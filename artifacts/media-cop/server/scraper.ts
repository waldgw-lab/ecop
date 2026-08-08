import * as cheerio from 'cheerio';
import type { InsertHeadline } from '@shared/schema';
import { extractArticleTimestamp } from './timestampExtractor';
import { analyzeBatchHeadlines } from './aiAnalyzer';
import { scrapeRSSFeed } from './rssScraper';
import { hasSecurityContext } from './relevanceDefinition';
import { storage } from './storage';
import { normalizeTitle } from './titleNormalizer';
import { openai, isAIConfigured } from './aiClient';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { isSingleWellFormedHttpUrl } from './curatedIngest';
import { resolveAiScore, evalMainScoreCaps } from './scoreAdjustments';
import type { InsertCuratedItem } from '@shared/schema';
import {
  isMainFeedWatchSteeringEnabled,
  loadActiveWatchTopics,
  matchWatchTopics,
  createRescueBudget,
  applyPriorityBoost,
  type CompiledWatchTopic,
  type WatchMatch,
} from './watchTopicMatcher';

// A low-credibility-source item pulled from the main gate. It is quarantined
// (audit) AND rerouted into the isolated curated lane as attach-only. The
// optional fields carry whatever enrichment the scrape already produced.
interface QuarantineItem {
  title: string;
  url: string;
  source: string;
  reason: string;
  category?: string;
  priorityScore?: number;
  tags?: string[];
  ogImageUrl?: string | null;
  articlePublishedAt?: Date | null;
}

// Blocked media outlets - filter these sources from Column 1 headlines
// User-specified outlets to exclude from military intelligence feed
// Using exact domains to handle variants (the-sun.com, thesun.co.uk, etc.)
const BLOCKED_MEDIA_OUTLET_DOMAINS = [
  'thesun.co.uk',
  'the-sun.com',
  'sun.co.uk',
  'breitbart.com',
  'infowars.com',
  'thegatewaypundit.com',
  'nationalenquirer.com',
  'wnd.com',
  'worldnetdaily.com'
];

// Blocked outlet names for source string matching (after extraction)
const BLOCKED_MEDIA_OUTLET_NAMES = [
  'the sun',
  'breitbart news',
  'breitbart',
  'infowars',
  'the gateway pundit',
  'gateway pundit',
  'national enquirer',
  'wnd'
];

// Exclusion keywords - stories to filter out (medical, entertainment, personal)
// NOTE: Must be specific to avoid false positives (e.g., "tumor cells" not "cells" to avoid blocking "terror cells")
//
// These are split into two groups:
//   - HARD_EXCLUSION_KEYWORDS: always hard-dropped at the Layer-1 gate
//     (entertainment, sports, medical, consumer tech). Unchanged behavior.
//   - FINANCE_WEATHER_KEYWORDS: rescue-eligible — if the headline ALSO contains
//     a security-context rescue term (see relevanceDefinition.ts), it is kept
//     and flows into the normal AI relevance/scoring layer instead of being
//     hard-dropped. Pure finance/weather noise is still dropped.
const HARD_EXCLUSION_KEYWORDS = [
  // Medical/Health (non-crisis)
  'cancer', 'tumor cells', 'medical breakthrough', 'health study', 'heart attack', 'disease outbreak', 'treatment option',
  'sleep study', 'diet plan', 'fitness', 'nutrition', 'recipe', 'wellness', 'vitamin', 'supplement',
  
  // Entertainment/Celebrity
  'celebrity', 'actor', 'actress', 'movie premiere', 'film festival', 'concert', 'album',
  'hollywood', 'oscar', 'grammy', 'emmy', 'golden globe', 'box office',
  'tv show', 'television series', 'streaming service', 'netflix', 'disney+', 'hbo',
  'south park', 'family guy', 'sitcom', 'reality show', 'talent show',
  'pop star', 'rapper', 'singer', 'musician', 'band tour', 'music video',
  'kardashian', 'influencer', 'viral video', 'tiktok', 'instagram model',
  
  // Sports
  'sports', 'football', 'basketball', 'baseball', 'playoff', 'player trade', 'team roster',
  'super bowl', 'world series', 'nba finals', 'nfl draft', 'soccer', 'golf tournament',
  'olympics', 'athlete', 'championship game', 'mvp award',
  
  // Social Media/Technology Consumer
  'cyberbullying', 'social media trend', 'app update', 'new iphone', 'gadget review',
  'video game', 'gaming console', 'esports', 'twitch streamer'
];

// Finance/weather keywords are rescue-eligible (see note above).
const FINANCE_WEATHER_KEYWORDS = [
  // Finance/Markets (non-strategic)
  'tax shield', 'real estate market', 'stock market', 'cryptocurrency', 'bitcoin',
  'mortgage rate', 'housing market', 'stock price', 'earnings report', 'wall street',
  
  // Weather (non-crisis)
  'weather forecast', 'tropical storm', 'hurricane forecast', 'winter storm warning',
];

// Full exclusion list (union) — preserved for categorizeHeadline()'s unchanged
// reject behavior.
const EXCLUSION_KEYWORDS = [...HARD_EXCLUSION_KEYWORDS, ...FINANCE_WEATHER_KEYWORDS];

// High-priority keywords for CJCS-critical stories (geopolitical, operational, strategic)
// U.S. MILITARY OPERATIONAL INCIDENTS get highest priority (40 points each)
const CRITICAL_PRIORITY_KEYWORDS = [
  'navy loses', 'air force loses', 'marines lose', 'army loses',
  'aircraft crash', 'helicopter crash', 'loses aircraft', 'aircraft lost',
  'uss nimitz', 'uss carrier', 'uss destroyer', 'military accident', 
  'training accident', 'operational incident', 'combat loss', 'casualties'
];

// GEOPOLITICAL/STRATEGIC get standard priority (20 points each)
const HIGH_PRIORITY_KEYWORDS = [
  'cia', 'venezuela', 'warship', 'carrier', 'naval', 'aircraft carrier', 'destroyer',
  'china', 'russia', 'iran', 'north korea', 'taiwan', 'ukraine', 'middle east',
  'nuclear', 'icbm', 'ballistic missile', 'drone strike', 'special operations',
  'coup', 'invasion', 'war crime', 'genocide', 'terrorism', 'al qaeda', 'isis',
  'pentagon', 'joint chiefs', 'secdef', 'commander', 'general', 'admiral',
  'sanctions', 'embargo', 'blockade', 'intervention', 'deployment',
  'classified', 'intelligence report', 'surveillance', 'reconnaissance',
  'false flag', 'covert', 'black ops'
];

