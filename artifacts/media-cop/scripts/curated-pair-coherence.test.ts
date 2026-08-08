/**
 * Curated coherence-guard PAIR BLIND SPOT regression.
 *
 * Root cause (real case: "Two Separate Military Developments in Morocco and
 * South Asia"): a 2-member cluster containing two clearly unrelated articles
 * (U.S. drone academy in Morocco + India's SSBN expansion) was kept alive
 * because the all-flagged fail-safe in applyCoherenceRemovals treated "flag
 * both" as a degenerate model answer and left the cluster intact. For a
 * 2-member cluster that is EXACTLY the correct "different events" verdict and
 * should DISSOLVE the pair.
 *
 * This gate pins:
 *   (A) 2-member all-flagged → DISSOLVED (new behavior, prevents the live bug)
 *   (B) 3+-member all-flagged → kept INTACT (fail-safe unchanged)
 *   (C) 2-member PARTIAL flag → normal pruning (remove one, keep one)
 *   (D) 4-member all-flagged → kept INTACT (fail-safe for 4+, not just 3)
 *   (E) Mixed: a 2-pair dissolved + a 3-member kept intact in the same call
 *
 * Also covers the synthesis-layer false-merge backstop (isLikelyFalseMerge)
 * for the 2-source unrelated-facts case — each fact traced to a single
 * independently-owned contributor is the structural tell of a bad merge.
 *
 * Pure, deterministic (no network / DB / LLM). Exits 1 on any violation.
 *
 * Usage:  npx tsx scripts/curated-pair-coherence.test.ts
 */

import { applyCoherenceRemovals } from '../server/curatedCluster';
import { isLikelyFalseMerge, type FactSupport } from '../server/curatedSynthesis';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[pair-coherence] OK   ${name}`);
  } else {
    console.error(`[pair-coherence] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

type Group = { keys: string[] };
const keysOf = (groups: Group[]): string[][] => groups.map(g => g.keys);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// (A) 2-MEMBER ALL-FLAGGED → DISSOLVED.
// The guard flagged both items (they describe different events). For a pair,
// that is the CORRECT verdict: dissolve the cluster (empty keys), both fall
// back to standalones.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [{ keys: ['morocco-drone', 'india-ssbn'] }];
  const remove = new Map<number, Set<number>>([[0, new Set([0, 1])]]); // both flagged
  const r = applyCoherenceRemovals(groups, remove);

  check('(A) 2-member all-flagged: cluster dissolved (empty keys)',
    eq(keysOf(r.groups), [[]]),
    `got ${JSON.stringify(keysOf(r.groups))}`);

  check('(A) 2-member all-flagged: both keys in droppedKeys',
    r.droppedKeys.size === 2 &&
    r.droppedKeys.has('morocco-drone') &&
    r.droppedKeys.has('india-ssbn'),
    `droppedKeys=${JSON.stringify([...r.droppedKeys])}`);

  check('(A) 2-member all-flagged: prunedClusters === 1',
    r.prunedClusters === 1,
    `got ${r.prunedClusters}`);
}

// ---------------------------------------------------------------------------
// (B) 3-MEMBER ALL-FLAGGED → KEPT INTACT (fail-safe unchanged for 3+).
// The model flagged every item — this is a degenerate answer for a 3-member
// cluster; keep the cluster as-is and count nothing dropped.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [{ keys: ['a', 'b', 'c'] }];
  const remove = new Map<number, Set<number>>([[0, new Set([0, 1, 2])]]); // all flagged
  const r = applyCoherenceRemovals(groups, remove);

  check('(B) 3-member all-flagged: cluster kept INTACT (fail-safe)',
    eq(keysOf(r.groups), [['a', 'b', 'c']]),
    `got ${JSON.stringify(keysOf(r.groups))}`);

  check('(B) 3-member all-flagged: ZERO dropped keys',
    r.droppedKeys.size === 0,
    `droppedKeys=${JSON.stringify([...r.droppedKeys])}`);

  check('(B) 3-member all-flagged: prunedClusters === 0',
    r.prunedClusters === 0,
    `got ${r.prunedClusters}`);
}

// ---------------------------------------------------------------------------
// (C) 2-MEMBER PARTIAL FLAG → NORMAL PRUNING.
// Only one item flagged in a 2-member cluster → remove it, keep the other.
// Formation gate downstream will then dissolve the now-single-member cluster
// (< 2 corroborating) — but that is not applyCoherenceRemovals' concern.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [{ keys: ['good', 'outlier'] }];
  const remove = new Map<number, Set<number>>([[0, new Set([1])]]); // flag outlier only
  const r = applyCoherenceRemovals(groups, remove);

  check('(C) 2-member partial flag: outlier removed, good kept',
    eq(keysOf(r.groups), [['good']]),
    `got ${JSON.stringify(keysOf(r.groups))}`);

  check('(C) 2-member partial flag: only outlier in droppedKeys',
    r.droppedKeys.size === 1 && r.droppedKeys.has('outlier'),
    `droppedKeys=${JSON.stringify([...r.droppedKeys])}`);

  check('(C) 2-member partial flag: prunedClusters === 1',
    r.prunedClusters === 1,
    `got ${r.prunedClusters}`);
}

