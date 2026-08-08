import Parser from "rss-parser";
import { storage } from "./storage";
import type { CompetingCoverageItem } from "@shared/schema";
import {
  significantTitleTokens,
  looksSameEvent,
  looksRelatedToStory,
} from "./curatedCluster";

// =============================================================================
// Competing Coverage (Task #203) — a topic-agnostic "blind-spot radar" of what
// the U.S./World is actually paying attention to RIGHT NOW, independent of MCOP's
// defense lens. Backbone = Google News RSS topic feeds (the "Most Covered" mix),
// ranked by coverage VOLUME — never by MCOP's own scoring.
//
// Two coverage scopes plus one best-effort buzz item:
//   - 'domestic'      → top U.S. stories across NATION + off-topic categories
//   - 'international' → top global stories (WORLD)
//   - 'buzz'          → a single best-effort trending item (added separately)
//
// TAG, DON'T FILTER: we always show the top-covered stories and FLAG the ones
// absent from MCOP's own feed as "blind spots" (off leadership's radar). The
// off-topic categories (Entertainment/Sports/Health/…) are intentionally the
// richest blind-spot source — they surface exactly what MCOP would never show.
//
// CURATED-LANE ONLY. The refresh writes to the dedicated competing_coverage_cache
// table; the curated-gated read endpoint serves from there. Nothing here touches
// headlines / manual_submissions / custom MCOPs / the public REST API / Classic /
// Visual (fail-closed isolation).
//
// Google News RSS notes:
//   - Item links are news.google.com/rss/articles/CBMi... encoded redirects. As
//     of mid-2024 these are NOT decodable to the publisher URL client-side, so we
//     keep the Google redirect URL verbatim — it 302s correctly in a browser.
//   - The outlet name comes from the RSS <source> element (falling back to the
//     "Headline - Source" title suffix), and we STRIP that suffix before display
//     AND before token matching so outlet-name tokens don't pollute the matcher.
//   - Each fetch is soft-fail: on any error we keep the last-good cached row so
//     the panel never blanks (same resilience the old GDELT job relied on).
// =============================================================================

const parser = new Parser({
  timeout: 12000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
  customFields: {
    // Google News emits <source url="...">Outlet Name</source> per item.
    item: ["source"],
  },
});

// Google Trends "Trending Now" RSS (the old daily/rss endpoint 404s as of 2025).
// Best-effort, fail-silent: a single trending item is a nice-to-have, never load-
// bearing. Each <item> is a search term with one or more nested <ht:news_item>
// children carrying a representative headline/url/source.
const TRENDS_URL = "https://trends.google.com/trending/rss?geo=US";
const trendsParser = new Parser({
  timeout: 12000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
  customFields: {
    item: [
      ["ht:approx_traffic", "approxTraffic"],
      ["ht:news_item", "newsItems", { keepArray: true }],
    ],
  },
});

// rss-parser surfaces each nested <ht:news_item_*> child as a one-element string
// array; pull the first string out defensively.
function pickNewsField(node: any, key: string): string | undefined {
  const v = node?.[key];
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0].trim() || undefined : undefined;
  if (typeof v === "string") return v.trim() || undefined;
  return undefined;
}

type Scope = "domestic" | "international";
type Topic = { topic: string; label: string };

// Domestic = the lead national hard-news feed (NATION) PLUS the off-topic
// categories that are the most valuable blind-spot source. Round-robin selection
// (below) guarantees the panel isn't dominated by one category.
const DOMESTIC_TOPICS: Topic[] = [
  { topic: "NATION", label: "U.S." },
  { topic: "BUSINESS", label: "Business" },
  { topic: "TECHNOLOGY", label: "Tech" },
  { topic: "HEALTH", label: "Health" },
  { topic: "SCIENCE", label: "Science" },
  { topic: "ENTERTAINMENT", label: "Entertainment" },
  { topic: "SPORTS", label: "Sports" },
];

// International = the cross-topic global top-stories feed.
const INTL_TOPICS: Topic[] = [{ topic: "WORLD", label: "World" }];

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const STARTUP_DELAY_MS = 20 * 1000;
const FETCH_SPACING_MS = 400; // be polite between category fetches
const MAX_PER_FEED = 25; // how many items to read from each category feed
// Per-scope display caps. Domestic is one row PER DOMAIN so every blind-spot
// source — including Entertainment and Sports — is guaranteed a slot (a fixed
// 5-of-7 round-robin would structurally exclude the last two topics, defeating
// the point of a blind-spot radar). International is a single ranked WORLD feed,
// so we keep its top 5.
const DOMESTIC_MAX_ITEMS = DOMESTIC_TOPICS.length;
const INTL_MAX_ITEMS = 5;

