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


const DRUDGE_BOT_USER_ID = 'drudge-bot-system';
const DRUDGE_BOT_USER_NAME = 'Drudge Bot';

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

interface DrudgeArticle {
  title: string;
  drudgeTitle: string;
  url: string;
  normalizedUrl: string;
}

interface AnalyzedArticle extends DrudgeArticle {
  isRelevant: boolean;
  summary: string;
  relevanceReason: string;
  englishTitle: string;
}

// Extract source name from URL domain
function extractSourceName(url: string): string {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname.toLowerCase();
    
    // Remove www. prefix
    hostname = hostname.replace(/^www\./, '');
    
    // Common domain to source name mappings
    const sourceMap: Record<string, string> = {
      'nytimes.com': 'The New York Times',
      'washingtonpost.com': 'The Washington Post',
      'wsj.com': 'The Wall Street Journal',
      'cnn.com': 'CNN',
      'foxnews.com': 'Fox News',
      'bbc.com': 'BBC',
      'bbc.co.uk': 'BBC',
      'reuters.com': 'Reuters',
      'apnews.com': 'Associated Press',
      'theguardian.com': 'The Guardian',
      'politico.com': 'Politico',
      'axios.com': 'Axios',
      'thehill.com': 'The Hill',
      'nbcnews.com': 'NBC News',
      'abcnews.go.com': 'ABC News',
      'cbsnews.com': 'CBS News',
      'bloomberg.com': 'Bloomberg',
      'forbes.com': 'Forbes',
      'usatoday.com': 'USA Today',
      'latimes.com': 'Los Angeles Times',
      'nypost.com': 'New York Post',
      'dailymail.co.uk': 'Daily Mail',
      'telegraph.co.uk': 'The Telegraph',
      'economist.com': 'The Economist',
      'ft.com': 'Financial Times',
      'aljazeera.com': 'Al Jazeera',
      'rt.com': 'RT',
      'sputniknews.com': 'Sputnik',
      'scmp.com': 'South China Morning Post',
      'jpost.com': 'Jerusalem Post',
      'timesofisrael.com': 'Times of Israel',
      'haaretz.com': 'Haaretz',
      'breitbart.com': 'Breitbart',
      'dailywire.com': 'The Daily Wire',
      'nationalreview.com': 'National Review',
      'theatlantic.com': 'The Atlantic',
      'newyorker.com': 'The New Yorker',
      'slate.com': 'Slate',
      'vox.com': 'Vox',
      'huffpost.com': 'HuffPost',
      'newsweek.com': 'Newsweek',
      'time.com': 'Time',
      'foreignpolicy.com': 'Foreign Policy',
      'foreignaffairs.com': 'Foreign Affairs',
      'defenseone.com': 'Defense One',
      'defensenews.com': 'Defense News',
      'military.com': 'Military.com',
      'stars and stripes.com': 'Stars and Stripes',
      'stripes.com': 'Stars and Stripes',
      'marinecorpstimes.com': 'Marine Corps Times',
      'armytimes.com': 'Army Times',
      'navytimes.com': 'Navy Times',
      'airforcetimes.com': 'Air Force Times',
      'militarytimes.com': 'Military Times',
      'thedrive.com': 'The Drive',
      'breakingdefense.com': 'Breaking Defense',
      'c4isrnet.com': 'C4ISRNET',
      'janes.com': 'Janes',
      'tass.com': 'TASS',
      'kyivindependent.com': 'Kyiv Independent',
      'pravda.com.ua': 'Ukrainska Pravda',
      'globo.com': 'O Globo',
      'folha.uol.com.br': 'Folha de S. Paulo',
      'uol.com.br': 'UOL',
      'estadao.com.br': 'Estadão',
      'infobae.com': 'Infobae',
      'clarin.com': 'Clarín',
      'elpais.com': 'El País',
      'elmundo.es': 'El Mundo',
      'lemonde.fr': 'Le Monde',
      'lefigaro.fr': 'Le Figaro',
      'spiegel.de': 'Der Spiegel',
      'bild.de': 'Bild',
      'nikkei.com': 'Nikkei',
      'japantimes.co.jp': 'Japan Times',
      'theaustralian.com.au': 'The Australian',
      'abc.net.au': 'ABC Australia',
      'news.com.au': 'News.com.au',
      'cbc.ca': 'CBC',
      'globalnews.ca': 'Global News',
      'nationalpost.com': 'National Post',
      'torontosun.com': 'Toronto Sun',
    };
    
    // Check for exact match
    if (sourceMap[hostname]) {
      return sourceMap[hostname];
    }
    
    // Check for partial domain match (for subdomains)
    for (const [domain, name] of Object.entries(sourceMap)) {
      if (hostname.endsWith('.' + domain) || hostname === domain) {
        return name;
      }
    }
    
    // Format the domain name nicely as a fallback
    // e.g., "folha.uol.com.br" -> "Folha"
    const parts = hostname.split('.');
    // Remove common TLDs
    const tlds = ['com', 'org', 'net', 'gov', 'edu', 'co', 'uk', 'br', 'de', 'fr', 'es', 'it', 'ru', 'cn', 'jp', 'au', 'ca', 'mx', 'ar', 'ua'];
    const filtered = parts.filter(p => !tlds.includes(p));
    
    if (filtered.length > 0) {
      // Capitalize first letter of main domain part
      const mainPart = filtered[0];
      return mainPart.charAt(0).toUpperCase() + mainPart.slice(1);
    }
    
    return hostname;
  } catch (error) {
    return 'Unknown Source';
  }
}