// Military-relevant keywords for filtering and categorization
const MILITARY_KEYWORDS = {
  DEFENSE: ['pentagon', 'defense', 'military', 'armed forces', 'weapons', 'navy', 'army', 'air force', 'marines', 'space force', 'troops', 'soldier', 'deployment', 'readiness', 'aircraft carrier', 'warship', 'destroyer', 'submarine', 'fighter jet', 'bomber'],
  CONFLICT: ['war', 'battle', 'combat', 'strike', 'conflict', 'fighting', 'invasion', 'aggression', 'hostilities', 'clash', 'offensive', 'drone strike', 'airstrike', 'bombardment'],
  POLICY: ['congress', 'senate', 'legislation', 'bill', 'budget', 'authorization', 'committee', 'hearing', 'policy', 'strategy', 'doctrine', 'white house', 'secdef', 'joint chiefs'],
  VETERANS: ['veteran', 'va', 'veterans affairs', 'ptsd', 'disability', 'gi bill', 'service member', 'former service'],
  INTEL: ['intelligence', 'cia', 'nsa', 'fbi', 'classified', 'surveillance', 'espionage', 'spy', 'hacking', 'threat', 'covert', 'reconnaissance', 'false flag'],
  GLOBAL: ['nato', 'alliance', 'coalition', 'un', 'united nations', 'china', 'russia', 'iran', 'north korea', 'taiwan', 'ukraine', 'venezuela', 'middle east', 'sanctions', 'treaty', 'summit'],
  DOMESTIC: ['homeland', 'national guard', 'recruitment', 'training', 'base', 'facility', 'contract', 'industry', 'technology']
};

interface ScrapedHeadline {
  title: string;
  url: string;
  category: string;
  source: string;
  articlePublishedAt?: Date | null;
  priorityScore?: number;
  tags?: string[];
}

// Helper function to scrape raw headlines from Drudge Report (without AI selection)
async function scrapeDrudgeReportRaw(): Promise<Array<{title: string; url: string; articlePublishedAt?: Date | null}>> {
  try {
    const response = await fetch('https://www.drudgereport.com/');
    const html = await response.text();
    const $ = cheerio.load(html);
    
    const candidateHeadlines: Array<{title: string; url: string}> = [];
    const seenTitles = new Set<string>();

    // First pass: Collect all potential headlines
    $('a').each((_, element) => {
      const $link = $(element);
      const title = $link.text().trim();
      // Trim the href before any inspection (Task #427). Drudge anchors sometimes
      // carry leading/trailing whitespace in href; an absolute URL with a leading
      // space failed `url.startsWith('http')`, so the drudgereport base was
      // prepended → a space-joined two-URL string that broke parsing downstream
      // and produced an "Unknown Source" curated row.
      const url = $link.attr('href')?.trim();

      // Filter out empty, short, or navigation links
      if (!title || title.length < 20 || !url || url.startsWith('#') || url.startsWith('javascript:')) {
        return;
      }

      // Filter out Removepaywall links
      if (url.toLowerCase().includes('removepaywall')) {
        return;
      }

      // Filter out Daily Beast direct links
      if (url.toLowerCase().includes('thedailybeast.com') || url.toLowerCase().includes('dailybeast.com')) {
        return;
      }

      // One-time block: Specific article titled "Psychiatrist: Why Don's More..."
      if (title.toLowerCase().includes('psychiatrist') && title.toLowerCase().includes("don's more")) {
        return;
      }

      // Filter out publication names and homepage links (not actual articles)
      if (isPublicationName(title, url)) {
        return;
      }

      // Avoid duplicates
      if (seenTitles.has(title)) {
        return;
      }
      seenTitles.add(title);

      candidateHeadlines.push({
        title,
        url: url.startsWith('http') ? url : `https://www.drudgereport.com${url}`,
      });
    });

    console.log(`Found ${candidateHeadlines.length} candidate headlines from Drudge Report`);
    
    // Extract timestamps first to filter by date
    console.log('Extracting article timestamps for date filtering...');
    const headlinesWithTimestamps = await Promise.all(
      candidateHeadlines.map(async (headline) => {
        const timestamp = await extractArticleTimestamp(headline.url);
        return { ...headline, articlePublishedAt: timestamp };
      })
    );
    
    // Filter out Daily Beast articles from archive links
    console.log('Checking archive links for Daily Beast content...');
    const filteredHeadlines = await Promise.all(
      headlinesWithTimestamps.map(async (headline) => {
        const url = headline.url.toLowerCase();
        
        // Check if it's an archive URL
        if (url.includes('archive.ph') || url.includes('archive.is') || url.includes('archive.org')) {
          const archiveSource = await extractSourceFromArchive(headline.url, headline.title);
          if (archiveSource === 'The Daily Beast') {
            console.log(`Filtered out Daily Beast archive article: ${headline.title}`);
            return null;
          }
        }
        
        return headline;
      })
    );
    
    // Remove null entries (filtered Daily Beast articles)
    return filteredHeadlines.filter(h => h !== null) as Array<{title: string; url: string; articlePublishedAt?: Date | null}>;
  } catch (error) {
    console.error('Error scraping Drudge Report:', error);
    return [];
  }
}

