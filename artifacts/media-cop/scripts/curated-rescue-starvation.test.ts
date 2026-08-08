/**
 * Curated rescue-lane STARVATION regression gate.
 *
 * Locks the fix for the production defect where the continuity lanes (a) active-
 * cluster + (a2) archive-grace consumed the whole shared TOTAL_RESCUE_CEILING
 * every pass (active ~46 + grace ~14 = 60) and, combined with identical-title
 * (40), left the event-bucket / social / contrast lanes at 0 rescues FOREVER —
 * ~45-48 missed-corroboration alarms per pass.
 *
 * The fix (Option D+):
 *   - Continuity (a)/(a2) keeps its own RESCUE_BUDGET (60) and is EXEMPT from
 *     the heuristic ceiling (like manual-link (m)).
 *   - Near-dup (b) no longer scavenges continuity leftovers; it has its own
 *     NEAR_DUP_RESCUE_BUDGET (20) and is the first lane counted against the
 *     TOTAL_RESCUE_CEILING (100).
 *   - Every later heuristic lane reserves the floors of the lanes still to run
 *     (identical-title 40, event-bucket 24, social 8, contrast 8), so no lane
 *     can be starved to 0 again while the overall payload stays HARD-bounded.
 *
 * PURE + deterministic (no network, no DB, no LLM). Exit 0 = pass, 1 = fail.
 *
 * Usage:  tsx scripts/curated-rescue-starvation.test.ts
 */

import { selectCandidateNodes, type LaneNode } from '../server/curatedCluster';

// Keep in lockstep with server/curatedCluster.ts. Intentionally re-stated (not
// imported) so this gate also pins the constants' INTENT: if the budget/floor
// math changes, these fixtures' arithmetic must be revisited.
const MAX_NODES = 140;
const RESCUE_BUDGET = 60; // continuity (a)/(a2) — ceiling-EXEMPT
const NEAR_DUP_RESCUE_BUDGET = 20; // lane (b) — own budget, first against ceiling
const IDENTICAL_TITLE_RESCUE_BUDGET = 40; // lane (c0) — floor == budget (correctness)
const EVENT_BUCKET_RESCUE_FLOOR = 24; // lane (c) guaranteed slots on a saturated pass
const SOCIAL_RESCUE_FLOOR = 8; // lane (d) guaranteed slots on a saturated pass
const CONTRAST_RESCUE_FLOOR = 8; // lane (e) guaranteed slots on a saturated pass
const TOTAL_RESCUE_CEILING = 100; // heuristic lanes (b)+(c0)+(c)+(d)+(e) combined
const MANUAL_LINK_HEADROOM = 100;
const HARD_NODE_CEILING =
  MAX_NODES + RESCUE_BUDGET + TOTAL_RESCUE_CEILING + MANUAL_LINK_HEADROOM;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[starvation] OK   ${name}`);
  } else {
    console.error(`[starvation] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const NOW = new Date();

function node(
  partial: Partial<LaneNode> & { key: string; title: string; priority: number; cls: LaneNode['cls'] },
): LaneNode {
  return {
    itemType: 'curated',
    itemId: partial.key.split(':')[1] ?? partial.key,
    source: partial.source ?? 'Test Wire',
    url: partial.url ?? `https://example.com/${partial.key}`,
    category: 'general',
    label: null,
    role:
      partial.cls === 'corroborating'
        ? 'contributing'
        : partial.cls === 'anchor-only'
          ? 'anchor-only'
          : 'attach-only',
    blocked: false,
    ogImageUrl: null,
    publishedAt: NOW,
    sourceIdentifier: null,
    factuality: null,
    ownership: [],
    summary: null,
    bullets: null,
    ...partial,
  } as LaneNode;
}

