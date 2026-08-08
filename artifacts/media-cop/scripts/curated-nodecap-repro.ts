/**
 * Curated node-cap recall reproduction (Task #199).
 *
 * Reproduces, against a PRODUCTION-LIKE candidate distribution, the defect where
 * clearly same-event mid-priority coverage falls below the flat top-MAX_NODES
 * priority cutoff and therefore never co-enters the clustering payload — so the
 * >=2-corroborating formation gate never sees the members together and the story
 * fragments into standalone rows (attach-only items then have no cluster to join).
 *
 * It establishes a measurable BEFORE/AFTER:
 *   - BEFORE: the original Task #178 selection (top MAX_NODES by priority + a
 *     rescue lane that only matches overflow rows against the TOP window). When a
 *     whole event lives below the cutoff, nothing seeds it → 0 members admitted
 *     together → no cluster can form.
 *   - AFTER : selectCandidateNodes (the Task #199 fix) — the whole same-event
 *     bucket is admitted together and the attach-only item rides along.
 *
 * This is a PURE, deterministic check (no network, no DB, no LLM). It exits
 * non-zero if the invariant is violated so it can run as a regression gate.
 *
 * Usage:  tsx scripts/curated-nodecap-repro.ts
 */

import {
  selectCandidateNodes,
  buildSameEventBuckets,
  isClusterPhasedOut,
  isDevelopingProcessCluster,
  lastContributingMs,
  scheduledEventPhase,
  type LaneNode,
} from '../server/curatedCluster';

// Keep these in lockstep with server/curatedCluster.ts. They are intentionally
// re-stated (not imported) so this repro also pins the constants' INTENT: if the
// cutoff math changes, this test's distribution assumptions must be revisited.
const MAX_NODES = 140;
// Mirrors server/curatedCluster.ts. Social-flash rescue (Task #209) reserves a
// bounded set of extra slots — beyond the priority cap, the active/near-dup lane,
// and the same-event bucket lane — for official social posts that plausibly cover
// a story already in the payload.
const SOCIAL_RESCUE_BUDGET = 40;
// Mirrors server/curatedCluster.ts. Contrast rescue (Task #210) reserves a further
// bounded set of slots for CONTRAST items (CPC/SWL/EPC or low-factuality outlets —
// cls 'anchor-only', label 'contrast') that plausibly contrast a story already in
// the payload but, framed with divergent wording, fail the strict near-dup lane.
const CONTRAST_RESCUE_BUDGET = 40;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[repro] OK   ${name}`);
  } else {
    console.error(`[repro] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

function node(partial: Partial<LaneNode> & { key: string; title: string; priority: number; cls: LaneNode['cls'] }): LaneNode {
  return {
    itemType: 'curated',
    itemId: partial.key.split(':')[1] ?? partial.key,
    source: partial.source ?? 'Test Wire',
    url: partial.url ?? `https://example.com/${partial.key}`,
    category: 'general',
    label: null,
    role: partial.cls === 'corroborating' ? 'contributing' : partial.cls === 'anchor-only' ? 'anchor-only' : 'attach-only',
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

// ---------------------------------------------------------------------------
// Build a production-like candidate pool (~1,575 items / 24h, top-140 cutoff at
// priority ~75 with ~201 items >= 75 competing for 140 slots).
// ---------------------------------------------------------------------------
const candidates: LaneNode[] = [];

// 201 high-priority filler items in [75, 95] — these fill (and overflow) the top
// 140 slots, pushing the cutoff to priority 75, exactly as in production.
for (let i = 0; i < 201; i++) {
  candidates.push(
    node({
      key: `curated:hi-${i}`,
      title: `Unrelated high priority headline ${i} topicAlpha${i} topicBeta${i}`,
      priority: 75 + (i % 21), // 75..95
      cls: 'corroborating',
    }),
  );
}

// ~1,360 low-priority filler items in [10, 74] — the rest of the over-cap pile.
for (let i = 0; i < 1360; i++) {
  candidates.push(
    node({
      key: `curated:lo-${i}`,
      title: `Unrelated low priority headline ${i} subjectGamma${i} subjectDelta${i}`,
      priority: 10 + (i % 64), // 10..73
      cls: 'corroborating',
    }),
  );
}

// THE affected coverage: one real same-event story (Trump vowing more Iran
// strikes / Kharg Island) reported by multiple outlets at P72-P78 — STRADDLING
// but mostly BELOW the cutoff, plus a related Truth Social post (attach-only).
// All share >=3 significant tokens (trump / strikes / iran / kharg / island) so
// the same-event heuristic groups them, while filler shares none of them.
const EVENT_PRIORITY = [74, 73, 73, 72, 72];
const eventCorroborating: LaneNode[] = [
  'Trump vows more strikes on Iran as forces hit Kharg Island',
  'Trump threatens additional Iran strikes after taking Kharg Island',
  'Trump warns of fresh strikes against Iran over Kharg Island oil terminal',
  'Trump pledges further strikes on Iran following Kharg Island assault',
  'Trump signals renewed Iran strikes as Kharg Island is seized',
].map((title, i) =>
  node({
    key: `curated:event-corr-${i}`,
    title,
    priority: EVENT_PRIORITY[i],
    cls: 'corroborating',
    source: ['The Hill', 'Bloomberg', 'DW', 'Washington Examiner', 'Times of Israel'][i],
  }),
);
const eventAttach = node({
  key: `curated:event-attach-0`,
  title: 'Trump posts on Truth Social vowing more strikes on Iran and Kharg Island',
  priority: 70,
  cls: 'attach',
  source: 'Truth Social',
});
const eventKeys = new Set([...eventCorroborating.map(n => n.key), eventAttach.key]);
candidates.push(...eventCorroborating, eventAttach);

console.log(`[repro] built ${candidates.length} candidates (prod-like distribution)`);

// Quantify: how many event members fall below the top-MAX_NODES priority cutoff?
const sortedByPriority = [...candidates].sort((a, b) => b.priority - a.priority);
const cutoffPriority = sortedByPriority[MAX_NODES - 1]?.priority ?? 0;
const primaryKeys = new Set(sortedByPriority.slice(0, MAX_NODES).map(n => n.key));
const eventMembersInPrimary = [...eventKeys].filter(k => primaryKeys.has(k)).length;
const eventMembersBelowCutoff = eventKeys.size - eventMembersInPrimary;
console.log(
  `[repro] top-${MAX_NODES} cutoff priority = ${cutoffPriority}; ` +
    `${eventMembersBelowCutoff}/${eventKeys.size} same-event members fall BELOW the cutoff`,
);
check(
  'cap miss reproduced: the whole same-event group lives below the cutoff',
  eventMembersInPrimary === 0,
  `${eventMembersInPrimary} event member(s) unexpectedly made the top ${MAX_NODES}`,
);

// ---------------------------------------------------------------------------
// BEFORE (Task #178 only): top-N by priority + rescue that matches overflow rows
// ONLY against the top window. Re-implemented here so the contrast is explicit.
// ---------------------------------------------------------------------------
const NODE_TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'has',
  'have', 'had', 'will', 'would', 'could', 'should', 'its', 'his', 'her',
  'their', 'was', 'were', 'are', 'new', 'after', 'before', 'amid', 'over',
  'into', 'out', 'off', 'near', 'say', 'says', 'said', 'report', 'reports',
  'reported', 'reportedly', 'breaking', 'update', 'updates', 'live', 'latest',
  'news', 'more', 'about', 'than', 'then', 'what', 'when', 'how', 'why',
  'who', 'amidst', 'again', 'now', 'set',
]);
function sigTokens(title: string): Set<string> {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/)
      .filter(w => w.length >= 3 && !NODE_TITLE_STOPWORDS.has(w)),
  );
}
function sameEvent(a: Set<string>, b: Set<string>): boolean {
  if (a.size < 2 || b.size < 2) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  small.forEach(t => { if (large.has(t)) shared++; });
  if (shared < 2) return false;
  return shared >= 3 || shared / small.size >= 0.4;
}
const RESCUE_BUDGET = 60;
function legacySelect(nodes: LaneNode[]): Set<string> {
  const sorted = [...nodes].sort((a, b) => b.priority - a.priority);
  const primary = sorted.slice(0, MAX_NODES);
  const overflow = sorted.slice(MAX_NODES);
  const selected = new Set(primary.map(n => n.key));
  const primaryTok = primary.map(n => sigTokens(n.title));
  let rescued = 0;
  for (const n of overflow) {
    if (rescued >= RESCUE_BUDGET) break;
    const toks = sigTokens(n.title);
    if (toks.size >= 2 && primaryTok.some(pt => sameEvent(toks, pt))) {
      selected.add(n.key);
      rescued++;
    }
  }
  return selected;
}

