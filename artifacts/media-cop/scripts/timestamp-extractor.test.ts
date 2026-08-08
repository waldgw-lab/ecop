/**
 * Regression test for Task #653 — the curated "stale-as-fresh" bug.
 *
 * Some outlets (Reuters is the reported example) reuse generic date-ish tags
 * (meta[name="date"], meta[name="pubdate"], and even
 * meta[property="og:published_time"]) to carry the *last-updated* timestamp
 * once a story is refreshed, overwriting the original publish time. Treating
 * "first date tag found" as authoritative silently turns a days-old story
 * into one that displays as freshly published.
 *
 * This locks parseTimestampsFromHtml's trust tiering: only structured,
 * purpose-built "original publish" signals (JSON-LD datePublished,
 * article:published_time, itemprop=datePublished, time[pubdate]) may ever
 * populate publishedAt; generic/ambiguous tags must never do so, and pages
 * with no trustworthy signal must return null (so the UI honestly falls back
 * to "First seen" instead of fabricating a "Published" date).
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/timestamp-extractor.test.ts
 * Exits non-zero on any failure.
 */
import * as cheerio from "cheerio";
import { parseTimestampsFromHtml } from "../server/timestampExtractor";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`PASS [${name}]`);
  } else {
    failed++;
    console.log(`FAIL [${name}]`);
  }
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

const HOUR = 60 * 60 * 1000;

// --- Case 1: the reported Reuters scenario -------------------------------
// Original publish June 29; generic date/pubdate/og:published_time tags
// were all overwritten to "3 hours ago" when the outlet later touched the
// story. JSON-LD datePublished still carries the true original date.
{
  const originalPublish = "2026-06-29T14:32:00.000Z";
  const fakeRecent = iso(3 * HOUR);
  const html = `
    <html><head>
      <meta name="date" content="${fakeRecent}">
      <meta name="pubdate" content="${fakeRecent}">
      <meta property="og:published_time" content="${fakeRecent}">
      <meta property="article:modified_time" content="${fakeRecent}">
      <script type="application/ld+json">
        {"@type":"NewsArticle","datePublished":"${originalPublish}","dateModified":"${fakeRecent}"}
      </script>
    </head><body></body></html>`;
  const $ = cheerio.load(html);
  const result = parseTimestampsFromHtml($);
  check(
    "Reuters overwritten-tags scenario: publishedAt uses JSON-LD original date, not the overwritten 'updated' tags",
    result.publishedAt?.toISOString() === originalPublish,
  );
  check(
    "Reuters overwritten-tags scenario: updatedAt captures the modified time separately",
    result.updatedAt !== null && Math.abs(result.updatedAt.getTime() - Date.now() + 3 * HOUR) < 5000,
  );
}

// --- Case 2: genuinely recent story, trusted signal only ------------------
{
  const recent = iso(3 * HOUR);
  const html = `
    <html><head>
      <meta property="article:published_time" content="${recent}">
    </head><body></body></html>`;
  const $ = cheerio.load(html);
  const result = parseTimestampsFromHtml($);
  check(
    "genuinely recent story: article:published_time is trusted and used",
    result.publishedAt !== null && Math.abs(result.publishedAt.getTime() - Date.now() + 3 * HOUR) < 5000,
  );
}

// --- Case 3: no trustworthy signal at all → null (honest "First seen") ---
{
  const recent = iso(3 * HOUR);
  const html = `
    <html><head>
      <meta name="date" content="${recent}">
      <meta name="pubdate" content="${recent}">
    </head><body><time datetime="${recent}">3 hours ago</time></body></html>`;
  const $ = cheerio.load(html);
  const result = parseTimestampsFromHtml($);
  check(
    "no trustworthy signal: generic date/pubdate meta + bare <time> never populate publishedAt",
    result.publishedAt === null,
  );
}

// --- Case 4: og:published_time alone is never trusted ---------------------
{
  const recent = iso(1 * HOUR);
  const html = `<html><head><meta property="og:published_time" content="${recent}"></head></html>`;
  const $ = cheerio.load(html);
  const result = parseTimestampsFromHtml($);
  check("og:published_time alone never populates publishedAt (known overwrite target)", result.publishedAt === null);
}

// --- Case 5: itemprop=datePublished on a <time> element is trusted --------
{
  const original = "2026-06-29T14:32:00.000Z";
  const html = `<html><body><time itemprop="datePublished" datetime="${original}">June 29</time></body></html>`;
  const $ = cheerio.load(html);
  const result = parseTimestampsFromHtml($);
  check(
    "time[itemprop=datePublished] is trusted for publishedAt",
    result.publishedAt?.toISOString() === original,
  );
}

// --- Case 6: non-Article JSON-LD type must not leak into publishedAt ------
{
  const html = `
    <html><head>
      <script type="application/ld+json">
        {"@type":"Organization","datePublished":"2020-01-01T00:00:00.000Z"}
      </script>
    </head></html>`;
  const $ = cheerio.load(html);
  const result = parseTimestampsFromHtml($);
  check("non-Article JSON-LD type (Organization) is ignored", result.publishedAt === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