const HEADLINE_FETCH_TIMEOUT = 4000;

async function resolveOriginalHeadline(url: string, drudgeTitle: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEADLINE_FETCH_TIMEOUT);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(`[DrudgeBot] Headline resolve failed (HTTP ${response.status}) for ${url.substring(0, 80)}, using Drudge title`);
      return drudgeTitle;
    }

    const html = await response.text();

    let headline: string | null = null;

    const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (ogTitleMatch?.[1]) {
      headline = ogTitleMatch[1].trim();
    }

    if (!headline) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch?.[1]) {
        headline = titleMatch[1].trim();
      }
    }

    if (!headline || headline.length < 15) {
      console.log(`[DrudgeBot] No valid headline found at ${url.substring(0, 80)}, using Drudge title`);
      return drudgeTitle;
    }

    const genericTitles = ['403 forbidden', 'access denied', 'page not found', '404', 'error', 'just a moment', 'attention required'];
    if (genericTitles.some(g => headline!.toLowerCase().startsWith(g))) {
      console.log(`[DrudgeBot] Generic/blocked page title at ${url.substring(0, 80)}, using Drudge title`);
      return drudgeTitle;
    }

    headline = headline
      .replace(/\s*[-–—|]\s*(The New York Times|Washington Post|CNN|Fox News|BBC|Reuters|Associated Press|AP News|NBC News|ABC News|CBS News|Bloomberg|Forbes|USA Today|Politico|Axios|The Hill|The Guardian|NPR|CNBC|The Wall Street Journal|WSJ|New York Post|Daily Mail|The Telegraph|The Economist|Al Jazeera|Defense One|Defense News|Breaking Defense|Military\.com|Stars and Stripes|The Atlantic|Newsweek|Time|Foreign Policy|HuffPost|Slate|Vox).*$/i, '')
      .replace(/\s*[-–—|]\s*[A-Z][A-Za-z\s.]{2,30}$/, '')
      .trim();

    if (headline.length < 15) {
      return drudgeTitle;
    }

    const decoded = headline
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");

    console.log(`[DrudgeBot] Resolved headline: "${decoded.substring(0, 60)}..." (Drudge: "${drudgeTitle.substring(0, 40)}...")`);
    return decoded;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      console.log(`[DrudgeBot] Headline fetch timed out for ${url.substring(0, 80)}, using Drudge title`);
    } else {
      console.log(`[DrudgeBot] Headline fetch error for ${url.substring(0, 80)}: ${error?.message || error}, using Drudge title`);
    }
    return drudgeTitle;
  }
}

