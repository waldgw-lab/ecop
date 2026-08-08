/**
 * Regression test for the Curated-lane same-article-only fuzzy-title de-dupe
 * (Task #602), implemented by isSameArticleDuplicate in server/curatedIngest.ts.
 *
 * The curated lane EXISTS to cluster every independent source covering the same
 * event, so near-identical headlines from DIFFERENT outlets are the STRONGEST
 * same-event signal and must be ADMITTED as separate nodes (clustering then
 * merges them into ONE corroborated story, each counted as a contributing
 * source, satisfying the ">=2 contributing" formation gate and the
 * byte-identical >=2-distinct-publisher must-link).
 *
 * A near-dupe must STILL collapse when it is a TRUE duplicate of the SAME
 * article: same normalized URL IDENTITY (a tracking-param / feed variant of the
 * same link) OR the same outlet re-emitting the story via multiple feeds.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-ingest-dedup.test.ts
 * Exits non-zero on any failure.
 */
import {
  isSameArticleDuplicate,
  type SimilarCuratedRef,
} from "../server/curatedIngest";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS [${label}]`);
  } else {
    failed++;
    console.log(`FAIL [${label}]`);
  }
}

// "DUP" = must collapse (true). "ADMIT" = must be kept as a separate node (false).
function dup(
  label: string,
  candUrl: string,
  candOutlet: string,
  similar: SimilarCuratedRef[],
) {
  check(`DUP: ${label}`, isSameArticleDuplicate(candUrl, candOutlet, similar) === true);
}
function admit(
  label: string,
  candUrl: string,
  candOutlet: string,
  similar: SimilarCuratedRef[],
) {
  check(`ADMIT: ${label}`, isSameArticleDuplicate(candUrl, candOutlet, similar) === false);
}

// ---------------------------------------------------------------------------
// The core fix: independent outlets' near-dupes are ADMITTED (not dropped)
// ---------------------------------------------------------------------------

// Reuters already stored; a near-identical AP headline arrives from a different
// outlet at a different URL → ADMIT so clustering corroborates the event.
admit(
  "different outlet, different URL, near-identical title",
  "https://apnews.com/article/iran-nuclear-talks-collapse-abc123",
  "Associated Press",
  [{ url: "https://www.reuters.com/world/iran-nuclear-talks-collapse-xyz", source: "Reuters" }],
);

// The prior trust-aware drop (Task #403) discarded an equal/higher-trust 2nd
// outlet. A lower-trust adversary near-dupe of a trusted-stored story is now
// admitted just the same — trust no longer gates the dedup.
admit(
  "adversary outlet near-dupe of a trusted stored story is admitted (trust no longer gates)",
  "https://www.globaltimes.cn/page/202606/1364038.shtml",
  "Global Times",
  [{ url: "https://www.bbc.com/news/world-iran-talks", source: "BBC" }],
);

// More than one stored near-dupe, all from OTHER outlets → still ADMIT.
admit(
  "near-dupes from several other outlets → still admitted",
  "https://www.aljazeera.com/news/2026/6/16/nato-summit-aid",
  "Al Jazeera",
  [
    { url: "https://www.reuters.com/world/nato-summit-aid", source: "Reuters" },
    { url: "https://apnews.com/article/nato-summit-aid-99", source: "Associated Press" },
  ],
);

// ---------------------------------------------------------------------------
// True same-article duplicates must STILL collapse
// ---------------------------------------------------------------------------

// Same outlet re-emitting the same story via another feed/section, different URL
// → DUP (same canonical outlet).
dup(
  "same outlet re-emits via a different section URL",
  "https://www.reuters.com/markets/iran-nuclear-talks-collapse",
  "Reuters",
  [{ url: "https://www.reuters.com/world/iran-nuclear-talks-collapse", source: "Reuters" }],
);

// Same outlet, case/whitespace-insensitive canonical match → DUP.
dup(
  "same outlet, case- and whitespace-insensitive",
  "https://www.bbc.com/news/world-2",
  "  bbc  ",
  [{ url: "https://www.bbc.com/news/world-1", source: "BBC" }],
);

// Same article, tracking-param variant of the SAME link (different outlet name
// label, but the URL identity is identical) → DUP via URL identity.
dup(
  "same link, tracking-param variant (URL identity match)",
  "https://www.bbc.com/news/world-iran-talks?at_medium=RSS&at_campaign=rss",
  "BBC News",
  [{ url: "https://www.bbc.com/news/world-iran-talks", source: "BBC" }],
);

// URL identity match wins even if it is one of several stored near-dupes.
dup(
  "URL identity match among a mix of other-outlet near-dupes still collapses",
  "https://apnews.com/article/nato-summit-aid-99?utm_source=feed",
  "Associated Press",
  [
    { url: "https://www.reuters.com/world/nato-summit-aid", source: "Reuters" },
    { url: "https://apnews.com/article/nato-summit-aid-99", source: "Associated Press" },
  ],
);

// ---------------------------------------------------------------------------
// Edge / safety cases
// ---------------------------------------------------------------------------

// No similar rows at all → never a duplicate (admit).
admit("empty similar list → admit", "https://x.test/a", "Reuters", []);

// Two genuinely different articles that share a path but differ by an
// IDENTIFYING param (ABC ?id=) from DIFFERENT outlets → ADMIT (identity differs).
admit(
  "different identifying param + different outlet → admit",
  "https://abcnews.go.com/Politics/story?id=222",
  "ABC News",
  [{ url: "https://www.cbsnews.com/news/story?id=111", source: "CBS News" }],
);

// Missing/blank candidate outlet must not false-match a blank stored source.
admit(
  "blank outlet on both sides must NOT collapse on outlet",
  "https://one.test/a",
  "",
  [{ url: "https://two.test/b", source: "" }],
);

// ...but a blank-outlet candidate that shares the URL identity still collapses.
dup(
  "blank outlet but same URL identity still collapses",
  "https://one.test/a?utm_source=x",
  "",
  [{ url: "https://one.test/a", source: "Whatever" }],
);

// ---------------------------------------------------------------------------
// Task #708 — busy-event window-overflow scenario
//
// These cases verify that isSameArticleDuplicate correctly collapses a
// same-outlet re-emit even when it appears alongside many near-identical
// headlines from other outlets.  The production fix (getSimilarCuratedItemsForOutlet)
// ensures the same-outlet row is ALWAYS included in the `similar` list passed
// here, regardless of where it ranks in the cross-outlet similarity window.
// ---------------------------------------------------------------------------

// Busy event: 5 other outlets' near-identical headlines already fill the top-5
// similarity window, BUT the 6th row is the same outlet (Reuters) re-emitting
// at a different URL.  When that row IS in the similar list (via the unbounded
// outlet pass), it must collapse.
dup(
  "same outlet re-emit survives a crowded similarity window (busy event)",
  "https://www.reuters.com/markets/us-iran-nuclear-deal-2026-07-10-v2",
  "Reuters",
  [
    { url: "https://apnews.com/article/us-iran-deal-abc", source: "Associated Press" },
    { url: "https://www.bbc.com/news/world-us-iran-deal", source: "BBC" },
    { url: "https://www.aljazeera.com/news/us-iran-deal", source: "Al Jazeera" },
    { url: "https://www.dw.com/en/us-iran-deal/a-111", source: "DW" },
    { url: "https://www.france24.com/en/us-iran-deal", source: "France 24" },
    // Same-outlet row that would have been rank #6 in the cross-outlet similarity
    // window (crowded out by the five above) — the outlet-specific pass rescues it:
    { url: "https://www.reuters.com/world/us-iran-nuclear-deal-2026-07-10", source: "Reuters" },
  ],
);

// The same busy-event situation must NOT collapse a NEW outlet that isn't in the
// list at all — its candidate is AP but the similar list (from both queries) only
// contains rows from other outlets.  AP should be admitted as a separate node
// so clustering can corroborate the story across multiple sources.
admit(
  "busy event with same-outlet rows present: a DIFFERENT outlet is still admitted",
  "https://apnews.com/article/us-iran-deal-new-xyz",
  "Associated Press",
  [
    { url: "https://www.bbc.com/news/world-us-iran-deal", source: "BBC" },
    { url: "https://www.aljazeera.com/news/us-iran-deal", source: "Al Jazeera" },
    { url: "https://www.dw.com/en/us-iran-deal/a-111", source: "DW" },
    { url: "https://www.france24.com/en/us-iran-deal", source: "France 24" },
    { url: "https://www.reuters.com/world/us-iran-nuclear-deal-2026-07-10", source: "Reuters" },
    // Same-outlet row for Reuters (added by the unbounded outlet pass) — AP is
    // still a different outlet and must be admitted as a separate corroborating node.
    { url: "https://www.reuters.com/markets/us-iran-nuclear-deal-2026-07-10-v2", source: "Reuters" },
  ],
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
