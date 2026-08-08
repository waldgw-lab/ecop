// =============================================================================
// Curated-only OFF-HOST discovery via Bing News RSS (Task #661).
//
// Some registered, trusted US outlets cannot be reached directly from this
// infrastructure's datacenter egress:
//   - Breaking Defense — breakingdefense.com/feed/ intermittently 403s from the
//       prod egress (Cloudflare), so the direct RSS pipe in curatedFeeds.ts can
//       silently go dark. This off-host path is a resilient SUPPLEMENT (both
//       dedup by URL downstream, so no double-count).
//   - Stars and Stripes — publishes no working RSS from this infra (all paths
//       404/stale) and a bespoke homepage scraper was previously rejected on
//       maintenance cost.
//   - USA Today — its public RSS was retired (rssfeeds.usatoday.com now serves
//       HTML), so it went silent in the curated aperture.
//
// Bing News indexes all three and, unlike Google News' now-undecodable signed
// redirects, its RSS item links carry the REAL publisher URL in the `url=` query
// param, so clean article URLs can be recovered off-host. This is the SAME
// decode already proven by the Reuters bot (server/reutersBot.ts) — but that bot
// posts to Team chat, whereas this module is CURATED-ONLY: every discovered
// headline funnels through admitCuratedCandidates('gate') into curated_items /
// curated_classifications ONLY, and NEVER the main feed / Classic / Visual /
// custom-MCOP feeds / public API.
//
// The lane TIER (contributing vs attach-only) is resolved downstream from the
// Outlet Registry by `sourceName`, so that string MUST match a registry
// canonical name / alias / domain, or the item silently falls back to
// attach-only. All three below seed as contributing US outlets.
// =============================================================================
import * as cheerio from 'cheerio';
import { isRecentUrl } from './articleDateFilter';
import { fetchWithResilience } from './resilientFetch';
import { storage } from './storage';

export interface CuratedOffHostSource {
  // Scheduler/admin toggle id (BOT_DEFINITIONS) + curated admission label.
  id: string;
  label: string;
  // Registry-resolvable outlet name (canonical / alias / domain).
  sourceName: string;
  logTag: string;
  // Bing News RSS search URLs (site-scoped). Each is `site:<domain>` plus, for a
  // broad general outlet, topical terms that bias the result set toward
  // defense/security so the bounded payload stays dense with on-topic candidates.
  bingQueries: string[];
  // Fail-closed host allowlist: the decoded real URL's hostname MUST satisfy
  // this or the item is dropped (never store a Bing redirect or an aggregator
  // dupe such as msn.com that Bing occasionally returns for a site: query).
  hostMatch: (host: string) => boolean;
}

interface OffHostArticle {
  title: string;
  url: string;
}

// Bound how many candidates a single run hands to the curated store so a noisy
// Bing result set can't flood the curated clustering payload. Mirrors the cap
// used by the curated website scraper and the RSS-bot reject capture.
const MAX_CURATED_CANDIDATES = 60;

// Per-source in-flight guard so a slow run can't stack with the next hourly cron
// or the startup kick.
const inFlightSources = new Set<string>();

// Bing News RSS links look like
//   https://www.bing.com/news/apiclick.aspx?...&url=<url-encoded real URL>&...
// Pull the real URL out of the `url=` param and fail-closed to the source's own
// host allowlist, dropping Bing's occasional aggregator dupes.
export function extractRealUrlFromBing(
  bingLink: string,
  hostMatch: (host: string) => boolean,
): string | null {
  try {
    const real = new URL(bingLink).searchParams.get('url');
    if (!real) return null;
    const host = new URL(real).hostname.toLowerCase();
    if (!hostMatch(host)) return null;
    return real;
  } catch {
    return null;
  }
}

