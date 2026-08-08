/**
 * Unified same-event consolidation regression gate.
 *
 * Pins `buildSameEventMergeComponents` — the ONE union-find lane that replaced
 * the three former partial missed-merge mechanisms (body-aware fuzzy standalone
 * lane #747, cross-cluster rep-vs-rep lane #752, one-merge-per-pass backstop
 * #1085). The motivating prod failure (2026-07-22): the US-Saudi nuclear deal —
 * one evolving event whose coverage phase-shifted from "announces pact" ->
 * "signs deal" -> "approves deal" — fragmented into SIX curated clusters.
 *
 * Fixture titles below are the REAL prod titles from that fragmentation.
 *
 * Asserts:
 *   A — the 3 phase-fragment groups union into ONE component (all keys).
 *   B — the Israel-reaction group and the Explainer group stay SEPARATE
 *       (legitimate distinct angles; title-only group evidence keeps them out).
 *   C — group<->group merging requires >= 2 INDEPENDENT links (a single
 *       coincidental member pair never merges two formed groups).
 *   D — two groups resolving to the SAME split overlay never re-merge.
 *   E — a union exceeding MISSED_MERGE_RECONCILE_MAX_COMBINED is skipped.
 *   F — safety valve OFF degrades to standalone-only merging (legacy fuzzy
 *       behavior): no group-involving merges, standalone pairs still link.
 *   G — a standalone folds into a matching formable group (fold component).
 *   H — standalone-only components still require >= 2 distinct publishers.
 *   I — deterministic: shuffled input order yields identical output.
 *
 * Pure + deterministic — no live AI, DB, or network. Run directly:
 *   npx tsx scripts/curated-same-event-consolidation.test.ts
 * Exit 0 = pass, 1 = fail.
 */
import {
  buildSameEventMergeComponents,
  MISSED_MERGE_RECONCILE_MAX_COMBINED,
  type LaneNode,
  type ClusterGroup,
} from '../server/curatedCluster';
import type { CuratedProcessSplitOverlay } from '../shared/schema';
import { memberSignatureToken } from '../server/curatedSynthesis';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[same-event-consolidation] OK   ${name}`);
  } else {
    console.error(`[same-event-consolidation] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const NOW = new Date('2026-07-22T12:00:00Z');

