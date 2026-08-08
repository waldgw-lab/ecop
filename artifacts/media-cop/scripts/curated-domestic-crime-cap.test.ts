/**
 * scripts/curated-domestic-crime-cap.test.ts
 *
 * Gate: Task #1027 Step 4 — evalCuratedDomesticCrimeCap fires at ≤60 for
 * domestic-crime/partisan-politics headlines while exempting national-security
 * anchors. Deterministic — no DB, no AI, no network.
 *
 * Exit 0 = PASS, exit 1 = FAIL.
 */

import { evalCuratedDomesticCrimeCap } from '../server/scoreAdjustments';
const CRIME_CAP = 60;

let passed = 0;
let failed = 0;

function assert(label: string, title: string, input: number, expectCapped: boolean) {
  const result = evalCuratedDomesticCrimeCap(title, input);
  const capFired = result.reason !== null;
  const scoreCorrect = expectCapped ? result.score === CRIME_CAP : result.score === input;
  if (scoreCorrect && capFired === expectCapped) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(
      `  ✗ ${label}\n    title: "${title}"\n    expected capped=${expectCapped}, got score=${result.score} reason=${JSON.stringify(result.reason)}`,
    );
    failed++;
  }
}

console.log('\n[curated-domestic-crime-cap] Domestic crime / partisan politics cap tests\n');

// ─── Should cap ──────────────────────────────────────────────────────────────
console.log('Should cap (input > 60):');
// Murder trial → pattern: murder trial
assert('murder trial', 'Jury begins deliberations in celebrity murder trial', 72, true);
// Conviction → pattern: convicted
assert('conviction', 'Reality TV star convicted on fraud and tax evasion charges', 74, true);
// Drug trafficking sentence → matches "drug trafficking...sentence"
assert('drug trafficking sentence', 'Drug trafficking kingpin sentenced to 30 years in federal prison', 68, true);
// Partisan politics: attack on a named politician
assert('partisan attack Biden', 'Democrats slam Biden\'s border policy as a failure', 68, true);
assert('partisan slam Trump', 'Republicans slam Trump\'s budget plan as fiscally irresponsible', 65, true);

// ─── Should NOT cap — national-security / military exemptions ─────────────────
console.log('\nShould NOT cap (national-security anchor):');
// Contains "terror" — guard fires
assert('terror investigation', 'FBI terrorism investigation nets five arrests across three states', 80, false);
// Contains "espionage" — guard fires
assert('espionage charges', 'Pentagon official charged with espionage for passing secrets to China', 85, false);
// Contains "nuclear" — guard fires
assert('nuclear material theft', 'Drug suspect linked to nuclear material theft investigation', 77, false);
// Contains "cartel" — guard fires
assert('cartel', 'Drug trafficking cartel leader faces extradition charges', 75, false);

// ─── Should NOT cap — war-crimes / international-tribunal coverage ──────────
console.log('\nShould NOT cap (war-crimes / tribunal — Task #1072):');
// "warlord" guard token (\bwar\b does NOT match "warlord") + "convicts"
assert('ICC convicts warlord', 'ICC convicts warlord of crimes against humanity in landmark ruling', 82, false);
// "tribunal" guard token + "sentenced"
assert('UN tribunal sentences', 'UN tribunal sentences former commander to 25 years for atrocities', 80, false);
// "war crimes" — \bwar\b guard token + "found guilty"
assert('war crimes verdict', 'Former militia leader found guilty of war crimes by international court', 78, false);
// "genocide" guard token + "on trial"
assert('genocide trial', 'Ex-president goes on trial for genocide at The Hague', 84, false);
// "hague" guard token + "indicted for"
assert('Hague indictment', 'Hague prosecutors announce leader indicted for crimes against humanity', 79, false);
// "icc" guard token + "pleaded guilty"
assert('ICC guilty plea', 'Militia chief pleaded guilty before the ICC to mass atrocities', 76, false);
// "ethnic cleansing" guard token + "convicted"
assert('ethnic cleansing conviction', 'General convicted over ethnic cleansing campaign, tribunal rules', 81, false);
// "international criminal court" spelled out + "sentenced"
assert('int criminal court', 'International Criminal Court sentences rebel leader for child-soldier crimes', 83, false);

// ─── Already at-or-below cap — no change ─────────────────────────────────────
console.log('\nAlready at or below cap:');
assert('score exactly 60', 'Celebrity murder trial begins in Los Angeles court', 60, false);
assert('score below cap', 'Convicted thief sentenced to community service', 45, false);

console.log(`\n[curated-domestic-crime-cap] ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
