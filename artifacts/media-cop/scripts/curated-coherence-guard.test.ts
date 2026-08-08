/**
 * Curated coherence-guard removal-application regression (Task #179).
 *
 * pruneIncoherentClusters asks an LLM which cluster members don't belong, then
 * APPLIES the answer deterministically. The application step carries the real
 * isolation-critical invariants (a degenerate "drop everything" answer must not
 * wipe a good cluster; overlapping clusters must not double-count drops), but it
 * used to be inlined inside the LLM function, so it could only be exercised with a
 * live, non-deterministic model call. `applyCoherenceRemovals` is the extracted
 * pure core; this test pins its contract WITHOUT the LLM.
 *
 * `removeByCheckableCluster` is keyed by index into
 * `checkable = groups.filter(g => g.keys.length >= 2)` (the exact indexing the
 * guard builds), with 0-based item indices to drop.
 *
 * Pure, deterministic (no network / DB / LLM). Exits non-zero on any violation so
 * it can run as a regression gate.
 *
 * Usage:  tsx scripts/curated-coherence-guard.test.ts
 */

import { applyCoherenceRemovals } from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[coherence] OK   ${name}`);
  } else {
    console.error(`[coherence] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

type Group = { keys: string[] };
const keysOf = (groups: Group[]): string[][] => groups.map(g => g.keys);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// 1 — PARTIAL DROP: a flagged member is removed, the rest of the cluster is kept,
// the dropped key is counted once, and exactly one cluster is recorded as pruned.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [{ keys: ['a', 'b', 'c'] }];
  const remove = new Map<number, Set<number>>([[0, new Set([1])]]); // drop 'b'
  const r = applyCoherenceRemovals(groups, remove);
  check(
    '1: a flagged member is dropped, the rest of the cluster is kept',
    eq(keysOf(r.groups), [['a', 'c']]),
    `got ${JSON.stringify(keysOf(r.groups))}`,
  );
  check('1: droppedKeys counts exactly the removed key', eq([...r.droppedKeys], ['b']),
    `got ${JSON.stringify([...r.droppedKeys])}`);
  check('1: prunedClusters === 1', r.prunedClusters === 1, `got ${r.prunedClusters}`);
}

// ---------------------------------------------------------------------------
// 2a — 2-MEMBER ALL-FLAGGED DISSOLVE: for an exactly-2-member cluster the guard's
// "flag both" answer is the correct "different events" verdict. The pair is
// DISSOLVED (empty keys returned) so both items fall back to standalones. Both
// keys count as dropped and the cluster is counted as pruned.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [{ keys: ['x', 'y'] }];
  const remove = new Map<number, Set<number>>([[0, new Set([0, 1])]]); // flag both
  const r = applyCoherenceRemovals(groups, remove);
  check('2a: a 2-member all-flagged cluster is DISSOLVED (empty keys)',
    eq(keysOf(r.groups), [[]]),
    `got ${JSON.stringify(keysOf(r.groups))}`);
  check('2a: both keys are counted as dropped', r.droppedKeys.size === 2 && r.droppedKeys.has('x') && r.droppedKeys.has('y'),
    `droppedKeys=${JSON.stringify([...r.droppedKeys])}`);
  check('2a: prunedClusters === 1 (the pair counted as pruned)', r.prunedClusters === 1,
    `prunedClusters=${r.prunedClusters}`);
}

// ---------------------------------------------------------------------------
// 2b — 3+-MEMBER ALL-FLAGGED FAIL-SAFE: a degenerate answer that flags EVERY
// member of a 3+-member cluster must NOT wipe it — the original cluster is
// returned intact, nothing is counted dropped, and no cluster is counted pruned.
// (This fail-safe only applies to 3+ members, not 2-member pairs.)
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [{ keys: ['x', 'y', 'z'] }];
  const remove = new Map<number, Set<number>>([[0, new Set([0, 1, 2])]]); // flag all 3
  const r = applyCoherenceRemovals(groups, remove);
  check('2b: a 3-member all-flagged cluster is kept INTACT (fail-safe)',
    eq(keysOf(r.groups), [['x', 'y', 'z']]),
    `got ${JSON.stringify(keysOf(r.groups))}`);
  check('2b: an all-flagged 3-member cluster contributes ZERO dropped keys', r.droppedKeys.size === 0,
    `droppedKeys=${JSON.stringify([...r.droppedKeys])}`);
  check('2b: an all-flagged 3-member cluster is NOT counted as pruned', r.prunedClusters === 0,
    `prunedClusters=${r.prunedClusters}`);
}

