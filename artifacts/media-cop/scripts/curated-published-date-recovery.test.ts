/**
 * Gate: curated-published-date-recovery
 *
 * Verifies that parseTimestampsFromHtml correctly recovers trusted publish
 * dates from article HTML (Task #933) and that untrusted/invalid signals are
 * correctly rejected (Task #653 trust-tier invariants).
 *
 * Pure unit test — no network, no DB, no server running required.
 * Exit 0 = PASS, exit 1 = FAIL.
 */

import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTimestampsFromHtml } from '../server/timestampExtractor';

let passed = 0;
let failed = 0;

function pass(label: string) {
  console.log(`  PASS: ${label}`);
  passed++;
}

function fail(label: string, detail?: string) {
  console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  failed++;
}

// ── Helper ──────────────────────────────────────────────────────────────────

function parse(html: string) {
  return parseTimestampsFromHtml(cheerio.load(html));
}

// ── Test 1: JSON-LD datePublished (NewsArticle) ──────────────────────────────
{
  const html = `<html><head>
    <script type="application/ld+json">
    {"@type":"NewsArticle","datePublished":"2026-07-13T14:09:00-04:00","headline":"Test"}
    </script>
  </head></html>`;
  const { publishedAt } = parse(html);
  if (!publishedAt) {
    fail('JSON-LD datePublished (NewsArticle)', 'publishedAt is null');
  } else if (publishedAt.getFullYear() !== 2026 || publishedAt.getMonth() !== 6 || publishedAt.getDate() !== 13) {
    fail('JSON-LD datePublished (NewsArticle)', `got ${publishedAt.toISOString()}, expected 2026-07-13`);
  } else {
    pass('JSON-LD datePublished (NewsArticle) → 2026-07-13');
  }
}

// ── Test 2: JSON-LD datePublished (Article type) ─────────────────────────────
{
  const html = `<html><head>
    <script type="application/ld+json">
    {"@type":"Article","datePublished":"2026-07-10T08:00:00Z"}
    </script>
  </head></html>`;
  const { publishedAt } = parse(html);
  if (!publishedAt) {
    fail('JSON-LD datePublished (Article)', 'publishedAt is null');
  } else if (publishedAt.getFullYear() !== 2026 || publishedAt.getMonth() !== 6 || publishedAt.getDate() !== 10) {
    fail('JSON-LD datePublished (Article)', `got ${publishedAt.toISOString()}`);
  } else {
    pass('JSON-LD datePublished (Article type)');
  }
}

// ── Test 3: article:published_time meta tag ──────────────────────────────────
{
  const html = `<html><head>
    <meta property="article:published_time" content="2026-07-11T12:30:00Z">
  </head></html>`;
  const { publishedAt } = parse(html);
  if (!publishedAt) {
    fail('article:published_time', 'publishedAt is null');
  } else if (publishedAt.getFullYear() !== 2026 || publishedAt.getMonth() !== 6 || publishedAt.getDate() !== 11) {
    fail('article:published_time', `got ${publishedAt.toISOString()}`);
  } else {
    pass('article:published_time meta → 2026-07-11');
  }
}

// ── Test 4: itemprop=datePublished (time element) ────────────────────────────
{
  const html = `<html><head></head><body>
    <time itemprop="datePublished" datetime="2026-07-09T09:00:00Z">July 9, 2026</time>
  </body></html>`;
  const { publishedAt } = parse(html);
  if (!publishedAt) {
    fail('time[itemprop=datePublished]', 'publishedAt is null');
  } else {
    pass('time[itemprop=datePublished] → found date');
  }
}

// ── Test 5: Untrusted meta[name=date] must NOT produce publishedAt ───────────
{
  const html = `<html><head>
    <meta name="date" content="2026-07-13T14:09:00Z">
  </head></html>`;
  const { publishedAt } = parse(html);
  if (publishedAt !== null) {
    fail('meta[name=date] must be ignored (untrusted tag)', `got ${publishedAt!.toISOString()}`);
  } else {
    pass('meta[name=date] correctly rejected (untrusted — reused for updates)');
  }
}

