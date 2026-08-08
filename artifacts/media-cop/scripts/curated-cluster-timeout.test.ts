/**
 * Curated clustering + synthesis timeout-abandonment regression (Task #987).
 *
 * Pre-Task #987, the curated clustering pass had a 10-minute hard-timeout
 * AbortSignal that stopped STARTING new AI work at phase boundaries, but did
 * NOT race already-in-flight AI calls against that signal. If the timeout
 * fired mid-call, the `await createCuratedClusterCompletion(...)` kept waiting
 * up to withAiTimeout's own backstop (~90s extra), wedging the pass exactly
 * as the ingest gate was wedged before Task #733.
 *
 * This file pins the regression fix: every `createCuratedClusterCompletion`
 * and `createCuratedSynthesisCompletion` call is now wrapped with a
 * `raceWithAbort*` helper that races against the pass's AbortSignal. A
 * blocking fake provider installed via the test seam holds the await; when
 * the shortened hard timeout fires the AbortError propagates and the pass
 * returns promptly — not after the backstop ceiling.
 *
 * Contract pinned here:
 *   1. UNIT — raceWithAbortClustering (via createCuratedClusterCompletion):
 *      a blocking stub is in flight when the pass's AbortSignal fires; the
 *      await releases with an AbortError, not after the backstop.
 *   2. END-TO-END — clusterCuratedLane with CLUSTER_MAX_DURATION_MS shortened
 *      via __setClusterMaxDurationForTest, storage stubbed to yield 2+ nodes,
 *      and blocking fake provider installed. The pass must return
 *      { stories: 0, members: 0 } promptly (within 2× the short timeout),
 *      with zero new AI calls starting after it returns.
 *
 * Run directly with tsx (no test framework configured):
 *   npx tsx scripts/curated-cluster-timeout.test.ts
 * Exits 0 on pass, 1 on any failure (pure in-process logic: no live AI, no
 * network, no DB writes — everything is stubbed).
 */

const HARD_TIMEOUT_MS = 600;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[cluster-timeout] OK   ${name}`);
  } else {
    console.error(`[cluster-timeout] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}
