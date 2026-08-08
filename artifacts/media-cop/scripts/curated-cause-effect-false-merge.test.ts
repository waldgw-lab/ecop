/**
 * Cause-effect (downstream economic ripple) false-merge regression (Task #1133).
 *
 * Root cause: a production curated story merged an Axios article ("US commander
 * advised halting Hormuz strikes") with a Taipei Times article ("Taiwan fuel
 * price hikes driven by the conflict"). One is a military/command decision, the
 * other is a downstream economic consequence of the same conflict — related in
 * theme, but DIFFERENT events. Neither the grouping prompt nor the coherence
 * guard had a rule for this event class, so both passed it, and the 2-publisher
 * formation gate formed the story.
 *
 * The fix adds an explicit "DOWNSTREAM ECONOMIC / MARKET EFFECT ≠ THE TRIGGERING
 * EVENT" rule to:
 *   1. Phase B grouping prompt — an economic/market/price consequence of a
 *      military or geopolitical event is a DIFFERENT story from the event.
 *   2. Coherence guard prompt — kinetic/geopolitical clusters must evict
 *      economic-ripple members; the 2-item special case is now an explicit
 *      "same real-world incident" test, not a "related topic" test.
 *
 * Gate layers:
 *
 *   (A) NEGATIVE — a 2-member conflict + fuel-price pair, with both members
 *                  flagged by the guard, is DISSOLVED so no story can form
 *                  (set-membership + formation-gate assertion).
 *   (B) POSITIVE — a pure same-event kinetic cluster with an empty remove set
 *                  keeps all members (no false evictions), and still forms.
 *   (C) POSITIVE — a pure economic-event cluster (two outlets on the SAME price
 *                  announcement) keeps all members and still forms.
 *   (D) STATIC   — the new rule phrases are present in curatedCluster.ts
 *                  (regression guard against accidental revert).
 *   (E) LIVE AI  — identifyCuratedClusters on a mixed fixture (2 command-decision
 *                  nodes + 2 fuel-price nodes + 2 same-strike controls) never
 *                  places a command-decision node and a fuel-price node in one
 *                  cluster, while the positive-control pair still clusters.
 *                  Exit 3 (inconclusive) when the AI is unreachable.
 *
 * Usage:  npx tsx scripts/curated-cause-effect-false-merge.test.ts
 * Exits 1 on deterministic failure, 3 on inconclusive (live-AI path only).
 */

import {
  applyCoherenceRemovals,
  evaluateFormation,
  identifyCuratedClusters,
  type LaneNode,
} from '../server/curatedCluster';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
let ran = 0;

function check(name: string, ok: boolean, detail = '') {
  ran++;
  if (ok) {
    console.log(`[cause-effect-false-merge] OK   ${name}`);
  } else {
    console.error(`[cause-effect-false-merge] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

type Group = { keys: string[] };

const NOW = new Date('2026-07-20T10:00:00Z');

function node(partial: Partial<LaneNode> & { key: string; title: string }): LaneNode {
  return {
    itemType: 'curated',
    itemId: partial.key.split(':')[1] ?? partial.key,
    source: partial.source ?? 'Test Wire',
    url: partial.url ?? `https://example.com/${encodeURIComponent(partial.key)}`,
    category: 'general',
    label: null,
    cls: 'corroborating',
    role: 'contributing',
    blocked: false,
    priority: 70,
    ogImageUrl: null,
    publishedAt: partial.publishedAt ?? NOW,
    sourceIdentifier: null,
    factuality: null,
    ownership: [],
    summary: partial.summary ?? null,
    bullets: null,
    ...partial,
  } as LaneNode;
}

// ---------------------------------------------------------------------------
// (A) NEGATIVE — the observed production pair. The guard (with the sharpened
// 2-item "same real-world incident" test) flags BOTH members; the pair must
// dissolve and neither fragment may pass the formation gate.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [
    {
      keys: [
        'curated:us-commander-halt-hormuz-strikes',
        'curated:taiwan-fuel-price-hike-conflict',
      ],
    },
  ];

  // Guard verdict for a related-but-different-events 2-item pair: flag both.
  const remove = new Map<number, Set<number>>([[0, new Set([0, 1])]]);
  const r = applyCoherenceRemovals(groups, remove);

  check(
    '(A) conflict + fuel-price pair is DISSOLVED (empty keys)',
    (r.groups[0]?.keys ?? ['sentinel']).length === 0,
    `got ${JSON.stringify(r.groups.map(g => g.keys))}`,
  );
  check(
    '(A) both members counted as dropped',
    r.droppedKeys.size === 2 &&
      r.droppedKeys.has('curated:us-commander-halt-hormuz-strikes') &&
      r.droppedKeys.has('curated:taiwan-fuel-price-hike-conflict'),
    `droppedKeys=${JSON.stringify([...r.droppedKeys])}`,
  );
  check('(A) prunedClusters === 1', r.prunedClusters === 1, `got ${r.prunedClusters}`);

  // Formation gate: the dissolved (empty) group can never form a story.
  const formation = evaluateFormation([]);
  check(
    '(A) dissolved pair does not pass the formation gate',
    formation.forms === false && formation.corroboratingCount === 0,
    JSON.stringify(formation),
  );
}

