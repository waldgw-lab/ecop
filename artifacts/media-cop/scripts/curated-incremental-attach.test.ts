/**
 * Curated incremental-attach bridge regression (Task #439).
 *
 * The bridge folds a freshly-arrived STANDALONE item into an already-formed
 * curated cluster BETWEEN the ~5-min wipe-and-rebuild clustering passes, so a
 * single-source card that clearly belongs to a Top Story doesn't sit alone until
 * the next pass. This pins the PURE, deterministic matching core (no DB / no LLM
 * / no network): buildAttachClusters + selectAttachClusterId.
 *
 * Invariants:
 *   (1) buildAttachClusters only returns FORMED clusters (>= 2 contributing
 *       members); a 1-contributing(+attach) cluster is never an attach target.
 *   (2) A candidate that strictly matches EXACTLY ONE cluster folds into it.
 *   (3) An off-topic candidate matches nothing -> null (never invents a join).
 *   (4) An AMBIGUOUS candidate (matches >= 2 clusters) -> null (left for the
 *       authoritative full pass; never arbitrarily assigned).
 *   (5) Category veto — a known-but-different category blocks a token match.
 *   (6) A < 2-token candidate is unmatchable -> null (fail closed).
 *   (7) Time window — a same-wording candidate OUTSIDE the same-event window
 *       (different news cycle) does not attach.
 *   (8) Match via >= 2 contributing MEMBERS (not the representative) attaches;
 *       a single-member overlap alone does not.
 *
 * Exits non-zero on any violation.  Usage:  tsx scripts/curated-incremental-attach.test.ts
 */
import {
  selectAttachClusterId,
  selectManualLinkWidenedClusterId,
  buildAttachClusters,
  isAdversaryNewsContrast,
  type AttachCandidate,
} from '../server/curatedIncrementalAttach';
import { significantTitleTokens, SAME_EVENT_WINDOW_HOURS } from '../server/curatedCluster';
import type { CuratedClusterMember } from '@shared/schema';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[attach] OK   ${name}`);
  } else {
    console.error(`[attach] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const HOUR = 3_600_000;
type MemberRow = Pick<
  CuratedClusterMember,
  'clusterId' | 'behaviorClass' | 'title' | 'category' | 'publishedAt' | 'isRepresentative'
>;
function member(opts: {
  clusterId: string;
  title: string;
  behaviorClass?: string;
  category?: string | null;
  ageH?: number;
  rep?: boolean;
}): MemberRow {
  return {
    clusterId: opts.clusterId,
    behaviorClass: opts.behaviorClass ?? 'corroborating',
    title: opts.title,
    category: opts.category ?? null,
    publishedAt: new Date(Date.now() - (opts.ageH ?? 1) * HOUR),
    isRepresentative: opts.rep ?? false,
  };
}
function candidate(opts: {
  title: string;
  category?: string | null;
  ageH?: number;
}): AttachCandidate {
  return {
    key: `main:${Math.random().toString(36).slice(2)}`,
    tokens: significantTitleTokens(opts.title),
    publishedAt: new Date(Date.now() - (opts.ageH ?? 1) * HOUR),
    category: opts.category ?? null,
  };
}

// ===========================================================================
// (1) buildAttachClusters returns ONLY formed (>= 2 contributing) clusters.
// ===========================================================================
{
  const members: MemberRow[] = [
    // Formed: 3 corroborating publishers.
    member({ clusterId: 'c1', title: 'IAEA inspectors return to Natanz enrichment site', category: 'Security', rep: true }),
    member({ clusterId: 'c1', title: 'IAEA inspection team granted access under deal', category: 'Security' }),
    member({ clusterId: 'c1', title: 'Inspectors verify Natanz centrifuge cascade', category: 'Security' }),
    // NOT formed: 1 corroborating + 1 attach-only social post.
    member({ clusterId: 'c2', title: 'Carrier strike group transits Strait of Hormuz', category: 'Security', rep: true }),
    member({ clusterId: 'c2', title: 'POTUS posts about the carrier deployment', behaviorClass: 'attach', category: 'Security' }),
  ];
  const clusters = buildAttachClusters(members);
  check('(1) only the formed cluster is an attach target', clusters.length === 1 && clusters[0].clusterId === 'c1', `got ${clusters.map((c) => c.clusterId).join(',')}`);
  check('(1) formed cluster reports its contributing count', clusters[0]?.contributingCount === 3, String(clusters[0]?.contributingCount));
  check('(1) formed cluster carries dominant known category', clusters[0]?.category === 'security', String(clusters[0]?.category));
}

