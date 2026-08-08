// =============================================================================
// GATE: meta-filler bullet detection (server/metaFiller.ts).
//
// The per-article summarizer used to pad thin excerpts with meta-commentary
// bullets ("The article does not provide further details…", "…not specified in
// the excerpt") that were stored and rendered as curated summary bullets /
// synthesis facts. isMetaFillerLine must catch those — while NEVER flagging
// genuine defense-news reporting where a PERSON, INSTITUTION, or COVERED
// DOCUMENT declines to give detail (attributed lines are real content; see the
// AI-refusal false-positive memory: attributed "cannot provide" is news).
//
// Also covers the extended pattern families added to stop junk-page
// meta-commentary from reaching curated cards:
//   - empty-claims announcements ("No attributed claims were found…")
//   - junk-source descriptions ("The provided text is a browser compat notice")
//   - intervening-phrase "no further details" variants
//   - broader noun list (background context, supplemental information)
//
// Pure test — no DB, no AI, no network. Exit 0 = pass, 1 = fail.
// =============================================================================
import { isMetaFillerLine, stripMetaFillerLines } from '../server/metaFiller';

let failures = 0;
function check(cond: boolean, label: string) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

// ── Positives: filler observed in prod + close variants — MUST be flagged ───
const positives = [
  // Observed in prod curated rows (original families):
  'The article does not provide further details on the nature of the strikes or blockade.',
  'Previous US strikes on Iranian-linked targets mentioned, but specifics not specified in the excerpt.',
  'The article does not specify the exact locations targeted in the strikes.',
  'Further context on the ceasefire negotiations is not specified in the article.',
  // Variants the model produces (original families):
  'This article does not mention casualty figures.',
  'The excerpt does not include information about the timeline.',
  "The article doesn't elaborate on the weapons systems involved.",
  'The article did not identify the units participating in the exercise.',
  'The excerpt lacks further details on the diplomatic response.',
  'The article lacks specifics about the funding mechanism.',
  'No further details were provided in the article.',
  'No additional information was given in the excerpt.',
  'No further details provided in the excerpt.',
  'No additional context included in the article.',
  'Exact troop numbers were not mentioned in the article.',
  'The provided excerpt does not state when the deployment begins.',
  'The given article does not disclose the source of the intelligence.',
  "The article's excerpt does not contain background on prior talks.",
  // NEW: broader noun list (background context, supplemental information)
  'No supplemental information is available in the excerpt.',
  'No background context was provided in the article.',
  'No further background context was given in the excerpt.',
  // NEW: "available" as linking verb in trailing-reference
  'Casualty figures are not available in the article.',
  'The deployment timeline is not available in the excerpt.',
  // NEW: intervening phrase tolerated in "no further details" pattern
  'No further details on the reversal were provided in the excerpt.',
  'No additional information about the timeline was given in the article.',
  'No further context on the ceasefire terms was included in the excerpt.',
  // NEW: empty-claims announcement family
  'No attributed claims were found in the provided text.',
  'No attributed claims were extracted from the article.',
  'No clearly attributed claims were identified in the excerpt.',
  'No attributed claims were found.',
  'No attributed claims can be found.',
  'No clearly attributed claims were present in the article.',
  'This article contains no attributed claims.',
  'The excerpt does not contain any attributed claims.',
  'The article excerpt does not contain any clearly attributed claims.',
  'The provided text does not contain any attributed claims.',
  // NEW: junk-source description family
  'The provided text is a browser compatibility notice rather than a news article.',
  'The provided text appears to be a navigation menu rather than an article.',
  'The provided text is a browser compatibility message and not a news article.',
  'The given text is a browser compatibility notice.',
  'The provided text is a cookie consent notice.',
  'The provided content appears to be a navigation menu.',
  'The provided source material is a boilerplate footer.',
  'The provided text is in Persian and cannot be summarized.',
  'The provided text appears to be written in Arabic.',
  'The given excerpt is in Chinese.',
  // NEW: "provided text does not" — extended SUBJECT to include "provided/given text"
  'The provided text does not mention casualty figures.',
  'The given text does not specify the date of the incident.',
  'The provided text does not contain any news content.',
  // NEW: placeholder / stub / no-substantive-news-content family
  'The article is a placeholder and does not contain substantive news content.',
  'This article is a placeholder.',
  'This article is a stub.',
  'The provided text is a placeholder.',
  'The given text is a stub with no real news.',
  'This article is not a real news article.',
  'The article does not contain substantive news content.',
  'The article contains no substantive news content.',
  'This excerpt contains no substantive news content.',
  'The article is not a genuine news article.',
  'The article is a boilerplate page.',
  'The given text is a draft with no substantive content.',
  'There is no substantive news content in this article.',
  'The article is a placeholder page.',
];
console.log('Positives (meta-filler → must be flagged):');
for (const line of positives) {
  check(isMetaFillerLine(line), `flagged: "${line.slice(0, 80)}"`);
}