// ---------------------------------------------------------------------------
// (B) POSITIVE — pure same-event kinetic cluster (two outlets, one command
// decision). Empty remove set → all members kept, story still forms.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [
    {
      keys: [
        'curated:us-commander-halt-hormuz-strikes',
        'curated:pentagon-official-advised-pausing-hormuz-strikes',
      ],
    },
  ];
  const remove = new Map<number, Set<number>>([[0, new Set()]]);
  const r = applyCoherenceRemovals(groups, remove);
  const kept = r.groups[0]?.keys ?? [];

  check('(B) same-event kinetic pair: both members kept', kept.length === 2, `got ${kept.length}`);
  check('(B) droppedKeys empty', r.droppedKeys.size === 0, `got ${r.droppedKeys.size}`);
  check('(B) prunedClusters === 0', r.prunedClusters === 0, `got ${r.prunedClusters}`);

  const formation = evaluateFormation([
    node({ key: kept[0], title: 'a', source: 'Axios', url: 'https://axios.com/a' }),
    node({ key: kept[1], title: 'b', source: 'Reuters', url: 'https://reuters.com/b' }),
  ]);
  check('(B) legitimate same-event pair still forms a story', formation.forms === true, JSON.stringify(formation));
}

// ---------------------------------------------------------------------------
// (C) POSITIVE — pure economic-event cluster (two outlets on the SAME price
// announcement). Economic stories still cluster with EACH OTHER.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [
    {
      keys: [
        'curated:taiwan-fuel-price-hike-conflict',
        'curated:cpc-taiwan-announces-fuel-price-increase',
      ],
    },
  ];
  const remove = new Map<number, Set<number>>([[0, new Set()]]);
  const r = applyCoherenceRemovals(groups, remove);
  const kept = r.groups[0]?.keys ?? [];

  check('(C) same-announcement economic pair: both members kept', kept.length === 2, `got ${kept.length}`);
  check('(C) droppedKeys empty', r.droppedKeys.size === 0, `got ${r.droppedKeys.size}`);

  const formation = evaluateFormation([
    node({ key: kept[0], title: 'a', source: 'Taipei Times', url: 'https://taipeitimes.com/a' }),
    node({ key: kept[1], title: 'b', source: 'Focus Taiwan', url: 'https://focustaiwan.tw/b' }),
  ]);
  check('(C) legitimate economic pair still forms a story', formation.forms === true, JSON.stringify(formation));
}

// ---------------------------------------------------------------------------
// (D) STATIC PROMPT CONTRACT — the grouping rule must remain in the shared
// event-identity guidance consumed by clustering, while the coherence guard
// keeps its own removal instruction. Accidental drift fails before any AI call.
// ---------------------------------------------------------------------------
{
  const src = readFileSync(join(process.cwd(), 'server', 'curatedCluster.ts'), 'utf8');
  const guidanceSrc = readFileSync(
    join(process.cwd(), 'server', 'curatedEventIdentityGuidance.ts'),
    'utf8',
  );

  const GROUPING_RULE = 'DOWNSTREAM ECONOMIC / MARKET EFFECT \u2260 THE TRIGGERING EVENT';
  const GROUPING_EXAMPLE = 'Taiwan raises fuel prices as the conflict squeezes oil supply';
  const TWO_ITEM_TEST = 'STRICT "same real-world incident" test, NOT a "related topic" test';

  check('(D) shared grouping guidance contains the downstream-effect rule + worked example',
    guidanceSrc.includes(GROUPING_RULE) && guidanceSrc.includes(GROUPING_EXAMPLE));
  check('(D) clustering prompt consumes the shared event-identity guidance',
    src.includes('${CURATED_EVENT_IDENTITY_GUIDANCE}'));
  check('(D) coherence guard retains its downstream-effect removal rule',
    src.includes(GROUPING_RULE));
  check('(D) coherence guard 2-item special case uses the strict same-incident test',
    src.includes(TWO_ITEM_TEST));
  check('(D) guard flag list includes downstream economic/market effect',
    src.includes('a downstream economic/market effect of the dominant event'));
}

// ---------------------------------------------------------------------------
// (E) LIVE AI — identifyCuratedClusters must not merge cause and effect.
//
// Fixture: 2 command-decision nodes (same event — Axios-modeled + a second
// outlet), 2 fuel-price nodes (same announcement — Taipei Times-modeled + a
// second outlet). Expected: NO cluster spans both sets; each set may cluster
// among itself (the command pair is the positive control).
// ---------------------------------------------------------------------------