let isRefreshing = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RawItem = {
  headline: string;
  source?: string;
  url?: string;
  outletCount: number;
  category: string;
  publishedAt?: number;
  feedPosition: number;
  mergeCount: number;
};

// Pull the outlet name out of rss-parser's <source> value, which may be a plain
// string or an object ({ _: "Name", $: { url } }) depending on attributes.
function extractSource(item: any): string | undefined {
  const s = item?.source;
  if (!s) return undefined;
  if (typeof s === "string") return s.trim() || undefined;
  if (typeof s === "object") {
    const v = s._ ?? s["#"] ?? s.name ?? s.title;
    if (typeof v === "string") return v.trim() || undefined;
  }
  return undefined;
}

// Google News titles are "Headline - Source". Strip that suffix so the headline
// reads cleanly AND so the trailing outlet name doesn't leak into token matching.
function splitTitleAndSource(
  rawTitle: string,
  knownSource?: string,
): { headline: string; source?: string } {
  let headline = rawTitle.trim();
  let source = knownSource?.trim() || undefined;

  if (source && headline.endsWith(` - ${source}`)) {
    headline = headline.slice(0, headline.length - source.length - 3).trim();
    return { headline, source };
  }

  // Fallback: strip a trailing " - Outlet" only when it looks like a short outlet
  // name (no sentence punctuation, reasonably short) so real hyphenated headlines
  // ("Trump-Xi call - what we know") aren't mangled.
  const idx = headline.lastIndexOf(" - ");
  if (idx > 0) {
    const tail = headline.slice(idx + 3).trim();
    if (tail.length >= 2 && tail.length <= 40 && !/[.?!:;]$/.test(tail)) {
      if (!source) source = tail;
      headline = headline.slice(0, idx).trim();
    }
  }
  return { headline, source };
}

// Google News item descriptions embed an <ol> of related articles for "Full
// Coverage" clusters; the <li> count is a best-effort "how many outlets" signal.
// Most topic-feed items carry a single link → default to 1.
function parseOutletCount(html: string | undefined): number {
  if (!html) return 1;
  const li = html.match(/<li\b/gi);
  if (li && li.length >= 1) return li.length;
  return 1;
}

async function fetchTopic(t: Topic): Promise<RawItem[]> {
  const url = `https://news.google.com/rss/headlines/section/topic/${t.topic}?hl=en-US&gl=US&ceid=US:en`;
  try {
    const feed = await parser.parseURL(url);
    const items = (feed.items || []) as any[];
    const out: RawItem[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const rawTitle = (it?.title || "").trim();
      if (!rawTitle) continue;
      const { headline, source } = splitTitleAndSource(rawTitle, extractSource(it));
      if (!headline) continue;
      const key = headline.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const when = it?.isoDate || it?.pubDate;
      out.push({
        headline,
        source,
        url: it?.link || undefined,
        outletCount: parseOutletCount(it?.content || it?.["content:encoded"] || it?.summary),
        category: t.label,
        publishedAt: when ? new Date(when).getTime() : undefined,
        feedPosition: i,
        mergeCount: 1,
      });
      if (out.length >= MAX_PER_FEED) break;
    }
    return out;
  } catch (err: any) {
    console.warn(
      `[CompetingCoverage] topic ${t.topic} fetch failed:`,
      err?.message || err,
    );
    return [];
  }
}

// A story's "most-covered" score: outlet consensus from the related-article list,
// boosted when the same event surfaced in more than one category feed.
function scoreOf(item: RawItem): number {
  return (item.outletCount || 1) + (item.mergeCount - 1) * 2;
}