// Pure parser: turn one Bing News RSS document into {title,url} articles. Holds
// ALL extraction logic so it can be exercised by saved fixtures without network
// (scripts/curated-offhost.test.ts) — if Bing changes its item markup this fails
// loudly in the harness instead of trickling to zero in prod.
// `seenUrls` dedups across the multiple site-scoped queries in one run.
// `applyDateFilter` gates the recency check: live runs keep only recent URLs;
// fixture tests leave it off so saved fixtures stay stable over time.
export function parseBingNewsRss(
  src: CuratedOffHostSource,
  xml: string,
  opts: { seenUrls?: Set<string>; applyDateFilter?: boolean } = {},
): OffHostArticle[] {
  const seenUrls = opts.seenUrls ?? new Set<string>();
  const applyDateFilter = opts.applyDateFilter ?? false;
  const articles: OffHostArticle[] = [];
  const $ = cheerio.load(xml, { xml: true });

  $('item').each((_, elem) => {
    const $elem = $(elem);
    let title = $elem.find('title').first().text().trim();
    const link = $elem.find('link').first().text().trim();
    if (!title || !link) return;

    const realUrl = extractRealUrlFromBing(link, src.hostMatch);
    if (!realUrl) return;
    // Skip obvious non-article assets.
    if (/\/(video|videos|picture|pictures|gallery)\//i.test(realUrl)) return;

    // Strip query/hash for a stable dedup + storage key.
    const cleanUrl = realUrl.split('?')[0].split('#')[0];
    if (seenUrls.has(cleanUrl)) return;

    title = title.replace(/\s+/g, ' ').trim();
    if (title.length < 10) return;
    if (title.length > 200) title = title.substring(0, 200) + '...';

    if (applyDateFilter && !isRecentUrl(cleanUrl, src.logTag)) return;

    seenUrls.add(cleanUrl);
    articles.push({ title, url: cleanUrl });
  });

  return articles;
}

interface OffHostFetchResult {
  articles: OffHostArticle[];
  fetchFailures: number;
  lastFetchError: string | null;
}

function shortFetchError(message: string): string {
  const clean = (message || 'fetch failed').trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
}

async function fetchOffHostHeadlines(src: CuratedOffHostSource): Promise<OffHostFetchResult> {
  const articles: OffHostArticle[] = [];
  const seenUrls = new Set<string>();
  let fetchFailures = 0;
  let lastFetchError: string | null = null;

  for (const feedUrl of src.bingQueries) {
    try {
      console.log(`[${src.logTag}] Fetching via Bing News RSS: ${feedUrl}`);
      const response = await fetchWithResilience(feedUrl, {
        accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
        timeoutMs: 15000,
        retries: 2,
        label: src.logTag,
      });
      if (!response.ok) {
        console.error(`[${src.logTag}] Failed to fetch Bing News RSS: ${response.status}`);
        fetchFailures++;
        lastFetchError = shortFetchError(`HTTP ${response.status} fetching Bing News RSS`);
        continue;
      }
      const xml = await response.text();
      articles.push(...parseBingNewsRss(src, xml, { seenUrls, applyDateFilter: true }));
    } catch (error) {
      console.error(`[${src.logTag}] Error fetching Bing News RSS ${feedUrl}:`, error);
      fetchFailures++;
      lastFetchError = shortFetchError((error as Error).message);
    }
  }

  console.log(`[${src.logTag}] Found ${articles.length} recent article(s)`);
  return { articles, fetchFailures, lastFetchError };
}

export async function runCuratedOffHostBot(
  src: CuratedOffHostSource,
): Promise<{ ingested: number; skipped: number; errors: number }> {
  if (inFlightSources.has(src.id)) {
    console.log(`[${src.logTag}] Previous run still in flight, skipping this cycle`);
    return { ingested: 0, skipped: 0, errors: 0 };
  }
  inFlightSources.add(src.id);
  console.log(`[${src.logTag}] Starting curated-only off-host scan...`);
  const startTime = Date.now();

  try {
    const { articles, fetchFailures, lastFetchError } = await fetchOffHostHeadlines(src);
    await storage.mergeCuratedIntakeFeedStats(new Map([[
      src.sourceName,
      {
        fetched: articles.length,
        kept: articles.length,
        aged: 0,
        dupInPass: 0,
        fetchFailures,
        lastFetchError,
        admissionPending: false,
      },
    ]])).catch((err) => {
      console.warn(`[${src.logTag}] Failed to persist off-host fetch stats (non-fatal):`, (err as Error).message);
    });
    if (articles.length === 0) {
      console.log(`[${src.logTag}] No articles found, skipping this cycle`);
      return { ingested: 0, skipped: 0, errors: 0 };
    }

    const candidates = articles.slice(0, MAX_CURATED_CANDIDATES).map((a) => ({
      title: a.title,
      url: a.url,
      source: src.sourceName,
    }));

    try {
      const { admitCuratedCandidates } = await import('./curatedIngest');
      const r = await admitCuratedCandidates(candidates, { mode: 'gate', label: src.label });
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `[${src.logTag}] Completed in ${duration}s - Admitted: ${r.ingested}, Skipped: ${r.skipped} (of ${candidates.length})`,
      );
      return { ingested: r.ingested, skipped: r.skipped, errors: 0 };
    } catch (err) {
      console.error(`[${src.logTag}] Curated intake failed (non-fatal):`, err);
      return { ingested: 0, skipped: 0, errors: 1 };
    }
  } catch (error) {
    console.error(`[${src.logTag}] Fatal error:`, error);
    return { ingested: 0, skipped: 0, errors: 1 };
  } finally {
    inFlightSources.delete(src.id);
  }
}