// ---------------------------------------------------------------------------
// (D) 4-MEMBER ALL-FLAGGED → KEPT INTACT (fail-safe covers 4+ as well).
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [{ keys: ['p', 'q', 'r', 's'] }];
  const remove = new Map<number, Set<number>>([[0, new Set([0, 1, 2, 3])]]); // all flagged
  const r = applyCoherenceRemovals(groups, remove);

  check('(D) 4-member all-flagged: cluster kept INTACT (fail-safe)',
    eq(keysOf(r.groups), [['p', 'q', 'r', 's']]),
    `got ${JSON.stringify(keysOf(r.groups))}`);

  check('(D) 4-member all-flagged: ZERO dropped keys',
    r.droppedKeys.size === 0,
    `got ${r.droppedKeys.size}`);

  check('(D) 4-member all-flagged: prunedClusters === 0',
    r.prunedClusters === 0,
    `got ${r.prunedClusters}`);
}

// ---------------------------------------------------------------------------
// (E) MIXED: a 2-pair all-flagged (dissolves) alongside a 3-member all-flagged
// (kept intact) in the same applyCoherenceRemovals call.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [
    { keys: ['pair-x', 'pair-y'] },   // checkable index 0 — all-flagged → dissolve
    { keys: ['tri-a', 'tri-b', 'tri-c'] }, // checkable index 1 — all-flagged → keep
  ];
  const remove = new Map<number, Set<number>>([
    [0, new Set([0, 1])],   // 2-member: both flagged → dissolve
    [1, new Set([0, 1, 2])], // 3-member: all flagged → keep intact
  ]);
  const r = applyCoherenceRemovals(groups, remove);

  check('(E) mixed: 2-pair dissolved (empty keys)',
    r.groups.length === 2 && eq(r.groups[0].keys, []),
    `groups=${JSON.stringify(keysOf(r.groups))}`);

  check('(E) mixed: 3-member kept intact',
    r.groups.length === 2 && eq(r.groups[1].keys, ['tri-a', 'tri-b', 'tri-c']),
    `groups=${JSON.stringify(keysOf(r.groups))}`);

  check('(E) mixed: only pair keys in droppedKeys',
    r.droppedKeys.size === 2 &&
    r.droppedKeys.has('pair-x') &&
    r.droppedKeys.has('pair-y'),
    `droppedKeys=${JSON.stringify([...r.droppedKeys])}`);

  check('(E) mixed: prunedClusters === 1 (only the pair counted)',
    r.prunedClusters === 1,
    `got ${r.prunedClusters}`);
}

// ---------------------------------------------------------------------------
// (F) SYNTHESIS BACKSTOP — 2-source unrelated-facts false merge.
// isLikelyFalseMerge must flag the structural tell of an unrelated pair: each
// "corroborated" fact is actually attributed to only ONE independently-owned
// contributor (Morocco drone article → Task & Purpose; India SSBN → The
// Diplomat). No fact is genuinely shared → dissolve verdict.
// ---------------------------------------------------------------------------
{
  const ownerByKey = new Map<string, string[]>([
    ['curated:task-purpose', ['Recurrent Ventures']],
    ['main:diplomat', ['The Diplomat Media Inc']],
  ]);
  const sourceByKey = new Map<string, string>([
    ['curated:task-purpose', 'Task & Purpose'],
    ['main:diplomat', 'The Diplomat'],
  ]);
  const facts: FactSupport[] = [
    {
      fact: 'The U.S. Army has opened a drone academy at a Moroccan air base',
      sourceKeys: ['curated:task-purpose'],
    },
    {
      fact: 'India has commissioned a second nuclear-armed submarine, expanding its SSBN fleet',
      sourceKeys: ['main:diplomat'],
    },
  ];

  check('(F) synthesis: 2-source unrelated-facts → flagged as false merge',
    isLikelyFalseMerge(facts, ownerByKey, sourceByKey) === true,
    'isLikelyFalseMerge should return true for single-sourced-everywhere facts');
}

// ---------------------------------------------------------------------------
// (G) SYNTHESIS BACKSTOP — 2-source same-event story must NOT be flagged.
// Two independent outlets reporting the SAME fact about ONE event is genuine
// corroboration — isLikelyFalseMerge must return false (keep the story).
// ---------------------------------------------------------------------------
{
  const ownerByKey = new Map<string, string[]>([
    ['main:reuters', ['Reuters News Agency']],
    ['main:ap', ['Associated Press']],
  ]);
  const sourceByKey = new Map<string, string>([
    ['main:reuters', 'Reuters'],
    ['main:ap', 'Associated Press'],
  ]);
  const facts: FactSupport[] = [
    {
      fact: 'A U.S. Navy destroyer intercepted a ballistic missile fired from Yemen',
      sourceKeys: ['main:reuters', 'main:ap'],
    },
  ];

  check('(G) synthesis: 2-source same-event → NOT flagged (genuine corroboration)',
    isLikelyFalseMerge(facts, ownerByKey, sourceByKey) === false,
    'isLikelyFalseMerge should return false when >= 2 distinct owners share a fact');
}

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? '[pair-coherence] ALL PASS'
    : `[pair-coherence] ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
