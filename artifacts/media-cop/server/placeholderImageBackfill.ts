import { db } from './db';
import { curatedItems } from '@shared/schema';
import { and, isNull, like, sql } from 'drizzle-orm';
import { isPlaceholderImageUrl } from '@shared/placeholderImage';
import { safeFetch } from './streamPrefetch';

// One-time cleanup of curated rows stuck displaying a RE-HOSTED outlet
// placeholder/logo (Task: stop re-hosted placeholder logos in curated view).
//
// Background: the media pipeline downloads an article's og:image and re-hosts
// it into object storage (`/objects/stream-images/…`), destroying the original
// URL — so a branded fallback share image (e.g. ABC News' Disney-branded
// `abc_news_default_*`) that was re-hosted BEFORE its URL pattern was added to
// PLACEHOLDER_IMAGE_PATTERNS can never be caught by the URL filter again.
// Confirmed live on the North Korea missile story's ABC member.
//
// This sweep runs once per row (gated by placeholder_recheck_at):
//   1. Rows WITH provenance (og_image_source_url) are checked directly against
//      isPlaceholderImageUrl — no network needed.
//   2. Legacy rows WITHOUT provenance are only re-checked when their article
//      host belongs to an outlet with a known URL-pattern placeholder (ABC,
//      NPR — the patterns this task covers). For those, the article page is
//      re-fetched and its CURRENT og:image is tested against the placeholder
//      patterns; a match means the stored re-hosted image originated from the
//      same branded default.
// A confirmed placeholder clears the stored image and resets the enrichment
// back-off so the normal enrichment/fallback flow can find a real photo from
// another member. Real photos are never touched: only a positive placeholder
// match (provenance or fresh og:image) clears anything — every failure path
// just stamps the row as checked and moves on. The daily orphan image sweep
// later removes the de-referenced object file.

const RECHECK_HOST_SUFFIXES = ['abcnews.go.com', 'abcnews.com', 'npr.org'];
const MAX_ROWS_PER_RUN = 80;
const FETCH_TIMEOUT_MS = 10 * 1000;

function isRecheckHost(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return RECHECK_HOST_SUFFIXES.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

function extractOgImage(html: string): string | null {
  const m =
    html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i) ||
    html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);
  return m?.[1] ?? null;
}

async function fetchCurrentOgImage(articleUrl: string): Promise<string | null> {
  try {
    // SSRF-hardened fetch (same per-hop host validation + DNS-pinned transport
    // as media enrichment): stored curated URLs are attacker-influenced, and a
    // redirect from a matching ABC/NPR URL must never reach an internal or
    // metadata address. Never use a bare redirect-following fetch here.
    const res = await safeFetch(articleUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return null;
    return extractOgImage(await res.text());
  } catch {
    return null;
  }
}

async function clearPlaceholderImage(id: string, reason: string): Promise<void> {
  await db
    .update(curatedItems)
    .set({
      ogImageUrl: null,
      ogImageSourceUrl: null,
      mediaScrapedAt: null,
      mediaAttemptCount: 0,
      lastMediaAttemptAt: null,
      placeholderRecheckAt: new Date(),
    })
    .where(sql`${curatedItems.id} = ${id}`);
  console.log(`[PlaceholderBackfill] Cleared re-hosted placeholder image for curated:${id} (${reason})`);
}

async function stampChecked(id: string): Promise<void> {
  await db
    .update(curatedItems)
    .set({ placeholderRecheckAt: new Date() })
    .where(sql`${curatedItems.id} = ${id}`);
}

// Injectable dependencies so the drain loop is deterministically testable
// without a database or network (see placeholderImageBackfill.selftest.ts).
export interface BackfillDeps {
  selectBatch: (limit: number) => Promise<Array<{ id: string; url: string; ogImageSourceUrl: string | null }>>;
  fetchOgImage: (articleUrl: string) => Promise<string | null>;
  clear: (id: string, reason: string) => Promise<void>;
  stamp: (id: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: BackfillDeps = {
  selectBatch: (limit) =>
    db
      .select({
        id: curatedItems.id,
        url: curatedItems.url,
        ogImageSourceUrl: curatedItems.ogImageSourceUrl,
      })
      .from(curatedItems)
      .where(
        and(
          like(curatedItems.ogImageUrl, '/objects/stream-images/%'),
          isNull(curatedItems.placeholderRecheckAt),
        ),
      )
      .limit(limit),
  fetchOgImage: fetchCurrentOgImage,
  clear: clearPlaceholderImage,
  stamp: stampChecked,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function runPlaceholderImageBackfill(
  deps: BackfillDeps = defaultDeps,
): Promise<{ scanned: number; cleared: number }> {
  let scanned = 0;
  let cleared = 0;
  // Drain ALL eligible legacy rows in bounded repeated batches within this one
  // invocation: network fetches are capped per batch (rate limiting) with a
  // short pause between batches, and the loop keeps going until a select comes
  // back empty. There is NO fixed total-batch cutoff — every processed row is
  // stamped, so each batch strictly shrinks the eligible set; the only break
  // besides drain-complete is a no-progress guard (defensive: a batch that
  // stamps/clears nothing means writes are failing, so looping would spin
  // forever on the same rows).
  try {
    for (;;) {
      const rows = await deps.selectBatch(500);
      if (rows.length === 0) break;

      let fetchesThisBatch = 0;
      let progressedThisBatch = 0;
      for (const row of rows) {
        // Provenance-based check: free, no network.
        if (row.ogImageSourceUrl) {
          scanned++;
          if (isPlaceholderImageUrl(row.ogImageSourceUrl)) {
            await deps.clear(row.id, 'provenance matched placeholder pattern');
            cleared++;
          } else {
            await deps.stamp(row.id);
          }
          progressedThisBatch++;
          continue;
        }
        // Legacy rows without provenance: only re-fetch for hosts whose branded
        // default is covered by a URL pattern (ABC / NPR). Everything else is
        // stamped checked without a fetch — we have no signal to test.
        if (!isRecheckHost(row.url)) {
          await deps.stamp(row.id);
          progressedThisBatch++;
          continue;
        }
        if (fetchesThisBatch >= MAX_ROWS_PER_RUN) continue; // picked up by the next batch below
        fetchesThisBatch++;
        scanned++;
        const freshOgImage = await deps.fetchOgImage(row.url);
        if (freshOgImage && isPlaceholderImageUrl(freshOgImage)) {
          await deps.clear(row.id, `fresh og:image is placeholder: ${freshOgImage.slice(0, 100)}`);
          cleared++;
        } else {
          // Real photo, or page unreachable — do NOT clear; stamp so we never
          // re-fetch this row again.
          await deps.stamp(row.id);
        }
        progressedThisBatch++;
      }
      if (progressedThisBatch === 0) {
        console.error('[PlaceholderBackfill] No progress in batch (writes failing?) — aborting sweep');
        break;
      }
      // Brief pause between batches so a large legacy population can't
      // monopolize outbound connections right after boot.
      await deps.sleep(5 * 1000);
    }
    if (scanned > 0 || cleared > 0) {
      console.log(`[PlaceholderBackfill] Done: scanned=${scanned}, cleared=${cleared}`);
    }
  } catch (error) {
    console.error('[PlaceholderBackfill] Sweep failed (non-fatal):', error);
  }
  return { scanned, cleared };
}