const beforeKeys = legacySelect(candidates);
const beforeEventCorr = eventCorroborating.filter(n => beforeKeys.has(n.key)).length;
const beforeAttach = beforeKeys.has(eventAttach.key);
console.log(
  `[repro] BEFORE (Task #178 only): ${beforeEventCorr}/${eventCorroborating.length} corroborating event members + ` +
    `attach=${beforeAttach} admitted into the payload`,
);
check(
  'BEFORE: the same-event group cannot form (< 2 corroborating members admitted together)',
  beforeEventCorr < 2,
  `${beforeEventCorr} corroborating members were admitted — expected < 2`,
);

// ---------------------------------------------------------------------------
// AFTER (Task #199): selectCandidateNodes admits the whole bucket together.
// ---------------------------------------------------------------------------
const selection = selectCandidateNodes(candidates, new Set(), new Set());
const afterKeys = new Set(selection.allNodes.map(n => n.key));
const afterEventCorr = eventCorroborating.filter(n => afterKeys.has(n.key)).length;
const afterAttach = afterKeys.has(eventAttach.key);
console.log(
  `[repro] AFTER (Task #199): ${afterEventCorr}/${eventCorroborating.length} corroborating event members + ` +
    `attach=${afterAttach} admitted; selection={primary:${selection.primaryCount}, ` +
    `activeOrNearDup:${selection.rescuedActiveOrNearDup}, eventBucket:${selection.rescuedEventBucket}, ` +
    `overflow:${selection.overflowCount}}`,
);
check(
  'AFTER: all corroborating event members co-enter the payload (>= 2, can form)',
  afterEventCorr === eventCorroborating.length,
  `${afterEventCorr}/${eventCorroborating.length} corroborating members admitted`,
);
check(
  'AFTER: the attach-only item rides along so it can join the formed story',
  afterAttach,
  'the attach-only Truth Social post was not admitted with its event bucket',
);

// ---------------------------------------------------------------------------
// INVARIANT: the payload stays HARD-bounded regardless of over-cap volume.
// ---------------------------------------------------------------------------
// Mirrors server/curatedCluster.ts (starvation fix): MAX_NODES + continuity
// RESCUE_BUDGET (60) + heuristic TOTAL_RESCUE_CEILING (100) + MANUAL_LINK_HEADROOM (100).
const HARD_NODE_CEILING = MAX_NODES + 60 + 100 + 100;
check(
  'INVARIANT: payload never exceeds HARD_NODE_CEILING',
  selection.allNodes.length <= HARD_NODE_CEILING,
  `payload=${selection.allNodes.length} > ${HARD_NODE_CEILING}`,
);
check(
  'INVARIANT: no duplicate keys in the payload',
  afterKeys.size === selection.allNodes.length,
  `${selection.allNodes.length - afterKeys.size} duplicate key(s) in payload`,
);

// ---------------------------------------------------------------------------
// PRECISION GUARD: a lone overflow row that matches NOTHING must NOT be admitted
// (the fix widens recall for real buckets only, it does not pull in singletons).
// ---------------------------------------------------------------------------
const lonelyOverflow = candidates.find(
  n => n.key.startsWith('curated:lo-') && !afterKeys.has(n.key),
);
check(
  'PRECISION: an unrelated low-priority singleton is NOT rescued',
  !!lonelyOverflow,
  'every low-priority filler row was admitted — recall is too broad',
);

// ---------------------------------------------------------------------------
// CHANGE A (Task #207): URL-keyed active-member rescue. The curated store clones
// the main feed, so the SAME article can flip its key (main:<id> <-> curated:<id>)
// between passes. A below-cutoff member of a STILL-ACTIVE cluster whose key flipped
// no longer matches the active-by-KEY set, but its URL still does — it must be
// rescued by URL so the existing story doesn't silently lose a member. Built on a
// dedicated pool (unique-token filler => no near-dup matches) so the active-rescue
// budget is free and the URL lane is exercised deterministically.
// ---------------------------------------------------------------------------
const flipPool: LaneNode[] = [];
for (let i = 0; i < 150; i++) {
  flipPool.push(
    node({
      key: `curated:fp-${i}`,
      title: `distinctalpha${i} distinctbeta${i} distinctgamma${i}`,
      priority: 90,
      cls: 'corroborating',
    }),
  );
}
const flippedUrl = 'https://example.com/flip/active-cluster-article';
const flippedNode = node({
  // CURRENT-pass key; low priority so it is firmly in overflow, and a unique title
  // so neither the near-dup nor the same-event-bucket lane can admit it — ONLY the
  // active-by-URL lane can.
  key: 'curated:flipped-now',
  title: 'singletonzeta singletonomega singletontheta',
  priority: 40,
  cls: 'corroborating',
  url: flippedUrl,
});
const flipCandidates = [...flipPool, flippedNode];
const normFlipUrl = flippedUrl.replace(/\/+$/, '').toLowerCase();
// Active set carries the PRIOR-pass key (deliberately NOT the current one) + URL.
const flipSel = selectCandidateNodes(
  flipCandidates,
  new Set(['main:flipped-prev']),
  new Set([normFlipUrl]),
);
check(
  'CHANGE A: an active-cluster member is rescued by URL even when its key flipped',
  new Set(flipSel.allNodes.map(n => n.key)).has('curated:flipped-now'),
  'the key-flipped active member was not admitted via its URL',
);
// Precision control: with NO matching active key OR URL, the SAME singleton is not
// admitted — the URL lane only rescues genuine active-cluster members.
const noFlipSel = selectCandidateNodes(
  flipCandidates,
  new Set(['main:flipped-prev']),
  new Set(),
);
check(
  'CHANGE A: the same singleton is NOT rescued without a matching active URL/key',
  !new Set(noFlipSel.allNodes.map(n => n.key)).has('curated:flipped-now'),
  'the singleton was admitted even though neither its key nor URL is active',
);

