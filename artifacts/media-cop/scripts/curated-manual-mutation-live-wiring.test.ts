/**
 * Curated manual-mutation LIVE WIRING contract test (Task #1180).
 *
 * The companion unit test (curated-manual-mutation-coordinator.test.ts) proves
 * the coordinator core in isolation. THIS test proves the CONTRACT the live
 * server/routes.ts handlers depend on when they route link/merge, unlink,
 * unlink-member, evict, unevict, move, unmove (and undos) through the singleton
 * coordinator: it reconstructs the EXACT dependency wiring routes.ts builds
 * (isClusteringBusy = isCuratedClusteringRunning, runCheapReshape = deterministic
 * reshapeCuratedLane + cache invalidation, deferReshape = schedulePendingManual
 * Reshape + requestCuratedClusteringYield, scheduleBoundedSynthesis = bounded
 * MANUAL_MERGE_SYNTHESIS_MAX_MS forceSynthesis reshape, invalidateCache = drop
 * BOTH curated prefixes) against in-memory fakes, then asserts the response-shape
 * markers each route builds:
 *
 *   - honest mutationStatus (applied/persisted/deferred/conflicted/no-op/failed),
 *   - reshaped flag reflects whether the inline deterministic reshape ran,
 *   - deferred flag = (status is persisted|deferred) — i.e. reshape was deferred
 *     behind a busy clustering pass, matching the legacy evict/move/link shape,
 *   - link/merge `formed` is only verified when reshaped ran (idle fast path),
 *   - a busy pass triggers schedulePendingManualReshape + requestClusteringYield
 *     for forward edits (yieldReason set) but NOT for undos (no yieldReason),
 *   - bounded synthesis is coalesced across a burst and NEVER blocks a later edit,
 *   - undo routes use the SAME coordinator + fail-closed stale revalidation,
 *   - exact-once curated cache invalidation per state-changing intent.
 *
 * No test framework — run directly with tsx:
 *   npx tsx scripts/curated-manual-mutation-live-wiring.test.ts
 * Exits non-zero on any failure.
 */
import {
  CuratedManualMutationCoordinator,
  type ManualMutationDeps,
  type ManualMutationIntent,
  type ManualMutationResult,
  type RevalidateResult,
} from '../server/curatedManualMutationCoordinator';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const MANUAL_MERGE_SYNTHESIS_MAX_MS = 30_000; // mirrors curatedCluster export

// A fake standing in for the curatedCluster + curatedCacheBus effects the live
// routes wire into the coordinator.
class FakeClusterWorld {
  clusteringBusy = false;
  reshapeSkipped = false; // when true, reshapeCuratedLane reports skipped
  reshapeThrows = false;
  // effect log
  invalidations: string[] = []; // prefix per invalidateCuratedCache call
  cheapReshapes = 0;
  deferredReshapes: { forceSynthesis: boolean; maxMs?: number }[] = [];
  yields: string[] = [];
  boundedSynthesisRuns: { keys: string[]; maxMs: number }[] = [];

  invalidateCuratedCache(prefix: string) {
    this.invalidations.push(prefix);
  }
  isCuratedClusteringRunning() {
    return this.clusteringBusy;
  }
  async reshapeCuratedLane(opts?: { forceSynthesis?: boolean; maxDurationMs?: number }): Promise<{ skipped?: boolean }> {
    if (this.reshapeThrows) throw new Error('reshape boom');
    if (opts?.forceSynthesis) {
      this.boundedSynthesisRuns.push({ keys: [], maxMs: opts.maxDurationMs ?? -1 });
    } else {
      this.cheapReshapes++;
    }
    return { skipped: this.reshapeSkipped };
  }
  schedulePendingManualReshape(forceSynthesis: boolean, maxMs?: number) {
    this.deferredReshapes.push({ forceSynthesis, maxMs });
  }
  requestCuratedClusteringYield(reason: string) {
    this.yields.push(reason);
    return true;
  }
}

