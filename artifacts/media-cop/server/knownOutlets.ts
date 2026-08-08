import { RSS_FEEDS } from './rssFeeds';
import { WARFIGHTER_ONLY_OUTLET_NAMES } from './warfighterRssScraper';

/**
 * Per-MCOP outlet allowlist: outlets that are scraped only for the named MCOP
 * slug and must not appear in any other MCOP's outlet selector or feed.
 */
const MCOP_ONLY_OUTLETS: Record<string, string[]> = {
  warfighter: WARFIGHTER_ONLY_OUTLET_NAMES,
};

const MCOP_ONLY_OUTLET_KEYS = new Set(
  Object.values(MCOP_ONLY_OUTLETS).flat().map(n => n.toLowerCase())
);

/**
 * Canonical list of every outlet/source that any scraper or bot in the system
 * can produce. The Outlets selector on the warfighter admin page should show
 * ALL of these (not just the ones with active stories in the last 48 hours),
 * so admins can pre-emptively hide an outlet before it ever publishes a story.
 *
 * When you add a new scraper or news bot, append its display name here so it
 * shows up in the Outlets selector immediately.
 */

const DEDICATED_BOT_OUTLETS = [
  'Fox News',
  'BBC News',
  'AP News',
  'Reuters',
  'ABC News',
  'CBS News',
  'NBC News',
  'Drudge Report',
];

const SCRAPER_PUBLISHER_OUTLETS = [
  'The Wall Street Journal',
  'The New York Times',
  'The Washington Post',
  'CNN',
  'Associated Press',
  'Politico',
  'The Hill',
  'Military.com',
  'Stars and Stripes',
  'Defense News',
  'Pentagon',
  'Al Jazeera',
  'Bloomberg',
  'The Guardian',
  'DataMinr',
];

const SOCIAL_AND_MISC_OUTLETS = [
  'POTUS (Truth Social)',
  'SecWar / Pete Hegseth (X)',
];

export interface KnownOutlet {
  key: string;
  name: string;
}

export function getKnownOutlets(mcopSlug?: string): KnownOutlet[] {
  const byKey = new Map<string, string>();
  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    const name = String(raw).trim();
    if (!name) return;
    const key = name.toLowerCase();
    // Outlets restricted to specific MCOPs are excluded from the global pool —
    // they're only added back below if the caller's slug is in the allowlist.
    if (MCOP_ONLY_OUTLET_KEYS.has(key)) return;
    if (!byKey.has(key)) byKey.set(key, name);
  };

  for (const feed of RSS_FEEDS) add(feed.sourceName);
  for (const name of DEDICATED_BOT_OUTLETS) add(name);
  for (const name of SCRAPER_PUBLISHER_OUTLETS) add(name);
  for (const name of SOCIAL_AND_MISC_OUTLETS) add(name);

  // Layer in this MCOP's restricted outlets (if any).
  if (mcopSlug && MCOP_ONLY_OUTLETS[mcopSlug]) {
    for (const name of MCOP_ONLY_OUTLETS[mcopSlug]) {
      const key = name.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, name);
    }
  }

  return Array.from(byKey.entries())
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}