export async function scrapeDrudgeReport(): Promise<ScrapedHeadline[]> {
  try {
    // Scrape Drudge Report
    const drudgeHeadlines = await scrapeDrudgeReportRaw();
    
    // RSS feed disabled - uncomment below to re-enable
    // const rssHeadlines = await scrapeRSSFeed();
    
    // Use only Drudge headlines (DataMinr removed from Column 1)
    const allHeadlines = [
      ...drudgeHeadlines,
      // ...rssHeadlines.map(rss => ({
      //   title: rss.title,
      //   url: rss.url,
      //   articlePublishedAt: rss.publishedAt
      // }))
    ];
    
    console.log(`Using ${drudgeHeadlines.length} Drudge headlines (DataMinr removed from Column 1)`);
    
    if (allHeadlines.length === 0) {
      console.log('No headlines found from any source');
      return [];
    }
    
    // Filter to headlines from the past 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentHeadlines = allHeadlines.filter(h => {
      if (h.articlePublishedAt) {
        return h.articlePublishedAt >= twentyFourHoursAgo;
      }
      // If no article timestamp, assume it's recent (just scraped)
      return true;
    });
    
    console.log(`Filtered to ${recentHeadlines.length} headlines from the past 24 hours`);
    
    if (recentHeadlines.length === 0) {
      console.log('No recent headlines found to analyze');
      return [];
    }
    
    // Aggregate counters for filter observability (lightweight COUNTS only —
    // dropped items themselves are never persisted).
    let financeWeatherRescued = 0;
    let financeWeatherDropped = 0;

    // Watch-topic steering (deterministic, default-OFF). Load active Priority/
    // BOLO topics ONCE per scrape pass; used to nudge priority scores and rescue
    // would-be-filtered headlines. Fail-closed: if disabled or the load fails,
    // there is no steering this pass and behavior is unchanged.
    // CURATED-ONLY for now: isMainFeedWatchSteeringEnabled() is hard-false, so
    // this main-feed steering block stays dormant even when the admin flag is on.
    let watchTopics: CompiledWatchTopic[] = [];
    const watchRescueBudget = createRescueBudget();
    if (isMainFeedWatchSteeringEnabled()) {
      try {
        watchTopics = await loadActiveWatchTopics();
      } catch (err) {
        console.error('[WatchTopicMatcher] Failed to load active watch topics (steering skipped this pass):', err);
        watchTopics = [];
      }
    }
    const watchSteeringActive = watchTopics.length > 0;

    // Low-credibility-source items pulled out of the gate and held for review.
    // Unlike dropped finance/weather noise, these ARE persisted (quarantined)
    // AND rerouted into the isolated curated lane as attach-only (curated-only;
    // never into headlines/Classic/Visual). The optional fields carry whatever
    // enrichment the scrape already produced so the curated row is useful.
    const quarantineItems: QuarantineItem[] = [];

    // Strict-CJCS-gate rejects (Task #137). Items the main analyzer scored as
    // having NO strategic tags are dropped from the main feed — but may still
    // have a geopolitical/defense angle for the WIDER curated aperture. We hold
    // them here and route them through the generous curated gate at the end
    // (curated-only; never re-enters headlines/Classic/Visual). Bounded so a
    // noisy scrape can't flood the curated store / clustering payload.
    const MAX_CURATED_REJECTS = 50;
    const curatedRejects: { title: string; url: string; source: string; pubDate?: Date | null }[] = [];

    // PRE-FILTER: Remove entertainment, sports, and other non-military content
    // Also filter blocked media outlets BEFORE AI analysis (saves cost)
    const militaryRelevantHeadlines = recentHeadlines.filter(headline => {
      const lowerTitle = headline.title.toLowerCase();
      
      // Check hard-exclusion keywords (entertainment/sports/medical/consumer
      // tech). These are always dropped — unchanged behavior.
      for (const keyword of HARD_EXCLUSION_KEYWORDS) {
        if (lowerTitle.includes(keyword.toLowerCase())) {
          console.log(`Filtering out non-military story: "${headline.title}" (matched: ${keyword})`);
          return false;
        }
      }
      
      // Check finance/weather keywords (rescue-eligible). If the headline ALSO
      // references a security context, do NOT hard-drop — let it flow into the
      // normal AI relevance/scoring layer, which makes the final call.
      for (const keyword of FINANCE_WEATHER_KEYWORDS) {
        if (lowerTitle.includes(keyword.toLowerCase())) {
          if (hasSecurityContext(headline.title)) {
            financeWeatherRescued++;
            console.log(`Rescued finance/weather story (security context): "${headline.title}" (matched: ${keyword})`);
            break; // keep this headline; stop checking finance/weather keywords
          }
          // BOLO watch rescue: keep finance/weather noise IF it matches an
          // active BOLO topic and the shared rescue budget allows. Hard
          // exclusions ran first; blocked outlets are checked AFTER this, so
          // they still win — a rescue only skips the finance/weather drop.
          if (watchSteeringActive) {
            const wm = matchWatchTopics(watchTopics, headline.title);
            if (wm.boloTopicIds.length && watchRescueBudget.consume(wm.boloTopicIds)) {
              financeWeatherRescued++;
              console.log(`[WatchTopicMatcher] BOLO rescue (finance/weather): "${headline.title.substring(0, 80)}"`);
              break; // keep; remaining checks (blocked outlets) still apply
            }
          }
          financeWeatherDropped++;
          console.log(`Filtering out finance/weather noise: "${headline.title}" (matched: ${keyword})`);
          return false;
        }
      }
      
      // FILTER: Exclude blocked media outlets (before AI analysis)
      try {
        const urlObj = new URL(headline.url);
        const hostname = urlObj.hostname.replace('www.', '').toLowerCase();
        
        // Check against exact blocked domains
        const isBlockedOutlet = BLOCKED_MEDIA_OUTLET_DOMAINS.some((domain: string) => 
          hostname === domain || hostname.endsWith(`.${domain}`)
        );
        
        if (isBlockedOutlet) {
          console.log(`Filtering out blocked media outlet by URL: "${hostname}" for headline: "${headline.title.substring(0, 80)}..."`);
          return false;
        }
      } catch {
        // If URL parsing fails, allow the headline through (will be caught later if needed)
      }
      
      return true;
    });
    
    console.log(`After pre-filtering: ${militaryRelevantHeadlines.length} military-relevant headlines (removed ${recentHeadlines.length - militaryRelevantHeadlines.length} entertainment/sports/non-military stories)`);
    
    if (militaryRelevantHeadlines.length === 0) {
      console.log('No military-relevant headlines found after filtering');
      await persistFilterAudit(quarantineItems, financeWeatherRescued, financeWeatherDropped);
      return [];
    }
    
    // FIRST: Identify and save any Chairman Caine mentions
    const caineKeywords = [
      'gen caine', 'general caine', 'chairman caine', 'gen. caine', 
      'cjcs caine', 'dan caine', 'hegseth, caine', 'and caine', ' caine'
    ];
    const caineHeadlines: ScrapedHeadline[] = [];
    
    console.log(`Checking ${militaryRelevantHeadlines.length} headlines for Chairman Caine mentions...`);
    
    for (const headline of militaryRelevantHeadlines) {
      const lowerTitle = headline.title.toLowerCase();
      
      // Exclude false positives like "cocaine"
      if (lowerTitle.includes('cocaine')) {
        continue;
      }
      
      const mentionsCaine = caineKeywords.some(keyword => lowerTitle.includes(keyword));
      
      if (mentionsCaine) {
        console.log(`✓ Found Chairman Caine mention: "${headline.title}"`);
        
        const source = extractSource(headline.url, headline.title);
        
        // FILTER: Exclude non-credible sources and blocked outlets
        // Remove (DM) suffix for comparison
        const sourceWithoutSuffix = source.replace(' (DM)', '').toLowerCase();
        
        const nonCredibleSources = [
          'blog photo', 'blog video', 'blog', 'blogger',
          'social media user', 'user photo', 'user video',
          'reporter photo', 'reporter video', 'local source',
          'x', 'public telegram', 'facebook', 'instagram'
        ];
        
        const isNonCredible = nonCredibleSources.some(nc => sourceWithoutSuffix.includes(nc));
        const isBlockedOutlet = BLOCKED_MEDIA_OUTLET_NAMES.some((blocked: string) => sourceWithoutSuffix.includes(blocked));
        
        if (isNonCredible) {
          console.log(`Quarantining Chairman Caine mention from non-credible source: "${source}"`);
          quarantineItems.push({
            title: headline.title,
            url: headline.url,
            source,
            reason: `held from main feed (low-cred source): ${source}`,
            category: 'MIL LEADERS',
            priorityScore: 50,
            articlePublishedAt: headline.articlePublishedAt ?? null,
          });
          continue; // Held from main feed; rerouted to curated lane (attach-only)
        }
        
        if (isBlockedOutlet) {
          console.log(`Filtering out Chairman Caine mention from blocked media outlet: "${source}"`);
          continue; // Skip this headline
        }
        
        caineHeadlines.push({
          title: headline.title,
          url: headline.url,
          category: 'MIL LEADERS',
          source,
          priorityScore: 50, // Medium-high priority
          articlePublishedAt: headline.articlePublishedAt,
          tags: ['MIL LEADERS'],
        });
      }
    }
    
    if (caineHeadlines.length > 0) {
      console.log(`Identified ${caineHeadlines.length} Chairman Caine mention(s) for MIL LEADERS category`);
    } else {
      console.log('No Chairman Caine mentions found in this batch');
    }
    
    // Use AI to analyze ALL headlines and assign strategic tags
    console.log('Analyzing all headlines with AI to assign strategic tags and priority scores...');
    const analyses = await analyzeBatchHeadlines(
      militaryRelevantHeadlines.map(h => h.title),
      { failOpenUnscored: true },
    );
    
    // Map ALL AI-analyzed headlines back to our candidate list with timestamps
    const headlines: ScrapedHeadline[] = [];
    for (const analysis of analyses) {
      // Find the matching headline from our military-relevant headlines list
      const matchingHeadline = militaryRelevantHeadlines.find(h => 
        h.title === analysis.title || h.title.includes(analysis.title) || analysis.title.includes(h.title)
      );
      
      if (!matchingHeadline) {
        console.warn(`Could not find matching headline for: ${analysis.title}`);
        continue;
      }
      
      // Use AI-assigned priority score (1-100 scale based on strategic importance).
      // resolveAiScore distinguishes a real 0 (→ floor) from a missing score
      // (→ default 50) instead of the old `|| 50` collapse (Task #444, Step 2).
      let priorityScore = resolveAiScore(analysis.priority_score, 50);

      // NOTE: statecraft/escalation prioritization is now handled by the shared
      // ANALYZER rubric (relevanceDefinition.ts) — its HIGH band explicitly
      // scores deal/negotiation + force, adversary attacks on a U.S. ally, and
      // strategic-chokepoint + force stories at 70+. Because every content path
      // (scraper, news bots, RSS, manual/team) scores through that same rubric,
      // the prioritization applies uniformly with no per-path deterministic floor.

      // DOWNGRADE: cap NOAA-related articles so a weather-agency item can't claim
      // a top main-feed slot. Now flows through the shared, auditable main-lane
      // rules table (Task #444, Step 3) instead of an inline Math.min.
      const mainCap = evalMainScoreCaps(matchingHeadline.title, priorityScore);
      if (mainCap.reason) {
        console.log(
          `[SCORE:CAP] lane=main rule=${mainCap.reason} ${priorityScore}->${mainCap.score} :: "${matchingHeadline.title.substring(0, 80)}..."`,
        );
        priorityScore = mainCap.score;
      }

      // Watch-topic steering: match ONCE per headline, then apply the moderate
      // Priority-watch boost. The same match drives the BOLO no-tags rescue
      // below. This sets a NEW row's base score only — it never touches a human
      // priority override.
      const watchMatch: WatchMatch | null = watchSteeringActive
        ? matchWatchTopics(watchTopics, matchingHeadline.title)
        : null;
      if (watchMatch?.priorityTopicIds.length) {
        const boosted = applyPriorityBoost(priorityScore);
        if (boosted !== priorityScore) {
          console.log(`[WatchTopicMatcher] Priority boost ${priorityScore}->${boosted}: "${matchingHeadline.title.substring(0, 80)}"`);
          priorityScore = boosted;
        }
      }

      // FILTER: Only include headlines that have at least one tag
      // This removes truly irrelevant stories (coffee, sports, entertainment)
      // But allows domestic politics stories with low priority scores
      let effectiveTags = analysis.tags;
      if (effectiveTags.length === 0) {
        // BOLO watch rescue: keep a no-strategic-tag headline in the MAIN feed
        // if it matches an active BOLO topic and the shared budget allows.
        // Otherwise fall back to the existing curated-reject routing.
        if (watchMatch?.boloTopicIds.length && watchRescueBudget.consume(watchMatch.boloTopicIds)) {
          effectiveTags = ['Watch'];
          console.log(`[WatchTopicMatcher] BOLO rescue (no strategic tags): "${matchingHeadline.title.substring(0, 80)}"`);
        } else {
          // Held from the main feed (no strategic tags), but route to the wider
          // curated aperture — it may still carry a geopolitical/defense angle.
          // Task #427: only route a reject with a single well-formed URL whose
          // source actually resolves. A malformed URL (e.g. two URLs joined by a
          // space) or one whose source falls back to "Unknown Source" is dropped
          // here rather than stored as an unattributed junk curated row.
          //
          // Task #444, Step 1: emit a structured per-drop [FUNNEL:PREFILTER] line
          // so the early relevance gate is auditable — every tag-presence drop is
          // visible, and the reject-reroute pre-check losses (cap reached, malformed
          // URL, unknown source) are distinguishable from a clean curated reroute.
          const titleSnippet = (matchingHeadline.title || '').substring(0, 80);
          if (curatedRejects.length < MAX_CURATED_REJECTS) {
            const rejectUrl = (matchingHeadline.url ?? '').trim();
            const rejectSource = extractSource(rejectUrl, matchingHeadline.title);
            if (isSingleWellFormedHttpUrl(rejectUrl) && rejectSource !== 'Unknown Source') {
              curatedRejects.push({
                title: matchingHeadline.title,
                url: rejectUrl,
                source: rejectSource,
                pubDate: matchingHeadline.articlePublishedAt ?? null,
              });
              console.log(`[FUNNEL:PREFILTER] drop=no-tags disposition=rerouted-curated :: "${titleSnippet}"`);
            } else {
              const lossReason = !isSingleWellFormedHttpUrl(rejectUrl) ? 'malformed-url' : 'unknown-source';
              console.log(`[FUNNEL:PREFILTER] drop=no-tags disposition=dropped reason=${lossReason} :: "${titleSnippet}"`);
            }
          } else {
            console.log(`[FUNNEL:PREFILTER] drop=no-tags disposition=dropped reason=reject-cap-reached :: "${titleSnippet}"`);
          }
          continue; // Skip headlines with no tags at all
        }
      }
      
      // Determine category from tags
      const category = determineCategory(effectiveTags);
      
      // Extract source from URL (pass title for DataMinr source extraction)
      const source = extractSource(matchingHeadline.url, matchingHeadline.title);
      
      // FILTER: Exclude non-credible sources (blogs, social media users, etc.)
      // Remove (DM) suffix for comparison
      const sourceWithoutSuffix = source.replace(' (DM)', '').toLowerCase();
      
      const nonCredibleSources = [
        'blog photo',
        'blog video',
        'blog',
        'blogger',
        'social media user',
        'user photo',
        'user video',
        'reporter photo',
        'reporter video',
        'local source',
        'x', // X/Twitter posts
        'public telegram',
        'facebook',
        'instagram'
      ];
      
      const isNonCredible = nonCredibleSources.some(nc => sourceWithoutSuffix.includes(nc));
      
      if (isNonCredible) {
        console.log(`Quarantining non-credible source: "${source}" for headline: "${matchingHeadline.title.substring(0, 80)}..."`);
        quarantineItems.push({
          title: matchingHeadline.title,
          url: matchingHeadline.url,
          source,
          reason: `held from main feed (low-cred source): ${source}`,
          category,
          priorityScore,
          tags: effectiveTags || [],
          articlePublishedAt: matchingHeadline.articlePublishedAt,
        });
        continue; // Held from main feed; rerouted to curated lane (attach-only)
      }
      
      // NOTE: Blocked media outlets are now filtered BEFORE AI analysis in the militaryRelevantHeadlines section
      // This saves AI costs by not analyzing headlines from blocked outlets
      
      headlines.push({
        title: matchingHeadline.title,
        url: matchingHeadline.url,
        category,
        source,
        priorityScore,
        articlePublishedAt: matchingHeadline.articlePublishedAt,
        tags: effectiveTags || [],
      });
    }

    console.log(`AI analyzed and tagged ${headlines.length} headlines from past 24 hours`);
    
    // Combine Chairman Caine mentions with AI-selected headlines
    // Use a Map to deduplicate (in case AI also selected a Caine mention)
    const headlineMap = new Map<string, ScrapedHeadline>();
    
    // Add Caine headlines first
    for (const headline of caineHeadlines) {
      headlineMap.set(headline.title, headline);
    }
    
    // Add AI-selected headlines (won't overwrite Caine headlines if duplicates)
    for (const headline of headlines) {
      if (!headlineMap.has(headline.title)) {
        headlineMap.set(headline.title, headline);
      }
    }
    
    const finalHeadlines = Array.from(headlineMap.values());
    
    if (caineHeadlines.length > 0) {
      console.log(`Returning ${finalHeadlines.length} total headlines: ${caineHeadlines.length} MIL LEADERS mentions + ${headlines.length} AI-analyzed`);
    }

    // Persist quarantined low-credibility items + lightweight filter metrics.
    await persistFilterAudit(quarantineItems, financeWeatherRescued, financeWeatherDropped);

    // Route strict-gate rejects into the WIDER, isolated curated aperture
    // (Task #137). Defensive: a curated-lane failure must never break the main
    // scrape. Curated-only — admitCuratedCandidates writes only to curated_items.
    if (curatedRejects.length > 0) {
      try {
        const { admitCuratedCandidates } = await import('./curatedIngest');
        const r = await admitCuratedCandidates(curatedRejects, { mode: 'gate', label: 'drudge-rejects' });
        console.log(`[Scraper] Curated reject capture: ${r.ingested} admitted, ${r.skipped} skipped (of ${curatedRejects.length})`);
      } catch (err) {
        console.error('[Scraper] Curated reject capture failed (non-fatal):', err);
      }
    }
    
    return finalHeadlines;
  } catch (error) {
    console.error('Error scraping Drudge Report:', error);
    return [];
  }
}