// Shared fixture for the matching tests: two distinct formed clusters.
function twoClusters() {
  const members: MemberRow[] = [
    // Cluster IAEA.
    member({ clusterId: 'iaea', title: 'IAEA inspectors return to Natanz enrichment site', category: 'Security', rep: true }),
    member({ clusterId: 'iaea', title: 'IAEA inspection team granted access under deal', category: 'Security' }),
    member({ clusterId: 'iaea', title: 'Inspectors verify Natanz centrifuge cascade levels', category: 'Security' }),
    // Cluster Pacific (clearly different event).
    member({ clusterId: 'pac', title: 'Taiwan reports record incursion of warplanes near strait', category: 'Security', rep: true }),
    member({ clusterId: 'pac', title: 'Taiwan scrambles jets after warplane incursion', category: 'Security' }),
    member({ clusterId: 'pac', title: 'Beijing warplanes cross Taiwan strait median line', category: 'Security' }),
  ];
  return buildAttachClusters(members);
}

// ===========================================================================
// (2) Single strict match folds in.
// ===========================================================================
{
  const clusters = twoClusters();
  const cand = candidate({ title: 'IAEA inspectors expand Natanz inspection rounds', category: 'Security' });
  check('(2) candidate folds into the one matching cluster', selectAttachClusterId(cand, clusters) === 'iaea', String(selectAttachClusterId(cand, clusters)));
}

// ===========================================================================
// (3) Off-topic candidate matches nothing.
// ===========================================================================
{
  const clusters = twoClusters();
  const cand = candidate({ title: 'Stock markets rally on technology earnings beat', category: 'Economy' });
  check('(3) off-topic candidate attaches to nothing', selectAttachClusterId(cand, clusters) === null);
}

// ===========================================================================
// (4) Ambiguous candidate (matches BOTH clusters) -> null.
// ===========================================================================
{
  // Two formed clusters that share heavy wording (same actor, same day) so a
  // generic candidate plausibly matches both -> must refuse rather than guess.
  const members: MemberRow[] = [
    member({ clusterId: 'a', title: 'Iran nuclear talks resume in Geneva session', category: 'Security', rep: true }),
    member({ clusterId: 'a', title: 'Iran nuclear talks open with Geneva session', category: 'Security' }),
    member({ clusterId: 'b', title: 'Iran nuclear talks stall over Geneva session terms', category: 'Security', rep: true }),
    member({ clusterId: 'b', title: 'Iran nuclear talks Geneva session ends without deal', category: 'Security' }),
  ];
  const clusters = buildAttachClusters(members);
  const cand = candidate({ title: 'Iran nuclear talks Geneva session update', category: 'Security' });
  const matchesBoth = clusters.length === 2;
  check('(4) ambiguous candidate refuses to attach (null)', matchesBoth && selectAttachClusterId(cand, clusters) === null);
}

// ===========================================================================
// (5) Category veto blocks an otherwise-token match.
// ===========================================================================
{
  const clusters = twoClusters(); // IAEA cluster is category Security
  const cand = candidate({ title: 'IAEA inspectors expand Natanz inspection rounds', category: 'Economy' });
  check('(5) known-but-different category vetoes the match', selectAttachClusterId(cand, clusters) === null);
  // ...but an UNKNOWN candidate category does not veto.
  const candUnknown = candidate({ title: 'IAEA inspectors expand Natanz inspection rounds', category: 'general' });
  check('(5) generic/unknown category does NOT veto', selectAttachClusterId(candUnknown, clusters) === 'iaea');
}

// ===========================================================================
// (6) Too-few-token candidate is unmatchable.
// ===========================================================================
{
  const clusters = twoClusters();
  const cand = candidate({ title: 'IAEA', category: 'Security' });
  check('(6) < 2-token candidate is fail-closed null', cand.tokens.size < 2 && selectAttachClusterId(cand, clusters) === null);
}

// ===========================================================================
// (7) Time window — same wording, different cycle, does not attach.
// ===========================================================================
{
  const clusters = twoClusters(); // members are ~1h old
  const cand = candidate({
    title: 'IAEA inspectors expand Natanz inspection rounds',
    category: 'Security',
    ageH: SAME_EVENT_WINDOW_HOURS + 6, // well outside the same-event window
  });
  check('(7) out-of-window same-wording candidate does not attach', selectAttachClusterId(cand, clusters) === null);
}

// ===========================================================================
// (8) Match via >= 2 contributing MEMBERS (rep deliberately off-topic).
// ===========================================================================
{
  // Representative headline is worded so it does NOT token-match the candidate,
  // forcing the match to come from >= 2 NON-representative contributing members.
  const members: MemberRow[] = [
    member({ clusterId: 'd', title: 'Deadline looms as parties weigh next move', category: 'Security', rep: true }),
    member({ clusterId: 'd', title: 'IAEA inspectors return to Natanz enrichment site', category: 'Security' }),
    member({ clusterId: 'd', title: 'IAEA inspection team granted Natanz access', category: 'Security' }),
  ];
  const clusters = buildAttachClusters(members);
  const cand = candidate({ title: 'IAEA inspectors expand Natanz inspection rounds', category: 'Security' });
  check('(8) match via >= 2 contributing members attaches', selectAttachClusterId(cand, clusters) === 'd', String(selectAttachClusterId(cand, clusters)));

  // A single-member-only overlap must NOT attach (needs >= 2 when rep misses).
  const membersSingle: MemberRow[] = [
    member({ clusterId: 'e', title: 'Deadline looms as parties weigh next move', category: 'Security', rep: true }),
    member({ clusterId: 'e', title: 'IAEA inspectors return to Natanz enrichment site', category: 'Security' }),
    member({ clusterId: 'e', title: 'Senate budget vote slips to next week amid standoff', category: 'Security' }),
  ];
  const clustersSingle = buildAttachClusters(membersSingle);
  const candSingle = candidate({ title: 'IAEA inspectors expand Natanz inspection rounds', category: 'Security' });
  check('(8) single-member overlap alone does NOT attach', selectAttachClusterId(candSingle, clustersSingle) === null);
}

