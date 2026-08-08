/**
 * Curated synthesis ANCHOR-FIDELITY regression (attach-vs-spawn, Phase 1).
 *
 * The live 102-source U.S.-Iran cluster proved the dominant failure mode is
 * anchor fidelity: the cluster was coherent (one developing deal process) but its
 * neutral headline + corroborated facts were anchored on a MINORITY high-priority
 * alarmist outlier (a single owner predicting collapse) instead of the
 * broadly-corroborated deal-progress development that most independently-owned
 * outlets actually reported.
 *
 * `buildSynthesisPrompt` is the pure, exported core of the synthesis pass: given
 * the formed cluster's members it returns the instruction prompt sent to the
 * model. This pins the contract WITHOUT the LLM (no network / DB / live AI) so it
 * can run as a regression gate:
 *   (a) the prompt makes the headline/lede/first-fact anchor on the cluster's
 *       DOMINANT development (broadest distinct-OWNER corroboration), not a
 *       minority/alarmist angle;
 *   (b) a multi-step DEVELOPING PROCESS is treated as ONE story;
 *   (c) minority/alarmist angles are routed to attributedClaims, NEVER the facts;
 *   (d) the anti-wire-inflation rule (weight by ownership distinctness, NOT raw
 *       repeat count) is RETAINED — the new anchor language must not regress it;
 *   (e) it still fail-closes (no corroborating member -> synthesizeStory null);
 *   (f) the prompt carries per-member recency lines ("published=…") from the
 *       publishedAt field — so the model can identify the latest turn;
 *   (g) the HEADLINE RECENCY RULE instruction is present: when ≥2 distinctly-
 *       owned outlets corroborate a later superseding development, the headline
 *       must reflect the latest state, not just the original announcement;
 *   (h) a single-outlet "latest turn" can NEVER hijack the headline — the rule
 *       requires ≥2 distinctly-owned corroborating sources for the new turn;
 *   (i) publishedAt is excluded from synthesisContentHash and memberSignatureToken
 *       so recency data never forces needless re-synthesis.
 *
 * Exits non-zero on any violation.
 *
 * Usage:  tsx scripts/curated-synthesis-anchor.test.ts
 */

import {
  buildSynthesisPrompt,
  salvageSynthesisHeadlineAndLede,
  synthesizeStory,
  synthesisContentHash,
  memberSignatureToken,
  type SynthMember,
} from '../server/curatedSynthesis';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[synthesis-anchor] OK   ${name}`);
  } else {
    console.error(`[synthesis-anchor] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// FIXTURE A: Original cluster (deal-progress majority + alarmist minority).
// A representative formed cluster: several independently-owned corroborating wire
// outlets reporting deal progress, plus one alarmist opinion outlet predicting
// collapse, plus an adversary state-media contrast take.
// ---------------------------------------------------------------------------
const members: SynthMember[] = [
  {
    key: 'main:reuters',
    url: 'https://www.reuters.com/world/iran-deal',
    source: 'Reuters',
    sourceIdentifier: 'reuters',
    factuality: 'high',
    ownership: ['Thomson Reuters'],
    title: 'U.S. and Iran report progress toward sanctions-relief framework',
    summary: 'Negotiators said a framework is taking shape.',
    bullets: ['Framework taking shape', 'Sanctions relief on the table'],
    cls: 'corroborating',
    label: 'corroborating',
  },
  {
    key: 'main:ap',
    url: 'https://apnews.com/iran-talks',
    source: 'Associated Press',
    sourceIdentifier: 'ap',
    factuality: 'high',
    ownership: ['Associated Press'],
    title: 'Iran nuclear talks advance as inspectors regain access',
    summary: 'Inspector access expanded as part of the process.',
    bullets: ['Inspectors regain access'],
    cls: 'corroborating',
    label: 'corroborating',
  },
  {
    key: 'curated:bbc',
    url: 'https://www.bbc.com/news/iran-us-deal',
    source: 'BBC',
    sourceIdentifier: 'bbc',
    factuality: 'high',
    ownership: ['BBC'],
    title: 'Washington and Tehran edge closer to interim agreement',
    summary: 'Both sides describe momentum.',
    bullets: ['Interim agreement closer'],
    cls: 'corroborating',
    label: 'corroborating',
  },
  {
    key: 'main:opinion',
    url: 'https://example-opinion.com/iran-collapse',
    source: 'Hawkish Opinion Daily',
    sourceIdentifier: 'opinion',
    factuality: 'mixed',
    ownership: ['Opinion Media'],
    title: 'Why the Iran deal is about to collapse and trigger war',
    summary: 'A columnist predicts imminent collapse.',
    bullets: ['Predicts collapse'],
    cls: 'attach',
    label: 'contrast',
  },
  {
    key: 'curated:press-tv',
    url: 'https://www.presstv.ir/iran-victory',
    source: 'Press TV',
    sourceIdentifier: 'press-tv',
    factuality: 'low',
    ownership: ['IRIB'],
    title: 'Iran forces U.S. concessions in nuclear standoff',
    summary: 'State media frames talks as an Iranian win.',
    bullets: ['Frames as Iranian win'],
    cls: 'anchor-only',
    label: 'contrast',
  },
];

