import * as cheerio from 'cheerio';

// =============================================================================
// Task #653 — "stale-as-fresh" fix.
//
// Outlets (Reuters is the reported example) reuse generic date-ish tags
// (meta[name="date"], meta[name="pubdate"], and sometimes even
// meta[property="og:published_time"]) to carry the *last-updated* timestamp
// once a story is refreshed, not the original publish time. Treating "first
// date tag found" as authoritative silently turns a days-old story into one
// that looks freshly published.
//
// The fix: only a small set of STRUCTURED, purpose-built "original publish"
// signals are trusted for `publishedAt` (JSON-LD datePublished, the
// article:published_time family, itemprop=datePublished, an explicit
// time[pubdate] marker, and a short list of vendor-specific original-publish
// meta tags). Generic/ambiguous tags (meta[name="date"], meta[name="pubdate"],
// bare time[datetime], free-text ".publish-date" style selectors) are NEVER
// used for `publishedAt` — they are exactly the tags outlets are known to
// overwrite. `updatedAt` is captured separately from explicit
// modified/updated signals and is never promoted to `publishedAt`.
//
// Callers that only need a best-effort "original publish" date (main-feed
// scraper.ts) keep using `extractArticleTimestamp()`, which now returns null
// more often but never returns a fabricated date. Callers that also care
// about the update time (curated) use `extractArticleTimestamps()`.
// =============================================================================

export interface ExtractedTimestamps {
  publishedAt: Date | null;
  updatedAt: Date | null;
}

export async function extractArticleTimestamp(url: string): Promise<Date | null> {
  const { publishedAt } = await extractArticleTimestamps(url);
  return publishedAt;
}

export async function extractArticleTimestamps(url: string): Promise<ExtractedTimestamps> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });

    if (!response.ok) {
      return { publishedAt: null, updatedAt: null };
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    return parseTimestampsFromHtml($);
  } catch (error) {
    console.error(`Failed to extract timestamp from ${url}:`, error instanceof Error ? error.message : 'Unknown error');
    return { publishedAt: null, updatedAt: null };
  }
}

// Convenience wrapper: parse trusted timestamps straight from an HTML STRING
// (loads cheerio internally). Used by curated enrichment (Task #933), which
// already has the article HTML in hand from the image/bullet fetch and wants
// to recover the original-publish date without a second network round-trip.
// Fail-safe: a cheerio load / parse error yields the empty result, never throws.
export function parseTimestampsFromHtmlString(html: string): ExtractedTimestamps {
  try {
    const $ = cheerio.load(html);
    return parseTimestampsFromHtml($);
  } catch {
    return { publishedAt: null, updatedAt: null };
  }
}

// Shared plausibility gate for a recovered original-publish date. A real publish
// date must not predate 2000 or sit ahead of the server clock. Even a small
// positive skew is unsafe here: Curated already has an honest first-seen
// timestamp, while a future publication instant can suspend enrichment/decay or
// make a scheduled article look newer than reporting that has actually landed.
// `parseDate` already rejects absurd years, but structured page metadata can
// still contain a timezone error or an embargo/scheduled timestamp.
// A failing/absent date returns false so callers leave the row null → the
// curated view honestly renders "First seen".
export function isPlausiblePublishedDate(d: Date | null | undefined): d is Date {
  return (
    !!d &&
    !isNaN(d.getTime()) &&
    d.getFullYear() > 2000 &&
    d.getTime() <= Date.now()
  );
}

// Pure parser (no network) so it can be reused against already-fetched HTML
// (e.g. aiAnalyzer.ts already has `$` loaded for a submitted link) and
// exercised directly in tests without a live fetch.
export function parseTimestampsFromHtml($: cheerio.CheerioAPI): ExtractedTimestamps {
  const jsonLd = tryJsonLD($);
  const publishedAt =
    jsonLd.publishedAt ||
    tryTrustedPublishedMeta($) ||
    tryTrustedPublishedTimeElements($);

  const updatedAt = jsonLd.updatedAt || tryUpdatedMeta($);

  return { publishedAt, updatedAt };
}

// Trusted "original publish" meta tags only. Deliberately EXCLUDES
// meta[name="date"], meta[name="pubdate"], and meta[property="og:published_time"]
// — outlets reuse these for the updated time, so treating them as the
// original publish date is exactly the Task #653 bug.
function tryTrustedPublishedMeta($: cheerio.CheerioAPI): Date | null {
  const metaSelectors = [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[property="article:published"]',
    'meta[itemprop="datePublished"]',
    'meta[name="publishdate"]',
    'meta[name="publish-date"]',
    'meta[name="DC.date.issued"]',
    'meta[name="sailthru.date"]',
    'meta[property="bt:pubDate"]',
  ];

  for (const selector of metaSelectors) {
    const content = $(selector).attr('content');
    if (content) {
      const date = parseDate(content);
      if (date) return date;
    }
  }

  return null;
}