// Round-robin across categories (in priority order) so the panel always carries a
// SPREAD of what the public is reading — not five variations of one hard-news
// story. Near-duplicate events (looksSameEvent) collapse into one row, bumping its
// consensus signal instead of taking a second slot.
function selectDiverse(
  perCategory: Map<string, RawItem[]>,
  order: string[],
  limit: number,
): RawItem[] {
  const picked: RawItem[] = [];
  const pickedTokens: Set<string>[] = [];
  const cursors = new Map<string, number>();
  let progressed = true;

  while (picked.length < limit && progressed) {
    progressed = false;
    for (const cat of order) {
      if (picked.length >= limit) break;
      const list = perCategory.get(cat) || [];
      let idx = cursors.get(cat) ?? 0;
      while (idx < list.length) {
        const cand = list[idx];
        idx++;
        const toks = significantTitleTokens(cand.headline);
        let dupAt = -1;
        for (let i = 0; i < pickedTokens.length; i++) {
          if (looksSameEvent(toks, pickedTokens[i])) {
            dupAt = i;
            break;
          }
        }
        if (dupAt >= 0) {
          // Same event already shown — fold this appearance into its consensus.
          picked[dupAt].outletCount = Math.max(
            picked[dupAt].outletCount,
            cand.outletCount,
          );
          picked[dupAt].mergeCount += 1;
          continue; // keep scanning this category for a fresh story
        }
        picked.push(cand);
        pickedTokens.push(toks);
        progressed = true;
        break; // move to the next category (round-robin)
      }
      cursors.set(cat, idx);
    }
  }
  return picked;
}

async function buildScope(topics: Topic[], limit: number): Promise<RawItem[]> {
  const perCategory = new Map<string, RawItem[]>();
  let total = 0;
  for (const t of topics) {
    const raws = await fetchTopic(t);
    perCategory.set(t.label, raws);
    total += raws.length;
    await sleep(FETCH_SPACING_MS);
  }
  if (total === 0) return []; // soft fail — caller keeps last-good cache

  const order = topics.map((t) => t.label);
  const selected = selectDiverse(perCategory, order, limit);
  // Stable sort by coverage score: high-consensus stories float up, otherwise the
  // diverse round-robin order is preserved (Array.sort is stable).
  selected.sort((a, b) => scoreOf(b) - scoreOf(a));
  return selected;
}

// --- Blind-spot tagging -----------------------------------------------------
// A story is a blind spot ONLY when it matches NOTHING in MCOP's own feed even
// under the LOOSER looksRelatedToStory heuristic. The permissiveness is the point:
// any plausible match SUPPRESSES the flag, because a false "you're missing this"
// in front of leadership is the worse error than an unflagged near-match.

async function loadMcopFeedTokenSets(): Promise<Set<string>[] | null> {
  try {
    const [primary, curated] = await Promise.all([
      storage.getPrimaryFeed(24, 500),
      storage.getCuratedStoreItems(24),
    ]);
    const titles: string[] = [
      ...primary.map((p) => p.title),
      ...curated.map((c) => c.title),
    ].filter((t): t is string => !!t);
    return titles.map((t) => significantTitleTokens(t)).filter((s) => s.size >= 2);
  } catch (err: any) {
    console.warn(
      "[CompetingCoverage] blind-spot feed read failed; leaving flags unset:",
      err?.message || err,
    );
    return null;
  }
}

function tagBlindSpots(
  items: RawItem[],
  feedTokenSets: Set<string>[] | null,
): CompetingCoverageItem[] {
  return items.map((item, i) => {
    const base: CompetingCoverageItem = {
      rank: i + 1,
      headline: item.headline,
      url: item.url,
      source: item.source,
      outletCount: item.outletCount,
      category: item.category,
      publishedAt: item.publishedAt,
      kind: "coverage",
    };
    if (!feedTokenSets) return base; // couldn't read feed → don't guess
    const toks = significantTitleTokens(item.headline);
    if (toks.size < 2) return { ...base, blindSpot: false };
    const matched = feedTokenSets.some((fs) => looksRelatedToStory(toks, fs));
    return { ...base, blindSpot: !matched };
  });
}

async function refreshScope(
  scope: Scope,
  topics: Topic[],
  limit: number,
  feedTokenSets: Set<string>[] | null,
): Promise<CompetingCoverageItem[]> {
  const raw = await buildScope(topics, limit);
  if (raw.length === 0) return []; // soft fail — keep last-good cache
  const items = tagBlindSpots(raw, feedTokenSets);
  await storage.upsertCompetingCoverage(scope, items);
  const blind = items.filter((i) => i.blindSpot).length;
  console.log(
    `[CompetingCoverage] ${scope}: cached ${items.length} stories (${blind} blind spots)`,
  );
  return items;
}