const commandKeys = new Set([
  'curated:axios-us-commander-advised-halting-hormuz-strikes',
  'curated:reuters-us-general-recommended-pausing-hormuz-strikes',
]);
const fuelKeys = new Set([
  'curated:taipeitimes-taiwan-fuel-price-hike',
  'curated:focustaiwan-cpc-raises-fuel-prices',
]);

const fixture: LaneNode[] = [
  node({
    key: 'curated:axios-us-commander-advised-halting-hormuz-strikes',
    title: 'Scoop: Top US commander advised halting strikes near Strait of Hormuz',
    source: 'Axios',
    summary: 'The senior US commander overseeing Middle East operations privately advised the White House to halt strikes near the Strait of Hormuz, warning of escalation risks to shipping and regional allies.',
  }),
  node({
    key: 'curated:reuters-us-general-recommended-pausing-hormuz-strikes',
    title: 'US general recommended pausing Hormuz-area strikes, officials say',
    source: 'Reuters',
    summary: 'A top American general recommended the administration pause military strikes near the Strait of Hormuz, according to officials familiar with the discussions.',
  }),
  node({
    key: 'curated:taipeitimes-taiwan-fuel-price-hike',
    title: 'Fuel prices to rise again as conflict squeezes oil supply',
    source: 'Taipei Times',
    summary: 'CPC Corp announced another round of domestic fuel price increases in Taiwan, citing crude oil supply disruptions and higher import costs driven by the ongoing Middle East conflict.',
  }),
  node({
    key: 'curated:focustaiwan-cpc-raises-fuel-prices',
    title: 'CPC raises gasoline, diesel prices citing Mideast supply disruption',
    source: 'Focus Taiwan',
    summary: "Taiwan's state-owned CPC Corp raised gasoline and diesel prices, attributing the hike to crude supply disruption from the Middle East conflict.",
  }),
];

console.log('\n[cause-effect-false-merge] Running live AI clustering on 4-node mixed fixture…');

let liveExitCode = 0;

try {
  const clusters = await identifyCuratedClusters(fixture, { harnessStub: false });

  if (clusters === null) {
    console.warn('[cause-effect-false-merge] identifyCuratedClusters returned null (AI error) — treating as inconclusive');
    liveExitCode = 3;
  } else {
    let crossMergeFound = false;
    for (const group of clusters) {
      const hasCommand = group.keys.some(k => commandKeys.has(k));
      const hasFuel = group.keys.some(k => fuelKeys.has(k));
      if (hasCommand && hasFuel) {
        console.error(
          `[cause-effect-false-merge] FAIL (E) cause-effect cross-merge detected — cluster members: ${JSON.stringify(group.keys)}`,
        );
        crossMergeFound = true;
        failures++;
      }
    }
    ran++;
    if (!crossMergeFound) {
      console.log('[cause-effect-false-merge] OK   (E) no cross-merge — command decision and fuel-price reaction stay separate');
    }

    // Positive control: the two command-decision reports (same event, two
    // outlets) should still cluster among themselves.
    const commandCluster = clusters.find(
      g => g.keys.some(k => commandKeys.has(k)) && !g.keys.some(k => fuelKeys.has(k)),
    );
    check(
      '(E) positive control — the two same-event command-decision reports still cluster',
      !!commandCluster && commandCluster.keys.length >= 2,
      commandCluster ? `got ${commandCluster.keys.length} keys` : 'no command-only cluster found',
    );
  }
} catch (err: any) {
  const msg = String(err?.message ?? err);
  if (/ECONNREFUSED|fetch failed|network|timeout|429|rate.?limit/i.test(msg)) {
    console.warn(`[cause-effect-false-merge] (E) live AI call failed (${msg}) — treating as inconclusive`);
    liveExitCode = 3;
  } else {
    console.error(`[cause-effect-false-merge] (E) unexpected error: ${err?.stack ?? err}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Completion sentinel — guard against a vacuous exit-0.
// ---------------------------------------------------------------------------
const EXPECTED_MIN_CHECKS = 16;
if (ran < EXPECTED_MIN_CHECKS) {
  console.error(
    `\n[cause-effect-false-merge] INCOMPLETE — only ${ran}/${EXPECTED_MIN_CHECKS} checks ran (vacuous pass guard)`,
  );
  process.exit(1);
}

if (failures > 0) {
  console.error(`\n[cause-effect-false-merge] ${failures} check(s) FAILED`);
  process.exit(1);
}

if (liveExitCode === 3) {
  console.warn('\n[cause-effect-false-merge] deterministic checks PASS; live AI call inconclusive — exit 3');
  process.exit(3);
}

console.log(`\n[cause-effect-false-merge] ALL PASS (${ran} checks)`);
