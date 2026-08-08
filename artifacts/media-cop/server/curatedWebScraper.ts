// =============================================================================
// Curated-only website scraper (Task #321).
//
// AP/Reuters/NPR/CNN are authoritative US/Western wires that had NO working
// recurring DIRECT pipe into the isolated Curated lane: their public RSS is
// dead/blocked from this infra (feeds.apnews.com/feeds.reuters.com don't
// resolve, feeds.npr.org returns 403, rss.cnn.com is frozen), so curated only
// ever saw them trickle in via the capped Drudge website-reject path.
//
// AP and Reuters already have dedicated main-feed website scrapers, so they get
// a curated reject hook bolted onto those bots (server/apNewsBot.ts /
// server/reutersBot.ts). CNN and NPR have NO dedicated bot at all, so this
// module gives them a small, CURATED-ONLY website scraper: it screens nothing
// itself and posts to NO shared feed — every headline it finds is funneled
// straight into the shared isolated admission path (admitCuratedCandidates,
// 'gate' mode), which runs the generous curated relevance gate and writes ONLY
// to curated_items / curated_classifications. It can never reach the main feed /
// Classic / Visual / custom-MCOP / public API.
//
// The lane TIER (contributing vs attach-only) is resolved downstream from the
// Outlet Registry by `sourceName`, so that string MUST match a registry
// canonical name / alias / domain (CNN, NPR both seed role: contributing).
// =============================================================================
import * as cheerio from 'cheerio';
import { isRecentUrl } from './articleDateFilter';
import { fetchWithResilience } from './resilientFetch';
import { storage } from './storage';

export interface CuratedWebSource {
  // Scheduler/admin toggle id + curated admission label.
  id: string;
  label: string;
  // Registry-resolvable outlet name (canonical / alias / domain).
  sourceName: string;
  logTag: string;
  // Section/index pages to scrape for article links.
  sections: string[];
  // Base origin used to absolutize relative hrefs.
  origin: string;
  // Anchor selector; only hrefs matching `hrefPattern` are kept.
  linkSelector: string;
  hrefPattern: RegExp;
  // Optional child selector to read the headline text from (falls back to the
  // anchor's own text when absent / empty).
  titleSelector?: string;
}

interface WebArticle {
  title: string;
  url: string;
}

// Bound how many candidates a single run hands to the curated store so a noisy
// section page can't flood the curated clustering payload. Mirrors the cap used
// by the RSS-bot reject capture.
const MAX_CURATED_CANDIDATES = 60;

// Per-source in-flight guard so a slow run can't stack with the next hourly cron
// or the startup kick. Keyed by src.id and shared by every caller (cron +
// startup), so even with fetch timeouts a degraded run never runs twice at once.
const inFlightSources = new Set<string>();

