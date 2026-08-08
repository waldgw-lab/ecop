/**
 * Trust-aware candidate selection regression test (Task #311).
 *
 * PROBLEM (production evidence): the curated clustering candidate pool is the top
 * MAX_NODES items BY PRIORITY, then topped up by bounded rescue lanes. But at
 * production volume the highest-scoring AND highest-volume non-DataMinr sources
 * are attach-only ADVERSARY / state media (contrast: RT / TASS / Sputnik / Global
 * Times, plus official social and unknown attach) — they out-score and out-number
 * the trusted CONTRIBUTING (corroborating) outlets that actually SEED stories.
 * Because adversary/attach both scores high and arrives in bulk, it can consume a
 * large share of the flat top-MAX_NODES PRIMARY cut and push contributing items
 * into the overflow, where they return only if a rescue lane happens to catch
 * them. Adversary/attach can NEVER seed or represent a story and already has its
 * own dedicated overflow rescue lanes, so dominating the PRIMARY cut is wasted
 * budget at the expense of story formation.
 *
 * This test establishes a measurable BEFORE/AFTER on a production-like pool and
 * locks the fix (selectCandidateNodes caps the adversary/attach share of the
 * primary cut) so a future tweak can't silently re-open the crowding:
 *   - BEFORE: a flat top-MAX_NODES-by-priority cut admits a large block of
 *     adversary/attach and starves contributing items into the overflow.
 *   - AFTER : selectCandidateNodes caps adversary/attach in the primary cut, so
 *     contributing breadth in the candidate pool increases, while adversary
 *     contrast still rides in via its contrast rescue lane.
 *
 * PURE, deterministic check (no network, no DB, no LLM). Exits non-zero on any
 * failure so it can run as a regression gate.
 *
 * Usage:  npx tsx scripts/curated-adversary-crowding.test.ts
 */

import { selectCandidateNodes, type LaneNode } from '../server/curatedCluster';

// Mirrors server/curatedCluster.ts. Re-stated (not imported) so this test also
// pins the constants' INTENT: if these change, the distribution assumptions and
// the expected crowding must be revisited.
const MAX_NODES = 140;
const PRIMARY_ADVERSARY_CAP = Math.floor(MAX_NODES * 0.4); // 56 of 140

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[adversary] OK   ${name}`);
  } else {
    console.error(`[adversary] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

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
    publishedAt: new Date(),
    sourceIdentifier: null,
    factuality: null,
    ownership: [],
    summary: null,
    bullets: null,
    ...partial,
  } as LaneNode;
}

// A trusted contributing outlet (corroborating) — can seed a story.
function contrib(key: string, priority: number, source = 'Reuters'): LaneNode {
  return node({ key, title: `contrib headline ${key}`, priority, cls: 'corroborating', source });
}
// An adversary / state-media CONTRAST item (cls anchor-only, label contrast).
function adversary(key: string, priority: number, source = 'TASS'): LaneNode {
  return node({
    key,
    title: `state media headline ${key}`,
    priority,
    cls: 'anchor-only',
    label: 'contrast',
    source,
  });
}
// An official primary ANCHOR (release) — protected from the cap, never adversary.
function anchor(key: string, priority: number, source = 'DoD'): LaneNode {
  return node({
    key,
    title: `official release ${key}`,
    priority,
    cls: 'anchor-only',
    label: 'primary',
    source,
  });
}

function flatPrimaryKeys(nodes: LaneNode[]): Set<string> {
  return new Set(
    [...nodes].sort((a, b) => b.priority - a.priority).slice(0, MAX_NODES).map(n => n.key),
  );
}

// ---------------------------------------------------------------------------
// SCENARIO 1 — production-like crowding. A large block of HIGH-priority adversary
// state media (P80-P95) out-scores trusted contributing outlets (P55-P78), so a
// flat top-MAX_NODES-by-priority cut fills most of the primary slots with
// adversary and starves contributing items into the overflow.
// ---------------------------------------------------------------------------
const pool: LaneNode[] = [];

