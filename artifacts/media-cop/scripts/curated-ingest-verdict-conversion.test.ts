/**
 * Curated ingest verdict-conversion regression (Task #1084).
 *
 * The perma-deferral bug (fixed in Task #1075's follow-through): chunked gate
 * analysis ran right up to the pass soft deadline, so the insert loop started
 * already-expired and deferred EVERY verdict it had just paid for — verdicts
 * piled up in the memo cache but `ingested` stayed 0 forever. Two code
 * properties prevent it today:
 *   1. GATE_INSERT_RESERVE_MS: analysis gets a deadline STRICTLY BEFORE the
 *      pass soft deadline, reserving a slice for the insert loop.
 *   2. Verdict-first insert ordering: the insert loop processes verdict-bearing
 *      items FIRST (stable partition), so the reserved window converts analyzed
 *      items into rows before unscored items burn any of it.
 *
 * No gate asserted the resulting invariant, so a regression (removing the
 * reserve, or the ordering) would silently reintroduce ingested=0 passes.
 * This gate pins it end-to-end through admitCuratedCandidates (mode 'gate'):
 *
 *   With a stubbed SLOW analyzer (each chunk call sleeps a fixed time, then
 *   returns relevant verdicts) and a TIGHT soft deadline sized so analysis
 *   CANNOT finish all chunks before its cutoff:
 *     a. the pass resolves normally (soft deadline is graceful — no throw),
 *     b. analysis was genuinely cut short (some titles never analyzed),
 *     c. NO analyzer chunk call starts at/after the analysis cutoff
 *        (deadline minus the insert reserve, floored at now+10s) — the
 *        insert-reserve invariant. If someone removes the reserve, chunk
 *        calls keep starting until the pass deadline and this fails.
 *     d. INVARIANT: verdict-bearing items CONVERT TO ROWS IN THE SAME PASS —
 *        ingested > 0 and every inserted row's title is one the stub analyzer
 *        returned a verdict for (verdict-first ordering; unscored items never
 *        consume the reserved insert window ahead of scored ones).
 *
 * Timing model (all in-process, storage stubbed, no live AI / network / DB):
 *   deadline = now + 13s. Reserve is 90s, so the clamped analysis cutoff is
 *   the 10s floor (min(deadline, max(now+10s, deadline-90s)) = now+10s).
 *   Stub chunk call sleeps 2.6s; 500 unique titles → 20 chunks of 25 at
 *   concurrency 3 → waves complete at ~2.6/5.2/7.8/10.4s. The wave started at
 *   7.8s is the last allowed (next dequeue check at ~10.4s is past the 10s
 *   cutoff), leaving ~200 titles unanalyzed and ~2.6s of reserved insert time.
 *
 * Run directly with tsx (no test framework configured):
 *   npx tsx scripts/curated-ingest-verdict-conversion.test.ts
 * Exits 0 on pass, 1 on any failure.
 */

// Ensure the AI-harness stub is OFF so the real gate call path (memo cache +
// chunked analysis + insert reserve) runs.
delete process.env.CURATED_AI_HARNESS_STUB;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[verdict-conversion] OK   ${name}`);
  } else {
    console.error(`[verdict-conversion] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mirrors GATE_INSERT_RESERVE_MS / the 10s analysis floor in curatedIngest.ts.
// If those constants change materially the timing assertions here will surface
// it (this test is deliberately coupled to the invariant, not the exact value).
const PASS_BUDGET_MS = 13_000;
const ANALYSIS_FLOOR_MS = 10_000;
const CHUNK_SLEEP_MS = 2_600;
const TOTAL_TITLES = 500; // 20 chunks of 25 (CURATED_GATE_CHUNK_SIZE)

