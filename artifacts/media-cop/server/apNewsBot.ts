import * as cheerio from 'cheerio';
import { openai } from './aiClient';
import { storage } from './storage';
import { fetchPageHtml, scrapeContent } from './textScraper';
import { matchOrCreateSubject, FLASH_TOPIC_NAME, qualifiesForFlashTopStories, CJCS_TOPIC_NAME, detectCJCSMention } from './subjectMatcher';
import { analyzeBatchHeadlines, scoreHeadlinePrioritiesBatch } from './aiAnalyzer';
import { adaptiveBatches } from './adaptiveBatch';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { BOT_CJCS_SYSTEM_PROMPT, UNSCORED_BOT_PRIORITY } from './relevanceDefinition';
import { isRecentUrl } from './articleDateFilter';
import { ENGLISH_TITLE_FIELD_SPEC, extractEnglishTitle } from './titleTranslator';
import { normalizeTitle } from './titleNormalizer';
import { invalidateCuratedReadCache } from './curatedCacheBus';


const AP_BOT_USER_ID = 'ap-news-bot-system';
const AP_BOT_USER_NAME = 'AP News Bot';

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

const AP_SECTIONS = [
  'https://apnews.com/world-news',
  'https://apnews.com/us-news',
  'https://apnews.com/politics',
];

interface APArticle {
  title: string;
  url: string;
  normalizedUrl: string;
}

interface AnalyzedArticle extends APArticle {
  isRelevant: boolean;
  summary: string;
  relevanceReason: string;
  englishTitle: string;
}

interface APFetchResult {
  articles: APArticle[];
  fetchFailures: number;
  lastFetchError: string | null;
}

const AP_HEADLINE_SELECTOR = [
  '.PagePromo-title',
  '.PagePromoContentIcons-text',
  '[class*="headline"]',
  '[class*="title"]',
].join(', ');

function cleanAPTitle(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * AP section cards repeat the same article URL across image, caption, headline,
 * and teaser links. Never let the first non-empty anchor win: prefer the image
 * link's explicit accessibility label, then a headline/title element, and only
 * then plain anchor text. Deduplicate only after all candidates for a URL have
 * been considered.
 */
export function parseAPSectionHtml(html: string): APArticle[] {
  const $ = cheerio.load(html);
  const candidates = new Map<string, { article: APArticle; rank: number }>();

  $('a[href*="/article/"]').each((_, elem) => {
    const $elem = $(elem);
    let href = $elem.attr('href');
    if (!href) return;
    if (href.startsWith('//')) href = `https:${href}`;
    else if (!href.startsWith('http')) href = `https://apnews.com${href.startsWith('/') ? href : `/${href}`}`;

    const normalizedUrl = normalizeUrl(href);
    let title = cleanAPTitle($elem.attr('aria-label'));
    let rank = title ? 3 : 0;
    if (!title) {
      title = cleanAPTitle($elem.find(AP_HEADLINE_SELECTOR).first().text());
      rank = title ? 2 : 0;
    }
    if (!title) {
      title = cleanAPTitle($elem.text());
      rank = title ? 1 : 0;
    }
    if (title.length < 10) return;
    if (title.length > 500) title = title.slice(0, 500);

    const existing = candidates.get(normalizedUrl);
    if (!existing || rank > existing.rank) {
      candidates.set(normalizedUrl, {
        article: { title, url: href, normalizedUrl },
        rank,
      });
    }
  });

  return [...candidates.values()].map(({ article }) => article);
}

export function extractAPCanonicalTitle(html: string): string | null {
  const $ = cheerio.load(html);
  const title = cleanAPTitle(
    $('meta[property="og:title"]').attr('content')
      || $('meta[name="twitter:title"]').attr('content')
      || $('h1.Page-headline').first().text()
      || $('h1').first().text(),
  );
  return title.length >= 10 ? title : null;
}

function isEnglishAPArticlePage(html: string): boolean {
  const $ = cheerio.load(html);
  const language = cleanAPTitle($('html').attr('lang')).toLowerCase();
  // AP article pages declare their edition language. Missing/foreign language
  // is not trustworthy enough for title repair or new-item admission.
  return language === 'en' || language.startsWith('en-');
}

function comparableAPTitle(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function areEquivalentAPTitles(a: string, b: string): boolean {
  return comparableAPTitle(a) === comparableAPTitle(b);
}

export function bindAPTitleToArticlePage(sectionTitle: string, html: string): string | null {
  if (!isEnglishAPArticlePage(html)) return null;
  const canonicalTitle = extractAPCanonicalTitle(html);
  if (!canonicalTitle) return null;
  return areEquivalentAPTitles(canonicalTitle, sectionTitle) ? sectionTitle : canonicalTitle;
}

async function verifyAPArticleTitles(articles: APArticle[]): Promise<APArticle[]> {
  const verified: APArticle[] = [];
  const CONCURRENCY = 6;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < articles.length) {
      const article = articles[nextIndex++];
      const page = await fetchPageHtml(article.url);
      const verifiedTitle = page.html ? bindAPTitleToArticlePage(article.title, page.html) : null;
      if (!verifiedTitle) {
        console.warn(`[ApNewsBot] Withholding unverified English article title: ${article.url} (HTTP ${page.status})`);
        continue;
      }
      if (verifiedTitle !== article.title) {
        console.warn(`[ApNewsBot] Canonical title corrected for ${article.url}: "${article.title.slice(0, 80)}" → "${verifiedTitle.slice(0, 80)}"`);
      }
      verified.push({ ...article, title: verifiedTitle });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, articles.length) }, () => worker()),
  );
  return verified;
}

