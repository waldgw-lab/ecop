/**
 * Curated manual-MERGE consolidation gate — overlapping merge rows must UNION,
 * never partition.
 *
 * Prod incident (July 21, 2026): an editor merged 7 URLs into one story, then —
 * seeing no immediate change — retried with a 3-URL SUBSET, then added a soft
 * link spanning both. The manual-MERGE carve-out built one dedicated forced
 * group per merge row; Phase A's assignedKeys filter let the first forced group
 * claim the shared keys, so the retry claimed its 3 and the original merge was
 * left with the leftovers: the story SPLIT into two clusters, and the leftover
 * fragment then dragged unrelated members in via story-sticky expansion. Every
 * retry made it worse — the exact opposite of the editor's intent.
 *
 * consolidateForcedMergeGroups (server/curatedCluster.ts) fixes this by
 * unioning forced groups into connected components before the carve-out. This
 * gate pins its contract:
 *   1. Overlapping merges union (subset retry = the prod bug shape).
 *   2. Transitive merge chains union (A∪B, B∪C, C∪D → one component).
 *   3. Disjoint merges stay separate (never weld unrelated editor stories).
 *   4. A soft link BRIDGING two merge components unions them (the editor's
 *      "link these together" rescue attempt must work).
 *   5. A soft link intersecting one merge pulls its own keys in (attach).
 *   6. Link-only groups NEVER create a forced group (formation gate stays
 *      fully in force for soft links — the #1 curated invariant).
 *   7. Single hop: a link chains into a merge only via the RAW merge key set —
 *      link-to-link chaining can never recruit distant keys into a merge.
 *   8. Deterministic + lossless (input order never changes the result; no
 *      merge key is ever dropped).
 *
 * Pure function — no DB, no AI, no network. Deterministic (no inconclusive3).
 * Run: npx tsx scripts/curated-manual-merge-union.test.ts
 * Exits 0 on pass, 1 on any failure.
 */
import { consolidateForcedMergeGroups } from '../server/curatedCluster';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = '') {
  checks++;
  if (ok) {
    console.log(`[merge-union] OK   ${name}`);
  } else {
    console.error(`[merge-union] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// Compare as sets-of-sets (order-independent).
const canon = (groups: string[][]) =>
  groups
    .map(g => [...g].sort().join(','))
    .sort()
    .join(' | ');
const expectGroups = (name: string, actual: string[][], expected: string[][]) => {
  check(name, canon(actual) === canon(expected), `got [${canon(actual)}] want [${canon(expected)}]`);
};

// --- 1. Subset retry (the prod bug shape): 7-URL merge + 3-URL subset retry ---
expectGroups(
  'subset retry merge unions into ONE story (prod bug shape)',
  consolidateForcedMergeGroups([
    ['hill-nl', 'nyt', 'hill-video', 'cbs', 'abc', 'straits', 'cgtn'],
    ['hill-nl', 'nyt', 'hill-video'],
  ]),
  [['hill-nl', 'nyt', 'hill-video', 'cbs', 'abc', 'straits', 'cgtn']],
);

// --- 2. Transitive merge chain ---
expectGroups(
  'transitive merge chain unions (A∪B, B∪C, C∪D)',
  consolidateForcedMergeGroups([
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
  ]),
  [['a', 'b', 'c', 'd']],
);

// --- 3. Disjoint merges stay separate ---
expectGroups(
  'disjoint merges stay separate stories',
  consolidateForcedMergeGroups([
    ['a', 'b'],
    ['x', 'y', 'z'],
  ]),
  [
    ['a', 'b'],
    ['x', 'y', 'z'],
  ],
);

// --- 4. Bridging link unions two merge components ---
expectGroups(
  'soft link bridging two merges unions them (the editor rescue attempt)',
  consolidateForcedMergeGroups(
    [
      ['a', 'b'],
      ['c', 'd'],
    ],
    [['b', 'c']],
  ),
  [['a', 'b', 'c', 'd']],
);

// --- 5. Link intersecting one merge attaches its keys ---
expectGroups(
  'soft link intersecting a merge pulls its keys into the forced group',
  consolidateForcedMergeGroups([['a', 'b']], [['b', 'x', 'y']]),
  [['a', 'b', 'x', 'y']],
);

// --- 6. Link-only groups never force ---
expectGroups(
  'link-only groups NEVER create a forced group (formation gate intact)',
  consolidateForcedMergeGroups([], [['x', 'y'], ['p', 'q', 'r']]),
  [],
);

// --- 7a. Non-intersecting link ignored ---
expectGroups(
  'non-intersecting soft link is ignored (stays soft)',
  consolidateForcedMergeGroups([['a', 'b']], [['x', 'y']]),
  [['a', 'b']],
);

// --- 7b. Single hop: link-to-link chaining never recruits into a merge ---
expectGroups(
  'single hop — a second link sharing only NON-merge keys never chains in',
  consolidateForcedMergeGroups([['a', 'b']], [
    ['b', 'x'], // joins via merge key b → absorbs x
    ['x', 'y'], // shares only x (not a RAW merge key) → must NOT absorb y
  ]),
  [['a', 'b', 'x']],
);

// --- 8a. Deterministic under input reordering ---
{
  const m1 = [
    ['hill-nl', 'nyt', 'hill-video'],
    ['hill-nl', 'nyt', 'hill-video', 'cbs', 'abc', 'straits', 'cgtn'],
  ];
  const m2 = [...m1].reverse();
  const l1 = [['cgtn', 'extra1'], ['zz1', 'zz2']];
  const l2 = [...l1].reverse();
  check(
    'result is order-independent (merges + links shuffled)',
    canon(consolidateForcedMergeGroups(m1, l1)) === canon(consolidateForcedMergeGroups(m2, l2)),
    `${canon(consolidateForcedMergeGroups(m1, l1))} vs ${canon(consolidateForcedMergeGroups(m2, l2))}`,
  );
}

// --- 8b. Lossless: every merge key survives consolidation ---
{
  const merges = [
    ['a', 'b', 'c'],
    ['c', 'd'],
    ['x', 'y'],
  ];
  const out = consolidateForcedMergeGroups(merges, [['y', 'w']]);
  const outKeys = new Set(out.flat());
  const missing = merges.flat().filter(k => !outKeys.has(k));
  check('no merge key is ever dropped', missing.length === 0, `missing: ${missing.join(',')}`);
}

// --- 9. Degenerate inputs: <2-key groups filtered, empty input safe ---
expectGroups(
  'sub-2-key groups are ignored; empty input yields no forced groups',
  consolidateForcedMergeGroups([['a'], []], [['b']]),
  [],
);

// Completion sentinel — the run counts only if every check above executed.
const EXPECTED_CHECKS = 11;
if (checks !== EXPECTED_CHECKS) {
  console.error(`[merge-union] FAIL completion sentinel — ran ${checks}/${EXPECTED_CHECKS} checks`);
  failures++;
}

if (failures > 0) {
  console.error(`[merge-union] ${failures} failure(s)`);
  process.exit(1);
}
console.log(`[merge-union] All ${checks} checks passed`);
process.exit(0);
