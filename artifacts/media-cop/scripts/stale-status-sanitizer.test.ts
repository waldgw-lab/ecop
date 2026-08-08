// =============================================================================
// GATE: stale status descriptor sanitizer (server/staleStatusSanitizer.ts).
//
// AI models with pre-2025 training cutoffs inject "Former/Ex-/Then-/Late"
// status descriptors even when every source article omits them (e.g. "Former
// President Trump" when sources say "President Trump"). The sanitizer must:
//   • Strip an injected descriptor when the source text never applies it to
//     that person.
//   • Preserve a descriptor when the source text genuinely uses it for that
//     person (article about a former official, attributed quote, etc.).
//   • Never alter names, titles, or the rest of the sentence.
//
// Pure test — no DB, no AI, no network. Exit 0 = pass, 1 = fail.
// =============================================================================
import {
  correctCurrentOfficialTitles,
  groundGeneratedLinesInSources,
  groundGeneratedTextInSources,
  stripStaleStatusDescriptors,
  stripStaleStatusDescriptorsFromArray,
  hasUnsupportedStatusDescriptor,
} from '../server/staleStatusSanitizer';
import { buildSynthesisGroundingSourceTexts } from '../server/curatedSynthesis';

let failures = 0;
function check(cond: boolean, label: string) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

// ── Injected descriptors — MUST be stripped ──────────────────────────────────
console.log('Injected descriptors (source lacks them — must be stripped):');

const srcPresidentTrump = ['Trump signed the executive order', 'President Trump announced a new policy'];
check(
  stripStaleStatusDescriptors('Former President Trump signed the order.', srcPresidentTrump) ===
    'President Trump signed the order.',
  'strips "Former" from "Former President Trump" when source says "President Trump"',
);

check(
  stripStaleStatusDescriptors('Ex-Secretary Pompeo testified before Congress.', [
    'Secretary Pompeo appeared before the Senate committee.',
  ]) === 'Secretary Pompeo testified before Congress.',
  'strips "Ex-" from "Ex-Secretary Pompeo" when source says "Secretary Pompeo"',
);

// ── Obsolete office substitutions — MUST be corrected ───────────────────────
console.log('Obsolete current-office substitutions (exact known officials):');

check(
  correctCurrentOfficialTitles('Senator Marco Rubio warned Cuba has infiltrated the United States.') ===
    'Secretary of State Marco Rubio warned Cuba has infiltrated the United States.',
  'corrects obsolete "Senator Marco Rubio" to "Secretary of State Marco Rubio"',
);

check(
  stripStaleStatusDescriptors('Former President Donald Trump announced new measures.', [
    'President Trump announced new measures.',
  ]) === 'President Donald Trump announced new measures.',
  'corrects "Former President Donald Trump" to "President Donald Trump"',
);

check(
  correctCurrentOfficialTitles('Senator Rubio discussed the issue.') ===
    'Senator Rubio discussed the issue.',
  'does not guess from a surname-only mention',
);
check(
  stripStaleStatusDescriptors(
    'Senator Marco Rubio questioned the witness.',
    ['In 2021, Senator Marco Rubio questioned the witness during a committee hearing.'],
  ) === 'Senator Marco Rubio questioned the witness.',
  'preserves a historically source-supported Rubio title',
);

// ── Source-grounded person identity ──────────────────────────────────────────
console.log('Source-grounded person identity:');

