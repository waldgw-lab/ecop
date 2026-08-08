/**
 * Regression test for the RSS feed-health detector (Task #542), pinned by
 * Task #554.
 *
 * server/feedHealthTracker.ts tracks per-feed-URL scrape outcomes so a feed that
 * keeps erroring OR keeps returning zero items for N consecutive cycles surfaces
 * as "stale" in the Coverage payload (getFeedHealthReport), while a healthy feed
 * — or one that has only briefly stumbled — never does. The recorder is wired
 * into BOTH scrapers (rssFeedBot 'rss-monitor' scope, warfighterRssScraper
 * 'warfighter' scope) and is the whole early-warning system for silent feed
 * failure. Nothing currently proves it actually flips stale at the threshold, so
 * a future refactor of the scrape loop could quietly stop recording outcomes and
 * nobody would notice.
 *
 * This drives the REAL recordFeedOutcome -> getFeedHealthReport path (no mocks)
 * and asserts:
 *   - 3 consecutive error / empty / mixed cycles flip the feed stale with the
 *     correct streakKind.
 *   - A healthy feed, and a feed one cycle below the threshold, are NOT stale.
 *   - A recovering feed (healthy cycle) resets the streak.
 *   - The recorder's fail-open guarantee: a throwing input never throws and never
 *     corrupts the report.
 *
 * All boundary values derive from the imported FEED_STALE_THRESHOLD constant
 * (never a literal 3) so the assertions track future threshold changes.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/feed-health-tracker.test.ts
 * Exits non-zero on any failure.
 */
import {
  recordFeedOutcome,
  getFeedHealthReport,
  FEED_STALE_THRESHOLD,
  type FeedOutcome,
  type FeedScope,
  type FeedHealthRow,
} from "../server/feedHealthTracker";

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

// The tracker state is a process-local Map keyed by URL, so every scenario uses
// a unique URL to stay isolated from the others within this single run.
let urlSeq = 0;
function uniqueUrl(tag: string): string {
  urlSeq += 1;
  return `https://feed-health-test.invalid/${tag}/${urlSeq}.xml`;
}

// Drive N cycles of one outcome through the real recorder, then return the row
// the Coverage payload would show for that feed.
function driveCycles(
  url: string,
  outcomes: FeedOutcome[],
  scope: FeedScope = "rss-monitor",
): FeedHealthRow {
  for (const outcome of outcomes) {
    recordFeedOutcome({ url, sourceName: `feed ${url}`, scope, outcome });
  }
  const row = getFeedHealthReport().feeds.find((f) => f.url === url);
  if (!row) throw new Error(`no health row recorded for ${url}`);
  return row;
}

function repeat(outcome: FeedOutcome, n: number): FeedOutcome[] {
  return Array.from({ length: n }, () => outcome);
}

// ---------------------------------------------------------------------------
// The threshold must be sane (>= 2) for "below threshold" to be a real state.
// ---------------------------------------------------------------------------
check("FEED_STALE_THRESHOLD is a meaningful streak (>= 2)", FEED_STALE_THRESHOLD >= 2, true);

// ---------------------------------------------------------------------------
// 1. A feed that ERRORS for exactly THRESHOLD cycles flips stale, streak=error.
// ---------------------------------------------------------------------------
{
  const row = driveCycles(uniqueUrl("all-error"), repeat("error", FEED_STALE_THRESHOLD));
  check("error feed at the threshold is stale", row.stale, true);
  check("error feed reports streakKind=error", row.streakKind, "error");
  check(
    "error feed streak equals the threshold",
    row.consecutiveUnhealthy,
    FEED_STALE_THRESHOLD,
  );
  check("error feed never recorded a healthy cycle", row.lastHealthyAt, null);
}

// ---------------------------------------------------------------------------
// 2. A feed that returns ZERO items (empty) for THRESHOLD cycles flips stale,
//    streak=empty. This is the "outlet retired its RSS, now serves HTML" case
//    where parsing succeeds but yields nothing.
// ---------------------------------------------------------------------------
{
  const row = driveCycles(uniqueUrl("all-empty"), repeat("empty", FEED_STALE_THRESHOLD));
  check("empty feed at the threshold is stale", row.stale, true);
  check("empty feed reports streakKind=empty", row.streakKind, "empty");
}

// ---------------------------------------------------------------------------
// 3. A MIX of error + empty across the threshold window still flips stale and is
//    reported as streakKind=mixed.
// ---------------------------------------------------------------------------
{
  // e.g. [empty, error, empty, ...] — guaranteed to contain both within the
  // trailing streak regardless of the threshold value.
  const mixed: FeedOutcome[] = Array.from({ length: FEED_STALE_THRESHOLD }, (_, i) =>
    i === 0 ? "error" : "empty",
  );
  const row = driveCycles(uniqueUrl("mixed"), mixed);
  check("mixed unhealthy feed at the threshold is stale", row.stale, true);
  check("mixed unhealthy feed reports streakKind=mixed", row.streakKind, "mixed");
}

