/**
 * scripts/curated-entertainment-cap.test.ts
 *
 * Gate: Task #1027 Step 1 — three new soft-cap rule families (entertainment /
 * TV listicles, publishing / memoir, consumer-brand incidents) are registered
 * and fire correctly.  Purely deterministic — no DB, no AI, no network.
 *
 * Exit 0 = PASS, exit 1 = FAIL.
 */

import { evalCuratedSoftCap } from '../server/scoreAdjustments';

// evalCuratedSoftCap(title, category, score) → { score, reason }

let passed = 0;
let failed = 0;

function check(label: string, title: string, inputScore: number, expectCapped: boolean) {
  const result = evalCuratedSoftCap(title, null, inputScore);
  const capFired = result.reason !== null;
  const scoreCorrect = expectCapped ? result.score === 49 : result.score === inputScore;
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

console.log('\n[curated-entertainment-cap] Soft-cap rule family regression tests\n');

// ─── Entertainment / TV listicle family ──────────────────────────────────────
console.log('Entertainment / TV listicle:');
// Ranked + TV shows — explicit combo trigger
check('ranked TV shows', 'Ranked: all-time best TV shows of the decade', 71, true);
// Netflix platform listing
check('Netflix shows lineup', 'Netflix new shows lineup for October 2024', 65, true);
// "What to watch" trigger
check('what to watch', 'What to watch on streaming this weekend', 72, true);

// ─── Publishing / memoir family ───────────────────────────────────────────────
console.log('\nPublishing / memoir:');
// Bare memoir keyword (no strategic guard terms)
check('actor memoir', "Actor's memoir reveals secrets from Hollywood career", 68, true);
// Book deal announcement
check('book deal', 'Reality star signs six-figure book deal with publisher', 72, true);
// Celebrity bestseller
check('celebrity bestseller', 'Celebrity chef lands on bestseller list with new cookbook', 65, true);

// ─── Consumer-brand incident family ──────────────────────────────────────────
console.log('\nConsumer-brand incidents:');
// Baby product recall with safety signal
check('baby product recall', 'Baby product recall issued over choking hazard safety risk', 66, true);
// Toy recall
check('toy recall', 'Toy recall for children\'s product safety hazard announced', 70, true);

// ─── Strategic / national-security stories must NOT be capped ─────────────────
console.log('\nStrategic / national-security (must not cap):');
check('Pentagon AI brief', 'Pentagon briefs Congress on AI defense strategy', 75, false);
check('Boeing defense contract', 'Boeing wins $2B Air Force contract for next-gen fighter', 74, false);
check('NATO summit', 'NATO summit focuses on nuclear deterrence and alliance commitments', 80, false);

// ─── Already-at-or-below cap — score unchanged ────────────────────────────────
console.log('\nBelow-cap score stays unchanged:');
{
  const res = evalCuratedSoftCap("Actor's memoir reveals Hollywood secrets", null, 30);
  // Still fires the reason (cap fires), but score cannot drop below input=30
  if (res.score === 30) {
    console.log(`  ✓ score 30 memoir: stays 30 (already below cap constant 49)`);
    passed++;
  } else {
    console.error(`  ✗ score 30 memoir → unexpected score=${res.score}`);
    failed++;
  }
}

console.log(`\n[curated-entertainment-cap] ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
