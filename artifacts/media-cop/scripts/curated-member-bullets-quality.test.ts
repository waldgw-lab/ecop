// =============================================================================
// GATE: member-bullet quality — vacuous attribution, date-restatement, and
// editorial/spin phrasing detection (server/metaFiller.ts).
//
// Regression coverage for two new pattern families added to isMetaFillerLine:
//
// FAMILY 4 — Vacuous attribution + date-restatement:
//   The per-article summarizer sometimes pads a bullet with meta-commentary
//   about when/where the source article was published, or a bare "comes from
//   sources" assertion.  Examples from production:
//     "This directive comes from sources, with the article published on July 16."
//     "The article was published on Monday."
//     "The information comes from the article."
//
// FAMILY 5 — Editorial / spin phrasing in key-fact bullets:
//   The AI occasionally writes editorial assessments as neutral fact bullets,
//   e.g. "Chaos and confusion bring US no closer to resolution on Strait of
//   Hormuz."  These are spin (they characterize a situation without citing an
//   actor) and must not appear as neutral key facts.
//   The detection is gated on the ABSENCE of an attribution marker so attributed
//   editorial quotes ("Officials said the chaos brought them no closer to a deal")
//   are never filtered.
//
// FALSE-POSITIVE DISCIPLINE:
//   Real news that mentions "article" in non-meta contexts, attribution markers
//   that protect editorial-sounding lines, and neutral "no closer" framing with
//   a neutral (non-evaluative) subject must never be flagged.
//
// Pure test — no DB, no AI, no network. Exit 0 = pass, 1 = fail.
// =============================================================================
import {
  filterExplicitlyAttributedClaims,
  hasExplicitClaimAttribution,
  hasUnattributedSourceDependentAssertion,
  isMetaFillerLine,
  stripMetaFillerLines,
} from '../server/metaFiller';
import {
  buildAttributedClaimsSystemPrompt,
  buildSummaryBulletsSystemPrompt,
} from '../server/streamPrefetch';

let failures = 0;
function check(cond: boolean, label: string) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

// ── FAMILY 4: Vacuous attribution + date-restatement ─────────────────────────

console.log('\nFamily 4 positives (date-restatement / vacuous attribution → MUST be flagged):');

const dateRestatementPositives = [
  // Core example from production (task description):
  'This directive comes from sources, with the article published on July 16, 2026.',
  // Variants of the date-restatement clause:
  'The article was published on Monday.',
  'The article is published on July 16.',
  'The article has been published on July 16, 2026.',
  // Compound sentence containing the trailing date clause:
  'Defense officials announced new sanctions, with the article published on Thursday.',
  'Talks continued through the weekend, with the article published on Sunday.',
  // Content-free "comes from" source attribution:
  'This directive comes from sources.',
  'The information comes from the article.',
  'This content comes from a news report.',
  'The report comes from the article.',
  'This data comes from the article.',
];

for (const line of dateRestatementPositives) {
  check(isMetaFillerLine(line), `flagged: "${line.slice(0, 90)}"`);
}

// ── FAMILY 4: False-positive traps ───────────────────────────────────────────

console.log('\nFamily 4 negatives (real news → must NOT be flagged):');

const dateRestatementNegatives = [
  // "published on" but referring to a BILL / LAW / DOCUMENT (not "the article"):
  'The legislation was published on Tuesday in the Federal Register.',
  'The executive order was published on Friday.',
  'The guidance document was published on Thursday by the DoD.',
  // "article" as a treaty / law article, not the source document:
  'Article 5 of the treaty was published on Monday by the UN.',
  'Article 2 was published on the NATO website.',
  // NATO / policy funding (not "comes from" the summarized material):
  'NATO funding comes from member states based on GDP contributions.',
  'The airlift comes from storage depots in Germany.',
  'Munitions come from U.S. stockpiles in Europe.',
  // Real bullets where "article" appears in a non-meta context:
  'The article of impeachment was introduced in the House on Tuesday.',
  'Article IV of the constitution does not grant executive privilege.',
  // Attribution without date filler:
  'Officials confirmed that the sanctions would take effect immediately.',
  'Iran launched a series of ballistic missiles at Israeli territory.',
];

