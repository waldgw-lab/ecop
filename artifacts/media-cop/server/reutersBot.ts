import * as cheerio from 'cheerio';
import { openai } from './aiClient';
import { storage } from './storage';
import { scrapeContent } from './textScraper';
import { matchOrCreateSubject, FLASH_TOPIC_NAME, qualifiesForFlashTopStories, CJCS_TOPIC_NAME, detectCJCSMention } from './subjectMatcher';
import { analyzeBatchHeadlines, scoreHeadlinePrioritiesBatch } from './aiAnalyzer';
import { adaptiveBatches } from './adaptiveBatch';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { BOT_CJCS_SYSTEM_PROMPT, UNSCORED_BOT_PRIORITY } from './relevanceDefinition';
import { isRecentUrl } from './articleDateFilter';
import { ENGLISH_TITLE_FIELD_SPEC, extractEnglishTitle } from './titleTranslator';


const REUTERS_BOT_USER_ID = 'reuters-bot-system';
const REUTERS_BOT_USER_NAME = 'Reuters Bot';

function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const protocol = 'https:';
    let normalized = protocol + '//' + urlObj.host + urlObj.pathname;
    normalized = normalized.replace(/\/+$/, '');
    return normalized;
  } catch {
    let normalized = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
    normalized = normalized.replace(/^http:/, 'https:');
    return normalized;
  }
}

// Reuters' own site (www.reuters.com) hard-blocks this server's datacenter IP
// with a 401 bot wall regardless of headers, so direct section scraping yields
// nothing. Instead we discover recent Reuters headlines off-host via Bing News
// RSS (which this infrastructure can reach). Bing News RSS item links carry the
// real publisher URL in their `url=` query parameter, so we can recover clean
// reuters.com article URLs directly — unlike Google News, whose newer links are
// signed redirects that can't be decoded offline. The CJCS relevance gate
// downstream does the topical filtering.
const REUTERS_BING_FEEDS = [
  'https://www.bing.com/news/search?q=site%3Areuters.com&format=RSS',
  'https://www.bing.com/news/search?q=site%3Areuters.com+(world+OR+military+OR+defense+OR+pentagon+OR+ukraine+OR+china+OR+israel)&format=RSS',
];

interface ReutersArticle {
  title: string;
  url: string;
  normalizedUrl: string;
}

interface AnalyzedArticle extends ReutersArticle {
  isRelevant: boolean;
  summary: string;
  relevanceReason: string;
  englishTitle: string;
}

// Bing News RSS links look like
// http://www.bing.com/news/apiclick.aspx?...&url=<url-encoded real article URL>
// Pull the real URL out of the `url=` param. Fail-closed to reuters.com hosts so
// we drop Bing's occasional aggregator dupes (msn.com, etc.) and never store a
// bing redirect URL.
function extractReutersUrlFromBing(bingLink: string): string | null {
  try {
    const real = new URL(bingLink).searchParams.get('url');
    if (!real) return null;
    const host = new URL(real).hostname.toLowerCase();
    if (host !== 'reuters.com' && !host.endsWith('.reuters.com')) return null;
    return real;
  } catch {
    return null;
  }
}

interface ReutersFetchResult {
  articles: ReutersArticle[];
  fetchFailures: number;
  lastFetchError: string | null;
}

function shortFetchError(message: string): string {
  const clean = (message || 'fetch failed').trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
}

async function fetchReutersHeadlines(): Promise<ReutersFetchResult> {
  const articles: ReutersArticle[] = [];
  const seenUrls = new Set<string>();
  let fetchFailures = 0;
  let lastFetchError: string | null = null;

  for (const feedUrl of REUTERS_BING_FEEDS) {
    try {
      console.log(`[ReutersBot] Fetching Reuters headlines via Bing News RSS: ${feedUrl}`);
      const response = await fetch(feedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response.ok) {
        console.error(`[ReutersBot] Failed to fetch Bing News RSS: ${response.status}`);
        fetchFailures++;
        lastFetchError = shortFetchError(`HTTP ${response.status} fetching Bing News RSS`);
        continue;
      }

      const xml = await response.text();
      const $ = cheerio.load(xml, { xml: true });

      $('item').each((_, elem) => {
        const $elem = $(elem);
        let title = $elem.find('title').first().text().trim();
        const link = $elem.find('link').first().text().trim();
        if (!title || !link) return;

        const realUrl = extractReutersUrlFromBing(link);
        if (!realUrl) return;
        if (realUrl.includes('/video/') || realUrl.includes('/pictures/')) return;

        title = title.replace(/\s+/g, ' ').trim();
        if (title.length < 10) return;
        if (title.length > 200) {
          title = title.substring(0, 200) + '...';
        }

        const normalized = normalizeUrl(realUrl);
        if (seenUrls.has(normalized)) return;
        seenUrls.add(normalized);

        if (!isRecentUrl(realUrl, 'ReutersBot')) return;

        articles.push({
          title,
          url: realUrl,
          normalizedUrl: normalized,
        });
      });
    } catch (error) {
      console.error(`[ReutersBot] Error fetching Bing News RSS ${feedUrl}:`, error);
      fetchFailures++;
      lastFetchError = shortFetchError((error as Error).message);
    }
  }

  console.log(`[ReutersBot] Found ${articles.length} recent articles from Reuters`);
  return { articles, fetchFailures, lastFetchError };
}