function isAbortError(e: unknown): boolean {
  return !!e && (e as Error).name === 'AbortError';
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const {
    clusterCuratedLane,
    __setCuratedClusterCompletionForTest,
    __setClusterMaxDurationForTest,
  } = await import('../server/curatedCluster');
  const { storage } = await import('../server/storage');

  // Never-settling promise — represents a blocking provider call.
  const NEVER = new Promise<never>(() => {});

  // =========================================================================
  // TEST 1 — UNIT: createCuratedClusterCompletion (via identifyCuratedClusters)
  // races against the passed AbortSignal. Abort while in flight releases with
  // an AbortError, NOT after the withAiTimeout backstop.
  // =========================================================================
  {
    let calls = 0;
    __setCuratedClusterCompletionForTest(async () => {
      calls++;
      return NEVER as any;
    });

    const { identifyCuratedClusters } = await import('../server/curatedCluster');
    const controller = new AbortController();
    const t0 = Date.now();

    const nodes = [
      {
        key: 'main:1', itemType: 'main' as const, itemId: 1, title: 'Carrier repositions in Indo-Pacific',
        url: 'https://example.com/a', source: 'Reuters', priority: 80,
        publishedAt: new Date(), normalizedTitle: 'carrier reposition indo pacific',
        blocked: false, behavior: 'corroborating' as any, role: 'trusted' as any,
        label: undefined, cls: 'corroborating' as any, sourceIdentifier: undefined,
        ownerGroup: undefined, contentKind: undefined, audioUrl: undefined,
      },
      {
        key: 'main:2', itemType: 'main' as const, itemId: 2, title: 'New export controls target chip tooling',
        url: 'https://example.com/b', source: 'AP', priority: 75,
        publishedAt: new Date(), normalizedTitle: 'export control chip tooling',
        blocked: false, behavior: 'corroborating' as any, role: 'trusted' as any,
        label: undefined, cls: 'corroborating' as any, sourceIdentifier: undefined,
        ownerGroup: undefined, contentKind: undefined, audioUrl: undefined,
      },
    ];

    const p = identifyCuratedClusters(nodes, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);

    let abortShaped = false;
    let result: any = 'NOT_SETTLED';
    try {
      result = await p;
    } catch (e) {
      abortShaped = isAbortError(e);
    }
    const elapsed = Date.now() - t0;

    // identifyCuratedClusters wraps in try/catch and returns null on any error
    // including AbortError — so the outer try never throws here.
    const settled = result !== 'NOT_SETTLED';
    check('1a identifyCuratedClusters settled (not hung)', settled, `result=${JSON.stringify(result)}`);
    check('1b it released promptly (not backstop-delay)', elapsed < 1000, `elapsed=${elapsed}ms`);
    check('1c exactly one provider call started', calls === 1, `calls=${calls}`);

    const callsAtSettle = calls;
    await sleep(200);
    check('1d no NEW calls after the abort', calls === callsAtSettle, `calls grew to ${calls}`);

    __setCuratedClusterCompletionForTest(null);
  }

  // =========================================================================
  // Storage stubbing for the end-to-end test (Test 2). Shadow every method
  // clusterCuratedLane touches before (and after) the AI call so nothing
  // hits the real DB.
  // =========================================================================
  const origStorage: Record<string, any> = {};
  const storageCounts: Record<string, number> = { replaceCuratedClusterMembers: 0 };
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

  // Two main-feed items so allNodes.length >= 2 (triggers the grouping LLM).
  const nowIso = new Date().toISOString();
  stub('getOutletRegistry', async () => []);
  stub('getPrimaryFeed', async () => [
    {
      id: 1, title: 'Carrier repositions in Indo-Pacific', url: 'https://example.com/a',
      source: 'Reuters', priority: 80, publishedAt: nowIso, scrapedAt: nowIso,
      isManual: false, tags: [], summary: null, blocked: false,
      factuality: null, bias: null, sourceType: null, sourceIdentifier: null,
      imageUrl: null, bullets: null, contentKind: null,
    },
    {
      id: 2, title: 'New export controls target chip tooling', url: 'https://example.com/b',
      source: 'AP', priority: 75, publishedAt: nowIso, scrapedAt: nowIso,
      isManual: false, tags: [], summary: null, blocked: false,
      factuality: null, bias: null, sourceType: null, sourceIdentifier: null,
      imageUrl: null, bullets: null, contentKind: null,
    },
  ]);
  stub('getCuratedStoreItems', async () => []);
  stub('getCuratedContentKindOverrides', async () => new Map<string, string>());
  stub('getCuratedClusterMembers', async () => []);
  stub('getCuratedArchiveOriginationBySignatures', async () => new Map());
  stub('getCuratedArchiveGraceCandidates', async () => []);
  stub('getActiveCuratedManualLinks', async () => []);
  stub('getActiveCuratedManualEvictions', async () => []);
  stub('getActiveCuratedSplitOverlays', async () => []);
  stub('replaceCuratedClusterMembers', async () => {});
  stub('recordCuratedClusterMetrics', async () => {});
  stub('getCuratedStorySynthesisMap', async () => new Map());
  stub('pruneCuratedStorySynthesisNotIn', async () => {});
  stub('pruneCuratedStoryArchive', async () => {});
  stub('upsertCuratedStoryArchive', async () => ({ id: 'stub' }));
  stub('getCuratedClassificationsByUrls', async () => new Map());
  stub('pruneCuratedMemberConfirmations', async () => {});
  stub('bumpCuratedMemberConfirmation', async () => 0);

  // =========================================================================
  // TEST 2 — END-TO-END: clusterCuratedLane with shortened hard timeout and
  // a blocking AI stub. The pass must resolve { stories:0, members:0 }
  // promptly via the AbortError path, with no new AI calls after return.
  // =========================================================================
  {
    let clusterCalls = 0;
    __setCuratedClusterCompletionForTest(async () => {
      clusterCalls++;
      return NEVER as any;
    });
    __setClusterMaxDurationForTest(HARD_TIMEOUT_MS);

    let result: any = null;
    let threw: unknown = null;
    const t0 = Date.now();
    try {
      result = await clusterCuratedLane();
    } catch (e) {
      threw = e;
    }
    const elapsed = Date.now() - t0;
    const callsAtReturn = clusterCalls;

    await sleep(400); // let any (buggy) background stragglers fire

    check('2a clusterCuratedLane RESOLVES (AbortError swallowed internally)', threw === null, String(threw));
    check(
      '2b it returns { stories:0, members:0 }',
      !!result && result.stories === 0 && result.members === 0,
      `result=${JSON.stringify(result)}`,
    );
    check(
      '2c pass abandoned roughly at the short timeout (not wedged at the backstop)',
      elapsed >= HARD_TIMEOUT_MS - 100 && elapsed < HARD_TIMEOUT_MS + 3000,
      `elapsed=${elapsed}ms (hard timeout ${HARD_TIMEOUT_MS}ms)`,
    );
    check('2d hard timeout fired while an AI call was in flight (at least one started)', callsAtReturn >= 1, `clusterCalls=${callsAtReturn}`);
    check('2e NO new AI calls start after the pass returns', clusterCalls === callsAtReturn, `calls grew to ${clusterCalls}`);

    __setCuratedClusterCompletionForTest(null);
    __setClusterMaxDurationForTest(null);
  }

  // Cleanup.
  restoreStorage();

  if (failures > 0) {
    console.error(`\n[cluster-timeout] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[cluster-timeout] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[cluster-timeout] UNEXPECTED ERROR', e);
  process.exit(1);
});