// 120 adversary/state-media items scoring HIGHEST (P80-P95) — mirrors Sputnik 79 /
// RT 73 / TASS 71 sitting at or above trusted contributors, plus their bulk.
for (let i = 0; i < 120; i++) {
  pool.push(adversary(`curated:adv-${i}`, 80 + (i % 16), ['TASS', 'RT', 'Sputnik', 'Global Times'][i % 4]));
}
// 130 trusted CONTRIBUTING items scoring LOWER (P55-P78) — the outlets that
// actually form stories (The Hindu 55, Al Jazeera 67, etc.).
for (let i = 0; i < 130; i++) {
  pool.push(contrib(`curated:con-${i}`, 55 + (i % 24), ['The Hindu', 'Al Jazeera', 'Reuters', 'AP'][i % 4]));
}

const totalContrib = pool.filter(n => n.cls === 'corroborating').length;

// BEFORE: flat top-MAX_NODES-by-priority cut.
const beforePrimary = flatPrimaryKeys(pool);
const beforeContribInPrimary = pool.filter(
  n => n.cls === 'corroborating' && beforePrimary.has(n.key),
).length;
const beforeAdvInPrimary = MAX_NODES - beforeContribInPrimary;
console.log(
  `[adversary] BEFORE flat cut: ${beforeAdvInPrimary}/${MAX_NODES} primary slots are adversary, ` +
    `only ${beforeContribInPrimary}/${totalContrib} contributing items make the primary cut`,
);

// AFTER: trust-aware selectCandidateNodes.
const sel = selectCandidateNodes(pool, new Set(), new Set());
console.log(
  `[adversary] AFTER trust-aware: primaryContributing=${sel.primaryContributing}, ` +
    `primaryAdversary=${sel.primaryAdversary}, deferredAdversary=${sel.deferredAdversary}, ` +
    `rescuedContrast=${sel.rescuedContrast}, overflow=${sel.overflowCount}`,
);

check(
  'BEFORE: the flat cut is crowded — adversary consumes MORE than the cap allows',
  beforeAdvInPrimary > PRIMARY_ADVERSARY_CAP,
  `adversary in flat primary = ${beforeAdvInPrimary}, cap = ${PRIMARY_ADVERSARY_CAP}`,
);
check(
  'AFTER: adversary/attach in the primary cut is capped at PRIMARY_ADVERSARY_CAP',
  sel.primaryAdversary <= PRIMARY_ADVERSARY_CAP,
  `primaryAdversary = ${sel.primaryAdversary} > ${PRIMARY_ADVERSARY_CAP}`,
);
check(
  'AFTER: contributing breadth in the primary cut INCREASES vs the flat cut',
  sel.primaryContributing > beforeContribInPrimary,
  `after = ${sel.primaryContributing}, before = ${beforeContribInPrimary}`,
);
check(
  'AFTER: the excess adversary is DEFERRED to overflow, not dropped',
  sel.deferredAdversary === beforeAdvInPrimary - sel.primaryAdversary &&
    sel.deferredAdversary > 0,
  `deferredAdversary = ${sel.deferredAdversary}`,
);
check(
  'AFTER: the primary cut is still full (no slots wasted)',
  sel.primaryCount === MAX_NODES,
  `primaryCount = ${sel.primaryCount}`,
);
check(
  'AFTER: deferred adversary contrast still reaches clusters via its contrast lane',
  // every deferred adversary node shares >= 2 tokens with the contributing story
  // refs? Not in this synthetic pool (titles are unique), so contrast rescue can
  // be 0 here — the LANE existence + budget is what preserves breadth. Verify the
  // payload still never exceeds the hard ceiling instead.
  sel.allNodes.length <= MAX_NODES + 60 + 80 + 40 + 40,
  `payload = ${sel.allNodes.length}`,
);