async function analyzeArticlesForCJCS(articles: ReutersArticle[]): Promise<AnalyzedArticle[]> {
  if (articles.length === 0) return [];
  
  console.log(`[ReutersBot] Analyzing ${articles.length} articles for CJCS relevance...`);
  
  const systemPrompt = BOT_CJCS_SYSTEM_PROMPT;

  try {
    const articlesList = articles.map((a, i) => `${i + 1}. "${a.title}"`).join('\n');
    
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
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'reutersBot.relevance');
    
    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error('[ReutersBot] No response from AI');
      return [];
    }
    
    const parsed = JSON.parse(content);
    const results: AnalyzedArticle[] = [];
    
    for (const item of parsed.articles || []) {
      const index = item.index - 1;
      if (index >= 0 && index < articles.length) {
        results.push({
          ...articles[index],
          isRelevant: item.isRelevant,
          summary: item.summary || '',
          relevanceReason: item.reason || '',
          englishTitle: extractEnglishTitle(item, articles[index].title),
        });
      }
    }
    
    const relevantCount = results.filter(r => r.isRelevant).length;
    console.log(`[ReutersBot] Found ${relevantCount} relevant articles out of ${results.length} analyzed`);
    
    return results;
  } catch (error) {
    console.error('[ReutersBot] Error analyzing articles:', error);
    return [];
  }
}

