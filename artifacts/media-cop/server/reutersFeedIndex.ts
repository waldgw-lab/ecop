// =============================================================================
// Reuters image index (Task #696).
//
// Reuters' article pages return a host-level 401 bot wall to this datacenter,
// so curated Reuters rows can't recover a real lead photo through the normal
// enrichment chain (direct/12ft/strengthened all fail, paywall2 never cracks
// them) and fall to Jina + CPC only — which frequently return no image, leaving
// the row frozen on the generic favicon once it exhausts MAX_MEDIA_ATTEMPTS.
//
// Bloomberg (Task #655) and WSJ (Task #692) close the same gap by polling the
// outlet's PUBLIC RSS section feeds, which carry a real lead photo via
// <media:content>. Reuters was left out of those because its RSS feeds were
// "not confirmed to have feed images."
//
// Live verification (July 2026) confirmed WHY: Reuters has NO working public
// RSS feed anymore. feeds.reuters.com no longer resolves via DNS, and every
// reuters.com RSS endpoint (/tools/rss, /world/rss, arc outboundfeeds/rss)
// returns the same 401 "please enable JS" bot wall as the article pages. So
// there is no media:content RSS source to model on.
//
// HOWEVER, Reuters' PUBLIC Google-News sitemap IS unblocked from this
// datacenter (HTTP 200) and every recent article entry carries a real full-size
// lead photo via <image:image><image:loc> pointing at Reuters' own CDN
// (reuters.com/resizer/v2/...jpg) — verified to resolve to real ~1280-1920px
// JPEGs (250KB+), not blank/favicon. This module polls the first few pages of
// that sitemap and exposes the SAME url -> image lookup the Bloomberg/WSJ feed
// indexes do, so the curated enrichment path can recover an uncrackable Reuters
// row's photo for free (in-memory) before spending any doomed page-fetch / CPC
// budget.
//
// Curated lane only. Reuters only (getReutersFeedImage internally gates on
// reuters.com). Read-only against Reuters; never writes curated_items directly
// (the caller persists the image + stamps media_scraped_at exactly like any
// other recovered image).
// =============================================================================

import { fetchWithResilience } from './resilientFetch';
import { normalizeIdentityUrl } from './urlIdentity';

// Reuters' Google-News sitemap is paginated (from=0,100,200,...). The most
// recent articles — which is what curated recency needs — live on the first
// pages, so we poll a bounded prefix rather than all 15 pages every refresh.
const REUTERS_SITEMAP_URLS: readonly string[] = [
  'https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml',
  'https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml&from=100',
  'https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml&from=200',
];

// Bounded refresh cadence — the index is refreshed lazily (on-demand, from
// inside the enrichment path) rather than on its own cron, so this just caps
// how often a curated enrichment call pays the sitemap-fetch cost.
const REFRESH_INTERVAL_MS = 12 * 60 * 1000;
const PER_FEED_TIMEOUT_MS = 10 * 1000;

// url (normalized via normalizeIdentityUrl) -> Reuters CDN image URL.
// A fresh Map replaces the old one only on a fully-successful refresh pass
// merge (per-page failures just skip that page and keep whatever the index
// already had), so a transient outage never wipes previously-recovered
// image mappings.
let imageByUrl: Map<string, string> = new Map();
let lastRefreshedAt = 0;
let refreshInFlight: Promise<void> | null = null;

function isReutersUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'reuters.com' || host.endsWith('.reuters.com');
  } catch {
    return false;
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// Parse a Google-News sitemap: each <url> block has one article <loc> and, when
// present, an <image:image><image:loc> lead photo. We take the FIRST image in
// each block (the lead) and key it by the article loc.
function parseSitemap(xml: string, into: Map<string, string>): { items: number; images: number } {
  let items = 0;
  let images = 0;
  const urlBlocks = xml.match(/<url\b[\s\S]*?<\/url>/gi) ?? [];
  for (const block of urlBlocks) {
    const locMatch = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/i);
    if (!locMatch?.[1]) continue;
    const articleUrl = decodeXmlEntities(locMatch[1].trim());
    items++;
    const imgMatch = block.match(/<image:loc>\s*([^<]+?)\s*<\/image:loc>/i);
    if (imgMatch?.[1]) {
      const imgUrl = decodeXmlEntities(imgMatch[1].trim());
      if (imgUrl) {
        into.set(normalizeIdentityUrl(articleUrl), imgUrl);
        images++;
      }
    }
  }
  return { items, images };
}

async function refreshOneSitemap(sitemapUrl: string, into: Map<string, string>): Promise<{ items: number; images: number }> {
  const resp = await fetchWithResilience(sitemapUrl, {
    accept: 'application/xml, text/xml, */*',
    timeoutMs: PER_FEED_TIMEOUT_MS,
    retries: 1,
    label: `ReutersFeedIndex:${sitemapUrl}`,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const xml = await resp.text();
  return parseSitemap(xml, into);
}

async function doRefresh(): Promise<void> {
  // Start from a copy of the current index so a page that fails this pass
  // doesn't lose entries it contributed on a prior successful pass.
  const merged = new Map(imageByUrl);
  let totalItems = 0;
  let totalImages = 0;
  let failedFeeds = 0;

  await Promise.all(
    REUTERS_SITEMAP_URLS.map(async (sitemapUrl) => {
      try {
        const { items, images } = await refreshOneSitemap(sitemapUrl, merged);
        totalItems += items;
        totalImages += images;
      } catch (err: any) {
        failedFeeds++;
        console.log(`[ReutersFeedIndex] Sitemap fetch failed for ${sitemapUrl}: ${err?.message || err}`);
      }
    }),
  );

  imageByUrl = merged;
  lastRefreshedAt = Date.now();
  console.log(
    `[ReutersFeedIndex] Refreshed — ${imageByUrl.size} URLs indexed total ` +
      `(this pass: ${totalItems} items, ${totalImages} with images, ${failedFeeds}/${REUTERS_SITEMAP_URLS.length} pages failed)`,
  );
}

/** Force a refresh now (deduped — concurrent callers share one in-flight refresh). */
export async function refreshReutersFeedIndex(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * Look up a real lead image for a Reuters article URL from the sitemap image
 * index, refreshing the index first if it's stale. Returns null for non-Reuters
 * URLs, articles not present in the polled sitemap pages, or if the refresh
 * itself fails (in which case the last-known-good index is still consulted).
 * Never throws.
 */
export async function getReutersFeedImage(url: string): Promise<string | null> {
  if (!isReutersUrl(url)) return null;
  if (Date.now() - lastRefreshedAt > REFRESH_INTERVAL_MS) {
    try {
      await refreshReutersFeedIndex();
    } catch {
      // Keep serving the last-known-good index below.
    }
  }
  return imageByUrl.get(normalizeIdentityUrl(url)) ?? null;
}