// ---------------------------------------------------------------------------
// 4. A feed ONE cycle below the threshold is NOT stale yet (off-by-one guard).
// ---------------------------------------------------------------------------
{
  const row = driveCycles(uniqueUrl("below"), repeat("error", FEED_STALE_THRESHOLD - 1));
  check("feed one cycle below the threshold is NOT stale", row.stale, false);
  check(
    "below-threshold feed still has a non-null streakKind",
    row.streakKind,
    "error",
  );
  check(
    "below-threshold streak is threshold-1",
    row.consecutiveUnhealthy,
    FEED_STALE_THRESHOLD - 1,
  );
}

// ---------------------------------------------------------------------------
// 5. A healthy feed is NEVER stale, even after many cycles, and has no streak.
// ---------------------------------------------------------------------------
{
  const row = driveCycles(uniqueUrl("healthy"), repeat("healthy", FEED_STALE_THRESHOLD + 5));
  check("a continuously healthy feed is never stale", row.stale, false);
  check("a healthy feed has zero unhealthy streak", row.consecutiveUnhealthy, 0);
  check("a healthy feed has no streakKind", row.streakKind, null);
  check("a healthy feed reports lastOutcome=healthy", row.lastOutcome, "healthy");
}

// ---------------------------------------------------------------------------
// 6. A feed that recovers resets: unhealthy enough to be on the brink, then one
//    healthy cycle, then unhealthy again must NOT be stale (the healthy cycle
//    cleared the streak — proving a single good cycle un-sticks a feed).
// ---------------------------------------------------------------------------
{
  const url = uniqueUrl("recover");
  const outcomes: FeedOutcome[] = [
    ...repeat("error", FEED_STALE_THRESHOLD - 1), // on the brink
    "healthy", // recovery resets the streak to 0
    ...repeat("error", FEED_STALE_THRESHOLD - 1), // climbs again but not to the bar
  ];
  const row = driveCycles(url, outcomes);
  check("a feed that had a healthy cycle is NOT stale", row.stale, false);
  check(
    "recovery reset the streak (only post-recovery errors count)",
    row.consecutiveUnhealthy,
    FEED_STALE_THRESHOLD - 1,
  );
  check("recovered feed remembers it was once healthy", row.lastHealthyAt !== null, true);
}

// ---------------------------------------------------------------------------
// 7. Crossing the bar by one more error tips a brink feed into stale (the exact
//    transition the Coverage tab depends on).
// ---------------------------------------------------------------------------
{
  const url = uniqueUrl("transition");
  let row = driveCycles(url, repeat("error", FEED_STALE_THRESHOLD - 1));
  check("brink feed (threshold-1 errors) not yet stale", row.stale, false);
  row = driveCycles(url, ["error"]); // one more error crosses the bar
  check("one more error tips the feed into stale", row.stale, true);
}

// ---------------------------------------------------------------------------
// 8. The aggregate report counts match the per-row stale flags.
// ---------------------------------------------------------------------------
{
  const report = getFeedHealthReport();
  check(
    "report.total equals the number of feed rows",
    report.total,
    report.feeds.length,
  );
  check(
    "report.stale equals the count of stale rows",
    report.stale,
    report.feeds.filter((f) => f.stale).length,
  );
  // Stale rows must sort ahead of healthy ones.
  const firstHealthyIdx = report.feeds.findIndex((f) => !f.stale);
  const lastStaleIdx = (() => {
    let idx = -1;
    report.feeds.forEach((f, i) => {
      if (f.stale) idx = i;
    });
    return idx;
  })();
  check(
    "stale rows sort ahead of healthy rows",
    firstHealthyIdx === -1 || lastStaleIdx === -1 || lastStaleIdx < firstHealthyIdx,
    true,
  );
}

// ---------------------------------------------------------------------------
// 9. Fail-open guarantee: a throwing input must never throw out of the recorder
//    (it would otherwise break the scrape cycle it is embedded in) and must not
//    corrupt the report. We pass an object whose property access throws.
// ---------------------------------------------------------------------------
{
  const before = getFeedHealthReport().total;
  let threw = false;
  try {
    const poison = {
      get url(): string {
        throw new Error("boom");
      },
      sourceName: "poison",
      scope: "rss-monitor" as FeedScope,
      outcome: "error" as FeedOutcome,
    };
    // Cast through unknown: the point is a runtime-throwing input, not a type.
    recordFeedOutcome(poison as unknown as Parameters<typeof recordFeedOutcome>[0]);
  } catch {
    threw = true;
  }
  check("a throwing input never throws out of recordFeedOutcome", threw, false);
  check(
    "a throwing input adds no row (report unchanged)",
    getFeedHealthReport().total,
    before,
  );
}

// ---------------------------------------------------------------------------
// 10. A blank URL is ignored (the recorder's explicit `if (!url) return` guard).
// ---------------------------------------------------------------------------
{
  const before = getFeedHealthReport().total;
  recordFeedOutcome({ url: "", sourceName: "blank", scope: "warfighter", outcome: "error" });
  check("a blank-URL outcome is ignored", getFeedHealthReport().total, before);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