for (const line of dateRestatementNegatives) {
  check(!isMetaFillerLine(line), `not flagged: "${line.slice(0, 90)}"`);
}

// ── FAMILY 5: Editorial / spin phrasing ──────────────────────────────────────

console.log('\nFamily 5 positives (editorial spin without attribution → MUST be flagged):');

const spinPositives = [
  // Core example from task description:
  'Chaos and confusion bring US no closer to resolution on Strait of Hormuz.',
  // Close variants:
  'Chaos and confusion bring the parties no closer to agreement.',
  'Chaos and confusion brings Washington no closer to a deal.',
  'Confusion and chaos bring Congress no closer to a resolution.',
  // Other evaluative opener + editorial outcome:
  'Gridlock and dysfunction bring diplomats no closer to a ceasefire.',
  'Stalemate brings the administration no closer to a solution.',
  'Deadlock brings negotiations no closer to compromise.',
  // Evaluative opener + "no closer to" via "bringing":
  'Chaos and confusion are bringing the US no closer to peace.',
];

for (const line of spinPositives) {
  check(isMetaFillerLine(line), `flagged: "${line.slice(0, 90)}"`);
}

// ── FAMILY 5: False-positive traps ───────────────────────────────────────────

console.log('\nFamily 5 negatives (attributed or neutral → must NOT be flagged):');

const spinNegatives = [
  // Same framing but ATTRIBUTED — the attribution marker protects the line:
  'Officials said the chaos brought the parties no closer to agreement.',
  'Diplomats acknowledged that confusion brings the two sides no closer to a deal.',
  'Analysts say the gridlock brings Congress no closer to a solution, according to reports.',
  'According to negotiators, the talks brought both sides no closer to resolution.',
  'The ceasefire talks have brought the parties no closer to agreement, officials said.',
  // Neutral subject (not an evaluative characterization) + "no closer to":
  'The talks brought both sides no closer to an agreement.',
  'Negotiations have brought Iran and the US no closer to a deal.',
  'The summit brought both leaders no closer to a resolution.',
  // "chaos" / "confusion" as OBJECTS (not subject), not editorial opener:
  'Officials warned that the chaos could bring the region no closer to stability.',
  'The ceasefire collapsed amid confusion, according to witnesses.',
  // Real bullets that mention chaos/confusion in a factual context:
  'Chaos erupted in the streets following the announcement of the ceasefire collapse.',
  'Confusion over the ceasefire terms was noted by UN observers on the ground.',
  // Editorial-sounding but ATTRIBUTED:
  'Critics said the policy brings the country no closer to energy independence.',
  'Analysts noted that the deadlock brings NATO no closer to a consensus.',
  // "closer to" in a non-editorial context:
  'The two sides moved closer to agreement after overnight talks.',
  'Negotiators said they were closer to a deal than at any previous round.',
  // Other real bullets:
  'Iran launched over 300 drones and missiles at Israel in the overnight attack.',
  'NATO members agreed to raise defense spending to 5 percent of GDP.',
  'The strikes targeted Houthi radar sites in western Yemen.',
];

for (const line of spinNegatives) {
  check(!isMetaFillerLine(line), `not flagged: "${line.slice(0, 90)}"`);
}

// ── stripMetaFillerLines integration ─────────────────────────────────────────

console.log('\nstripMetaFillerLines integration (new families):');

// Date-restatement stripped from a mixed array:
const mixedDateRestatement = [
  'The US imposed new sanctions on Iran effective immediately.',
  'This directive comes from sources, with the article published on July 16, 2026.',
  'The Pentagon confirmed the deployment of additional assets to the region.',
];
const strippedDateRestatement = stripMetaFillerLines(mixedDateRestatement);
check(
  strippedDateRestatement.length === 2 &&
    strippedDateRestatement[0] === mixedDateRestatement[0] &&
    strippedDateRestatement[1] === mixedDateRestatement[2],
  'date-restatement bullet stripped, real bullets preserved',
);

