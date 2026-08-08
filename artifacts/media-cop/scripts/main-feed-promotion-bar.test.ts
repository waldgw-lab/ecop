/**
 * Regression test for the main-feed auto-promotion bar (Task #522, pinned by
 * Task #523).
 *
 * The gate inside storage.finalizeSubmissionAnalysis decides whether an
 * AUTOMATED bot/RSS/reviewed news submission is promoted out of Team-chat-only
 * and onto the main MCOP/Classic/Visual/Warfighter feed. Task #522 lowered that
 * bar from a hard-coded `>= 66` to the rubric's MODERATE floor
 * (MAIN_FEED_PROMOTION_THRESHOLD = 50). There was no deterministic test pinning
 * this, so a future refactor could silently move the bar — or, worse,
 * re-conflate it with the SEPARATE, stricter FLASH "TOP STORIES" bar
 * (FLASH_PRIORITY_THRESHOLD = 66).
 *
 * This test exercises the two PURE predicates that now back both gates:
 *   - qualifiesForMainFeedPromotion(score, sourceType)  (relevanceDefinition.ts)
 *     — wired into storage.finalizeSubmissionAnalysis (the real promotion gate).
 *   - qualifiesForFlashTopStories(score)                (subjectMatcher.ts)
 *     — wired into every news bot + the review/team-chat routes.
 *
 * All boundary values are derived from the imported CONSTANTS (never literal
 * 50/66), so the assertions track future bar changes instead of going stale.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/main-feed-promotion-bar.test.ts
 * Exits non-zero on any failure.
 */
import {
  MAIN_FEED_PROMOTION_THRESHOLD,
  qualifiesForMainFeedPromotion,
} from "../server/relevanceDefinition";
import {
  FLASH_PRIORITY_THRESHOLD,
  qualifiesForFlashTopStories,
} from "../server/subjectMatcher";

let pass = 0;
const failures: string[] = [];

function check(label: string, got: unknown, expected: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`PASS [${label}]`);
  } else {
    const msg = `FAIL [${label}] got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`;
    failures.push(msg);
    console.log(msg);
  }
}

// ---------------------------------------------------------------------------
// Sanity: the two bars are independent knobs and the main bar is the lower one.
// If a refactor re-conflated them (both 66, or main raised to FLASH), this
// fails immediately.
// ---------------------------------------------------------------------------
check(
  "the main-feed bar is strictly below the FLASH bar (independent knobs)",
  MAIN_FEED_PROMOTION_THRESHOLD < FLASH_PRIORITY_THRESHOLD,
  true,
);

// A moderate score that clears the main bar but NOT the FLASH bar. Derived from
// the constants so it stays valid as the bars move (requires only that the
// MODERATE band between them is non-empty, asserted above).
const MODERATE_SCORE = FLASH_PRIORITY_THRESHOLD - 1; // 65 today: >= 50, < 66

// ---------------------------------------------------------------------------
// qualifiesForMainFeedPromotion — the real promotion gate.
// ---------------------------------------------------------------------------

// A news item scored in the MODERATE band (50-65) auto-promotes to the main feed.
check(
  "news scored in the MODERATE band (>=50, <66) auto-promotes to the main feed",
  qualifiesForMainFeedPromotion(MODERATE_SCORE, "news"),
  true,
);

// Exactly on the bar promotes (>= is inclusive).
check(
  "news scored exactly at the bar promotes",
  qualifiesForMainFeedPromotion(MAIN_FEED_PROMOTION_THRESHOLD, "news"),
  true,
);

// One point below the bar stays CHAT-ONLY.
check(
  "news scored one point below the bar stays chat-only",
  qualifiesForMainFeedPromotion(MAIN_FEED_PROMOTION_THRESHOLD - 1, "news"),
  false,
);

// A clearly low / noise score stays CHAT-ONLY.
check(
  "low-priority noise (score 30) stays chat-only",
  qualifiesForMainFeedPromotion(30, "news"),
  false,
);

// A high score still promotes (the bar is a floor, not a ceiling).
check(
  "high-priority news (score 90) promotes",
  qualifiesForMainFeedPromotion(90, "news"),
  true,
);

// Non-`news` sourceTypes NEVER auto-promote here, regardless of score.
for (const sourceType of ["social", "flash", "tweet", "truth", "dataminr", ""]) {
  check(
    `non-news sourceType "${sourceType}" never auto-promotes even at score 100`,
    qualifiesForMainFeedPromotion(100, sourceType),
    false,
  );
}

// A missing / non-numeric score never qualifies (mirrors the original
// `effectivePriority !== undefined` guard).
check(
  "undefined score never promotes",
  qualifiesForMainFeedPromotion(undefined, "news"),
  false,
);
check(
  "null score never promotes",
  qualifiesForMainFeedPromotion(null, "news"),
  false,
);
check(
  "NaN score never promotes",
  qualifiesForMainFeedPromotion(NaN, "news"),
  false,
);

// ---------------------------------------------------------------------------
// qualifiesForFlashTopStories — the SEPARATE FLASH "TOP STORIES" bar.
// Proves the two bars stay independent: a MODERATE item reaches the main feed
// but is NOT elevated into the FLASH reel.
// ---------------------------------------------------------------------------

// The MODERATE item that promoted to the main feed is BELOW the FLASH bar.
check(
  "a MODERATE item (main-feed-eligible) does NOT reach the FLASH reel",
  qualifiesForFlashTopStories(MODERATE_SCORE),
  false,
);

// Exactly on the FLASH bar qualifies (>= is inclusive).
check(
  "score exactly at the FLASH bar qualifies for FLASH",
  qualifiesForFlashTopStories(FLASH_PRIORITY_THRESHOLD),
  true,
);

// One point below the FLASH bar does not.
check(
  "score one point below the FLASH bar does not qualify for FLASH",
  qualifiesForFlashTopStories(FLASH_PRIORITY_THRESHOLD - 1),
  false,
);

// A high score reaches FLASH.
check(
  "high-priority (score 90) qualifies for FLASH",
  qualifiesForFlashTopStories(90),
  true,
);

// Missing / non-numeric never qualifies for FLASH.
check("undefined score never reaches FLASH", qualifiesForFlashTopStories(undefined), false);
check("null score never reaches FLASH", qualifiesForFlashTopStories(null), false);
check("NaN score never reaches FLASH", qualifiesForFlashTopStories(NaN), false);

// ---------------------------------------------------------------------------
// Cross-check: every score in the MODERATE band promotes to the main feed yet
// stays out of FLASH — the core "moderate news now reaches the feed, noise and
// FLASH stay separate" guarantee.
// ---------------------------------------------------------------------------
{
  let allMainEligible = true;
  let anyFlashEligible = false;
  for (let s = MAIN_FEED_PROMOTION_THRESHOLD; s < FLASH_PRIORITY_THRESHOLD; s++) {
    if (!qualifiesForMainFeedPromotion(s, "news")) allMainEligible = false;
    if (qualifiesForFlashTopStories(s)) anyFlashEligible = true;
  }
  check("entire MODERATE band promotes to the main feed", allMainEligible, true);
  check("no score in the MODERATE band leaks into FLASH", anyFlashEligible, false);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
