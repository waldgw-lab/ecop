/**
 * Curated manual mutation coordinator (Task #1180).
 *
 * The coordinator is the single SERIAL, DETERMINISTIC entry point every editor
 * manual mutation route (link/merge/move/evict/unlink/undo) submits its intent
 * to. This test drives the PURE, dependency-injected core with in-memory fakes
 * for every effect (clock, clustering-busy, revalidate, validate, apply, reshape,
 * defer, invalidate, synthesis) — no DB, no AI, no HTTP — and proves the eight
 * load-bearing behaviours from the task:
 *
 *   1. concurrent edits serialize deterministically (no interleave, stable order),
 *   2. a repeated intent is idempotent (one apply, cached result on the repeat),
 *   3. a stale target fails closed with `conflicted` and performs NO write,
 *   4. a busy clustering pass takes the deferred path (`persisted`, reshape
 *      deferred not blocked) and STILL invalidates the cache exactly once,
 *   5. bounded synthesis is COALESCED across a burst (one schedule call, all keys)
 *      and never blocks a later edit,
 *   6. undo takes the SAME validated/revalidated/applied path as any intent,
 *   7. fail-closed validation => `failed` with no effect, and
 *   8. dormant/no-op statuses are truthful.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-manual-mutation-coordinator.test.ts
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
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// A programmable in-memory harness capturing every injected effect so each test
// can assert exactly what the coordinator did.
interface Harness {
  deps: ManualMutationDeps;
  events: string[]; // ordered log of effect calls
  applied: string[]; // dedupeKeys whose applyIntent ran + changed
  reshaped: string[]; // dedupeKeys whose inline cheap reshape ran
  deferred: string[]; // dedupeKeys whose reshape was deferred
  invalidated: string[]; // dedupeKeys whose cache was invalidated
  synthesisCalls: string[][]; // one array of keys per scheduleBoundedSynthesis call
  finalized: Array<{ episodeId: string; status: string; key: string }>;
  setBusy: (b: boolean) => void;
  setRevision: (targetId: string, rev: number) => void;
  setLive: (targetId: string, live: boolean, dormant?: boolean) => void;
  failApply: (dedupeKey: string) => void;
  failEvidence: (dedupeKey: string) => void;
  noopApply: (dedupeKey: string) => void;
  gateApply: (dedupeKey: string) => () => void; // returns a release fn
}

function makeHarness(): Harness {
  let clock = 1_000;
  let busy = false;
  const revisions = new Map<string, number>();
  const liveState = new Map<string, { live: boolean; dormant: boolean }>();
  const failApplies = new Set<string>();
  const failEvidence = new Set<string>();
  const noopApplies = new Set<string>();
  const applyGates = new Map<string, Promise<void>>();
  const applyGateReleases = new Map<string, () => void>();

  const events: string[] = [];
  const applied: string[] = [];
  const reshaped: string[] = [];
  const deferred: string[] = [];
  const invalidated: string[] = [];
  const synthesisCalls: string[][] = [];
  const finalized: Array<{ episodeId: string; status: string; key: string }> = [];

  const deps: ManualMutationDeps = {
    now: () => (clock += 1),
    isClusteringBusy: () => busy,
    revalidateTarget: (target): RevalidateResult => {
      const rev = revisions.has(target.id) ? revisions.get(target.id)! : target.seenRevision;
      const ls = liveState.get(target.id) ?? { live: true, dormant: false };
      return { currentRevision: rev, live: ls.live, dormant: ls.dormant };
    },
    validateIntent: (intent) => {
      if (intent.dedupeKey.startsWith('invalid:')) return 'bad intent';
      return null;
    },
    beforeApply: (intent) => {
      events.push(`evidence:${intent.dedupeKey}`);
      if (failEvidence.has(intent.dedupeKey)) throw new Error('evidence unavailable');
      return `episode:${intent.dedupeKey}`;
    },
    finalizeEvidence: (episodeId, status, _note, intent) => {
      events.push(`finalize:${intent.dedupeKey}:${status}`);
      finalized.push({ episodeId, status, key: intent.dedupeKey });
    },
    applyIntent: async (intent) => {
      events.push(`apply:${intent.dedupeKey}`);
      const gate = applyGates.get(intent.dedupeKey);
      if (gate) await gate;
      if (failApplies.has(intent.dedupeKey)) throw new Error('boom');
      if (noopApplies.has(intent.dedupeKey)) return { changed: false, reason: 'nothing to do' };
      applied.push(intent.dedupeKey);
      return { changed: true };
    },
    runCheapReshape: (intent) => {
      events.push(`reshape:${intent.dedupeKey}`);
      reshaped.push(intent.dedupeKey);
    },
    deferReshape: (intent) => {
      events.push(`defer:${intent.dedupeKey}`);
      deferred.push(intent.dedupeKey);
    },
    invalidateCache: (intent) => {
      events.push(`invalidate:${intent.dedupeKey}`);
      invalidated.push(intent.dedupeKey);
    },
    scheduleBoundedSynthesis: (keys) => {
      events.push(`synth:${keys.join(',')}`);
      synthesisCalls.push(keys.slice());
    },
    log: () => undefined,
  };

  return {
    deps,
    events,
    applied,
    reshaped,
    deferred,
    invalidated,
    synthesisCalls,
    finalized,
    setBusy: (b) => {
      busy = b;
    },
    setRevision: (id, rev) => revisions.set(id, rev),
    setLive: (id, live, dormant = false) => liveState.set(id, { live, dormant }),
    failApply: (k) => failApplies.add(k),
    failEvidence: (k) => failEvidence.add(k),
    noopApply: (k) => noopApplies.add(k),
    gateApply: (k) => {
      let release!: () => void;
      const p = new Promise<void>((res) => {
        release = res;
      });
      applyGates.set(k, p);
      applyGateReleases.set(k, release);
      return () => {
        applyGates.delete(k);
        release();
      };
    },
  };
}

function intent(kind: ManualMutationIntent['kind'], key: string, over: Partial<ManualMutationIntent> = {}): ManualMutationIntent {
  return {
    kind,
    dedupeKey: key,
    targets: over.targets ?? [{ id: `cluster:${key}`, seenRevision: 1 }],
    wantsSynthesis: over.wantsSynthesis,
    payload: over.payload,
    undoOf: over.undoOf,
  };
}

async function tick(): Promise<void> {
  // Flush microtasks + a macrotask so the coalesced-synthesis drain fires.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
async function testSerialOrdering() {
  console.log('\n[serial ordering]');
  const h = makeHarness();
  const c = new CuratedManualMutationCoordinator(h.deps);

  // Gate the FIRST apply so it can't finish until we release it, then submit a
  // second intent while the first is in flight. A correct serial coordinator must
  // NOT start apply:b until apply:a has settled.
  const release = h.gateApply('a');
  const pA = c.submit(intent('link', 'a'));
  const pB = c.submit(intent('merge', 'b'));

  // Give the chain a moment; b's apply must not have started yet.
  await tick();
  check('second apply does not start before first settles', !h.events.includes('apply:b'), h.events.join(' '));

  release();
  const [rA, rB] = await Promise.all([pA, pB]);
  await tick();

  check('both applied', rA.status === 'applied' && rB.status === 'applied', `${rA.status}/${rB.status}`);
  check('deterministic seq order a<b', rA.seq < rB.seq, `${rA.seq}/${rB.seq}`);
  // apply:a and reshape:a must fully precede apply:b (no interleave).
  const idxReshapeA = h.events.indexOf('reshape:a');
  const idxApplyB = h.events.indexOf('apply:b');
  check('no interleave: a fully done before b applies', idxReshapeA >= 0 && idxApplyB > idxReshapeA, h.events.join(' '));
}

// ---------------------------------------------------------------------------
async function testIdempotency() {
  console.log('\n[repeated intent / idempotency]');
  const h = makeHarness();
  const c = new CuratedManualMutationCoordinator(h.deps);

  const r1 = await c.submit(intent('link', 'dup'));
  const r2 = await c.submit(intent('link', 'dup'));
  await tick();

  check('first is applied', r1.status === 'applied', r1.status);
  check('repeat is cached (same status)', r2.status === 'applied', r2.status);
  check('repeat flagged idempotentHit', r2.idempotentHit === true, String(r2.idempotentHit));
  check('applyIntent ran exactly once', h.applied.filter((k) => k === 'dup').length === 1, JSON.stringify(h.applied));
  check('cache invalidated exactly once', h.invalidated.filter((k) => k === 'dup').length === 1, JSON.stringify(h.invalidated));
}

// ---------------------------------------------------------------------------
async function testStaleTarget() {
  console.log('\n[stale target revalidation]');
  const h = makeHarness();
  const c = new CuratedManualMutationCoordinator(h.deps);

  // Route saw revision 1; world has moved to revision 5 by apply time.
  h.setRevision('cluster:stale', 5);
  const r = await c.submit(intent('move', 'stale', { targets: [{ id: 'cluster:stale', seenRevision: 1 }] }));
  await tick();

  check('stale target => conflicted', r.status === 'conflicted', r.status);
  check('no write performed on conflict', !h.applied.includes('stale'), JSON.stringify(h.applied));
  check('no cache invalidation on conflict', !h.invalidated.includes('stale'), JSON.stringify(h.invalidated));

  // A gone (non-live) target also conflicts, fail-closed.
  h.setLive('cluster:gone', false);
  const r2 = await c.submit(intent('unlink', 'gone', { targets: [{ id: 'cluster:gone', seenRevision: 1 }] }));
  check('gone target => conflicted', r2.status === 'conflicted', r2.status);
}

// ---------------------------------------------------------------------------
async function testBusyDeferred() {
  console.log('\n[clustering-busy deferred path]');
  const h = makeHarness();
  const c = new CuratedManualMutationCoordinator(h.deps);

  h.setBusy(true);
  const r = await c.submit(intent('merge', 'busy1'));
  await tick();

  check('busy path => persisted', r.status === 'persisted', r.status);
  check('write landed while busy', h.applied.includes('busy1'), JSON.stringify(h.applied));
  check('reshape deferred not run inline', h.deferred.includes('busy1') && !h.reshaped.includes('busy1'), h.events.join(' '));
  check('cache invalidated exactly once even when busy', h.invalidated.filter((k) => k === 'busy1').length === 1, JSON.stringify(h.invalidated));

  // Once the pass frees, a later intent runs inline (deterministic switch).
  h.setBusy(false);
  const r2 = await c.submit(intent('merge', 'free1'));
  await tick();
  check('after busy clears => applied inline', r2.status === 'applied', r2.status);
  check('later intent reshaped inline', h.reshaped.includes('free1'), JSON.stringify(h.reshaped));
}

// ---------------------------------------------------------------------------
async function testSynthesisCoalescing() {
  console.log('\n[coalesced bounded synthesis]');
  const h = makeHarness();
  const c = new CuratedManualMutationCoordinator(h.deps);

  // Submit a burst of synthesis-wanting intents in the same tick.
  const ps = [
    c.submit(intent('link', 's1', { wantsSynthesis: true })),
    c.submit(intent('link', 's2', { wantsSynthesis: true })),
    c.submit(intent('link', 's3', { wantsSynthesis: true })),
  ];
  const results = await Promise.all(ps);
  await tick();

  check('all synthesis intents applied', results.every((r) => r.status === 'applied'), results.map((r) => r.status).join(','));
  check('synthesis scheduled exactly ONCE for the burst', h.synthesisCalls.length === 1, `calls=${h.synthesisCalls.length}`);
  check(
    'single synthesis call covers all three keys',
    h.synthesisCalls.length === 1 &&
      ['s1', 's2', 's3'].every((k) => h.synthesisCalls[0].includes(k)),
    JSON.stringify(h.synthesisCalls),
  );

  // Synthesis must NEVER block a later edit: the synth call appears in the event
  // log AFTER all applies/reshapes (it was scheduled, not awaited between edits).
  const lastReshapeIdx = Math.max(...['s1', 's2', 's3'].map((k) => h.events.indexOf(`reshape:${k}`)));
  const synthIdx = h.events.findIndex((e) => e.startsWith('synth:'));
  check('synthesis scheduled after all edits drained (never blocks a later edit)', synthIdx > lastReshapeIdx, h.events.join(' '));

  // A brand-new burst later schedules a SECOND, independent coalesced call.
  await c.submit(intent('link', 's4', { wantsSynthesis: true }));
  await tick();
  check('a later burst schedules a fresh synthesis call', h.synthesisCalls.length === 2, `calls=${h.synthesisCalls.length}`);
  check('second call covers only the new burst', h.synthesisCalls[1].join(',') === 's4', JSON.stringify(h.synthesisCalls[1]));
}

// ---------------------------------------------------------------------------
async function testUndoSamePath() {
  console.log('\n[undo takes the same path]');
  const h = makeHarness();
  const c = new CuratedManualMutationCoordinator(h.deps);

  const applyRes = await c.submit(intent('merge', 'op-42', { wantsSynthesis: true }));
  await tick();
  check('original op applied', applyRes.status === 'applied', applyRes.status);

  // Undo is just another intent — validated, revalidated, applied, reshaped,
  // invalidated, coalesced-synthesis — identical machinery.
  const undoRes = await c.submit(intent('undo', 'undo-op-42', { undoOf: 'op-42', wantsSynthesis: true }));
  await tick();
  check('undo applied via same path', undoRes.status === 'applied', undoRes.status);
  check('undo ran apply + reshape + invalidate', h.applied.includes('undo-op-42') && h.reshaped.includes('undo-op-42') && h.invalidated.includes('undo-op-42'), h.events.join(' '));

  // Undo obeys stale-target revalidation too (fail-closed).
  h.setRevision('cluster:undo-stale', 9);
  const undoStale = await c.submit(
    intent('undo', 'undo-stale', { undoOf: 'x', targets: [{ id: 'cluster:undo-stale', seenRevision: 1 }] }),
  );
  check('stale undo => conflicted (same fail-closed rule)', undoStale.status === 'conflicted', undoStale.status);
}

// ---------------------------------------------------------------------------
async function testFailClosedAndNoop() {
  console.log('\n[fail-closed validation + no-op + dormant + apply-throw]');
  const h = makeHarness();
  const c = new CuratedManualMutationCoordinator(h.deps);

  const bad = await c.submit(intent('link', 'invalid:x'));
  check('invalid intent => failed', bad.status === 'failed', bad.status);
  check('failed intent performed no write', !h.applied.includes('invalid:x'), JSON.stringify(h.applied));

  h.failEvidence('evidence-fails');
  const evidenceFailed = await c.submit(intent('link', 'evidence-fails'));
  check('required evidence failure => failed', evidenceFailed.status === 'failed', evidenceFailed.status);
  check('required evidence failure performs no write', !h.events.includes('apply:evidence-fails'), h.events.join(' '));
  check('required evidence failure performs no reshape/invalidation',
    !h.reshaped.includes('evidence-fails') && !h.invalidated.includes('evidence-fails'),
    h.events.join(' '));
  const evidenceRetry = await c.submit(intent('link', 'evidence-fails'));
  check('evidence failure is retryable, not cached', evidenceRetry.idempotentHit === false, String(evidenceRetry.idempotentHit));

  h.noopApply('noop1');
  const noop = await c.submit(intent('move', 'noop1'));
  check('unchanged apply => no-op', noop.status === 'no-op', noop.status);
  check('no-op did not invalidate cache', !h.invalidated.includes('noop1'), JSON.stringify(h.invalidated));

  h.setLive('cluster:dorm', true, true);
  const dorm = await c.submit(intent('evict', 'dorm', { targets: [{ id: 'cluster:dorm', seenRevision: 1 }] }));
  check('dormant target => dormant', dorm.status === 'dormant', dorm.status);
  check('dormant performed no write', !h.applied.includes('dorm'), JSON.stringify(h.applied));

  h.failApply('throws1');
  const thrown = await c.submit(intent('merge', 'throws1'));
  check('apply throw => failed (fail-closed)', thrown.status === 'failed', thrown.status);
  check(
    'apply throw durably finalizes captured evidence as failed',
    h.finalized.some((entry) => entry.key === 'throws1' && entry.status === 'failed'),
    JSON.stringify(h.finalized),
  );
  check('failed apply not cached — retry allowed', thrown.idempotentHit === false, String(thrown.idempotentHit));
  // A retry of a thrown apply is NOT served from cache: submitting again attempts apply again.
  const retry = await c.submit(intent('merge', 'throws1'));
  check('thrown apply is retryable (not idempotent-cached)', retry.idempotentHit === false, String(retry.idempotentHit));
}

// ---------------------------------------------------------------------------
(async () => {
  await testSerialOrdering();
  await testIdempotency();
  await testStaleTarget();
  await testBusyDeferred();
  await testSynthesisCoalescing();
  await testUndoSamePath();
  await testFailClosedAndNoop();

  console.log('');
  if (failures > 0) {
    console.error(`curated-manual-mutation-coordinator: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('curated-manual-mutation-coordinator: all checks passed');
  process.exit(0);
})().catch((err) => {
  console.error('curated-manual-mutation-coordinator: unexpected error', err);
  process.exit(1);
});