// ── Test 6: og:published_time must NOT produce publishedAt ──────────────────
{
  const html = `<html><head>
    <meta property="og:published_time" content="2026-07-13T14:09:00Z">
  </head></html>`;
  const { publishedAt } = parse(html);
  if (publishedAt !== null) {
    fail('og:published_time must be ignored (untrusted — outlets reuse for updates)', `got ${publishedAt!.toISOString()}`);
  } else {
    pass('og:published_time correctly rejected (untrusted)');
  }
}

// ── Test 7: No timestamp signal at all → null ────────────────────────────────
{
  const html = `<html><head><title>Article</title></head><body><p>Body text</p></body></html>`;
  const { publishedAt } = parse(html);
  if (publishedAt !== null) {
    fail('No signal → should be null', `got ${publishedAt!.toISOString()}`);
  } else {
    pass('No timestamp signal → null (honest "First seen" fallback)');
  }
}

// ── Test 8: Pre-2000 date rejected by parseDate ──────────────────────────────
{
  const html = `<html><head>
    <script type="application/ld+json">
    {"@type":"NewsArticle","datePublished":"1999-07-13T14:09:00Z"}
    </script>
  </head></html>`;
  const { publishedAt } = parse(html);
  if (publishedAt !== null) {
    fail('Pre-2000 date should be rejected by parseDate', `got ${publishedAt!.toISOString()}`);
  } else {
    pass('Pre-2000 date → null (plausibility guard)');
  }
}

// ── Test 9: Any future date is rejected in favor of honest first-seen time ────
// This validates the shared enrichment plausibility rule. Even a small skew is
// unsafe because downstream workers may otherwise see a negative age.
{
  const futureMs = Date.now() + 5 * 60 * 1000; // only five minutes ahead
  const futureDate = new Date(futureMs);
  const futureIso = futureDate.toISOString();
  const html = `<html><head>
    <script type="application/ld+json">
    {"@type":"NewsArticle","datePublished":"${futureIso}"}
    </script>
  </head></html>`;
  const { publishedAt } = parse(html);
  const { isPlausiblePublishedDate } = await import('../server/timestampExtractor');
  if (publishedAt && !isPlausiblePublishedDate(publishedAt)) {
    pass('Small future skew is rejected by enrichment plausibility gate');
  } else {
    fail('Small future skew must be rejected', `got ${publishedAt?.toISOString() ?? 'null'}`);
  }
}

// ── Test 10: persisted future-date healing is not limited by row age ─────────
// The network recovery scan remains bounded, but clearing an invalid future
// timestamp must cover old rows too; otherwise an absurd far-future value can
// survive indefinitely in raw-date workers.
{
  const source = readFileSync(join(process.cwd(), 'server/streamPrefetch.ts'), 'utf8');
  const functionStart = source.indexOf('export async function backfillCuratedPublishedDates');
  const healStart = source.indexOf('await db.update(curatedItems)', functionStart);
  const scanStart = source.indexOf('const rows = await db.select', healStart);
  const healBlock = source.slice(healStart, scanStart);
  if (
    functionStart >= 0 &&
    healStart >= 0 &&
    scanStart > healStart &&
    healBlock.includes('gt(curatedItems.articlePublishedAt, new Date())') &&
    !healBlock.includes('gte(curatedItems.scrapedAt, cutoff)')
  ) {
    pass('Persisted future-date healing covers old rows; only recovery fetching is time-bounded');
  } else {
    fail('Persisted future-date healing must not be scoped by scrapedAt');
  }
}

// ── Test 11: JSON-LD @graph pattern ──────────────────────────────────────────
{
  const html = `<html><head>
    <script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[{"@type":"NewsArticle","datePublished":"2026-07-08T06:00:00Z"}]}
    </script>
  </head></html>`;
  const { publishedAt } = parse(html);
  if (!publishedAt) {
    fail('JSON-LD @graph pattern', 'publishedAt is null');
  } else if (publishedAt.getFullYear() !== 2026 || publishedAt.getDate() !== 8) {
    fail('JSON-LD @graph pattern', `got ${publishedAt.toISOString()}`);
  } else {
    pass('JSON-LD @graph pattern → 2026-07-08');
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\ncurated-published-date-recovery: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
