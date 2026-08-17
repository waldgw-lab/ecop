/**
 * Decision-execution split regression (Task: merge decision-execution story
 * splits in curated view).
 *
 * Two behaviors caused same-event families to stay fragmented:
 *   (a) the event-identity prompt guidance over-applied its announcement-vs-
 *       event separation to a policy decision and its direct same-track
 *       execution; and
 *   (b) the deterministic repair nets (incremental attach + radar classify)
 *       fail-closed on the category veto when the same concrete event carries
 *       different-but-related CONTROLLED topics (Force Posture & Deployments /
 *       Military Operations & Armed Conflict / Defense Policy & Military
 *       Readiness / Foreign Policy & Diplomacy).
 *
 * This pins the fix WITHOUT loosening any precision bar. Fixtures use the real
 * persisted shape: the member/candidate `category` is a SPECIFIC free-form
 * phrase (per the classifier's 2-4-word instruction, e.g. "Korea Drills
 * Downsizing"), while the compatibility carve-out keys on the CONTROLLED
 * primary_topic resolved from the classification overlay (topicByUrl /
 * cand.primaryTopic).
 *
 * Exits non-zero on any violation. Usage: npx tsx scripts/curated-decision-execution-merge.test.ts
 */
import {
  selectAttachClusterId,
  classifyAttachCandidate,
  buildAttachClusters,
  categoriesCompatible,
  isRelatedPrimaryTopic,
  relatedCategoryFamily,
  type AttachCandidate,
} from '../server/curatedIncrementalAttach';
import {
  significantTitleTokens,
  scheduledEventPhase,
  SAME_EVENT_WINDOW_HOURS,
} from '../server/curatedCluster';
import { CURATED_EVENT_IDENTITY_GUIDANCE } from '../server/curatedEventIdentityGuidance';
import type { CuratedClusterMember } from '@shared/schema';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[dec-exec] OK   ${name}`);
  } else {
    console.error(`[dec-exec] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const HOUR = 3_600_000;
type MemberRow = Pick<
  CuratedClusterMember,
  'clusterId' | 'behaviorClass' | 'title' | 'category' | 'publishedAt' | 'isRepresentative'
> & { url?: string | null };
let urlSeq = 0;
function member(opts: {
  clusterId: string;
  title: string;
  category?: string | null;
  ageH?: number;
  rep?: boolean;
  url?: string;
}): MemberRow {
  return {
    clusterId: opts.clusterId,
    behaviorClass: 'corroborating',
    title: opts.title,
    category: opts.category ?? null,
    publishedAt: new Date(Date.now() - (opts.ageH ?? 2) * HOUR),
    isRepresentative: opts.rep ?? false,
    url: opts.url ?? `https://example.com/a${++urlSeq}`,
  };
}
function candidate(opts: {
  title: string;
  category?: string | null;
  primaryTopic?: string | null;
  ageH?: number;
}): AttachCandidate {
  return {
    key: `main:${Math.random().toString(36).slice(2)}`,
    tokens: significantTitleTokens(opts.title),
    publishedAt: new Date(Date.now() - (opts.ageH ?? 1) * HOUR),
    category: opts.category ?? null,
    primaryTopic: opts.primaryTopic ?? null,
  };
}

// The controlled topics (full stored form).
const T_POSTURE = 'Force Posture & Deployments';
const T_MILOPS = 'Military Operations & Armed Conflict';
const T_DEFPOL = 'Defense Policy & Military Readiness';
const T_DIPLO = 'Foreign Policy & Diplomacy';
const T_ECON = 'Economic Statecraft & Sanctions';

// Execution cluster: specific free-form categories, controlled topics via overlay.
function drillsCluster() {
  const members: MemberRow[] = [
    member({ clusterId: 'drills', title: 'US South Korea joint military drills begin in downsized form', category: 'Korea Drills Downsizing', rep: true, url: 'https://example.com/exec1' }),
    member({ clusterId: 'drills', title: 'Downsized US South Korea drills begin despite tensions', category: 'Korean Peninsula Exercises', url: 'https://example.com/exec2' }),
  ];
  const topicByUrl = new Map<string, string | null>([
    ['https://example.com/exec1', T_POSTURE],
    ['https://example.com/exec2', T_MILOPS],
  ]);
  return buildAttachClusters(members, topicByUrl);
}