const paparoSource = [
  'The head of U.S. Pacific Command said coercive actions challenge regional stability.',
  'Admiral Samuel Paparo said some actors were using false claims of legitimacy.',
  'Paparo said the United States will not let any nation dominate the region.',
];
check(
  groundGeneratedTextInSources(
    'Admiral John Aquilino warned against coercion in the Indo-Pacific.',
    paparoSource,
  ) === 'Admiral Samuel Paparo warned against coercion in the Indo-Pacific.',
  'repairs observed Aquilino predecessor substitution when source names Paparo',
);
check(
  groundGeneratedTextInSources(
    'Admiral John Aquilino warned against coercion in the Indo-Pacific.',
    ['Admiral John Aquilino warned against coercion during a 2023 address.'],
  ) === 'Admiral John Aquilino warned against coercion in the Indo-Pacific.',
  'preserves Aquilino when the source actually names Aquilino',
);
check(
  groundGeneratedTextInSources(
    'Admiral Jane Invented warned against coercion in the Indo-Pacific.',
    paparoSource,
  ) === null,
  'rejects an unsupported titled full name absent from source',
);
check(
  groundGeneratedLinesInSources(
    [
      'Admiral John Aquilino said no nation will dominate the Indo-Pacific.',
      'Regional states continue to face coercive maritime actions.',
      'General Jane Invented endorsed the policy.',
    ],
    paparoSource,
  ).join('|') ===
    'Admiral Samuel Paparo said no nation will dominate the Indo-Pacific.|Regional states continue to face coercive maritime actions.',
  'array guard repairs source-backed identity, keeps grounded line, and drops invented person',
);
const synthesisOracle = buildSynthesisGroundingSourceTexts([
  {
    title: 'Admiral Samuel Paparo warns against coercion in the Indo-Pacific',
    summary: 'Admiral John Aquilino warned against coercion.',
    bullets: ['Admiral John Aquilino said no nation will dominate the region.'],
  } as any,
]);
check(
  synthesisOracle.join('|') ===
    'Admiral Samuel Paparo warns against coercion in the Indo-Pacific' &&
    groundGeneratedTextInSources(
      'Admiral John Aquilino warned against coercion.',
      synthesisOracle,
    ) === 'Admiral Samuel Paparo warned against coercion.',
  'synthesis grounding ignores contaminated generated summaries and bullets',
);

check(
  stripStaleStatusDescriptors('Then-National Security Advisor Bolton objected.', [
    'National Security Advisor Bolton objected to the plan.',
  ]) === 'National Security Advisor Bolton objected.',
  'strips "Then-" when source does not use it',
);

check(
  stripStaleStatusDescriptors(
    'The bill was signed by Former President Biden last year.',
    ['President Biden signed the legislation'],
  ) === 'The bill was signed by President Biden last year.',
  'strips mid-sentence "Former President Biden" when source says "President Biden"',
);

check(
  stripStaleStatusDescriptors('Former Secretary of State Rubio met with allies.', [
    'Secretary of State Rubio held talks with European allies.',
  ]) === 'Secretary of State Rubio met with allies.',
  'strips "Former" before multi-word title "Secretary of State Rubio"',
);

// ── Source-supported descriptors — MUST be preserved ────────────────────────
console.log('Source-supported descriptors (must be preserved):');

const srcFormerObama = [
  'Former President Obama signed the law in 2015.',
  'the Obama-era agreement remains in force',
];
check(
  stripStaleStatusDescriptors('Former President Obama signed the law.', srcFormerObama) ===
    'Former President Obama signed the law.',
  'preserves "Former President Obama" when source uses the same phrasing',
);

const srcFormerMattis = ['former defense secretary Mattis criticized the policy in an op-ed'];
check(
  stripStaleStatusDescriptors(
    'Former Defense Secretary Mattis criticized the policy.',
    srcFormerMattis,
  ) === 'Former Defense Secretary Mattis criticized the policy.',
  'preserves "Former Defense Secretary Mattis" when source uses it',
);

const srcQuotedFormer = [
  'Trump referred to Biden as "the former president" during the speech.',
  'Trump said the former president made bad deals',
];
check(
  stripStaleStatusDescriptors(
    'Trump called Biden the former president in his remarks.',
    srcQuotedFormer,
  ).includes('former president'),
  'preserves "former president" descriptor when source attributes it in a quote',
);

// ── Name and surrounding text is never altered ───────────────────────────────
console.log('Surrounding text preservation:');

const afterStrip = stripStaleStatusDescriptors(
  'Former Secretary of State Rubio arrived in Brussels for talks.',
  ['Secretary of State Rubio arrived in Brussels'],
);
check(
  afterStrip === 'Secretary of State Rubio arrived in Brussels for talks.',
  'only descriptor stripped — title + name + rest of sentence intact',
);