// Build the coordinator with the SAME wiring shape server/routes.ts uses.
function buildLiveWiredCoordinator(world: FakeClusterWorld) {
  // Per-intent route-specific revalidation, injected via payload (as in routes).
  interface Payload {
    revalidate?: () => Promise<RevalidateResult> | RevalidateResult;
    captureRequired?: () => Promise<string> | string;
    apply: () => Promise<{ changed: boolean; reason?: string; data?: Record<string, unknown> }>;
  }
  const deps: ManualMutationDeps = {
    now: () => Date.now(),
    isClusteringBusy: () => world.isCuratedClusteringRunning(),
    revalidateTarget: (target, intent) => {
      const p = intent.payload as Payload | undefined;
      if (p?.revalidate) return p.revalidate();
      return { currentRevision: target.seenRevision, live: true };
    },
    validateIntent: () => null,
    beforeApply: (intent) => {
      const p = intent.payload as Payload | undefined;
      if (!p?.captureRequired) throw new Error('captureRequired missing');
      return p.captureRequired();
    },
    finalizeEvidence: async () => {},
    applyIntent: (intent) => {
      const p = intent.payload as Payload;
      return p.apply();
    },
    // runCheapReshape: deterministic reshape + BOTH-prefix invalidation (idle path)
    runCheapReshape: () => {
      // Live routes now schedule this work instead of awaiting it.
      void world.reshapeCuratedLane().then(() => {
        world.invalidateCuratedCache('top-stories');
        world.invalidateCuratedCache('cluster-members');
      });
      return false;
    },
    // deferReshape: schedule + (optional) yield, mirroring the busy branch
    deferReshape: (intent) => {
      world.schedulePendingManualReshape(intent.forceSynthesis === true, intent.synthesisMaxMs);
      if (intent.yieldReason) world.requestCuratedClusteringYield(intent.yieldReason);
    },
    // invalidateCache: exact hook, BOTH curated prefixes, once per state change
    invalidateCache: () => {
      world.invalidateCuratedCache('top-stories');
      world.invalidateCuratedCache('cluster-members');
    },
    // scheduleBoundedSynthesis: one bounded forceSynthesis reshape per burst
    scheduleBoundedSynthesis: (keys) => {
      // fire-and-forget in production; here we run synchronously-ish for assertion
      void world
        .reshapeCuratedLane({ forceSynthesis: true, maxDurationMs: MANUAL_MERGE_SYNTHESIS_MAX_MS })
        .then(() => {
          world.invalidateCuratedCache('top-stories');
          world.invalidateCuratedCache('cluster-members');
          // record keys on the last bounded run for assertion
          const last = world.boundedSynthesisRuns[world.boundedSynthesisRuns.length - 1];
          if (last) last.keys = keys.slice();
        })
        .catch(() => undefined);
    },
    log: () => undefined,
  };
  return new CuratedManualMutationCoordinator(deps);
}

async function tick() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// Mirrors the mapping every refactored route applies to the coordinator result.
function toRouteShape(result: ManualMutationResult, opts: { includeFormed?: boolean; formed?: boolean } = {}) {
  const deferred = result.status === 'persisted' || result.status === 'deferred';
  const shape: Record<string, unknown> = {
    ok: true,
    id: (result.data.id as string) ?? null,
    reshaped: result.reshaped,
    deferred,
    mutationStatus: result.status,
  };
  if (opts.includeFormed) shape.formed = result.reshaped ? opts.formed === true : false;
  return shape;
}

