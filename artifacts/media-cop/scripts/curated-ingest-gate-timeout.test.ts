/**
 * Curated ingest gate-timeout abandonment regression (Task #733).
 *
 * Task #715's unit test proved the abort SIGNAL propagates through the intake
 * loop boundaries (mode 'reuse', stubbed storage). It did NOT prove the
 * end-to-end failure mode this file pins: the hard timeout in runCuratedIngest
 * fires WHILE an AI relevance-gate call (analyzeCuratedBatchChunked, gate
 * mode) is IN FLIGHT. Without an in-flight race, a stalled provider call
 * holds the `await analyzeCuratedBatchChunked(...)` in admitCuratedCandidates
 * forever — the loop-level throwIfAborted guards all look correct but never
 * run again, and only the outer Promise.race in runCuratedIngest eventually
 * gives up (leaving the pass wedged in the background). A regression that
 * made the gate ignore `opts.signal` would keep hammering the model.
 *
 * Contract pinned here:
 *   1. analyzeCuratedBatchChunked FAST PATH (single chunk): an abort while the
 *      one call is in flight releases the await with an AbortError — it does
 *      not merely stop "the next iteration" (there is none).
 *   2. analyzeCuratedBatchChunked MULTI-CHUNK: an abort while chunk #1 is in
 *      flight rejects the whole gate with an AbortError and NO further chunk
 *      calls ever start.
 *   3. admitCuratedCandidates mode 'gate' with a BLOCKING fake gate (installed
 *      via the aiAnalyzer test seam): an abort mid-gate throws an AbortError
 *      out of the pass, exactly one gate call was started, none start after
 *      the abort, and nothing is ingested.
 *   4. END-TO-END: runCuratedIngest with INGEST_MAX_DURATION_MS shortened via
 *      CURATED_INGEST_MAX_DURATION_MS (set before import), global fetch
 *      stubbed to serve a tiny fresh RSS body (no network), storage stubbed,
 *      and the blocking gate seam installed. The pass must resolve
 *      { ingested: 0, skipped: 0 } via the AbortError path shortly after the
 *      shortened hard timeout, with zero inserts and zero NEW gate calls
 *      after it returns.
 *
 * Run directly with tsx (no test framework configured):
 *   npx tsx scripts/curated-ingest-gate-timeout.test.ts
 * Exits 0 on pass, 1 on any failure (pure in-process logic: no live AI, no
 * network, no DB writes — everything is stubbed).
 */

// MUST be set before importing curatedIngest (read at module load).
const HARD_TIMEOUT_MS = 1500;
process.env.CURATED_INGEST_MAX_DURATION_MS = String(HARD_TIMEOUT_MS);
// Ensure the AI-harness stub is OFF so the real gate call path runs.
delete process.env.CURATED_AI_HARNESS_STUB;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[gate-timeout] OK   ${name}`);
  } else {
    console.error(`[gate-timeout] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}
