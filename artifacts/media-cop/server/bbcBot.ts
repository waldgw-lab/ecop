import Parser from 'rss-parser';
import { openai } from './aiClient';
import { storage } from './storage';
import { scrapeContent } from './textScraper';
import { matchOrCreateSubject, FLASH_TOPIC_NAME, qualifiesForFlashTopStories, CJCS_TOPIC_NAME, detectCJCSMention } from './subjectMatcher';
import { analyzeBatchHeadlines, scoreHeadlinePrioritiesBatch } from './aiAnalyzer';
import { adaptiveBatches } from './adaptiveBatch';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { BOT_CJCS_SYSTEM_PROMPT, UNSCORED_BOT_PRIORITY } from './relevanceDefinition';
import { isRecentArticle } from './articleDateFilter';
import { ENGLISH_TITLE_FIELD_SPEC, extractEnglishTitle } from './titleTranslator';


const BBC_BOT_USER_ID = 'bbc-bot-system';
const BBC_BOT_USER_NAME = 'BBC Bot';

// Normalize URL for consistent duplicate detection
function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Normalize protocol to https, remove query params, fragments, and trailing slashes
    const protocol = 'https:';
    let normalized = protocol + '//' + urlObj.host + urlObj.pathname;
    normalized = normalized.replace(/\/+$/, ''); // Remove trailing slashes
    return normalized;
  } catch {
    // Fallback if URL parsing fails
    let normalized = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
    normalized = normalized.replace(/^http:/, 'https:');
    return normalized;
  }
}

const BBC_RSS_FEEDS = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml',
  'https://feeds.bbci.co.uk/news/world/europe/rss.xml',
  'https://feeds.bbci.co.uk/news/world/asia/rss.xml',
];

interface BBCArticle {
  title: string;
  url: string;
  normalizedUrl: string;
  pubDate?: string;
}

interface AnalyzedArticle extends BBCArticle {
  isRelevant: boolean;
  summary: string;
  relevanceReason: string;
  englishTitle: string;
}

async function fetchBBCHeadlines(): Promise<BBCArticle[]> {
  const parser = new Parser();
  const articles: BBCArticle[] = [];
  const seenUrls = new Set<string>();

  for (const feedUrl of BBC_RSS_FEEDS) {
    try {
      console.log(`[BBCBot] Fetching RSS feed: ${feedUrl}`);
      const feed = await parser.parseURL(feedUrl);
      
      for (const item of feed.items || []) {
        if (!item.title || !item.link) continue;
        
        const normalized = normalizeUrl(item.link);
        if (seenUrls.has(normalized)) continue;
        seenUrls.add(normalized);
        
        if (!isRecentArticle(item.pubDate, 'BBCBot')) continue;
        
        articles.push({
          title: item.title,
          url: item.link,
          normalizedUrl: normalized,
          pubDate: item.pubDate,
        });
      }
    } catch (error) {
      console.error(`[BBCBot] Error fetching RSS feed ${feedUrl}:`, error);
    }
  }

  console.log(`[BBCBot] Found ${articles.length} recent articles from BBC RSS feeds`);
  return articles;
}

async function analyzeArticlesForCJCS(articles: BBCArticle[]): Promise<AnalyzedArticle[]> {
  if (articles.length === 0) return [];
  
  console.log(`[BBCBot] Analyzing ${articles.length} articles for CJCS relevance...`);
  
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
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'bbcBot.relevance');
    
    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error('[BBCBot] No response from AI');
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
    console.log(`[BBCBot] Found ${relevantCount} relevant articles out of ${results.length} analyzed`);
    
    return results;
  } catch (error) {
    console.error('[BBCBot] Error analyzing articles:', error);
    return [];
  }
}