const prompt = buildSynthesisPrompt(members);
const lc = prompt.toLowerCase();

// (a) DOMINANT-development anchoring is explicit for headline + lede + first fact.
check(
  'prompt anchors on the DOMINANT development',
  /dominant development/i.test(prompt),
  'expected the prompt to require anchoring on the cluster DOMINANT development',
);
check(
  'first fact must state the dominant development',
  /first fact/i.test(prompt) && /dominant development/i.test(prompt),
  'expected the FIRST fact to be pinned to the dominant development',
);

// (b) breadth-of-distinct-owners is the driver of "dominant".
check(
  'dominant is defined by BROADEST distinct-OWNER corroboration',
  /broadest distinct-owner/i.test(prompt) || /widest set of distinctly-owned/i.test(prompt),
  'expected dominance to be defined by breadth of DISTINCT OWNERS, not raw count',
);

// (c) developing process is ONE story.
check(
  'multi-step DEVELOPING PROCESS treated as ONE story',
  /developing process/i.test(prompt) && /one story/i.test(prompt),
  'expected an ongoing negotiation/deal to be treated as a single developing story',
);

// (d) minority / alarmist angles routed to attributedClaims, barred from facts.
check(
  'minority / alarmist angle routed away from headline/lede/facts',
  (lc.includes('alarmist') || lc.includes('minority')) && lc.includes('attributedclaims'),
  'expected minority/alarmist angles to be relegated to attributedClaims, not the facts',
);

// (e) ANTI-WIRE-INFLATION retained — must NOT regress with the new anchor language.
check(
  'anti-wire-inflation rule retained (ownership distinctness over raw repeat count)',
  /not by how many outlets repeat it/i.test(prompt) && /ownership distinctness/i.test(prompt),
  'the dominant-development language must not drop the anti-wire-inflation guard',
);
check(
  'same-owner / same-type copies still counted once',
  /share an owner or type/i.test(prompt) && /same wire copy/i.test(prompt),
  'expected same-owner/same-type copies to still count as one source',
);

// ---------------------------------------------------------------------------
// FIXTURE B: Hormuz-style — broadly corroborated announcement + reversal
// corroborated by 2+ distinctly-owned outlets.
// Timestamps are relative to NOW so the fixture never goes stale.
// ---------------------------------------------------------------------------
const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