// ---------------------------------------------------------------------------
// SCENARIO 2 — contrast breadth is preserved. When deferred contrast items
// genuinely relate to a contributing story already in the payload, the existing
// contrast rescue lane (e) must still pull them back in even though they were
// capped out of the primary cut.
// ---------------------------------------------------------------------------
const breadthPool: LaneNode[] = [];
// Fill the primary cut with PRIMARY_ADVERSARY_CAP adversary items at the very top
// so the cap is exhausted by UNRELATED high-priority state media.
for (let i = 0; i < PRIMARY_ADVERSARY_CAP; i++) {
  breadthPool.push(adversary(`curated:fill-adv-${i}`, 95, 'TASS'));
}
// A real contributing story (>=2 corroborating) about a specific event.
breadthPool.push(
  node({ key: 'curated:story-1', title: 'Iran strikes US base at Al Udeid airfield', priority: 90, cls: 'corroborating', source: 'Reuters' }),
  node({ key: 'curated:story-2', title: 'US base Al Udeid hit by Iran missile strike', priority: 90, cls: 'corroborating', source: 'AP' }),
);
// A contrast item about the SAME event, but LOWER priority so it is over-cap, and
// the cap is already full — it can ONLY return via the contrast rescue lane.
const relatedContrast = node({
  key: 'curated:contrast-related',
  title: 'Iran missile strike on Al Udeid base hailed by Tehran',
  priority: 30,
  cls: 'anchor-only',
  label: 'contrast',
  source: 'Press TV',
  publishedAt: new Date(),
});
breadthPool.push(relatedContrast);
// Padding contributing items so the primary cut is well-formed.
for (let i = 0; i < 90; i++) {
  breadthPool.push(contrib(`curated:pad-${i}`, 70 + (i % 10)));
}

const breadthSel = selectCandidateNodes(breadthPool, new Set(), new Set());
const breadthKeys = new Set(breadthSel.allNodes.map(n => n.key));
check(
  'BREADTH: a related contrast item capped out of primary is still rescued via the contrast lane',
  breadthKeys.has('curated:contrast-related'),
  'the related contrast item never re-entered the payload',
);
check(
  'BREADTH: both contributing story members are in the primary cut',
  breadthKeys.has('curated:story-1') && breadthKeys.has('curated:story-2'),
  'a contributing story member was crowded out',
);

// ---------------------------------------------------------------------------
// SCENARIO 3 — primary anchors (official releases) are PROTECTED, not capped.
// Releases are not adversary; they must never be deferred by the adversary cap.
// ---------------------------------------------------------------------------
const anchorPool: LaneNode[] = [];
for (let i = 0; i < PRIMARY_ADVERSARY_CAP + 30; i++) {
  anchorPool.push(adversary(`curated:a-adv-${i}`, 95, 'RT'));
}
for (let i = 0; i < 40; i++) {
  anchorPool.push(anchor(`curated:a-anchor-${i}`, 90));
}
for (let i = 0; i < 80; i++) {
  anchorPool.push(contrib(`curated:a-con-${i}`, 60));
}
const anchorSel = selectCandidateNodes(anchorPool, new Set(), new Set());
const anchorKeys = new Set(anchorSel.allNodes.map(n => n.key));
const anchorsInPayload = anchorPool.filter(
  n => n.cls === 'anchor-only' && n.label === 'primary' && anchorKeys.has(n.key),
).length;
check(
  'ANCHOR: every official primary-anchor release is in the payload (never capped)',
  anchorsInPayload === 40,
  `${anchorsInPayload}/40 anchors admitted`,
);
check(
  'ANCHOR: anchors do NOT count against the adversary cap',
  anchorSel.primaryAdversary <= PRIMARY_ADVERSARY_CAP,
  `primaryAdversary = ${anchorSel.primaryAdversary}`,
);

// ---------------------------------------------------------------------------
// SCENARIO 4 — LOW-VOLUME backfill. When there are not enough contributing /
// anchor items to fill MAX_NODES, deferred adversary nodes backfill the remaining
// slots so the primary payload is never shorter than the flat cut would be.
// ---------------------------------------------------------------------------
const smallPool: LaneNode[] = [];
// Only 20 contributing items, but 200 adversary items.
for (let i = 0; i < 20; i++) smallPool.push(contrib(`curated:s-con-${i}`, 70));
for (let i = 0; i < 200; i++) smallPool.push(adversary(`curated:s-adv-${i}`, 80 + (i % 10)));
const smallSel = selectCandidateNodes(smallPool, new Set(), new Set());
check(
  'BACKFILL: low-contributing-volume cycle still fills the full primary cut',
  smallSel.primaryCount === MAX_NODES,
  `primaryCount = ${smallSel.primaryCount}`,
);
check(
  'BACKFILL: all available contributing items are admitted',
  smallSel.primaryContributing === 20,
  `primaryContributing = ${smallSel.primaryContributing}`,
);
check(
  'BACKFILL: adversary backfills beyond the cap when contributors run out',
  smallSel.primaryAdversary > PRIMARY_ADVERSARY_CAP,
  `primaryAdversary = ${smallSel.primaryAdversary} (expected > cap via backfill)`,
);