// ── Null / empty inputs ──────────────────────────────────────────────────────
console.log('Null / empty inputs:');

check(stripStaleStatusDescriptors(null, []) === '', 'null input returns empty string');
check(stripStaleStatusDescriptors(undefined, []) === '', 'undefined input returns empty string');
check(
  stripStaleStatusDescriptors('No descriptors here.', ['some source']) === 'No descriptors here.',
  'clean text returned unchanged',
);
check(
  stripStaleStatusDescriptors('No descriptors here.', []) === 'No descriptors here.',
  'empty source list returns text unchanged (fail-safe)',
);

// ── Array variant ────────────────────────────────────────────────────────────
console.log('Array variant:');

const bullets = [
  'Former President Trump signed the executive order at the White House.',
  'The order affects defense contractors across the supply chain.',
  'Former Secretary Pompeo called the move "overdue".',
];
const srcArr = [
  'President Trump signed the executive order',
  'Secretary of State Rubio and Secretary Pompeo praised the move',
];
const stripped = stripStaleStatusDescriptorsFromArray(bullets, srcArr);
check(stripped.length === 3, 'array variant preserves array length');
check(
  !stripped[0].startsWith('Former'),
  'array variant strips "Former" from bullet 0 (source says "President Trump")',
);
check(stripped[1] === bullets[1], 'array variant leaves clean bullet unchanged');
check(
  stripStaleStatusDescriptorsFromArray(null, []).length === 0,
  'null array returns empty array',
);

// ── hasUnsupportedStatusDescriptor helper ────────────────────────────────────
console.log('hasUnsupportedStatusDescriptor:');

check(
  hasUnsupportedStatusDescriptor('Former President Trump signed', [
    'President Trump signed the order',
  ]) === true,
  'detects unsupported "Former" correctly',
);
check(
  hasUnsupportedStatusDescriptor('Former President Obama signed', [
    'Former President Obama signed the agreement',
  ]) === false,
  'returns false when source supports the descriptor',
);
check(
  hasUnsupportedStatusDescriptor(null, []) === false,
  'null text returns false',
);

// ── Synthesis-row heal detection: stale headline detected + convergence proof ─
// This mirrors the boot-time heal logic in server/curatedHeal.ts.
// The heal scans ALL prose fields with emptySource so any descriptor in any
// field — including the headline — triggers a re-queue flag.  After one clean
// re-synthesis the hardened prompt + write-time sanitizer produce text that no
// longer contains the descriptor → the detector returns false → no re-queue.
console.log('Synthesis-row heal detection (stale-headline + convergence):');

// Scenario: AI wrote "Former President Trump" in both headline AND lede.
// The empty-source detection must flag this (it cannot self-justify).
const staleHeadline = 'Former President Trump signs executive order on AI regulation.';
const staleLede = 'Former President Trump on Monday signed an executive order directing federal agencies to review AI safety guidelines.';
const emptySource: string[] = [];
check(
  hasUnsupportedStatusDescriptor(staleHeadline, emptySource) === true,
  'synthesis-row heal: stale headline detected with empty source oracle',
);
check(
  hasUnsupportedStatusDescriptor(staleLede, emptySource) === true,
  'synthesis-row heal: stale lede detected with empty source oracle',
);

// Scenario: after one re-synthesis the hardened prompt + sanitizer produce clean
// text ("Former" removed, name preserved).  The detector must return false →
// contentHash is NOT nulled again → no infinite re-synthesis loop.
const cleanHeadline = 'President Trump signs executive order on AI regulation.';
const cleanLede = 'President Trump on Monday signed an executive order directing federal agencies to review AI safety guidelines.';
check(
  hasUnsupportedStatusDescriptor(cleanHeadline, emptySource) === false,
  'synthesis-row heal convergence: clean post-sanitizer headline not re-queued',
);
check(
  hasUnsupportedStatusDescriptor(cleanLede, emptySource) === false,
  'synthesis-row heal convergence: clean post-sanitizer lede not re-queued',
);