const hormuzMembers: SynthMember[] = [
  // Original announcement — many outlets, older
  {
    key: 'main:reuters-h',
    url: 'https://www.reuters.com/world/hormuz-fee',
    source: 'Reuters',
    sourceIdentifier: 'reuters',
    factuality: 'high',
    ownership: ['Thomson Reuters'],
    title: 'Trump announces 20% fee on ships using U.S. protection through Strait of Hormuz',
    summary: 'Trump proposes a transit fee for Hormuz shipping protection.',
    bullets: ['20% fee proposed'],
    cls: 'corroborating',
    label: 'corroborating',
    publishedAt: hoursAgo(20),
  },
  {
    key: 'main:ap-h',
    url: 'https://apnews.com/hormuz-fee',
    source: 'Associated Press',
    sourceIdentifier: 'ap',
    factuality: 'high',
    ownership: ['Associated Press'],
    title: 'Trump proposes transit toll for Hormuz Strait shipping',
    summary: 'The president floated a fee on ships transiting the strait.',
    bullets: ['Shipping toll floated'],
    cls: 'corroborating',
    label: 'corroborating',
    publishedAt: hoursAgo(19),
  },
  {
    key: 'curated:bbc-h',
    url: 'https://www.bbc.com/news/hormuz',
    source: 'BBC',
    sourceIdentifier: 'bbc',
    factuality: 'high',
    ownership: ['BBC'],
    title: 'US to charge for Hormuz protection, Trump says',
    summary: 'BBC reports the toll proposal.',
    bullets: ['Fee announced'],
    cls: 'corroborating',
    label: 'corroborating',
    publishedAt: hoursAgo(18),
  },
  {
    key: 'curated:nyt-h',
    url: 'https://www.nytimes.com/hormuz-fee',
    source: 'New York Times',
    sourceIdentifier: 'nyt',
    factuality: 'high',
    ownership: ['New York Times Company'],
    title: 'Trump says Gulf nations must pay for U.S. naval protection at Hormuz',
    summary: 'NYT coverage of the toll.',
    bullets: ['Gulf nations to pay'],
    cls: 'corroborating',
    label: 'corroborating',
    publishedAt: hoursAgo(17),
  },
  // REVERSAL — only 2 outlets, but distinctly owned, more recent
  {
    key: 'main:wsj-h',
    url: 'https://www.wsj.com/hormuz-reversal',
    source: 'Wall Street Journal',
    sourceIdentifier: 'wsj',
    factuality: 'high',
    ownership: ['News Corp'],
    title: 'Trump drops Hormuz fee, shifts to Gulf investment deal framework',
    summary: 'White House walked back the fee in favor of investment commitments from Gulf states.',
    bullets: ['Fee dropped', 'Gulf investment deal instead'],
    cls: 'corroborating',
    label: 'corroborating',
    publishedAt: hoursAgo(2),
  },
  {
    key: 'curated:ft-h',
    url: 'https://www.ft.com/hormuz-deal',
    source: 'Financial Times',
    sourceIdentifier: 'ft',
    factuality: 'high',
    ownership: ['Nikkei'],
    title: 'US abandons Hormuz shipping fee after Gulf states offer investment pledges',
    summary: 'FT reports the reversal: investment pledges replaced the fee proposal.',
    bullets: ['Fee abandoned', 'Investment pledges secured'],
    cls: 'corroborating',
    label: 'corroborating',
    publishedAt: hoursAgo(1),
  },
];

const hormuzPrompt = buildSynthesisPrompt(hormuzMembers);

// (f) Per-member recency lines appear in the prompt for members WITH publishedAt.
check(
  'Hormuz fixture: prompt contains published= lines for timestamped members',
  /published=\d+ (min|hr|days?) ago/i.test(hormuzPrompt),
  'expected "published=N hr ago" style lines in the prompt for members with publishedAt',
);

// Verify every timestamped member gets a recency line (6 members all have publishedAt).
const recencyMatches = (hormuzPrompt.match(/published=\d+ (min|hr|days?) ago/gi) ?? []).length;
check(
  'Hormuz fixture: recency line present for each timestamped member (6)',
  recencyMatches === 6,
  `expected 6 published= lines (one per Hormuz member), got ${recencyMatches}`,
);