// ---------------------------------------------------------------------------
// #215 CROWD-OUT: pass 1 reserves the shared RESCUE_BUDGET for active-cluster
// members BEFORE pass 2 fills the remainder with near-dups. A LOW-priority active
// member must therefore survive even when the ENTIRE budget could be consumed by
// HIGHER-priority near-dups of a primary item. Under the old single-pass
// (priority-desc, first-come) design the RESCUE_BUDGET worth of high-priority
// near-dups would exhaust the budget before the low-priority active member was
// reached, silently dropping a still-active story's source. This fixture pins
// that exact regression: it FAILS on the single-pass design, PASSES on two-pass.
// ---------------------------------------------------------------------------
const coNow = new Date();
const coNodes: LaneNode[] = [];
// A primary-cut anchor the near-dups will match (shared tokens + same time window).
coNodes.push(
  node({
    key: 'curated:co-anchor',
    title: 'crowdone crowdtwo crowdthree crowdfour',
    priority: 950,
    cls: 'corroborating',
    publishedAt: coNow,
  }),
);
// Fill the rest of the top-MAX_NODES cut with unique-token fillers so the crowd
// and the active member both land firmly in OVERFLOW (and the fillers never act
// as near-dup anchors for the crowd).
for (let i = 0; i < MAX_NODES - 1; i++) {
  coNodes.push(
    node({
      key: `curated:co-fill-${i}`,
      title: `cofillalpha${i} cofillbeta${i} cofillgamma${i}`,
      priority: 900 - i,
      cls: 'corroborating',
    }),
  );
}
// RESCUE_BUDGET worth of HIGH-priority near-dups of the anchor (share 3 tokens +
// same time window) — enough to consume the whole budget on their own.
for (let i = 0; i < RESCUE_BUDGET; i++) {
  coNodes.push(
    node({
      key: `curated:co-crowd-${i}`,
      title: `crowdone crowdtwo crowdthree cohdvariant${i}`,
      priority: 700,
      cls: 'corroborating',
      publishedAt: coNow,
    }),
  );
}
// The LOW-priority active-cluster member, with a UNIQUE title so it can ONLY be
// rescued by the active lane (never the near-dup or same-event-bucket lane).
const coActiveKey = 'curated:co-active-member';
coNodes.push(
  node({
    key: coActiveKey,
    title: 'councactivezeta councactiveomega councactivetheta',
    priority: 40,
    cls: 'corroborating',
    publishedAt: coNow,
  }),
);
const coSel = selectCandidateNodes(coNodes, new Set([coActiveKey]), new Set());
const coKeys = new Set(coSel.allNodes.map(n => n.key));
check(
  '#215 CROWD-OUT: a low-priority active member survives a full budget of higher-priority near-dups',
  coKeys.has(coActiveKey),
  'the active-cluster member was crowded out of the rescue budget by near-dups (single-pass regression)',
);
// The near-dup lane is genuinely exercised (the test is not vacuous) AND the
// starvation-fix budgets hold: the continuity lane admits the active member (1,
// ceiling-exempt) and the near-dup lane fills its OWN dedicated budget
// (NEAR_DUP_RESCUE_BUDGET = 20) instead of scavenging continuity leftovers.
const NEAR_DUP_RESCUE_BUDGET = 20; // mirrors server/curatedCluster.ts
check(
  '#215 CROWD-OUT: near-dups fill their dedicated budget alongside the active member',
  coSel.rescuedActiveOrNearDup === 1 + NEAR_DUP_RESCUE_BUDGET &&
    coSel.rescuedNearDup === NEAR_DUP_RESCUE_BUDGET,
  `rescuedActiveOrNearDup=${coSel.rescuedActiveOrNearDup}, rescuedNearDup=${coSel.rescuedNearDup}; expected ${1 + NEAR_DUP_RESCUE_BUDGET}/${NEAR_DUP_RESCUE_BUDGET}`,
);

// ---------------------------------------------------------------------------
// TIME DISTINCTION: token-overlapping coverage that is FAR APART in time must NOT
// land in the same recall bucket (the user's "US strikes Iran" 26h ago vs. "Iran
// targets US bases for a second night" 11h ago case). Same wording but >12h apart
// => separate buckets; the same wording within the window => one bucket.
// ---------------------------------------------------------------------------
const HOUR = 3_600_000;
function tnode(key: string, title: string, hoursAgo: number): LaneNode {
  // cls 'corroborating' so each node is a story-forming CONNECTOR — the
  // transitive bucketing only bridges through real story members.
  return node({
    key,
    title,
    cls: 'corroborating',
    source: 'TimeWire',
    priority: 50,
    publishedAt: new Date(Date.now() - hoursAgo * HOUR),
  });
}

// Two events that share heavy wording (us/iran/strikes/bases) but sit 15h apart.
const farApart = [
  tnode('curated:t-old-1', 'US strikes Iran nuclear sites', 26),
  tnode('curated:t-old-2', 'US strikes Iran in major operation', 26),
  tnode('curated:t-new-1', 'Iran strikes US bases for a second night', 11),
  tnode('curated:t-new-2', 'Iran hits US bases again overnight', 11),
];
const farBuckets = buildSameEventBuckets(farApart).filter(b => b.length >= 2);
const oldBucket = farBuckets.find(b => b.some(n => n.key === 'curated:t-old-1'));
const newBucket = farBuckets.find(b => b.some(n => n.key === 'curated:t-new-1'));
check(
  'TIME: same-token events 15h apart split into SEPARATE buckets',
  !!oldBucket &&
    !!newBucket &&
    !oldBucket.some(n => n.key.startsWith('curated:t-new-')) &&
    !newBucket.some(n => n.key.startsWith('curated:t-old-')),
  `buckets=${JSON.stringify(farBuckets.map(b => b.map(n => n.key)))}`,
);