// Ambiguous/updated-leaning meta tags. Never used for publishedAt.
function tryUpdatedMeta($: cheerio.CheerioAPI): Date | null {
  const metaSelectors = [
    'meta[property="article:modified_time"]',
    'meta[name="article:modified_time"]',
    'meta[property="og:updated_time"]',
  ];

  for (const selector of metaSelectors) {
    const content = $(selector).attr('content');
    if (content) {
      const date = parseDate(content);
      if (date) return date;
    }
  }

  return null;
}

// <time> elements only count as "original publish" when they carry an
// explicit, purpose-built marker (itemprop=datePublished or the HTML5
// `pubdate` boolean attribute). A bare `time[datetime]` with no such marker
// is exactly as ambiguous as a generic date meta tag (many CMSes stamp the
// last-modified time on the visible <time> element after an update), so it
// is intentionally NOT trusted here.
function tryTrustedPublishedTimeElements($: cheerio.CheerioAPI): Date | null {
  const timeElements = $('time[itemprop="datePublished"], time[pubdate]');

  for (let i = 0; i < timeElements.length; i++) {
    const $time = $(timeElements[i]);
    const datetime = $time.attr('datetime') || $time.attr('pubdate') || $time.text();
    if (datetime) {
      const date = parseDate(datetime);
      if (date) return date;
    }
  }

  return null;
}

// JSON-LD structured data. `datePublished` is a purpose-built original-publish
// field and is trusted; `dateModified` is captured separately as updatedAt and
// never used to backfill publishedAt.
//
// Handles both a top-level object, a top-level array, and the `@graph` wrapper
// pattern (e.g. `{"@context":"…","@graph":[{"@type":"NewsArticle",…}]}`) used
// by many outlets (WordPress-based sites, some agency feeds, etc.). Without the
// @graph unwrap, those outlets' datePublished is silently missed.
function collectJsonLdCandidates(raw: unknown): unknown[] {
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw)) {
    const out: unknown[] = [];
    for (const el of raw) out.push(...collectJsonLdCandidates(el));
    return out;
  }
  const node = raw as Record<string, unknown>;
  const nodes: unknown[] = [node];
  if (Array.isArray(node['@graph'])) {
    for (const el of node['@graph']) nodes.push(...collectJsonLdCandidates(el));
  }
  return nodes;
}

function tryJsonLD($: cheerio.CheerioAPI): { publishedAt: Date | null; updatedAt: Date | null } {
  let publishedAt: Date | null = null;
  let updatedAt: Date | null = null;

  try {
    const scripts = $('script[type="application/ld+json"]');

    for (let i = 0; i < scripts.length; i++) {
      const scriptContent = $(scripts[i]).html();
      if (!scriptContent) continue;

      try {
        const data = JSON.parse(scriptContent);
        const items = collectJsonLdCandidates(data);

        for (const raw of items) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
          const item = raw as Record<string, unknown>;
          const type = item['@type'];
          const isArticleLike =
            typeof type === 'string'
              ? /article|newsarticle|report|blogposting/i.test(type)
              : Array.isArray(type) && type.some((t: unknown) => typeof t === 'string' && /article|newsarticle|report|blogposting/i.test(t));

          if (!isArticleLike) continue;

          if (!publishedAt) {
            const raw2 = item['datePublished'] || item['publishedDate'];
            if (typeof raw2 === 'string') publishedAt = parseDate(raw2);
          }
          if (!updatedAt) {
            const raw2 = item['dateModified'] || item['modifiedDate'];
            if (typeof raw2 === 'string') updatedAt = parseDate(raw2);
          }

          if (publishedAt && updatedAt) return { publishedAt, updatedAt };
        }
      } catch {
        continue;
      }
    }
  } catch {
    // fail-safe: never let a JSON-LD parse error break the caller
  }

  return { publishedAt, updatedAt };
}

function parseDate(dateString: string): Date | null {
  if (!dateString) return null;

  try {
    const cleaned = dateString.trim();

    const isoDate = new Date(cleaned);
    if (!isNaN(isoDate.getTime()) && isoDate.getFullYear() > 2000 && isoDate.getFullYear() <= new Date().getFullYear() + 1) {
      return isoDate;
    }

    const patterns = [
      // "December 27, 2024" or "Dec 27, 2024"
      /(\w+)\s+(\d{1,2}),?\s+(\d{4})/,
      // "27 December 2024"
      /(\d{1,2})\s+(\w+)\s+(\d{4})/,
      // "2024-12-27"
      /(\d{4})-(\d{1,2})-(\d{1,2})/,
      // "12/27/2024" or "12-27-2024"
      /(\d{1,2})[/-](\d{1,2})[/-](\d{4})/
    ];

    for (const pattern of patterns) {
      const match = cleaned.match(pattern);
      if (match) {
        const parsed = new Date(cleaned);
        if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2000 && parsed.getFullYear() <= new Date().getFullYear() + 1) {
          return parsed;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}