async function refreshCompetingCoverage(): Promise<void> {
  if (isRefreshing) {
    console.log("[CompetingCoverage] refresh already running, skipping");
    return;
  }
  isRefreshing = true;
  try {
    const feedTokenSets = await loadMcopFeedTokenSets();
    const domestic = await refreshScope(
      "domestic",
      DOMESTIC_TOPICS,
      DOMESTIC_MAX_ITEMS,
      feedTokenSets,
    );
    const international = await refreshScope(
      "international",
      INTL_TOPICS,
      INTL_MAX_ITEMS,
      feedTokenSets,
    );
    // Buzz item is best-effort + fail-silent, de-duped against everything we just
    // showed (coverage backbone) and MCOP's own feed.
    await refreshBuzz([...domestic, ...international], feedTokenSets);
  } catch (err: any) {
    console.error("[CompetingCoverage] refresh error:", err?.message || err);
  } finally {
    isRefreshing = false;
  }
}

// --- Buzz item (best-effort) ------------------------------------------------
// One trending item from Google Trends "Trending Now" RSS. Fail-silent: any error,
// empty feed, or all-redundant result leaves the last-good buzz row untouched (the
// panel simply shows the previous buzz, or none). De-duped against the coverage
// backbone we just stored AND MCOP's own feed so it never echoes a story already on
// screen. We pick the highest trend whose news headline (or, lacking one, the
// search term) is genuinely NEW to the picture.
//
// selectBuzz is the pure half (no storage writes); refreshBuzz stores the result.
async function selectBuzz(
  coverageItems: CompetingCoverageItem[],
  feedTokenSets: Set<string>[] | null,
): Promise<CompetingCoverageItem | null> {
  try {
    const feed = await trendsParser.parseURL(TRENDS_URL);
    const items = (feed.items || []) as any[];
    if (items.length === 0) return null;

    const dedupSets: Set<string>[] = [];
    if (feedTokenSets) dedupSets.push(...feedTokenSets);
    for (const c of coverageItems) {
      const s = significantTitleTokens(c.headline);
      if (s.size >= 2) dedupSets.push(s);
    }

    for (const it of items) {
      const term = (it?.title || "").trim();
      if (!term) continue;
      const news = Array.isArray(it?.newsItems) ? it.newsItems : [];
      const first = news[0];
      const newsTitle = pickNewsField(first, "ht:news_item_title");
      const newsUrl = pickNewsField(first, "ht:news_item_url");
      const newsSource = pickNewsField(first, "ht:news_item_source");
      const headline = newsTitle || term;

      // Redundant if EITHER the news headline or the trend term plausibly matches
      // something already shown (coverage) or already tracked (MCOP feed).
      const headlineToks = significantTitleTokens(headline);
      const termToks = significantTitleTokens(term);
      const redundant = dedupSets.some(
        (s) =>
          (headlineToks.size >= 2 && looksRelatedToStory(headlineToks, s)) ||
          (termToks.size >= 2 && looksRelatedToStory(termToks, s)),
      );
      if (redundant) continue;

      const when = it?.isoDate || it?.pubDate;
      return {
        rank: 1,
        headline,
        url: newsUrl,
        source: newsSource,
        // `category` carries the trending search term so the UI can show what
        // people are actually searching for (e.g. "TRENDING: koe wetzel").
        category: term,
        publishedAt: when ? new Date(when).getTime() : undefined,
        kind: "buzz",
      };
    }
    return null; // every trend was redundant
  } catch (err: any) {
    console.warn(
      "[CompetingCoverage] buzz fetch failed (non-fatal):",
      err?.message || err,
    );
    return null;
  }
}

async function refreshBuzz(
  coverageItems: CompetingCoverageItem[],
  feedTokenSets: Set<string>[] | null,
): Promise<void> {
  const buzz = await selectBuzz(coverageItems, feedTokenSets);
  if (!buzz) return; // fail-silent — keep last-good buzz row
  await storage.upsertCompetingCoverage("buzz", [buzz]);
  console.log(`[CompetingCoverage] buzz: "${buzz.category}" -> ${buzz.headline}`);
}

export function startCompetingCoverageJob(): void {
  setTimeout(refreshCompetingCoverage, STARTUP_DELAY_MS);
  setInterval(refreshCompetingCoverage, REFRESH_INTERVAL_MS);
  console.log("[CompetingCoverage] job started (refreshes every 15 minutes)");
}

// Exposed for the one-off verification script (scripts/) — not used at runtime.
export const __testables = {
  buildScope,
  fetchTopic,
  selectDiverse,
  tagBlindSpots,
  loadMcopFeedTokenSets,
  selectBuzz,
  splitTitleAndSource,
  parseOutletCount,
  DOMESTIC_TOPICS,
  INTL_TOPICS,
  DOMESTIC_MAX_ITEMS,
  INTL_MAX_ITEMS,
};