// Control: the SAME wording within the window still merges into one bucket, so the
// time guard has not broken genuine same-cycle recall.
const sameCycle = [
  tnode('curated:t-c-1', 'Iran strikes US bases for a second night', 11),
  tnode('curated:t-c-2', 'Iran hits US bases again overnight', 13),
];
const cycleBuckets = buildSameEventBuckets(sameCycle).filter(b => b.length >= 2);
check(
  'TIME: same-token events within the window still MERGE (recall intact)',
  cycleBuckets.length === 1 && cycleBuckets[0].length === 2,
  `buckets=${JSON.stringify(cycleBuckets.map(b => b.map(n => n.key)))}`,
);

// ---------------------------------------------------------------------------
// TRANSITIVE BRIDGING (recall): same-event coverage where NO single pairwise
// match spans the whole set must still land in ONE bucket via a shared
// story-forming member. Mirrors the live Anthropic fragmentation: Bloomberg and
// DW don't directly match (only "anthropic" + "access" in common), but BOTH
// match Jerusalem Post, so a transitive chain (Bloomberg~JPost~DW) must pull all
// three together. Axios shares only "anthropic" with the rest, so it correctly
// stays out — recall widens for the connected set only, not for everything.
// ---------------------------------------------------------------------------
const anthropic = [
  node({ key: 'curated:anth-axios', title: "How Amazon and the White House ended Anthropic's Fable", priority: 65, cls: 'corroborating', source: 'Axios' }),
  node({ key: 'curated:anth-bloomberg', title: 'Anthropic Shuts Down Mythos Access After Unprecedented US Order', priority: 58, cls: 'corroborating', source: 'Bloomberg' }),
  node({ key: 'curated:anth-jpost', title: 'Anthropic disables top-tier AI models after US order limiting foreign access', priority: 20, cls: 'corroborating', source: 'Jerusalem Post' }),
  node({ key: 'curated:anth-dw', title: 'Anthropic cuts top-tier AI access after US foreigner ban', priority: 20, cls: 'corroborating', source: 'DW' }),
];
const anthBuckets = buildSameEventBuckets(anthropic);
const anthBridged = anthBuckets.find(b => b.some(n => n.key === 'curated:anth-jpost'));
check(
  'TRANSITIVE: Bloomberg, Jerusalem Post and DW land in ONE bucket via a shared member',
  !!anthBridged &&
    ['curated:anth-bloomberg', 'curated:anth-jpost', 'curated:anth-dw'].every(
      k => anthBridged!.some(n => n.key === k),
    ),
  `buckets=${JSON.stringify(anthBuckets.map(b => b.map(n => n.key)))}`,
);
check(
  'TRANSITIVE PRECISION: Axios (shares only "anthropic") stays OUT of the bridged bucket',
  !!anthBridged && !anthBridged!.some(n => n.key === 'curated:anth-axios'),
  `buckets=${JSON.stringify(anthBuckets.map(b => b.map(n => n.key)))}`,
);

// ---------------------------------------------------------------------------
// BRIDGE GUARD (precision): a non-connector (attach-only / contrast / social)
// node may JOIN a bucket but must NEVER act as the bridge that fuses two
// otherwise-unrelated corroborating reports. Here corrA and corrB do NOT match
// each other (defense+budget = 2 shared over 7-token titles => 0.28 < 0.4), but
// the attach node matches EACH of them (defense+budget over a 5-token title =>
// 0.4). Without the connector guard the attach node would transitively merge
// corrA+corrB into one bucket; with it, they stay separate.
// ---------------------------------------------------------------------------
const bridgeGuard = [
  node({ key: 'curated:bg-corrA', title: 'Senate passes defense budget bill alphaone alphatwo', priority: 60, cls: 'corroborating', source: 'Reuters' }),
  node({ key: 'curated:bg-corrB', title: 'House debates defense budget timeline betaone betatwo', priority: 60, cls: 'corroborating', source: 'AP News' }),
  node({ key: 'curated:bg-attach', title: 'defense budget gammaone gammatwo gammathree', priority: 55, cls: 'attach', source: 'Truth Social' }),
];
const bgBuckets = buildSameEventBuckets(bridgeGuard);
const bgABucket = bgBuckets.find(b => b.some(n => n.key === 'curated:bg-corrA'));
check(
  'BRIDGE GUARD: an attach node cannot bridge two unrelated corroborating reports',
  !!bgABucket && !bgABucket!.some(n => n.key === 'curated:bg-corrB'),
  `buckets=${JSON.stringify(bgBuckets.map(b => b.map(n => n.key)))}`,
);
check(
  'BRIDGE GUARD: the attach node still JOINS the report it directly matches',
  !!bgABucket && bgABucket!.some(n => n.key === 'curated:bg-attach'),
  `buckets=${JSON.stringify(bgBuckets.map(b => b.map(n => n.key)))}`,
);

// Same nodes, but the attach node is listed FIRST — ahead of the connector it
// belongs to. Buckets are seeded from connectors first, so the attach node must
// still be swept into the connector's bucket instead of being orphaned as a
// singleton (the bug: a non-connector seen before any connector gets marked
// assigned and locked out before a connector's BFS can reach it).
const attachFirst = [
  node({ key: 'curated:af-attach', title: 'defense budget gammaone gammatwo gammathree', priority: 70, cls: 'attach', source: 'Truth Social' }),
  node({ key: 'curated:af-corr', title: 'Senate passes defense budget bill alphaone alphatwo', priority: 60, cls: 'corroborating', source: 'Reuters' }),
];
const afBuckets = buildSameEventBuckets(attachFirst);
const afBucket = afBuckets.find(b => b.some(n => n.key === 'curated:af-corr'));
check(
  'CONNECTOR-FIRST: an attach node preceding its connector is swept in, not orphaned',
  !!afBucket &&
    afBucket!.some(n => n.key === 'curated:af-attach') &&
    afBucket!.length === 2,
  `buckets=${JSON.stringify(afBuckets.map(b => b.map(n => n.key)))}`,
);