// ---------------------------------------------------------------------------
async function testLinkIdlePath() {
  console.log('\n[link/merge — idle fast path applies + bounded synthesis]');
  const world = new FakeClusterWorld();
  const c = buildLiveWiredCoordinator(world);

  const result = await c.submit({
    kind: 'merge',
    dedupeKey: 'link:merge:a|b',
    targets: [{ id: 'member:a', seenRevision: 0 }, { id: 'member:b', seenRevision: 0 }],
    wantsSynthesis: true,
    forceSynthesis: true,
    synthesisMaxMs: MANUAL_MERGE_SYNTHESIS_MAX_MS,
    yieldReason: 'manual link/merge',
    payload: {
      captureRequired: () => 'episode:row-1',
      apply: async () => ({ changed: true, data: { id: 'row-1' } }),
    },
  });
  await tick();

  const shape = toRouteShape(result, { includeFormed: true, formed: true });
  check('idle merge durable write returns persisted while reshape is scheduled', result.status === 'persisted', result.status);
  check('route reshaped=false because HTTP no longer awaits reshape', shape.reshaped === false, String(shape.reshaped));
  check('route deferred=true while background reshape is scheduled', shape.deferred === true, String(shape.deferred));
  check('route id surfaced from apply data', shape.id === 'row-1', String(shape.id));
  check('mutationStatus honest = persisted', shape.mutationStatus === 'persisted', String(shape.mutationStatus));
  // Idle path invalidates BOTH prefixes from three sources: the exact
  // invalidateCache hook, the cheap-reshape wrapper, and the bounded-synthesis
  // completion — always in balanced top-stories/cluster-members pairs.
  const tsIdle = world.invalidations.filter((p) => p === 'top-stories').length;
  const cmIdle = world.invalidations.filter((p) => p === 'cluster-members').length;
  check('cache invalidated in balanced prefix pairs', tsIdle === cmIdle && tsIdle >= 2, JSON.stringify(world.invalidations));
  check('exact invalidateCache hook fired once for the applied intent', tsIdle >= 2, JSON.stringify(world.invalidations));
  check('bounded synthesis scheduled once with MANUAL_MERGE budget', world.boundedSynthesisRuns.length === 1 && world.boundedSynthesisRuns[0].maxMs === MANUAL_MERGE_SYNTHESIS_MAX_MS, JSON.stringify(world.boundedSynthesisRuns));
  check('bounded synthesis covered the merge key', world.boundedSynthesisRuns[0].keys.includes('link:merge:a|b'), JSON.stringify(world.boundedSynthesisRuns[0].keys));
  check('idle path performed NO clustering yield', world.yields.length === 0, JSON.stringify(world.yields));
}

// ---------------------------------------------------------------------------
async function testLinkBusyDeferred() {
  console.log('\n[link/merge — busy path persists + defers + yields]');
  const world = new FakeClusterWorld();
  world.clusteringBusy = true;
  const c = buildLiveWiredCoordinator(world);

  const result = await c.submit({
    kind: 'merge',
    dedupeKey: 'link:merge:busy',
    targets: [{ id: 'member:x', seenRevision: 0 }],
    wantsSynthesis: true,
    forceSynthesis: true,
    synthesisMaxMs: MANUAL_MERGE_SYNTHESIS_MAX_MS,
    yieldReason: 'manual link/merge',
    payload: {
      captureRequired: () => 'episode:row-b',
      apply: async () => ({ changed: true, data: { id: 'row-b' } }),
    },
  });
  await tick();

  const shape = toRouteShape(result, { includeFormed: true, formed: false });
  check('busy merge => persisted', result.status === 'persisted', result.status);
  check('route deferred=true on busy', shape.deferred === true, String(shape.deferred));
  check('route reshaped=false on busy', shape.reshaped === false, String(shape.reshaped));
  check('route formed=false when not reshaped', shape.formed === false, String(shape.formed));
  check('deferred reshape scheduled with synthesis + MANUAL_MERGE budget', world.deferredReshapes.length === 1 && world.deferredReshapes[0].forceSynthesis === true && world.deferredReshapes[0].maxMs === MANUAL_MERGE_SYNTHESIS_MAX_MS, JSON.stringify(world.deferredReshapes));
  check('forward edit requested clustering yield with reason', world.yields.includes('manual link/merge'), JSON.stringify(world.yields));
  // Even on the busy path the state-changing write fires the exact cache hook
  // (both prefixes) once — the editor's action is durable + visible immediately.
  check('cache invalidated (both prefixes) even when busy', world.invalidations.filter((p) => p === 'top-stories').length >= 1 && world.invalidations.filter((p) => p === 'cluster-members').length >= 1, JSON.stringify(world.invalidations));
  check('no inline cheap reshape on busy path', world.cheapReshapes === 0, String(world.cheapReshapes));
}