// ===========================================================================
// (9) Adversary STATE-MEDIA contrast members never count toward formation.
//     The bridge may fold contrast into an ALREADY-formed story, but contrast
//     (behaviorClass 'anchor-only') must never make a cluster a target on its
//     own, nor inflate the contributing total of one that is.
// ===========================================================================
{
  // 1 corroborating + 1 anchor-only contrast => NOT formed (not a target).
  const notFormed: MemberRow[] = [
    member({ clusterId: 'x', title: 'IAEA inspectors return to Natanz enrichment site', category: 'Security', rep: true }),
    member({ clusterId: 'x', title: 'RT claims Natanz inspection is Western theatre', behaviorClass: 'anchor-only', category: 'Security' }),
  ];
  const cl1 = buildAttachClusters(notFormed);
  check('(9) 1 contributing + contrast is NOT an attach target', cl1.length === 0, `got ${cl1.length}`);

  // 2 corroborating + 1 anchor-only contrast => formed, count stays 2.
  const formed: MemberRow[] = [
    member({ clusterId: 'y', title: 'IAEA inspectors return to Natanz enrichment site', category: 'Security', rep: true }),
    member({ clusterId: 'y', title: 'IAEA inspection team granted access under deal', category: 'Security' }),
    member({ clusterId: 'y', title: 'RT claims Natanz inspection is Western theatre', behaviorClass: 'anchor-only', category: 'Security' }),
  ];
  const cl2 = buildAttachClusters(formed);
  check('(9) contrast does NOT inflate contributing count', cl2.length === 1 && cl2[0].contributingCount === 2, String(cl2[0]?.contributingCount));
}

// ===========================================================================
// (10) isAdversaryNewsContrast — only NON-social CPC NEWS contrast qualifies.
// ===========================================================================
{
  const C = { role: 'anchor-only', label: 'contrast' } as const;
  check('(10) news-cpc contrast qualifies', isAdversaryNewsContrast(C, { sourceIdentifier: 'news-cpc' }) === true);
  check('(10) social-cpc contrast does NOT qualify', isAdversaryNewsContrast(C, { sourceIdentifier: 'social-cpc' }) === false);
  check('(10) non-CPC mixed-factuality contrast does NOT qualify', isAdversaryNewsContrast(C, { sourceIdentifier: 'news-major' }) === false);
  check('(10) contributing (label null) does NOT qualify', isAdversaryNewsContrast({ role: 'contributing', label: null }, { sourceIdentifier: 'news-cpc' }) === false);
  check('(10) anchor-primary release does NOT qualify', isAdversaryNewsContrast({ role: 'anchor-only', label: 'primary' }, { sourceIdentifier: 'release-cpc' }) === false);
  check('(10) missing outlet does NOT qualify', isAdversaryNewsContrast(C, null) === false);
}

// ===========================================================================
// (11) Manual-link widening still observes category veto and ambiguity.
// ===========================================================================
{
  const clusters = twoClusters();
  const cand = candidate({ title: 'IAEA inspectors expand Natanz inspection rounds', category: 'Security' });
  const widened = new Map([
    ['iaea', [{ tokens: significantTitleTokens('IAEA inspectors return to Natanz enrichment site'), publishedAt: cand.publishedAt }]],
  ]);
  check('(11) one compatible manual-link widened target attaches', selectManualLinkWidenedClusterId(cand, clusters, widened) === 'iaea');
  widened.set('pac', [{ tokens: significantTitleTokens('IAEA inspectors return to Natanz enrichment site'), publishedAt: cand.publishedAt }]);
  check('(11) two widened targets remain unattached (no iteration-order pick)', selectManualLinkWidenedClusterId(cand, clusters, widened) === null);
  const wrongCategory = candidate({ title: 'IAEA inspectors expand Natanz inspection rounds', category: 'Economy' });
  check('(11) widened matching respects the known-category veto', selectManualLinkWidenedClusterId(wrongCategory, clusters, new Map([
    ['iaea', [{ tokens: significantTitleTokens('IAEA inspectors return to Natanz enrichment site'), publishedAt: wrongCategory.publishedAt }]],
  ])) === null);
}

console.log(`\n[attach] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