// ---------------------------------------------------------------------------
// SOCIAL-FLASH RESCUE (Task #209): an official social post (X / Truth Social /
// DataMinr) enters curated at a FIXED low priority (~50) with tweet PROSE for a
// title, so it lands in the overflow and rarely token-matches a headline strongly
// enough for the Task #178 near-dup lane. Lane (d) gives social-flash overflow
// nodes a bounded second chance to ride into the payload when they plausibly
// concern a REAL story node already selected (>= 2 shared significant tokens +
// same-event window). Social is attach-only: it can never seed or represent a
// story; this only widens RECALL so the post can co-enter the payload, and the
// LLM grouping + coherence guard + >=2 formation gate still decide the final
// attachment.
//
// Fixtures isolate lane (d): each social node shares EXACTLY 2 significant tokens
// with the reference story (kerch + bridge) over 6-token titles, so looksSameEvent
// (>= 3 shared OR >= 0.4 coefficient) is FALSE — neither the near-dup lane (a) nor
// the same-event bucket lane (c) can admit it — while looksRelatedSocial (>= 2
// shared, no coefficient) is TRUE, so ONLY lane (d) can.
// ---------------------------------------------------------------------------
const socialFiller: LaneNode[] = [];
for (let i = 0; i < 150; i++) {
  socialFiller.push(
    node({
      key: `curated:sf-${i}`,
      title: `filleralpha${i} fillerbeta${i} fillergamma${i}`,
      priority: 90,
      cls: 'corroborating',
    }),
  );
}
// A real, selected story (priority 95 => firmly in the top-MAX_NODES primary set,
// so it lands in the storyRefNodes snapshot that lane (d) matches against).
const socialRefStory: LaneNode[] = [0, 1, 2].map(i =>
  node({
    key: `curated:soc-ref-${i}`,
    title: `kerch bridge crimea refalpha${i} refbeta${i} refgamma${i}`,
    priority: 95,
    cls: 'corroborating',
    source: ['Reuters', 'AP News', 'BBC'][i],
  }),
);
function socialNode(key: string, uniq: string, priority = 40): LaneNode {
  return node({
    key,
    // shares EXACTLY kerch + bridge (2 tokens) with the reference; 6 tokens total
    // so the overlap coefficient stays below 0.4 and looksSameEvent stays false.
    title: `kerch bridge ${uniq}a ${uniq}b ${uniq}c ${uniq}d`,
    priority,
    cls: 'attach',
    source: 'Truth Social',
    isSocialFlash: true,
  });
}

// Selection A — rescue + precision: 5 on-topic social posts ride in via lane (d);
// 1 off-topic social post (no shared tokens) does NOT.
const relatedSocial = [0, 1, 2, 3, 4].map(i => socialNode(`curated:soc-rel-${i}`, `socrel${i}`));
const offtopicSocial = node({
  key: 'curated:soc-offtopic',
  title: 'unrelatedalpha unrelatedbeta unrelatedgamma unrelateddelta',
  priority: 40,
  cls: 'attach',
  source: 'Truth Social',
  isSocialFlash: true,
});
const socialPoolA = [...socialFiller, ...socialRefStory, ...relatedSocial, offtopicSocial];
const socialSelA = selectCandidateNodes(socialPoolA, new Set(), new Set());
const socialKeysA = new Set(socialSelA.allNodes.map(n => n.key));
console.log(
  `[repro] SOCIAL A: rescuedSocial=${socialSelA.rescuedSocial}; ` +
    `on-topic admitted=${relatedSocial.filter(n => socialKeysA.has(n.key)).length}/${relatedSocial.length}; ` +
    `off-topic admitted=${socialKeysA.has(offtopicSocial.key)}`,
);
check(
  'SOCIAL: on-topic official social posts are rescued into the payload via lane (d)',
  relatedSocial.every(n => socialKeysA.has(n.key)) &&
    socialSelA.rescuedSocial === relatedSocial.length,
  `rescuedSocial=${socialSelA.rescuedSocial}; admitted=${relatedSocial.filter(n => socialKeysA.has(n.key)).length}/${relatedSocial.length}`,
);
check(
  'SOCIAL PRECISION: an off-topic official social post is NOT rescued',
  !socialKeysA.has(offtopicSocial.key),
  'the off-topic social post was admitted — social recall is too broad',
);

// Selection B — budget exhaustion: 60 on-topic social posts all qualify, but lane
// (d) admits at most SOCIAL_RESCUE_BUDGET, and the payload stays HARD-bounded.
const manySocial = Array.from({ length: 60 }, (_, i) =>
  socialNode(`curated:soc-many-${i}`, `socmany${i}`),
);
const socialPoolB = [...socialFiller, ...socialRefStory, ...manySocial];
const socialSelB = selectCandidateNodes(socialPoolB, new Set(), new Set());
const socialKeysB = new Set(socialSelB.allNodes.map(n => n.key));
const manyAdmitted = manySocial.filter(n => socialKeysB.has(n.key)).length;
console.log(
  `[repro] SOCIAL B: rescuedSocial=${socialSelB.rescuedSocial}; ` +
    `admitted=${manyAdmitted}/${manySocial.length}; payload=${socialSelB.allNodes.length}`,
);
check(
  'SOCIAL BUDGET: social rescue is capped at SOCIAL_RESCUE_BUDGET',
  socialSelB.rescuedSocial === SOCIAL_RESCUE_BUDGET && manyAdmitted === SOCIAL_RESCUE_BUDGET,
  `rescuedSocial=${socialSelB.rescuedSocial}; manyAdmitted=${manyAdmitted}; budget=${SOCIAL_RESCUE_BUDGET}`,
);
check(
  'SOCIAL BUDGET: not all over-budget social posts are admitted',
  manyAdmitted < manySocial.length,
  `all ${manySocial.length} social posts were admitted despite the budget`,
);
check(
  'SOCIAL INVARIANT: payload stays within HARD_NODE_CEILING with social rescue active',
  socialSelB.allNodes.length <= HARD_NODE_CEILING,
  `payload=${socialSelB.allNodes.length} > ${HARD_NODE_CEILING}`,
);

// ---------------------------------------------------------------------------
// CONTRAST RESCUE (Task #210): a CONTRAST item (CPC/SWL/EPC alignment or a
// mixed/low/very-low factuality outlet — deriveBehavior => cls 'anchor-only',
// label 'contrast', e.g. RT / Press TV / TASS / Global Times / Fox News) is pushed
// below the flat priority cutoff by its content-based score and frames the same
// event with DIVERGENT (propaganda / adversarial) wording, so it rarely token-
// matches a mainstream headline strongly enough for the Task #178 near-dup lane,
// and lane (d) skips it (not social). Lane (e) gives contrast overflow nodes a
// bounded second chance to ride into the payload when they plausibly contrast a
// REAL story node already selected (>= 2 shared significant tokens + same-event
// window). Contrast is anchor-only: it can never seed, represent, or inform the
// facts of a story; this only widens RECALL so the item can co-enter the payload,
// and the LLM grouping + coherence guard + >=2 formation gate still decide the
// final attachment.
//
// Fixtures isolate lane (e): each contrast node shares EXACTLY 2 significant tokens
// with the reference story (damascus + airstrike) over 6-token titles, so
// looksSameEvent (>= 3 shared OR >= 0.4 coefficient) is FALSE — neither the near-dup
// lane (a) nor the same-event bucket lane (c) can admit it — while looksRelatedToStory
// (>= 2 shared, no coefficient) is TRUE, so ONLY lane (e) can.
// ---------------------------------------------------------------------------
const contrastFiller: LaneNode[] = [];
for (let i = 0; i < 150; i++) {
  contrastFiller.push(
    node({
      key: `curated:cf-${i}`,
      title: `ctfilleralpha${i} ctfillerbeta${i} ctfillergamma${i}`,
      priority: 90,
      cls: 'corroborating',
    }),
  );
}
// A real, selected story (priority 95 => firmly in the top-MAX_NODES primary set,
// so it lands in the storyRefNodes snapshot that lane (e) matches against).
const contrastRefStory: LaneNode[] = [0, 1, 2].map(i =>
  node({
    key: `curated:ct-ref-${i}`,
    title: `damascus airstrike syria ctrefalpha${i} ctrefbeta${i} ctrefgamma${i}`,
    priority: 95,
    cls: 'corroborating',
    source: ['Reuters', 'AP News', 'BBC'][i],
  }),
);
function contrastNode(key: string, uniq: string, priority = 40): LaneNode {
  return node({
    key,
    // shares EXACTLY damascus + airstrike (2 tokens) with the reference; 6 tokens
    // total so the overlap coefficient stays below 0.4 and looksSameEvent stays false.
    title: `damascus airstrike ${uniq}a ${uniq}b ${uniq}c ${uniq}d`,
    priority,
    cls: 'anchor-only',
    label: 'contrast',
    source: 'RT',
  });
}

