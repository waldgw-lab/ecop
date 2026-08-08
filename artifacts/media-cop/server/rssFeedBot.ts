import Parser from 'rss-parser';
import { openai, parseAiJson, salvageJsonObjectArray } from './aiClient';
import { storage } from './storage';
import { scrapeContent } from './textScraper';
import { matchOrCreateSubject, FLASH_TOPIC_NAME, qualifiesForFlashTopStories, CJCS_TOPIC_NAME, detectCJCSMention } from './subjectMatcher';
import { scoreHeadlinePrioritiesBatch } from './aiAnalyzer';
import { adaptiveBatches } from './adaptiveBatch';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { BOT_CJCS_SYSTEM_PROMPT, UNSCORED_BOT_PRIORITY } from './relevanceDefinition';
import { isRecentArticle } from './articleDateFilter';
import { RSS_FEEDS, getRSSBotUserId, getRSSBotUserName, type RSSFeedConfig } from './rssFeeds';
import { fetchWithResilience } from './resilientFetch';
import { ENGLISH_TITLE_FIELD_SPEC, extractEnglishTitle } from './titleTranslator';
import { recordFeedOutcome } from './feedHealthTracker';
import {
  isMainFeedWatchSteeringEnabled,
  loadActiveWatchTopics,
  matchWatchTopics,
  createRescueBudget,
  type CompiledWatchTopic,
} from './watchTopicMatcher';


// Circuit breaker: pause feeds that keep failing so they stop firing every cycle.
// After FEED_FAILURE_THRESHOLD consecutive failures a feed is skipped for
// FEED_COOLDOWN_MS, then retried once. A single success resets it immediately.
const FEED_FAILURE_THRESHOLD = 3;
const FEED_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
const feedFailureState = new Map<string, { failures: number; skipUntil: number }>();

function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    let normalized = 'https://' + urlObj.host + urlObj.pathname;
    normalized = normalized.replace(/\/+$/, '');
    return normalized;
  } catch {
    let normalized = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
    normalized = normalized.replace(/^http:/, 'https:');
    return normalized;
  }
}

interface RSSArticle {
  title: string;
  url: string;
  normalizedUrl: string;
  pubDate?: string;
  sourceName: string;
  feedConfig: RSSFeedConfig;
}

interface AnalyzedRSSArticle extends RSSArticle {
  isRelevant: boolean;
  summary: string;
  relevanceReason: string;
  englishTitle: string;
}