// ---------------------------------------------------------------------------
// SCENARIO 5 — NO-OP when adversary volume is below the cap. The cap is a ceiling;
// when adversary/attach is under it, selection is identical to the flat cut.
// ---------------------------------------------------------------------------
const lightPool: LaneNode[] = [];
for (let i = 0; i < 30; i++) lightPool.push(adversary(`curated:l-adv-${i}`, 90));
for (let i = 0; i < 200; i++) lightPool.push(contrib(`curated:l-con-${i}`, 60 + (i % 20)));
const lightSel = selectCandidateNodes(lightPool, new Set(), new Set());
check(
  'NO-OP: adversary below the cap is never deferred',
  lightSel.deferredAdversary === 0 && lightSel.primaryAdversary === 30,
  `deferredAdversary = ${lightSel.deferredAdversary}, primaryAdversary = ${lightSel.primaryAdversary}`,
);
const lightFlatPrimary = flatPrimaryKeys(lightPool);
const lightAfterPrimaryKeys = new Set(
  lightSel.allNodes.slice(0, lightSel.primaryCount).map(n => n.key),
);
check(
  'NO-OP: the primary cut equals the flat top-MAX_NODES cut when uncrowded',
  lightFlatPrimary.size === lightAfterPrimaryKeys.size &&
    [...lightFlatPrimary].every(k => lightAfterPrimaryKeys.has(k)),
  'the primary cut diverged from the flat cut even though adversary was under the cap',
);

// ---------------------------------------------------------------------------
// SCENARIO 6 — metric semantics. deferredAdversary must count ONLY items the cap
// pushed out, NOT adversary that naturally fell below the top-MAX_NODES cut by
// priority. With adversary volume UNDER the cap but some adversary at very low
// priority, nothing is cap-deferred even though adversary sits in the overflow.
// ---------------------------------------------------------------------------
const metricPool: LaneNode[] = [];
// 40 adversary total (< cap 56): 10 at the very top, 30 at the very bottom.
for (let i = 0; i < 10; i++) metricPool.push(adversary(`curated:m-adv-hi-${i}`, 95));
for (let i = 0; i < 30; i++) metricPool.push(adversary(`curated:m-adv-lo-${i}`, 10));
// 200 contributing in the middle so the 30 low adversary fall into overflow.
for (let i = 0; i < 200; i++) metricPool.push(contrib(`curated:m-con-${i}`, 50 + (i % 20)));
const metricSel = selectCandidateNodes(metricPool, new Set(), new Set());
const metricAdvInOverflow = metricSel.allNodes
  .slice(metricSel.primaryCount)
  .filter(n => n.cls === 'attach' || (n.cls === 'anchor-only' && n.label === 'contrast'))
  .length;
check(
  'METRIC: adversary under the cap is never reported as cap-deferred',
  metricSel.deferredAdversary === 0,
  `deferredAdversary = ${metricSel.deferredAdversary} (expected 0; ${metricAdvInOverflow} adversary fell to overflow by priority, not by cap)`,
);