// Selection A — rescue + precision: 5 on-topic contrast items ride in via lane (e);
// 1 off-topic contrast item (no shared tokens) does NOT.
const relatedContrast = [0, 1, 2, 3, 4].map(i => contrastNode(`curated:ct-rel-${i}`, `ctrel${i}`));
const offtopicContrast = node({
  key: 'curated:ct-offtopic',
  title: 'ctunrelatedalpha ctunrelatedbeta ctunrelatedgamma ctunrelateddelta',
  priority: 40,
  cls: 'anchor-only',
  label: 'contrast',
  source: 'RT',
});
const contrastPoolA = [...contrastFiller, ...contrastRefStory, ...relatedContrast, offtopicContrast];
const contrastSelA = selectCandidateNodes(contrastPoolA, new Set(), new Set());
const contrastKeysA = new Set(contrastSelA.allNodes.map(n => n.key));
console.log(
  `[repro] CONTRAST A: rescuedContrast=${contrastSelA.rescuedContrast}; ` +
    `on-topic admitted=${relatedContrast.filter(n => contrastKeysA.has(n.key)).length}/${relatedContrast.length}; ` +
    `off-topic admitted=${contrastKeysA.has(offtopicContrast.key)}`,
);
check(
  'CONTRAST: on-topic contrast items are rescued into the payload via lane (e)',
  relatedContrast.every(n => contrastKeysA.has(n.key)) &&
    contrastSelA.rescuedContrast === relatedContrast.length,
  `rescuedContrast=${contrastSelA.rescuedContrast}; admitted=${relatedContrast.filter(n => contrastKeysA.has(n.key)).length}/${relatedContrast.length}`,
);
check(
  'CONTRAST PRECISION: an off-topic contrast item is NOT rescued',
  !contrastKeysA.has(offtopicContrast.key),
  'the off-topic contrast item was admitted — contrast recall is too broad',
);

// Selection B — budget exhaustion: 60 on-topic contrast items all qualify, but lane
// (e) admits at most CONTRAST_RESCUE_BUDGET, and the payload stays HARD-bounded.
const manyContrast = Array.from({ length: 60 }, (_, i) =>
  contrastNode(`curated:ct-many-${i}`, `ctmany${i}`),
);
const contrastPoolB = [...contrastFiller, ...contrastRefStory, ...manyContrast];
const contrastSelB = selectCandidateNodes(contrastPoolB, new Set(), new Set());
const contrastKeysB = new Set(contrastSelB.allNodes.map(n => n.key));
const manyContrastAdmitted = manyContrast.filter(n => contrastKeysB.has(n.key)).length;
console.log(
  `[repro] CONTRAST B: rescuedContrast=${contrastSelB.rescuedContrast}; ` +
    `admitted=${manyContrastAdmitted}/${manyContrast.length}; payload=${contrastSelB.allNodes.length}`,
);
check(
  'CONTRAST BUDGET: contrast rescue is capped at CONTRAST_RESCUE_BUDGET',
  contrastSelB.rescuedContrast === CONTRAST_RESCUE_BUDGET && manyContrastAdmitted === CONTRAST_RESCUE_BUDGET,
  `rescuedContrast=${contrastSelB.rescuedContrast}; manyAdmitted=${manyContrastAdmitted}; budget=${CONTRAST_RESCUE_BUDGET}`,
);
check(
  'CONTRAST BUDGET: not all over-budget contrast items are admitted',
  manyContrastAdmitted < manyContrast.length,
  `all ${manyContrast.length} contrast items were admitted despite the budget`,
);
check(
  'CONTRAST INVARIANT: payload stays within HARD_NODE_CEILING with contrast rescue active',
  contrastSelB.allNodes.length <= HARD_NODE_CEILING,
  `payload=${contrastSelB.allNodes.length} > ${HARD_NODE_CEILING}`,
);

// ---------------------------------------------------------------------------
// PROCESS-AWARE PHASE-OUT: a developing diplomatic/negotiation story (a "deal"
// being signed) legitimately spans multiple days. The 22h hard cap, tuned for
// discrete strikes, was killing a still-active multi-day deal before write. The
// exemption raises the hard ceiling to 48h ONLY for a process cluster that is
// still actively updating, and strikes never get it. Pure + deterministic.
// ---------------------------------------------------------------------------
const NOW = Date.now();
const HRS = (h: number) => NOW - h * HOUR;

// Detector: >= 2 deal-worded titles => process cluster; a strike cluster (even
// one that mentions a deal ONCE) is not, and "signal" must not trip "sign".
check(
  'PROCESS DETECT: >=2 deal-worded titles => developing process',
  isDevelopingProcessCluster([
    'Trump says US-Iran deal to be signed Sunday',
    'Mediator says US-Iran peace deal could be finalized within 24 hours',
    'US shoots down Iranian drones over Hormuz',
  ]) === true,
);
check(
  'PROCESS DETECT: a strike cluster is NOT a process (no deal vocab)',
  isDevelopingProcessCluster([
    'US strikes Iranian nuclear sites',
    'Pentagon confirms strikes on Iran facilities',
    'Iran reports damage after US attack',
  ]) === false,
);
check(
  'PROCESS DETECT: a single deal-worded title is not enough (>=2 required)',
  isDevelopingProcessCluster([
    'US and Iran say deal close but Lebanon fighting continues',
    'Israel launches fresh strikes on south Lebanon',
  ]) === false,
);
check(
  'PROCESS DETECT: "signal"/"signals" must NOT match the sign() term',
  isDevelopingProcessCluster([
    'Iran signals readiness to talk',
    'Tehran signals openness amid pressure',
  ]) === false,
);
check(
  'PROCESS DETECT: bare "signs"/"signs order" must NOT match (only signed/signing/to sign)',
  isDevelopingProcessCluster([
    'Trump signs executive order targeting Iran',
    'Analysts see signs of further escalation',
  ]) === false,
);
check(
  'PROCESS DETECT: "talks"/"framework"/"finalized" carry recall for deal stories without the word "deal"',
  isDevelopingProcessCluster([
    'US-Iran talks continue into a second day in Geneva',
    'Officials say a framework could be finalized within hours',
  ]) === true,
);
check(
  'PROCESS DETECT (new vocab): "reversal"/"walk back" qualify a proposal-reaction-reversal arc',
  isDevelopingProcessCluster([
    'Iran walks back proposal on Hormuz transit toll after US pressure',
    'US rejects counter-proposal on Hormuz shipping fees, demands full reversal',
  ]) === true,
);
check(
  'PROCESS DETECT (new vocab): "concession"/"counter-proposal" qualify a negotiation arc',
  isDevelopingProcessCluster([
    'Tehran makes concessions on Strait of Hormuz access fees',
    'White House rejects Iranian counter-proposal, calls for unconditional withdrawal',
  ]) === true,
);
check(
  'PROCESS DETECT (new vocab): a single reversal title is not enough (>=2 required)',
  isDevelopingProcessCluster([
    'Iran reverses position on Hormuz toll plan',
    'US strikes Iranian drone sites over Strait',
  ]) === false,
);
check(
  'PROCESS DETECT (new vocab): kinetic strike titles with no process vocab stay NOT a process',
  isDevelopingProcessCluster([
    'US Navy strikes Iranian patrol boats in Gulf',
    'Iran retaliates with missile barrage on US base',
  ]) === false,
);