// Persist quarantined low-credibility-source items (de-duplicated) and bump the
// lightweight aggregate filter-behavior counters. Failures here must never break
// a scrape, so everything is wrapped defensively.
async function persistFilterAudit(
  quarantineItems: QuarantineItem[],
  financeWeatherRescued: number,
  financeWeatherDropped: number,
): Promise<void> {
  let quarantinedNew = 0;
  for (const item of quarantineItems) {
    try {
      const added = await storage.addQuarantinedHeadline({
        title: item.title,
        url: item.url,
        source: item.source,
        reason: item.reason,
        normalizedTitle: normalizeTitle(item.title),
      });
      if (added) quarantinedNew++;
    } catch (err) {
      console.error('Failed to persist quarantined headline:', err);
    }

    // Reroute low-cred items into the ISOLATED curated lane as attach-only.
    // Curated-only: this never touches headlines/Classic/Visual/public-API.
    // attach-only items can JOIN a curated story for contrast but never seed
    // one. Conflicts on url are ignored (idempotent across scrape cycles).
    try {
      const curatedInsert: InsertCuratedItem = {
        title: item.title,
        url: item.url,
        source: item.source,
        category: item.category ?? 'general',
        priorityScore: item.priorityScore ?? 0,
        ogImageUrl: item.ogImageUrl ?? null,
        articlePublishedAt: item.articlePublishedAt ?? null,
        tags: item.tags ?? [],
        role: 'attach-only',
      };
      await storage.addCuratedItem(curatedInsert, normalizeTitle(item.title));
    } catch (err) {
      console.error('Failed to reroute low-cred item into curated lane:', err);
    }
  }

  if (financeWeatherRescued > 0 || financeWeatherDropped > 0 || quarantinedNew > 0) {
    try {
      await storage.incrementFilterMetrics({
        financeWeatherRescued,
        financeWeatherDropped,
        quarantined: quarantinedNew,
      });
    } catch (err) {
      console.error('Failed to update filter metrics:', err);
    }
  }
}

