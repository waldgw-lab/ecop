/**
 * Regression test for the Curated malformed-URL admission guard (Task #427).
 *
 * isSingleWellFormedHttpUrl is the curated-ingest gate's URL sanity check. The
 * original bug: a Drudge anchor href with a LEADING SPACE failed the old
 * `url.startsWith('http')` test, so the drudgereport base was prepended,
 * producing a space-joined "two URLs" value
 * ("https://www.drudgereport.com https://www.hollywoodreporter.com/..."). The
 * legacy gate only matched the `^https?://` PREFIX, so it admitted that value;
 * `new URL(...)` then threw downstream → source fell back to the junk
 * "Unknown Source" label and the dedup/identity key was corrupted.
 *
 * This locks the guard so:
 *   - a single well-formed http(s) URL is accepted (incl. surrounding space
 *     that the gate trims),
 *   - any value with INTERNAL whitespace (the space-joined two-URL case) is
 *     rejected,
 *   - anything that does not parse as a single http(s) URL is rejected.
 *
 * It also locks the read-time defense-in-depth predicate used by the curated
 * top-stories handler (skip rows whose source is the junk "Unknown Source"
 * fallback or whose URL is malformed).
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-url-guard.test.ts
 * Exits non-zero on any failure.
 */
import { isSingleWellFormedHttpUrl } from "../server/curatedIngest";

// The exact malformed value observed in the prod "Unknown Source" row.
const PROD_BAD_URL =
  "https://www.drudgereport.com https://www.hollywoodreporter.com/movies/movie-news/example-123/";

interface Case {
  url: string;
  expected: boolean;
  why: string;
}

const cases: Case[] = [
  // ---- MUST be accepted ----
  { url: "https://www.hollywoodreporter.com/movies/movie-news/example-123/", expected: true, why: "a plain well-formed https URL" },
  { url: "http://en.people.cn/n3/2026/0622/c90000-20469359.html", expected: true, why: "http (not https) is still a valid single URL" },
  { url: "https://www.cnn.com/2026/06/16/politics/senate-defense-bill-vote/index.html?utm_source=x", expected: true, why: "a query string is fine (no internal whitespace)" },
  { url: "  https://www.npr.org/2026/06/16/nx-s1-5400001/state-department-iran-talks  ", expected: true, why: "leading/trailing space is trimmed, then valid" },

  // ---- MUST be rejected ----
  { url: PROD_BAD_URL, expected: false, why: "the exact prod bug: two URLs joined by a space" },
  { url: "https://www.drudgereport.com https://example.com/x", expected: false, why: "internal whitespace (space-joined two URLs)" },
  { url: "https://example.com/a\tb", expected: false, why: "internal tab whitespace" },
  { url: "https://example.com/a\nb", expected: false, why: "internal newline whitespace" },
  { url: "ftp://example.com/file", expected: false, why: "non-http(s) protocol" },
  { url: "javascript:alert(1)", expected: false, why: "non-http(s) scheme" },
  { url: "/movies/movie-news/example-123/", expected: false, why: "a bare relative path, not an absolute URL" },
  { url: "www.example.com/x", expected: false, why: "missing scheme — not parseable as an absolute URL" },
  { url: "https://", expected: false, why: "scheme only, no host" },
  { url: "", expected: false, why: "empty string" },
  { url: "   ", expected: false, why: "whitespace only" },
];

// Read-time defense-in-depth predicate mirrored from the curated top-stories
// handler: skip a curated row when its source never resolved past the junk
// fallback OR its URL is malformed.
const wouldSkipCuratedRow = (source: string, url: string): boolean =>
  source === "Unknown Source" || !isSingleWellFormedHttpUrl(url);

let passed = 0;
let failed = 0;

for (const c of cases) {
  const got = isSingleWellFormedHttpUrl(c.url);
  if (got === c.expected) {
    passed++;
    console.log(`PASS [${c.expected ? "accept" : "reject"}] ${c.why}`);
  } else {
    failed++;
    console.error(`FAIL [expected ${c.expected}, got ${got}] ${c.why} :: ${JSON.stringify(c.url)}`);
  }
}

// Null / undefined inputs must not throw and must be rejected.
for (const bad of [null, undefined]) {
  const got = isSingleWellFormedHttpUrl(bad);
  if (got === false) {
    passed++;
    console.log(`PASS [reject] ${String(bad)} input is rejected without throwing`);
  } else {
    failed++;
    console.error(`FAIL [expected false, got ${got}] ${String(bad)} input`);
  }
}

// Read-time guard: the historical prod row (source "Unknown Source" + the
// space-joined URL) must be skipped; a legitimate row must NOT be skipped.
const readTimeChecks: { source: string; url: string; expectSkip: boolean; why: string }[] = [
  { source: "Unknown Source", url: PROD_BAD_URL, expectSkip: true, why: "the historical prod row is skipped at read time" },
  { source: "Unknown Source", url: "https://www.cnn.com/2026/06/16/x/index.html", expectSkip: true, why: "junk source label alone is enough to skip" },
  { source: "The Hollywood Reporter", url: PROD_BAD_URL, expectSkip: true, why: "malformed URL alone is enough to skip" },
  { source: "CNN", url: "https://www.cnn.com/2026/06/16/x/index.html", expectSkip: false, why: "a legitimate curated row is NOT skipped" },
];

for (const r of readTimeChecks) {
  const got = wouldSkipCuratedRow(r.source, r.url);
  if (got === r.expectSkip) {
    passed++;
    console.log(`PASS [read-time ${r.expectSkip ? "skip" : "keep"}] ${r.why}`);
  } else {
    failed++;
    console.error(`FAIL [read-time expected skip=${r.expectSkip}, got ${got}] ${r.why}`);
  }
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.error(`${failed} FAILED`);
  process.exit(1);
}