// Pure parser: turn one section page's HTML into {title, url} articles by
// applying the source's linkSelector / hrefPattern / titleSelector. This holds
// ALL of the structural extraction logic so it can be exercised by saved HTML
// fixtures (scripts/curated-web-scraper.test.ts) without any network — if CNN
// or NPR redesign their markup and a selector/pattern stops matching, that test
// (and any caller) gets an empty result loudly instead of a silent trickle.
//
// `seenUrls` is shared across a multi-section live run for cross-section dedup.
// `applyDateFilter` gates the recency check (a separate concern from structure):
// live runs keep only recent articles; the structural fixture test leaves it off
// so saved fixtures stay stable regardless of when the test is run.
export function parseSectionHtml(
  src: CuratedWebSource,
  html: string,
  opts: { seenUrls?: Set<string>; applyDateFilter?: boolean } = {},
): WebArticle[] {
  const seenUrls = opts.seenUrls ?? new Set<string>();
  const applyDateFilter = opts.applyDateFilter ?? false;
  const articles: WebArticle[] = [];
  const $ = cheerio.load(html);

  $(src.linkSelector).each((_, elem) => {
    const $elem = $(elem);
    let href = $elem.attr('href');
    if (!href) return;

    // Protocol-relative hrefs (//host/path — used by e.g. China Daily) need a
    // scheme, NOT origin-prefixing: `origin + "//host/path"` double-prefixes the
    // host into a malformed URL. Handle them before the origin-relative branch.
    if (href.startsWith('//')) {
      href = 'https:' + href;
    } else if (!href.startsWith('http')) {
      href = src.origin + (href.startsWith('/') ? href : `/${href}`);
    }

    // Keep only real dated article URLs, then strip query/hash for a stable
    // dedup + storage key.
    if (!src.hrefPattern.test(href)) return;
    const cleanUrl = href.split('?')[0].split('#')[0];
    // Skip URLs already ACCEPTED (cross-element/section dedup). We only add to
    // seenUrls AFTER a candidate fully passes title + recency below — so an
    // empty/image wrapper <a> pointing at the same URL (common CNN/NPR card
    // markup) can't poison the dedup set and drop the later real headline link.
    if (seenUrls.has(cleanUrl)) return;

    let title = (src.titleSelector ? $elem.find(src.titleSelector).first().text() : $elem.text())
      .replace(/\s+/g, ' ')
      .trim();
    if (!title || title.length < 10) return;
    if (title.length > 200) title = title.substring(0, 200) + '...';

    if (applyDateFilter && !isRecentUrl(cleanUrl, src.logTag)) return;

    seenUrls.add(cleanUrl);
    articles.push({ title, url: cleanUrl });
  });

  return articles;
}

interface WebFetchResult {
  articles: WebArticle[];
  fetchFailures: number;
  lastFetchError: string | null;
}

function shortFetchError(message: string): string {
  const clean = (message || 'fetch failed').trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
}

async function fetchHeadlines(src: CuratedWebSource): Promise<WebFetchResult> {
  const articles: WebArticle[] = [];
  const seenUrls = new Set<string>();
  let fetchFailures = 0;
  let lastFetchError: string | null = null;

  for (const sectionUrl of src.sections) {
    try {
      console.log(`[${src.logTag}] Fetching section: ${sectionUrl}`);
      // Rotating browser UA + bounded transient/UA-block retry (Task #383): a
      // UA-specific 403 or an intermittent blip on one section no longer drops
      // it silently for the whole pass. Each attempt is still bounded by the
      // 15s timeout, and the retry budget keeps a run well under the hourly cron.
      const response = await fetchWithResilience(sectionUrl, {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        timeoutMs: 15000,
        retries: 2,
        label: src.logTag,
      });

      if (!response.ok) {
        console.error(`[${src.logTag}] Failed to fetch ${sectionUrl}: ${response.status}`);
        fetchFailures++;
        lastFetchError = shortFetchError(`HTTP ${response.status} fetching ${sectionUrl}`);
        continue;
      }

      const html = await response.text();
      articles.push(...parseSectionHtml(src, html, { seenUrls, applyDateFilter: true }));
    } catch (error) {
      console.error(`[${src.logTag}] Error fetching section ${sectionUrl}:`, error);
      fetchFailures++;
      lastFetchError = shortFetchError((error as Error).message);
    }
  }

  console.log(`[${src.logTag}] Found ${articles.length} recent articles`);
  return { articles, fetchFailures, lastFetchError };
}