// ===========================================================================
// (0) Controlled-topic related set + legacy free-form family fallback.
// ===========================================================================
{
  check('(0) full controlled topics in related set', [T_POSTURE, T_MILOPS, T_DEFPOL, T_DIPLO].every(isRelatedPrimaryTopic));
  check('(0) unrelated controlled topics outside set', !isRelatedPrimaryTopic(T_ECON) && !isRelatedPrimaryTopic('Global Markets & Strategic Economics') && !isRelatedPrimaryTopic('Other / Emerging') && !isRelatedPrimaryTopic(null));
  check('(0) legacy fallback recognizes explicit label terms', relatedCategoryFamily('NATO Force Posture') === 'force-posture' && relatedCategoryFamily('US Korea Foreign Policy') === 'diplomacy' && relatedCategoryFamily('Defence Policy Shift') === 'defense-policy');
  check('(0) legacy fallback rejects specific non-family phrases', relatedCategoryFamily('Korea Drills Downsizing') === null && relatedCategoryFamily('Iran Nuclear Talks') === null && relatedCategoryFamily('Labor Strikes') === null);
}

// ===========================================================================
// (0b) categoriesCompatible semantics (controlled topic is authoritative).
// ===========================================================================
{
  const c = (category: string | null, primaryTopic: string | null = null) => ({ category, primaryTopic });
  check('(0b) equal free-form categories compatible', categoriesCompatible(c('Iran Nuclear Talks'), c('Iran Nuclear Talks')));
  check('(0b) unknown/generic side compatible (no false veto)', categoriesCompatible(c(null), c('Iran Nuclear Talks')) && categoriesCompatible(c('general'), c('Iran Nuclear Talks')));
  check('(0b) related controlled-topic pair compatible despite specific categories', categoriesCompatible(c('Korea Drills Order', T_DIPLO), c('Korea Drills Downsizing', T_POSTURE)));
  check('(0b) related pair (Defense Policy vs Military Ops topics) compatible', categoriesCompatible(c('Pentagon Drills Directive', T_DEFPOL), c('Korean Peninsula Exercises', T_MILOPS)));
  check('(0b) unrelated controlled topics still veto', !categoriesCompatible(c('Korea Sanctions Package', T_ECON), c('Korea Drills Downsizing', T_POSTURE)));
  check('(0b) same unrelated topic, different categories: veto semantics unchanged', !categoriesCompatible(c('Russia Sanctions', T_ECON), c('Iran Sanctions', T_ECON)));
  check('(0b) topic missing on one side -> legacy free-form fallback decides', categoriesCompatible(c('NATO Force Posture'), c('US Korea Foreign Policy', T_DIPLO)) && !categoriesCompatible(c('Korea Drills Downsizing'), c('US Korea Foreign Policy', T_DIPLO)));
}

// ===========================================================================
// (1) The drills decision/execution family folds together despite the topic
//     split: the decision item (Diplomacy topic, specific category) attaches
//     to the execution cluster (Force Posture/Military Ops topics).
// ===========================================================================
{
  const clusters = drillsCluster();
  check('(1) execution cluster carries a controlled topic', clusters.length === 1 && clusters[0].primaryTopic !== null);
  const decision = candidate({
    title: 'Trump orders US South Korea joint drills scaled back',
    category: 'Korea Drills Order',
    primaryTopic: T_DIPLO,
  });
  check('(1) decision (Diplomacy topic) attaches to execution cluster', selectAttachClusterId(decision, clusters) === 'drills');
  const rec = classifyAttachCandidate(decision, clusters);
  check('(1) radar classify agrees (would-auto-attach)', rec.reason === 'would-auto-attach' && rec.matchedClusterId === 'drills');
  const decisionDp = candidate({
    title: 'Trump orders US South Korea joint drills scaled back',
    category: 'Pentagon Drills Directive',
    primaryTopic: T_DEFPOL,
  });
  check('(1) Defense Policy topic variant also attaches', selectAttachClusterId(decisionDp, clusters) === 'drills');
}

// ===========================================================================
// (2) Genuinely different topics still never attach — even with identical-ish
//     tokens, an unrelated controlled topic hard-vetoes.
// ===========================================================================
{
  const clusters = drillsCluster();
  const market = candidate({
    title: 'US South Korea joint drills downsized form weighs on markets',
    category: 'Korea Market Reaction',
    primaryTopic: 'Global Markets & Strategic Economics',
  });
  check('(2) unrelated topic (Global Markets) still hard-vetoes', selectAttachClusterId(market, clusters) === null);
  const econ = candidate({
    title: 'US South Korea joint military drills begin in downsized form',
    category: 'Korea Sanctions Package',
    primaryTopic: T_ECON,
  });
  check('(2) Economic Statecraft vs Force Posture still hard-vetoes', selectAttachClusterId(econ, clusters) === null);
  // No controlled topic AND a specific non-family category: legacy fallback
  // does not fire -> hard veto preserved.
  const legacyUnrelated = candidate({
    title: 'US South Korea joint military drills begin in downsized form',
    category: 'Korea Market Reaction',
  });
  check('(2) legacy row with non-family category still hard-vetoes', selectAttachClusterId(legacyUnrelated, clusters) === null);
}

