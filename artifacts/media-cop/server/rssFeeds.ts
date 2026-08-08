export interface RSSFeedConfig {
  url: string;
  sourceName: string;
  category: string;
  /**
   * When true, items from this outlet bypass the CJCS relevance gate and are
   * always posted to Team chat (a fallback summary is generated if the AI did
   * not provide one). Use ONLY for outlets whose entire editorial focus is
   * defense/IR/national-security — every piece they publish is CJCS-relevant
   * by definition (e.g. Foreign Policy, The Diplomat).
   */
  bypassCJCSGate?: boolean;
}

// RSS feed list verification (2026-07-18):
// All dead/blocked/stale feeds have been pruned with inline notes explaining
// why each was removed and what covers the gap:
//   - AP News, Reuters: DNS-dead public feeds retired upstream
//   - AFP: HTTP 200 but sparse corporate feed, 0 articles to main over 30 days
//   - Stars & Stripes: all known feed paths return 404 HTML stub
//   - MSNBC: no longer publishes RSS; NBC News carries this network
//   - USA Today: Gannett HTML site returned instead of RSS
//   - Washington Times: Cloudflare managed challenge (403) blocks this egress
//   - CNN world feed: HTTP 200 but recycled stale items, 0 passed relevance gate
//   - Times of Israel: Cloudflare managed challenge (403) blocks this egress
//   - Brookings: WordPress feed paths return HTML, not RSS
// Replacements for each dropped source are documented inline below.
// All remaining feeds verified live and returning same-day fresh items
// from this egress IP as of the above date.
export const RSS_FEEDS: RSSFeedConfig[] = [
  // Wire Services
  // NOTE (Task #426, 2026-06-24): AP News (feeds.apnews.com) and Reuters
  // (feeds.reuters.com) are intentionally omitted. AP and Reuters both retired
  // their public RSS feeds; the old hosts no longer resolve via DNS from this
  // infrastructure (curl: "Could not resolve host"), and Reuters' only remaining
  // Arc endpoint serves a URL sitemap, not an article feed. These were erroring
  // every cycle. Re-add only if a real, resolvable RSS/Atom feed reappears.
  { url: 'https://feeds.bloomberg.com/politics/news.rss', sourceName: 'Bloomberg', category: 'Wire Services' },
  // NOTE (2026-06-30): AFP (afp.com/en/rss.xml) is intentionally omitted. The
  // endpoint returns HTTP 200 valid RSS but it is AFP's sparse corporate/site
  // feed, not a wire article feed — it delivered 0 items to main over 30 days
  // (no AFP-published news ever reaches the RSS Monitor). Re-add only if AFP
  // exposes a real, resolvable article RSS/Atom feed.

  // US Defense & Military
  { url: 'https://breakingdefense.com/feed/', sourceName: 'Breaking Defense', category: 'US Defense' },
  { url: 'https://www.defenseone.com/rss/all/', sourceName: 'Defense One', category: 'US Defense' },
  { url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml', sourceName: 'Defense News', category: 'US Defense' },
  { url: 'https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml', sourceName: 'Military Times', category: 'US Defense' },
  // NOTE (Task #426, 2026-06-24): Stars & Stripes (stripes.com) is intentionally
  // omitted. Every known feed path (/rss, /rss/news.rss, /news.rss, the ArcXP
  // /arc/outboundfeeds/rss endpoint) now returns a 404 "Redirect" HTML stub from
  // this infrastructure — the outlet appears to have retired its RSS. It was
  // erroring every cycle. Re-add if a working feed URL is found.
  { url: 'https://www.thedrive.com/the-war-zone/feed', sourceName: 'The War Zone', category: 'US Defense' },
  { url: 'https://warontherocks.com/feed/', sourceName: 'War on the Rocks', category: 'US Defense' },
  // ADDED (2026-06-30): Military.com and Task & Purpose replace the lost
  // Stars & Stripes military-community coverage (its RSS retired upstream — all
  // paths 404). Both feeds verified live and same-day fresh from this egress.
  // Left ON the CJCS gate (not bypassed) because both publish a high volume of
  // benefits/lifestyle/human-interest items that the gate should filter out,
  // keeping only operational/strategic pieces.
  { url: 'https://www.military.com/feed', sourceName: 'Military.com', category: 'US Defense' },
  { url: 'https://taskandpurpose.com/feed/', sourceName: 'Task & Purpose', category: 'US Defense' },

  // Major US News
  { url: 'https://moxie.foxnews.com/google-publisher/world.xml', sourceName: 'Fox News', category: 'Major US News' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', sourceName: 'BBC', category: 'Major US News' },
  // NOTE (2026-06-30): CNN (rss.cnn.com/rss/edition_world.rss) is intentionally
  // omitted. CNN retired RSS; the legacy host still returns HTTP 200 but serves
  // only ~4 stale, recycled items per cycle that never pass the relevance gate
  // (logs: "[RSSBot][CNN] screened=4 passed=0" every cycle), so it delivered 0
  // items to main over 30 days. World coverage is carried by BBC/NBC/CBS/ABC/Al
  // Jazeera/France 24/DW. Re-add if CNN exposes a real, current RSS feed.
  // ADDED (2026-06-30): The Guardian (US edition) restores broad general-news
  // coverage lost when CNN's feed went stale. Verified live and same-day fresh.
  { url: 'https://www.theguardian.com/us-news/rss', sourceName: 'The Guardian', category: 'Major US News' },
  { url: 'https://feeds.nbcnews.com/nbcnews/public/world', sourceName: 'NBC News', category: 'Major US News' },
  { url: 'https://www.cbsnews.com/latest/rss/world', sourceName: 'CBS News', category: 'Major US News' },
  { url: 'https://feeds.abcnews.com/abcnews/internationalheadlines', sourceName: 'ABC News', category: 'Major US News' },
  { url: 'https://feeds.npr.org/1004/rss.xml', sourceName: 'NPR', category: 'Major US News' },
  { url: 'https://feeds.washingtonpost.com/rss/politics', sourceName: 'Washington Post', category: 'Major US News' },
  { url: 'https://feeds.washingtonpost.com/rss/world', sourceName: 'Washington Post', category: 'Major US News' },
  { url: 'https://feeds.washingtonpost.com/rss/national', sourceName: 'Washington Post', category: 'Major US News' },
  // NOTE (Task #426, 2026-06-24): MSNBC (msnbc.com/feeds/latest) is intentionally
  // omitted. The path now serves an HTML page (not RSS), so the parser failed with
  // "Attribute without value" every cycle; the NBC public feed alias 404s. MSNBC
  // appears to no longer publish RSS. NBC News (above) still carries this network.
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', sourceName: 'CNBC', category: 'Major US News' },
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000113', sourceName: 'CNBC', category: 'Major US News' },
  // NOTE (Task #426, 2026-06-24): USA Today (rssfeeds.usatoday.com) is
  // intentionally omitted. Its feed hosts now return the Gannett HTML site
  // (not RSS), so the parser failed with "Unquoted attribute value" /
  // "Feed not recognized as RSS" every cycle. Re-add if a working feed reappears.
  { url: 'https://www.newsnationnow.com/feed/', sourceName: 'NewsNation', category: 'Major US News' },

  // Beltway / Politics
  { url: 'https://thehill.com/feed/', sourceName: 'The Hill', category: 'Beltway' },
  { url: 'https://thehill.com/policy/defense/feed/', sourceName: 'The Hill', category: 'Beltway' },
  { url: 'https://rss.politico.com/politics-news.xml', sourceName: 'Politico', category: 'Beltway' },
  { url: 'https://rss.politico.com/defense.xml', sourceName: 'Politico', category: 'Beltway' },
  // NOTE (Task #426, 2026-06-24): Washington Times (washingtontimes.com) is
  // intentionally omitted. Its feeds serve a Cloudflare managed challenge
  // ("Just a moment..." HTTP 403) to this infrastructure even with a real browser
  // User-Agent — same class as Times of Israel — so it can't be ingested via RSS
  // and was erroring every cycle. Re-add if/when it stops challenging this egress.
  { url: 'https://www.washingtonexaminer.com/feed', sourceName: 'Washington Examiner', category: 'Beltway' },
  { url: 'https://www.washingtonexaminer.com/section/policy/defense/feed', sourceName: 'Washington Examiner', category: 'Beltway' },

  // Geopolitical & International
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', sourceName: 'Al Jazeera', category: 'Geopolitical' },
  { url: 'https://www.france24.com/en/rss', sourceName: 'France 24', category: 'Geopolitical' },
  { url: 'https://rss.dw.com/rdf/rss-en-all', sourceName: 'DW', category: 'Geopolitical' },
  // ADDED (2026-06-30): The Guardian (World) restores the international wire
  // coverage lost when AFP's feed (sparse/stale) and CNN's world feed were
  // dropped. Verified live and same-day fresh from this egress.
  { url: 'https://www.theguardian.com/world/rss', sourceName: 'The Guardian', category: 'Geopolitical' },
  // bypassCJCSGate: these two outlets publish exclusively defense/IR/foreign-policy
  // analysis. The CJCS relevance gate (gpt-4o-mini) consistently scores their
  // analytical/opinion-style headlines as not-relevant (screened=N passed=0 every
  // cycle) even though every piece they publish is definitionally CJCS-relevant.
  // Bypassing the gate means they always reach Team chat; the priority scorer still
  // assigns a score so low-consequence pieces land in the chat-only band as usual.
  { url: 'https://thediplomat.com/feed/', sourceName: 'The Diplomat', category: 'Geopolitical', bypassCJCSGate: true },
  { url: 'https://foreignpolicy.com/feed/', sourceName: 'Foreign Policy', category: 'Geopolitical', bypassCJCSGate: true },
  { url: 'https://www.foreignaffairs.com/rss.xml', sourceName: 'Foreign Affairs', category: 'Geopolitical' },

  // Regional Monitoring
  // NOTE (Task #426, 2026-06-24): Times of Israel
  // (https://www.timesofisrael.com/feed/) is intentionally omitted. Its feed
  // serves a Cloudflare managed challenge (HTTP 403) to this infrastructure even
  // with a real browser User-Agent, so it can't be ingested via the RSS Monitor
  // and was erroring every cycle. Israel coverage is still carried by Jerusalem
  // Post (below). Re-add if/when ToI stops challenging this egress.
  { url: 'https://www.jpost.com/rss/rssfeedsfrontpage.aspx', sourceName: 'Jerusalem Post', category: 'Regional' },
  { url: 'https://en.yna.co.kr/RSS/news.xml', sourceName: 'Yonhap', category: 'Regional' },

  // Think Tanks
  // bypassCJCSGate (2026-06-30): CSIS publishes exclusively defense / national-
  // security / IR analysis. The CJCS relevance gate (gpt-4o-mini) consistently
  // scored its analytical headlines as not-relevant, so it delivered 0 items to
  // main over 30 days despite the feed fetching fine (HTTP 200). Same treatment
  // as Foreign Policy / The Diplomat: bypass the gate so its analysis reaches
  // Team chat; the priority scorer still ranks low-consequence pieces down.
  { url: 'https://www.csis.org/rss.xml', sourceName: 'CSIS', category: 'Think Tanks', bypassCJCSGate: true },
  { url: 'https://www.rand.org/blog.xml', sourceName: 'RAND', category: 'Think Tanks' },
  // ADDED (2026-06-30): Atlantic Council replaces the lost Brookings think-tank
  // coverage (Brookings' WordPress feed now serves HTML, not RSS). Verified live
  // and same-day fresh. bypassCJCSGate for the same reason as CSIS / Foreign
  // Policy / The Diplomat — it publishes exclusively defense/IR/security analysis
  // that the relevance gate otherwise scores to zero.
  { url: 'https://www.atlanticcouncil.org/feed/', sourceName: 'Atlantic Council', category: 'Think Tanks', bypassCJCSGate: true },
  // NOTE (Task #426, 2026-06-24): Brookings (brookings.edu/feed) is intentionally
  // omitted. Every WordPress feed path (/feed/, /feed, /articles/feed/) now serves
  // the HTML site (not RSS) from this infrastructure, so the parser failed with
  // "Feed not recognized as RSS 1 or 2" every cycle. Re-add if a feed reappears.
];

export function getRSSBotUserId(sourceName: string): string {
  return `rss-${sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-bot`;
}

export function getRSSBotUserName(sourceName: string): string {
  return `RSS(${sourceName}) Bot`;
}