let recentAPTitleAuditStarted = false;
export async function auditRecentAPCuratedTitles(): Promise<void> {
  if (recentAPTitleAuditStarted) return;
  recentAPTitleAuditStarted = true;

  try {
    const recent = await storage.getRecentAPCuratedItems(72, 80);
    const candidates = recent.map((row) => ({
      title: row.title,
      url: row.url,
      normalizedUrl: normalizeUrl(row.url),
    }));
    const verified = await verifyAPArticleTitles(candidates);
    const storedByUrl = new Map(recent.map((row) => [normalizeUrl(row.url), row]));
    let repaired = 0;

    for (const article of verified) {
      const stored = storedByUrl.get(article.normalizedUrl);
      if (!stored || stored.title === article.title) continue;
      if (await storage.repairAPCuratedTitleByUrl(
        stored.url,
        article.title,
        normalizeTitle(article.title),
      )) {
        repaired++;
        console.warn(`[ApNewsBot] Repaired Curated AP title binding for ${stored.url}`);
      }
    }
    if (repaired > 0) invalidateCuratedReadCache();
    console.log(`[ApNewsBot] Recent Curated title audit — checked=${verified.length}/${recent.length} repaired=${repaired}`);
  } catch (error) {
    recentAPTitleAuditStarted = false;
    console.error('[ApNewsBot] Recent Curated title audit failed (will retry next run):', error);
  }
}

function shortFetchError(message: string): string {
  const clean = (message || 'fetch failed').trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
}

async function fetchAPHeadlines(): Promise<APFetchResult> {
  const articles: APArticle[] = [];
  const seenUrls = new Set<string>();
  let fetchFailures = 0;
  let lastFetchError: string | null = null;

  for (const sectionUrl of AP_SECTIONS) {
    try {
      console.log(`[ApNewsBot] Fetching section: ${sectionUrl}`);
      const response = await fetch(sectionUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        },
      });
      
      if (!response.ok) {
        console.error(`[ApNewsBot] Failed to fetch ${sectionUrl}: ${response.status}`);
        fetchFailures++;
        lastFetchError = shortFetchError(`HTTP ${response.status} fetching ${sectionUrl}`);
        continue;
      }
      
      const html = await response.text();
      for (const article of parseAPSectionHtml(html)) {
        if (seenUrls.has(article.normalizedUrl)) continue;
        if (!isRecentUrl(article.url, 'ApNewsBot')) continue;
        seenUrls.add(article.normalizedUrl);
        articles.push(article);
      }
    } catch (error) {
      console.error(`[ApNewsBot] Error fetching section ${sectionUrl}:`, error);
      fetchFailures++;
      lastFetchError = shortFetchError((error as Error).message);
    }
  }

  console.log(`[ApNewsBot] Found ${articles.length} recent articles from AP News`);
  return { articles, fetchFailures, lastFetchError };
}

async function analyzeArticlesForCJCS(articles: APArticle[]): Promise<AnalyzedArticle[]> {
  if (articles.length === 0) return [];
  
  console.log(`[ApNewsBot] Analyzing ${articles.length} articles for CJCS relevance...`);
  
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
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'apNewsBot.relevance');
    
    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error('[ApNewsBot] No response from AI');
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
    console.log(`[ApNewsBot] Found ${relevantCount} relevant articles out of ${results.length} analyzed`);
    
    return results;
  } catch (error) {
    console.error('[ApNewsBot] Error analyzing articles:', error);
    return [];
  }
}

