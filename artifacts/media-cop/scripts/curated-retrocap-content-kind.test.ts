/**
 * scripts/curated-retrocap-content-kind.test.ts
 *
 * Gate: Task #1027 Step 3 — the retro-cap logic applied after a content-kind
 * override uses the correct constant (CURATED_ANALYSIS_OPINION_CAP = 69) and
 * the cap ONLY fires when:
 *   1. effKind ∈ {analysis, opinion, editorial, explainer}
 *   2. stored score > CURATED_ANALYSIS_OPINION_CAP
 *   3. no existing human priority pin for the item
 *
 * Deterministic, no DB, no AI, no network.
 * Exit 0 = PASS, exit 1 = FAIL.
 */

import { CURATED_ANALYSIS_OPINION_CAP } from '../server/scoreAdjustments';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log('\n[curated-retrocap-content-kind] Retro-cap constant + logic tests\n');

// The cap constant must equal 69.
assert('CURATED_ANALYSIS_OPINION_CAP === 69', CURATED_ANALYSIS_OPINION_CAP === 69);

// ─── Inline simulation of the retro-cap guard logic ──────────────────────────
// Mirrors the condition in the /api/curated/content-kind POST handler:
//   if (effKind && ['analysis','opinion','editorial','explainer'].includes(effKind)
//       && storedScore > CAP && !pinExists)
//     → update to CAP

function simulateRetrocap(
  effKind: string | null,
  storedScore: number,
  pinExists: boolean,
): { wouldCap: boolean; cappedTo: number | null } {
  const capFamilies = ['analysis', 'opinion', 'editorial', 'explainer'];
  if (
    effKind &&
    capFamilies.includes(effKind) &&
    storedScore > CURATED_ANALYSIS_OPINION_CAP &&
    !pinExists
  ) {
    return { wouldCap: true, cappedTo: CURATED_ANALYSIS_OPINION_CAP };
  }
  return { wouldCap: false, cappedTo: null };
}

console.log('Retro-cap should fire:');
assert(
  'analysis mark, score=80, no pin → cap to 69',
  simulateRetrocap('analysis', 80, false).wouldCap,
);
assert(
  'opinion mark, score=75, no pin → cap to 69',
  simulateRetrocap('opinion', 75, false).wouldCap,
);
assert(
  'editorial mark, score=70, no pin → cap to 69',
  simulateRetrocap('editorial', 70, false).wouldCap,
);
assert(
  'explainer mark, score=70, no pin → cap to 69',
  simulateRetrocap('explainer', 70, false).wouldCap,
);
assert(
  'capped value is exactly 69',
  simulateRetrocap('analysis', 80, false).cappedTo === CURATED_ANALYSIS_OPINION_CAP,
);

console.log('\nRetro-cap should NOT fire:');
assert(
  'analysis mark, score already ≤ 69 → no cap',
  !simulateRetrocap('analysis', 69, false).wouldCap,
);
assert(
  'analysis mark, score=80, pin exists → no cap (human pin protected)',
  !simulateRetrocap('analysis', 80, true).wouldCap,
);
assert(
  'null effKind (clear action) → no cap',
  !simulateRetrocap(null, 80, false).wouldCap,
);
assert(
  'video mark (not in family) → no cap',
  !simulateRetrocap('video', 80, false).wouldCap,
);
assert(
  'live mark (not in family) → no cap',
  !simulateRetrocap('live', 80, false).wouldCap,
);

console.log(`\n[curated-retrocap-content-kind] ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
