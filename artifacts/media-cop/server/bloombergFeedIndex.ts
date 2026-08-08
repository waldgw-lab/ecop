// =============================================================================
// Bloomberg RSS feed image index (Task #655).
//
// Bloomberg's article pages hard-block direct/Jina/paywall2/CPC fetches, so
// curated Bloomberg rows have no way to recover a real lead photo through the
// normal enrichment chain and freeze on the generic favicon once they exhaust
// MAX_MEDIA_ATTEMPTS. Bloomberg's PUBLIC section RSS feeds are NOT blocked and
// every item carries a real lead image via <media:content>/<media:thumbnail>
// pointing at Bloomberg's own CDN (assets.bwbx.io) — this module polls those
// feeds and exposes a simple url -> image lookup that the curated enrichment
// path checks BEFORE attempting the doomed page fetches.
//
// Curated lane only. Bloomberg only (Reuters is not confirmed to have feed
// images — out of scope per Task #655). Read-only against Bloomberg; never
// writes curated_items directly (the caller persists the image + stamps
// media_scraped_at exactly like any other recovered image).
// =============================================================================

import Parser from 'rss-parser';
import { fetchWithResilience } from './resilientFetch';
import { normalizeIdentityUrl } from './urlIdentity';

// Section feeds chosen to cover the range of Bloomberg outlets that actually
// appear in curated rows (the main RSS monitor only polls /politics/).
const BLOOMBERG_FEED_URLS: readonly string[] = [
  'https://feeds.bloomberg.com/politics/news.rss',
  'https://feeds.bloomberg.com/markets/news.rss',
  'https://feeds.bloomberg.com/technology/news.rss',
  'https://feeds.bloomberg.com/economics/news.rss',
];

// Bounded refresh cadence — the index is refreshed lazily (on-demand, from
// inside the enrichment path) rather than on its own cron, so this just caps
// how often a curated enrichment call pays the feed-fetch cost.
const REFRESH_INTERVAL_MS = 12 * 60 * 1000;
const PER_FEED_TIMEOUT_MS = 10 * 1000;

// url (normalized via normalizeIdentityUrl) -> Bloomberg CDN image URL.
// A fresh Map replaces the old one only on a fully-successful refresh pass
// merge (per-feed failures just skip that feed and keep whatever the index
// already had), so a transient feed outage never wipes previously-recovered
// image mappings.
let imageByUrl: Map<string, string> = new Map();
let lastRefreshedAt = 0;
let refreshInFlight: Promise<void> | null = null;

const parser = new Parser({
  timeout: PER_FEED_TIMEOUT_MS,
  customFields: {
    item: [['media:content', 'mediaContent', { keepArray: true }]],
  },
});

function isBloombergUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'bloomberg.com' || host.endsWith('.bloomberg.com');
  } catch {
    return false;
  }
}

function getAttrUrl(node: any): string | null {
  if (!node) return null;
  if (typeof node === 'string') return node;
  if (node.$ && typeof node.$.url === 'string') return node.$.url;
  return null;
}

function extractMediaImage(item: any): string | null {
  const raw = item.mediaContent ?? item['media:content'];
  const nodes = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const node of nodes) {
    const direct = getAttrUrl(node);
    if (direct) return direct;
    const thumb = getAttrUrl(node?.['media:thumbnail']);
    if (thumb) return thumb;
  }
  return null;
}

async function refreshOneFeed(feedUrl: string, into: Map<string, string>): Promise<{ items: number; images: number }> {
  const resp = await fetchWithResilience(feedUrl, {
    accept: 'application/rss+xml, application/xml, text/xml, */*',
    timeoutMs: PER_FEED_TIMEOUT_MS,
    retries: 1,
    label: `BloombergFeedIndex:${feedUrl}`,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const xml = await resp.text();
  const parsed = await parser.parseString(xml);
  let items = 0;
  let images = 0;
  for (const item of parsed.items ?? []) {
    if (!item.link) continue;
    items++;
    const img = extractMediaImage(item);
    if (img) {
      into.set(normalizeIdentityUrl(item.link), img);
      images++;
    }
  }
  return { items, images };
}

async function doRefresh(): Promise<void> {
  // Start from a copy of the current index so a feed that fails this pass
  // doesn't lose entries it contributed on a prior successful pass.
  const merged = new Map(imageByUrl);
  let totalItems = 0;
  let totalImages = 0;
  let failedFeeds = 0;

  await Promise.all(
    BLOOMBERG_FEED_URLS.map(async (feedUrl) => {
      try {
        const { items, images } = await refreshOneFeed(feedUrl, merged);
        totalItems += items;
        totalImages += images;
      } catch (err: any) {
        failedFeeds++;
        console.log(`[BloombergFeedIndex] Feed fetch failed for ${feedUrl}: ${err?.message || err}`);
      }
    }),
  );

  imageByUrl = merged;
  lastRefreshedAt = Date.now();
  console.log(
    `[BloombergFeedIndex] Refreshed — ${imageByUrl.size} URLs indexed total ` +
      `(this pass: ${totalItems} items, ${totalImages} with images, ${failedFeeds}/${BLOOMBERG_FEED_URLS.length} feeds failed)`,
  );
}

/** Force a refresh now (deduped — concurrent callers share one in-flight refresh). */
export async function refreshBloombergFeedIndex(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * Look up a real lead image for a Bloomberg article URL from the RSS feed
 * index, refreshing the index first if it's stale. Returns null for
 * non-Bloomberg URLs, articles not present in the polled sections, or if the
 * refresh itself fails (in which case the last-known-good index is still
 * consulted). Never throws.
 */
export async function getBloombergFeedImage(url: string): Promise<string | null> {
  if (!isBloombergUrl(url)) return null;
  if (Date.now() - lastRefreshedAt > REFRESH_INTERVAL_MS) {
    try {
      await refreshBloombergFeedIndex();
    } catch {
      // Keep serving the last-known-good index below.
    }
  }
  return imageByUrl.get(normalizeIdentityUrl(url)) ?? null;
}
