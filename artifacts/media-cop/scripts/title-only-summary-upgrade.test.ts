// =============================================================================
// GATE: title-only summary upgrade after late article recovery
// -----------------------------------------------------------------------------
// Deterministic unit tests of the two exported predicates from
// server/streamPrefetch.ts and write-path intent rules. No DB, no AI, no net.
//
// Invariants proven:
//   A) isSummaryUpgradeCandidate — explicit-marker semantics: NULL/empty =
//      no post-time text → candidate; ANY non-empty string = NOT candidate
//      (no length heuristic to avoid false-positive overwrites).
//   B) shouldUpgradeSummaryFromText — same eligibility + requires a substantive
//      regenerated summary; delegates to isSummaryUpgradeCandidate.
//   C) Write-path intent — verify the stamp/no-stamp decision rules that
//      cacheHeadlineMedia implements (gated on summaryUpgradeAttempted, not
//      just isCandidate, to prevent permanent retry loops):
//        • eligible + attempted + good summary → upgrade AND stamp done
//        • eligible + attempted + AI failed   → withhold stamp (retryable)
//        • eligible + NOT attempted           → stamp done (no retry loop)
//        • not eligible + any outcome         → no upgrade, stamp done normally
//        • manually-edited                    → never touched
//   D) shouldStampCuratedMediaDone — curated lane stamp predicate correctly
//      blocks when summaryUpgradeFailed is true.
//
// Exit 0 = all pass, exit 1 = failure.
// =============================================================================
import {
  isSummaryUpgradeCandidate,
  shouldUpgradeSummaryFromText,
  shouldStampCuratedMediaDone,
} from '../server/streamPrefetch';

let failures = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── A. isSummaryUpgradeCandidate — explicit-marker semantics ──────────────────
console.log('[title-only-summary-upgrade] A. isSummaryUpgradeCandidate predicate');

check(
  'fullText null → candidate (no post-time text)',
  isSummaryUpgradeCandidate({ manuallyEdited: false, storedFullText: null }),
);
check(
  'fullText undefined → candidate',
  isSummaryUpgradeCandidate({ manuallyEdited: false, storedFullText: undefined }),
);
check(
  'fullText empty string → candidate',
  isSummaryUpgradeCandidate({ manuallyEdited: false, storedFullText: '' }),
);
check(
  'fullText whitespace-only → candidate (trimmed is empty)',
  isSummaryUpgradeCandidate({ manuallyEdited: false, storedFullText: '   ' }),
);
// Any non-empty string means post-time text was intentionally stored — NOT a candidate.
// No length heuristic: even short strings prevent false-positive overwrites.
check(
  'fullText single char → NOT candidate (any non-empty = real text marker)',
  !isSummaryUpgradeCandidate({ manuallyEdited: false, storedFullText: 'X' }),
);
check(
  'fullText short stub ("Breaking.") → NOT candidate (non-empty = real text)',
  !isSummaryUpgradeCandidate({ manuallyEdited: false, storedFullText: 'Breaking.' }),
);
check(
  'fullText substantive → NOT candidate',
  !isSummaryUpgradeCandidate({ manuallyEdited: false, storedFullText: 'Senate Democrats blocked the NDAA as Schumer cited concerns over defense spending priorities and foreign policy riders.' }),
);
check(
  'manuallyEdited true + fullText null → NOT candidate (human edit protected)',
  !isSummaryUpgradeCandidate({ manuallyEdited: true, storedFullText: null }),
);
check(
  'manuallyEdited true + fullText non-empty → NOT candidate',
  !isSummaryUpgradeCandidate({ manuallyEdited: true, storedFullText: 'some text' }),
);

// ── B. shouldUpgradeSummaryFromText ──────────────────────────────────────────
console.log('\n[title-only-summary-upgrade] B. shouldUpgradeSummaryFromText predicate');

const GOOD_SUMMARY = 'Senate Democrats moved to block the NDAA over partisan rider concerns.';
const REAL_TEXT = 'Senate Majority Leader Chuck Schumer sharply criticized the National Defense Authorization Act on Tuesday, calling it a vehicle for partisan policy riders that have no place in must-pass legislation.';

check(
  'fullText null + good summary → upgrade',
  shouldUpgradeSummaryFromText({ manuallyEdited: false, storedFullText: null, regeneratedSummary: GOOD_SUMMARY }),
);
check(
  'fullText empty + good summary → upgrade',
  shouldUpgradeSummaryFromText({ manuallyEdited: false, storedFullText: '', regeneratedSummary: GOOD_SUMMARY }),
);
check(
  'manuallyEdited true → NO upgrade',
  !shouldUpgradeSummaryFromText({ manuallyEdited: true, storedFullText: null, regeneratedSummary: GOOD_SUMMARY }),
);
check(
  'regeneratedSummary null → NO upgrade (old summary stays)',
  !shouldUpgradeSummaryFromText({ manuallyEdited: false, storedFullText: null, regeneratedSummary: null }),
);
check(
  'regeneratedSummary empty → NO upgrade',
  !shouldUpgradeSummaryFromText({ manuallyEdited: false, storedFullText: null, regeneratedSummary: '' }),
);
check(
  'regeneratedSummary ≤10 chars → NO upgrade',
  !shouldUpgradeSummaryFromText({ manuallyEdited: false, storedFullText: null, regeneratedSummary: 'Short.' }),
);
check(
  'fullText non-empty (any real post-time text) → NO upgrade',
  !shouldUpgradeSummaryFromText({ manuallyEdited: false, storedFullText: REAL_TEXT, regeneratedSummary: GOOD_SUMMARY }),
);
check(
  'fullText short-but-real ("Breaking.") → NO upgrade (explicit-marker semantics)',
  !shouldUpgradeSummaryFromText({ manuallyEdited: false, storedFullText: 'Breaking.', regeneratedSummary: GOOD_SUMMARY }),
  'any non-empty storedFullText prevents upgrade regardless of length',
);