// ── Negatives: genuine news lines — must NEVER be flagged ───────────────────
const negatives = [
  // People/institutions declining detail = real reporting:
  'Officials did not provide further details on the strikes.',
  'The Pentagon said it cannot provide details about ongoing operations.',
  'The Defense Department declined to specify the number of troops involved.',
  'A senior official said further details were not available.',
  // A REPORT/DOCUMENT the article covers is content, not the summarized material:
  'The report does not name the officials involved in the decision.',
  'Casualty figures were not specified in the report.',
  'The text of the agreement does not specify enforcement mechanisms.',
  'The inspector general report did not identify the contractor.',
  'The indictment does not mention any co-conspirators.',
  // Ordinary substantive bullets:
  'Iran launched over 300 drones and missiles at Israel in the overnight attack.',
  'The strikes targeted Houthi radar sites in western Yemen.',
  'NATO members agreed to raise defense spending to 5 percent of GDP.',
  'An article of impeachment was filed in the House on Tuesday.',
  'The article of the treaty invoked by Poland requires consultations.',
  // FALSE-POSITIVE TRAPS for the empty-claims / junk-source new patterns:
  // "attributed" in a news context (source protection, attribution of an act):
  'The strike was attributed to a Special Operations Forces unit.',
  'The attack was attributed to Iran by U.S. intelligence officials.',
  'Israel has not publicly attributed responsibility for the strike.',
  // "I would need Article 5 assurances" — "Article" is a treaty article, not the summarized article:
  'NATO allies said they would need Article 5 assurances before committing forces.',
  // "source protection" — "source" is an anonymous source (not summarized material):
  'The journalist cited source protection as the reason for not naming the official.',
  // "no attributed claims" in a DIFFERENT grammatical position (embedded quote):
  'The committee found no attributed claims of wrongdoing in the redacted report.',
  // Bare "text" in a document context:
  'The text of the resolution does not include a timeline for withdrawal.',
  // FALSE-POSITIVE TRAPS for the new placeholder/substantive-content family:
  // "placeholder" in a real reporting context (bill/policy described as a placeholder):
  'The bill contains no substantive policy changes according to analysts.',
  'The budget proposal is widely seen as a placeholder until negotiations conclude.',
  'Critics described the agreement as a placeholder that could be renegotiated.',
  // "no substantive news content" PRECEDED by real attribution (the anchor check):
  'Senator Cruz argued the bill has no substantive news content but was passed anyway.',
  // Real reporting about a document/report that lacks something (not the AI describing fed material):
  'The draft resolution contains no substantive enforcement provisions.',
  // "article" as a treaty/law article (not the summarized material):
  'Article 5 does not contain substantive new obligations for allied nations.',
  // Real bullets about background context (not the AI saying context is absent):
  'Tensions have escalated over the past week following the assassination.',
  'The background context of the conflict dates to the 2003 invasion.',
  // Empty-ish inputs:
  '',
  '   ',
];
console.log('Negatives (real news / empty → must NOT be flagged):');
for (const line of negatives) {
  check(!isMetaFillerLine(line), `not flagged: "${(line || '(blank)').slice(0, 80)}"`);
}

// ── stripMetaFillerLines semantics ──────────────────────────────────────────
console.log('stripMetaFillerLines:');
const mixed = [
  'The strikes targeted Houthi radar sites in western Yemen.',
  'The article does not provide further details on the nature of the strikes.',
  'US officials confirmed no American casualties.',
];
const strippedMixed = stripMetaFillerLines(mixed);
check(
  strippedMixed.length === 2 &&
    strippedMixed[0] === mixed[0] &&
    strippedMixed[1] === mixed[2],
  'mixed array keeps real bullets in order, drops the filler line',
);
check(stripMetaFillerLines([
  'The article does not specify the location.',
  'No further details were provided in the article.',
]).length === 0, 'all-filler array strips to empty');
check(stripMetaFillerLines(null).length === 0, 'null input → empty array');
check(stripMetaFillerLines(undefined).length === 0, 'undefined input → empty array');
check(stripMetaFillerLines(['', '  ', 'Real bullet here.']).length === 1, 'blank lines dropped');
const untouched = ['Fact one.', 'Fact two.'];
check(
  stripMetaFillerLines(untouched).length === 2 && stripMetaFillerLines(untouched) !== untouched,
  'clean array survives intact (new array returned)',
);
// NEW: strips empty-claims announcements
check(
  stripMetaFillerLines(['No attributed claims were found in the provided text.']).length === 0,
  'empty-claims announcement stripped to empty array',
);
check(
  stripMetaFillerLines([
    'The Pentagon announced a new arms sale to Israel.',
    'No attributed claims were extracted from the article.',
    'The deal is valued at approximately $1.2 billion.',
  ]).length === 2,
  'empty-claims announcement stripped, real bullets preserved',
);
// NEW: strips junk-source descriptions
check(
  stripMetaFillerLines(['The provided text is a browser compatibility notice rather than a news article.']).length === 0,
  'junk-source description stripped to empty array',
);
// NEW: intervening-phrase variant
check(
  stripMetaFillerLines(['No further details on the ceasefire terms were provided in the excerpt.']).length === 0,
  'intervening-phrase "no further details" variant stripped',
);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll meta-filler detection checks passed');
process.exit(0);
