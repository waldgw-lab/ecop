/**
 * Regression test for the Curated URL identity normalizer (server/urlIdentity.ts).
 *
 * The same article routinely enters the curated lane twice: once via the main
 * feed (URL already cleaned by the RSS bots) and once via a direct curated RSS /
 * website path that keeps the RAW feed link with its tracking query
 * (BBC `?at_medium=RSS&at_campaign=rss`, DW `?maca=...`, generic `?utm_*`). If
 * the identity token keeps those tracking params the two forms look like two
 * different articles, the collapse-by-URL step misses, and ONE article shows up
 * TWICE as two "sources" in a Top Story (e.g. BBC + BBC News, DW + Deutsche
 * Welle).
 *
 * normalizeIdentityUrl must:
 *   - collapse tracking-query variants of one article to a single token, AND
 *   - PRESERVE identifying params (e.g. ABC's `?id=12345`) so two genuinely
 *     different articles that share a path are never merged.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-url-identity.test.ts
 * Exits non-zero on any failure.
 */
import { normalizeIdentityUrl } from "../server/urlIdentity";

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

// Two inputs must reduce to the SAME identity token (= same article).
function same(label: string, a: string, b: string) {
  const na = normalizeIdentityUrl(a);
  const nb = normalizeIdentityUrl(b);
  check(`${label} :: "${na}" === "${nb}"`, na === nb && na.length > 0);
}

// Two inputs must reduce to DIFFERENT tokens (= different articles).
function differ(label: string, a: string, b: string) {
  const na = normalizeIdentityUrl(a);
  const nb = normalizeIdentityUrl(b);
  check(`${label} :: "${na}" !== "${nb}"`, na !== nb);
}

// ---- The real production duplicates this fix targets ----
same(
  "BBC: RSS tracking query vs clean (the reported BBC / BBC News dup)",
  "https://www.bbc.co.uk/news/articles/cx23rnzdgl8o?at_medium=RSS&at_campaign=rss",
  "https://www.bbc.co.uk/news/articles/cx23rnzdgl8o",
);
same(
  "DW: maca RSS attribution vs clean (the DW / Deutsche Welle dup)",
  "https://www.dw.com/en/us-iran-give-conflicting-claims-over-hormuz-fees/live-77666574?maca=en-rss-en-all-1573-rdf",
  "https://www.dw.com/en/us-iran-give-conflicting-claims-over-hormuz-fees/live-77666574",
);
same(
  "RT: utm_* RSS query vs clean",
  "https://www.rt.com/news/642002-iran-hormuz-hotline/?utm_source=rss&utm_medium=rss&utm_campaign=RSS",
  "https://www.rt.com/news/642002-iran-hormuz-hotline/",
);

// ---- Tracking-param coverage ----
same(
  "case-insensitive: UTM_Source variant collapses like utm_source",
  "https://example.com/article?UTM_Source=newsletter",
  "https://example.com/article",
);
same(
  "traffic_source is treated as tracking",
  "https://example.com/article?traffic_source=rss",
  "https://example.com/article",
);
same(
  "fbclid / gclid click ids are tracking",
  "https://example.com/a?fbclid=abc123&gclid=xyz",
  "https://example.com/a",
);
same(
  "ns_* prefix (BBC) is tracking",
  "https://example.com/a?ns_campaign=bbcnews&ns_mchannel=social",
  "https://example.com/a",
);
same(
  "mixed: tracking stripped, identifying kept reduces to the id-only form",
  "https://abcnews.go.com/Politics/story?id=12345&utm_source=twitter&at_medium=social",
  "https://abcnews.go.com/Politics/story?id=12345",
);

// ---- Identifying params MUST be preserved (no over-collapse) ----
differ(
  "ABC: two DIFFERENT ?id= stories on the same path stay distinct",
  "https://abcnews.go.com/Politics/story?id=12345",
  "https://abcnews.go.com/Politics/story?id=67890",
);
differ(
  "WordPress-style ?p= post ids stay distinct",
  "https://example.com/?p=111",
  "https://example.com/?p=222",
);
check(
  "ABC ?id= survives normalization",
  normalizeIdentityUrl("https://abcnews.go.com/Politics/story?id=12345") ===
    "https://abcnews.go.com/politics/story?id=12345",
);

// ---- Fragment + trailing slash + case ----
same(
  "fragment (#anchor) does not change identity",
  "https://example.com/article#section-2",
  "https://example.com/article",
);
same(
  "trailing slash does not change identity",
  "https://example.com/article/",
  "https://example.com/article",
);
same(
  "scheme/host case does not change identity",
  "https://Example.COM/Article",
  "https://example.com/article",
);

// ---- Determinism: kept params are order-independent ----
same(
  "kept params are sorted so order does not matter",
  "https://example.com/a?id=1&page=2",
  "https://example.com/a?page=2&id=1",
);

// ---- Social identity variants must resolve to the same curated item ----
same(
  "X x.com tracking variant vs canonical status URL",
  "https://x.com/DeptofDefense/status/1900123456789012345?utm_source=copy_link#post",
  "https://x.com/DeptofDefense/status/1900123456789012345",
);
same(
  "Truth Social tracking variant vs canonical status URL",
  "https://truthsocial.com/@realDonaldTrump/114000000000000000?utm_source=share&at_medium=social",
  "https://truthsocial.com/@realDonaldTrump/114000000000000000",
);
differ(
  "different Truth Social status IDs remain distinct",
  "https://truthsocial.com/@realDonaldTrump/114000000000000000",
  "https://truthsocial.com/@realDonaldTrump/114000000000000001",
);

// ---- Byte-identical to the OLD behavior for query-less URLs (no churn) ----
// The OLD normalizer was: trim -> strip trailing slash -> lowercase.
const oldNorm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
for (const u of [
  "https://www.cnn.com/2026/06/23/world/live-news/iran-war",
  "https://tass.com/world/2150019",
  "https://presstv.ir/Detail/2026/06/23/770941/Iran-Oman",
  "http://en.people.cn/n3/2026/0622/c90000-20469359.html",
]) {
  check(
    `no-query URL unchanged vs old behavior: ${u}`,
    normalizeIdentityUrl(u) === oldNorm(u),
  );
}

// ---- Degenerate inputs never throw ----
check("null -> empty string", normalizeIdentityUrl(null) === "");
check("undefined -> empty string", normalizeIdentityUrl(undefined) === "");
check("empty -> empty string", normalizeIdentityUrl("   ") === "");
check(
  "all-tracking query collapses to bare path (no dangling ?)",
  normalizeIdentityUrl("https://example.com/a/?utm_source=x&at_medium=rss") ===
    "https://example.com/a",
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
