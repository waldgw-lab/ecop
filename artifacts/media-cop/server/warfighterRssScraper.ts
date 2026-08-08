import Parser from 'rss-parser';
import { openai } from './aiClient';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { storage } from './storage';
import { normalizeTitle } from './titleNormalizer';
import { isRecentArticle } from './articleDateFilter';
import { analyzeBatchHeadlines } from './aiAnalyzer';
import { extractArticlePreview } from './streamPrefetch';
import { recordFeedOutcome } from './feedHealthTracker';
import { BOT_CJCS_SYSTEM_PROMPT } from './relevanceDefinition';

// Strict deterministic fallback gate for AI-outage mode ONLY.
// Unlike the shared `hasSecurityContext` rescue list (intentionally inclusive,
// substring-matched, and designed to lean on the downstream AI as a backstop),
// this fallback has NO AI backstop, so it must be conservative. It matches only
// unambiguous defense/national-security terms on WORD BOUNDARIES (never raw
// substrings), and deliberately omits over-broad tokens like bare "war"
// (matches "warning"/"software"/"aware"), "allies", or "defense" (matches
// "self-defense"/consumer contexts). Precision over recall: a clearly-defense
// headline is admitted; anything ambiguous is left for the AI once it recovers.
const STRICT_FALLBACK_TERMS: readonly string[] = [
  // Conflict & force (unambiguous, multi-word or specific)
  'warfare', 'invasion', 'airstrike', 'air strike', 'missile', 'missiles',
  'drone strike', 'warship', 'warships', 'fighter jet', 'ceasefire',
  'armed forces', 'troops', 'military', 'pentagon', 'nato',
  // Named adversaries & actors
  'china', 'chinese', 'russia', 'russian', 'kremlin', 'iran', 'iranian',
  'north korea', 'pyongyang', 'hezbollah', 'hamas', 'houthi', 'wagner',
  // Flashpoints & geography (specific)
  'taiwan', 'strait of hormuz', 'ukraine', 'gaza', 'south china sea',
  'red sea', 'korean peninsula', 'black sea', 'west bank',
  // Security & statecraft (specific)
  'sanctions', 'embargo', 'blockade', 'national security', 'homeland security',
  'deterrence', 'cyberattack', 'espionage', 'nuclear weapon', 'nuclear weapons',
  // Installations
  'naval base', 'air base', 'military base', 'naval station',
];