export async function runCuratedWebScraper(
  src: CuratedWebSource,
): Promise<{ ingested: number; skipped: number; errors: number }> {
  if (inFlightSources.has(src.id)) {
    console.log(`[${src.logTag}] Previous run still in flight, skipping this cycle`);
    return { ingested: 0, skipped: 0, errors: 0 };
  }
  inFlightSources.add(src.id);
  console.log(`[${src.logTag}] Starting curated-only scan...`);
  const startTime = Date.now();

  try {
    const { articles, fetchFailures, lastFetchError } = await fetchHeadlines(src);
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
      console.warn(`[${src.logTag}] Failed to persist website fetch stats (non-fatal):`, (err as Error).message);
    });
    if (articles.length === 0) {
      console.log(`[${src.logTag}] No articles found, skipping this cycle`);
      return { ingested: 0, skipped: 0, errors: 0 };
    }

    const candidates = articles.slice(0, MAX_CURATED_CANDIDATES).map(a => ({
      title: a.title,
      url: a.url,
      source: src.sourceName,
    }));

    // Curated-only: admitCuratedCandidates writes solely to curated_items /
    // curated_classifications. 'gate' mode runs the generous curated relevance
    // analyzer over the batch and dedups by URL against the curated store, so
    // re-seen headlines are skipped. Defensive: a curated-lane failure must
    // never crash the scheduler.
    let ingested = 0;
    let skipped = 0;
    try {
      const { admitCuratedCandidates } = await import('./curatedIngest');
      const r = await admitCuratedCandidates(candidates, { mode: 'gate', label: src.label });
      ingested = r.ingested;
      skipped = r.skipped;
      console.log(
        `[${src.logTag}] Curated intake: ${r.ingested} admitted, ${r.skipped} skipped (of ${candidates.length})`,
      );
    } catch (err) {
      console.error(`[${src.logTag}] Curated intake failed (non-fatal):`, err);
      return { ingested: 0, skipped: 0, errors: 1 };
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${src.logTag}] Completed in ${duration}s - Admitted: ${ingested}, Skipped: ${skipped}`);
    return { ingested, skipped, errors: 0 };
  } catch (error) {
    console.error(`[${src.logTag}] Fatal error:`, error);
    return { ingested: 0, skipped: 0, errors: 1 };
  } finally {
    inFlightSources.delete(src.id);
  }
}

// ---------------------------------------------------------------------------
// Source definitions. `sourceName` MUST resolve in the Outlet Registry (both
// CNN and NPR seed role: contributing, news-us-domestic).
// ---------------------------------------------------------------------------
export const CNN_CURATED_SOURCE: CuratedWebSource = {
  id: 'cnnCuratedBot',
  label: 'cnn-curated',
  sourceName: 'CNN',
  logTag: 'CnnCuratedBot',
  sections: ['https://www.cnn.com/world', 'https://www.cnn.com/politics', 'https://www.cnn.com/us'],
  origin: 'https://www.cnn.com',
  linkSelector: 'a[href*="/20"]',
  // /YYYY/MM/DD/section/slug
  hrefPattern: /cnn\.com\/\d{4}\/\d{2}\/\d{2}\/[a-z-]+\//i,
  titleSelector: '.container__headline-text',
};

export const NPR_CURATED_SOURCE: CuratedWebSource = {
  id: 'nprCuratedBot',
  label: 'npr-curated',
  sourceName: 'NPR',
  logTag: 'NprCuratedBot',
  sections: [
    'https://www.npr.org/sections/world/',
    'https://www.npr.org/sections/politics/',
    'https://www.npr.org/sections/national-security/',
  ],
  origin: 'https://www.npr.org',
  // NPR lists each story as <h2 class="title"><a href=...>Title</a></h2>.
  linkSelector: 'h2.title a[href*="/20"]',
  // /YYYY/MM/DD/<id>/slug
  hrefPattern: /npr\.org\/\d{4}\/\d{2}\/\d{2}\//i,
};

// NOTE — Stars and Stripes curated WEBSITE scraper TRIALED then REMOVED 2026-06-24
// (reward-per-cost review). Stars and Stripes publishes no working RSS, and the
// bespoke homepage scraper that briefly backed it carries materially higher
// maintenance/fragility cost than an RSS feed (it can silently break on a site
// redesign) for only medium incremental coverage. The outlet stays registered but
// intentionally silent in curated. Do not re-add without accepting that upkeep.

export async function runCnnCuratedBot() {
  return runCuratedWebScraper(CNN_CURATED_SOURCE);
}

export async function runNprCuratedBot() {
  return runCuratedWebScraper(NPR_CURATED_SOURCE);
}

// ---------------------------------------------------------------------------
// Adversary / state-controlled outlets (Task #386) — Chinese state media + one
// Latin-American state outlet. Their public RSS is dead or stale from this infra
// (Global Times / China Daily / People's Daily / CGTN RSS return only weeks-old
// items). NOTE: Prensa Latina (Cuba) runs through the RSS path in
// curatedFeeds.ts ADVERSARY_FEEDS, not this website-scraper list. Its English
// desk (plenglish.com/feed/) went slow + stale, so as of 2026-07-05 it uses the
// Spanish .cu RSS feed (www.prensa-latina.cu/feed/, fast + fresh) — see that
// file for the live re-probe details. The outlets below get the same
// CURATED-ONLY website-scraper treatment
// as CNN/NPR above: every headline is
// funneled through admitCuratedCandidates ('gate' mode) into the isolated curated
// store ONLY — never the main / Classic / Visual / custom-MCOP feeds or public
// API. All resolve to news-cpc in the registry (role attach-only → contrast), so
// they can only ATTACH to a trusted story, never seed one. titleSelector is
// omitted because each outlet's article headline IS the anchor text.
// ---------------------------------------------------------------------------
export const GLOBAL_TIMES_CURATED_SOURCE: CuratedWebSource = {
  id: 'globalTimesCuratedBot',
  label: 'global-times-curated',
  sourceName: 'Global Times',
  logTag: 'GlobalTimesCuratedBot',
  sections: ['https://www.globaltimes.cn/china/', 'https://www.globaltimes.cn/world/'],
  origin: 'https://www.globaltimes.cn',
  linkSelector: 'a[href*="/page/"]',
  // /page/YYYYMM/NNNNNNN.shtml — no day in the path, so there is no URL date to
  // recency-filter on; the section pages list current items and the curated store
  // ages out old rows.
  hrefPattern: /globaltimes\.cn\/page\/\d{6}\/\d+\.shtml/i,
};

export const CHINA_DAILY_CURATED_SOURCE: CuratedWebSource = {
  id: 'chinaDailyCuratedBot',
  label: 'china-daily-curated',
  sourceName: 'China Daily',
  logTag: 'ChinaDailyCuratedBot',
  sections: ['https://www.chinadaily.com.cn/world', 'https://www.chinadaily.com.cn/china'],
  origin: 'https://www.chinadaily.com.cn',
  // hrefs are protocol-relative (//www.chinadaily.com.cn/a/...) — schemed in
  // parseSectionHtml.
  linkSelector: 'a[href*="/a/20"]',
  // /a/YYYYMM/DD/WS<hex>.html
  hrefPattern: /chinadaily\.com\.cn\/a\/\d{6}\/\d{2}\/WS[0-9a-z]+\.html/i,
};

export const PEOPLES_DAILY_CURATED_SOURCE: CuratedWebSource = {
  id: 'peoplesDailyCuratedBot',
  label: 'peoples-daily-curated',
  sourceName: "People's Daily",
  logTag: 'PeoplesDailyCuratedBot',
  sections: ['http://en.people.cn/90777/index.html', 'http://en.people.cn/90883/index.html'],
  origin: 'http://en.people.cn',
  linkSelector: 'a[href*="/20"]',
  // /nN/YYYY/MMDD/c<digits>-<digits>.html
  hrefPattern: /people\.(?:cn|com\.cn)\/n\d?\/\d{4}\/\d{4}\/c\d+-\d+\.html/i,
};

export const CGTN_CURATED_SOURCE: CuratedWebSource = {
  id: 'cgtnCuratedBot',
  label: 'cgtn-curated',
  sourceName: 'CGTN',
  logTag: 'CgtnCuratedBot',
  sections: ['https://www.cgtn.com/world', 'https://www.cgtn.com/china'],
  origin: 'https://www.cgtn.com',
  // Article links are absolute to the news.cgtn.com / newseu.cgtn.com hosts.
  linkSelector: 'a[href*="cgtn.com/news/"]',
  // news.cgtn.com/news/YYYY-MM-DD/slug-XXXX/p.html — dated, so old items are
  // recency-filtered out at the URL level.
  hrefPattern: /cgtn\.com\/news\/\d{4}-\d{2}-\d{2}\/[^/]+\/p\.html/i,
};

export const TELESUR_CURATED_SOURCE: CuratedWebSource = {
  id: 'telesurCuratedBot',
  label: 'telesur-curated',
  sourceName: 'teleSUR',
  logTag: 'TelesurCuratedBot',
  sections: ['https://www.telesurenglish.net/'],
  origin: 'https://www.telesurenglish.net',
  // teleSUR article URLs are slug-only (no date): /multi-word-slug/. Match a 4+
  // word hyphenated slug to separate real articles from short nav/section links;
  // the homepage lists current stories and the curated store ages out old rows.
  // linkSelector stays broad (a[href]) because the slugs share no stable
  // substring — hrefPattern does the real filtering after absolutization.
  linkSelector: 'a[href]',
  hrefPattern: /telesurenglish\.net\/[a-z0-9]+(?:-[a-z0-9]+){3,}\/$/i,
};

// KCNA (North Korea) — Task #634. The kcnawatch.org RSS feed (/feed/)
// 302-redirects into an HTML member-signup popup so the parser gets HTML and
// throws (documented dead in curatedFeeds.ts), and there is no other public
// KCNA RSS. The kcnawatch.org HOMEPAGE, however, is reachable (HTTP 200) and
// carries same-day articles at /newstream/<id>/<slug> with the headline as the
// anchor's own text (no titleSelector needed) — the same "RSS dead, website
// works" situation already handled for CGTN/teleSUR above, so it gets the same
// generic website-scraper treatment. Before this, KCNA had a Source Oversight
// row (originCountry: North Korea) but NO intake path at all, so the
// North Korea lens was permanently silent even though the outlet was "wired".
export const KCNA_CURATED_SOURCE: CuratedWebSource = {
  id: 'kcnaCuratedBot',
  label: 'kcna-curated',
  sourceName: 'KCNA',
  logTag: 'KcnaCuratedBot',
  sections: ['https://kcnawatch.org/'],
  origin: 'https://kcnawatch.org',
  // /newstream/<numeric-id>-<numeric-id>/<slug> — no date in the path, so there
  // is no URL date to recency-filter on; the homepage lists current items and
  // the curated store ages out old rows (same approach as Global Times above).
  linkSelector: 'a[href*="/newstream/"]',
  hrefPattern: /kcnawatch\.org\/newstream\/\d+-\d+\/[a-z0-9-]+/i,
};

// The adversary/state-media web scrapers, scheduled as a group (CNN/NPR are
// scheduled individually). Also feeds the Source Oversight coverage inventory.
export const STATE_MEDIA_CURATED_SOURCES: CuratedWebSource[] = [
  GLOBAL_TIMES_CURATED_SOURCE,
  CHINA_DAILY_CURATED_SOURCE,
  PEOPLES_DAILY_CURATED_SOURCE,
  CGTN_CURATED_SOURCE,
  TELESUR_CURATED_SOURCE,
  KCNA_CURATED_SOURCE,
];

// Every curated-only website scraper, for the Source Oversight coverage
// inventory (silent-source detection) and any other caller that needs the full
// list of scraper-backed curated sources.
export const CURATED_WEB_SOURCES: CuratedWebSource[] = [
  CNN_CURATED_SOURCE,
  NPR_CURATED_SOURCE,
  ...STATE_MEDIA_CURATED_SOURCES,
];
