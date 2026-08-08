/**
 * Mutual-exchange cluster merge regression (Task #806).
 *
 * Two "exchange"-framed Top Stories about the same two actors in the same news
 * cycle must collapse into ONE cluster card. The four cases below are the
 * canonical regression suite:
 *
 *   (a) POSITIVE  — two divergent-wording exchange cards of the SAME actor pair
 *                   → merged into one cluster
 *   (b) NEGATIVE  — a single-direction strike card alongside an exchange card
 *                   → stays separate (direction split preserved)
 *   (c) NEGATIVE  — two exchanges of DIFFERENT actor pairs
 *                   → stays separate (wrong pair)
 *   (d) NEGATIVE  — an exchange pair outside the same-event time window
 *                   → stays separate (different news cycle)
 *
 * Pure + deterministic — no network, no DB, no LLM. Exercises the real
 * exported functions that the clustering pass calls.
 *
 * Run directly:
 *   npx tsx scripts/curated-exchange-merge.test.ts
 * Exits non-zero on any failure.
 */

import {
  isMutualExchangeFraming,
  extractActorPair,
  reconcileMustLinkGroups,
  withinSameEventWindow,
  type LaneNode,
} from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[exchange-merge] OK   ${name}`);
  } else {
    console.error(`[exchange-merge] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const NOW = new Date('2026-06-30T12:00:00Z');
const HOUR = 3_600_000;