function isAbortError(e: unknown): boolean {
  return !!e && (e as Error).name === 'AbortError';
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { analyzeCuratedBatchChunked, __setCuratedGateAnalyzeForTest } = await import(
    '../server/aiAnalyzer'
  );
  const { admitCuratedCandidates, runCuratedIngest } = await import('../server/curatedIngest');
  const { storage } = await import('../server/storage');
  const { CURATED_FEEDS, CURATED_TITLE_TRANSLATE_SOURCES } = await import(
    '../server/curatedFeeds'
  );

  // A gate result shaped like the analyzer's (never actually returned — the
  // blocking gate never resolves), only used by never-blocking control calls.
  const NEVER = new Promise<never>(() => {});

  // =========================================================================
  // TEST 1 — fast path (single chunk): abort releases the IN-FLIGHT await.
  // =========================================================================
  {
    let calls = 0;
    const controller = new AbortController();
    const t0 = Date.now();
    let abortedAt = 0;
    const p = analyzeCuratedBatchChunked(['alpha carrier deployment', 'beta export controls'], {
      _analyze: async () => { calls++; return NEVER as any; },
      signal: controller.signal,
    });
    setTimeout(() => {
      abortedAt = Date.now();
      controller.abort();
    }, 100);
    let abortShaped = false;
    try {
      await p;
    } catch (e) {
      abortShaped = isAbortError(e);
    }
    const elapsed = Date.now() - t0;
    const releaseLag = abortedAt > 0 ? Date.now() - abortedAt : Number.POSITIVE_INFINITY;
    check('1a fast-path in-flight call is abandoned with an AbortError', abortShaped);
    check(
      '1b it releases promptly after the abort is delivered (not a hang)',
      releaseLag < 500,
      `releaseLag=${releaseLag}ms totalElapsed=${elapsed}ms`,
    );
    check('1c exactly one gate call started', calls === 1, `calls=${calls}`);
  }

  // =========================================================================
  // TEST 2 — multi-chunk: abort mid-chunk rejects the whole gate, no new
  // chunk calls start afterwards.
  // =========================================================================
  {
    let calls = 0;
    const controller = new AbortController();
    const titles = Array.from({ length: 8 }, (_, i) => `headline number ${i} about deterrence`);
    const p = analyzeCuratedBatchChunked(titles, {
      chunkSize: 2,
      concurrency: 1,
      _analyze: async () => { calls++; return NEVER as any; },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    let abortShaped = false;
    try {
      await p;
    } catch (e) {
      abortShaped = isAbortError(e);
    }
    const callsAtReject = calls;
    await sleep(300); // give any (buggy) stragglers time to fire
    check('2a multi-chunk gate rejects with an AbortError', abortShaped);
    check('2b only the in-flight chunk had started', callsAtReject === 1, `calls=${callsAtReject}`);
    check('2c NO new chunk calls start after the abort', calls === callsAtReject, `calls grew to ${calls}`);
  }

  // =========================================================================
  // Shared storage stubbing for tests 3 & 4. Shadow every method the ingest
  // path can touch BEFORE the gate blocks (and the insert path that must
  // never run).
  // =========================================================================
  const origStorage: Record<string, any> = {};
  const storageCounts: Record<string, number> = { addCuratedItem: 0 };
  const stub = (name: string, fn: (...a: any[]) => any) => {
    if (!(name in origStorage)) origStorage[name] = (storage as any)[name];
    (storage as any)[name] = (...args: any[]) => {
      storageCounts[name] = (storageCounts[name] || 0) + 1;
      return fn(...args);
    };
  };
  const restoreStorage = () => {
    for (const [n, f] of Object.entries(origStorage)) (storage as any)[n] = f;
  };
  stub('getOutletRegistry', async () => []);
  stub('getExistingCuratedUrls', async () => new Set<string>());
  stub('getCuratedItemByUrl', async () => undefined);
  stub('getSimilarCuratedItems', async () => []);
  stub('getSimilarCuratedItemsForOutlet', async () => []);
  stub('getCuratedDedupCorpus', async () => []);
  stub('addCuratedItem', async (insert: any) => ({ id: 'stub', ...insert }));
  stub('clearOldCuratedItems', async () => 0);
  stub('pruneStaleCuratedContentKindOverrides', async () => 0);
  stub('mergeCuratedIntakeFeedStats', async () => {});
  stub('upsertCuratedIntakeTelemetry', async () => {});
  // Wrapper source readers (stages after RSS — never reached because the gate
  // blocks, but stub them so a regression can't hit the real DB).
  stub('getRecentTeamSubmissionsForCurated', async () => []);
  stub('getRecentHeadlinesForCurated', async () => []);
  stub('getRecentXPostsForCurated', async () => []);
  stub('getRecentTruthSocialPostsForCurated', async () => []);
  stub('getRecentFirstAlertsForCurated', async () => []);
  // Task #1075: cheap reuse-mode stages (team/social/headlines) now run BEFORE
  // the RSS gate stage, so ALL their source readers must be stubbed empty —
  // otherwise real DB rows get legitimately ingested before the gate stalls
  // and check 4f ("nothing inserted past the stalled gate") false-fails.
  stub('getCuratedOsintPosts', async () => []);
  stub('getCuratedJournalistPosts', async () => []);
  stub('getCuratedRapidResponsePosts', async () => []);
  stub('getCuratedDOWResponsePosts', async () => []);
  stub('getCuratedSentDefenderPosts', async () => []);

  // Blocking gate seam: every call increments the counter and never settles.
  let gateCalls = 0;
  __setCuratedGateAnalyzeForTest(async () => { gateCalls++; return NEVER as any; });

  // =========================================================================
  // TEST 3 — admitCuratedCandidates mode 'gate': abort WHILE the (blocking)
  // relevance-gate call is in flight throws AbortError out of the pass,
  // ingests nothing, and no new gate calls start after the abort.
  // =========================================================================
  {
    gateCalls = 0;
    const controller = new AbortController();
    const candidates = [
      { title: 'Carrier strike group repositions in the Indo-Pacific', url: 'https://example.com/t3-a', source: 'Reuters' },
      { title: 'New export-control tranche targets chip tooling', url: 'https://example.com/t3-b', source: 'Associated Press' },
      { title: 'Geneva talks enter a third round over enrichment caps', url: 'https://example.com/t3-c', source: 'Defense News' },
    ];
    const t0 = Date.now();
    let abortedAt = 0;
    const p = admitCuratedCandidates(candidates, {
      mode: 'gate',
      label: 'gate-timeout-test',
      signal: controller.signal,
    });
    setTimeout(() => {
      abortedAt = Date.now();
      controller.abort();
    }, 150);
    let abortShaped = false;
    let result: any = null;
    try {
      result = await p;
    } catch (e) {
      abortShaped = isAbortError(e);
    }
    const elapsed = Date.now() - t0;
    const releaseLag = abortedAt > 0 ? Date.now() - abortedAt : Number.POSITIVE_INFINITY;
    const gateCallsAtSettle = gateCalls;
    await sleep(300);
    check('3a gate-mode pass settles via the AbortError path', abortShaped, `result=${JSON.stringify(result)}`);
    check(
      '3b the await released promptly after abort despite the stalled AI call',
      releaseLag < 500,
      `releaseLag=${releaseLag}ms totalElapsed=${elapsed}ms`,
    );
    check('3c the abort reached an IN-FLIGHT gate call (exactly one had started)', gateCallsAtSettle === 1, `gateCalls=${gateCallsAtSettle}`);
    check('3d no NEW gate calls start after the abort', gateCalls === gateCallsAtSettle, `grew to ${gateCalls}`);
    check('3e nothing ingested (addCuratedItem never called)', storageCounts.addCuratedItem === 0);
  }

  // =========================================================================
  // TEST 4 — END-TO-END: runCuratedIngest with the hard timeout shortened to
  // HARD_TIMEOUT_MS. Global fetch is stubbed so the RSS stage instantly
  // yields fresh candidates (unique per feed; translate-source feeds are
  // 404'd so no pre-gate translation call fires), then the gate blocks. The
  // shortened hard timeout must abort + resolve { ingested: 0, skipped: 0 }.
  // =========================================================================
  {
    gateCalls = 0;
    storageCounts.addCuratedItem = 0;

    // Map feed URL → sourceName so translate-source feeds can be failed.
    const translateFeedUrls = new Set(
      CURATED_FEEDS.filter((f: any) => CURATED_TITLE_TRANSLATE_SOURCES.has(f.sourceName)).map((f: any) => f.url),
    );
    const origFetch = globalThis.fetch;
    let fetchSeq = 0;
    const nowRfc = () => new Date().toUTCString();
    (globalThis as any).fetch = async (url: any) => {
      const u = String(url);
      if (translateFeedUrls.has(u)) {
        return new Response('not found', { status: 404 });
      }
      const n = ++fetchSeq;
      const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>stub</title>
        <item><title>Stub headline ${n}A on strategic force posture</title><link>https://stub.example.com/${n}/a</link><pubDate>${nowRfc()}</pubDate></item>
        <item><title>Stub headline ${n}B on sanctions enforcement</title><link>https://stub.example.com/${n}/b</link><pubDate>${nowRfc()}</pubDate></item>
      </channel></rss>`;
      return new Response(body, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    };

    let result: any = null;
    let threw: unknown = null;
    const t0 = Date.now();
    try {
      result = await runCuratedIngest();
    } catch (e) {
      threw = e;
    } finally {
      (globalThis as any).fetch = origFetch;
    }
    const elapsed = Date.now() - t0;
    const gateCallsAtReturn = gateCalls;
    await sleep(400); // a wedged background pass would keep issuing gate calls
    check('4a runCuratedIngest RESOLVES (AbortError path is swallowed internally)', threw === null, String(threw));
    check(
      '4b it returns { ingested: 0, skipped: 0 } — nothing admitted past the stalled gate',
      !!result && result.ingested === 0 && result.skipped === 0,
      `result=${JSON.stringify(result)}`,
    );
    check(
      '4c the pass was abandoned at (roughly) the shortened hard timeout, not wedged',
      elapsed >= HARD_TIMEOUT_MS - 50 && elapsed < HARD_TIMEOUT_MS + 3000,
      `elapsed=${elapsed}ms (hard timeout ${HARD_TIMEOUT_MS}ms)`,
    );
    check('4d the hard timeout fired WHILE a gate call was in flight', gateCallsAtReturn >= 1, `gateCalls=${gateCallsAtReturn}`);
    check('4e no NEW gate calls start after the pass returns', gateCalls === gateCallsAtReturn, `grew to ${gateCalls}`);
    check('4f nothing was ever inserted (addCuratedItem never called)', storageCounts.addCuratedItem === 0, `addCuratedItem=${storageCounts.addCuratedItem}`);
  }

  // Cleanup.
  __setCuratedGateAnalyzeForTest(null);
  restoreStorage();

  if (failures > 0) {
    console.error(`\n[gate-timeout] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[gate-timeout] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[gate-timeout] UNEXPECTED ERROR', e);
  process.exit(1);
});