// All-filler date-restatement array:
check(
  stripMetaFillerLines([
    'The article was published on Monday.',
    'This directive comes from sources.',
  ]).length === 0,
  'all-date-restatement array strips to empty',
);

// Spin bullet stripped from a mixed array:
const mixedSpin = [
  'US and Iranian diplomats met in Muscat for indirect talks on the nuclear file.',
  'Chaos and confusion bring US no closer to resolution on Strait of Hormuz.',
  'Tehran reiterated its demand for sanctions relief before any enrichment cap.',
];
const strippedSpin = stripMetaFillerLines(mixedSpin);
check(
  strippedSpin.length === 2 &&
    strippedSpin[0] === mixedSpin[0] &&
    strippedSpin[1] === mixedSpin[2],
  'spin/editorial bullet stripped, real bullets preserved',
);

// All-spin array:
check(
  stripMetaFillerLines([
    'Chaos and confusion bring US no closer to resolution on Strait of Hormuz.',
    'Gridlock and dysfunction bring diplomats no closer to a ceasefire.',
  ]).length === 0,
  'all-spin array strips to empty',
);

// Attributed "editorial" line is kept (attribution guard):
check(
  stripMetaFillerLines([
    'Officials said the chaos brought the parties no closer to agreement.',
  ]).length === 1,
  'attributed "no closer to" line is kept (attribution guard)',
);

// Real bullets survive intact:
const realBullets = [
  'Iran launched over 300 drones and missiles at Israel.',
  'NATO members agreed to raise defense spending to 5 percent of GDP.',
  'The strikes targeted Houthi radar sites in western Yemen.',
];
check(
  stripMetaFillerLines(realBullets).length === 3,
  'real bullets array passes through unchanged',
);

// ── Single-source evidence prompt contract ───────────────────────────────────
console.log('\nSingle-source evidence prompt contract:');
const defaultBulletPrompt = buildSummaryBulletsSystemPrompt('2026-08-04');
const bulletPrompt = buildSummaryBulletsSystemPrompt('2026-08-04', 'curated-evidence');
const claimPrompt = buildAttributedClaimsSystemPrompt('2026-08-04');

check(
  /big change or announcement/i.test(defaultBulletPrompt) &&
    /background context/i.test(defaultBulletPrompt) &&
    !/separate attributed-claims section/i.test(defaultBulletPrompt),
  'default main-feed bullets retain announcements and context without assuming a visible claims section',
);
check(
  /events or actions, measurements or quantities, locations, timing, and scope/i.test(bulletPrompt),
  'bullets prioritize concrete events, measurements, locations, timing, and scope',
);
check(
  /stated cause or motive, forecast, prediction/i.test(bulletPrompt) &&
    /separate attributed-claims section/i.test(bulletPrompt),
  'causal survey interpretations and forecasts are routed out of fact bullets',
);
check(
  /speaker, agency, document, or unnamed-source class/i.test(claimPrompt) &&
    /never when it merely carries another actor's words/i.test(claimPrompt),
  'claims name their underlying originator rather than the carrier outlet',
);
check(
  /claims must add information beyond/i.test(claimPrompt) &&
    /do not repeat a bullet/i.test(claimPrompt),
  'single-source facts and claims are complementary',
);
check(
  /EVERY LINE MUST BE SELF-CONTAINED AND VISIBLY ATTRIBUTED/.test(claimPrompt) &&
    /claim-section label is not a substitute for attribution/i.test(claimPrompt),
  'claim lines require visible in-sentence attribution',
);
check(
  /unnamed officials/i.test(bulletPrompt) &&
    /depleted nearly all long-range missiles/i.test(bulletPrompt) &&
    /raises concerns about readiness/i.test(bulletPrompt),
  'missile-depletion estimates and readiness concerns are routed to attributed claims',
);

