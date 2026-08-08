// Shared, pure title-dedup pass for the main public read feeds.
//
// This is the single heaviest synchronous step reachable from the Classic
// (`/api/headline-feed`), Visual (`/api/stream`), and custom-MCOP feed handlers,
// which all delegate ranking + dedup to `storage.getPrimaryFeed`. It is O(n^2):
// every candidate scans the already-kept set (findIndex + calculateSimilarity
// per pair). With the per-source fetch cap at 1000 rows the combined array can
// approach 2000 items, so at production volume this one pass can block the
// single-process event loop long enough to stall every other in-flight request
// — the same problem Task #681 fixed for the curated read.
//
// It was extracted from getPrimaryFeed (Task #684) so the yield-vs-no-yield
// output parity can be locked by a deterministic test (scripts/feed-dedup-parity.test.ts)
// without depending on the flaky live-scraping isolation harness.
//
// Yielding contract: `yieldFn` is awaited every `chunk` outer iterations. It
// changes ONLY scheduling — items are processed in the same order against the
// same growing `deduplicated` array, so the result is byte-identical regardless
// of the yield function or chunk size.
import { normalizeTitle, calculateSimilarity } from "./titleNormalizer";
import { yieldToEventLoop, CURATED_YIELD_CHUNK } from "./eventLoop";

// 70% word overlap = duplicate.
export const SIMILARITY_THRESHOLD = 0.7;

// Minimal shape the dedup pass reads. The real feed rows carry many more fields;
// those ride through untouched because unmatched items are pushed by reference
// and the manual-over-scraped merge spreads the whole item.
export interface DedupableFeedItem {
  title: string;
  url: string;
  type: "scraped" | "manual";
  originalPriority: number;
  depreciatedPriority: number;
}

/**
 * Deduplicate a pre-sorted combined feed by URL identity and title similarity.
 *
 * When duplicates collide the FIRST-seen item is kept, EXCEPT that a later
 * manual (user-submitted) item replaces an already-kept scraped item — so
 * user-curated media (reviewed image/bullets) is preserved — carrying the max
 * of the two priorities forward.
 *
 * @param combined  the ranked feed rows (already sorted by caller)
 * @param limit     optional cap applied to the final deduplicated list
 * @param yieldFn   awaited every `chunk` iterations to keep the event loop free
 * @param chunk     how many iterations between yields
 */
export async function dedupPrimaryFeed<T extends DedupableFeedItem>(
  combined: T[],
  limit?: number,
  yieldFn: () => Promise<void> = yieldToEventLoop,
  chunk: number = CURATED_YIELD_CHUNK,
): Promise<T[]> {
  const deduplicated: T[] = [];
  let yDedup = 0;
  for (const item of combined) {
    if (++yDedup % chunk === 0) await yieldFn();
    const normalizedItemTitle = normalizeTitle(item.title);

    // Check if this is a duplicate of any already-added item
    const duplicateIndex = deduplicated.findIndex((existing) => {
      const normalizedExistingTitle = normalizeTitle(existing.title);

      // Check URL match (same article, different scrape)
      if (item.url === existing.url) {
        return true;
      }

      // Check title similarity
      const similarity = calculateSimilarity(normalizedItemTitle, normalizedExistingTitle);
      return similarity >= SIMILARITY_THRESHOLD;
    });

    if (duplicateIndex === -1) {
      deduplicated.push(item);
    } else {
      const existing = deduplicated[duplicateIndex];
      // If current item is manual and existing is scraped, replace with the manual version
      // (preserves user-curated media data like reviewed image and bullets)
      if (item.type === "manual" && existing.type === "scraped") {
        const higherPriority = Math.max(item.depreciatedPriority, existing.depreciatedPriority);
        const higherOriginal = Math.max(item.originalPriority, existing.originalPriority);
        deduplicated[duplicateIndex] = { ...item, depreciatedPriority: higherPriority, originalPriority: higherOriginal };
      }
    }
  }

  // Apply limit if specified
  return limit ? deduplicated.slice(0, limit) : deduplicated;
}