async function postToTeamChat(article: AnalyzedArticle, precomputedPriority?: number): Promise<boolean> {
  try {
    const normalizedArticleUrl = article.normalizedUrl || normalizeUrl(article.url);
    
    const isBlocked = await storage.isBotContentBlocked(normalizedArticleUrl);
    if (isBlocked) {
      console.log(`[ReutersBot] Skipping blocked content: ${article.title.substring(0, 50)}...`);
      return false;
    }
    
    const alreadyPosted = await storage.isReutersBotArticlePosted(normalizedArticleUrl);
    if (alreadyPosted) {
      console.log(`[ReutersBot] Skipping duplicate (final check): ${article.title.substring(0, 50)}...`);
      return false;
    }
    
    const displayTitle = article.englishTitle || article.title;
    const message = `**${displayTitle}**\n\n${article.summary}\n\n${article.url}`;
    
    const chatMessage = await storage.addChatMessage({
      userId: REUTERS_BOT_USER_ID,
      userName: REUTERS_BOT_USER_NAME,
      userProfileImage: null,
      message,
    });
    
    try {
      await storage.addReutersBotPost({
        articleUrl: normalizedArticleUrl,
        articleTitle: article.title,
        summary: article.summary,
        chatMessageId: chatMessage.id,
      });
    } catch (dbError: any) {
      if (dbError?.code === '23505') {
        console.log(`[ReutersBot] Skipping duplicate (constraint): ${article.title.substring(0, 50)}...`);
        return false;
      }
      throw dbError;
    }
    
    try {
      const existingSubmission = await storage.getSubmissionByUrl(normalizedArticleUrl);
      if (!existingSubmission) {
        const { subjectName } = await matchOrCreateSubject(displayTitle, article.summary, 'ReutersBot');
        const subject = await storage.findOrCreateSubject(subjectName, REUTERS_BOT_USER_ID);
        
        let fullText: string | undefined;
        let ogImageUrl: string | null = null;
        let improvedSummary = article.summary;
        try {
          const scrapedContent = await scrapeContent(article.url, 'news');
          if (scrapedContent.imageUrl) {
            ogImageUrl = scrapedContent.imageUrl;
          }
          if (scrapedContent.success && scrapedContent.fullText) {
            fullText = scrapedContent.fullText;
            
            if (fullText.length > 100) {
              try {
                const summaryResponse = await withAiTimeout(openai.chat.completions.create({
                  model: 'gpt-4o-mini',
                  messages: [
                    { 
                      role: 'system', 
                      content: 'You are a military intelligence analyst. Summarize the following news article in 1-2 concise sentences, focusing on the key facts, events, and strategic implications for U.S. national security. Do NOT describe what the publication is or what it covers - describe the actual news story. Output ONLY the summary itself as plain prose: no heading, no title, no label, no preamble, and never name or address an audience or state who the summary is for.' 
                    },
                    { 
                      role: 'user', 
                      content: `Article headline: ${article.title}\n\nArticle text:\n${fullText.substring(0, 4000)}` 
                    }
                  ],
                  temperature: 0.2,
                  max_tokens: 150,
                }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'reutersBot.summary');
                
                const newSummary = summaryResponse.choices[0]?.message?.content?.trim();
                if (newSummary && newSummary.length > 20) {
                  improvedSummary = newSummary;
                }
              } catch (summaryError) {
                console.error('[ReutersBot] Error generating improved summary:', summaryError);
              }
            }
          }
        } catch (scrapeError) {
        }
        
        let priorityScore = typeof precomputedPriority === "number" ? precomputedPriority : UNSCORED_BOT_PRIORITY;
        // Task #811: flag the AI-scorer-failed fallback so the retry job can find
        // and re-score it instead of leaving it buried at 30 forever.
        let scoreSource = typeof precomputedPriority === "number" ? 'ai' : 'unscored_fallback';
        if (typeof precomputedPriority !== "number") {
          try {
            const analysisResults = await analyzeBatchHeadlines([displayTitle]);
            if (analysisResults.length > 0 && analysisResults[0].priority_score) {
              priorityScore = analysisResults[0].priority_score;
              scoreSource = 'ai';
            }
          } catch (analyzeError) {
            console.error('[ReutersBot] Error analyzing priority:', analyzeError);
          }
        }
        
        let flashSubjectId: string | null = null;
        if (qualifiesForFlashTopStories(priorityScore)) {
          console.log(`[ReutersBot] HIGH PRIORITY (${priorityScore}) - Adding to FLASH: TOP STORIES`);
          const flashSubject = await storage.getSubjectByName(FLASH_TOPIC_NAME);
          if (flashSubject) {
            flashSubjectId = flashSubject.id;
          }
        }
        
        // Check for CJCS (Chairman Caine) mentions
        let cjcsSubjectId: string | null = null;
        const mentionsCJCS = await detectCJCSMention(displayTitle, improvedSummary);
        if (mentionsCJCS) {
          console.log(`[ReutersBot] CJCS MENTION DETECTED - Adding to CJCS MENTIONS`);
          const cjcsSubject = await storage.getSubjectByName(CJCS_TOPIC_NAME);
          if (cjcsSubject) {
            cjcsSubjectId = cjcsSubject.id;
          }
        }
        
        const submission = await storage.addSubmission({
          chatMessageId: chatMessage.id,
          submittedBy: REUTERS_BOT_USER_ID,
          submittedByName: REUTERS_BOT_USER_NAME,
          sourceType: 'news',
          // Store the full article URL (query string preserved) for display/Curated.
          // The normalized form is used only as the dedup key.
          sourceUrl: article.url,
          headline: displayTitle,
          summary: improvedSummary,
          status: 'processed',
          priorityScore,
          scoreSource,
        });
        
        await storage.finalizeSubmissionAnalysis(submission.id, {
          headline: displayTitle,
          summary: improvedSummary,
          sourceType: 'news',
          subjectId: subject.id,
          sourceName: 'Reuters',
          publishedAt: null,
          fullText,
          priorityScore,
          scoreSource,
          flashSubjectId,
          cjcsSubjectId,
          ogImageUrl,
        });
      }
    } catch (submissionError) {
      console.error(`[ReutersBot] Error creating submission:`, submissionError);
    }
    
    console.log(`[ReutersBot] Posted article: ${article.title.substring(0, 50)}...`);
    return true;
  } catch (error) {
    console.error(`[ReutersBot] Error posting article to team chat:`, error);
    return false;
  }
}

export async function runReutersBot(): Promise<{ posted: number; skipped: number; errors: number }> {
  console.log('[ReutersBot] Starting Reuters scan...');
  const startTime = Date.now();
  
  let posted = 0;
  let skipped = 0;
  let errors = 0;
  
  try {
    const { articles, fetchFailures, lastFetchError } = await fetchReutersHeadlines();
    await storage.mergeCuratedIntakeFeedStats(new Map([[
      'Reuters',
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
      console.warn('[ReutersBot] Failed to persist off-host fetch stats (non-fatal):', (err as Error).message);
    });
    
    if (articles.length === 0) {
      console.log('[ReutersBot] No articles found, skipping this cycle');
      return { posted, skipped, errors };
    }
    
    const newArticles: ReutersArticle[] = [];
    for (const article of articles) {
      const alreadyPosted = await storage.isReutersBotArticlePosted(article.normalizedUrl);
      if (alreadyPosted) {
        skipped++;
      } else {
        newArticles.push(article);
      }
    }
    
    console.log(`[ReutersBot] ${newArticles.length} new articles to analyze (${skipped} already posted)`);
    
    if (newArticles.length === 0) {
      console.log('[ReutersBot] No new articles to process');
      return { posted, skipped, errors };
    }
    
    // Strict-CJCS-gate rejects collected across batches, routed into the WIDER
    // isolated curated aperture at the end (Task #321). Reuters previously
    // reached the curated store only via the capped Drudge website-reject path;
    // this gives it a direct, recurring pipe so its non-CJCS world/politics
    // coverage can corroborate curated Top Stories. Bounded so a noisy scan
    // can't flood the curated clustering payload. Curated-only — these never
    // re-enter headlines / Team chat / Classic / Visual.
    const MAX_CURATED_REJECTS = 60;
    const curatedRejects: { title: string; url: string; source: string }[] = [];

    for await (const batch of adaptiveBatches(newArticles)) {
      const analyzed = await analyzeArticlesForCJCS(batch);

      // When the relevance AI is unavailable (timeout / cooldown during an AI
      // rate-limit storm) analyzeArticlesForCJCS returns nothing, which
      // previously dropped the whole batch and starved the Curated lane of fresh
      // Reuters coverage. Fall back to offering the fetched, recency-filtered
      // headlines to the isolated curated aperture (which applies its own
      // admission gate) so curated stays fed even when Team-chat scoring can't run.
      if (analyzed.length === 0) {
        for (const a of batch) {
          if (curatedRejects.length >= MAX_CURATED_REJECTS) break;
          curatedRejects.push({ title: a.title, url: a.url, source: 'Reuters' });
        }
        continue;
      }

      const relevant = analyzed.filter(a => a.isRelevant && a.summary);
      const priorityMap = await scoreHeadlinePrioritiesBatch(relevant.map(a => a.title));

      for (const a of analyzed) {
        if (a.isRelevant && a.summary) continue;
        if (curatedRejects.length >= MAX_CURATED_REJECTS) break;
        curatedRejects.push({ title: a.title, url: a.url, source: 'Reuters' });
      }

      for (const article of relevant) {
        const success = await postToTeamChat(article, priorityMap.get(article.title));
        if (success) {
          posted++;
        } else {
          skipped++;
        }
      }
    }

    // Route strict-gate rejects into the isolated curated aperture (Task #321).
    // Defensive: a curated-lane failure must never break the Reuters bot.
    // admitCuratedCandidates writes only to curated_items / curated_classifications.
    if (curatedRejects.length > 0) {
      try {
        const { admitCuratedCandidates } = await import('./curatedIngest');
        const r = await admitCuratedCandidates(curatedRejects, { mode: 'gate', label: 'reuters-bot-rejects' });
        console.log(`[ReutersBot] Curated reject capture: ${r.ingested} admitted, ${r.skipped} skipped (of ${curatedRejects.length})`);
      } catch (err) {
        console.error('[ReutersBot] Curated reject capture failed (non-fatal):', err);
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ReutersBot] Completed in ${duration}s - Posted: ${posted}, Skipped: ${skipped}, Errors: ${errors}`);
    
    return { posted, skipped, errors };
  } catch (error) {
    console.error('[ReutersBot] Fatal error:', error);
    return { posted, skipped, errors: errors + 1 };
  }
}