console.log('\nExplicit attributed-claim output guard:');
const clearMissileClaims = [
  'Three U.S. officials told Reuters that the military used nearly all ATACMS and PrSM missiles.',
  'Pentagon analysts warned that depleted inventories could reduce readiness for another major conflict.',
  'The White House said U.S. munitions remain sufficient and production has increased.',
  'According to two defense officials, replenishing the inventories could take several years.',
  'President Trump accused Iran of delaying negotiations.',
  'The defense minister urged allies to increase production.',
  'Reuters, citing two defense officials, reported that inventories were nearly exhausted.',
  'The estimate was assessed by Pentagon analysts as a readiness risk.',
  'Sources say the military used nearly all available long-range missiles.',
  '"The inventories are nearly exhausted," officials said.',
  '"The inventories are nearly exhausted," said three U.S. officials.',
  'Inventories are nearly exhausted, according to three U.S. officials.',
  'The Government Accountability Office reports that replenishment will take several years.',
];
for (const line of clearMissileClaims) {
  check(hasExplicitClaimAttribution(line), `keeps clear attribution: "${line}"`);
}

const unclearMissileClaims = [
  'The U.S. has depleted nearly all of its long-range precision missiles.',
  'The depletion raises concerns about U.S. readiness for future conflicts.',
  'It is reported that missile inventories are nearly exhausted.',
  'The article says the United States has sufficient munitions.',
  'Reported estimates show that inventories are nearly exhausted.',
  'The assessment warned of a serious readiness risk.',
  'It was assessed that inventories could not sustain another conflict.',
  'President Trump discussed readiness, the assessment warned of a serious risk.',
  '"Inventories are nearly exhausted," it was reported.',
  'The depletion suggested Russia was weakened.',
  'It reported Iran had launched missiles.',
  'The assessment warned Beijing of escalation.',
  'Growth is projected to slow next year.',
];
for (const line of unclearMissileClaims) {
  check(!hasExplicitClaimAttribution(line), `rejects unclear attribution: "${line}"`);
}
check(
  filterExplicitlyAttributedClaims([...unclearMissileClaims, ...clearMissileClaims]).length ===
    clearMissileClaims.length,
  'write-time claim filter fails closed on unattributed assertions',
);
check(
  hasUnattributedSourceDependentAssertion(
    'The U.S. has used virtually all of its long-range precision missiles.',
  ) &&
    hasUnattributedSourceDependentAssertion(
      'The depletion raises concerns about U.S. readiness for future conflicts.',
    ) &&
    !hasUnattributedSourceDependentAssertion(
      'Three U.S. officials told Reuters that the military used virtually all long-range missiles.',
    ) &&
    !hasUnattributedSourceDependentAssertion('May Day protests draw thousands') &&
    !hasUnattributedSourceDependentAssertion('New law aims to curb emissions by 2030') &&
    !hasUnattributedSourceDependentAssertion('Storm expected to make landfall Friday') &&
    hasUnattributedSourceDependentAssertion('The strike suggests that Iran will retaliate.') &&
    hasUnattributedSourceDependentAssertion('Growth is projected to slow next year.') &&
    hasUnattributedSourceDependentAssertion('The strike may signal wider escalation.') &&
    hasUnattributedSourceDependentAssertion('The move aims to pressure Tehran.') &&
    hasUnattributedSourceDependentAssertion('The war is expected to continue.') &&
    hasUnattributedSourceDependentAssertion('The attack was designed to weaken defenses.') &&
    hasUnattributedSourceDependentAssertion('The raid raises risk of retaliation.') &&
    !hasUnattributedSourceDependentAssertion('Officials said the move aims to pressure Tehran.') &&
    !hasUnattributedSourceDependentAssertion('The strike hit radar sites in western Yemen.') &&
    !hasUnattributedSourceDependentAssertion('The ministry announced talks Friday.') &&
    !hasUnattributedSourceDependentAssertion('Three sites lost power.'),
  'source-dependent headline/lede guard requires visible attribution',
);

// ── Final summary ─────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll member-bullet quality checks passed');
process.exit(0);