async function postToTeamChat(article: AnalyzedArticle, precomputedPriority?: number): Promise<boolean> {
  try {
    const normalizedArticleUrl = article.normalizedUrl || normalizeUrl(article.url);
    
    const isBlocked = await storage.isBotContentBlocked(normalizedArticleUrl);
    if (isBlocked) {
      console.log(`[ApNewsBot] Skipping blocked content: ${article.title.substring(0, 50)}...`);
      return false;
    }
    
    const alreadyPosted = await storage.isAPNewsBotArticlePosted(normalizedArticleUrl);
    if (alreadyPosted) {
      console.log(`[ApNewsBot] Skipping duplicate (final check): ${article.title.substring(0, 50)}...`);
      return false;
    }
    
    const displayTitle = article.englishTitle || article.title;
    const message = `**${displayTitle}**\n\n${article.summary}\n\n${article.url}`;
    
    const chatMessage = await storage.addChatMessage({
      userId: AP_BOT_USER_ID,
      userName: AP_BOT_USER_NAME,
      userProfileImage: null,
      message,
    });
    
    try {
      await storage.addAPNewsBotPost({
        articleUrl: normalizedArticleUrl,
        articleTitle: article.title,
        summary: article.summary,
        chatMessageId: chatMessage.id,
      });
    } catch (dbError: any) {
      if (dbError?.code === '23505') {
        console.log(`[ApNewsBot] Skipping duplicate (constraint): ${article.title.substring(0, 50)}...`);
        return false;
      }
      throw dbError;
    }
    
    try {
      const existingSubmission = await storage.getSubmissionByUrl(normalizedArticleUrl);
      if (!existingSubmission) {
        const { subjectName } = await matchOrCreateSubject(displayTitle, article.summary, 'ApNewsBot');
        const subject = await storage.findOrCreateSubject(subjectName, AP_BOT_USER_ID);
        
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
                }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'apNewsBot.summary');
                
                const newSummary = summaryResponse.choices[0]?.message?.content?.trim();
                if (newSummary && newSummary.length > 20) {
                  improvedSummary = newSummary;
                }
              } catch (summaryError) {
                console.error('[ApNewsBot] Error generating improved summary:', summaryError);
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
            console.error('[ApNewsBot] Error analyzing priority:', analyzeError);
          }
        }
        
        let flashSubjectId: string | null = null;
        if (qualifiesForFlashTopStories(priorityScore)) {
          console.log(`[ApNewsBot] HIGH PRIORITY (${priorityScore}) - Adding to FLASH: TOP STORIES`);
          const flashSubject = await storage.getSubjectByName(FLASH_TOPIC_NAME);
          if (flashSubject) {
            flashSubjectId = flashSubject.id;
          }
        }
        
        // Check for CJCS (Chairman Caine) mentions
        let cjcsSubjectId: string | null = null;
        const mentionsCJCS = await detectCJCSMention(displayTitle, improvedSummary);
        if (mentionsCJCS) {
          console.log(`[ApNewsBot] CJCS MENTION DETECTED - Adding to CJCS MENTIONS`);
          const cjcsSubject = await storage.getSubjectByName(CJCS_TOPIC_NAME);
          if (cjcsSubject) {
            cjcsSubjectId = cjcsSubject.id;
          }
        }
        
        const submission = await storage.addSubmission({
          chatMessageId: chatMessage.id,
          submittedBy: AP_BOT_USER_ID,
          submittedByName: AP_BOT_USER_NAME,
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
          sourceName: 'AP News',
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
      console.error(`[ApNewsBot] Error creating submission:`, submissionError);
    }
    
    console.log(`[ApNewsBot] Posted article: ${article.title.substring(0, 50)}...`);
    return true;
  } catch (error) {
    console.error(`[ApNewsBot] Error posting article to team chat:`, error);
    return false;
  }
}

