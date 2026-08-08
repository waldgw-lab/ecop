// scripts/mcop-bot-curated.test.ts
// ---------------------------------------------------------------------------
// Gate: MCOP Bot curated-view awareness + misinformation safety contract.
//
// Verifies two independent guarantees:
//
//  1. OFF the curated view (no provider) the bot is byte-identical to before —
//     the curated tool is NOT offered and the curated safety clause is NOT in
//     the system prompt. This proves Stream/Team/custom-MCOP behavior is
//     unchanged and there is no accidental curated back-door.
//
//  2. The trust-tagged formatter STRUCTURALLY separates corroborated (fact-safe)
//     content from adversary / state-media / single-source content. Adversary
//     "spin" and attributed claims must land ONLY in attribute-only fields
//     (sources[].spin / attributedClaims) and must NEVER leak into
//     corroboratedFacts or summary — so the bot can attribute adversary framing
//     but can never present it as verified fact.
//
// Pure, DB-free, deterministic. Exit 0 = pass, 1 = fail (no inconclusive path).
// ---------------------------------------------------------------------------

import { buildMcopBotTools, buildSystemPrompt } from '../server/newsbot';
import {
  formatCuratedStoriesForModel,
  filterCuratedStories,
} from '../server/mcopBotCurated';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ok   - ${label}`);
  } else {
    console.error(`  FAIL - ${label}`);
    failures++;
  }
}

function toolNames(hasCurated: boolean): string[] {
  return buildMcopBotTools(hasCurated).map((t: any) => t?.function?.name);
}

// A distinctive marker that must NEVER appear in any fact-safe field.
const ADVERSARY_SPIN_MARKER = 'IRAN_STATE_MEDIA_SPIN_DO_NOT_STATE_AS_FACT';
const ADVERSARY_CLAIM_MARKER = 'IRAN_STATE_MEDIA_CLAIM_ATTRIBUTE_ONLY';
const CORROBORATED_FACT_MARKER = 'CORROBORATED_MULTI_OUTLET_FACT';

console.log('[1] Off-curated mode is byte-identical (no curated tool / no curated prompt)');
{
  const off = toolNames(false);
  const on = toolNames(true);
  check('buildMcopBotTools(false) omits searchCuratedTopStories',
    !off.includes('searchCuratedTopStories'));
  check('buildMcopBotTools(true) includes searchCuratedTopStories',
    on.includes('searchCuratedTopStories'));
  check('curated tool is strictly ADDITIVE (all base tools still present in curated mode)',
    off.every((n) => on.includes(n)) && on.length === off.length + 1);

  const promptOff = buildSystemPrompt(false);
  const promptOn = buildSystemPrompt(true);
  check('buildSystemPrompt() defaults to non-curated (no curated tool mention)',
    !buildSystemPrompt().includes('searchCuratedTopStories'));
  check('buildSystemPrompt(false) omits the curated safety clause',
    !promptOff.includes('Curated Top Stories') && !promptOff.includes('searchCuratedTopStories'));
  check('buildSystemPrompt(true) includes the curated safety clause',
    promptOn.includes('Curated Top Stories') && promptOn.includes('searchCuratedTopStories'));
  check('curated prompt states adversary/state-media must never be presented as fact',
    /never/i.test(promptOn) && /state-media/i.test(promptOn) && /attribut/i.test(promptOn));
  // The base prompt embeds a live ISO timestamp ("Today is <iso>."), so compare
  // with that normalized out to avoid a millisecond-drift false failure.
  const stripTs = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<TS>');
  check('curated prompt is strictly a SUPERSET of the base prompt',
    stripTs(promptOn).startsWith(stripTs(promptOff)));
}

console.log('[2] Cluster formatter keeps adversary spin/claims out of fact-safe fields');
const clusterPayload = {
  stories: [
    {
      clusterId: 'cl-1',
      headline: 'Strait of Hormuz tensions escalate',
      lede: 'Multiple outlets report increased naval activity in the strait.',
      facts: [
        `${CORROBORATED_FACT_MARKER}: naval patrols increased this week`,
        'Shipping insurers raised premiums',
      ],
      attributedClaims: [
        `${ADVERSARY_CLAIM_MARKER}: Tehran says the drills were purely defensive`,
      ],
      sourceCount: 3,
      members: [
        {
          source: 'Reuters',
          role: 'contributing',
          behaviorClass: 'corroborating',
          displayTitle: 'Naval activity rises in Hormuz',
          url: 'https://reuters.example/hormuz',
          spin: 'this-should-be-dropped-for-a-trusted-source',
        },
        {
          source: 'Press TV',
          role: 'attach-only',
          behaviorClass: 'contrast',
          displayTitle: 'US provocation in the Gulf',
          url: 'https://presstv.example/gulf',
          spin: `${ADVERSARY_SPIN_MARKER}: frames the US as the sole aggressor`,
          alignment: 20,
        },
      ],
    },
  ],
};

{
  const [story] = formatCuratedStoriesForModel(clusterPayload);
  check('cluster story tagged kind=cluster', story.kind === 'cluster');
  check('corroboratedFacts carries the multi-outlet fact',
    story.corroboratedFacts.some((f) => f.includes(CORROBORATED_FACT_MARKER)));
  check('summary (lede) is populated for a cluster', !!story.summary);

  const factSafeBlob = [story.summary ?? '', ...story.corroboratedFacts].join(' \u0000 ');
  check('adversary SPIN never leaks into summary/corroboratedFacts',
    !factSafeBlob.includes(ADVERSARY_SPIN_MARKER));
  check('adversary CLAIM never leaks into summary/corroboratedFacts',
    !factSafeBlob.includes(ADVERSARY_CLAIM_MARKER));

  check('adversary claim is preserved in attributedClaims (attribute-only)',
    story.attributedClaims.some((c) => c.includes(ADVERSARY_CLAIM_MARKER)));

  const reuters = story.sources.find((s) => s.source === 'Reuters')!;
  const pressTv = story.sources.find((s) => s.source === 'Press TV')!;
  check('trusted contributing source => trustClass corroborating / verifiedForFacts true',
    !!reuters && reuters.trustClass === 'corroborating' && reuters.verifiedForFacts === true);
  check('trusted source carries NO spin (spin is attribute-only)',
    !!reuters && reuters.spin === undefined);
  check('adversary source => trustClass attributed / verifiedForFacts false',
    !!pressTv && pressTv.trustClass === 'attributed' && pressTv.verifiedForFacts === false);
  check('adversary spin is preserved ONLY on its own source entry',
    !!pressTv && !!pressTv.spin && pressTv.spin.includes(ADVERSARY_SPIN_MARKER));
}

console.log('[3] Standalone (single) story: contributing => fact-safe bullets, no leak');
const singlePayload = {
  stories: [
    {
      clusterId: null,
      title: 'Defense budget markup advances',
      headline: 'Defense budget markup advances',
      summaryBullets: [
        `${CORROBORATED_FACT_MARKER}: committee approved the markup`,
        'Vote was bipartisan',
      ],
      attributedClaims: [],
      role: 'contributing',
      source: 'Associated Press',
      url: 'https://ap.example/budget',
    },
  ],
};
{
  const [story] = formatCuratedStoriesForModel(singlePayload);
  check('single story tagged kind=single', story.kind === 'single');
  check('single summaryBullets become corroboratedFacts',
    story.corroboratedFacts.some((f) => f.includes(CORROBORATED_FACT_MARKER)));
  check('single contributing source => verifiedForFacts true',
    story.sources.length === 1 && story.sources[0].verifiedForFacts === true);
  check('single story summary (lede) is null (singles have no synthesized lede)',
    story.summary === null);
}

console.log('[4] Whole-payload leak sweep: adversary markers never in any fact-safe field');
{
  const all = formatCuratedStoriesForModel(clusterPayload);
  const factSafeEverywhere = all
    .flatMap((s) => [s.summary ?? '', ...s.corroboratedFacts])
    .join(' \u0000 ');
  check('no adversary spin marker anywhere in corroboratedFacts/summary',
    !factSafeEverywhere.includes(ADVERSARY_SPIN_MARKER));
  check('no adversary claim marker anywhere in corroboratedFacts/summary',
    !factSafeEverywhere.includes(ADVERSARY_CLAIM_MARKER));
}

console.log('[5] filterCuratedStories keyword behavior');
{
  const stories = formatCuratedStoriesForModel(clusterPayload);
  check('empty keywords => passthrough',
    filterCuratedStories(stories, []).length === stories.length);
  check('matching keyword (headline) returns the story',
    filterCuratedStories(stories, ['Hormuz']).length === 1);
  check('keyword matched against adversary spin still returns the story',
    filterCuratedStories(stories, [ADVERSARY_SPIN_MARKER]).length === 1);
  check('non-matching keyword returns nothing',
    filterCuratedStories(stories, ['no-such-topic-xyzzy']).length === 0);
  check('too-short keyword (<2 chars) is ignored => passthrough',
    filterCuratedStories(stories, ['a']).length === stories.length);
}

if (failures > 0) {
  console.error(`\n[mcop-bot-curated] FAILED with ${failures} failing assertion(s).`);
  process.exit(1);
}
console.log('\n[mcop-bot-curated] PASS — curated awareness gated + trust separation enforced.');
process.exit(0);