// ---------------------------------------------------------------------------
// Shared fixture builder. The PRIMARY cut (exactly MAX_NODES, priorities >= 700)
// contains:
//   - 40 twin ANCHORS (distinct >=4-token titles, publisher Reuters) whose
//     identical-title twins live in the overflow,
//   - 1 near-dup anchor, 1 social ref story, 1 contrast ref story,
//   - 97 unique-token fillers.
// The OVERFLOW (all priorities <= 200) contains, in priority-desc order:
//   - 60 active-cluster continuity members (unique titles — ONLY lane (a) can
//     admit them) that fully saturate RESCUE_BUDGET,
//   - near-dups of the near-dup anchor (share 3 tokens + same window),
//   - 40 identical-title twins (publisher AP News),
//   - per-scenario event buckets / social / contrast candidates.
// ---------------------------------------------------------------------------
interface Fixture {
  pool: LaneNode[];
  activeKeys: Set<string>;
  twinKeys: string[];
  nearDupKeys: string[];
}

function buildBaseFixture(tag: string, nearDupCount: number): Fixture {
  const pool: LaneNode[] = [];
  const twinKeys: string[] = [];
  const nearDupKeys: string[] = [];

  // 40 twin anchors — in primary.
  for (let i = 0; i < 40; i++) {
    pool.push(
      node({
        key: `curated:${tag}-twin-anchor-${i}`,
        title: `${tag}twinalpha${i} ${tag}twinbeta${i} ${tag}twingamma${i} ${tag}twindelta${i}`,
        priority: 900 - i,
        cls: 'corroborating',
        source: 'Reuters',
        // publisherKeyOf keys on URL hostname — the must-link group needs >= 2
        // DISTINCT publishers, so anchor and twin must live on different hosts.
        url: `https://reuters-test.example/${tag}-twin-${i}`,
      }),
    );
  }
  // Near-dup anchor, social ref, contrast ref — in primary.
  pool.push(
    node({
      key: `curated:${tag}-neardup-anchor`,
      title: `${tag}neardupone ${tag}nearduptwo ${tag}neardupthree ${tag}neardupfour`,
      priority: 850,
      cls: 'corroborating',
      source: 'AP News',
    }),
    node({
      key: `curated:${tag}-social-ref`,
      title: `${tag}kerch ${tag}bridge ${tag}refalpha ${tag}refbeta ${tag}refgamma ${tag}refdelta`,
      priority: 849,
      cls: 'corroborating',
      source: 'BBC',
    }),
    node({
      key: `curated:${tag}-contrast-ref`,
      title: `${tag}damascus ${tag}airstrike ${tag}ctrefalpha ${tag}ctrefbeta ${tag}ctrefgamma ${tag}ctrefdelta`,
      priority: 848,
      cls: 'corroborating',
      source: 'DW',
    }),
  );
  // 97 unique fillers — complete the 140-slot primary cut (priorities 800..704).
  for (let i = 0; i < 97; i++) {
    pool.push(
      node({
        key: `curated:${tag}-fill-${i}`,
        title: `${tag}fillalpha${i} ${tag}fillbeta${i} ${tag}fillgamma${i}`,
        priority: 800 - i,
        cls: 'corroborating',
      }),
    );
  }

  // 60 continuity members — overflow, unique titles, ONLY the active lane fits.
  const activeKeys = new Set<string>();
  for (let i = 0; i < RESCUE_BUDGET; i++) {
    const key = `curated:${tag}-active-${i}`;
    activeKeys.add(key);
    pool.push(
      node({
        key,
        title: `${tag}activealpha${i} ${tag}activebeta${i} ${tag}activegamma${i}`,
        priority: 200,
        cls: 'corroborating',
      }),
    );
  }
  // Near-dups of the anchor (share 3 tokens, same window) — priority 150 so the
  // near-dup lane fills from THESE before it ever reaches the twins below.
  for (let i = 0; i < nearDupCount; i++) {
    const key = `curated:${tag}-neardup-${i}`;
    nearDupKeys.push(key);
    pool.push(
      node({
        key,
        title: `${tag}neardupone ${tag}nearduptwo ${tag}neardupthree ${tag}ndvariant${i}`,
        priority: 150,
        cls: 'corroborating',
        source: `Wire ${i}`,
      }),
    );
  }
  // 40 identical-title twins — same normalized title as their anchor, DIFFERENT
  // publisher, same event window => deterministic must-link candidacy (lane c0).
  for (let i = 0; i < 40; i++) {
    const key = `curated:${tag}-twin-${i}`;
    twinKeys.push(key);
    pool.push(
      node({
        key,
        title: `${tag}twinalpha${i} ${tag}twinbeta${i} ${tag}twingamma${i} ${tag}twindelta${i}`,
        priority: 100,
        cls: 'corroborating',
        source: 'AP News',
        url: `https://apnews-test.example/${tag}-twin-${i}`,
      }),
    );
  }
  return { pool, activeKeys, twinKeys, nearDupKeys };
}