function isPublicationName(title: string, url: string): boolean {
  // Check if URL is just a homepage (no article path)
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    // Homepage if path is just "/" or empty
    if (path === '/' || path === '') {
      return true;
    }
  } catch {
    // Invalid URL, let it through for now
  }

  // Check if title looks like a publication name (short, mostly caps, no verbs)
  const words = title.split(' ').filter(w => w.length > 0);
  
  // Headlines often contain action verbs - if present, it's NOT a publication name
  const headlineVerbs = [
    'ORDERS', 'SAYS', 'REVEALS', 'ANNOUNCES', 'CLAIMS', 'WARNS', 'REPORTS', 
    'CONFIRMS', 'DENIES', 'ADMITS', 'DECLARES', 'URGES', 'DEMANDS', 'THREATENS',
    'LAUNCHES', 'ATTACKS', 'STRIKES', 'VOWS', 'PROMISES', 'PLANS', 'TESTS',
    'LOSES', 'WINS', 'SEEKS', 'FACES', 'READIES', 'PREPARES', 'DIRECTS'
  ];
  const upperTitle = title.toUpperCase();
  for (const verb of headlineVerbs) {
    if (upperTitle.includes(verb)) {
      return false; // Contains action verb = headline, not publication name
    }
  }
  
  // Publication names are usually 1-3 words (NYT, BBC, WASHINGTON POST), not 4
  if (words.length <= 3) {
    const allCapsWords = words.filter(w => w === w.toUpperCase() && w.length > 2);
    if (allCapsWords.length === words.length) {
      // All caps, likely a publication name
      return true;
    }
  }

  // Common publication name patterns
  const publicationPatterns = [
    /^[A-Z\s]+DAILY$/i,
    /^[A-Z\s]+TIMES$/i,
    /^[A-Z\s]+POST$/i,
    /^[A-Z\s]+JOURNAL$/i,
    /^[A-Z\s]+NEWS$/i,
    /TRACKER$/i,  // "TRUMP APPROVAL TRACKER"
  ];

  for (const pattern of publicationPatterns) {
    if (pattern.test(title)) {
      return true;
    }
  }

  return false;
}