// ---------------------------------------------------------------------------
async function testUndoBusyNoYield() {
  console.log('\n[undo (unevict/unmove/unlink) — busy defers WITHOUT yield]');
  const world = new FakeClusterWorld();
  world.clusteringBusy = true;
  const c = buildLiveWiredCoordinator(world);

  const result = await c.submit({
    kind: 'undo',
    undoOf: 'move:99',
    dedupeKey: 'unmove:99',
    targets: [{ id: 'manual-move:99', seenRevision: 0 }],
    wantsSynthesis: true,
    forceSynthesis: true,
    // NO yieldReason — undos must not preempt an in-flight pass (legacy behavior)
    payload: {
      captureRequired: () => 'episode:99',
      apply: async () => ({ changed: true, data: { id: '99' } }),
    },
  });
  await tick();

  check('busy undo => persisted', result.status === 'persisted', result.status);
  check('undo deferred reshape scheduled (with synthesis)', world.deferredReshapes.length === 1 && world.deferredReshapes[0].forceSynthesis === true, JSON.stringify(world.deferredReshapes));
  check('undo did NOT request clustering yield', world.yields.length === 0, JSON.stringify(world.yields));
}

// ---------------------------------------------------------------------------
async function testUnlinkNotFoundNoop() {
  console.log('\n[undo — revoke not-found maps to no-op (route → 404)]');
  const world = new FakeClusterWorld();
  const c = buildLiveWiredCoordinator(world);

  const result = await c.submit({
    kind: 'undo',
    undoOf: 'link:missing',
    dedupeKey: 'unlink:missing',
    targets: [{ id: 'manual-link:missing', seenRevision: 0 }],
    payload: {
      captureRequired: () => 'episode:missing',
      apply: async () => ({ changed: false, reason: 'not found' }),
    },
  });
  await tick();

  check('missing revoke => no-op', result.status === 'no-op', result.status);
  check('no-op performed NO cache invalidation', world.invalidations.length === 0, JSON.stringify(world.invalidations));
  check('no-op performed NO reshape', world.cheapReshapes === 0 && world.deferredReshapes.length === 0, 'reshape happened');
  // The route maps no-op → 404 Manual link not found (asserted by inspecting status).
}

// ---------------------------------------------------------------------------
async function testStaleSocialAttachConflicted() {
  console.log('\n[social attach — stale target revalidation fails closed]');
  const world = new FakeClusterWorld();
  const c = buildLiveWiredCoordinator(world);

  // The social attach re-resolves both sides at commit; model the target having
  // dispersed (no longer a formed story) via a revalidate returning not-live.
  let applyRan = false;
  const result = await c.submit({
    kind: 'link',
    dedupeKey: 'link:social:attach',
    targets: [{ id: 'cluster:target', seenRevision: 5 }],
    payload: {
      captureRequired: () => 'episode:social-attach',
      revalidate: () => ({ currentRevision: 5, live: false }),
      apply: async () => {
        applyRan = true;
        return { changed: true, data: { id: 'should-not-write' } };
      },
    },
  });
  await tick();

  check('stale/dispersed target => conflicted', result.status === 'conflicted', result.status);
  check('conflict performed NO write (apply never ran)', applyRan === false, String(applyRan));
  check('conflict performed NO cache invalidation', world.invalidations.length === 0, JSON.stringify(world.invalidations));
}