// (g) HEADLINE RECENCY RULE instruction is present in the prompt.
check(
  'prompt contains HEADLINE RECENCY RULE instruction',
  /headline recency rule/i.test(hormuzPrompt),
  'expected the HEADLINE RECENCY RULE paragraph to appear in the prompt',
);

check(
  'recency rule references supersedes or reverses',
  /supersedes or reverses/i.test(hormuzPrompt),
  'expected the recency rule to specify supersedes/reverses triggering condition',
);

// (h) Single-outlet "latest turn" guard — the ≥2 distinct-owner requirement is stated.
check(
  'recency rule requires ≥2 distinctly-owned corroborating outlets for the new turn',
  /≥2 distinctly-owned corroborating/i.test(hormuzPrompt) ||
    /2 distinctly-owned corroborating/i.test(hormuzPrompt),
  'expected the recency rule to require ≥2 distinctly-owned outlets for the newer turn',
);

check(
  'single-outlet latest turn cannot hijack headline',
  /single-outlet.*hijack/i.test(hormuzPrompt) || /single-outlet.*never.*hijack/i.test(hormuzPrompt),
  'expected the guard that a single-outlet latest turn cannot hijack the headline',
);

// Evidence-discipline contract: a corroborated recent denial changes the story
// into a disagreement/trajectory, while a singleton novelty cannot.
check(
  'corroborated denial becomes a disagreement trajectory',
  /corroborated disagreement rule/i.test(hormuzPrompt) &&
    /denies, contradicts, or disputes/i.test(hormuzPrompt) &&
    /headline and lede must describe the disagreement or trajectory/i.test(hormuzPrompt),
  'expected independently reported contradiction to update headline and lede',
);
check(
  'lone unconfirmed update preserves established framing',
  /one newly attached source/i.test(hormuzPrompt) &&
    /never displaces the established framing/i.test(hormuzPrompt) &&
    /until independently reported/i.test(hormuzPrompt),
  'expected one-source novelty to remain attributed until a second origin reports it',
);
check(
  'propositions are classified before synthesis',
  /evidence classification — do this before writing/i.test(hormuzPrompt) &&
    /announcement, commitment, intention/i.test(hormuzPrompt) &&
    /motive, cause, explanation, forecast/i.test(hormuzPrompt),
  'expected observable developments to be separated from assertions and explanations',
);
check(
  'facts and claims must be propositionally complementary',
  /add information not already stated in "facts"/i.test(hormuzPrompt) &&
    /never repeat the same proposition in both sections/i.test(hormuzPrompt),
  'expected facts and attributed claims to add distinct information',
);
check(
  'source-based estimates stay visibly attributed in headline, lede, and claims',
  /unnamed-source estimate/i.test(hormuzPrompt) &&
    /officials say U\.S\. used nearly all long-range missiles/i.test(hormuzPrompt) &&
    /every entry must be self-contained and visibly attributed/i.test(hormuzPrompt) &&
    /section label is not attribution/i.test(hormuzPrompt),
  'expected source-dependent quantities and readiness assessments to name their origin',
);
const salvagedDisplay = salvageSynthesisHeadlineAndLede({
  headline: 'U.S. has used virtually all long-range missiles',
  lede: 'Officials reported a drawdown while the Pentagon accelerated replacement orders.',
  facts: ['The Pentagon placed replacement orders for two missile systems.'],
});
check(
  'unsafe headline is replaced without discarding safe synthesis content',
  salvagedDisplay.replacedHeadline &&
    !salvagedDisplay.replacedLede &&
    salvagedDisplay.headline === salvagedDisplay.lede &&
    salvagedDisplay.lede.startsWith('Officials reported'),
  'expected field-level salvage to use only current safe synthesis content',
);
const salvagedBoth = salvageSynthesisHeadlineAndLede({
  headline: 'U.S. has used nearly all long-range missiles',
  lede: 'The depletion raises concerns about military readiness.',
  facts: ['The Pentagon placed replacement orders for two missile systems.'],
});
check(
  'unsafe headline and lede fall back to a grounded fact',
  salvagedBoth.replacedHeadline &&
    salvagedBoth.replacedLede &&
    salvagedBoth.headline === 'The Pentagon placed replacement orders for two missile systems.' &&
    salvagedBoth.lede === 'The Pentagon placed replacement orders for two missile systems.',
  'expected safe grounded facts to survive instead of rejecting the full synthesis',
);
const stalePriorNotReused = salvageSynthesisHeadlineAndLede({
  headline: 'U.S. has used nearly all long-range missiles',
  lede: 'The depletion raises concerns about military readiness.',
  facts: ['The Pentagon placed replacement orders for two missile systems.'],
  priorHeadline: 'Ceasefire talks collapse after overnight strikes',
} as Parameters<typeof salvageSynthesisHeadlineAndLede>[0] & { priorHeadline: string });
check(
  'unsafe display fields never fall back to a stale prior headline',
  stalePriorNotReused.headline === 'The Pentagon placed replacement orders for two missile systems.' &&
    stalePriorNotReused.lede === 'The Pentagon placed replacement orders for two missile systems.',
  'expected salvage to ignore obsolete prior framing',
);