function node(
  partial: Partial<LaneNode> & { key: string; title: string },
): LaneNode {
  const cls: LaneNode['cls'] = (partial as any).cls ?? 'corroborating';
  return {
    itemType: 'curated',
    itemId: partial.key.split(':')[1] ?? partial.key,
    source: partial.source ?? 'Test Wire',
    url: partial.url ?? `https://example.com/${partial.key}`,
    category: 'general',
    label: null,
    cls,
    role: cls === 'corroborating' ? 'contributing' : cls === 'anchor-only' ? 'anchor-only' : 'attach-only',
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
// Helper: simulate the exchange merge lane.
// Given coherent groups (as arrays of node keys) and a nodeByKey map,
// returns the must-link key groups that the exchange lane would emit.
// This mirrors the production logic in curatedCluster.ts exactly.
// ---------------------------------------------------------------------------
function simulateExchangeLane(
  coherentGroupKeys: string[][],
  nodeByKey: Map<string, LaneNode>,
): string[][] {
  const BUDGET = 6;
  type ExchangeGroupRep = { keys: string[]; rep: LaneNode; pairKey: string };
  const exchangeReps: ExchangeGroupRep[] = [];

  for (const keys of coherentGroupKeys) {
    const repNode = keys
      .map(k => nodeByKey.get(k))
      .filter((n): n is LaneNode => !!n && n.cls === 'corroborating' && !n.blocked)
      .sort((a, b) => b.priority - a.priority)[0];
    if (!repNode) continue;
    if (!isMutualExchangeFraming(repNode.title, repNode.summary)) continue;
    const pair = extractActorPair(repNode.title);
    if (!pair) continue;
    exchangeReps.push({ keys, rep: repNode, pairKey: pair.join('|') });
  }

  const mustLinks: string[][] = [];
  outer: for (let i = 0; i < exchangeReps.length; i++) {
    for (let j = i + 1; j < exchangeReps.length; j++) {
      if (mustLinks.length >= BUDGET) break outer;
      const eI = exchangeReps[i];
      const eJ = exchangeReps[j];
      if (eI.pairKey !== eJ.pairKey) continue;
      if (!withinSameEventWindow(eI.rep.publishedAt, eJ.rep.publishedAt)) continue;
      mustLinks.push([...eI.keys, ...eJ.keys]);
    }
  }
  return mustLinks;
}

// ===========================================================================
// Unit-level checks on isMutualExchangeFraming
// ===========================================================================

// Exchange headlines — must match
const EXCHANGE_TITLES_POSITIVE = [
  'US and Iran Exchange Strikes Amid Dispute Over Strait of Hormuz Status',
  'Iran and US exchange strikes across Gulf region, oil prices rise',
  'Russia and Ukraine trade strikes along Kharkiv front line',
  'Israel and Hezbollah exchange fire across the northern border',
  'Both sides traded blows in overnight clashes along disputed territory',
  'Tit-for-tat strikes between Israel and Hezbollah escalate',
  'US and Iran bomb each other in Gulf standoff',
  'Both sides struck back as the conflict widened overnight',
  'Missiles exchanged between Israel and Hamas over Gaza Strip',
];

// Single-direction or non-attack headlines — must NOT match
const EXCHANGE_TITLES_NEGATIVE = [
  'US strikes Iran for the fifth time as conflict escalates',
  'Iran retaliates against US strike on nuclear facilities',
  'US and Iran exchange prisoners in diplomatic deal',
  'US and Iran trade insults over nuclear negotiations',
  'Israel attacks Gaza in overnight operation',
  'Iran launches missiles at US bases in Iraq',
  'China steps up patrols near Taiwan',
  'US and Iran trade barbs at UN Security Council meeting',
  'US and Russia exchange diplomats after spy row',
];

for (const title of EXCHANGE_TITLES_POSITIVE) {
  check(
    `isMutualExchangeFraming TRUE: "${title.slice(0, 60)}"`,
    isMutualExchangeFraming(title),
    'expected true, got false',
  );
}

for (const title of EXCHANGE_TITLES_NEGATIVE) {
  check(
    `isMutualExchangeFraming FALSE: "${title.slice(0, 60)}"`,
    !isMutualExchangeFraming(title),
    'expected false, got true',
  );
}

// ===========================================================================
// Unit-level checks on extractActorPair
// ===========================================================================

{
  const pair = extractActorPair('US and Iran Exchange Strikes Amid Dispute Over Strait of Hormuz Status');
  check(
    'extractActorPair: US and Iran → [Iran, US] sorted',
    pair !== null && pair[0] === 'Iran' && pair[1] === 'US',
    JSON.stringify(pair),
  );
}

{
  const pair = extractActorPair('Iran and US exchange strikes across Gulf region, oil prices rise');
  check(
    'extractActorPair: Iran and US → [Iran, US] sorted (same as above)',
    pair !== null && pair[0] === 'Iran' && pair[1] === 'US',
    JSON.stringify(pair),
  );
}

{
  const pair = extractActorPair('Russia and Ukraine trade strikes along Kharkiv front');
  check(
    'extractActorPair: Russia and Ukraine → [Russia, Ukraine] sorted',
    pair !== null && pair[0] === 'Russia' && pair[1] === 'Ukraine',
    JSON.stringify(pair),
  );
}

{
  const pair = extractActorPair('US strikes Iran for the fifth time');
  check(
    'extractActorPair: US strikes Iran (single-direction) → still extracts pair',
    pair !== null && pair[0] === 'Iran' && pair[1] === 'US',
    JSON.stringify(pair),
  );
}

{
  // Three actors — ambiguous, should return null
  const pair = extractActorPair('US, Iran and Israel in triangular standoff');
  check(
    'extractActorPair: three actors → null (ambiguous)',
    pair === null,
    JSON.stringify(pair),
  );
}

// ===========================================================================
// (a) POSITIVE: two divergent-wording exchange cards of the SAME pair → merge
// ===========================================================================
// Mirrors the real example from the task:
//   "US and Iran Exchange Strikes Amid Dispute Over Strait of Hormuz Status" (11 sources)
//   "Iran and US exchange strikes across Gulf region, oil prices rise" (3 sources)
{
  const clusterANodes = [
    node({ key: 'curated:a1', title: 'US and Iran Exchange Strikes Amid Dispute Over Strait of Hormuz Status', source: 'Reuters', priority: 80 }),
    node({ key: 'curated:a2', title: 'US and Iran Exchange Strikes Amid Dispute Over Strait of Hormuz Status', source: 'AP', priority: 79 }),
    node({ key: 'curated:a3', title: 'US and Iran Exchange Strikes Amid Dispute Over Strait of Hormuz Status', source: 'BBC', priority: 78 }),
  ];
  const clusterBNodes = [
    node({ key: 'curated:b1', title: 'Iran and US exchange strikes across Gulf region, oil prices rise', source: 'DW', priority: 72 }),
    node({ key: 'curated:b2', title: 'Iran and US exchange strikes across Gulf region, oil prices rise', source: 'Al Jazeera', priority: 71 }),
  ];
  const allNodes = [...clusterANodes, ...clusterBNodes];
  const nodeByKey = new Map(allNodes.map(n => [n.key, n]));

  const groupAKeys = clusterANodes.map(n => n.key);
  const groupBKeys = clusterBNodes.map(n => n.key);
  const coherentGroupKeys = [groupAKeys, groupBKeys];
  const coherentGroups = coherentGroupKeys.map(keys => ({ keys }));

  // Check both reps are exchange-framed
  check(
    '(a) cluster A rep is exchange-framed',
    isMutualExchangeFraming(clusterANodes[0].title),
  );
  check(
    '(a) cluster B rep is exchange-framed',
    isMutualExchangeFraming(clusterBNodes[0].title),
  );

  // Check both yield the same actor pair
  const pairA = extractActorPair(clusterANodes[0].title);
  const pairB = extractActorPair(clusterBNodes[0].title);
  check(
    '(a) both reps yield the same actor pair (Iran|US)',
    pairA !== null && pairB !== null && pairA.join('|') === pairB.join('|'),
    `pairA=${JSON.stringify(pairA)} pairB=${JSON.stringify(pairB)}`,
  );

  // Simulate the exchange lane
  const mustLinks = simulateExchangeLane(coherentGroupKeys, nodeByKey);
  check(
    '(a) exchange lane emits exactly ONE must-link group',
    mustLinks.length === 1,
    `mustLinks=${JSON.stringify(mustLinks.map(g => g.length))}`,
  );

  // Apply reconcile and verify the two groups are merged
  const reconciled = reconcileMustLinkGroups(coherentGroups, mustLinks);
  const allKeys = new Set([...groupAKeys, ...groupBKeys]);
  const merged = reconciled.find(g => groupAKeys.some(k => g.keys.includes(k)) && groupBKeys.some(k => g.keys.includes(k)));
  check(
    '(a) after reconcile: A and B are in ONE group',
    !!merged && allKeys.size === merged.keys.length,
    `reconciled groups=${JSON.stringify(reconciled.map(g => g.keys))}`,
  );
}

// ===========================================================================
// (b) NEGATIVE: single-direction strike card stays separate from exchange card
// ===========================================================================
{
  const exchangeNodes = [
    node({ key: 'curated:ex1', title: 'US and Iran Exchange Strikes Amid Dispute Over Strait of Hormuz Status', source: 'Reuters', priority: 80 }),
    node({ key: 'curated:ex2', title: 'US and Iran Exchange Strikes', source: 'AP', priority: 79 }),
  ];
  const singleDirNodes = [
    node({ key: 'curated:sd1', title: 'US strikes Iran for the fifth time as conflict escalates', source: 'DW', priority: 75 }),
    node({ key: 'curated:sd2', title: 'US strikes Iran military sites overnight', source: 'BBC', priority: 74 }),
  ];
  const allNodes = [...exchangeNodes, ...singleDirNodes];
  const nodeByKey = new Map(allNodes.map(n => [n.key, n]));

  const exchangeKeys = exchangeNodes.map(n => n.key);
  const singleDirKeys = singleDirNodes.map(n => n.key);
  const coherentGroupKeys = [exchangeKeys, singleDirKeys];

  // The single-direction headline must NOT be exchange-framed
  check(
    '(b) single-direction headline is NOT exchange-framed',
    !isMutualExchangeFraming(singleDirNodes[0].title),
  );

  const mustLinks = simulateExchangeLane(coherentGroupKeys, nodeByKey);
  check(
    '(b) exchange lane emits NO must-link (direction split preserved)',
    mustLinks.length === 0,
    `mustLinks=${JSON.stringify(mustLinks)}`,
  );
}

// ===========================================================================
// (c) NEGATIVE: two exchanges of DIFFERENT actor pairs → stays separate
// ===========================================================================
{
  const usIranNodes = [
    node({ key: 'curated:ui1', title: 'US and Iran exchange strikes across Gulf region', source: 'Reuters', priority: 80 }),
    node({ key: 'curated:ui2', title: 'Iran and US trade strikes as tensions escalate', source: 'AP', priority: 79 }),
  ];
  const ruUkrNodes = [
    node({ key: 'curated:ru1', title: 'Russia and Ukraine trade strikes along Kharkiv front', source: 'DW', priority: 75 }),
    node({ key: 'curated:ru2', title: 'Ukraine and Russia exchange fire near Kharkiv', source: 'BBC', priority: 74 }),
  ];
  const allNodes = [...usIranNodes, ...ruUkrNodes];
  const nodeByKey = new Map(allNodes.map(n => [n.key, n]));

  const usIranKeys = usIranNodes.map(n => n.key);
  const ruUkrKeys = ruUkrNodes.map(n => n.key);
  const coherentGroupKeys = [usIranKeys, ruUkrKeys];

  // Both are exchange-framed but different pairs
  check(
    '(c) US-Iran cluster rep is exchange-framed',
    isMutualExchangeFraming(usIranNodes[0].title),
  );
  check(
    '(c) Russia-Ukraine cluster rep is exchange-framed',
    isMutualExchangeFraming(ruUkrNodes[0].title),
  );

  const pairUI = extractActorPair(usIranNodes[0].title);
  const pairRU = extractActorPair(ruUkrNodes[0].title);
  check(
    '(c) the two clusters have DIFFERENT actor pairs',
    pairUI !== null && pairRU !== null && pairUI.join('|') !== pairRU.join('|'),
    `pairUI=${JSON.stringify(pairUI)} pairRU=${JSON.stringify(pairRU)}`,
  );

  const mustLinks = simulateExchangeLane(coherentGroupKeys, nodeByKey);
  check(
    '(c) exchange lane emits NO must-link (different actor pairs)',
    mustLinks.length === 0,
    `mustLinks=${JSON.stringify(mustLinks)}`,
  );
}

// ===========================================================================
// (d) NEGATIVE: exchange pair outside same-event time window → stays separate
// ===========================================================================
{
  const earlyNodes = [
    node({
      key: 'curated:ea1',
      title: 'US and Iran exchange strikes across Gulf region',
      source: 'Reuters',
      priority: 80,
      publishedAt: new Date(NOW.getTime() - 25 * HOUR), // 25h ago
    }),
    node({
      key: 'curated:ea2',
      title: 'Iran and US trade fire in Gulf standoff',
      source: 'AP',
      priority: 79,
      publishedAt: new Date(NOW.getTime() - 25 * HOUR),
    }),
  ];
  const laterNodes = [
    node({
      key: 'curated:la1',
      title: 'Iran and US exchange strikes across Gulf region, oil prices rise',
      source: 'DW',
      priority: 75,
      publishedAt: NOW, // now — 25h gap from earlyNodes
    }),
    node({
      key: 'curated:la2',
      title: 'US and Iran trade rockets in renewed Gulf exchange',
      source: 'BBC',
      priority: 74,
      publishedAt: NOW,
    }),
  ];
  const allNodes = [...earlyNodes, ...laterNodes];
  const nodeByKey = new Map(allNodes.map(n => [n.key, n]));

  const earlyKeys = earlyNodes.map(n => n.key);
  const laterKeys = laterNodes.map(n => n.key);
  const coherentGroupKeys = [earlyKeys, laterKeys];

  check(
    '(d) both clusters are exchange-framed',
    isMutualExchangeFraming(earlyNodes[0].title) && isMutualExchangeFraming(laterNodes[0].title),
  );
  check(
    '(d) both clusters have same actor pair (Iran|US)',
    (() => {
      const p1 = extractActorPair(earlyNodes[0].title);
      const p2 = extractActorPair(laterNodes[0].title);
      return p1 !== null && p2 !== null && p1.join('|') === p2.join('|');
    })(),
  );
  check(
    '(d) the two cluster reps are OUTSIDE the same-event window (25h apart)',
    !withinSameEventWindow(earlyNodes[0].publishedAt, laterNodes[0].publishedAt),
  );

  const mustLinks = simulateExchangeLane(coherentGroupKeys, nodeByKey);
  check(
    '(d) exchange lane emits NO must-link (outside same-event window)',
    mustLinks.length === 0,
    `mustLinks=${JSON.stringify(mustLinks)}`,
  );
}

// ===========================================================================
if (failures > 0) {
  console.error(`\n[exchange-merge] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[exchange-merge] all checks passed');
process.exit(0);