// ── C. Write-path intent rules ────────────────────────────────────────────────
// These test the DECISION RULES cacheHeadlineMedia implements:
//   upgradeSummary = shouldUpgradeSummaryFromText(...)
//   shouldStamp = !summaryUpgradeAttempted || !!regeneratedSummary
//
// Key: stamp is gated on ATTEMPTED-AND-FAILED, not merely IS-CANDIDATE.
// This prevents permanent retry loops on candidate rows where the enrichment
// pass didn't qualify for an upgrade attempt (e.g., no bullets generated).
console.log('\n[title-only-summary-upgrade] C. Write-path intent rules (main lane)');

function mainLaneWriteIntent(opts: {
  manuallyEdited: boolean;
  storedFullText: string | null | undefined;
  regeneratedSummary: string | null | undefined;
  summaryUpgradeAttempted: boolean;
}): { shouldUpgrade: boolean; shouldStamp: boolean } {
  const shouldUpgrade = shouldUpgradeSummaryFromText({
    manuallyEdited: opts.manuallyEdited,
    storedFullText: opts.storedFullText,
    regeneratedSummary: opts.regeneratedSummary,
  });
  // Mirror the exact logic in cacheHeadlineMedia:
  const shouldStamp = !opts.summaryUpgradeAttempted || !!opts.regeneratedSummary;
  return { shouldUpgrade, shouldStamp };
}

// 1. Eligible candidate + attempted + good summary → upgrade + stamp done
{
  const r = mainLaneWriteIntent({ manuallyEdited: false, storedFullText: null, regeneratedSummary: GOOD_SUMMARY, summaryUpgradeAttempted: true });
  check('candidate + attempted + good summary → upgrade=true', r.shouldUpgrade);
  check('candidate + attempted + good summary → stamp=true (row marked done)', r.shouldStamp);
}

// 2. Eligible candidate + attempted + AI failure → no upgrade + withhold stamp (retryable)
{
  const r = mainLaneWriteIntent({ manuallyEdited: false, storedFullText: null, regeneratedSummary: null, summaryUpgradeAttempted: true });
  check('candidate + attempted + AI failure → upgrade=false', !r.shouldUpgrade);
  check('candidate + attempted + AI failure → stamp=false (stays retryable)', !r.shouldStamp,
    'stamp must be withheld when upgrade was attempted but AI returned null');
}

// 3. Eligible candidate + NOT attempted this pass → no upgrade + stamp done (no retry loop)
{
  const r = mainLaneWriteIntent({ manuallyEdited: false, storedFullText: null, regeneratedSummary: null, summaryUpgradeAttempted: false });
  check('candidate + not-attempted → upgrade=false', !r.shouldUpgrade);
  check('candidate + not-attempted → stamp=true (no retry loop)', r.shouldStamp,
    'stamp must proceed normally when upgrade was never attempted — prevents permanent retry loop');
}

// 4. Not eligible (real post-time text) → no upgrade + stamp done normally
{
  const r = mainLaneWriteIntent({ manuallyEdited: false, storedFullText: REAL_TEXT, regeneratedSummary: GOOD_SUMMARY, summaryUpgradeAttempted: false });
  check('not-candidate (real text) → upgrade=false', !r.shouldUpgrade);
  check('not-candidate → stamp=true (not held back)', r.shouldStamp);
}

// 5. Manually edited → no upgrade + stamp done (human edit is sacred)
{
  const r = mainLaneWriteIntent({ manuallyEdited: true, storedFullText: null, regeneratedSummary: GOOD_SUMMARY, summaryUpgradeAttempted: false });
  check('manually-edited → upgrade=false', !r.shouldUpgrade);
  check('manually-edited → stamp=true (not held back)', r.shouldStamp);
}

// ── D. shouldStampCuratedMediaDone ───────────────────────────────────────────
console.log('\n[title-only-summary-upgrade] D. shouldStampCuratedMediaDone (curated lane)');

check(
  'realImage=true, noRefusal, noUpgradeFail → stamp done',
  shouldStampCuratedMediaDone(true, false, false),
);
check(
  'realImage=true, noRefusal, default arg → stamp done (back-compat)',
  shouldStampCuratedMediaDone(true, false),
);
check(
  'realImage=false → NOT done',
  !shouldStampCuratedMediaDone(false, false, false),
);
check(
  'hadRefusal=true → NOT done',
  !shouldStampCuratedMediaDone(true, true, false),
);
check(
  'summaryUpgradeFailed=true → NOT done (upgrade retry needed)',
  !shouldStampCuratedMediaDone(true, false, true),
  'curated row with pending upgrade must stay retryable',
);
check(
  'summaryUpgradeFailed=true + hadRefusal=true → NOT done',
  !shouldStampCuratedMediaDone(true, true, true),
);
check(
  'summaryUpgradeFailed=true + realImage=false → NOT done',
  !shouldStampCuratedMediaDone(false, false, true),
);
check(
  'upgradeNotAttempted → summaryUpgradeFailed=false → stamps done normally',
  shouldStampCuratedMediaDone(true, false, false),
);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`[title-only-summary-upgrade] ${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('[title-only-summary-upgrade] all tests PASSED');
  process.exit(0);
}