// ---------------------------------------------------------------------------
// Source definitions. `sourceName` MUST resolve in the Outlet Registry
// (server/outletRegistrySeed.ts) — all three verified as contributing US
// outlets: "Breaking Defense", "Stars and Stripes" (domain stripes.com),
// "USA Today" (domain usatoday.com).
// ---------------------------------------------------------------------------
export const BREAKING_DEFENSE_OFFHOST_SOURCE: CuratedOffHostSource = {
  id: 'breakingDefenseOffHostBot',
  label: 'breaking-defense-offhost',
  sourceName: 'Breaking Defense',
  logTag: 'BreakingDefenseOffHost',
  bingQueries: [
    'https://www.bing.com/news/search?q=site%3Abreakingdefense.com&format=RSS',
    'https://www.bing.com/news/search?q=site%3Abreakingdefense.com+(pentagon+OR+navy+OR+army+OR+%22air+force%22+OR+missile+OR+ukraine+OR+china)&format=RSS',
  ],
  hostMatch: (h) => h === 'breakingdefense.com' || h.endsWith('.breakingdefense.com'),
};

export const STARS_STRIPES_OFFHOST_SOURCE: CuratedOffHostSource = {
  id: 'starsStripesOffHostBot',
  label: 'stars-stripes-offhost',
  sourceName: 'Stars and Stripes',
  logTag: 'StarsStripesOffHost',
  bingQueries: [
    'https://www.bing.com/news/search?q=site%3Astripes.com&format=RSS',
    'https://www.bing.com/news/search?q=site%3Astripes.com+(military+OR+navy+OR+army+OR+veterans+OR+pentagon+OR+deployment)&format=RSS',
  ],
  hostMatch: (h) => h === 'stripes.com' || h.endsWith('.stripes.com'),
};

// USA Today is a broad general-interest outlet (sports/entertainment dominate a
// bare site: query), so scope the Bing query to defense/security terms only —
// the curated gate would reject the rest anyway, and this keeps the bounded
// payload dense with on-topic candidates.
export const USA_TODAY_OFFHOST_SOURCE: CuratedOffHostSource = {
  id: 'usaTodayOffHostBot',
  label: 'usa-today-offhost',
  sourceName: 'USA Today',
  logTag: 'UsaTodayOffHost',
  bingQueries: [
    'https://www.bing.com/news/search?q=site%3Ausatoday.com+(military+OR+pentagon+OR+ukraine+OR+china+OR+israel+OR+defense+OR+%22national+security%22)&format=RSS',
  ],
  hostMatch: (h) => h === 'usatoday.com' || h.endsWith('.usatoday.com'),
};

// Bloomberg's own RSS feed (feeds.bloomberg.com/politics/news.rss) returns
// HTTP 404 from this infrastructure. Off-host discovery via Bing News RSS
// recovers the outlet without depending on Bloomberg's own feed. Scoped to
// defense/security/geopolitics terms so the gate rejects fewer candidates.
export const BLOOMBERG_OFFHOST_SOURCE: CuratedOffHostSource = {
  id: 'bloombergOffHostBot',
  label: 'bloomberg-offhost',
  sourceName: 'Bloomberg',
  logTag: 'BloombergOffHost',
  bingQueries: [
    'https://www.bing.com/news/search?q=site%3Abloomberg.com+(military+OR+pentagon+OR+ukraine+OR+china+OR+%22national+security%22+OR+defense+OR+nato+OR+sanctions)&format=RSS',
  ],
  hostMatch: (h) => h === 'bloomberg.com' || h.endsWith('.bloomberg.com'),
};

export const CURATED_OFFHOST_SOURCES: CuratedOffHostSource[] = [
  BREAKING_DEFENSE_OFFHOST_SOURCE,
  STARS_STRIPES_OFFHOST_SOURCE,
  USA_TODAY_OFFHOST_SOURCE,
  BLOOMBERG_OFFHOST_SOURCE,
];