async function main() {
  const { __setCuratedGateAnalyzeForTest } = await import('../server/aiAnalyzer');
  const { admitCuratedCandidates } = await import('../server/curatedIngest');
  const { storage } = await import('../server/storage');

  // ---------------------------------------------------------------------------
  // Storage stubbing — shadow every method the gate-mode admission path touches
  // so nothing hits the real DB. addCuratedItem records inserted titles.
  // ---------------------------------------------------------------------------
  const origStorage: Record<string, any> = {};
  const stub = (name: string, fn: (...a: any[]) => any) => {
    if (!(name in origStorage)) origStorage[name] = (storage as any)[name];
    (storage as any)[name] = fn;
  };
  const restoreStorage = () => {
    for (const [n, f] of Object.entries(origStorage)) (storage as any)[n] = f;
  };
  const insertedTitles: string[] = [];
  let insertSeq = 0;
  stub('getOutletRegistry', async () => []);
  stub('getExistingCuratedUrls', async () => new Set<string>());
  stub('getCuratedItemByUrl', async () => undefined);
  stub('getSimilarCuratedItems', async () => []);
  stub('getSimilarCuratedItemsForOutlet', async () => []);
  stub('getCuratedDedupCorpus', async () => []);
  // HERMETIC SEAL (post-#1114): admission telemetry is persisted on every
  // admit exit — unstubbed it wrote a 'verdict-conversion-test' row into the
  // real curated_intake_telemetry table.
  stub('upsertCuratedIntakeTelemetry', async () => {});
  stub('mergeCuratedIntakeFeedStats', async () => {});
  stub('addCuratedItem', async (insert: any) => {
    insertedTitles.push(insert.title);
    return { id: `stub-${++insertSeq}`, ...insert };
  });
  stub('getCuratedLearnedRules', async () => []); // learned-rules cache backing read
  stub('getCuratedClassificationsByUrls', async () => new Map());
  stub('upsertCuratedClassifications', async () => {});
  stub('recordClassificationProposal', async () => {});
  stub('recordWatchTopicMatch', async () => {});
  // HERMETIC SEAL (post-#1083): the gate path now hydrates persisted verdicts
  // from curated_gate_verdicts and write-through persists fresh ones
  // (fire-and-forget). Left unstubbed, the first run LEAKS the synthetic probe
  // verdicts into the real dev table and every later run replays them from
  // cache — the stub analyzer is never called and checks b/c/d3 fail. Serve an
  // empty hydrate and capture saves in-memory: no DB reads, no DB writes, no
  // cross-run coupling.
  let verdictLoads = 0;
  let verdictSaves = 0;
  stub('loadCuratedGateVerdicts', async () => {
    verdictLoads++;
    return [];
  });
  stub('saveCuratedGateVerdicts', async () => {
    verdictSaves++;
  });

  // ---------------------------------------------------------------------------
  // Slow-analyzer seam: each chunk call sleeps CHUNK_SLEEP_MS then returns a
  // relevant verdict for every title in the chunk. Start times are recorded so
  // the insert-reserve invariant (no call starts past the cutoff) is provable.
  // ---------------------------------------------------------------------------
  const chunkStartOffsets: number[] = [];
  const analyzedTitles = new Set<string>();
  let t0 = 0;
  __setCuratedGateAnalyzeForTest(async (titles: string[]) => {
    chunkStartOffsets.push(Date.now() - t0);
    await sleep(CHUNK_SLEEP_MS);
    for (const t of titles) analyzedTitles.add(t);
    return titles.map((title) => ({
      title,
      is_relevant: true,
      reason: 'verdict-conversion test',
      tags: [],
      priority_score: 55,
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

  const candidates = Array.from({ length: TOTAL_TITLES }, (_, i) => ({
    title: `Verdict conversion probe ${i} on strategic force posture and deterrence`,
    url: `https://example.com/verdict-conversion/${i}`,
    source: 'Reuters',
    pubDate: new Date(),
  }));

  t0 = Date.now();
  const deadlineMs = t0 + PASS_BUDGET_MS;
  let result: { ingested: number; skipped: number } | null = null;
  let threw: unknown = null;
  try {
    result = await admitCuratedCandidates(candidates, {
      mode: 'gate',
      label: 'verdict-conversion-test',
      deadlineMs,
    });
  } catch (e) {
    threw = e;
  }
  const elapsed = Date.now() - t0;

  // Cleanup before asserting (so a failed check can't leave globals dirty).
  __setCuratedGateAnalyzeForTest(null);
  restoreStorage();

  // (a) Soft deadline is graceful — the pass resolves, never throws.
  check('a. pass resolves normally under the soft deadline (no throw)', threw === null, String(threw));

  // Preconditions that make the invariant meaningful: analysis really was cut
  // short by the deadline (otherwise this test proves nothing).
  check(
    'b. analysis was genuinely cut short (some titles never analyzed)',
    analyzedTitles.size > 0 && analyzedTitles.size < TOTAL_TITLES,
    `analyzed=${analyzedTitles.size}/${TOTAL_TITLES}`,
  );

  // (c) Insert-reserve invariant: no analyzer chunk call may START at/after the
  // analysis cutoff (pass deadline minus the reserve, floored at start+10s).
  // Removing GATE_INSERT_RESERVE_MS makes chunk calls keep starting up to the
  // pass deadline (~10.4s wave here would be followed by a ~10.4s start).
  const lastStart = Math.max(...chunkStartOffsets);
  check(
    'c. no analyzer chunk starts past the analysis cutoff (insert reserve held)',
    chunkStartOffsets.length > 0 && lastStart < ANALYSIS_FLOOR_MS + 300,
    `lastChunkStart=+${lastStart}ms (cutoff ~+${ANALYSIS_FLOOR_MS}ms), chunks=${chunkStartOffsets.length}`,
  );

  // (d) THE invariant this gate exists for: verdicts produced under the soft
  // deadline CONVERT to rows in the SAME pass.
  check(
    'd1. verdict-bearing items were inserted in the same pass (ingested > 0)',
    !!result && result.ingested > 0,
    `result=${JSON.stringify(result)}`,
  );
  check(
    'd2. inserted count matches addCuratedItem calls',
    !!result && result.ingested === insertedTitles.length,
    `ingested=${result?.ingested} inserts=${insertedTitles.length}`,
  );
  const strayInsert = insertedTitles.find((t) => !analyzedTitles.has(t));
  check(
    'd3. every inserted row carries a verdict (verdict-first ordering held)',
    insertedTitles.length > 0 && strayInsert === undefined,
    strayInsert ? `unscored title inserted: "${strayInsert}"` : `inserts=${insertedTitles.length}`,
  );

  // The pass respected its overall budget (soft deadline stops STARTING new
  // work; generous slack because already-started work — the last in-flight
  // analyzer wave, the batched overlay upsert, per-item yields — legitimately
  // finishes a few seconds past the deadline). This only catches a WEDGE.
  check(
    'e. pass ended near its soft deadline, not wedged past it',
    elapsed < PASS_BUDGET_MS + 8_000,
    `elapsed=${elapsed}ms (budget ${PASS_BUDGET_MS}ms)`,
  );

  // (f) Hermeticity + #1083 write-through contract: the hydrate seam was
  // consulted (and served empty — no real-DB coupling), and freshly-analyzed
  // verdicts were offered to the fire-and-forget persistence seam without
  // touching the DB. If someone removes the stubs, the leak reappears and
  // checks b/c/d3 start failing on the SECOND run — this check names the
  // contract so the failure is diagnosable on the first.
  check(
    'f. persisted-verdict seams stayed stubbed (hydrate consulted, write-through fired)',
    verdictLoads >= 1 && verdictSaves >= 1,
    `loads=${verdictLoads} saves=${verdictSaves}`,
  );

  if (failures > 0) {
    console.error(`\n[verdict-conversion] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[verdict-conversion] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[verdict-conversion] UNEXPECTED ERROR', e);
  process.exit(1);
});