// ---------------------------------------------------------------------------
// 3 — OVERLAPPING-CLUSTER DEDUP: the grouping LLM can echo the SAME key in more
// than one cluster. Each cluster's removal is applied, but the distinct dropped-
// key COUNT must not double-count the shared key (the original defect inflated the
// log far above the number of items clustered).
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [
    { keys: ['p', 'q', 'dup'] }, // checkable index 0 — drop 'dup' (index 2)
    { keys: ['r', 'dup', 's'] }, // checkable index 1 — drop 'dup' (index 1)
  ];
  const remove = new Map<number, Set<number>>([
    [0, new Set([2])],
    [1, new Set([1])],
  ]);
  const r = applyCoherenceRemovals(groups, remove);
  check('3: each overlapping cluster has its flagged member removed',
    eq(keysOf(r.groups), [['p', 'q'], ['r', 's']]),
    `got ${JSON.stringify(keysOf(r.groups))}`);
  check('3: the shared dropped key is counted ONCE (distinct keys, not per-cluster sum)',
    r.droppedKeys.size === 1 && r.droppedKeys.has('dup'),
    `droppedKeys=${JSON.stringify([...r.droppedKeys])}`);
  check('3: both clusters are counted as pruned', r.prunedClusters === 2, `got ${r.prunedClusters}`);
}

// ---------------------------------------------------------------------------
// 4 — SINGLETON PASSTHROUGH + ORDERING: groups with < 2 members are not checkable
// (only a multi-member cluster can hide an outlier), so they pass through
// untouched. The checkable-cluster indices must SKIP the singleton, and the
// returned order is [...pruned(checkable), ...passthrough].
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [
    { keys: ['m', 'n'] },       // checkable index 0
    { keys: ['solo'] },         // passthrough (< 2 members)
    { keys: ['u', 'v', 'w'] },  // checkable index 1
  ];
  // Index 1 = the THIRD group ('u','v','w'); drop 'u'. The singleton is skipped by
  // the checkable indexing, proving removals are keyed off `checkable`, not `groups`.
  const remove = new Map<number, Set<number>>([[1, new Set([0])]]);
  const r = applyCoherenceRemovals(groups, remove);
  check('4: singleton passes through untouched, order is [...pruned, ...passthrough]',
    eq(keysOf(r.groups), [['m', 'n'], ['v', 'w'], ['solo']]),
    `got ${JSON.stringify(keysOf(r.groups))}`);
  check('4: only the genuinely flagged key is dropped', eq([...r.droppedKeys], ['u']),
    `got ${JSON.stringify([...r.droppedKeys])}`);
  check('4: prunedClusters === 1', r.prunedClusters === 1, `got ${r.prunedClusters}`);
}

// ---------------------------------------------------------------------------
// 5 — EMPTY / NO-OP REMOVALS: an empty removal set for a cluster (or no entry at
// all) leaves everything untouched and counts nothing.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [{ keys: ['a', 'b'] }, { keys: ['c', 'd'] }];
  const remove = new Map<number, Set<number>>([[0, new Set()]]); // empty removal set
  const r = applyCoherenceRemovals(groups, remove);
  check('5: an empty removal set is a no-op (membership unchanged)',
    eq(keysOf(r.groups), [['a', 'b'], ['c', 'd']]),
    `got ${JSON.stringify(keysOf(r.groups))}`);
  check('5: an empty removal set counts no drops and no pruned clusters',
    r.droppedKeys.size === 0 && r.prunedClusters === 0,
    `droppedKeys=${r.droppedKeys.size}, prunedClusters=${r.prunedClusters}`);
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '[coherence] ALL PASS' : `[coherence] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