export async function runAPNewsBot(): Promise<{ posted: number; skipped: number; errors: number }> {
  console.log('[ApNewsBot] Starting AP News scan...');
  const startTime = Date.now();
  
  let posted = 0;
  let skipped = 0;
  let errors = 0;
  
  try {
    // One bounded audit per process catches historical AP section-card
    // cross-wiring, including rows no longer present on today's section pages.
    // Do not block the fresh scan; exact-URL repair is safe to run alongside it.
    void auditRecentAPCuratedTitles();

    const { articles, fetchFailures, lastFetchError } = await fetchAPHeadlines();
    await storage.mergeCuratedIntakeFeedStats(new Map([[
      'AP News',
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
      console.warn('[ApNewsBot] Failed to persist website fetch stats (non-fatal):', (err as Error).message);
    });
    
    if (articles.length === 0) {
      console.log('[ApNewsBot] No articles found, skipping this cycle');
      return { posted, skipped, errors };
    }
    
    const newArticles: APArticle[] = [];
    for (const article of articles) {
      const alreadyPosted = await storage.isAPNewsBotArticlePosted(article.normalizedUrl);
      if (alreadyPosted) {
        skipped++;
      } else {
        newArticles.push(article);
      }
    }
    
    console.log(`[ApNewsBot] ${newArticles.length} new articles to analyze (${skipped} already posted)`);
    
    if (newArticles.length === 0) {
      console.log('[ApNewsBot] No new articles to process');
      return { posted, skipped, errors };
    }

    // Section pages are discovery only. AP repeats each URL across image,
    // caption, headline, and teaser links, and those card fields can become
    // mismatched during page updates. Bind every NEW candidate to the article
    // page's canonical title before Team scoring or Curated admission. Fail
    // closed: an unverified URL/title pair is safer withheld than cross-wired.
    const verifiedArticles = await verifyAPArticleTitles(newArticles);
    if (verifiedArticles.length !== newArticles.length) {
      console.warn(`[ApNewsBot] Withheld ${newArticles.length - verifiedArticles.length} article(s) whose canonical title could not be verified`);
    }
    if (verifiedArticles.length === 0) {
      console.log('[ApNewsBot] No canonically verified articles to process');
      return { posted, skipped, errors };
    }
    
    // Strict-CJCS-gate rejects collected across batches, routed into the WIDER
    // isolated curated aperture at the end (Task #321). AP previously reached the
    // curated store only via the capped Drudge website-reject path; this gives it
    // a direct, recurring pipe so its non-CJCS world/politics coverage can
    // corroborate curated Top Stories. Bounded so a noisy scan can't flood the
    // curated clustering payload. Curated-only — these never re-enter headlines /
    // Team chat / Classic / Visual.
    const MAX_CURATED_REJECTS = 60;
    const curatedRejects: { title: string; url: string; source: string }[] = [];

    for await (const batch of adaptiveBatches(verifiedArticles)) {
      const analyzed = await analyzeArticlesForCJCS(batch);

      // When the relevance AI is unavailable (timeout / cooldown during an AI
      // rate-limit storm) analyzeArticlesForCJCS returns nothing, which
      // previously dropped the whole batch and starved the Curated lane of fresh
      // AP coverage. Fall back to offering the fetched, recency-filtered
      // headlines to the isolated curated aperture (which applies its own
      // admission gate) so curated stays fed even when Team-chat scoring can't run.
      if (analyzed.length === 0) {
        for (const a of batch) {
          if (curatedRejects.length >= MAX_CURATED_REJECTS) break;
          curatedRejects.push({ title: a.title, url: a.url, source: 'AP News' });
        }
        continue;
      }

      const relevant = analyzed.filter(a => a.isRelevant && a.summary);
      const priorityMap = await scoreHeadlinePrioritiesBatch(relevant.map(a => a.title));

      for (const a of analyzed) {
        if (a.isRelevant && a.summary) continue;
        if (curatedRejects.length >= MAX_CURATED_REJECTS) break;
        curatedRejects.push({ title: a.title, url: a.url, source: 'AP News' });
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
    // Defensive: a curated-lane failure must never break the AP bot.
    // admitCuratedCandidates writes only to curated_items / curated_classifications.
    if (curatedRejects.length > 0) {
      try {
        const { admitCuratedCandidates } = await import('./curatedIngest');
        const r = await admitCuratedCandidates(curatedRejects, { mode: 'gate', label: 'ap-bot-rejects' });
        console.log(`[ApNewsBot] Curated reject capture: ${r.ingested} admitted, ${r.skipped} skipped (of ${curatedRejects.length})`);
      } catch (err) {
        console.error('[ApNewsBot] Curated reject capture failed (non-fatal):', err);
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ApNewsBot] Completed in ${duration}s - Posted: ${posted}, Skipped: ${skipped}, Errors: ${errors}`);
    
    return { posted, skipped, errors };
  } catch (error) {
    console.error('[ApNewsBot] Fatal error:', error);
    return { posted, skipped, errors: errors + 1 };
  }
}