// Scenario: a genuine "Former President Obama" story re-synthesizes once (boot
// detects the empty-source pattern), but the hardened prompt + sanitizer restore
// "Former" because member texts genuinely say "former president obama".
// After that, the clean output must also NOT re-queue (even with empty oracle).
// Key insight: "Former President Obama" passes hasUnsupportedStatusDescriptor
// with empty source → triggers initial re-queue.  After re-synthesis the sanitizer
// PRESERVES "Former" (member source texts support it) → the stored text is again
// "Former President Obama" → the heal would re-queue it on next boot indefinitely.
// That is intentional and acceptable: such a story lives in the curated feed for
// at most ~24h before it ages out, and the heal is idempotent (null of an already-
// null contentHash is a no-op). Real regression risk is the STALE case looping, not
// genuine past-official stories.  Document this explicitly:
check(
  hasUnsupportedStatusDescriptor('Former President Obama signed', emptySource) === true,
  'genuine-former story: still detected by empty-oracle scan on each boot (expected; row ages out within 24h)',
);
// Crucially: stripStaleStatusDescriptors with real source PRESERVES it — confirming
// the write-time sanitizer restores "Former" correctly on re-synthesis.
check(
  stripStaleStatusDescriptors('Former President Obama signed the climate accord.', [
    'Former President Obama signed the climate accord in 2015.',
  ]) === 'Former President Obama signed the climate accord.',
  'genuine-former preserved by write-time sanitizer (source supports it)',
);

// ── One-sentence summary path (generateOneSentenceSummary write-time sanitizer)
// The summary generator now wires the sanitizer using title + articleText as
// the source oracle.  These tests verify the sanitizer behaves correctly for
// the summary-write chokepoint (pure helper call, no network needed).
console.log('Summary write-time sanitizer (generateOneSentenceSummary path):');

const summaryTitle = 'President Trump Signs Executive Order on Defense AI Policy';
const summaryArticleExcerpt = 'President Trump signed an executive order Monday directing the Department of Defense to accelerate AI development. The order was described by National Security Advisor Waltz as "a critical step."';

// Simulate AI generating a stale summary — sanitizer must strip "Former".
const staleSummary = 'Former President Trump signed an executive order directing the Pentagon to accelerate AI development under new guidelines.';
const cleanedSummary = stripStaleStatusDescriptors(staleSummary, [summaryTitle, summaryArticleExcerpt]);
check(
  !cleanedSummary.includes('Former President Trump'),
  'summary path: "Former President Trump" stripped when article says "President Trump"',
);
check(
  cleanedSummary.includes('President Trump'),
  'summary path: "President Trump" preserved after stripping "Former"',
);

// AI correctly mirrors source — sanitizer must NOT alter the output.
const correctSummary = 'President Trump signed an executive order directing the Pentagon to accelerate AI development under new guidelines.';
check(
  stripStaleStatusDescriptors(correctSummary, [summaryTitle, summaryArticleExcerpt]) === correctSummary,
  'summary path: correctly mirrored summary left unchanged by sanitizer',
);

// Source-supported "former" in a summary about a past official must be preserved.
const pastOfficialTitle = 'Former SecDef Mattis Testifies Before Senate Armed Services Committee';
const pastOfficialArticle = 'Former Defense Secretary James Mattis testified before the Senate Armed Services Committee on Wednesday, offering a pointed critique of current Pentagon strategy.';
const pastOfficialSummary = 'Former Defense Secretary Mattis testified before the Senate committee, criticizing current Pentagon strategy as inadequate.';
check(
  stripStaleStatusDescriptors(pastOfficialSummary, [pastOfficialTitle, pastOfficialArticle]) === pastOfficialSummary,
  'summary path: "Former Defense Secretary Mattis" preserved when article genuinely uses it',
);

// ── Final result ─────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll stale-status-sanitizer checks passed');
process.exit(0);