function categorizeHeadline(title: string): { category: string; priorityScore: number } | null {
  const lowerTitle = title.toLowerCase();
  
  // FIRST: Check exclusion keywords - reject if medical/entertainment/personal
  for (const keyword of EXCLUSION_KEYWORDS) {
    if (lowerTitle.includes(keyword.toLowerCase())) {
      return null; // Excluded - not relevant to CJCS
    }
  }
  
  // SECOND: Calculate priority score (0-100)
  let priorityScore = 0;
  
  // Check for CRITICAL operational incidents first (40 points each)
  for (const keyword of CRITICAL_PRIORITY_KEYWORDS) {
    if (lowerTitle.includes(keyword.toLowerCase())) {
      priorityScore += 40; // Critical incidents get +40 points each
    }
  }
  
  // Then check for geopolitical/strategic keywords (20 points each)
  for (const keyword of HIGH_PRIORITY_KEYWORDS) {
    if (lowerTitle.includes(keyword.toLowerCase())) {
      priorityScore += 20; // High-priority keywords get +20 points each
    }
  }
  
  // Cap priority score at 100
  priorityScore = Math.min(priorityScore, 100);
  
  // THIRD: Check each category for keyword matches
  for (const [category, keywords] of Object.entries(MILITARY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerTitle.includes(keyword.toLowerCase())) {
        return { category, priorityScore };
      }
    }
  }
  
  return null; // Not military-relevant
}

function extractDataMinrSource(headline: string): string {
  // DataMinr headlines follow pattern: "Headline text: Source via Platform."
  // Example: "Russian presidential spokesperson...: Major News Outlet via Reuters."
  // We want to extract the actual outlet after "via" and add "(DM)" suffix
  
  const parts = headline.split(':');
  if (parts.length >= 2) {
    // Get everything after the last colon
    const sourcePart = parts[parts.length - 1].trim();
    
    // Remove trailing period if present
    const cleanSource = sourcePart.replace(/\.$/, '');
    
    // If it contains "via", extract the part AFTER "via" as the actual outlet
    if (cleanSource.includes(' via ')) {
      const viaIndex = cleanSource.indexOf(' via ');
      const actualOutlet = cleanSource.substring(viaIndex + 5).trim(); // +5 to skip " via "
      
      // Add (DM) suffix to indicate DataMinr source
      return `${actualOutlet} (DM)`;
    }
    
    // If no "via" found, return the source part with (DM) suffix
    return `${cleanSource} (DM)`;
  }
  
  return 'DataMinr';
}

