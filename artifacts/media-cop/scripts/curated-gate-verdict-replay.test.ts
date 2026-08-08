/**
 * scripts/curated-gate-verdict-replay.test.ts — Task #1109 gate.
 *
 * Pins the gate-verdict memo cache replay behavior (Task #1075 backlog-drain
 * fix, other half of the #1084 verdict-conversion gate): a headline judged
 * once by the AI relevance gate must be admitted/rejected from the CACHED
 * verdict on later passes with ZERO analyzer calls, and after the TTL the
 * title must be re-analyzed fresh. A regression here (cache key change, cache
 * bypass, TTL mishandling) silently re-inflates per-pass AI cost and
 * re-creates the never-draining ~700-item RSS backlog.
 *
 * Pass 1: N unique titles → analyzer sees all of them, relevant ones ingest.
 * Pass 2: SAME titles with FRESH URLs (so URL dedup can't hide a cache miss)
 *         → ZERO analyzer calls; relevant titles still ingest from cache and
 *         rejected titles stay rejected from cache.
 * Pass 3: clock advanced past GATE_VERDICT_TTL_MS (6h) → every title is
 *         re-analyzed fresh.
 *
 * Hermetic: every storage seam the gate-mode admission path touches is
 * stubbed (same pattern as curated-ingest-verdict-conversion.test.ts),
 * including the #1083 persisted-verdict hydrate/write-through seams, so no
 * real-DB reads/writes and no cross-run coupling.
 */

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[verdict-replay] OK   ${name}`);
  } else {
    console.error(`[verdict-replay] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const RELEVANT_COUNT = 12;
const REJECTED_COUNT = 4;
const TTL_ADVANCE_MS = 7 * 60 * 60 * 1000; // 7h > the 6h GATE_VERDICT_TTL_MS

// Titles must be MUTUALLY DISSIMILAR prose: all candidates share one outlet,
// and since #1105 the same-outlet fuzzy de-dupe runs IN MEMORY within the
// pass — near-identical templated titles ("probe 0/1/2…") legitimately
// collapse to ONE insert and break every ingest-count assertion. The
// test marker lives in the URL, never the title (isolation-test convention).
const relevantTitles = [
  'NATO expands Baltic air policing rotation after drone incursions',
  'Pentagon accelerates hypersonic interceptor testing timeline',
  'China conducts large-scale amphibious exercise near Taiwan strait',
  'Iran unveils extended-range ballistic missile at military parade',
  'North Korea test-fires cruise missiles into western sea',
  'Russia redeploys armored brigades toward Kharkiv axis',
  'US Navy carrier strike group transits South China Sea',
  'Israel strikes weapons depots near Damascus, Syria says',
  'India commissions second indigenous aircraft carrier',
  'Poland signs deal for additional K2 tanks from South Korea',
  'Houthi forces target commercial shipping in Red Sea lanes',
  'Japan approves record defense budget amid regional tensions',
];
if (relevantTitles.length !== RELEVANT_COUNT) throw new Error('relevantTitles/RELEVANT_COUNT mismatch');
const rejectedTitles = [
  'Celebrity chef opens new pasta restaurant in Manhattan',
  'Streaming drama tops weekend box office charts',
  'Pop star announces stadium tour dates for next summer',
  'Reality show couple shares wedding photos with fans',
];
if (rejectedTitles.length !== REJECTED_COUNT) throw new Error('rejectedTitles/REJECTED_COUNT mismatch');
const allTitles = [...relevantTitles, ...rejectedTitles];
const rejectedSet = new Set(rejectedTitles);

