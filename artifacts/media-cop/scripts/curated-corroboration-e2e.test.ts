/**
 * End-to-end corroboration regression (Task #604): prove that two INDEPENDENT
 * outlets covering the SAME event travel the full curated path
 *
 *     INGEST ADMIT  ->  CANDIDACY  ->  CLUSTERING  ->  FORMATION
 *
 * and land in ONE formed Curated Top Story with sourceCount >= 2 — a single
 * corroborated card, NOT two near-dupe standalone cards. The prior tests each
 * pinned ONE stage in isolation:
 *   - curated-ingest-dedup.test.ts   -> the ADMIT/collapse decision only.
 *   - curated-identical-title-merge.test.ts -> the deterministic must-link only.
 * Neither wired the stages together to assert the downstream story actually FORMS
 * with a real distinct-publisher sourceCount, and the load-bearing formation gate
 * lived inline inside clusterCuratedLane (untestable). This test composes the real
 * exported functions across every stage and pins the formed-story guarantee.
 *
 * Deterministic by construction — no live AI, DB, or network:
 *   - ADMIT uses isSameArticleDuplicate (pure).
 *   - CANDIDACY uses selectCandidateNodes (pure).
 *   - CLUSTERING: the byte-identical case rides the deterministic must-link
 *     (buildIdenticalTitleMustLinkGroups + reconcileMustLinkGroups) so it holds
 *     even when the LLM SPLITS the twins; the genuinely-fuzzy case SIMULATES the
 *     LLM's grouping decision (a real production LLM would group them) and pins the
 *     DOWNSTREAM formation, which is the deterministic part.
 *   - FORMATION uses evaluateFormation — the exact pure gate clusterCuratedLane now
 *     applies inline, so this test and production can never drift.
 *
 * Run directly with tsx (no test framework configured):
 *   npx tsx scripts/curated-corroboration-e2e.test.ts
 * Exits non-zero on any failure.
 */
import {
  isSameArticleDuplicate,
  type SimilarCuratedRef,
} from '../server/curatedIngest';
import {
  evaluateFormation,
  buildIdenticalTitleMustLinkGroups,
  reconcileMustLinkGroups,
  selectCandidateNodes,
  type LaneNode,
  type ClusterGroup,
} from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[corroboration-e2e] OK   ${name}`);
  } else {
    console.error(`[corroboration-e2e] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// Same fixture shape as curated-identical-title-merge.test.ts. Deliberately omits
// normalizedTitle so deterministicTitleKey exercises its normalizeTitle fallback.
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

const NOW = new Date('2026-06-30T12:00:00Z');