interface ArchiveExtraction {
  sourceName: string | null;
  ogImage: string | null;
  originalDomain: string | null;
}

async function extractSourceFromArchive(archiveUrl: string, headlineTitle?: string): Promise<string | null> {
  const result = await extractArchiveData(archiveUrl, headlineTitle);
  return result.sourceName;
}

export async function extractArchiveData(archiveUrl: string, headlineTitle?: string): Promise<ArchiveExtraction> {
  // First try simple fetch
  let html: string | null = null;
  
  try {
    const response = await fetch(archiveUrl, {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const text = await response.text();
    // Check if we got actual article content (not a challenge page)
    if (text.includes('og:image') || text.includes('SHARE_LONGLINK') || text.includes('og:url')) {
      html = text;
    }
  } catch {}
  
  if (html) {
    return parseArchiveHtml(html);
  }
  
  // archive.is blocks server requests — use AI to identify the original publisher,
  // then fetch the og:image directly from the publisher's site
  console.log(`[ArchiveExtractor] archive.is blocked, using AI to find original source for: "${headlineTitle?.substring(0, 60)}..."`);
  return await findOriginalSourceViaAI(headlineTitle || '');
}

async function findOriginalSourceViaAI(headlineTitle: string): Promise<ArchiveExtraction> {
  if (!headlineTitle || !isAIConfigured()) {
    return { sourceName: null, ogImage: null, originalDomain: null };
  }
  
  try {
    const completion = await withAiTimeout(openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: 'You are a news source identifier. Given a headline, identify the most likely original publisher. Respond with ONLY a JSON object: {"domain": "example.com", "name": "Publisher Name"}. Common publishers: bloomberg.com, wsj.com, nytimes.com, washingtonpost.com, reuters.com, apnews.com, politico.com, cnn.com, foxnews.com, thehill.com, ft.com, economist.com, bbc.com, theguardian.com, nbcnews.com, cbsnews.com, abcnews.go.com. If uncertain, respond {"domain": null, "name": null}.'
        },
        {
          role: 'user',
          content: `Headline: "${headlineTitle}"`
        }
      ],
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'findOriginalSourceViaAI');
    
    const response = completion.choices[0]?.message?.content?.trim();
    if (!response) return { sourceName: null, ogImage: null, originalDomain: null };
    
    const parsed = JSON.parse(response);
    if (!parsed.domain) return { sourceName: null, ogImage: null, originalDomain: null };
    
    console.log(`[ArchiveExtractor] AI identified source: ${parsed.name} (${parsed.domain})`);
    
    // Try to fetch og:image directly from the publisher's homepage or article
    let ogImage: string | null = null;
    
    try {
      // Try fetching the publisher's homepage for a default og:image
      const homepageResponse = await fetch(`https://www.${parsed.domain}`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        redirect: 'follow',
      });
      
      if (homepageResponse.ok) {
        const homepageHtml = await homepageResponse.text();
        const ogMatch = homepageHtml.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
          || homepageHtml.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
        
        if (ogMatch && ogMatch[1]) {
          ogImage = ogMatch[1];
          console.log(`[ArchiveExtractor] Found publisher og:image: ${ogImage.substring(0, 80)}`);
        }
      }
    } catch {}
    
    return {
      sourceName: parsed.name || null,
      ogImage,
      originalDomain: parsed.domain,
    };
  } catch (e) {
    console.log(`[ArchiveExtractor] AI source identification failed: ${e}`);
    return { sourceName: null, ogImage: null, originalDomain: null };
  }
}