// (i) publishedAt must NOT enter synthesisContentHash or memberSignatureToken.
//
// Hash must be identical with and without publishedAt (it is display-only).
const baseMembers: SynthMember[] = [
  {
    key: 'main:a',
    url: 'https://example.com/a',
    source: 'Source A',
    sourceIdentifier: null,
    factuality: 'high',
    ownership: ['Owner A'],
    title: 'Test headline A',
    summary: 'Summary A',
    bullets: null,
    cls: 'corroborating',
    label: null,
  },
  {
    key: 'main:b',
    url: 'https://example.com/b',
    source: 'Source B',
    sourceIdentifier: null,
    factuality: 'high',
    ownership: ['Owner B'],
    title: 'Test headline B',
    summary: 'Summary B',
    bullets: null,
    cls: 'corroborating',
    label: null,
  },
];

const withTimestamps: SynthMember[] = baseMembers.map((m, i) => ({
  ...m,
  publishedAt: new Date(NOW.getTime() - i * 3_600_000),
}));

const hashWithout = synthesisContentHash(baseMembers);
const hashWith = synthesisContentHash(withTimestamps);
check(
  'synthesisContentHash is invariant to publishedAt (prompt-display only)',
  hashWithout === hashWith,
  `hash changed when publishedAt was added: without=${hashWithout} with=${hashWith}`,
);

const tokenWithout = memberSignatureToken(baseMembers[0].url, baseMembers[0].key);
const tokenWith = memberSignatureToken(withTimestamps[0].url, withTimestamps[0].key);
check(
  'memberSignatureToken is invariant to publishedAt (prompt-display only)',
  tokenWithout === tokenWith,
  'memberSignatureToken must not change when publishedAt is present',
);

// Members without publishedAt must NOT produce rendered recency lines in the
// member descriptors (the prompt RULE text mentions "published=…" as an example
// but member descriptors must not carry "published=N hr ago" when omitted).
const noTimestampPrompt = buildSynthesisPrompt(baseMembers);
check(
  'no rendered recency in member descriptors when members lack publishedAt',
  !/published=\d+ (min|hr|days?) ago/i.test(noTimestampPrompt),
  'expected no "published=N hr ago" recency in member descriptors when publishedAt is absent',
);

// (f-orig) FAIL-CLOSED — no corroborating member -> no synthesis (null), unchanged.
(async () => {
  const noCorro: SynthMember[] = members.filter((m) => m.cls !== 'corroborating');
  const result = await synthesizeStory(noCorro);
  check(
    'fail-closed: no corroborating member -> synthesizeStory returns null',
    result === null,
    'a cluster with zero corroborating members must not synthesize',
  );

  console.log(
    failures === 0 ? '[synthesis-anchor] ALL PASS' : `[synthesis-anchor] ${failures} FAILURE(S)`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
