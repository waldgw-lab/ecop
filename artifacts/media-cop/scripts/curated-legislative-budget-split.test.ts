/**
 * Legislative/budget split regression (Task #970).
 *
 * Root cause: the Iran war strikes megacluster (107 sources) absorbed a
 * distinct second story — the congressional funding fight (Speaker Johnson's
 * $95B supplemental, the House Iran-war funding plan, "$1.5T defense budget in
 * trouble", NDAA stall). Both the grouping LLM and the coherence guard treated
 * funding/appropriations/budget-process items as "angles" of the kinetic strikes
 * event because they named the same war. Result: two genuinely different stories
 * — nightly strikes vs. Washington's funding battle — were welded into one card.
 *
 * The fix adds explicit rules to three LLM prompts:
 *   1. Grouping prompt  — legislative/budget is a DIFFERENT event from kinetic ops
 *   2. Coherence guard  — when dominant event is kinetic, flag budget/appropriations
 *                         members for removal
 *   3. Anchor-split     — same rule in the event-identity classifier
 *
 * This gate covers the DETERMINISTIC layer of the fix (applyCoherenceRemovals)
 * plus a static prompt-contract check to guard against accidental regression:
 *
 *   (A) NEGATIVE — coherence guard flags 2 funding items inside a 6-member kinetic
 *                  cluster → evicted; kinetic members remain intact
 *   (B) POSITIVE — coherence guard flags NOTHING inside a pure kinetic cluster
 *                  (strike + interception + casualties + reaction) → all 4 kept
 *   (C) POSITIVE — coherence guard flags NOTHING inside a pure funding cluster
 *                  (multiple outlets on the same appropriations vote) → all 3 kept
 *   (D) STATIC   — grouping prompt, coherence guard prompt, and anchor-split prompt
 *                  each contain the legislative/budget carve-out text
 *
 * Pure, deterministic (no network / DB / LLM). Exits 1 on any violation.
 *
 * Usage:  npx tsx scripts/curated-legislative-budget-split.test.ts
 */

import { applyCoherenceRemovals } from '../server/curatedCluster';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
let ran = 0;