async function postToTeamChat(article: AnalyzedArticle, precomputedPriority?: number): Promise<boolean> {
  try {
    // Use normalized URL for consistent duplicate detection
    const normalizedArticleUrl = article.normalizedUrl || normalizeUrl(article.url);
    
    // Check if this content was blocked by a user (deleted from Active Topics)
    const isBlocked = await storage.isBotContentBlocked(normalizedArticleUrl);
    if (isBlocked) {
      console.log(`[BBCBot] Skipping blocked content: ${article.title.substring(0, 50)}...`);
      return false;
    }
    
    // Final deduplication check right before posting to prevent race conditions
    const alreadyPosted = await storage.isBBCBotArticlePosted(normalizedArticleUrl);
    if (alreadyPosted) {
      console.log(`[BBCBot] Skipping duplicate (final check): ${article.title.substring(0, 50)}...`);
      return false;
    }
    
    const displayTitle = article.englishTitle || article.title;
    const message = `**${displayTitle}**\n\n${article.summary}\n\n${article.url}`;
    
    // Create chat message first
    const chatMessage = await storage.addChatMessage({
      userId: BBC_BOT_USER_ID,
      userName: BBC_BOT_USER_NAME,
      userProfileImage: null,
      message,
    });
    
    // Try to add the post record (has unique constraint) - store NORMALIZED URL
    try {
      await storage.addBBCBotPost({
        articleUrl: normalizedArticleUrl,
        articleTitle: article.title,
        summary: article.summary,
        chatMessageId: chatMessage.id,
      });
    } catch (dbError: any) {
      if (dbError?.code === '23505') {
        // Duplicate - chat message already created but that's okay, it provides context
        console.log(`[BBCBot] Skipping duplicate (constraint): ${article.title.substring(0, 50)}...`);
        return false;
      }
      throw dbError;
    }
    
    // Also create a team submission so articles appear in Active Topics
    try {
      // Check for duplicate URL using normalized URL for consistency
      const existingSubmission = await storage.getSubmissionByUrl(normalizedArticleUrl);
      if (!existingSubmission) {
        // Determine subject for the article (with similarity matching)
        const { subjectName } = await matchOrCreateSubject(displayTitle, article.summary, 'BBCBot');
        const subject = await storage.findOrCreateSubject(subjectName, BBC_BOT_USER_ID);
        
        // Scrape full text for Cassandra archive and better summary
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
            
            // Generate a better summary from the actual article content
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
                }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'bbcBot.summary');
                
                const newSummary = summaryResponse.choices[0]?.message?.content?.trim();
                if (newSummary && newSummary.length > 20) {
                  improvedSummary = newSummary;
                }
              } catch (summaryError) {
                // Keep original summary if AI call fails
                console.error('[BBCBot] Error generating improved summary:', summaryError);
              }
            }
          }
        } catch (scrapeError) {
          // Ignore scrape errors, article summary is sufficient
        }
        
        // Analyze headline for priority score
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
            console.error('[BBCBot] Error analyzing priority:', analyzeError);
          }
        }
        
        // Check if this is a high-priority submission (75+) for FLASH: TOP STORIES
        let flashSubjectId: string | null = null;
        if (qualifiesForFlashTopStories(priorityScore)) {
          console.log(`[BBCBot] HIGH PRIORITY (${priorityScore}) - Adding to FLASH: TOP STORIES`);
          const flashSubject = await storage.getSubjectByName(FLASH_TOPIC_NAME);
          if (flashSubject) {
            flashSubjectId = flashSubject.id;
          }
        }
        
        // Check for CJCS (Chairman Caine) mentions
        let cjcsSubjectId: string | null = null;
        const mentionsCJCS = await detectCJCSMention(displayTitle, improvedSummary);
        if (mentionsCJCS) {
          console.log(`[BBCBot] CJCS MENTION DETECTED - Adding to CJCS MENTIONS`);
          const cjcsSubject = await storage.getSubjectByName(CJCS_TOPIC_NAME);
          if (cjcsSubject) {
            cjcsSubjectId = cjcsSubject.id;
          }
        }
        
        // Store the full article URL (query string preserved) for display/Curated.
        // Dedup is handled separately by the normalized key, so the displayed
        // link keeps its query string and resolves correctly.
        const submission = await storage.addSubmission({
          chatMessageId: chatMessage.id,
          submittedBy: BBC_BOT_USER_ID,
          submittedByName: BBC_BOT_USER_NAME,
          sourceType: 'news',
          sourceUrl: article.url,
          headline: displayTitle,
          summary: improvedSummary,
          status: 'processed',
          priorityScore,
          scoreSource,
        });
        
        // Finalize with subject and flash assignment
        await storage.finalizeSubmissionAnalysis(submission.id, {
          headline: displayTitle,
          summary: improvedSummary,
          sourceType: 'news',
          subjectId: subject.id,
          sourceName: 'BBC News',
          publishedAt: article.pubDate ? new Date(article.pubDate) : null,
          fullText,
          priorityScore,
          scoreSource,
          flashSubjectId,
          cjcsSubjectId,
          ogImageUrl,
        });
      }
    } catch (submissionError) {
      // Log but don't fail the whole post if submission creation fails
      console.error(`[BBCBot] Error creating submission:`, submissionError);
    }
    
    console.log(`[BBCBot] Posted article: ${article.title.substring(0, 50)}...`);
    return true;
  } catch (error) {
    console.error(`[BBCBot] Error posting article to team chat:`, error);
    return false;
  }
}

export async function runBBCBot(): Promise<{ posted: number; skipped: number; errors: number }> {
  console.log('[BBCBot] Starting BBC News scan...');
  const startTime = Date.now();
  
  let posted = 0;
  let skipped = 0;
  let errors = 0;
  
  try {
    const articles = await fetchBBCHeadlines();
    
    if (articles.length === 0) {
      console.log('[BBCBot] No articles found, skipping this cycle');
      return { posted, skipped, errors };
    }
    
    const newArticles: BBCArticle[] = [];
    for (const article of articles) {
      const alreadyPosted = await storage.isBBCBotArticlePosted(article.url);
      if (alreadyPosted) {
        skipped++;
      } else {
        newArticles.push(article);
      }
    }
    
    console.log(`[BBCBot] ${newArticles.length} new articles to analyze (${skipped} already posted)`);
    
    if (newArticles.length === 0) {
      console.log('[BBCBot] No new articles to process');
      return { posted, skipped, errors };
    }
    
    for await (const batch of adaptiveBatches(newArticles)) {
      const analyzed = await analyzeArticlesForCJCS(batch);
      const relevant = analyzed.filter(a => a.isRelevant && a.summary);
      const priorityMap = await scoreHeadlinePrioritiesBatch(relevant.map(a => a.title));

      for (const article of relevant) {
        const success = await postToTeamChat(article, priorityMap.get(article.title));
        if (success) {
          posted++;
        } else {
          skipped++;
        }
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[BBCBot] Completed in ${duration}s - Posted: ${posted}, Skipped: ${skipped}, Errors: ${errors}`);
    
    return { posted, skipped, errors };
  } catch (error) {
    console.error('[BBCBot] Fatal error:', error);
    return { posted, skipped, errors: errors + 1 };
  }
}