async function scrapeDrudgeHeadlines(): Promise<DrudgeArticle[]> {
  try {
    console.log('[DrudgeBot] Fetching Drudge Report homepage...');
    const response = await fetch('https://www.drudgereport.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(30000),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    const articles: DrudgeArticle[] = [];
    const seenUrls = new Set<string>();
    
    $('a').each((_, element) => {
      const $link = $(element);
      const title = $link.text().trim();
      const url = $link.attr('href');
      
      if (!title || title.length < 15 || !url) return;
      if (url.startsWith('#') || url.startsWith('javascript:')) return;
      if (!url.startsWith('http')) return;
      
      const normalized = normalizeUrl(url);
      if (seenUrls.has(normalized)) return;
      seenUrls.add(normalized);
      
      if (url.includes('drudgereport.com')) return;
      
      if (!isRecentUrl(url, 'DrudgeBot')) return;
      
      articles.push({ title, drudgeTitle: title, url, normalizedUrl: normalized });
    });
    
    console.log(`[DrudgeBot] Found ${articles.length} recent articles on Drudge Report, resolving original headlines...`);
    
    const resolvedResults = await Promise.allSettled(
      articles.map(article => resolveOriginalHeadline(article.url, article.drudgeTitle))
    );
    
    let resolvedCount = 0;
    for (let i = 0; i < articles.length; i++) {
      const result = resolvedResults[i];
      if (result.status === 'fulfilled') {
        if (result.value !== articles[i].drudgeTitle) {
          resolvedCount++;
        }
        articles[i].title = result.value;
      }
    }
    
    console.log(`[DrudgeBot] Resolved ${resolvedCount}/${articles.length} original headlines (${articles.length - resolvedCount} used Drudge fallback)`);
    return articles;
  } catch (error) {
    console.error('[DrudgeBot] Error scraping Drudge Report:', error);
    return [];
  }
}

async function analyzeArticlesForCJCS(articles: DrudgeArticle[]): Promise<AnalyzedArticle[]> {
  if (articles.length === 0) return [];
  
  console.log(`[DrudgeBot] Analyzing ${articles.length} articles for CJCS relevance...`);
  
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
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'drudgeBot.relevance');
    
    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error('[DrudgeBot] No response from AI');
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
    console.log(`[DrudgeBot] Found ${relevantCount} relevant articles out of ${results.length} analyzed`);
    
    return results;
  } catch (error) {
    console.error('[DrudgeBot] Error analyzing articles:', error);
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
      console.log(`[DrudgeBot] Skipping blocked content: ${article.title.substring(0, 50)}...`);
      return false;
    }
    
    // Final deduplication check right before posting to prevent race conditions
    const alreadyPosted = await storage.isDrudgeBotArticlePosted(normalizedArticleUrl);
    if (alreadyPosted) {
      console.log(`[DrudgeBot] Skipping duplicate (final check): ${article.title.substring(0, 50)}...`);
      return false;
    }
    
    const displayTitle = article.englishTitle || article.title;
    const message = `**${displayTitle}**\n\n${article.summary}\n\n${article.url}`;
    
    // Create chat message first
    const chatMessage = await storage.addChatMessage({
      userId: DRUDGE_BOT_USER_ID,
      userName: DRUDGE_BOT_USER_NAME,
      userProfileImage: null,
      message,
    });
    
    // Try to add the post record (has unique constraint) - store NORMALIZED URL
    try {
      await storage.addDrudgeBotPost({
        articleUrl: normalizedArticleUrl,
        articleTitle: article.title,
        summary: article.summary,
        chatMessageId: chatMessage.id,
      });
    } catch (dbError: any) {
      if (dbError?.code === '23505') {
        // Duplicate - chat message already created but that's okay, it provides context
        console.log(`[DrudgeBot] Skipping duplicate (constraint): ${article.title.substring(0, 50)}...`);
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
        const { subjectName } = await matchOrCreateSubject(displayTitle, article.summary, 'DrudgeBot');
        const subject = await storage.findOrCreateSubject(subjectName, DRUDGE_BOT_USER_ID);
        
        // Extract the actual source name from the URL
        const actualSourceName = extractSourceName(article.url);
        
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
                }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'drudgeBot.summary');
                
                const newSummary = summaryResponse.choices[0]?.message?.content?.trim();
                if (newSummary && newSummary.length > 20) {
                  improvedSummary = newSummary;
                }
              } catch (summaryError) {
                // Keep original summary if AI call fails
                console.error('[DrudgeBot] Error generating improved summary:', summaryError);
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
            console.error('[DrudgeBot] Error analyzing priority:', analyzeError);
          }
        }
        
        // Check if this is a high-priority submission (75+) for FLASH: TOP STORIES
        let flashSubjectId: string | null = null;
        if (qualifiesForFlashTopStories(priorityScore)) {
          console.log(`[DrudgeBot] HIGH PRIORITY (${priorityScore}) - Adding to FLASH: TOP STORIES`);
          const flashSubject = await storage.getSubjectByName(FLASH_TOPIC_NAME);
          if (flashSubject) {
            flashSubjectId = flashSubject.id;
          }
        }
        
        // Check for CJCS (Chairman Caine) mentions
        let cjcsSubjectId: string | null = null;
        const mentionsCJCS = await detectCJCSMention(displayTitle, improvedSummary);
        if (mentionsCJCS) {
          console.log(`[DrudgeBot] CJCS MENTION DETECTED - Adding to CJCS MENTIONS`);
          const cjcsSubject = await storage.getSubjectByName(CJCS_TOPIC_NAME);
          if (cjcsSubject) {
            cjcsSubjectId = cjcsSubject.id;
          }
        }
        
        // Store the full resolved article URL (query string preserved) for
        // display/Curated, not the Drudge redirect. Dedup is handled separately
        // by the normalized key, so the displayed link resolves correctly.
        const submission = await storage.addSubmission({
          chatMessageId: chatMessage.id,
          submittedBy: DRUDGE_BOT_USER_ID,
          submittedByName: DRUDGE_BOT_USER_NAME,
          sourceType: 'news',
          sourceUrl: article.url,
          headline: displayTitle,
          summary: improvedSummary,
          status: 'processed',
          priorityScore,
          scoreSource,
        });
        
        // Finalize with subject and flash/cjcs assignment
        await storage.finalizeSubmissionAnalysis(submission.id, {
          headline: displayTitle,
          summary: improvedSummary,
          sourceType: 'news',
          subjectId: subject.id,
          sourceName: actualSourceName,
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
      // Log but don't fail the whole post if submission creation fails
      console.error(`[DrudgeBot] Error creating submission:`, submissionError);
    }
    
    console.log(`[DrudgeBot] Posted article: ${article.title.substring(0, 50)}...`);
    return true;
  } catch (error) {
    console.error(`[DrudgeBot] Error posting article to team chat:`, error);
    return false;
  }
}

