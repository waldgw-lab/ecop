// =============================================================================
// WSJ RSS feed image index (Task #692).
//
// WSJ's article pages are hard-blocked (added to isHardBlockedOutlet alongside
// Bloomberg/Reuters) — direct/12ft/strengthened fetches 403 or redirect to a
// login wall, so most curated WSJ rows recover their lead photo through the
// paywall2 breaker. But if a WSJ article page can't be cracked by paywall2
// (e.g. heavily geo-restricted or live pages) the row would exhaust
// MAX_MEDIA_ATTEMPTS and freeze on the generic favicon.
//
// Live verification (July 2026) confirmed WSJ's PUBLIC section RSS feeds are
// NOT blocked and every item carries a real full-size lead photo via
// <media:content> pointing at WSJ's own CDN (images.wsj.net) — e.g.
// RSSWorldNews / RSSWSJD / RSSMarketsMain / WSJcomUSBusiness / RSSUSnews /
// RSSOpinion all returned HTTP 200 with media:content on ~95-100% of items,
// and the referenced images resolve to real 1280px JPEGs (not blank/favicon).
// This module polls those feeds and exposes a simple url -> image lookup that
// the curated enrichment path checks BEFORE the doomed page fetches / paywall2,
// giving uncrackable WSJ rows a free fallback image without burning any budget.
//
// Curated lane only. WSJ only (getWsjFeedImage internally gates on wsj.com).
// Read-only against WSJ; never writes curated_items directly (the caller
// persists the image + stamps media_scraped_at exactly like any other
// recovered image).
// =============================================================================

import Parser from 'rss-parser';
import { fetchWithResilience } from './resilientFetch';
import { normalizeIdentityUrl } from './urlIdentity';

// Section feeds chosen to cover the range of WSJ content that actually appears
// in curated rows (world/markets/tech/business/US/opinion). All verified live
// to return media:content lead images.
// Exported (read-only) so the live-validation harness asserts against the SAME
// feed slugs the enrichment path actually polls — a slug rename can't silently
// pass the test.
export const WSJ_FEED_URLS: readonly string[] = [
  'https://feeds.content.dowjones.io/public/rss/RSSWorldNews',
  'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain',
  'https://feeds.content.dowjones.io/public/rss/RSSWSJD',
  'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness',
  'https://feeds.content.dowjones.io/public/rss/RSSUSnews',
  'https://feeds.content.dowjones.io/public/rss/RSSOpinion',
];

// Bounded refresh cadence — the index is refreshed lazily (on-demand, from
// inside the enrichment path) rather than on its own cron, so this just caps
// how often a curated enrichment call pays the feed-fetch cost.
const REFRESH_INTERVAL_MS = 12 * 60 * 1000;
const PER_FEED_TIMEOUT_MS = 10 * 1000;

// url (normalized via normalizeIdentityUrl) -> WSJ CDN image URL.
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

export function isWsjUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'wsj.com' || host.endsWith('.wsj.com');
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

export function extractMediaImage(item: any): string | null {
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
    label: `WsjFeedIndex:${feedUrl}`,
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
    WSJ_FEED_URLS.map(async (feedUrl) => {
      try {
        const { items, images } = await refreshOneFeed(feedUrl, merged);
        totalItems += items;
        totalImages += images;
      } catch (err: any) {
        failedFeeds++;
        console.log(`[WsjFeedIndex] Feed fetch failed for ${feedUrl}: ${err?.message || err}`);
      }
    }),
  );

  imageByUrl = merged;
  lastRefreshedAt = Date.now();
  console.log(
    `[WsjFeedIndex] Refreshed — ${imageByUrl.size} URLs indexed total ` +
      `(this pass: ${totalItems} items, ${totalImages} with images, ${failedFeeds}/${WSJ_FEED_URLS.length} feeds failed)`,
  );
}

/** Force a refresh now (deduped — concurrent callers share one in-flight refresh). */
export async function refreshWsjFeedIndex(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * Look up a real lead image for a WSJ article URL from the RSS feed index,
 * refreshing the index first if it's stale. Returns null for non-WSJ URLs,
 * articles not present in the polled sections, or if the refresh itself fails
 * (in which case the last-known-good index is still consulted). Never throws.
 */
export async function getWsjFeedImage(url: string): Promise<string | null> {
  if (!isWsjUrl(url)) return null;
  if (Date.now() - lastRefreshedAt > REFRESH_INTERVAL_MS) {
    try {
      await refreshWsjFeedIndex();
    } catch {
      // Keep serving the last-known-good index below.
    }
  }
  return imageByUrl.get(normalizeIdentityUrl(url)) ?? null;
}