// ===========================================================================
// SCENARIO A — genuinely FUZZY near-dupe from two independent trusted outlets.
// This is the exact Task #602 case: near-identical (NOT byte-identical) wording.
// The path: both ADMIT at ingest -> both co-enter candidacy -> the LLM groups
// them (simulated) -> formation forms ONE story with sourceCount 2.
// ===========================================================================
{
  const REUTERS = {
    key: 'curated:reuters-iran',
    title: 'Iran and US nuclear talks collapse after final round in Geneva',
    source: 'Reuters',
    url: 'https://www.reuters.com/world/middle-east/iran-us-nuclear-talks-collapse-2026-06-30',
  };
  const AP = {
    key: 'curated:ap-iran',
    // Near-identical meaning, DIFFERENT wording — not a byte-identical must-link.
    title: 'US-Iran nuclear negotiations break down in final Geneva round',
    source: 'Associated Press',
    url: 'https://apnews.com/article/iran-us-nuclear-talks-geneva-9f2c1',
  };

  // --- STAGE 1: INGEST ADMIT. AP arriving against a stored Reuters near-dupe is
  //     a DIFFERENT outlet at a DIFFERENT URL -> ADMIT (kept as a separate node).
  const admitStored: SimilarCuratedRef[] = [{ url: REUTERS.url, source: REUTERS.source }];
  check(
    'A1 independent-outlet fuzzy near-dupe is ADMITTED at ingest (not dropped)',
    isSameArticleDuplicate(AP.url, AP.source, admitStored) === false,
  );

  // --- STAGE 2: CANDIDACY. Both admitted nodes must co-enter the clustering
  //     payload or the formation gate would never see them together.
  const reutersNode = node({ ...REUTERS, priority: 71, cls: 'corroborating', publishedAt: NOW });
  const apNode = node({ ...AP, priority: 70, cls: 'corroborating', publishedAt: NOW });
  const selection = selectCandidateNodes([reutersNode, apNode], new Set(), new Set());
  const selectedKeys = new Set(selection.allNodes.map(n => n.key));
  check(
    'A2 both independent near-dupes co-enter the clustering payload',
    selectedKeys.has(REUTERS.key) && selectedKeys.has(AP.key),
    `reuters=${selectedKeys.has(REUTERS.key)} ap=${selectedKeys.has(AP.key)}`,
  );

  // --- STAGE 3: CLUSTERING. A real production LLM groups these near-identical
  //     headlines together. We SIMULATE that grouping decision (the only
  //     non-deterministic stage) and pin the DETERMINISTIC downstream formation.
  const llmGroups: ClusterGroup[] = [{ keys: [REUTERS.key, AP.key] }];

  // --- STAGE 4: FORMATION. The grouped near-dupes form ONE story from 2 distinct
  //     publishers -> sourceCount 2 (a corroborated card, not two standalones).
  const groupNodes = llmGroups[0].keys
    .map(k => (k === REUTERS.key ? reutersNode : apNode));
  const formed = evaluateFormation(groupNodes);
  check(
    'A4 the two independent near-dupes FORM one story',
    formed.forms === true,
    JSON.stringify(formed),
  );
  check(
    'A4 the formed story has sourceCount >= 2 (corroborated, not a single card)',
    formed.sourceCount >= 2,
    `sourceCount=${formed.sourceCount}`,
  );
  check(
    'A4 exactly ONE cluster holds BOTH outlets (not two near-dupe cards)',
    llmGroups.length === 1 &&
      new Set(llmGroups[0].keys).size === 2 &&
      llmGroups[0].keys.includes(REUTERS.key) &&
      llmGroups[0].keys.includes(AP.key),
  );
}

// ===========================================================================
// SCENARIO B — BYTE-IDENTICAL syndicated headline across two distinct outlets.
// Here the guarantee is FULLY deterministic (no LLM needed): even if the LLM
// SPLITS the twins across two groups, the must-link forces them back into one,
// and formation yields sourceCount 2.
// ===========================================================================
{
  const SYNDICATED = 'China unveils new long-range air-to-air missile in Pacific drill';
  const DN = {
    key: 'curated:dn',
    title: SYNDICATED,
    source: 'Defense News',
    url: 'https://www.defensenews.com/air/2026/06/30/china-aam',
  };
  const MT = {
    key: 'curated:mt',
    title: SYNDICATED, // byte-identical wire pickup
    source: 'Military Times',
    url: 'https://www.militarytimes.com/news/2026/06/30/china-aam',
  };

  // ADMIT: distinct outlet, distinct URL -> kept as separate nodes.
  check(
    'B1 byte-identical syndicated twin from a distinct outlet is ADMITTED',
    isSameArticleDuplicate(MT.url, MT.source, [{ url: DN.url, source: DN.source }]) === false,
  );

  const dnNode = node({ ...DN, priority: 68, cls: 'corroborating', publishedAt: NOW });
  const mtNode = node({ ...MT, priority: 68, cls: 'corroborating', publishedAt: NOW });

  // CLUSTERING (adversarial): the LLM SPLITS the byte-identical twins apart.
  const splitByLlm: ClusterGroup[] = [{ keys: [DN.key] }, { keys: [MT.key] }];
  const mustLinks = buildIdenticalTitleMustLinkGroups([dnNode, mtNode]).map(g => g.map(n => n.key));
  check(
    'B2 byte-identical twins produce exactly ONE must-link group of 2',
    mustLinks.length === 1 && mustLinks[0].length === 2,
    `groups=${mustLinks.length}`,
  );
  const reconciled = reconcileMustLinkGroups(splitByLlm, mustLinks);
  const merged = reconciled.find(g => g.keys.includes(DN.key));
  check(
    'B3 must-link reconciles the LLM split back into ONE group',
    reconciled.length === 1 && !!merged && new Set(merged!.keys).size === 2 && merged!.keys.includes(MT.key),
    `reconciled=${JSON.stringify(reconciled)}`,
  );

  // FORMATION: the reconciled group forms with sourceCount 2.
  const formed = evaluateFormation([dnNode, mtNode]);
  check(
    'B4 the reconciled syndicated twins FORM one story with sourceCount >= 2',
    formed.forms === true && formed.sourceCount >= 2,
    JSON.stringify(formed),
  );
}