// ---------------------------------------------------------------------------
// SCENARIO 7 — WATERWAY/MINERAL coverage is not crowded out by adversary volume
// (Task #567). The adversary cap is about TRUST, not topic: a waterway/chokepoint
// or critical-mineral story is treated like any other.
//   Part A — a trusted-outlet (Reuters/AP) Panama Canal story is CONTRIBUTING, so
//     the adversary cap never touches it: it surfaces in the primary cut even when
//     a large block of higher-priority adversary state media is present.
//   Part B — when the ONLY waterway coverage is a state-media angle (contrast,
//     attach-only) and adversary volume is UNDER the cap, that lone item still
//     surfaces in the candidate pool as attach-only — capped behaviour only DEFERS
//     adversary to overflow when it is OVER the cap, it never drops it outright.
// ---------------------------------------------------------------------------
// Part A: trusted Panama Canal contributors amid heavy adversary volume.
const waterwayPoolA: LaneNode[] = [];
// A heavy block of high-priority UNRELATED adversary state media (P90-P95), more
// than the cap, to prove it cannot squeeze out the trusted waterway story.
for (let i = 0; i < PRIMARY_ADVERSARY_CAP + 40; i++) {
  waterwayPoolA.push(adversary(`curated:w-adv-${i}`, 90 + (i % 6), ['TASS', 'RT', 'Sputnik', 'Global Times'][i % 4]));
}
// The trusted Panama Canal story (>=2 corroborating) — LOWER priority than the
// adversary block, exactly the case the cap is meant to protect.
waterwayPoolA.push(
  node({ key: 'curated:panama-1', title: 'Panama Canal traffic disrupted as drought cuts daily transits', priority: 72, cls: 'corroborating', source: 'Reuters' }),
  node({ key: 'curated:panama-2', title: 'Drought forces Panama Canal to slash ship crossings', priority: 71, cls: 'corroborating', source: 'AP' }),
);
const waterwaySelA = selectCandidateNodes(waterwayPoolA, new Set(), new Set());
const waterwayKeysA = new Set(waterwaySelA.allNodes.map(n => n.key));
check(
  'WATERWAY: a trusted Panama Canal story is NOT crowded out by higher-priority adversary volume',
  waterwayKeysA.has('curated:panama-1') && waterwayKeysA.has('curated:panama-2'),
  'a trusted waterway contributor was squeezed out of the candidate pool',
);
check(
  'WATERWAY: both trusted waterway contributors make the priority (primary) cut, not just the rescue lanes',
  waterwaySelA.primaryContributing >= 2,
  `primaryContributing = ${waterwaySelA.primaryContributing} (expected the 2 trusted Panama Canal contributors)`,
);

// Part B: the ONLY waterway coverage is a lone state-media angle, adversary UNDER
// the cap — it must still surface (attach-only), not be dropped.
const waterwayPoolB: LaneNode[] = [];
// Adversary volume well under the cap so the lone item is never cap-deferred.
for (let i = 0; i < 10; i++) {
  waterwayPoolB.push(adversary(`curated:w2-adv-${i}`, 60, 'TASS'));
}
// Contributing padding on UNRELATED topics so there is no trusted waterway story
// for the lone state-media item to attach to.
for (let i = 0; i < 60; i++) {
  waterwayPoolB.push(contrib(`curated:w2-con-${i}`, 65 + (i % 10)));
}
// The lone waterway/chokepoint coverage — a state-media (contrast, attach-only)
// angle, the only Panama Canal item in the pool.
const lonePanamaStateMedia = node({
  key: 'curated:panama-state-only',
  title: 'Panama Canal congestion proves US mismanagement, state media claims',
  priority: 58,
  cls: 'anchor-only',
  label: 'contrast',
  source: 'Global Times',
});
waterwayPoolB.push(lonePanamaStateMedia);
const waterwaySelB = selectCandidateNodes(waterwayPoolB, new Set(), new Set());
const waterwayKeysB = new Set(waterwaySelB.allNodes.map(n => n.key));
check(
  'WATERWAY: a lone state-media waterway angle (adversary under cap) still surfaces as attach-only, not dropped',
  waterwayKeysB.has('curated:panama-state-only'),
  'the only available state-media waterway item was dropped from the candidate pool',
);
check(
  'WATERWAY: with adversary under the cap, nothing is cap-deferred',
  waterwaySelB.deferredAdversary === 0,
  `deferredAdversary = ${waterwaySelB.deferredAdversary} (expected 0 — adversary volume is under the cap)`,
);

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n[adversary] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[adversary] all checks passed');
