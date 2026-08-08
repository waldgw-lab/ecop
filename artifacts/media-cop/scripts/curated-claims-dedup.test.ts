// =============================================================================
// GATE: curated-claims-dedup
//
// Verifies the deduplicateLines helper in server/metaFiller.ts correctly
// collapses near-identical lines (same-assertion rewordings, same-predicate
// subject-splits) while keeping genuinely distinct facts/claims, and that
// the isMetaFillerLine detector catches the new "placeholder / no substantive
// news content" family.
//
// Pure deterministic — no DB, no AI, no network. Exit 0 = pass, 1 = fail.
// =============================================================================
import {
  deduplicateLines,
  excludeNearDuplicateLines,
  isMetaFillerLine,
  stripMetaFillerLines,
} from '../server/metaFiller';

let failures = 0;
function check(cond: boolean, label: string) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

// ── deduplicateLines: near-identical removal ─────────────────────────────────
console.log('\ndeduplicateLines — same-assertion rewordings (must collapse):');

// Classic same-assertion near-duplicate: multiple lines that assert the same
// fact using largely the same words (high content-word overlap > 60%).
// Note: pure-synonym rewording ("take apart" vs "dismantle") has too little
// word overlap to cross the threshold; the function targets actual word-overlap
// near-dups and same-predicate subject-splits, not semantic similarity.
const rubioLines = [
  'Rubio announced he will dismantle PACE and end its funding immediately.',
  'Rubio announced he will end PACE funding and dismantle the program immediately.',
  'Rubio said he plans to dismantle PACE and cut its funding without delay.',
];
const rubioDeduped = deduplicateLines(rubioLines);
check(rubioDeduped.length < rubioLines.length, 'same-actor same-object near-duplicates collapsed');
check(rubioDeduped[0] === rubioLines[0], 'first line kept as primary');

// Same-predicate subject-split: one event → separate lines per person.
const attendLines = [
  'Vance attended the talks in Islamabad.',
  'Witkoff attended the talks in Islamabad.',
  'Sharif attended the talks in Islamabad.',
];
const attendDeduped = deduplicateLines(attendLines);
check(attendDeduped.length < attendLines.length, 'same-event same-predicate subject-split collapsed');
check(attendDeduped[0] === attendLines[0], 'first line kept as primary');

// Exact same sentence — always deduped.
const exactDup = [
  'Iran launched missiles at Israeli targets.',
  'Iran launched missiles at Israeli targets.',
];
const exactDeduped = deduplicateLines(exactDup);
check(exactDeduped.length === 1, 'exact duplicate collapsed to one');

console.log('\ndeduplicateLines — genuinely distinct lines (must be kept):');

// Distinct actors, distinct events — both kept.
const distinct1 = [
  'Iran launched over 300 missiles at Israel.',
  'Israel intercepted most of the incoming missiles.',
];
const distinct1Out = deduplicateLines(distinct1);
check(distinct1Out.length === 2, 'distinct actor/action pair: both kept');

// Corroborating but independent facts.
const distinct2 = [
  'The Pentagon confirmed no U.S. troops were involved.',
  'Israel declared a state of emergency in the northern districts.',
  'NATO allies were briefed on the situation within hours.',
];
const distinct2Out = deduplicateLines(distinct2);
check(distinct2Out.length === 3, 'three genuinely distinct facts: all kept');

// Short different statements.
const distinct3 = [
  'Rubio will dismantle PACE.',
  'Russia rejected the ceasefire proposal.',
];
const distinct3Out = deduplicateLines(distinct3);
check(distinct3Out.length === 2, 'two distinct actors/events: both kept');

// Empty input.
check(deduplicateLines([]).length === 0, 'empty array returns empty');
// Single item always kept.
check(deduplicateLines(['One fact.']).length === 1, 'single item kept');
// Short items (< 2 content words) always kept.
check(deduplicateLines(['Yes.', 'No.']).length === 2, 'short items kept (< 2 content words)');

console.log('\nexcludeNearDuplicateLines — facts/claims complementarity:');
const infrastructureFacts = [
  'The attack disrupted power at three substations in western Ukraine.',
  'Emergency crews restored service to two districts by morning.',
];
const infrastructureClaims = [
  'Ukraine said the attack disrupted power at three substations in western Ukraine.',
  'The security service attributed the infrastructure attack to a Russian military hacking unit.',
  'Officials warned repairs could take several days.',
];
const complementaryClaims = excludeNearDuplicateLines(infrastructureClaims, infrastructureFacts);
check(
  complementaryClaims.length === 2 &&
    !complementaryClaims.some((line) => line.includes('disrupted power at three substations')),
  'reported infrastructure-attack fact is not repeated as an attributed claim',
);
check(
  complementaryClaims.some((line) => line.includes('attributed the infrastructure attack')) &&
    complementaryClaims.some((line) => line.includes('repairs could take')),
  'distinct responsibility attribution and forecast remain as claims',
);