function socialNode(tag: string, key: string, uniq: string): LaneNode {
  // Shares EXACTLY 2 tokens with the social ref (6-token titles => overlap
  // coefficient 0.33 < 0.4 and shared < 3, so looksSameEvent stays FALSE —
  // neither the near-dup lane nor the bucket lane can admit it; ONLY lane (d)).
  return node({
    key,
    title: `${tag}kerch ${tag}bridge ${uniq}a ${uniq}b ${uniq}c ${uniq}d`,
    priority: 60,
    cls: 'attach',
    source: 'Truth Social',
    isSocialFlash: true,
  });
}

function contrastNode(tag: string, key: string, uniq: string): LaneNode {
  // Same 2-shared-token construction against the contrast ref; ONLY lane (e).
  return node({
    key,
    title: `${tag}damascus ${tag}airstrike ${uniq}a ${uniq}b ${uniq}c ${uniq}d`,
    priority: 55,
    cls: 'anchor-only',
    label: 'contrast',
    source: 'RT',
  });
}

// ---------------------------------------------------------------------------
// SCENARIO A — the PRODUCTION starvation shape: continuity saturates its budget
// (60) and identical-title takes its full 40 (the exact combination that used to
// consume the entire old ceiling), yet a below-cutoff 5-member same-event story,
// on-topic social posts, and contrast items must ALL still be rescued.
// ---------------------------------------------------------------------------
{
  const tag = 'sa';
  const fx = buildBaseFixture(tag, NEAR_DUP_RESCUE_BUDGET); // exactly 20 near-dups
  // A whole 5-member same-event story living below the cutoff (unique tokens —
  // nothing in primary seeds it, so ONLY the bucket lane can admit it).
  const bucketKeys: string[] = [];
  for (let i = 0; i < 5; i++) {
    const key = `curated:${tag}-bucket-${i}`;
    bucketKeys.push(key);
    fx.pool.push(
      node({
        key,
        title: `${tag}bktone ${tag}bkttwo ${tag}bktthree ${tag}bktvar${i}`,
        priority: 80,
        cls: 'corroborating',
        source: `Outlet ${i}`,
      }),
    );
  }
  const socialKeys = [0, 1, 2, 3, 4].map(i => `curated:${tag}-soc-${i}`);
  for (let i = 0; i < 5; i++) fx.pool.push(socialNode(tag, socialKeys[i], `${tag}soc${i}`));
  const contrastKeys = [0, 1, 2, 3, 4].map(i => `curated:${tag}-ct-${i}`);
  for (let i = 0; i < 5; i++) fx.pool.push(contrastNode(tag, contrastKeys[i], `${tag}ct${i}`));

  const sel = selectCandidateNodes(fx.pool, fx.activeKeys, new Set());
  const keys = new Set(sel.allNodes.map(n => n.key));
  const continuity = sel.rescuedActiveOrNearDup - sel.rescuedNearDup;
  console.log(
    `[starvation] A: continuity=${continuity} nearDup=${sel.rescuedNearDup} ` +
      `identical=${sel.rescuedIdenticalTitle} bucket=${sel.rescuedEventBucket} ` +
      `social=${sel.rescuedSocial} contrast=${sel.rescuedContrast} payload=${sel.allNodes.length}`,
  );

  check(
    'A: continuity lane saturates its OWN budget (ceiling-exempt)',
    continuity === RESCUE_BUDGET,
    `continuity=${continuity}; expected ${RESCUE_BUDGET}`,
  );
  check(
    'A: near-dup lane fills its dedicated budget despite continuity saturation',
    sel.rescuedNearDup === NEAR_DUP_RESCUE_BUDGET,
    `rescuedNearDup=${sel.rescuedNearDup}; expected ${NEAR_DUP_RESCUE_BUDGET}`,
  );
  check(
    'A: identical-title correctness lane still takes its FULL budget',
    sel.rescuedIdenticalTitle === IDENTICAL_TITLE_RESCUE_BUDGET &&
      fx.twinKeys.every(k => keys.has(k)),
    `rescuedIdenticalTitle=${sel.rescuedIdenticalTitle}; expected ${IDENTICAL_TITLE_RESCUE_BUDGET}`,
  );
  check(
    'A: THE REGRESSION — a below-cutoff same-event story is rescued as a unit (was 0 forever)',
    sel.rescuedEventBucket === 5 && bucketKeys.every(k => keys.has(k)),
    `rescuedEventBucket=${sel.rescuedEventBucket}; bucket admitted=${bucketKeys.filter(k => keys.has(k)).length}/5`,
  );
  check(
    'A: social-flash posts are rescued despite continuity + identical-title saturation (was 0 forever)',
    sel.rescuedSocial === 5 && socialKeys.every(k => keys.has(k)),
    `rescuedSocial=${sel.rescuedSocial}; admitted=${socialKeys.filter(k => keys.has(k)).length}/5`,
  );
  check(
    'A: contrast items are rescued despite continuity + identical-title saturation (was 0 forever)',
    sel.rescuedContrast === 5 && contrastKeys.every(k => keys.has(k)),
    `rescuedContrast=${sel.rescuedContrast}; admitted=${contrastKeys.filter(k => keys.has(k)).length}/5`,
  );
  const expectedPayload = MAX_NODES + RESCUE_BUDGET + 20 + 40 + 5 + 5 + 5;
  check(
    'A: payload size is exactly primary + continuity + heuristic rescues',
    sel.allNodes.length === expectedPayload,
    `payload=${sel.allNodes.length}; expected ${expectedPayload}`,
  );
  check(
    'A: payload never exceeds HARD_NODE_CEILING and has no duplicate keys',
    sel.allNodes.length <= HARD_NODE_CEILING && keys.size === sel.allNodes.length,
    `payload=${sel.allNodes.length} ceiling=${HARD_NODE_CEILING} unique=${keys.size}`,
  );
}