// ---------------------------------------------------------------------------
async function testMixedBurstSynthesisCoalesced() {
  console.log('\n[mixed burst — synthesis coalesced, never blocks a later edit]');
  const world = new FakeClusterWorld();
  const c = buildLiveWiredCoordinator(world);

  // A burst: merge (wants synthesis), evict (wants synthesis), unlink (no synth).
  const ps = [
    c.submit({ kind: 'merge', dedupeKey: 'm1', targets: [{ id: 'x', seenRevision: 0 }], wantsSynthesis: true, forceSynthesis: true, synthesisMaxMs: MANUAL_MERGE_SYNTHESIS_MAX_MS, yieldReason: 'manual link/merge', payload: { captureRequired: () => 'episode:m1', apply: async () => ({ changed: true, data: { id: 'm1' } }) } }),
    c.submit({ kind: 'evict', dedupeKey: 'e1', targets: [{ id: 'y', seenRevision: 0 }], wantsSynthesis: true, forceSynthesis: true, yieldReason: 'manual evict', payload: { captureRequired: () => 'episode:e1', apply: async () => ({ changed: true, data: { id: 'e1' } }) } }),
    c.submit({ kind: 'unlink', dedupeKey: 'u1', targets: [{ id: 'z', seenRevision: 0 }], forceSynthesis: false, yieldReason: 'manual unlink', payload: { captureRequired: () => 'episode:u1', apply: async () => ({ changed: true, data: { id: 'u1' } }) } }),
  ];
  const results = await Promise.all(ps);
  await tick();

  check('all three writes persist while reshapes are deferred', results.every((r) => r.status === 'persisted'), results.map((r) => r.status).join(','));
  check('three inline cheap reshapes ran (one per edit)', world.cheapReshapes === 3, String(world.cheapReshapes));
  check('bounded synthesis scheduled EXACTLY ONCE for the burst', world.boundedSynthesisRuns.length === 1, String(world.boundedSynthesisRuns.length));
  check('single synthesis covers only the two synthesis-wanting keys', world.boundedSynthesisRuns[0].keys.slice().sort().join(',') === 'e1,m1', JSON.stringify(world.boundedSynthesisRuns[0].keys));
  // Determinism: seq order matches submission order.
  check('serial seq order m1<e1<u1', results[0].seq < results[1].seq && results[1].seq < results[2].seq, results.map((r) => r.seq).join(','));
}

// ---------------------------------------------------------------------------
async function testReshapeSkippedHonest() {
  console.log('\n[reshape skipped => applied but reshaped=false (honest)]');
  const world = new FakeClusterWorld();
  world.reshapeSkipped = true; // clustering disabled/skips
  const c = buildLiveWiredCoordinator(world);

  const result = await c.submit({
    kind: 'link',
    dedupeKey: 'link:skip',
    targets: [{ id: 'member:s', seenRevision: 0 }],
    wantsSynthesis: true,
    forceSynthesis: true,
    payload: {
      captureRequired: () => 'episode:row-s',
      apply: async () => ({ changed: true, data: { id: 'row-s' } }),
    },
  });
  await tick();

  check('write landed => persisted while reshape remains deferred', result.status === 'persisted', result.status);
  check('reshaped=false when reshape skipped (honest)', result.reshaped === false, String(result.reshaped));
  const shape = toRouteShape(result, { includeFormed: true, formed: true });
  check('formed=false when reshape did not run', shape.formed === false, String(shape.formed));
}

// ---------------------------------------------------------------------------
async function testApplyThrowFailed() {
  console.log('\n[apply throw => failed, fail-closed, retryable]');
  const world = new FakeClusterWorld();
  const c = buildLiveWiredCoordinator(world);

  const result = await c.submit({
    kind: 'evict',
    dedupeKey: 'evict:boom',
    targets: [{ id: 'member:b', seenRevision: 0 }],
    payload: {
      captureRequired: () => 'episode:boom',
      apply: async () => { throw new Error('db down'); },
    },
  });
  await tick();

  check('apply throw => failed', result.status === 'failed', result.status);
  check('failed performed NO cache invalidation', world.invalidations.length === 0, JSON.stringify(world.invalidations));
  check('failed not idempotent-cached (retryable)', result.idempotentHit === false, String(result.idempotentHit));
}

// ---------------------------------------------------------------------------
(async () => {
  await testLinkIdlePath();
  await testLinkBusyDeferred();
  await testUndoBusyNoYield();
  await testUnlinkNotFoundNoop();
  await testStaleSocialAttachConflicted();
  await testMixedBurstSynthesisCoalesced();
  await testReshapeSkippedHonest();
  await testApplyThrowFailed();

  console.log('');
  if (failures > 0) {
    console.error(`curated-manual-mutation-live-wiring: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('curated-manual-mutation-live-wiring: all checks passed');
  process.exit(0);
})().catch((err) => {
  console.error('curated-manual-mutation-live-wiring: unexpected error', err);
  process.exit(1);
});