// The exact production shape: a deal story spanning ~28h whose newest member is
// fresh (just updated). Without the exemption it hard-phases-out (age>22); with
// it (process + actively updating) it SURVIVES (age 28 < 48 ceiling).
const dealPubTimes = [HRS(28), HRS(20), HRS(11), HRS(0.5)];
check(
  'PHASEOUT: 28h-spanning STRIKE cluster (no exemption) is phased out',
  isClusterPhasedOut(dealPubTimes, NOW) === true,
);
check(
  'PHASEOUT: 28h-spanning DEAL cluster still updating SURVIVES (process exemption)',
  isClusterPhasedOut(dealPubTimes, NOW, { developingProcess: true }) === false,
);
// A stale deal story (no fresh update for >6h) falls back to the normal rule and
// drops like any stale story — the exemption is for ACTIVE stories only.
const staleDealPubTimes = [HRS(30), HRS(26), HRS(24)];
check(
  'PHASEOUT: a STALE deal cluster (no fresh update) still drops',
  isClusterPhasedOut(staleDealPubTimes, NOW, { developingProcess: true }) === true,
);
// Even an actively-updating process story cannot live past the 48h ceiling.
const ancientActiveDeal = [HRS(50), HRS(40), HRS(0.5)];
check(
  'PHASEOUT: a process cluster older than 48h is still phased out (absolute ceiling)',
  isClusterPhasedOut(ancientActiveDeal, NOW, { developingProcess: true }) === true,
);
// Control: a recent strike cluster (well within 22h) is NOT phased out — the
// normal path is unchanged for kinetic events.
check(
  'PHASEOUT: a recent strike cluster (<16h) is NOT phased out',
  isClusterPhasedOut([HRS(10), HRS(8), HRS(2)], NOW) === false,
);

// ---------------------------------------------------------------------------
// GENERAL ACTIVELY-UPDATING CLUSTER EXTENSION (Task #301). A non-process,
// multi-source clustered story that is STILL being reported by trusted
// (contributing) outlets is legitimately live past the 22h kinetic hard cap,
// up to the bounded 36h ceiling — but ONLY freshness from CONTRIBUTING members
// counts, so an adversary/attach repost can never hold a story open. Strictly
// additive: omitting lastContributingMs reproduces today's rule exactly.

// lastContributingMs needs >= 2 corroborating members with usable dates.
check(
  'PHASEOUT helper: lastContributingMs is undefined with < 2 corroborating members',
  lastContributingMs([
    { cls: 'corroborating', publishedAt: new Date(HRS(1)) },
    { cls: 'attach', publishedAt: new Date(HRS(0.5)) },
    { cls: 'anchor-only', publishedAt: new Date(HRS(0.5)) },
  ]) === undefined,
);
check(
  'PHASEOUT helper: lastContributingMs returns the NEWEST corroborating timestamp',
  lastContributingMs([
    { cls: 'corroborating', publishedAt: new Date(HRS(5)) },
    { cls: 'corroborating', publishedAt: new Date(HRS(2)) },
    { cls: 'attach', publishedAt: new Date(HRS(0.1)) },
  ]) === HRS(2),
);
check(
  'PHASEOUT helper: lastContributingMs reads the stored behaviorClass shape too',
  lastContributingMs([
    { behaviorClass: 'corroborating', publishedAt: new Date(HRS(7)) },
    { behaviorClass: 'corroborating', publishedAt: new Date(HRS(3)) },
  ]) === HRS(3),
);

// A non-process multi-source story aged 24h (past the 22h hard cap) whose newest
// CONTRIBUTING report landed within the active gap SURVIVES (24 < 36 ceiling).
const activeContribTimes = [HRS(24), HRS(18), HRS(10), HRS(1)];
check(
  'PHASEOUT: an actively-updating 24h cluster SURVIVES when a contributing member is fresh',
  isClusterPhasedOut(activeContribTimes, NOW, { lastContributingMs: HRS(1) }) === false,
);
// Without the opt the SAME cluster phases out — proves the rule is unchanged
// for callers that don't pass contributing freshness (back-compat).
check(
  'PHASEOUT: the SAME 24h cluster phases out with no contributing-freshness opt (back-compat)',
  isClusterPhasedOut(activeContribTimes, NOW) === true,
);
// The extension is keyed on CONTRIBUTING freshness only: if the only fresh
// member is an adversary/attach repost (so lastContributingMs is stale), the
// story falls back to the normal hard cap and phases out.
check(
  'PHASEOUT: a stale-contributing 24h cluster still drops (adversary repost cannot hold it open)',
  isClusterPhasedOut(activeContribTimes, NOW, { lastContributingMs: HRS(12) }) === true,
);
// The general extension respects its own 36h ceiling: a story aged past 36h
// drops even with a fresh contributing update (bounded below the 48h process
// ceiling so nothing zombies forever).
check(
  'PHASEOUT: an actively-updating cluster older than 36h still phases out (general ceiling)',
  isClusterPhasedOut([HRS(40), HRS(30), HRS(1)], NOW, { lastContributingMs: HRS(1) }) === true,
);
// A fresh, young actively-updating cluster (well within every ceiling) stays.
check(
  'PHASEOUT: a young actively-updating cluster (<16h) is NOT phased out',
  isClusterPhasedOut([HRS(14), HRS(8), HRS(1)], NOW, { lastContributingMs: HRS(1) }) === false,
);