// ---------------------------------------------------------------------------
// SCENARIO B — EVERY lane over-subscribed at once: the reserved-floor arithmetic
// must give each lane exactly its floor, sum to TOTAL_RESCUE_CEILING, and the
// payload must stay hard-bounded. This pins the floors themselves.
// ---------------------------------------------------------------------------
{
  const tag = 'sb';
  const fx = buildBaseFixture(tag, NEAR_DUP_RESCUE_BUDGET); // 20 near-dups (exact budget)
  // 8 same-event buckets x 4 members (32 candidates > the 24-slot floor). Buckets
  // are admitted as UNITS, so exactly 6 buckets (24 nodes) fit the floor.
  const bucketKeys: string[] = [];
  for (let g = 0; g < 8; g++) {
    for (let i = 0; i < 4; i++) {
      const key = `curated:${tag}-bkt${g}-${i}`;
      bucketKeys.push(key);
      fx.pool.push(
        node({
          key,
          title: `${tag}grp${g}one ${tag}grp${g}two ${tag}grp${g}three ${tag}grp${g}var${i}`,
          priority: 80,
          cls: 'corroborating',
          source: `Outlet ${g}-${i}`,
        }),
      );
    }
  }
  // 20 qualifying social + 20 qualifying contrast candidates (>> the 8-slot floors).
  const socialKeys = Array.from({ length: 20 }, (_, i) => `curated:${tag}-soc-${i}`);
  socialKeys.forEach((k, i) => fx.pool.push(socialNode(tag, k, `${tag}soc${i}`)));
  const contrastKeys = Array.from({ length: 20 }, (_, i) => `curated:${tag}-ct-${i}`);
  contrastKeys.forEach((k, i) => fx.pool.push(contrastNode(tag, k, `${tag}ct${i}`)));

  const sel = selectCandidateNodes(fx.pool, fx.activeKeys, new Set());
  const keys = new Set(sel.allNodes.map(n => n.key));
  const continuity = sel.rescuedActiveOrNearDup - sel.rescuedNearDup;
  const heuristicTotal =
    sel.rescuedNearDup +
    sel.rescuedIdenticalTitle +
    sel.rescuedEventBucket +
    sel.rescuedSocial +
    sel.rescuedContrast;
  console.log(
    `[starvation] B: continuity=${continuity} nearDup=${sel.rescuedNearDup} ` +
      `identical=${sel.rescuedIdenticalTitle} bucket=${sel.rescuedEventBucket} ` +
      `social=${sel.rescuedSocial} contrast=${sel.rescuedContrast} ` +
      `heuristicTotal=${heuristicTotal} payload=${sel.allNodes.length}`,
  );

  check(
    'B: continuity stays at its own budget (never eats the heuristic ceiling)',
    continuity === RESCUE_BUDGET,
    `continuity=${continuity}; expected ${RESCUE_BUDGET}`,
  );
  check(
    'B: near-dup floor holds under full saturation',
    sel.rescuedNearDup === NEAR_DUP_RESCUE_BUDGET,
    `rescuedNearDup=${sel.rescuedNearDup}; expected ${NEAR_DUP_RESCUE_BUDGET}`,
  );
  check(
    'B: identical-title floor (== its full budget) holds under full saturation',
    sel.rescuedIdenticalTitle === IDENTICAL_TITLE_RESCUE_BUDGET,
    `rescuedIdenticalTitle=${sel.rescuedIdenticalTitle}; expected ${IDENTICAL_TITLE_RESCUE_BUDGET}`,
  );
  check(
    'B: event-bucket floor holds — whole buckets only, exactly the floor',
    sel.rescuedEventBucket === EVENT_BUCKET_RESCUE_FLOOR,
    `rescuedEventBucket=${sel.rescuedEventBucket}; expected ${EVENT_BUCKET_RESCUE_FLOOR}`,
  );
  // No bucket may be PARTIALLY admitted (a half bucket can't clear the >=2 gate).
  const admittedPerBucket = new Map<string, number>();
  for (const k of bucketKeys) {
    const g = k.slice(0, k.lastIndexOf('-'));
    if (keys.has(k)) admittedPerBucket.set(g, (admittedPerBucket.get(g) ?? 0) + 1);
  }
  check(
    'B: every admitted bucket is admitted WHOLE (never truncated mid-bucket)',
    Array.from(admittedPerBucket.values()).every(c => c === 4),
    `per-bucket admit counts: ${JSON.stringify(Array.from(admittedPerBucket.values()))}`,
  );
  check(
    'B: social floor holds under full saturation',
    sel.rescuedSocial === SOCIAL_RESCUE_FLOOR,
    `rescuedSocial=${sel.rescuedSocial}; expected ${SOCIAL_RESCUE_FLOOR}`,
  );
  check(
    'B: contrast floor holds under full saturation',
    sel.rescuedContrast === CONTRAST_RESCUE_FLOOR,
    `rescuedContrast=${sel.rescuedContrast}; expected ${CONTRAST_RESCUE_FLOOR}`,
  );
  check(
    'B: heuristic lanes sum EXACTLY to TOTAL_RESCUE_CEILING when all are saturated',
    heuristicTotal === TOTAL_RESCUE_CEILING,
    `heuristicTotal=${heuristicTotal}; expected ${TOTAL_RESCUE_CEILING}`,
  );
  const expectedPayload = MAX_NODES + RESCUE_BUDGET + TOTAL_RESCUE_CEILING;
  check(
    'B: payload = primary + continuity + full heuristic ceiling, within HARD_NODE_CEILING',
    sel.allNodes.length === expectedPayload &&
      sel.allNodes.length <= HARD_NODE_CEILING &&
      keys.size === sel.allNodes.length,
    `payload=${sel.allNodes.length}; expected ${expectedPayload} (ceiling ${HARD_NODE_CEILING}, unique ${keys.size})`,
  );
}

console.log(
  failures === 0
    ? '[starvation] RESULT: PASS — rescue-lane starvation fix holds'
    : `[starvation] RESULT: FAIL — ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