export async function runDrudgeBot(): Promise<{ posted: number; skipped: number; errors: number }> {
  console.log('[DrudgeBot] Starting Drudge Report scan...');
  const startTime = Date.now();
  
  let posted = 0;
  let skipped = 0;
  let errors = 0;
  
  try {
    const articles = await scrapeDrudgeHeadlines();
    
    if (articles.length === 0) {
      console.log('[DrudgeBot] No articles found, skipping this cycle');
      return { posted, skipped, errors };
    }
    
    const newArticles: DrudgeArticle[] = [];
    for (const article of articles) {
      const alreadyPosted = await storage.isDrudgeBotArticlePosted(article.normalizedUrl);
      if (alreadyPosted) {
        skipped++;
      } else {
        newArticles.push(article);
      }
    }
    
    console.log(`[DrudgeBot] ${newArticles.length} new articles to analyze (${skipped} already posted)`);
    
    if (newArticles.length === 0) {
      console.log('[DrudgeBot] No new articles to process');
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
    console.log(`[DrudgeBot] Completed in ${duration}s - Posted: ${posted}, Skipped: ${skipped}, Errors: ${errors}`);
    
    return { posted, skipped, errors };
  } catch (error) {
    console.error('[DrudgeBot] Fatal error:', error);
    return { posted, skipped, errors: errors + 1 };
  }
}