// ===========================================================================
// (3) Ambiguity still fail-closes across related topics.
// ===========================================================================
{
  const members: MemberRow[] = [
    member({ clusterId: 'a', title: 'US South Korea joint drills begin downsized Pyongyang warns', category: 'Korea Drills Downsizing', rep: true, url: 'https://example.com/a1' }),
    member({ clusterId: 'a', title: 'US South Korea drills begin downsized amid warnings', category: 'Korea Drills Downsizing', url: 'https://example.com/a2' }),
    member({ clusterId: 'b', title: 'US South Korea joint drills downsized after Trump order', category: 'Korea Drills Order', rep: true, url: 'https://example.com/b1' }),
    member({ clusterId: 'b', title: 'US South Korea drills downsized following order', category: 'Korea Drills Order', url: 'https://example.com/b2' }),
  ];
  const topicByUrl = new Map<string, string | null>([
    ['https://example.com/a1', T_POSTURE], ['https://example.com/a2', T_POSTURE],
    ['https://example.com/b1', T_MILOPS], ['https://example.com/b2', T_MILOPS],
  ]);
  const clusters = buildAttachClusters(members, topicByUrl);
  const cand = candidate({ title: 'US South Korea joint drills downsized begin', category: 'Korea Drills Order', primaryTopic: T_DIPLO });
  check('(3) two matching related-topic clusters -> null (ambiguity fail-close)', clusters.length === 2 && selectAttachClusterId(cand, clusters) === null);
}

// ===========================================================================
// (4) Token/time precision gates still decide.
// ===========================================================================
{
  const clusters = drillsCluster();
  const weak = candidate({
    title: 'Pentagon budget review examines readiness posture accounts',
    category: 'Pentagon Budget Review',
    primaryTopic: T_DEFPOL,
  });
  check('(4) related topic with weak token overlap does NOT attach', selectAttachClusterId(weak, clusters) === null);
  const stale = candidate({
    title: 'Trump orders US South Korea joint drills scaled back',
    category: 'Korea Drills Order',
    primaryTopic: T_DIPLO,
    ageH: SAME_EVENT_WINDOW_HOURS + 14,
  });
  check('(4) out-of-window decision does NOT attach', selectAttachClusterId(stale, clusters) === null);
}

// ===========================================================================
// (5) Prompt guidance: narrow exception present, designed-in separations kept.
// ===========================================================================
{
  const g = CURATED_EVENT_IDENTITY_GUIDANCE;
  check('(5) decision-execution exception present', g.includes('POLICY DECISION / ORDER + ITS DIRECT SAME-TRACK EXECUTION'));
  check('(5) exception names same actors + same measure gate', /SAME actors AND the SAME specific measure/.test(g));
  check('(5) exception preserves scheduled-event phase split', /SCHEDULED EVENT PHASES rule still stands/.test(g));
  check('(5) exception keeps reactions/market effects out', /REACTIONS, third-party commentary, analysis pieces, and downstream MARKET\/ECONOMIC effects/.test(g));
  check('(5) scheduled-event phase rule intact', g.includes('SCHEDULED EVENT PHASES (summit / conference / forum with a defined START)'));
  check('(5) counter-strike separation intact', g.includes('A retaliatory or counter-strike is a DIFFERENT incident'));
  check('(5) mutual-exchange peer group intact', g.includes('MUTUAL-EXCHANGE — a THIRD, peer-level group'));
  check('(5) downstream market-effect separation intact', g.includes('DOWNSTREAM ECONOMIC / MARKET EFFECT ≠ THE TRIGGERING EVENT'));
  check('(5) diplomacy-vs-kinetic wall intact', g.includes('a military strike that occurs DURING negotiations is STILL a SEPARATE incident'));
  check('(5) legislative-vs-kinetic wall intact', g.includes('LEGISLATIVE / APPROPRIATIONS / BUDGET PROCESS is a DIFFERENT event'));
}

// ===========================================================================
// (6) Deterministic scheduled-event phase split unchanged.
// ===========================================================================
{
  check('(6) pre-phase still detected', scheduledEventPhase('Trump to address allies at upcoming G7 summit') === 'pre');
  check('(6) during-phase still detected', scheduledEventPhase('G7 summit begins as leaders gather') === 'during');
  check('(6) non-summit decision/execution titles carry no phase', scheduledEventPhase('Trump orders US South Korea joint drills scaled back') === null && scheduledEventPhase('US South Korea drills begin in downsized form') === null);
}

if (failures > 0) {
  console.error(`\n[dec-exec] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[dec-exec] all checks passed');