function check(name: string, ok: boolean, detail = '') {
  ran++;
  if (ok) {
    console.log(`[legislative-budget-split] OK   ${name}`);
  } else {
    console.error(`[legislative-budget-split] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

type Group = { keys: string[] };
const keysOf = (groups: Group[]): string[][] => groups.map(g => g.keys);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// (A) NEGATIVE: funding items co-located in a kinetic strikes cluster.
//
// Simulate the real production scenario: 6 members — 4 kinetic headlines and 2
// funding/budget headlines.  The coherence guard (prompted with the new rules)
// would flag items at 0-based positions 4 and 5 (the two budget items).
// applyCoherenceRemovals must evict those two and leave the 4 kinetic items.
//
// Fixture headlines modelled on the real Iran-war megacluster:
//   KINETIC (keep):
//     0. "US strikes Iran for sixth night — Pentagon confirms strikes on nuclear sites"
//     1. "Iran intercepts US missiles over Tehran; military says 40 incoming drones down"
//     2. "Iranian state TV: 14 killed in overnight US airstrikes on Natanz"
//     3. "Pentagon: strikes 'degraded Iranian nuclear capability'; B-2s involved"
//   BUDGET/LEGISLATIVE (evict):
//     4. "Speaker Johnson's $95B Iran war funding package clears first House hurdle"
//     5. "$1.5 trillion defense budget in trouble as Senate blocks NDAA supplemental"
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [
    {
      keys: [
        'main:us-strikes-iran-6th-night',
        'main:iran-intercepts-us-missiles',
        'main:iranian-tv-14-killed',
        'main:pentagon-nuclear-capability-degraded',
        'main:johnson-95b-iran-funding',
        'main:1t5-defense-budget-ndaa-blocked',
      ],
    },
  ];

  // 0-based positions 4 and 5 are the budget/legislative items flagged for removal.
  const remove = new Map<number, Set<number>>([[0, new Set([4, 5])]]);
  const r = applyCoherenceRemovals(groups, remove);

  const keptKeys = r.groups[0]?.keys ?? [];
  const kinetic = [
    'main:us-strikes-iran-6th-night',
    'main:iran-intercepts-us-missiles',
    'main:iranian-tv-14-killed',
    'main:pentagon-nuclear-capability-degraded',
  ];
  const evicted = ['main:johnson-95b-iran-funding', 'main:1t5-defense-budget-ndaa-blocked'];

  check(
    '(A) kinetic cluster with 2 budget items: exactly 4 keys remain',
    keptKeys.length === 4,
    `got ${keptKeys.length} keys: ${JSON.stringify(keptKeys)}`,
  );

  for (const k of kinetic) {
    check(
      `(A) kinetic item kept: ${k}`,
      keptKeys.includes(k),
      `missing from kept: ${JSON.stringify(keptKeys)}`,
    );
  }

  for (const k of evicted) {
    check(
      `(A) budget/legislative item evicted: ${k}`,
      !keptKeys.includes(k) && r.droppedKeys.has(k),
      `droppedKeys=${JSON.stringify([...r.droppedKeys])}`,
    );
  }

  check(
    '(A) exactly 2 keys in droppedKeys',
    r.droppedKeys.size === 2,
    `got ${r.droppedKeys.size}`,
  );

  check(
    '(A) prunedClusters === 1 (the kinetic cluster was pruned)',
    r.prunedClusters === 1,
    `got ${r.prunedClusters}`,
  );
}

// ---------------------------------------------------------------------------
// (B) POSITIVE: a pure kinetic cluster — guard flags NOTHING.
//
// Same-incident angles of one strike event all belong together:
//   0. "US launches airstrikes on Iranian nuclear sites"  (the strike itself)
//   1. "Iran fires interceptor missiles; US warheads neutralised over Isfahan"  (interception)
//   2. "Seven dead after US strike hits Natanz residential area" (casualties)
//   3. "White House: strikes were 'necessary and proportionate response'" (official reaction)
//
// The coherence guard with the new rules would not flag any of these; it
// would return an empty remove-set for this cluster.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [
    {
      keys: [
        'main:us-launches-strikes-nuclear-sites',
        'main:iran-interceptor-missiles-isfahan',
        'main:seven-dead-natanz-strike',
        'main:whitehouse-necessary-proportionate',
      ],
    },
  ];

  // Coherence guard finds no outliers → empty remove set for this cluster.
  const remove = new Map<number, Set<number>>([[0, new Set()]]);
  const r = applyCoherenceRemovals(groups, remove);

  const keptKeys = r.groups[0]?.keys ?? [];

  check(
    '(B) pure kinetic cluster: all 4 members kept',
    keptKeys.length === 4,
    `got ${keptKeys.length}`,
  );

  check(
    '(B) pure kinetic cluster: droppedKeys is empty',
    r.droppedKeys.size === 0,
    `got ${r.droppedKeys.size}`,
  );

  check(
    '(B) pure kinetic cluster: prunedClusters === 0',
    r.prunedClusters === 0,
    `got ${r.prunedClusters}`,
  );
}

// ---------------------------------------------------------------------------
// (C) POSITIVE: a pure funding/legislative cluster — guard flags NOTHING.
//
// Multiple outlets covering the SAME appropriations story belong together:
//   0. "AP: '$95 billion Iran war package clears first hurdle' as House votes"
//   1. "Politico: '$1.5T defense budget in trouble' as Senate NDAA talks stall"
//   2. "Breaking Defense: supplemental / $1.5T budget piece — war funding faces
//        procedural hurdles on Capitol Hill"
//
// These should cluster with each other — the rule forbids them from joining a
// KINETIC cluster, not from forming their own story.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [
    {
      keys: [
        'main:ap-95b-iran-war-package-hurdle',
        'main:politico-1t5-defense-ndaa-trouble',
        'main:breaking-defense-supplemental-budget',
      ],
    },
  ];

  // Guard finds no outliers inside a pure-funding cluster.
  const remove = new Map<number, Set<number>>([[0, new Set()]]);
  const r = applyCoherenceRemovals(groups, remove);

  const keptKeys = r.groups[0]?.keys ?? [];

  check(
    '(C) pure funding cluster: all 3 members kept',
    keptKeys.length === 3,
    `got ${keptKeys.length}`,
  );

  check(
    '(C) pure funding cluster: droppedKeys is empty',
    r.droppedKeys.size === 0,
    `got ${r.droppedKeys.size}`,
  );

  check(
    '(C) pure funding cluster: prunedClusters === 0',
    r.prunedClusters === 0,
    `got ${r.prunedClusters}`,
  );
}

// ---------------------------------------------------------------------------
// (D) STATIC PROMPT CONTRACT — the shared event-identity guidance plus the
// clustering guard/anchor prompts must retain the legislative/budget carve-out.
// The grouping rule now lives in the shared source consumed by clustering and
// manual review; drift or a missing interpolation still fails before any AI call.
// ---------------------------------------------------------------------------
{
  const src = readFileSync(join(process.cwd(), 'server', 'curatedCluster.ts'), 'utf8');
  const guidanceSrc = readFileSync(
    join(process.cwd(), 'server', 'curatedEventIdentityGuidance.ts'),
    'utf8',
  );

  // The distinguishing phrase in the shared grouping guidance.
  const GROUPING_PHRASE = 'LEGISLATIVE / APPROPRIATIONS / BUDGET PROCESS is a DIFFERENT event from KINETIC MILITARY OPERATIONS';
  check(
    '(D) shared grouping guidance contains legislative/budget carve-out',
    guidanceSrc.includes(GROUPING_PHRASE),
    'phrase not found in server/curatedEventIdentityGuidance.ts',
  );
  check(
    '(D) clustering prompt consumes the shared event-identity guidance',
    src.includes('${CURATED_EVENT_IDENTITY_GUIDANCE}'),
    'shared guidance interpolation not found in server/curatedCluster.ts',
  );

  // The distinguishing phrase added to the coherence guard prompt.
  const GUARD_PHRASE = 'LEGISLATIVE / APPROPRIATIONS / BUDGET PROCESS SPILLOVER';
  check(
    '(D) coherence guard prompt contains legislative/budget spillover rule',
    src.includes(GUARD_PHRASE),
    'phrase not found in server/curatedCluster.ts',
  );

  // The distinguishing phrase added to the anchor-split classifier prompt.
  const ANCHOR_PHRASE = 'LEGISLATIVE / APPROPRIATIONS / BUDGET PROCESS vs. KINETIC OPERATIONS';
  check(
    '(D) anchor-split classifier prompt contains legislative/budget vs kinetic rule',
    src.includes(ANCHOR_PHRASE),
    'phrase not found in server/curatedCluster.ts',
  );
}

// ---------------------------------------------------------------------------
// Completion sentinel — guard against a vacuous exit-0.
// ---------------------------------------------------------------------------
const EXPECTED_MIN_CHECKS = 16;
if (ran < EXPECTED_MIN_CHECKS) {
  console.error(
    `\n[legislative-budget-split] INCOMPLETE — only ${ran}/${EXPECTED_MIN_CHECKS} checks ran (vacuous pass guard)`,
  );
  process.exit(1);
}

if (failures > 0) {
  console.error(`\n[legislative-budget-split] ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n[legislative-budget-split] ALL PASS (${ran} checks)`);
}