async function fetchAllRSSFeeds(): Promise<RSSArticle[]> {
  const parser = new Parser({ timeout: 15000 });
  const articles: RSSArticle[] = [];
  const seenUrls = new Set<string>();
  let skippedInCooldown = 0;

  for (const feed of RSS_FEEDS) {
    const state = feedFailureState.get(feed.url);
    if (state && state.skipUntil > Date.now()) {
      skippedInCooldown++;
      continue; // still in cooldown after repeated failures — skip quietly
    }

    try {
      console.log(`[RSSBot] Fetching: ${feed.sourceName} (${feed.url})`);
      // Fetch with a rotating browser User-Agent + bounded transient/UA-block
      // retry, then parse from the returned text — instead of parser.parseURL,
      // whose default `User-Agent: rss-parser` is 403-blocked by Cloudflare/WAF
      // for several outlets (The War Zone, Washington Examiner, DW, ...). Mirrors
      // the curated-lane fetch path (server/curatedIngest.ts).
      const resp = await fetchWithResilience(feed.url, {
        accept: 'application/rss+xml, application/xml, text/xml, */*',
        timeoutMs: 15000,
        retries: 2,
        label: `RSSBot:${feed.sourceName}`,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const parsed = await parser.parseString(await resp.text());

      feedFailureState.delete(feed.url); // success — clear any failure streak

      const rawItemCount = (parsed.items || []).length;
      recordFeedOutcome({
        url: feed.url,
        sourceName: feed.sourceName,
        scope: 'rss-monitor',
        outcome: rawItemCount === 0 ? 'empty' : 'healthy',
        detail: `${rawItemCount} item${rawItemCount === 1 ? '' : 's'} returned`,
      });

      for (const item of parsed.items || []) {
        if (!item.title || !item.link) continue;

        const normalized = normalizeUrl(item.link);
        if (seenUrls.has(normalized)) continue;
        seenUrls.add(normalized);

        if (!isRecentArticle(item.pubDate, 'RSSBot')) continue;

        articles.push({
          title: item.title.trim(),
          url: item.link,
          normalizedUrl: normalized,
          pubDate: item.pubDate || item.isoDate,
          sourceName: feed.sourceName,
          feedConfig: feed,
        });
      }
    } catch (error) {
      console.error(`[RSSBot] Error fetching ${feed.sourceName}:`, error instanceof Error ? error.message : error);

      recordFeedOutcome({
        url: feed.url,
        sourceName: feed.sourceName,
        scope: 'rss-monitor',
        outcome: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });

      const prev = feedFailureState.get(feed.url) ?? { failures: 0, skipUntil: 0 };
      const failures = prev.failures + 1;
      if (failures >= FEED_FAILURE_THRESHOLD) {
        feedFailureState.set(feed.url, { failures, skipUntil: Date.now() + FEED_COOLDOWN_MS });
        console.warn(`[RSSBot] Pausing ${feed.sourceName} (${feed.url}) for 6h after ${failures} consecutive failures`);
      } else {
        feedFailureState.set(feed.url, { failures, skipUntil: 0 });
      }
    }
  }

  const cooldownNote = skippedInCooldown > 0 ? ` (${skippedInCooldown} paused after repeated failures)` : '';
  console.log(`[RSSBot] Fetched ${articles.length} recent articles from ${RSS_FEEDS.length} feeds${cooldownNote}`);
  return articles;
}

async function analyzeArticlesForCJCS(articles: RSSArticle[]): Promise<AnalyzedRSSArticle[]> {
  if (articles.length === 0) return [];

  console.log(`[RSSBot] Analyzing ${articles.length} articles for CJCS relevance...`);

  const systemPrompt = BOT_CJCS_SYSTEM_PROMPT;

  try {
    const articlesList = articles.map((a, i) => `${i + 1}. [${a.sourceName}] "${a.title}"`).join('\n');

    const response = await withAiTimeout(openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Analyze these ${articles.length} headlines and identify which ones are relevant for the Chairman of the Joint Chiefs of Staff. Return a JSON object with an "articles" array where each item has: "index" (1-based), "isRelevant" (boolean), "summary" (1-2 sentence plain-prose news summary if relevant — no heading, no title, no preamble, and do not state who it is for; empty string if not), "reason" (brief reason for relevance/irrelevance), ${ENGLISH_TITLE_FIELD_SPEC}.

Headlines:
${articlesList}`
        }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'rssFeedBot');

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error('[RSSBot] No response from AI');
      return [];
    }

    // Tolerant parse + salvage: gpt-4o-mini intermittently truncates the reply
    // mid-JSON at the token cap ("Unterminated string in JSON" / "Unexpected end
    // of JSON input"), and a bare JSON.parse would drop the WHOLE batch. Prefer a
    // clean parse of the {articles:[...]} object; otherwise recover every COMPLETE
    // {...} element that fully came back — the truncated tail is retried next pass.
    let articleItems: any[] = [];
    const parsed = parseAiJson<any>(content);
    if (parsed && Array.isArray(parsed.articles)) {
      articleItems = parsed.articles;
    } else {
      articleItems = salvageJsonObjectArray(content);
      if (articleItems.length > 0) {
        console.log(`[RSSBot] SALVAGED ${articleItems.length}/${articles.length} result(s) from a truncated/malformed reply (would previously have dropped the whole batch)`);
      } else {
        console.error('[RSSBot] MALFORMED AI response (nothing salvageable), dropping batch');
      }
    }

    const results: AnalyzedRSSArticle[] = [];

    for (const item of articleItems) {
      const index = item.index - 1;
      if (index >= 0 && index < articles.length) {
        results.push({
          ...articles[index],
          isRelevant: item.isRelevant,
          summary: item.summary || '',
          relevanceReason: item.reason || '',
          englishTitle: extractEnglishTitle(item, articles[index].title, articles[index].sourceName),
        });
      }
    }

    const relevantCount = results.filter(r => r.isRelevant).length;
    console.log(`[RSSBot] Found ${relevantCount} relevant articles out of ${results.length} analyzed`);

    return results;
  } catch (error) {
    console.error('[RSSBot] Error analyzing articles:', error);
    return [];
  }
}

async function postToTeamChat(article: AnalyzedRSSArticle, precomputedPriority?: number): Promise<boolean> {
  try {
    const normalizedArticleUrl = article.normalizedUrl || normalizeUrl(article.url);
    const botUserId = getRSSBotUserId(article.sourceName);
    const botUserName = getRSSBotUserName(article.sourceName);

    const isBlocked = await storage.isBotContentBlocked(normalizedArticleUrl);
    if (isBlocked) {
      console.log(`[RSSBot] Skipping blocked content: ${article.title.substring(0, 50)}...`);
      return false;
    }

    const alreadyPostedByAnyBot = await storage.isArticlePostedByAnyBot(normalizedArticleUrl);
    if (alreadyPostedByAnyBot) {
      console.log(`[RSSBot] Skipping duplicate (already posted by a bot): ${article.title.substring(0, 50)}...`);
      return false;
    }

    const existingSubmission = await storage.getSubmissionByUrl(normalizedArticleUrl);
    if (existingSubmission) {
      console.log(`[RSSBot] Skipping duplicate (already in submissions): ${article.title.substring(0, 50)}...`);
      try {
        await storage.addRSSBotPost({
          articleUrl: normalizedArticleUrl,
          articleTitle: article.title,
          summary: article.summary,
          sourceName: article.sourceName,
          chatMessageId: null,
        });
      } catch {}
      return false;
    }

    const displayTitle = article.englishTitle || article.title;
    const message = `**${displayTitle}**\n\n${article.summary}\n\n${article.url}`;

    const chatMessage = await storage.addChatMessage({
      userId: botUserId,
      userName: botUserName,
      userProfileImage: null,
      message,
    });

    try {
      await storage.addRSSBotPost({
        articleUrl: normalizedArticleUrl,
        articleTitle: article.title,
        summary: article.summary,
        sourceName: article.sourceName,
        chatMessageId: chatMessage.id,
      });
    } catch (dbError: any) {
      if (dbError?.code === '23505') {
        console.log(`[RSSBot] Skipping duplicate (constraint): ${article.title.substring(0, 50)}...`);
        return false;
      }
      throw dbError;
    }

    try {
      const { subjectName } = await matchOrCreateSubject(displayTitle, article.summary, 'RSSBot');
      const subject = await storage.findOrCreateSubject(subjectName, botUserId);

      // Reuse the summary + priority already produced ONCE per batch in
      // runRSSFeedBot (analyzeArticlesForCJCS supplies article.summary;
      // scoreHeadlinePrioritiesBatch supplies precomputedPriority). We still
      // scrape the page for full text + OG image (no AI calls), but we no longer
      // make a second per-article AI summary or per-article AI priority call —
      // the article is analyzed once, not three times.
      let fullText: string | undefined;
      let ogImageUrl: string | null = null;
      try {
        const scrapedContent = await scrapeContent(article.url, 'news');
        if (scrapedContent.imageUrl) {
          ogImageUrl = scrapedContent.imageUrl;
        }
        if (scrapedContent.success && scrapedContent.fullText) {
          fullText = scrapedContent.fullText;
        }
      } catch (scrapeError) {
        console.warn(`[RSSBot] Failed to scrape full text/OG image for ${article.url}: ${scrapeError instanceof Error ? scrapeError.message : String(scrapeError)}`);
      }

      const priorityScore = typeof precomputedPriority === "number" ? precomputedPriority : UNSCORED_BOT_PRIORITY;
      // Task #811: flag the AI-scorer-failed fallback so the retry job can find
      // and re-score it instead of leaving it buried at 30 forever.
      const scoreSource = typeof precomputedPriority === "number" ? 'ai' : 'unscored_fallback';

      let flashSubjectId: string | null = null;
      if (qualifiesForFlashTopStories(priorityScore)) {
        console.log(`[RSSBot] HIGH PRIORITY (${priorityScore}) - Adding to FLASH: TOP STORIES`);
        const flashSubject = await storage.getSubjectByName(FLASH_TOPIC_NAME);
        if (flashSubject) {
          flashSubjectId = flashSubject.id;
        }
      }

      let cjcsSubjectId: string | null = null;
      const mentionsCJCS = await detectCJCSMention(displayTitle, article.summary);
      if (mentionsCJCS) {
        console.log(`[RSSBot] CJCS MENTION DETECTED - Adding to CJCS MENTIONS`);
        const cjcsSubject = await storage.getSubjectByName(CJCS_TOPIC_NAME);
        if (cjcsSubject) {
          cjcsSubjectId = cjcsSubject.id;
        }
      }

      const submission = await storage.addSubmission({
        chatMessageId: chatMessage.id,
        submittedBy: botUserId,
        submittedByName: botUserName,
        sourceType: 'news',
        sourceUrl: normalizedArticleUrl,
        headline: displayTitle,
        summary: article.summary,
        status: 'processed',
        priorityScore,
        scoreSource,
      });

      await storage.finalizeSubmissionAnalysis(submission.id, {
        headline: displayTitle,
        summary: article.summary,
        sourceType: 'news',
        subjectId: subject.id,
        sourceName: article.sourceName,
        publishedAt: article.pubDate ? new Date(article.pubDate) : null,
        fullText,
        priorityScore,
        scoreSource,
        flashSubjectId,
        cjcsSubjectId,
        ogImageUrl,
      });
    } catch (submissionError) {
      console.error(`[RSSBot] Error creating submission:`, submissionError);
    }

    console.log(`[RSSBot] Posted [${article.sourceName}]: ${article.title.substring(0, 60)}...`);
    return true;
  } catch (error) {
    console.error(`[RSSBot] Error posting article:`, error);
    return false;
  }
}

export async function runRSSFeedBot(): Promise<{ posted: number; skipped: number; errors: number }> {
  console.log('[RSSBot] Starting RSS Feed scan...');
  const startTime = Date.now();

  let posted = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const articles = await fetchAllRSSFeeds();

    if (articles.length === 0) {
      console.log('[RSSBot] No articles found, skipping this cycle');
      return { posted, skipped, errors };
    }

    const newArticles: RSSArticle[] = [];
    for (const article of articles) {
      const alreadyPostedByAnyBot = await storage.isArticlePostedByAnyBot(article.normalizedUrl);
      if (alreadyPostedByAnyBot) {
        skipped++;
      } else {
        const existingSubmission = await storage.getSubmissionByUrl(article.normalizedUrl);
        if (existingSubmission) {
          skipped++;
        } else {
          newArticles.push(article);
        }
      }
    }

    console.log(`[RSSBot] ${newArticles.length} new articles to analyze (${skipped} already posted/submitted)`);

    if (newArticles.length === 0) {
      console.log('[RSSBot] No new articles to process');
      return { posted, skipped, errors };
    }


    // Strict-CJCS-gate rejects collected across batches, routed into the WIDER
    // isolated curated aperture at the end (Task #137). Bounded so a noisy poll
    // can't flood the curated store / clustering payload. Curated-only — never
    // re-enters headlines / Team chat / Classic / Visual.
    const MAX_CURATED_REJECTS = 60;
    const curatedRejects: { title: string; url: string; source: string; pubDate?: string }[] = [];

    // Watch-topic steering (deterministic, default-OFF). Load active Priority/
    // BOLO topics ONCE per poll; the BOLO rescue below keeps would-be-filtered
    // RSS items. Fail-closed: disabled or load failure => no steering this poll.
    // CURATED-ONLY for now: isMainFeedWatchSteeringEnabled() is hard-false, so
    // this main-feed steering block stays dormant even when the admin flag is on.
    let watchTopics: CompiledWatchTopic[] = [];
    const watchRescueBudget = createRescueBudget();
    if (isMainFeedWatchSteeringEnabled()) {
      try {
        watchTopics = await loadActiveWatchTopics();
      } catch (err) {
        console.error('[WatchTopicMatcher] RSS load failed (steering skipped this poll):', err);
        watchTopics = [];
      }
    }
    const watchSteeringActive = watchTopics.length > 0;

    for await (const batch of adaptiveBatches(newArticles)) {
      const analyzed = await analyzeArticlesForCJCS(batch);

      // When the relevance AI is unavailable (timeout / cooldown during an AI
      // rate-limit storm) analyzeArticlesForCJCS returns nothing, which
      // previously dropped the whole batch and starved the Curated lane of fresh
      // RSS coverage. Fall back to offering the fetched, recency-filtered
      // headlines to the isolated curated aperture (which applies its own
      // admission gate) so curated stays fed even when Team-chat scoring can't run.
      if (analyzed.length === 0) {
        console.log(`[RSSBot] AI unavailable for batch of ${batch.length} — fail-routing all to curated lane (deferred=${batch.length})`);
        for (const a of batch) {
          if (curatedRejects.length >= MAX_CURATED_REJECTS) break;
          curatedRejects.push({ title: a.title, url: a.url, source: a.sourceName, pubDate: a.pubDate });
        }
        continue;
      }

      // Bypass-gate override: outlets whose entire editorial scope is
      // defense/IR/national-security (e.g. Foreign Policy, The Diplomat) are
      // marked bypassCJCSGate=true in rssFeeds.ts. The CJCS gate (gpt-4o-mini)
      // consistently marks their analytical/opinion-style headlines as
      // not-relevant even though every piece is definitionally CJCS-relevant.
      // We force isRelevant=true for these outlets and generate a minimal
      // fallback summary if the AI didn't produce one. The priority scorer still
      // runs normally, so low-consequence pieces stay chat-only as intended.
      // Note: this is intentionally an allow-all for bypass-gated outlets.
      // Only outlets whose ENTIRE editorial scope is defense/IR should be flagged
      // (see rssFeeds.ts comment) — the flag is a last resort after confirming
      // a persistent zero-pass pattern in production logs.
      // Track per-source bypass stats while applying overrides in a single pass.
      const bypassStats = new Map<string, { configured: number; overridden: number }>();
      for (const a of analyzed) {
        if (!a.feedConfig.bypassCJCSGate) continue;
        const bs = bypassStats.get(a.sourceName) ?? { configured: 0, overridden: 0 };
        bs.configured++;
        // Force relevant regardless of AI verdict.
        if (!a.isRelevant) {
          a.isRelevant = true;
          bs.overridden++;
        }
        // Ensure a non-empty summary so the item clears the downstream filter.
        // Covers the !isRelevant case (AI produced no summary) AND the edge case
        // where AI returned isRelevant=true but an empty summary string.
        if (!a.summary) {
          a.summary = `Defense and foreign-policy analysis from ${a.sourceName}.`;
        }
        bypassStats.set(a.sourceName, bs);
      }
      const totalOverridden = [...bypassStats.values()].reduce((n, bs) => n + bs.overridden, 0);
      if (totalOverridden > 0) {
        console.log(`[RSSBot] Gate-bypass: overrode not-relevant for ${totalOverridden} item(s) from bypass-gated outlets`);
      }

      const relevant = analyzed.filter(a => a.isRelevant && a.summary);
      const priorityMap = await scoreHeadlinePrioritiesBatch(relevant.map(a => a.title));

      for (const a of analyzed) {
        if (a.isRelevant && a.summary) continue;
        if (curatedRejects.length >= MAX_CURATED_REJECTS) break;
        curatedRejects.push({ title: a.title, url: a.url, source: a.sourceName, pubDate: a.pubDate });
      }

      console.log(`[RSSBot] Batch: ${relevant.length} relevant out of ${batch.length}`);
      const bySource = new Map<string, { screened: number; passed: number }>();
      for (const a of analyzed) {
        const s = bySource.get(a.sourceName) ?? { screened: 0, passed: 0 };
        s.screened++;
        if (a.isRelevant && a.summary) s.passed++;
        bySource.set(a.sourceName, s);
      }
      bySource.forEach((t, src) => {
        const bs = bypassStats.get(src);
        const bypassNote = bs
          ? ` bypass_configured=${bs.configured} bypass_overridden=${bs.overridden}`
          : '';
        console.log(`[RSSBot][${src}] screened=${t.screened} passed=${t.passed}${bypassNote}`);
      });

      for (const article of relevant) {
        try {
          const success = await postToTeamChat(article, priorityMap.get(article.title));
          if (success) {
            posted++;
          } else {
            skipped++;
          }
        } catch (err) {
          console.error(`[RSSBot] Error posting article: ${article.title.substring(0, 50)}`, err);
          errors++;
        }
      }

      // BOLO watch rescue (deterministic, default-OFF): keep CJCS-irrelevant RSS
      // items in Team chat if they match an active BOLO topic, bounded by the
      // shared per-poll budget. These are ALSO routed to the curated lane above
      // (isolated, deduped there) — that double-handling is harmless.
      if (watchSteeringActive) {
        const rescued = analyzed
          .filter(a => !(a.isRelevant && a.summary))
          .filter(a => {
            const wm = matchWatchTopics(watchTopics, a.title, a.summary);
            return wm.boloTopicIds.length > 0 && watchRescueBudget.consume(wm.boloTopicIds);
          })
          .map(a => ({ ...a, summary: a.summary || a.relevanceReason || a.title }));

        if (rescued.length > 0) {
          const rescuedPriority = await scoreHeadlinePrioritiesBatch(rescued.map(a => a.title));
          for (const article of rescued) {
            try {
              const success = await postToTeamChat(article, rescuedPriority.get(article.title));
              if (success) {
                posted++;
              } else {
                skipped++;
              }
            } catch (err) {
              console.error(`[RSSBot] Error posting BOLO-rescued article: ${article.title.substring(0, 50)}`, err);
              errors++;
            }
          }
          console.log(`[WatchTopicMatcher] RSS BOLO rescue: posted ${rescued.length} otherwise-filtered item(s)`);
        }
      }
    }

    // Route strict-gate rejects into the WIDER, isolated curated aperture
    // (Task #137). Defensive: a curated-lane failure must never break the RSS
    // bot. Curated-only — admitCuratedCandidates writes only to curated_items.
    if (curatedRejects.length > 0) {
      try {
        const { admitCuratedCandidates } = await import('./curatedIngest');
        const r = await admitCuratedCandidates(curatedRejects, { mode: 'gate', label: 'rss-bot-rejects' });
        console.log(`[RSSBot] Curated reject capture: ${r.ingested} admitted, ${r.skipped} skipped (of ${curatedRejects.length})`);
      } catch (err) {
        console.error('[RSSBot] Curated reject capture failed (non-fatal):', err);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[RSSBot] Completed in ${duration}s - Posted: ${posted}, Skipped: ${skipped}, Errors: ${errors}`);

    return { posted, skipped, errors };
  } catch (error) {
    console.error('[RSSBot] Fatal error:', error);
    return { posted, skipped, errors: errors + 1 };
  }
}