// ===========================================================================
// SCENARIO C — the NEGATIVE guards: same-outlet re-emit and same-URL tracking
// variant must COLLAPSE at ingest, so a single outlet can never masquerade as
// two corroborating sources.
// ===========================================================================
{
  // Same outlet re-emitting via a different section URL -> DUP at ingest.
  check(
    'C1 same-outlet re-emit COLLAPSES at ingest (no fake 2nd source)',
    isSameArticleDuplicate(
      'https://www.reuters.com/markets/iran-nuclear-talks-collapse',
      'Reuters',
      [{ url: 'https://www.reuters.com/world/iran-nuclear-talks-collapse', source: 'Reuters' }],
    ) === true,
  );

  // Same link, tracking-param variant (URL identity match) -> DUP at ingest.
  check(
    'C2 same-URL tracking variant COLLAPSES at ingest (URL identity)',
    isSameArticleDuplicate(
      'https://www.bbc.com/news/world-iran-talks?at_medium=RSS&at_campaign=rss',
      'BBC News',
      [{ url: 'https://www.bbc.com/news/world-iran-talks', source: 'BBC' }],
    ) === true,
  );

  // Defense-in-depth: even if two SAME-outlet clones somehow reached clustering
  // (URL dedup missed them), the formation gate refuses to inflate sourceCount —
  // one publisher is one source, so the group does NOT form.
  const cloneA = node({
    key: 'curated:reuters-a',
    title: 'Iran and US nuclear talks collapse after final round in Geneva',
    priority: 71,
    cls: 'corroborating',
    source: 'Reuters',
    url: 'https://www.reuters.com/world/iran-talks?a=1',
    publishedAt: NOW,
  });
  const cloneB = node({
    key: 'curated:reuters-b',
    title: 'Iran and US nuclear talks collapse after final round in Geneva',
    priority: 71,
    cls: 'corroborating',
    source: 'Reuters',
    url: 'https://www.reuters.com/world/iran-talks?a=2',
    publishedAt: NOW,
  });
  const formed = evaluateFormation([cloneA, cloneB]);
  check(
    'C3 two SAME-outlet clones do NOT form a story (sourceCount stays 1)',
    formed.forms === false && formed.sourceCount === 1,
    JSON.stringify(formed),
  );

  // A single corroborating outlet + an attach-only second copy is also NOT a
  // 2-source story: attach items carry no formation weight.
  const corr = node({
    key: 'curated:corr',
    title: 'US-Iran nuclear negotiations break down in final Geneva round',
    priority: 70,
    cls: 'corroborating',
    source: 'Associated Press',
    url: 'https://apnews.com/article/iran-talks-x',
    publishedAt: NOW,
  });
  const attach = node({
    key: 'curated:attach',
    title: 'Iran nuclear talks: what happens next',
    priority: 55,
    cls: 'attach-only',
    source: 'Some Blog',
    url: 'https://blog.example.com/iran-talks',
    publishedAt: NOW,
  });
  const formedAttach = evaluateFormation([corr, attach]);
  check(
    'C4 one corroborating + one attach-only does NOT form (attach has no weight)',
    formedAttach.forms === false,
    JSON.stringify(formedAttach),
  );
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n[corroboration-e2e] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[corroboration-e2e] all checks passed');
process.exit(0);
