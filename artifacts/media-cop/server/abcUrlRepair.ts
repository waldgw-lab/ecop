import Parser from 'rss-parser';
import { db } from './db';
import { teamSubmissions, curatedItems } from '@shared/schema';
import { and, eq, like, notLike } from 'drizzle-orm';

// =============================================================================
// One-time repair of ABC News rows whose stored URL lost its `?id=` query.
//
// ABC `/story` permalinks carry the article id in the query string
// (…/<slug>/story?id=133825956). The news bots historically stored a
// query-stripped URL as the canonical/displayed link, leaving a bare …/story
// path that returns HTTP 404. The `/story` path still contains the article's
// unique slug, so we can recover the missing id by matching the stripped path
// against ABC's live RSS feeds and re-appending only `?id=<id>` to the existing
// stored URL (host/path untouched).
//
// This is a self-limiting, idempotent cleanup: after repair the rows carry
// `?id=` and no longer match the "stripped /story, no query" filter, and rows
// too old to appear in ABC's live feed window are simply left to age out.
// =============================================================================

const ABC_RSS_FEEDS = [
  'https://feeds.abcnews.com/abcnews/topstories',
  'https://feeds.abcnews.com/abcnews/internationalheadlines',
  'https://feeds.abcnews.com/abcnews/politicsheadlines',
  'https://feeds.abcnews.com/abcnews/usheadlines',
];

// Lowercased pathname of a `/story` permalink, used as a host-agnostic key.
function storyPathKey(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    return path.endsWith('/story') ? path : null;
  } catch {
    return null;
  }
}

// Build a map: stripped `/story` pathname -> recovered article id, from ABC's
// live RSS feeds. Only entries that actually carry an `?id=` are included.
async function buildIdMap(): Promise<Map<string, string>> {
  const parser = new Parser({ timeout: 15000 });
  const map = new Map<string, string>();

  for (const feedUrl of ABC_RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items || []) {
        if (!item.link) continue;
        let id: string | null = null;
        try {
          id = new URL(item.link).searchParams.get('id');
        } catch {
          id = null;
        }
        if (!id) continue;
        const key = storyPathKey(item.link);
        if (key) map.set(key, id);
      }
    } catch (error) {
      console.error(`[ABCUrlRepair] Error fetching RSS feed ${feedUrl}:`, error);
    }
  }

  return map;
}

export async function repairAbcStoryUrls(): Promise<void> {
  if (!process.env.DATABASE_URL) return;

  let idMap: Map<string, string>;
  try {
    idMap = await buildIdMap();
  } catch (error) {
    console.error('[ABCUrlRepair] Failed to build id map:', error);
    return;
  }

  if (idMap.size === 0) {
    console.log('[ABCUrlRepair] No recoverable ABC story ids from live feeds; skipping.');
    return;
  }

  let submissionsFixed = 0;
  let curatedFixed = 0;

  // --- Originating team submissions ---
  try {
    const rows = await db
      .select({ id: teamSubmissions.id, sourceUrl: teamSubmissions.sourceUrl })
      .from(teamSubmissions)
      .where(
        and(
          like(teamSubmissions.sourceUrl, '%abcnews%'),
          like(teamSubmissions.sourceUrl, '%/story'),
          notLike(teamSubmissions.sourceUrl, '%?id=%'),
        ),
      );

    for (const row of rows) {
      const key = storyPathKey(row.sourceUrl);
      if (!key) continue;
      const id = idMap.get(key);
      if (!id) continue;
      const repaired = `${row.sourceUrl.replace(/\/+$/, '')}?id=${id}`;
      await db
        .update(teamSubmissions)
        .set({ sourceUrl: repaired })
        .where(eq(teamSubmissions.id, row.id));
      submissionsFixed++;
    }
  } catch (error) {
    console.error('[ABCUrlRepair] Error repairing team submissions:', error);
  }

  // --- Curated items (cloned from the submissions above) ---
  try {
    const rows = await db
      .select({ id: curatedItems.id, url: curatedItems.url })
      .from(curatedItems)
      .where(
        and(
          like(curatedItems.url, '%abcnews%'),
          like(curatedItems.url, '%/story'),
          notLike(curatedItems.url, '%?id=%'),
        ),
      );

    for (const row of rows) {
      const key = storyPathKey(row.url);
      if (!key) continue;
      const id = idMap.get(key);
      if (!id) continue;
      const repaired = `${row.url.replace(/\/+$/, '')}?id=${id}`;
      try {
        await db
          .update(curatedItems)
          .set({ url: repaired })
          .where(eq(curatedItems.id, row.id));
        curatedFixed++;
      } catch (error: any) {
        // url is UNIQUE; a collision (already-repaired twin) is harmless.
        if (error?.code === '23505') continue;
        throw error;
      }
    }
  } catch (error) {
    console.error('[ABCUrlRepair] Error repairing curated items:', error);
  }

  console.log(
    `[ABCUrlRepair] Repaired ABC /story URLs — submissions: ${submissionsFixed}, curated: ${curatedFixed}`,
  );
}