const disputedInfrastructureClaims = excludeNearDuplicateLines(
  ['Russia denied causing the power outage at three substations in western Ukraine.'],
  ['The attack caused a power outage at three substations in western Ukraine.'],
);
check(
  disputedInfrastructureClaims.length === 1,
  'high-overlap denial survives because it disputes rather than repeats the fact',
);

const repeatedDenials = excludeNearDuplicateLines(
  ['Russia denied causing the power outage at three substations in western Ukraine.'],
  ['Russia denied causing the power outage at three substations in western Ukraine.'],
);
check(
  repeatedDenials.length === 0,
  'same-stance duplicate denial is still removed',
);

const causalSurveyFacts = [
  'The survey measured recruitment shortfalls across 12 military occupations.',
];
const causalSurveyClaims = [
  'The survey measured recruitment shortfalls across 12 military occupations.',
  'Researchers said housing costs were the main cause of the recruiting decline.',
];
const causalSurveyOut = excludeNearDuplicateLines(causalSurveyClaims, causalSurveyFacts);
check(
  causalSurveyOut.length === 1 && causalSurveyOut[0].startsWith('Researchers said'),
  'causal survey explanation remains attributed while duplicate measurement is removed',
);

console.log('\ndeduplicateLines — order preservation:');
const ordered = [
  'NATO approved the new spending target.',
  'Member states will reach the goal by 2030.',
  'The United States pushed for the higher threshold.',
];
const orderedOut = deduplicateLines(ordered);
check(orderedOut.length === 3 && orderedOut[0] === ordered[0] && orderedOut[2] === ordered[2],
  'order preserved for distinct lines');

// ── isMetaFillerLine: new placeholder/substantive family ─────────────────────
console.log('\nisMetaFillerLine — new placeholder/substantive-content patterns (must be flagged):');

const placeholderPositives = [
  'The article is a placeholder and does not contain substantive news content.',
  'This article is a placeholder.',
  'The excerpt is a stub.',
  'This article is a stub with no real news.',
  'The article does not contain substantive news content.',
  'The article contains no substantive news content.',
  'This excerpt contains no substantive news content.',
  'The article is not a real news article.',
  'The article is not a genuine news article.',
  'The provided text is a placeholder.',
  'The given text is a draft.',
  'The article contains no substantive content.',
  'This article is a boilerplate.',
  'There is no substantive news content in this article.',
];
for (const line of placeholderPositives) {
  check(isMetaFillerLine(line), `flagged placeholder: "${line.slice(0, 70)}"`);
}

console.log('\nisMetaFillerLine — false-positive guards for placeholder family (must NOT be flagged):');

const placeholderNegatives = [
  // Real news about placeholder behavior in legislation / plans:
  'The bill contains no substantive policy changes according to analysts.',
  'The budget proposal is widely seen as a placeholder until negotiations conclude.',
  'Critics described the agreement as a placeholder that could be renegotiated.',
  // Real reporting about people/institutions:
  'Officials did not provide further details on the timeline.',
  'The Pentagon said it cannot provide details about ongoing operations.',
  // Normal news bullets:
  'Iran launched over 300 missiles at Israel.',
  'NATO agreed to raise defense spending to 5 percent of GDP.',
  'The strike targeted Houthi radar sites in western Yemen.',
  // Empty / whitespace:
  '',
  '   ',
];
for (const line of placeholderNegatives) {
  check(!isMetaFillerLine(line), `not flagged (real news/empty): "${(line || '(blank)').slice(0, 70)}"`);
}

// ── stripMetaFillerLines with new placeholder family ─────────────────────────
console.log('\nstripMetaFillerLines — strips new placeholder variants:');

const mixed = [
  'Secretary Rubio announced new Iran sanctions.',
  'The article is a placeholder and does not contain substantive news content.',
  'The measures target petrochemical exports.',
];
const strippedMixed = stripMetaFillerLines(mixed);
check(
  strippedMixed.length === 2 &&
    strippedMixed[0] === mixed[0] &&
    strippedMixed[1] === mixed[2],
  'placeholder line stripped, real bullets preserved',
);

check(
  stripMetaFillerLines(['This article is a placeholder.']).length === 0,
  'all-placeholder array strips to empty',
);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll curated-claims-dedup checks passed');
process.exit(0);