const STRICT_FALLBACK_REGEXES = STRICT_FALLBACK_TERMS.map(
  (term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
);

// Strict, word-boundary defense check used ONLY by the outage fallback.
function isStrictlyDefenseRelevant(title: string): boolean {
  const t = title || '';
  return STRICT_FALLBACK_REGEXES.some((re) => re.test(t));
}


interface WarfighterRSSFeed {
  url: string;
  sourceName: string;
  category: string;
}

export const WARFIGHTER_ONLY_RSS_FEEDS: WarfighterRSSFeed[] = [
  { url: 'https://www.theblaze.com/feeds/feed.rss', sourceName: 'The Blaze', category: 'Major US News' },
  // NOTE: The Epoch Times (theepochtimes.com) RSS feeds are intentionally omitted.
  // The site migrated to Next.js and retired its RSS endpoints — every candidate
  // (/c-us/feed, /c-china/feed, /feed, /rss, /feed.xml) now redirects to HTML or
  // 404s. They were erroring every cycle with zero headlines. Re-add only if a
  // real, resolvable RSS/Atom feed reappears. Outlet identity stays restricted
  // below so already-stored headlines remain valid.
  { url: 'https://www.dailywire.com/feeds/rss.xml', sourceName: 'The Daily Wire', category: 'Major US News' },
];

// Outlets whose live RSS feeds have been retired but whose identity must remain
// warfighter-restricted: already-stored headlines stay scoped to the warfighter
// MCOP and out of the global outlet pool / public API.
const WARFIGHTER_RETIRED_OUTLET_NAMES = ['The Epoch Times'];

export const WARFIGHTER_ONLY_OUTLET_NAMES = Array.from(
  new Set([
    ...WARFIGHTER_ONLY_RSS_FEEDS.map(f => f.sourceName),
    ...WARFIGHTER_RETIRED_OUTLET_NAMES,
  ])
);

const RESTRICTED_TO: string[] = ['warfighter'];

let isRunning = false;

async function generateBulletsFromText(title: string, fullText: string): Promise<string[]> {
  if (!fullText || fullText.length < 100) return [];
  try {
    const completion = await withAiTimeout(openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a military intelligence analyst. Produce 3 ultra-concise bullet points (max 15 words each) summarizing the key facts of the article for a senior military leader.',
        },
        {
          role: 'user',
          content: `Headline: ${title}\n\nArticle text:\n${fullText.substring(0, 4000)}`,
        },
      ],
      max_tokens: 200,
      temperature: 0.3,
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'warfighterRssScraper');
    const text = completion.choices[0]?.message?.content || '';
    return text
      .split('\n')
      .map(line => line.replace(/^[-•*\d.)\s]+/, '').trim())
      .filter(line => line.length > 0)
      .slice(0, 3)
      .map(line => line.split(/\s+/).slice(0, 18).join(' '));
  } catch (err) {
    console.error('[WarfighterRSS] Bullet generation failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

// Defense-relevance gate. WarfighterRSS is the only ingestion path that writes
// to the `headlines` table without a CJCS relevance check, so consumer/lifestyle
// articles (e.g. Daily Wire family/reading pieces) were leaking onto the main
// feed. Screen a batch of titles with the shared BOT_CJCS_SYSTEM_PROMPT and
// return a Set of the titles judged defense-relevant. On a normal verdict this
// is authoritative. On AI UNAVAILABILITY (error / missing verdict) it flags
// `degraded: true` so the caller can apply a bounded, conservative deterministic
// keyword fallback instead of silently dropping all defense coverage.
async function screenTitlesForRelevance(
  titles: string[],
): Promise<{ relevant: Set<string>; degraded: boolean }> {
  const relevant = new Set<string>();
  if (titles.length === 0) return { relevant, degraded: false };
  try {
    const list = titles.map((t, i) => `${i + 1}. "${t}"`).join('\n');
    const completion = await withAiTimeout(openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: BOT_CJCS_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Analyze these ${titles.length} headlines and identify which ones are relevant for the Chairman of the Joint Chiefs of Staff. Return a JSON object with an "articles" array where each item has: "index" (1-based) and "isRelevant" (boolean).

Headlines:
${list}`,
        },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'warfighterRssScraper');

    const content = completion.choices[0]?.message?.content;
    if (!content) return { relevant, degraded: true };
    const parsed = JSON.parse(content);
    // A parseable-but-malformed response (no `articles` array) is a silent
    // model-format failure, not a real "nothing is relevant" verdict — treat it
    // as degraded so the bounded fallback activates instead of dropping the batch.
    if (!Array.isArray(parsed.articles)) return { relevant, degraded: true };
    for (const item of parsed.articles) {
      const index = (item.index ?? 0) - 1;
      if (index >= 0 && index < titles.length && item.isRelevant === true) {
        relevant.add(titles[index]);
      }
    }
    return { relevant, degraded: false };
  } catch (err) {
    console.error('[WarfighterRSS] Relevance screen failed (AI unavailable, will apply bounded keyword fallback):', err instanceof Error ? err.message : err);
    return { relevant, degraded: true };
  }
}

export async function runWarfighterRssScraper(): Promise<{ added: number; skipped: number; errors: number }> {
  if (isRunning) {
    console.log('[WarfighterRSS] Skipping — previous run still in progress');
    return { added: 0, skipped: 0, errors: 0 };
  }
  isRunning = true;
  const startedAt = Date.now();
  const parser = new Parser({ timeout: 15000 });
  let added = 0;
  let skipped = 0;
  let errors = 0;

  try {
    for (const feed of WARFIGHTER_ONLY_RSS_FEEDS) {
      let parsed;
      try {
        parsed = await parser.parseURL(feed.url);
      } catch (err) {
        errors++;
        recordFeedOutcome({
          url: feed.url,
          sourceName: feed.sourceName,
          scope: 'warfighter',
          outcome: 'error',
          detail: err instanceof Error ? err.message : String(err),
        });
        console.error(`[WarfighterRSS] Failed to parse ${feed.sourceName} (${feed.url}):`, err instanceof Error ? err.message : err);
        continue;
      }

      const rawItemCount = (parsed.items || []).length;
      recordFeedOutcome({
        url: feed.url,
        sourceName: feed.sourceName,
        scope: 'warfighter',
        outcome: rawItemCount === 0 ? 'empty' : 'healthy',
        detail: `${rawItemCount} item${rawItemCount === 1 ? '' : 's'} returned`,
      });

      const items = (parsed.items || []).slice(0, 25);

      // Defense-relevance gate: screen recent, storable titles up front so
      // non-defense lifestyle/consumer content never reaches the headlines table.
      const candidateTitles = Array.from(new Set(
        items
          .filter(it => it.title && it.link && isRecentArticle(it.pubDate, 'WarfighterRSS'))
          .map(it => it.title!.trim())
      ));
      const { relevant: relevantTitles, degraded } = await screenTitlesForRelevance(candidateTitles);

      // Bounded, conservative deterministic fallback for when the AI relevance
      // screen is unavailable. Rather than dropping ALL defense coverage for the
      // cycle (fail-closed), rescue only titles that strictly match unambiguous
      // defense vocabulary on WORD BOUNDARIES (isStrictlyDefenseRelevant) — strict
      // enough that lifestyle / consumer articles cannot leak through with no AI
      // backstop — and cap how many can be admitted per feed per cycle so a
      // degraded run can never flood the main feed.
      const FALLBACK_MAX_PER_FEED = 5;
      if (degraded) {
        let rescued = 0;
        for (const t of candidateTitles) {
          if (rescued >= FALLBACK_MAX_PER_FEED) break;
          if (isStrictlyDefenseRelevant(t)) {
            relevantTitles.add(t);
            rescued++;
          }
        }
        console.warn(`[WarfighterRSS] Relevance AI degraded — bounded strict keyword fallback admitted ${rescued}/${candidateTitles.length} title(s) for ${feed.sourceName} (cap ${FALLBACK_MAX_PER_FEED})`);
      }

      for (const item of items) {
        if (!item.title || !item.link) continue;
        const title = item.title.trim();
        if (!isRecentArticle(item.pubDate, 'WarfighterRSS')) continue;

        if (!relevantTitles.has(title)) {
          skipped++;
          console.log(`[WarfighterRSS] ✗ not defense-relevant, skipped: ${title.substring(0, 70)}`);
          continue;
        }

        const normalized = normalizeTitle(title);

        try {
          const isBlocked = await storage.isHeadlineBlocked(normalized);
          if (isBlocked) { skipped++; continue; }

          const similar = await storage.getSimilarHeadlines(normalized, 48);
          if (similar.length > 0) { skipped++; continue; }

          let priorityScore = 50;
          try {
            const analyzed = await analyzeBatchHeadlines([title]);
            if (analyzed.length > 0 && analyzed[0].priority_score) {
              priorityScore = analyzed[0].priority_score;
            }
          } catch (err) {
            console.error('[WarfighterRSS] Priority analysis failed, defaulting to 50:', err instanceof Error ? err.message : err);
          }

          let ogImageUrl: string | null = null;
          let summaryBullets: string[] = [];
          let summary = title;
          try {
            const preview = await extractArticlePreview(item.link);
            if (preview.ogImageUrl) ogImageUrl = preview.ogImageUrl;
            if (preview.summaryBullets && preview.summaryBullets.length > 0) {
              summaryBullets = preview.summaryBullets;
              summary = preview.summaryBullets[0] || summary;
            }
          } catch (err) {
            // Image/bullet enrichment failed — still store the headline so it shows up
          }

          // Best-effort bullets via paywall fallback path if preview produced none
          if (summaryBullets.length === 0) {
            try {
              const { fetchViaPaywallBypass } = await import('./paywallBypass');
              const paywall = await fetchViaPaywallBypass(item.link);
              if (paywall?.story && paywall.story.length > 100) {
                summaryBullets = await generateBulletsFromText(title, paywall.story);
                if (summaryBullets.length > 0) summary = summaryBullets[0];
                if (!ogImageUrl && (paywall as any).imageUrl) ogImageUrl = (paywall as any).imageUrl;
              }
            } catch {}
          }

          let publishedAt: Date | null = null;
          if (item.pubDate) {
            const d = new Date(item.pubDate);
            if (!isNaN(d.getTime())) publishedAt = d;
          }

          await storage.addHeadline({
            title,
            url: item.link,
            category: feed.category,
            source: feed.sourceName,
            summary,
            articlePublishedAt: publishedAt,
            priorityScore,
            tags: [],
            ogImageUrl,
            summaryBullets: summaryBullets.length > 0 ? summaryBullets : undefined,
            mediaScrapedAt: new Date(),
            restrictedToMcops: RESTRICTED_TO,
          } as any, normalized);

          added++;
          console.log(`[WarfighterRSS] +${feed.sourceName} (${priorityScore}): ${title.substring(0, 70)}...`);
        } catch (err: any) {
          if (err?.code === '23505') { skipped++; continue; }
          errors++;
          console.error(`[WarfighterRSS] Insert failed for "${title.substring(0, 60)}":`, err instanceof Error ? err.message : err);
        }
      }
    }

    const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[WarfighterRSS] Done in ${dur}s — added: ${added}, skipped: ${skipped}, errors: ${errors}`);
    return { added, skipped, errors };
  } finally {
    isRunning = false;
  }
}