function node(
  partial: Partial<LaneNode> & { key: string; title: string; url: string },
): LaneNode {
  const cls: LaneNode['cls'] = partial.cls ?? 'corroborating';
  return {
    itemType: 'curated',
    itemId: partial.key.split(':')[1] ?? partial.key,
    source: partial.source ?? 'Test Wire',
    category: 'general',
    label: null,
    cls,
    role: cls === 'corroborating' ? 'contributing' : 'attach-only',
    blocked: false,
    priority: 70,
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

// ===========================================================================
// REAL prod fixture (2026-07-22 US-Saudi nuclear deal, 6-way fragmentation).
// ===========================================================================
const signs = [
  node({ key: 'c:guardian-signs', title: 'US signs landmark nuclear deal with Saudi Arabia', source: 'The Guardian', url: 'https://www.theguardian.com/us-saudi-signs' }),
  node({ key: 'c:reuters-reaches', title: 'US says it reaches nuclear power deal with Saudi Arabia', source: 'Reuters', url: 'https://www.reuters.com/us-saudi-reaches' }),
  node({ key: 'c:almonitor-reaches', title: 'US says it reaches nuclear power deal with Saudi Arabia', source: 'Al-Monitor', url: 'https://www.al-monitor.com/us-saudi-reaches' }),
  node({ key: 'c:straits-reaches', title: 'US says it reaches nuclear power deal with Saudi Arabia', source: 'Straits Times', url: 'https://www.straitstimes.com/us-saudi-reaches' }),
  node({ key: 'c:politico-export', title: 'Trump administration announces deal to export nuclear materials to Saudi Arabia', source: 'Politico', url: 'https://www.politico.com/us-saudi-export' }),
  node({ key: 'c:aljazeera-coop', title: 'US and Saudi Arabia announce nuclear cooperation deal', source: 'Al Jazeera', url: 'https://www.aljazeera.com/us-saudi-coop' }),
];
const approves = [
  node({ key: 'c:nbc-approves', title: 'Trump approves landmark U.S.-Saudi nuclear deal', source: 'NBC News', url: 'https://www.nbcnews.com/us-saudi-approves' }),
  node({ key: 'c:cnn-approves', title: 'Trump approves deal with Saudi Arabia that could allow kingdom to enrich nuclear fuel', source: 'CNN', url: 'https://www.cnn.com/us-saudi-approves' }),
  node({ key: 'c:npr-signs', title: 'Trump administration signs commercial nuclear deal with Saudi Arabia', source: 'NPR', url: 'https://www.npr.org/us-saudi-signs' }),
  node({ key: 'c:usatoday-path', title: 'U.S. nuclear deal with Saudis includes path to enriching fuel', source: 'USA Today', url: 'https://www.usatoday.com/us-saudi-path' }),
];
const announcePact = [
  node({ key: 'c:france24-pact', title: 'US announces nuclear cooperation pact with Saudi Arabia', source: 'France 24', url: 'https://www.france24.com/us-saudi-pact' }),
  node({ key: 'c:lemonde-pact', title: 'US announces nuclear cooperation pact with Saudi Arabia', source: 'Le Monde', url: 'https://www.lemonde.fr/us-saudi-pact' }),
  node({ key: 'c:hindu-civilian', title: 'U.S. announces civilian nuclear deal with Saudi Arabia', source: 'The Hindu', url: 'https://www.thehindu.com/us-saudi-civilian' }),
  node({ key: 'c:dw-historic', title: 'US and Saudi Arabia reach historic nuclear energy deal', source: 'DW', url: 'https://www.dw.com/us-saudi-historic' }),
];
const israel = [
  node({ key: 'c:newsweek-israel', title: 'Israel, the Only Middle East Nuclear Weapons Power, Fears US-Saudi Deal', source: 'Newsweek', url: 'https://www.newsweek.com/israel-fears' }),
  node({ key: 'c:toi-israel', title: 'Israeli officials warn US-Saudi deal could lead to nuclear weapons in the region', source: 'Times of Israel', url: 'https://www.timesofisrael.com/israel-warn' }),
];
const explainer = [
  node({ key: 'c:almonitor-explainer', title: 'Explainer-Why is a proposed US-Saudi nuclear pact causing alarm in Washington and the Middle East?', source: 'Al-Monitor', url: 'https://www.al-monitor.com/explainer' }),
  node({ key: 'c:straits-explainer', title: 'US, Saudi Arabia set to sign nuclear agreement: What to know', source: 'Straits Times', url: 'https://www.straitstimes.com/explainer' }),
];

const prodGroups: ClusterGroup[] = [
  { keys: signs.map(n => n.key) },
  { keys: approves.map(n => n.key) },
  { keys: announcePact.map(n => n.key) },
  { keys: israel.map(n => n.key) },
  { keys: explainer.map(n => n.key) },
];
const prodNodes = [...signs, ...approves, ...announcePact, ...israel, ...explainer];
const phaseKeys = new Set([...signs, ...approves, ...announcePact].map(n => n.key));

// ===========================================================================
// A — the 3 phase-fragment groups union into ONE component.
// B — Israel-reaction and Explainer groups stay OUT of it.
// ===========================================================================
{
  const r = buildSameEventMergeComponents({ groups: prodGroups, nodes: prodNodes });
  const phaseComponent = r.mustLinkGroups.find(g => g.includes('c:guardian-signs'));
  check(
    'A1 phase fragments form one component containing all 14 phase keys',
    !!phaseComponent && phaseComponent.length === phaseKeys.size &&
      Array.from(phaseKeys).every(k => phaseComponent!.includes(k)),
    JSON.stringify(r.mustLinkGroups),
  );
  check('A2 counted as a cross-group component', r.crossGroupComponents >= 1, JSON.stringify(r));
  const separated = [...israel, ...explainer].map(n => n.key);
  check(
    'B1 Israel + Explainer angles never enter any merge component',
    r.mustLinkGroups.every(g => g.every(k => !separated.includes(k))),
    JSON.stringify(r.mustLinkGroups),
  );
}

// ===========================================================================
// C — >= 2 independent links required for group<->group. Two groups sharing
// only ONE similar member pair (all other titles disjoint) must NOT merge.
// ===========================================================================
{
  const gA = [
    node({ key: 'c:a1', title: 'Pentagon awards hypersonic missile contract to Lockheed Martin', source: 'Reuters', url: 'https://www.reuters.com/a1' }),
    node({ key: 'c:a2', title: 'Defense Department expands hypersonic weapons program with new contract award', source: 'AP', url: 'https://apnews.com/a2' }),
  ];
  const gB = [
    node({ key: 'c:b1', title: 'Pentagon awards hypersonic missile contract to Lockheed Martin this week', source: 'CNN', url: 'https://www.cnn.com/b1' }),
    node({ key: 'c:b2', title: 'Navy destroyer transits Taiwan Strait amid rising tensions', source: 'BBC', url: 'https://www.bbc.com/b2' }),
  ];
  const r = buildSameEventMergeComponents({
    groups: [{ keys: gA.map(n => n.key) }, { keys: gB.map(n => n.key) }],
    nodes: [...gA, ...gB],
  });
  check(
    'C1 single-link group pair does NOT merge (needs >= 2 independent links)',
    r.crossGroupComponents === 0 && r.mustLinkGroups.length === 0,
    JSON.stringify(r),
  );
}

// ===========================================================================
// D — two groups covered by the SAME split overlay never re-merge, even with
// overwhelming title evidence. Overlay member tokens key on the node URL
// (memberSignatureToken), children spanning both groups.
// ===========================================================================
{
  const gA = [
    node({ key: 'c:ov-a1', title: 'Iran launches ballistic missile barrage at US base in Qatar', source: 'Reuters', url: 'https://www.reuters.com/ov-a1' }),
    node({ key: 'c:ov-a2', title: 'Iran launches ballistic missile barrage at US base in Qatar overnight', source: 'AP', url: 'https://apnews.com/ov-a2' }),
    node({ key: 'c:ov-a3', title: 'Iran launches ballistic missile barrage at US base in Qatar, Pentagon says', source: 'Fox News', url: 'https://www.foxnews.com/ov-a3' }),
    node({ key: 'c:ov-a4', title: 'Iran launches ballistic missile barrage on US base in Qatar', source: 'NPR', url: 'https://www.npr.org/ov-a4' }),
  ];
  const gB = [
    node({ key: 'c:ov-b1', title: 'Iran launches ballistic missile barrage at US base in Qatar, officials say', source: 'CNN', url: 'https://www.cnn.com/ov-b1' }),
    node({ key: 'c:ov-b2', title: 'Iran launches ballistic missile barrage targeting US base in Qatar', source: 'BBC', url: 'https://www.bbc.com/ov-b2' }),
    node({ key: 'c:ov-b3', title: 'Iran launches ballistic missile barrage against US base in Qatar', source: 'The Guardian', url: 'https://www.theguardian.com/ov-b3' }),
    node({ key: 'c:ov-b4', title: 'Iran launches ballistic missile barrage striking US base in Qatar', source: 'ABC News', url: 'https://abcnews.go.com/ov-b4' }),
  ];
  const overlay = {
    id: 'overlay-1',
    children: [
      { childKey: 'strike-day-1', memberTokens: gA.map(n => memberSignatureToken(n.url, n.key)) },
      { childKey: 'strike-day-2', memberTokens: gB.map(n => memberSignatureToken(n.url, n.key)) },
    ],
  } as unknown as CuratedProcessSplitOverlay;
  const groups = [{ keys: gA.map(n => n.key) }, { keys: gB.map(n => n.key) }];
  const nodes = [...gA, ...gB];
  const withOverlay = buildSameEventMergeComponents({ groups, nodes, overlays: [overlay] });
  const withoutOverlay = buildSameEventMergeComponents({ groups, nodes });
  check(
    'D1 sanity: without the overlay these two groups DO merge',
    withoutOverlay.crossGroupComponents === 1,
    JSON.stringify(withoutOverlay),
  );
  check(
    'D2 same split overlay blocks the re-merge',
    withOverlay.crossGroupComponents === 0 && withOverlay.mustLinkGroups.length === 0,
    JSON.stringify(withOverlay),
  );
}

// ===========================================================================
// E — megacluster guard: a union whose combined key count exceeds
// MISSED_MERGE_RECONCILE_MAX_COMBINED is skipped. Group A carries filler keys
// (not present as nodes — e.g. attach-only members) so keys.length is large
// while its corroborating evidence stays small.
// ===========================================================================
{
  const gA = [
    node({ key: 'c:mega-a1', title: 'Russia strikes Kyiv with massive drone and missile attack overnight', source: 'Reuters', url: 'https://www.reuters.com/mega-a1' }),
    node({ key: 'c:mega-a2', title: 'Russia strikes Kyiv in massive overnight drone and missile attack', source: 'AP', url: 'https://apnews.com/mega-a2' }),
  ];
  const filler = Array.from({ length: MISSED_MERGE_RECONCILE_MAX_COMBINED - 4 }, (_, i) => `c:mega-filler-${i}`);
  const gB = [
    node({ key: 'c:mega-b1', title: 'Russia strikes Kyiv with massive drone and missile attack, officials say', source: 'CNN', url: 'https://www.cnn.com/mega-b1' }),
    node({ key: 'c:mega-b2', title: 'Russia strikes Kyiv overnight in massive missile and drone attack', source: 'BBC', url: 'https://www.bbc.com/mega-b2' }),
  ];
  // A: 2 corr + filler keys => keys.length = MAX_COMBINED - 2; B: 2 keys.
  // Union = MAX_COMBINED + wait: (MAX-2) + 2 = MAX -> allowed. Add one more filler
  // to push it OVER the cap.
  const overCap = [...gA.map(n => n.key), ...filler, 'c:mega-filler-extra'];
  const r = buildSameEventMergeComponents({
    groups: [{ keys: overCap }, { keys: gB.map(n => n.key) }],
    nodes: [...gA, ...gB],
  });
  check(
    'E1 union exceeding MISSED_MERGE_RECONCILE_MAX_COMBINED is skipped',
    r.crossGroupComponents === 0 && r.mustLinkGroups.length === 0,
    JSON.stringify({ counts: r, aKeys: overCap.length }),
  );
}

// ===========================================================================
// F — safety valve OFF (allowCrossGroupMerges: false): degrades to the legacy
// standalone-only fuzzy behavior. No group-involving merges; standalone
// near-dupes from distinct publishers still link.
// ===========================================================================
{
  const s1 = node({ key: 'c:solo-1', title: 'China conducts large-scale military drills encircling Taiwan', source: 'Reuters', url: 'https://www.reuters.com/solo-1' });
  const s2 = node({ key: 'c:solo-2', title: 'China conducts large-scale military drills around Taiwan', source: 'AP', url: 'https://apnews.com/solo-2' });
  const r = buildSameEventMergeComponents({
    groups: prodGroups,
    nodes: [...prodNodes, s1, s2],
    allowCrossGroupMerges: false,
  });
  const soloComponent = r.mustLinkGroups.find(g => g.includes('c:solo-1'));
  check(
    'F1 flag OFF: no group-involving components',
    r.crossGroupComponents === 0 && r.foldComponents === 0,
    JSON.stringify(r),
  );
  check(
    'F2 flag OFF: standalone near-dupes still merge (legacy fuzzy behavior)',
    !!soloComponent && soloComponent.length === 2 && soloComponent.includes('c:solo-2') &&
      r.standaloneComponents === 1,
    JSON.stringify(r.mustLinkGroups),
  );
}

// ===========================================================================
// G — a standalone folds into a matching formable group (body-aware, 1 link).
// ===========================================================================
{
  const gA = [
    node({ key: 'c:fold-a1', title: 'North Korea test-fires intercontinental ballistic missile into Sea of Japan', source: 'Reuters', url: 'https://www.reuters.com/fold-a1' }),
    node({ key: 'c:fold-a2', title: 'North Korea test-fires intercontinental ballistic missile toward Sea of Japan', source: 'AP', url: 'https://apnews.com/fold-a2' }),
  ];
  const solo = node({ key: 'c:fold-s1', title: 'North Korea fires intercontinental ballistic missile into Sea of Japan, Seoul says', source: 'Yonhap', url: 'https://en.yna.co.kr/fold-s1' });
  const r = buildSameEventMergeComponents({
    groups: [{ keys: gA.map(n => n.key) }],
    nodes: [...gA, solo],
  });
  const comp = r.mustLinkGroups.find(g => g.includes('c:fold-s1'));
  check(
    'G1 standalone folds into the formable group (fold component)',
    !!comp && comp.length === 3 && r.foldComponents === 1 && r.crossGroupComponents === 0,
    JSON.stringify(r),
  );
}

// ===========================================================================
// H — standalone-only components still require >= 2 DISTINCT publishers.
// ===========================================================================
{
  const a = node({ key: 'c:same-pub-1', title: 'Houthi forces attack commercial tanker in Red Sea shipping lane', source: 'Reuters', url: 'https://www.reuters.com/same-pub-1' });
  const b = node({ key: 'c:same-pub-2', title: 'Houthi forces attack commercial tanker in Red Sea shipping lanes', source: 'Reuters', url: 'https://www.reuters.com/same-pub-2' });
  const r = buildSameEventMergeComponents({ groups: [], nodes: [a, b] });
  check(
    'H1 same-publisher standalone pair is NOT emitted',
    r.mustLinkGroups.length === 0 && r.standaloneComponents === 0,
    JSON.stringify(r),
  );
}

// ===========================================================================
// J — standalone-bridge guard: a standalone with body-aware edges to TWO
// groups must never transitively glue those groups together when they lack
// direct group<->group title evidence. The standalone may fold into ONE side.
// ===========================================================================
{
  const gA = [
    node({ key: 'c:br-a1', title: 'European Union imposes sweeping sanctions on Russian oil exports', source: 'Reuters', url: 'https://www.reuters.com/br-a1' }),
    node({ key: 'c:br-a2', title: 'European Union imposes sweeping sanctions targeting Russian oil exports', source: 'AP', url: 'https://apnews.com/br-a2' }),
  ];
  const gB = [
    node({ key: 'c:br-b1', title: 'Kremlin vows retaliation against Western energy restrictions', source: 'CNN', url: 'https://www.cnn.com/br-b1' }),
    node({ key: 'c:br-b2', title: 'Kremlin vows retaliation over Western energy restrictions', source: 'BBC', url: 'https://www.bbc.com/br-b2' }),
  ];
  // Bridge standalone: thin title, body vocabulary spanning BOTH groups.
  const bridge = node({
    key: 'c:br-s1',
    title: 'A widening economic confrontation',
    source: 'Politico',
    url: 'https://www.politico.com/br-s1',
    bullets: [
      'European Union imposes sweeping sanctions on Russian oil exports as Kremlin vows retaliation against Western energy restrictions',
    ],
  });
  const groups = [{ keys: gA.map(n => n.key) }, { keys: gB.map(n => n.key) }];
  const r = buildSameEventMergeComponents({ groups, nodes: [...gA, ...gB, bridge] });
  const aRoot = r.mustLinkGroups.find(g => g.includes('c:br-a1'));
  const bRoot = r.mustLinkGroups.find(g => g.includes('c:br-b1'));
  check(
    'J1 standalone bridge never unites two groups lacking direct title evidence',
    r.crossGroupComponents === 0 && !(aRoot && aRoot.includes('c:br-b1')),
    JSON.stringify(r),
  );
  check(
    'J2 the bridge standalone folds into at most ONE group',
    !(aRoot && bRoot && aRoot.includes('c:br-s1') && bRoot.includes('c:br-s1')),
    JSON.stringify(r.mustLinkGroups),
  );
}

// ===========================================================================
// I — determinism: reversed group + node order yields identical output.
// ===========================================================================
{
  const r1 = buildSameEventMergeComponents({ groups: prodGroups, nodes: prodNodes });
  const r2 = buildSameEventMergeComponents({
    groups: [...prodGroups].reverse(),
    nodes: [...prodNodes].reverse(),
  });
  check(
    'I1 output invariant under input order',
    JSON.stringify(r1) === JSON.stringify(r2),
    `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`,
  );
}

if (failures > 0) {
  console.error(`[same-event-consolidation] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('[same-event-consolidation] ALL CHECKS PASSED');
process.exit(0);
