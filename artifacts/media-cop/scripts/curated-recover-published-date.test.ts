/**
 * Regression gate for curated original-publish-date recovery (Task #933).
 *
 * Curated rows discovered off-host (e.g. Bing News RSS) arrive with only a
 * title + url, so `article_published_at` lands null and the card honestly shows
 * "First seen". Recovery mines the article HTML for the ORIGINAL publish date and
 * backfills it — but ONLY from trusted structured signals (JSON-LD datePublished,
 * article:published_time, itemprop=datePublished, time[pubdate]). Generic/updated
 * tags (meta[name="date"], og:published_time, article:modified_time, a bare
 * time[datetime]) must NEVER be promoted to a publish date — that is exactly the
 * Task #653 bug this locks against. A recovered date must also pass the shared
 * plausibility bound (year > 2000, not in the future beyond a 24h skew) so a
 * scheduled/embargoed next-year JSON-LD stamp can't leak in.
 *
 * Pure + deterministic (no network, no AI): parses inline HTML fixtures through
 * the exact production helpers. Run directly with tsx:
 *   npx tsx scripts/curated-recover-published-date.test.ts
 * Exit 0 = pass, 1 = fail. (No inconclusive/exit-3 path — nothing live here.)
 */
import {
  parseTimestampsFromHtmlString,
  isPlausiblePublishedDate,
} from "../server/timestampExtractor";

const DAY = 24 * 60 * 60 * 1000;
// Fixture dates are computed relative to NOW so the test never rots as the
// calendar advances (parseDate caps at currentYear+1; a hard-coded year would
// eventually trip that ceiling). Truncate to whole seconds so ISO round-trips
// compare cleanly.
const iso = (msAgo: number) => new Date(Math.floor((Date.now() - msAgo) / 1000) * 1000).toISOString();
const PUB_ISO = iso(10 * DAY); // original publish, 10 days ago
const MOD_ISO = iso(1 * DAY); //  last-modified, 1 day ago (must never win)

let failures = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} [${name}]`);
  if (!ok && detail) console.log(`     ${detail}`);
};

// The combined recovery the callers actually perform: parse the HTML, then only
// accept a plausible date (mirrors enrichOneItem / backfillCuratedPublishedDates).
function recover(html: string): Date | null {
  const { publishedAt } = parseTimestampsFromHtmlString(html);
  return isPlausiblePublishedDate(publishedAt) ? publishedAt : null;
}

// ── Trusted signals must be recovered, and the modified date must never win ──
check(
  "JSON-LD datePublished recovered (dateModified ignored)",
  recover(`<html><head><script type="application/ld+json">${JSON.stringify({
    "@type": "NewsArticle",
    headline: "Strait tensions rise",
    datePublished: PUB_ISO,
    dateModified: MOD_ISO,
  })}</script></head><body>x</body></html>`)?.toISOString() === PUB_ISO,
  `expected ${PUB_ISO}`,
);

check(
  "JSON-LD @type array (['NewsArticle']) recovered",
  recover(`<html><head><script type="application/ld+json">${JSON.stringify({
    "@type": ["NewsArticle", "Article"],
    datePublished: PUB_ISO,
  })}</script></head><body>x</body></html>`)?.toISOString() === PUB_ISO,
);

check(
  "article:published_time meta recovered",
  recover(`<html><head><meta property="article:published_time" content="${PUB_ISO}"></head></html>`)?.toISOString() === PUB_ISO,
);

check(
  "itemprop=datePublished meta recovered",
  recover(`<html><head><meta itemprop="datePublished" content="${PUB_ISO}"></head></html>`)?.toISOString() === PUB_ISO,
);

check(
  "time[pubdate] element recovered",
  recover(`<html><body><time pubdate datetime="${PUB_ISO}">10 days ago</time></body></html>`)?.toISOString() === PUB_ISO,
);

// ── Task #653 exclusions: generic/updated signals must NEVER be promoted ──
check(
  "generic meta[name=date] NOT promoted",
  recover(`<html><head><meta name="date" content="${PUB_ISO}"></head></html>`) === null,
);

check(
  "og:published_time NOT promoted",
  recover(`<html><head><meta property="og:published_time" content="${PUB_ISO}"></head></html>`) === null,
);

check(
  "article:modified_time NOT promoted to publish date",
  recover(`<html><head><meta property="article:modified_time" content="${MOD_ISO}"></head></html>`) === null,
);

check(
  "bare time[datetime] (no pubdate/itemprop) NOT trusted",
  recover(`<html><body><time datetime="${PUB_ISO}">x</time></body></html>`) === null,
);

check(
  "JSON-LD dateModified only (no datePublished) NOT promoted",
  recover(`<html><head><script type="application/ld+json">${JSON.stringify({
    "@type": "NewsArticle",
    dateModified: MOD_ISO,
  })}</script></head></html>`) === null,
);

// ── No signal / malformed input must fail-open to null (→ "First seen") ──
check("no timestamp signal → null", recover(`<html><body><h1>Headline only</h1></body></html>`) === null);
check("empty string → null (no throw)", recover("") === null);
check("garbage HTML → null (no throw)", recover("<<<not really html {[}") === null);
check(
  "malformed JSON-LD → null (parse error swallowed)",
  recover(`<html><head><script type="application/ld+json">{not valid json,,,</script></head></html>`) === null,
);

// ── Plausibility bound (isPlausiblePublishedDate) ──
check("plausible: recent past date accepted", isPlausiblePublishedDate(new Date(Date.now() - 10 * DAY)) === true);
check("implausible: null rejected", isPlausiblePublishedDate(null) === false);
check("implausible: undefined rejected", isPlausiblePublishedDate(undefined) === false);
check("implausible: NaN date rejected", isPlausiblePublishedDate(new Date("not-a-date")) === false);
check("implausible: pre-2000 rejected", isPlausiblePublishedDate(new Date("1999-12-31T00:00:00Z")) === false);
check("implausible: far-future rejected", isPlausiblePublishedDate(new Date(Date.now() + 10 * DAY)) === false);
check("implausible: any positive future skew rejected", isPlausiblePublishedDate(new Date(Date.now() + 12 * 60 * 60 * 1000)) === false);

// End-to-end: a future JSON-LD datePublished (scheduled/embargoed) must be
// rejected by the plausibility gate even though parseDate would accept next year.
check(
  "future JSON-LD datePublished rejected end-to-end",
  recover(`<html><head><script type="application/ld+json">${JSON.stringify({
    "@type": "NewsArticle",
    datePublished: iso(-10 * DAY), // 10 days in the FUTURE
  })}</script></head></html>`) === null,
);

const total = failures === 0;
console.log(`\ncurated-recover-published-date: ${total ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
if (!total) {
  console.error(`curated-recover-published-date test FAILED: ${failures} case(s) did not match`);
  process.exit(1);
}
console.log("curated-recover-published-date test PASSED");