async function main() {
  const { __setCuratedGateAnalyzeForTest } = await import('../server/aiAnalyzer');
  const { admitCuratedCandidates } = await import('../server/curatedIngest');
  const { storage } = await import('../server/storage');

  // --- storage stubbing (mirror of the #1084 harness) ------------------------
  const origStorage: Record<string, any> = {};
  const stub = (name: string, fn: (...a: any[]) => any) => {
    if (!(name in origStorage)) origStorage[name] = (storage as any)[name];
    (storage as any)[name] = fn;
  };
  const restoreStorage = () => {
    for (const [n, f] of Object.entries(origStorage)) (storage as any)[n] = f;
  };
  let insertSeq = 0;
  let insertedTitles: string[] = [];
  stub('getOutletRegistry', async () => []);
  stub('getExistingCuratedUrls', async () => new Set<string>());
  stub('getCuratedItemByUrl', async () => undefined);
  stub('getSimilarCuratedItems', async () => []);
  stub('getSimilarCuratedItemsForOutlet', async () => []);
  stub('addCuratedItem', async (insert: any) => {
    insertedTitles.push(insert.title);
    return { id: `stub-${++insertSeq}`, ...insert };
  });
  stub('getCuratedLearnedRules', async () => []);
  stub('getCuratedClassificationsByUrls', async () => new Map());
  stub('upsertCuratedClassifications', async () => {});
  stub('recordClassificationProposal', async () => {});
  stub('recordWatchTopicMatch', async () => {});
  // HERMETIC SEAL (post-#1083): serve an empty hydrate and swallow the
  // fire-and-forget write-through so no real-DB rows leak in or out.
  stub('loadCuratedGateVerdicts', async () => []);
  stub('saveCuratedGateVerdicts', async () => {});
  // HERMETIC SEAL (post-#1105/#1114): the admit loop now reads the 48h dedup
  // corpus in one batch and persists per-source admission telemetry on every
  // exit. Left unstubbed these hit the real dev DB (telemetry rows leaked
  // labels like 'verdict-replay-pass1' and broke the telemetry gate).
  stub('getCuratedDedupCorpus', async () => []);
  stub('upsertCuratedIntakeTelemetry', async () => {});
  stub('mergeCuratedIntakeFeedStats', async () => {});

  // --- counting analyzer stub -------------------------------------------------
  let analyzerCalls = 0;
  let analyzedTitles: string[] = [];
  __setCuratedGateAnalyzeForTest(async (titles: string[]) => {
    analyzerCalls++;
    analyzedTitles.push(...titles);
    return titles.map((title) => ({
      title,
      is_relevant: !rejectedSet.has(title),
      reason: 'verdict-replay test',
      tags: [],
      priority_score: rejectedSet.has(title) ? 10 : 55,
      category: 'general',
      region: null,
      country: null,
      primaryTopic: 'Other / Emerging',
      scope: null,
      conflictTrack: null,
      countryPair: null,
      proposedTopic: null,
    })) as any;
  });

  // --- controllable clock (TTL expiry without waiting 6h) ---------------------
  const realNow = Date.now.bind(Date);
  let clockOffsetMs = 0;
  Date.now = () => realNow() + clockOffsetMs;

  const runPass = async (label: string) => {
    analyzerCalls = 0;
    analyzedTitles = [];
    insertedTitles = [];
    // Fresh URLs EVERY pass so URL dedup can never hide a verdict-cache miss.
    const candidates = allTitles.map((title, i) => ({
      title,
      url: `https://example.com/verdict-replay/${label}/${i}-${Math.random().toString(36).slice(2)}`,
      source: 'Reuters',
      pubDate: new Date(Date.now()), // fresh under the (possibly advanced) clock
    }));
    const result = await admitCuratedCandidates(candidates, {
      mode: 'gate',
      label: `verdict-replay-${label}`,
      deadlineMs: Date.now() + 60_000,
    });
    return {
      result,
      calls: analyzerCalls,
      analyzed: [...analyzedTitles],
      inserted: [...insertedTitles],
    };
  };

  let threw: unknown = null;
  let p1: Awaited<ReturnType<typeof runPass>> | null = null;
  let p2: typeof p1 = null;
  let p3: typeof p1 = null;
  try {
    p1 = await runPass('pass1');
    p2 = await runPass('pass2');
    clockOffsetMs = TTL_ADVANCE_MS; // expire every cached verdict
    p3 = await runPass('pass3');
  } catch (e) {
    threw = e;
  }

  // Cleanup before asserting.
  Date.now = realNow;
  __setCuratedGateAnalyzeForTest(null);
  restoreStorage();

  check('a. all three passes resolve without throwing', threw === null, String(threw));

  // Pass 1 — cold: every unique title reaches the analyzer, relevant ones ingest.
  const p1AnalyzedSet = new Set(p1?.analyzed ?? []);
  check(
    'b1. pass 1 analyzes every unique title (cold cache)',
    !!p1 && allTitles.every((t) => p1AnalyzedSet.has(t)),
    `analyzed=${p1?.analyzed.length}/${allTitles.length} calls=${p1?.calls}`,
  );
  check(
    'b2. pass 1 ingests exactly the relevant titles',
    !!p1 && p1.inserted.length === RELEVANT_COUNT && p1.inserted.every((t) => !rejectedSet.has(t)),
    `inserted=${p1?.inserted.length} (want ${RELEVANT_COUNT})`,
  );

  // Pass 2 — THE invariant: same titles, fresh URLs → ZERO analyzer calls,
  // relevant titles still ingest from cached verdicts, rejects stay rejected.
  check(
    'c1. pass 2 makes ZERO analyzer calls (verdicts replayed from cache)',
    !!p2 && p2.calls === 0,
    `calls=${p2?.calls} analyzed=${p2?.analyzed.length}`,
  );
  check(
    'c2. pass 2 still ingests all relevant titles from cached verdicts',
    !!p2 && p2.inserted.length === RELEVANT_COUNT && relevantTitles.every((t) => p2!.inserted.includes(t)),
    `inserted=${p2?.inserted.length} (want ${RELEVANT_COUNT})`,
  );
  check(
    'c3. pass 2 keeps cached rejections rejected (no rejected title inserted)',
    !!p2 && p2.inserted.every((t) => !rejectedSet.has(t)),
    `strays=${p2?.inserted.filter((t) => rejectedSet.has(t)).join(', ')}`,
  );

  // Pass 3 — TTL expiry: expired verdicts must be re-analyzed fresh.
  const p3AnalyzedSet = new Set(p3?.analyzed ?? []);
  check(
    'd1. expired-TTL titles are re-analyzed (all titles hit the analyzer again)',
    !!p3 && p3.calls > 0 && allTitles.every((t) => p3AnalyzedSet.has(t)),
    `calls=${p3?.calls} analyzed=${p3?.analyzed.length}/${allTitles.length}`,
  );
  check(
    'd2. pass 3 ingests the relevant titles from the fresh verdicts',
    !!p3 && p3.inserted.length === RELEVANT_COUNT,
    `inserted=${p3?.inserted.length} (want ${RELEVANT_COUNT})`,
  );

  if (failures > 0) {
    console.error(`\n[verdict-replay] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[verdict-replay] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[verdict-replay] UNEXPECTED ERROR', e);
  process.exit(1);
});