// ---------------------------------------------------------------------------
// SCHEDULED-EVENT PHASE SEPARATION (Task #297): a scheduled gathering (summit /
// conference / forum with a defined START) has TWO distinct phases — AHEAD-OF
// anticipation coverage vs DURING/at-the-event coverage. The G7 over-merge folded
// pre-event "Trump to address … at G7" previews INTO the during-event "G7 Summit
// Begins" story because "summit" qualified for the broad multi-day PROCESS
// exemption. The deterministic guard splits the two phases in the recall lane
// (mirroring the prompt + coherence-guard carve-out); open-ended deal/ceasefire
// NEGOTIATIONS keep grouping across days, and kinetic strikes are untouched.
// ---------------------------------------------------------------------------

// Phase classifier: pre-event anticipation, during-event, or null (not a scheduled
// gathering OR no clear phase cue). Conservative — null means "no split".
check(
  'SCHED PHASE: "Trump to address allies at G7 summit" => pre-event',
  scheduledEventPhase('Trump to address allies at G7 summit') === 'pre',
  `got ${scheduledEventPhase('Trump to address allies at G7 summit')}`,
);
check(
  'SCHED PHASE: "Leaders set to discuss Ukraine ahead of G7 summit" => pre-event',
  scheduledEventPhase('Leaders set to discuss Ukraine ahead of G7 summit') === 'pre',
  `got ${scheduledEventPhase('Leaders set to discuss Ukraine ahead of G7 summit')}`,
);
check(
  'SCHED PHASE: "G7 Summit Begins in France" => during-event',
  scheduledEventPhase('G7 Summit Begins in France') === 'during',
  `got ${scheduledEventPhase('G7 Summit Begins in France')}`,
);
check(
  'SCHED PHASE: "World Leaders Gather for G7 Summit" => during-event',
  scheduledEventPhase('World Leaders Gather for G7 Summit') === 'during',
  `got ${scheduledEventPhase('World Leaders Gather for G7 Summit')}`,
);
check(
  'SCHED PHASE: a deal/negotiation title is NOT a scheduled-event phase (=> null)',
  scheduledEventPhase('Mediator says US-Iran peace deal could be finalized within 24 hours') === null,
  `got ${scheduledEventPhase('Mediator says US-Iran peace deal could be finalized within 24 hours')}`,
);
check(
  'SCHED PHASE: a kinetic strike title is NOT a scheduled-event phase (=> null)',
  scheduledEventPhase('US strikes Iranian nuclear sites') === null,
  `got ${scheduledEventPhase('US strikes Iranian nuclear sites')}`,
);

// Recall split: four summit items — two PRE, two DURING — all sharing heavy tokens
// (g7 / summit / ukraine / iran) and ALL within the same-event time window (8h
// apart), so WITHOUT the phase guard the token+time heuristic would fuse all four
// into ONE bucket. WITH the guard they split into a pre-event bucket and a
// during-event bucket — the deterministic counterpart to the prompt carve-out.
function snode(key: string, title: string, hoursAgo: number): LaneNode {
  return node({
    key,
    title,
    cls: 'corroborating',
    source: 'SummitWire',
    priority: 60,
    publishedAt: new Date(Date.now() - hoursAgo * HOUR),
  });
}
const summitItems = [
  snode('curated:g7-pre-1', 'Trump to address G7 summit on Ukraine and Iran', 10),
  snode('curated:g7-pre-2', 'Leaders set to discuss Ukraine and Iran ahead of G7 summit', 10),
  snode('curated:g7-dur-1', 'G7 summit begins as leaders discuss Ukraine and Iran', 2),
  snode('curated:g7-dur-2', 'World leaders gather as G7 summit opens on Ukraine and Iran', 2),
];
const summitBuckets = buildSameEventBuckets(summitItems).filter(b => b.length >= 2);
const preBucket = summitBuckets.find(b => b.some(n => n.key === 'curated:g7-pre-1'));
const durBucket = summitBuckets.find(b => b.some(n => n.key === 'curated:g7-dur-1'));
check(
  'SCHED SPLIT: pre-event and during-event summit coverage land in SEPARATE buckets',
  !!preBucket &&
    !!durBucket &&
    preBucket !== durBucket &&
    preBucket!.some(n => n.key === 'curated:g7-pre-2') &&
    !preBucket!.some(n => n.key.startsWith('curated:g7-dur-')) &&
    durBucket!.some(n => n.key === 'curated:g7-dur-2') &&
    !durBucket!.some(n => n.key.startsWith('curated:g7-pre-')),
  `buckets=${JSON.stringify(summitBuckets.map(b => b.map(n => n.key)))}`,
);

// Same-phase control: two DURING-event items within the window still MERGE — the
// phase guard splits ACROSS phases only, it does not fragment genuine during-event
// coverage of the gathering as it unfolds.
const duringOnly = [
  snode('curated:g7-d-a', 'G7 summit begins as leaders discuss Ukraine and Iran', 4),
  snode('curated:g7-d-b', 'World leaders gather as G7 summit opens on Ukraine and Iran', 2),
];
const duringBuckets = buildSameEventBuckets(duringOnly).filter(b => b.length >= 2);
check(
  'SCHED CONTROL: two during-event summit items still MERGE (no over-split)',
  duringBuckets.length === 1 && duringBuckets[0].length === 2,
  `buckets=${JSON.stringify(duringBuckets.map(b => b.map(n => n.key)))}`,
);

// Negotiation control: an open-ended deal/negotiation is NOT a scheduled gathering,
// so the phase guard never touches it — two deal items within the window still
// bucket together, AND the cluster is still detected as a developing PROCESS (its
// multi-day grouping + retention exemption are unchanged by this task).
const dealItems = [
  snode('curated:deal-1', 'US-Iran deal talks continue for a second day in Geneva', 4),
  snode('curated:deal-2', 'Mediators say US-Iran deal could be finalized in Geneva today', 2),
];
const dealBuckets = buildSameEventBuckets(dealItems).filter(b => b.length >= 2);
check(
  'SCHED CONTROL: an open-ended deal/negotiation still buckets together (not phase-split)',
  dealBuckets.length === 1 && dealBuckets[0].length === 2,
  `buckets=${JSON.stringify(dealBuckets.map(b => b.map(n => n.key)))}`,
);
check(
  'SCHED CONTROL: the deal cluster is still detected as a developing PROCESS (grouping intact)',
  isDevelopingProcessCluster(dealItems.map(n => n.title)) === true,
);

// Strike control: kinetic strike coverage is never a scheduled-event phase, so it
// remains governed by the existing same-event window (15h apart => separate).
const strikePhaseItems = [
  snode('curated:strk-1', 'US strikes Iran nuclear sites', 26),
  snode('curated:strk-2', 'Iran strikes US bases for a second night', 11),
];
check(
  'SCHED CONTROL: strike titles carry no scheduled-event phase (rules unchanged)',
  scheduledEventPhase(strikePhaseItems[0].title) === null &&
    scheduledEventPhase(strikePhaseItems[1].title) === null,
);

if (failures > 0) {
  console.error(`\n[repro] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[repro] all checks passed — node-cap recall fix verified at production scale');
process.exit(0);