function parseArchiveHtml(html: string): ArchiveExtraction {
  let sourceName: string | null = null;
  let ogImage: string | null = null;
  let originalDomain: string | null = null;
  
  // Check for Daily Beast
  const dailyBeastPatterns = ['thedailybeast.com', 'dailybeast.com', 'daily beast', 'The Daily Beast', 'DAILY BEAST'];
  const htmlLower = html.toLowerCase();
  for (const pattern of dailyBeastPatterns) {
    if (htmlLower.includes(pattern.toLowerCase())) {
      sourceName = 'The Daily Beast';
      break;
    }
  }
  
  // Extract og:image from the archived page
  const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (ogImageMatch && ogImageMatch[1]) {
    ogImage = ogImageMatch[1];
  }
  
  // Also try twitter:image if no og:image
  if (!ogImage) {
    const twitterImageMatch = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);
    if (twitterImageMatch && twitterImageMatch[1]) {
      ogImage = twitterImageMatch[1];
    }
  }
  
  // Try to find large article images if no meta images found
  if (!ogImage) {
    const largeImageMatch = html.match(/<img[^>]*src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["'][^>]*(?:width=["']\d{3,}|class=["'][^"']*(?:hero|featured|lead|main|article|lede)[^"']*)/i);
    if (largeImageMatch && largeImageMatch[1]) {
      ogImage = largeImageMatch[1];
    }
  }
  
  // Extract original source domain from the archive page
  const originalUrlMatch = html.match(/id=["']?SHARE_LONGLINK["']?[^>]*value=["']([^"']+)["']/i)
    || html.match(/<input[^>]*id=["']?SHARE_LONGLINK["']?[^>]*value=["']([^"']+)["']/i)
    || html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:url["']/i);
  
  if (originalUrlMatch && originalUrlMatch[1]) {
    try {
      const origUrl = new URL(originalUrlMatch[1]);
      if (!origUrl.hostname.includes('archive.')) {
        originalDomain = origUrl.hostname;
      }
    } catch {}
  }
  
  // Fallback: search for known news domains in the HTML
  if (!originalDomain) {
    const domainMatch = html.match(/https?:\/\/((?:www\.)?(?:wsj|nytimes|washingtonpost|cnn|foxnews|reuters|apnews|bbc|politico|thehill|nbcnews|cbsnews|abcnews|military|defensenews|theguardian|bloomberg|ft|economist|stripes)\.(?:com|co\.uk|org))/i);
    if (domainMatch && domainMatch[1]) {
      originalDomain = domainMatch[1];
    }
  }
  
  return { sourceName, ogImage, originalDomain };
}

function extractSource(url: string, title?: string): string {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace('www.', '');
    
    // If it's a DataMinr URL and we have a title, extract the actual source from the headline
    if ((hostname === 'r.dataminr.com' || hostname === 'dataminr.com') && title) {
      return extractDataMinrSource(title);
    }
    
    // Map common domains to readable source names
    const sourceMap: Record<string, string> = {
      'r.dataminr.com': 'DataMinr',
      'dataminr.com': 'DataMinr',
      'wsj.com': 'The Wall Street Journal',
      'nytimes.com': 'The New York Times',
      'washingtonpost.com': 'The Washington Post',
      'cnn.com': 'CNN',
      'foxnews.com': 'Fox News',
      'reuters.com': 'Reuters',
      'apnews.com': 'Associated Press',
      'bbc.com': 'BBC News',
      'bbc.co.uk': 'BBC News',
      'politico.com': 'Politico',
      'thehill.com': 'The Hill',
      'military.com': 'Military.com',
      'stripes.com': 'Stars and Stripes',
      'defensenews.com': 'Defense News',
      'defense.gov': 'Department of Defense',
      'pentagon.gov': 'Pentagon',
      'aljazeera.com': 'Al Jazeera',
      'bloomberg.com': 'Bloomberg',
      'theguardian.com': 'The Guardian',
      // Blocked media outlets (mapped for proper identification)
      'thesun.co.uk': 'The Sun',
      'the-sun.com': 'The Sun',
      'sun.co.uk': 'The Sun',
      'breitbart.com': 'Breitbart News',
      'infowars.com': 'Infowars',
      'thegatewaypundit.com': 'The Gateway Pundit',
      'nationalenquirer.com': 'National Enquirer',
      'wnd.com': 'WND',
      'worldnetdaily.com': 'WND'
    };

    return sourceMap[hostname] || capitalize(hostname.split('.')[0]);
  } catch {
    return 'Unknown Source';
  }
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function calculatePriorityFromTags(tags: string[]): number {
  // Priority scoring based on strategic importance
  const HIGH_PRIORITY_TAGS = [
    'PRC/Indo-Pacific', 'RUS/UKR', 'Israel/Gaza', 'Iran/M. East Stability', 'North Korea',
    'Nuclear Posture', 'Force Readiness', 'Budget/NDAA', 'Cyber Security',
    'Troop Deployments', 'Cartel Operations', 'Border Security Ops', 'Counterterrorism'
  ];
  
  const MEDIUM_PRIORITY_TAGS = [
    'NATO/Allies', 'Recruitment/Retention', 'AI/Emerging Tech', 'Space Domain',
    'Critical Infrastructure', 'Legislative Policy'
  ];
  
  const LOW_PRIORITY_TAGS = [
    'Trump Administration', 'Congressional Actions', 'Domestic Politics', 
    'Elections/Campaigns', 'Supreme Court'
  ];
  
  let score = 0;
  
  for (const tag of tags) {
    if (HIGH_PRIORITY_TAGS.includes(tag)) {
      score += 40; // Critical geopolitical, defense capability, and operational issues
    } else if (MEDIUM_PRIORITY_TAGS.includes(tag)) {
      score += 20; // Important but not immediately critical
    } else if (LOW_PRIORITY_TAGS.includes(tag)) {
      score += 5; // Domestic politics - situational awareness only
    } else {
      score += 10; // Standard relevance
    }
  }
  
  // Cap at 100
  return Math.min(score, 100);
}

function determineCategory(tags: string[]): string {
  // Map tags to categories
  const GEOPOLITICAL_TAGS = ['PRC/Indo-Pacific', 'RUS/UKR', 'Israel/Gaza', 'Iran/M. East Stability', 'North Korea', 'NATO/Allies'];
  const DEFENSE_TAGS = ['Force Readiness', 'Recruitment/Retention', 'Budget/NDAA', 'Nuclear Posture', 'Sustainment/Logistics'];
  const TECH_TAGS = ['AI/Emerging Tech', 'Cyber Security', 'Space Domain', 'JADC2/Integration', 'Hypersonic'];
  const DOMESTIC_TAGS = ['Nat Guard Domestic', 'Critical Infrastructure', 'Legislative Policy', 'Global Economy', 'Climate/Disaster', 'Public Health/Pandemic'];
  
  for (const tag of tags) {
    if (GEOPOLITICAL_TAGS.includes(tag)) return 'GLOBAL';
    if (DEFENSE_TAGS.includes(tag)) return 'DEFENSE';
    if (TECH_TAGS.includes(tag)) return 'INTEL';
    if (DOMESTIC_TAGS.includes(tag)) return 'DOMESTIC';
  }
  
  return 'POLICY'; // Default category
}

// Generate a simple summary from the headline (placeholder - in production you might use an LLM)
export function generateSummary(title: string): string {
  // For now, just return a contextual summary based on category keywords
  const lowerTitle = title.toLowerCase();
  
  if (lowerTitle.includes('announce')) {
    return 'Official announcement regarding military operations or policy changes.';
  } else if (lowerTitle.includes('report') || lowerTitle.includes('intelligence')) {
    return 'Intelligence briefing or analytical report on defense matters.';
  } else if (lowerTitle.includes('nato') || lowerTitle.includes('alliance')) {
    return 'International coalition coordination and strategic partnership updates.';
  } else if (lowerTitle.includes('veteran')) {
    return 'Veterans affairs, benefits, and support services information.';
  } else if (lowerTitle.includes('congress') || lowerTitle.includes('senate')) {
    return 'Legislative developments affecting defense policy and military funding.';
  } else if (lowerTitle.includes('cyber') || lowerTitle.includes('hack')) {
    return 'Cybersecurity threats and digital defense capabilities.';
  } else if (lowerTitle.includes('conflict') || lowerTitle.includes('war')) {
    return 'Regional conflict updates and military engagement developments.';
  } else {
    return 'Strategic military development with operational implications.';
  }
}
