import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage, calculateDepreciatedPriority, calculateCuratedDepreciatedPriority, getCuratedEffectiveAgeAnchor } from "./storage";
import { getScoringRelevanceOverview, MAIN_FEED_PROMOTION_THRESHOLD, UNSCORED_BOT_PRIORITY } from "./relevanceDefinition";
import { getStrategicContextSnapshot } from "./strategicContext";
import { FLASH_PRIORITY_THRESHOLD } from "./subjectMatcher";
import { CURATED_SOFT_CAP, CURATED_ANALYSIS_OPINION_CAP } from "./scoreAdjustments";
import { scrapeDrudgeReport, generateSummary, extractArchiveData } from "./scraper";
import { scrapeAllTruthSocial, updateRelayHeartbeat, isRelayHealthy, getRelayHeartbeat, filterTruthSocialPostImage } from "./truthSocialService";
import { updateXRelayHeartbeat, getXRelayHeartbeat, isXRelayHealthy, normalizeXRelayPost, routeXRelayPost, extractXRelayPosts } from "./xRelayService";
import { processPostImages } from './imageTextExtractor';
import { sendPOTUSAlert } from './twilioService';
import { isGenericCategory } from './curatedClassify';
import {
  registerCuratedCacheInvalidator,
  bumpCuratedRevision,
  getCuratedRevision,
  registerCuratedTopStoriesPrewarmer,
} from './curatedCacheBus';
import { createFeedCoalescer } from './feedCoalesce';
import { CURATED_FEEDS } from './curatedFeeds';
import { CURATED_WEB_SOURCES } from './curatedWebScraper';
import { CURATED_OFFHOST_SOURCES } from './curatedOffHostBot';
import { computePipelineHealth, summarizePipeline, indeterminatePipeline } from './pipelineHealth';
import { getTruthRelayOutageReport } from './relayOutageMonitor';
import { wouldMatch } from './enrichment/referenceAdapter';
import { computeMeltwaterHealthMulti } from './meltwaterHealth';
import { getFeedHealthReport } from './feedHealthTracker';
import { buildOutletIngestionHealth } from './outletIngestionHealth';
import { updateXPosts } from "./xScraper";
import { updateRapidResponsePosts } from "./rapidResponseScraper";
import { updateDOWResponsePosts } from "./dowResponseScraper";
import { INFLUENCER_X_HANDLES, INFLUENCER_X_ACCOUNTS } from "@shared/influencerXAccounts";
import {
  CATALOG_CURATED_US_OSINT_ACCOUNTS,
  CATALOG_CURATED_OSINT_ACCOUNTS,
  CATALOG_CURATED_JOURNALIST_ACCOUNTS,
  CATALOG_GENERAL_X_ACCOUNTS,
  CATALOG_RAPIDRESPONSE_HANDLES,
  CATALOG_DOWRESPONSE_HANDLES,
  CATALOG_SENTDEFENDER_HANDLES,
  isApprovedCuratedAttachmentAccount,
} from "@shared/socialAccountCatalog";
import { isEffectivelyReportedArticle, isRoundupDigestTitle, hasTitleInterrogativeSignal, isOpinionUrl, type StoredContentKind } from "@shared/contentKind";
import { unwrapSafeLink } from "@shared/safeLink";
import { deriveSourceKind, coercePrimaryTopic, coerceConflictTrack, deriveScope, inferConflictTrack, isOpinionGenreCategory } from "@shared/classificationVocab";
import { yieldToEventLoop, CURATED_YIELD_CHUNK } from "./eventLoop";
import { curatedEditorialOutcomeQueue } from "./curatedEditorialOutcomeQueue";

/** Normalise a human-supplied country or region label (Task #1027, Step 7):
 *  collapse consecutive whitespace, trim, and return null for blank strings so
 *  the DB column never stores an all-whitespace value. Title-cases nothing —
 *  values come from a controlled-vocabulary dropdown in the UI so capitalisation
 *  is already correct; this just handles copy-paste leading/trailing spaces. */
function normalizeCountryLabel(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t || null;
}
import { updateFirstAlerts } from "./firstAlertScraper";
import { analyzeBatchHeadlines } from "./aiAnalyzer";
import { insertHeadlineSchema, insertManualSubmissionSchema, insertTeamChatMessageSchema, insertCuratedViewFeedbackSchema, headlines, manualSubmissions, headlineClusters, teamSubjects, teamSubmissions, dailyNewsScrubs, smsAlertSubscribers, smsQueue, type InsertTruthSocialPost, type TruthSocialPost, type CuratedOverrideEvent } from "@shared/schema";
import {
  isConfirmedCuratedMember,
  significantTitleTokens,
  significantCandidateTokens,
  isCuratedClusteringRunning as isCuratedClusteringRunningSync,
  MANUAL_MERGE_SYNTHESIS_MAX_MS as MANUAL_MERGE_SYNTHESIS_MAX_MS_ROUTES,
  requestCuratedClusteringYield,
  schedulePendingManualReshape,
} from "./curatedCluster";
import { pickDominantAngleMember } from "./curatedDominantAngle";
import { buildAttachClusters, classifyAttachCandidate, isAdversaryNewsContrast, type AttachRecommendation } from "./curatedIncrementalAttach";
import { computeClusterPriorityScore, freshestRankingMemberAt } from "./curatedClusterScore";
import { isEligibleCuratedStoryImageCandidate, selectCuratedStoryImages } from "./curatedStoryImages";
import { isAttachmentOnlySocialContent } from "./socialPostText";
import { buildOutletIndex, findOutlet, deriveOutletBehavior, deriveBehavior, normalizeOutletName, extractOutletDomain, SOURCE_IDENTIFIERS, OTHER_SOURCE_TYPES, OWNERSHIP_CATEGORIES, ADVERSARY_COUNTRIES, isSocialFlashOutlet } from "@shared/outletRegistry";
import { buildCuratedOnlyOutletIds } from "./curatedOnlyOutlets";
import { isFaviconUrl, triggerCuratedRadarEnrichment, getCuratedEnrichmentLifecycle, getRadarRescueStatus } from "./streamPrefetch";
import { db } from "./db";
import { eq, and, desc, isNull, isNotNull, sql, gte, inArray } from "drizzle-orm";
import { categorizeSubmission, SubmissionWithTopic } from "./newsScrubGenerator";
import multer from "multer";
import sanitizeHtml from "sanitize-html";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { parseNewsScrubHighlights } from "./newsScrubParser";
import { normalizeTitle, cleanDisplayTitle, calculateSimilarity } from "./titleNormalizer";
import { clusterTopStories, setClusterRepresentative, unlinkFromCluster, mergeClusters, getAllClustersWithMembers } from "./headlineCluster";
import { isClusteringEnabled, setClusteringEnabled, isTopicClusteringEnabled, setTopicClusteringEnabled, isJoePriorityMatchingEnabled, setJoePriorityMatchingEnabled, persistClusteringEnabled, persistTopicClusteringEnabled, persistJoePriorityMatchingEnabled } from "./clusterConfig";
import { isWatchTopicSteeringEnabled, setWatchTopicSteeringEnabled, persistWatchTopicSteering } from "./watchTopicMatcher";
import { clusterSubmissionsForTopic, getClusteredSubmissionsForTopic, assignSubmissionToCluster, createClusterWithSubmission, unlinkSubmissionFromCluster, getAllTeamClusters, clusterAllActiveTopics, clearAllTeamClusters } from "./teamSubmissionCluster";
import { scrapeVideoUrl } from "./videoScraper";
import type { IStorage } from "./storage";
import { normalizeIdentityUrl } from "./urlIdentity";
import { getSchemaReadiness } from "./schemaReadiness";
import { isSingleWellFormedHttpUrl } from "./curatedIngest";
import { getTickerData } from "./tickerCache";
import {
  getModeratedLiveBroadcastStatus,
  refreshModeratedLiveBroadcastStatus,
  type LiveBroadcastStatus,
} from "./liveBroadcastStatus";
import {
  applyLiveBroadcastModeration,
  isCurrentLiveBroadcastEvent,
  validateLiveBroadcastOverrides,
} from "./liveBroadcastModeration";
import { LIVE_ALERT_REASON_KEYS } from "@shared/curatedReasonVocab";
import { INCORRECT_GROUPING_REASON_KEYS } from "@shared/editorialEvidence";
import {
  mapActionToKind,
  buildEpisodeExplorer,
  buildEvidenceMarkdown,
  buildEvidenceMarkdownFromEpisodes,
  computeFilteredCounts,
  adaptDbEpisodes,
  lineageFromDbEpisodes,
  buildEvidenceResponse,
} from "./editorialEvidenceBuild";
import {
  captureEditorialEpisode,
  updateEditorialEpisodeReason,
  recordLegacyRuleDisposition,
  LEGACY_DISPOSITIONS,
} from "./editorialEvidenceCapture";
import { sampleFdUsage, getFdHistory, FD_WARN_THRESHOLD } from "./fdMonitor";
import { fetchViaPaywallBypass } from "./paywallBypass";
import { registerPublicApi } from "./publicApi";
import { openai, isAIConfigured, isTransientAIError, getProviderMode, setProviderMode, createPreferOpenRouter, parseAiJson } from "./aiClient";
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from "./aiTimeout";
import { createHash } from "crypto";

function resolveField(obj: any, ...candidates: string[]): any {
  for (const key of candidates) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

function asStoredContentKind(kind: string | null | undefined): StoredContentKind {
  if (kind === 'audio' || kind === 'article' || kind === 'opinion' || kind === 'explainer') {
    return kind;
  }
  return undefined;
}
function generatePostId(content: string): string {
  return 'auto-' + createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function normalizeRelayPost(raw: any): { postId: string; content: string; postedAt: Date; truthSocialUrl: string; imageUrl: string | null; videoUrl: string | null; videoThumbnailUrl: string | null; isReblog: boolean; rebloggedFrom: string | null } | null {
  const content = resolveField(raw, 'content', 'text', 'body', 'message', 'status', 'description', 'post_content', 'post_text', 'full_text', 'note');
  let contentStr = content !== undefined && content !== null ? String(content).trim() : '';

  const timestamp = resolveField(raw, 'postedAt', 'posted_at', 'created_at', 'createdAt', 'timestamp', 'date', 'published_at', 'publishedAt', 'time');
  let postedAt: Date;
  if (timestamp) {
    const parsed = new Date(timestamp);
    postedAt = isNaN(parsed.getTime()) ? new Date() : parsed;
  } else {
    postedAt = new Date();
  }

  let imageUrl = resolveField(raw, 'imageUrl', 'image_url', 'image', 'media_url', 'photo', 'photo_url', 'picture', 'thumbnail', 'thumb', 'media_image');
  let videoUrl = resolveField(raw, 'videoUrl', 'video_url', 'video', 'media_video', 'video_link');
  let videoThumbnailUrl = resolveField(raw, 'videoThumbnailUrl', 'video_thumbnail_url', 'video_thumbnail', 'video_thumb');

  const attachments = resolveField(raw, 'media_attachments', 'mediaAttachments', 'attachments', 'media');
  if (Array.isArray(attachments) && attachments.length > 0) {
    for (const att of attachments) {
      if (!att || typeof att !== 'object') continue;
      const attType = String(att.type || '').toLowerCase();
      if (!imageUrl && (attType === 'image' || attType === 'photo')) {
        const imgSrc = att.url || att.remote_url;
        if (imgSrc) imageUrl = imgSrc;
      }
      if (attType === 'video' || attType === 'gifv' || attType === 'animated_gif') {
        if (!videoUrl) {
          const vidSrc = att.url || att.remote_url;
          if (vidSrc) videoUrl = vidSrc;
        }
        if (!videoThumbnailUrl) {
          const thumbSrc = att.preview_url || att.preview_remote_url;
          if (thumbSrc) videoThumbnailUrl = thumbSrc;
        }
      }
      if (imageUrl && videoUrl && videoThumbnailUrl) break;
    }
  }

  // Retain media-only posts as linkable sources. Their exact synthetic marker
  // lets the shared policy suppress only the still image while preserving video.
  if (!contentStr) {
    if (!imageUrl && !videoUrl && !videoThumbnailUrl) return null;
    contentStr = '[Media attachment]';
  }

  const postId = resolveField(raw, 'postId', 'post_id', 'id', 'statusId', 'status_id', 'truth_id', 'externalId', 'external_id', 'uid');
  const postIdStr = postId ? String(postId) : generatePostId(contentStr);
  const url = resolveField(raw, 'truthSocialUrl', 'truth_social_url', 'url', 'link', 'post_url', 'permalink', 'href', 'source_url');
  const truthSocialUrl = url ? String(url) : `https://truthsocial.com/posts/${postIdStr}`;

  const isReblog = resolveField(raw, 'isReblog', 'is_reblog', 'is_repost', 'isRepost', 'reblog', 'repost') || false;
  const rebloggedFrom = resolveField(raw, 'rebloggedFrom', 'reblogged_from', 'reposted_from', 'repostedFrom', 'original_author');

  return {
    postId: postIdStr,
    content: contentStr,
    postedAt,
    truthSocialUrl,
    imageUrl: imageUrl ? String(imageUrl) : null,
    videoUrl: videoUrl ? String(videoUrl) : null,
    videoThumbnailUrl: videoThumbnailUrl ? String(videoThumbnailUrl) : null,
    isReblog: Boolean(isReblog),
    rebloggedFrom: rebloggedFrom ? String(rebloggedFrom) : null,
  };
}

function extractPostsFromBody(body: any): Array<{ normalized: ReturnType<typeof normalizeRelayPost> & {}; rawPayload: string }> {
  const results: Array<{ normalized: NonNullable<ReturnType<typeof normalizeRelayPost>>; rawPayload: string }> = [];

  let items: any[] = [];

  if (Array.isArray(body)) {
    items = body;
  } else if (body && typeof body === 'object') {
    const wrapperKeys = ['posts', 'data', 'items', 'results', 'statuses', 'entries', 'records'];
    let found = false;
    for (const key of wrapperKeys) {
      if (Array.isArray(body[key])) {
        items = body[key];
        found = true;
        break;
      }
    }
    if (!found) {
      items = [body];
    }
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const normalized = normalizeRelayPost(item);
    if (normalized) {
      results.push({ normalized, rawPayload: JSON.stringify(item) });
    } else {
      const fallbackContent = JSON.stringify(item);
      if (fallbackContent.length > 2) {
        results.push({
          normalized: {
            postId: generatePostId(fallbackContent),
            content: fallbackContent,
            postedAt: new Date(),
            truthSocialUrl: '',
            imageUrl: null,
            videoUrl: null,
            videoThumbnailUrl: null,
            isReblog: false,
            rebloggedFrom: null,
          },
          rawPayload: fallbackContent,
        });
      }
    }
  }

  return results;
}

function decodeHtmlEntities(url: string): string {
  return url
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Background video scraping - runs without blocking response
const videoScrapeQueue = new Set<string>();

async function scrapeVideoInBackground(headlineId: string, url: string, storage: IStorage) {
  // Avoid duplicate scraping
  if (videoScrapeQueue.has(headlineId)) return;
  videoScrapeQueue.add(headlineId);
  
  try {
    console.log(`[VideoScraper] Starting background scrape for: ${url}`);
    const result = await scrapeVideoUrl(url);
    
    // Only update if we got useful data
    if (result.videoUrl || result.ogImageUrl) {
      const [existing] = await db.select({ ogImageUrl: headlines.ogImageUrl })
        .from(headlines).where(eq(headlines.id, headlineId));
      const existingHasManualImage = existing?.ogImageUrl && existing.ogImageUrl.startsWith('/objects/');
      
      await db.update(headlines)
        .set({
          videoUrl: result.videoUrl,
          ogImageUrl: existingHasManualImage ? existing.ogImageUrl : result.ogImageUrl,
          mediaScrapedAt: new Date(),
        })
        .where(eq(headlines.id, headlineId));
      console.log(`[VideoScraper] Cached media for headline ${headlineId}: video=${!!result.videoUrl}, image=${existingHasManualImage ? 'preserved-manual' : !!result.ogImageUrl}`);
    } else {
      console.log(`[VideoScraper] No media found for ${headlineId}, not caching empty result`);
    }
  } catch (error) {
    console.error(`[VideoScraper] Background scrape failed for ${url}:`, error);
  } finally {
    videoScrapeQueue.delete(headlineId);
  }
}

// Helper to update headline media cache (only caches when there's useful data)
// Returns the final values that were written to the DB (respecting user edits)
async function updateHeadlineMedia(
  headlineId: string, 
  ogImageUrl: string | null, 
  videoUrl: string | null, 
  summaryBullets: string[],
  storage: IStorage
): Promise<{ ogImageUrl: string | null; videoUrl: string | null; summaryBullets: string[] } | null> {
  const hasData = ogImageUrl || videoUrl || summaryBullets.length > 0;
  if (!hasData) return null;
  
  try {
    const [existing] = await db.select({ 
      ogImageUrl: headlines.ogImageUrl,
      summaryBullets: headlines.summaryBullets, 
      mediaScrapedAt: headlines.mediaScrapedAt,
      manuallyEdited: headlines.manuallyEdited,
    })
      .from(headlines).where(eq(headlines.id, headlineId));
    
    if (existing) {
      if (existing.manuallyEdited) {
        return { ogImageUrl: existing.ogImageUrl, videoUrl: null, summaryBullets: existing.summaryBullets || [] };
      }
      
      const existingHasManualBullets = existing.summaryBullets && existing.summaryBullets.length > 0 && existing.mediaScrapedAt;
      const existingHasManualImage = existing.ogImageUrl && existing.ogImageUrl.startsWith('/objects/');
      
      const finalOgImage = existingHasManualImage ? existing.ogImageUrl : ogImageUrl;
      const finalBullets = existingHasManualBullets ? existing.summaryBullets : (summaryBullets.length > 0 ? summaryBullets : null);
      
      await db.update(headlines)
        .set({
          ogImageUrl: finalOgImage,
          videoUrl,
          summaryBullets: finalBullets,
          mediaScrapedAt: new Date(),
        })
        .where(eq(headlines.id, headlineId));
      
      return { ogImageUrl: finalOgImage, videoUrl, summaryBullets: finalBullets || [] };
    }
    
    const [existingManual] = await db.select({ 
      ogImageUrl: manualSubmissions.ogImageUrl,
      summaryBullets: manualSubmissions.summaryBullets, 
      mediaScrapedAt: manualSubmissions.mediaScrapedAt,
      manuallyEdited: manualSubmissions.manuallyEdited,
    })
      .from(manualSubmissions).where(eq(manualSubmissions.id, headlineId));
    
    if (existingManual) {
      if (existingManual.manuallyEdited) {
        return { ogImageUrl: existingManual.ogImageUrl, videoUrl: null, summaryBullets: existingManual.summaryBullets || [] };
      }
      
      const existingHasManualBullets = existingManual.summaryBullets && existingManual.summaryBullets.length > 0 && existingManual.mediaScrapedAt;
      const existingHasManualImage = existingManual.ogImageUrl && existingManual.ogImageUrl.startsWith('/objects/');
      
      const finalOgImage = existingHasManualImage ? existingManual.ogImageUrl : ogImageUrl;
      const finalBullets = existingHasManualBullets ? existingManual.summaryBullets : (summaryBullets.length > 0 ? summaryBullets : null);
      
      await db.update(manualSubmissions)
        .set({
          ogImageUrl: finalOgImage,
          videoUrl,
          summaryBullets: finalBullets,
          mediaScrapedAt: new Date(),
        })
        .where(eq(manualSubmissions.id, headlineId));
      
      return { ogImageUrl: finalOgImage, videoUrl, summaryBullets: finalBullets || [] };
    }
    
    return null;
  } catch (error) {
    console.error(`[MediaCache] Failed to cache media for ${headlineId}:`, error);
    return null;
  }
}

// Sanitization options for rich text chat messages
const chatSanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'a', 'img'],
  allowedAttributes: {
    'a': ['href', 'target', 'rel'],
    'img': ['src', 'alt']
  },
  allowedSchemes: ['http', 'https'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  transformTags: {
    'a': (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        target: '_blank',
        rel: 'noopener noreferrer'
      }
    })
  }
};
import { getUncachableResendClient } from "./resend";
import { getScraperStatus } from "./scheduler";

// Check if a Replit user is a member of the team (stored in database)
async function isTeamMember(user: any): Promise<boolean> {
  if (!user?.claims) return false;
  
  const email = user.claims.email;
  if (!email) return false;
  
  return await storage.isTeamMember(email);
}

// Middleware to check authentication
// Create flexible auth guard middleware
function createAuthGuard(options: { allowUser?: boolean; allowAdmin?: boolean; allowReplitAuth?: boolean } = {}) {
  const { allowUser = false, allowAdmin = false, allowReplitAuth = false } = options;
  
  return function(req: Request, res: Response, next: NextFunction) {
    const isUser = req.session?.authenticated === true;
    const isAdmin = req.session?.adminAuthenticated === true;
    const isReplitUser = !!(req as any).user;
    
    if ((allowUser && isUser) || (allowAdmin && isAdmin) || (allowReplitAuth && isReplitUser)) {
      return next();
    }
    
    return res.status(401).json({ error: 'Authentication required' });
  };
}

// Middleware to check team membership (stored in database)
async function requireTeamMember(req: any, res: Response, next: NextFunction) {
  // First check if user is authenticated with Replit
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user?.claims?.sub) {
    return res.status(401).json({ error: 'Replit authentication required' });
  }
  
  // Then check team membership from database
  const isMember = await isTeamMember(req.user);
  if (!isMember) {
    return res.status(403).json({ error: 'Access restricted to team members only' });
  }
  
  return next();
}

// Combined auth middleware: allows Replit auth team members OR password-authenticated users.
// "Password-authenticated" includes:
//   - legacy team/admin/war-admin sessions
//   - Warfighter viewer or admin password sessions
//   - any Custom MCOP per-MCOP password unlock (viewer or admin)
// This means anyone who has unlocked the Warfighter or Warfighter Admin page
// (or any Custom MCOP) can use shared utilities like /api/stream/upload-image
// without needing to also be signed in to Replit.
async function requireTeamOrUserAuth(req: any, res: Response, next: NextFunction) {
  const s = req.session || {};
  if (
    s.authenticated === true ||
    s.adminAuthenticated === true ||
    s.warAdminAuthenticated === true ||
    s.warViewerAuthenticated === true ||
    s.warfighterAdminAuth === true ||
    s.warfighterViewerAuth === true ||
    s.cyberAdminAuth === true ||
    s.cyberViewerAuth === true ||
    (s.customMcopAuth && Object.values(s.customMcopAuth).some((v) => v === true))
  ) {
    return next();
  }

  // Fall back to Replit auth + team membership check
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.claims?.sub) {
    const isMember = await isTeamMember(req.user);
    if (isMember) {
      return next();
    }
    return res.status(403).json({ error: 'Access restricted to team members only' });
  }

  console.log(`[Auth] requireTeamOrUserAuth REJECTED ${req.method} ${req.originalUrl} - session keys: ${Object.keys(req.session || {}).join(',')}`);
  return res.status(401).json({ error: 'Authentication required' });
}


// Plain-English defaults for new Custom MCOPs (and the Warfighter MCOP).
// These mirror the original CJCS-style SYSTEM_PROMPT used by /api/headlines scoring,
// but written so a non-engineer can edit them in the admin UI.
const DEFAULT_GENERAL_PROMPT = `You are scoring news for a senior U.S. military leader (think Chairman of the Joint Chiefs / Secretary of Defense level).

Score HIGH (80-100) — strategic-level news that would belong in a daily intel brief:
- Peer adversaries: China (PLA, Taiwan, South China Sea, espionage), Russia (Ukraine war, NATO friction, nuclear posture), North Korea (missile/nuclear tests), Iran (proxies, nuclear program, Strait of Hormuz)
- Active wars and major military operations involving U.S. forces, NATO, or allies
- U.S. force readiness, troop movements, deployments, posture changes, recruiting, force structure
- Defense policy, NDAA, defense budget, major acquisitions, shipbuilding, munitions stockpiles
- Senior DoD leadership: SecDef, Joint Chiefs, combatant commanders, civilian-military relations
- Cyber attacks on U.S. infrastructure or military, space conflict, military AI, autonomous weapons
- Alliances and partnerships: NATO, AUKUS, Quad, Five Eyes, ROK/Japan, Indo-Pacific posture
- Major terrorism, mass-casualty attacks, or homeland security incidents
- WMD: nuclear, chemical, biological, radiological proliferation or use
- Critical supply chains for defense (rare earths, semiconductors, energy)
- U.S. domestic politics ONLY when it materially affects national security: White House national-security decisions, major SCOTUS rulings on war powers, civil-military crises, government shutdowns affecting DoD

Score MEDIUM (40-70) — useful situational awareness but not lead-of-brief:
- Regional conflicts without direct U.S. interest
- Allied domestic politics with security implications
- Veterans affairs, military families, military justice
- Defense industry news, mergers, contract awards
- General foreign policy and diplomacy

Score LOW (1-30) — tangentially related at best`;

const DEFAULT_LOOK_FOR_NOW = ``;

const DEFAULT_EXCLUDE = `Filter OUT (mark is_relevant=false) the following unless they have a clear national-security angle:
- Entertainment, celebrities, awards shows, movies, music, TV
- Professional and college sports (unless a security incident at an event)
- Consumer tech product launches and reviews (phones, gadgets, apps)
- Pop culture, lifestyle, fashion, food
- Local crime stories (unless terrorism or mass casualty)
- Routine weather (unless catastrophic disaster affecting military bases or strategic infrastructure)
- Markets and finance (unless related to sanctions, embargoes, defense industry, or strategic commodities)
- Health and medicine (unless pandemic, bioweapon, or military medicine)
- Real estate, personal finance, lifestyle advice
- Opinion / editorial pieces with no new factual reporting`;

// Curated-only: in-memory cache of parsed IE Highlights keyed by scrub id, so
// the latest scrub PDF is downloaded + parsed only once.
const curatedIeHighlightsCache = new Map<string, {
  id: string;
  caoDate: Date;
  filename: string;
  groups: { group: string; trending: string[]; breaking: string[] }[];
}>();

// The IE Highlights parsing logic lives in ./newsScrubParser
// (parseNewsScrubHighlights) so it can be unit-tested in isolation. It handles
// both the "IE Highlights" and the "MAJOR IR/IE NARRATIVES" scrub templates.

// =============================================================================
// Curated lane — editor-OVERRIDE LEARNING LOG (Task #540). A human-in-the-loop
// feedback loop (NOT an auto-tuner). These two helpers let every Curated
// moderation endpoint append an immutable event + content snapshot the moment an
// editor acts, so the signal about WHAT editors keep suppressing / boosting can
// be compiled into a report + AI brief. CURATED-ONLY and fail-soft: a snapshot or
// log failure NEVER breaks the underlying moderation action, and nothing here is
// read by any feed path (getPrimaryFeed / Classic / Visual / custom-MCOP / public
// API) — the override-log read endpoint is the sole consumer.
// =============================================================================
type CuratedOverrideSnapshot = {
  storyKey: string | null;
  itemUrl: string | null;
  headline: string | null;
  outlet: string | null;
  country: string | null;
  region: string | null;
  contentKind: string | null;
         sourceIdentifier: string | null;
         otherSourceType: string | null;
  originalScore: number | null;
  originalReasoning: string | null;
  originalTopic: string | null;
  originalCategory: string | null;
};

// Best-effort snapshot of the content an editor is acting on, resolved from the
// curated store at action time (so the log is meaningful even after the row
// churns out of the live window). Never throws.
async function resolveCuratedOverrideSnapshot(opts: {
  scope?: string;
  type?: string;
  id?: string;
  clusterId?: string;
  url?: string;
}): Promise<CuratedOverrideSnapshot> {
  const snap: CuratedOverrideSnapshot = {
    storyKey: null, itemUrl: null, headline: null, outlet: null,
    country: null, region: null, contentKind: null,
    sourceIdentifier: null, otherSourceType: null,
    originalScore: null, originalReasoning: null, originalTopic: null, originalCategory: null,
  };
  try {
    if (opts.scope === 'cluster' && opts.clusterId) {
      // Cluster scope — snapshot the representative member (the story's "face").
      snap.storyKey = `cluster:${opts.clusterId}`;
      const members = await storage.getCuratedClusterMembersByClusterId(opts.clusterId);
      // An editor-forced all-social merge intentionally has no representative:
      // social posts remain Additional Coverage and must not become story media.
      const rep = members.find(m => m.isRepresentative);
      if (rep) {
        snap.headline = rep.title ?? null;
        snap.outlet = rep.source ?? null;
        snap.itemUrl = rep.url ?? null;
        snap.originalScore = rep.priorityScore ?? null;
        snap.originalCategory = rep.category ?? null;
      }
    } else if (opts.scope === 'standalone' && opts.id) {
      const prefix = opts.type === 'curated' ? 'curated' : 'main';
      snap.storyKey = `${prefix}:${opts.id}`;
      if (prefix === 'curated') {
        const map = await storage.getCuratedItemsByIds([opts.id]);
        const item = map.get(opts.id);
        if (item) {
          snap.headline = item.title ?? null;
          snap.outlet = item.source ?? null;
          snap.itemUrl = item.url ?? null;
          snap.region = item.region ?? null;
          snap.country = item.country ?? null;
          snap.contentKind = item.contentKind ?? null;
          snap.originalScore = item.priorityScore ?? null;
          snap.originalCategory = item.category ?? null;
        }
      } else {
        // main:<id> surfaced in curated — snapshot from its cluster member row.
        const member = await storage.getCuratedClusterMemberByItem('main', opts.id);
        if (member) {
          snap.headline = member.title ?? null;
          snap.outlet = member.source ?? null;
          snap.itemUrl = member.url ?? null;
          snap.originalScore = member.priorityScore ?? null;
          snap.originalCategory = member.category ?? null;
        } else {
          // Task #678: a standalone main:<id> pin frequently targets a headline
          // that is NOT a current cluster member — the cluster_members table is
          // wiped and rebuilt every pass, and an un-clustered main item never has
          // a member row at all. Previously this left the snapshot empty, so the
          // scoring signal (AI originalScore / outlet / topic) for these pins was
          // silently lost from the learning log. Fall back to the main-feed source
          // tables (headlines, then manual_submissions) so the AI-vs-editor scoring
          // signal is captured. priorityScore here is the AI's ORIGINAL score (the
          // pin lives in a separate override column), which is exactly what the
          // learning loop needs. Read-only lookup; curated-lane capture path only.
          const src =
            (await storage.getHeadlineById(opts.id)) ??
            (await storage.getManualSubmissionById(opts.id));
          if (src) {
            snap.headline = src.title ?? null;
            snap.outlet = src.source ?? null;
            snap.itemUrl = src.url ?? null;
            snap.originalScore = src.priorityScore ?? null;
            snap.originalCategory = src.category ?? null;
          }
        }
      }
    } else if (opts.url) {
      // Classification override — keyed by article URL.
      snap.itemUrl = opts.url;
      const item = await storage.getCuratedItemByUrl(opts.url);
      if (item) {
        snap.storyKey = `curated:${item.id}`;
        snap.headline = item.title ?? null;
        snap.outlet = item.source ?? null;
        snap.region = item.region ?? null;
        snap.country = item.country ?? null;
        snap.contentKind = item.contentKind ?? null;
        snap.originalScore = item.priorityScore ?? null;
        snap.originalCategory = item.category ?? null;
      } else {
        // Task #1027, Step 7: a URL-keyed override may target a main-feed
        // article that is surfaced via clustering but not stored in curated_items.
        // Snapshot headline/outlet from main-feed tables so the audit log is
        // meaningful. Read-only; curated-lane capture path only.
        const [headlineByUrl] = await db.select().from(headlines).where(eq(headlines.url, opts.url)).limit(1);
        const src =
          headlineByUrl ??
          (await storage.getManualSubmissionByUrl(opts.url));
        if (src) {
          snap.headline = src.title ?? null;
          snap.outlet = src.source ?? null;
          snap.originalScore = src.priorityScore ?? null;
          snap.originalCategory = src.category ?? null;
        }
      }
    }
    // Overlay the curated classification (content geography + controlled-vocab
    // topic) — the authoritative ORIGINAL topic/region/country shown to editors.
    if (snap.itemUrl) {
      const clsMap = await storage.getCuratedClassificationsByUrls([snap.itemUrl]);
      const cls = clsMap.get(snap.itemUrl);
      if (cls) {
        if (cls.primaryTopic) snap.originalTopic = cls.primaryTopic;
        if (cls.region) snap.region = cls.region;
        if (cls.country) snap.country = cls.country;
        if (cls.category) snap.originalCategory = cls.category;
      }
    }
  } catch (e: any) {
    // Best-effort only — never break the moderation action.
    console.warn('[curated-override-log] snapshot resolve failed:', e?.message || e);
  }
  return snap;
}

// Append a single override event, honoring the persisted capture-pause flag.
// Fail-soft: any error is swallowed so the moderation action always succeeds.
async function captureCuratedOverrideEvent(params: {
  action: string;
  editor: string;
  newValue?: string | null;
  snapshot?: Partial<CuratedOverrideSnapshot>;
  storyKey?: string | null;
  itemUrl?: string | null;
  outlet?: string | null;
  headline?: string | null;
  reasonKeys?: string[] | null;
  reasonNote?: string | null;
  beforeValue?: Record<string, unknown> | null;
  afterValue?: Record<string, unknown> | null;
  // Scoring Radar telemetry (Task #834). Set when the correction comes from the
  // radar panel so the learning loop can distinguish radar-prompted actions.
  rawScore?: number | null;
  decayedScore?: number | null;
  itemAgeHours?: number | null;
  surfacingState?: string | null;
  fromRadar?: boolean | null;
  memberUrls?: string[] | null;
  memberOutlets?: string[] | null;
  headlines?: string[] | null;
  alternatives?: Record<string, unknown>[] | null;
  provenance?: { model?: string | null; promptVersion?: string | null; clusterRevision?: string | null; surface?: string | null } | null;
  surface?: string | null;
  outcome?: import('@shared/editorialEvidence').LifecycleOutcome | null;
  beforeContext?: Record<string, unknown> | null;
  requestedContext?: Record<string, unknown> | null;
  actualContext?: Record<string, unknown> | null;
  /** Coordinated manual mutations require both the raw event and durable episode
   * before the authoritative overlay changes. Legacy callers remain fail-soft. */
  strict?: boolean;
  /** Strict coordinated callers use this to retain the durable episode id for
   * terminal coordinator-outcome updates after the overlay apply attempt. */
  onEpisode?: (episodeId: string) => void;
}): Promise<string | null> {
  try {
    const settings = await storage.getCuratedFeedbackSettings();
    if (settings.capturePaused) {
      if (params.strict) throw new Error('editorial evidence capture is paused');
      return null;
    }
    const s = params.snapshot ?? {};
    const itemUrl = params.itemUrl ?? s.itemUrl ?? null;
    const rawEvent = {
      action: params.action,
      storyKey: params.storyKey ?? s.storyKey ?? null,
      itemUrl,
      canonicalUrl: normalizeIdentityUrl(itemUrl),
      headline: params.headline ?? s.headline ?? null,
      outlet: params.outlet ?? s.outlet ?? null,
      country: s.country ?? null,
      region: s.region ?? null,
      contentKind: s.contentKind ?? null,
      originalScore: s.originalScore ?? null,
      originalReasoning: s.originalReasoning ?? null,
      originalTopic: s.originalTopic ?? null,
      originalCategory: s.originalCategory ?? null,
      newValue: params.newValue ?? null,
      beforeValue: params.beforeValue ?? null,
      afterValue: params.afterValue ?? null,
      editor: params.editor,
      reasonKeys: params.reasonKeys?.length ? params.reasonKeys : null,
      reasonNote: params.reasonNote || null,
      // Radar telemetry passthrough.
      rawScore: params.rawScore ?? null,
      decayedScore: params.decayedScore ?? null,
      itemAgeHours: params.itemAgeHours ?? null,
      surfacingState: params.surfacingState ?? null,
      fromRadar: params.fromRadar ?? false,
    };
    const persistEpisode = async (episodeStorage: unknown, eventId: string): Promise<string | null> => {
    // Task #1180 — every immutable raw action ALSO attempts a durable EPISODE
    // capture with normalized identities + reason/note + before/requested/
    // actual + provenance + editor surface + lifecycle. Fail-soft (duck-typed
    // optional storage method) so an edit always succeeds even when the durable
    // persistence method has not been added yet.
    try {
      const kind = mapActionToKind(params.action);
      if (kind) {
        const s = params.snapshot ?? {};
        const before = s.originalScore ?? null;
        const requested =
          kind === 'priority-adjust' ? parseRequestedPriorityScore(params.newValue) : null;
        const defaultBeforeContext: Record<string, unknown> = {
          rawScore: params.rawScore ?? s.originalScore ?? null,
          decayedScore: params.decayedScore ?? null,
          displayedScore: s.originalScore ?? null,
          ageHours: params.itemAgeHours ?? null,
          surfacingReason: params.surfacingState ?? null,
          topic: s.originalTopic ?? null,
          category: s.originalCategory ?? null,
          region: s.region ?? null,
          country: s.country ?? null,
          contentKind: s.contentKind ?? null,
          headline: params.headline ?? s.headline ?? null,
          outlet: params.outlet ?? s.outlet ?? null,
        };
        const compact = (value: Record<string, unknown>): Record<string, unknown> =>
          Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined));
        const defaultOutcome =
          kind === 'undo' ? 'undone'
            : kind === 'link' || kind === 'merge' || kind === 'unlink' || kind === 'evict' || kind === 'move'
              ? 'persisted'
              : 'applied';
        const episodeId = await captureEditorialEpisode(episodeStorage, {
          sourceEventId: eventId,
          kind,
          editor: params.editor,
          clusterId: extractClusterIdFromStoryKey(params.storyKey ?? s.storyKey ?? null),
          primaryUrl: itemUrl,
          memberUrls: params.memberUrls ?? (itemUrl ? [itemUrl] : []),
          memberOutlets: params.memberOutlets ?? ((params.outlet ?? s.outlet) ? [String(params.outlet ?? s.outlet)] : []),
          headlines: params.headlines ?? ((params.headline ?? s.headline) ? [String(params.headline ?? s.headline)] : []),
          reasonKey: params.reasonKeys?.[0] ?? null,
          reasonNote: params.reasonNote ?? null,
          beforeScore: before,
          requestedScore: requested,
          actualScore: requested,
          alternatives: params.alternatives ?? null,
          provenance: params.provenance ?? {
            clusterRevision: String(getCuratedRevision().revision),
            surface: params.fromRadar ? 'scoring-radar' : 'curated-detail',
          },
          surface: params.surface ?? (params.fromRadar ? 'scoring-radar' : 'curated-detail'),
          outcome: params.outcome ?? defaultOutcome,
          beforeContext: params.beforeContext ?? compact(defaultBeforeContext),
          requestedContext: params.requestedContext ?? compact({
            value: params.newValue ?? null,
            targetScore: requested,
          }),
          actualContext: params.actualContext ?? null,
          explicitIncorrectGrouping: Array.isArray(params.reasonKeys)
            ? params.reasonKeys.some((k) => INCORRECT_GROUPING_REASON_KEYS.has(k))
            : false,
          atMs: Date.now(),
        }, { strict: params.strict === true });
        if (params.strict && !episodeId) {
          throw new Error('durable editorial episode was not persisted');
        }
        return episodeId;
      } else if (params.strict) {
        throw new Error(`unsupported strict editorial action: ${params.action}`);
      }
    } catch (e: any) {
      if (params.strict) throw e;
      console.warn('[editorial-evidence] durable capture wrapper failed (fail-soft):', e?.message || e);
    }
      return null;
    };

    if (params.strict) {
      const captured = await storage.captureCuratedOverrideEvidenceAtomic(
        rawEvent,
        (eventId, transactionStorage) => persistEpisode(transactionStorage, eventId),
      );
      params.onEpisode?.(captured.episodeId);
      return captured.eventId;
    }

    const eventId = await storage.recordCuratedOverrideEvent(rawEvent);
    const episodeId = await persistEpisode(storage, eventId);
    if (episodeId) params.onEpisode?.(episodeId);
    return eventId;
  } catch (e: any) {
    if (params.strict) throw e;
    console.warn('[curated-override-log] capture failed:', e?.message || e);
    return null;
  }
}

async function captureRequiredCuratedOverrideEvent(
  params: Omit<Parameters<typeof captureCuratedOverrideEvent>[0], 'strict' | 'onEpisode'>,
): Promise<string> {
  let episodeId: string | null = null;
  await captureCuratedOverrideEvent({
    ...params,
    strict: true,
    onEpisode: (id) => {
      episodeId = id;
    },
  });
  if (!episodeId) throw new Error('durable editorial episode was not persisted');
  return episodeId;
}

// Parse the "pinned to <n>" free-text used by priority-override newValue. Local
// mirror of the evidence builder's parser so the durable-capture path does not
// depend on the aggregation module.
function parseRequestedPriorityScore(newValue: string | null | undefined): number | null {
  if (!newValue) return null;
  const m = /(-?\d+)/.exec(newValue);
  return m ? parseInt(m[1], 10) : null;
}

function extractClusterIdFromStoryKey(storyKey: string | null | undefined): string | null {
  const k = (storyKey ?? '').trim();
  if (k.startsWith('cluster:')) return k.slice('cluster:'.length) || null;
  return null;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Idempotent seed: ensure the Cyber MCOP exists and starts as a mirror of
  // Warfighter (priority prompt, look-for-now, exclude, feed-from-MCOP).
  // Runs once at boot. Safe to re-run — only inserts if the row is missing.
  // After creation Cyber and Warfighter are independent.
  (async () => {
    try {
      const existing = await storage.getCustomMcopBySlug('cyber');
      if (existing) return;
      const warfighter = await storage.getCustomMcopBySlug('warfighter');
      const created = await storage.createCustomMcop({
        slug: 'cyber',
        name: 'Cyber',
        generalPrompt: warfighter?.generalPrompt ?? DEFAULT_GENERAL_PROMPT,
        lookForNow: warfighter?.lookForNow ?? DEFAULT_LOOK_FOR_NOW,
        exclude: warfighter?.exclude ?? DEFAULT_EXCLUDE,
        feedFromMcop: warfighter?.feedFromMcop ?? true,
        createdBy: 'system-seed',
      });
      // Seed an admin password hash so /api/custom-mcops/:slug operations that
      // require a password (other than the gate) work out of the box. The
      // public-facing two-tier gate uses GATED_MCOP_CONFIG passwords; this is
      // the per-MCOP password that admins can change later in the admin UI.
      try {
        const cryptoMod = await import('crypto');
        const salt = cryptoMod.randomBytes(16).toString('hex');
        const key: Buffer = await new Promise((resolve, reject) => {
          cryptoMod.scrypt('Cyber22@@', salt, 64, (err, derivedKey) => {
            if (err) reject(err);
            else resolve(derivedKey as Buffer);
          });
        });
        const hash = `${salt}:${key.toString('hex')}`;
        await storage.setCustomMcopPasswordHash(created.id, hash);
      } catch (e) {
        console.error('[Cyber MCOP seed] failed to set initial password hash:', e);
      }
      console.log('[Cyber MCOP seed] created Cyber MCOP as a mirror of Warfighter');
    } catch (e) {
      console.error('[Cyber MCOP seed] failed:', e);
    }
  })();

  // Authentication routes (no auth required)
  app.post("/api/auth/login", async (req, res) => {
    const { password } = req.body;
    const correctPassword = process.env.APP_PASSWORD;

    if (!correctPassword) {
      return res.status(500).json({ message: 'Server not configured for authentication' });
    }

    if (password === correctPassword) {
      req.session.authenticated = true;
      res.json({ success: true });
    } else {
      res.status(401).json({ message: 'Invalid password' });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        res.status(500).json({ error: 'Failed to logout' });
      } else {
        res.json({ success: true });
      }
    });
  });

  app.get("/api/auth/status", (req, res) => {
    res.json({ authenticated: !!req.session.authenticated });
  });

  // Check if user has team access (stored in database)
  app.get("/api/auth/team-access", async (req: any, res) => {
    // Check Replit authentication first
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user?.claims?.sub) {
      return res.json({ 
        authenticated: false, 
        hasTeamAccess: false,
        reason: 'not_logged_in'
      });
    }
    
    // Check team membership from database
    const hasAccess = await isTeamMember(req.user);
    res.json({ 
      authenticated: true, 
      hasTeamAccess: hasAccess,
      reason: hasAccess ? 'member' : 'not_org_member'
    });
  });

  // Single flag for the curated dev bypass. In development every curated gate
  // short-circuits so the preview never demands a login. (Flip to `false`
  // temporarily to reproduce production auth in the dev preview for testing.)
  const CURATED_DEV_BYPASS = app.get("env") === "development";

  // Resolve the two DECOUPLED Curated access signals for a request:
  //   canView — load the /curated page + read endpoints
  //   canEdit — moderation/mutation endpoints (priority pins, link/image
  //             replacement, classification, hide, etc.)
  // Access model: the MCOP password (the standard app session shared with
  // Classic/Visual) grants VIEW-only "public" access to Curated. EDIT is a
  // separate, higher tier granted ONLY to the Replit-auth tester allowlist.
  // Matrix: dev → both true; allowlist tester (Replit auth) → both true;
  // any app-password session (non-tester) → view-only; not logged in → both false.
  const resolveCuratedAccess = async (
    req: any,
  ): Promise<{ canView: boolean; canEdit: boolean; reason: string }> => {
    if (CURATED_DEV_BYPASS) {
      return { canView: true, canEdit: true, reason: 'dev' };
    }
    // Editor tier: tester allowlist via Replit auth → both view and edit.
    const email = req.user?.claims?.email;
    const isTester = !!(req.isAuthenticated && req.isAuthenticated() && email &&
      await storage.isCuratedViewTester(email));
    if (isTester) {
      return { canView: true, canEdit: true, reason: 'tester' };
    }
    // Public view tier: any standard app-password session (the same session as
    // Classic/Visual) gets VIEW-only access. Edit is never granted here.
    const s = req.session || {};
    if (s.authenticated === true) {
      return { canView: true, canEdit: false, reason: 'app-authed' };
    }
    return { canView: false, canEdit: false, reason: 'not_logged_in' };
  };

  // Check whether the user has access to the Curated View. Returns both DECOUPLED
  // signals (canView / canEdit) plus `hasCuratedAccess` kept as a backward-compat
  // ALIAS of canView for the existing nav-button callers (Header/Stream/Team/
  // Archive/ViewSwitcher) that gate the Curated nav entry on it.
  app.get("/api/auth/curated-access", async (req: any, res) => {
    const { canView, canEdit, reason } = await resolveCuratedAccess(req);
    res.json({ hasCuratedAccess: canView, canView, canEdit, reason });
  });

  // Team member management routes (requires team membership)
  app.get("/api/team/members", requireTeamMember, async (req: any, res) => {
    try {
      const members = await storage.getAllTeamMembers();
      res.json(members);
    } catch (error) {
      console.error('Error fetching team members:', error);
      res.status(500).json({ error: 'Failed to fetch team members' });
    }
  });

  app.post("/api/team/members", requireTeamMember, async (req: any, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email is required' });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }

      const existing = await storage.getTeamMemberByEmail(email);
      if (existing) {
        return res.status(400).json({ error: 'This email is already a team member' });
      }

      const addedBy = req.user.claims.email || req.user.claims.name || 'Unknown';
      const member = await storage.addTeamMember(email, addedBy);
      res.json(member);
    } catch (error) {
      console.error('Error adding team member:', error);
      res.status(500).json({ error: 'Failed to add team member' });
    }
  });

  app.delete("/api/team/members/:id", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      await storage.removeTeamMember(id);
      res.json({ success: true });
    } catch (error) {
      console.error('Error removing team member:', error);
      res.status(500).json({ error: 'Failed to remove team member' });
    }
  });

  // Request access endpoint (no auth required)
  app.post("/api/auth/request-access", async (req, res) => {
    try {
      const { name, email, message } = req.body;

      // Validate input
      if (!name || !email || !message) {
        return res.status(400).json({ error: 'Name, email, and message are required' });
      }

      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }

      const recipientEmail = process.env.RECIPIENT_EMAIL;
      if (!recipientEmail) {
        console.error('RECIPIENT_EMAIL environment variable not set');
        return res.status(500).json({ error: 'Email service not configured' });
      }

      // Get Resend client
      const { client, fromEmail } = await getUncachableResendClient();

      // Send email
      const { data, error } = await client.emails.send({
        from: fromEmail,
        to: recipientEmail,
        replyTo: email,
        subject: `Media Common Operating Picture Access Request from ${name}`,
        html: `
          <h3>New Access Request for Media Common Operating Picture v2.0</h3>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Message:</strong></p>
          <p>${message.replace(/\n/g, '<br>')}</p>
        `,
      });

      if (error) {
        console.error('Resend error:', error);
        return res.status(500).json({ error: 'Failed to send access request' });
      }

      res.json({ success: true, message: 'Access request sent successfully' });
    } catch (error) {
      console.error('Error sending access request email:', error);
      res.status(500).json({ error: 'Failed to send access request' });
    }
  });

  // Admin authentication status endpoint
  app.get("/api/admin/auth/status", async (req, res) => {
    res.json({ authenticated: !!req.session.adminAuthenticated });
  });

  // Admin authentication endpoint
  app.post("/api/admin/auth", async (req, res) => {
    const { password } = req.body;
    const correctPassword = process.env.ADMIN_PASSWORD;

    if (!correctPassword) {
      return res.status(500).json({ error: 'Admin access not configured' });
    }

    if (password === correctPassword) {
      req.session.adminAuthenticated = true;
      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'Invalid admin password' });
    }
  });

  // Admin middleware
  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (req.session.adminAuthenticated) {
      next();
    } else {
      res.status(401).json({ error: 'Admin authentication required' });
    }
  }

  // Combined guard for headline management (allows admin OR authenticated team users OR Replit-authenticated team members)
  async function requireAdminOrTeamUser(req: any, res: Response, next: NextFunction) {
    // Check session-based auth (admin or regular login)
    if (req.session.adminAuthenticated || req.session.authenticated) {
      return next();
    }
    
    // Check Replit authentication (used by Team page) - query database for team membership
    if (req.user && req.user.claims) {
      const userEmail = req.user.claims.email?.toLowerCase();
      if (userEmail) {
        try {
          const isMember = await storage.isTeamMember(userEmail);
          if (isMember) {
            return next();
          }
        } catch (error) {
          console.error('Error checking team membership:', error);
        }
      }
    }
    
    res.status(401).json({ error: 'Authentication required' });
  }

  // Admin routes
  app.patch("/api/admin/headlines/:id/priority", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { id } = req.params;
      const { priorityOverride, type } = req.body;

      // Allow null to clear the override, or a number between 1-100
      if (priorityOverride !== null && (typeof priorityOverride !== 'number' || priorityOverride < 1 || priorityOverride > 100)) {
        return res.status(400).json({ error: 'Priority override must be null or a number between 1-100' });
      }

      // Validate type parameter
      if (type !== 'scraped' && type !== 'manual') {
        return res.status(400).json({ error: 'Type must be "scraped" or "manual"' });
      }

      // Route to appropriate storage method based on type
      if (type === 'scraped') {
        await storage.updateHeadlinePriority(id, priorityOverride);
      } else {
        await storage.updateManualSubmissionPriority(id, priorityOverride);
      }
      
      invalidateMainFeeds();
      res.json({ success: true });
    } catch (error) {
      console.error('Error updating priority:', error);
      res.status(500).json({ error: 'Failed to update priority' });
    }
  });

  // Update headline title (accessible to admin or team users)
  app.patch("/api/admin/headlines/:id/title", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { id } = req.params;
      const { title, type } = req.body;

      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ error: 'Title is required' });
      }

      if (type !== 'scraped' && type !== 'manual') {
        return res.status(400).json({ error: 'Type must be "scraped" or "manual"' });
      }

      if (type === 'scraped') {
        const normalized = normalizeTitle(title.trim());
        await storage.updateHeadlineTitle(id, title.trim(), normalized);
      } else {
        await storage.updateManualSubmissionTitle(id, title.trim());
      }
      
      invalidateMainFeeds();
      res.json({ success: true });
    } catch (error) {
      console.error('Error updating title:', error);
      res.status(500).json({ error: 'Failed to update title' });
    }
  });

  app.patch("/api/headlines/:id/url", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { id } = req.params;
      const { url, type } = req.body;

      if (!url || typeof url !== 'string' || url.trim().length === 0) {
        return res.status(400).json({ error: 'URL is required' });
      }

      if (type !== 'scraped' && type !== 'manual') {
        return res.status(400).json({ error: 'Type must be "scraped" or "manual"' });
      }

      if (type === 'scraped') {
        await storage.updateHeadlineUrl(id, url.trim());
      } else {
        await storage.updateManualSubmissionUrl(id, url.trim());
      }

      invalidateMainFeeds();
      res.json({ success: true });
    } catch (error) {
      console.error('Error updating URL:', error);
      res.status(500).json({ error: 'Failed to update URL' });
    }
  });

  app.delete("/api/admin/headlines/:id", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { id } = req.params;
      const type = (req.query.type as string) as 'scraped' | 'manual' | undefined;
      await storage.blockHeadline(id, type);
      invalidateMainFeeds();
      res.json({ success: true });
    } catch (error) {
      console.error('Error blocking headline:', error);
      res.status(500).json({ error: 'Failed to block headline' });
    }
  });

  // Internal-only article fields that must NEVER serialize into a public feed
  // response when a raw headlines/manual row is spread (`...h` / `...rest`).
  //   - attributedClaims — curated-lane enrichment (Task #706); only the curated
  //     API may serialize it.
  //   - contentKind      — page-detected curated-lane marker (audio/opinion);
  //     read ONLY by curated-gated surfaces, never Classic/Visual/war/custom.
  //   - fullText         — full article body carried for internal enrichment;
  //     public feeds serve title/summary/bullets only.
  // Used by every serializer that spreads a getPrimaryFeed row into a public
  // payload (headline-feed, stream, war feed). The curated top-stories builder
  // reads these fields straight from storage in its OWN handler and is
  // unaffected. Guarded by the curated-isolation harness Phase 8 negative
  // controls (Task #780).
  const stripInternalArticleFields = (row: Record<string, any>): Record<string, any> => {
    const { attributedClaims: _ac, contentKind: _ck, fullText: _ft, ...rest } = row;
    return rest;
  };

  // Compute for /api/headline-feed, extracted so BOTH the route (via
  // serveCoalescedFeed) and the main-feed keep-warm loop (Task #1023, wired
  // after the stream builder below) share the exact same builder.
  const buildHeadlineFeedPayload = async (hours: number, limit?: number) => {
    const feed = await storage.getPrimaryFeed(hours, limit);
    // Strip curated-lane / internal-only fields (attributedClaims,
    // contentKind, fullText) from the public Classic feed response so they
    // never surface to non-curated clients (Task #706/#780).
    return feed.map(item => stripInternalArticleFields(item as any));
  };

  // Headline feed endpoint (accessible to regular users, admins, and Replit-authenticated team members)
  const headlineFeedGuard = createAuthGuard({ allowUser: true, allowAdmin: true, allowReplitAuth: true });
  app.get("/api/headline-feed", headlineFeedGuard, async (req, res) => {
    try {
      const hours = parseInt(req.query.hours as string) || 12;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      
      if (isNaN(hours) || hours < 1) {
        return res.status(400).json({ error: 'Invalid hours parameter' });
      }

      // Short-TTL cache keyed by the only inputs that vary the output (the feed
      // is identical for all authed users for the same params). Honors
      // x-mcop-no-cache. This feed is mostly scraper-driven, but it also blends in
      // human writes (admin moderation + manual/team submissions), so every such
      // write path calls invalidateMainFeeds() to drop this key (and stream).
      const cacheKey = `headline-feed:${hours}:${limit ?? 'all'}`;
      await serveCoalescedFeed(req, res, cacheKey, () => buildHeadlineFeedPayload(hours, limit));
    } catch (error) {
      console.error('Error fetching headline feed:', error);
      res.status(500).json({ error: 'Failed to fetch headline feed' });
    }
  });

  // ===========================================================================
  // Curated View (CV) — curated-only endpoints
  // These power the gated /curated page. They are read-only and never alter any
  // existing MCOP feed/scraper/scoring behavior.
  //
  // TWO access tiers:
  //   requireCuratedView  — canView tier: tester allowlist always, plus any
  //                         standard app-password login user. Used for
  //                         read-only endpoints.
  //   requireCuratedAccess — canEdit tier: editor/tester allowlist ONLY.
  //                          Used for all mutation/moderation endpoints.
  // Both derive from the single resolveCuratedAccess() resolver above.
  // ===========================================================================

  // View-tier: gated on canView (tester always; plus any standard app-password
  // login user). In development, always passes.
  const requireCuratedView = async (req: any, res: Response, next: NextFunction) => {
    const { canView } = await resolveCuratedAccess(req);
    if (canView) return next();
    return res.status(401).json({ error: 'Login required to view Curated' });
  };

  // Editor-tier: tester allowlist only. Keeps all moderation/mutation endpoints
  // restricted to the allowlist regardless of the view reveal.
  const requireCuratedAccess = async (req: any, res: Response, next: NextFunction) => {
    const { canEdit, reason } = await resolveCuratedAccess(req);
    if (canEdit) return next();
    // Distinguish not-logged-in (401) from logged-in-but-not-an-editor (403).
    if (reason === 'not_logged_in') {
      return res.status(401).json({ error: 'Curated editor access required' });
    }
    return res.status(403).json({ error: 'Curated editor access restricted' });
  };

  // Alias: `requireCuratedEditor` is the editor-tier gate under the write-auth
  // hardening. In the app-login access model it is semantically identical to
  // `requireCuratedAccess` (tester allowlist only, dev-bypass in development),
  // so it points at the same middleware. Kept as a named alias so the many
  // mutation endpoints that reference it read intent-first ("editor only").
  const requireCuratedEditor = requireCuratedAccess;

  // ---------------------------------------------------------------------------
  // Curated View feedback inbox
  // POST /api/curated/feedback — view-tier gated; any Curated viewer can submit.
  // GET  /api/curated/feedback — editor-tier gated; list all submissions.
  // POST /api/curated/feedback/:id/review — editor-tier gated; mark reviewed.
  // GET  /api/curated/feedback/unreviewed-count — editor-tier; badge count.
  // ---------------------------------------------------------------------------

  app.post("/api/curated/feedback", requireCuratedView, async (req: any, res) => {
    try {
      // Pre-sanitize anonymous submissions before schema validation so that
      // contact fields (which may be empty/invalid) can never cause a 400 on
      // an anonymous payload — the server is the authority on dropping them.
      const body = req.body ?? {};
      const normalized = body.anonymous
        ? { ...body, contactName: null, contactEmail: null, contactOrg: null, wantsFollowUp: false }
        : body;

      const parsed = insertCuratedViewFeedbackSchema.safeParse(normalized);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
      }
      const data = parsed.data;
      // Non-anonymous follow-up requires an email.
      if (data.wantsFollowUp && !data.anonymous && !data.contactEmail) {
        return res.status(400).json({ error: 'Email is required when requesting follow-up' });
      }
      const row = await storage.createCuratedViewFeedback(data);
      res.json({ ok: true, id: row.id });
    } catch (error) {
      console.error('[curated/feedback] POST error:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  });

  app.get("/api/curated/feedback", requireCuratedEditor, async (_req, res) => {
    try {
      const items = await storage.listCuratedViewFeedback();
      res.json({ items });
    } catch (error) {
      console.error('[curated/feedback] GET error:', error);
      res.status(500).json({ error: 'Failed to load feedback' });
    }
  });

  app.get("/api/curated/feedback/unreviewed-count", requireCuratedEditor, async (_req, res) => {
    try {
      const count = await storage.getCuratedViewFeedbackUnreviewedCount();
      res.json({ count });
    } catch (error) {
      console.error('[curated/feedback] unreviewed-count error:', error);
      res.status(500).json({ error: 'Failed to get count' });
    }
  });

  app.post("/api/curated/feedback/bulk-review", requireCuratedEditor, async (req: any, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown) => typeof x === 'string') : [];
      if (ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
      const reviewedBy = req.user?.claims?.email || 'editor';
      await storage.markCuratedViewFeedbackReviewedBulk(ids, reviewedBy);
      res.json({ ok: true, count: ids.length });
    } catch (error) {
      console.error('[curated/feedback] bulk-review error:', error);
      res.status(500).json({ error: 'Failed to mark reviewed' });
    }
  });

  app.post("/api/curated/feedback/bulk-delete", requireCuratedEditor, async (req: any, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown) => typeof x === 'string') : [];
      if (ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
      await storage.deleteCuratedViewFeedbackBulk(ids);
      res.json({ ok: true, count: ids.length });
    } catch (error) {
      console.error('[curated/feedback] bulk-delete error:', error);
      res.status(500).json({ error: 'Failed to delete feedback' });
    }
  });

  app.post("/api/curated/feedback/:id/review", requireCuratedEditor, async (req: any, res) => {
    try {
      const { id } = req.params;
      const reviewedBy = req.user?.claims?.email || 'editor';
      await storage.markCuratedViewFeedbackReviewed(id, reviewedBy);
      res.json({ ok: true });
    } catch (error) {
      console.error('[curated/feedback] review error:', error);
      res.status(500).json({ error: 'Failed to mark reviewed' });
    }
  });

  app.post("/api/curated/feedback/:id/unreview", requireCuratedEditor, async (req: any, res) => {
    try {
      const { id } = req.params;
      await storage.unmarkCuratedViewFeedbackReviewed(id);
      res.json({ ok: true });
    } catch (error) {
      console.error('[curated/feedback] unreview error:', error);
      res.status(500).json({ error: 'Failed to restore feedback' });
    }
  });

  app.delete("/api/curated/feedback/:id", requireCuratedEditor, async (req: any, res) => {
    try {
      const { id } = req.params;
      await storage.deleteCuratedViewFeedback(id);
      res.json({ ok: true });
    } catch (error) {
      console.error('[curated/feedback] delete error:', error);
      res.status(500).json({ error: 'Failed to delete feedback' });
    }
  });

  // Helper: returns true if the current request is from an editor/tester.
  // Used inline (without middleware) when we need to shape the response
  // differently for editors vs. regular viewers.
  const isCuratedEditor = async (req: any): Promise<boolean> => {
    if (CURATED_DEV_BYPASS) return true;
    const email = req.user?.claims?.email;
    if (!req.isAuthenticated || !req.isAuthenticated() || !email) return false;
    return storage.isCuratedViewTester(email);
  };

  // ---------------------------------------------------------------------------
  // Curated per-user preferences (cross-device settings sync).
  //
  // Gated on basic Replit auth (not requireCuratedView): the preferences table
  // is keyed by Replit OIDC `sub` and is available to every logged-in user
  // regardless of the curated-view reveal tier. Writes are cheap single-row
  // upserts; reads are a single primary-key lookup — neither touches the feed
  // compute or read-cache paths.
  // ---------------------------------------------------------------------------
  app.get("/api/curated/preferences", async (req: any, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user?.claims?.sub) {
      return res.status(401).json({ error: "Replit login required" });
    }
    const userId: string = req.user.claims.sub;
    try {
      const result = await db.execute(
        sql<{ prefs: unknown }>`SELECT prefs FROM curated_user_preferences WHERE user_id = ${userId}`
      );
      const row = result.rows[0];
      return res.json(row ? row.prefs : null);
    } catch (err) {
      console.error("[Prefs] GET failed:", err);
      return res.status(500).json({ error: "Failed to load preferences" });
    }
  });

  app.put("/api/curated/preferences", async (req: any, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user?.claims?.sub) {
      return res.status(401).json({ error: "Replit login required" });
    }
    const userId: string = req.user.claims.sub;
    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Invalid preferences payload" });
    }
    try {
      // Ensure the replit_users row exists before inserting preferences
      // (it is upserted during OAuth, but be defensive against edge cases).
      const claims = (req.user as any)?.claims ?? {};
      await db.execute(sql`
        INSERT INTO replit_users (id, email, first_name, last_name)
        VALUES (
          ${userId},
          ${claims.email ?? null},
          ${claims.first_name ?? null},
          ${claims.last_name ?? null}
        )
        ON CONFLICT (id) DO NOTHING
      `);
      await db.execute(sql`
        INSERT INTO curated_user_preferences (user_id, prefs, updated_at)
        VALUES (${userId}, ${JSON.stringify(body)}::jsonb, NOW())
        ON CONFLICT (user_id) DO UPDATE
          SET prefs = ${JSON.stringify(body)}::jsonb,
              updated_at = NOW()
      `);
      return res.json({ ok: true });
    } catch (err) {
      console.error("[Prefs] PUT failed:", err);
      return res.status(500).json({ error: "Failed to save preferences" });
    }
  });

  // ---------------------------------------------------------------------------
  // Curated read cache (prod perf). The Curated page fans out ~12 read-only
  // requests on every open; under concurrent users + the scheduled crons that
  // exhausted the DB pool ("timeout exceeded when trying to connect"). These
  // feeds only change on the 5-10 min scrape/cluster cycles, so a short in-
  // memory TTL cache collapses the repeat DB work without changing what is
  // shown. CURATED-LANE ONLY: nothing here is read by Classic/Visual/custom-
  // MCOP/public-API, so caching cannot leak cross-lane data. A request may
  // bypass the cache with the `x-mcop-no-cache` header (used by the isolation
  // harness so its inject->read assertions always see fresh data).
  type CuratedCacheEntry = { at: number; ttl: number; data: any };
  const curatedReadCache = new Map<string, CuratedCacheEntry>();
  // Single-flight (request coalescing) registry for the heaviest curated read
  // (/api/curated/top-stories). Keyed by the same cacheKey as curatedReadCache.
  // While one compute is in flight, concurrent callers (the Curated page's
  // ~25s auto-refresh + any user retries) await that SAME promise instead of
  // each launching a fresh, multi-round-trip clustering pass that would contend
  // for the same Neon connections + CPU. CURATED-LANE ONLY.
  const topStoriesInFlight = new Map<string, Promise<any>>();
  // Bound the cache so high-cardinality keys (e.g. cluster-members:<clusterId>)
  // can't grow memory without limit over a long-running prod process. Lazy
  // eviction on read only frees keys that are read again; setCuratedCache also
  // sweeps expired entries and, if still over the cap, drops oldest-inserted
  // keys (Map preserves insertion order).
  const CURATED_CACHE_MAX_KEYS = 500;
  const getCuratedCache = (req: any, key: string): any | undefined => {
    if (req.headers?.['x-mcop-no-cache']) return undefined;
    const e = curatedReadCache.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > e.ttl) { curatedReadCache.delete(key); return undefined; }
    return e.data;
  };
  const setCuratedCache = (key: string, data: any, ttlMs: number): void => {
    curatedReadCache.set(key, { at: Date.now(), ttl: ttlMs, data });
    if (curatedReadCache.size <= CURATED_CACHE_MAX_KEYS) return;
    const now = Date.now();
    for (const k of Array.from(curatedReadCache.keys())) {
      const e = curatedReadCache.get(k);
      if (e && now - e.at > e.ttl) curatedReadCache.delete(k);
    }
    for (const k of Array.from(curatedReadCache.keys())) {
      if (curatedReadCache.size <= CURATED_CACHE_MAX_KEYS) break;
      curatedReadCache.delete(k);
    }
  };
  // Late-binding slot: set after prewarmTopStories is defined further below.
  // Allows invalidateCuratedCache to trigger a warm rebuild on every top-stories
  // invalidation without a forward reference. CURATED-LANE ONLY.
  let _topStoriesPrewarmer: (() => Promise<void>) | null = null;

  const invalidateCuratedCache = (prefix?: string, prewarm = true): void => {
    // Bump the per-process revision counter on EVERY curated cache invalidation.
    // Clients poll /api/curated/revision and trigger a feed refetch when the
    // number changes — the heavy compute only runs on an actual edit.
    bumpCuratedRevision();
    if (!prefix) {
      curatedReadCache.clear();
      // Full clear means top-stories is gone — schedule a background rebuild.
      if (prewarm && _topStoriesPrewarmer) void _topStoriesPrewarmer().catch(() => {});
      return;
    }
    for (const k of Array.from(curatedReadCache.keys())) {
      if (k.startsWith(prefix)) curatedReadCache.delete(k);
    }
    // Warm-on-write: after dropping the top-stories key, proactively rebuild
    // the cache in the background so the next client poll hits a warm response
    // instead of a cold recompute. The prewarmer is a no-op if already warm.
    if (prewarm && prefix === 'top-stories' && _topStoriesPrewarmer) {
      void _topStoriesPrewarmer().catch(() => {});
    }
  };
  // Let background classification jobs (curatedClassify cron, curatedIngest)
  // invalidate this curated-lane read cache on any reclassify write (Task #336)
  // without importing routes.ts. CURATED-LANE ONLY.
  registerCuratedCacheInvalidator(invalidateCuratedCache);

  // ===========================================================================
  // Task #1180 — single SERIAL manual-mutation coordinator. Every editor manual
  // story control (link/merge, unlink, unlink-member, evict, unevict, move,
  // unmove — and their undos) submits its intent HERE instead of open-coding the
  // reshape epilogue. The coordinator serializes applies deterministically, is
  // idempotent per dedupeKey, fails closed on stale targets, runs the SAME
  // bounded reshape / schedulePendingManualReshape / requestCuratedClusteringYield
  // epilogue every route previously duplicated, coalesces bounded background
  // synthesis so it never blocks a later edit, and reports an honest status
  // (applied/persisted/deferred/conflicted/dormant/no-op/failed).
  //
  // The route-specific storage-write + stale-revalidation logic is injected per
  // intent via `payload` (see submitManualMutation). This keeps every hardened
  // semantic (soft social attach, authoritative 2+ merge, overlap consolidation,
  // fail-closed anchors) in the route while the coordinator owns coordination.
  // CURATED-LANE ONLY — no main-feed behavior.
  // ===========================================================================
  interface ManualMutationPayload {
    /** Route-specific stale-target revalidation; omit to skip (defaults live). */
    revalidate?: () => Promise<import('./curatedManualMutationCoordinator').RevalidateResult> | import('./curatedManualMutationCoordinator').RevalidateResult;
    /** Required immutable raw action + durable episode persistence. Throwing
     * prevents the authoritative mutation and leaves the intent retryable. */
    captureRequired: () => Promise<string> | string;
    /** Route-specific storage write. Throw => failed; changed=false => no-op. */
    apply: () => Promise<import('./curatedManualMutationCoordinator').ApplyOutcome> | import('./curatedManualMutationCoordinator').ApplyOutcome;
  }

  // Run the bounded reshape epilogue the routes historically inlined. Called by
  // the coordinator's runCheapReshape (idle path). Returns false when clustering
  // is disabled/skips so the route reports reshaped=false honestly. The follow-up
  // bounded synthesis reshape is fired-and-forgotten via the coordinator's
  // coalesced scheduleBoundedSynthesis, NOT here, so it can never block an edit.
  const runManualCheapReshape = (
    intent: import('./curatedManualMutationCoordinator').ManualMutationIntent,
  ): boolean => {
    // A synthesis-wanting edit is covered by the coordinator's queue-drain hook.
    // Non-synthesis edits enter the SAME process-wide Curated reshape coalescer.
    // The HTTP request never awaits deterministic reshaping.
    if (!intent.wantsSynthesis) {
      schedulePendingManualReshape(false);
    }
    return false;
  };

  // BUSY path: record a deferred reshape (so it lands the instant the lock frees,
  // not the next 5-min cron) and, when the intent names a yield reason, preempt
  // the in-flight full pass so the lock frees in seconds. Mirrors the exact busy
  // branch every route used, with the SAME forceSynthesis / MANUAL_MERGE budget.
  const deferManualReshape = (
    intent: import('./curatedManualMutationCoordinator').ManualMutationIntent,
  ): void => {
    void (async () => {
      try {
        const { schedulePendingManualReshape, requestCuratedClusteringYield } = await import('./curatedCluster');
        schedulePendingManualReshape(intent.forceSynthesis === true, intent.synthesisMaxMs);
        if (intent.yieldReason) requestCuratedClusteringYield(intent.yieldReason);
        console.log(`[manual-mutation:${intent.kind}] Clustering busy — deferred re-shape scheduled${intent.forceSynthesis ? ' (with synthesis)' : ''}`);
      } catch (e) {
        console.warn(`[manual-mutation:${intent.kind}] Deferred re-shape scheduling failed (next cron applies it):`, e instanceof Error ? e.message : e);
      }
    })();
  };

  // COALESCED bounded synthesis: one background synthesis-only reshape covers a
  // whole burst of synthesis-wanting edits. Fire-and-forget — never awaited on
  // any request path — with the SAME bounded MANUAL_MERGE_SYNTHESIS_MAX_MS budget
  // so it releases the single clustering lock promptly. On completion it pushes
  // the fresh headline/facts to clients via one more cache invalidation.
  const scheduleManualBoundedSynthesis = (keys: string[]): void => {
    schedulePendingManualReshape(true, MANUAL_MERGE_SYNTHESIS_MAX_MS_ROUTES);
    if (isCuratedClusteringRunningSync()) {
      requestCuratedClusteringYield('manual synthesis refresh');
    }
    console.log(`[manual-mutation] Coalesced bounded synthesis requested for ${keys.length} edit(s)`);
  };

  const { CuratedManualMutationCoordinator } = await import('./curatedManualMutationCoordinator');
  const manualMutationCoordinator = new CuratedManualMutationCoordinator({
    now: () => Date.now(),
    isClusteringBusy: () => {
      // Synchronous in-process read of the shared clustering lock state.
      try {
        return isCuratedClusteringRunningSync();
      } catch {
        return false;
      }
    },
    revalidateTarget: async (target, intent) => {
      const payload = intent.payload as ManualMutationPayload | undefined;
      if (payload?.revalidate) return payload.revalidate();
      // No route-specific revalidation → the target is treated as live at the
      // revision the route observed (routes that need a stale check supply one).
      return { currentRevision: target.seenRevision, live: true };
    },
    validateIntent: () => null, // routes validate BEFORE building the intent (fail-closed at HTTP 4xx)
    beforeApply: (intent) => {
      const payload = intent.payload as ManualMutationPayload | undefined;
      if (!payload?.captureRequired) {
        throw new Error('manual mutation intent missing captureRequired()');
      }
      return payload.captureRequired();
    },
    finalizeEvidence: async (episodeId, status, note) => {
      const updated = await storage.updateCuratedEditorialOutcome(episodeId, {
        outcome: status,
        outcomeNote: note.slice(0, 500),
        lifecycle: status === 'failed' ? 'contradicted' : 'open',
        verified: false,
        ambiguous: status === 'failed',
      });
      if (!updated) throw new Error(`editorial episode ${episodeId} not found during finalization`);
    },
    applyIntent: (intent) => {
      const payload = intent.payload as ManualMutationPayload | undefined;
      if (!payload?.apply) throw new Error('manual mutation intent missing apply()');
      return payload.apply();
    },
    runCheapReshape: (intent) => runManualCheapReshape(intent),
    deferReshape: (intent) => deferManualReshape(intent),
    invalidateCache: () => {
      // Exact curated cache-invalidation hook — fired once per state-changing
      // intent by the coordinator. Membership changed → drop BOTH curated
      // prefixes (matches every legacy route). NEVER the main feeds.
      // Do not immediately prewarm a top-stories response whose derived
      // membership/synthesis is known to still be stale. The reshape/synthesis
      // completion paths invalidate again and perform the authoritative warm.
      invalidateCuratedCache('top-stories', false);
      invalidateCuratedCache('cluster-members', false);
    },
    scheduleBoundedSynthesis: (keys) => scheduleManualBoundedSynthesis(keys),
    log: (event, detail) => {
      if (event === 'conflicted' || event === 'failed-apply' || event === 'reshape-failed-deferred') {
        console.warn(`[manual-mutation] ${event}`, detail);
      }
    },
  });

  // Small helper: submit an intent and return its terminal result.
  // The payload is contextually typed as ManualMutationPayload so each route's
  // inline apply()/capture() closures get full type-checking (r: result).
  type TypedManualIntent = Omit<import('./curatedManualMutationCoordinator').ManualMutationIntent, 'payload'> & {
    payload: ManualMutationPayload;
  };
  // Monotonic per-process nonce so two SEPARATE HTTP submissions of the same
  // logical grouping remain distinct intents (each re-writes + re-runs the full
  // epilogue, matching legacy route behavior). The coordinator's idempotency
  // therefore only ever collapses a TRUE duplicate — a client that supplies an
  // explicit `Idempotency-Key` (via req.body.idempotencyKey) which yields the
  // SAME dedupeKey twice (e.g. a double-clicked button, a retried POST).
  let _manualMutationNonce = 0;
  // Extract an optional client idempotency key (body field or header) so an exact
  // double-submit collapses to a coordinator no-op instead of writing twice.
  const idempotencyKeyOf = (req: any): string | null => {
    const fromBody = typeof req?.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : null;
    const fromHeader = typeof req?.get === 'function' ? (req.get('Idempotency-Key') || null) : null;
    return fromBody || fromHeader || null;
  };
  const submitManualMutation = async (
    intent: TypedManualIntent,
    idempotencyKey?: string | null,
  ): Promise<import('./curatedManualMutationCoordinator').ManualMutationResult> => {
    // If the caller passes a stable idempotency key, fold it into the dedupeKey so
    // an exact retry collapses to a no-op. Otherwise append a unique nonce so each
    // distinct HTTP request is its own intent (preserves legacy re-submit behavior
    // where re-linking the same items always re-writes + invalidates the cache).
    const suffix = idempotencyKey && idempotencyKey.trim()
      ? `#idem:${idempotencyKey.trim().slice(0, 120)}`
      : `#n:${++_manualMutationNonce}`;
    const dedupeKey = `${intent.dedupeKey}${suffix}`;
    return await manualMutationCoordinator.submit({ ...intent, dedupeKey });
  };

  // ---------------------------------------------------------------------------
  // Non-curated feed cache + single-flight coalescing (prod perf). The full
  // implementation and its detailed rationale now live in ./feedCoalesce.ts so
  // the coalescing edge behavior (leader-failure isolation, in-flight cleanup,
  // x-mcop-no-cache bypass — Task #687) can be exercised by an automated harness
  // without booting Express. Destructuring here keeps every call site below
  // (getFeedCache/setFeedCache/invalidateFeedCache/invalidateMainFeeds/
  // serveCoalescedFeed) byte-identical to the previous inline block.
  const {
    getFeedCache,
    setFeedCache,
    invalidateFeedCache,
    invalidateMainFeeds,
    serveCoalescedFeed,
    prewarmFeed,
    lastFeedReadAt,
    onMainFeedsInvalidated,
  } = createFeedCoalescer();

  // Shared hydration for a cluster's stored members → the DISPLAY shape the
  // detail pop-out renders. Used by BOTH /api/curated/cluster-members (the
  // legacy by-clusterId fetch) AND /api/curated/top-stories (which now embeds
  // each clustered story's members inline). Embedding inline means the card's
  // header count and the detail body come from ONE snapshot, so they can never
  // drift: previously the detail did a SEPARATE by-clusterId fetch, and because
  // clusterId is a hash of the member SET (it changes whenever membership
  // changes) and the members table is fully rewritten every clustering pass,
  // a client holding a now-stale clusterId got [] back → fell to a single-source
  // fallback ("1 contributing source") while the header still showed the old
  // count. Enrichment kept identical to the old inline block: blocked-outlet
  // filter, dead-link overlay (curated:<id>), live curated_items photo/bullets,
  // and per-source spin/alignment from the synthesis cache. Curated-lane only.
  // Cross-pass member-confirmation hysteresis (Task #645). A member is shown
  // once it is either non-provisional (trusted Phase-A core, always shown) OR
  // provisional AND confirmed by ≥2 consecutive passes (the bridge attach +
  // semantic adversary-attach writers persist confirmedStreak; see
  // curatedCluster.ts / curatedIncrementalAttach.ts). This is the SAME gate
  // applied to both the header sourceCount and the detail member list, so
  // they can never drift out of sync with each other. isConfirmedCuratedMember
  // and CURATED_MEMBER_CONFIRM_THRESHOLD are imported from curatedCluster.ts so
  // this file and the unit test share the exact same pure gate function.

  const hydrateCuratedClusterMembers = (
    rows: Array<{
      itemId: string; itemType: string; title: string; source: string; url: string;
      role: string; behaviorClass: any; behaviorLabel: any; contentKind?: any;
      publishedAt: any; createdAt: any; summary: string | null; ogImageUrl: string | null;
    }>,
    memberIndex: ReturnType<typeof buildOutletIndex>,
    linkReplacements: Map<string, string>,
    curatedItemsById: Map<string, { ogImageUrl?: string | null; summaryBullets?: string[] | null; linkDeadAt?: any }>,
    spins: Record<string, any>,
    alignments: Record<string, any>,
    // Editor PHOTO HIDE overlay (Task #380 expansion), keyed by image URL. A
    // member whose photo is hidden has its ogImageUrl nulled below so it drops
    // from the detail member rows / hero set. Curated-lane only.
    hiddenImages: Set<string>,
  ) => {
    const isBlocked = (source: string, url: string) => {
      const o = findOutlet(memberIndex, source, url);
      return (o ? deriveOutletBehavior(o) : deriveBehavior({ factuality: null })).blocked;
    };
    return rows
      .filter((r) => !isBlocked(r.source, r.url)) // Blocked outlets never shown
      .map((r) => {
        const replacementUrl = r.itemType === 'curated'
          ? linkReplacements.get(`curated:${r.itemId}`)
          : undefined;
        const linkDead = r.itemType === 'curated' && !replacementUrl
          && !!curatedItemsById.get(r.itemId)?.linkDeadAt;
        return {
          id: r.itemId,
          itemType: r.itemType,
          title: r.title,
          displayTitle: cleanDisplayTitle(r.title),
          source: r.source,
          url: replacementUrl ?? r.url,
          linkDead,
          role: r.role,
          behaviorClass: r.behaviorClass,
          behaviorLabel: r.behaviorLabel,
          // Page-detected content kind (Task #650) snapshotted at formation
          // time; drives the member row's Opinion/Analysis badge in lockstep
          // with the effective-kind demotion into the attach area.
          contentKind: r.contentKind ?? null,
          publishedAt: r.publishedAt ?? r.createdAt,
          summary: r.summary ?? null,
          // Prefer a real (non-favicon) image: never let a favicon placeholder on
          // the live curated_items row override a real snapshotted hero image.
          ogImageUrl: (() => {
            const pick = (() => {
              const live = curatedItemsById.get(r.itemId)?.ogImageUrl ?? null;
              const snap = r.ogImageUrl ?? null;
              if (live && !isFaviconUrl(live)) return live;
              if (snap && !isFaviconUrl(snap)) return snap;
              return live ?? snap ?? null;
            })();
            // Editor-hidden photo (Task #380 expansion) → null so it drops here too.
            return pick && hiddenImages.has(pick) ? null : pick;
          })(),
          summaryBullets: curatedItemsById.get(r.itemId)?.summaryBullets ?? null,
          spin: spins[`${r.itemType}:${r.itemId}`] ?? null,
          alignment: alignments[`${r.itemType}:${r.itemId}`] ?? null,
        };
      })
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  };

  // Curated lane (Task #203) — "Competing Coverage" / "Aerial View": the world's
  // most-covered news right now (top U.S. + top international), pulled from Google
  // News RSS + Google Trends and ranked by coverage VOLUME, INDEPENDENT of MCOP's
  // own scoring. Served from the dedicated cache table (refreshed by the background
  // job); fail-soft to empty so the panel never breaks the page. Curated-gated;
  // never feeds any shared lane.
  //
  // DEAD-LINK OVERLAY DOES NOT APPLY HERE (confirmed). Unlike Top Stories, cluster
  // detail, and State Controlled Narratives, Aerial View items are NOT curated_items
  // rows — they carry no curated `id` and their links are opaque Google News/Trends
  // redirect URLs (documented to 302 correctly in-browser, not decodable to a
  // publisher URL). The `linkDeadAt` flag + `getCuratedLinkReplacements()` overlay
  // are keyed `curated:<id>`/`main:<id>` and the liveness cron only ever probes
  // curated_items URLs, so there is no join key and no liveness signal for these
  // rows. Joining the overlay here would be a permanent no-op; it is intentionally
  // omitted rather than wired in as dead code.
  app.get("/api/curated/competing-coverage", requireCuratedView, async (req, res) => {
    try {
      const cacheKey = "competing-coverage";
      const cached = getCuratedCache(req, cacheKey);
      if (cached) return res.json(cached);
      const data = await storage.getCompetingCoverage();
      setCuratedCache(cacheKey, data, 60_000);
      res.json(data);
    } catch (err) {
      console.error("[Curated] competing-coverage error:", err);
      res.json({ domestic: [], international: [], buzz: [], updatedAt: null });
    }
  });

  // Curated lane (Task #450) — "State-controlled Narratives". A read-only,
  // per-country lens over the adversary STATE-MEDIA content that already lives in
  // the curated lane: it buckets recent rows by the OUTLET's origin country
  // (registry-provided), restricted to the five designated adversary states
  // (Russia, China, Iran, Cuba, North Korea — Venezuela is explicitly excluded).
  // It surfaces only "contrast"-class state media (news-cpc / low-factuality),
  // never trusted reporting, so it can never inform facts. CURATED-LANE ONLY: it
  // is curated-gated and its output is never read by Classic/Visual/custom-MCOP/
  // public-API. Fail-closed: an unrecognized outlet or country is dropped.
  // Build the State-Controlled Narratives lens payload (extracted from the route
  // so a background pre-warm can keep it cached — users then hit memory instead
  // of the multi-second cold build). CURATED-LANE ONLY: reads exclusively from
  // the curated store + the URL-keyed classification overlay; it never unions the
  // main/primary feed, so the isolation guarantee holds in both directions.
  const STATE_NARRATIVES_TTL_MS = 180_000;
  const buildStateNarrativesPayload = async (hours: number) => {
      // A lens only renders when it clears this freshness/volume floor — this is
      // how sparse countries auto-hide (today only Russia/China/Iran qualify).
      const MIN_LENS_ITEMS = 2;
      // Bound per-country payload: enough for 2-3 top + 1 emerging + a little
      // depth for the detail view, without shipping the whole bucket.
      const PER_COUNTRY_CAP = 8;
      // The designated adversary states (shared with the public state-media lane
      // via @shared/outletRegistry). Venezuela (teleSUR) is excluded by omission.
      // Ordering there drives the default left->right lens order.

      // Lean projection (perf): this lens only needs ~11 fields, so it reads a
      // narrow column set instead of SELECT *. The full curated row carries the
      // heavy article `content` body + attributed claims this lens never uses,
      // and shipping the whole window over the serverless driver was the dominant
      // cold-load cost (the query itself is single-digit ms).
      const [curatedStore, registry, linkReplacements, priorityOverrides, hiddenStoryRows, headlineOverrides] = await Promise.all([
        storage.getCuratedStoreItemsForNarratives(hours),
        storage.getOutletRegistry(),
        // Dead-link overlay (Task #226 / #630), keyed `curated:<id>` — same
        // source Top Stories / cluster detail use. Supplies the healed
        // replacement URL, or (when none exists) marks the item unavailable
        // instead of linking to a known-dead page.
        storage.getCuratedLinkReplacements(),
        // Allowlist-gated priority overrides + editor HIDE overlay — the SAME
        // curated-only overlays Top Stories honors. A pinned priority must
        // reorder this lens and an editor take-down must drop the item here too
        // (both keyed by the stable `curated:<id>` key). Curation writes already
        // invalidate this lens's cache (Task #633); without applying the overlays
        // here those invalidations were no-ops. CURATED-LANE ONLY; fail-closed.
        storage.getCuratedPriorityOverrides(),
        storage.getCuratedHiddenStories(),
        // Editor HEADLINE + BULLETS overlay (Task #176) — the SAME curated-only
        // correction overlay the Top Stories read path applies (keyed by the
        // stable `curated:<id>` key). Without it, a corrected headline still
        // shows the stale stored version in this lens. Display-only: the stored
        // title is never mutated and stays the dedup/gating basis. The
        // replace-headline write endpoint already invalidates this lens's
        // cache, so the correction surfaces on the next cache miss.
        // CURATED-LANE ONLY; fail-closed.
        storage.getCuratedHeadlineOverrides(),
      ]);
      // Flatten the hide overlay into a fast lookup: a story's own stable key
      // PLUS every member key captured at hide-time (so a churned/re-clustered
      // copy stays suppressed). SCN items are all standalone curated rows, so a
      // `curated:<id>` match covers both a direct hide and a cluster-hide that
      // captured this row as a member.
      const hiddenKeys = new Set<string>();
      for (const h of hiddenStoryRows) {
        if (h.key) hiddenKeys.add(h.key);
        for (const mk of h.memberKeys ?? []) hiddenKeys.add(mk);
      }
      const outletIndex = buildOutletIndex(registry);
      // Content-based classification overlay (keyed by URL) — the SAME source the
      // Top Stories "Topic · Focus" label uses. Lets each opened narrative show
      // the curated view's controlled-vocabulary Topic ("Force Posture") and
      // content Focus ("Israel") instead of the free-form category / outlet origin.
      const classMap = await storage.getCuratedClassificationsByUrls(
        Array.from(new Set(curatedStore.map((c) => c.url))),
      );

      type SNItem = {
        id: string; type: 'scraped' | 'manual' | 'curated'; title: string;
        source: string; url: string; category: string; priorityScore: number;
        // Task #631: recency-aware ranking score — the same published-date decay
        // Top Stories uses (`calculateDepreciatedPriority`), anchored to the
        // displayed age. Used ONLY for ordering/interleave/tie-break here; the
        // raw `priorityScore` above is still what's shipped to the client and
        // what the pin/dedup comparisons use, so a single old-but-high-priority
        // item no longer permanently pins the top slot over newer coverage.
        rankingScore: number;
        sourceCount: number; clusterId: string | null;
        articlePublishedAt: string | null; scrapedAt: string;
        // `country` is the OUTLET origin country — the adversary bucket key. The
        // story's own content geography is carried separately below.
        country: string;
        // Controlled-vocabulary classification overlay (curated_classifications),
        // so the opened story detail renders the SAME Topic·Focus as the rest of
        // the curated view. `contentRegion`/`contentCountry` are the story SUBJECT
        // geography (never the outlet origin). Null until classified.
        primaryTopic: string | null; conflictTrack: string | null;
        contentRegion: string | null; contentCountry: string | null;
        countryPair: string[] | null;
        // Already-stored CPC paywall-breaker + AI summary enrichment for this
        // curated row (the SAME fields the cluster detail renders). Surfaced so
        // each narrative row can show more detail; never a live fetch here.
        summary: string | null; summaryBullets: string[] | null;
        // Dead-link overlay (Task #630) — mirrors the Top Stories treatment.
        // `url` below is already the effective DISPLAY url (replacement when
        // present); `linkDead` flags a probe-confirmed-dead item with no
        // healed replacement, so the client never renders it as a normal link.
        linkDead: boolean;
      };
      // Dedupe within the curated store by normalized identity URL; keep the
      // higher-priority copy so the same article (e.g. main:<id>+curated:<id>)
      // surfaces once.
      const byUrl = new Map<string, SNItem>();
      // Defensive date parsing: a single curated row with a malformed/garbage
      // published date must never throw "RangeError: Invalid time value" and take
      // down the whole lens. An unparseable value yields null (sorts oldest).
      const safeIso = (v: any): string | null => {
        if (v == null) return null;
        const t = new Date(v).getTime();
        return Number.isNaN(t) ? null : new Date(t).toISOString();
      };
      const consider = (
        id: string,
        type: 'scraped' | 'manual' | 'curated',
        title: string,
        source: string,
        url: string,
        category: string,
        priorityScore: number,
        articlePublishedAt: any,
        scrapedAt: any,
        contentKind: string | null,
        videoUrl: string | null,
        summary: string | null,
        summaryBullets: string[] | null,
        linkDeadAt: any,
      ) => {
        if (!title || !isSingleWellFormedHttpUrl(url) || source === 'Unknown Source') return;
        const outlet = findOutlet(outletIndex, source, url);
        if (!outlet) return; // fail-closed: unknown outlet -> no origin country
        const country = outlet.originCountry;
        if (!country || !ADVERSARY_COUNTRIES.includes(country)) return;
        const behavior = deriveOutletBehavior(outlet);
        if (behavior.blocked) return; // hard-excluded everywhere
        // Only adversary STATE MEDIA (contrast class). Trusted reporting that
        // happens to be based in one of these countries never appears here.
        if (behavior.label !== 'contrast') return;
        // Social posts and non-article media (video/podcast) are not narrative
        // articles — skip so a lens shows readable headlines, not a raw post.
        const sid = outlet.sourceIdentifier;
        if (typeof sid === 'string' && sid.startsWith('social-')) return;
        if (videoUrl) return;
        if (contentKind === 'video' || contentKind === 'audio' || contentKind === 'podcast') return;
        if (isRoundupDigestTitle(title)) return;
        // Editor HIDE overlay (Task #380) — an editor take-down must drop the
        // item from THIS lens too (keyed by the stable `curated:<id>` key), not
        // just from Top Stories. CURATED-LANE ONLY; fail-closed.
        if (type === 'curated' && hiddenKeys.has(`curated:${id}`)) return;
        // Allowlist-gated priority override (keyed `curated:<id>`) SETS the raw
        // score; honor it in this lens's ranking as well. This lens ranks by the
        // raw stored priority (no decay applied here), so substitute the raw
        // override value directly.
        const override = type === 'curated' ? priorityOverrides.get(`curated:${id}`) : undefined;
        const effectivePriority = override ?? priorityScore;
        // Dead-link overlay (Task #630) — identity/dedup key is always the RAW
        // stored url (stable regardless of replacement); the DISPLAY url below
        // swaps in the healed replacement when one exists.
        const key = normalizeIdentityUrl(url);
        const existing = byUrl.get(key);
        if (existing && existing.priorityScore >= effectivePriority) return;
        const replacementUrl = type === 'curated' ? linkReplacements.get(`curated:${id}`) : undefined;
        const linkDead = type === 'curated' && !replacementUrl && !!linkDeadAt;
        const displayUrl = replacementUrl ?? url;
        // Overlay classification (authoritative when present) → controlled-vocab
        // Topic + content geography for the opened detail; falls back to the
        // row's own category and a deterministic conflict-track guess.
        const cls = classMap.get(url);
        // Editor headline/bullets override (Task #176) — display-only swap,
        // applied AFTER all gating/dedup decisions so the stored title keeps
        // driving identity, roundup, and conflict-track logic.
        const hlOverride = type === 'curated' ? headlineOverrides.get(`curated:${id}`) : undefined;
        const displayTitle = hlOverride?.headline?.trim() ? hlOverride.headline.trim() : title;
        const displayBullets =
          hlOverride?.bullets && hlOverride.bullets.length > 0 ? hlOverride.bullets : summaryBullets;
        // Recency-aware ranking (Task #631): decay on the same published-date
        // curve the rest of the curated view uses, so a stale high-priority
        // item cools instead of permanently pinning the top slot. Anchors to
        // the parsed published date when valid, else first-seen scrapedAt —
        // the same fallback the window filter and display already use, so
        // shown age / inclusion / ranking all agree.
        const pubDate = safeIso(articlePublishedAt);
        // Decay off the effective (override-aware) priority so an active
        // priority override still ranks/decays correctly in this lens.
        const rankingScore = calculateCuratedDepreciatedPriority(
          effectivePriority,
          null,
          new Date(scrapedAt ?? Date.now()),
          null,
          pubDate ? new Date(pubDate) : null,
        ).depreciatedPriority;
        byUrl.set(key, {
          id, type, title: displayTitle, source, url: displayUrl,
          category: cls?.category ?? (category || 'General'),
          priorityScore: effectivePriority,
          rankingScore,
          sourceCount: 1,
          clusterId: null,
          articlePublishedAt: safeIso(articlePublishedAt),
          scrapedAt: safeIso(scrapedAt) ?? new Date(0).toISOString(),
          country,
          primaryTopic: cls?.primaryTopic ?? null,
          conflictTrack: cls?.conflictTrack ?? inferConflictTrack(title, cls?.category ?? category) ?? null,
          contentRegion: cls?.region ?? null,
          contentCountry: cls?.country ?? null,
          countryPair: cls?.countryPair ?? null,
          summary: summary && summary.trim() ? summary.trim() : null,
          summaryBullets:
            Array.isArray(displayBullets) && displayBullets.length > 0
              ? displayBullets
              : null,
          linkDead,
        });
      };

      for (const c of curatedStore) {
        consider(
          c.id, 'curated', c.title, c.source, c.url, c.category,
          c.priorityScore, c.articlePublishedAt, c.scrapedAt,
          c.contentKind ?? null, null,
          c.summary ?? null,
          c.summaryBullets ?? null,
          c.linkDeadAt,
        );
      }

      // Bucket by country, rank by DECAYED priority desc (recency breaks
      // ties), cap. Task #631: ranking uses `rankingScore` (published-date
      // decay, same curve as the rest of the curated view) rather than the
      // raw stored score, so a single old-but-high-priority adversary item no
      // longer permanently pins the top slot over newer coverage for the
      // whole 36h window — recency now meaningfully influences the top slot.
      const tsOf = (it: SNItem) =>
        new Date(it.articlePublishedAt || it.scrapedAt).getTime() || 0;
      // Lens diversity (Task #450 follow-up): one high-volume outlet would
      // otherwise monopolize the priority-ranked per-country slice and hide the
      // rest of the state's media apparatus. Real case: in a 36h window TASS
      // publishes ~10x the volume of RT/Sputnik (228 vs ~28/~27), so a pure
      // priority+recency sort fills the 8-item cap almost entirely with TASS and
      // RT falls outside the cut — making the Russia lens look TASS-only even
      // though RT and Sputnik are present in the curated lane. Round-robin by
      // outlet (groups ordered by their top item's rank, one item drawn per
      // outlet each pass) so the capped slice shows the BREADTH of a country's
      // state media. Within-outlet order (decayed priority desc, recency
      // tie-break) is preserved, and items[0] stays the single top-ranked
      // headline.
      const interleaveByOutlet = (items: SNItem[]): SNItem[] => {
        const groups = new Map<string, SNItem[]>();
        for (const it of items) {
          const g = groups.get(it.source);
          if (g) g.push(it);
          else groups.set(it.source, [it]);
        }
        // `items` arrives priority-sorted, so each group is too and Map insertion
        // order ranks the groups by their lead item.
        const queues = Array.from(groups.values());
        const out: SNItem[] = [];
        for (let round = 0; out.length < items.length; round++) {
          let progressed = false;
          for (const q of queues) {
            if (round < q.length) {
              out.push(q[round]);
              progressed = true;
            }
          }
          if (!progressed) break;
        }
        return out;
      };
      const countries = ADVERSARY_COUNTRIES.map((country) => {
        const all = Array.from(byUrl.values())
          .filter((it) => it.country === country)
          .sort((a, b) =>
            b.rankingScore - a.rankingScore || tsOf(b) - tsOf(a),
          );
        const slice = interleaveByOutlet(all).slice(0, PER_COUNTRY_CAP);
        const latestAt = slice.reduce<number>((mx, it) => Math.max(mx, tsOf(it)), 0);
        // Map to the client shape: each item's geography is the STORY content
        // (contentRegion/contentCountry), NOT the adversary bucket `country`, so
        // the opened detail's Focus reads e.g. "Israel" rather than "Russia".
        const items = slice.map((it) => ({
          id: it.id, type: it.type, title: it.title, source: it.source,
          url: it.url, category: it.category, priorityScore: it.priorityScore,
          sourceCount: it.sourceCount, clusterId: it.clusterId,
          articlePublishedAt: it.articlePublishedAt, scrapedAt: it.scrapedAt,
          summary: it.summary, summaryBullets: it.summaryBullets,
          primaryTopic: it.primaryTopic, conflictTrack: it.conflictTrack,
          region: it.contentRegion, country: it.contentCountry,
          countryPair: it.countryPair,
          linkDead: it.linkDead,
        }));
        return {
          country,
          items,
          count: all.length,
          latestAt: latestAt > 0 ? new Date(latestAt).toISOString() : null,
        };
      })
        // Auto-hide sparse lenses: a country renders only when it clears the
        // freshness/volume floor.
        .filter((c) => c.items.length >= MIN_LENS_ITEMS);

      const payload = { countries, updatedAt: Date.now() };
      return payload;
  };

  app.get("/api/curated/state-narratives", requireCuratedView, async (req, res) => {
    try {
      // Adversary content can be sparser than the main feed, so use a wider
      // default window than Top Stories to give each lens enough to render.
      const hours = parseInt(req.query.hours as string) || 36;
      const cacheKey = `state-narratives:${hours}`;
      const cachedSN = getCuratedCache(req, cacheKey);
      if (cachedSN) return res.json(cachedSN);
      const payload = await buildStateNarrativesPayload(hours);
      // The scrape/cluster/classify cycle invalidates this cache on write, so a
      // longer TTL is safe; the pre-warm below keeps it warm between cycles.
      setCuratedCache(cacheKey, payload, STATE_NARRATIVES_TTL_MS);
      res.json(payload);
    } catch (err) {
      console.error('[state-narratives] error:', err);
      res.status(500).json({ error: 'Failed to build state-controlled narratives' });
    }
  });

  // Pre-warm the State-Controlled Narratives lens (default 36h window) so users
  // never pay the cold build. Cold-only guarded: it rebuilds ONLY when the cache
  // is actually empty/expired, so it does real work at most once per invalidation
  // cycle (not every tick) and naturally de-collides from the curated AI bursts.
  // Single-instance VM (one process) so this warms the SAME Map the route reads.
  // CURATED-LANE ONLY.
  const prewarmStateNarratives = async () => {
    const key = 'state-narratives:36';
    const e = curatedReadCache.get(key);
    if (e && Date.now() - e.at <= e.ttl) return; // still warm — skip
    try {
      const payload = await buildStateNarrativesPayload(36);
      setCuratedCache(key, payload, STATE_NARRATIVES_TTL_MS);
    } catch {
      // best-effort; the route still builds the payload on demand
    }
  };
  const stateNarrativesPrewarmTimer = setInterval(() => { void prewarmStateNarratives(); }, 90_000);
  stateNarrativesPrewarmTimer.unref?.();
  // First warm ~a minute after boot, AFTER the boot warm-up scrape window, to
  // avoid adding to boot-time fan-out on the memory-constrained VM.
  setTimeout(() => { void prewarmStateNarratives(); }, 60_000).unref?.();

  // Pre-warm the Top Stories cache (the heaviest curated read) so the page
  // never pays a cold rebuild on a normal auto-refresh. Cold-only guarded:
  // rebuilds ONLY when the key is empty/expired, so real work runs at most
  // once per TTL cycle and naturally de-collides from curated AI bursts.
  // Warms the SAME per-process curatedReadCache Map the route reads (correct
  // on single-VM Reserved deployment). CURATED-LANE ONLY.
  const prewarmTopStories = async () => {
    const key = `top-stories:${TOP_STORIES_DEFAULT_HOURS}:${TOP_STORIES_DEFAULT_LIMIT}`;
    const e = curatedReadCache.get(key);
    if (e && Date.now() - e.at <= e.ttl) return; // still warm — skip
    try {
      // Stamp the revision the payload reflects (captured BEFORE the build, a
      // conservative lower bound) so warm-cache hits carry it too — the client
      // seeds its change-detection baseline from this field, and the warm path
      // is the common case after any edit. Mirror of the route-level stamp.
      const revisionAtBuild = getCuratedRevision().revision;
      const payload = await buildTopStoriesPayload(TOP_STORIES_DEFAULT_HOURS, TOP_STORIES_DEFAULT_LIMIT);
      payload.revision = revisionAtBuild;
      setCuratedCache(key, payload, TOP_STORIES_CACHE_TTL_MS);
    } catch {
      // best-effort; the route still builds the payload on demand
    }
  };
  const topStoriesPrewarmTimer = setInterval(() => { void prewarmTopStories(); }, 90_000);
  topStoriesPrewarmTimer.unref?.();
  // First warm ~75 s after boot — after the state-narratives first-warm and
  // well after the boot scrape window — to avoid adding to boot fan-out on
  // the memory-constrained VM. 75 s staggers it from the 60 s SN warm.
  setTimeout(() => { void prewarmTopStories(); }, 75_000).unref?.();

  // Wire the late-binding prewarmer slot (see invalidateCuratedCache above) and
  // register it on the bus so background-job invalidations also trigger a warm
  // rebuild. CURATED-LANE ONLY.
  _topStoriesPrewarmer = prewarmTopStories;
  registerCuratedTopStoriesPrewarmer(prewarmTopStories);

  // ---------------------------------------------------------------------------
  // Curated lane — lightweight REVISION endpoint. Returns only the per-process
  // revision counter + timestamp. No DB, no cache compute — trivial payload.
  // Clients poll this at ~12s to detect edits and refetch the heavy feeds only
  // when something actually changed. View-tier gated (requireCuratedView) — the
  // SAME tier as /api/curated/top-stories, so EVERY authenticated curated viewer
  // (standard app login OR tester allowlist), not just editors, polls it and
  // picks up edits within one cycle. Gating it editor-only would silently strand
  // standard viewers on the 120s fallback (the whole point is cross-viewer
  // propagation in ~15s). CURATED-LANE ONLY — never touches main feeds/public API.
  // ---------------------------------------------------------------------------
  app.get("/api/curated/revision", requireCuratedView, (_req, res) => {
    res.json(getCuratedRevision());
  });

  // Curated lane (Task #89) — Top Stories is the UNION of the main feed and the
  // SEPARATE curated store, collapsed by the isolated two-tier clustering:
  //   - Each FORMED story (>= 2 contributing items) emits ONCE as its
  //     representative (always a contributing source), with sourceCount = total
  //     members and the curated clusterId.
  //   - Standalone CONTRIBUTING items appear on their own.
  //   - Standalone ATTACH-ONLY items are DROPPED (never seed) — they surface
  //     ONLY when attached to a formed story (via /cluster-members).
  // This endpoint is curated-gated; it never feeds Classic/Visual/public-API.

  // Cache TTL for Top Stories — aligned with the 120 s auto-refresh so a
  // normal page poll reliably hits a warm cache rather than paying the full
  // cold rebuild on every cycle. Kept ≥ refresh interval so editor
  // invalidations (invalidateCuratedCache("top-stories")) surface promptly
  // and the warmer always runs before the entry expires. CURATED-LANE ONLY.
  const TOP_STORIES_CACHE_TTL_MS = 150_000;
  const TOP_STORIES_DEFAULT_HOURS = 24;
  const TOP_STORIES_DEFAULT_LIMIT = 100;

  // Builder extracted so the pre-warm timer can call it outside the HTTP
  // request lifecycle. Defined inside registerRoutes so it shares the same
  // storage / registry closures the route uses. CURATED-LANE ONLY.
  // feed-strip-exempt: curated-lane builder — served ONLY via requireCuratedView
  // routes (/api/curated/top-stories + pre-warm), which are allowed to
  // serialize attributedClaims/contentKind (public-feed-strip gate, Task #898).
  const buildTopStoriesPayload = async (hours: number, limit: number): Promise<any> => {
      const [feed, curatedStore, clusterMembers, registry, synthesisMap, priorityOverrides, linkReplacements, hiddenStoryRows, imageReplacements, hiddenImages, headlineOverrides, ckOverrides] = await Promise.all([
        storage.getPrimaryFeed(hours),
        storage.getCuratedStoreItems(hours),
        storage.getCuratedClusterMembers(hours),
        storage.getOutletRegistry(),
        storage.getCuratedStorySynthesisMap(),
        // Curated-only manual Priority overrides (allowlist-gated editing). Keyed
        // by `cluster:<clusterId>` for whole clusters or the standalone item's
        // stable curated key (`main:<id>` / `curated:<id>`). Applied here ONLY —
        // never leaks into the main-feed priority columns.
        storage.getCuratedPriorityOverrides(),
        // Curated-only dead-link replacement overlay (Task #226), keyed by
        // `curated:<id>`. When present it supplies the DISPLAY url so a replaced
        // link opens the working article; curated_items.url is never mutated
        // (clustering identity stays stable). Curated-only — never the main feed.
        storage.getCuratedLinkReplacements(),
        // Curated-only editor HIDE overlay (Task #380). Allowlist-gated take-down
        // of a bad curated story. Read ONLY here to EXCLUDE the story from the
        // curated feed; never written to / read by the main feed, Classic/Visual,
        // custom MCOPs, or the public REST API (fail-closed lane isolation).
        storage.getCuratedHiddenStories(),
        // Curated-only editor PHOTO overlays (Task #380 expansion). Single-source
        // image replacement (display-only redirect, keyed `main:<id>`/`curated:<id>`)
        // + hidden cluster member photos (keyed by image URL). Read ONLY here to
        // shape the curated photos; never the main feed / public API (lane isolation).
        storage.getCuratedImageReplacements(),
        storage.getCuratedHiddenImages(),
        // Curated-only editor HEADLINE + BULLETS overlay. Allowlist-gated manual
        // correction to a story's display headline and/or summary bullets. Keyed by
        // the item's stable curated key or cluster id. Applied here ONLY — never the
        // main feed, Classic/Visual, custom MCOPs, or public API (lane isolation).
        storage.getCuratedHeadlineOverrides(),
        // Curated-only per-item human content-kind override (Task #892). An editor
        // can mark any article as analysis/opinion/editorial/other, which demotes
        // it to attach-only and bars it from every curated headline surface. Read
        // ONLY here so the override flows into both the standalone gate and the
        // Top Narratives gate below. Never touches Classic/Visual/custom-MCOP.
        storage.getCuratedContentKindOverrides(),
      ]);
      // Flatten the hide overlay into fast lookups. `hiddenKeys` holds each
      // hidden story's canonical key PLUS every member key captured at hide-time
      // so a re-clustered / churned version of the same story stays suppressed
      // even when its deterministic clusterId or representative changed.
      // `hiddenClusterIds` catches a hidden cluster whose id is unchanged.
      const hiddenKeys = new Set<string>();
      const hiddenClusterIds = new Set<string>();
      for (const h of hiddenStoryRows) {
        if (h.key) hiddenKeys.add(h.key);
        if (h.clusterId) hiddenClusterIds.add(h.clusterId);
        for (const mk of h.memberKeys ?? []) hiddenKeys.add(mk);
      }
      // Map a displayed (possibly churned) story back to the stored hidden-row
      // primary key(s) that cause its suppression, so the editor "Hidden stories"
      // panel can un-hide the RIGHT row(s) even when the story's clusterId or
      // representative changed after a re-cluster. The read path suppresses by
      // key / clusterId / member-key overlap, but the stored row's PRIMARY key
      // (what un-hide deletes by) may no longer equal the story's current key —
      // so we surface the actual stored key(s) for the un-hide call. Matches when
      // the stored key equals this story's key, the stored clusterId equals this
      // cluster's id, this story's key was captured as a stored member key, or any
      // current member key overlaps a stored row key / member key (either way).
      // Curated-lane only; fail-closed (returns [] on no match). (Task #380 fix.)
      const matchingHiddenRecordKeys = (
        selfKey: string | null,
        selfClusterId: string | null,
        memberKeys: string[],
      ): string[] => {
        if (hiddenStoryRows.length === 0) return [];
        const mkSet = new Set(memberKeys);
        const out = new Set<string>();
        for (const h of hiddenStoryRows) {
          const rowMemberKeys = h.memberKeys ?? [];
          const matched =
            (!!selfKey && h.key === selfKey) ||
            (!!selfClusterId && h.clusterId === selfClusterId) ||
            (!!selfKey && rowMemberKeys.includes(selfKey)) ||
            (!!h.key && mkSet.has(h.key)) ||
            rowMemberKeys.some((mk) => mkSet.has(mk));
          if (matched) out.add(h.key);
        }
        return Array.from(out);
      };
      // Pin identity carry by URL (Task #1027, Step 6). A priority pin stored
      // under key `main:<id>` is missed when the same article is represented as
      // `curated:<id>` after a re-cluster (or vice-versa). Build a secondary
      // URL-keyed lookup from the in-memory feed/store — no extra DB round-trips.
      // Primary key lookup always wins; this is a fallback only.
      const pinByNormUrl = new Map<string, number>();
      for (const [pinKey, pinScore] of priorityOverrides.entries()) {
        const parts = pinKey.split(':');
        if (parts.length !== 2) continue;
        const [kType, kId] = parts;
        let kUrl: string | null = null;
        if (kType === 'curated') {
          const ci = curatedStore.find(c => c.id === kId);
          if (ci?.url) kUrl = normalizeIdentityUrl(ci.url);
        } else if (kType === 'main') {
          const fi = feed.find(f => f.id === kId);
          if (fi?.url) kUrl = normalizeIdentityUrl(fi.url);
        }
        if (kUrl && !pinByNormUrl.has(kUrl)) pinByNormUrl.set(kUrl, pinScore);
      }

      const outletIndex = buildOutletIndex(registry);
      // Curated lane — live curated_items (photos/bullets/dead-link) for EVERY
      // curated cluster member, batched once so each cluster's embedded member
      // list is hydrated identically to the /cluster-members detail endpoint.
      // Curated-lane only (reads curated_items exclusively).
      const curatedMemberItemsById = await storage.getCuratedItemsByIds(
        clusterMembers.filter(m => m.itemType === 'curated').map(m => m.itemId),
      );
      // Registry-derived behavior. Role is the 3-value legacy label
      // (contributing | anchor-only | attach-only); blocked outlets are
      // hard-excluded from the curated view entirely (never touches the
      // main feed's own Classic/Visual surfaces).
      // Read-path scale (Task #382): behaviorFor is called repeatedly across the
      // feed/curated/standalone/contrast loops, each time re-running findOutlet
      // (registry lookups) + behavior derivation for the same (source, url). It is
      // a pure function of (source, url) within a request (outletIndex is fixed
      // per request), so memoize per request. Same inputs → same value, so the
      // output is identical; this only collapses the duplicate work.
      const behaviorMemo = new Map<string, ReturnType<typeof deriveOutletBehavior>>();
      const behaviorFor = (source: string, url: string) => {
        const memoKey = `${source ?? ''}\u0000${url ?? ''}`;
        const hit = behaviorMemo.get(memoKey);
        if (hit) return hit;
        const o = findOutlet(outletIndex, source, url);
        const derived = o ? deriveOutletBehavior(o) : deriveBehavior({ factuality: null });
        behaviorMemo.set(memoKey, derived);
        return derived;
      };

      // Social-media members (Truth Social / X / any social-* outlet) may ride
      // along inside a formed cluster but, per product rule, must NEVER supply the
      // story's media — not the card image, not the carousel, not the display
      // base. Detected by the registry source family so it covers every social
      // account (US-official, international, even a low-factuality/CPC social
      // handle that derives to "contrast"). Unregistered handles aren't flagged
      // here, but they already fail closed to attach-only via the role gate so
      // they can never stand alone regardless.
      const isSocialMember = (source: string, url: string) => {
        const o = findOutlet(outletIndex, source, url);
        const sid = o?.sourceIdentifier;
        return typeof sid === 'string' && sid.startsWith('social-');
      };

      // Content-based classification overlay (keyed by URL). The SINGLE source of
      // truth for the "Category · Country/Region" label — covers BOTH the
      // main-feed union rows and the curated store, so every displayed row gets
      // article-content geography (never the outlet's origin). A background job
      // keeps it populated; rows not yet classified fall back to their own
      // category + the client's text heuristic for geography.
      const classUrls = Array.from(new Set([
        ...feed.map((f) => f.url),
        ...curatedStore.map((c) => c.url),
      ]));
      const classMap = await storage.getCuratedClassificationsByUrls(classUrls);

      // Build a normalized lookup for both stores keyed by `${type}:${id}`.
      type Role = 'contributing' | 'anchor-only' | 'attach-only';
      type Norm = {
        id: string; type: 'scraped' | 'manual' | 'curated'; title: string;
        summary: string; summaryBullets: string[] | null; ogImageUrl: string | null;
        // Attributed claims / key statements (Task #256). Shown additively beneath
        // the existing summary/facts; null/empty hides the section.
        attributedClaims: string[] | null;
        videoUrl: string | null; category: string; source: string; url: string;
        // Content-based geography (curated store only; main-feed rows carry null
        // and the client falls back to a keyword heuristic on the story text).
        region: string | null; country: string | null;
        // Controlled-vocabulary classification ENRICHMENT object (Task #336).
        // Read from the curated_classifications overlay; null until classified.
        // CURATED-LANE ONLY — never read by any shared feed.
        primaryTopic: string | null; scope: string | null; conflictTrack: string | null;
        // Two FULL country names for a bilateral story (Topic·Focus Focus slot,
        // Task #336). The ONLY source for a non-conflict two-country focus;
        // tracked-conflict pairs derive from conflictTrack at read time. Null when
        // not bilateral. CURATED-LANE ONLY.
        countryPair: string[] | null;
        // Deterministic source kind (Task #336) derived from lane/table +
        // content kind + the outlet's registry identity. Always populated.
        sourceKind: string;
        // Outlet registry identity fields threaded through so downstream image
        // candidacy + source-spin logic can read them without re-resolving the
        // registry. Null when the outlet is unregistered.
        sourceIdentifier: string | null; otherSourceType: string | null;
        // Outlet PROVENANCE joined from the registry at read time (Task #336):
        // where the OUTLET is based / who owns it — distinct from the story's
        // own subject geography (region/country above). Display/labeling only.
        outletOriginCountry: string | null; outletOriginRegion: string | null;
        outletOwnership: string[];
        // priorityScore is the value shown for STANDALONE cards (main rows carry
        // the time-decayed score; curated rows carry their raw stored score).
        // originalPriority is the RAW, undecayed score — used to (re)compute
        // cluster decay from each member's own age without double-decaying.
        priorityScore: number; originalPriority: number; scrapedAt: any; articlePublishedAt: any;
        role: Role;
        // Page-detected content kind (curated-lane gating). 'audio' = a podcast /
        // audio story kept out of standalone Top Stories / Top Narratives and out
        // of a cluster's face (mirrors how a URL-detected video is excluded). NULL
        // for unchecked rows or normal reported articles.
        contentKind: string | null;
        // Curated enrichment's per-source framing characterization. Main-feed
        // rows do not carry it, while curated rows expose the persisted value.
        sourceSpin: string | null;
        // Dead-link flag (Task #226). True ONLY for curated rows whose article URL
        // a liveness probe confirmed dead (404/410) AND that have no replacement
        // overlay. Main-feed rows are never flagged (false). Display-only.
        linkDead: boolean;
      };
      const byKey = new Map<string, Norm>();
      let yBuildFeed = 0;
      for (const f of feed) {
        if (++yBuildFeed % CURATED_YIELD_CHUNK === 0) await yieldToEventLoop();
        const b = behaviorFor(f.source, f.url);
        if (b.blocked) continue; // blocked outlet — excluded from curated view
        // Content-based classification overlay (keyed by URL). When present it is
        // authoritative; otherwise fall back to the legacy bucket + null geography
        // (the client then applies its text heuristic).
        const cls = classMap.get(f.url);
        const fOutlet = findOutlet(outletIndex, f.source, f.url);
        byKey.set(`main:${f.id}`, {
          id: f.id, type: f.type, title: f.title, summary: f.summary,
          summaryBullets: f.summaryBullets ?? null, ogImageUrl: f.ogImageUrl ?? null,
          attributedClaims: (f as any).attributedClaims ?? null,
          videoUrl: f.videoUrl ?? null, category: cls?.category ?? f.category, source: f.source, url: f.url,
          region: cls?.region ?? null, country: cls?.country ?? null,
          primaryTopic: cls?.primaryTopic ?? null, scope: cls?.scope ?? null,
          // Display-only safety net: when the row was never classified (e.g. the
          // AI generator was down) but its title clearly names a tracked conflict,
          // derive the track deterministically so it still registers as an active
          // conflict. High-precision keyword inference; never off-list. CURATED-LANE.
          conflictTrack: cls?.conflictTrack ?? inferConflictTrack(f.title, cls?.category ?? f.category) ?? null,
          countryPair: cls?.countryPair ?? null,
          sourceKind: deriveSourceKind({
            itemType: f.type, contentKind: (f as any).contentKind ?? null,
            sourceIdentifier: fOutlet?.sourceIdentifier ?? null,
            otherSourceType: fOutlet?.otherSourceType ?? null,
          }),
           sourceIdentifier: fOutlet?.sourceIdentifier ?? null,
           otherSourceType: fOutlet?.otherSourceType ?? null,
          outletOriginCountry: fOutlet?.originCountry ?? null,
          outletOriginRegion: fOutlet?.originRegion ?? null,
          outletOwnership: fOutlet?.ownership ?? [],
          priorityScore: f.depreciatedPriority, originalPriority: f.originalPriority,
          scrapedAt: f.scrapedAt,
          articlePublishedAt: f.articlePublishedAt, role: b.role,
          // Per-item human content-kind override (Task #892), applied at build
          // time against the row's ORIGINAL url (canonical identity) — never
          // the display/replacement url. An 'explainer' mark is preserved as
          // 'explainer' (distinct attach-only badge); every other human-marked
          // kind maps to 'opinion' so the standalone + Top Narratives gates see
          // the demoted value.
          contentKind: (() => { const ov = ckOverrides.has(normalizeIdentityUrl(f.url)) ? ckOverrides.get(normalizeIdentityUrl(f.url)) : undefined; return ov ? (ov === 'explainer' ? 'explainer' : 'opinion') : ((f as any).contentKind ?? null); })(),
          sourceSpin: null,
          linkDead: false, // main-feed rows are never liveness-flagged
        });
      }
      let yBuildCurated = 0;
      for (const c of curatedStore) {
        if (++yBuildCurated % CURATED_YIELD_CHUNK === 0) await yieldToEventLoop();
        // Task #427: defense-in-depth — never surface a curated row whose URL is
        // malformed (e.g. two URLs joined by a space) or whose source never
        // resolved past the junk "Unknown Source" fallback. The admission gate
        // now rejects these at ingest, but this read-time skip drops any such
        // pre-existing row (incl. the historical malformed "Unknown Source" row)
        // from every curated surface immediately on deploy — no prod DB write
        // needed; the row ages out of the store on its own. Curated-lane only.
        if (c.source === 'Unknown Source' || !isSingleWellFormedHttpUrl(c.url)) continue;
        // Blocked is re-derived LIVE (a hard exclusion takes effect immediately,
        // before any re-ingest).
        const cOutlet = findOutlet(outletIndex, c.source, c.url);
        const cBehavior = cOutlet ? deriveOutletBehavior(cOutlet) : deriveBehavior({ factuality: null });
        if (cBehavior.blocked) continue; // blocked — excluded
        // Lane ROLE: re-derive LIVE from the registry when the outlet is
        // REGISTERED, so a registry role change (e.g. an outlet downgraded to
        // attach-only) takes effect immediately rather than waiting for the row
        // to age out. Fall back to the stored ingest-time role ONLY for sources
        // unknown to the registry — curated rows can carry synthetic /
        // unregistered sources that would otherwise fail-closed to attach-only.
        const cLiveRole: Role = cOutlet ? (cBehavior.role as Role) : ((c.role as Role) ?? 'attach-only');
        // Prefer the URL-keyed overlay (authoritative + repairs legacy 'general'
        // rows that predate per-item classification); fall back to the row's own
        // ingest-time classification. Geography is the ARTICLE's subject
        // geography, NOT the outlet's origin.
        const cls = classMap.get(c.url);
        // Dead-link overlay (Task #226). When an allowlisted user has supplied a
        // replacement URL it becomes the DISPLAY url (and the row is no longer
        // "dead"); otherwise the row shows its stored url and is flagged dead when
        // a liveness probe stamped link_dead_at. Classification is still keyed by
        // the ORIGINAL url (c.url) — the overlay only changes the display target.
        const replacementUrl = linkReplacements.get(`curated:${c.id}`);
        const effectiveUrl = replacementUrl ?? c.url;
        byKey.set(`curated:${c.id}`, {
          id: c.id, type: 'curated', title: c.title, summary: c.summary,
          summaryBullets: c.summaryBullets ?? null, ogImageUrl: c.ogImageUrl ?? null,
          attributedClaims: (c as any).attributedClaims ?? null,
          videoUrl: null, category: cls?.category ?? c.category, source: c.source, url: effectiveUrl,
          region: cls?.region ?? c.region ?? null, country: cls?.country ?? c.country ?? null,
          primaryTopic: cls?.primaryTopic ?? null, scope: cls?.scope ?? null,
          // Display-only safety net (see main-feed block above): derive a tracked
          // conflict from the title when the overlay never classified the row.
          conflictTrack: cls?.conflictTrack ?? inferConflictTrack(c.title, cls?.category ?? c.category) ?? null,
          countryPair: cls?.countryPair ?? null,
          sourceKind: deriveSourceKind({
            itemType: 'curated', contentKind: (c as any).contentKind ?? null,
            sourceIdentifier: cOutlet?.sourceIdentifier ?? null,
            otherSourceType: cOutlet?.otherSourceType ?? null,
          }),
           sourceIdentifier: cOutlet?.sourceIdentifier ?? null,
           otherSourceType: cOutlet?.otherSourceType ?? null,
          outletOriginCountry: cOutlet?.originCountry ?? null,
          outletOriginRegion: cOutlet?.originRegion ?? null,
          outletOwnership: cOutlet?.ownership ?? [],
          priorityScore: c.priorityScore, originalPriority: c.priorityScore,
          scrapedAt: c.scrapedAt,
          articlePublishedAt: c.articlePublishedAt,
          role: cLiveRole,
          // Content-kind override checked against the ORIGINAL stored url
          // (c.url), NOT effectiveUrl — a dead-link replacement is a
          // display-only overlay and must never change moderation identity
          // (review fix: the old post-build pass matched item.url, which for
          // replaced rows was the replacement url and silently missed).
          contentKind: (() => { const ov = ckOverrides.has(normalizeIdentityUrl(c.url)) ? ckOverrides.get(normalizeIdentityUrl(c.url)) : undefined; return ov ? (ov === 'explainer' ? 'explainer' : 'opinion') : ((c as any).contentKind ?? null); })(),
          sourceSpin: c.sourceSpin ?? null,
          linkDead: !replacementUrl && !!c.linkDeadAt,
        });
      }

      // Group cluster members by clusterId; track the representative's STORED row
      // (so a story can still render after its live source row churns out of the
      // window), the count, and the full member key list (for the synthesis
      // signature).
      type MemberRow = (typeof clusterMembers)[number];
      const clusters = new Map<string, { repKey: string | null; repMember: MemberRow | null; total: number; keys: string[]; members: MemberRow[] }>();
      const memberKeys = new Set<string>();
      // The SAME article can exist under two keys (main:<id> and curated:<id>)
      // when it was both scraped into the main feed AND cloned into the curated
      // store. Clustering only records ONE of those keys, so the other key would
      // slip past the key-based standalone filter and the article would surface
      // BOTH inside its cluster AND as its own standalone card. Dedup by URL too.
      // Same shared identity normalizer as the clustering pass (collapses
      // tracking-query variants of one article — see server/urlIdentity.ts).
      const normUrl = normalizeIdentityUrl;
      const memberUrls = new Set<string>();
      for (const m of clusterMembers) {
        const key = `${m.itemType}:${m.itemId}`;
        memberKeys.add(key);
        if (m.url) memberUrls.add(normUrl(m.url));
        const entry = clusters.get(m.clusterId) ?? { repKey: null, repMember: null, total: 0, keys: [], members: [] };
        entry.total++;
        entry.keys.push(key);
        entry.members.push(m);
        if (m.isRepresentative) { entry.repKey = key; entry.repMember = m; }
        clusters.set(m.clusterId, entry);
      }

      const stories: any[] = [];

      // 1) One row per FORMED story. Prefer the representative's LIVE row; if it
      //    has churned out of the window (id rotation / aging) fall back to any
      //    other resolvable member, and finally to the representative's STORED
      //    row — so a formed cluster NEVER silently disappears between clustering
      //    passes. Live data (image, AI summary, importance) is overlaid from
      //    whichever members still resolve. The neutral lede + corroborated facts
      //    come from the synthesis cache (keyed by content signature, so it
      //    survives cluster-id churn).
      let yFormed = 0;
      for (const [clusterId, info] of Array.from(clusters.entries())) {
        if (++yFormed % CURATED_YIELD_CHUNK === 0) await yieldToEventLoop();
        const rep = info.repMember;
        if (!rep) continue; // malformed cluster — no representative row
        const liveMembers = info.keys
          .map((k) => byKey.get(k))
          .filter((x): x is Norm => !!x);
        const repLive = info.repKey ? byKey.get(info.repKey) : undefined;
        // Hard read-time guard for the cluster FACE. The clustering engine never
        // elects a social member as representative, but a stale or pre-change
        // persisted cluster row could still carry a social rep. A social post must
        // NEVER be the cluster's face or supply its media, so derive a guaranteed
        // NON-SOCIAL representative for every stored display fallback (title /
        // summary / url / category / date / image). A formed cluster always has
        // >= 2 non-social corroborating members, so a non-social row exists.
        const displayRep =
          (!isSocialMember(rep.source, rep.url) ? rep : undefined)
          ?? info.members.find((m) => !isSocialMember(m.source, m.url))
          ?? rep;
        // Display base: the LIVE rep (only when it's non-social), else the first
        // NON-SOCIAL resolvable member, else the stored displayRep below. A social
        // post is skipped here so it can never become the cluster's face.
        const repLiveSafe =
          repLive && !isSocialMember(repLive.source, repLive.url) ? repLive : undefined;
        const base = repLiveSafe ?? liveMembers.find((x) => !isSocialMember(x.source, x.url));
        // Fail-closed: if NO member resolves live (all churned or now Blocked)
        // AND the display representative's own outlet is Blocked, drop the story
        // rather than surfacing it from the stored rep row. A non-blocked rep that
        // merely aged out of the window still renders (intended).
        if (!base && behaviorFor(displayRep.source, displayRep.url).blocked) continue;
        // Importance: keep the cluster's STRONGEST member, but let that score
        // COOL with age using the same depreciation curve as the rest of the feed
        // (no decay for the first 2h, then -6/hr, floor 20). Each member is
        // decayed by its OWN article age (from the raw, undecayed originalPriority
        // so main-feed rows aren't double-decayed), then we take the max — with
        // two additional invariants enforced by computeClusterPriorityScore:
        //   1. Provisional (not-yet-confirmed) members are excluded so they
        //      cannot move the P badge before passing the hysteresis gate.
        //   2. Late joiners (published > SAME_EVENT_WINDOW_HOURS after their
        //      event window's anchor) are capped to at most LATE_JOINER_LIFT_CAP
        //      points above the cooled-base score, so a 19-minute-old catch-up
        //      piece cannot reset a 20-hour-old story to its raw P85 — UNLESS
        //      the fresh window is CORROBORATED (>= 2 members from >= 2 distinct
        //      publishers published fresh together): a real new development in a
        //      multi-day story then displays its true fresh priority instead of
        //      being pinned to the decayed floor + 10.
        // Build the confirmed-key set (same visibility gate as sourceCount /
        // member list). Ranking authority is narrower below: only confirmed
        // corroborating members may affect P-score or effective freshness.
        const confirmedKeySet = new Set(
          info.members
            .filter(isConfirmedCuratedMember)
            .map((m) => `${m.itemType}:${m.itemId}`),
        );
        // Distinct-publisher identity for fresh-burst corroboration: url host
        // (www-stripped), fallback the source name. Mirrors the >=2-distinct-
        // publishers philosophy of the story-formation gate.
        const publisherKeyOf = (x: { url: string; source: string }): string => {
          try {
            return new URL(x.url).hostname.replace(/^www\./i, '').toLowerCase();
          } catch {
            return (x.source || '').trim().toLowerCase();
          }
        };
        // Map every stored member → MemberScoreInput, overlaying fresher live
        // fields when available. Stored rows keep an aged-out corroborating core
        // rankable; attach/contrast/primary rows stay visible but cannot raise
        // priority or freshness.
        const memberScoreInputs = info.members
          .map((m) => {
            const k = `${m.itemType}:${m.itemId}`;
            const x = byKey.get(k);
            return {
              originalPriority: x?.originalPriority ?? m.priorityScore ?? 50,
              scrapedAt: x?.scrapedAt ?? m.createdAt ?? new Date(),
              articlePublishedAt: x?.articlePublishedAt ?? m.publishedAt,
              confirmed: confirmedKeySet.has(k),
              // Require BOTH the stored per-item behavior and the current live
              // registry behavior to remain corroborating. This preserves
              // content-kind demotions and makes a registry downgrade effective
              // immediately.
              contributesToRanking:
                m.behaviorClass === 'corroborating'
                && behaviorFor(m.source, m.url).cls === 'corroborating',
              publisherKey: publisherKeyOf(x ?? m),
            };
          });
        const hasRankingMember = memberScoreInputs.some(
          (m) => m.confirmed && m.contributesToRanking !== false,
        );
        // A manual all-non-corroborating force-merge has no ranking authority.
        // Use the floor instead of falling back to a social/contrast/primary rep.
        const computedPriority = hasRankingMember
          ? computeClusterPriorityScore(
              memberScoreInputs,
              rep.priorityScore || 50,
              rep.createdAt ?? new Date(),
            )
          : 20;
        // Curated-only editor PHOTO HIDE overlay (Task #380 expansion). An editor
        // can HIDE an individual member's photo (keyed by image URL); a hidden URL
        // must drop from the card thumbnail AND the detail carousel. Applied here
        // ONLY (curated lane) — never the main feed / public API.
        const notHiddenImg = (u: string | null | undefined): u is string =>
          !!u && !hiddenImages.has(u);
        const curatedImageCandidate = (
          item: { ogImageUrl?: string | null; source: string; url: string },
          registryFields?: { sourceIdentifier?: string | null; otherSourceType?: string | null },
        ) => {
          const outlet = registryFields ?? findOutlet(outletIndex, item.source, item.url);
          return {
            imageUrl: item.ogImageUrl,
            isSocial: isSocialMember(item.source, item.url),
            sourceIdentifier: outlet?.sourceIdentifier ?? null,
            otherSourceType: outlet?.otherSourceType ?? null,
          };
        };
        // Card image: rep/base first, else any media-eligible member image, else
        // the stored rep's image — skipping HIDDEN photos. Social, CPC/SWL/EPC,
        // and all registry "Other source" members remain attached/linkable but
        // never populate the card or carousel.
        const { ogImageUrl, memberImages } = selectCuratedStoryImages(
          [
             ...(base ? [curatedImageCandidate(base, base)] : []),
             ...liveMembers.map((x) => curatedImageCandidate(x, x)),
             curatedImageCandidate(displayRep),
          ],
          [
             ...liveMembers.map((x) => curatedImageCandidate(x, x)),
             ...info.members.map((m) => curatedImageCandidate(m)),
          ],
          hiddenImages,
        );
        // All DISTINCT member photos for the clustered-story image carousel
        // (detail hero + main-page card). Primary/base image first, then the
        // FRESH live-member images, then the STORED member images so members that
        // have aged out of the live window (carry-over) still contribute their
        // photo. Deduped by exact URL; HIDDEN photos are dropped.
        // This cluster's currently-HIDDEN, media-eligible member photos surfaced
        // so an editor can UNHIDE them inline. Ineligible source classes do not
        // enter this list, preventing an unhide from appearing to restore them.
        const hiddenImagesForStory = Array.from(
          new Set(
            [
               ...(base ? [curatedImageCandidate(base, base)] : []),
               curatedImageCandidate(displayRep),
               ...liveMembers.map((x) => curatedImageCandidate(x, x)),
               ...info.members.map((m) => curatedImageCandidate(m)),
             ]
               .filter(isEligibleCuratedStoryImageCandidate)
               .map((candidate) => candidate.imageUrl)
               .filter((u): u is string => !!u && hiddenImages.has(u)),
          ),
        );
        // Freshest CORROBORATING-source time for the COLLAPSED cluster card. The
        // representative's own published date can be much older than the newest
        // corroborating source joined hours ago. Attach-only social/OSINT,
        // contrast, and primary-origin members never refresh the effective date
        // or reset a priority pin's decay clock.
        const freshestMemberAt =
          freshestRankingMemberAt(memberScoreInputs)?.toISOString() ?? null;
        // Allowlist-gated manual override for the whole cluster. It SETS the
        // cluster's RAW priority, which then COOLS with age on the SAME
        // depreciation curve as computedPriority — anchored to the freshest
        // contributing source (falling back to the rep's first-seen date). Pins
        // are NOT exempt from time-decay; they cool exactly like every other
        // curated row.
        const clusterOverride = priorityOverrides.get(`cluster:${clusterId}`);
        const overrideAnchor = freshestMemberAt
          ? new Date(freshestMemberAt)
          : null;
        const priorityScore =
          clusterOverride != null && overrideAnchor
            ? calculateCuratedDepreciatedPriority(
                clusterOverride, null, overrideAnchor, null, overrideAnchor,
              ).depreciatedPriority
            : computedPriority;
        // Synthesis is keyed by the story's STABLE stored clusterId (Task #301),
        // so look it up directly — no per-read member-set hash recompute (which
        // re-minted a fresh key on every source-churn and missed the cache).
        const synth = synthesisMap.get(clusterId);
        // Honest "Updated" time (Task #920). The displayed "Updated" must reflect
        // the freshest CONTRIBUTING content the synopsis actually incorporated —
        // never a freshness the text lacks. The synthesis stamps that exact time
        // as `synthesizedThrough`; use it (falling back — for legacy/
        // un-synthesized rows — to the freshest corroborating-member time).
        // Because synthesizedThrough <= freshestMemberAt by construction,
        // the "Updated" time can never lead the synthesized-through content. The
        // priority-decay override anchor below stays on the REAL freshest member
        // time (freshestMemberAt) — this only changes the DISPLAYED timestamp.
        // No corroborating member means no effective freshness: an editor-forced
        // all-social/contrast/primary cluster must not inherit a member timestamp.
        const synopsisUpdatedAt: string | null = synth?.synthesizedThrough
          ? new Date(synth.synthesizedThrough).toISOString()
          : freshestMemberAt;
        // Cross-pass member-confirmation hysteresis (Task #645): withhold any
        // provisional (volatile bridge-attach / semantic adversary-attach)
        // member that hasn't yet been confirmed by >=2 consecutive passes. The
        // trusted Phase-A core is never provisional, so a formed cluster's
        // formation gate (>=2 corroborating) is always satisfied by
        // confirmedMembers alone — this can never wrongly demote a real story.
        // Both the header sourceCount AND the detail member list below read
        // from this SAME filtered set, so they stay in sync.
        const confirmedMembers = info.members.filter(isConfirmedCuratedMember);
        // Display count intentionally includes every confirmed attached source.
        // Ranking boost is based only on confirmed, still-corroborating coverage
        // so social/OSINT/contrast/official-origin pile-ons cannot promote a story.
        const corroboratingSourceCount = confirmedMembers.filter(
          (m) =>
            m.behaviorClass === 'corroborating'
            && behaviorFor(m.source, m.url).cls === 'corroborating',
        ).length;
        // Embed this cluster's hydrated members inline (shared helper) so the
        // detail pop-out renders from the SAME snapshot as the card header.
        // Previously the detail did a SEPARATE by-clusterId fetch; because the
        // clusterId is a hash of the member SET and the members table is fully
        // rewritten each clustering pass, a client holding a now-stale clusterId
        // got [] back → collapsed to a single-source fallback while the header
        // still showed the old count. sourceCount stays confirmedMembers.length
        // (feeds the ranking blend + cluster/single classification); members is
        // display-only — both now hysteresis-gated, so they can never drift.
        const members = hydrateCuratedClusterMembers(
          confirmedMembers, outletIndex, linkReplacements, curatedMemberItemsById,
          synth?.spins ?? {}, synth?.alignments ?? {}, hiddenImages,
        );
        // Dominant-angle fallback headline (Task #1141). When a formed
        // multi-source story has NO synthesized headline yet (synthesis deferred
        // by the pass deadline or a transient LLM failure) and no editor/auto
        // headline override, the card falls back to a member title. The rep is
        // often the NEWEST member — frequently a single outlet's narrow reaction
        // angle — so instead pick the corroborating member whose title best
        // overlaps the OTHER corroborating members' titles (deterministic token
        // overlap, no AI call): the shared underlying development wins. Fail-open
        // to the existing rep fallback when no clear winner exists. DISPLAY-ONLY:
        // only displayTitle/summary/bullets swap; the matching/search `title`,
        // rep identity, media, url, and all synthesis semantics are untouched.
        const clusterHeadlineOv = headlineOverrides.get(`cluster:${clusterId}`);
        const hasDisplayableHeadline =
          !!(clusterHeadlineOv?.headline?.trim()) || !!(synth?.headline?.trim());
        let angleFallback: (typeof members)[number] | null = null;
        if (!hasDisplayableHeadline && members.length >= 2) {
          const pick = pickDominantAngleMember(
            members.map((m) => ({
              key: `${m.itemType}:${m.id}`,
              title: m.title,
              behaviorClass: m.behaviorClass,
              publishedAt: m.publishedAt,
              // Video/podcast/opinion members (show-branded titles like
              // "… | Daybreak Europe 8/18/2026") may vote but never supply the
              // displayed fallback headline.
              eligibleToWin: isEffectivelyReportedArticle(
                m.url, asStoredContentKind(m.contentKind), m.title,
              ),
            })),
          );
          if (pick) {
            angleFallback =
              members.find((m) => `${m.itemType}:${m.id}` === pick.key) ?? null;
          }
        }
        // When the live base churned out (base undefined) the row falls back to
        // the STORED representative — whose category is the raw union bucket. Pull
        // the overlay by the rep's URL so a fully-churned cluster KEEPS its
        // content-based label instead of reverting to "General".
        const repCls = classMap.get(displayRep.url);
        // Cluster category: derive from the DOMINANT specific topic across the
        // cluster's live members (their overlay-applied categories), not just the
        // single display base — so the label reflects the story's true subject and
        // stays stable as individual members churn between passes. Generic labels
        // ('general'/empty) don't vote. Ties break deterministically (display
        // base's own category → highest member priority → lexicographic) so an
        // equal vote never oscillates request-to-request. If EVERY member is
        // generic we keep the existing base/rep fallback chain.
        const baseCategory = base?.category;
        const baseKey = baseCategory && !isGenericCategory(baseCategory) ? baseCategory.trim() : null;
        const categoryVotes = new Map<string, { count: number; maxPriority: number }>();
        for (const m of liveMembers) {
          if (isGenericCategory(m.category)) continue;
          const ck = m.category.trim();
          const prev = categoryVotes.get(ck) ?? { count: 0, maxPriority: -Infinity };
          prev.count += 1;
          prev.maxPriority = Math.max(prev.maxPriority, m.priorityScore ?? 0);
          categoryVotes.set(ck, prev);
        }
        let votedCategory: string | null = null;
        if (categoryVotes.size > 0) {
          votedCategory = Array.from(categoryVotes.entries()).sort((a, b) => {
            if (b[1].count !== a[1].count) return b[1].count - a[1].count;
            if (baseKey) {
              if (a[0] === baseKey && b[0] !== baseKey) return -1;
              if (b[0] === baseKey && a[0] !== baseKey) return 1;
            }
            if (b[1].maxPriority !== a[1].maxPriority) return b[1].maxPriority - a[1].maxPriority;
            return a[0].localeCompare(b[0]);
          })[0][0];
        }
        const clusterCategory =
          votedCategory
          ?? baseKey
          ?? (repCls?.category && !isGenericCategory(repCls.category) ? repCls.category : null)
          ?? (displayRep.category && !isGenericCategory(displayRep.category) ? displayRep.category : null)
          ?? base?.category ?? repCls?.category ?? displayRep.category ?? 'General';
        // Controlled-vocabulary primary_topic for the cluster (Task #336). Vote on
        // the DOMINANT specific topic across live members exactly like the legacy
        // category above, so the structured chip stays stable as members churn.
        // 'Other / Emerging' and null don't vote (treated as non-specific); ties
        // break by base topic → member priority → lexicographic. Falls back to the
        // base/rep overlay topic when every member is non-specific.
        const isSpecificTopic = (t: string | null | undefined): boolean =>
          !!t && t.trim() !== '' && t.trim() !== 'Other / Emerging';
        const basePrimaryTopic = isSpecificTopic(base?.primaryTopic) ? base!.primaryTopic!.trim() : null;
        const topicVotes = new Map<string, { count: number; maxPriority: number }>();
        for (const m of liveMembers) {
          if (!isSpecificTopic(m.primaryTopic)) continue;
          const tk = m.primaryTopic!.trim();
          const prev = topicVotes.get(tk) ?? { count: 0, maxPriority: -Infinity };
          prev.count += 1;
          prev.maxPriority = Math.max(prev.maxPriority, m.priorityScore ?? 0);
          topicVotes.set(tk, prev);
        }
        let votedPrimaryTopic: string | null = null;
        if (topicVotes.size > 0) {
          votedPrimaryTopic = Array.from(topicVotes.entries()).sort((a, b) => {
            if (b[1].count !== a[1].count) return b[1].count - a[1].count;
            if (basePrimaryTopic) {
              if (a[0] === basePrimaryTopic && b[0] !== basePrimaryTopic) return -1;
              if (b[0] === basePrimaryTopic && a[0] !== basePrimaryTopic) return 1;
            }
            if (b[1].maxPriority !== a[1].maxPriority) return b[1].maxPriority - a[1].maxPriority;
            return a[0].localeCompare(b[0]);
          })[0][0];
        }
        const clusterPrimaryTopic =
          votedPrimaryTopic
          ?? basePrimaryTopic
          ?? (isSpecificTopic(repCls?.primaryTopic) ? repCls!.primaryTopic!.trim() : null)
          ?? base?.primaryTopic ?? repCls?.primaryTopic ?? null;
        // Conflict track / scope / provenance / source kind follow the live
        // display base, falling back to the rep's overlay when the base churned.
        const clusterConflictTrack =
          base?.conflictTrack
          ?? repCls?.conflictTrack
          // Display-only safety net: derive from the cluster face's title when no
          // member carried a stored track (e.g. classified while the AI was down).
          ?? inferConflictTrack(base?.title ?? displayRep.title, base?.category ?? repCls?.category ?? null)
          ?? null;
        const clusterScope = base?.scope ?? repCls?.scope ?? null;
        // Two-country Focus pair follows the live display base, falling back to the
        // rep's overlay when the base churned (Topic·Focus model, Task #336).
        const clusterCountryPair = base?.countryPair ?? repCls?.countryPair ?? null;
        stories.push({
          id: base?.id ?? displayRep.itemId,
          type: base?.type ?? (displayRep.itemType === 'curated' ? 'curated' : 'manual'),
          title: base?.title ?? displayRep.title,
          // Display-only cleaned title (strips daily live-blog prefixes). Used as
          // the card/detail fallback when a cluster has no synthesized headline;
          // the original `title` is left intact for matching/search/geo.
          // Dominant-angle fallback (Task #1141): when there is no synthesized/
          // override headline, display the corroborating member title that best
          // represents the cluster's shared development (see angleFallback above)
          // instead of the rep/newest member's own angle.
          displayTitle: angleFallback
            ? cleanDisplayTitle(angleFallback.title)
            : cleanDisplayTitle(base?.title ?? displayRep.title),
          summary: angleFallback
            ? (angleFallback.summary ?? base?.summary ?? '')
            : (base?.summary ?? ''),
          summaryBullets: angleFallback
            ? (angleFallback.summaryBullets ?? base?.summaryBullets ?? null)
            : (base?.summaryBullets ?? null),
          // Editor PHOTO replacement (cluster parity): a display-only override
          // keyed by `cluster:<id>` wins over the derived member-image selection.
          // Member rows' ogImageUrl are never mutated; curated lane only.
          ogImageUrl: imageReplacements.get(`cluster:${clusterId}`) ?? ogImageUrl,
          memberImages: imageReplacements.has(`cluster:${clusterId}`)
            ? [
                imageReplacements.get(`cluster:${clusterId}`)!,
                ...memberImages.filter((u) => u !== imageReplacements.get(`cluster:${clusterId}`)),
              ]
            : memberImages,
          // Editor PHOTO HIDE overlay (Task #380 expansion) — this cluster's
          // currently-hidden member photos, so an editor can UNHIDE them inline.
          // Curated-lane only; rendered solely to editors in the detail pop-out.
          hiddenImages: hiddenImagesForStory,
          videoUrl: base?.videoUrl ?? null,
          category: clusterCategory,
          // Geography follows the live display base (so a clustered story
          // refreshes with whichever member represents it). When the base has
          // churned, fall back to the rep's overlay; else null → client heuristic.
          region: base?.region ?? repCls?.region ?? null,
          country: base?.country ?? repCls?.country ?? null,
          // Controlled-vocabulary classification object (Task #336, curated-lane).
          primaryTopic: clusterPrimaryTopic,
          scope: clusterScope,
          conflictTrack: clusterConflictTrack,
          countryPair: clusterCountryPair,
          sourceKind: base?.sourceKind ?? null,
          outletOriginCountry: base?.outletOriginCountry ?? null,
          outletOriginRegion: base?.outletOriginRegion ?? null,
          outletOwnership: base?.outletOwnership ?? [],
          source: base?.source ?? displayRep.source,
          url: base?.url ?? displayRep.url,
          // Page-detected content kind of the display rep (Task #650). The
          // representative is already picked to be a real reported article
          // (never opinion/audio), so this is normally null for clusters.
          contentKind: base?.contentKind ?? null,
          clusterId,
          priorityScore,
          // An all-non-corroborating force-merge has no legal priority anchor,
          // so do not advertise an inactive stored pin to the client.
          priorityOverride: hasRankingMember ? (clusterOverride ?? null) : null,
          // All-non-corroborating force-merges have no ranking/freshness
          // authority, so do not leak a social/contrast/primary timestamp through
          // the generic scrapedAt fallback.
          scrapedAt: hasRankingMember ? (base?.scrapedAt ?? displayRep.createdAt) : null,
          // Collapsed cluster card shows the FRESHEST contributing source's time
          // (not the representative's older date), matching what users see inside
          // the expanded story. Fall back to the base/rep date if no member date
          // resolves.
          // Honest displayed "Updated"/recency for the cluster card (Task #920):
          // the freshest CONTRIBUTING content the synopsis actually incorporated,
          // never a freshness the text lacks. Falls back to the freshest member
          // time for legacy/un-synthesized rows. (Priority decay still anchors on
          // the real freshest member time via overrideAnchor above.)
          articlePublishedAt: hasRankingMember
            ? (synopsisUpdatedAt ?? freshestMemberAt ?? base?.articlePublishedAt ?? displayRep.publishedAt)
            : null,
          sourceCount: confirmedMembers.length,
          corroboratingSourceCount,
          // Curated lane — the cluster's hydrated members embedded inline so the
          // detail pop-out renders from the SAME snapshot as this card header
          // (no separate by-clusterId fetch that can go stale after a re-cluster).
          members,
          // Live role from the resolvable display base; when the whole cluster
          // has churned out of the window, re-derive the (non-social) display
          // rep's role LIVE from the registry (registered outlets) and fall back
          // to its stored role only for unregistered/synthetic sources.
          role: base?.role
            ?? (() => {
              const ro = findOutlet(outletIndex, displayRep.source, displayRep.url);
              return ro ? (deriveOutletBehavior(ro).role as Role) : ((displayRep.role as Role) ?? 'attach-only');
            })(),
          // Short generalized headline (clusters only); lede shown beneath it.
          // Curated-only editor HEADLINE + BULLETS overlay: when a manual
          // correction exists for this cluster, it overrides the synthesized
          // headline and/or bullets (curated-lane only — never the main feed).
          headline: headlineOverrides.get(`cluster:${clusterId}`)?.headline ?? synth?.headline ?? null,
          lede: synth?.lede || null,
          facts: headlineOverrides.get(`cluster:${clusterId}`)?.bullets ?? (synth && synth.facts.length ? synth.facts : null),
          // Flag the override presence so the client can show "reset to original".
          headlineOverride: headlineOverrides.has(`cluster:${clusterId}`) ? {
            headline: headlineOverrides.get(`cluster:${clusterId}`)!.headline,
            bullets: headlineOverrides.get(`cluster:${clusterId}`)!.bullets,
            claims: headlineOverrides.get(`cluster:${clusterId}`)!.claims,
            // 'human' = editor-set (#176); 'auto' = system-recovered headline.
            provenance: headlineOverrides.get(`cluster:${clusterId}`)!.provenance,
          } : null,
          // Attributed claims / key statements (Task #256). Cluster-level claims
          // come from the synthesis cache; null when none so the section hides.
          attributedClaims: headlineOverrides.get(`cluster:${clusterId}`)?.claims
            ?? (synth && synth.attributedClaims && synth.attributedClaims.length ? synth.attributedClaims : null),
          // Editor HIDE flag (Task #380). True when this cluster is hidden by key,
          // by its (unchanged) clusterId, or because ANY current member key was
          // captured when an earlier (churned) version of the story was hidden.
          hidden:
            hiddenKeys.has(`cluster:${clusterId}`) ||
            hiddenClusterIds.has(clusterId) ||
            info.keys.some((k) => hiddenKeys.has(k)),
          // Stored hidden-row key(s) that suppress THIS cluster, so the editor
          // can un-hide the ORIGINAL row even after the clusterId / rep churned
          // post re-cluster (un-hide by stored key, not by current identity).
          // Empty when not hidden.
          hiddenRecordKeys: matchingHiddenRecordKeys(`cluster:${clusterId}`, clusterId, info.keys),
        });
      }

      // 2) Standalone items not in any formed story. Contributing items appear;
      //    attach-only items are DROPPED (fail-closed — never seed a story).
      //    No synthesis for single-source items (lede/facts null → UI falls back
      //    to the item's own summary).
      const windowMs = hours * 60 * 60 * 1000;
      // Outlet source-types that are commentary / non-reporting (opinion, video,
      // podcast, tabloid). Shared by the standalone Top Stories gate (here) and the
      // Top Narratives gate below so a whole non-news outlet is barred consistently
      // from every curated HEADLINE surface. Cluster MEMBERS remain exempt — a
      // video/podcast/opinion item may still attach to / help form a cluster.
      const NON_NEWS_OUTLET_TYPES = new Set(['opinion', 'video', 'podcast', 'tabloid']);
      let yStandalone = 0;
      for (const [key, item] of Array.from(byKey.entries())) {
        if (++yStandalone % CURATED_YIELD_CHUNK === 0) await yieldToEventLoop();
        if (memberKeys.has(key)) continue;
        // URL-level dedup: an article clustered under its OTHER key (main vs
        // curated) must not also surface as a standalone card.
        if (memberUrls.has(normUrl(item.url))) continue;
        if (item.role !== 'contributing') continue;
        // Drop STANDALONE non-reported content (video, audio/podcast, AND
        // opinion/analysis): a lone video clip, podcast, or an op-ed/analysis
        // column isn't a reported news "story", so it must not seed a
        // single-source Top Story (it renders with a "Video"/"Opinion" badge and
        // no real reporting behind it). isEffectivelyReportedArticle combines the
        // per-URL content kind — deriveContentType (aljazeera.com/video/...,
        // /watch/... for video; /opinion/, /op-ed/, /commentary/, /column/,
        // /editorial/ for opinion) — with the stored page-detected signal (audio
        // fingerprint; page-labeled ANALYSIS/OPINION kicker/JSON-LD/section for a
        // trusted outlet whose URL doesn't reveal it — Task #650). A video or
        // opinion item that CORROBORATES a multi-source cluster is unaffected —
        // those are emitted above (section 1, skipped here via memberKeys) and can
        // still appear in that cluster's "Videos & Opinions" pane.
        if (!isEffectivelyReportedArticle(item.url, asStoredContentKind(item.contentKind), item.title)) continue;
        // Opinion/analysis GENRE also detected via the discrete curated
        // `category` classification (a structured label, NOT a body substring):
        // a trusted outlet's opinion column whose URL carries no /opinion/
        // segment and whose page-detected content_kind wasn't stamped still gets
        // category "Opinion"/"Analysis" at ingest. Bar it from seeding a
        // standalone Top Story — it may still attach to a multi-source cluster as
        // a member (section 1, exempt above via memberKeys). Curated-lane only.
        if (isOpinionGenreCategory(item.category)) continue;
        // Multi-story roundup digest (NPR "Up First", "X resigns. And, Y agrees
        // to a deal"). It stitches two unrelated stories into one title, so it is
        // already barred from clustering (curatedCluster excludes it from the node
        // set); gate it here too so it never surfaces as a lone standalone card.
        if (isRoundupDigestTitle(item.title)) continue;
        const standaloneOutlet = findOutlet(outletIndex, item.source, item.url);
        // Whole non-news outlet (opinion / video / podcast / tabloid) — never a
        // standalone reported story. (Previously only 'opinion' was barred here,
        // which let a video/podcast outlet slip through as a standalone card.)
        if (NON_NEWS_OUTLET_TYPES.has((standaloneOutlet?.otherSourceType || '').trim().toLowerCase())) continue;
        // Age-out gate (STANDALONE only): phase a single-source item out once the
        // ARTICLE itself — its published date, the SAME date the UI shows as
        // "Xd ago" — is older than the feed window. Without this a stale article
        // (e.g. published 2 days ago) lingers as a standalone the moment a source
        // re-lists it, because scrapedAt (first-seen) keeps resetting it inside
        // the window. Formed multi-source stories (emitted above) are exempt, so
        // corroborated coverage still persists when adopted into a cluster.
        const effectiveDate = item.articlePublishedAt ?? item.scrapedAt;
        if (effectiveDate && Date.now() - new Date(effectiveDate).getTime() > windowMs) continue;
        // Content-completeness seeding gate (Task #231): a CURATED standalone
        // item may only SEED a Top Story card when fully populated — a real
        // headline, AI summary bullets present, and a REAL (non-favicon) image.
        // An un-enriched curated row may still ATTACH to a formed cluster
        // (emitted in section 1) but must never surface as a degraded standalone
        // card. It re-qualifies automatically once the existing prefetch/backfill
        // lands its media — no blocking fetch here. Main-feed reuse rows keep
        // their existing behavior (the gate is curated-lane only).
        if (
          item.type === 'curated' &&
          !(
            !!(item.title && item.title.trim()) &&
            Array.isArray(item.summaryBullets) && item.summaryBullets.length > 0 &&
            !!item.ogImageUrl && !isFaviconUrl(item.ogImageUrl)
          )
        ) {
          continue;
        }
        // Allowlist-gated manual override for this single-source item, keyed by
        // its stable curated key (`main:<id>` / `curated:<id>`). When set it
        // SETS the RAW priority, which then decays on the SAME curve as every
        // other curated row — pins are NOT exempt from time-decay.
        // URL-based fallback (Task #1027, Step 6): if a pin was set under the
        // item's prior key (e.g. `main:X` but now surfaced as `curated:X`),
        // carry it forward via the URL-keyed secondary lookup.
        const _nuOverrideItem = item.url ? normalizeIdentityUrl(item.url) : null;
        const itemOverride = priorityOverrides.get(key)
          ?? (_nuOverrideItem ? pinByNormUrl.get(_nuOverrideItem) : undefined);
        // Standalone display priority. Main-feed rows ALREADY arrive decayed from
        // getPrimaryFeed (item.priorityScore === f.depreciatedPriority) — do NOT
        // decay them a second time. Curated-store rows enter with their RAW
        // priorityScore (item.priorityScore === item.originalPriority === the raw
        // curated score), so decay them HERE on the same curve as the main feed,
        // anchored to the article's published date (falling back to scrapedAt).
        // An allowlist-gated override (itemOverride) sets the RAW score and is
        // decayed on that same article-age curve (NOT decay-exempt).
        const standalonePriority =
          itemOverride != null
            ? calculateCuratedDepreciatedPriority(
                itemOverride, null, item.scrapedAt, null, item.articlePublishedAt,
              ).depreciatedPriority
            : item.type === 'curated'
              ? calculateCuratedDepreciatedPriority(
                  item.originalPriority, null, item.scrapedAt, null, item.articlePublishedAt,
                ).depreciatedPriority
              : item.priorityScore;
        stories.push({
          id: item.id, type: item.type, title: item.title,
          // Display-only cleaned title (strips daily live-blog prefixes); the
          // original `title` is left intact for matching/search/geo.
          displayTitle: cleanDisplayTitle(item.title),
          summary: item.summary,
          // Curated-only editor PHOTO replacement (Task #380 expansion). A
          // single-source item's photo can be replaced (URL or pasted image →
          // object storage), keyed by its stable curated key. DISPLAY-only — the
          // row's ogImageUrl is never mutated. Applied here ONLY — never the main
          // feed / Classic/Visual / public API (fail-closed lane isolation).
          ogImageUrl: imageReplacements.get(key) ?? item.ogImageUrl,
          memberImages: (imageReplacements.get(key) ?? item.ogImageUrl)
            ? [imageReplacements.get(key) ?? item.ogImageUrl]
            : [],
          videoUrl: item.videoUrl, category: item.category, source: item.source,
          // Standalone single-source items carry their own ingest-time
          // content-based geography (null for main-feed rows → client heuristic).
          region: item.region ?? null, country: item.country ?? null,
          // Controlled-vocabulary classification object (Task #336, curated-lane).
          primaryTopic: item.primaryTopic ?? null, scope: item.scope ?? null,
          conflictTrack: item.conflictTrack ?? null,
          countryPair: item.countryPair ?? null,
          sourceKind: item.sourceKind ?? null,
          outletOriginCountry: item.outletOriginCountry ?? null,
          outletOriginRegion: item.outletOriginRegion ?? null,
          outletOwnership: item.outletOwnership ?? [],
          url: item.url, clusterId: null,
          priorityScore: standalonePriority,
          priorityOverride: itemOverride ?? null,
          scrapedAt: item.scrapedAt, articlePublishedAt: item.articlePublishedAt,
          sourceCount: 1, role: item.role,
          // Curated-only editor HEADLINE + BULLETS overlay for standalone items.
          // When a manual correction exists, it overrides the raw title display
          // (via the `headline` field the client prefers) and/or the bullets.
          headline: headlineOverrides.get(key)?.headline ?? null,
          summaryBullets: headlineOverrides.get(key)?.bullets ?? item.summaryBullets,
          // Flag the override so the client can show "reset to original".
          headlineOverride: headlineOverrides.has(key) ? {
            headline: headlineOverrides.get(key)!.headline,
            bullets: headlineOverrides.get(key)!.bullets,
            claims: headlineOverrides.get(key)!.claims,
            // 'human' = editor-set (#176); 'auto' = system-recovered headline.
            provenance: headlineOverrides.get(key)!.provenance,
          } : null,
          lede: null, facts: null,
          // Attributed claims / key statements (Task #256) from the single
          // article's enrichment; null when none so the section hides.
          attributedClaims: headlineOverrides.get(key)?.claims
            ?? (item.attributedClaims && item.attributedClaims.length ? item.attributedClaims : null),
          // Per-article angle/framing characterization (Task #937). Reuses the
          // existing cluster-member `spin` field on the client so no new rendering
          // code is needed. Null when absent (section hidden by existing `{a.spin && ...}`).
          spin: item.sourceSpin,
          // Page-detected content kind (Task #650: audio/opinion). Client badge
          // reconciles this with the URL shape via getEffectiveContentKind so the
          // badge matches the same signal that drove server-side filtering.
          contentKind: item.contentKind ?? null,
          // Dead-link flag (Task #226): standalone curated card shows a "link
          // unavailable" state instead of "Open article" when set.
          linkDead: item.linkDead,
          // Editor HIDE flag (Task #380). A standalone story is hidden by its own
          // stable key.
          hidden: hiddenKeys.has(key),
          // Stored hidden-row key(s) that suppress THIS standalone story — its own
          // key, or a stored (cluster) row whose captured memberKeys include it —
          // so un-hide deletes the right row even if the suppressing row is a
          // churned cluster. Empty when not hidden.
          hiddenRecordKeys: matchingHiddenRecordKeys(key, null, [key]),
        });
      }

      // Blend ranking (user-tuned): order by importance/freshness (the
      // depreciated priority) but give corroborated, multi-source stories a
      // BOUNDED boost so big clusters surface near the top — WITHOUT burying
      // high-priority single-source items, which must keep rotating through the
      // hero until clustering is fully dialed in. Boost grows per extra source
      // and is capped so one huge cluster can't dominate the whole feed.
      // Sized against the steep age-depreciation (10 pts/hr after 2h): a heavily
      // corroborated story that is several hours old must still out-rank fresh
      // single-source items, while a lightly-corroborated (2-3 source) story only
      // gets a gentle nudge so fresh, high-importance singles keep rotating in.
      const CORROBORATION_PER_SOURCE = 7; // points per source beyond the first
      const CORROBORATION_MAX_BOOST = 50; // ceiling on the corroboration boost
      const blendScore = (s: any): number => {
        const base = s.priorityScore ?? 0;
        // Visible sourceCount includes attached coverage; only corroborating
        // members earn the multi-source ranking boost.
        const extra = Math.max(
          0,
          (s.corroboratingSourceCount ?? s.sourceCount ?? 1) - 1,
        );
        return base + Math.min(CORROBORATION_MAX_BOOST, extra * CORROBORATION_PER_SOURCE);
      };
      // Defense-in-depth: never emit two stories with the same id. A duplicate id
      // collides as a React key on the client and the view silently drops one of
      // the rows (which can hide a real cluster). Clustering already dedups items
      // across groups; this guard protects the response even if that slips.
      const seenStoryIds = new Set<string>();
      const seenStoryUrls = new Set<string>();
      const dedupedStories = stories.filter(s => {
        if (seenStoryIds.has(s.id)) return false;
        // Also collapse by URL so the same article can't appear twice (e.g. a
        // clustered story and a standalone card sharing one URL). Clustered
        // stories are pushed first, so the cluster row wins the slot.
        const u = normUrl(s.url);
        if (u && seenStoryUrls.has(u)) return false;
        seenStoryIds.add(s.id);
        if (u) seenStoryUrls.add(u);
        return true;
      });
      // Editor HIDE partition (Task #380). Hidden stories are pulled OUT of the
      // ranked feed entirely (so they never consume a slot or appear on any
      // card / detail surface), and surfaced separately so allowlisted editors
      // can review + un-hide them. Curated-lane only — fail-closed.
      const uniqueStories = dedupedStories.filter((s) => !s.hidden);
      // Lightweight summary rows for the editor "Hidden stories" panel — only the
      // fields the un-hide UI needs (no member arrays / synthesis payloads).
      const hiddenStories = dedupedStories
        .filter((s) => s.hidden)
        .map((s) => ({
          id: s.id,
          type: s.type,
          clusterId: s.clusterId,
          title: s.headline || s.displayTitle || s.title,
          source: s.source,
          sourceCount: s.sourceCount,
          scrapedAt: s.scrapedAt,
          articlePublishedAt: s.articlePublishedAt,
          // Article URL so the editor panel can hyperlink the title for a
          // quick source check before deciding to un-hide.
          url: s.url ?? null,
          // The stored hidden-row key(s) to delete on un-hide — survives identity
          // churn so the panel always restores the right row(s). (Task #380 fix.)
          hiddenRecordKeys: s.hiddenRecordKeys ?? [],
        }));

      // -----------------------------------------------------------------------
      // Same-outlet near-duplicate collapse (Task #127). The id/URL dedup above
      // only catches EXACT matches. When one outlet lists the SAME event twice
      // with a lightly-reworded headline (different URL, near-identical title —
      // e.g. ABC News "Saudi Arabia sounds missile alert in area which hosts US
      // forces" vs "…in area home to the Prince Sultan…"), both rows survive and
      // the outlet shows two cards for one story. Collapse those into a single
      // card per outlet/event, keeping the strongest. Treating the SAME outlet
      // covering the SAME event as the duplicate signal is deliberate: two
      // DIFFERENT outlets on the same event are clustering's job and are left
      // untouched here.
      const STORY_STOPWORDS = new Set([
        'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or',
        'but', 'with', 'as', 'by', 'from', 'into', 'over', 'after', 'before',
        'again', 'amid', 'near', 'who', 'which', 'that', 'this', 'is', 'are',
        'was', 'were', 'be', 'has', 'have', 'had', 'will', 'its', 'it', 'about',
        'their', 'his', 'her', 'they', 'he', 'she',
      ]);
      // Lowercase, drop apostrophes (so "iran's" == "irans"), strip remaining
      // punctuation/trailing ellipsis to spaces, then split into a set of
      // SIGNIFICANT tokens (stopwords removed). Numbers are kept (e.g. "100").
      const titleTokens = (t: string): Set<string> => {
        const norm = (t ?? '')
          .toLowerCase()
          .replace(/['\u2018\u2019]/g, '')
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return new Set(
          norm.split(' ').filter((w) => w && !STORY_STOPWORDS.has(w)),
        );
      };
      const normOutlet = (s: string): string => (s ?? '').trim().toLowerCase();
      // Overlap coefficient (intersection / smaller set). Robust to reworded
      // variants where one headline adds detail the other omits. The min-shared-
      // token floor guards against trivial short-title subset matches. Threshold
      // is 0.65 (not the old 0.6): action↔reaction pairs that share only two actor
      // names plus a generic verb — e.g. Sputnik "Israel Launches Airstrikes on
      // Iran" vs "Iran Launches Response Operation Against Israel" — land at exactly
      // 0.60 and must stay separate, while genuinely reworded dupes (the reported
      // ABC News / Al Jazeera pairs land ~0.667 = 6 of 9 shared words, e.g. "Saudi
      // Arabia sounds missile alert in area which hosts US forces" vs "…in area home
      // to the Prince Sultan") sit just above 0.65 and still collapse.
      const NEAR_DUP_THRESHOLD = 0.65;
      const MIN_SHARED_TOKENS = 3;
      // Whole numeric literals pulled from the RAW title BEFORE punctuation is
      // stripped, so decimals stay intact ("6.3" → "6.3", not "6"+"3"). Used to
      // keep sequential/numbered coverage distinct. Matching on whole literals
      // avoids the decimal trap where "6.1" vs "8.1" would falsely share the
      // digit "1" if compared as split tokens.
      const titleNumbers = (t: string): Set<string> => {
        const out = new Set<string>();
        const m = (t ?? '').match(/\d+(?:\.\d+)?/g);
        if (m) m.forEach((n) => out.add(n));
        return out;
      };
      const isNearDuplicate = (
        a: Set<string>, b: Set<string>,
        numsA: Set<string>, numsB: Set<string>,
      ): boolean => {
        if (a.size < MIN_SHARED_TOKENS || b.size < MIN_SHARED_TOKENS) return false;
        let inter = 0;
        a.forEach((t) => { if (b.has(t)) inter++; });
        if (inter < MIN_SHARED_TOKENS) return false;
        // Different-numbers guard: when BOTH headlines carry numbers and share
        // none of them, they describe distinct events — daily war updates
        // ("day 100" vs "day 101") or different magnitudes ("6.3" vs "8.1") —
        // even when the surrounding wording overlaps. Keep both. (If only one
        // side has a number, fall through to the normal similarity check.)
        if (numsA.size && numsB.size) {
          let sharedNum = false;
          numsA.forEach((n) => { if (numsB.has(n)) sharedNum = true; });
          if (!sharedNum) return false;
        }
        return inter / Math.min(a.size, b.size) >= NEAR_DUP_THRESHOLD;
      };
      // Strongest = most complete/important: a formed (multi-source) story over a
      // single card, otherwise higher priority, then a row that already carries an
      // image + AI summary bullets, then a stable id tiebreak.
      const mediaRichness = (s: any): number =>
        (s.ogImageUrl ? 1 : 0) +
        (Array.isArray(s.summaryBullets) && s.summaryBullets.length ? 1 : 0);
      const isStronger = (a: any, b: any): boolean => {
        // Never collapse a corroborated, multi-source story in favor of a single
        // card — losing a formed cluster would be worse than showing a dup. When
        // exactly one side is a cluster, it wins outright.
        const aCluster = (a.sourceCount ?? 1) > 1;
        const bCluster = (b.sourceCount ?? 1) > 1;
        if (aCluster !== bCluster) return aCluster;
        // Otherwise (the common standalone-vs-standalone case): highest priority,
        // then the row that already carries an image + AI summary bullets, then a
        // stable id tiebreak.
        const ap = a.priorityScore ?? 0, bp = b.priorityScore ?? 0;
        if (ap !== bp) return ap > bp;
        const am = mediaRichness(a), bm = mediaRichness(b);
        if (am !== bm) return am > bm;
        return String(a.id) <= String(b.id);
      };
      const storyTokens = uniqueStories.map((s) => ({
        outlet: normOutlet(s.source),
        tokens: titleTokens(s.title),
        numbers: titleNumbers(s.title),
      }));
      // Read-path scale (Task #382): the collapse only ever compares two stories
      // from the SAME outlet, so bucket the candidate indices by outlet first and
      // run the nested compare WITHIN each bucket. This turns the old global
      // O(N^2) scan (which compared every pair and skipped the cross-outlet ones)
      // into O(sum of per-outlet^2), which is far smaller as the curated window
      // grows. Buckets preserve ascending original-index order, and empty-outlet
      // rows are excluded (the old loop's `!a.outlet` guard made them no-ops), so
      // the exact same same-outlet pairs are compared in the exact same order —
      // the resulting `dropped` set, and therefore the output, is identical.
      const dropped = new Set<number>();
      const outletBuckets = new Map<string, number[]>();
      for (let i = 0; i < storyTokens.length; i++) {
        const outlet = storyTokens[i].outlet;
        if (!outlet) continue; // matches the old `!a.outlet` skip
        const bucket = outletBuckets.get(outlet);
        if (bucket) bucket.push(i);
        else outletBuckets.set(outlet, [i]);
      }
      let yNearDup = 0;
      for (const indices of Array.from(outletBuckets.values())) {
        if (++yNearDup % CURATED_YIELD_CHUNK === 0) await yieldToEventLoop();
        for (let x = 0; x < indices.length; x++) {
          const i = indices[x];
          if (dropped.has(i)) continue;
          for (let y = x + 1; y < indices.length; y++) {
            const j = indices[y];
            if (dropped.has(j)) continue;
            const a = storyTokens[i], b = storyTokens[j];
            if (!isNearDuplicate(a.tokens, b.tokens, a.numbers, b.numbers)) continue;
            if (isStronger(uniqueStories[i], uniqueStories[j])) {
              dropped.add(j);
            } else {
              dropped.add(i);
              break; // i itself is collapsed away — stop comparing from it
            }
          }
        }
      }
      const collapsedStories = uniqueStories.filter((_, idx) => !dropped.has(idx));

      collapsedStories.sort((a, b) => blendScore(b) - blendScore(a));

      // -----------------------------------------------------------------------
      // Top Narratives / MCOP Highlights (left column): a US-domestic vs.
      // international split by MEDIA ECOSYSTEM — which press corps is carrying
      // the story. "U.S. Domestic" = what is most prominent among US mainstream
      // outlets (Registry source_identifier `news-us-domestic`); "International"
      // = what is most prominent among international mainstream outlets
      // (`news-international`). Contrast/CPC and non-news outlets are excluded
      // upstream, so both buckets are mainstream-press-only. The story's SUBJECT
      // geography is deliberately NOT the axis here — a US-tariff story carried
      // by a Bangladeshi paper belongs in International (that ecosystem is the
      // one carrying it), and vice versa. Built from the per-ARTICLE byKey map
      // (never the collapsed cluster rows) so individual articles stay eligible
      // whether or not they belong to a cluster. At most ONE article per cluster
      // surfaces across the panel; social posts are never narratives.
      // -----------------------------------------------------------------------
      // Resolve an outlet's source-class identifier. Prefer the stored value;
      // fall back to a legacy origin-derived news class for not-yet-enriched
      // runtime rows that predate an explicit source_identifier. This is the
      // bucketing axis for Top Narratives (media ecosystem) AND the axis for the
      // Top Stories diversity re-rank later.
      const sourceIdentifierFor = (source: string, url: string): string | null => {
        const o = findOutlet(outletIndex, source, url);
        if (!o) return null;
        if (o.sourceIdentifier) return o.sourceIdentifier;
        const country = (o.originCountry || '').trim().toLowerCase();
        if (country === 'united states' || country === 'usa' || country === 'us') return 'news-us-domestic';
        if (country || (o.originRegion || '').trim()) return 'news-international';
        return null;
      };

      // --- Media-ecosystem bucketing (the PUBLISHING outlet's class) ---------
      // US-domestic when the article was published by a US mainstream outlet
      // (source_identifier `news-us-domestic`); international when published by
      // an international mainstream outlet (`news-international`). Any other
      // identifier class (or an unknown outlet) stays unbucketed for the final
      // fill pass — content geography plays NO role in this split.
      type GeoBucket = 'us-domestic' | 'international';
      const narrativeBucketForOutlet = (source: string, url: string): GeoBucket | null => {
        const sid = sourceIdentifierFor(source, url);
        if (sid === 'news-us-domestic') return 'us-domestic';
        if (sid === 'news-international') return 'international';
        return null;
      };

      // key (`${itemType}:${itemId}`) -> clusterId, so each article knows its
      // cluster (null when standalone).
      const keyToClusterId = new Map<string, string>();
      for (const m of clusterMembers) {
        keyToClusterId.set(`${m.itemType}:${m.itemId}`, m.clusterId);
      }

      type NarrativeCand = {
        id: string; type: string; title: string; source: string; url: string;
        category: string;
        priorityScore: number; sourceCount: number; clusterId: string | null;
        bucket: GeoBucket | null;
        scrapedAt: any; articlePublishedAt: any;
      };
      // Dedupe the same article that exists under both a `main:` and `curated:`
      // key by normalized URL (keep the higher-priority copy; carry over any
      // resolved cluster id, the larger source count, and a resolved ecosystem
      // bucket). Social posts are excluded — they are never Top Narratives.
      // NON_NEWS_OUTLET_TYPES is defined once above (shared with the standalone
      // gate): an outlet flagged opinion / video / podcast / tabloid in the
      // registry can never headline a Top Narrative even if its factuality were
      // acceptable. Complements the per-URL content-kind + stored-audio checks.
      const candByUrl = new Map<string, NarrativeCand>();
      let yNarrative = 0;
      for (const [key, item] of Array.from(byKey.entries())) {
        if (++yNarrative % CURATED_YIELD_CHUNK === 0) await yieldToEventLoop();
        if (isSocialMember(item.source, item.url)) continue;
        // Editor HIDE (Task #380): an article hidden by its own key, or whose
        // cluster was hidden, is excluded from the Top Narratives column too —
        // the hide takes the story off EVERY curated read surface.
        if (hiddenKeys.has(key)) continue;
        const itemClusterId = keyToClusterId.get(key);
        if (itemClusterId && hiddenClusterIds.has(itemClusterId)) continue;
        // Contrast sources (CPC / adversary state media — RT, Sputnik, TASS,
        // Global Times, Press TV, … — and any low-factuality outlet) are shown
        // ONLY for contrast ATTACHED to a credible, corroborated story; they are
        // never the headline. They are already barred from standalone Top Stories
        // (the role gate) and from anchoring a cluster representative, so bar them
        // from the Top Narratives left column too — an adversary outlet must never
        // become a headline narrative on its own. A formed cluster always has >=2
        // corroborating members, so it keeps narrative representation via one of
        // those instead. Derived LIVE from the registry. Attach-class outlets
        // (low-factuality news, aggregators, opinion/other) are also barred:
        // the attach contract says they may only ride along inside a formed
        // story ("Additional coverage"), never headline anything on their own.
        {
          const b = behaviorFor(item.source, item.url);
          if (b.label === 'contrast' || b.cls === 'attach') continue;
        }
        // Non-news items are never Top Narratives. isEffectivelyReportedArticle
        // combines: (1) the per-URL content kind — an /opinion/ column or a
        // /video/ clip (commentary or non-reporting, even from a credible
        // outlet); (2) the stored page-detected signal — podcast/audio (NPR
        // audio looks like an article URL) and a page-labeled ANALYSIS/OPINION
        // piece whose URL doesn't reveal it (Task #650). A Top Narrative must be
        // a reported news story.
        if (!isEffectivelyReportedArticle(item.url, asStoredContentKind(item.contentKind), item.title)) continue;
        // Opinion/analysis GENRE via the discrete curated `category` label —
        // mirror of the standalone gate above. Each curated headline surface
        // gates non-news SEPARATELY, so a category-labeled opinion column must be
        // barred from the Top Narratives column too (attach-only). Curated-lane
        // only; cluster members remain exempt.
        if (isOpinionGenreCategory(item.category)) continue;
        // Multi-story roundup digest — a single title stitching two unrelated
        // stories together is never a single Top Narrative (mirrors the standalone
        // gate above and the clustering exclusion).
        if (isRoundupDigestTitle(item.title)) continue;
        const narrativeOutlet = findOutlet(outletIndex, item.source, item.url);
        if (NON_NEWS_OUTLET_TYPES.has((narrativeOutlet?.otherSourceType || '').trim().toLowerCase())) continue;
        const clusterId = keyToClusterId.get(key) ?? null;
        const sourceCount = clusterId ? (clusters.get(clusterId)?.total ?? 1) : 1;
        const cand: NarrativeCand = {
          id: item.id, type: item.type, title: item.title, source: item.source,
          url: item.url, category: item.category ?? 'General',
          priorityScore: item.priorityScore, sourceCount,
          clusterId, bucket: narrativeBucketForOutlet(item.source, item.url),
          scrapedAt: item.scrapedAt, articlePublishedAt: item.articlePublishedAt,
        };
        const nu = normUrl(item.url) || key;
        const existing = candByUrl.get(nu);
        if (!existing) {
          candByUrl.set(nu, cand);
        } else {
          const winner = cand.priorityScore > existing.priorityScore ? cand : existing;
          winner.clusterId = existing.clusterId ?? cand.clusterId;
          winner.sourceCount = Math.max(existing.sourceCount, cand.sourceCount);
          // Keep a resolved ecosystem bucket from EITHER copy (prefer the winner's).
          winner.bucket = winner.bucket ?? (winner === cand ? existing.bucket : cand.bucket);
          candByUrl.set(nu, winner);
        }
      }

      // Rank by individual priority and greedily fill each column to 3, ensuring
      // a cluster contributes at most one article to the whole panel (standalone
      // articles, clusterId null, never block each other).
      const rankedCands = Array.from(candByUrl.values())
        .sort((a, b) => b.priorityScore - a.priorityScore);
      const domestic: any[] = [];
      const international: any[] = [];
      const usedClusters = new Set<string>();
      const toNarrative = (c: NarrativeCand) => ({
        id: c.id, type: c.type, title: c.title, source: c.source, url: c.url,
        category: c.category,
        priorityScore: c.priorityScore, sourceCount: c.sourceCount,
        clusterId: c.clusterId, articlePublishedAt: c.articlePublishedAt,
        scrapedAt: c.scrapedAt,
      });
      const placeNarrative = (c: NarrativeCand, col: any[]): boolean => {
        if (col.length >= 3) return false;
        if (c.clusterId && usedClusters.has(c.clusterId)) return false;
        col.push(toNarrative(c));
        if (c.clusterId) usedClusters.add(c.clusterId);
        return true;
      };
      // Pass 1 — place every article whose outlet has a DEFINITE ecosystem class
      // into its own column (an international-press story is never put in U.S.
      // Domestic and vice versa). Highest individual priority first.
      for (const c of rankedCands) {
        if (domestic.length >= 3 && international.length >= 3) break;
        if (c.bucket === 'us-domestic') placeNarrative(c, domestic);
        else if (c.bucket === 'international') placeNarrative(c, international);
      }
      // Pass 2 — fill any leftover slots from rows whose outlet has no ecosystem
      // class (unknown outlet, or a registry identifier outside the two news
      // classes), so both buckets fill. Domestic is topped up to 3 first, then
      // International; highest priority first within each.
      if (domestic.length < 3 || international.length < 3) {
        for (const c of rankedCands) {
          if (domestic.length >= 3 && international.length >= 3) break;
          if (c.bucket) continue; // definite-bucket rows were handled in pass 1
          if (c.clusterId && usedClusters.has(c.clusterId)) continue;
          if (domestic.length < 3) placeNarrative(c, domestic);
          else placeNarrative(c, international);
        }
      }

      // -----------------------------------------------------------------------
      // Gentle diversity-aware re-rank (Task #142) — Top Stories column ONLY.
      // The blend sort above orders purely by priority + corroboration boost, so
      // a single prolific outlet heavily covering the top beat can fill the head
      // of the feed with a long uniform run (same outlet / same category / same
      // outlet type). This pass SOFTLY spreads out OVER-REPRESENTED individual
      // (single-source) items so other coverage interleaves, while priority
      // stays the dominant signal.
      //
      // Scope & safety:
      //  - Operates only on this curated Top Stories list (collapsedStories). The
      //    topNarratives payload and every other endpoint are untouched.
      //  - Same set, new order — no story is dropped. The id/URL dedup and the
      //    same-outlet near-duplicate collapse already ran above; this is purely a
      //    re-ordering of the already-selected stories.
      //  - CLUSTERED (multi-source) stories are FULLY EXEMPT: never penalized and
      //    never counted toward the over-representation totals. Only individual
      //    (single-source) items absorb a penalty, and only individual items
      //    increment the running diversity counts.
      //  - The penalty is bounded well below the priority/age spread (10 pts/hr
      //    decay), so it can reshuffle near-equal individual items but can never
      //    push a clearly higher-priority story below a clearly lower-priority
      //    one. The leader is never changed (all counts start at zero → the first
      //    pick has no penalty), so a genuinely dominant breaking story still
      //    leads. When the feed is naturally varied (nothing crosses a
      //    threshold) the order is identical to the pure blend sort.
      //
      // Method: cluster rows are FROZEN at their exact blend-sorted slots; only
      // the individual items are permuted (among the individual slots) by a greedy
      // re-rank that repeatedly takes the individual with the highest EFFECTIVE
      // score (blend score minus a diversity penalty based on how
      // over-represented its outlet / category / outlet type already is among the
      // individuals placed so far). This guarantees clusters never move while a
      // saturated individual run gets nudged down so other coverage rises.
      // FREE = how many individual items of a given attribute are allowed before
      // any penalty applies; the (FREE+1)th and beyond are penalized. The
      // prospective occurrence number of the item being weighed is
      // (placedCount + 1), so a penalty applies exactly when
      // (placedCount + 1) > FREE.
      const DIV_OUTLET_FREE = 1;     // 2nd+ same-outlet individual is penalized
      const DIV_OUTLET_STEP = 6;     // points per extra same-outlet individual
      const DIV_CATEGORY_FREE = 2;   // 3rd+ same-category individual is penalized
      const DIV_CATEGORY_STEP = 4;
      const DIV_TYPE_FREE = 3;       // 4th+ same outlet-type individual penalized
      const DIV_TYPE_STEP = 3;
      const DIV_MAX_PENALTY = 18;    // ceiling — gentle vs. the priority spread

      // Outlet type axis: US domestic vs. international, from the same registry
      // resolution the Top Narratives split uses. null (unresolved / social /
      // release without an origin) simply gets no type penalty.
      const divOutletType = (source: string, url: string): 'us' | 'intl' | null => {
        const sid = sourceIdentifierFor(source, url);
        if (sid === 'news-us-domestic') return 'us';
        if (sid === 'news-international') return 'intl';
        return null;
      };
      const divCategory = (s: any): string =>
        (s.category ?? '').toString().trim().toLowerCase() || 'general';
      const divOutlet = (s: any): string => normOutlet(s.source);
      const isIndividual = (s: any): boolean => (s.sourceCount ?? 1) <= 1;

      const outletCounts = new Map<string, number>();
      const categoryCounts = new Map<string, number>();
      const typeCounts = new Map<string, number>();
      // Penalty is computed from the PROSPECTIVE occurrence (placedCount + 1), so
      // an outlet with FREE=1 is penalized starting at its 2nd individual, a
      // category with FREE=2 at its 3rd, and a type with FREE=3 at its 4th.
      const diversityPenalty = (s: any): number => {
        const ok = divOutlet(s);
        const oc = ok ? (outletCounts.get(ok) ?? 0) : 0;
        const cc = categoryCounts.get(divCategory(s)) ?? 0;
        const t = divOutletType(s.source, s.url);
        const tc = t ? (typeCounts.get(t) ?? 0) : 0;
        const p =
          Math.max(0, (oc + 1) - DIV_OUTLET_FREE) * DIV_OUTLET_STEP +
          Math.max(0, (cc + 1) - DIV_CATEGORY_FREE) * DIV_CATEGORY_STEP +
          Math.max(0, (tc + 1) - DIV_TYPE_FREE) * DIV_TYPE_STEP;
        return Math.min(DIV_MAX_PENALTY, p);
      };
      const bumpCounts = (s: any): void => {
        const ok = divOutlet(s);
        if (ok) outletCounts.set(ok, (outletCounts.get(ok) ?? 0) + 1);
        const ck = divCategory(s);
        categoryCounts.set(ck, (categoryCounts.get(ck) ?? 0) + 1);
        const t = divOutletType(s.source, s.url);
        if (t) typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
      };

      // Freeze CLUSTER slots at their exact blend-sorted positions and only
      // permute the INDIVIDUAL items among the individual slots. This guarantees
      // every clustered (multi-source) story "sits wherever its blend score
      // places it" — the diversity nudge can never move a cluster up or down —
      // while still spreading out a saturated run of single-source items.
      const individualSlots: number[] = []; // indices in collapsedStories holding individuals
      const individuals: any[] = [];        // the individual stories, in blend order
      for (let i = 0; i < collapsedStories.length; i++) {
        if (isIndividual(collapsedStories[i])) {
          individualSlots.push(i);
          individuals.push(collapsedStories[i]);
        }
      }
      // Greedy diversity re-rank over INDIVIDUALS ONLY. `individuals` is already a
      // blend-sorted subsequence; repeatedly take the one with the highest
      // effective score (blend minus diversity penalty). The first pick has all
      // counts at zero → no penalty, so the strongest individual is never demoted
      // and a genuinely dominant story still leads.
      const remaining = individuals.slice();
      const reorderedIndividuals: any[] = [];
      // Effective ranking score per story = the score that actually decided its
      // position. For individuals we capture the blend-minus-diversity-penalty
      // value in effect at the moment they were placed (so the tooltip/cutoffs
      // reflect the real, post-diversity ordering — not the pre-diversity blend).
      const effByStory = new Map<any, number>();
      let yDiv = 0;
      while (remaining.length) {
        if (++yDiv % CURATED_YIELD_CHUNK === 0) await yieldToEventLoop();
        let bestIdx = 0;
        let bestScore = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const s = remaining[i];
          const eff = blendScore(s) - diversityPenalty(s);
          if (eff > bestScore) {
            bestScore = eff;
            bestIdx = i;
          }
        }
        const [picked] = remaining.splice(bestIdx, 1);
        reorderedIndividuals.push(picked);
        effByStory.set(picked, bestScore);
        bumpCounts(picked);
      }
      // Clusters are fully diversity-exempt, so their effective ranking score is
      // simply their blend score (the value at which they were frozen into the
      // feed). Individuals use the captured effective score above.
      const effectiveScore = (s: any): number =>
        effByStory.has(s) ? (effByStory.get(s) as number) : blendScore(s);
      // Reinsert the re-ranked individuals into the (frozen) individual slots;
      // cluster rows keep their original blend positions untouched. Same set,
      // new order — nothing is dropped.
      const diversified = collapsedStories.slice();
      for (let k = 0; k < individualSlots.length; k++) {
        diversified[individualSlots[k]] = reorderedIndividuals[k];
      }

      // Ranking-score cutoffs for the allowlist-gated Priority tooltip. The
      // ranking score is each story's EFFECTIVE score — the value that actually
      // decided its slot in the final diversified feed (blend score for
      // diversity-exempt clusters; blend minus diversity penalty for
      // individuals). The top-5 / top-30 cutoffs are the effective score at rank
      // 5 and rank 30 of the FINAL diversified set (post-diversity), i.e. the
      // minimum score a story currently needs to sit in the top 5 / top 30 of
      // what users actually see. Each story carries its own rankingScore so the
      // tooltip can show "this story vs. the bar".
      const effSorted = diversified
        .map((s) => effectiveScore(s))
        .sort((a, b) => b - a);
      const cutoffAt = (rank: number): number | null => {
        if (effSorted.length === 0) return null;
        const idx = Math.min(rank - 1, effSorted.length - 1);
        return effSorted[idx];
      };
      const outStories = diversified
        .slice(0, limit)
        .map((s) => ({ ...s, rankingScore: effectiveScore(s) }));

      const topPayload = {
        stories: outStories,
        topNarratives: { domestic, international },
        rankingCutoffs: { top5: cutoffAt(5), top30: cutoffAt(30) },
        // Editor HIDE overlay (Task #380) — stories currently hidden from the
        // feed, for the allowlist-gated "Hidden stories" review/un-hide panel.
        hiddenStories,
      };
      // A ranking build is the authoritative observer for open PRIORITY
      // episodes. The pin write itself records only `persisted`; this bounded
      // pass verifies the actual displayed score/rank state without inferring
      // success from the overlay row.
      curatedEditorialOutcomeQueue.enqueue(
        'ranking',
        {
          clusterRevision: `ranking:${getCuratedRevision().revision}`,
          keptMembers: outStories.map((s: any, index: number) => ({
            clusterId: s.clusterId ?? `standalone:${s.type}:${s.id}`,
            itemType: s.type,
            itemId: s.id,
            url: s.url,
            priorityScore: s.priorityScore ?? 0,
            isRepresentative: index === 0,
          })),
          mode: 'immediate',
          actionFamilies: ['priority'],
          observedBy: 'rank-build',
        },
      );
    return topPayload;
  };

  app.get("/api/curated/top-stories", requireCuratedView, async (req, res) => {
    // Single-flight bookkeeping — declared outside the try so the catch can
    // settle/clean up the in-flight entry even when the compute throws.
    let inFlightKey: string | null = null;
    let resolveInFlight: ((v: any) => void) | undefined;
    let rejectInFlight: ((e: any) => void) | undefined;
    try {
      // NOTE: These are the conservative server-side DEFAULTS for callers that
      // don't specify params. The full "view 100" (100 cards / 24h window) is an
      // EDITOR-ONLY capability: the editor-gated curated page explicitly requests
      // { hours: 24, limit: 100 }. Keep the default limit small so 100 is only
      // ever served on an explicit (allowlist-gated) request, never as a blanket
      // default.
      // Clamp to safe bounds. Since the curated-view reveal opened this — the
      // heaviest curated read — to ALL app-authenticated viewers (not just the
      // tester allowlist), unbounded hours/limit would let any logged-in user
      // amplify a full clustering/standalone/dedup compute: every distinct param
      // combo bypasses BOTH the read cache and single-flight coalescing. The
      // defaults (18h / 40) and the editor page's explicit 24h / 100 are within
      // these bounds and therefore unchanged.
      const rawHours = parseInt(req.query.hours as string);
      const hours = Math.min(72, Math.max(1, Number.isFinite(rawHours) ? rawHours : 18));
      const rawLimit = req.query.limit ? parseInt(req.query.limit as string) : 40;
      const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 40));

      // Resolve editor status ONCE here so every return path below — cache hit,
      // coalesced waiter, and fresh compute — can strip editor-only fields before
      // sending. The full payload (including hiddenStories) is always stored in
      // the cache; only the response sent to the client is shaped per caller.
      const isEditor = await isCuratedEditor(req);
      // Inline helper: strips hiddenStories for non-editors before sending.
      const sendPayload = (payload: any) => {
        const out = isEditor ? payload : { ...payload, hiddenStories: [] };
        res.json(out);
      };

      const cacheKey = `top-stories:${hours}:${limit}`;
      const cachedTop = getCuratedCache(req, cacheKey);
      if (cachedTop) return sendPayload(cachedTop);

      // Single-flight (request coalescing). The Top Stories compute is the
      // heaviest curated read: ~a dozen DB round-trips plus a full clustering /
      // standalone / dedup pass over the curated superset. When the read cache
      // is cold, the page's ~25s auto-refresh (plus any user retries) can launch
      // several identical heavy computes at once; stacked, they contend for the
      // same Neon connections + CPU so none finishes within the request timeout,
      // the cache never warms, and the panel hangs blank indefinitely. Coalesce
      // concurrent callers onto ONE in-flight compute: the first computes; the
      // rest await it and serve the payload it caches. The isolation harness
      // (x-mcop-no-cache) BYPASSES coalescing so it always sees a fresh,
      // uncoalesced compute (canary / byte-identity guarantees preserved).
      const noCacheTop = !!req.headers?.['x-mcop-no-cache'];
      if (!noCacheTop) {
        const existing = topStoriesInFlight.get(cacheKey);
        if (existing) {
          try {
            const shared = await existing;
            return sendPayload(shared);
          } catch {
            // Leader compute failed — fall through and try once ourselves.
          }
        }
        const p = new Promise<any>((resolve, reject) => {
          resolveInFlight = resolve;
          rejectInFlight = reject;
        });
        p.catch(() => {}); // coalesced waiters attach their own handlers
        topStoriesInFlight.set(cacheKey, p);
        inFlightKey = cacheKey;
      }

      // Capture the revision BEFORE the (multi-round-trip) build so the payload
      // is stamped with a conservative lower bound of the state it reflects: if
      // an edit lands mid-build it also invalidates this cache + triggers a warm
      // rebuild, so the client will still see the revision advance on its next
      // poll. Clients seed their change-detection baseline from this field,
      // which closes the mount race where an edit between the initial feed load
      // and the first poll would otherwise be missed. CURATED-LANE ONLY.
      const revisionAtBuild = getCuratedRevision().revision;
      const topPayload = await buildTopStoriesPayload(hours, limit);
      topPayload.revision = revisionAtBuild;
      setCuratedCache(cacheKey, topPayload, TOP_STORIES_CACHE_TTL_MS);
      if (inFlightKey) {
        resolveInFlight?.(topPayload);
        topStoriesInFlight.delete(inFlightKey);
        inFlightKey = null;
      }
      sendPayload(topPayload);
    } catch (error) {
      if (inFlightKey) {
        rejectInFlight?.(error);
        topStoriesInFlight.delete(inFlightKey);
        inFlightKey = null;
      }
      console.error('Error fetching curated top stories:', error);
      res.status(500).json({ error: 'Failed to fetch curated top stories' });
    }
  });

  // -------------------------------------------------------------------------
  // Scoring Radar (Task #834) — EDITOR-ONLY panel showing recent items that are
  // NOT currently surfacing in Top Stories, with machine-readable reasons for
  // each gate failure. Viewers never call this endpoint (they have no access).
  // Gate logic mirrors buildTopStoriesPayload so the "why" reasons are always
  // in sync with the real exclusion logic. The candidate universe is the SAME
  // union Top Stories draws from — getPrimaryFeed (main lane) + the curated
  // store — deduplicated by identity URL so an article present in both lanes
  // appears once (the curated row wins: it carries enrichment state).
  // Returns { windowHours, feedLimit, cutLineScore, radarCount, surfacingCount,
  //           items: RadarItem[] }.
  // - RadarItem: { id, type, url, title, source, priorityScore, decayedScore,
  //               itemAgeHours, surfacingState, imageUrl, contentKind, category,
  //               isCpc, enrichmentAttempts, lastEnrichmentAt, rescueStatus }
  //   isCpc: registry sourceIdentifier carries the -cpc designation (contrast
  //   lane) — lets the editor panel separate CPC vs non-CPC attach-only items.
  //   (the last three are curated-lane only — the seeding gate and the one-shot
  //   rescue never apply to main rows; null for type 'main').
  // surfacingState values:
  //   'surfacing'    – already in a cluster / standalone top story (skip in panel)
  //   'attach-only'  – outlet role is attach-only (not contributing)
  //   'opinion-video'– gated out by content-kind or otherSourceType
  //   'not-enriched' – no usable bullets or favicon image (seeding gate; curated only)
  //   'age-out'      – older than the active window
  //   'below-cut'    – would pass all gates but score is below the feed cut line
  // -------------------------------------------------------------------------
  const RADAR_CACHE_KEY = 'scoring-radar:v2';
  const RADAR_CACHE_TTL_MS = 30_000; // 30 s — fresh enough for interactive use
  // Single-flight (request coalescing) for the radar compute — same pattern as
  // /api/curated/top-stories. The radar build unions getPrimaryFeed + the full
  // curated store + cluster members; when the 30s cache is cold, concurrent
  // editor requests (view switch + poll) would stack identical heavy computes.
  // Coalesce them onto ONE in-flight build; x-mcop-no-cache bypasses coalescing
  // (harness always sees a fresh, uncoalesced compute).
  let radarInFlight: Promise<any> | null = null;
  // Stage-level diagnostics for the scoring-radar build (Task #1135): the
  // endpoint's generic 500 hid WHERE the heavy aggregate failed. The builder
  // stamps its current stage + key sizing facts here as it progresses; the
  // catch block logs them so the next intermittent failure is diagnosable.
  // Single-flight (radarInFlight) means at most one build runs at a time, so
  // a shared mutable diag object is safe.
  const radarBuildDiag = {
    stage: 'idle' as string,
    windowHours: 0,
    candidateCount: 0,
    radarItemCount: 0,
  };
  type RadarTelemetry = { rawScore: number; decayedScore: number; itemAgeHours: number; surfacingState: string };
  // Shared by the GET endpoint AND the priority-override server-side telemetry
  // fallback (which needs the surfacing state for items the panel never lists,
  // i.e. 'surfacing' ones — hence the separate telemetryByKey map covering
  // EVERY candidate, keyed by the stable story key `main:<id>` / `curated:<id>`).
  const buildScoringRadarPayload = async (): Promise<{ payload: any; telemetryByKey: Map<string, RadarTelemetry> }> => {
      const WINDOW_HOURS = TOP_STORIES_DEFAULT_HOURS;
      const FEED_LIMIT  = TOP_STORIES_DEFAULT_LIMIT;
      const now         = Date.now();
      const NON_NEWS_TYPES = ['opinion', 'video', 'podcast', 'tabloid'];
      const PLACEHOLDER_PATTERNS = ['placeholder', 'default', 'favicon', 'logo', 'clear.gif', '1x1', 'pixel', 'spacer'];
      const isPlaceholderImg = (url?: string | null): boolean => {
        if (!url) return true;
        if (isFaviconUrl(url)) return true;
        const lower = url.toLowerCase();
        return PLACEHOLDER_PATTERNS.some((p) => lower.includes(p));
      };
      const isEnriched = (item: { summaryBullets?: any; ogImageUrl?: string | null }): boolean => {
        const hasBullets = Array.isArray(item.summaryBullets) && item.summaryBullets.length > 0;
        const hasImage   = !isPlaceholderImg(item.ogImageUrl);
        return hasBullets && hasImage;
      };
      const ageHours = (item: { articlePublishedAt?: Date | null; scrapedAt: Date }): number => {
        const effectiveMs = getCuratedEffectiveAgeAnchor(
          item.scrapedAt,
          item.articlePublishedAt ?? null,
          now,
        ).getTime();
        return Math.max(0, (now - effectiveMs) / 3_600_000);
      };

      radarBuildDiag.stage = 'data-fetch';
      radarBuildDiag.windowHours = WINDOW_HOURS;
      radarBuildDiag.candidateCount = 0;
      radarBuildDiag.radarItemCount = 0;
      // Load all the data in parallel — the SAME two lanes buildTopStoriesPayload
      // unions (main feed + curated store), plus cluster membership + overrides.
      const [feed, rawItems, rawMembers, overridesMap, registry] = await Promise.all([
        storage.getPrimaryFeed(WINDOW_HOURS + 6),       // main lane (small buffer)
        storage.getCuratedStoreItems(WINDOW_HOURS + 6), // curated lane
        storage.getCuratedClusterMembers(WINDOW_HOURS + 6),
        storage.getCuratedPriorityOverrides(), // returns Map<key, score>
        storage.getOutletRegistry(),
      ]);

      radarBuildDiag.stage = 'candidate-normalize';
      const outletIdx = buildOutletIndex(registry);

      // Items already IN an active cluster are surfacing. Keyed by the member's
      // LANE (itemType — the `source` column on member rows is the OUTLET name,
      // never 'main'/'curated') plus the identity URL, so an article clustered
      // under its OTHER key (main vs curated) also counts as surfacing — the
      // same dual-key rule the standalone display path applies (memberUrls).
      const inClusterKeys = new Set<string>();
      const clusteredUrls = new Set<string>();
      for (const m of rawMembers) {
        inClusterKeys.add(`${m.itemType}:${m.itemId}`);
        if (m.url) {
          const nu = normalizeIdentityUrl(m.url);
          if (nu) clusteredUrls.add(nu);
        }
      }

      // -----------------------------------------------------------------------
      // Normalize BOTH lanes into one candidate list — mirrors the byKey build
      // in buildTopStoriesPayload (main rows ~line 2082, curated rows ~2120).
      // -----------------------------------------------------------------------
      type Candidate = {
        key: string; id: string; type: 'main' | 'curated';
        url: string; title: string; source: string;
        rawScore: number; effective: number; ageH: number;
        role: string; otherType: string; contentKind: string | null;
        isCpc: boolean; // registry sourceIdentifier ends in -cpc (contrast lane)
        passesSeedingGate: boolean; // seeding gate is CURATED-LANE only — main rows always true
        imageUrl: string | null; category: string | null;
        enrichmentAttempts: number | null; lastEnrichmentAt: Date | null;
        // A manual priority override (P-pin) exists for this row. The radar's
        // "scored too low" list must EXCLUDE these — an editor-decayed item is
        // not an AI miss, and re-promoting it would fight the editor's call.
        hasOverride: boolean;
        // For bridge-faithful attach recommendation: body text and eligibility lane.
        summary: string | null;
        articlePublishedAt: Date | null;
        firstSeenAt: Date | null;
        publishedAt: Date | null;
        // Enriched content fields — included in the radar payload so the
        // link/merge dialog's enriched search can match below-cut items on
        // the same field set the global search uses.
        summaryBullets: string[] | null;
        attributedClaims: string[] | null;
        facts: string[] | null;
        matchedKeywords: string[] | null;
        // Which lane this candidate falls into for the incremental-attach bridge:
        // 'contributing' = trusted news; 'contrast' = adversary CPC state-media;
        // 'skip' = everything the bridge fail-closes (social, blocked, unknown,
        // non-CPC contrast, opinion/analysis). 'manual-only' is derived from 'skip'.
        bridgeLane: 'contributing' | 'contrast' | 'skip';
      };
      // CPC designation comes straight from the registry identifier — the same
      // signal deriveOutletBehavior uses for its contrast master switch. Unknown
      // outlets are non-CPC (there is no identifier to carry the designation).
      const outletIsCpc = (outlet: { sourceIdentifier?: string | null } | null | undefined): boolean =>
        ((outlet?.sourceIdentifier || '').trim().toLowerCase()).endsWith('-cpc');
      const candidates: Candidate[] = [];
      const seenUrls = new Set<string>();

      // Curated lane FIRST so a same-article main-feed duplicate collapses into
      // the curated row (which carries enrichment/rescue state).
      for (const item of rawItems) {
        const outlet   = findOutlet(outletIdx, item.source, item.url);
        const behavior = outlet ? deriveOutletBehavior(outlet) : deriveBehavior({ factuality: null });
        // Blocked outlets are excluded from every curated surface (display path
        // line ~2134) — they are not "not surfacing" candidates, they're barred.
        if (behavior.blocked) continue;
        // Mirror the display gate exactly: known outlet → live-derived role;
        // unknown outlet → the row's stored role, failing closed to attach-only.
        const role      = outlet ? behavior.role : (((item as any).role as string) ?? 'attach-only');
        const ageH      = ageHours(item);
        const rawScore  = item.priorityScore ?? 0;
        const pinned    = overridesMap.get(`curated:${item.id}`);
        // Curated rows are stored RAW → decay HERE on the EXACT display curve
        // (calculateCuratedDepreciatedPriority: importance-tiered grace/slope
        // (Task #1129), floor 20, anchored to
        // the article's published date falling back to scrapedAt) — the SAME
        // helper the standalone Top Stories path uses (~line 2650). An
        // allowlist-gated override SETS the raw score and decays on that same
        // curve — pins are NOT decay-exempt (mirrors the display path exactly),
        // so radar decayedScore / cut line / below-cut stay faithful.
        const effective = calculateCuratedDepreciatedPriority(
          pinned ?? rawScore, null, item.scrapedAt, null, item.articlePublishedAt ?? null, now,
        ).depreciatedPriority;
        const nu = normalizeIdentityUrl(item.url);
        if (nu) {
          if (seenUrls.has(nu)) continue; // duplicate within the curated lane
          seenUrls.add(nu);
        }
        const curatedBehavior = outlet ? deriveOutletBehavior(outlet) : deriveBehavior({ factuality: null });
        let curatedBridgeLane: 'contributing' | 'contrast' | 'skip';
        if (curatedBehavior.blocked || isSocialFlashOutlet(outlet)) {
          curatedBridgeLane = 'skip';
        } else if (curatedBehavior.role === 'contributing') {
          curatedBridgeLane = 'contributing';
        } else if (isAdversaryNewsContrast(curatedBehavior, outlet)) {
          curatedBridgeLane = 'contrast';
        } else {
          curatedBridgeLane = 'skip';
        }
        candidates.push({
          key: `curated:${item.id}`, id: item.id, type: 'curated',
          url: item.url, title: item.title, source: item.source,
          rawScore, effective, ageH, role,
          otherType: (outlet?.otherSourceType || '').trim().toLowerCase(),
          contentKind: (item as any).contentKind ?? null,
          isCpc: outletIsCpc(outlet),
          passesSeedingGate: isEnriched(item),
          imageUrl: item.ogImageUrl ?? null, category: item.category ?? null,
          enrichmentAttempts: (item as any).mediaAttemptCount ?? 0,
          lastEnrichmentAt: (item as any).lastMediaAttemptAt ?? null,
          hasOverride: pinned != null,
          summary: item.summary ?? null,
          articlePublishedAt: item.articlePublishedAt ?? null,
          firstSeenAt: item.scrapedAt ?? null,
          publishedAt: item.articlePublishedAt ?? item.scrapedAt ?? null,
          summaryBullets: Array.isArray(item.summaryBullets) ? item.summaryBullets : null,
          attributedClaims: Array.isArray((item as any).attributedClaims) ? (item as any).attributedClaims : null,
          facts: Array.isArray((item as any).facts) ? (item as any).facts : null,
          matchedKeywords: Array.isArray((item as any).matchedKeywords) ? (item as any).matchedKeywords : null,
          bridgeLane: curatedBridgeLane,
        });
      }
      // Main lane (Task #834 review): Top Stories standalone candidates come from
      // the UNION of getPrimaryFeed + the curated store — a main-feed row that
      // fails to surface must be visible on the radar too, or the panel lies by
      // omission. Same-URL rows already covered by their curated twin are skipped.
      for (const f of feed) {
        const outlet   = findOutlet(outletIdx, f.source, f.url);
        const behavior = outlet ? deriveOutletBehavior(outlet) : deriveBehavior({ factuality: null });
        if (behavior.blocked) continue; // mirrors the display path (~line 2085)
        const nu = normalizeIdentityUrl(f.url);
        if (nu) {
          if (seenUrls.has(nu)) continue; // same article, curated row wins
          seenUrls.add(nu);
        }
        const ageH = ageHours(f as any);
        // Main rows arrive PRE-decayed from the feed pipeline: depreciatedPriority
        // IS the decayed display score and originalPriority the raw one — never
        // apply the curated decay again (double-decay).
        const rawScore  = (f as any).originalPriority ?? (f as any).priority ?? 0;
        const pinned    = overridesMap.get(`main:${f.id}`);
        // An override replaces the raw score and decays on the same article-age
        // curve — exactly the display path's override branch (~line 2650). No
        // override → the pre-decayed depreciatedPriority IS the display score.
        const effective = pinned != null
          ? calculateCuratedDepreciatedPriority(
              pinned, null, (f as any).scrapedAt, null, (f as any).articlePublishedAt ?? null, now,
            ).depreciatedPriority
          : ((f as any).depreciatedPriority ?? rawScore);
        let mainBridgeLane: 'contributing' | 'contrast' | 'skip';
        if (behavior.blocked || isSocialFlashOutlet(outlet)) {
          mainBridgeLane = 'skip';
        } else if (behavior.role === 'contributing') {
          mainBridgeLane = 'contributing';
        } else if (isAdversaryNewsContrast(behavior, outlet)) {
          mainBridgeLane = 'contrast';
        } else {
          mainBridgeLane = 'skip';
        }
        candidates.push({
          key: `main:${f.id}`, id: f.id, type: 'main',
          url: f.url, title: f.title, source: f.source,
          rawScore, effective, ageH,
          // Main lane derives role LIVE via the registry, failing closed for
          // unknown outlets (mirrors behaviorFor in buildTopStoriesPayload).
          role: behavior.role,
          otherType: (outlet?.otherSourceType || '').trim().toLowerCase(),
          contentKind: (f as any).contentKind ?? null,
          isCpc: outletIsCpc(outlet),
          passesSeedingGate: true, // seeding gate is curated-lane only (display ~2627)
          imageUrl: (f as any).ogImageUrl ?? null, category: (f as any).category ?? null,
          enrichmentAttempts: null, lastEnrichmentAt: null,
          hasOverride: pinned != null,
          summary: (f as any).summary ?? null,
          articlePublishedAt: (f as any).articlePublishedAt ?? null,
          firstSeenAt: (f as any).scrapedAt ?? null,
          publishedAt: (f as any).articlePublishedAt ?? (f as any).scrapedAt ?? null,
          summaryBullets: Array.isArray((f as any).summaryBullets) ? (f as any).summaryBullets : null,
          attributedClaims: null, // main-feed rows don't carry attributedClaims
          facts: null, // main-feed rows don't carry corroborated facts (curated-lane only)
          matchedKeywords: Array.isArray((f as any).matchedKeywords) ? (f as any).matchedKeywords : null,
          bridgeLane: mainBridgeLane,
        });
      }

      radarBuildDiag.stage = 'cut-line';
      radarBuildDiag.candidateCount = candidates.length;
      const isClustered = (c: Candidate): boolean => {
        if (inClusterKeys.has(c.key)) return true;
        const nu = normalizeIdentityUrl(c.url);
        return !!nu && clusteredUrls.has(nu);
      };

      // -----------------------------------------------------------------------
      // Gate every candidate — mirrors the standalone path in buildTopStoriesPayload.
      // -----------------------------------------------------------------------
      type RadarItem = {
        id: string; type: 'curated' | 'main'; url: string; title: string;
        source: string; priorityScore: number; decayedScore: number;
        itemAgeHours: number; surfacingState: string;
        articlePublishedAt?: Date | null; firstSeenAt?: Date | null;
        imageUrl?: string | null; contentKind?: string | null; category?: string | null;
        isCpc: boolean;
        // Manual P-pin exists — the editor already made a call on this row, so
        // the "scored too low" view must not re-surface it as an AI miss.
        hasManualOverride: boolean;
        // Topic·Focus classification overlay (curated_classifications, keyed by
        // URL). Null until the async classifier has covered the row — the client
        // renders the metadata line only when available.
        primaryTopic?: string | null; country?: string | null; region?: string | null;
        conflictTrack?: string | null; countryPair?: string[] | null;
        enrichmentAttempts?: number | null; lastEnrichmentAt?: Date | null;
        rescueStatus?: 'pending' | 'succeeded' | 'failed' | null;
        enrichmentLifecycle?: 'ready' | 'pending' | 'backed-off' | 'retry-capped' | null;
        // Bridge-faithful auto-attach recommendation for attach-only / opinion-video
        // items. Null/absent for surfacing/below-cut/not-enriched/age-out rows.
        // Computed from the SAME matching primitives the incremental-attach bridge
        // uses (significantTitleTokens + body, looksSameEvent, withinSameEventWindow,
        // category veto, ≥2-contributing-publisher cluster gate) so the panel never
        // over-promises what the bridge will actually do.
        attachRecommendation?: AttachRecommendation | null;
        // Task #963: lone interrogative signal (trailing "?" or WH-lead at start
        // of title) with NO corroborating URL/page-HTML content-kind signal.
        // Surfaced for editor review so a human can one-click confirm — never
        // auto-demotes, never changes tiering (first indicator only).
        possibleExplainer?: boolean;
        // Enriched content fields for the link/merge dialog's enriched search —
        // lets the editor find below-cut items by article body, bullets, claims,
        // facts, matched keywords, and classification — same field set as the
        // global storySearchText so both searches stay in lockstep.
        summary?: string | null;
        summaryBullets?: string[] | null;
        attributedClaims?: string[] | null;
        facts?: string[] | null;
        matchedKeywords?: string[] | null;
      };

      // Build the formed-cluster picture for the bridge-faithful recommendation.
      // Uses the SAME rawMembers already loaded above (18h window), so no extra
      // DB query — only clusters with ≥2 contributing publishers are included,
      // exactly as the bridge gate requires.
      radarBuildDiag.stage = 'bridge-cluster-build';
      // Resolve controlled primary_topics (classification overlay by URL) for
      // cluster members AND radar candidates, so the bridge-faithful category
      // veto applies the same related-topic carve-out as the live bridge.
      // Non-fatal: on failure the veto keeps its legacy free-form fallback.
      let bridgeClsMap = new Map<string, { category: string | null; primaryTopic: string | null }>();
      try {
        const raw = await storage.getCuratedClassificationsByUrls(
          Array.from(new Set(
            [...rawMembers.map((m) => m.url), ...candidates.map((c) => c.url)].filter(Boolean),
          )),
        );
        bridgeClsMap = new Map(
          Array.from(raw.entries()).map(([url, cls]) => [
            url,
            { category: cls.category ?? null, primaryTopic: cls.primaryTopic ?? null },
          ]),
        );
      } catch (err) {
        console.error('[curated/scoring-radar] bridge classification lookup failed (non-fatal):', err);
      }
      const bridgeTopicByUrl = new Map(
        Array.from(bridgeClsMap.entries()).map(([url, cls]) => [url, cls.primaryTopic]),
      );
      const attachClusters = buildAttachClusters(rawMembers, bridgeTopicByUrl);

      const radarItems: RadarItem[] = [];
      const telemetryByKey = new Map<string, RadarTelemetry>();
      let surfacingCount = 0;
      let cutLineScore = 0;

      // First pass: cut line from candidates passing all content gates
      // (enrichment excluded — matches the pre-refactor pool exactly).
      const passGate = candidates.filter((c) =>
        !isClustered(c) &&
        c.role === 'contributing' &&
        !NON_NEWS_TYPES.includes(c.otherType) &&
        c.contentKind !== 'video' && c.contentKind !== 'audio' &&
        c.ageH <= WINDOW_HOURS,
      );
      passGate.sort((a, b) => b.effective - a.effective);
      if (passGate.length > 0) {
        cutLineScore = passGate[Math.min(FEED_LIMIT, passGate.length) - 1]?.effective ?? 0;
      }

      // Second pass: classify EVERY candidate; list the non-surfacing ones.
      radarBuildDiag.stage = 'gate-classify+bridge-matching';
      for (const c of candidates) {
        let state: string;
        if (isClustered(c)) {
          state = 'surfacing';
        } else if (c.role !== 'contributing') {
          state = 'attach-only';
        } else if (NON_NEWS_TYPES.includes(c.otherType) || c.contentKind === 'video' || c.contentKind === 'audio') {
          state = 'opinion-video';
        } else if (c.ageH > WINDOW_HOURS) {
          state = 'age-out';
        } else if (!c.passesSeedingGate) {
          state = 'not-enriched';
        } else if (c.effective < cutLineScore) {
          state = 'below-cut';
        } else {
          // Passes all gates and above/at the cut — surfacing (as a standalone
          // card now, or in the next cluster pass).
          state = 'surfacing';
        }

        telemetryByKey.set(c.key, {
          rawScore: c.rawScore,
          decayedScore: c.effective,
          itemAgeHours: Math.round(c.ageH * 10) / 10,
          surfacingState: state,
        });

        if (state === 'surfacing') { surfacingCount++; continue; }

        // Bridge-faithful attach recommendation for attach-only and opinion-video
        // rows. For all other states (below-cut, not-enriched, age-out) this is
        // not relevant — leave null so the client doesn't render the indicator.
        let attachRecommendation: AttachRecommendation | null = null;
        if (state === 'attach-only' || state === 'opinion-video') {
          if (c.bridgeLane === 'skip') {
            // The bridge fail-closes on this lane — non-CPC contrast, social,
            // blocked, unknown outlets. A manual attach is the only path.
            attachRecommendation = { reason: 'manual-only', matchCount: 0 };
          } else {
            // Run the SAME matching primitives as the bridge: title tokens + body
            // (summary) extension, same-event time window, category veto.
            const titleToks = significantTitleTokens(c.title);
            const combinedToks = significantCandidateTokens({
              title: c.title,
              bullets: null,
              summary: c.summary,
            });
            attachRecommendation = classifyAttachCandidate(
              {
                key:        c.key,
                tokens:     titleToks,
                bodyTokens: combinedToks.size > titleToks.size ? combinedToks : undefined,
                publishedAt: c.publishedAt,
                category:   c.category,
                primaryTopic: bridgeClsMap.get(c.url)?.primaryTopic ?? null,
              },
              attachClusters,
            );
          }
        }

        radarItems.push({
          id:           c.id,
          type:         c.type,
          url:          c.url,
          title:        c.title,
          source:       c.source,
          priorityScore: c.rawScore,
          decayedScore: c.effective,
          itemAgeHours: Math.round(c.ageH * 10) / 10,
          articlePublishedAt: c.articlePublishedAt,
          firstSeenAt: c.firstSeenAt,
          surfacingState: state,
          imageUrl:     c.imageUrl,
          contentKind:  c.contentKind,
          category:     c.category,
          isCpc:        c.isCpc,
          hasManualOverride: c.hasOverride,
          // Task #963: flag items where a lone interrogative signal (trailing "?"
          // or WH-lead at start) fires but NO corroborating signal exists — no
          // stored content kind AND no URL-based opinion match. This keeps the
          // badge a true "headline-only, no other corroboration" first indicator.
          // Surfaced as a review prompt only; never auto-demotes.
          possibleExplainer: !c.contentKind && !isOpinionUrl(c.url) && hasTitleInterrogativeSignal(c.title) || undefined,
          // Rescue lifecycle (curated lane only): persisted back-off metadata +
          // the in-process one-shot rescue status, so the panel shows an honest
          // pending/failed state instead of an optimistic toast.
          enrichmentAttempts: c.enrichmentAttempts,
          lastEnrichmentAt:   c.lastEnrichmentAt,
          rescueStatus:       c.type === 'curated' ? getRadarRescueStatus(c.id) : null,
           enrichmentLifecycle: c.type === 'curated'
             ? getCuratedEnrichmentLifecycle({
                 summaryBullets: c.summaryBullets,
                 ogImageUrl: c.imageUrl,
                 mediaAttemptCount: c.enrichmentAttempts,
                 lastMediaAttemptAt: c.lastEnrichmentAt,
               })
             : null,
          attachRecommendation,
          // Enriched content for the link/merge dialog search — same field set
          // as the global storySearchText (bullets, facts, claims, keywords).
          summary:          c.summary,
          summaryBullets:   c.summaryBullets,
          attributedClaims: c.attributedClaims,
          facts:            c.facts,
          matchedKeywords:  c.matchedKeywords,
        });
      }

      // Sort radar items for the panel: below-cut first (most actionable), then
      // not-enriched, then the rest. Within each group, sort by score descending.
      const stateOrder: Record<string, number> = {
        'below-cut':    0,
        'not-enriched': 1,
        'age-out':      2,
        'attach-only':  3,
        'opinion-video': 4,
      };
      radarItems.sort((a, b) => {
        const ao = stateOrder[a.surfacingState] ?? 9;
        const bo = stateOrder[b.surfacingState] ?? 9;
        if (ao !== bo) return ao - bo;
        return b.decayedScore - a.decayedScore;
      });

      // Topic·Focus classification overlay (curated_classifications, URL-keyed)
      // stamped onto the radar rows so the editor views can show the same
      // "Topic – Focus" metadata the Top Stories cards carry. Fetched only for
      // the (small) non-surfacing list, never the whole candidate pool, and
      // non-fatal: a lookup failure just leaves the metadata line off.
      radarBuildDiag.stage = 'classification-stamp';
      radarBuildDiag.radarItemCount = radarItems.length;
      try {
        const clsMap = await storage.getCuratedClassificationsByUrls(
          Array.from(new Set(radarItems.map((r) => r.url).filter(Boolean))),
        );
        for (const r of radarItems) {
          const cls = clsMap.get(r.url);
          if (!cls) continue;
          r.primaryTopic  = cls.primaryTopic ?? null;
          r.country       = cls.country ?? null;
          r.region        = cls.region ?? null;
          r.conflictTrack = cls.conflictTrack ?? null;
          r.countryPair   = cls.countryPair ?? null;
          if (cls.category) r.category = cls.category;
        }
      } catch (err) {
        console.error('[curated/scoring-radar] classification stamp failed (non-fatal):', err);
      }

      const payload = {
        windowHours:    WINDOW_HOURS,
        feedLimit:      FEED_LIMIT,
        cutLineScore,
        surfacingCount,
        radarCount:     radarItems.length,
        items:          radarItems,
      };
      radarBuildDiag.stage = 'complete';
      return { payload, telemetryByKey };
  };

  // requireCuratedAccess already enforces canEdit (editor/tester allowlist).
  // Any request that reaches the handler has already passed the editor gate.
  app.get("/api/curated/scoring-radar", requireCuratedAccess, async (req: any, res) => {
    const bypass = req.headers['x-mcop-no-cache'] === '1';
    // Single-flight bookkeeping — declared outside the try so the catch can
    // settle/clean up the in-flight entry even when the compute throws.
    let holdsFlight = false;
    let resolveInFlight: ((v: any) => void) | undefined;
    let rejectInFlight: ((e: any) => void) | undefined;
    try {
      if (!bypass) {
        const hit = getCuratedCache(req, RADAR_CACHE_KEY);
        if (hit) return res.json(hit);
        const existing = radarInFlight;
        if (existing) {
          try {
            return res.json(await existing);
          } catch {
            // Leader compute failed — fall through and try once ourselves.
          }
        }
        const p = new Promise<any>((resolve, reject) => {
          resolveInFlight = resolve;
          rejectInFlight = reject;
        });
        p.catch(() => {}); // coalesced waiters attach their own handlers
        radarInFlight = p;
        holdsFlight = true;
      }
      const { payload } = await buildScoringRadarPayload();
      // Cache only on non-bypass reads: x-mcop-no-cache means "never touch the
      // cache" (read OR write), so a harness pass can't warm stale state.
      if (!bypass) setCuratedCache(RADAR_CACHE_KEY, payload, RADAR_CACHE_TTL_MS);
      if (holdsFlight) {
        resolveInFlight?.(payload);
        radarInFlight = null;
        holdsFlight = false;
      }
      res.json(payload);
    } catch (err) {
      if (holdsFlight) {
        rejectInFlight?.(err);
        radarInFlight = null;
        holdsFlight = false;
      }
      console.error(
        `[curated/scoring-radar] error at stage=${radarBuildDiag.stage} ` +
        `(window=${radarBuildDiag.windowHours}h, candidates=${radarBuildDiag.candidateCount}, ` +
        `radarItems=${radarBuildDiag.radarItemCount}):`,
        err,
      );
      res.status(500).json({ error: 'Failed to build scoring radar' });
    }
  });

  // Personal keyword watchlist (Task #456) — CURATED custom-feed surface ONLY.
  // An ADDITIVE / union recall lane: surface ANY story in the curated + main DB
  // pool whose own text (title / summary / AI bullets / attributed claims)
  // contains a watched word, EVEN IF the normal curated ranking, relevance
  // scorer, or recency window never showed it. Served on a DEDICATED endpoint so
  // these rows live ONLY in the client's custom-feed section — they NEVER enter
  // /api/curated/top-stories (which feeds the whole curated page + Top
  // Narratives) or the public REST API (fail-closed lane isolation). Honors the
  // SAME blocked-outlet + editor HIDE overlays as top-stories so a keyword can
  // never resurrect admin-removed content. Social posts are out of scope.
  // Matching is literal, case-insensitive substring. NEVER cached (the keyword
  // set is per-viewer) — bypasses the curated read cache entirely.
  app.get("/api/curated/keyword-matches", requireCuratedView, async (req, res) => {
    try {
      // Parse the comma-separated watchlist: trim, lowercase, dedup, bound each
      // token (2-80 chars) and cap the list (25). Empty → empty result.
      const rawKeywords: string = typeof req.query.keywords === 'string' ? req.query.keywords : '';
      const keywordSeen = new Set<string>();
      const keywords: string[] = [];
      for (const part of rawKeywords.split(',')) {
        const k = part.trim().toLowerCase();
        if (k.length < 2 || k.length > 80) continue;
        if (keywordSeen.has(k)) continue;
        keywordSeen.add(k);
        keywords.push(k);
        if (keywords.length >= 25) break;
      }
      if (keywords.length === 0) {
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ stories: [] });
      }

      // Recency window for the DB scan (default 24h, max 7d). Bounds how far back
      // the union recall reaches; independent of the client's facet time window.
      const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 168);

      const [feed, curatedStore, registry, hiddenStoryRows, linkReplacements, imageReplacements] = await Promise.all([
        storage.getPrimaryFeed(hours),
        storage.getCuratedStoreItems(hours),
        storage.getOutletRegistry(),
        storage.getCuratedHiddenStories(),
        storage.getCuratedLinkReplacements(),
        storage.getCuratedImageReplacements(),
      ]);

      // Editor HIDE overlay → suppression keys (same as top-stories). A keyword
      // must never resurrect a hidden story.
      const hiddenKeys = new Set<string>();
      for (const h of hiddenStoryRows) {
        if (h.key) hiddenKeys.add(h.key);
        for (const mk of h.memberKeys ?? []) hiddenKeys.add(mk);
      }

      const outletIndex = buildOutletIndex(registry);
      // Social-media outlets are out of scope for the keyword lane.
      const isSocialMember = (source: string, url: string) => {
        const o = findOutlet(outletIndex, source, url);
        const sid = o?.sourceIdentifier;
        return typeof sid === 'string' && sid.startsWith('social-');
      };

      // Content-classification overlay (same URL-keyed source of truth as
      // top-stories) for each card's Category · Country/Region labels.
      const classUrls = Array.from(new Set([
        ...feed.map((f) => f.url),
        ...curatedStore.map((c) => c.url),
      ]));
      const classMap = await storage.getCuratedClassificationsByUrls(classUrls);

      // Literal, case-insensitive substring match over the story's OWN text only
      // (title + summary + AI bullets + attributed claims). No semantic match.
      const matchKw = (parts: (string | null | undefined)[]): string[] => {
        const hay = parts.filter((p): p is string => !!p).join('\n').toLowerCase();
        return keywords.filter((k) => hay.includes(k));
      };

      // The SAME article can exist as main:<id> AND curated:<id> (same URL);
      // collapse to one card by article identity and union the matched keywords.
      const byUrl = new Map<string, any>();
      const pushMatch = (identityUrl: string, story: any) => {
        const u = normalizeIdentityUrl(identityUrl);
        const existing = byUrl.get(u);
        if (!existing) { byUrl.set(u, story); return; }
        const union = Array.from(new Set([
          ...(existing.matchedKeywords ?? []),
          ...(story.matchedKeywords ?? []),
        ]));
        // Keep the richer record (the one that carries AI bullets); the curated
        // row is usually more enriched than the raw main-feed row.
        const incomingRicher =
          Array.isArray(story.summaryBullets) && story.summaryBullets.length > 0 &&
          !(Array.isArray(existing.summaryBullets) && existing.summaryBullets.length > 0);
        const winner = incomingRicher ? story : existing;
        winner.matchedKeywords = union;
        byUrl.set(u, winner);
      };

      // CURATED-store rows first (most enriched). Decay display priority here the
      // same way top-stories does for standalone curated items.
      for (const c of curatedStore) {
        if (c.source === 'Unknown Source' || !isSingleWellFormedHttpUrl(c.url)) continue;
        if (isSocialMember(c.source, c.url)) continue; // social out of scope
        const cOutlet = findOutlet(outletIndex, c.source, c.url);
        const cBehavior = cOutlet ? deriveOutletBehavior(cOutlet) : deriveBehavior({ factuality: null });
        if (cBehavior.blocked) continue; // blocked outlet — hard exclude
        const key = `curated:${c.id}`;
        if (hiddenKeys.has(key)) continue; // editor take-down
        const claims = (c as any).attributedClaims as string[] | null | undefined;
        const matched = matchKw([c.title, c.summary, ...(c.summaryBullets ?? []), ...(claims ?? [])]);
        if (matched.length === 0) continue;
        const cls = classMap.get(c.url);
        const cLiveRole = cOutlet ? cBehavior.role : ((c.role as any) ?? 'attach-only');
        const replacementUrl = linkReplacements.get(key);
        const effectiveUrl = replacementUrl ?? c.url;
        const img = imageReplacements.get(key) ?? c.ogImageUrl ?? null;
        const decayed = calculateCuratedDepreciatedPriority(
          c.priorityScore, null, c.scrapedAt, null, c.articlePublishedAt,
        ).depreciatedPriority;
        pushMatch(c.url, {
          id: c.id, type: 'curated', title: c.title,
          displayTitle: cleanDisplayTitle(c.title),
          summary: c.summary ?? '', summaryBullets: c.summaryBullets ?? null,
          ogImageUrl: img, memberImages: img && !isFaviconUrl(img) ? [img] : [],
          hiddenImages: [],
          videoUrl: null, category: cls?.category ?? c.category,
          region: cls?.region ?? c.region ?? null, country: cls?.country ?? c.country ?? null,
          primaryTopic: cls?.primaryTopic ?? null, scope: cls?.scope ?? null,
          conflictTrack: cls?.conflictTrack ?? inferConflictTrack(c.title, cls?.category ?? c.category) ?? null,
          countryPair: cls?.countryPair ?? null,
          sourceKind: deriveSourceKind({
            itemType: 'curated', contentKind: (c as any).contentKind ?? null,
            sourceIdentifier: cOutlet?.sourceIdentifier ?? null,
            otherSourceType: cOutlet?.otherSourceType ?? null,
          }),
          outletOriginCountry: cOutlet?.originCountry ?? null,
          outletOriginRegion: cOutlet?.originRegion ?? null,
          outletOwnership: cOutlet?.ownership ?? [],
          source: c.source, url: effectiveUrl, clusterId: null,
          priorityScore: decayed, priorityOverride: null,
          scrapedAt: c.scrapedAt, articlePublishedAt: c.articlePublishedAt,
          sourceCount: 1, role: cLiveRole, headline: null, lede: null, facts: null,
          attributedClaims: claims && claims.length ? claims : null,
          contentKind: (c as any).contentKind ?? null,
          linkDead: !replacementUrl && !!c.linkDeadAt,
          hidden: false, members: [],
          matchedKeywords: matched,
        });
      }

      // MAIN-feed rows (already arrive decayed from getPrimaryFeed).
      for (const f of feed) {
        if (isSocialMember(f.source, f.url)) continue; // social out of scope
        const fOutlet = findOutlet(outletIndex, f.source, f.url);
        const fBehavior = fOutlet ? deriveOutletBehavior(fOutlet) : deriveBehavior({ factuality: null });
        if (fBehavior.blocked) continue; // blocked outlet — hard exclude
        const key = `main:${f.id}`;
        if (hiddenKeys.has(key)) continue; // editor take-down
        const claims = (f as any).attributedClaims as string[] | null | undefined;
        const matched = matchKw([f.title, f.summary, ...(f.summaryBullets ?? []), ...(claims ?? [])]);
        if (matched.length === 0) continue;
        const cls = classMap.get(f.url);
        const img = f.ogImageUrl ?? null;
        pushMatch(f.url, {
          id: f.id, type: f.type, title: f.title,
          displayTitle: cleanDisplayTitle(f.title),
          summary: f.summary, summaryBullets: f.summaryBullets ?? null,
          ogImageUrl: img, memberImages: img && !isFaviconUrl(img) ? [img] : [],
          hiddenImages: [],
          videoUrl: f.videoUrl ?? null, category: cls?.category ?? f.category,
          region: cls?.region ?? null, country: cls?.country ?? null,
          primaryTopic: cls?.primaryTopic ?? null, scope: cls?.scope ?? null,
          conflictTrack: cls?.conflictTrack ?? inferConflictTrack(f.title, cls?.category ?? f.category) ?? null,
          countryPair: cls?.countryPair ?? null,
          sourceKind: deriveSourceKind({
            itemType: f.type, contentKind: (f as any).contentKind ?? null,
            sourceIdentifier: fOutlet?.sourceIdentifier ?? null,
            otherSourceType: fOutlet?.otherSourceType ?? null,
          }),
          outletOriginCountry: fOutlet?.originCountry ?? null,
          outletOriginRegion: fOutlet?.originRegion ?? null,
          outletOwnership: fOutlet?.ownership ?? [],
          source: f.source, url: f.url, clusterId: null,
          priorityScore: f.depreciatedPriority, priorityOverride: null,
          scrapedAt: f.scrapedAt, articlePublishedAt: f.articlePublishedAt,
          sourceCount: 1, role: fBehavior.role, headline: null, lede: null, facts: null,
          attributedClaims: claims && claims.length ? claims : null,
          contentKind: (f as any).contentKind ?? null,
          linkDead: false, hidden: false, members: [],
          matchedKeywords: matched,
        });
      }

      // Sort by display priority (importance/freshness) then recency; cap the
      // surfaced extras so the personal lane never floods the section.
      const stories = Array.from(byUrl.values())
        .sort((a, b) => {
          const ds = (b.priorityScore ?? 0) - (a.priorityScore ?? 0);
          if (ds !== 0) return ds;
          return new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime();
        })
        .slice(0, 50);

      // Per-viewer set — must never be cross-served from the curated read cache.
      res.setHeader('Cache-Control', 'no-store');
      res.json({ stories });
    } catch (error) {
      console.error('Error fetching curated keyword matches:', error);
      res.status(500).json({ error: 'Failed to fetch curated keyword matches' });
    }
  });

  // Allowlist-gated manual Priority override (Task #171). Only Curated-allowlist
  // users (same gate as the read endpoint) can set a P score on a curated story.
  // CURATED-ONLY: the score is stored in the dedicated curated_priority_overrides
  // table and applied ONLY when building /api/curated/top-stories — it is NEVER
  // written to headlines.priority_override or manual_submissions.priority_override
  // (which would leak into Classic/Visual/custom-MCOP/public-API). The override
  // key is built SERVER-SIDE from the scope so the client can't write an
  // arbitrary key: clusters -> `cluster:<clusterId>`; standalone items ->
  // `${type === 'curated' ? 'curated' : 'main'}:<id>`.
  app.post("/api/curated/priority-override", requireCuratedAccess, async (req: any, res) => {
    try {
      const {
        scope, type, id, clusterId, priorityScore,
        // Scoring Radar telemetry (Task #834). Optional — only set when the
        // action originates from the Scoring Radar panel so the learning loop
        // can distinguish radar-prompted actions from organic editor actions.
        fromRadar, surfacingState, rawScore, decayedScore, itemAgeHours,
      } = req.body ?? {};

      const score = Number(priorityScore);
      if (!Number.isInteger(score) || score < 1 || score > 100) {
        return res.status(400).json({ error: 'priorityScore must be an integer between 1 and 100' });
      }

      let key: string;
      if (scope === 'cluster') {
        const cid = (clusterId ?? '').toString().trim();
        if (!cid) return res.status(400).json({ error: 'clusterId required for cluster scope' });
        key = `cluster:${cid}`;
      } else if (scope === 'standalone') {
        const itemId = (id ?? '').toString().trim();
        if (!itemId) return res.status(400).json({ error: 'id required for standalone scope' });
        const prefix = type === 'curated' ? 'curated' : 'main';
        key = `${prefix}:${itemId}`;
      } else {
        return res.status(400).json({ error: "scope must be 'cluster' or 'standalone'" });
      }

      const updatedBy = req.user?.claims?.email || 'dev';

      // Scoring-context derivation (Task #834 review): the ORGANIC feed-card
      // promote/demote flow doesn't send scoring context — only the radar view
      // does. Derive it SERVER-SIDE when absent so every priority-override
      // event carries rawScore/decayedScore/itemAgeHours/surfacingState and the
      // learning loop can compare radar-prompted vs organic actions on equal
      // footing. Best-effort: a derivation failure must never block the pin.
      let ctxRaw     = typeof rawScore === 'number' ? Math.round(rawScore) : null;
      let ctxDecayed = typeof decayedScore === 'number' ? Math.round(decayedScore) : null;
      let ctxAge     = typeof itemAgeHours === 'number' ? itemAgeHours : null;
      let ctxState   = typeof surfacingState === 'string' ? surfacingState : null;
      if (ctxRaw == null || ctxDecayed == null || ctxAge == null || ctxState == null) {
        try {
          if (scope === 'standalone') {
            const { telemetryByKey } = await buildScoringRadarPayload();
            const t = telemetryByKey.get(key);
            if (t) {
              if (ctxRaw == null)     ctxRaw = t.rawScore;
              if (ctxDecayed == null) ctxDecayed = Math.round(t.decayedScore);
              if (ctxAge == null)     ctxAge = t.itemAgeHours;
              if (ctxState == null)   ctxState = t.surfacingState;
            }
          } else if (ctxState == null) {
            // A formed cluster is by definition surfacing; per-item raw/decayed
            // scores don't apply to a whole-story pin, so they stay null.
            ctxState = 'surfacing';
          }
        } catch (e: any) {
          console.warn('[curated/priority-override] telemetry derivation failed (non-blocking):', e?.message || e);
        }
      }

      // Snapshot the AI's ORIGINAL score/labels BEFORE the pin is applied.
      const snapshot = await resolveCuratedOverrideSnapshot({ scope, type, id, clusterId });
      let rankingBefore: Record<string, unknown> | null = null;
      let rankingAlternatives: Record<string, unknown>[] | null = null;
      try {
        const beforePayload = await buildTopStoriesPayload(TOP_STORIES_DEFAULT_HOURS, TOP_STORIES_DEFAULT_LIMIT);
        const stories = Array.isArray(beforePayload?.stories) ? beforePayload.stories : [];
        const index = stories.findIndex((s: any) =>
          scope === 'cluster'
            ? s.clusterId === clusterId
            : s.type === (type === 'curated' ? 'curated' : 'main') && String(s.id) === String(id),
        );
        if (index >= 0) {
          const current = stories[index];
          rankingBefore = {
            rank: index + 1,
            displayedScore: current.priorityScore ?? null,
            rankingScore: current.rankingScore ?? null,
            cutoffTop5: beforePayload?.rankingCutoffs?.top5 ?? null,
            cutoffTop30: beforePayload?.rankingCutoffs?.top30 ?? null,
          };
          rankingAlternatives = stories
            .slice(Math.max(0, index - 3), Math.min(stories.length, index + 4))
            .filter((_: any, i: number) => Math.max(0, index - 3) + i !== index)
            .map((s: any, i: number) => ({
              rank: Math.max(0, index - 3) + i + 1,
              storyKey: s.clusterId ? `cluster:${s.clusterId}` : `${s.type}:${s.id}`,
              headline: s.headline ?? s.title ?? null,
              outlet: s.source ?? null,
              url: normalizeIdentityUrl(s.url),
              displayedScore: s.priorityScore ?? null,
              rankingScore: s.rankingScore ?? null,
            }));
        }
      } catch (e) {
        console.warn('[curated/priority-override] ranking context capture failed (non-blocking):', e);
      }
      await storage.setCuratedPriorityOverride(key, score, updatedBy);
      // A manual P pin changes ranking immediately — drop the cached top-stories
      // so the curated user sees their override on the next load, not up to 30s
      // later.
      invalidateCuratedCache('top-stories');
      // A pinned score can move an adversary item's ranking in the State
      // Controlled Narratives lens too — keep it in sync (Task #633).
      invalidateCuratedCache('state-narratives');
      // Invalidate the scoring-radar cache too so the panel reflects the action.
      invalidateCuratedCache('scoring-radar');
      const eventId = await captureCuratedOverrideEvent({
        action: 'priority-override', editor: updatedBy, snapshot, storyKey: key,
        newValue: `pinned to ${score}`,
        // Scoring context: client-sent (radar view) or server-derived (organic
        // feed-card promote/demote) — see derivation above.
        fromRadar: fromRadar === true ? true : null,
        surfacingState: ctxState,
        rawScore: ctxRaw,
        decayedScore: ctxDecayed,
        itemAgeHours: ctxAge,
        alternatives: rankingAlternatives,
        beforeContext: rankingBefore,
        requestedContext: {
          requestedMinPriority: score,
          requestedMemberUrls: snapshot.itemUrl ? [snapshot.itemUrl] : [],
          intendedComparison: rankingAlternatives,
        },
        outcome: 'persisted',
        surface: fromRadar === true ? 'scoring-radar' : 'curated-priority-control',
      });
      // Force one fresh authoritative ranking build after the episode exists.
      // This records the immediate actual outcome; later revision builds record
      // persistence automatically with no further editor work.
      try {
        await buildTopStoriesPayload(TOP_STORIES_DEFAULT_HOURS, TOP_STORIES_DEFAULT_LIMIT);
      } catch (e) {
        console.warn('[curated/priority-override] post-pin outcome observation failed (non-blocking):', e);
      }

      // Enrichment rescue (Task #834): when an editor promotes a not-enriched
      // item from the Scoring Radar panel, kick off a bounded one-shot
      // enrichment so the item has a chance to clear the seeding gate before
      // the next clustering pass. Fire-and-forget; never awaited here — the
      // promote action must succeed even if enrichment fails.
      if (fromRadar === true && surfacingState === 'not-enriched' && scope === 'standalone' && type === 'curated' && id) {
        triggerCuratedRadarEnrichment(String(id)).catch(() => {});
      }

      res.json({ ok: true, key, priorityScore: score, eventId });
    } catch (error) {
      console.error('Error setting curated priority override:', error);
      res.status(500).json({ error: 'Failed to set curated priority override' });
    }
  });

  // Curated lane (Task #430) — MANUAL re-cluster trigger. Allowlist-gated
  // (requireCuratedAccess), CURATED-LANE ONLY. Lets an editor kick off a curated
  // clustering pass on demand (e.g. right after hiding/relabeling stories or
  // adding sources) instead of waiting for the scheduled cron tick. This runs the
  // SAME curated clustering entry point the cron uses and goes through the SAME
  // single in-flight guard (isClusteringRunning) — a manual run and the cron pass
  // can never run concurrently. On a real run it invalidates ONLY the curated read
  // cache so the next read reflects the new grouping; it NEVER calls
  // invalidateMainFeeds(), so the main/Classic/Visual/custom-MCOP feeds and the
  // public API are untouched. If a pass is already running, it fails closed with a
  // distinct "already running" response instead of a misleading zero-result success.
  app.post("/api/curated/recluster", requireCuratedEditor, async (req: any, res) => {
    try {
      const { clusterCuratedLane, reshapeCuratedLane, isCuratedClusteringRunning } = await import('./curatedCluster');
      if (isCuratedClusteringRunning()) {
        return res.status(409).json({ alreadyRunning: true, error: 'A clustering pass is already running' });
      }
      // Optional CHEAP path (Task #430 follow-up): ?mode=reshape runs the
      // DETERMINISTIC re-shape — it reuses the previous grouping and skips every
      // expensive LLM pass (zero new AI cost). This is the manual way to invoke /
      // verify the auto-reshape path while the automation itself stays shelved.
      // Default (no param) is the full re-cluster — unchanged behavior.
      const reshape = req.query?.mode === 'reshape';
      const result = reshape ? await reshapeCuratedLane() : await clusterCuratedLane();
      if (result.skipped) {
        // Lost a race with the cron pass (or a concurrent click) between the
        // pre-check and the guard — report it honestly, not as a zero-result run.
        return res.status(409).json({ alreadyRunning: true, error: 'A clustering pass is already running' });
      }
      // Re-cluster (full OR reshape) changes cluster MEMBERSHIP, so invalidate
      // BOTH curated read-cache prefixes — top-stories AND cluster-members — so an
      // immediately-following story-detail read can't serve a stale member list
      // (matches every other curated grouping-mutation route). Do NOT invalidate
      // the main feeds; curated isolation is the hard invariant here.
      invalidateCuratedCache('top-stories');
      invalidateCuratedCache('cluster-members');
      res.json({ ok: true, mode: reshape ? 'reshape' : 'full', stories: result.stories, members: result.members });
    } catch (error) {
      console.error('Error running curated re-cluster:', error);
      res.status(500).json({ error: 'Failed to run curated clustering' });
    }
  });

  // ---------------------------------------------------------------------------
  // Curated lane — EDITOR MANUAL LINK / MERGE (Task #430). Lets an allowlisted
  // curated editor deliberately force items into ONE story: either LINK a stray
  // standalone item into an existing story, or MERGE 2+ selected items. An AI
  // gives a non-binding second opinion (concur / object-with-reason), but the
  // EDITOR always decides — the AI never blocks. Every action is WRITTEN to the
  // curated_manual_links overlay, which both (a) drives the clustering must-link
  // and (b) is the Source Oversight editor-update audit trail. CURATED-LANE ONLY:
  // never touches the main / Classic / Visual / custom-MCOP feeds or public API.
  // ---------------------------------------------------------------------------

  // Normalize the caller-supplied member URLs to the SAME identity used by the
  // clustering engine, and de-duplicate. Returns [] when < 2 distinct remain.
  const buildManualLinkMemberUrls = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    for (const u of raw) {
      if (typeof u !== 'string') continue;
      const nu = normalizeIdentityUrl(u);
      if (nu) seen.add(nu);
    }
    return Array.from(seen);
  };

  // (1) AI second opinion only — no write. The editor calls this to preview the
  // AI's verdict before confirming. Fails OPEN ('skipped') so the editor is never
  // blocked by AI availability.
  app.post("/api/curated/link-review", requireCuratedEditor, async (req: any, res) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const fallbacks = items
        .filter((it: any) => it && typeof it.title === 'string' && it.title.trim())
        .map((it: any) => ({
          title: String(it.title).replace(/\s+/g, ' ').trim().slice(0, 300),
          outlet: it.outlet ? String(it.outlet).replace(/\s+/g, ' ').trim().slice(0, 100) : null,
          url: it.url ? String(it.url) : null,
          evidenceSource: 'client' as const,
        }));
      if (fallbacks.length < 2) {
        return res.status(400).json({ error: 'Provide at least two items to review' });
      }
      const rawReviewMemberUrls = Array.isArray(req.body?.memberUrls)
        ? req.body.memberUrls.filter((url: unknown): url is string => typeof url === 'string' && !!url.trim())
        : [];
      const reviewMemberUrls = buildManualLinkMemberUrls(rawReviewMemberUrls);
      const itemUrls = buildManualLinkMemberUrls(fallbacks.map((item: any) => item.url));
      if (
        reviewMemberUrls.length < 2 ||
        itemUrls.some((url) => !reviewMemberUrls.includes(url))
      ) {
        return res.status(400).json({ error: 'Review selection URLs do not match the proposed grouping' });
      }

      // Hydrate by normalized URL from the CURRENT Curated inputs/membership.
      // Client display fields are fallback-only: they may be stale synthesized
      // headlines and do not carry publication timing or body evidence.
      const requestedUrls = new Set(reviewMemberUrls);
      const exactUrls = Array.from(new Set([
        ...fallbacks.map((item: any) => item.url).filter(Boolean),
        ...rawReviewMemberUrls,
        ...requestedUrls,
      ]));
      // Target only the selected URLs in the existing Curated inputs instead of
      // loading/scanning seven days of every feed on this interactive route.
      const evidenceRows = await storage.getCuratedLinkReviewEvidence(exactUrls);
      type EvidenceRow = {
        title: string;
        source?: string | null;
        url: string;
        articlePublishedAt?: Date | null;
        scrapedAt?: Date | null;
        publishedAt?: Date | null;
        role?: string | null;
        summary?: string | null;
        summaryBullets?: string[] | null;
      };
      const evidenceByUrl = new Map<string, EvidenceRow>();
      const absorb = (rows: EvidenceRow[]) => {
        for (const row of rows) {
          const normalized = normalizeIdentityUrl(row.url);
          if (normalized && requestedUrls.has(normalized)) {
            const current = evidenceByUrl.get(normalized);
            evidenceByUrl.set(normalized, current ? {
              ...row,
              ...current,
              role: current.role ?? row.role,
              summary: current.summary ?? row.summary,
              summaryBullets: current.summaryBullets ?? row.summaryBullets,
              articlePublishedAt: current.articlePublishedAt ?? row.articlePublishedAt,
              publishedAt: current.publishedAt ?? row.publishedAt,
              scrapedAt: current.scrapedAt ?? row.scrapedAt,
            } : row);
          }
        }
      };
      // Prefer live store/main rows because they carry bullets; cluster-member
      // snapshots remain the fallback when a live row has aged out.
      absorb(evidenceRows as EvidenceRow[]);
      const fallbackByUrl = new Map(
        fallbacks.map((fallback: any) => [
          fallback.url ? normalizeIdentityUrl(fallback.url) : null,
          fallback,
        ]),
      );
      const clean = reviewMemberUrls.map((normalized) => {
        const fallback: any = fallbackByUrl.get(normalized);
        const row = evidenceByUrl.get(normalized);
        if (!row) {
          return {
            title: fallback?.title || '(current server evidence unavailable)',
            outlet: fallback?.outlet ?? null,
            url: normalized,
            evidenceSource: 'client' as const,
          };
        }
        return {
          title: row.title || fallback?.title || '(untitled current item)',
          outlet: row.source || fallback?.outlet,
          url: normalized,
          publishedAt: row.articlePublishedAt ?? row.publishedAt ?? row.scrapedAt ?? null,
          role: row.role ?? null,
          summary: typeof row.summary === 'string' ? row.summary : null,
          bullets: Array.isArray(row.summaryBullets) ? row.summaryBullets : null,
          evidenceSource: 'server' as const,
        };
      });
      const { reviewManualLink } = await import('./curatedManualLink');
      const review = await reviewManualLink(clean, reviewMemberUrls);
      res.json({ ok: true, ...review });
    } catch (error) {
      console.error('Error reviewing curated manual link:', error);
      // Fail OPEN — the editor decides; a review failure must not block the flow.
      res.json({
        ok: true,
        verdict: 'skipped',
        reasoning: 'AI review failed.',
        rationale: 'AI unavailable',
        requestedCount: Array.isArray(req.body?.items) ? req.body.items.length : 0,
        reviewedCount: 0,
        evidenceResolvedCount: 0,
        partial: false,
        warning: null,
      });
    }
  });

  // (2) PERSIST the editor's decision and apply it instantly. Writes the overlay
  // row (audit trail + must-link), invalidates the curated read cache, and runs a
  // deterministic re-shape (zero AI cost) so the new grouping shows immediately.
  app.post("/api/curated/link-items", requireCuratedEditor, async (req: any, res) => {
    try {
      const { label, kind, reviewToken, reviewUrls, reasonKeys: rawReasonKeys, reasonNote: rawReasonNote } = req.body ?? {};
      const isSocialCardAttach = req.body?.fromSocialCard === true;
      // Validate optional reason keys against the shared controlled vocabulary.
      const { LINK_MERGE_REASON_KEYS } = await import('@shared/curatedReasonVocab');
      const reasonKeys = Array.isArray(rawReasonKeys)
        ? rawReasonKeys.filter((k: unknown) => typeof k === 'string' && LINK_MERGE_REASON_KEYS.has(k))
        : [];
      const reasonNote = typeof rawReasonNote === 'string' ? rawReasonNote.trim().slice(0, 500) : null;
      let requestedMemberUrls = req.body?.memberUrls;
      if (isSocialCardAttach) {
        if (kind === 'merge') {
          return res.status(400).json({ error: 'Social posts can only be attached with a soft link' });
        }
        const socialIdentity = normalizeIdentityUrl(req.body?.socialUrl);
        const targetClusterId =
          typeof req.body?.targetClusterId === 'string' ? req.body.targetClusterId.trim() : '';
        if (!socialIdentity || !targetClusterId) {
          return res.status(400).json({ error: 'A social post and active story are required' });
        }
        // The menu can go stale after opening, so re-resolve BOTH sides at commit
        // time. The social URL must still pass the same approved/current Curated
        // candidate boundary as the picker, and the target must still be an
        // active formed story. Client-supplied member URLs are never trusted.
        const [eligibleSocial, topStories] = await Promise.all([
          getEligibleCuratedSocialLinkCandidates(),
          buildTopStoriesPayload(TOP_STORIES_DEFAULT_HOURS, TOP_STORIES_DEFAULT_LIMIT),
        ]);
        const social = eligibleSocial.find(
          (candidate) => normalizeIdentityUrl(candidate.url) === socialIdentity,
        );
        const target = (topStories?.stories ?? []).find(
          (story: any) =>
            story?.clusterId === targetClusterId &&
            Number(story?.sourceCount ?? 0) >= 2 &&
            typeof story?.url === 'string',
        );
        if (!social) {
          return res.status(409).json({
            error: 'This social post is not currently approved and available in Curated',
          });
        }
        if (!target) {
          return res.status(409).json({
            error: 'This story is no longer an active formed story',
          });
        }
        requestedMemberUrls = [social.url, target.url];
      }
      const memberUrls = buildManualLinkMemberUrls(requestedMemberUrls);
      if (memberUrls.length < 2) {
        return res.status(400).json({ error: 'At least two distinct item URLs are required' });
      }
      // An authoritative merge may bypass the normal formation gate, so reject
      // an all-social selection before writing its overlay. Social posts are
      // Additional Coverage only: they may be soft-linked into an already formed
      // article story, and mixed article/social merges remain valid, but social
      // posts alone cannot create a Top Story. Without this write-time guard the
      // clustering engine correctly elected no representative while the endpoint
      // still reported `formed: true`, leaving the editor with a hidden grouping.
      if (kind === 'merge' && !isSocialCardAttach) {
        const [currentItems, primaryItems, registry] = await Promise.all([
          storage.getCuratedStoreItems(7 * 24),
          storage.getPrimaryFeed(7 * 24),
          storage.getOutletRegistry(),
        ]);
        const currentByIdentity = new Map(
          [...primaryItems, ...currentItems].map((item) => [normalizeIdentityUrl(item.url), item]),
        );
        const outletIndex = buildOutletIndex(registry);
        const selected = memberUrls.map((url) => {
          const item = currentByIdentity.get(url);
          const outlet = item ? findOutlet(outletIndex, item.source, item.url) : undefined;
          return { item, outlet };
        });
        const hasUnresolvedIdentity = selected.some(({ item, outlet }) => !item || !outlet);
        const hasNonSocialArticle = selected.some(({ outlet }) => (
          !!outlet && !isSocialFlashOutlet(outlet)
        ));
        if (hasUnresolvedIdentity || !hasNonSocialArticle) {
          return res.status(400).json({
            error: 'An authoritative merge must include a current non-social article',
          });
        }
      }
      // Audit AI metadata only when it was issued by this server for this SAME
      // URL selection. A missing/expired/tampered token simply degrades to
      // `skipped`; it never blocks the editor action.
      const { verifyManualLinkReviewToken, manualLinkReviewSelectionFingerprint } = await import('./curatedManualLink');
      const verifiedReview = verifyManualLinkReviewToken(reviewToken);
      const normalizedReviewUrls = buildManualLinkMemberUrls(reviewUrls);
      const committedUrlSet = new Set(memberUrls);
      const reviewMatchesSelection =
        !!verifiedReview &&
        normalizedReviewUrls.length >= 2 &&
        normalizedReviewUrls.length === committedUrlSet.size &&
        normalizedReviewUrls.every((url) => committedUrlSet.has(url)) &&
        verifiedReview.selectionFingerprint === manualLinkReviewSelectionFingerprint(
          normalizedReviewUrls.map((url) => ({ url })),
        );
      const verdict = reviewMatchesSelection ? verifiedReview.verdict : 'skipped';
      const aiReasoning = reviewMatchesSelection ? verifiedReview.reasoning : '';
      const overrodeAi = verdict === 'object';
      const createdBy = req.user?.claims?.email || 'dev';
      // Overlap discovery, union construction, kind escalation, survivor
      // create/refresh, and absorbed-row revocation happen together under the
      // storage transaction's PostgreSQL advisory lock. The route deliberately
      // submits only the editor's requested selection so queued/concurrent
      // requests cannot act on a stale pre-queue overlap snapshot.
      const requestedKind: 'link' | 'merge' = kind === 'merge' ? 'merge' : 'link';
      let effectiveMemberUrls = memberUrls;
      let effectiveKind: 'link' | 'merge' = requestedKind;
      // Route the create + overlap-consolidation revocation + bounded reshape
      // through the SERIAL coordinator (Task #1180). The authoritative-merge
      // semantics (forceSynthesis, MANUAL_MERGE_SYNTHESIS_MAX_MS, clustering-yield)
      // are expressed on the intent; the write itself stays in applyIntent so it
      // serializes with every other manual mutation and never interleaves. Both
      // link and merge want synthesis (a formed story needs a headline).
      let createdRow: Awaited<ReturnType<typeof storage.createCuratedManualLink>> | null = null;
      const result = await submitManualMutation({
        kind: requestedKind,
        dedupeKey: `link:${requestedKind}:${memberUrls.slice().sort().join('|')}`,
        targets: memberUrls.map((u) => ({ id: `member:${u}`, seenRevision: 0 })),
        wantsSynthesis: true,
        forceSynthesis: true,
        synthesisMaxMs: MANUAL_MERGE_SYNTHESIS_MAX_MS_ROUTES,
        yieldReason: 'manual link/merge',
        payload: {
          captureRequired: async () => {
            const snapshot = await resolveCuratedOverrideSnapshot({ url: memberUrls[0] });
            return captureRequiredCuratedOverrideEvent({
              action: requestedKind === 'merge' ? 'manual-merge' : 'manual-link',
              editor: createdBy,
              newValue:
                `requested ${requestedKind} of ${memberUrls.length} items` +
                (label ? `: ${String(label).slice(0, 120)}` : ''),
              snapshot,
              reasonKeys: reasonKeys.length > 0 ? reasonKeys : null,
              reasonNote: reasonNote || null,
              memberUrls,
              requestedContext: {
                requestedMemberUrls: memberUrls,
                expectTogether: true,
                requestedKind,
                compatibleTargetStories: isSocialCardAttach && req.body?.targetClusterId
                  ? [String(req.body.targetClusterId)]
                  : [],
                selectedTargetStory: isSocialCardAttach && req.body?.targetClusterId
                  ? String(req.body.targetClusterId)
                  : null,
              },
              alternatives: Array.isArray(req.body?.compatibleTargetStories)
                ? req.body.compatibleTargetStories.slice(0, 20)
                : null,
              outcome: 'requested',
              surface: isSocialCardAttach ? 'curated-social-card' : 'curated-story-controls',
              fromRadar: req.body?.fromRadar === true,
              surfacingState: typeof req.body?.surfacingState === 'string'
                ? req.body.surfacingState.slice(0, 40)
                : null,
            });
          },
          apply: async () => {
            const { MANUAL_LINK_EFFECTIVE_URL_CAP } = await import('./curatedCluster');
            const consolidated = await storage.createCuratedManualLinkConsolidated({
              memberUrls,
              label: typeof label === 'string' ? label.slice(0, 500) : '',
              kind: requestedKind,
              createdBy,
              aiVerdict: verdict,
              aiReasoning: typeof aiReasoning === 'string' ? aiReasoning.slice(0, 400) : '',
              overrodeAi: verdict === 'object' && overrodeAi === true,
              reasonKeys: reasonKeys.length > 0 ? reasonKeys : null,
              reasonNote: reasonNote || null,
              status: 'active',
            }, {
              absorbOverlaps: !isSocialCardAttach,
              effectiveUrlCap: MANUAL_LINK_EFFECTIVE_URL_CAP,
            });
            createdRow = consolidated.row;
            effectiveMemberUrls = consolidated.effectiveMemberUrls;
            effectiveKind = consolidated.effectiveKind;
            if (consolidated.supersededIds.length > 0) {
              console.log(
                `[manual-link] Consolidated ${consolidated.supersededIds.length} overlapping active row(s) into ` +
                  `${consolidated.row.kind} ${consolidated.row.id} (${effectiveMemberUrls.length} member URLs)`,
              );
            }
            return { changed: true, data: { id: consolidated.row.id } };
          },
        },
      }, idempotencyKeyOf(req));
      if (result.status === 'failed') {
        return res.status(503).json({ error: 'Manual link was not saved; retry the request', mutationStatus: result.status });
      }
      const deferred = result.status === 'persisted' || result.status === 'deferred';
      // Verify formation only when the deterministic reshape actually ran inline
      // (the legacy `formed` flag was only meaningful on the idle fast path). A
      // merge that fails the formation gate must not report false success.
      let formed = false;
      if (result.reshaped) {
        try {
          const freshMembers = await storage.getCuratedClusterMembers(6);
          const linkedUrls = new Set(effectiveMemberUrls);
          const clusterIdsHit = new Set(
            freshMembers
              .filter((m) => m.url && linkedUrls.has(normalizeIdentityUrl(m.url) ?? m.url))
              .map((m) => m.clusterId),
          );
          formed = clusterIdsHit.size === 1;
        } catch (e) {
          console.warn('Could not verify manual-link formation outcome (non-fatal):', e);
        }
      }
      res.json({ ok: true, id: (result.data.id as string) ?? (createdRow ? (createdRow as any).id : null), reshaped: result.reshaped, formed, deferred, mutationStatus: result.status });
    } catch (error) {
      console.error('Error saving curated manual link:', error);
      res.status(500).json({ error: 'Failed to save manual link' });
    }
  });

  // (3) ATTACH REASONS to an already-logged override event (post-apply). Used
  // by the dismissible "Provide reason?" prompt that fires after a P-score
  // change or a manual link/merge. The score/merge is already applied — this
  // call is fire-and-forget from the client; a failure never undoes the action.
  // Validates keys against the shared controlled vocabulary before writing.
  app.post("/api/curated/override-event/:id/reasons", requireCuratedEditor, async (req: any, res) => {
    try {
      const eventId = (req.params.id ?? '').toString().trim();
      if (!eventId) return res.status(400).json({ error: 'event id is required' });
      const { SCORE_ADJUST_REASON_KEYS, LINK_MERGE_REASON_KEYS } = await import('@shared/curatedReasonVocab');
      const allowedKeys = new Set([...SCORE_ADJUST_REASON_KEYS, ...LINK_MERGE_REASON_KEYS]);
      const rawKeys = req.body?.reasonKeys;
      const reasonKeys = Array.isArray(rawKeys)
        ? rawKeys.filter((k: unknown) => typeof k === 'string' && allowedKeys.has(k))
        : [];
      const rawNote = req.body?.reasonNote;
      const reasonNote = typeof rawNote === 'string' ? rawNote.trim().slice(0, 500) : null;
      await storage.attachCuratedOverrideEventReasons(eventId, reasonKeys, reasonNote);
      // Task #1180 — a reason attachment UPDATES the mirrored episode's
      // semantics: it can promote a grouping-negative/lineage episode to an
      // explicit incorrect-grouping (negative label) one and refresh its note.
      // Fail-soft duck-typed call; never blocks the reason write.
      await updateEditorialEpisodeReason(storage, {
        sourceEventId: eventId,
        reasonKey: reasonKeys[0] ?? null,
        reasonNote,
        explicitIncorrectGrouping: reasonKeys.some((k: string) => INCORRECT_GROUPING_REASON_KEYS.has(k)),
      });
      res.json({ ok: true });
    } catch (error) {
      console.error('Error attaching reasons to override event:', error);
      res.status(500).json({ error: 'Failed to attach reasons' });
    }
  });

  // (4) UNLINK — revoke an existing manual link (kept in the audit trail as
  // 'revoked') and re-shape so it stops being applied immediately.
  app.post("/api/curated/unlink", requireCuratedEditor, async (req: any, res) => {
    try {
      const id = (req.body?.id ?? '').toString().trim();
      if (!id) return res.status(400).json({ error: 'id is required' });
      const revokedBy = req.user?.claims?.email || 'dev';
      const prior = await storage.getCuratedManualLink(id);
      if (!prior || prior.status !== 'active') {
        return res.status(404).json({ error: 'Manual link not found' });
      }
      // UNDO route — routed through the SAME coordinator. Unlinking only shrinks a
      // grouping (no synthesis). The revoke + 404 detection lives in applyIntent so
      // a missing row surfaces as a no-op the route maps to 404.
      let notFound = false;
      let revoked: Awaited<ReturnType<typeof storage.revokeCuratedManualLink>> | null = null;
      const result = await submitManualMutation({
        kind: 'undo',
        undoOf: `link:${id}`,
        dedupeKey: `unlink:${id}`,
        targets: [{ id: `manual-link:${id}`, seenRevision: 0 }],
        forceSynthesis: false,
        yieldReason: 'manual unlink',
        payload: {
          captureRequired: async () => {
            const firstUrl = Array.isArray(prior.memberUrls) ? prior.memberUrls[0] : undefined;
            return captureRequiredCuratedOverrideEvent({
              action: 'manual-unlink-undo',
              editor: revokedBy,
              newValue:
                `requested revoke of manual ${prior.kind === 'merge' ? 'merge' : 'link'}` +
                (prior.label ? `: ${prior.label.slice(0, 120)}` : ''),
              snapshot: firstUrl ? await resolveCuratedOverrideSnapshot({ url: firstUrl }) : undefined,
              memberUrls: Array.isArray(prior.memberUrls) ? prior.memberUrls : [],
              requestedContext: {
                undoOfOverlayId: id,
                priorKind: prior.kind,
                requestedMemberUrls: Array.isArray(prior.memberUrls) ? prior.memberUrls : [],
              },
              outcome: 'requested',
              surface: 'curated-story-controls',
            });
          },
          apply: async () => {
            revoked = await storage.revokeCuratedManualLink(id, revokedBy);
            if (!revoked) { notFound = true; return { changed: false, reason: 'not found' }; }
            return { changed: true, data: { id } };
          },
        },
      }, idempotencyKeyOf(req));
      if (notFound) return res.status(404).json({ error: 'Manual link not found' });
      if (result.status === 'failed') {
        return res.status(503).json({ error: 'Manual unlink was not saved; retry the request', mutationStatus: result.status });
      }
      res.json({ ok: true, id, reshaped: result.reshaped, mutationStatus: result.status });
    } catch (error) {
      console.error('Error revoking curated manual link:', error);
      res.status(500).json({ error: 'Failed to revoke manual link' });
    }
  });

  // (4b) UNLINK MEMBER — remove ONE item from its cluster (curated-only,
  // editor-gated). Records a member-eviction overlay (curated_manual_evictions)
  // keyed by the item's normalized URL + an anchor-URL snapshot of the OTHER
  // cluster members visible at click time. The eviction fires against any group
  // that still contains >= 1 anchor URL, so it follows the cluster even after
  // membership churn without ever globally hiding the item — it simply stops
  // being absorbed into THAT cluster, re-enters the candidate pool, and is
  // placed wherever its own eligibility dictates on the next pass.
  // A deterministic reshape applies the eviction immediately so the editor
  // sees the item leave the story without waiting for the next cron pass.
  app.post("/api/curated/unlink-member", requireCuratedEditor, async (req: any, res) => {
    try {
      const { memberUrl, anchorUrls, clusterId } = req.body ?? {};
      const cleanMemberUrl = (memberUrl ?? '').toString().trim();
      if (!cleanMemberUrl) return res.status(400).json({ error: 'memberUrl required' });
      const cleanAnchors: string[] = Array.isArray(anchorUrls)
        ? anchorUrls
            .map((u: any) => (u ?? '').toString().trim())
            .filter((u: string) => u.length > 0)
        : [];
      const createdBy = req.user?.claims?.email || 'dev';
      const label = cleanAnchors.length > 0
        ? `removed from cluster (${cleanAnchors.length} anchors)`
        : 'removed from cluster';
      // Member-eviction overlay — shrinks a grouping only (no synthesis).
      const result = await submitManualMutation({
        kind: 'unlink',
        dedupeKey: `unlink-member:${cleanMemberUrl}:${cleanAnchors.slice().sort().join('|')}`,
        targets: [{ id: `member:${cleanMemberUrl}`, seenRevision: 0 }],
        forceSynthesis: false,
        yieldReason: 'unlink member',
        payload: {
          captureRequired: async () => {
            return captureRequiredCuratedOverrideEvent({
              action: 'manual-unlink-member',
              editor: createdBy,
              itemUrl: cleanMemberUrl,
              newValue: `requested member unlink${clusterId ? ` from cluster ${String(clusterId).slice(0, 32)}` : ''}`,
              snapshot: await resolveCuratedOverrideSnapshot({ url: cleanMemberUrl }),
              memberUrls: [cleanMemberUrl, ...cleanAnchors],
              requestedContext: {
                requestedMemberUrls: [cleanMemberUrl],
                requestedSeparateFromUrls: cleanAnchors,
                expectTogether: false,
                sourceClusterId: clusterId ?? null,
              },
              outcome: 'requested',
              surface: 'curated-story-controls',
            });
          },
          apply: async () => {
            const row = await storage.createCuratedManualEviction({
              evictedUrl: cleanMemberUrl,
              anchorUrls: cleanAnchors,
              label,
              createdBy,
              status: 'active',
            });
            return { changed: true, data: { id: row.id } };
          },
        },
      }, idempotencyKeyOf(req));
      if (result.status === 'failed') {
        return res.status(503).json({ error: 'Member unlink was not saved; retry the request', mutationStatus: result.status });
      }
      res.json({ ok: true, id: (result.data.id as string) ?? null, reshaped: result.reshaped, mutationStatus: result.status });
    } catch (error) {
      console.error('Error creating curated member eviction:', error);
      res.status(500).json({ error: 'Failed to unlink member' });
    }
  });

  // (4) LIST recent manual links (active + revoked) for the Source Oversight
  // editor-update trail. CURATED-LANE ONLY (requireCuratedAccess).
  app.get("/api/curated/manual-links", requireCuratedAccess, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, parseInt(String(req.query?.limit ?? '100'), 10) || 100));
      const archiveMode = req.query.archive === '1';
      const settings = await storage.getCuratedFeedbackSettings();
      const ack = settings.acknowledgedAt ? new Date(settings.acknowledgedAt) : null;
      // Archive mode: links created BEFORE the last reset (pre-reset history).
      // Active mode: links created AFTER the last reset (post-reset, or all if no reset has run).
      const links = archiveMode
        ? (ack ? await storage.getRecentCuratedManualLinks(limit, null, ack) : [])
        : await storage.getRecentCuratedManualLinks(limit, ack, null);
      res.json({ ok: true, links, acknowledgedAt: settings.acknowledgedAt ?? null });
    } catch (error) {
      console.error('Error listing curated manual links:', error);
      res.status(500).json({ error: 'Failed to list manual links' });
    }
  });

  // ===========================================================================
  // Curated lane — editor manual EVICTION overlay. The inverse of manual-link:
  // it PULLS one wrongly-merged member OUT of a story. Persists an overlay row
  // (evicted URL + an anchor snapshot of its siblings), invalidates the curated
  // read cache, and runs a deterministic re-shape so the split shows instantly.
  // The overlay only fires against a group still holding the anchor-guard
  // fraction of its siblings, so it targets the wrong cluster and no other, and
  // can NEVER split a legitimately-merged member. CURATED-LANE ONLY.
  // ===========================================================================

  // (1) EVICT — remove one member from the story it was wrongly merged into.
  app.post("/api/curated/evict-item", requireCuratedEditor, async (req: any, res) => {
    try {
      const evictedUrl = normalizeIdentityUrl(String(req.body?.evictedUrl ?? '').trim());
      if (!evictedUrl) {
        return res.status(400).json({ error: 'A valid evictedUrl is required' });
      }
      // Anchor snapshot = the OTHER members on screen at click time. Normalize,
      // dedup, and drop the evicted URL itself. We need ≥2 anchors so the overlay
      // can positively identify the wrongly-merged cluster (fail-closed no-op if
      // that cluster later disperses).
      const anchorUrls = buildManualLinkMemberUrls(req.body?.anchorUrls).filter((u) => u !== evictedUrl);
      if (anchorUrls.length < 2) {
        return res.status(400).json({ error: 'At least two anchor (sibling) URLs are required to target the story' });
      }
      const { LINK_MERGE_REASON_KEYS } = await import('@shared/curatedReasonVocab');
      const rawReasonKeys = req.body?.reasonKeys;
      const reasonKeys = Array.isArray(rawReasonKeys)
        ? rawReasonKeys.filter((k: unknown) => typeof k === 'string' && LINK_MERGE_REASON_KEYS.has(k))
        : [];
      const rawReasonNote = req.body?.reasonNote;
      const reasonNote = typeof rawReasonNote === 'string' ? rawReasonNote.trim().slice(0, 500) : null;
      const createdBy = req.user?.claims?.email || 'dev';
      const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 500) : '';
      // Eviction splits a wrongly-merged story → wants a background synthesis
      // refresh (shrunken story + newly-standalone item), coalesced + bounded.
      const result = await submitManualMutation({
        kind: 'evict',
        dedupeKey: `evict:${evictedUrl}:${anchorUrls.slice().sort().join('|')}`,
        targets: [{ id: `member:${evictedUrl}`, seenRevision: 0 }],
        wantsSynthesis: true,
        forceSynthesis: true,
        yieldReason: 'manual evict',
        payload: {
          captureRequired: async () => {
            const snapshot = await resolveCuratedOverrideSnapshot({ url: evictedUrl });
            return captureRequiredCuratedOverrideEvent({
              action: 'manual-evict',
              editor: createdBy,
              newValue: (`requested eviction${label ? ` from ${label.slice(0, 200)}` : ''}`).slice(0, 500),
              snapshot,
              reasonKeys: reasonKeys.length > 0 ? reasonKeys : null,
              reasonNote: reasonNote || null,
              memberUrls: [evictedUrl, ...anchorUrls],
              requestedContext: {
                requestedMemberUrls: [evictedUrl],
                requestedSeparateFromUrls: anchorUrls,
                expectTogether: false,
              },
              outcome: 'requested',
              surface: 'curated-story-controls',
            });
          },
          apply: async () => {
            const row = await storage.createCuratedManualEviction({
              evictedUrl,
              anchorUrls,
              label,
              createdBy,
              reasonKeys: reasonKeys.length > 0 ? reasonKeys : null,
              reasonNote: reasonNote || null,
              status: 'active',
            });
            return { changed: true, data: { id: row.id } };
          },
        },
      }, idempotencyKeyOf(req));
      if (result.status === 'failed') {
        return res.status(503).json({ error: 'Eviction was not saved; retry the request', mutationStatus: result.status });
      }
      // `deferred` preserved: true when the reshape was deferred behind a busy
      // pass (persisted) or fully deferred — i.e. not applied inline this request.
      const deferred = result.status === 'persisted' || result.status === 'deferred';
      res.json({ ok: true, id: (result.data.id as string) ?? null, reshaped: result.reshaped, deferred, mutationStatus: result.status });
    } catch (error) {
      console.error('Error saving curated manual eviction:', error);
      res.status(500).json({ error: 'Failed to save eviction' });
    }
  });

  // (2) UNEVICT — revoke an eviction (kept as 'revoked' in the audit trail) so
  // the item can re-merge on the next pass, and re-shape immediately.
  app.post("/api/curated/unevict", requireCuratedEditor, async (req: any, res) => {
    try {
      const id = (req.body?.id ?? '').toString().trim();
      if (!id) return res.status(400).json({ error: 'id is required' });
      const revokedBy = req.user?.claims?.email || 'dev';
      const prior = await storage.getCuratedManualEviction(id);
      if (!prior || prior.status !== 'active') {
        return res.status(404).json({ error: 'Eviction not found' });
      }
      // UNDO route — same coordinator. Un-evicting may re-merge the item, so it
      // wants a bounded background synthesis refresh. No clustering-yield (an undo
      // is not time-critical enough to preempt an in-flight pass — preserves the
      // legacy behavior where unevict never called requestCuratedClusteringYield).
      let notFound = false;
      let revoked: Awaited<ReturnType<typeof storage.revokeCuratedManualEviction>> | null = null;
      const result = await submitManualMutation({
        kind: 'undo',
        undoOf: `evict:${id}`,
        dedupeKey: `unevict:${id}`,
        targets: [{ id: `manual-eviction:${id}`, seenRevision: 0 }],
        wantsSynthesis: true,
        forceSynthesis: true,
        payload: {
          captureRequired: async () => {
            return captureRequiredCuratedOverrideEvent({
              action: 'manual-unevict',
              editor: revokedBy,
              newValue: `requested revoke of eviction${prior.label ? `: ${prior.label.slice(0, 120)}` : ''}`,
              snapshot: prior.evictedUrl ? await resolveCuratedOverrideSnapshot({ url: prior.evictedUrl }) : undefined,
              memberUrls: [prior.evictedUrl, ...(prior.anchorUrls ?? [])].filter(Boolean) as string[],
              requestedContext: {
                undoOfOverlayId: id,
                requestedMemberUrls: [prior.evictedUrl].filter(Boolean),
              },
              outcome: 'requested',
              surface: 'curated-story-controls',
            });
          },
          apply: async () => {
            revoked = await storage.revokeCuratedManualEviction(id, revokedBy);
            if (!revoked) { notFound = true; return { changed: false, reason: 'not found' }; }
            return { changed: true, data: { id } };
          },
        },
      }, idempotencyKeyOf(req));
      if (notFound) return res.status(404).json({ error: 'Eviction not found' });
      if (result.status === 'failed') {
        return res.status(503).json({ error: 'Eviction restore was not saved; retry the request', mutationStatus: result.status });
      }
      res.json({ ok: true, id, reshaped: result.reshaped, mutationStatus: result.status });
    } catch (error) {
      console.error('Error revoking curated manual eviction:', error);
      res.status(500).json({ error: 'Failed to revoke eviction' });
    }
  });

  // (3) LIST recent evictions (active + revoked) for the Source Oversight
  // editor-update trail. CURATED-LANE ONLY (requireCuratedAccess).
  app.get("/api/curated/evictions", requireCuratedAccess, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, parseInt(String(req.query?.limit ?? '100'), 10) || 100));
      const archiveMode = req.query.archive === '1';
      const settings = await storage.getCuratedFeedbackSettings();
      const ack = settings.acknowledgedAt ? new Date(settings.acknowledgedAt) : null;
      const evictions = archiveMode
        ? (ack ? await storage.getRecentCuratedManualEvictions(limit, null, ack) : [])
        : await storage.getRecentCuratedManualEvictions(limit, ack, null);
      res.json({ ok: true, evictions, acknowledgedAt: settings.acknowledgedAt ?? null });
    } catch (error) {
      console.error('Error listing curated manual evictions:', error);
      res.status(500).json({ error: 'Failed to list evictions' });
    }
  });

  // ===========================================================================
  // Curated lane — editor manual MOVE overlay ("this belongs in that OTHER
  // story"): atomic evict-from-source + attach-to-target in ONE decision.
  // A DEDICATED overlay (curated_manual_moves), NOT an eviction + link
  // composite — the link reconcile runs BEFORE evictions each pass, so a link
  // naming the item plus target members would FUSE the two clusters. The
  // engine applies moves AFTER evictions (applyManualMoves) with the same
  // fail-closed anchor guards; if the target story disperses, the move
  // degrades to a plain eviction (item standalone, never lost, never leaked).
  // CURATED-LANE ONLY.
  // ===========================================================================

  // (1) MOVE — re-home one member into a different story.
  app.post("/api/curated/move-member", requireCuratedEditor, async (req: any, res) => {
    try {
      const itemUrl = normalizeIdentityUrl(String(req.body?.itemUrl ?? '').trim());
      if (!itemUrl) {
        return res.status(400).json({ error: 'A valid itemUrl is required' });
      }
      // Source anchors = the item's CURRENT siblings at click time (may be
      // empty when moving a standalone item). Target anchors = the destination
      // story's members; >= 2 required so the overlay can positively identify
      // the target cluster (a formed story always has >= 2 members).
      const sourceAnchorUrls = buildManualLinkMemberUrls(req.body?.sourceAnchorUrls).filter((u) => u !== itemUrl);
      const targetAnchorUrls = buildManualLinkMemberUrls(req.body?.targetAnchorUrls).filter((u) => u !== itemUrl);
      if (targetAnchorUrls.length < 2) {
        return res.status(400).json({ error: 'At least two target (destination story) URLs are required' });
      }
      // A URL can't be on both sides of the move — target wins (it names intent).
      const targetSet = new Set(targetAnchorUrls);
      const cleanSourceAnchors = sourceAnchorUrls.filter((u) => !targetSet.has(u));
      const { LINK_MERGE_REASON_KEYS } = await import('@shared/curatedReasonVocab');
      const rawReasonKeys = req.body?.reasonKeys;
      const reasonKeys = Array.isArray(rawReasonKeys)
        ? rawReasonKeys.filter((k: unknown) => typeof k === 'string' && LINK_MERGE_REASON_KEYS.has(k))
        : [];
      const rawReasonNote = req.body?.reasonNote;
      const reasonNote = typeof rawReasonNote === 'string' ? rawReasonNote.trim().slice(0, 500) : null;
      const createdBy = req.user?.claims?.email || 'dev';
      const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 500) : '';
      // A move re-homes an item (shrinks source, grows target) → wants bounded,
      // coalesced background synthesis. The LATEST-WINS revoke of conflicting
      // move/eviction/link rows + the move-row create ALL run inside applyIntent
      // so they are serialized with every other manual mutation and never
      // interleave with a concurrent edit. Each revoke stays fail-soft.
      const result = await submitManualMutation({
        kind: 'move',
        dedupeKey: `move:${itemUrl}:${targetAnchorUrls.slice().sort().join('|')}`,
        targets: [{ id: `member:${itemUrl}`, seenRevision: 0 }],
        wantsSynthesis: true,
        forceSynthesis: true,
        yieldReason: 'move member',
        payload: {
          captureRequired: async () => {
            const snapshot = await resolveCuratedOverrideSnapshot({ url: itemUrl });
            return captureRequiredCuratedOverrideEvent({
              action: 'manual-move',
              editor: createdBy,
              newValue: (`requested move${label ? ` to ${label.slice(0, 200)}` : ' to another story'}`).slice(0, 500),
              snapshot,
              reasonKeys: reasonKeys.length > 0 ? reasonKeys : null,
              reasonNote: reasonNote || null,
              memberUrls: [itemUrl, ...targetAnchorUrls, ...cleanSourceAnchors],
              requestedContext: {
                requestedMemberUrls: [itemUrl, ...targetAnchorUrls],
                requestedSeparateFromUrls: cleanSourceAnchors,
                expectTogether: true,
                selectedTargetStory: req.body?.targetClusterId ?? null,
                sourceClusterId: req.body?.sourceClusterId ?? null,
              },
              alternatives: Array.isArray(req.body?.compatibleTargetStories)
                ? req.body.compatibleTargetStories.slice(0, 20)
                : null,
              outcome: 'requested',
              surface: 'curated-story-controls',
            });
          },
          apply: async () => {
            // LATEST-WINS: newest decision supersedes older active move/eviction/
            // link naming this item. Fail-soft — a revoke hiccup never blocks the
            // move itself.
            try {
              await storage.revokeActiveCuratedManualMovesForUrl(itemUrl);
            } catch (e) {
              console.warn('[move-member] Could not revoke prior moves for url (continuing):', e);
            }
            try {
              const activeEvictions = await storage.getActiveCuratedManualEvictions();
              for (const ev of activeEvictions) {
                if (normalizeIdentityUrl(ev.evictedUrl ?? '') === itemUrl) {
                  await storage.revokeCuratedManualEviction(ev.id, createdBy);
                }
              }
            } catch (e) {
              console.warn('[move-member] Could not revoke conflicting evictions (continuing):', e);
            }
            try {
              const activeLinks = await storage.getActiveCuratedManualLinks();
              for (const ln of activeLinks) {
                const members = (ln.memberUrls ?? []).map((u) => normalizeIdentityUrl(u ?? ''));
                if (members.includes(itemUrl)) {
                  await storage.revokeCuratedManualLink(ln.id, createdBy);
                }
              }
            } catch (e) {
              console.warn('[move-member] Could not revoke conflicting links (continuing):', e);
            }
            const row = await storage.createCuratedManualMove({
              itemUrl,
              sourceAnchorUrls: cleanSourceAnchors,
              targetAnchorUrls,
              label,
              createdBy,
              reasonKeys: reasonKeys.length > 0 ? reasonKeys : null,
              reasonNote: reasonNote || null,
              status: 'active',
            });
            return { changed: true, data: { id: row.id } };
          },
        },
      }, idempotencyKeyOf(req));
      if (result.status === 'failed') {
        return res.status(503).json({ error: 'Move was not saved; retry the request', mutationStatus: result.status });
      }
      const deferred = result.status === 'persisted' || result.status === 'deferred';
      res.json({ ok: true, id: (result.data.id as string) ?? null, reshaped: result.reshaped, deferred, mutationStatus: result.status });
    } catch (error) {
      console.error('Error saving curated manual move:', error);
      res.status(500).json({ error: 'Failed to save move' });
    }
  });

  // (2) UNMOVE — revoke a move (kept as 'revoked' in the audit trail) so the
  // item can re-settle wherever eligibility dictates on the next pass.
  app.post("/api/curated/unmove", requireCuratedEditor, async (req: any, res) => {
    try {
      const id = (req.body?.id ?? '').toString().trim();
      if (!id) return res.status(400).json({ error: 'id is required' });
      const revokedBy = req.user?.claims?.email || 'dev';
      const prior = await storage.getCuratedManualMove(id);
      if (!prior || prior.status !== 'active') {
        return res.status(404).json({ error: 'Move not found' });
      }
      // UNDO route — same coordinator. Un-moving lets the item re-settle → wants
      // bounded background synthesis. No clustering-yield (preserves the legacy
      // unmove behavior which never called requestCuratedClusteringYield).
      let notFound = false;
      let revoked: Awaited<ReturnType<typeof storage.revokeCuratedManualMove>> | null = null;
      const result = await submitManualMutation({
        kind: 'undo',
        undoOf: `move:${id}`,
        dedupeKey: `unmove:${id}`,
        targets: [{ id: `manual-move:${id}`, seenRevision: 0 }],
        wantsSynthesis: true,
        forceSynthesis: true,
        payload: {
          captureRequired: async () => {
            return captureRequiredCuratedOverrideEvent({
              action: 'manual-unmove',
              editor: revokedBy,
              newValue: `requested revoke of move${prior.label ? `: ${prior.label.slice(0, 120)}` : ''}`,
              snapshot: prior.itemUrl ? await resolveCuratedOverrideSnapshot({ url: prior.itemUrl }) : undefined,
              memberUrls: [
                prior.itemUrl,
                ...(prior.sourceAnchorUrls ?? []),
                ...(prior.targetAnchorUrls ?? []),
              ].filter(Boolean) as string[],
              requestedContext: {
                undoOfOverlayId: id,
                requestedMemberUrls: [prior.itemUrl].filter(Boolean),
              },
              outcome: 'requested',
              surface: 'curated-story-controls',
            });
          },
          apply: async () => {
            revoked = await storage.revokeCuratedManualMove(id, revokedBy);
            if (!revoked) { notFound = true; return { changed: false, reason: 'not found' }; }
            return { changed: true, data: { id } };
          },
        },
      }, idempotencyKeyOf(req));
      if (notFound) return res.status(404).json({ error: 'Move not found' });
      if (result.status === 'failed') {
        return res.status(503).json({ error: 'Move restore was not saved; retry the request', mutationStatus: result.status });
      }
      res.json({ ok: true, id, reshaped: result.reshaped, mutationStatus: result.status });
    } catch (error) {
      console.error('Error revoking curated manual move:', error);
      res.status(500).json({ error: 'Failed to revoke move' });
    }
  });

  // (3) LIST recent moves (active + revoked) for the Source Oversight
  // editor-update trail. CURATED-LANE ONLY (requireCuratedAccess).
  app.get("/api/curated/moves", requireCuratedAccess, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, parseInt(String(req.query?.limit ?? '100'), 10) || 100));
      const archiveMode = req.query.archive === '1';
      const settings = await storage.getCuratedFeedbackSettings();
      const ack = settings.acknowledgedAt ? new Date(settings.acknowledgedAt) : null;
      const moves = archiveMode
        ? (ack ? await storage.getRecentCuratedManualMoves(limit, null, ack) : [])
        : await storage.getRecentCuratedManualMoves(limit, ack, null);
      res.json({ ok: true, moves, acknowledgedAt: settings.acknowledgedAt ?? null });
    } catch (error) {
      console.error('Error listing curated manual moves:', error);
      res.status(500).json({ error: 'Failed to list moves' });
    }
  });

  // ===========================================================================
  // Curated lane (Task #1180) — EDITORIAL EVIDENCE, not standing rules.
  //
  // The old learned-rule generation/decision routes (approve/reject/snooze/
  // revoke of auto-mined "rules") are REPLACED. Manual editor actions are now
  // captured as immutable EVIDENCE (see server/editorialEvidenceCapture.ts +
  // shared/editorialEvidence.ts) and surfaced for a development agent to learn
  // from — nothing here is ever auto-enforced.
  //
  //   GET  /api/curated/editorial-evidence          → rich episode explorer +
  //                                                    SEPARATE workload counts.
  //   GET  /api/curated/editorial-evidence/packet   → deterministic redacted
  //                                                    Markdown packet (filters,
  //                                                    default ambiguous exclude).
  //   GET  /api/curated/legacy-learning             → FROZEN inventory (inert).
  //   POST /api/curated/legacy-learning/:id/disposition → explicit FROZEN
  //                                                    disposition on an inert
  //                                                    inventory row ONLY
  //                                                    (never enforcement).
  //
  // CURATED-LANE ONLY (requireCuratedAccess). No AI. No enforcement. Direct
  // overlays (hide/pin/link/etc.) are untouched — this lane only OBSERVES.
  // ===========================================================================

  // Parse the CLIENT evidence-filter contract from a request query. Mirrors
  // shared/client editorialEvidence.ts evidenceQueryParams(): since/until (epoch
  // ms), families (csv), commentedOnly, unresolvedOnly, representativeLimitPerFamily.
  // The reset checkpoint (ackMs) is folded into `since` so we never surface
  // evidence from before the last acknowledgement.
  const parseEvidenceFilters = (req: any, ackMs: number | null) => {
    const q = req.query ?? {};
    const parseMs = (v: unknown): number | null => {
      const n = parseInt(String(v ?? ''), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    let since = parseMs(q.since);
    if (ackMs != null) since = since != null ? Math.max(since, ackMs) : ackMs;
    const until = parseMs(q.until);
    const allowedFamilies = new Set([
      'priority', 'grouping-positive', 'grouping-negative', 'metadata', 'lineage',
    ]);
    const familiesRaw = String(q.families ?? '').trim();
    const families = familiesRaw
      ? (familiesRaw.split(',').map((f: string) => f.trim()).filter((f: string) => allowedFamilies.has(f)) as any[])
      : null;
    const truthy = (v: unknown) => v === '1' || v === 'true' || v === true;
    const rawLimit = parseInt(String(q.representativeLimitPerFamily ?? q.limitPerFamily ?? ''), 10);
    const representativeLimitPerFamily = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null;
    return {
      since,
      until,
      families: families && families.length ? families : null,
      commentedOnly: truthy(q.commentedOnly),
      unresolvedOnly: truthy(q.unresolvedOnly),
      representativeLimitPerFamily,
    };
  };

  // Load the durable editorial episodes matching the coarse family filter (the
  // finer filters — window / commented / unresolved / sampling — are applied by
  // the pure filter after adaptation). PRIMARY truth for the evidence lane.
  const loadDurableEpisodes = async (filters: { families?: any[] | null }) => {
    try {
      const family = filters.families && filters.families.length === 1 ? filters.families[0] : undefined;
      return await storage.listCuratedEditorialEpisodes({ actionFamily: family, limit: 2000 });
    } catch (e: any) {
      console.warn('[editorial-evidence] durable episode load failed (fallback to raw):', e?.message || e);
      return [];
    }
  };

  // Map a frozen inventory row to the CLIENT LegacyLearningItem shape. The
  // editor's explicit disposition (archive/discard/acknowledge) can be overlaid
  // when just recorded. Blast radius is context-only (what the rule WOULD have
  // touched); it is never enforced.
  const mapLegacyInventoryItem = (
    r: any,
    override?: { disposition?: string; dispositionedBy?: string },
  ) => {
    // Frozen review STATUS derived from the migration disposition.
    const statusMap: Record<string, string> = {
      'frozen-review': 'frozen',
      'historical-only': 'frozen',
      'historical-other': 'frozen',
    };
    const status = statusMap[String(r.disposition ?? '')] ?? 'frozen';
    // Explicit editor disposition is stored on the inert inventory row itself.
    // Payload fallbacks preserve compatibility with rows captured by the brief
    // fail-soft transition implementation.
    const payload = (r.payload && typeof r.payload === 'object') ? r.payload : {};
    const editorDisp = override?.disposition
      ?? (['acknowledge', 'archive', 'discard'].includes(String(r.disposition ?? '')) ? r.disposition : null)
      ?? (typeof payload.__disposition === 'string' ? payload.__disposition : null);
    const editorBy = override?.dispositionedBy
      ?? r.dispositionedBy
      ?? (typeof payload.__dispositionedBy === 'string' ? payload.__dispositionedBy : null);
    const editorAt = r.dispositionedAt
      ? new Date(r.dispositionedAt).toISOString()
      : (typeof payload.__dispositionedAt === 'string' ? payload.__dispositionedAt : null);
    const blast = (payload.__blastRadius && typeof payload.__blastRadius === 'object')
      ? payload.__blastRadius
      : null;
    return {
      id: r.id,
      ruleType: r.ruleType ?? '',
      label: r.label ?? '',
      status,
      blastRadius: blast
        ? {
            affectedCount: Number(blast.affectedCount ?? 0) || 0,
            distinctStoryCount: Number(blast.distinctStoryCount ?? 0) || 0,
            windowDays: blast.windowDays != null ? Number(blast.windowDays) : null,
            basis: typeof blast.basis === 'string' ? blast.basis : null,
          }
        : {
            affectedCount: r.evidenceCount ?? 0,
            distinctStoryCount: 0,
            windowDays: null,
            basis: 'frozen inventory (context only — never enforced)',
          },
      evidenceCount: r.evidenceCount ?? 0,
      createdAt: r.frozenAt ? new Date(r.frozenAt).toISOString() : null,
      disposition: editorDisp,
      dispositionedBy: editorBy,
      dispositionedAt: editorAt,
    };
  };

  // Episode-explorer + workload telemetry. Reads the immutable override-event
  // rows in the window (honoring the reset checkpoint), maps them through the
  // PURE evidence module, and returns BOTH the collapsed episodes and the
  // honest workload tally — kept as SEPARATE fields so "work done" and
  // "learnable evidence" are never conflated. Optional ?days=N (1..180, def 90).
  app.get("/api/curated/editorial-evidence", requireCuratedAccess, async (req, res) => {
    try {
      const settings = await storage.getCuratedFeedbackSettings();
      const ack = settings.acknowledgedAt ? new Date(settings.acknowledgedAt) : null;
      const ackMs = ack ? ack.getTime() : null;

      // Parse the CLIENT filter contract (shared/client editorialEvidence.ts):
      //   since / until (epoch ms) · families (csv) · commentedOnly ·
      //   unresolvedOnly · representativeLimitPerFamily.
      const filters = parseEvidenceFilters(req, ackMs);
      const scopeLabel = ack
        ? `since reset checkpoint ${ack.toISOString()}`
        : "all captured evidence";

      // PRIMARY source of truth: durable curated editorial episodes. They carry
      // the actual lifecycle/persistence/contradiction/lineage/provenance the
      // explorer needs. Raw override events are used ONLY as a pre-migration
      // fallback for windows that predate durable capture.
      const dbRows = await loadDurableEpisodes(filters);
      let episodes;
      let lineage;
      if (dbRows.length > 0) {
        episodes = adaptDbEpisodes(dbRows);
        lineage = lineageFromDbEpisodes(dbRows);
      } else {
        // Pre-migration fallback: project the immutable override events.
        const since = filters.since != null ? new Date(filters.since) : new Date(0);
        const rawEvents = await storage.getCuratedOverrideEventsSince(since, 5000);
        const explorer = buildEpisodeExplorer(rawEvents);
        episodes = explorer.episodes;
        lineage = undefined;
      }

      // Client-facing response (rich episodes + counts) — the default ambiguous
      // exclusion + representative sampling are applied by the pure filter.
      const response = buildEvidenceResponse(episodes, { filters, scopeLabel, lineage });

      // SEPARATE raw workload telemetry (honest "work done" tally) computed from
      // the immutable override rows — never conflated with learnable evidence.
      const workloadSince = filters.since != null ? new Date(filters.since) : new Date(0);
      const rawForWorkload = await storage.getCuratedOverrideEventsSince(workloadSince, 5000);
      const { workload } = buildEpisodeExplorer(rawForWorkload);

      res.json({
        // Client EditorialEvidenceResponse contract.
        schemaVersion: response.schemaVersion,
        scopeLabel: response.scopeLabel,
        counts: response.counts,
        redactedFields: response.redactedFields,
        episodes: response.episodes,
        excludedAmbiguous: response.excludedAmbiguous,
        // SEPARATE raw workload counts (honest "work done" telemetry).
        workload,
        acknowledgedAt: settings.acknowledgedAt ?? null,
        source: dbRows.length > 0 ? "durable-episodes" : "raw-events-fallback",
      });
    } catch (error) {
      console.error('Error building curated editorial evidence:', error);
      res.status(500).json({ error: 'Failed to build editorial evidence' });
    }
  });

  // Deterministic redacted Markdown packet for a development agent to copy.
  // Byte-for-byte reproducible for identical input. Query filters:
  //   ?days=N                         window (1..180, default 90)
  //   ?families=priority,metadata,... restrict to families
  //   ?commentedOnly=1                only episodes carrying an editor note
  //   ?unresolvedOnly=1               only conflicted/deferred/failed/dormant
  //   ?limitPerFamily=N               representative sampling cap
  //   ?includeAmbiguous=1             INCLUDE ambiguous/unverified (default is
  //                                   to EXCLUDE and report them separately)
  // The default ambiguous exclusion is enforced by the pure module; passing
  // includeAmbiguous=1 flips only whether they appear in the body (still counted).
  app.get("/api/curated/editorial-evidence/packet", requireCuratedAccess, async (req, res) => {
    try {
      const settings = await storage.getCuratedFeedbackSettings();
      const ack = settings.acknowledgedAt ? new Date(settings.acknowledgedAt) : null;
      const ackMs = ack ? ack.getTime() : null;

      // Same CLIENT filter contract as the list endpoint so the copied Markdown
      // packet describes the IDENTICAL filtered scope as the on-screen view.
      const filters = parseEvidenceFilters(req, ackMs);
      const scopeLabel = ack
        ? `since reset checkpoint ${ack.toISOString()}`
        : "all captured evidence";

      // PRIMARY: durable episodes; raw-event projection only as fallback.
      const dbRows = await loadDurableEpisodes(filters);
      let markdown: string;
      if (dbRows.length > 0) {
        const episodes = adaptDbEpisodes(dbRows);
        markdown = buildEvidenceMarkdownFromEpisodes(episodes, { scopeLabel, filters });
      } else {
        const since = filters.since != null ? new Date(filters.since) : new Date(0);
        const rawEvents = await storage.getCuratedOverrideEventsSince(since, 5000);
        markdown = buildEvidenceMarkdown(rawEvents, { scopeLabel, filters });
      }

      // Return as text/markdown so the client can copy it directly; the JSON
      // packet is embedded in a fenced block inside the Markdown.
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(markdown);
    } catch (error) {
      console.error('Error building curated editorial-evidence packet:', error);
      res.status(500).json({ error: 'Failed to build editorial-evidence packet' });
    }
  });

  // FROZEN legacy-learning INVENTORY (read-only). The pre-#1180 auto-mined
  // learned rules were frozen into curated_legacy_rule_inventory by the
  // migration; this endpoint surfaces that inert inventory for review. Nothing
  // here is enforced, ever. Each item includes a context-only BLAST RADIUS (what
  // the rule WOULD have affected) and the editor's explicit disposition (if any).
  app.get("/api/curated/legacy-learning", requireCuratedAccess, async (_req, res) => {
    try {
      const rows = await storage.listCuratedLegacyRuleInventory();
      const items = rows.map((r) => mapLegacyInventoryItem(r));
      res.json({ items });
    } catch (error) {
      console.error('Error listing frozen legacy-learning inventory:', error);
      res.status(500).json({ error: 'Failed to list legacy-learning inventory' });
    }
  });

  // FROZEN legacy-learning DISPOSITION. Records the editor's explicit decision
  // (acknowledge / archive / discard) on a frozen inventory row. It NEVER
  // enables enforcement, NEVER mutates curated_learned_rules, NEVER writes an
  // outlet override or invalidates an enforcement cache — it only stamps the
  // reviewer's disposition against the inert frozen inventory.
  app.post("/api/curated/legacy-learning/:id/disposition", requireCuratedEditor, async (req: any, res) => {
    try {
      const id = (req.params.id ?? '').toString().trim();
      if (!id) return res.status(400).json({ error: 'id required' });
      const rawDisp = (req.body?.disposition ?? '').toString().trim();
      // Only the frozen, non-enforcing client dispositions are permitted.
      if (!LEGACY_DISPOSITIONS.includes(rawDisp as any)) {
        return res.status(400).json({
          error: `disposition must be one of: ${LEGACY_DISPOSITIONS.join(', ')}`,
        });
      }
      // Resolve the frozen inventory row (by inventory id or source rule id).
      const inventory = await storage.listCuratedLegacyRuleInventory();
      const row = inventory.find((r) => r.id === id || r.legacyRuleId === id);
      if (!row) return res.status(404).json({ error: 'Frozen legacy rule not found' });

      const decidedBy = req.user?.claims?.email || 'dev';
      // Persist the reviewer's disposition against the FROZEN inventory only.
      // Fail-soft + duck-typed: never enforcement, never a rule mutation.
      const stored = await recordLegacyRuleDisposition(storage, {
        inventoryId: row.id,
        legacyRuleId: row.legacyRuleId,
        disposition: rawDisp as any,
        dispositionedBy: decidedBy,
      });
      res.json({
        ok: true,
        disposition: rawDisp,
        dispositionedBy: decidedBy,
        persisted: stored,
        item: mapLegacyInventoryItem(row, { disposition: rawDisp, dispositionedBy: decidedBy }),
      });
    } catch (error) {
      console.error('Error recording legacy-learning disposition:', error);
      res.status(500).json({ error: 'Failed to record legacy-learning disposition' });
    }
  });

  // Curated lane (Task #226) — REPLACE a dead curated link. Allowlist-gated
  // (requireCuratedAccess). Only curated items can be replaced (main-feed rows are
  // never liveness-flagged). The new URL is validated through isPublicFetchableUrl
  // (same SSRF guard as auto-fill) before anything is written. We store the
  // replacement in the curated-only overlay (curated_items.url is NEVER mutated, so
  // clustering identity stays stable), clear the dead flag, and reset the media
  // cache so the next enrichment pass re-fetches image + bullets from the new URL.
  // Confined to the curated lane — never touches the main feed or public API.
  app.post("/api/curated/replace-link", requireCuratedAccess, async (req: any, res) => {
    try {
      const { type, id, url } = req.body ?? {};
      if (type !== 'curated') {
        return res.status(400).json({ error: "Only curated items can be replaced" });
      }
      const itemId = (id ?? '').toString().trim();
      if (!itemId) return res.status(400).json({ error: 'id required' });
      const newUrl = (url ?? '').toString().trim();
      if (!newUrl) return res.status(400).json({ error: 'url required' });

      const { isPublicFetchableUrl } = await import('./streamPrefetch');
      if (!(await isPublicFetchableUrl(newUrl))) {
        return res.status(400).json({ error: 'URL is not a valid, publicly fetchable address' });
      }

      const key = `curated:${itemId}`;
      const updatedBy = req.user?.claims?.email || 'dev';
      const snapshot = await resolveCuratedOverrideSnapshot({ scope: 'standalone', type: 'curated', id: itemId });
      // Store overlay first, then clear the flag + reset media so a crash can't
      // leave the row un-dead but still pointing at the broken URL.
      await storage.setCuratedLinkReplacement(key, newUrl, updatedBy);
      await storage.applyCuratedLinkReplacement(itemId);
      // The replacement changes the DISPLAY url + clears the unavailable state for
      // both surfaces immediately, so drop their caches (incl. the narratives
      // lens if this item surfaces there — Task #633).
      invalidateCuratedCache('top-stories');
      invalidateCuratedCache('cluster-members');
      invalidateCuratedCache('state-narratives');
      await captureCuratedOverrideEvent({
        action: 'replace-link', editor: updatedBy, snapshot, storyKey: key,
        newValue: `link replaced → ${newUrl}`,
      });
      res.json({ ok: true, key, url: newUrl });
    } catch (error) {
      console.error('Error replacing curated link:', error);
      res.status(500).json({ error: 'Failed to replace curated link' });
    }
  });

  // Curated lane (Task #380) — editor HIDE / UN-HIDE a curated story. Allowlist-
  // gated (requireCuratedAccess). Hiding writes to the curated-only hidden overlay
  // (curated_hidden_stories) keyed by a SERVER-BUILT story key so the client can't
  // hide an arbitrary row; the top-stories read path then EXCLUDES the story from
  // every curated surface (cards, detail, Top Narratives). The hide captures the
  // story's clusterId + every current member key so a later re-cluster / churn of
  // the same story stays suppressed. Curated-lane only — never the main feed,
  // Classic/Visual, custom MCOPs, or the public REST API (fail-closed isolation).
  app.post("/api/curated/hide-story", requireCuratedEditor, async (req: any, res) => {
    try {
      const { scope, type, id, clusterId, memberKeys, hidden, recordKeys } = req.body ?? {};
      // Editor-view telemetry (Task #834 rework) — optional flags the client
      // sets when the correction comes from the header editor views (Radar /
      // Hidden stories), so the learning loop can distinguish view-prompted
      // corrections. Sanitized; never affects the hide/un-hide behavior.
      const evFromRadar = req.body?.fromRadar === true;
      const evSurfacingState = typeof req.body?.surfacingState === 'string'
        ? req.body.surfacingState.slice(0, 40)
        : null;

      // Un-hide by explicit stored record key(s). The "Hidden stories" panel
      // sends the ORIGINAL hidden-row key(s) from the feed payload, so a story
      // whose identity churned after a re-cluster still deletes the right row(s).
      // Without this, un-hide reconstructs the key from the story's CURRENT shape
      // (which may differ from the stored key) and silently deletes nothing,
      // leaving the story hidden forever. Curated-lane only; fail-closed.
      if (hidden === false && Array.isArray(recordKeys) && recordKeys.length > 0) {
        const keys = Array.from(new Set(
          recordKeys
            .map((k: any) => (k ?? '').toString().trim())
            .filter((k: string) => k.length > 0),
        ));
        for (const k of keys) await storage.removeCuratedHiddenStory(k);
        invalidateCuratedCache('top-stories');
        invalidateCuratedCache('cluster-members');
        invalidateCuratedCache('state-narratives');
        await captureCuratedOverrideEvent({
          action: 'unhide-story', editor: req.user?.claims?.email || 'dev',
          storyKey: keys[0] ?? null, newValue: `un-hidden (${keys.length} key${keys.length === 1 ? '' : 's'})`,
          fromRadar: evFromRadar, surfacingState: evSurfacingState,
        });
        return res.json({ ok: true, removed: keys, hidden: false });
      }

      let key: string;
      let cid: string | null = null;
      if (scope === 'cluster') {
        cid = (clusterId ?? '').toString().trim() || null;
        if (!cid) return res.status(400).json({ error: 'clusterId required for cluster scope' });
        key = `cluster:${cid}`;
      } else if (scope === 'standalone') {
        const itemId = (id ?? '').toString().trim();
        if (!itemId) return res.status(400).json({ error: 'id required for standalone scope' });
        const prefix = type === 'curated' ? 'curated' : 'main';
        key = `${prefix}:${itemId}`;
      } else {
        return res.status(400).json({ error: "scope must be 'cluster' or 'standalone'" });
      }

      const wantHidden = hidden !== false; // default true (hide)
      if (wantHidden) {
        // Sanitize the member-key list to clean `<type>:<id>` strings — these are
        // captured so a churned re-cluster of the same story stays hidden.
        const mks = Array.isArray(memberKeys)
          ? Array.from(new Set(
              memberKeys
                .map((m: any) => (m ?? '').toString().trim())
                .filter((m: string) => /^(curated|main):.+/.test(m)),
            ))
          : [];
        const hiddenBy = req.user?.claims?.email || 'dev';
        await storage.setCuratedHiddenStory(key, cid, mks, hiddenBy);
      } else {
        await storage.removeCuratedHiddenStory(key);
      }
      // The hide/un-hide changes what users see immediately — drop the caches
      // (incl. the narratives lens, so a hidden adversary item stops showing
      // there too — Task #633).
      invalidateCuratedCache('top-stories');
      invalidateCuratedCache('cluster-members');
      invalidateCuratedCache('state-narratives');
      const editor = req.user?.claims?.email || 'dev';
      const snapshot = await resolveCuratedOverrideSnapshot({ scope, type, id, clusterId: cid ?? undefined });
      await captureCuratedOverrideEvent({
        action: wantHidden ? 'hide-story' : 'unhide-story', editor, snapshot, storyKey: key,
        newValue: wantHidden ? 'hidden' : 'un-hidden',
        fromRadar: evFromRadar, surfacingState: evSurfacingState,
      });
      res.json({ ok: true, key, hidden: wantHidden });
    } catch (error) {
      console.error('Error setting curated hidden story:', error);
      res.status(500).json({ error: 'Failed to set curated hidden story' });
    }
  });

  // Curated lane (Task #380 expansion) — REPLACE the photo on a SINGLE-SOURCE
  // standalone item with a new image URL. Allowlist-gated (requireCuratedAccess).
  // The URL is validated through isPublicFetchableUrl (same SSRF guard as the
  // dead-link replacement / auto-fill) before anything is written. Stored in the
  // curated-only image overlay keyed by the item's stable curated key
  // (`main:<id>`/`curated:<id>`); the underlying row's ogImageUrl is NEVER mutated.
  // Curated-lane only — never the main feed, Classic/Visual, custom MCOPs, or the
  // public REST API (fail-closed lane isolation).
  app.post("/api/curated/replace-image", requireCuratedEditor, async (req: any, res) => {
    try {
      const { scope, type, id, clusterId, url } = req.body ?? {};
      const newUrl = (url ?? '').toString().trim();
      if (!newUrl) return res.status(400).json({ error: 'url required' });

      const { isPublicFetchableUrl } = await import('./streamPrefetch');
      if (!(await isPublicFetchableUrl(newUrl))) {
        return res.status(400).json({ error: 'URL is not a valid, publicly fetchable address' });
      }

      // Cluster scope (photo-upload parity with single-source): the override is
      // keyed by the cluster's stable `cluster:<id>` key and applied as a
      // DISPLAY-only override on the cluster card + carousel. Member rows'
      // ogImageUrl are never mutated.
      let key: string;
      let snapshot: Awaited<ReturnType<typeof resolveCuratedOverrideSnapshot>>;
      const updatedBy = req.user?.claims?.email || 'dev';
      if (scope === 'cluster') {
        const cid = (clusterId ?? '').toString().trim();
        if (!cid) return res.status(400).json({ error: 'clusterId required for cluster scope' });
        key = `cluster:${cid}`;
        snapshot = await resolveCuratedOverrideSnapshot({ scope: 'cluster', clusterId: cid });
      } else {
        const itemId = (id ?? '').toString().trim();
        if (!itemId) return res.status(400).json({ error: 'id required' });
        const prefix = type === 'curated' ? 'curated' : 'main';
        key = `${prefix}:${itemId}`;
        snapshot = await resolveCuratedOverrideSnapshot({ scope: 'standalone', type, id: itemId });
      }
      await storage.setCuratedImageReplacement(key, newUrl, updatedBy);
      invalidateCuratedCache('top-stories');
      invalidateCuratedCache('cluster-members');
      invalidateCuratedCache('state-narratives');
      await captureCuratedOverrideEvent({
        action: 'replace-image', editor: updatedBy, snapshot, storyKey: key,
        newValue: `photo replaced → ${newUrl}`,
      });
      res.json({ ok: true, key, url: newUrl });
    } catch (error) {
      console.error('Error replacing curated image:', error);
      res.status(500).json({ error: 'Failed to replace curated image' });
    }
  });

  // Curated lane (Task #380 expansion) — UPLOAD a pasted clipboard image as the
  // replacement photo for a SINGLE-SOURCE item. Allowlist-gated. The image bytes
  // are stored in OUR object storage bucket (no SSRF surface) and the resulting
  // URL becomes the curated-only display override (keyed by the item's stable
  // curated key). curated_items.url / ogImageUrl are never mutated. Curated-lane
  // only — never the main feed or public API.
  const curatedImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new Error('Only image files are allowed'));
    },
  });
  app.post("/api/curated/upload-image", requireCuratedEditor, (req: any, res: any, next: any) => {
    curatedImageUpload.single('image')(req, res, (err: any) => {
      if (err) return res.status(400).json({ error: `Upload error: ${err.message}` });
      next();
    });
  }, async (req: any, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No image file provided' });
      const { scope, type, id, clusterId } = req.body ?? {};
      const objectStorageService = new ObjectStorageService();
      const imagePath = await objectStorageService.uploadStreamImage(
        req.file.buffer, req.file.originalname || 'pasted-image', req.file.mimetype,
      );
      // Cluster scope: same display-only overlay, keyed by `cluster:<id>` —
      // photo-upload parity with single-source items (member rows never mutated).
      let key: string;
      let snapshot: Awaited<ReturnType<typeof resolveCuratedOverrideSnapshot>>;
      const updatedBy = req.user?.claims?.email || 'dev';
      if (scope === 'cluster') {
        const cid = (clusterId ?? '').toString().trim();
        if (!cid) return res.status(400).json({ error: 'clusterId required for cluster scope' });
        key = `cluster:${cid}`;
        snapshot = await resolveCuratedOverrideSnapshot({ scope: 'cluster', clusterId: cid });
      } else {
        const itemId = (id ?? '').toString().trim();
        if (!itemId) return res.status(400).json({ error: 'id required' });
        const prefix = type === 'curated' ? 'curated' : 'main';
        key = `${prefix}:${itemId}`;
        snapshot = await resolveCuratedOverrideSnapshot({ scope: 'standalone', type, id: itemId });
      }
      await storage.setCuratedImageReplacement(key, imagePath, updatedBy);
      invalidateCuratedCache('top-stories');
      invalidateCuratedCache('cluster-members');
      invalidateCuratedCache('state-narratives');
      await captureCuratedOverrideEvent({
        action: 'replace-image', editor: updatedBy, snapshot, storyKey: key,
        newValue: 'photo uploaded',
      });
      res.json({ ok: true, key, url: imagePath });
    } catch (error: any) {
      console.error('Error uploading curated image:', error?.message || error);
      res.status(500).json({ error: `Failed to upload image: ${error?.message || 'Unknown error'}` });
    }
  });

  // Curated lane — editor HEADLINE + BULLETS override (curated-only). Allowlist-
  // gated (requireCuratedAccess). Writes a display-only correction to a story's
  // headline and/or summary bullets into the curated-only overlay, keyed by the
  // item's stable curated key or cluster id. The stored `title` / `normalizedTitle`
  // is NEVER mutated (clustering/dedup identity stays intact). Clears by passing
  // `{ clear: true }`. Curated-lane only — never the main feed, Classic/Visual,
  // custom MCOPs, or the public REST API (fail-closed lane isolation).
  app.post("/api/curated/replace-headline", requireCuratedEditor, async (req: any, res) => {
    try {
      const { scope, type, id, clusterId, headline, bullets, claims, clear } = req.body ?? {};
      const updatedBy = req.user?.claims?.email || 'dev';

      let key: string;
      if (scope === 'cluster') {
        const cid = (clusterId ?? '').toString().trim();
        if (!cid) return res.status(400).json({ error: 'clusterId required for cluster scope' });
        key = `cluster:${cid}`;
      } else {
        const itemId = (id ?? '').toString().trim();
        if (!itemId) return res.status(400).json({ error: 'id required for standalone scope' });
        const prefix = type === 'curated' ? 'curated' : 'main';
        key = `${prefix}:${itemId}`;
      }

      if (clear === true) {
        await storage.removeCuratedHeadlineOverride(key);
        invalidateCuratedCache('top-stories');
        invalidateCuratedCache('cluster-members');
        invalidateCuratedCache('state-narratives');
        await captureCuratedOverrideEvent({
          action: 'replace-headline', editor: updatedBy, storyKey: key,
          newValue: 'headline override cleared',
        });
        return res.json({ ok: true, key, cleared: true });
      }

      // Sanitize and validate headline: strip control chars, trim, length-cap.
      let cleanHeadline: string | null = null;
      if (headline !== undefined && headline !== null) {
        const h = String(headline)
          .replace(/[\x00-\x1F\x7F]/g, ' ')  // strip control chars
          .replace(/\s+/g, ' ')
          .trim();
        if (h.length === 0) return res.status(400).json({ error: 'headline must not be empty when provided' });
        if (h.length > 500) return res.status(400).json({ error: 'headline too long (max 500 chars)' });
        cleanHeadline = h;
      }

      // Sanitize bullets: max 10, each ≤ 200 chars, strip control chars.
      let cleanBullets: string[] | null = null;
      if (Array.isArray(bullets) && bullets.length > 0) {
        const bs = bullets
          .map((b: any) => String(b)
            .replace(/[\x00-\x1F\x7F]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
          )
          .filter((b: string) => b.length > 0)
          .slice(0, 10)
          .map((b: string) => b.slice(0, 200));
        if (bs.length === 0) return res.status(400).json({ error: 'bullets must not all be empty when provided' });
        cleanBullets = bs;
      }

      // Attributed claims use the same bounded text contract as bullets. They
      // remain a separate display section and never become corroborated facts.
      let cleanClaims: string[] | null = null;
      if (Array.isArray(claims) && claims.length > 0) {
        const cs = claims
          .map((c: any) => String(c)
            .replace(/[\x00-\x1F\x7F]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
          )
          .filter((c: string) => c.length > 0)
          .slice(0, 10)
          .map((c: string) => c.slice(0, 300));
        if (cs.length === 0) return res.status(400).json({ error: 'claims must not all be empty when provided' });
        cleanClaims = cs;
      }

      if (cleanHeadline === null && cleanBullets === null && cleanClaims === null) {
        return res.status(400).json({ error: 'headline, bullets, and/or claims required' });
      }

      const snapshot = await resolveCuratedOverrideSnapshot(
        scope === 'cluster'
          ? { scope: 'cluster', clusterId: key.replace('cluster:', '') }
          : { scope: 'standalone', type: type === 'curated' ? 'curated' : 'main', id: (id ?? '').toString().trim() }
      );
      await storage.setCuratedHeadlineOverride(key, cleanHeadline, cleanBullets, cleanClaims, updatedBy);
      invalidateCuratedCache('top-stories');
      invalidateCuratedCache('cluster-members');
      invalidateCuratedCache('state-narratives');
      await captureCuratedOverrideEvent({
        action: 'replace-headline', editor: updatedBy, snapshot, storyKey: key,
        newValue: cleanHeadline ? `headline → ${cleanHeadline.slice(0, 80)}` : cleanClaims ? 'attributed claims override' : 'bullets only override',
      });
      res.json({ ok: true, key, headline: cleanHeadline, bullets: cleanBullets, claims: cleanClaims });
    } catch (error) {
      console.error('Error saving curated headline override:', error);
      res.status(500).json({ error: 'Failed to save curated headline override' });
    }
  });

  // Curated lane — AI PARSE for pasted article text (optional assist for
  // the headline editor). Allowlist-gated (requireCuratedAccess). Accepts raw
  // article text and returns a proposed clean headline + 3 summary bullets using
  // the same "raw text → bullets" AI pattern as the manual review summarize-text
  // flow. AI failures surface as a clear, retryable error — never empty content.
  // This endpoint PROPOSES only; it does NOT persist anything.
  app.post("/api/curated/parse-headline", requireCuratedEditor, async (req: any, res) => {
    try {
      const { text, currentHeadline } = req.body ?? {};
      if (!text || typeof text !== 'string' || text.trim().length < 50) {
        return res.status(400).json({ error: 'Text must be at least 50 characters' });
      }
      if (!isAIConfigured()) {
        return res.status(503).json({ error: 'AI not configured — try again later' });
      }
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a military intelligence analyst. Given an article, produce a concise corrected headline and exactly 3 summary bullet points. Respond in JSON like: { "headline": "...", "bullets": ["...", "...", "..."] }. Headline: one accurate declarative sentence, ≤15 words. Bullets: each ≤15 words, present tense, most important facts first. Spell out publication names in full (e.g. "The Wall Street Journal" not "WSJ"). Respond with ONLY the JSON object, no extra text.',
          },
          {
            role: 'user',
            content: `Current headline: ${currentHeadline || 'unknown'}\n\nArticle text:\n${text.slice(0, 3000)}`,
          },
        ],
        max_tokens: 300,
        temperature: 0.2,
      });
      const raw = completion.choices[0]?.message?.content?.trim() || '';
      let parsed: { headline?: string; bullets?: string[] } = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Try extracting JSON from the response
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch { /* fall through */ }
        }
      }
      const { groundGeneratedTextInSources, groundGeneratedLinesInSources } =
        await import('./staleStatusSanitizer');
      // The pasted article text is the sole oracle. The current displayed
      // headline may itself contain the hallucination the editor is trying to
      // fix, so it must never legitimize an unsupported person name.
      const sourceTexts = [text];
      const rawHeadline = typeof parsed.headline === 'string' && parsed.headline.trim()
        ? parsed.headline.trim().slice(0, 500)
        : null;
      const proposedHeadline = rawHeadline
        ? groundGeneratedTextInSources(rawHeadline, sourceTexts)
        : null;
      const rawBullets = Array.isArray(parsed.bullets)
        ? parsed.bullets
            .map((b: any) => String(b).trim())
            .filter((b: string) => b.length > 0)
            .slice(0, 3)
            .map((b: string) => b.split(/\s+/).slice(0, 15).join(' '))
        : [];
      const proposedBullets = groundGeneratedLinesInSources(rawBullets, sourceTexts);
      if (!proposedHeadline && proposedBullets.length === 0) {
        return res.status(422).json({ error: 'AI could not parse the text — try again or edit manually' });
      }
      res.json({ headline: proposedHeadline, bullets: proposedBullets });
    } catch (error: any) {
      const isTransient = isTransientAIError(error);
      console.error('Error in curated parse-headline:', error?.message || error);
      res.status(isTransient ? 503 : 500).json({
        error: isTransient
          ? 'AI is busy — try again in a moment'
          : `AI parse failed: ${error?.message || 'Unknown error'}`,
      });
    }
  });

  // Curated lane (Task #380 expansion) — HIDE / UNHIDE an individual cluster
  // member's photo. Allowlist-gated. Hiding writes the image URL to the curated-
  // only hidden-images overlay; the top-stories read path then drops that URL from
  // every card thumbnail + detail carousel and nulls it on the member row. Keyed
  // by the image URL (deduped) so the hide survives member churn / a re-cluster.
  // Curated-lane only — never the main feed, Classic/Visual, custom MCOPs, or the
  // public REST API (fail-closed lane isolation).
  app.post("/api/curated/hide-image", requireCuratedEditor, async (req: any, res) => {
    try {
      const { imageUrl, hidden } = req.body ?? {};
      const u = (imageUrl ?? '').toString().trim();
      if (!u) return res.status(400).json({ error: 'imageUrl required' });
      const wantHidden = hidden !== false; // default true (hide)
      const hiddenBy = req.user?.claims?.email || 'dev';
      if (wantHidden) {
        await storage.setCuratedHiddenImage(u, hiddenBy);
      } else {
        await storage.removeCuratedHiddenImage(u);
      }
      invalidateCuratedCache('top-stories');
      invalidateCuratedCache('cluster-members');
      invalidateCuratedCache('state-narratives');
      await captureCuratedOverrideEvent({
        action: wantHidden ? 'hide-image' : 'unhide-image', editor: hiddenBy,
        itemUrl: u, newValue: wantHidden ? 'image hidden' : 'image un-hidden',
      });
      res.json({ ok: true, imageUrl: u, hidden: wantHidden });
    } catch (error) {
      console.error('Error setting curated hidden image:', error);
      res.status(500).json({ error: 'Failed to set curated hidden image' });
    }
  });

  // Curated lane (Task #380) — editor inline CORRECTION of a story's Topic / Focus
  // / Region / Country. Allowlist-gated (requireCuratedAccess). Writes a
  // HUMAN-provenance row into the curated-only classification overlay
  // (curated_classifications), keyed by the story's article URL. Stamping
  // provenance='human' PROTECTS the override from the bounded AI re-check (which
  // acts only on provenance='ai' rows), so the correction survives later
  // classification cycles. Topic + Focus are coerced to the controlled vocabulary;
  // off-list values are rejected. Curated-lane only — the overlay is read solely by
  // the curated route, never by any shared feed or the public API.
  app.post("/api/curated/classification", requireCuratedEditor, async (req: any, res) => {
    try {
      const { url, primaryTopic, conflictTrack, region, country } = req.body ?? {};
      const cleanUrl = (url ?? '').toString().trim();
      if (!cleanUrl) return res.status(400).json({ error: 'url required' });

      // Topic — required, must coerce to a controlled-vocabulary primary_topic.
      const topic = coercePrimaryTopic(primaryTopic);
      if (!topic) {
        return res.status(400).json({ error: 'primaryTopic must be a valid controlled-vocabulary topic' });
      }
      // Focus (conflict_track) — OPTIONAL. When provided it must coerce to a
      // governed track; an explicit empty string clears it.
      let track: string | null = null;
      if (conflictTrack !== undefined && conflictTrack !== null && String(conflictTrack).trim() !== '') {
        track = coerceConflictTrack(conflictTrack);
        if (!track) {
          return res.status(400).json({ error: 'conflictTrack must be a valid governed conflict track' });
        }
      }
      const effRegion = normalizeCountryLabel(
        typeof region === 'string' ? region : null
      );
      const effCountry = normalizeCountryLabel(
        typeof country === 'string' ? country : null
      );

      // Snapshot the ORIGINAL labels (topic/region/country) BEFORE this human
      // override rewrites them, so the learning log shows the AI→editor delta.
      const snapshot = await resolveCuratedOverrideSnapshot({ url: cleanUrl });

      // Preserve the existing SPECIFIC card label + audit fields; the editor only
      // sets the bucket + geography + focus (mirrors the Team-review override path).
      const priorMap = await storage.getCuratedClassificationsByUrls([cleanUrl]);
      const prior = priorMap.get(cleanUrl);
      await storage.upsertCuratedClassifications([{
        url: cleanUrl,
        category: prior?.category ?? 'general',
        region: effRegion,
        country: effCountry,
        primaryTopic: topic,
        scope: deriveScope({ topicCountry: effCountry, region: effRegion }),
        conflictTrack: track,
        // Keep any AI-derived two-country Focus pair so a track-less correction
        // doesn't blank an existing pair.
        countryPair: prior?.countryPair ?? null,
        legacyCategory: prior?.legacyCategory ?? null,
        proposedTopic: prior?.proposedTopic ?? null,
        // HUMAN override — PROTECTED from the bounded AI re-check (Task #350).
        provenance: 'human',
      }]);
      invalidateCuratedCache();
      const editor = req.user?.claims?.email || 'dev';
      const newLabel = [topic, track, effRegion, effCountry].filter(Boolean).join(' · ');
      await captureCuratedOverrideEvent({
        action: 'classification', editor, snapshot, itemUrl: cleanUrl,
        newValue: `re-labeled to ${newLabel}`,
      });
      res.json({ ok: true, url: cleanUrl, primaryTopic: topic, conflictTrack: track, region: effRegion, country: effCountry });
    } catch (error) {
      console.error('Error setting curated classification override:', error);
      res.status(500).json({ error: 'Failed to set curated classification override' });
    }
  });

  // ===========================================================================
  // Curated lane — per-item human CONTENT-KIND OVERRIDE (Task #892).
  // GET  /api/curated/content-kind-override?url=<url>  → current override (or null)
  // POST /api/curated/content-kind-override            → set (kind) or clear (kind absent/null)
  // Protected from AI clobber: stored in a separate table, never touched by
  // enrichment. Demotes the item to attach-only in clustering + bars it from
  // every curated headline surface. Curated-lane only; editor tier required.
  // ===========================================================================

  app.get("/api/curated/content-kind-override", requireCuratedEditor, async (req, res) => {
    try {
      const url = (req.query.url as string ?? '').trim();
      if (!url) return res.status(400).json({ error: 'url required' });
      // Canonical identity: if the client holds a dead-link REPLACEMENT url,
      // resolve it back to the original stored url so the read matches what
      // POST stored (storage additionally normalizes tracking-query variants).
      const targetUrl = await storage.resolveCuratedContentKindTargetUrl(url);
      const kind = await storage.getCuratedContentKindOverrideByUrl(targetUrl);
      res.json({ url, kind });
    } catch (error) {
      console.error('Error fetching content-kind override:', error);
      res.status(500).json({ error: 'Failed to fetch content-kind override' });
    }
  });

  app.post("/api/curated/content-kind-override", requireCuratedEditor, async (req: any, res) => {
    try {
      const { url, kind } = req.body ?? {};
      const cleanUrl = (url ?? '').toString().trim();
      if (!cleanUrl) return res.status(400).json({ error: 'url required' });
      const VALID_KINDS = ['analysis', 'opinion', 'editorial', 'explainer', 'other'] as const;
      if (kind != null && kind !== '' && !VALID_KINDS.includes(kind)) {
        return res.status(400).json({ error: `Invalid kind '${kind}'. Valid values: ${VALID_KINDS.join(', ')}` });
      }
      const effKind = kind && VALID_KINDS.includes(kind) ? kind as string : null;
      const editor = req.user?.claims?.email || 'dev';
      // Canonical identity (review fix): the popup may hold a dead-link
      // REPLACEMENT url. Store the override under the ORIGINAL stored url's
      // normalized identity — the same key the clustering pass and the
      // top-stories build check — or the mark would never demote the item.
      const targetUrl = await storage.resolveCuratedContentKindTargetUrl(cleanUrl);
      // Snapshot from the resolved ORIGINAL url (review): for dead-link-replaced
      // items the popup only holds the replacement url, which matches no stored
      // row — snapshotting by targetUrl (the raw original stored url) keeps
      // headline/outlet context in the audit event. For non-replaced items
      // targetUrl === cleanUrl, so behavior is unchanged.
      const snapshot = await resolveCuratedOverrideSnapshot({ url: targetUrl });
      await storage.setCuratedContentKindOverride(targetUrl, effKind, editor);
      // Retro-cap stored machine score on opinion/analysis marks (Task #1027,
      // Step 3). Editors were repeatedly pinning DOWN analysis/opinion pieces the
      // gate had scored 70–85. When this mark is a non-null opinion/analysis
      // family AND the curated item's stored score exceeds CURATED_ANALYSIS_OPINION_CAP
      // AND there is no human priority pin → lower the stored score to the cap
      // now (the same ceiling the admission pipeline applies at ingest). Fail-soft.
      if (effKind && ['analysis', 'opinion', 'editorial', 'explainer'].includes(effKind)) {
        try {
          const ckItem = await storage.getCuratedItemByUrl(targetUrl);
          if (ckItem && (ckItem.priorityScore ?? 0) > CURATED_ANALYSIS_OPINION_CAP) {
            const pins = await storage.getCuratedPriorityOverrides();
            if (!pins.has(`curated:${ckItem.id}`)) {
              await storage.updateCuratedItemPriorityScore(ckItem.id, CURATED_ANALYSIS_OPINION_CAP);
              console.log(
                `[content-kind-override] retro-capped score ${ckItem.priorityScore}` +
                `→${CURATED_ANALYSIS_OPINION_CAP} for curated:${ckItem.id} (marked as ${effKind})`,
              );
            }
          }
        } catch (e: any) {
          console.warn('[content-kind-override] retro-cap failed (non-fatal):', e?.message || e);
        }
      }
      invalidateCuratedCache();
      await captureCuratedOverrideEvent({
        action: effKind ? 'content-kind-mark' : 'content-kind-clear',
        editor, snapshot, itemUrl: cleanUrl,
        newValue: effKind ? `marked as ${effKind}` : 'mark cleared',
      });
      res.json({ ok: true, url: cleanUrl, kind: effKind });
    } catch (error) {
      console.error('Error setting content-kind override:', error);
      res.status(500).json({ error: 'Failed to set content-kind override' });
    }
  });

  // ===========================================================================
  // Curated lane — editor-OVERRIDE LEARNING LOG (Task #540). The human-in-the-
  // loop read surface. Curated-gated endpoints:
  //   GET  /api/curated/override-log         → recent events + DETERMINISTIC
  //                                            aggregated report + pause state.
  //   POST /api/curated/override-log/pause   → persist the capture-pause toggle.
  // (Task #1180: the ON-DEMAND AI brief route was REMOVED — editor signal is now
  //  surfaced as deterministic evidence via /api/curated/editorial-evidence.)
  // This is observability ONLY — it NEVER mutates scoring, hide overlays, or any
  // feed. Reads solely the curated-only event table.
  // ===========================================================================

  // Deterministic aggregation of override events into an editor-readable report.
  // Pure function of the events list (no AI, no randomness) so the same window
  // always yields the same report and it's trivially testable/diffable.
  function buildCuratedOverrideReport(events: CuratedOverrideEvent[], windowDays: number, steeringByUrl = new Map<string, any[]>()) {
    const byAction: Record<string, number> = {};
    const suppressedOutlets: Record<string, number> = {};
    const boostedOutlets: Record<string, number> = {};
    const relabeledFromTopic: Record<string, number> = {};
    const byRegion: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    let pinnedUp = 0, pinnedDown = 0, pinDeltaSum = 0, pinDeltaCount = 0;

    // Score-vs-action conflict signals — where the AI's P-score disagreed with
    // the editor. These are the strongest cues for a scoring/threshold change.
    // MAIN_FEED_PROMOTION_THRESHOLD is 50 and CURATED_SOFT_CAP is 49, so 50 is
    // the natural high/low boundary for bucketing the AI's original score.
    const SCORE_THRESHOLD = 50;
    let highScoreHides = 0;   // editor hid a story the AI scored HIGH (>=50) — over-scored
    let lowScoreBoosts = 0;   // editor pinned UP a story the AI scored LOW (<50) — under-scored
    const highScoreHideOutlets: Record<string, number> = {};
    const lowScoreBoostOutlets: Record<string, number> = {};

    // CLUSTERING-behavior signals — editor manual link/merge/unlink of stories.
    // Bucketed SEPARATELY from the scoring/relevance signals above so the brief
    // maps them to clustering tuning (server/curatedCluster.ts), not scoring.
    let clusterLinks = 0, clusterMerges = 0, clusterUnlinks = 0;
    const steering = {
      exactCorrelated: 0, uncorrelated: 0, priorityBoosted: 0, boloRescued: 0,
      usImplicationAdjusted: 0, nonSteered: 0, byAction: {} as Record<string, number>,
      byTopic: {} as Record<string, number>,
    };

    const inc = (m: Record<string, number>, k: string | null | undefined) => {
      const key = (k ?? '').toString().trim();
      if (!key) return;
      m[key] = (m[key] ?? 0) + 1;
    };

    const isHide = (action: string) =>
      action === 'hide-story' || action === 'hide-image' || action === 'outlet-block';

    for (const e of events) {
      // Do not manufacture a steering identity for historical events that were
      // captured before canonicalUrl existed. Those remain explicitly unknown.
      const identity = e.canonicalUrl;
      const decisions = identity
        ? (steeringByUrl.get(identity) ?? []).filter((d) => {
            const actionAt = new Date(e.createdAt).getTime();
            const decisionAt = new Date(d.matchedAt).getTime();
            return decisionAt <= actionAt && actionAt - decisionAt <= 7 * 24 * 60 * 60 * 1000;
          })
        : [];
      if (decisions.length > 0) {
        steering.exactCorrelated++;
        const kinds = new Set(decisions.map((d) => d.steeringKind));
        if (kinds.has('priority')) steering.priorityBoosted++;
        if (decisions.some((d) => d.boloRescueUsed)) steering.boloRescued++;
        if (kinds.has('us-implication')) steering.usImplicationAdjusted++;
        steering.byAction[e.action] = (steering.byAction[e.action] ?? 0) + 1;
        for (const d of decisions) {
          if (d.topicId !== '__us_implication__') steering.byTopic[d.topicId] = (steering.byTopic[d.topicId] ?? 0) + 1;
        }
      } else {
        steering.uncorrelated++;
        steering.nonSteered++;
      }
      byAction[e.action] = (byAction[e.action] ?? 0) + 1;
      inc(byRegion, e.region);
      inc(byCountry, e.country);

      // Suppression signal: hides + outlet blocks (what editors keep removing).
      if (isHide(e.action)) {
        inc(suppressedOutlets, e.outlet);
        // High-score hide = the AI over-scored content the editor rejected.
        if (e.originalScore != null && e.originalScore >= SCORE_THRESHOLD) {
          highScoreHides += 1;
          inc(highScoreHideOutlets, e.outlet);
        }
      }
      // Boost signal: priority pins that RAISED the AI's original score.
      if (e.action === 'priority-override') {
        const m = /pinned to (\d+)/.exec(e.newValue ?? '');
        const newScore = m ? parseInt(m[1], 10) : null;
        if (newScore != null && e.originalScore != null) {
          const delta = newScore - e.originalScore;
          pinDeltaSum += delta; pinDeltaCount += 1;
          if (delta > 0) {
            pinnedUp += 1; inc(boostedOutlets, e.outlet);
            // Low-score boost = the AI under-scored content the editor values.
            if (e.originalScore < SCORE_THRESHOLD) {
              lowScoreBoosts += 1;
              inc(lowScoreBoostOutlets, e.outlet);
            }
          } else if (delta < 0) {
            pinnedDown += 1; inc(suppressedOutlets, e.outlet);
          }
        } else if (newScore != null) {
          // No baseline — treat a high pin as a boost, low pin as suppression.
          if (newScore >= SCORE_THRESHOLD) {
            pinnedUp += 1; inc(boostedOutlets, e.outlet);
          } else {
            pinnedDown += 1; inc(suppressedOutlets, e.outlet);
          }
        }
      }
      // Re-classification signal: which ORIGINAL topics editors kept correcting.
      if (e.action === 'classification') inc(relabeledFromTopic, e.originalTopic);
      // Clustering-behavior signals — kept out of the scoring/relevance buckets.
      if (e.action === 'manual-link') clusterLinks += 1;
      else if (e.action === 'manual-merge') clusterMerges += 1;
      else if (e.action === 'manual-unlink') clusterUnlinks += 1;
    }

    const top = (m: Record<string, number>, n = 8) =>
      Object.entries(m)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([name, count]) => ({ name, count }));
    const editorialQuality = Object.entries(byAction).map(([action, count]) => {
      const actionEvents = events.filter(e => e.action === action);
      const stories = new Set(actionEvents.map(e => e.itemUrl || e.storyKey || e.headline || e.id));
      const reasons: Record<string, number> = {};
      for (const e of actionEvents) {
        for (const reason of e.reasonKeys ?? []) reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
      return { action, count, distinctStories: stories.size, reasons: top(reasons, 5) };
    }).sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));

    return {
      windowDays,
      totalEvents: events.length,
      byAction,
      topSuppressedOutlets: top(suppressedOutlets),
      topBoostedOutlets: top(boostedOutlets),
      topRelabeledFromTopic: top(relabeledFromTopic),
      topRegions: top(byRegion),
      topCountries: top(byCountry),
      pinSummary: {
        pinnedUp,
        pinnedDown,
        avgDelta: pinDeltaCount > 0 ? Math.round((pinDeltaSum / pinDeltaCount) * 10) / 10 : 0,
      },
      // Explicit score-vs-action conflict signals (AI-vs-editor disagreement),
      // bucketed against the score threshold (50) — the clearest tuning cues.
      scoreConflicts: {
        scoreThreshold: SCORE_THRESHOLD,
        highScoreHides,
        lowScoreBoosts,
        topHighScoreHideOutlets: top(highScoreHideOutlets),
        topLowScoreBoostOutlets: top(lowScoreBoostOutlets),
      },
      // Clustering-behavior changes (manual link/merge/unlink) — a DISTINCT
      // category from the scoring/relevance signals above. Informs clustering
      // tuning (server/curatedCluster.ts), never scoring/relevance thresholds.
      clusteringChanges: {
        total: clusterLinks + clusterMerges + clusterUnlinks,
        links: clusterLinks,
        merges: clusterMerges,
        unlinks: clusterUnlinks,
      },
      // Observation-only: these editorial actions are deliberately not compiled
      // into automatic outlet/content/scoring behavior.
      editorialQuality,
      steering,
    };
  }

  app.get("/api/curated/override-log", requireCuratedAccess, async (req, res) => {
    try {
      const rawDays = parseInt(req.query.days as string);
      const windowDays = Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 30, 1), 180);
      const settings = await storage.getCuratedFeedbackSettings();
      const ack = settings.acknowledgedAt ? new Date(settings.acknowledgedAt) : null;
      // Archive mode: return events BEFORE the last reset so editors can
      // inspect the full history without clearing anything (non-destructive).
      if (req.query.archive === '1') {
        if (!ack) return res.json({ report: buildCuratedOverrideReport([], windowDays), recent: [], capturePaused: settings.capturePaused, capturePausedBy: settings.updatedBy ?? null, capturePausedAt: settings.updatedAt ?? null, acknowledgedAt: settings.acknowledgedAt ?? null, archive: true });
        const archiveEvents = await storage.getCuratedOverrideEventsBefore(ack, 500);
        const archiveUrls = archiveEvents.map((e) => e.canonicalUrl).filter((url): url is string => Boolean(url));
        const oldestArchiveEvent = archiveEvents.reduce<Date | null>((oldest, e) => {
          const created = new Date(e.createdAt);
          return !oldest || created < oldest ? created : oldest;
        }, null);
        const archiveTelemetry = await storage.getWatchTopicTelemetryForCanonicalUrls(
          archiveUrls,
          oldestArchiveEvent ? new Date(oldestArchiveEvent.getTime() - 7 * 24 * 60 * 60 * 1000) : ack,
        );
        const archiveByUrl = new Map<string, typeof archiveTelemetry>();
        for (const d of archiveTelemetry) {
          if (!d.canonicalUrl) continue;
          const list = archiveByUrl.get(d.canonicalUrl) ?? [];
          list.push(d); archiveByUrl.set(d.canonicalUrl, list);
        }
        const archiveReport = buildCuratedOverrideReport(archiveEvents, windowDays, archiveByUrl);
        return res.json({ report: archiveReport, recent: archiveEvents, capturePaused: settings.capturePaused, capturePausedBy: settings.updatedBy ?? null, capturePausedAt: settings.updatedAt ?? null, acknowledgedAt: settings.acknowledgedAt ?? null, archive: true });
      }
      // Reset checkpoint: never show actions logged at/before the last reset, even
      // if they fall inside the requested day window (non-destructive clear).
      const windowSince = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
      const since = ack && ack > windowSince ? ack : windowSince;
      const reportEvents = await storage.getCuratedOverrideEventsSince(since, 5000);
      // Conservative correlation window: steering must predate an action by no
      // more than seven days, and identity must be exact/canonical. No historical
      // row without a canonical steering identity is guessed into a correlation.
      const telemetry = await storage.getWatchTopicTelemetryForCanonicalUrls(
        reportEvents.map((e) => e.canonicalUrl).filter((url): url is string => Boolean(url)),
        new Date(since.getTime() - 7 * 24 * 60 * 60 * 1000),
      );
      const steeringByUrl = new Map<string, typeof telemetry>();
      for (const d of telemetry) {
        if (!d.canonicalUrl) continue;
        const list = steeringByUrl.get(d.canonicalUrl) ?? [];
        list.push(d); steeringByUrl.set(d.canonicalUrl, list);
      }
      const report = buildCuratedOverrideReport(reportEvents, windowDays, steeringByUrl);
      // The recent-adjustments view shows the newest events (independent of the
      // report window) so editors can eyeball exactly what was logged — but still
      // honors the reset checkpoint.
      const recentAll = await storage.getCuratedOverrideEvents(100);
      const recent = ack ? recentAll.filter(e => new Date(e.createdAt) > ack) : recentAll;
      res.json({
        report,
        recent,
        capturePaused: settings.capturePaused,
        capturePausedBy: settings.updatedBy ?? null,
        capturePausedAt: settings.updatedAt ?? null,
        acknowledgedAt: settings.acknowledgedAt ?? null,
      });
    } catch (error) {
      console.error('Error building curated override log:', error);
      res.status(500).json({ error: 'Failed to build override log' });
    }
  });

  // OBSERVE-ONLY correction telemetry (Task #1180 rework) — HONEST episode /
  // workload telemetry. This no longer previews rule-compiler correlations
  // (which implied a pattern would become an auto-enforceable rule); instead it
  // reports the REAL editor workload: how many immutable actions were captured,
  // how they collapse into episodes, the per-family / per-action / per-label
  // breakdown, and how much learnable evidence remains after the default
  // ambiguous/unverified exclusion. Nothing here is approvable or enforced.
  // 90-day lookback, honors the reset checkpoint. Read-only.
  app.get("/api/curated/correction-telemetry", requireCuratedAccess, async (_req, res) => {
    try {
      const settings = await storage.getCuratedFeedbackSettings();
      const ack = settings.acknowledgedAt ? new Date(settings.acknowledgedAt) : null;
      const windowSince = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const since = ack && ack > windowSince ? ack : windowSince;
      const events = await storage.getCuratedOverrideEventsSince(since, 5000);
      const { episodes, workload } = buildEpisodeExplorer(events);
      const evidenceCounts = computeFilteredCounts(episodes);
      res.json({ ok: true, windowDays: 90, workload, evidenceCounts });
    } catch (error) {
      console.error('Error building curated correction telemetry:', error);
      res.status(500).json({ error: 'Failed to build correction telemetry' });
    }
  });

  app.post("/api/curated/override-log/pause", requireCuratedAccess, async (req: any, res) => {
    try {
      const paused = req.body?.paused === true;
      const updatedBy = req.user?.claims?.email || 'dev';
      const settings = await storage.setCuratedCapturePaused(paused, updatedBy);
      res.json({ ok: true, capturePaused: settings.capturePaused, capturePausedBy: settings.updatedBy });
    } catch (error) {
      console.error('Error setting curated capture pause:', error);
      res.status(500).json({ error: 'Failed to set capture pause' });
    }
  });

  // Non-destructive reset of the Adjustments learning log: stamps a checkpoint so
  // the report/recent/brief only count editor actions logged after it. Raw rows
  // are preserved for audit. Intended for use after a tuning brief has been applied.
  app.post("/api/curated/override-log/reset", requireCuratedEditor, async (req: any, res) => {
    try {
      const updatedBy = req.user?.claims?.email || 'dev';
      const settings = await storage.resetCuratedOverrideLog(updatedBy);
      res.json({ ok: true, acknowledgedAt: settings.acknowledgedAt, acknowledgedBy: settings.updatedBy });
    } catch (error) {
      console.error('Error resetting curated override log:', error);
      res.status(500).json({ error: 'Failed to reset override log' });
    }
  });

  // NOTE (Task #1180): the on-demand AI brief route (POST
  // /api/curated/override-log/brief) has been REMOVED. Editor actions are now
  // surfaced as deterministic EVIDENCE (GET /api/curated/editorial-evidence and
  // /api/curated/editorial-evidence/packet) for a development agent to learn
  // from — there is no auto-generated AI brief and nothing is auto-enforced.

  // Curated lane — HISTORICAL story ARCHIVE. Searchable list of every FORMED
  // story preserved across the per-pass member wipe (curated_story_archive),
  // newest activity first. Curated-gated; reads ONLY the isolated archive table —
  // never getPrimaryFeed, the public REST API, custom MCOPs, or Classic/Visual.
  app.get("/api/curated/archive", requireCuratedView, async (req, res) => {
    try {
      const query = ((req.query.q as string) || '').trim();
      const rawLimit = parseInt(req.query.limit as string);
      const rawOffset = parseInt(req.query.offset as string);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 30, 1), 100);
      const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
      const cacheKey = `archive:${query}:${limit}:${offset}`;
      const cached = getCuratedCache(req, cacheKey);
      if (cached) return res.json(cached);
      const result = await storage.searchCuratedStoryArchive({ query, limit, offset });
      const payload = { items: result.items, total: result.total, limit, offset };
      setCuratedCache(cacheKey, payload, 60_000);
      res.json(payload);
    } catch (error) {
      console.error('[Curated] archive error:', error);
      res.json({ items: [], total: 0, limit: 30, offset: 0 });
    }
  });

  // Curated clustering "flight recorder" — recent per-pass metrics snapshots
  // (size distribution, refinement-backstop behavior, archive churn). Read-only
  // observability gated behind requireCuratedAccess; CURATED-ONLY, never exposed
  // on the public /api/v1 API. Newest first; limit clamped to [1, 500].
  app.get("/api/curated/cluster-metrics", requireCuratedAccess, async (req, res) => {
    try {
      const rawLimit = parseInt(req.query.limit as string);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 500);
      const items = await storage.getCuratedClusterMetrics(limit);
      res.json({ items, limit });
    } catch (error) {
      console.error('[Curated] cluster-metrics error:', error);
      res.json({ items: [], limit: 100 });
    }
  });

  // Admin maintenance — collapse the EXISTING backlog of duplicate (same-story)
  // archive rows the old single-match carry-forward left behind. Dry-run by default
  // (body { dryRun: false } to actually write). Curated-lane only; never touches the
  // main feed / public API. Body: { dryRun?: boolean, windowHours?: number }.
  app.post("/api/admin/curated/archive/normalize-duplicates", requireAdmin, async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false; // default true (safe)
      const rawWindow = Number(req.body?.windowHours);
      const windowHours = Number.isFinite(rawWindow) ? rawWindow : undefined;
      const result = await storage.normalizeCuratedArchiveDuplicates({ dryRun, windowHours });
      res.json(result);
    } catch (error) {
      console.error('[Curated] archive normalize-duplicates error:', error);
      res.status(500).json({ error: 'Failed to normalize archive duplicates' });
    }
  });

  // Admin maintenance — close the legacy over-age "zombie" archive rows (a single
  // row holding a multi-day blob of sources that displays as one absurd story) by
  // bounding each to its most-recent episode window. Dry-run by default (body
  // { dryRun: false } to actually write). Curated-lane only; never touches the
  // main feed / public API. Body: { dryRun?: boolean, windowHours?: number }.
  app.post("/api/admin/curated/archive/bound-episodes", requireAdmin, async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false; // default true (safe)
      const rawWindow = Number(req.body?.windowHours);
      const windowHours = Number.isFinite(rawWindow) ? rawWindow : undefined;
      const result = await storage.boundOverAgeCuratedArchiveEpisodes({ dryRun, windowHours });
      res.json(result);
    } catch (error) {
      console.error('[Curated] archive bound-episodes error:', error);
      res.status(500).json({ error: 'Failed to bound archive episodes' });
    }
  });

  // Admin maintenance — orphaned object-storage image sweep (Task #765). Deletes
  // `/objects/stream-images/` files no longer referenced by ANY table (curated
  // media resets, re-enrichment, and row deletions orphan the old file). Dry-run
  // by default (body { dryRun: false } to actually delete). Also runs as a
  // deployment-gated daily cron. Body: { dryRun?: boolean, maxDeletions?: number,
  // minAgeHours?: number }. DELETION IS DEPLOYMENT-GATED here too (same as the
  // cron): stream-images is a SHARED bucket across dev and the deployed app, but
  // each has its OWN database, so a real delete from a non-deployed copy would
  // use the dev DB's references and could remove files the deployed app still
  // uses. A non-deployment caller therefore always gets a scan-only result even
  // with { dryRun: false } — the response's `deletionsAllowed` reports this.
  // Bullets-coverage telemetry (Task #14). Explains WHY curated Top Stories
  // cards lack summary bullets: per-reason breakdown (recorded at generation
  // time), enrichment lifecycle for unexplained rows, and a sample of the most
  // recent bullet-less rows. Read-only.
  app.get("/api/admin/curated/bullets-coverage", requireAdmin, async (req, res) => {
    try {
      const rawHours = Number(req.query.hours);
      const hours = Number.isFinite(rawHours) && rawHours > 0 ? Math.min(rawHours, 24 * 14) : 72;
      const { db } = await import('./db');
      const { sql } = await import('drizzle-orm');
      const totals = await db.execute(sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE summary_bullets IS NOT NULL AND cardinality(summary_bullets) > 0)::int AS with_bullets
        FROM curated_items WHERE scraped_at > now() - make_interval(hours => ${hours})`);
      const byReason = await db.execute(sql`
        SELECT COALESCE(bullets_failure_reason, CASE
                 WHEN media_scraped_at IS NOT NULL THEN 'unclassified_stamped'
                 WHEN media_attempt_count >= 6 THEN 'retry_capped_unclassified'
                 WHEN media_attempt_count > 0 THEN 'retrying'
                 ELSE 'pending_never_attempted' END) AS reason,
               count(*)::int AS count
        FROM curated_items
        WHERE scraped_at > now() - make_interval(hours => ${hours})
          AND (summary_bullets IS NULL OR cardinality(summary_bullets) = 0)
        GROUP BY 1 ORDER BY 2 DESC`);
      const sample = await db.execute(sql`
        SELECT id, title, source, url, bullets_failure_reason, media_scraped_at,
               media_attempt_count, last_media_attempt_at, scraped_at
        FROM curated_items
        WHERE scraped_at > now() - make_interval(hours => ${hours})
          AND (summary_bullets IS NULL OR cardinality(summary_bullets) = 0)
        ORDER BY scraped_at DESC LIMIT 50`);
      const t = (totals.rows?.[0] ?? {}) as { total?: number; with_bullets?: number };
      res.json({
        windowHours: hours,
        total: t.total ?? 0,
        withBullets: t.with_bullets ?? 0,
        coveragePct: t.total ? Math.round(((t.with_bullets ?? 0) / t.total) * 1000) / 10 : null,
        withoutBulletsByReason: byReason.rows,
        sampleWithoutBullets: sample.rows,
      });
    } catch (error) {
      console.error('[Admin] bullets-coverage failed:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Manual bullets/media backfill trigger (Task #14) — same pass the recurring
  // cron runs, with an operator-chosen window/batch for one-time catch-ups.
  app.post("/api/admin/curated/backfill-bullets", requireAdmin, async (req, res) => {
    try {
      const rawHours = Number(req.body?.hoursBack);
      const hoursBack = Number.isFinite(rawHours) && rawHours > 0 ? Math.min(rawHours, 24 * 14) : 72;
      const rawMax = Number(req.body?.maxItems);
      const maxItems = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(rawMax, 200) : 60;
      const { backfillStaleCuratedMedia } = await import('./streamPrefetch');
      const result = await backfillStaleCuratedMedia(hoursBack, maxItems);
      res.json({ hoursBack, maxItems, ...result });
    } catch (error) {
      console.error('[Admin] backfill-bullets failed:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Topic/region distribution report (Task #25) — per-topic and per-region
  // share over a selectable recent window so overbroad/underused focus areas
  // can be reviewed with real data before any future taxonomy change.
  app.get("/api/admin/curated/topic-distribution", requireAdmin, async (req, res) => {
    try {
      const rawHours = Number(req.query?.hours);
      const hours = Number.isFinite(rawHours) && rawHours > 0 ? Math.min(rawHours, 24 * 90) : 24 * 7;
      const topics = await db.execute(sql`
        SELECT COALESCE(primary_topic, '(unclassified)') AS topic, count(*)::int AS n
        FROM curated_classifications
        WHERE classified_at > now() - make_interval(hours => ${hours})
        GROUP BY 1 ORDER BY n DESC`);
      const regions = await db.execute(sql`
        SELECT COALESCE(region, '(none)') AS region, count(*)::int AS n
        FROM curated_classifications
        WHERE classified_at > now() - make_interval(hours => ${hours})
        GROUP BY 1 ORDER BY n DESC`);
      const total = (topics.rows as any[]).reduce((s, r) => s + (r.n ?? 0), 0);
      const withShare = (rows: any[], key: string) => rows.map((r) => ({
        [key]: r[key], count: r.n,
        sharePct: total ? Math.round((r.n / total) * 1000) / 10 : null,
      }));
      res.json({
        windowHours: hours,
        total,
        topics: withShare(topics.rows as any[], 'topic'),
        regions: withShare(regions.rows as any[], 'region'),
      });
    } catch (error) {
      console.error('[Admin] topic-distribution failed:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Bounded reclassification backfill (Task #25) — mark AI-labeled rows inside
  // the LIVE curated candidate window whose topic is one of the historically
  // over-assigned buckets (Military Ops, Diplomacy, Cyber/Emerging Tech) or the
  // catch-all as reclassify-eligible (primary_topic → NULL, cooldown aged out),
  // so the normal classifier cron re-labels them under the sharpened prompt and
  // new AI topic. Human-provenance rows are NEVER touched, and nothing outside
  // the visible window is reprocessed.
  app.post("/api/admin/curated/reclassify-topics", requireAdmin, async (req, res) => {
    try {
      const rawMax = Number(req.body?.maxItems);
      const maxItems = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(rawMax, 500) : 200;
      const dryRun = req.body?.dryRun === true;
      const TARGET_TOPICS = [
        'Military Operations & Armed Conflict',
        'Foreign Policy & Diplomacy',
        'Cyber, Space & Emerging Technology',
        'Other / Emerging',
      ];
      const { buildCuratedCandidateWindow, scheduleCuratedClassificationBackfill } = await import('./curatedClassify');
      const { normalizeIdentityUrl } = await import('./urlIdentity');
      const { candidates } = await buildCuratedCandidateWindow();
      const urlSet = new Set<string>();
      for (const c of candidates) {
        urlSet.add(c.url);
        const canon = normalizeIdentityUrl(c.url);
        if (canon) urlSet.add(canon);
      }
      const urls = Array.from(urlSet);
      if (urls.length === 0) return res.json({ eligible: 0, cleared: 0, dryRun });
      // drizzle expands a JS array param into a tuple (cannot cast to text[]);
      // build the array literals from individual params instead.
      const sqlTextArray = (vals: string[]) =>
        sql`ARRAY[${sql.join(vals.map((v) => sql`${v}`), sql`, `)}]::text[]`;
      const eligibleRows = await db.execute(sql`
        SELECT url, primary_topic FROM curated_classifications
        WHERE url = ANY(${sqlTextArray(urls)})
          AND provenance = 'ai'
          AND primary_topic = ANY(${sqlTextArray(TARGET_TOPICS)})
        LIMIT ${maxItems}`);
      const targets = (eligibleRows.rows as any[]).map((r) => r.url as string);
      let cleared = 0;
      if (!dryRun && targets.length > 0) {
        const r = await db.execute(sql`
          UPDATE curated_classifications
          SET primary_topic = NULL,
              proposed_topic = NULL,
              classified_at = now() - interval '7 days'
          WHERE url = ANY(${sqlTextArray(targets)})
            AND provenance = 'ai'`);
        cleared = (r as any).rowCount ?? targets.length;
        scheduleCuratedClassificationBackfill(2_000);
      }
      res.json({ candidateWindow: candidates.length, eligible: targets.length, cleared, dryRun, maxItems });
    } catch (error) {
      console.error('[Admin] reclassify-topics failed:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post("/api/admin/curated/orphan-image-sweep", requireAdmin, async (req, res) => {
    try {
      const isDeployment = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';
      const dryRun = req.body?.dryRun !== false; // default true (safe)
      const rawMax = Number(req.body?.maxDeletions);
      const maxDeletions = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(rawMax, 5000) : undefined;
      const rawAge = Number(req.body?.minAgeHours);
      const minAgeMs = Number.isFinite(rawAge) && rawAge >= 0 ? rawAge * 3_600_000 : undefined;
      const { runOrphanImageSweep } = await import('./orphanImageSweep');
      const result = await runOrphanImageSweep({
        dryRun,
        allowDelete: isDeployment,
        maxDeletions,
        minAgeMs,
        reason: dryRun ? 'admin-dryrun' : 'admin',
      });
      res.json({
        ...result,
        // Make it explicit to operators why a { dryRun: false } request in a
        // non-deployed environment still deleted nothing.
        note: !isDeployment && !dryRun
          ? 'Scan-only: real deletions run in the deployed environment only (shared bucket, separate databases).'
          : undefined,
      });
    } catch (error) {
      console.error('[Curated] orphan-image-sweep error:', error);
      res.status(500).json({ error: 'Failed to run orphan image sweep' });
    }
  });

  // Outlet registry — canonical source knowledge / labeling layer. Curated view
  // resolves logos, source character, origin region, and ratings from this.
  // Read-only and confined to the curated gate; no shared feed reads it.
  app.get("/api/curated/outlets", requireCuratedView, async (req, res) => {
    try {
      const cached = getCuratedCache(req, 'outlets');
      if (cached) return res.json(cached);
      const data = await storage.getOutletRegistry();
      setCuratedCache('outlets', data, 60_000);
      res.json(data);
    } catch (error) {
      console.error('Error fetching outlet registry:', error);
      res.status(500).json({ error: 'Failed to fetch outlet registry' });
    }
  });

  // Curated lane (Task #89) — member articles of a FORMED story, read from the
  // ISOLATED curated_cluster_members mapping (never headlines.cluster_id). Each
  // member carries its lane `role` so the detail pop-out can split CONTRIBUTING
  // (trusted, story-forming) sources from ATTACHED (adversary / opinion /
  // low-cred / social) sources. When the story is unclustered, the page falls
  // back to the single article it already has.
  app.get("/api/curated/cluster-members", requireCuratedView, async (req, res) => {
    try {
      const clusterId = (req.query.clusterId as string || '').trim();
      if (!clusterId) return res.json([]);

      const cmCacheKey = `cluster-members:${clusterId}`;
      const cachedCm = getCuratedCache(req, cmCacheKey);
      if (cachedCm) return res.json(cachedCm);

      const [rows, registry, linkReplacements, hiddenImages] = await Promise.all([
        storage.getCuratedClusterMembersByClusterId(clusterId),
        storage.getOutletRegistry(),
        // Dead-link overlay (Task #226), keyed `curated:<id>` — supplies the
        // working DISPLAY url for replaced curated members. Curated-only.
        storage.getCuratedLinkReplacements(),
        // Editor PHOTO HIDE overlay (Task #380 expansion), keyed by image URL —
        // a hidden member photo is nulled in the hydrated members. Curated-only.
        storage.getCuratedHiddenImages(),
      ]);
      // Per-source spin (Task #90): looked up from the synthesis cache by the
      // story's STABLE stored clusterId (Task #301). Synthesis is now keyed by the
      // clusterId persisted at formation, so resolve it directly instead of
      // recomputing a member-set hash (which re-minted a fresh key on every
      // source-churn and missed the cache). Blocked members are only hidden from
      // DISPLAY below.
      const synth = await storage.getCuratedStorySynthesisBySignature(clusterId);
      const spins = synth?.spins ?? {};
      const alignments = synth?.alignments ?? {};
      // Task #126 — photos + AI summary bullets now live on curated_items (filled
      // by Task #124). The cluster-member snapshot has a stale ogImageUrl and no
      // bullets, so enrich each curated member from the live curated_items row.
      // Read ONLY from curated_items (curated lane isolation preserved).
      const curatedItemsById = await storage.getCuratedItemsByIds(
        rows.filter(r => r.itemType === 'curated').map(r => r.itemId),
      );
      const memberIndex = buildOutletIndex(registry);
      // Same enrichment the inline top-stories embedding uses (shared helper):
      // blocked filter + dead-link overlay + live curated_items photo/bullets +
      // per-source spin/alignment, sorted newest-first.
      // Cross-pass member-confirmation hysteresis (Task #645) — same gate as
      // the inline top-stories embedding, so this by-clusterId fetch never
      // shows a not-yet-confirmed provisional member that the card header
      // (sourceCount) already withheld.
      const confirmedRows = rows.filter(isConfirmedCuratedMember);
      const members = hydrateCuratedClusterMembers(
        confirmedRows, memberIndex, linkReplacements, curatedItemsById, spins, alignments, hiddenImages,
      );
      setCuratedCache(cmCacheKey, members, 30_000);
      res.json(members);
    } catch (error) {
      console.error('Error fetching curated cluster members:', error);
      res.status(500).json({ error: 'Failed to fetch cluster members' });
    }
  });

  // Curated-only read proxies for the side-column feeds. The classic endpoints
  // (/api/truth-social-posts, /api/x-posts, /api/osint-posts, etc.) sit behind
  // the global /api auth guard, which a curated-only (non-team) session cannot
  // satisfy. These proxies expose the same read-only data under the curated
  // gate without altering the existing endpoints or their auth.
  // Curated social feeds. Truth Social reaches back 48h; all X feeds reach back
  // 24h (the shared X/OSINT path uses a ~30h window which satisfies 24h). A
  // generous per-feed row cap protects against runaway payloads on busy days.
  const CURATED_TRUTH_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours (Truth Social)
  const CURATED_SOCIAL_WINDOW_MS = 30 * 60 * 60 * 1000; // ~30 hours (X feeds ≥24h)
  const CURATED_SOCIAL_MAX_ROWS = 300;

  app.get("/api/curated/truth-social-posts", requireCuratedView, async (req, res) => {
    try {
      const cached = getCuratedCache(req, 'truth-social-posts');
      if (cached) return res.json(cached);
      const since = new Date(Date.now() - CURATED_TRUTH_WINDOW_MS);
      const data = await storage.getCuratedTruthSocialPosts(since, CURATED_SOCIAL_MAX_ROWS);
      setCuratedCache('truth-social-posts', data, 30_000);
      res.json(data);
    } catch (error) {
      console.error('Error fetching curated Truth Social posts:', error);
      res.status(500).json({ error: 'Failed to fetch Truth Social posts' });
    }
  });

  // Curated-only feed routing. These account handles must stay in sync with the
  // scraper lists (X_POSTS_ACCOUNTS in server/xScraper.ts and OSINT_ACCOUNTS in
  // server/osintScraper.ts). Re-routing here is display-only and does NOT change
  // what gets scraped, so the main MCOP feeds are unaffected.
  // "U.S. X Feed": shared X posts + the combatant-command handles below (which
  // live in osint_posts). CENTCOM/SOUTHCOM are SHARED — they also appear in the
  // main OSINT feed. The other 9 commands are CURATED-ONLY: they are read here
  // via getCuratedOsintPosts but excluded from every non-curated reader via
  // CURATED_ONLY_OSINT_HANDLES (see server/curatedOnlyOsint.ts).
  // USPACOM was formerly @INDOPACOM; the legacy handle is kept so already-stored
  // curated posts under the old name still surface alongside the new ones.
  // Derived from the canonical social-account catalog (Task #1038); edit the
  // roster in shared/socialAccountCatalog.ts.
  const CURATED_US_OSINT_ACCOUNTS = CATALOG_CURATED_US_OSINT_ACCOUNTS;
  // "OSINT X Feed": sentdefender + these OSINT accounts (CENTCOM/SOUTHCOM excluded).
  const CURATED_OSINT_ACCOUNTS = CATALOG_CURATED_OSINT_ACCOUNTS;

  app.get("/api/curated/x-posts", requireCuratedView, async (req, res) => {
    try {
      const cached = getCuratedCache(req, 'x-posts');
      if (cached) return res.json(cached);
      const since = new Date(Date.now() - CURATED_SOCIAL_WINDOW_MS);
      const [xp, ...osintByAccount] = await Promise.all([
        storage.getCuratedXPosts(since, CURATED_SOCIAL_MAX_ROWS),
        ...CURATED_US_OSINT_ACCOUNTS.map((acct) =>
          storage.getCuratedOsintPosts(since, CURATED_SOCIAL_MAX_ROWS, acct)
        ),
      ]);
      // Normalize CENTCOM/SOUTHCOM OSINT rows into the X-post shape the feed renders.
      const normalized = osintByAccount.flat().map((p) => ({
        id: p.id,
        postId: p.postId,
        content: p.content,
        postedAt: p.postedAt,
        xUrl: p.xUrl,
        sourceAccount: p.sourceAccount,
        accountCategory: 'default',
        isRetweet: p.isRetweet ?? false,
        retweetedFrom: p.retweetedFrom ?? null,
        imageUrl: p.imageUrl ?? null,
        isHidden: false,
        scrapedAt: p.scrapedAt,
      }));
      // Belt-and-suspenders: influencer-tagged rows must never surface in the
      // curated U.S. X Feed. getCuratedXPosts already excludes them, but filter
      // again here so the curated feed stays clean even if that changes.
      const xpOfficial = xp.filter((p) => p.accountCategory !== 'influencer');
      const combined = [...xpOfficial, ...normalized].sort(
        (a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime()
      );
      const xOut = combined.slice(0, CURATED_SOCIAL_MAX_ROWS);
      setCuratedCache('x-posts', xOut, 30_000);
      res.json(xOut);
    } catch (error) {
      console.error('Error fetching curated X posts:', error);
      res.status(500).json({ error: 'Failed to fetch X posts' });
    }
  });

  app.get("/api/curated/osint-posts", requireCuratedView, async (req, res) => {
    try {
      const cached = getCuratedCache(req, 'osint-posts');
      if (cached) return res.json(cached);
      const since = new Date(Date.now() - CURATED_SOCIAL_WINDOW_MS);
      const [sent, ...osintByAccount] = await Promise.all([
        storage.getCuratedSentDefenderPosts(since, CURATED_SOCIAL_MAX_ROWS),
        ...CURATED_OSINT_ACCOUNTS.map((acct) =>
          storage.getCuratedOsintPosts(since, CURATED_SOCIAL_MAX_ROWS, acct)
        ),
      ]);
      const combined = [...sent, ...osintByAccount.flat()].sort(
        (a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime()
      );
      const osintOut = combined.slice(0, CURATED_SOCIAL_MAX_ROWS);
      setCuratedCache('osint-posts', osintOut, 30_000);
      res.json(osintOut);
    } catch (error) {
      console.error('Error fetching curated OSINT posts:', error);
      res.status(500).json({ error: 'Failed to fetch OSINT posts' });
    }
  });

  // "Journalists X Feed" (Task #182) — curated-lane-only. Reads the isolated
  // journalist_posts table behind the curated access gate so journalist posts
  // never leak into the main feed, public API, MCOP Bot, Dashboard, or Stream.
  // Derived from the canonical social-account catalog (Task #1038).
  const CURATED_JOURNALIST_ACCOUNTS = CATALOG_CURATED_JOURNALIST_ACCOUNTS;

  interface SocialLinkCandidate {
    id: string;
    laneType: 'x' | 'osint' | 'journalist' | 'truth' | 'dataminr' | 'response' | 'sentdefender';
    source: string;
    snippet: string;
    url: string;
    postedAt: Date | string;
  }

  // One fail-closed candidate builder serves both the editor picker and the
  // social-card commit-time revalidation. A visible feed row alone is never
  // enough: the account/lane must be approved and its normalized URL must
  // resolve to a current Curated item.
  const getEligibleCuratedSocialLinkCandidates = async (): Promise<SocialLinkCandidate[]> => {
    const since = new Date(Date.now() - CURATED_SOCIAL_WINDOW_MS);
    const [xpRaw, truthRaw, rapidRaw, dowRaw, sentRaw] = await Promise.all([
      storage.getCuratedXPosts(since, CURATED_SOCIAL_MAX_ROWS),
      storage.getCuratedTruthSocialPosts(since, CURATED_SOCIAL_MAX_ROWS),
      storage.getCuratedRapidResponsePosts(since, CURATED_SOCIAL_MAX_ROWS),
      storage.getCuratedDOWResponsePosts(since, CURATED_SOCIAL_MAX_ROWS),
      storage.getCuratedSentDefenderPosts(since, CURATED_SOCIAL_MAX_ROWS),
    ]);
    const osintByAccount = await Promise.all(
      [...CURATED_US_OSINT_ACCOUNTS, ...CURATED_OSINT_ACCOUNTS].map((account) =>
        storage.getCuratedOsintPosts(since, 50, account),
      ),
    );
    const journalistByAccount = await Promise.all(
      CURATED_JOURNALIST_ACCOUNTS.map((account) =>
        storage.getCuratedJournalistPosts(since, 50, account),
      ),
    );
    const firstAlerts = await storage.getRecentFirstAlertsForCurated(
      CURATED_SOCIAL_WINDOW_MS / 3_600_000,
      100,
    );
    const curatedIdentityUrls = new Set(
      (await storage.getCuratedStoreItems(CURATED_SOCIAL_WINDOW_MS / 3_600_000))
        .map((item) => normalizeIdentityUrl(item.url))
        .filter(Boolean),
    );
    const candidates: SocialLinkCandidate[] = [];
    const seenUrls = new Set<string>();
    const admit = (candidate: SocialLinkCandidate) => {
      const identityUrl = normalizeIdentityUrl(candidate.url);
      if (!candidate.url || !/^https?:\/\//i.test(candidate.url) || !identityUrl) return;
      if (!curatedIdentityUrls.has(identityUrl) || seenUrls.has(identityUrl)) return;
      seenUrls.add(identityUrl);
      candidates.push(candidate);
    };
    for (const p of xpRaw) {
      if (p.accountCategory === 'influencer') continue;
      if (!isApprovedCuratedAttachmentAccount(p.sourceAccount, 'x-default')) continue;
      if (!p.content || !p.xUrl) continue;
      admit({ id: p.id, laneType: 'x', source: p.sourceAccount, snippet: p.content.slice(0, 200), url: p.xUrl, postedAt: p.postedAt });
    }
    for (const post of truthRaw) {
      if (!post.content || !post.truthSocialUrl) continue;
      admit({ id: post.id, laneType: 'truth', source: 'POTUS', snippet: post.content.slice(0, 200), url: post.truthSocialUrl, postedAt: post.postedAt });
    }
    for (const post of osintByAccount.flat()) {
      if (!isApprovedCuratedAttachmentAccount(post.sourceAccount, 'osint')) continue;
      if (!post.content || !post.xUrl) continue;
      admit({ id: post.id, laneType: 'osint', source: post.sourceAccount, snippet: post.content.slice(0, 200), url: post.xUrl, postedAt: post.postedAt });
    }
    for (const post of journalistByAccount.flat()) {
      if (!isApprovedCuratedAttachmentAccount(post.sourceAccount, 'journalist')) continue;
      if (!post.content || !post.xUrl) continue;
      admit({ id: post.id, laneType: 'journalist', source: post.sourceAccount, snippet: post.content.slice(0, 200), url: post.xUrl, postedAt: post.postedAt });
    }
    for (const alert of firstAlerts) {
      if (!alert.headline || !alert.url || !/^https?:\/\//i.test(alert.url)) continue;
      admit({ id: alert.id, laneType: 'dataminr', source: 'DataMinr', snippet: alert.headline.slice(0, 200), url: alert.url, postedAt: alert.publishedAt ?? new Date() });
    }
    const addDedicated = (
      lane: 'rapidresponse' | 'dowresponse' | 'sentdefender',
      handles: readonly string[],
      rows: Array<{ id: string; content: string; xUrl: string; postedAt: Date }>,
    ) => {
      const handle = handles[0];
      if (!handle || !isApprovedCuratedAttachmentAccount(handle, lane)) return;
      for (const post of rows) {
        if (!post.content || !post.xUrl) continue;
        admit({
          id: post.id,
          laneType: lane === 'sentdefender' ? 'sentdefender' : 'response',
          source: handle,
          snippet: post.content.slice(0, 200),
          url: post.xUrl,
          postedAt: post.postedAt,
        });
      }
    };
    addDedicated('rapidresponse', CATALOG_RAPIDRESPONSE_HANDLES, rapidRaw);
    addDedicated('dowresponse', CATALOG_DOWRESPONSE_HANDLES, dowRaw);
    addDedicated('sentdefender', CATALOG_SENTDEFENDER_HANDLES, sentRaw);
    return candidates
      .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
      .slice(0, 300);
  };

  app.get("/api/curated/journalist-posts", requireCuratedView, async (req, res) => {
    try {
      const cached = getCuratedCache(req, 'journalist-posts');
      if (cached) return res.json(cached);
      const since = new Date(Date.now() - CURATED_SOCIAL_WINDOW_MS);
      const byAccount = await Promise.all(
        CURATED_JOURNALIST_ACCOUNTS.map((acct) =>
          storage.getCuratedJournalistPosts(since, CURATED_SOCIAL_MAX_ROWS, acct)
        )
      );
      const combined = byAccount.flat().sort(
        (a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime()
      );
      const journoOut = combined.slice(0, CURATED_SOCIAL_MAX_ROWS);
      setCuratedCache('journalist-posts', journoOut, 30_000);
      res.json(journoOut);
    } catch (error) {
      console.error('Error fetching curated Journalist posts:', error);
      res.status(500).json({ error: 'Failed to fetch Journalist posts' });
    }
  });

  // Social link candidates — aggregated from all curated social lanes for the
  // "Link / merge stories" editor dialog. Returns posts in a unified shape so
  // the dialog can offer X/OSINT/journalist/Truth Social posts as a third
  // attach-only candidate group alongside Top Stories and Scoring Radar.
  // Gated on requireCuratedEditor (same tier as the link-items write route).
  // Curated-lane only: nothing here touches the main feed or public API.
  app.get("/api/curated/social-link-candidates", requireCuratedEditor, async (req, res) => {
    try {
      const cached = getCuratedCache(req, 'social-link-candidates');
      if (cached) return res.json(cached);
      const out = await getEligibleCuratedSocialLinkCandidates();
      setCuratedCache('social-link-candidates', out, 30_000);
      res.json(out);
    } catch (error) {
      console.error('Error fetching social link candidates:', error);
      res.status(500).json({ error: 'Failed to fetch social link candidates' });
    }
  });

  app.get("/api/curated/response-feed", requireCuratedView, async (req, res) => {
    try {
      const cached = getCuratedCache(req, 'response-feed');
      if (cached) return res.json(cached);
      const since = new Date(Date.now() - CURATED_SOCIAL_WINDOW_MS);
      const [rapid, dow] = await Promise.all([
        storage.getCuratedRapidResponsePosts(since, CURATED_SOCIAL_MAX_ROWS),
        storage.getCuratedDOWResponsePosts(since, CURATED_SOCIAL_MAX_ROWS),
      ]);
      const rfPayload = { rapidResponsePosts: rapid, dowResponsePosts: dow };
      setCuratedCache('response-feed', rfPayload, 30_000);
      res.json(rfPayload);
    } catch (error) {
      console.error('Error fetching curated response feed:', error);
      res.status(500).json({ error: 'Failed to fetch response feed' });
    }
  });

  app.get("/api/curated/first-alerts", requireCuratedView, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const faCacheKey = `first-alerts:${limit}`;
      const cachedFa = getCuratedCache(req, faCacheKey);
      if (cachedFa) return res.json(cachedFa);
      const data = await storage.getRecentFirstAlerts(limit);
      setCuratedCache(faCacheKey, data, 30_000);
      res.json(data);
    } catch (error) {
      console.error('Error fetching curated First Alerts:', error);
      res.status(500).json({ error: 'Failed to fetch First Alerts' });
    }
  });

  app.get("/api/curated/ticker", requireCuratedView, (_req, res) => {
    res.json(getTickerData());
  });

  // Curated-only live leadership broadcast banner status. Returns the cached
  // single live-status object (or { status: null } when nothing is happening).
  // CURATED LANE ONLY — gated like every other /api/curated/* route so it can
  // never surface on Classic/Visual/custom-MCOP/public API.
  app.get("/api/curated/live-status", requireCuratedView, async (req, res) => {
    try {
      // Preview override (curated-access-gated, viewer-local): lets a tester see
      // each banner stage on demand without waiting for a real broadcast. Add
      // ?preview=upcoming|live|recently_ended to the Curated URL. Returns a
      // clearly-labeled synthetic status; never touches the real aggregator.
      const preview = String(req.query.preview || "").toLowerCase();
      if (preview === "upcoming" || preview === "live" || preview === "recently_ended") {
        const now = Date.now();
        const sample = {
          upcoming: {
            state: "upcoming" as const,
            leader: "President",
            title: "President to deliver remarks (preview sample)",
            watchUrl: "https://www.whitehouse.gov/live/",
            startsAt: new Date(now + 15 * 60 * 1000).toISOString(),
          },
          live: {
            state: "live" as const,
            leader: "President",
            title: "President delivers remarks (preview sample)",
            watchUrl: "https://www.whitehouse.gov/live/",
            since: new Date(now - 3 * 60 * 1000).toISOString(),
          },
          recently_ended: {
            state: "recently_ended" as const,
            leader: "President",
            title: "President delivered remarks (preview sample)",
            watchUrl: "https://www.whitehouse.gov/live/",
            endsAt: new Date(now - 5 * 60 * 1000).toISOString(),
          },
        }[preview];
        return res.json({ status: sample, lastComputed: now });
      }
      const result = await getModeratedLiveBroadcastStatus();
      res.json(result);
    } catch (error) {
      console.error("Error fetching curated live-status:", error);
      // Fail soft: an empty status just hides the banner.
      res.json({ status: null, lastComputed: null });
    }
  });

  // Curated-gated read endpoint for live-broadcast firing history. Returns recent
  // firings (filterable by ?hours= window, default 72h, max 720h) so an audit of
  // when the banner fired and what triggered it is a single query, not a replay.
  app.get("/api/curated/live-status/firings", requireCuratedView, async (req: any, res) => {
    try {
      const hours = Math.min(Math.max(Number(req.query.hours) || 72, 1), 720);
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
      const [firings, activeBanner] = await Promise.all([
        storage.getRecentLiveBroadcastFirings(hours, limit),
        getModeratedLiveBroadcastStatus(),
      ]);
      const canEdit = await isCuratedEditor(req);
      const moderationMap = await storage.getLiveBroadcastModerations(firings.map((f) => f.eventKey));
      res.json({
        canEdit,
        activeBanner: {
          eventKey: activeBanner.eventKey,
          status: activeBanner.status,
          lastComputed: activeBanner.lastComputed,
        },
        firings: firings.map((f) => {
          const moderation = moderationMap.get(f.eventKey) ?? null;
          const detector: LiveBroadcastStatus = {
            state: f.state as LiveBroadcastStatus["state"],
            leader: f.leader as LiveBroadcastStatus["leader"],
            title: f.title,
            watchUrl: f.watchUrl,
            ...(f.state === "upcoming" && f.startsAt ? { startsAt: f.startsAt.toISOString() } : {}),
            ...(f.state === "live" ? { since: f.firstObservedAt.toISOString() } : {}),
            ...(f.state === "recently_ended" && f.endedAt ? { endsAt: f.endedAt.toISOString() } : {}),
          };
          return {
            ...f,
            moderation,
            effectiveStatus: applyLiveBroadcastModeration(detector, moderation),
            isCurrentBannerEvent: isCurrentLiveBroadcastEvent(f.eventKey, activeBanner.eventKey),
          };
        }),
      });
    } catch (error) {
      console.error("Error fetching live-broadcast firings:", error);
      res.status(500).json({ error: "Failed to fetch firings" });
    }
  });

  const parseLiveAlertAnnotation = (body: any): { reasonKeys: string[]; reasonNote: string | null } => {
    const reasonKey = typeof body?.reasonKey === "string" ? body.reasonKey.trim() : "";
    if (reasonKey && !LIVE_ALERT_REASON_KEYS.has(reasonKey)) {
      throw new Error("Invalid live-alert reason");
    }
    const reasonNote = typeof body?.reasonNote === "string" ? body.reasonNote.trim() : "";
    if (reasonNote.length > 1000) throw new Error("Reason note must be 1000 characters or fewer");
    return { reasonKeys: reasonKey ? [reasonKey] : [], reasonNote: reasonNote || null };
  };

  const liveFiringSnapshot = (f: Awaited<ReturnType<typeof storage.getLiveBroadcastFiringById>>) => f ? ({
    eventKey: f.eventKey,
    state: f.state,
    leader: f.leader,
    title: f.title,
    watchUrl: f.watchUrl,
    startsAt: f.startsAt?.toISOString() ?? null,
    firstObservedAt: f.firstObservedAt.toISOString(),
    endedAt: f.endedAt?.toISOString() ?? null,
    source: f.source,
  }) : null;

  const liveAlertMutationResponse = async (
    firing: NonNullable<Awaited<ReturnType<typeof storage.getLiveBroadcastFiringById>>>,
    moderation: Awaited<ReturnType<typeof storage.getLiveBroadcastModeration>>,
  ) => {
    // Do not alter detector candidates, precedence, or audit history. Re-read
    // only the event-key-scoped Curated overlay saved above.
    const activeBanner = await refreshModeratedLiveBroadcastStatus();
    return {
      firingId: firing.id,
      selectedEvent: liveFiringSnapshot(firing),
      isCurrentBannerEvent: isCurrentLiveBroadcastEvent(firing.eventKey, activeBanner.eventKey),
      activeBanner: {
        eventKey: activeBanner.eventKey,
        status: activeBanner.status,
        lastComputed: activeBanner.lastComputed,
      },
      moderation,
    };
  };

  app.post("/api/curated/live-status/firings/:id/hide", requireCuratedEditor, async (req: any, res) => {
    try {
      const firing = await storage.getLiveBroadcastFiringById(req.params.id);
      if (!firing) return res.status(404).json({ error: "Live alert firing not found" });
      const annotation = parseLiveAlertAnnotation(req.body);
      const prior = await storage.getLiveBroadcastModeration(firing.eventKey);
      const editor = req.user?.claims?.email || "dev";
      const moderation = await storage.setLiveBroadcastModeration(
        firing.eventKey,
        true,
        prior?.overrides ?? {},
        editor,
      );
      await captureCuratedOverrideEvent({
        action: "live-alert-hide",
        editor,
        storyKey: firing.eventKey,
        itemUrl: firing.watchUrl,
        headline: firing.title,
        newValue: "live alert hidden",
        reasonKeys: annotation.reasonKeys,
        reasonNote: annotation.reasonNote,
        beforeValue: { detector: liveFiringSnapshot(firing), moderation: prior ?? null },
        afterValue: { detector: liveFiringSnapshot(firing), moderation },
      });
      res.json({ ok: true, ...(await liveAlertMutationResponse(firing, moderation)) });
    } catch (error: any) {
      const message = error?.message || "Failed to hide live alert";
      if (/Invalid live-alert reason|1000 characters/.test(message)) return res.status(400).json({ error: message });
      console.error("Error hiding live alert:", error);
      res.status(500).json({ error: "Failed to hide live alert" });
    }
  });

  app.post("/api/curated/live-status/firings/:id/restore", requireCuratedEditor, async (req: any, res) => {
    try {
      const firing = await storage.getLiveBroadcastFiringById(req.params.id);
      if (!firing) return res.status(404).json({ error: "Live alert firing not found" });
      const annotation = parseLiveAlertAnnotation(req.body);
      const prior = await storage.getLiveBroadcastModeration(firing.eventKey);
      const editor = req.user?.claims?.email || "dev";
      const moderation = await storage.setLiveBroadcastModeration(
        firing.eventKey,
        false,
        prior?.overrides ?? {},
        editor,
      );
      await captureCuratedOverrideEvent({
        action: "live-alert-restore",
        editor,
        storyKey: firing.eventKey,
        itemUrl: firing.watchUrl,
        headline: firing.title,
        newValue: "live alert restored",
        reasonKeys: annotation.reasonKeys,
        reasonNote: annotation.reasonNote,
        beforeValue: { detector: liveFiringSnapshot(firing), moderation: prior ?? null },
        afterValue: { detector: liveFiringSnapshot(firing), moderation },
      });
      res.json({ ok: true, ...(await liveAlertMutationResponse(firing, moderation)) });
    } catch (error: any) {
      const message = error?.message || "Failed to restore live alert";
      if (/Invalid live-alert reason|1000 characters/.test(message)) return res.status(400).json({ error: message });
      console.error("Error restoring live alert:", error);
      res.status(500).json({ error: "Failed to restore live alert" });
    }
  });

  app.post("/api/curated/live-status/firings/:id/edit", requireCuratedEditor, async (req: any, res) => {
    try {
      const firing = await storage.getLiveBroadcastFiringById(req.params.id);
      if (!firing) return res.status(404).json({ error: "Live alert firing not found" });
      const fields = validateLiveBroadcastOverrides(req.body?.fields);
      const annotation = parseLiveAlertAnnotation(req.body);
      const prior = await storage.getLiveBroadcastModeration(firing.eventKey);
      const editor = req.user?.claims?.email || "dev";
      const moderation = await storage.setLiveBroadcastModeration(
        firing.eventKey,
        prior?.suppressed ?? false,
        fields,
        editor,
      );
      await captureCuratedOverrideEvent({
        action: "live-alert-edit",
        editor,
        storyKey: firing.eventKey,
        itemUrl: firing.watchUrl,
        headline: firing.title,
        newValue: "live alert fields corrected",
        reasonKeys: annotation.reasonKeys,
        reasonNote: annotation.reasonNote,
        beforeValue: { detector: liveFiringSnapshot(firing), moderation: prior ?? null },
        afterValue: { detector: liveFiringSnapshot(firing), moderation },
      });
      res.json({ ok: true, ...(await liveAlertMutationResponse(firing, moderation)) });
    } catch (error: any) {
      const message = error?.message || "Failed to edit live alert";
      if (/Invalid|must be|only valid|characters|Watch URL|Title/.test(message)) {
        return res.status(400).json({ error: message });
      }
      console.error("Error editing live alert:", error);
      res.status(500).json({ error: "Failed to edit live alert" });
    }
  });

  // Curated View: read-only news scrub access (curated allowlist gated).
  // Registered before the global /api guard so curated-gate-only sessions can read.
  app.get("/api/curated/news-scrub/latest", requireCuratedView, async (req: any, res) => {
    try {
      const cached = getCuratedCache(req, 'news-scrub-latest');
      if (cached) return res.json(cached);
      const [latest] = await db.select().from(dailyNewsScrubs).orderBy(desc(dailyNewsScrubs.createdAt)).limit(1);
      if (!latest) {
        return res.status(404).json({ error: 'No daily news scrub found' });
      }
      const nsPayload = { id: latest.id, caoDate: latest.caoDate, filename: latest.filename, hasHtml: !!latest.htmlContent };
      setCuratedCache('news-scrub-latest', nsPayload, 60_000);
      res.json(nsPayload);
    } catch (error) {
      console.error('Error fetching latest daily news scrub (curated):', error);
      res.status(500).json({ error: 'Failed to fetch latest daily news scrub' });
    }
  });

  app.get("/api/curated/news-scrub/:id/html", requireCuratedView, async (req: any, res) => {
    try {
      const [scrub] = await db.select().from(dailyNewsScrubs).where(eq(dailyNewsScrubs.id, req.params.id));
      if (!scrub) {
        return res.status(404).json({ error: 'Daily news scrub not found' });
      }
      if (!scrub.htmlContent) {
        return res.status(404).json({ error: 'No formatted content available for this scrub' });
      }
      res.json({ htmlContent: scrub.htmlContent });
    } catch (error) {
      console.error('Error fetching scrub HTML (curated):', error);
      res.status(500).json({ error: 'Failed to fetch scrub HTML' });
    }
  });

  app.get("/api/curated/news-scrub/:id/download", requireCuratedView, async (req: any, res) => {
    try {
      const [scrub] = await db.select().from(dailyNewsScrubs).where(eq(dailyNewsScrubs.id, req.params.id));
      if (!scrub) {
        return res.status(404).json({ error: 'Daily news scrub not found' });
      }
      const objectStorageService = new ObjectStorageService();
      const objectFile = await objectStorageService.getObjectEntityFile(scrub.storagePath);
      res.setHeader('Content-Type', 'application/pdf');
      const disposition = req.query.inline === 'true' ? 'inline' : 'attachment';
      res.setHeader('Content-Disposition', `${disposition}; filename="${scrub.filename}"`);
      objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      console.error('Error downloading daily news scrub (curated):', error);
      res.status(500).json({ error: 'Failed to download daily news scrub' });
    }
  });

  // Curated-only: parse the structured "IE HIGHLIGHTS" section out of the latest
  // uploaded news-scrub PDF and return it as JSON for the Curated view's IE
  // Highlights panel. Parsed results are cached in-memory per scrub id so we only
  // download + pdf-parse each PDF once. This endpoint reads the same
  // daily_news_scrubs records the team page uploads but never mutates them.
  app.get("/api/curated/news-scrub/ie-highlights", requireCuratedView, async (_req: any, res) => {
    try {
      const [latest] = await db.select().from(dailyNewsScrubs).orderBy(desc(dailyNewsScrubs.createdAt)).limit(1);
      if (!latest) {
        return res.status(404).json({ error: 'No daily news scrub found' });
      }

      const cached = curatedIeHighlightsCache.get(latest.id);
      if (cached) {
        return res.json(cached);
      }

      const objectStorageService = new ObjectStorageService();
      const objectFile = await objectStorageService.getObjectEntityFile(latest.storagePath);
      const [pdfBuffer] = await objectFile.download();

      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
      const parsed = await parser.getText();
      const groups = parseNewsScrubHighlights(parsed.text);

      const payload = {
        id: latest.id,
        caoDate: latest.caoDate,
        filename: latest.filename,
        groups,
      };
      curatedIeHighlightsCache.set(latest.id, payload);
      res.json(payload);
    } catch (error) {
      console.error('Error parsing IE highlights from news scrub (curated):', error);
      res.status(500).json({ error: 'Failed to parse IE highlights' });
    }
  });

  // Public search endpoint - searches team submissions without authentication
  // This allows the front page search to find team submissions even for non-team users
  app.get("/api/public-search", headlineFeedGuard, async (req, res) => {
    try {
      const query = (req.query.q as string || '').trim();
      if (!query || query.length < 2) {
        return res.json({ submissions: [] });
      }

      const results = await storage.unifiedNewsSearch(query, 200);

      const submissions = results.map(r => ({
        id: r.id,
        headline: r.title,
        summary: r.summary,
        sourceUrl: r.url,
        sourceName: r.source,
        sourceTable: r.sourceTable,
        topicName: r.sourceTable === 'team_submission' ? 'Team Submission' :
                   r.sourceTable === 'mcop_feed' ? 'MCOP Feed' :
                   r.sourceTable === 'headline' ? 'Headline' : 'RSS Bot',
        priorityScore: r.priorityScore,
        createdAt: r.date,
        publishedAt: r.date,
      }));

      res.json({ submissions });
    } catch (error) {
      console.error('Error in public search:', error);
      res.status(500).json({ error: 'Failed to search submissions' });
    }
  });

  // Headline clustering API endpoints
  // Get all clusters with their members
  app.get("/api/clusters", requireAdminOrTeamUser, async (req, res) => {
    try {
      const clusters = await getAllClustersWithMembers();
      res.json(clusters);
    } catch (error) {
      console.error('Error fetching clusters:', error);
      res.status(500).json({ error: 'Failed to fetch clusters' });
    }
  });

  app.get("/api/clusters/enabled", async (req, res) => {
    res.json({ enabled: isClusteringEnabled() });
  });

  app.post("/api/clusters/toggle", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { enabled } = req.body;
      const newState = enabled === true;
      setClusteringEnabled(newState);
      // Persist alongside the in-memory update so the toggle survives restarts
      // (awaited, mirroring the Watch Topic steering toggle, so a persist
      // failure surfaces as a 500 instead of silently not surviving a restart).
      await persistClusteringEnabled(newState);

      if (!newState) {
        await clusterTopStories(true);
        console.log('[Clustering] Disabled — all clusters cleared');
      } else {
        await clusterTopStories(false);
        console.log('[Clustering] Enabled — clustering run');
      }

      // Toggling clustering rewrites headlines/manual_submissions cluster fields,
      // which getPrimaryFeed uses to shape Classic + Stream → drop their caches.
      invalidateMainFeeds();
      const clusters = await getAllClustersWithMembers();
      res.json({ enabled: newState, clusters });
    } catch (error) {
      console.error('Error toggling clustering:', error);
      res.status(500).json({ error: 'Failed to toggle clustering' });
    }
  });

  app.get("/api/topic-clusters/enabled", async (req, res) => {
    res.json({ enabled: isTopicClusteringEnabled() });
  });

  app.post("/api/topic-clusters/toggle", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { enabled } = req.body;
      const newState = enabled === true;
      setTopicClusteringEnabled(newState);
      // Persist alongside the in-memory update so the toggle survives restarts
      // (awaited so a persist failure surfaces instead of silently not sticking).
      await persistTopicClusteringEnabled(newState);

      if (!newState) {
        await clearAllTeamClusters();
        console.log('[TopicClustering] Disabled — all topic clusters cleared');
      } else {
        await clusterAllActiveTopics();
        console.log('[TopicClustering] Enabled — clustering run');
      }

      res.json({ enabled: newState });
    } catch (error) {
      console.error('Error toggling topic clustering:', error);
      res.status(500).json({ error: 'Failed to toggle topic clustering' });
    }
  });

  app.get("/api/joe-priority-matching/enabled", async (req, res) => {
    res.json({ enabled: isJoePriorityMatchingEnabled() });
  });

  app.post("/api/joe-priority-matching/toggle", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { enabled } = req.body;
      const newState = enabled === true;
      setJoePriorityMatchingEnabled(newState);
      // Persist alongside the in-memory update so the toggle survives restarts
      // (awaited so a persist failure surfaces instead of silently not sticking).
      await persistJoePriorityMatchingEnabled(newState);
      res.json({ enabled: newState });
    } catch (error) {
      console.error('Error toggling Joe Priority/BOLO matching:', error);
      res.status(500).json({ error: 'Failed to toggle Joe Priority/BOLO matching' });
    }
  });

  app.get("/api/watch-topic-steering/enabled", async (req, res) => {
    res.json({ enabled: isWatchTopicSteeringEnabled() });
  });

  app.post("/api/watch-topic-steering/toggle", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { enabled } = req.body;
      const newState = enabled === true;
      setWatchTopicSteeringEnabled(newState);
      await persistWatchTopicSteering(newState);
      res.json({ enabled: newState });
    } catch (error) {
      console.error('Error toggling watch-topic steering:', error);
      res.status(500).json({ error: 'Failed to toggle watch-topic steering' });
    }
  });

  app.get("/api/bot-control/status", requireTeamOrUserAuth, async (req: any, res) => {
    const { BOT_DEFINITIONS, getBotStates } = await import('./scraperConfig');
    const states = getBotStates();
    const bots = BOT_DEFINITIONS.map(bot => ({
      ...bot,
      enabled: states[bot.id] ?? true,
    }));
    res.json({ bots });
  });

  app.post("/api/bot-control/toggle", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { botId, enabled } = req.body;
      if (typeof botId !== 'string' || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'botId (string) and enabled (boolean) are required' });
      }

      {
        const { setBotEnabled, persistBotStates, BOT_DEFINITIONS } = await import('./scraperConfig');
        const validBot = BOT_DEFINITIONS.find(b => b.id === botId);
        if (!validBot) {
          return res.status(400).json({ error: `Unknown bot: ${botId}` });
        }
        setBotEnabled(botId, enabled);
        // Persist alongside the in-memory update so the toggle survives restarts.
        await persistBotStates();
      }

      res.json({ success: true, botId, enabled });
    } catch (error) {
      console.error('Error toggling bot:', error);
      res.status(500).json({ error: 'Failed to toggle bot' });
    }
  });

  // Same-event duplicate reconciliation (curated Top Stories one-merge-per-pass
  // backstop, Task #1085). Dark-launched, runtime-toggleable without a redeploy.
  app.get("/api/curated/missed-merge-reconcile/enabled", requireTeamOrUserAuth, async (req, res) => {
    const { isCuratedMissedMergeReconcileEnabled } = await import('./clusterConfig');
    res.json({ enabled: isCuratedMissedMergeReconcileEnabled() });
  });

  app.post("/api/curated/missed-merge-reconcile/toggle", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled (boolean) is required' });
      }
      const newState = enabled;
      const { setCuratedMissedMergeReconcileEnabled, persistCuratedMissedMergeReconcileEnabled } = await import('./clusterConfig');
      setCuratedMissedMergeReconcileEnabled(newState);
      // Persist alongside the in-memory update so the toggle survives restarts
      // (awaited so a persist failure surfaces instead of silently not sticking).
      await persistCuratedMissedMergeReconcileEnabled(newState);
      res.json({ enabled: newState });
    } catch (error) {
      console.error('Error toggling curated missed-merge reconciliation:', error);
      res.status(500).json({ error: 'Failed to toggle curated missed-merge reconciliation' });
    }
  });

  app.post("/api/bot-control/trigger", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { botId } = req.body;
      if (typeof botId !== 'string') {
        return res.status(400).json({ error: 'botId (string) is required' });
      }
      const results: Record<string, any> = {};
      const botsToRun = botId === 'all' 
        ? ['rss', 'bbc', 'foxnews']
        : [botId];
      
      for (const bot of botsToRun) {
        try {
          switch (bot) {
            case 'rss': {
              const { runRSSFeedBot } = await import('./rssFeedBot');
              results[bot] = await runRSSFeedBot();
              break;
            }
            case 'bbc': {
              const { runBBCBot } = await import('./bbcBot');
              results[bot] = await runBBCBot();
              break;
            }
            case 'foxnews': {
              const { runFoxNewsBot } = await import('./foxNewsBot');
              results[bot] = await runFoxNewsBot();
              break;
            }
            case 'drudge': {
              const { runDrudgeBot } = await import('./drudgeBot');
              results[bot] = await runDrudgeBot();
              break;
            }
            case 'abc': {
              const { runABCNewsBot } = await import('./abcNewsBot');
              results[bot] = await runABCNewsBot();
              break;
            }
            default:
              results[bot] = { error: 'Unknown bot' };
          }
        } catch (botError) {
          results[bot] = { error: String(botError) };
        }
      }
      res.json({ success: true, results });
    } catch (error) {
      console.error('Error triggering bot:', error);
      res.status(500).json({ error: 'Failed to trigger bot' });
    }
  });

  // Trigger clustering (manual or called from admin)
  // Incremental mode by default: preserves existing clusters and adds new stories
  app.post("/api/clusters/run", requireAdminOrTeamUser, async (req, res) => {
    try {
      const resetExisting = req.body?.resetExisting === true;
      await clusterTopStories(resetExisting);
      // Manual clustering run reshapes Classic + Stream (which item represents a story)
      invalidateMainFeeds();
      const clusters = await getAllClustersWithMembers();
      res.json({ success: true, clusters });
    } catch (error) {
      console.error('Error running clustering:', error);
      res.status(500).json({ error: 'Failed to run clustering' });
    }
  });

  // Set cluster representative
  app.post("/api/clusters/:clusterId/representative", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { clusterId } = req.params;
      const { itemId, itemType } = req.body;
      
      if (!itemId || !itemType) {
        return res.status(400).json({ error: 'Missing itemId or itemType' });
      }
      
      await setClusterRepresentative(clusterId, itemId, itemType);
      // Changing a cluster's representative changes which row Classic + Stream show
      invalidateMainFeeds();
      res.json({ success: true });
    } catch (error) {
      console.error('Error setting representative:', error);
      res.status(500).json({ error: 'Failed to set representative' });
    }
  });

  // Unlink item from cluster
  app.post("/api/clusters/unlink", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { itemId, itemType } = req.body;
      
      if (!itemId || !itemType) {
        return res.status(400).json({ error: 'Missing itemId or itemType' });
      }
      
      await unlinkFromCluster(itemId, itemType);
      // Unlinking surfaces a previously-hidden item → reshapes Classic + Stream
      invalidateMainFeeds();
      res.json({ success: true });
    } catch (error) {
      console.error('Error unlinking from cluster:', error);
      res.status(500).json({ error: 'Failed to unlink from cluster' });
    }
  });

  // Merge clusters
  app.post("/api/clusters/merge", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { sourceClusterId, targetClusterId } = req.body;
      
      if (!sourceClusterId || !targetClusterId) {
        return res.status(400).json({ error: 'Missing source or target cluster ID' });
      }
      
      await mergeClusters(sourceClusterId, targetClusterId);
      // Merging clusters changes representatives/membership → reshapes Classic + Stream
      invalidateMainFeeds();
      res.json({ success: true });
    } catch (error) {
      console.error('Error merging clusters:', error);
      res.status(500).json({ error: 'Failed to merge clusters' });
    }
  });

  // Create a new user-defined cluster
  app.post("/api/clusters/create", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { name, itemId, itemType } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: 'Cluster name is required' });
      }
      
      const [newCluster] = await db
        .insert(headlineClusters)
        .values({ name, isUserCreated: true })
        .returning();
      
      if (itemId && itemType) {
        if (itemType === 'headline') {
          await db.update(headlines).set({ 
            clusterId: newCluster.id, 
            isClusterRepresentative: true 
          }).where(eq(headlines.id, itemId));
        } else if (itemType === 'manual') {
          await db.update(manualSubmissions).set({ 
            clusterId: newCluster.id, 
            isClusterRepresentative: true 
          }).where(eq(manualSubmissions.id, itemId));
        }
        // The assigned item becomes a representative → reshapes Classic + Stream
        invalidateMainFeeds();
      }
      
      res.json({ success: true, cluster: newCluster });
    } catch (error) {
      console.error('Error creating cluster:', error);
      res.status(500).json({ error: 'Failed to create cluster' });
    }
  });

  // Assign headline to existing cluster
  app.post("/api/clusters/assign", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { clusterId, itemId, itemType } = req.body;
      
      if (!clusterId || !itemId || !itemType) {
        return res.status(400).json({ error: 'Missing clusterId, itemId, or itemType' });
      }
      
      if (itemType === 'headline') {
        await db.update(headlines).set({ 
          clusterId, 
          isClusterRepresentative: false 
        }).where(eq(headlines.id, itemId));
      } else if (itemType === 'manual') {
        await db.update(manualSubmissions).set({ 
          clusterId, 
          isClusterRepresentative: false 
        }).where(eq(manualSubmissions.id, itemId));
      }
      
      // Assigning hides a non-representative item from Classic + Stream → drop caches
      invalidateMainFeeds();
      res.json({ success: true });
    } catch (error) {
      console.error('Error assigning to cluster:', error);
      res.status(500).json({ error: 'Failed to assign to cluster' });
    }
  });

  // Team submission clustering API endpoints
  // Trigger clustering for submissions within a topic
  app.post("/api/team-submissions/clusters/run/:subjectId", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { subjectId } = req.params;
      await clusterSubmissionsForTopic(subjectId);
      const clusteredSubmissions = await getClusteredSubmissionsForTopic(subjectId);
      res.json({ success: true, clusteredSubmissions });
    } catch (error) {
      console.error('Error running team submission clustering:', error);
      res.status(500).json({ error: 'Failed to cluster submissions' });
    }
  });

  // Get clustered submissions for a topic
  app.get("/api/team-submissions/clusters/:subjectId", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { subjectId } = req.params;
      const clusteredSubmissions = await getClusteredSubmissionsForTopic(subjectId);
      res.json(clusteredSubmissions);
    } catch (error) {
      console.error('Error fetching clustered submissions:', error);
      res.status(500).json({ error: 'Failed to fetch clustered submissions' });
    }
  });

  // Get all team clusters (for dropdown menu)
  app.get("/api/team-submissions/clusters-all", requireAdminOrTeamUser, async (req, res) => {
    try {
      const clusters = await getAllTeamClusters();
      res.json(clusters);
    } catch (error) {
      console.error('Error fetching all team clusters:', error);
      res.status(500).json({ error: 'Failed to fetch clusters' });
    }
  });

  // Assign submission to existing cluster
  app.post("/api/team-submissions/clusters/assign", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { submissionId, clusterId } = req.body;
      if (!submissionId || !clusterId) {
        return res.status(400).json({ error: 'submissionId and clusterId are required' });
      }
      await assignSubmissionToCluster(submissionId, clusterId);
      res.json({ success: true });
    } catch (error) {
      console.error('Error assigning submission to cluster:', error);
      res.status(500).json({ error: 'Failed to assign to cluster' });
    }
  });

  // Create new cluster with submission
  app.post("/api/team-submissions/clusters/create", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { submissionId, clusterName, subjectId } = req.body;
      if (!submissionId || !clusterName || !subjectId) {
        return res.status(400).json({ error: 'submissionId, clusterName, and subjectId are required' });
      }
      const clusterId = await createClusterWithSubmission(submissionId, clusterName, subjectId);
      res.json({ success: true, clusterId });
    } catch (error) {
      console.error('Error creating cluster:', error);
      res.status(500).json({ error: 'Failed to create cluster' });
    }
  });

  // Unlink submission from cluster
  app.post("/api/team-submissions/clusters/unlink", requireAdminOrTeamUser, async (req, res) => {
    try {
      const { submissionId } = req.body;
      if (!submissionId) {
        return res.status(400).json({ error: 'submissionId is required' });
      }
      await unlinkSubmissionFromCluster(submissionId);
      res.json({ success: true });
    } catch (error) {
      console.error('Error unlinking from cluster:', error);
      res.status(500).json({ error: 'Failed to unlink from cluster' });
    }
  });

  // Register public API (has its own API key auth)
  registerPublicApi(app);

  // Protect all API routes except auth, admin, and team routes
  // Allow both regular users and admins to access general API routes
  const generalApiGuard = createAuthGuard({ allowUser: true, allowAdmin: true });

  // Read-only feed endpoints used by the Warfighter Dashboard (/war) and
  // Custom MCOP dashboards. These must be reachable from any session that
  // unlocked the Warfighter password gate or a Custom MCOP password gate,
  // not just team/admin sessions — otherwise the columns get stuck on
  // stale cached data while the API silently 401s.
  const WAR_FEED_PATHS = new Set([
    "/x-posts",
    "/influencer-x-posts",
    "/truth-social-posts",
    "/rapidresponse-posts",
    "/dowresponse-posts",
    "/sentdefender-posts",
    "/osint-posts",
  ]);

  app.use("/api", (req, res, next) => {
    // Skip auth check for auth, admin, team, stream, diagnostics, war, webhook,
    // and public-objects (public logo/image serving) routes
    if (req.path.startsWith("/v1/") || req.path.startsWith("/auth/") || req.path.startsWith("/admin/") || req.path.startsWith("/team/") || req.path.startsWith("/diagnostics/") || req.path.startsWith("/war/") || req.path.startsWith("/webhooks/") || req.path.startsWith("/sms-queue/") || req.path.startsWith("/sms-subscribers") || req.path.startsWith("/sms-alerts/") || req.path.startsWith("/public-objects/")) {
      return next();
    }
    // Custom MCOP routes have their own auth (requireCustomMcopAccess /
    // requireMcopAdmin) which understands the Warfighter public password
    // gate. Skip the global guard so anonymous-but-gate-unlocked sessions
    // can reach them.
    if (req.path.startsWith("/custom-mcops/") || req.path === "/custom-mcops") {
      return next();
    }
    if (req.path.startsWith("/stream/") || req.path.match(/^\/headlines\/[^/]+\/stream-media$/)) {
      return requireTeamOrUserAuth(req, res, next);
    }
    // Warfighter / Custom MCOP feed reads use the broader auth check so a
    // password-gate-only session can read them.
    if (req.method === "GET" && WAR_FEED_PATHS.has(req.path)) {
      return requireTeamOrUserAuth(req, res, next);
    }
    generalApiGuard(req, res, next);
  });

  // Protected routes - all API routes below require authentication
  // Get all headlines
  app.get("/api/headlines", async (req, res) => {
    try {
      const headlines = await storage.getAllHeadlines();
      res.json(headlines);
    } catch (error) {
      console.error('Error fetching headlines:', error);
      res.status(500).json({ error: 'Failed to fetch headlines' });
    }
  });

  // Get recent headlines (within specified hours)
  app.get("/api/headlines/recent/:hours", async (req, res) => {
    try {
      const hours = parseInt(req.params.hours);
      if (isNaN(hours) || hours < 1) {
        return res.status(400).json({ error: 'Invalid hours parameter' });
      }
      const headlines = await storage.getRecentHeadlines(hours);
      res.json(headlines);
    } catch (error) {
      console.error('Error fetching recent headlines:', error);
      res.status(500).json({ error: 'Failed to fetch recent headlines' });
    }
  });

  // Get recent Truth Social posts
  app.get("/api/truth-social-posts", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const posts = await storage.getRecentTruthSocialPosts(limit);
      res.json(posts);
    } catch (error) {
      console.error('Error fetching Truth Social posts:', error);
      res.status(500).json({ error: 'Failed to fetch Truth Social posts' });
    }
  });

  // Trigger manual scrape of Truth Social
  app.post("/api/scrape-truth-social", async (req, res) => {
    try {
      console.log('Manual Truth Social scrape triggered');
      const addedCount = await scrapeAllTruthSocial(storage);
      const allPosts = await storage.getRecentTruthSocialPosts(50);
      
      console.log(`Truth Social scrape complete: ${addedCount} new posts. Total: ${allPosts.length}`);
      
      res.json({ 
        success: true, 
        newCount: addedCount,
        total: allPosts.length
      });
    } catch (error) {
      console.error('Error during Truth Social scrape:', error);
      res.status(500).json({ error: 'Failed to scrape Truth Social posts' });
    }
  });

  app.get("/api/truth-social-posts/all", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const posts = await storage.getRecentTruthSocialPosts(limit, true);
      res.json(posts);
    } catch (error) {
      console.error('Error fetching all Truth Social posts:', error);
      res.status(500).json({ error: 'Failed to fetch Truth Social posts' });
    }
  });

  app.patch("/api/truth-social-posts/:id/hide", async (req, res) => {
    try {
      const { id } = req.params;
      const { hidden } = req.body;
      await storage.hideTruthSocialPost(id, hidden !== false);
      invalidateFeedCache('stream');
      res.json({ success: true });
    } catch (error) {
      console.error('Error hiding Truth Social post:', error);
      res.status(500).json({ error: 'Failed to hide post' });
    }
  });

  app.patch("/api/truth-social-posts/:id/remove-image", async (req, res) => {
    try {
      const { id } = req.params;
      await storage.updateTruthSocialPostImage(id, null);
      invalidateFeedCache('stream');
      res.json({ success: true });
    } catch (error) {
      console.error('Error removing image from Truth Social post:', error);
      res.status(500).json({ error: 'Failed to remove image' });
    }
  });

  app.post("/api/truth-social-posts/manual", async (req, res) => {
    try {
      const { content, postedAt, imageUrl, linkUrl } = req.body;
      if (!content || typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'Content is required' });
      }
      if (!postedAt) {
        return res.status(400).json({ error: 'Post time is required' });
      }
      // Treat the input as Eastern time — datetime-local gives "YYYY-MM-DDTHH:MM" with no timezone
      // Append Eastern offset so Date parses it correctly
      let parsedDate: Date;
      const rawDateStr = String(postedAt);
      const tIdx = rawDateStr.indexOf('T');
      const hasTimezoneInfo = rawDateStr.includes('Z') || rawDateStr.includes('+') || (tIdx >= 0 && rawDateStr.indexOf('-', tIdx + 1) >= 0);
      if (!hasTimezoneInfo) {
        // No timezone info — interpret as Eastern
        // Use Intl to figure out current Eastern offset (handles EST/EDT automatically)
        const now = new Date();
        const easternOffset = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          timeZoneName: 'shortOffset',
        }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value || 'GMT-5';
        const offsetMatch = easternOffset.match(/GMT([+-]\d+)/);
        const offsetHours = offsetMatch ? parseInt(offsetMatch[1]) : -5;
        const sign = offsetHours >= 0 ? '+' : '-';
        const absHours = Math.abs(offsetHours).toString().padStart(2, '0');
        parsedDate = new Date(`${rawDateStr}:00${sign}${absHours}:00`);
      } else {
        parsedDate = new Date(postedAt);
      }
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date format' });
      }
      const postId = `manual_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const defaultUrl = `https://truthsocial.com/@realDonaldTrump/posts/${postId}`;
      const post = await storage.addTruthSocialPost({
        postId,
        content: content.trim(),
        postedAt: parsedDate,
        truthSocialUrl: (linkUrl && typeof linkUrl === 'string' && linkUrl.trim()) ? linkUrl.trim() : defaultUrl,
        imageUrl: imageUrl || null,
        isReblog: false,
        rebloggedFrom: null,
        isManual: true,
        isHidden: false,
        videoUrl: null,
        videoThumbnailUrl: null,
        extractedImageText: null,
      });
      invalidateFeedCache('stream');
      res.json(post);
    } catch (error) {
      console.error('Error adding manual Truth Social post:', error);
      res.status(500).json({ error: 'Failed to add manual post' });
    }
  });

  // Get recent X posts (default category — excludes influencers)
  app.get("/api/x-posts", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const posts = await storage.getRecentXPosts(limit);
      res.json(posts);
    } catch (error) {
      console.error('Error fetching X posts:', error);
      res.status(500).json({ error: 'Failed to fetch X posts' });
    }
  });

  // Get recent Influencer X posts (separate category)
  app.get("/api/influencer-x-posts", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 30;
      const posts = await storage.getRecentInfluencerXPosts(limit);
      res.json(posts);
    } catch (error) {
      console.error('Error fetching influencer X posts:', error);
      res.status(500).json({ error: 'Failed to fetch influencer X posts' });
    }
  });

  // Trigger manual scrape of X/Twitter
  app.post("/api/scrape-x", async (req, res) => {
    try {
      // Check if scheduled scrape is in progress to avoid rate limiting
      const status = getScraperStatus();
      if (status.isRunning) {
        console.log('Manual X scrape skipped - scheduled scrape in progress');
        const allPosts = await storage.getRecentXPosts(50);
        return res.json({ 
          success: true, 
          skipped: true,
          message: 'Scrape skipped - scheduled scrape in progress',
          total: allPosts.length
        });
      }
      
      console.log('Manual X scrape triggered');
      const addedCount = await updateXPosts(storage);
      const allPosts = await storage.getRecentXPosts(50);
      
      console.log(`X scrape complete: ${addedCount} new posts. Total: ${allPosts.length}`);
      
      res.json({ 
        success: true, 
        newCount: addedCount,
        total: allPosts.length
      });
    } catch (error) {
      console.error('Error during X scrape:', error);
      res.status(500).json({ error: 'Failed to scrape X posts' });
    }
  });

  // Get recent RapidResponse posts
  app.get("/api/rapidresponse-posts", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const posts = await storage.getRecentRapidResponsePosts(limit);
      res.json(posts);
    } catch (error) {
      console.error('Error fetching RapidResponse posts:', error);
      res.status(500).json({ error: 'Failed to fetch RapidResponse posts' });
    }
  });

  // Trigger manual scrape of RapidResponse
  app.post("/api/scrape-rapidresponse", async (req, res) => {
    try {
      // Check if scheduled scrape is in progress to avoid rate limiting
      const status = getScraperStatus();
      if (status.isRunning) {
        console.log('Manual RapidResponse scrape skipped - scheduled scrape in progress');
        const allPosts = await storage.getRecentRapidResponsePosts(50);
        return res.json({ 
          success: true, 
          skipped: true,
          message: 'Scrape skipped - scheduled scrape in progress',
          total: allPosts.length
        });
      }
      
      console.log('Manual RapidResponse scrape triggered');
      const addedCount = await updateRapidResponsePosts(storage);
      const allPosts = await storage.getRecentRapidResponsePosts(50);
      
      console.log(`RapidResponse scrape complete: ${addedCount} new posts. Total: ${allPosts.length}`);
      
      res.json({ 
        success: true, 
        newCount: addedCount,
        total: allPosts.length
      });
    } catch (error) {
      console.error('Error during RapidResponse scrape:', error);
      res.status(500).json({ error: 'Failed to scrape RapidResponse posts' });
    }
  });

  // Get recent SentDefender posts
  app.get("/api/sentdefender-posts", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const posts = await storage.getRecentSentDefenderPosts(limit);
      res.json(posts);
    } catch (error) {
      console.error('Error fetching SentDefender posts:', error);
      res.status(500).json({ error: 'Failed to fetch SentDefender posts' });
    }
  });

  // Get recent OSINT posts (MATA_osint, Civmilair)
  app.get("/api/osint-posts", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 30;
      const account = req.query.account as string | undefined;
      const posts = await storage.getRecentOsintPosts(limit, account);
      res.json(posts);
    } catch (error) {
      console.error('Error fetching OSINT posts:', error);
      res.status(500).json({ error: 'Failed to fetch OSINT posts' });
    }
  });

  app.get("/api/x-feed/all", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 200;
      const posts = await storage.getAllXFeedPosts(limit);
      res.json(posts);
    } catch (error) {
      console.error('Error fetching all X feed posts:', error);
      res.status(500).json({ error: 'Failed to fetch X feed posts' });
    }
  });

  app.patch("/api/x-feed/:source/:id/hide", async (req, res) => {
    try {
      const { source, id } = req.params;
      const { hidden } = req.body;
      if (typeof hidden !== 'boolean') {
        return res.status(400).json({ error: 'hidden must be a boolean' });
      }
      await storage.hideXFeedPost(source, id, hidden);
      invalidateFeedCache('stream');
      res.json({ success: true });
    } catch (error: any) {
      console.error('Error hiding X feed post:', error);
      res.status(500).json({ error: error.message || 'Failed to hide post' });
    }
  });

  // Get recent DOWResponse posts
  app.get("/api/dowresponse-posts", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const posts = await storage.getRecentDOWResponsePosts(limit);
      res.json(posts);
    } catch (error) {
      console.error('Error fetching DOWResponse posts:', error);
      res.status(500).json({ error: 'Failed to fetch DOWResponse posts' });
    }
  });

  // Trigger manual scrape of DOWResponse
  app.post("/api/scrape-dowresponse", async (req, res) => {
    try {
      // Check if scheduled scrape is in progress to avoid rate limiting
      const status = getScraperStatus();
      if (status.isRunning) {
        console.log('Manual DOWResponse scrape skipped - scheduled scrape in progress');
        const allPosts = await storage.getRecentDOWResponsePosts(50);
        return res.json({ 
          success: true, 
          skipped: true,
          message: 'Scrape skipped - scheduled scrape in progress',
          total: allPosts.length
        });
      }
      
      console.log('Manual DOWResponse scrape triggered');
      const addedCount = await updateDOWResponsePosts(storage);
      const allPosts = await storage.getRecentDOWResponsePosts(50);
      
      console.log(`DOWResponse scrape complete: ${addedCount} new posts. Total: ${allPosts.length}`);
      
      res.json({ 
        success: true, 
        newCount: addedCount,
        total: allPosts.length
      });
    } catch (error) {
      console.error('Error during DOWResponse scrape:', error);
      res.status(500).json({ error: 'Failed to scrape DOWResponse posts' });
    }
  });

  // Get recent First Alert notifications
  app.get("/api/first-alerts", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const alerts = await storage.getRecentFirstAlerts(limit);
      res.json(alerts);
    } catch (error) {
      console.error('Error fetching First Alerts:', error);
      res.status(500).json({ error: 'Failed to fetch First Alerts' });
    }
  });

  // Compute for /api/stream, extracted from the route handler so BOTH the
  // route (via serveCoalescedFeed) and the main-feed keep-warm loop (Task
  // #1023, wired below the route) share the exact same builder.
  const buildStreamPayload = async () => {
      // Fetch all required data in parallel
      const [headlines, truthSocialPosts, streamSecWarPosts, streamRapidResponsePosts, streamDowResponsePosts, firstAlerts] = await Promise.all([
        storage.getPrimaryFeed(18, 20), // Get top 20 headlines from last 18 hours
        storage.getRecentTruthSocialPosts(10),
        storage.getRecentXPosts(20), // SecWar posts (includes PeteHegseth retweets)
        storage.getRecentRapidResponsePosts(20), // Rapidresponse47 posts
        storage.getRecentDOWResponsePosts(20), // DOWResponse posts
        storage.getRecentFirstAlerts(15),
      ]);
      
      // Combine all X feed posts into a unified format
      const xPosts = [
        ...streamSecWarPosts.map(p => ({
          ...p,
          sourceAccount: p.sourceAccount || 'SecWar',
          isRetweet: p.isRetweet || false,
          retweetedFrom: p.retweetedFrom || null,
        })),
        ...streamRapidResponsePosts.map(p => ({
          id: p.id,
          postId: p.postId,
          content: p.content,
          postedAt: p.postedAt,
          xUrl: p.xUrl,
          sourceAccount: 'Rapidresponse47',
          isRetweet: false,
          retweetedFrom: null as string | null,
          scrapedAt: p.scrapedAt,
          imageUrl: null as string | null,
        })),
        ...streamDowResponsePosts.map(p => ({
          id: p.id,
          postId: p.postId,
          content: p.content,
          postedAt: p.postedAt,
          xUrl: p.xUrl,
          sourceAccount: 'DOWResponse',
          isRetweet: false,
          retweetedFrom: null as string | null,
          scrapedAt: p.scrapedAt,
          imageUrl: null as string | null,
        })),
      ].sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());
      
      const allSortedHeadlines = headlines
        .sort((a, b) => {
          if (b.depreciatedPriority !== a.depreciatedPriority) {
            return b.depreciatedPriority - a.depreciatedPriority;
          }
          const dateA = new Date(a.articlePublishedAt || a.scrapedAt).getTime();
          const dateB = new Date(b.articlePublishedAt || b.scrapedAt).getTime();
          return dateB - dateA;
        });
      const sortedHeadlines = allSortedHeadlines.slice(0, 8);
      const nextUpHeadlines = allSortedHeadlines.slice(8, 11);
      
      // Serve cached media data from background pre-fetch (no on-demand scraping)
      const enhancedStories = sortedHeadlines.map((headline) => {
        // Strip curated-lane / internal-only fields (attributedClaims,
        // contentKind, fullText) before the spread so they never surface in
        // the public Visual feed response (Task #706/#780).
        const headlineFields = stripInternalArticleFields(headline as any);
        const imageUrl = headlineFields.videoUrl
          ? `VIDEO:${headlineFields.videoUrl}`
          : headlineFields.ogImageUrl;
        return {
          ...headlineFields,
          imageUrl,
          summaryBullets: headlineFields.summaryBullets || [],
        };
      });
      
      // Filter SecWar posts only
      const secWarPosts = xPosts.filter(p => p.sourceAccount === 'SecWar');
      
      // Use database imageUrl for Truth Social posts (already scraped by backup scraper).
      // Do NOT fall back to og:image scraping — Truth Social's og:image for a
      // text-only post is the author's profile picture, which would render as a
      // fake "attached photo" (the flag-face avatar) on text-only posts.
      const enhancedTruthSocialPosts = truthSocialPosts;
      
      // Serve the stored/prefetched og:image for each SecWar X post — NO inline
      // x.com fetch in the request path (Task #680). Previously this fanned out
      // one fetch() per SecWar post to x.com (5s timeout each) on every cache
      // miss and blocked the response on all of them, so when x.com was slow,
      // rate-limiting, or serving a login wall the whole Visual feed stalled or
      // 500'd for every viewer. The image is now resolved and persisted by the
      // background media prefetch (prefetchXPostMedia), which also applies the
      // text-only-post avatar guard so a text-only post never stores a profile
      // picture as a fake "attached photo".
      const enhancedXPosts = secWarPosts.map((post) => ({
        ...post,
        imageUrl: post.imageUrl ?? null,
      }));
      
      const nextUpStories = nextUpHeadlines.map(h => ({
        id: h.id,
        title: h.title,
        url: h.url,
        source: h.source,
        priorityScore: h.priorityScore,
        priorityOverride: h.priorityOverride,
        depreciatedPriority: h.depreciatedPriority,
        type: h.type,
      }));

      const payload = {
        topStories: enhancedStories,
        nextUpStories,
        truthSocialPosts: enhancedTruthSocialPosts,
        xPosts: enhancedXPosts,
        firstAlerts,
      };
      return payload;
  };

  // Stream page endpoint - returns top stories with images and AI summaries
  app.get("/api/stream", headlineFeedGuard, async (req, res) => {
    try {
      // Serve the fully-computed payload from the short TTL cache when warm
      // (route guard above already ran). Identical for all authed users.
      // Honors x-mcop-no-cache (isolation harness). Concurrent cold-cache
      // callers are coalesced onto ONE compute (Task #680).
      await serveCoalescedFeed(req, res, 'stream', buildStreamPayload);
    } catch (error) {
      console.error('Error fetching stream data:', error);
      res.status(500).json({ error: 'Failed to fetch stream data' });
    }
  });

  // ---------------------------------------------------------------------------
  // Main-feed keep-warm loop (Task #1023). The always-on Dashboard displays
  // poll /api/headline-feed (hours=18 and hours=48) and /api/stream on a
  // 2-minute invalidate-all cycle from multiple unsynchronized computers, so
  // with a 25s TTL nearly every poll was a COLD miss (1–4.7s in prod). This
  // loop proactively recomputes the three hot keys so those polls land on a
  // warm, pre-serialized cache (~150ms) instead.
  //
  // Bounds (deliberate):
  //   - ACTIVITY-GATED: a key is kept warm only if some client actually read
  //     it within the last 10 minutes (lastFeedReadAt) — idle overnight means
  //     the loop idles too. Boot warm passes force=true since no reads exist
  //     yet right after a deploy.
  //   - MIN-AGE: prewarmFeed skips entries fresher than 15s, so the 20s tick
  //     recomputes each key at most ~3x/min — same worst-case compute rate the
  //     25s TTL already allowed, just moved off the request path.
  //   - TTL/bypass semantics UNCHANGED: entries still expire at the same 25s
  //     TTL and x-mcop-no-cache still forces a fresh uncoalesced compute, so
  //     data staleness bounds and the isolation harness are untouched.
  //   - Curated lane untouched: its own 60s/75s/90s prewarm timers already
  //     cover top-stories/state-narratives (CURATED-LANE ONLY, separate cache).
  const HOT_MAIN_FEED_KEYS: Array<{ key: string; compute: () => Promise<any> }> = [
    { key: 'headline-feed:18:all', compute: () => buildHeadlineFeedPayload(18, undefined) },
    { key: 'headline-feed:48:all', compute: () => buildHeadlineFeedPayload(48, undefined) },
    { key: 'stream', compute: buildStreamPayload },
  ];
  const KEEP_WARM_ACTIVE_WINDOW_MS = 10 * 60_000;
  const keepMainFeedsWarm = async (force = false): Promise<void> => {
    for (const { key, compute } of HOT_MAIN_FEED_KEYS) {
      if (!force) {
        const last = lastFeedReadAt(key);
        if (!last || Date.now() - last > KEEP_WARM_ACTIVE_WINDOW_MS) continue;
      }
      // Sequential on purpose — one heavy compute at a time on the single
      // event loop. prewarmFeed itself skips fresh/in-flight keys.
      try { await prewarmFeed(key, compute); } catch { /* best-effort */ }
    }
  };
  setInterval(() => { void keepMainFeedsWarm(); }, 20_000).unref?.();
  // Boot pre-warm: one forced sequential warm ~35s after boot — after the boot
  // scrape window settles but BEFORE the curated 60s/75s warms, so the heavy
  // computes stay serialized on the memory-constrained VM.
  setTimeout(() => { void keepMainFeedsWarm(true); }, 35_000).unref?.();
  // Rebuild right after a feed-shaping write drops the Classic+Visual keys
  // (debounced — scrape cycles fire invalidateMainFeeds in bursts) so the next
  // poll after a write is still a warm hit.
  let mainFeedRewarmTimer: NodeJS.Timeout | null = null;
  onMainFeedsInvalidated(() => {
    if (mainFeedRewarmTimer) return; // already scheduled
    mainFeedRewarmTimer = setTimeout(() => {
      mainFeedRewarmTimer = null;
      void keepMainFeedsWarm();
    }, 4_000);
    mainFeedRewarmTimer.unref?.();
  });

  app.get("/api/ticker", (_req, res) => {
    res.json(getTickerData());
  });

  // Get scrape metadata (last update times, counts, status)
  app.get("/api/scrape-metadata", async (req, res) => {
    try {
      const metadata = await storage.getScrapeMetadata();
      res.json(metadata || {
        id: 'global',
        lastScrapeTime: null,
        scrapeStatus: 'idle'
      });
    } catch (error) {
      console.error('Error fetching scrape metadata:', error);
      res.status(500).json({ error: 'Failed to fetch scrape metadata' });
    }
  });

  // Diagnostic endpoint for debugging Truth Social scraping in production
  app.get("/api/diagnostics/truth-social", async (req, res) => {
    try {
      const posts = await storage.getRecentTruthSocialPosts(5);
      const dbHost = process.env.PGHOST || 'unknown';
      const nodeEnv = process.env.NODE_ENV || 'unknown';
      
      res.json({
        environment: nodeEnv,
        databaseHost: dbHost.substring(0, 20) + '...',
        serverTime: new Date().toISOString(),
        postCount: posts.length,
        latestPosts: posts.map(p => ({
          id: p.id,
          postId: p.postId,
          postedAt: p.postedAt,
          contentPreview: p.content?.substring(0, 50) + '...'
        }))
      });
    } catch (error) {
      console.error('Error in diagnostics:', error);
      res.status(500).json({ error: 'Diagnostics failed', message: String(error) });
    }
  });

  // Database schema diagnostics - shows actual table structure to identify naming discrepancies
  app.get("/api/diagnostics/db-schema", async (req, res) => {
    try {
      const { db } = await import('./db');
      const { sql } = await import('drizzle-orm');
      
      // Get all tables in the public schema
      const tablesResult = await db.execute(sql`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name
      `);
      
      // Get truth_social_posts column info
      const truthSocialColumnsResult = await db.execute(sql`
        SELECT column_name, data_type, is_nullable 
        FROM information_schema.columns 
        WHERE table_name = 'truth_social_posts' 
        ORDER BY ordinal_position
      `);
      
      // Count rows in truth_social_posts
      const countResult = await db.execute(sql`
        SELECT COUNT(*) as count FROM truth_social_posts
      `);
      
      // Get latest 3 rows
      const latestResult = await db.execute(sql`
        SELECT id, post_id, LEFT(content, 40) as content_preview, posted_at 
        FROM truth_social_posts 
        ORDER BY posted_at DESC 
        LIMIT 3
      `);
      
      // Check for any similar table names (in case of naming discrepancy)
      const similarTablesResult = await db.execute(sql`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND (table_name LIKE '%truth%' OR table_name LIKE '%potus%' OR table_name LIKE '%social%')
        ORDER BY table_name
      `);
      
      res.json({
        environment: process.env.NODE_ENV || 'unknown',
        databaseUrl: (process.env.DATABASE_URL || '').substring(0, 30) + '...',
        allTables: tablesResult.rows.map((r: any) => r.table_name),
        truthSocialRelatedTables: similarTablesResult.rows.map((r: any) => r.table_name),
        truthSocialPostsSchema: {
          exists: truthSocialColumnsResult.rows.length > 0,
          columns: truthSocialColumnsResult.rows.map((r: any) => ({
            name: r.column_name,
            type: r.data_type,
            nullable: r.is_nullable
          }))
        },
        truthSocialPostsData: {
          rowCount: (countResult.rows[0] as any)?.count || 0,
          latestRows: latestResult.rows
        }
      });
    } catch (error) {
      console.error('Error in db-schema diagnostics:', error);
      res.status(500).json({ 
        error: 'Database schema diagnostics failed', 
        message: String(error),
        hint: 'This error itself may indicate a schema problem'
      });
    }
  });

  // Diagnostic endpoint to see raw HTML structure from trumpstruth.org
  app.get("/api/diagnostics/raw-html", async (req, res) => {
    try {
      const cheerio = await import('cheerio');
      const response = await fetch('https://trumpstruth.org/');
      const html = await response.text();
      const $ = cheerio.load(html);
      
      const statusDivs = $('.statuses > div.status');
      const results: { dataStatusUrl: string; truthSocialUrl: string; extractedId: string; method: string }[] = [];
      
      statusDivs.each((i, elem) => {
        if (i < 5) {
          const statusDiv = $(elem);
          const dataStatusUrl = statusDiv.attr('data-status-url') || 'NO_DATA_STATUS_URL';
          
          // Try to find truthsocial.com link (canonical source)
          const truthSocialLink = statusDiv.find('a[href^="https://truthsocial.com"]').first();
          const truthSocialUrl = truthSocialLink.attr('href') || 'NO_TRUTHSOCIAL_LINK';
          
          // Extract ID using the same logic as the scraper
          let extractedId = 'NO_ID';
          let method = 'none';
          
          // Try format: /@username/ID (current format)
          const truthSocialIdMatch = truthSocialUrl.match(/@[^/]+\/(\d+)/);
          if (truthSocialIdMatch) {
            extractedId = truthSocialIdMatch[1];
            method = 'truthsocial.com (canonical)';
          } else {
            // Try format: /posts/ID
            const postsMatch = truthSocialUrl.match(/\/posts\/(\d+)/);
            if (postsMatch) {
              extractedId = postsMatch[1];
              method = 'truthsocial.com/posts';
            } else {
              const statusIdMatch = dataStatusUrl.match(/\/statuses\/(\d+)/);
              if (statusIdMatch) {
                extractedId = statusIdMatch[1];
                method = 'data-status-url (fallback)';
              }
            }
          }
          
          results.push({ dataStatusUrl, truthSocialUrl, extractedId, method });
        }
      });
      
      res.json({
        statusDivCount: statusDivs.length,
        firstFivePosts: results,
        htmlLength: html.length,
        hasStatusesClass: $('.statuses').length > 0
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Trigger manual Truth Social scrape and return detailed results (for production debugging)
  app.get("/api/diagnostics/scrape-truth-social", async (req, res) => {
    try {
      console.log('[Diagnostics] Manual Truth Social scrape triggered');
      const startTime = Date.now();
      
      const addedCount = await scrapeAllTruthSocial(storage);
      
      const totalDuration = Date.now() - startTime;
      const posts = await storage.getRecentTruthSocialPosts(5);
      
      console.log(`[Diagnostics] Scrape completed in ${totalDuration}ms, added ${addedCount} posts`);
      
      res.json({
        success: true,
        totalDurationMs: totalDuration,
        addedCount,
        latestDbPosts: posts.map(p => ({
          id: p.id,
          postId: p.postId,
          postedAt: p.postedAt,
          contentPreview: p.content?.substring(0, 50) + '...'
        }))
      });
    } catch (error) {
      console.error('[Diagnostics] Scrape error:', error);
      res.status(500).json({ 
        error: 'Scrape failed', 
        message: String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  });

  // Trigger manual scrape of First Alerts
  app.post("/api/scrape-first-alerts", async (req, res) => {
    try {
      console.log('Manual First Alert scrape triggered');
      const addedCount = await updateFirstAlerts(storage);
      const allAlerts = await storage.getRecentFirstAlerts(50);
      
      console.log(`First Alert scrape complete: ${addedCount} new alerts. Total: ${allAlerts.length}`);
      
      res.json({ 
        success: true, 
        newCount: addedCount,
        total: allAlerts.length
      });
    } catch (error) {
      console.error('Error during First Alert scrape:', error);
      res.status(500).json({ error: 'Failed to scrape First Alerts' });
    }
  });

  // GET version for easy browser access
  app.get("/api/trigger-scrape", async (req, res) => {
    try {
      console.log('Scraping all sources (triggered via GET)...');
      res.write('Scraping started...\n');
      
      const results = {
        headlines: { newCount: 0, duplicateCount: 0, total: 0 },
        truthSocial: { newCount: 0, total: 0 },
        x: { newCount: 0, total: 0 },
        rapidResponse: { newCount: 0, total: 0 },
        dowResponse: { newCount: 0, total: 0 },
        firstAlerts: { newCount: 0, total: 0 }
      };

      // Clear old headlines (older than 48 hours)
      await storage.clearOldHeadlines(48);
      
      // Scrape Drudge Report headlines
      res.write('Scraping headlines...\n');
      const scrapedHeadlines = await scrapeDrudgeReport();
      let newCount = 0;
      let duplicateCount = 0;
      
      for (const scraped of scrapedHeadlines) {
        const normalized = normalizeTitle(scraped.title);
        
        // Check if headline is blocked
        const isBlocked = await storage.isHeadlineBlocked(normalized);
        if (isBlocked) {
          continue;
        }
        
        const similarHeadlines = await storage.getSimilarHeadlines(normalized, 48);
        
        if (similarHeadlines.length > 0) {
          const existing = similarHeadlines[0];
          const existingScore = existing.priorityScore || 0;
          const scrapedScore = scraped.priorityScore || 0;
          await storage.updateHeadline(existing.id, {
            title: scraped.title,
            url: scraped.url,
            priorityScore: Math.max(existingScore, scrapedScore),
            tags: Array.from(new Set([...existing.tags, ...(scraped.tags || [])])),
          }, normalized);
          duplicateCount++;
        } else {
          const summary = generateSummary(scraped.title);
          await storage.addHeadline({
            title: scraped.title,
            url: scraped.url,
            category: scraped.category,
            source: scraped.source,
            summary,
            articlePublishedAt: scraped.articlePublishedAt,
            priorityScore: scraped.priorityScore || 0,
            tags: scraped.tags || []
          }, normalized);
          newCount++;
        }
      }
      
      const allHeadlines = await storage.getAllHeadlines();
      results.headlines = { newCount, duplicateCount, total: allHeadlines.length };
      res.write(`Headlines: ${newCount} new, ${duplicateCount} duplicates. Total: ${allHeadlines.length}\n`);

      // Scrape Truth Social
      res.write('Scraping Truth Social...\n');
      const truthSocialCount = await scrapeAllTruthSocial(storage);
      const allTruthSocial = await storage.getRecentTruthSocialPosts(50);
      results.truthSocial = { newCount: truthSocialCount, total: allTruthSocial.length };
      res.write(`Truth Social: ${truthSocialCount} new posts. Total: ${allTruthSocial.length}\n`);

      // Scrape X/Twitter
      res.write('Scraping X/Twitter...\n');
      const xCount = (await updateXPosts(storage)).addedCount;
      const allXPosts = await storage.getRecentXPosts(50);
      results.x = { newCount: xCount, total: allXPosts.length };
      res.write(`X: ${xCount} new posts. Total: ${allXPosts.length}\n`);

      // Scrape RapidResponse
      res.write('Scraping RapidResponse...\n');
      const rapidResponseCount = (await updateRapidResponsePosts(storage)).addedCount;
      const allRapidResponse = await storage.getRecentRapidResponsePosts(50);
      results.rapidResponse = { newCount: rapidResponseCount, total: allRapidResponse.length };
      res.write(`RapidResponse: ${rapidResponseCount} new posts. Total: ${allRapidResponse.length}\n`);

      // Scrape DOWResponse
      res.write('Scraping DOWResponse...\n');
      const dowResponseCount = (await updateDOWResponsePosts(storage)).addedCount;
      const allDOWResponse = await storage.getRecentDOWResponsePosts(50);
      results.dowResponse = { newCount: dowResponseCount, total: allDOWResponse.length };
      res.write(`DOWResponse: ${dowResponseCount} new posts. Total: ${allDOWResponse.length}\n`);

      // Scrape First Alerts
      res.write('Scraping First Alerts...\n');
      const firstAlertCount = await updateFirstAlerts(storage);
      const allFirstAlerts = await storage.getRecentFirstAlerts(100);
      results.firstAlerts = { newCount: firstAlertCount, total: allFirstAlerts.length };
      res.write(`First Alerts: ${firstAlertCount} new alerts. Total: ${allFirstAlerts.length}\n`);

      res.write('\nAll sources scraped successfully!\n');
      res.write(JSON.stringify(results, null, 2));
      res.end();
    } catch (error) {
      console.error('Error during scrape:', error);
      res.write(`\nError: ${error}\n`);
      res.status(500).end();
    }
  });

  // Trigger all scrapers at once (on-demand for Autoscale compatibility)
  app.post("/api/scrape-all", async (req, res) => {
    try {
      // Check if scheduled scrape is in progress to avoid rate limiting
      const status = getScraperStatus();
      if (status.isRunning) {
        console.log('Manual scrape-all skipped - scheduled scrape in progress');
        return res.json({ 
          success: true, 
          skipped: true,
          message: 'Scrape skipped - scheduled scrape in progress'
        });
      }
      
      console.log('Scraping all sources...');
      
      const results = {
        headlines: { newCount: 0, duplicateCount: 0, total: 0 },
        truthSocial: { newCount: 0, total: 0 },
        x: { newCount: 0, total: 0 },
        rapidResponse: { newCount: 0, total: 0 },
        dowResponse: { newCount: 0, total: 0 },
        firstAlerts: { newCount: 0, total: 0 }
      };

      // Clear old headlines (older than 48 hours)
      await storage.clearOldHeadlines(48);
      
      // Scrape Drudge Report headlines
      const scrapedHeadlines = await scrapeDrudgeReport();
      let newCount = 0;
      let duplicateCount = 0;
      
      for (const scraped of scrapedHeadlines) {
        const normalized = normalizeTitle(scraped.title);
        
        // Check if headline is blocked
        const isBlocked = await storage.isHeadlineBlocked(normalized);
        if (isBlocked) {
          console.log(`Skipping blocked headline: "${scraped.title.substring(0, 80)}..."`);
          continue;
        }
        
        const similarHeadlines = await storage.getSimilarHeadlines(normalized, 48);
        
        if (similarHeadlines.length > 0) {
          const existing = similarHeadlines[0];
          const existingScore = existing.priorityScore || 0;
          const scrapedScore = scraped.priorityScore || 0;
          await storage.updateHeadline(existing.id, {
            title: scraped.title,
            url: scraped.url,
            priorityScore: Math.max(existingScore, scrapedScore),
            tags: Array.from(new Set([...existing.tags, ...(scraped.tags || [])])),
          }, normalized);
          duplicateCount++;
        } else {
          const summary = generateSummary(scraped.title);
          await storage.addHeadline({
            title: scraped.title,
            url: scraped.url,
            category: scraped.category,
            source: scraped.source,
            summary,
            articlePublishedAt: scraped.articlePublishedAt,
            priorityScore: scraped.priorityScore || 0,
            tags: scraped.tags || []
          }, normalized);
          newCount++;
        }
      }
      
      const allHeadlines = await storage.getAllHeadlines();
      results.headlines = { newCount, duplicateCount, total: allHeadlines.length };
      console.log(`Headlines: ${newCount} new, ${duplicateCount} duplicates. Total: ${allHeadlines.length}`);

      // Scrape Truth Social
      const truthSocialCount = await scrapeAllTruthSocial(storage);
      const allTruthSocial = await storage.getRecentTruthSocialPosts(50);
      results.truthSocial = { newCount: truthSocialCount, total: allTruthSocial.length };
      console.log(`Truth Social: ${truthSocialCount} new posts. Total: ${allTruthSocial.length}`);

      // Scrape X/Twitter
      const xCount = (await updateXPosts(storage)).addedCount;
      const allXPosts = await storage.getRecentXPosts(50);
      results.x = { newCount: xCount, total: allXPosts.length };
      console.log(`X: ${xCount} new posts. Total: ${allXPosts.length}`);

      // Scrape RapidResponse
      const rapidResponseCount = (await updateRapidResponsePosts(storage)).addedCount;
      const allRapidResponse = await storage.getRecentRapidResponsePosts(50);
      results.rapidResponse = { newCount: rapidResponseCount, total: allRapidResponse.length };
      console.log(`RapidResponse: ${rapidResponseCount} new posts. Total: ${allRapidResponse.length}`);

      // Scrape DOWResponse
      const dowResponseCount = (await updateDOWResponsePosts(storage)).addedCount;
      const allDOWResponse = await storage.getRecentDOWResponsePosts(50);
      results.dowResponse = { newCount: dowResponseCount, total: allDOWResponse.length };
      console.log(`DOWResponse: ${dowResponseCount} new posts. Total: ${allDOWResponse.length}`);

      // Scrape First Alerts
      const firstAlertCount = await updateFirstAlerts(storage);
      const allFirstAlerts = await storage.getRecentFirstAlerts(100);
      results.firstAlerts = { newCount: firstAlertCount, total: allFirstAlerts.length };
      console.log(`First Alerts: ${firstAlertCount} new alerts. Total: ${allFirstAlerts.length}`);

      console.log('All sources scraped successfully');
      
      res.json({ 
        success: true,
        results
      });
    } catch (error) {
      console.error('Error during scrape-all:', error);
      res.status(500).json({ error: 'Failed to scrape all sources' });
    }
  });

  // Trigger manual scrape
  app.post("/api/scrape", async (req, res) => {
    try {
      const status = getScraperStatus();
      if (status.isRunning) {
        console.log('Manual headline scrape skipped - scheduled scrape in progress');
        return res.json({ 
          success: true, 
          skipped: true,
          message: 'Scrape skipped - scheduled scrape in progress'
        });
      }
      console.log('Manual scrape triggered');
      
      // Clear old headlines (older than 48 hours)
      await storage.clearOldHeadlines(48);
      
      // Scrape new headlines
      const scrapedHeadlines = await scrapeDrudgeReport();
      
      // Store headlines with summaries (skip duplicates)
      let newCount = 0;
      let duplicateCount = 0;
      
      for (const scraped of scrapedHeadlines) {
        const normalized = normalizeTitle(scraped.title);
        
        // Check if headline is blocked
        const isBlocked = await storage.isHeadlineBlocked(normalized);
        if (isBlocked) {
          console.log(`Skipping blocked headline: "${scraped.title.substring(0, 80)}..."`);
          continue;
        }
        
        // Check for similar headlines using fuzzy matching
        const similarHeadlines = await storage.getSimilarHeadlines(normalized, 48);
        
        if (similarHeadlines.length > 0) {
          // Found a similar headline - update it instead of creating a duplicate
          const existing = similarHeadlines[0];
          const existingScore = existing.priorityScore || 0;
          const scrapedScore = scraped.priorityScore || 0;
          await storage.updateHeadline(existing.id, {
            title: scraped.title,
            url: scraped.url,
            priorityScore: Math.max(existingScore, scrapedScore),
            tags: Array.from(new Set([...existing.tags, ...(scraped.tags || [])])),
          }, normalized);
          duplicateCount++;
        } else {
          // No similar headline found - create new one
          const summary = generateSummary(scraped.title);
          await storage.addHeadline({
            title: scraped.title,
            url: scraped.url,
            category: scraped.category,
            source: scraped.source,
            summary,
            articlePublishedAt: scraped.articlePublishedAt,
            priorityScore: scraped.priorityScore || 0,
            tags: scraped.tags || []
          }, normalized);
          newCount++;
        }
      }
      
      const allHeadlines = await storage.getAllHeadlines();
      console.log(`Manual scrape complete: ${newCount} new, ${duplicateCount} duplicates skipped. Total: ${allHeadlines.length}`);
      
      res.json({ 
        success: true, 
        newCount,
        duplicateCount,
        total: allHeadlines.length
      });
    } catch (error) {
      console.error('Error during scrape:', error);
      res.status(500).json({ error: 'Failed to scrape headlines' });
    }
  });

  // Configure multer for PDF uploads with strict validation
  const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { 
      fileSize: 10 * 1024 * 1024, // 10MB limit
      files: 1 // Only allow 1 file
    },
    fileFilter: (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
      // Strict MIME type validation
      if (file.mimetype !== 'application/pdf') {
        return cb(new Error('Only PDF files are allowed'));
      }
      
      // File extension validation
      const ext = file.originalname.toLowerCase().split('.').pop();
      if (ext !== 'pdf') {
        return cb(new Error('File must have .pdf extension'));
      }
      
      cb(null, true);
    }
  });

  // Get all manual submissions
  app.get("/api/manual-submissions", async (req, res) => {
    try {
      const submissions = await storage.getAllManualSubmissions();
      res.json(submissions);
    } catch (error) {
      console.error('Error fetching manual submissions:', error);
      res.status(500).json({ error: 'Failed to fetch manual submissions' });
    }
  });

  // Submit a new article manually (with PDF upload)
  app.post("/api/manual-submissions", upload.single('pdf'), async (req: any, res) => {
    try {
      console.log('[Manual Submission] Processing new submission...');
      console.log('[Manual Submission] Has PDF attachment:', !!req.file);
      
      // Validate password first
      const submissionPassword = process.env.SUBMISSION_PASSWORD;
      if (!submissionPassword) {
        console.error('[Manual Submission] ERROR: SUBMISSION_PASSWORD environment variable not set');
        return res.status(500).json({ error: 'Server configuration error' });
      }
      
      if (!req.body.password || req.body.password !== submissionPassword) {
        console.log('[Manual Submission] ERROR: Invalid password provided');
        return res.status(401).json({ error: 'Invalid password' });
      }
      
      console.log('[Manual Submission] Password validated successfully');
      
      // Normalize multipart/form-data payload
      // Parse JSON strings into their expected types (handle both JSON and multipart/form-data)
      const normalizedBody = {
        ...req.body,
        // If tags is already an array (application/json), use it; if it's a string (multipart), parse it
        tags: req.body.tags ? (Array.isArray(req.body.tags) ? req.body.tags : JSON.parse(req.body.tags)) : [],
        priorityScore: req.body.priorityScore ? parseInt(req.body.priorityScore, 10) : 0
      };
      
      // Remove password from the data before validation (not part of schema)
      delete normalizedBody.password;
      
      console.log('[Manual Submission] Validating submission data...');
      
      // Validate against schema
      const validatedData = insertManualSubmissionSchema.parse(normalizedBody);
      
      console.log('[Manual Submission] Data validation passed');
      
      // Respect user-provided priority score and tags
      // Only use AI analysis as fallback if not provided
      let finalPriorityScore = validatedData.priorityScore || 50;
      let finalTags = validatedData.tags || [];
      
      // If user didn't provide priority or tags, use AI analysis
      if (!validatedData.priorityScore || !validatedData.tags || validatedData.tags.length === 0) {
        console.log(`[Manual Submission] Running AI analysis for: "${validatedData.title}"`);
        const analyses = await analyzeBatchHeadlines([validatedData.title]);
        
        if (analyses.length > 0 && analyses[0]) {
          // Only use AI values if user didn't provide them
          if (!validatedData.priorityScore) {
            finalPriorityScore = analyses[0].priority_score || 50;
          }
          if (!validatedData.tags || validatedData.tags.length === 0) {
            finalTags = analyses[0].tags || [];
          }
          console.log(`[Manual Submission] AI analysis complete: priority=${analyses[0].priority_score}, tags=[${analyses[0].tags?.join(', ')}]`);
        }
      } else {
        console.log(`[Manual Submission] Using user values: priority=${finalPriorityScore}, tags=[${finalTags.join(', ')}]`);
      }
      
      let pdfPath = null;
      
      // Handle PDF upload if provided
      if (req.file) {
        console.log(`[Manual Submission] Processing PDF upload: ${req.file.originalname} (${req.file.size} bytes)`);
        
        // Additional security: validate file content starts with PDF magic bytes
        const pdfMagicBytes = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
        if (!req.file.buffer.subarray(0, 4).equals(pdfMagicBytes)) {
          console.log('[Manual Submission] ERROR: PDF validation failed - invalid magic bytes');
          return res.status(400).json({ error: 'Invalid PDF file format' });
        }
        
        console.log('[Manual Submission] PDF magic bytes validated');
        
        try {
          // Upload to Replit's App Storage instead of local filesystem
          const objectStorageService = new ObjectStorageService();
          console.log('[Manual Submission] Uploading PDF to object storage...');
          pdfPath = await objectStorageService.uploadPDF(req.file.buffer, req.file.originalname);
          console.log(`[Manual Submission] PDF uploaded successfully to: ${pdfPath}`);
        } catch (uploadError) {
          console.error('[Manual Submission] ERROR: PDF upload to object storage failed:', uploadError);
          return res.status(500).json({ 
            error: 'Failed to upload PDF', 
            details: uploadError instanceof Error ? uploadError.message : 'Unknown error' 
          });
        }
      }
      
      console.log('[Manual Submission] Saving submission to database...');
      
      // Save with user-provided values (or AI fallback if not provided)
      const submission = await storage.addManualSubmission({
        ...validatedData,
        priorityScore: finalPriorityScore,
        tags: finalTags,
        pdfPath
      });
      
      console.log(`[Manual Submission] SUCCESS: "${submission.title}" by ${submission.submittedBy} (priority: ${finalPriorityScore})`);
      
      invalidateMainFeeds();
      res.json(submission);
    } catch (error) {
      console.error('[Manual Submission] ERROR: Unhandled exception:', error);
      
      // Return validation errors with clear messages
      if (error instanceof Error) {
        console.error('[Manual Submission] Error message:', error.message);
        console.error('[Manual Submission] Error stack:', error.stack);
        
        if (error.message.includes('validation') || error.message.includes('parse')) {
          return res.status(400).json({ error: 'Invalid submission data', details: error.message });
        }
      }
      
      res.status(500).json({ error: 'Failed to create manual submission' });
    }
  });

  // Serve uploaded PDFs from object storage (public access for submitted articles)
  app.get("/objects/:objectPath(*)", async (req, res) => {
    const objectStorageService = new ObjectStorageService();
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(req.path);
      objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      console.error("Error serving PDF:", error);
      if (error instanceof ObjectNotFoundError) {
        return res.sendStatus(404);
      }
      return res.sendStatus(500);
    }
  });

  // Serve public objects (e.g. uploaded outlet logos) from the object-storage
  // PUBLIC folder. No auth — these are intentionally public assets, mirroring
  // how bundled logos are publicly served by the client.
  app.get("/api/public-objects/:filePath(*)", async (req, res) => {
    const filePath = req.params.filePath;
    const objectStorageService = new ObjectStorageService();
    try {
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        return res.status(404).json({ error: "File not found" });
      }
      objectStorageService.downloadObject(file, res);
    } catch (error) {
      console.error("Error serving public object:", error);
      return res.status(500).json({ error: "Error serving public object" });
    }
  });

  // Configure multer for chat image uploads
  const chatImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB limit
      files: 1
    },
    fileFilter: (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
      if (file.mimetype.startsWith('image/')) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed'));
      }
    }
  });

  // Upload chat image to object storage
  app.post("/api/team/chat/upload-image", chatImageUpload.single('image'), requireTeamMember, async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image file provided' });
      }

      const objectStorageService = new ObjectStorageService();
      const imagePath = await objectStorageService.uploadChatImage(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );

      res.json({ url: imagePath });
    } catch (error) {
      console.error('Error uploading chat image:', error);
      res.status(500).json({ error: 'Failed to upload image' });
    }
  });

  const streamImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
      if (file.mimetype.startsWith('image/')) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed'));
      }
    }
  });

  app.post("/api/stream/upload-image", (req: any, res: any, next: any) => {
    console.log(`[Upload] POST /api/stream/upload-image received - content-length: ${req.headers['content-length']}, content-type: ${req.headers['content-type']?.substring(0, 50)}, cookie: ${req.headers.cookie ? 'present' : 'MISSING'}`);
    streamImageUpload.single('image')(req, res, (err: any) => {
      if (err) {
        console.error('Multer upload error:', err);
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      next();
    });
  }, requireTeamOrUserAuth, async (req: any, res) => {
    try {
      console.log(`[Upload] Stream image upload request - session auth: user=${!!req.session?.authenticated}, admin=${!!req.session?.adminAuthenticated}, warAdmin=${!!req.session?.warAdminAuthenticated}, file=${!!req.file}`);
      if (!req.file) {
        return res.status(400).json({ error: 'No image file provided' });
      }
      const objectStorageService = new ObjectStorageService();
      const imagePath = await objectStorageService.uploadStreamImage(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );
      console.log(`[Upload] Stream image uploaded successfully: ${imagePath}`);
      res.json({ url: imagePath });
    } catch (error: any) {
      console.error('Error uploading stream image:', error?.message || error);
      res.status(500).json({ error: `Failed to upload image: ${error?.message || 'Unknown error'}` });
    }
  });

  // Flight tracking post endpoints
  const flightTrackingUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
      if (file.mimetype.startsWith('image/')) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed'));
      }
    }
  });

  app.post("/api/flight-tracking/analyze", flightTrackingUpload.single('screenshot'), requireTeamOrUserAuth, async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No screenshot file provided' });
      }
      const { xUrl } = req.body;
      if (!xUrl || typeof xUrl !== 'string') {
        return res.status(400).json({ error: 'X post URL is required' });
      }

      const objectStorageService = new ObjectStorageService();
      const screenshotUrl = await objectStorageService.uploadFlightTrackingImage(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );

      const screenshotBase64 = req.file.buffer.toString('base64');
      const mimeType = req.file.mimetype;
      const dataUrl = `data:${mimeType};base64,${screenshotBase64}`;

      if (!isAIConfigured()) {
        return res.status(500).json({ error: 'AI not configured' });
      }

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Analyze this screenshot of an X (Twitter) post. Extract the following information:

1. "sourceAccount" - The X/Twitter handle of the TOP-LEVEL account that posted or retweeted this (without the @). This is the account whose post appears at the top of the screenshot.
2. "displayName" - The display name shown for the top-level account.
3. "postedAt" - The date and time the post was made. Look for timestamps like "2:30 PM · Feb 27, 2026" or relative times like "1h". IMPORTANT: X/Twitter displays timestamps in the viewer's local timezone, which is US Eastern Time (America/New_York, UTC-5 or UTC-4 during DST). You MUST convert the displayed time from Eastern Time to UTC before returning. For example, if the post shows "7:33 AM · Feb 27, 2026" that is 7:33 AM ET = 12:33 PM UTC, so return "2026-02-27T12:33:00.000Z". If relative (like "1h"), calculate from current time (${new Date().toISOString()}). Return in ISO 8601 format (UTC).

4. RETWEET/QUOTE-TWEET DETECTION: Carefully check if this post is a quote-tweet (a post that embeds/quotes another post inside it). Signs of a quote-tweet:
   - There is an embedded/nested post card inside the main post (usually with a different author, their own avatar, handle, and text)
   - The main post has its own text (commentary) AND shows another post below it
   If it IS a quote-tweet:
   - Set "isRetweet": true
   - Set "retweetedFrom": the handle of the ORIGINAL quoted post's author (without @)
   - Set "retweetCommentary": the TOP-LEVEL poster's own commentary text
   - Set "originalContent": the text from the EMBEDDED/QUOTED post
   If it is NOT a quote-tweet (just a regular post):
   - Set "isRetweet": false
   - Set "retweetedFrom": null
   - Set "retweetCommentary": null
   - Set "originalContent": null

5. "content" - The COMBINED text content. For regular posts, this is just the post text. For quote-tweets, format as:
   "[retweeter's commentary text]\\n\\nRT @originalAuthor: [original post text]"
   This ensures all text is captured in one field.

6. "hasEmbeddedImage" - true if there is a photo/image embedded in the post (look for actual photographs, not profile pictures or the quote-tweet card itself). If the post is a quote-tweet, check if the ORIGINAL quoted post contains an image.
7. "imageDescription" - If hasEmbeddedImage is true, briefly describe the image content (e.g., "Military aircraft parked at an airport"). Set to null if no image.

The X post URL is: ${xUrl}

Respond in JSON format:
{
  "sourceAccount": "handle_without_at",
  "displayName": "Display Name",
  "content": "Combined text with RT formatting if applicable",
  "postedAt": "2026-02-27T14:30:00.000Z",
  "isRetweet": false,
  "retweetedFrom": null,
  "retweetCommentary": null,
  "originalContent": null,
  "hasEmbeddedImage": true,
  "imageDescription": "Brief description of embedded image or null"
}`,
              },
              {
                type: "image_url",
                image_url: {
                  url: dataUrl,
                  detail: "high",
                },
              },
            ],
          },
        ],
        max_tokens: 2000,
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const aiContent = response.choices[0]?.message?.content;
      if (!aiContent) {
        return res.status(500).json({ error: 'AI analysis returned no content' });
      }

      const parsed = JSON.parse(aiContent);
      
      let postId = '';
      const statusMatch = xUrl.match(/\/status\/(\d+)/);
      if (statusMatch) {
        postId = statusMatch[1];
      } else {
        postId = `ft-${Date.now()}`;
      }

      res.json({
        sourceAccount: parsed.sourceAccount || '',
        displayName: parsed.displayName || '',
        content: parsed.content || '',
        postedAt: parsed.postedAt || new Date().toISOString(),
        hasEmbeddedImage: parsed.hasEmbeddedImage || false,
        imageDescription: parsed.imageDescription || null,
        isRetweet: parsed.isRetweet || false,
        retweetedFrom: parsed.retweetedFrom || null,
        retweetCommentary: parsed.retweetCommentary || null,
        originalContent: parsed.originalContent || null,
        postId,
        xUrl,
        screenshotUrl,
      });
    } catch (error: any) {
      console.error('Error analyzing flight tracking post:', error);
      res.status(500).json({ error: `Failed to analyze screenshot: ${error?.message || 'Unknown error'}` });
    }
  });

  app.post("/api/flight-tracking/posts", requireTeamOrUserAuth, async (req: any, res) => {
    try {
      const { postId, content, postedAt, xUrl, sourceAccount, imageUrl, screenshotUrl } = req.body;
      if (!content || !xUrl || !sourceAccount) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const parsedDate = postedAt ? new Date(postedAt) : new Date();
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({ error: 'Invalid posted date' });
      }

      const post = await storage.addFlightTrackingPost({
        postId: postId || `ft-${Date.now()}`,
        content,
        postedAt: parsedDate,
        xUrl,
        sourceAccount,
        imageUrl: imageUrl || null,
        screenshotUrl: screenshotUrl || null,
        submittedBy: req.session?.username || req.user?.username || 'unknown',
      });

      res.json(post);
    } catch (error: any) {
      console.error('Error saving flight tracking post:', error);
      res.status(500).json({ error: 'Failed to save post' });
    }
  });

  app.get("/api/flight-tracking/posts", async (_req, res) => {
    try {
      const posts = await storage.getRecentFlightTrackingPosts(50);
      res.json(posts);
    } catch (error) {
      console.error('Error fetching flight tracking posts:', error);
      res.status(500).json({ error: 'Failed to fetch posts' });
    }
  });

  app.post("/api/team/submissions/:id/post-to-flight-tracking", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      const submission = await storage.getTeamSubmissionById(id);
      if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
      }
      if (!submission.isMataOsint) {
        return res.status(400).json({ error: 'Only MATA/OSINT submissions can be posted to flight tracking' });
      }
      if (submission.flightTrackingPostedAt) {
        return res.status(400).json({ error: 'Already posted to flight tracking' });
      }

      let imageUrl: string | null = null;
      if (submission.chatMessageId) {
        const { teamChatMessages } = await import('@shared/schema');
        const [chatMsg] = await db
          .select()
          .from(teamChatMessages)
          .where(eq(teamChatMessages.id, submission.chatMessageId))
          .limit(1);
        if (chatMsg) {
          const imgMatch = chatMsg.message.match(/<img[^>]+src="([^"]+)"/);
          if (imgMatch) {
            imageUrl = imgMatch[1];
          }
        }
      }

      const content = submission.headline + (submission.summary ? '\n\n' + submission.summary : '');
      const sourceAccount = submission.sourceName || 'MATA_OSINT';

      const post = await storage.addFlightTrackingPost({
        postId: `mata-${submission.id}`,
        content,
        postedAt: submission.publishedAt || submission.createdAt,
        xUrl: submission.sourceUrl,
        sourceAccount,
        imageUrl,
        screenshotUrl: null,
        submittedBy: req.user?.claims?.first_name || req.session?.username || 'unknown',
      });

      await db
        .update(teamSubmissions)
        .set({ flightTrackingPostedAt: new Date(), updatedAt: new Date() })
        .where(eq(teamSubmissions.id, id));

      res.json(post);
    } catch (error: any) {
      console.error('Error posting to flight tracking:', error);
      res.status(500).json({ error: 'Failed to post to flight tracking' });
    }
  });

  app.post("/api/stream/summarize-text", requireTeamOrUserAuth, async (req: any, res) => {
    try {
      const { text, headline } = req.body;
      if (!text || typeof text !== 'string' || text.trim().length < 50) {
        return res.status(400).json({ error: 'Text must be at least 50 characters' });
      }
      if (!isAIConfigured()) {
        return res.status(500).json({ error: 'AI not configured' });
      }
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a military intelligence analyst. Generate exactly 3 concise bullet points summarizing this article. Each bullet must be 15 words or fewer. Bullet 1: What is the big change or announcement in this story. Bullet 2: What is the background context. Bullet 3: Any supplemental information. Always spell out publication, outlet, and organization names in full (e.g. "The Daily Wire" not "TDW", "The Wall Street Journal" not "WSJ", "Associated Press" not "AP"). Return only the 3 bullets, one per line, without bullet markers or numbering.'
          },
          {
            role: 'user',
            content: `Headline: ${headline || 'News article'}\n\nArticle text:\n${text.slice(0, 3000)}`
          }
        ],
        max_tokens: 200,
        temperature: 0.3,
      });
      const responseText = completion.choices[0]?.message?.content || '';
      const bullets = responseText
        .split('\n')
        .map((line: string) => line.replace(/^[-•*\d.)\s]+/, '').trim())
        .filter((line: string) => line.length > 0)
        .slice(0, 3)
        .map((line: string) => line.split(/\s+/).slice(0, 15).join(' '));
      res.json({ bullets });
    } catch (error: any) {
      console.error('Error in summarize-text:', error?.message || error);
      res.status(500).json({ error: `Failed to summarize: ${error?.message || 'Unknown error'}` });
    }
  });

  app.patch("/api/headlines/:id/stream-media", requireTeamOrUserAuth, async (req: any, res) => {
    try {
      const headlineId = req.params.id;
      const { ogImageUrl, summaryBullets } = req.body;

      const updateData: any = { mediaScrapedAt: new Date(), manuallyEdited: true };
      if (ogImageUrl !== undefined) {
        updateData.ogImageUrl = ogImageUrl;
      }
      if (summaryBullets !== undefined) {
        updateData.summaryBullets = summaryBullets && summaryBullets.length > 0 ? summaryBullets : null;
      }

      const result = await db.update(headlines)
        .set(updateData)
        .where(eq(headlines.id, headlineId))
        .returning({ id: headlines.id });

      if (result.length === 0) {
        const manualResult = await db.update(manualSubmissions)
          .set(updateData)
          .where(eq(manualSubmissions.id, headlineId))
          .returning({ id: manualSubmissions.id });

        if (manualResult.length === 0) {
          return res.status(404).json({ error: 'Headline no longer exists. It may have been removed from the feed. Please refresh the page.' });
        }
      }

      invalidateMainFeeds();
      res.json({ success: true });
    } catch (error) {
      console.error('Error updating stream media:', error);
      res.status(500).json({ error: 'Failed to update stream media' });
    }
  });

  // Team Chat API routes (requires Replit auth + Warfighter org membership)
  app.get("/api/team/chat", requireTeamMember, async (req: any, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const messages = await storage.getRecentChatMessages(limit);
      // Reverse to show oldest first in the UI
      res.json(messages.reverse());
    } catch (error) {
      console.error('Error fetching chat messages:', error);
      res.status(500).json({ error: 'Failed to fetch chat messages' });
    }
  });

  app.delete("/api/team/chat/:id", requireTeamMember, async (req: any, res) => {
    try {
      const messageId = req.params.id;
      const userId = req.user.claims.sub;
      
      const messages = await storage.getRecentChatMessages(1000);
      const message = messages.find(m => m.id === messageId);
      
      if (!message) {
        return res.status(404).json({ error: 'Message not found' });
      }
      
      if (message.userId !== userId) {
        return res.status(403).json({ error: 'You can only delete your own messages' });
      }
      
      await storage.deleteChatMessage(messageId);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting chat message:', error);
      res.status(500).json({ error: 'Failed to delete message' });
    }
  });

  app.post("/api/team/chat/review-x-post", requireTeamMember, async (req: any, res) => {
    try {
      const { url: rawUrl } = req.body;
      if (!rawUrl || typeof rawUrl !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
      }
      // Unwrap any safe-link / isolation-proxy wrapper so a wrapped social link
      // is routed to the correct X-post path. No-op for normal links.
      const url = unwrapSafeLink(rawUrl);

      const xUrlPattern = /^https?:\/\/(?:www\.)?(x\.com|twitter\.com)\/[^/]+\/status\/\d+/i;
      if (!xUrlPattern.test(url)) {
        return res.status(400).json({ error: 'URL must be a valid X/Twitter post (e.g. https://x.com/user/status/123)' });
      }

      const { scrapeXPostContent } = await import('./textScraper');
      console.log(`[ReviewXPost] Scraping X post: ${url}`);
      const xContent = await scrapeXPostContent(url);

      if (!xContent.success || !xContent.text) {
        return res.status(422).json({ error: 'Could not scrape the X post. It may be protected or unavailable.' });
      }

      console.log(`[ReviewXPost] Scraped @${xContent.author}: ${xContent.text.length} chars${xContent.imageUrl ? ' (with image)' : ''}${xContent.postedAt ? ` (posted ${xContent.postedAt})` : ''}`);
      res.json({
        text: xContent.text,
        author: xContent.author,
        imageUrl: xContent.imageUrl,
        videoUrl: xContent.videoUrl,
        postedAt: xContent.postedAt,
        url,
        success: true,
      });
    } catch (error: any) {
      console.error('[ReviewXPost] Error:', error?.message || error);
      res.status(500).json({ error: `Failed to scrape X post: ${error?.message || 'Unknown error'}` });
    }
  });

  app.post("/api/team/chat/submit-reviewed-x-post", requireTeamMember, async (req: any, res) => {
    try {
      const { text, author, imageUrl, videoUrl, postedAt, url, message } = req.body;
      if (!text || !url) {
        return res.status(400).json({ error: 'Text and URL are required' });
      }

      const xUrlPattern = /^https?:\/\/(?:www\.)?(x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i;
      const xMatch = url.match(xUrlPattern);
      if (!xMatch) {
        return res.status(400).json({ error: 'URL must be a valid X/Twitter post' });
      }

      const claims = req.user.claims;
      const userId = claims.sub;
      const userName = claims.first_name || claims.email?.split('@')[0] || 'User';

      const postId = xMatch[2];

      const existing = await storage.getFlightTrackingPostByPostId(postId);
      if (existing) {
        return res.status(409).json({ error: 'This X post has already been added' });
      }

      const flightPost = await storage.addFlightTrackingPost({
        postId,
        content: text,
        postedAt: postedAt ? new Date(postedAt) : new Date(),
        xUrl: url,
        sourceAccount: (author || 'unknown').replace(/^@/, ''),
        imageUrl: imageUrl || null,
        videoUrl: videoUrl || null,
        submittedBy: userName,
      });

      console.log(`[ReviewXPost] Saved to flight_tracking_posts: @${author} - ${text.substring(0, 60)}... (id: ${flightPost.id})`);

      res.json({
        success: true,
        flightPost,
      });
    } catch (error: any) {
      console.error('[ReviewXPost] Submit error:', error?.message || error);
      res.status(500).json({ error: `Failed to save reviewed X post: ${error?.message || 'Unknown error'}` });
    }
  });

  app.post("/api/team/chat/review-link", requireTeamMember, async (req: any, res) => {
    // If the client navigates away or fires a new review before this one finishes,
    // stop writing to a dead socket: the in-flight AI work is already capped by the
    // time budget below, but streaming onto a closed response just wastes work and
    // logs noisy write-after-end errors. Guarded in writeEvent and the final end().
    //
    // Detect the disconnect on the RESPONSE, never the request: in modern Node the
    // IncomingMessage 'close' fires as soon as the request BODY is consumed — well
    // before this handler finishes streaming — so a req-side 'close' would false-
    // positive on EVERY normal request and silently swallow the whole stream. The
    // response 'close' fires on normal completion (writableFinished === true) OR on
    // a premature client disconnect (writableFinished === false); only the latter
    // means the client is gone.
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) clientGone = true; });
    // Heartbeat handle for the streamed connection (started below); cleared in finally.
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const { url: rawUrl, message, useUserInfo, userText } = req.body;
      if (!rawUrl || typeof rawUrl !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
      }
      // Unwrap any safe-link / isolation-proxy wrapper (e.g. Menlo) FIRST so the
      // dialog URL, the page fetch, and source-name detection all use the real
      // article URL rather than the proxy shell. No-op for normal links.
      const url = unwrapSafeLink(rawUrl);
      const userSuppliedText = (useUserInfo && typeof userText === 'string') ? userText.trim() : '';

      if (!isAIConfigured()) {
        return res.status(500).json({ error: 'AI not configured' });
      }

      const { analyzeSubmittedLink, analyzeBatchHeadlines, analyzeCuratedBatch, analyzeLinkPriorityWithBody } = await import('./aiAnalyzer');
      const { scrapeContent, scrapeArticleText, fetchPageHtml } = await import('./textScraper');
      type ScrapeResult = Awaited<ReturnType<typeof scrapeArticleText>>;

      const allSubjects = await storage.getAllSubjects();
      const activeSubjects = allSubjects.filter(s => s.isActive);
      const existingSubjectNames = allSubjects.map(s => s.name);
      const existingTopics = activeSubjects.map(s => s.name);

      // --- Stream-first interactive review (NDJSON) ---
      // Open the review dialog IMMEDIATELY — before any slow fetch / paywall-
      // bypass / metadata AI work — then enrich it progressively. This removes
      // the silent pre-stream window that made slow or paywalled links exceed the
      // proxy timeout (returning a non-JSON body the client could only show as a
      // generic failure) and DROP the user's pasted link. Now the link is never
      // lost: the dialog is usable the whole time, and the user can fill in any
      // field the auto-fill can't reach and post manually. This does NOT shorten
      // any shared scraper / Playwright / fetch timeout — those run unchanged; we
      // only change the ORDER (stream first) and stop *waiting* on them for THIS
      // one interactive request.
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      const writeEvent = (event: any) => {
        if (clientGone || res.writableEnded) return;
        try {
          res.write(JSON.stringify(event) + '\n');
          if (typeof (res as any).flush === 'function') (res as any).flush();
        } catch (writeErr) {
          console.error('[ReviewLink] Stream write error:', writeErr);
        }
      };

      // Open the dialog right now with just the URL + the user's own text. The
      // headline / image / source and the priority / bullets / classification
      // fields each stream in as they finish (or fall back to manual entry).
      writeEvent({
        type: 'init',
        url,
        userText: userSuppliedText,
        message: message || '',
        headline: '',
        summary: '',
        ogImageUrl: null,
        sourceName: 'News Source',
        sourceType: 'news',
        existingTopics,
        _loading: { metadata: true, priority: true, bullets: true, classification: true },
      });

      // Heartbeat: a streamed connection held open for tens of seconds (slow
      // paywall bypass) must keep emitting bytes, or an upstream proxy may treat
      // the idle socket as dead and cut a non-JSON error. The client parser
      // ignores any line it can't map to a known event, so a ping is inert.
      heartbeat = setInterval(() => writeEvent({ type: 'ping', ts: Date.now() }), 10000);

      // Cheap up-front social-URL check (no network). A pasted X/social link must
      // NOT get article-scraped — it keeps its current fast path.
      const isLikelySocialUrl = /(?:^|\.)(?:x\.com|twitter\.com|t\.co|facebook\.com|fb\.com|instagram\.com|threads\.net|tiktok\.com|youtube\.com|youtu\.be|reddit\.com|truthsocial\.com|t\.me|telegram\.me|bsky\.app|linkedin\.com)\//i.test(url);

      // METADATA PHASE: fetch the page once + extract metadata, bounded by a
      // generous request-local budget so even a slow paywall-bypass (~50s in the
      // wild) can finish. throwOnTransient is OFF here: a transient AI blip must
      // NOT abort the already-open dialog — it just falls back to manual entry.
      const META_BUDGET_MS = 60000;
      const metaDeadline = Date.now() + META_BUDGET_MS;
      const META_TIMED_OUT = Symbol('meta_timed_out');
      const raceMeta = <T,>(p: Promise<T>): Promise<T | typeof META_TIMED_OUT> =>
        Promise.race([
          p,
          new Promise<typeof META_TIMED_OUT>((resolve) =>
            setTimeout(() => resolve(META_TIMED_OUT), Math.max(0, metaDeadline - Date.now())),
          ),
        ]);

      // Fetch the page HTML ONCE up front. Both the metadata-extraction AI and
      // the full-text article scrape reuse this single fetch — neither triggers a
      // second network round-trip for the page itself.
      const prefetchedPagePromise = fetchPageHtml(url).catch(
        (): { html: string | null; ok: boolean; status: number } => ({ html: null, ok: false, status: 0 }),
      );

      // OVERLAP (interactive review only): kick off the slow full-text extraction
      // AS SOON AS the page HTML is available — concurrently with the metadata AI
      // below — instead of waiting until metadata finishes. By the time the
      // headline streams in, the article body is ready or nearly ready, so the
      // bullets (and the body-aware priority refinement) resolve much sooner.
      // This calls the SHARED scraper with its exact, unchanged behavior/timeouts;
      // only the ORDERING changes here. Social URLs keep their fast path (no
      // article scrape). Guarded so an orphaned scrape (e.g. on a meta timeout)
      // can never surface as an unhandled rejection.
      const articleScrapePromise: Promise<ScrapeResult> | null = isLikelySocialUrl
        ? null
        : prefetchedPagePromise.then((page) =>
            scrapeArticleText(url, page).catch((err): ScrapeResult => {
              console.error('[ReviewLink] Concurrent article scrape error:', err);
              return { fullText: '', success: false, error: 'scrape failed' };
            }),
          );

      const metaPhase = (async (): Promise<{
        analysis: Awaited<ReturnType<typeof analyzeSubmittedLink>>;
        prefetchedPage: { html: string | null; ok: boolean; status: number };
      }> => {
        const prefetchedPage = await prefetchedPagePromise;
        const analysis = await analyzeSubmittedLink(url, message || '', existingSubjectNames, prefetchedPage, { throwOnTransient: false, deadlineMs: metaDeadline });
        return { analysis, prefetchedPage };
      })();

      const metaOutcome = await raceMeta(metaPhase);

      if (metaOutcome === META_TIMED_OUT || !metaOutcome.analysis) {
        metaPhase.catch(() => {}); // orphaned work may settle later — swallow it
        // Auto-fill couldn't finish — keep the dialog usable for manual entry and
        // resolve every still-loading field to its default so nothing spins forever.
        writeEvent({
          type: 'metadata_error',
          error: 'Auto-fill could not finish — the link may be slow, paywalled, or blocking automated access. Fill in the details and post it manually.',
          timedOut: metaOutcome === META_TIMED_OUT,
        });
        writeEvent({ type: 'priority', priorityScore: 50, tags: [], timedOut: true });
        writeEvent({ type: 'bullets', summaryBullets: [], articleText: '', timedOut: true });
        writeEvent({
          type: 'classification',
          suggestedPrimaryTopic: null,
          suggestedConflictTrack: null,
          suggestedRegion: null,
          suggestedCountry: null,
          suggestedCountryPair: null,
          timedOut: true,
        });
        writeEvent({ type: 'done' });
        if (!clientGone && !res.writableEnded) res.end();
        return;
      }

      const { prefetchedPage } = metaOutcome;
      const analysis = metaOutcome.analysis!;

      // Metadata is ready — fill the headline / image / source / topic now.
      writeEvent({
        type: 'metadata',
        headline: analysis.headline,
        headlineGenerated: analysis.headlineGenerated,
        headlineSource: analysis.headlineSource,
        summary: analysis.summary,
        ogImageUrl: analysis.ogImageUrl,
        suggestedTopic: analysis.subject,
        sourceName: analysis.sourceName,
        sourceType: analysis.sourceType,
        publishedAt: analysis.publishedAt,
      });

      // (The full-text article scrape was already kicked off above, the moment the
      // page HTML was available — concurrently with the metadata AI.)

      // Run the two independent AI chains concurrently:
      //  - priority/tags scoring (depends only on the headline)
      //  - full-text scrape + 3-bullet summary (depends on the headline + text)
      // Each keeps its own error handling so one failure can't blow up the
      // whole review — failures fall back to the same defaults as before.
      const priorityPromise = (async (): Promise<{ priorityScore: number; tags: string[] }> => {
        try {
          const priorityAnalyses = await analyzeBatchHeadlines([analysis.headline]);
          if (priorityAnalyses.length > 0 && priorityAnalyses[0]) {
            return {
              priorityScore: priorityAnalyses[0].priority_score || 50,
              tags: priorityAnalyses[0].tags || [],
            };
          }
        } catch (priorityError) {
          console.error('[ReviewLink] Error calculating priority score:', priorityError);
        }
        return { priorityScore: 50, tags: [] };
      })();

      const bulletsPromise = (async (): Promise<{ summaryBullets: string[]; scrapedArticleText: string }> => {
        let summaryBullets: string[] = [];
        let scrapedArticleText = '';
        try {
          let bulletSourceText = '';
          let bulletSourceLabel: 'user-supplied text' | 'Article text' = 'Article text';

          if (userSuppliedText.length > 0) {
            bulletSourceText = userSuppliedText;
            bulletSourceLabel = 'user-supplied text';
          }

          // Reuse the overlapped article scrape for non-social URLs; social URLs
          // keep the exact shared social path as before. If the cheap check
          // disagreed with the AI's classification, fall back to scrapeContent so
          // behavior matches today.
          let scrapedContent: ScrapeResult;
          if (analysis.sourceType === 'social_media') {
            scrapedContent = await scrapeContent(url, analysis.sourceType, prefetchedPage);
          } else if (articleScrapePromise) {
            scrapedContent = await articleScrapePromise;
          } else {
            scrapedContent = await scrapeContent(url, analysis.sourceType, prefetchedPage);
          }

          if (scrapedContent.success && scrapedContent.fullText && scrapedContent.fullText.length >= 50) {
            scrapedArticleText = scrapedContent.fullText;
            if (!bulletSourceText) {
              bulletSourceText = scrapedContent.fullText;
            }
          }

          if (bulletSourceText) {
            const completion = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content: 'You are a military intelligence analyst. Generate exactly 3 concise bullet points summarizing this article. Each bullet must be 15 words or fewer. Bullet 1: What is the big change or announcement in this story. Bullet 2: What is the background context. Bullet 3: Any supplemental information. Always spell out publication, outlet, and organization names in full (e.g. "The Daily Wire" not "TDW", "The Wall Street Journal" not "WSJ", "Associated Press" not "AP"). Return only the 3 bullets, one per line, without bullet markers or numbering.'
                },
                {
                  role: 'user',
                  content: `Headline: ${analysis.headline}\n\n${bulletSourceLabel}:\n${bulletSourceText.slice(0, 3000)}`
                }
              ],
              max_tokens: 200,
              temperature: 0.3,
            });
            const responseText = completion.choices[0]?.message?.content || '';
            // Keep at most 3 bullets but do NOT hard-slice each to a fixed word
            // count — that chopped sentences mid-word in the detail view. Team
            // submissions can feed the Curated lane, so this path matters for the
            // Curated detail too. The prompt already keeps bullets concise.
            summaryBullets = responseText
              .split('\n')
              .map((line: string) => line.replace(/^[-•*\d.)\s]+/, '').trim())
              .filter((line: string) => line.length > 0)
              .slice(0, 3);
          }
        } catch (bulletError) {
          console.error('[ReviewLink] Error generating summary bullets:', bulletError);
        }
        return { summaryBullets, scrapedArticleText };
      })();

      // Curated classification suggestion (Task #336): the controlled-vocabulary
      // ENRICHMENT object (primary topic / conflict track / region / country) the
      // reviewer can accept ("Auto") or override. Runs CONCURRENTLY with
      // priority+bullets and is streamed as its own progressive event so it never
      // delays the dialog opening on the meta frame. These are suggestions for the
      // reviewer only — curated-lane enrichment; they never touch Main/Visual.
      const classificationPromise = (async (): Promise<{
        primaryTopic: string | null;
        conflictTrack: string | null;
        region: string | null;
        country: string | null;
        countryPair: string[] | null;
      } | null> => {
        try {
          const results = await analyzeCuratedBatch([analysis.headline]);
          const c = results?.[0];
          if (!c) return null;
          return {
            primaryTopic: c.primaryTopic ?? null,
            conflictTrack: c.conflictTrack ?? null,
            region: c.region ?? null,
            country: c.country ?? null,
            countryPair: c.countryPair ?? null,
          };
        } catch (classifyError) {
          console.error('[ReviewLink] Error computing classification suggestion:', classifyError);
          return null;
        }
      })();

      // --- Progressive enrichment streaming (NDJSON) ---
      // Headline/source/image are already streamed (the dialog is open); now
      // stream priority/tags, summary bullets, and the curated classification as
      // each finishes. An interactive-only budget guarantees the stream ends even
      // if the (shared, unchanged) scraper runs long — the dialog stays usable
      // meanwhile. This budget does NOT shorten any shared per-fetch/Playwright
      // timeout — the scrape keeps running; we just stop waiting on it for THIS
      // one interactive request.
      const REVIEW_TIME_BUDGET_MS = 20000;
      const deadline = Date.now() + REVIEW_TIME_BUDGET_MS;
      const TIMED_OUT = Symbol('timed_out');
      const withBudget = <T,>(p: Promise<T>): Promise<T | typeof TIMED_OUT> =>
        Promise.race([
          p,
          new Promise<typeof TIMED_OUT>((resolve) =>
            setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadline - Date.now()))
          ),
        ]);

      // PRIORITY (two-phase, body-aware): paint a fast HEADLINE-based score first
      // (no slower to first value than today), then — once the overlapped article
      // body is ready — refine it with the FULL story using the SAME analyzer
      // rubric/scale and stream an upgrade. If the body isn't ready within the
      // budget (or the link is social / has no usable body), the headline-based
      // score stands. The client quietly upgrades the displayed value unless the
      // reviewer already edited it.
      const priorityStream = (async () => {
        const headlineResult = await withBudget(priorityPromise);
        let baseTags: string[] = [];
        if (headlineResult === TIMED_OUT) {
          writeEvent({ type: 'priority', priorityScore: 50, tags: [], timedOut: true });
        } else {
          baseTags = headlineResult.tags;
          writeEvent({ type: 'priority', priorityScore: headlineResult.priorityScore, tags: baseTags });
        }

        // Body-aware refinement — non-social links with a usable article body only.
        if (!articleScrapePromise || analysis.sourceType === 'social_media') return;
        const refined = await withBudget((async () => {
          const scraped = await articleScrapePromise;
          if (!scraped.success || !scraped.fullText || scraped.fullText.length < 50) return null;
          return analyzeLinkPriorityWithBody(analysis.headline, scraped.fullText);
        })());
        if (refined && refined !== TIMED_OUT) {
          writeEvent({
            type: 'priority',
            priorityScore: refined.priority_score,
            tags: refined.tags && refined.tags.length ? refined.tags : baseTags,
            refined: true,
          });
        }
      })();

      const bulletsStream = withBudget(bulletsPromise).then((result) => {
        if (result === TIMED_OUT) {
          writeEvent({ type: 'bullets', summaryBullets: [], articleText: '', timedOut: true });
        } else {
          writeEvent({ type: 'bullets', summaryBullets: result.summaryBullets, articleText: result.scrapedArticleText });
        }
      });

      const classificationStream = withBudget(classificationPromise).then((result) => {
        if (result === TIMED_OUT || result === null) {
          writeEvent({
            type: 'classification',
            suggestedPrimaryTopic: null,
            suggestedConflictTrack: null,
            suggestedRegion: null,
            suggestedCountry: null,
            suggestedCountryPair: null,
            timedOut: result === TIMED_OUT,
          });
        } else {
          writeEvent({
            type: 'classification',
            suggestedPrimaryTopic: result.primaryTopic,
            suggestedConflictTrack: result.conflictTrack,
            suggestedRegion: result.region,
            suggestedCountry: result.country,
            suggestedCountryPair: result.countryPair,
          });
        }
      });

      await Promise.allSettled([priorityStream, bulletsStream, classificationStream]);
      writeEvent({ type: 'done' });
      if (!clientGone && !res.writableEnded) res.end();
    } catch (error: any) {
      console.error('[ReviewLink] Error:', error?.message || error);
      // If the stream already started, the dialog is already open with whatever
      // was delivered — just terminate the response cleanly.
      if (res.headersSent) {
        try { res.end(); } catch {}
        return;
      }
      // A transient provider blip (rate-limit / 5xx / network / open circuit) is
      // retryable: signal it with 503 so the client can re-attempt the IDENTICAL
      // request a few times before giving up. Genuine failures stay 500/422/400.
      if (isTransientAIError(error)) {
        return res.status(503).json({
          error: 'The AI service is briefly rate-limited. Please try again in a moment.',
          retryable: true,
        });
      }
      res.status(500).json({ error: `Failed to analyze link: ${error?.message || 'Unknown error'}` });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  });

  app.post("/api/team/chat", requireTeamMember, async (req: any, res) => {
    try {
      const { message, topicId, newTopicName, isQuestionable, isMataOsint, reviewData, idempotencyKey } = req.body;
      if (reviewData) {
        const schema = getSchemaReadiness();
        if (!schema.ready) {
          res.setHeader('Retry-After', '2');
          return res.status(503).json({
            error: 'Team reviewed saves are temporarily unavailable while database initialization completes',
            retryable: true,
          });
        }
      }
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: 'Message is required' });
      }
      
      // Sanitize HTML to prevent XSS attacks
      const sanitizedMessage = sanitizeHtml(message, chatSanitizeOptions);
      
      // Check if sanitized message is empty (only contained malicious content)
      const cleanText = sanitizedMessage.replace(/<[^>]*>/g, '').trim();
      if (cleanText.length === 0 && !sanitizedMessage.includes('<img')) {
        return res.status(400).json({ error: 'Message content is required' });
      }
      
      // Get user info from Replit auth claims
      const claims = req.user.claims;
      const userId = claims.sub;
      const userName = claims.first_name || claims.email?.split('@')[0] || 'User';
      const userProfileImage = claims.profile_image_url || null;
      
      const stableRequestId =
        reviewData && typeof idempotencyKey === 'string' && idempotencyKey.trim()
          ? idempotencyKey.trim().slice(0, 120)
          : null;
      const chatInsert = {
        userId,
        userName,
        userProfileImage,
        message: sanitizedMessage,
      };
      const chatResult = stableRequestId
        ? await storage.addChatMessageIdempotent({ ...chatInsert, clientRequestId: stableRequestId })
        : { message: await storage.addChatMessage(chatInsert), inserted: true };
      const chatMessage = chatResult.message;
      // A retry after response loss returns the original row and MUST NOT launch
      // the asynchronous submission/folder/MCOP side effects a second time.
      if (!chatResult.inserted) return res.json(chatMessage);
      
      // Detect URLs in the message and process them with AI (async, don't block response)
      // Extract URLs from both href attributes and plain text, then deduplicate.
      // Href-first ordering ensures canonical URLs take priority over HTML-mangled variants.
      const hrefRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
      const plainUrlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
      const hrefMatches: string[] = [];
      let hrefMatch;
      while ((hrefMatch = hrefRegex.exec(message)) !== null) {
        hrefMatches.push(hrefMatch[1]);
      }
      const plainMatches = message.replace(/<[^>]*>/g, '').match(plainUrlRegex) || [];
      const urls = [...new Set([...hrefMatches, ...plainMatches])];
      
      if (urls && urls.length > 0) {
        if (reviewData && typeof reviewData === 'object') {
          console.log(`[Team Chat] Received reviewData with headline: "${(reviewData as any).headline}"`);
        }
        // Process URLs asynchronously
        (async () => {
          try {
            const { analyzeSubmittedLink, analyzeBatchHeadlines } = await import('./aiAnalyzer');
            const { scrapeContent, scrapeXPostContent } = await import('./textScraper');
            const { FLASH_TOPIC_NAME, qualifiesForFlashTopStories, CJCS_TOPIC_NAME, MATA_OSINT_TOPIC_NAME, detectCJCSMention } = await import('./subjectMatcher');
            
            const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
            
            for (const url of urls) {
              console.log(`Processing submitted URL: ${url}`);
              
              // Check for duplicate URL
              const existingSubmission = await storage.getSubmissionByUrl(url);
              if (existingSubmission) {
                console.log(`Skipping duplicate URL: ${url}`);
                continue;
              }
              
              // If reviewData is present, use the pre-reviewed data path
              if (reviewData && typeof reviewData === 'object') {
                console.log(`[Team Chat] Using REVIEWED submission data for: ${url}`);
                
                const reviewSourceType = reviewData.sourceType || 'news';
                const reviewSourceName = reviewData.sourceName || 'News Source';
                
                const submission = await storage.addSubmission({
                  chatMessageId: chatMessage.id,
                  submittedBy: userId,
                  submittedByName: userName,
                  sourceType: reviewSourceType,
                  sourceUrl: url,
                  headline: reviewData.headline || 'Untitled',
                  summary: '',
                  status: 'processed',
                  isQuestionable: false,
                  isMataOsint: false,
                });
                
                // Resolve topic
                let subject;
                if (reviewData.topicId) {
                  const existingSubject = await storage.getSubjectById(reviewData.topicId);
                  subject = existingSubject || await storage.findOrCreateSubject('General', userId);
                } else if (reviewData.newTopicName && typeof reviewData.newTopicName === 'string' && reviewData.newTopicName.trim()) {
                  subject = await storage.createUserTopic(reviewData.newTopicName.trim(), userId);
                } else if (topicId) {
                  const existingSubject = await storage.getSubjectById(topicId);
                  subject = existingSubject || await storage.findOrCreateSubject('General', userId);
                } else if (newTopicName && typeof newTopicName === 'string' && newTopicName.trim()) {
                  subject = await storage.createUserTopic(newTopicName.trim(), userId);
                } else if (
                  reviewData.autoSubjectName &&
                  typeof reviewData.autoSubjectName === 'string' &&
                  reviewData.autoSubjectName.trim()
                ) {
                  // No human folder pick → AI auto-assigns the regional Subject
                  // from the review-time suggestion. findOrCreateSubject reuses an
                  // existing subject by name (no duplicate folders) and keeps the
                  // Team-page cards + public API working unchanged.
                  subject = await storage.findOrCreateSubject(reviewData.autoSubjectName.trim(), userId);
                } else {
                  subject = await storage.findOrCreateSubject('General', userId);
                }
                
                const reviewPriority = reviewData.priorityScore || 50;
                
                // Check FLASH
                let flashSubjectId: string | null = null;
                if (qualifiesForFlashTopStories(reviewPriority)) {
                  const flashSubject = await storage.getSubjectByName(FLASH_TOPIC_NAME);
                  if (flashSubject) flashSubjectId = flashSubject.id;
                }
                
                // Check CJCS mentions
                let cjcsSubjectId: string | null = null;
                const mentionsCJCS = await detectCJCSMention(reviewData.headline, '');
                if (mentionsCJCS) {
                  const cjcsSubject = await storage.getSubjectByName(CJCS_TOPIC_NAME);
                  if (cjcsSubject) cjcsSubjectId = cjcsSubject.id;
                }
                
                let fullText: string | undefined;
                if (reviewData.articleText && typeof reviewData.articleText === 'string' && reviewData.articleText.trim().length > 0) {
                  const providedText: string = reviewData.articleText.trim();
                  fullText = providedText;
                  console.log(`[Reviewed] Using user-provided article text (${providedText.length} chars)`);
                } else {
                  try {
                    const scrapedContent = await scrapeContent(url, 'news');
                    if (scrapedContent.success && scrapedContent.fullText) {
                      fullText = scrapedContent.fullText;
                    }
                  } catch (scrapeError) {
                    console.error('[Reviewed] Error scraping full text:', scrapeError);
                  }
                }
                
                // Finalize with user-reviewed data
                // skipAutoMCOP: true — the reviewed path below handles manual_submissions creation
                // with user-curated media (ogImageUrl, summaryBullets) that auto-MCOP would lose
                await storage.finalizeSubmissionAnalysis(submission.id, {
                  headline: reviewData.headline,
                  summary: '',
                  sourceType: reviewSourceType,
                  subjectId: subject.id,
                  sourceName: reviewSourceName,
                  publishedAt: null,
                  fullText,
                  priorityScore: reviewPriority,
                  flashSubjectId,
                  cjcsSubjectId,
                  mataOsintSubjectId: null,
                  skipAutoMCOP: true,
                });

                if (fullText && fullText.length > 100) {
                  storage.hasQuotesForStory(submission.id).then(has => {
                    if (!has) {
                      import('./quoteExtractor').then(({ extractQuotesFromArticle }) =>
                        extractQuotesFromArticle(submission.id, fullText!, url, null)
                          .then(quotes => quotes.length > 0 ? storage.insertArticleQuotes(quotes) : undefined)
                          .catch(err => console.error('[QuoteExtractor] Auto-extract error:', err))
                      );
                    }
                  });
                }
                
                // Auto-save user comment
                const messageTextOnly = message.replace(/<[^>]*>/g, '').replace(urlRegex, '').trim();
                if (messageTextOnly.length > 0) {
                  try {
                    await storage.addComment({
                      submissionId: submission.id,
                      userId,
                      userName,
                      text: messageTextOnly,
                    });
                  } catch (commentError) {
                    console.error('Error saving auto-comment:', commentError);
                  }
                }
                
                // Always create manual_submissions record for reviewed submissions
                // so Stream Manager has access to the photo and bullets
                const mcopEnabled = reviewData.mcopEnabled !== false;
                try {
                  // Targeted O(1) dedup instead of scanning every manual submission.
                  const existingManualSubmission = await storage.getManualSubmissionByUrl(url);
                  const urlExists = !!existingManualSubmission;
                  
                  if (!urlExists) {
                    const logLabel = mcopEnabled ? 'Auto-submitting to MCOP' : 'Creating Stream record (MCOP disabled by user)';
                    console.log(`[Team Chat Reviewed] ${logLabel}: "${reviewData.headline}"`);
                    
                    const manualSub = await storage.addManualSubmission({
                      title: reviewData.headline,
                      url: url,
                      category: 'Defense',
                      source: reviewSourceName || 'Team Submission',
                      summary: '',
                      submittedBy: `Team: ${userName}`,
                      priorityScore: reviewPriority,
                      tags: [subject.name],
                      pdfPath: null,
                      ogImageUrl: reviewData.ogImageUrl || null,
                      summaryBullets: reviewData.summaryBullets && reviewData.summaryBullets.length > 0 ? reviewData.summaryBullets : null,
                      mediaScrapedAt: new Date(),
                      // The reviewed flow carries no trusted publish signal
                      // (reviewData has no date field) — leave null so the UI
                      // honestly shows "First seen"; the boot-time backfill
                      // heals it from a bot copy of the same URL when one has
                      // a real published_at.
                      articlePublishedAt: null,
                    });
                    console.log(`[Team Chat Reviewed] Created submission with media (image: ${!!reviewData.ogImageUrl}, bullets: ${reviewData.summaryBullets?.length || 0})`);
                    
                    if (mcopEnabled) {
                      await storage.markTeamSubmissionAsMCOP(submission.id, userId);
                      console.log(`[Team Chat Reviewed] SUCCESS: Added to MCOP front page`);
                    }
                    // New manual_submission shapes Classic + Stream → drop their caches
                    invalidateMainFeeds();
                  }
                } catch (mcopError) {
                  console.error('[Team Chat Reviewed] Error creating submission:', mcopError);
                }

                // Curated classification override (Task #336). When the reviewer
                // picked a Primary Topic from the approved list, persist the full
                // controlled-vocabulary object to the URL-keyed curated overlay so
                // it FOLLOWS the item into the Curated lane and the gate-mode AI
                // never re-classifies it. CURATED-ONLY: this overlay is read only
                // by the curated path; Main/Visual/custom-MCOP never touch it.
                try {
                  const humanPrimaryTopic = coercePrimaryTopic(reviewData.primaryTopic);
                  if (humanPrimaryTopic) {
                    const humanConflictTrack = coerceConflictTrack(reviewData.conflictTrack);
                    const humanRegion = normalizeCountryLabel(
                      typeof reviewData.region === 'string' ? reviewData.region : null,
                    );
                    const humanCountry = normalizeCountryLabel(
                      typeof reviewData.country === 'string' ? reviewData.country : null,
                    );
                    // A reviewer overrides only the overarching BUCKET
                    // (primary_topic) + geography / conflict-track — NEVER the
                    // SPECIFIC card label (`category`), which the AI/submission
                    // supplies. Preserve any existing specific category + legacy
                    // audit so the manual bucket assignment can't blank or
                    // clobber the card's topic.
                    const priorMap = await storage.getCuratedClassificationsByUrls([url]);
                    const prior = priorMap.get(url);
                    const effRegion = humanRegion ?? prior?.region ?? null;
                    const effCountry = humanCountry ?? prior?.country ?? null;
                    await storage.upsertCuratedClassifications([{
                      url,
                      // `category` (the SPECIFIC card label) is NOT NULL. The
                      // reviewer only sets the bucket, so keep any existing
                      // specific label; when none exists yet fall back to the
                      // generic default — the card then shows the human bucket.
                      category: prior?.category ?? 'general',
                      region: effRegion,
                      country: effCountry,
                      primaryTopic: humanPrimaryTopic,
                      scope: deriveScope({ topicCountry: effCountry, region: effRegion }),
                      conflictTrack: humanConflictTrack ?? prior?.conflictTrack ?? null,
                      // The two-country Focus pair is AI-derived and carried from
                      // the review-time suggestion; fall back to any prior overlay
                      // value so it survives when the AI didn't propose a pair.
                      countryPair:
                        (Array.isArray(reviewData.countryPair) && reviewData.countryPair.length
                          ? reviewData.countryPair
                          : null) ?? prior?.countryPair ?? null,
                      legacyCategory: prior?.legacyCategory ?? null,
                      proposedTopic: prior?.proposedTopic ?? null,
                      // Reviewer override (Task #350) — PROTECTED. Stamping
                      // 'human' bars the bounded cluster-disagreement re-check
                      // from ever clearing this bucket.
                      provenance: 'human',
                    }]);
                    invalidateCuratedCache();
                    console.log(`[Team Chat Reviewed] Saved curated classification override: ${humanPrimaryTopic}${humanConflictTrack ? ` · ${humanConflictTrack}` : ''}`);
                  }
                } catch (classErr) {
                  console.error('[Team Chat Reviewed] Error saving classification override:', classErr);
                }

                console.log(`[Team Chat Reviewed] Successfully processed reviewed submission: ${reviewData.headline}`);
                continue;
              }
              
              // Standard (non-reviewed) path
              // Create pending submission
              const submission = await storage.addSubmission({
                chatMessageId: chatMessage.id,
                submittedBy: userId,
                submittedByName: userName,
                sourceType: 'news',
                sourceUrl: url,
                headline: 'Processing...',
                summary: 'AI is analyzing this submission...',
                status: 'pending',
                isQuestionable: isQuestionable === true,
                isMataOsint: isMataOsint === true,
              });
              
              // Get existing subjects to pass to AI
              const allSubjects = await storage.getAllSubjects();
              const existingSubjectNames = allSubjects.map(s => s.name);
              
              // For MATA/OSINT X.com posts, scrape the actual tweet content with Playwright
              let enrichedMessage = message;
              let scrapedXImageUrl: string | null = null;
              let scrapedXText: string | null = null;
              let scrapedXAuthor: string | null = null;
              const isXUrl = url.includes('x.com') || url.includes('twitter.com');
              if (isMataOsint && isXUrl) {
                try {
                  console.log(`[MATA/OSINT] Scraping X post content for: ${url}`);
                  const xContent = await scrapeXPostContent(url);
                  if (xContent.success && xContent.text) {
                    enrichedMessage = `[X Post by @${xContent.author}]: ${xContent.text}\n\nUser message: ${message}`;
                    scrapedXImageUrl = xContent.imageUrl;
                    scrapedXText = xContent.text;
                    scrapedXAuthor = xContent.author;
                    console.log(`[MATA/OSINT] Got ${xContent.text.length} chars from @${xContent.author}${xContent.imageUrl ? ' (with image)' : ''}`);
                  } else {
                    console.log(`[MATA/OSINT] Playwright scrape failed, falling back to normal analysis`);
                  }
                } catch (xScrapeError) {
                  console.error(`[MATA/OSINT] X post scrape error:`, xScrapeError);
                }
              }
              
              // Analyze with AI
              const analysis = await analyzeSubmittedLink(url, enrichedMessage, existingSubjectNames);
              
              if (analysis) {
                // Use user-selected topic if provided, otherwise use AI-assigned topic
                let subject;
                if (topicId) {
                  const existingSubject = await storage.getSubjectById(topicId);
                  subject = existingSubject || await storage.findOrCreateSubject(analysis.subject, userId);
                  console.log(`[Team Chat] User pre-selected topic: ${subject.name}`);
                } else if (newTopicName && typeof newTopicName === 'string' && newTopicName.trim()) {
                  subject = await storage.createUserTopic(newTopicName.trim(), userId);
                  console.log(`[Team Chat] User created new topic: ${subject.name}`);
                } else {
                  subject = await storage.findOrCreateSubject(analysis.subject, userId);
                }
                
                // Scrape full text content for MCOP Bot archive
                let fullText: string | undefined;
                try {
                  const scrapedContent = await scrapeContent(url, analysis.sourceType);
                  if (scrapedContent.success && scrapedContent.fullText) {
                    fullText = scrapedContent.fullText;
                    console.log(`Scraped ${fullText.length} characters of text for MCOP Bot archive`);
                  } else {
                    console.log(`Could not scrape full text: ${scrapedContent.error || 'No content'}`);
                  }
                } catch (scrapeError) {
                  console.error('Error scraping full text:', scrapeError);
                }
                
                // Run priority scoring using same logic as manual article submission
                let priorityScore = 0;
                let tags: string[] = [];
                try {
                  const priorityAnalyses = await analyzeBatchHeadlines([analysis.headline]);
                  if (priorityAnalyses.length > 0 && priorityAnalyses[0]) {
                    priorityScore = priorityAnalyses[0].priority_score || 0;
                    tags = priorityAnalyses[0].tags || [];
                    console.log(`[Team Chat] Priority score: ${priorityScore} for "${analysis.headline}"`);
                  }
                } catch (priorityError) {
                  console.error('Error calculating priority score:', priorityError);
                }
                
                // Check if this is a high-priority submission (66+) - skip for questionable sources
                let flashSubjectId: string | null = null;
                if (qualifiesForFlashTopStories(priorityScore) && !submission.isQuestionable) {
                  console.log(`[Team Chat] HIGH PRIORITY (${priorityScore}) - Adding to FLASH: TOP STORIES`);
                  const flashSubject = await storage.getSubjectByName(FLASH_TOPIC_NAME);
                  if (flashSubject) {
                    flashSubjectId = flashSubject.id;
                  }
                }
                
                // Check for CJCS (Chairman Caine) mentions
                let cjcsSubjectId: string | null = null;
                const mentionsCJCS = await detectCJCSMention(analysis.headline, analysis.summary);
                if (mentionsCJCS) {
                  console.log(`[Team Chat] CJCS MENTION DETECTED - Adding to CJCS MENTIONS`);
                  const cjcsSubject = await storage.getSubjectByName(CJCS_TOPIC_NAME);
                  if (cjcsSubject) {
                    cjcsSubjectId = cjcsSubject.id;
                  }
                }
                
                // Check if user flagged this as MATA/OSINT
                let mataOsintSubjectId: string | null = null;
                if (isMataOsint === true) {
                  console.log(`[Team Chat] MATA/OSINT flagged - Adding to MATA / OSINT SOCIAL MEDIA`);
                  const mataSubject = await storage.getSubjectByName(MATA_OSINT_TOPIC_NAME);
                  if (mataSubject) {
                    mataOsintSubjectId = mataSubject.id;
                  }
                }
                
                // For MATA/OSINT X posts with scraped text, use actual tweet content
                let finalHeadline = analysis.headline;
                let finalSummary = analysis.summary;
                let finalSourceName = analysis.sourceName;
                if (isMataOsint && scrapedXText) {
                  finalHeadline = scrapedXText;
                  finalSummary = '';
                  if (scrapedXAuthor) {
                    finalSourceName = `X/@${scrapedXAuthor}`;
                  }
                  console.log(`[MATA/OSINT] Using actual tweet text as headline/summary instead of AI summary`);
                }
                
                // Finalize submission with all analysis data including priority
                await storage.finalizeSubmissionAnalysis(submission.id, {
                  headline: finalHeadline,
                  summary: finalSummary,
                  sourceType: analysis.sourceType,
                  subjectId: subject.id,
                  sourceName: finalSourceName,
                  publishedAt: analysis.publishedAt,
                  fullText,
                  priorityScore,
                  flashSubjectId,
                  cjcsSubjectId,
                  mataOsintSubjectId,
                });

                if (fullText && fullText.length > 100) {
                  storage.hasQuotesForStory(submission.id).then(has => {
                    if (!has) {
                      import('./quoteExtractor').then(({ extractQuotesFromArticle }) =>
                        extractQuotesFromArticle(submission.id, fullText!, url, analysis.publishedAt)
                          .then(quotes => quotes.length > 0 ? storage.insertArticleQuotes(quotes) : undefined)
                          .catch(err => console.error('[QuoteExtractor] Auto-extract error:', err))
                      );
                    }
                  });
                }
                
                // If we scraped an X post image, store it in the chat message so it's visible and accessible for flight tracking
                if (scrapedXImageUrl && submission.chatMessageId) {
                  try {
                    const safeUrl = scrapedXImageUrl.replace(/[<>"']/g, '');
                    if (safeUrl.startsWith('https://pbs.twimg.com/')) {
                      const imgTag = `<img src="${safeUrl}" alt="X post image" style="max-width:100%;margin-top:8px;border-radius:8px;" />`;
                      const { teamChatMessages: tChatMessages } = await import('@shared/schema');
                      const [existingMsg] = await db.select().from(tChatMessages).where(eq(tChatMessages.id, submission.chatMessageId)).limit(1);
                      if (existingMsg) {
                        await db.update(tChatMessages).set({ message: existingMsg.message + imgTag }).where(eq(tChatMessages.id, submission.chatMessageId));
                        console.log(`[MATA/OSINT] Appended scraped X image to chat message`);
                      }
                    }
                  } catch (imgUpdateErr) {
                    console.error('[MATA/OSINT] Failed to append image to chat message:', imgUpdateErr);
                  }
                }
                
                console.log(`Successfully processed submission: ${analysis.headline}`);

                // Auto-save the user's chat message text as the first comment on this submission
                const messageTextOnly = message.replace(/<[^>]*>/g, '').replace(urlRegex, '').trim();
                if (messageTextOnly.length > 0) {
                  try {
                    await storage.addComment({
                      submissionId: submission.id,
                      userId,
                      userName,
                      text: messageTextOnly,
                    });
                    console.log(`[Team Chat] Saved user comment on submission: "${messageTextOnly.substring(0, 50)}..."`);
                  } catch (commentError) {
                    console.error('Error saving auto-comment:', commentError);
                  }
                }
                
                // Auto-submit high-priority NEWS articles to MCOP (like pressing MCOP button) - skip questionable sources
                if (qualifiesForFlashTopStories(priorityScore) && analysis.sourceType === 'news' && !submission.isQuestionable) {
                  try {
                    // Check if URL already exists in manual submissions
                    const existingManualSubmissions = await storage.getAllManualSubmissions();
                    const urlExists = existingManualSubmissions.some(s => s.url === url);
                    
                    if (!urlExists) {
                      console.log(`[Team Chat] Auto-submitting to MCOP: "${analysis.headline}"`);
                      
                      // Create manual submission from team submission data
                      await storage.addManualSubmission({
                        title: analysis.headline,
                        url: url,
                        category: 'Defense',
                        source: analysis.sourceName || 'Team Submission',
                        summary: analysis.summary,
                        submittedBy: `Team: ${userName}`,
                        priorityScore,
                        tags: tags.length > 0 ? tags : [analysis.subject],
                        pdfPath: null,
                        // Real publish date from the trusted link-analysis
                        // extraction (bounded in addManualSubmission); never
                        // fabricated from submit time.
                        articlePublishedAt: analysis.publishedAt ?? null,
                      });
                      
                      // Mark the team submission as MCOP-submitted
                      await storage.markTeamSubmissionAsMCOP(submission.id, userId);
                      // New manual_submission shapes Classic + Stream → drop their caches
                      invalidateMainFeeds();
                      
                      console.log(`[Team Chat] SUCCESS: Auto-submitted to MCOP primary feed`);
                    } else {
                      console.log(`[Team Chat] URL already in MCOP, skipping auto-submit`);
                    }
                  } catch (mcopError) {
                    console.error('[Team Chat] Error auto-submitting to MCOP:', mcopError);
                  }
                }
              } else {
                await storage.updateSubmissionStatus(submission.id, 'failed');
                console.log(`Failed to analyze submission for URL: ${url}`);
              }
            }
          } catch (error) {
            console.error('Error processing URLs:', error);
          }
        })();
      }
      
      res.json(chatMessage);
    } catch (error) {
      console.error('Error posting chat message:', error);
      res.status(500).json({ error: 'Failed to post chat message' });
    }
  });

  // Team Subjects API routes (requires Replit auth + Warfighter membership)
  app.get("/api/team/subjects", requireTeamMember, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const { active, archived } = await storage.getActiveAndArchivedSubjects(userId);
      res.json({ active, archived });
    } catch (error) {
      console.error('Error fetching subjects:', error);
      return res.status(500).json({ error: 'Failed to fetch subjects' });
    }
  });

  // Toggle submission read status
  app.post("/api/team/submissions/:id/read", requireTeamMember, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const submissionId = req.params.id;
      const isRead = await storage.toggleSubmissionRead(userId, submissionId);
      res.json({ isRead });
    } catch (error) {
      console.error('Error toggling read status:', error);
      return res.status(500).json({ error: 'Failed to toggle read status' });
    }
  });

  // Get comment counts for multiple submissions (batch) - must be before :id routes
  app.post("/api/team/submissions/comment-counts", requireTeamMember, async (req: any, res) => {
    try {
      const { submissionIds } = req.body;
      if (!Array.isArray(submissionIds)) {
        return res.status(400).json({ error: 'submissionIds array is required' });
      }
      const counts = await storage.getCommentCountsForSubmissions(submissionIds);
      res.json(counts);
    } catch (error) {
      console.error('Error fetching comment counts:', error);
      res.status(500).json({ error: 'Failed to fetch comment counts' });
    }
  });

  // Get comments for a submission
  app.get("/api/team/submissions/:id/comments", requireTeamMember, async (req: any, res) => {
    try {
      const comments = await storage.getCommentsForSubmission(req.params.id);
      res.json(comments);
    } catch (error) {
      console.error('Error fetching comments:', error);
      res.status(500).json({ error: 'Failed to fetch comments' });
    }
  });

  // Add a comment to a submission
  app.post("/api/team/submissions/:id/comments", requireTeamMember, async (req: any, res) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return res.status(400).json({ error: 'Comment text is required' });
      }
      const claims = req.user.claims;
      const comment = await storage.addComment({
        submissionId: req.params.id,
        userId: claims.sub,
        userName: claims.first_name || claims.email?.split('@')[0] || 'User',
        text: text.trim(),
      });
      res.json(comment);
    } catch (error) {
      console.error('Error adding comment:', error);
      res.status(500).json({ error: 'Failed to add comment' });
    }
  });

  // Delete a comment
  app.delete("/api/team/submissions/:id/comments/:commentId", requireTeamMember, async (req: any, res) => {
    try {
      await storage.deleteComment(req.params.commentId);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting comment:', error);
      res.status(500).json({ error: 'Failed to delete comment' });
    }
  });

  // Submit team submission to MCOP (primary news feed)
  app.post("/api/team/submissions/:id/mcop", requireTeamMember, async (req: any, res) => {
    try {
      const submissionId = req.params.id;
      const userName = req.user.claims.name || 'Team Member';
      
      // Get the team submission
      const teamSubmission = await storage.getTeamSubmissionById(submissionId);
      if (!teamSubmission) {
        return res.status(404).json({ error: 'Submission not found' });
      }
      
      // Only allow news articles (not social media posts)
      if (teamSubmission.sourceType === 'social_media') {
        return res.status(400).json({ error: 'Social media posts cannot be submitted to MCOP' });
      }
      
      // Block questionable sources from being submitted to MCOP
      if (teamSubmission.isQuestionable) {
        return res.status(400).json({ error: 'Questionable sources cannot be submitted to MCOP' });
      }
      
      // Check if this URL already exists in manual submissions to prevent duplicates
      const existingSubmissions = await storage.getAllManualSubmissions();
      const urlExists = existingSubmissions.some(s => s.url === teamSubmission.sourceUrl);
      if (urlExists) {
        return res.status(409).json({ error: 'This article has already been submitted to MCOP' });
      }
      
      console.log(`[MCOP Submit] Submitting team article to primary feed: "${teamSubmission.headline}"`);
      
      // Get the subject name if the submission has one assigned
      let subjectName: string | null = null;
      if (teamSubmission.subjectId) {
        const subject = await storage.getSubjectById(teamSubmission.subjectId);
        if (subject) {
          subjectName = subject.name;
        }
      }
      
      // Run AI analysis to get priority score and tags
      const analyses = await analyzeBatchHeadlines([teamSubmission.headline]);
      let priorityScore = 50;
      let tags: string[] = [];
      
      if (analyses.length > 0 && analyses[0]) {
        priorityScore = analyses[0].priority_score || 50;
        tags = analyses[0].tags || [];
        console.log(`[MCOP Submit] AI analysis: priority=${priorityScore}, tags=[${tags.join(', ')}]`);
      }
      
      // Add subject name to tags if available and not already present
      if (subjectName && !tags.some(t => t.toLowerCase() === subjectName.toLowerCase())) {
        tags = [subjectName, ...tags];
      }
      
      // Create manual submission from team submission data
      // Use the actual source name from the team submission, or indicate it came from team
      const manualSubmission = await storage.addManualSubmission({
        title: teamSubmission.headline,
        url: teamSubmission.sourceUrl,
        category: 'Defense',
        source: teamSubmission.sourceName || 'Team Submission',
        summary: teamSubmission.summary,
        submittedBy: `Team: ${userName}`,
        priorityScore,
        tags,
        pdfPath: null,
        // Carry the team submission's real publish date (RSS pubDate / trusted
        // extraction) into the main feed; bounded in addManualSubmission.
        articlePublishedAt: teamSubmission.publishedAt ?? null,
      });
      
      console.log(`[MCOP Submit] SUCCESS: Added to primary feed with ID ${manualSubmission.id}`);
      
      // Mark the team submission as MCOP-submitted
      const userId = req.user.claims.sub;
      await storage.markTeamSubmissionAsMCOP(submissionId, userId);
      
      // New manual_submission shapes Classic + Stream → drop their caches
      invalidateMainFeeds();
      res.json({ success: true, manualSubmission });
    } catch (error) {
      console.error('Error submitting to MCOP:', error);
      return res.status(500).json({ error: 'Failed to submit to MCOP' });
    }
  });

  // Update priority score for a team submission (global, not user-specific)
  app.patch("/api/team/submissions/:id/priority", requireTeamMember, async (req: any, res) => {
    try {
      const submissionId = req.params.id;
      const { priorityScore } = req.body;
      const userId = req.user?.claims?.sub || 'priority-system';
      const userName = req.user?.claims?.name || 'Team Member';
      
      if (typeof priorityScore !== 'number' || priorityScore < 0 || priorityScore > 100) {
        return res.status(400).json({ error: 'Priority score must be a number between 0 and 100' });
      }
      
      // Get submission BEFORE updating to check if it was already submitted
      const beforeUpdate = await storage.getTeamSubmissionById(submissionId);
      const wasAlreadyMCOP = beforeUpdate?.mcopSubmittedAt != null;
      
      const updated = await storage.updateSubmissionPriority(submissionId, priorityScore);
      
      if (!updated) {
        return res.status(404).json({ error: 'Submission not found' });
      }
      
      let mcopSubmitted = false;
      
      // If priority is 66+ and it's a news article that hasn't been submitted to MCOP yet,
      // actually create the headline record (not just mark as submitted) - skip questionable sources
      if (priorityScore >= 66 && updated.sourceType === 'news' && !wasAlreadyMCOP && !updated.isQuestionable) {
        try {
          // Check if this URL already exists in manual submissions to prevent duplicates
          const existingSubmissions = await storage.getAllManualSubmissions();
          const urlExists = existingSubmissions.some(s => s.url === updated.sourceUrl);
          
          if (!urlExists) {
            console.log(`[Priority] Auto-submitting to MCOP: "${updated.headline?.substring(0, 50)}..."`);
            
            // Get the subject name if the submission has one assigned
            let subjectName: string | null = null;
            if (updated.subjectId) {
              const subject = await storage.getSubjectById(updated.subjectId);
              if (subject) {
                subjectName = subject.name;
              }
            }
            
            // Use the priority score from the update and get tags from AI
            const analyses = await analyzeBatchHeadlines([updated.headline || '']);
            let tags: string[] = [];
            
            if (analyses.length > 0 && analyses[0]) {
              tags = analyses[0].tags || [];
            }
            
            // Add subject name to tags if available
            if (subjectName && !tags.some(t => t.toLowerCase() === subjectName!.toLowerCase())) {
              tags = [subjectName, ...tags];
            }
            
            // Create manual submission for the headline feed
            const manualSubmission = await storage.addManualSubmission({
              title: updated.headline || 'Untitled',
              url: updated.sourceUrl,
              category: 'Defense',
              source: updated.sourceName || 'Team Submission',
              summary: updated.summary || '',
              submittedBy: `Team: ${userName}`,
              priorityScore,
              tags,
              pdfPath: null,
              // Carry the team submission's real publish date (RSS pubDate /
              // trusted extraction); bounded in addManualSubmission.
              articlePublishedAt: updated.publishedAt ?? null,
            });
            
            // Mark the team submission as MCOP-submitted
            await storage.markTeamSubmissionAsMCOP(submissionId, userId);
            // New manual_submission shapes Classic + Stream → drop their caches
            invalidateMainFeeds();
            
            console.log(`[Priority] SUCCESS: Added to MCOP primary feed with ID ${manualSubmission.id}`);
            mcopSubmitted = true;
          } else {
            console.log(`[Priority] URL already in MCOP, skipping: ${updated.sourceUrl}`);
          }
        } catch (mcopError) {
          console.error('[Priority] Error auto-submitting to MCOP:', mcopError);
        }
      }
      
      // If story was already submitted to MCOP, propagate the priority change
      // to the manual_submissions record so it affects main page and Stream page
      if (wasAlreadyMCOP && updated.sourceUrl) {
        try {
          const { manualSubmissions: msTable } = await import('@shared/schema');
          const [existingMs] = await db.select({ id: msTable.id, priorityScore: msTable.priorityScore })
            .from(msTable).where(eq(msTable.url, updated.sourceUrl)).limit(1);
          if (existingMs) {
            await db.update(msTable).set({ priorityScore }).where(eq(msTable.id, existingMs.id));
            // Priority change on a live manual_submission shapes Classic + Stream
            invalidateMainFeeds();
            console.log(`[Priority] Updated MCOP manual_submission priority: ${existingMs.priorityScore} → ${priorityScore} for "${updated.headline?.substring(0, 50)}"`);
          }
        } catch (msError) {
          console.error('[Priority] Error updating MCOP priority:', msError);
        }
      }
      
      console.log(`[Priority] Updated submission ${submissionId} to priority ${priorityScore}`);
      res.json({ 
        success: true, 
        submission: updated,
        flashAssigned: priorityScore >= 66,
        mcopSubmitted
      });
    } catch (error) {
      console.error('Error updating priority score:', error);
      return res.status(500).json({ error: 'Failed to update priority score' });
    }
  });

  // Toggle questionable flag on a team submission
  app.patch("/api/team/submissions/:id/questionable", requireTeamMember, async (req: any, res) => {
    try {
      const submissionId = req.params.id;
      const { isQuestionable } = req.body;
      
      if (typeof isQuestionable !== 'boolean') {
        return res.status(400).json({ error: 'isQuestionable must be a boolean' });
      }
      
      const submission = await storage.getTeamSubmissionById(submissionId);
      if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
      }
      
      await storage.updateSubmissionQuestionable(submissionId, isQuestionable);
      
      console.log(`[Questionable] Submission ${submissionId} marked as ${isQuestionable ? 'questionable' : 'not questionable'}`);
      res.json({ success: true, isQuestionable });
    } catch (error) {
      console.error('Error toggling questionable flag:', error);
      return res.status(500).json({ error: 'Failed to update questionable status' });
    }
  });

  // Change a submission's topic
  app.patch("/api/team/submissions/:id/topic", requireTeamMember, async (req: any, res) => {
    try {
      const submissionId = req.params.id;
      const { topicId, newTopicName } = req.body;
      
      // Either topicId (existing topic) or newTopicName (create new) must be provided
      if (!topicId && !newTopicName) {
        return res.status(400).json({ error: 'Either topicId or newTopicName is required' });
      }
      
      const userId = req.user.claims.sub;
      let targetTopicId = topicId;
      let targetTopicName = '';
      
      // If creating a new topic
      if (newTopicName && typeof newTopicName === 'string' && newTopicName.trim().length > 0) {
        const trimmedName = newTopicName.trim();
        
        // Check if topic already exists
        const existing = await storage.getSubjectByName(trimmedName);
        if (existing) {
          targetTopicId = existing.id;
          targetTopicName = existing.name;
        } else {
          // Create new topic
          const newTopic = await storage.addSubject({
            name: trimmedName,
            description: null,
            origin: 'manual',
            createdBy: userId,
          });
          targetTopicId = newTopic.id;
          targetTopicName = newTopic.name;
          console.log(`[Topic] Created new topic: ${trimmedName}`);
        }
      } else {
        // Get topic name for logging
        const topic = await storage.getSubjectById(targetTopicId);
        if (!topic) {
          return res.status(404).json({ error: 'Topic not found' });
        }
        targetTopicName = topic.name;
      }
      
      // Update the submission's topic
      await storage.updateSubmissionStatus(submissionId, 'processed', targetTopicId);
      
      console.log(`[Topic] Changed submission ${submissionId} to topic "${targetTopicName}"`);
      res.json({ success: true, topicId: targetTopicId, topicName: targetTopicName });
    } catch (error) {
      console.error('Error changing submission topic:', error);
      return res.status(500).json({ error: 'Failed to change topic' });
    }
  });

  // Delete a submission (soft delete) and block bots from re-posting
  app.delete("/api/team/submissions/:id", requireTeamMember, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const submissionId = req.params.id;
      
      if (!submissionId || typeof submissionId !== 'string') {
        return res.status(400).json({ error: 'Invalid submission ID' });
      }
      
      const submission = await storage.getTeamSubmissionById(submissionId);
      if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
      }
      
      // Soft delete the submission and block bots from re-posting
      const deleted = await storage.softDeleteSubmission(submissionId, userId);
      
      if (!deleted) {
        return res.status(500).json({ error: 'Failed to delete submission' });
      }
      
      console.log(`[Delete] User ${userId} deleted submission: ${submission.headline?.substring(0, 50)}...`);
      res.json({ success: true, message: 'Submission deleted and blocked from bot re-posting' });
    } catch (error) {
      console.error('Error deleting submission:', error);
      return res.status(500).json({ error: 'Failed to delete submission' });
    }
  });

  // Mark a submission as Joe-emailed (without sending email - used when mailto draft is opened)
  app.post("/api/team/submissions/:id/joe-mark", requireTeamMember, async (req: any, res) => {
    try {
      const submissionId = req.params.id;
      if (!submissionId || typeof submissionId !== 'string') {
        return res.status(400).json({ error: 'Invalid submission ID' });
      }
      const userId = req.user.claims.sub;
      const updated = await storage.markSubmissionAsJoeEmailed(submissionId, userId);
      if (!updated) {
        return res.status(404).json({ error: 'Submission not found' });
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error('Error marking Joe email:', error);
      res.status(500).json({ error: 'Failed to mark submission' });
    }
  });

  // Send "Joe" email alert for a submission
  app.post("/api/team/submissions/:id/joe-email", requireTeamMember, async (req: any, res) => {
    try {
      const submissionId = req.params.id;
      if (!submissionId || typeof submissionId !== 'string') {
        return res.status(400).json({ error: 'Invalid submission ID' });
      }
      
      const submission = await storage.getTeamSubmissionById(submissionId);
      
      if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
      }
      
      // Import Resend client
      const { getUncachableResendClient } = await import('./resend');
      const { client: resend, fromEmail } = await getUncachableResendClient();
      
      // Helper to escape HTML entities for security
      const escapeHtml = (text: string): string => {
        return text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      };
      
      // Format the date
      const publishedDate = submission.publishedAt || submission.createdAt;
      const formattedDate = new Date(publishedDate).toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
      });
      
      // Escape user content for security
      const safeHeadline = escapeHtml(submission.headline);
      const safeSource = escapeHtml(submission.sourceName || 'Unknown Source');
      const safeSummary = escapeHtml(submission.summary || 'No summary available.');
      const safeUrl = encodeURI(submission.sourceUrl);
      
      // Build email subject
      const emailSubject = `MCOP Alert: ${safeHeadline} - ${safeSource}`;
      
      // Build email body (HTML)
      const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a365d; border-bottom: 2px solid #2563eb; padding-bottom: 10px;">MCOP Alert</h2>
          
          <div style="margin: 20px 0;">
            <h3 style="margin: 0 0 10px 0; color: #1e293b;">${safeHeadline}</h3>
            
            <p style="margin: 5px 0; color: #64748b;">
              <strong>Source:</strong> ${safeSource}
            </p>
            
            <p style="margin: 5px 0; color: #64748b;">
              <strong>Date/Time:</strong> ${formattedDate}
            </p>
            
            <p style="margin: 15px 0; color: #334155; line-height: 1.6;">
              <strong>Summary:</strong><br/>
              ${safeSummary}
            </p>
            
            <p style="margin: 20px 0;">
              <a href="${safeUrl}" 
                 style="display: inline-block; background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
                Read Full Article
              </a>
            </p>
          </div>
          
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
          
          <p style="color: #94a3b8; font-size: 12px;">
            This alert was sent from the Media Common Operating Picture (MCOP) system.
          </p>
        </div>
      `;
      
      // TO recipients
      const toRecipients = [
        'joseph.r.holstead.civ@mail.mil',
        'william.j.dixon60.civ@mail.mil'
      ];
      
      // CC recipients
      const ccRecipients = [
        'js.pentagon.ocjcs.list.joint-staff-public-affairs-all@mail.mil',
        'js.pentagon.ocjcs.mbx.public-affairs-media-analysis@mail.mil'
      ];
      
      // Send the email
      const result = await resend.emails.send({
        from: fromEmail,
        to: toRecipients,
        cc: ccRecipients,
        subject: emailSubject,
        html: emailBody,
      });
      
      // Mark submission as Joe emailed
      const userId = req.user.claims.sub;
      await storage.markSubmissionAsJoeEmailed(submissionId, userId);
      
      console.log(`[Joe Email] Sent MCOP Alert for submission ${submissionId}: "${submission.headline}"`);
      res.json({ success: true, messageId: result.data?.id });
    } catch (error: any) {
      console.error('Error sending Joe email:', error);
      const errorMessage = error?.message || error?.statusCode 
        ? `${error.statusCode || 500}: ${error.message || 'Unknown error'}` 
        : 'Failed to send email';
      return res.status(500).json({ error: errorMessage });
    }
  });

  app.post("/api/team/subjects", requireTeamMember, async (req: any, res) => {
    try {
      const { name, description } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Subject name is required' });
      }
      
      // Check if subject already exists
      const existing = await storage.getSubjectByName(name.trim());
      if (existing) {
        return res.status(409).json({ error: 'Subject already exists' });
      }
      
      const userId = req.user.claims.sub;
      const subject = await storage.addSubject({
        name: name.trim(),
        description: description?.trim() || null,
        origin: 'manual',
        createdBy: userId,
      });
      
      res.json(subject);
    } catch (error) {
      console.error('Error creating subject:', error);
      res.status(500).json({ error: 'Failed to create subject' });
    }
  });

  // Delete a subject and move its submissions to closest matching topic
  app.delete("/api/team/subjects/:id", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      // Get the subject first to check if it exists and is deletable
      const subject = await storage.getSubjectById(id);
      if (!subject) {
        return res.status(404).json({ error: 'Subject not found' });
      }
      
      // Prevent deletion of special topics
      if (subject.name === 'FLASH: TOP STORIES' || subject.name === 'MOST RECENT' || subject.name === 'CJCS MENTIONS') {
        return res.status(400).json({ error: `Cannot delete ${subject.name} topic` });
      }
      
      // Delete subject and move submissions to closest matching topic
      const result = await storage.deleteSubjectWithMode(id, 'move');
      
      if (!result.success) {
        return res.status(500).json({ error: 'Failed to delete subject' });
      }
      
      res.json({ 
        success: true, 
        message: `Topic deleted. ${result.movedCount || 0} items reassigned to related topics.`
      });
    } catch (error) {
      console.error('Error deleting subject:', error);
      res.status(500).json({ error: 'Failed to delete subject' });
    }
  });

  // Joe Priorities / BOLO - AI-powered topic creation
  app.post("/api/team/joe-priorities-bolo", requireTeamMember, async (req: any, res) => {
    try {
      const { text, category } = req.body;
      const topicId = (typeof req.body.topicId === 'string' && req.body.topicId.trim().length > 0)
        ? req.body.topicId.trim()
        : null;
      let isPriorityWatch = req.body.isPriorityWatch === true;
      let isBoloWatch = req.body.isBoloWatch === true;
      // Backward compatibility: legacy callers send only `category`.
      if (!isPriorityWatch && !isBoloWatch && category) {
        isPriorityWatch = category === 'joe_priority';
        isBoloWatch = category === 'bolo';
      }
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return res.status(400).json({ error: 'Text is required' });
      }
      if (!isPriorityWatch && !isBoloWatch) {
        return res.status(400).json({ error: 'Select Priority, BOLO, or both' });
      }

      const userId = req.user.claims.sub;
      // `category` is retained for backward compatibility; derive a primary value.
      const derivedCategory = isPriorityWatch ? 'joe_priority' : 'bolo';
      const behaviorLabel = isPriorityWatch && isBoloWatch
        ? 'Priority watch topics (rank higher in the feed) that are ALSO BOLO (must never be filtered out)'
        : isPriorityWatch
          ? "Joe's Priorities (topics to rank higher in the feed)"
          : 'BOLO (Be On the Lookout) topics that must never be filtered out as off-topic';

      if (!isAIConfigured()) {
        return res.status(503).json({
          error: 'AI is temporarily unavailable. Please try again in a moment.',
          reason: 'transient',
          retryable: true,
        });
      }

      const runAiCall = () => openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You extract specific topics/priorities from user text for a military intelligence platform.
The user is describing ${behaviorLabel} - these are specific areas of focus for military leadership.

Extract each distinct topic/priority as a short, clear name (2-6 words) with a brief description.
If the text contains multiple topics, extract each one separately.
If the text is a single topic or paragraph about one thing, extract just that one topic.

For each topic ALSO provide:
- "keywords": 4-10 lowercase distinctive terms/phrases that capture the SPECIFIC CONTEXT the user cares about (the angle, not generic filler words). Include the key actors, places, and the event/issue. These are used later to confirm an article is about this topic in the intended context, so prefer precise multi-word phrases over broad single words. Avoid stopwords.
- "estimatedDurationDays": an integer estimate of how long this topic will stay relevant. A specific dated event ~7-14, an active developing situation ~30-60, a standing strategic concern ~120-180.
- "focusArea": a short Title Case focus-area label (2-5 words) naming the narrower lens this topic falls under, e.g. "Indo-Pacific Deterrence", "Russia-Ukraine War", "Defense Industrial Base", "Nuclear Posture". This is a suggestion a human can later edit.

Return JSON: {"topics": [{"name": "Topic Name", "description": "Brief description of what to watch for", "keywords": ["term1", "term2"], "estimatedDurationDays": 30, "focusArea": "Focus Area"}]}

Examples:
- Input: "Watch for any news about China military buildup near Taiwan and Russian nuclear threats"
  Output: {"topics": [{"name": "China-Taiwan Military Buildup", "description": "Chinese military activity and buildup near Taiwan", "keywords": ["china", "taiwan", "pla", "taiwan strait", "military buildup", "invasion"], "estimatedDurationDays": 120, "focusArea": "Indo-Pacific Deterrence"}, {"name": "Russian Nuclear Threats", "description": "Russian nuclear posturing and threats", "keywords": ["russia", "nuclear", "putin", "warhead", "deterrence", "nuclear threat"], "estimatedDurationDays": 90, "focusArea": "Nuclear Posture"}]}
- Input: "Keep an eye on defense budget negotiations"
  Output: {"topics": [{"name": "Defense Budget Negotiations", "description": "Congressional defense budget and spending negotiations", "keywords": ["defense budget", "ndaa", "appropriations", "congress", "pentagon spending"], "estimatedDurationDays": 60, "focusArea": "Defense Industrial Base"}]}`
          },
          {
            role: 'user',
            content: text.trim()
          }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });

      // Bounded retry so a momentary provider blip (rate-limit / timeout /
      // network) — by far the most common failure here — recovers on a plain
      // re-try instead of collapsing into a generic error. Only TRANSIENT
      // errors are retried; genuine failures surface immediately. On exhausted
      // transience we return a distinct 503 the client shows as "AI is busy".
      const MAX_AI_ATTEMPTS = 3;
      let response: Awaited<ReturnType<typeof runAiCall>> | null = null;
      for (let attempt = 0; attempt < MAX_AI_ATTEMPTS; attempt++) {
        try {
          response = await runAiCall();
          break;
        } catch (aiErr) {
          if (!isTransientAIError(aiErr) || attempt === MAX_AI_ATTEMPTS - 1) {
            if (isTransientAIError(aiErr)) {
              console.warn('[WatchTopics] AI transient failure exhausted retries', aiErr);
              return res.status(503).json({
                error: 'AI is busy right now. Please try again in a moment.',
                reason: 'transient',
                retryable: true,
              });
            }
            throw aiErr;
          }
          const backoff = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
          console.warn(`[WatchTopics] AI transient failure, retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_AI_ATTEMPTS - 1})`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }

      const content = response?.choices[0]?.message?.content;
      // Tolerant parse: salvage a truncated / fence-wrapped reply instead of
      // letting JSON.parse throw into the catch-all generic 500. A null result
      // means the reply was genuinely unusable → "couldn't understand" (422).
      const parsed = parseAiJson<{ topics?: any[] }>(content);
      const topics = Array.isArray(parsed?.topics) ? parsed!.topics : [];

      if (topics.length === 0) {
        return res.status(422).json({
          error: "Couldn't understand that text. Try rephrasing what to watch for.",
          reason: 'could_not_extract',
          retryable: false,
        });
      }

      const sanitizeKeywords = (raw: any): string[] => {
        if (!Array.isArray(raw)) return [];
        const seen = new Set<string>();
        const out: string[] = [];
        for (const k of raw) {
          if (typeof k !== 'string') continue;
          const t = k.trim().toLowerCase();
          if (t.length < 2 || t.length > 60 || seen.has(t)) continue;
          seen.add(t);
          out.push(t);
          if (out.length >= 12) break;
        }
        return out;
      };
      const clampDuration = (raw: any): number | null => {
        const n = Math.round(Number(raw));
        if (!Number.isFinite(n) || n <= 0) return null;
        return Math.min(365, Math.max(1, n));
      };
      const sanitizeFocusArea = (raw: any): string | null => {
        if (typeof raw !== 'string') return null;
        const t = raw.trim();
        if (t.length < 2) return null;
        return t.slice(0, 80);
      };

      const existingSubjects = await storage.getAllSubjects();
      const maxPosition = existingSubjects
        .filter((s: any) => s.category === derivedCategory)
        .reduce((max: number, s: any) => Math.max(max, s.position || 0), 0);

      const createdSubjects = [];
      for (let i = 0; i < topics.length; i++) {
        const topic = topics[i];
        const keywords = sanitizeKeywords(topic.keywords);
        const durationDays = clampDuration(topic.estimatedDurationDays);
        const estimatedActiveUntil = durationDays ? new Date(Date.now() + durationDays * 86400000) : null;
        const focusArea = sanitizeFocusArea(topic.focusArea);

        const existing = await storage.getSubjectByName(topic.name);
        if (existing) {
          // Don't hijack a plain (non-watch) topic that happens to share a name.
          if (!existing.category && !existing.isPriorityWatch && !existing.isBoloWatch) {
            continue;
          }
          // Merge behavior flags + keywords onto the existing watch topic.
          const mergedKeywords = Array.from(new Set([...(existing.watchKeywords || []), ...keywords])).slice(0, 12);
          const updated = await storage.updateSubject(existing.id, {
            isPriorityWatch: existing.isPriorityWatch || isPriorityWatch,
            isBoloWatch: existing.isBoloWatch || isBoloWatch,
            watchKeywords: mergedKeywords,
            estimatedDurationDays: existing.estimatedDurationDays ?? durationDays,
            estimatedActiveUntil: existing.estimatedActiveUntil ?? estimatedActiveUntil,
            autoArchiveReason: null,
            isActive: true,
            category: (existing.category as 'joe_priority' | 'bolo' | null) || derivedCategory,
            // Apply the chosen Topic / AI focus area, but never clobber values a
            // human may have already set on an existing watch topic.
            topicId: existing.topicId ?? topicId,
            focusArea: existing.focusArea ?? focusArea,
          });
          createdSubjects.push(updated || existing);
          continue;
        }

        const subject = await storage.addSubject({
          name: topic.name,
          description: topic.description,
          origin: 'manual',
          createdBy: userId,
          category: derivedCategory,
          isPriorityWatch,
          isBoloWatch,
          watchKeywords: keywords,
          estimatedDurationDays: durationDays,
          estimatedActiveUntil,
          topicId,
          focusArea,
          position: maxPosition + i + 1,
          // Persist the raw user prompt so editors can see what was originally
          // requested. Trimmed to 1000 chars; falls back to body.sourcePrompt
          // if the caller supplied one explicitly (future: creation form field).
          sourcePrompt: ((typeof req.body.sourcePrompt === 'string' && req.body.sourcePrompt.trim()) || text.trim()).slice(0, 1000),
        });
        createdSubjects.push(subject);
      }

      console.log(`[WatchTopics] Created/updated ${createdSubjects.length} topics (priority=${isPriorityWatch}, bolo=${isBoloWatch}) from AI analysis`);
      res.json({ success: true, subjects: createdSubjects });
    } catch (error) {
      console.error('Error creating joe priorities/bolo:', error);
      if (isTransientAIError(error)) {
        return res.status(503).json({
          error: 'AI is busy right now. Please try again in a moment.',
          reason: 'transient',
          retryable: true,
        });
      }
      res.status(500).json({ error: 'Failed to create topics', reason: 'generic', retryable: false });
    }
  });

  // General-purpose PATCH for watch-topic detail fields (name, description,
  // keywords, lifecycle mode, boost strength, topic/focus, expiry).
  app.patch("/api/team/joe-priorities-bolo/:id", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      const subject = await storage.getSubjectById(id);
      if (!subject) return res.status(404).json({ error: 'Topic not found' });
      const isWatchTopic = subject.isPriorityWatch === true || subject.isBoloWatch === true
        || (!!subject.category && ['joe_priority', 'bolo'].includes(subject.category));
      if (!isWatchTopic) return res.status(400).json({ error: 'Not a watch topic' });

      const fields: Parameters<typeof storage.updateWatchTopicDetail>[1] = {};
      const b = req.body;
      if (typeof b.name === 'string' && b.name.trim().length > 0) fields.name = b.name.trim().slice(0, 200);
      if ('description' in b) fields.description = (typeof b.description === 'string' && b.description.trim().length > 0) ? b.description.trim().slice(0, 2000) : null;
      if ('watchTopicLabel' in b) fields.watchTopicLabel = (typeof b.watchTopicLabel === 'string' && b.watchTopicLabel.trim().length > 0) ? b.watchTopicLabel.trim().slice(0, 120) : null;
      if (typeof b.lifecycleMode === 'string' && ['smart_decay', 'hold'].includes(b.lifecycleMode)) fields.lifecycleMode = b.lifecycleMode;
      if (typeof b.boostStrength === 'string' && ['weak', 'standard', 'strong'].includes(b.boostStrength)) fields.boostStrength = b.boostStrength;
      if (Array.isArray(b.orKeywords)) fields.orKeywords = b.orKeywords.filter((k: any) => typeof k === 'string' && k.trim().length > 0).map((k: string) => k.trim().toLowerCase().slice(0, 100)).slice(0, 12);
      if (Array.isArray(b.andKeywords)) fields.andKeywords = b.andKeywords.filter((k: any) => typeof k === 'string' && k.trim().length > 0).map((k: string) => k.trim().toLowerCase().slice(0, 100)).slice(0, 12);
      if (Array.isArray(b.notKeywords)) fields.notKeywords = b.notKeywords.filter((k: any) => typeof k === 'string' && k.trim().length > 0).map((k: string) => k.trim().toLowerCase().slice(0, 100)).slice(0, 12);
      if ('topicId' in b) fields.topicId = (typeof b.topicId === 'string' && b.topicId.trim().length > 0) ? b.topicId.trim() : null;
      if ('focusArea' in b) fields.focusArea = (typeof b.focusArea === 'string' && b.focusArea.trim().length > 0) ? b.focusArea.trim().slice(0, 80) : null;
      if ('estimatedActiveUntil' in b) {
        fields.estimatedActiveUntil = b.estimatedActiveUntil ? new Date(b.estimatedActiveUntil) : null;
        if (fields.estimatedActiveUntil && isNaN(fields.estimatedActiveUntil.getTime())) fields.estimatedActiveUntil = undefined;
      }

      const updated = await storage.updateWatchTopicDetail(id, fields);
      res.json({ success: true, subject: updated });
    } catch (error) {
      console.error('Error updating watch topic detail:', error);
      res.status(500).json({ error: 'Failed to update topic' });
    }
  });

  // Get impact stats for a watch topic (match telemetry, ~30-day window).
  app.get("/api/team/joe-priorities-bolo/:id/stats", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      const subject = await storage.getSubjectById(id);
      if (!subject) return res.status(404).json({ error: 'Topic not found' });
      const stats = await storage.getWatchTopicStats(id);
      res.json(stats);
    } catch (error) {
      console.error('Error fetching watch topic stats:', error);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // Delete a Joe Priority / BOLO subject
  app.delete("/api/team/joe-priorities-bolo/:id", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      const subject = await storage.getSubjectById(id);
      if (!subject) {
        return res.status(404).json({ error: 'Subject not found' });
      }
      if (!subject.category || !['joe_priority', 'bolo'].includes(subject.category)) {
        return res.status(400).json({ error: 'Can only delete Joe Priority or BOLO subjects via this endpoint' });
      }

      await db.delete(teamSubjects).where(eq(teamSubjects.id, id));
      console.log(`[JoePriorities] Deleted ${subject.category} topic: "${subject.name}"`);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting joe priority/bolo:', error);
      res.status(500).json({ error: 'Failed to delete topic' });
    }
  });

  // Reorder Joe Priority / BOLO subjects
  app.patch("/api/team/joe-priorities-bolo/reorder", requireTeamMember, async (req: any, res) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'Items array is required' });
      }

      for (let i = 0; i < items.length; i++) {
        await db.update(teamSubjects)
          .set({ position: i })
          .where(eq(teamSubjects.id, items[i].id));
      }

      console.log(`[JoePriorities] Reordered ${items.length} topics`);
      res.json({ success: true });
    } catch (error) {
      console.error('Error reordering joe priorities/bolo:', error);
      res.status(500).json({ error: 'Failed to reorder topics' });
    }
  });

  // Archive a Joe Priority / BOLO subject (soft delete - moves to "Older Priorities")
  app.patch("/api/team/joe-priorities-bolo/:id/archive", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      const subject = await storage.getSubjectById(id);
      if (!subject) {
        return res.status(404).json({ error: 'Subject not found' });
      }
      if (!subject.category || !['joe_priority', 'bolo'].includes(subject.category)) {
        return res.status(400).json({ error: 'Can only archive Joe Priority or BOLO subjects via this endpoint' });
      }

      const updated = await storage.updateSubjectActiveStatus(id, false);
      console.log(`[JoePriorities] Archived ${subject.category} topic: "${subject.name}"`);
      res.json({ success: true, subject: updated });
    } catch (error) {
      console.error('Error archiving joe priority/bolo:', error);
      res.status(500).json({ error: 'Failed to archive topic' });
    }
  });

  // Restore an archived Joe Priority / BOLO subject
  app.patch("/api/team/joe-priorities-bolo/:id/restore", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      const subject = await storage.getSubjectById(id);
      if (!subject) {
        return res.status(404).json({ error: 'Subject not found' });
      }
      if (!subject.category || !['joe_priority', 'bolo'].includes(subject.category)) {
        return res.status(400).json({ error: 'Can only restore Joe Priority or BOLO subjects via this endpoint' });
      }

      const updated = await storage.updateSubjectActiveStatus(id, true);
      console.log(`[JoePriorities] Restored ${subject.category} topic: "${subject.name}"`);
      res.json({ success: true, subject: updated });
    } catch (error) {
      console.error('Error restoring joe priority/bolo:', error);
      res.status(500).json({ error: 'Failed to restore topic' });
    }
  });

  // Set/clear the Topic + Focus area classification on a Priority / BOLO topic.
  app.patch("/api/team/joe-priorities-bolo/:id/classification", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      const subject = await storage.getSubjectById(id);
      if (!subject) {
        return res.status(404).json({ error: 'Subject not found' });
      }
      const isWatchTopic = subject.isPriorityWatch === true || subject.isBoloWatch === true
        || (!!subject.category && ['joe_priority', 'bolo'].includes(subject.category));
      if (!isWatchTopic) {
        return res.status(400).json({ error: 'Can only classify Joe Priority or BOLO subjects via this endpoint' });
      }

      const fields: { topicId?: string | null; focusArea?: string | null } = {};
      if ('topicId' in req.body) {
        const raw = req.body.topicId;
        fields.topicId = (typeof raw === 'string' && raw.trim().length > 0) ? raw.trim() : null;
      }
      if ('focusArea' in req.body) {
        const raw = req.body.focusArea;
        fields.focusArea = (typeof raw === 'string' && raw.trim().length > 0) ? raw.trim().slice(0, 80) : null;
      }
      if (Object.keys(fields).length === 0) {
        return res.status(400).json({ error: 'Provide topicId and/or focusArea' });
      }

      const updated = await storage.updateSubject(id, fields);
      res.json({ success: true, subject: updated });
    } catch (error) {
      console.error('Error updating joe priority/bolo classification:', error);
      res.status(500).json({ error: 'Failed to update classification' });
    }
  });

  // Get Joe Priority / BOLO subjects with matched submissions
  app.get("/api/team/joe-priorities-bolo", requireTeamMember, async (req: any, res) => {
    try {
      const allSubjects = await storage.getAllSubjects();
      // Membership is driven by the behavior flags (so a "both" topic appears in
      // both lists). Legacy rows are covered by the migrate.ts backfill.
      const isPriority = (s: any) => s.isPriorityWatch === true || (s.isPriorityWatch == null && s.category === 'joe_priority');
      const isBolo = (s: any) => s.isBoloWatch === true || (s.isBoloWatch == null && s.category === 'bolo');
      const activeJoePriorities = allSubjects
        .filter((s: any) => isPriority(s) && s.isActive !== false)
        .sort((a: any, b: any) => (a.position || 0) - (b.position || 0));
      const archivedJoePriorities = allSubjects
        .filter((s: any) => isPriority(s) && s.isActive === false)
        .sort((a: any, b: any) => (a.position || 0) - (b.position || 0));
      const activeBoloItems = allSubjects
        .filter((s: any) => isBolo(s) && s.isActive !== false)
        .sort((a: any, b: any) => (a.position || 0) - (b.position || 0));
      const archivedBoloItems = allSubjects
        .filter((s: any) => isBolo(s) && s.isActive === false)
        .sort((a: any, b: any) => (a.position || 0) - (b.position || 0));

      // Bounded query: only submissions already linked to a Priority/BOLO topic,
      // within the last 30 days, selecting only the columns the panel renders.
      // This replaces the previous unbounded full-table scan (~63k rows, 252 MB).
      const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentSubmissions = await db
        .select({
          id: teamSubmissions.id,
          sourceUrl: teamSubmissions.sourceUrl,
          headline: teamSubmissions.headline,
          sourceName: teamSubmissions.sourceName,
          sourceType: teamSubmissions.sourceType,
          publishedAt: teamSubmissions.publishedAt,
          createdAt: teamSubmissions.createdAt,
          joePrioritySubjectId: teamSubmissions.joePrioritySubjectId,
        })
        .from(teamSubmissions)
        .where(and(
          eq(teamSubmissions.status, 'processed'),
          isNull(teamSubmissions.deletedAt),
          isNotNull(teamSubmissions.joePrioritySubjectId),
          gte(teamSubmissions.createdAt, THIRTY_DAYS_AGO),
        ))
        .orderBy(desc(teamSubmissions.createdAt));

      // Cheap aggregate for all-time total counts per topic — used for count
      // badges without shipping the full submission history.
      const totalCountRows = await db
        .select({
          subjectId: teamSubmissions.joePrioritySubjectId,
          count: sql<number>`count(*)::int`,
        })
        .from(teamSubmissions)
        .where(and(
          eq(teamSubmissions.status, 'processed'),
          isNull(teamSubmissions.deletedAt),
          isNotNull(teamSubmissions.joePrioritySubjectId),
        ))
        .groupBy(teamSubmissions.joePrioritySubjectId);

      const totalCountMap = new Map<string, number>(
        totalCountRows.map(r => [r.subjectId!, r.count])
      );

      const enhanceWithSubmissions = (subjects: any[]) => {
        return subjects.map(subject => {
          const submissions = recentSubmissions.filter(s => s.joePrioritySubjectId === subject.id);
          const totalCount = totalCountMap.get(subject.id) || 0;
          return { ...subject, submissions, totalCount };
        });
      };

      res.json({
        joePriorities: enhanceWithSubmissions(activeJoePriorities),
        archivedJoePriorities: enhanceWithSubmissions(archivedJoePriorities),
        boloItems: enhanceWithSubmissions(activeBoloItems),
        archivedBoloItems: enhanceWithSubmissions(archivedBoloItems),
      });
    } catch (error) {
      console.error('Error fetching joe priorities/bolo:', error);
      res.status(500).json({ error: 'Failed to fetch topics' });
    }
  });

  // Find existing articles similar to a pasted URL (watch-topic create flow).
  // Reuses the SSRF-guarded preview extractor; read-only, no writes.
  app.get("/api/team/watch-topics/similar", requireTeamMember, async (req: any, res) => {
    try {
      const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
      if (!url) return res.status(400).json({ error: 'url is required' });
      let parsedUrl: URL;
      try { parsedUrl = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return res.status(400).json({ error: 'Invalid URL' });
      }

      // Derive a title to search on via the SSRF-guarded preview helper; fall
      // back to the URL slug if the page can't be read.
      let title = '';
      try {
        const { extractArticlePreview } = await import('./streamPrefetch');
        const preview = await extractArticlePreview(url);
        title = (preview?.title || '').trim();
      } catch (e: any) {
        const msg = e?.message || '';
        if (msg.includes('not allowed')) {
          return res.status(400).json({ error: msg });
        }
      }
      if (!title) {
        title = decodeURIComponent(parsedUrl.pathname.split('/').filter(Boolean).pop() || '')
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/[-_]+/g, ' ')
          .trim();
      }

      const searchText = (title || parsedUrl.hostname).trim();
      if (!searchText) return res.json({ title: '', query: '', matches: [] });

      const results = await storage.unifiedNewsSearch(searchText, 100);
      const matches = results
        .map((r: any) => ({
          id: r.id,
          title: r.title,
          displayTitle: cleanDisplayTitle(r.title || ''),
          source: r.source,
          url: r.url,
          publishedAt: r.date ?? null,
          similarity: Math.round(calculateSimilarity(title || searchText, r.title || '') * 100) / 100,
        }))
        .filter((r: any) => r.similarity >= 0.35)
        .sort((a: any, b: any) => b.similarity - a.similarity)
        .slice(0, 8);

      res.json({ title, query: searchText, matches });
    } catch (error) {
      console.error('Error finding similar articles for watch topic:', error);
      res.status(500).json({ error: 'Failed to find similar articles' });
    }
  });

  // Team Submissions API routes (requires Replit auth + Warfighter membership)
  app.get("/api/team/submissions", requireTeamMember, async (req: any, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const submissions = await storage.getRecentSubmissions(limit);
      res.json(submissions);
    } catch (error) {
      console.error('Error fetching submissions:', error);
      res.status(500).json({ error: 'Failed to fetch submissions' });
    }
  });

  // Get all available topics (for dropdown/UI)
  app.get("/api/team/topics", requireTeamMember, async (req: any, res) => {
    try {
      const topics = await storage.getAllSubjects();
      res.json(topics);
    } catch (error) {
      console.error('Error fetching topics:', error);
      res.status(500).json({ error: 'Failed to fetch topics' });
    }
  });

  // Get active and inactive topics for management UI
  app.get("/api/team/topics/manage", requireTeamMember, async (req: any, res) => {
    try {
      const activeTopics = await storage.getActiveSubjects();
      const inactiveTopics = await storage.getInactiveSubjects();
      res.json({ active: activeTopics, inactive: inactiveTopics });
    } catch (error) {
      console.error('Error fetching topics for management:', error);
      res.status(500).json({ error: 'Failed to fetch topics' });
    }
  });

  // Reorder topics (bulk update positions and active status)
  app.patch("/api/team/topics/reorder", requireTeamMember, async (req: any, res) => {
    try {
      const { updates } = req.body;
      if (!Array.isArray(updates)) {
        return res.status(400).json({ error: 'Updates array is required' });
      }
      
      await storage.reorderSubjects(updates);
      res.json({ success: true });
    } catch (error) {
      console.error('Error reordering topics:', error);
      res.status(500).json({ error: 'Failed to reorder topics' });
    }
  });

  // Toggle topic active status
  app.patch("/api/team/topics/:id/status", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;
      
      if (typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive boolean is required' });
      }
      
      const updated = await storage.updateSubjectActiveStatus(id, isActive);
      if (!updated) {
        return res.status(404).json({ error: 'Topic not found' });
      }
      
      res.json(updated);
    } catch (error) {
      console.error('Error updating topic status:', error);
      res.status(500).json({ error: 'Failed to update topic status' });
    }
  });

  // Delete topic with mode: 'delete' (remove submissions) or 'move' (relocate submissions)
  app.delete("/api/team/topics/:id", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { mode } = req.body;
      
      if (mode !== 'delete' && mode !== 'move') {
        return res.status(400).json({ error: 'Mode must be "delete" or "move"' });
      }
      
      const result = await storage.deleteSubjectWithMode(id, mode);
      if (!result.success) {
        return res.status(404).json({ error: 'Topic not found' });
      }
      
      res.json(result);
    } catch (error) {
      console.error('Error deleting topic:', error);
      res.status(500).json({ error: 'Failed to delete topic' });
    }
  });

  // Recategorize all existing submissions into predefined topics
  app.post("/api/team/recategorize", requireTeamMember, async (req: any, res) => {
    try {
      console.log('[Recategorize] Starting recategorization of all submissions...');
      
      // Get all submissions
      const submissions = await storage.getRecentSubmissions(1000);
      const topics = await storage.getAllSubjects();
      
      // Find the "Emerging" topic as fallback
      const emergingTopic = topics.find(t => t.name === 'Emerging');
      if (!emergingTopic) {
        return res.status(500).json({ error: 'Emerging topic not found - please restart server to seed topics' });
      }
      
      let recategorized = 0;
      const { matchOrCreateSubject } = await import('./subjectMatcher');
      
      for (const submission of submissions) {
        try {
          const result = await matchOrCreateSubject(
            submission.headline,
            submission.summary,
            'Recategorize'
          );
          
          // Find the topic by name
          const topic = topics.find(t => t.name === result.subjectName) || emergingTopic;
          
          // Update the submission's topic
          await storage.updateSubmissionStatus(submission.id, 'processed', topic.id);
          recategorized++;
          
          console.log(`[Recategorize] ${submission.headline.substring(0, 50)}... -> ${topic.name}`);
        } catch (err) {
          console.error(`[Recategorize] Error for submission ${submission.id}:`, err);
        }
      }
      
      console.log(`[Recategorize] Complete: ${recategorized} submissions recategorized`);
      res.json({ success: true, recategorized });
    } catch (error) {
      console.error('Error recategorizing:', error);
      res.status(500).json({ error: 'Failed to recategorize submissions' });
    }
  });

  // MCOP Bot API endpoint - AI answers questions about team submissions (open to all users)
  app.post("/api/team/mcopBot", async (req: any, res) => {
    try {
      const { query, curatedContext } = req.body;
      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({ error: 'Query is required' });
      }

      // Dynamically import the mcopBot module
      const { answerQuestion } = await import('./newsbot');

      // Curated-view awareness (Task #819 expansion): when the client is on the
      // Curated view it sends curatedContext:true. The SERVER — not the client —
      // decides whether to grant curated access: only a viewer who passes
      // resolveCuratedAccess().canView gets the curated tool + safety prompt.
      // Otherwise the bot silently runs in normal (shared-archive) mode; access
      // is never leaked as an error. Fail-closed.
      let curatedProvider: (() => Promise<any[]>) | undefined;
      if (curatedContext === true) {
        try {
          const { canView } = await resolveCuratedAccess(req);
          if (canView) {
            const { formatCuratedStoriesForModel } = await import('./mcopBotCurated');
            curatedProvider = async () => {
              // Reuse the SAME prewarmed top-stories cache entry the Curated view
              // itself serves from (built by buildTopStoriesPayload) — no extra
              // heavy rebuild, and the bot sees exactly what the user sees.
              const cacheKey = `top-stories:${TOP_STORIES_DEFAULT_HOURS}:${TOP_STORIES_DEFAULT_LIMIT}`;
              let payload = getCuratedCache(req, cacheKey);
              if (!payload) {
                payload = await buildTopStoriesPayload(TOP_STORIES_DEFAULT_HOURS, TOP_STORIES_DEFAULT_LIMIT);
                setCuratedCache(cacheKey, payload, TOP_STORIES_CACHE_TTL_MS);
              }
              return formatCuratedStoriesForModel(payload);
            };
          }
        } catch (e) {
          // Access resolution failure → fail closed to normal mode (no leak).
          console.error('[MCOPBot] curated access resolution failed:', e);
        }
      }

      const answer = await answerQuestion(query.trim(), { curatedProvider });

      res.json({ answer });
    } catch (error) {
      console.error('Error in MCOP Bot:', error);
      res.status(500).json({ error: 'Failed to process query' });
    }
  });

  // Total count of items across all 16 archive source tables MCOP Bot can search.
  // Cached for 5 minutes — 16 count(*) queries shouldn't run on every dialog open.
  let mcopBotArchiveCountCache: { total: number; at: number } | null = null;
  const MCOP_BOT_COUNT_TTL_MS = 5 * 60 * 1000;
  app.get("/api/team/mcopBot/archive-count", async (_req, res) => {
    try {
      const now = Date.now();
      if (mcopBotArchiveCountCache && (now - mcopBotArchiveCountCache.at) < MCOP_BOT_COUNT_TTL_MS) {
        return res.json({ total: mcopBotArchiveCountCache.total, cachedAt: mcopBotArchiveCountCache.at });
      }
      const { listSourcesInWindow } = await import('./mcopBotArchive');
      const counts = await listSourcesInWindow();
      const total = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
      mcopBotArchiveCountCache = { total, at: now };
      res.json({ total, cachedAt: now });
    } catch (error) {
      console.error('Error counting MCOP Bot archive:', error);
      res.status(500).json({ error: 'Failed to count archive' });
    }
  });

  // News Scrub endpoint - generates a Word document summary of news in a time period
  app.post("/api/team/news-scrub", requireTeamMember, async (req: any, res) => {
    try {
      // Check for OpenAI API key
      if (!isAIConfigured()) {
        return res.status(500).json({ error: 'OpenAI API key not configured' });
      }
      
      const { fromDate, toDate, boloTopics } = req.body;
      
      if (!fromDate || !toDate) {
        return res.status(400).json({ error: 'From and To dates are required' });
      }
      
      const from = new Date(fromDate);
      const to = new Date(toDate);
      
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        return res.status(400).json({ error: 'Invalid date format' });
      }
      
      // Dynamically import the news scrub generator
      const { generateNewsScrub } = await import('./newsScrubGenerator');
      const docBuffer = await generateNewsScrub(from, to, boloTopics || '');
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', 'attachment; filename="News_Scrub.docx"');
      res.send(docBuffer);
    } catch (error) {
      console.error('Error generating News Scrub:', error);
      res.status(500).json({ error: 'Failed to generate News Scrub' });
    }
  });

  // Step 1 of the news-scrub upload: hand the browser a presigned URL so it can
  // PUT the PDF directly to object storage. This bypasses the app server (and the
  // production edge proxy's request-body size limit, which was returning a 403
  // before the request ever reached Express for large scrub PDFs).
  app.post("/api/team/daily-news-scrub/upload-url", requireTeamMember, async (_req: any, res) => {
    try {
      const objectStorageService = new ObjectStorageService();
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      res.json({ uploadURL });
    } catch (error) {
      console.error('Error creating daily news scrub upload URL:', error);
      res.status(500).json({ error: 'Failed to create upload URL' });
    }
  });

  // Step 2: the browser reports the uploaded object so we can record it. Only
  // small JSON metadata travels through the app server here — never the PDF bytes.
  app.post("/api/team/daily-news-scrub", requireTeamMember, async (req: any, res) => {
    try {
      const { uploadURL, filename, caoDate } = req.body || {};
      if (!uploadURL || typeof uploadURL !== 'string') {
        return res.status(400).json({ error: 'uploadURL is required' });
      }
      if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'filename is required' });
      }
      if (!caoDate) {
        return res.status(400).json({ error: 'CAO date is required' });
      }
      const cao = new Date(caoDate);
      if (isNaN(cao.getTime())) {
        return res.status(400).json({ error: 'Invalid CAO date format' });
      }

      const objectStorageService = new ObjectStorageService();
      const storagePath = objectStorageService.normalizeObjectEntityPath(uploadURL);
      // Only accept freshly-issued presigned upload keys (/objects/uploads/<uuid>).
      // This prevents a team user from pointing a scrub record at an arbitrary
      // existing private object and exposing it via the download surface.
      if (!/^\/objects\/uploads\/[0-9a-f-]{36}$/.test(storagePath)) {
        return res.status(400).json({ error: 'Invalid upload path' });
      }

      // Validate the uploaded object is a real PDF (magic bytes) by reading just
      // the first few bytes from storage — keeps this request fast.
      let objectFile;
      try {
        objectFile = await objectStorageService.getObjectEntityFile(storagePath);
        const [head] = await objectFile.download({ start: 0, end: 7 });
        const pdfMagicBytes = Buffer.from([0x25, 0x50, 0x44, 0x46]);
        if (!head.subarray(0, 4).equals(pdfMagicBytes)) {
          return res.status(400).json({ error: 'Invalid PDF file format' });
        }
      } catch (e) {
        console.error('Error validating uploaded scrub PDF:', e);
        return res.status(400).json({ error: 'Uploaded file could not be read from storage' });
      }

      const [record] = await db.insert(dailyNewsScrubs).values({
        filename,
        storagePath,
        caoDate: cao,
        uploadedBy: req.user?.claims?.email || req.user?.claims?.name || req.session?.username || 'Unknown',
        htmlContent: null,
      }).returning();

      // Respond immediately — the file is stored and the record exists. The
      // formatted HTML is generated in the background so the request never blocks
      // on the slow PDF parse + OpenAI call.
      res.json(record);

      void (async () => {
        try {
          const [pdfBuffer] = await objectFile.download();
          const { PDFParse } = await import('pdf-parse');
          const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
          const pdfData = await parser.getText();
          const pdfText = pdfData.text;

          if (!pdfText || pdfText.length <= 100 || !isAIConfigured()) {
            return;
          }


          const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: `You are a military intelligence document formatter. Convert the provided News Scrub text into clean, well-structured HTML for display in a web application. Follow these rules:
- Output ONLY the inner HTML content (no <html>, <head>, <body>, or <style> tags)
- Use semantic HTML: <h1> for the document title, <h2> for major sections (BLUF, IE Highlights, GLOBAL IE, PENTAGON/NATSEC, DOMESTIC OPERATIONS, etc.), <h3> for sub-sections and story headlines
- Use <p> for paragraphs, <ul>/<li> for bullet points
- Use <strong> for emphasis on key terms, source names, and important data points
- Use <blockquote> for direct quotes
- Add CSS classes for styling: "bluf-section" for the BLUF, "section-header" for major sections, "story-card" for individual stories, "source-tag" for reporting outlet names, "social-media-note" for social media analysis sections
- Preserve all factual content exactly as written - do not add, remove, or modify any information
- Structure stories cleanly with headline, key information bullets, and source attribution
- Make the document scannable with clear visual hierarchy`
              },
              {
                role: 'user',
                content: pdfText.substring(0, 15000)
              }
            ],
            max_tokens: 8000,
            temperature: 0.1,
          });

          const htmlContent = completion.choices[0]?.message?.content || null;
          if (htmlContent) {
            await db.update(dailyNewsScrubs)
              .set({ htmlContent })
              .where(eq(dailyNewsScrubs.id, record.id));
          }
        } catch (htmlError) {
          console.error('Error generating HTML from PDF (non-fatal):', htmlError);
        }
      })();
    } catch (error) {
      console.error('Error recording daily news scrub:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to record daily news scrub' });
      }
    }
  });

  app.get("/api/daily-news-scrub/latest", requireTeamOrUserAuth, async (_req: any, res) => {
    try {
      const [latest] = await db.select().from(dailyNewsScrubs).orderBy(desc(dailyNewsScrubs.createdAt)).limit(1);
      if (!latest) {
        return res.status(404).json({ error: 'No daily news scrub found' });
      }
      res.json({ id: latest.id, caoDate: latest.caoDate, filename: latest.filename, hasHtml: !!latest.htmlContent });
    } catch (error) {
      console.error('Error fetching latest daily news scrub:', error);
      res.status(500).json({ error: 'Failed to fetch latest daily news scrub' });
    }
  });

  app.get("/api/daily-news-scrub/:id/html", requireTeamOrUserAuth, async (req: any, res) => {
    try {
      const [scrub] = await db.select().from(dailyNewsScrubs).where(eq(dailyNewsScrubs.id, req.params.id));
      if (!scrub) {
        return res.status(404).json({ error: 'Daily news scrub not found' });
      }
      if (!scrub.htmlContent) {
        return res.status(404).json({ error: 'No formatted content available for this scrub' });
      }
      res.json({ htmlContent: scrub.htmlContent });
    } catch (error) {
      console.error('Error fetching scrub HTML:', error);
      res.status(500).json({ error: 'Failed to fetch scrub HTML' });
    }
  });

  app.get("/api/daily-news-scrub/archive", requireTeamMember, async (_req: any, res) => {
    try {
      const archive = await db.select().from(dailyNewsScrubs).orderBy(desc(dailyNewsScrubs.caoDate));
      res.json(archive);
    } catch (error) {
      console.error('Error fetching daily news scrub archive:', error);
      res.status(500).json({ error: 'Failed to fetch archive' });
    }
  });

  app.get("/api/daily-news-scrub/:id/download", requireTeamOrUserAuth, async (req: any, res) => {
    try {
      const [scrub] = await db.select().from(dailyNewsScrubs).where(eq(dailyNewsScrubs.id, req.params.id));
      if (!scrub) {
        return res.status(404).json({ error: 'Daily news scrub not found' });
      }
      const objectStorageService = new ObjectStorageService();
      const objectFile = await objectStorageService.getObjectEntityFile(scrub.storagePath);
      res.setHeader('Content-Type', 'application/pdf');
      const disposition = req.query.inline === 'true' ? 'inline' : 'attachment';
      res.setHeader('Content-Disposition', `${disposition}; filename="${scrub.filename}"`);
      objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      console.error('Error downloading daily news scrub:', error);
      res.status(500).json({ error: 'Failed to download daily news scrub' });
    }
  });

  // === SMS Alert Subscribers ===
  app.get("/api/sms-alerts/status", requireTeamMember, async (_req: any, res) => {
    const { isTwilioConfigured, isSmsConfigured, getSmsMode } = await import("./twilioService");
    const { getBridgeStatus } = await import("./smsBridge");
    const { getSmsHealthVerdict } = await import("./smsAlertMonitor");
    const mode = getSmsMode();
    const pendingCount = await db.select({ count: sql`count(*)` }).from(smsQueue).where(and(eq(smsQueue.status, "pending"), eq(smsQueue.direction, "outbound")));
    const bridge = await getBridgeStatus();
    let health: { color: string; reasons: string[] } = { color: "green", reasons: [] };
    try { health = await getSmsHealthVerdict(); } catch (err) { console.error("[SMS] Health verdict error:", err); }
    res.json({
      configured: isSmsConfigured(),
      twilioConfigured: isTwilioConfigured(),
      mode,
      termuxQueuePending: Number(pendingCount[0]?.count ?? 0),
      bridge,
      health,
    });
  });

  // Lightweight health poll — same verdict as the full status endpoint but
  // without the bridge detail, so the Team-page button can poll cheaply.
  app.get("/api/sms-alerts/health", requireTeamMember, async (_req: any, res) => {
    const { getSmsHealthVerdict } = await import("./smsAlertMonitor");
    try {
      const verdict = await getSmsHealthVerdict();
      res.json(verdict);
    } catch (err) {
      console.error("[SMS] Health endpoint error:", err);
      res.json({ color: "green", reasons: [] });
    }
  });

  app.post("/api/sms-alerts/mode", requireTeamMember, async (req: any, res) => {
    const { mode } = req.body;
    if (mode !== "twilio" && mode !== "termux") {
      return res.status(400).json({ error: "Mode must be 'twilio' or 'termux'" });
    }
    const { setSmsMode } = await import("./twilioService");
    setSmsMode(mode);
    res.json({ mode });
  });

  // Manual failover override for the Termux bridge phones: 'auto' lets the
  // failover controller decide, 'primary'/'backup' force a device.
  app.post("/api/sms-alerts/bridge-override", requireTeamMember, async (req: any, res) => {
    const { mode } = req.body;
    if (mode !== "auto" && mode !== "primary" && mode !== "backup") {
      return res.status(400).json({ error: "Mode must be 'auto', 'primary', or 'backup'" });
    }
    try {
      const { setBridgeOverride, getBridgeStatus } = await import("./smsBridge");
      await setBridgeOverride(mode);
      res.json({ ok: true, bridge: await getBridgeStatus() });
    } catch (error) {
      console.error("[SMS-Bridge] Error setting override:", error);
      res.status(500).json({ error: "Failed to set bridge override" });
    }
  });

  app.get("/api/sms-subscribers", requireTeamMember, async (_req: any, res) => {
    try {
      const subscribers = await db.select().from(smsAlertSubscribers).orderBy(desc(smsAlertSubscribers.createdAt));
      res.json(subscribers);
    } catch (error) {
      console.error("Error fetching SMS subscribers:", error);
      res.status(500).json({ error: "Failed to fetch subscribers" });
    }
  });

  app.post("/api/sms-subscribers", requireTeamMember, async (req: any, res) => {
    try {
      const { name, phoneNumber } = req.body;
      if (!name || !phoneNumber) {
        return res.status(400).json({ error: "Name and phone number are required" });
      }
      let normalized = phoneNumber.replace(/[\s\-\(\)]/g, "");
      if (!normalized.startsWith("+")) {
        normalized = "+1" + normalized;
      }
      if (!/^\+\d{10,15}$/.test(normalized)) {
        return res.status(400).json({ error: "Invalid phone number format. Use E.164 format (e.g., +15551234567)" });
      }
      const [subscriber] = await db.insert(smsAlertSubscribers).values({
        name,
        phoneNumber: normalized,
      }).returning();
      res.json(subscriber);
    } catch (error: any) {
      if (error?.message?.includes("unique") || error?.code === "23505") {
        return res.status(409).json({ error: "This phone number is already subscribed" });
      }
      console.error("Error adding SMS subscriber:", error);
      res.status(500).json({ error: "Failed to add subscriber" });
    }
  });

  app.patch("/api/sms-subscribers/:id", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      const updates: any = {};
      if (req.body.name !== undefined) updates.name = req.body.name;
      if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;
      if (req.body.phoneNumber !== undefined) {
        let normalized = req.body.phoneNumber.replace(/[\s\-\(\)]/g, "");
        if (!normalized.startsWith("+")) normalized = "+1" + normalized;
        if (!/^\+\d{10,15}$/.test(normalized)) {
          return res.status(400).json({ error: "Invalid phone number format" });
        }
        updates.phoneNumber = normalized;
      }
      const [updated] = await db.update(smsAlertSubscribers).set(updates).where(eq(smsAlertSubscribers.id, id)).returning();
      if (!updated) return res.status(404).json({ error: "Subscriber not found" });
      res.json(updated);
    } catch (error) {
      console.error("Error updating SMS subscriber:", error);
      res.status(500).json({ error: "Failed to update subscriber" });
    }
  });

  app.delete("/api/sms-subscribers/:id", requireTeamMember, async (req: any, res) => {
    try {
      const [deleted] = await db.delete(smsAlertSubscribers).where(eq(smsAlertSubscribers.id, req.params.id)).returning();
      if (!deleted) return res.status(404).json({ error: "Subscriber not found" });
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting SMS subscriber:", error);
      res.status(500).json({ error: "Failed to delete subscriber" });
    }
  });

  // Custom ad-hoc message to subscribers (Task #1073). Recipients are either
  // all active subscribers or an explicit subset of subscriber IDs; sends go
  // through the existing per-number path so Twilio/Termux mode is inherited.
  app.post("/api/sms-alerts/custom-message", requireTeamMember, async (req: any, res) => {
    try {
      const { message, recipientIds } = req.body ?? {};
      const trimmed = typeof message === "string" ? message.trim() : "";
      if (!trimmed) {
        return res.status(400).json({ error: "Message cannot be empty" });
      }
      if (trimmed.length > 1200) {
        return res.status(400).json({ error: "Message too long (max 1200 characters)" });
      }
      if (recipientIds !== undefined && !Array.isArray(recipientIds)) {
        return res.status(400).json({ error: "recipientIds must be an array of subscriber IDs" });
      }

      const activeSubscribers = await db.select().from(smsAlertSubscribers).where(eq(smsAlertSubscribers.isActive, true));
      let recipients = activeSubscribers;
      if (Array.isArray(recipientIds)) {
        const wanted = new Set(recipientIds.map(String));
        if (wanted.size === 0) {
          return res.status(400).json({ error: "No recipients selected" });
        }
        recipients = activeSubscribers.filter((s) => wanted.has(s.id));
        const foundIds = new Set(recipients.map((s) => s.id));
        const missing = Array.from(wanted).filter((id) => !foundIds.has(id));
        if (missing.length > 0) {
          return res.status(400).json({ error: "Some selected recipients are not active subscribers" });
        }
      }
      if (recipients.length === 0) {
        return res.status(400).json({ error: "No active subscribers to send to" });
      }

      const { sendCustomSms, getSmsMode } = await import("./twilioService");
      const results = await sendCustomSms(
        trimmed,
        recipients.map((s) => ({ id: s.id, name: s.name, phoneNumber: s.phoneNumber })),
      );
      const mode = getSmsMode();
      res.json({
        mode,
        total: results.length,
        sent: results.filter((r) => r.success && !r.queued).length,
        queued: results.filter((r) => r.success && r.queued).length,
        failed: results.filter((r) => !r.success).length,
        results,
      });
    } catch (error) {
      console.error("Error sending custom SMS:", error);
      res.status(500).json({ error: "Failed to send custom message" });
    }
  });

  app.post("/api/sms-subscribers/test", requireTeamMember, async (req: any, res) => {
    try {
      const { phoneNumber } = req.body;
      if (!phoneNumber) return res.status(400).json({ error: "Phone number is required" });
      let normalized = phoneNumber.replace(/[\s\-\(\)]/g, "");
      if (!normalized.startsWith("+")) normalized = "+1" + normalized;
      if (!/^\+\d{10,15}$/.test(normalized)) {
        return res.status(400).json({ error: "Invalid phone number format" });
      }
      const { sendTestSms, getSmsMode } = await import("./twilioService");
      const result = await sendTestSms(normalized);
      const mode = getSmsMode();
      if (mode === "termux" && result.success) {
        return res.json({ success: true, note: "Message queued for Termux delivery" });
      }
      res.json(result);
    } catch (error) {
      console.error("Error sending test SMS:", error);
      res.status(500).json({ error: "Failed to send test SMS" });
    }
  });

  // Briefing Card endpoint - generates a Word document with priority stories for military leadership
  app.post("/api/team/briefing-card", requireTeamMember, async (req: any, res) => {
    try {
      const { fromDate, toDate, bolo, sections } = req.body;
      
      if (!fromDate || !toDate) {
        return res.status(400).json({ error: 'From and To dates are required' });
      }
      
      const from = new Date(fromDate);
      const to = new Date(toDate);
      
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        return res.status(400).json({ error: 'Invalid date format' });
      }
      
      // Dynamically import the briefing card generator
      const { generateBriefingCard } = await import('./briefingCardGenerator');
      const docBuffer = await generateBriefingCard(from, to, bolo, sections);
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', 'attachment; filename="Briefing_Card.docx"');
      res.send(docBuffer);
    } catch (error) {
      console.error('Error generating Briefing Card:', error);
      res.status(500).json({ error: 'Failed to generate Briefing Card' });
    }
  });

  // Briefing Card HTML endpoint for print functionality
  app.post("/api/team/briefing-card/html", requireTeamMember, async (req: any, res) => {
    try {
      const { fromDate, toDate, bolo, sections } = req.body;
      
      if (!fromDate || !toDate) {
        return res.status(400).json({ error: 'From and To dates are required' });
      }
      
      const from = new Date(fromDate);
      const to = new Date(toDate);
      
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        return res.status(400).json({ error: 'Invalid date format' });
      }
      
      const { generateBriefingCardHtml } = await import('./briefingCardGenerator');
      const html = await generateBriefingCardHtml(from, to, bolo, sections);
      
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      console.error('Error generating Briefing Card HTML:', error);
      res.status(500).json({ error: 'Failed to generate Briefing Card for print' });
    }
  });

  app.post("/api/webhooks/truth-social-relay", async (req, res) => {
    try {
      const apiKey = req.headers['x-api-key'] as string;
      const configuredKey = process.env.TRUTH_RELAY_API_KEY;
      if (!configuredKey || !apiKey || apiKey !== configuredKey) {
        console.warn('[Relay] Unauthorized request — invalid or missing API key');
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const body = req.body;
      console.log(`[Relay] Raw incoming body: ${JSON.stringify(body).slice(0, 2000)}`);

      if (process.env.TRUTH_RELAY_PAUSED === 'true') {
        console.log('[Relay] PAUSED — skipping post processing and heartbeat');
        return res.status(200).json({ status: 'paused', heartbeat: false, received: 0, new: 0, message: 'Relay is paused — posts not processed' });
      }

      updateRelayHeartbeat();

      const posts = extractPostsFromBody(body);

      if (posts.length === 0) {
        console.warn('[Relay] Could not extract any posts from body (heartbeat still updated)');
        return res.status(200).json({ status: 'ok', heartbeat: true, received: 0, new: 0 });
      }

      console.log(`[Relay] Extracted ${posts.length} post(s) from relay`);

      let newCount = 0;
      let dupeCount = 0;
      let promotedCount = 0;
      const postsNeedingImageAnalysis: Array<{ postId: string; imageUrl: string | null | undefined; content: string }> = [];

      for (const { normalized, rawPayload } of posts) {
        const existingRelay = await storage.getRelayTruthSocialPostByPostId(normalized.postId);
        if (existingRelay) {
          dupeCount++;
          const filteredImg = filterTruthSocialPostImage(normalized.content, normalized.imageUrl);
          if (filteredImg) {
            if (!existingRelay.imageUrl) {
              await storage.updateRelayTruthSocialPostMedia(existingRelay.id, { imageUrl: filteredImg });
            }
            const mainPost = await storage.getTruthSocialPostByPostId(normalized.postId);
            if (mainPost && !mainPost.imageUrl) {
              await storage.updateTruthSocialPostImage(mainPost.id, filteredImg);
              console.log(`[Relay] Enriched image for existing main post ${normalized.postId}`);
            }
          }
          continue;
        }

        await storage.addRelayTruthSocialPost({
          postId: normalized.postId,
          content: normalized.content,
          postedAt: normalized.postedAt,
          truthSocialUrl: normalized.truthSocialUrl,
          imageUrl: filterTruthSocialPostImage(normalized.content, normalized.imageUrl),
          videoUrl: normalized.videoUrl || null,
          videoThumbnailUrl: normalized.videoThumbnailUrl || null,
          isReblog: normalized.isReblog || false,
          rebloggedFrom: normalized.rebloggedFrom || null,
          rawPayload: rawPayload,
        });
        newCount++;

        const attachmentOnly = isAttachmentOnlySocialContent(normalized.content);
        const filteredImageUrl = filterTruthSocialPostImage(normalized.content, normalized.imageUrl);

        let existingMain = await storage.getTruthSocialPostByPostId(normalized.postId);

        // Bridge-wins dedup: if a scraper-sourced row for the same Truth Social
        // post already exists (matched by canonical truthSocialUrl), claim it
        // and overwrite with the bridge's cleaner content/media instead of
        // inserting a duplicate row.
        let claimedScraperRow = false;
        if (!existingMain && normalized.truthSocialUrl) {
          const scraperRow = await storage.getTruthSocialPostByTruthSocialUrl(normalized.truthSocialUrl);
          if (scraperRow && scraperRow.postId !== normalized.postId) {
            // Also overwrite postId with the bridge's canonical Truth Social
            // snowflake so subsequent lookups by bridge postId (admin backfill,
            // repeat relay enrichment) find this row.
            const update: Partial<InsertTruthSocialPost> = {
              postId: normalized.postId,
              content: normalized.content,
              postedAt: normalized.postedAt,
              isReblog: normalized.isReblog || false,
              rebloggedFrom: normalized.rebloggedFrom || null,
            };
            if (filteredImageUrl) update.imageUrl = filteredImageUrl;
            if (normalized.videoUrl) update.videoUrl = normalized.videoUrl;
            if (normalized.videoThumbnailUrl) update.videoThumbnailUrl = normalized.videoThumbnailUrl;
            try {
              await storage.updateTruthSocialPost(scraperRow.id, update);
              console.log(`[Relay] CLAIMED scraper row ${scraperRow.postId} -> ${normalized.postId} (bridge wins)`);
              existingMain = { ...scraperRow, ...update } as TruthSocialPost;
              claimedScraperRow = true;

              if (filteredImageUrl && !scraperRow.extractedImageText) {
                postsNeedingImageAnalysis.push({
                  postId: normalized.postId,
                  imageUrl: filteredImageUrl,
                  content: normalized.content,
                });
              }
            } catch (claimErr: any) {
              // If a concurrent insert already created the bridge row (unique
              // constraint on postId), fall through to the existing-main path.
              if (claimErr?.code === '23505') {
                console.log(`[Relay] Claim race for ${normalized.postId} — bridge row already exists, falling through`);
                existingMain = await storage.getTruthSocialPostByPostId(normalized.postId);
              } else {
                throw claimErr;
              }
            }
          }
        }

        if (!existingMain) {
          try {
            await storage.addTruthSocialPost({
              postId: normalized.postId,
              content: normalized.content,
              postedAt: normalized.postedAt,
              truthSocialUrl: normalized.truthSocialUrl,
              imageUrl: filteredImageUrl,
              videoUrl: normalized.videoUrl || null,
              videoThumbnailUrl: normalized.videoThumbnailUrl || null,
              isReblog: normalized.isReblog || false,
              rebloggedFrom: normalized.rebloggedFrom || null,
            });
            promotedCount++;
            console.log(`[Relay] Promoted post ${normalized.postId} to main truth_social_posts`);

            if (filteredImageUrl) {
              postsNeedingImageAnalysis.push({
                postId: normalized.postId,
                imageUrl: filteredImageUrl,
                content: normalized.content,
              });
            }

            const postAge = Date.now() - new Date(normalized.postedAt).getTime();
            if (postAge < 60 * 60 * 1000) {
              sendPOTUSAlert({
                content: normalized.content,
                postedAt: normalized.postedAt,
                truthSocialUrl: normalized.truthSocialUrl,
                imageUrl: filteredImageUrl,
                extractedImageText: null,
                isReblog: normalized.isReblog,
                rebloggedFrom: normalized.rebloggedFrom,
              }).catch(err => console.error('[Relay] POTUS alert fire-and-forget error:', err));
            }
          } catch (promoteErr: any) {
            if (promoteErr?.code === '23505') {
              console.log(`[Relay] Post ${normalized.postId} already in main table (unique constraint)`);
            } else {
              console.error(`[Relay] Error promoting post ${normalized.postId}:`, promoteErr);
            }
          }
        } else if (!claimedScraperRow) {
          if (!existingMain.imageUrl && filteredImageUrl) {
            await storage.updateTruthSocialPostImage(existingMain.id, filteredImageUrl);
            console.log(`[Relay] Updated image for existing main post ${normalized.postId}`);
          }
        }
      }

      console.log(`[Relay] Processed: ${newCount} new, ${dupeCount} duplicates, ${promotedCount} promoted to main`);

      if (postsNeedingImageAnalysis.length > 0) {
        processPostImages(
          postsNeedingImageAnalysis.filter(p => p.imageUrl).map(p => ({
            postId: p.postId,
            imageUrl: p.imageUrl!,
            content: p.content,
          }))
        ).then(async (extractedTexts) => {
          for (const [postId, text] of extractedTexts.entries()) {
            const post = await storage.getTruthSocialPostByPostId(postId);
            if (post) {
              await storage.updateTruthSocialPostExtractedText(post.id, text);
              console.log(`[Relay] Extracted image text for post ${postId}`);
            }
          }
        }).catch(err => console.error('[Relay] Image text extraction error:', err));
      }

      res.json({ status: 'ok', received: posts.length, new: newCount, duplicates: dupeCount, promoted: promotedCount });
    } catch (error) {
      console.error('[Relay] Error processing relay webhook:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get("/api/admin/relay-status", requireAdmin, async (req, res) => {
    const heartbeat = getRelayHeartbeat();
    const healthy = isRelayHealthy();
    const ageSec = heartbeat > 0 ? Math.round((Date.now() - heartbeat) / 1000) : null;
    res.json({
      relayHealthy: healthy,
      lastHeartbeat: heartbeat > 0 ? new Date(heartbeat).toISOString() : null,
      lastHeartbeatAgeSeconds: ageSec,
      scraperMode: healthy ? 'WATCHDOG' : 'PRIMARY',
    });
  });

  app.get("/api/team/relay-status", requireTeamMember, async (req: any, res) => {
    const heartbeat = getRelayHeartbeat();
    const healthy = isRelayHealthy();
    const ageSec = heartbeat > 0 ? Math.round((Date.now() - heartbeat) / 1000) : null;
    res.json({
      relayHealthy: healthy,
      lastHeartbeat: heartbeat > 0 ? new Date(heartbeat).toISOString() : null,
      lastHeartbeatAgeSeconds: ageSec,
      scraperMode: healthy ? 'WATCHDOG' : 'PRIMARY',
    });
  });

  // ==========================================================================
  // X / Twitter relay ("Evangelist Vortex" / EV). Mirrors the Truth Social relay
  // webhook: external service POSTs tweet batches here, we authenticate, update
  // the in-memory heartbeat, then route each post to its lane table by handle.
  // The Playwright scrapers stay as automatic per-lane fallback (dedup-by-postId
  // makes them backfill-only while the relay is healthy).
  // ==========================================================================
  app.post("/api/webhooks/x-relay", async (req, res) => {
    try {
      const apiKey = req.headers['x-api-key'] as string;
      const configuredKey = process.env.EV_RELAY_API_KEY;
      if (!configuredKey || !apiKey || apiKey !== configuredKey) {
        console.warn('[X-Relay] Unauthorized request — invalid or missing API key');
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const body = req.body;
      console.log(`[X-Relay] Raw incoming body: ${JSON.stringify(body).slice(0, 2000)}`);

      if (process.env.X_RELAY_PAUSED === 'true') {
        console.log('[X-Relay] PAUSED — skipping post processing and heartbeat');
        return res.status(200).json({ status: 'paused', heartbeat: false, received: 0, new: 0, message: 'Relay is paused — posts not processed' });
      }

      updateXRelayHeartbeat();

      const rawPosts = extractXRelayPosts(body);
      if (rawPosts.length === 0) {
        console.warn('[X-Relay] Could not extract any posts from body (heartbeat still updated)');
        return res.status(200).json({ status: 'ok', heartbeat: true, received: 0, new: 0 });
      }

      let inserted = 0;
      let duplicates = 0;
      let unknown = 0;
      let errors = 0;
      let invalid = 0;

      for (const raw of rawPosts) {
        const normalized = normalizeXRelayPost(raw);
        if (!normalized) {
          invalid++;
          continue;
        }
        const result = await routeXRelayPost(storage, normalized);
        if (result === 'inserted') inserted++;
        else if (result === 'duplicate') duplicates++;
        else if (result === 'unknown-handle') unknown++;
        else errors++;
      }

      console.log(`[X-Relay] Processed: ${inserted} new, ${duplicates} duplicates, ${unknown} unknown-handle, ${invalid} invalid, ${errors} errors (of ${rawPosts.length})`);
      res.json({ status: 'ok', received: rawPosts.length, new: inserted, duplicates, unknownHandle: unknown, invalid, errors });
    } catch (error) {
      console.error('[X-Relay] Error processing relay webhook:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get("/api/admin/x-relay-status", requireAdmin, async (req, res) => {
    const heartbeat = getXRelayHeartbeat();
    const healthy = isXRelayHealthy();
    const ageSec = heartbeat > 0 ? Math.round((Date.now() - heartbeat) / 1000) : null;
    res.json({
      relayHealthy: healthy,
      lastHeartbeat: heartbeat > 0 ? new Date(heartbeat).toISOString() : null,
      lastHeartbeatAgeSeconds: ageSec,
      scraperMode: healthy ? 'WATCHDOG' : 'PRIMARY',
    });
  });

  app.get("/api/team/x-relay-status", requireTeamMember, async (req: any, res) => {
    const heartbeat = getXRelayHeartbeat();
    const healthy = isXRelayHealthy();
    const ageSec = heartbeat > 0 ? Math.round((Date.now() - heartbeat) / 1000) : null;
    res.json({
      relayHealthy: healthy,
      lastHeartbeat: heartbeat > 0 ? new Date(heartbeat).toISOString() : null,
      lastHeartbeatAgeSeconds: ageSec,
      scraperMode: healthy ? 'WATCHDOG' : 'PRIMARY',
    });
  });

  // File-descriptor capacity status (team-only). Surfaces the live process FD
  // count vs the OS limit so a slow FD leak (the cause of the prior EMFILE
  // crash) is visible on the Team page before it crashes the app.
  app.get("/api/team/fd-status", requireTeamMember, async (req: any, res) => {
    const current = sampleFdUsage();
    res.json({
      current: current.open,
      limit: current.limit,
      percent: current.percent,
      threshold: FD_WARN_THRESHOLD,
      available: current.open >= 0 && current.limit > 0,
      samples: getFdHistory(),
    });
  });

  // Review-only surface for low-credibility-source items held in quarantine.
  // These never appear in any normal feed.
  app.get("/api/team/quarantine", requireTeamMember, async (req: any, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
      const items = await storage.getQuarantinedHeadlines(limit);
      res.json(items);
    } catch (error) {
      console.error('Error fetching quarantined headlines:', error);
      res.status(500).json({ error: 'Failed to fetch quarantined headlines' });
    }
  });

  // Lightweight aggregate counters for pre-filter behavior (rescue/drop/quarantine).
  app.get("/api/team/filter-metrics", requireTeamMember, async (req: any, res) => {
    try {
      const metrics = await storage.getFilterMetrics();
      res.json({
        financeWeatherRescued: metrics?.financeWeatherRescued ?? 0,
        financeWeatherDropped: metrics?.financeWeatherDropped ?? 0,
        quarantined: metrics?.quarantined ?? 0,
        updatedAt: metrics?.updatedAt ?? null,
      });
    } catch (error) {
      console.error('Error fetching filter metrics:', error);
      res.status(500).json({ error: 'Failed to fetch filter metrics' });
    }
  });

  // Read-only "Scoring & Relevance" oversight surface (Task #622). Surfaces the
  // live main-feed priority-scoring ladder, numeric gates, relevance-filter
  // summary, and a maintained changelog of past rule adjustments. Everything is
  // derived live from the canonical constants/prompts, so a republish that
  // changes a threshold or prompt updates this automatically — there is no
  // second place to edit. Strictly read-only; never mutates scoring/relevance
  // behavior. Team-member gated, same as the rest of the Source Oversight dialog.
  app.get("/api/team/scoring-relevance", requireTeamMember, async (req: any, res) => {
    try {
      const overview = getScoringRelevanceOverview();
      // Task #678: surface the APPROVED learned scoring caps that are currently
      // being enforced in the curated lane, so this read-only tab reflects the
      // closed feedback loop (not just the static constants). Fail-soft: a lookup
      // error just yields an empty list — never breaks the overview.
      let learnedScoringCaps: Array<{
        outlet: string; category: string; cap: number | null;
        evidenceCount: number; decidedBy: string | null; decidedAt: string | null;
      }> = [];
      try {
        const approved = await storage.getCuratedLearnedRules(['approved']);
        learnedScoringCaps = approved
          .filter((r) => r.ruleType === 'scoring-cap')
          .map((r) => {
            const p = (r.payload ?? {}) as Record<string, unknown>;
            return {
              outlet: typeof p.outlet === 'string' ? p.outlet : '',
              category: typeof p.category === 'string' ? p.category : '',
              cap: typeof p.cap === 'number' ? p.cap : null,
              evidenceCount: r.evidenceCount,
              decidedBy: r.decidedBy ?? null,
              decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null,
            };
          });
      } catch (e: any) {
        console.warn('[scoring-relevance] learned scoring caps lookup failed (omitting):', e?.message || e);
      }
      // Task #1093: surface the LIVE current-context block that is appended to
      // the analyzer prompt at call time (today's date + auto-derived strategic
      // picture). Fail-soft: an error just yields null — never breaks the tab.
      let currentContext: Awaited<ReturnType<typeof getStrategicContextSnapshot>> | null = null;
      try {
        currentContext = await getStrategicContextSnapshot();
      } catch (e: any) {
        console.warn('[scoring-relevance] current-context snapshot failed (omitting):', e?.message || e);
      }
      // Task #1093 follow-through: live 7-day spread of RAW AI-assigned
      // main-feed scores (bot/RSS funnel). Makes the post-publish calibration
      // check self-serve — favorite-value clumping and an empty 90+ band are
      // visible directly in the Scoring tab instead of requiring a manual DB
      // audit. Fail-soft: an error yields null — never breaks the tab.
      let scoreDistribution: Awaited<ReturnType<typeof storage.getMainScoreSpread>> | null = null;
      try {
        scoreDistribution = await storage.getMainScoreSpread(7);
      } catch (e: any) {
        console.warn('[scoring-relevance] score-spread lookup failed (omitting):', e?.message || e);
      }
      res.json({
        ...overview,
        // Task #1094: stamp the LIVE steering toggle onto the static
        // watch-steering description so the tab reflects reality.
        watchSteering: {
          ...overview.watchSteering,
          enabled: isWatchTopicSteeringEnabled(),
        },
        learnedScoringCaps,
        currentContext,
        scoreDistribution,
        gates: [
          {
            key: 'mainFeedPromotion',
            label: 'Main-feed auto-promotion bar',
            value: MAIN_FEED_PROMOTION_THRESHOLD,
            description: 'The score an automated bot/RSS submission must clear to auto-promote from Team chat onto the main MCOP/Classic/Visual feed.',
          },
          {
            key: 'flashTopStories',
            label: 'FLASH: Top Stories bar',
            value: FLASH_PRIORITY_THRESHOLD,
            description: 'The stricter score an item must clear to also earn a spot on the FLASH: TOP STORIES highlight reel.',
          },
          {
            key: 'unscoredFallback',
            label: 'Unscored-item fallback',
            value: UNSCORED_BOT_PRIORITY,
            description: 'The default priority given to an item when the AI scorer returns no score at all — kept below both bars so it can never auto-promote or hit FLASH on the default alone.',
          },
          {
            key: 'curatedSoftCap',
            label: 'Curated soft-politics cap',
            value: CURATED_SOFT_CAP,
            description: 'Curated-lane-only backstop that caps clearly-soft, non-strategic items (tourism/PR/routine appointments, consumer cyber-fraud how-tos) back into the low band, even if the AI scored them higher.',
          },
          {
            key: 'curatedAnalysisOpinionCap',
            label: 'Curated analysis/opinion cap',
            value: CURATED_ANALYSIS_OPINION_CAP,
            description: 'Curated-lane-only backstop that caps analysis, opinion, explainer, and live-blog pieces below the HIGH band so discrete breaking events reliably out-rank commentary. Applied at ingest from the URL and again at enrichment when the page itself is labeled analysis/opinion. Never raises a score and never touches human-set pins.',
          },
        ],
      });
    } catch (error) {
      console.error('Error building scoring & relevance overview:', error);
      res.status(500).json({ error: 'Failed to build scoring & relevance overview' });
    }
  });

  // Read-only vocabulary-drift surface (Task #351). Surfaces two curated-lane
  // signals so a human can decide when to grow the controlled vocabulary:
  //   1. Most-frequent off-list topic proposals the curated generator could not
  //      place (classification_topic_proposals, ranked by occurrences).
  //   2. Largest groups of `Other / Emerging` curated_classifications rows,
  //      grouped by their specific free-form category/legacy_category.
  // Admin-gated (admin session OR team member). Strictly READ-ONLY — never
  // mutates the controlled vocabulary or overlay rows.
  //
  // OPERATOR RE-MAP LOOP: this tab only SURFACES drift; growing the vocabulary is
  // a manual code change. After editing the vocab rules (shared/classificationVocab.ts
  // + the suffix/remap rules in scripts/curated-classification-remap.ts), back-fill
  // the retained legacy_category backlog into the new labels by running:
  //   npx tsx scripts/curated-classification-remap.ts --apply --reapply-catchall
  // The bare remap is a no-op once rows already carry the `Other / Emerging`
  // catch-all (it is guarded by primary_topic IS NULL), so --reapply-catchall is
  // REQUIRED to re-derive those rows. Omit --apply first for a dry run.
  app.get("/api/team/classification-topics", requireAdminOrTeamUser, async (req: any, res) => {
    try {
      const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 168, 1), 720);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
      const [proposals, catchAllClusters] = await Promise.all([
        storage.getClassificationProposals(),
        storage.getCatchAllTopicClusters(hours, limit),
      ]);
      res.json({ proposals, catchAllClusters, windowHours: hours });
    } catch (error) {
      console.error('Error fetching classification topics oversight:', error);
      res.status(500).json({ error: 'Failed to fetch classification topics' });
    }
  });

  // ==========================================================================
  // Outlet registry oversight (Task #84). One Team-page surface to view the
  // registry, confirmation status, manual overrides (per-field provenance),
  // upload per-outlet logos, and trigger enrichment. Writes ONLY to the
  // registry labeling layer — no shared feed reads these.
  // ==========================================================================
  app.get("/api/team/outlet-registry", requireTeamMember, async (_req: any, res) => {
    try {
      const registry = await storage.getOutletRegistry();
      // Attach the DISPLAY-ONLY "Curated only" derivation (Task #530): an outlet
      // with a curated ingestion path but no main-feed path. Derived live from
      // feed wiring on every read — never stored, so it can't clobber logos /
      // manual overrides and is not an admission gate.
      const curatedOnlyIds = buildCuratedOnlyOutletIds(registry);
      res.json(registry.map((row) => ({ ...row, curatedOnly: curatedOnlyIds.has(row.id) })));
    } catch (error) {
      console.error('Error fetching outlet registry (oversight):', error);
      res.status(500).json({ error: 'Failed to fetch outlet registry' });
    }
  });

  // Read-only Coverage + Freshness oversight (Task #352). Two strictly read-only
  // sections that surface where the labeling layer has blind spots; this endpoint
  // NEVER mutates the registry or manualOverrides.
  //
  //   COVERAGE  — highest-volume recent curated sources that findOutlet cannot
  //               resolve at all, OR only resolves via the generic parent-domain
  //               fallback (e.g. live.foxnews.com → foxnews.com). Ranked by
  //               volume, with the exact source string/domain + sample URLs so an
  //               admin can decide whether to add an alias/domain to a registry
  //               row (a manual action elsewhere — this surface only reports).
  //   FRESHNESS — confirmed outlets whose enrichment is stale (lastEnrichedAt, or
  //               the freshest per-field enrichmentProvenance[*].at, older than
  //               the threshold). Fields a human has locked via manualOverrides
  //               are skipped (enrichment does not manage them).
  app.get("/api/team/outlet-registry/coverage", requireTeamMember, async (req: any, res) => {
    try {
      const hours = Math.min(Math.max(parseInt(String(req.query.hours ?? '72'), 10) || 72, 1), 720);
      const staleDays = Math.min(Math.max(parseInt(String(req.query.staleDays ?? '30'), 10) || 30, 1), 365);
      const MAX_SAMPLES = 3;

      const [registry, items] = await Promise.all([
        storage.getOutletRegistry(),
        storage.getCuratedStoreItems(hours),
      ]);
      const index = buildOutletIndex(registry);

      // Classify a curated item's source/url against the index the same way
      // findOutlet walks it, but reporting HOW it matched: an exact name/domain
      // hit ('resolved'), a generic parent-domain fallback ('parent-fallback'),
      // or no match at all ('unresolved').
      type OutletRow = typeof registry[number];
      type Resolution =
        | { status: 'resolved'; outlet: OutletRow | null }
        | { status: 'parent-fallback'; matchedDomain: string; outlet: OutletRow }
        | { status: 'unresolved' };
      function classify(source: string | null | undefined, url?: string | null): Resolution {
        const nameKey = normalizeOutletName(source);
        if (nameKey && index.byKey.has(nameKey)) {
          return { status: 'resolved', outlet: index.byKey.get(nameKey) ?? null };
        }
        for (const candidate of [source, url]) {
          const dom = extractOutletDomain(candidate);
          if (!dom) continue;
          let d = dom;
          let depth = 0;
          while (d.includes('.')) {
            const hit = index.byDomain.get(d);
            if (hit) {
              return depth === 0
                ? { status: 'resolved', outlet: hit }
                : { status: 'parent-fallback', matchedDomain: d, outlet: hit };
            }
            d = d.slice(d.indexOf('.') + 1);
            depth++;
          }
        }
        return { status: 'unresolved' };
      }

      // FULL source-resolution roster (Task #400) — every recent curated source,
      // not just the problem rows. Cleanly-resolved sources group under their
      // matched outlet's canonical name; unresolved / parent-fallback sources
      // group by their own domain (or display name) so each is an actionable row.
      // The UI flags the problem rows red and shows the resolved roster compact.
      type CoverageGroup = {
        key: string;
        domain: string | null;
        status: 'unresolved' | 'parent-fallback' | 'resolved';
        matchedDomain: string | null;
        matchedOutlet: string | null;
        count: number;
        sampleSources: string[];
        sampleUrls: string[];
      };
      const groups = new Map<string, CoverageGroup>();
      for (const item of items) {
        const r = classify(item.source, item.url);
        const itemDomain = extractOutletDomain(item.url) || extractOutletDomain(item.source);
        // Resolved items group under the matched outlet so the roster reads as a
        // clean per-outlet list; flagged items group by domain/display name.
        const groupKey = r.status === 'resolved' && r.outlet
          ? `outlet:${normalizeOutletName(r.outlet.canonicalName) ?? r.outlet.canonicalName}`
          : (itemDomain || normalizeOutletName(item.source) || item.source || 'unknown');
        let g = groups.get(groupKey);
        if (!g) {
          g = {
            key: groupKey,
            domain: itemDomain,
            status: r.status,
            matchedDomain: r.status === 'parent-fallback' ? r.matchedDomain : null,
            matchedOutlet:
              r.status === 'parent-fallback' ? r.outlet.canonicalName
              : r.status === 'resolved' ? (r.outlet?.canonicalName ?? null)
              : null,
            count: 0,
            sampleSources: [],
            sampleUrls: [],
          };
          groups.set(groupKey, g);
        }
        // Unresolved is the most urgent state — if any item in a group is fully
        // unresolved, surface the group as unresolved.
        if (r.status === 'unresolved') {
          g.status = 'unresolved';
          g.matchedDomain = null;
          g.matchedOutlet = null;
        }
        g.count++;
        if (item.source && !g.sampleSources.includes(item.source) && g.sampleSources.length < MAX_SAMPLES) {
          g.sampleSources.push(item.source);
        }
        if (item.url && !g.sampleUrls.includes(item.url) && g.sampleUrls.length < MAX_SAMPLES) {
          g.sampleUrls.push(item.url);
        }
      }
      const allGroups = Array.from(groups.values());
      const flaggedGroups = allGroups
        .filter((g) => g.status !== 'resolved')
        .sort((a, b) => {
          // Unresolved before parent-fallback, then by volume.
          if (a.status !== b.status) return a.status === 'unresolved' ? -1 : 1;
          return b.count - a.count;
        });
      const resolvedGroups = allGroups
        .filter((g) => g.status === 'resolved')
        .sort((a, b) => b.count - a.count);
      // Full roster (Task #400): show every source, flag the bad. Flagged rows
      // first, then the complete resolved roster — never truncated, so healthy
      // rows are always visible (the UI collapses them into compact chips).
      const sources: CoverageGroup[] = [
        ...flaggedGroups,
        ...resolvedGroups,
      ];
      // Back-compat alias: the old `coverage` key held only the flagged groups.
      const coverage = flaggedGroups;

      // OUTLETS — FULL roster of confirmed outlets with a freshness verdict
      // (Task #400 flips this from stale-only to the full set, flagging stale
      // rows). The freshest signal is the most recent of lastEnrichedAt and any
      // per-field provenance timestamp for a field NOT locked by a manual
      // override. Every field carrying an enrichmentProvenance entry is evaluated
      // (not a fixed subset) so newly enrichment-managed fields are covered.
      const staleCutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
      const outlets = registry
        .filter((row) => row.confirmationStatus === 'confirmed')
        .map((row) => {
          const overrides = (row.manualOverrides ?? {}) as Record<string, unknown>;
          const provenance = (row.enrichmentProvenance ?? {}) as Record<string, { source: string; at: string }>;
          const managedFields = Object.keys(provenance)
            .filter((f) => !(f in overrides))
            .map((f) => ({ field: f, at: provenance[f]?.at ?? null }));
          const provTimes = managedFields
            .map((m) => (m.at ? new Date(m.at).getTime() : NaN))
            .filter((t) => !Number.isNaN(t));
          const lastEnrichedMs = row.lastEnrichedAt ? new Date(row.lastEnrichedAt).getTime() : NaN;
          const candidateTimes = [...provTimes, lastEnrichedMs].filter((t) => !Number.isNaN(t));
          const freshestMs = candidateTimes.length ? Math.max(...candidateTimes) : null;
          const freshestAt = freshestMs ? new Date(freshestMs).toISOString() : null;
          // Stale = never enriched, or the freshest managed signal is past the cutoff.
          const stale = freshestAt === null || new Date(freshestAt).getTime() < staleCutoff;
          // noReferenceData = stale for a structural reason (no entry in the
          // bundled reference dataset), not because enrichment is overdue.
          // These should be surfaced separately from genuinely-overdue outlets.
          const noReferenceData = stale && !wouldMatch({
            domains: row.domains ?? [],
            canonicalName: row.canonicalName,
            aliases: row.aliases ?? [],
          });
          return {
            id: row.id,
            canonicalName: row.canonicalName,
            logoSlug: row.logoSlug,
            logoUrl: row.logoUrl,
            logoBrandColor: row.logoBrandColor,
            logoObjectFit: row.logoObjectFit,
            factuality: row.factuality,
            sourceIdentifier: row.sourceIdentifier,
            lastEnrichedAt: row.lastEnrichedAt,
            freshestAt,
            stale,
            noReferenceData,
            managedFields,
          };
        })
        .sort((a, b) => {
          // Stale (problem) rows first, then by freshness (oldest first).
          if (a.stale !== b.stale) return a.stale ? -1 : 1;
          const at = a.freshestAt ? new Date(a.freshestAt).getTime() : 0;
          const bt = b.freshestAt ? new Date(b.freshestAt).getTime() : 0;
          return at - bt;
        });
      // Back-compat alias: the old `freshness` key held only the stale outlets.
      const freshness = outlets.filter((o) => o.stale);

      // CONFIGURED SOURCES — FULL roster of every configured curated feed/scraper
      // with its delivery count (Task #400 flips this from silent-only to the
      // full set, flagging the silent ones). A "silent" source admitted ZERO
      // items in the lookback window: the registry is comprehensive (so
      // "unmatched" is usually empty) and enrichment keeps outlets fresh (so
      // "stale" is usually empty), but a configured RSS feed can quietly
      // 403/break and nobody notices it stops delivering. We compare
      // CANONICAL-to-CANONICAL: curatedIngest stamps the stored row's source as
      // the resolved registry canonicalName, so a feed whose sourceName resolves
      // to a different canonical (e.g. "BBC" → "BBC News") would falsely read as
      // silent if compared on raw labels. 0 admitted can mean the feed is
      // unreachable/blocked OR simply published nothing that passed the recency +
      // curation gate — the UI says so; this only reports.
      const deliveredCountByCanon = new Map<string, number>();
      const deliveredCountByNormRaw = new Map<string, number>();
      for (const it of items) {
        const o = findOutlet(index, it.source, it.url);
        const ck = o ? normalizeOutletName(o.canonicalName) : null;
        if (ck) deliveredCountByCanon.set(ck, (deliveredCountByCanon.get(ck) ?? 0) + 1);
        const nk = normalizeOutletName(it.source);
        if (nk) deliveredCountByNormRaw.set(nk, (deliveredCountByNormRaw.get(nk) ?? 0) + 1);
      }
      type ConfiguredSource = { name: string; kind: 'feed' | 'web' | 'offhost'; registered: boolean; urls: string[]; itemCount: number; delivered: boolean };
      const configuredByCanon = new Map<string, ConfiguredSource>();
      const configuredSources: { name: string; url: string; kind: 'feed' | 'web' | 'offhost' }[] = [
        ...CURATED_FEEDS.map((f) => ({ name: f.sourceName, url: f.url, kind: 'feed' as const })),
        ...CURATED_WEB_SOURCES.map((s) => ({ name: s.sourceName, url: s.sections[0] ?? '', kind: 'web' as const })),
        ...CURATED_OFFHOST_SOURCES.map((s) => ({ name: s.sourceName, url: s.bingQueries[0] ?? '', kind: 'offhost' as const })),
      ];
      for (const cfg of configuredSources) {
        const o = findOutlet(index, cfg.name, cfg.url);
        const canonKey = (o ? normalizeOutletName(o.canonicalName) : null) ?? normalizeOutletName(cfg.name) ?? cfg.name;
        const itemCount = o
          ? (deliveredCountByCanon.get(canonKey) ?? 0)
          : (deliveredCountByNormRaw.get(canonKey) ?? 0);
        let row = configuredByCanon.get(canonKey);
        if (!row) {
          row = { name: o?.canonicalName ?? cfg.name, kind: cfg.kind, registered: !!o, urls: [], itemCount, delivered: itemCount > 0 };
          configuredByCanon.set(canonKey, row);
        }
        row.itemCount = Math.max(row.itemCount, itemCount);
        row.delivered = row.delivered || itemCount > 0;
        if (cfg.url && !row.urls.includes(cfg.url)) row.urls.push(cfg.url);
      }
      const feeds: ConfiguredSource[] = Array.from(configuredByCanon.values())
        .sort((a, b) => {
          // Silent (problem) rows first, then by delivery volume desc, then name.
          if (a.delivered !== b.delivered) return a.delivered ? 1 : -1;
          if (b.itemCount !== a.itemCount) return b.itemCount - a.itemCount;
          return a.name.localeCompare(b.name);
        });
      // Back-compat alias: the old `silentSources` key held only the silent feeds.
      const silentSources = feeds
        .filter((r) => !r.delivered)
        .map(({ itemCount, delivered, ...rest }) => rest);

      // PIPELINE HEALTH — read-only verdicts for the MAIN-feed subsystems (Task
      // #400). Corroborates persisted scrape metadata / relay heartbeats with
      // each subsystem's own output-table freshness. Never mutates anything.
      let pipeline: Awaited<ReturnType<typeof computePipelineHealth>>;
      try {
        const meta = await storage.getScrapeMetadata();
        pipeline = await computePipelineHealth(meta);
      } catch (e) {
        console.error('Pipeline health computation failed:', e);
        // Still return all six subsystems as `indeterminate` so the panel never
        // disappears and the UI keeps listing every subsystem with a reason.
        pipeline = indeterminatePipeline(e instanceof Error ? e.message : 'metadata unavailable');
      }
      const pipelineSummary = summarizePipeline(pipeline);

      // MELTWATER API HEALTH — curated-lane only (Task #543). Reads per-search
      // telemetry snapshots and derives per-search status verdicts with
      // cadence-aware stale thresholds (CPC hourly → 3h stale; Int/US 2-hourly
      // → 6h stale). Never added to the main-feed pipeline section. Only counted
      // as degraded (stale/error) in the summary flagged count, not merely throttled.
      const meltwaterTelemetryRows = await storage.getMeltwaterTelemetries();
      const hasApiKey = !!process.env.MELTWATER_API_KEY;
      const meltwater = computeMeltwaterHealthMulti(meltwaterTelemetryRows, hasApiKey);

      // RSS FEED HEALTH — per-feed-URL outcome tracking for the main RSS Monitor
      // (server/rssFeeds.ts) and the Warfighter RSS list (Task #542). Surfaces
      // feeds that hard-error or return zero items for N consecutive cycles,
      // before they quietly clutter logs. In-memory, observability only.
      const rssFeedHealth = getFeedHealthReport();

      // CURATED INTAKE TELEMETRY (Task #950) — per-source admission funnel
      // snapshot persisted after each curated ingest pass. Shows fetched/kept
      // counts plus each drop-reason counter so a silent configured source is
      // attributable to a specific failure mode (aged-out, relevance-rejected,
      // dup-url, gate-unscored, etc.) rather than just "0 admitted". Curated-only.
      const intakeTelemetry = await storage.getCuratedIntakeTelemetry();

      // TRUTH SOCIAL RELAY OUTAGE (Task #1020) — live heartbeat-derived status
      // for the prominent "relay DOWN / fallback active" banner. Derived on
      // every request so the banner clears automatically on recovery. Isolated
      // failure: a null here just hides the banner (the pipeline verdict above
      // still reports the relay as degraded/broken).
      let relayOutage: Awaited<ReturnType<typeof getTruthRelayOutageReport>> | null = null;
      try {
        relayOutage = await getTruthRelayOutageReport(storage);
      } catch (e) {
        console.error('Relay outage report failed:', e);
      }

      res.json({
        params: { hours, staleDays },
        relayOutage,
        // Full-roster fields (Task #400).
        feeds,
        outlets,
        sources,
        pipeline,
        meltwater,
        rssFeedHealth,
        intakeTelemetry,
        summary: {
          feeds: { total: feeds.length, silent: feeds.filter((f) => !f.delivered).length },
          outlets: { total: outlets.length, stale: outlets.filter((o) => o.stale).length },
          sources: { total: allGroups.length, flagged: flaggedGroups.length },
          pipeline: pipelineSummary,
          meltwater: { degraded: meltwater.aggregate.degradedCount },
          rssFeedHealth: { total: rssFeedHealth.total, stale: rssFeedHealth.stale },
        },
        // Back-compat aliases (exceptions-only) retained for any other consumer.
        coverage,
        freshness,
        silentSources,
        scanned: items.length,
        configuredCount: configuredByCanon.size,
      });
    } catch (error) {
      console.error('Error building outlet coverage report:', error);
      res.status(500).json({ error: 'Failed to build coverage report' });
    }
  });

  // Read-only per-outlet INGESTION HEALTH (Registry tab). For every registry
  // outlet key, describes HOW its content is ingested (primary + fallback
  // source) and the live health of each pipeline, derived STRICTLY from existing
  // signals: feedHealthTracker (RSS/scraper feed outcomes), the X + Truth Social
  // relay heartbeats, and MELTWATER_API_KEY presence. Never mutates a registry
  // row, never runs a scrape, never creates a table/tracker. Editor-gated the
  // same way as the other registry endpoints; single-pass and cheap.
  app.get("/api/team/outlet-registry/ingestion", requireTeamMember, async (_req: any, res) => {
    try {
      const registry = await storage.getOutletRegistry();
      const items = await buildOutletIngestionHealth(registry, storage);
      // Keyed map for O(1) client lookups, plus a flat array for convenience.
      const byKey: Record<string, (typeof items)[number]> = {};
      for (const it of items) byKey[it.key] = it;
      res.json({
        byKey,
        items,
        summary: {
          total: items.length,
          healthy: items.filter((i) => i.overall === "healthy").length,
          degraded: items.filter((i) => i.overall === "degraded").length,
          broken: items.filter((i) => i.overall === "broken").length,
          unknown: items.filter((i) => i.overall === "unknown").length,
          unused: items.filter((i) => i.overall === "unused").length,
        },
      });
    } catch (error) {
      console.error('Error building outlet ingestion health:', error);
      res.status(500).json({ error: 'Failed to build outlet ingestion health' });
    }
  });

  // Set / update manual overrides for an outlet. Body: { overrides: {field: value} }.
  // Overrides win over machine enrichment and persist across refreshes.
  app.patch("/api/team/outlet-registry/:id/overrides", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      const overrides = req.body?.overrides;
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        return res.status(400).json({ error: 'overrides object required' });
      }
      const allowed = new Set([
        'originCountry', 'originRegion',
        'factuality', 'confirmationStatus',
        // New trust-engine labeling fields (role is now DERIVED, not editable).
        'sourceIdentifier', 'otherSourceType', 'ownership', 'blocked',
      ]);
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(overrides)) {
        if (!allowed.has(k)) continue;
        // Strict value validation on the trust-engine fields so a malformed
        // override can't misclassify a source (fail-closed at the boundary).
        if (k === 'sourceIdentifier' && v !== null &&
            !(SOURCE_IDENTIFIERS as readonly string[]).includes(v as string)) {
          return res.status(400).json({ error: `invalid sourceIdentifier: ${v}` });
        }
        if (k === 'otherSourceType' && v !== null &&
            !(OTHER_SOURCE_TYPES as readonly string[]).includes(v as string)) {
          return res.status(400).json({ error: `invalid otherSourceType: ${v}` });
        }
        if (k === 'ownership' && v !== null) {
          if (!Array.isArray(v) || v.length > 3 ||
              v.some(x => !(OWNERSHIP_CATEGORIES as readonly string[]).includes(x as string))) {
            return res.status(400).json({ error: 'invalid ownership (max 3 known categories)' });
          }
        }
        if (k === 'blocked' && v !== null && typeof v !== 'boolean') {
          return res.status(400).json({ error: 'blocked must be a boolean' });
        }
        filtered[k] = v;
      }
      if (Object.keys(filtered).length === 0) {
        return res.status(400).json({ error: 'no valid override fields provided' });
      }
      const user = req.user?.claims?.email || req.user?.claims?.sub || 'unknown';
      const updated = await storage.setOutletManualOverride(id, filtered, user);
      if (!updated) return res.status(404).json({ error: 'Outlet not found' });
      // Outlet labels (block/role/origin/logo) feed the cached curated outlets +
      // top-stories + cluster-members; drop the whole curated cache so an admin
      // edit shows up right away (rare action, so a full clear is cheap).
      invalidateCuratedCache();
      // Learning-log capture: only the block/unblock action is a curated-relevant
      // suppression signal (the other label edits aren't editor "moderation").
      if (Object.prototype.hasOwnProperty.call(filtered, 'blocked')) {
        const blocked = filtered.blocked === true;
        await captureCuratedOverrideEvent({
          action: blocked ? 'outlet-block' : 'outlet-unblock', editor: user,
          outlet: updated.canonicalName ?? null,
          newValue: blocked ? 'outlet blocked' : 'outlet unblocked',
        });
      }
      res.json(updated);
    } catch (error) {
      console.error('Error setting outlet override:', error);
      res.status(500).json({ error: 'Failed to set override' });
    }
  });

  // Clear a manual override for a field so enrichment manages it again.
  app.delete("/api/team/outlet-registry/:id/overrides/:field", requireTeamMember, async (req: any, res) => {
    try {
      const { id, field } = req.params;
      const updated = await storage.clearOutletManualOverride(id, field);
      if (!updated) return res.status(404).json({ error: 'Outlet not found' });
      invalidateCuratedCache();
      // Clearing a manual 'blocked' override is an effective un-block — log it so
      // the learning-log block/unblock signal stays complete.
      if (field === 'blocked') {
        const user = req.user?.claims?.email || req.user?.claims?.sub || 'unknown';
        await captureCuratedOverrideEvent({
          action: 'outlet-unblock', editor: user,
          outlet: updated.canonicalName ?? null,
          newValue: 'outlet block override cleared',
        });
      }
      res.json(updated);
    } catch (error) {
      console.error('Error clearing outlet override:', error);
      res.status(500).json({ error: 'Failed to clear override' });
    }
  });

  // Upload a per-outlet logo to the PUBLIC object-storage folder; stores the URL
  // on the registry row. Bundled-slug logos keep working (logoUrl just wins).
  const outletLogoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    fileFilter: (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new Error('Only image files are allowed'));
    },
  });
  app.post("/api/team/outlet-registry/:id/logo", requireTeamMember, outletLogoUpload.single('logo'), async (req: any, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No logo file provided' });
      const { id } = req.params;
      const ext = (req.file.originalname?.split('.').pop() || 'png');
      const objectStorageService = new ObjectStorageService();
      const url = await objectStorageService.uploadOutletLogo(req.file.buffer, req.file.mimetype, ext);
      const user = req.user?.claims?.email || req.user?.claims?.sub || 'unknown';
      const updated = await storage.setOutletLogoUrl(id, url, user);
      if (!updated) return res.status(404).json({ error: 'Outlet not found' });
      invalidateCuratedCache();
      res.json(updated);
    } catch (error) {
      console.error('Error uploading outlet logo:', error);
      res.status(500).json({ error: 'Failed to upload logo' });
    }
  });

  // Set a per-outlet logo from a pasted image URL. Fetches the image
  // server-side behind the shared SSRF guard, validates it is an image within
  // the same 2MB limit as the upload path, persists it to the same public
  // object-storage outlet-logos folder (self-hosted, not hotlinked), then saves
  // the URL via setOutletLogoUrl so provenance/updatedAt match the upload path.
  app.post("/api/team/outlet-registry/:id/logo-url", requireTeamMember, async (req: any, res) => {
    try {
      const { id } = req.params;
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      if (!url) return res.status(400).json({ error: 'No logo URL provided' });

      const { isPublicFetchableUrl } = await import('./streamPrefetch');
      if (!(await isPublicFetchableUrl(url))) {
        return res.status(400).json({ error: 'URL is not allowed (must be a public http(s) address)' });
      }

      let response: globalThis.Response;
      try {
        response = await fetch(url, {
          signal: AbortSignal.timeout(10000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          redirect: 'follow',
        });
      } catch {
        return res.status(400).json({ error: 'Could not reach the image URL' });
      }
      if (!response.ok) return res.status(400).json({ error: 'Could not fetch image from URL' });

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        return res.status(400).json({ error: 'URL did not return an image' });
      }

      const MAX_LOGO_BYTES = 2 * 1024 * 1024;
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      if (contentLength > MAX_LOGO_BYTES) {
        return res.status(400).json({ error: 'Image exceeds the 2MB limit' });
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) return res.status(400).json({ error: 'URL returned an empty image' });
      if (buffer.length > MAX_LOGO_BYTES) {
        return res.status(400).json({ error: 'Image exceeds the 2MB limit' });
      }

      const ext = contentType.includes('png') ? 'png'
        : contentType.includes('webp') ? 'webp'
        : contentType.includes('gif') ? 'gif'
        : contentType.includes('svg') ? 'svg'
        : 'jpg';
      const objectStorageService = new ObjectStorageService();
      const persistedUrl = await objectStorageService.uploadOutletLogo(buffer, contentType, ext);
      const user = req.user?.claims?.email || req.user?.claims?.sub || 'unknown';
      const updated = await storage.setOutletLogoUrl(id, persistedUrl, user);
      if (!updated) return res.status(404).json({ error: 'Outlet not found' });
      invalidateCuratedCache();
      res.json(updated);
    } catch (error) {
      console.error('Error setting outlet logo from URL:', error);
      res.status(500).json({ error: 'Failed to set logo from URL' });
    }
  });

  // Manually trigger an enrichment pass (also runs on a schedule). Guarded
  // against overlap inside the service.
  app.post("/api/team/outlet-registry/run-enrichment", requireTeamMember, async (req: any, res) => {
    try {
      const { runOutletEnrichment } = await import("./enrichment");
      const user = req.user?.claims?.email || req.user?.claims?.sub || 'unknown';
      const summary = await runOutletEnrichment(`manual:${user}`);
      invalidateCuratedCache();
      res.json(summary);
    } catch (error) {
      console.error('Error running outlet enrichment:', error);
      res.status(500).json({ error: 'Failed to run enrichment' });
    }
  });

  app.post("/api/admin/relay-backfill-media", requireAdmin, async (req, res) => {
    try {
      const candidates = await storage.getRelayTruthSocialPostsMissingMedia();
      let scanned = 0;
      let payloadParsed = 0;
      let mediaFound = 0;
      let relayUpdated = 0;
      let mainUpdated = 0;
      let mainNotFound = 0;
      const errors: Array<{ postId: string; error: string }> = [];

      for (const row of candidates) {
        scanned++;
        if (!row.rawPayload) continue;

        let parsed: any;
        try {
          parsed = typeof row.rawPayload === 'string' ? JSON.parse(row.rawPayload) : row.rawPayload;
        } catch (e: any) {
          errors.push({ postId: row.postId, error: `JSON parse: ${e.message}` });
          continue;
        }
        payloadParsed++;

        const normalized = normalizeRelayPost(parsed);
        if (!normalized) continue;

        const filteredImage = filterTruthSocialPostImage(normalized.content, normalized.imageUrl);
        const newImage = filteredImage || null;
        const newVideo = normalized.videoUrl || null;
        const newThumb = normalized.videoThumbnailUrl || null;

        if (!newImage && !newVideo && !newThumb) continue;
        mediaFound++;

        const relayFields: { imageUrl?: string | null; videoUrl?: string | null; videoThumbnailUrl?: string | null } = {};
        if (newImage && !row.imageUrl) relayFields.imageUrl = newImage;
        if (newVideo && !row.videoUrl) relayFields.videoUrl = newVideo;
        if (newThumb && !row.videoThumbnailUrl) relayFields.videoThumbnailUrl = newThumb;
        if (Object.keys(relayFields).length > 0) {
          await storage.updateRelayTruthSocialPostMedia(row.id, relayFields);
          relayUpdated++;
        }

        const mainPost = await storage.getTruthSocialPostByPostId(row.postId);
        if (!mainPost) {
          mainNotFound++;
          continue;
        }
        const mainFields: { imageUrl?: string | null; videoUrl?: string | null; videoThumbnailUrl?: string | null } = {};
        if (newImage && !mainPost.imageUrl) mainFields.imageUrl = newImage;
        if (newVideo && !mainPost.videoUrl) mainFields.videoUrl = newVideo;
        if (newThumb && !mainPost.videoThumbnailUrl) mainFields.videoThumbnailUrl = newThumb;
        if (Object.keys(mainFields).length > 0) {
          await storage.updateTruthSocialPostMedia(mainPost.id, mainFields);
          mainUpdated++;
          console.log(`[RelayBackfill] Backfilled media for post ${row.postId}: ${Object.keys(mainFields).join(', ')}`);
        }
      }

      res.json({
        status: 'ok',
        candidates: candidates.length,
        scanned,
        payloadParsed,
        mediaFound,
        relayUpdated,
        mainUpdated,
        mainNotFound,
        errorCount: errors.length,
        errors: errors.slice(0, 20),
      });
    } catch (error: any) {
      console.error('[RelayBackfill] Error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  });

  app.get("/api/admin/relay-test-posts", requireAdmin, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const posts = await storage.getRecentRelayTruthSocialPosts(limit);
      res.json(posts);
    } catch (error) {
      console.error('[Relay] Error fetching relay test posts:', error);
      res.status(500).json({ error: 'Failed to fetch relay test posts' });
    }
  });

  app.get("/api/team/relay-test-posts", requireTeamMember, async (req: any, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const posts = await storage.getRecentRelayTruthSocialPosts(limit);
      res.json(posts);
    } catch (error) {
      console.error('[Relay] Error fetching relay test posts:', error);
      res.status(500).json({ error: 'Failed to fetch relay test posts' });
    }
  });

  // Backfill stream-media enrichment for any headlines / manual_submissions
  // in the last N hours that don't yet have media_scraped_at populated.
  // Useful after the prefetch mutex was stuck or to widen scope past top 11.
  app.post("/api/admin/backfill-stream-media", requireAdmin, async (req, res) => {
    try {
      const hoursBack = Math.min(Math.max(parseInt(String(req.body?.hours || req.query?.hours || '48'), 10) || 48, 1), 168);
      const maxItems = Math.min(Math.max(parseInt(String(req.body?.max || req.query?.max || '50'), 10) || 50, 1), 200);
      const { backfillStaleStreamMedia } = await import('./streamPrefetch');
      const result = await backfillStaleStreamMedia(hoursBack, maxItems);
      res.json({ ok: true, hoursBack, maxItems, ...result });
    } catch (error: any) {
      console.error('[Admin] backfill-stream-media error:', error?.message || error);
      res.status(500).json({ error: error?.message || 'Backfill failed' });
    }
  });

  // ==================== War Dashboard API ====================
  
  const WAR_VIEWER_PASSWORD = "Warriors11!!";
  const WAR_ADMIN_PASSWORD = "iloveiwc";

  app.post("/api/war/viewer/auth", async (req: any, res) => {
    const { password } = req.body;
    if (password === WAR_VIEWER_PASSWORD) {
      req.session.warViewerAuthenticated = true;
      req.session.save((err: any) => {
        if (err) {
          console.error('[WarViewer] Session save error:', err);
          return res.status(500).json({ error: 'Session error' });
        }
        res.json({ success: true });
      });
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  });

  app.get("/api/war/viewer/status", async (req, res) => {
    res.json({ authenticated: !!(req.session.warViewerAuthenticated || req.session.warAdminAuthenticated) });
  });

  function requireWarViewer(req: Request, res: Response, next: NextFunction) {
    if (req.session.warViewerAuthenticated || req.session.warAdminAuthenticated) {
      next();
    } else {
      res.status(401).json({ error: 'War dashboard authentication required' });
    }
  }

  app.post("/api/war/admin/auth", async (req: any, res) => {
    const { password } = req.body;
    if (password === WAR_ADMIN_PASSWORD) {
      req.session.warAdminAuthenticated = true;
      req.session.save((err: any) => {
        if (err) {
          console.error('[WarAdmin] Session save error:', err);
          return res.status(500).json({ error: 'Session error' });
        }
        res.json({ success: true });
      });
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  });

  app.get("/api/war/admin/status", async (req, res) => {
    res.json({ authenticated: !!req.session.warAdminAuthenticated });
  });

  function requireWarAdmin(req: Request, res: Response, next: NextFunction) {
    if (req.session.warAdminAuthenticated) {
      next();
    } else {
      res.status(401).json({ error: 'War admin authentication required' });
    }
  }

  app.get("/api/war/settings", requireWarViewer, async (req, res) => {
    try {
      const settings = await storage.getWarSettings();
      res.json(settings);
    } catch (error) {
      console.error('Error fetching war settings:', error);
      res.status(500).json({ error: 'Failed to fetch war settings' });
    }
  });

  app.post("/api/war/settings", requireWarAdmin, async (req, res) => {
    try {
      const { feedFromMcop } = req.body;
      const settings = await storage.updateWarSettings(feedFromMcop);
      invalidateFeedCache('war-feed');
      res.json(settings);
    } catch (error) {
      console.error('Error updating war settings:', error);
      res.status(500).json({ error: 'Failed to update war settings' });
    }
  });

  // --- AI provider mode toggle (Team page) ---------------------------------
  // Global switch between 'auto' (pick the healthy provider automatically),
  // 'openrouter' (force OpenRouter primary + auto Anthropic fallback), and
  // 'internal' (force the Anthropic integration primary + auto OpenRouter
  // fallback). Reads/writes the persisted singleton AND the in-memory aiClient
  // cache so the change takes effect immediately for all server-side AI work.
  app.get("/api/team/ai-settings", requireTeamMember, async (req, res) => {
    try {
      const settings = await storage.getAiSettings();
      res.json({ provider: settings.provider, mode: getProviderMode(), updatedAt: settings.updatedAt });
    } catch (error) {
      console.error('Error fetching AI settings:', error);
      res.status(500).json({ error: 'Failed to fetch AI settings' });
    }
  });

  app.post("/api/team/ai-settings", requireTeamMember, async (req, res) => {
    try {
      const { provider } = req.body;
      if (provider !== 'openrouter' && provider !== 'internal' && provider !== 'auto') {
        return res.status(400).json({ error: "provider must be 'auto', 'openrouter', or 'internal'" });
      }
      const settings = await storage.updateAiSettings(provider);
      setProviderMode(provider);
      res.json({ provider: settings.provider, mode: getProviderMode(), updatedAt: settings.updatedAt });
    } catch (error) {
      console.error('Error updating AI settings:', error);
      res.status(500).json({ error: 'Failed to update AI settings' });
    }
  });

  app.get("/api/war/articles", async (req, res) => {
    try {
      const articles = await storage.getWarArticles();
      res.json(articles);
    } catch (error) {
      console.error('Error fetching war articles:', error);
      res.status(500).json({ error: 'Failed to fetch war articles' });
    }
  });

  app.post("/api/war/articles", requireWarAdmin, async (req, res) => {
    try {
      const { title, url, imageUrl, summaryBullets, source, priorityScore } = req.body;
      const article = await storage.addWarArticle({
        title,
        url,
        imageUrl: imageUrl || null,
        summaryBullets: summaryBullets || null,
        source: source || null,
        priorityScore: priorityScore || 50,
      });
      invalidateFeedCache('war-feed');
      res.json(article);
    } catch (error) {
      console.error('Error adding war article:', error);
      res.status(500).json({ error: 'Failed to add war article' });
    }
  });

  app.patch("/api/war/articles/:id", requireWarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const article = await storage.updateWarArticle(id, updates);
      invalidateFeedCache('war-feed');
      res.json(article);
    } catch (error) {
      console.error('Error updating war article:', error);
      res.status(500).json({ error: 'Failed to update war article' });
    }
  });

  app.delete("/api/war/articles/:id", requireWarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteWarArticle(id);
      invalidateFeedCache('war-feed');
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting war article:', error);
      res.status(500).json({ error: 'Failed to delete war article' });
    }
  });

  app.get("/api/war/overrides", requireWarAdmin, async (req, res) => {
    try {
      const overrides = await storage.getWarOverrides();
      res.json(overrides);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch overrides' });
    }
  });

  app.put("/api/war/overrides/:headlineId", requireWarAdmin, async (req, res) => {
    try {
      const { headlineId } = req.params;
      const { title, imageUrl, summaryBullets, priorityScore } = req.body;
      const override = await storage.upsertWarOverride(headlineId, {
        title: title ?? null,
        imageUrl: imageUrl ?? null,
        summaryBullets: summaryBullets ?? null,
        priorityScore: priorityScore ?? null,
      });
      invalidateFeedCache('war-feed');
      res.json(override);
    } catch (error) {
      res.status(500).json({ error: 'Failed to save override' });
    }
  });

  app.delete("/api/war/overrides/:headlineId", requireWarAdmin, async (req, res) => {
    try {
      await storage.deleteWarOverride(req.params.headlineId);
      invalidateFeedCache('war-feed');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete override' });
    }
  });

  const warScreenshotUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
      if (file.mimetype.startsWith("image/")) cb(null, true);
      else cb(new Error("Only image files are allowed"));
    },
  });

  app.get("/api/war/screenshots", requireWarViewer, async (req, res) => {
    try {
      const screenshots = await storage.getWarScreenshots();
      res.json(screenshots);
    } catch (error) {
      console.error('Error fetching war screenshots:', error);
      res.status(500).json({ error: 'Failed to fetch war screenshots' });
    }
  });

  app.post("/api/war/screenshots", requireWarAdmin, warScreenshotUpload.single("image"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Image file is required' });
      }
      const { caption, sourceLabel, priorityScore, linkUrl } = req.body;
      if (!caption) {
        return res.status(400).json({ error: 'Caption is required' });
      }
      const objectStorageService = new ObjectStorageService();
      const imageUrl = await objectStorageService.uploadWarScreenshot(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );
      const screenshot = await storage.addWarScreenshot({
        caption,
        imageUrl,
        sourceLabel: sourceLabel || null,
        linkUrl: linkUrl?.trim() || null,
        priorityScore: priorityScore ? parseInt(priorityScore, 10) : 50,
      });
      res.json(screenshot);
    } catch (error) {
      console.error('Error creating war screenshot:', error);
      res.status(500).json({ error: 'Failed to create war screenshot' });
    }
  });

  app.patch("/api/war/screenshots/:id", requireWarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const screenshot = await storage.updateWarScreenshot(id, updates);
      res.json(screenshot);
    } catch (error) {
      console.error('Error updating war screenshot:', error);
      res.status(500).json({ error: 'Failed to update war screenshot' });
    }
  });

  app.delete("/api/war/screenshots/:id", requireWarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteWarScreenshot(id);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting war screenshot:', error);
      res.status(500).json({ error: 'Failed to delete war screenshot' });
    }
  });

  app.get("/api/war/feed", requireWarViewer, async (req, res) => {
    try {
      // Short-TTL global cache — the war feed payload is identical for every war
      // viewer (no per-user data). Honors x-mcop-no-cache. War admin writes
      // (settings/articles/overrides) call invalidateFeedCache('war-feed') so
      // edits show immediately; otherwise <=25s staleness, same as the other
      // feeds.
      await serveCoalescedFeed(req, res, 'war-feed', async () => {
      const [settings, warArticlesData, overrides] = await Promise.all([
        storage.getWarSettings(),
        storage.getWarArticles(),
        storage.getWarOverrides(),
      ]);

      const overrideMap = new Map(overrides.map(o => [o.headlineId, o]));

      let streamStories: any[] = [];
      let streamTruthSocialPosts: any[] = [];
      let streamXPosts: any[] = [];
      let streamFirstAlerts: any[] = [];

      if (settings.feedFromMcop) {
        const [headlines, truthPosts, secWarPosts, rapidPosts, dowPosts, alerts] = await Promise.all([
          storage.getPrimaryFeed(18, 20),
          storage.getRecentTruthSocialPosts(10),
          storage.getRecentXPosts(20),
          storage.getRecentRapidResponsePosts(20),
          storage.getRecentDOWResponsePosts(20),
          storage.getRecentFirstAlerts(15),
        ]);

        const sortedHeadlines = headlines
          .sort((a, b) => {
            const aOverride = overrideMap.get(a.id);
            const bOverride = overrideMap.get(b.id);
            const aScore = aOverride?.priorityScore ?? a.priorityOverride ?? a.priorityScore;
            const bScore = bOverride?.priorityScore ?? b.priorityOverride ?? b.priorityScore;
            return bScore - aScore;
          })
          .slice(0, 12);

        streamStories = sortedHeadlines.map(h => {
          const override = overrideMap.get(h.id);
          // Strip curated-lane / internal-only fields (attributedClaims,
          // contentKind, fullText) — getPrimaryFeed returns them, but this
          // public war-dashboard feed must never surface them (mirrors the
          // strip on the Classic/headline feed; Task #706/#725/#780).
          const rest = stripInternalArticleFields(h as any);
          return {
            ...rest,
            title: override?.title ?? h.title,
            imageUrl: override?.imageUrl ?? (h.videoUrl ? `VIDEO:${h.videoUrl}` : h.ogImageUrl),
            summaryBullets: override?.summaryBullets ?? h.summaryBullets ?? [],
            priorityScore: override?.priorityScore ?? h.priorityOverride ?? h.priorityScore,
            isMcopArticle: true,
            hasOverride: !!override,
          };
        });

        streamTruthSocialPosts = truthPosts;

        streamXPosts = [
          ...secWarPosts.map(p => ({
            ...p,
            sourceAccount: p.sourceAccount || 'SecWar',
            isRetweet: p.isRetweet || false,
            retweetedFrom: p.retweetedFrom || null,
          })),
          ...rapidPosts.map(p => ({
            id: p.id, postId: p.postId, content: p.content, postedAt: p.postedAt,
            xUrl: p.xUrl, sourceAccount: 'Rapidresponse47', isRetweet: false,
            retweetedFrom: null as string | null, scrapedAt: p.scrapedAt, imageUrl: null as string | null,
          })),
          ...dowPosts.map(p => ({
            id: p.id, postId: p.postId, content: p.content, postedAt: p.postedAt,
            xUrl: p.xUrl, sourceAccount: 'DOWResponse', isRetweet: false,
            retweetedFrom: null as string | null, scrapedAt: p.scrapedAt, imageUrl: null as string | null,
          })),
        ].sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());

        streamFirstAlerts = alerts;
      }

      const warStoriesFormatted = warArticlesData.map(a => ({
        id: a.id,
        title: a.title,
        url: a.url,
        imageUrl: a.imageUrl,
        summaryBullets: a.summaryBullets || [],
        source: a.source || 'War Dashboard',
        priorityScore: a.priorityScore,
        priorityOverride: null,
        scrapedAt: a.createdAt,
        category: 'war',
        summary: '',
        normalizedTitle: '',
        tags: [],
        isWarArticle: true,
      }));

      const combinedStories = [...warStoriesFormatted, ...streamStories]
        .sort((a, b) => {
          const aScore = a.priorityOverride ?? a.priorityScore;
          const bScore = b.priorityOverride ?? b.priorityScore;
          return bScore - aScore;
        })
        .slice(0, 12);

      const warFeedPayload = {
        topStories: combinedStories,
        truthSocialPosts: streamTruthSocialPosts,
        xPosts: streamXPosts,
        firstAlerts: streamFirstAlerts,
        feedFromMcop: settings.feedFromMcop,
      };
      return warFeedPayload;
      });
    } catch (error) {
      console.error('Error fetching war feed:', error);
      res.status(500).json({ error: 'Failed to fetch war feed' });
    }
  });

  // Quote Database endpoints
  app.get("/api/quotes/search", async (req: any, res) => {
    try {
      const { speaker, tag, keyword, fromDate, toDate, limit, offset } = req.query;
      const result = await storage.searchArticleQuotes({
        speaker: speaker as string,
        tag: tag as string,
        keyword: keyword as string,
        fromDate: fromDate as string,
        toDate: toDate as string,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });
      res.json(result);
    } catch (error) {
      console.error('Error searching quotes:', error);
      res.status(500).json({ error: 'Failed to search quotes' });
    }
  });

  app.get("/api/quotes/stats", async (req: any, res) => {
    try {
      const stats = await storage.getArticleQuoteStats();
      res.json(stats);
    } catch (error) {
      console.error('Error getting quote stats:', error);
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  app.get("/api/stories/:id", async (req: any, res) => {
    try {
      const submission = await storage.getTeamSubmissionById(req.params.id);
      if (!submission) {
        return res.status(404).json({ error: 'Story not found' });
      }
      res.json({
        id: submission.id,
        headline: submission.headline,
        fullText: submission.fullText,
        publishedAt: submission.publishedAt,
        sourceUrl: submission.sourceUrl,
        sourceName: submission.sourceName,
      });
    } catch (error) {
      console.error('Error fetching story:', error);
      res.status(500).json({ error: 'Failed to fetch story' });
    }
  });

  app.post("/api/quotes/extract/:storyId", async (req: any, res) => {
    try {
      const submission = await storage.getTeamSubmissionById(req.params.storyId);
      if (!submission) {
        return res.status(404).json({ error: 'Story not found' });
      }
      if (!submission.fullText || submission.fullText.length < 100) {
        return res.status(400).json({ error: 'Story has insufficient text for extraction' });
      }
      const alreadyProcessed = await storage.hasQuotesForStory(req.params.storyId);
      if (alreadyProcessed) {
        return res.json({ extracted: 0, message: 'Story already processed' });
      }
      const { extractQuotesFromArticle } = await import('./quoteExtractor');
      const quotes = await extractQuotesFromArticle(
        submission.id,
        submission.fullText,
        submission.sourceUrl,
        submission.publishedAt
      );
      if (quotes.length > 0) {
        await storage.insertArticleQuotes(quotes);
      }
      res.json({ extracted: quotes.length });
    } catch (error) {
      console.error('Error extracting quotes:', error);
      res.status(500).json({ error: 'Failed to extract quotes' });
    }
  });

  app.post("/api/quotes/batch-process", async (req: any, res) => {
    try {
      const batchSize = 50;
      const allSubmissions = await storage.getAllSubmissionsForNewsBot();
      const withText = allSubmissions.filter(s => s.fullText && s.fullText.length > 100);

      let processed = 0;
      let totalExtracted = 0;

      for (const sub of withText.slice(0, batchSize)) {
        const hasQuotes = await storage.hasQuotesForStory(sub.id);
        if (hasQuotes) continue;

        try {
          const { extractQuotesFromArticle } = await import('./quoteExtractor');
          const quotes = await extractQuotesFromArticle(
            sub.id,
            sub.fullText!,
            sub.sourceUrl,
            sub.publishedAt
          );
          if (quotes.length > 0) {
            await storage.insertArticleQuotes(quotes);
            totalExtracted += quotes.length;
          }
          processed++;
          if (processed % 5 === 0) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        } catch (err) {
          console.error(`Quote extraction failed for story ${sub.id}:`, err);
        }
      }

      res.json({ processed, totalExtracted });
    } catch (error) {
      console.error('Error in batch processing:', error);
      res.status(500).json({ error: 'Failed to batch process' });
    }
  });

  app.get("/api/sms-queue/pending", async (req, res) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== process.env.MCOP_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const { parseDeviceRole, recordBridgePoll, evaluateActiveDevice, claimPendingMessages } = await import("./smsBridge");
      // Backward compatible: an old bridge script sends no device param and is
      // treated as the primary phone.
      const device = parseDeviceRole(req.query.device ?? req.headers["x-device-role"]);
      await recordBridgePoll(device);
      const activeDevice = await evaluateActiveDevice();

      if (device !== activeDevice) {
        // Standby device: heartbeat recorded, but it gets no messages so the
        // two phones can never double-send.
        return res.json({ messages: [], standby: true, activeDevice });
      }

      const messages = await claimPendingMessages(device, 20);
      res.json({ messages, standby: false, activeDevice });
    } catch (error) {
      console.error("[SMS-Queue] Error fetching pending:", error);
      res.status(500).json({ error: "Failed to fetch pending messages" });
    }
  });

  app.post("/api/sms-queue/confirm", async (req, res) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== process.env.MCOP_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const { id, success, error: errorMsg, device: rawDevice } = req.body;
      if (!id) return res.status(400).json({ error: "Message ID required" });

      const { parseDeviceRole, noteConfirmResult } = await import("./smsBridge");
      const device = parseDeviceRole(rawDevice);

      if (success) {
        // Idempotent: only the first confirm transitions the row; a duplicate
        // confirm (retry, or a stale device confirming after lease expiry)
        // finds status already 'sent' and is a no-op.
        const updated = await db.update(smsQueue)
          .set({ status: "sent", sentAt: new Date() })
          .where(and(eq(smsQueue.id, id), eq(smsQueue.status, "pending")))
          .returning({ id: smsQueue.id });
        if (updated.length === 0) {
          console.log(`[SMS-Queue] Duplicate/late confirm for ${id} from ${device} — already finalized`);
          noteConfirmResult(device, true);
          return res.json({ ok: true, duplicate: true });
        }
      } else {
        await db.update(smsQueue)
          .set({ status: "failed", error: errorMsg || "Unknown error" })
          .where(and(eq(smsQueue.id, id), eq(smsQueue.status, "pending")));
      }
      noteConfirmResult(device, !!success);
      console.log(`[SMS-Queue] Message ${id} ${success ? "sent" : "failed"} (device: ${device})`);
      res.json({ ok: true });
    } catch (error) {
      console.error("[SMS-Queue] Error confirming:", error);
      res.status(500).json({ error: "Failed to confirm message" });
    }
  });

  app.post("/api/sms-queue/inbound", async (req, res) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== process.env.MCOP_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const { from, body } = req.body;
      if (!from || !body) return res.status(400).json({ error: "from and body required" });

      // Dedup: if both phones (or a retrying phone) forward the same inbound
      // SMS within the window, only the first one gets a MCOP Bot reply.
      const { isDuplicateInbound } = await import("./smsBridge");
      if (isDuplicateInbound(from, body)) {
        console.log(`[SMS-Queue] Duplicate inbound from ${from} — skipping`);
        return res.json({ ok: true, replyQueued: false, duplicate: true });
      }

      console.log(`[SMS-Queue] Inbound from ${from}: "${body.substring(0, 80)}"`);

      const { handleInboundSms } = await import("./twilioService");
      const reply = await handleInboundSms(from, body);

      await db.insert(smsQueue).values({
        toNumber: from,
        body: reply,
        status: "pending",
        direction: "outbound",
      });

      console.log(`[SMS-Queue] Queued reply to ${from} (${reply.length} chars)`);
      res.json({ ok: true, replyQueued: true });
    } catch (error) {
      console.error("[SMS-Queue] Inbound error:", error);
      res.status(500).json({ error: "Failed to process inbound message" });
    }
  });

  app.post("/api/webhooks/twilio-inbound", async (req, res) => {
    try {
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      if (authToken) {
        const twilio = await import("twilio");
        const twilioSignature = req.headers["x-twilio-signature"] as string;
        const protocol = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.headers["host"];
        const fullUrl = `${protocol}://${host}${req.originalUrl}`;
        const isValid = twilio.validateRequest(authToken, twilioSignature || "", fullUrl, req.body);
        if (!isValid) {
          console.log("[SMS-Bot] Invalid Twilio signature — rejecting request");
          res.status(403).type("text/xml").send("<Response></Response>");
          return;
        }
      }

      const { From, Body } = req.body;

      if (!From || !Body) {
        console.log("[SMS-Bot] Missing From or Body in Twilio webhook");
        res.type("text/xml").send("<Response></Response>");
        return;
      }

      console.log(`[SMS-Bot] Inbound SMS from ${From}: "${Body.substring(0, 80)}"`);

      const { handleInboundSms, sendSmsReply } = await import("./twilioService");
      const reply = await handleInboundSms(From, Body);

      await sendSmsReply(From, reply);

      res.type("text/xml").send("<Response></Response>");
    } catch (error: any) {
      console.error("[SMS-Bot] Webhook error:", error?.message || error);
      res.type("text/xml").send("<Response></Response>");
    }
  });

  // ===== Custom MCOPs =====
  const { rescoreAllForMcop } = await import('./customMcopScorer');
  const cryptoMod = await import('crypto');

  function slugify(name: string): string {
    return name.toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `mcop-${Date.now()}`;
  }

  function scryptHash(password: string, salt: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      cryptoMod.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(key));
    });
  }
  async function hashMcopPassword(password: string): Promise<string> {
    const salt = cryptoMod.randomBytes(16).toString('hex');
    const key = await scryptHash(password, salt);
    return `${salt}:${key.toString('hex')}`;
  }
  async function verifyMcopPassword(password: string, hash: string): Promise<boolean> {
    const [salt, keyHex] = (hash || '').split(':');
    if (!salt || !keyHex) return false;
    const expected = Buffer.from(keyHex, 'hex');
    const actual = await scryptHash(password, salt);
    return expected.length === actual.length && cryptoMod.timingSafeEqual(expected, actual);
  }

  // Team-level access (lists, dashboard reads)
  // A small allow-list of MCOPs have a public-facing two-tier password gate
  // (viewer + admin). Anyone who enters the viewer or admin password gets a
  // session flag scoped to that slug — no team/Replit-OAuth membership required.
  // Each gated MCOP has its own session keys so unlocking one doesn't unlock
  // another.
  type McopGateConfig = {
    viewerPassword: string;
    adminPassword: string;
    viewerSessionKey: string;
    adminSessionKey: string;
  };
  const GATED_MCOP_CONFIG: Record<string, McopGateConfig> = {
    warfighter: {
      viewerPassword: "Warfighter11!!",
      adminPassword: "Warfighter22@@",
      viewerSessionKey: "warfighterViewerAuth",
      adminSessionKey: "warfighterAdminAuth",
    },
    cyber: {
      viewerPassword: "Cyber11!!",
      adminPassword: "Cyber22@@",
      viewerSessionKey: "cyberViewerAuth",
      adminSessionKey: "cyberAdminAuth",
    },
  };
  function getMcopGateConfig(slug: string | undefined): McopGateConfig | null {
    if (!slug) return null;
    return GATED_MCOP_CONFIG[slug] || null;
  }
  function hasWarfighterViewerAccess(req: any, slug: string | undefined): boolean {
    const cfg = getMcopGateConfig(slug);
    if (!cfg) return false;
    return !!(req.session?.[cfg.viewerSessionKey] || req.session?.[cfg.adminSessionKey]);
  }
  function hasWarfighterAdminAccess(req: any, slug: string | undefined): boolean {
    const cfg = getMcopGateConfig(slug);
    if (!cfg) return false;
    return !!req.session?.[cfg.adminSessionKey];
  }

  // Returns true when the signed-in Replit user's email is on the
  // warfighter_cyber_allowed list AND the slug is a gated MCOP.
  // Fail-closed: any error → false.
  async function isWarfighterCyberAllowedUser(req: any, slug?: string): Promise<boolean> {
    if (!getMcopGateConfig(slug ?? req.params?.slug)) return false;
    if (!(req.isAuthenticated && req.isAuthenticated() && req.user?.claims?.sub)) return false;
    const email = req.user.claims.email?.toLowerCase();
    if (!email) return false;
    try {
      return await storage.isWarfighterCyberAllowed(email);
    } catch {
      return false;
    }
  }

  async function requireCustomMcopAccess(req: any, res: Response, next: NextFunction) {
    if (req.session?.adminAuthenticated || req.session?.authenticated || req.session?.warAdminAuthenticated) {
      return next();
    }
    if (hasWarfighterViewerAccess(req, req.params?.slug)) return next();
    if (req.isAuthenticated && req.isAuthenticated() && req.user?.claims?.sub) {
      const email = req.user.claims.email?.toLowerCase();
      if (email) {
        try {
          if (await storage.isTeamMember(email)) return next();
        } catch (e) {
          console.error('[CustomMcop auth] team membership check failed:', e);
        }
        try {
          if (await isWarfighterCyberAllowedUser(req, req.params?.slug)) return next();
        } catch (e) {
          console.error('[CustomMcop auth] warfighter/cyber allowlist check failed:', e);
        }
      }
    }
    return res.status(401).json({ error: 'Authentication required' });
  }

  async function hasTeamAccess(req: any, slug?: string): Promise<boolean> {
    if (req.session?.adminAuthenticated || req.session?.authenticated || req.session?.warAdminAuthenticated) return true;
    if (hasWarfighterAdminAccess(req, slug ?? req.params?.slug)) return true;
    if (req.isAuthenticated && req.isAuthenticated() && req.user?.claims?.sub) {
      const email = req.user.claims.email?.toLowerCase();
      if (email) {
        try { if (await storage.isTeamMember(email)) return true; } catch {}
        try { if (await isWarfighterCyberAllowedUser(req, slug ?? req.params?.slug)) return true; } catch {}
      }
    }
    return false;
  }

  // Per-MCOP admin access. Requires team-level access PLUS either:
  //  - global admin session, OR
  //  - per-MCOP password unlocked in this session, OR
  //  - the MCOP has no password set yet (first-time setup)
  async function requireMcopAdmin(req: any, res: Response, next: NextFunction) {
    if (!(await hasTeamAccess(req))) return res.status(401).json({ error: 'Authentication required' });
    const slug = req.params.slug;
    if (!slug) return res.status(400).json({ error: 'Missing slug' });
    const mcop = await storage.getCustomMcopBySlug(slug);
    if (!mcop) return res.status(404).json({ error: 'Not found' });
    (req as any).mcop = mcop;
    if (req.session?.adminAuthenticated) return next();
    if (hasWarfighterAdminAccess(req, slug)) return next();
    if (await isWarfighterCyberAllowedUser(req, slug)) return next();
    if (!mcop.adminPasswordHash) return next(); // first-time setup allowed
    if (req.session?.customMcopAuth?.[mcop.id] === true) return next();
    return res.status(403).json({ error: 'MCOP admin password required', code: 'MCOP_LOCKED' });
  }

  // Parameterized two-tier password gate for any MCOP in GATED_MCOP_CONFIG
  // (currently warfighter and cyber). Each gated slug has its own viewer/admin
  // passwords and its own session keys, so unlocking one MCOP does not unlock
  // another.
  app.get("/api/custom-mcops/:slug/gate-status", async (req: any, res) => {
    const cfg = getMcopGateConfig(req.params.slug);
    if (!cfg) return res.status(404).json({ error: 'Not a gated MCOP' });
    // Global admins and users on the warfighter_cyber_allowed list are always
    // fully unlocked — no password required.
    const isGlobalAdmin = !!req.session?.adminAuthenticated;
    const isAllowed = !isGlobalAdmin && await isWarfighterCyberAllowedUser(req, req.params.slug);
    if (isGlobalAdmin || isAllowed) {
      return res.json({ viewerUnlocked: true, adminUnlocked: true });
    }
    res.json({
      viewerUnlocked: !!(req.session?.[cfg.viewerSessionKey] || req.session?.[cfg.adminSessionKey]),
      adminUnlocked: !!req.session?.[cfg.adminSessionKey],
    });
  });

  app.post("/api/custom-mcops/:slug/gate-viewer", async (req: any, res) => {
    const cfg = getMcopGateConfig(req.params.slug);
    if (!cfg) return res.status(404).json({ error: 'Not a gated MCOP' });
    const password = String(req.body?.password || '');
    if (password !== cfg.viewerPassword && password !== cfg.adminPassword) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    req.session[cfg.viewerSessionKey] = true;
    if (password === cfg.adminPassword) req.session[cfg.adminSessionKey] = true;
    req.session.save?.(() => res.json({ ok: true }));
  });

  app.post("/api/custom-mcops/:slug/gate-admin", async (req: any, res) => {
    const cfg = getMcopGateConfig(req.params.slug);
    if (!cfg) return res.status(404).json({ error: 'Not a gated MCOP' });
    const password = String(req.body?.password || '');
    if (password !== cfg.adminPassword) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    req.session[cfg.adminSessionKey] = true;
    req.session[cfg.viewerSessionKey] = true;
    req.session.save?.(() => res.json({ ok: true }));
  });

  app.get("/api/custom-mcops", requireCustomMcopAccess, async (_req, res) => {
    try {
      const mcops = await storage.listCustomMcops();
      res.json(mcops);
    } catch (e) {
      console.error('list custom mcops error:', e);
      res.status(500).json({ error: 'Failed to list custom MCOPs' });
    }
  });

  app.post("/api/custom-mcops", requireCustomMcopAccess, async (req: any, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim();
      const password = typeof body.password === 'string' ? body.password : '';
      if (!name) return res.status(400).json({ error: 'Name is required' });
      if (!password || password.length < 4) return res.status(400).json({ error: 'Password (at least 4 characters) is required' });

      // Compute unique slug
      let slug = slugify(name);
      const existing = await storage.getCustomMcopBySlug(slug);
      if (existing) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;

      const createdBy = req.user?.claims?.email || (req.session.adminAuthenticated ? 'admin' : 'team');
      const created = await storage.createCustomMcop({
        slug,
        name,
        generalPrompt: body.generalPrompt ?? DEFAULT_GENERAL_PROMPT,
        lookForNow: body.lookForNow ?? DEFAULT_LOOK_FOR_NOW,
        exclude: body.exclude ?? DEFAULT_EXCLUDE,
        createdBy,
      });
      // Hash and persist password, then auto-unlock for the creator's session
      const hash = await hashMcopPassword(password);
      await storage.setCustomMcopPasswordHash(created.id, hash);
      if (!req.session.customMcopAuth) req.session.customMcopAuth = {};
      req.session.customMcopAuth[created.id] = true;
      res.json(created);
    } catch (e) {
      console.error('create custom mcop error:', e);
      res.status(500).json({ error: 'Failed to create custom MCOP' });
    }
  });

  // Auth status for the per-MCOP admin gate
  app.get("/api/custom-mcops/:slug/auth-status", requireCustomMcopAccess, async (req: any, res) => {
    try {
      const mcop = await storage.getCustomMcopBySlug(req.params.slug);
      if (!mcop) return res.status(404).json({ error: 'Not found' });
      const hasPassword = !!mcop.adminPasswordHash;
      const isAdmin = !!req.session?.adminAuthenticated || hasWarfighterAdminAccess(req, req.params.slug)
        || await isWarfighterCyberAllowedUser(req, req.params.slug);
      const unlocked = isAdmin || !hasPassword || req.session?.customMcopAuth?.[mcop.id] === true;
      res.json({ hasPassword, unlocked, requiresSetup: !hasPassword });
    } catch (e) {
      res.status(500).json({ error: 'Failed to check status' });
    }
  });

  // Login with the per-MCOP password
  app.post("/api/custom-mcops/:slug/auth", requireCustomMcopAccess, async (req: any, res) => {
    try {
      const mcop = await storage.getCustomMcopBySlug(req.params.slug);
      if (!mcop) return res.status(404).json({ error: 'Not found' });
      const password = String(req.body?.password || '');
      if (!password) return res.status(400).json({ error: 'Password required' });
      if (!mcop.adminPasswordHash) return res.status(400).json({ error: 'No password set yet — use the setup flow', code: 'NO_PASSWORD' });
      const ok = await verifyMcopPassword(password, mcop.adminPasswordHash);
      if (!ok) return res.status(401).json({ error: 'Incorrect password' });
      if (!req.session.customMcopAuth) req.session.customMcopAuth = {};
      req.session.customMcopAuth[mcop.id] = true;
      res.json({ ok: true });
    } catch (e) {
      console.error('mcop auth error:', e);
      res.status(500).json({ error: 'Auth failed' });
    }
  });

  app.post("/api/custom-mcops/:slug/logout", requireCustomMcopAccess, async (req: any, res) => {
    const mcop = await storage.getCustomMcopBySlug(req.params.slug);
    if (mcop && req.session?.customMcopAuth) delete req.session.customMcopAuth[mcop.id];
    res.json({ ok: true });
  });

  // Set or change the per-MCOP password (must already have admin access to this MCOP)
  app.post("/api/custom-mcops/:slug/password", requireMcopAdmin, async (req: any, res) => {
    try {
      const mcop = req.mcop;
      const password = String(req.body?.password || '');
      if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
      const hash = await hashMcopPassword(password);
      await storage.setCustomMcopPasswordHash(mcop.id, hash);
      if (!req.session.customMcopAuth) req.session.customMcopAuth = {};
      req.session.customMcopAuth[mcop.id] = true;
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to set password' });
    }
  });

  app.get("/api/custom-mcops/:slug", requireCustomMcopAccess, async (req, res) => {
    try {
      const mcop = await storage.getCustomMcopBySlug(req.params.slug);
      if (!mcop) return res.status(404).json({ error: 'Not found' });
      res.json(mcop);
    } catch (e) {
      console.error('get custom mcop error:', e);
      res.status(500).json({ error: 'Failed to fetch' });
    }
  });

  app.patch("/api/custom-mcops/:slug", requireMcopAdmin, async (req: any, res) => {
    try {
      const mcop = req.mcop;
      const body = req.body || {};
      const fields: any = {};
      if (typeof body.name === 'string') fields.name = body.name.trim();
      if (typeof body.generalPrompt === 'string') fields.generalPrompt = body.generalPrompt;
      if (typeof body.lookForNow === 'string') fields.lookForNow = body.lookForNow;
      if (typeof body.exclude === 'string') fields.exclude = body.exclude;
      if (typeof body.feedFromMcop === 'boolean') fields.feedFromMcop = body.feedFromMcop;
      const updated = await storage.updateCustomMcop(mcop.id, fields);
      // name + feedFromMcop both shape the cached viewer feed, so refresh it.
      invalidateFeedCache(`custom-feed:${req.params.slug}:`);
      invalidateFeedCache(`custom-outlets:${req.params.slug}`);
      res.json(updated);
      rescoreAllForMcop(mcop.id).catch(err => console.error('rescore error:', err));
    } catch (e) {
      console.error('update custom mcop error:', e);
      res.status(500).json({ error: 'Failed to update' });
    }
  });

  app.delete("/api/custom-mcops/:slug", requireMcopAdmin, async (req: any, res) => {
    try {
      await storage.deleteCustomMcop(req.mcop.id);
      res.json({ success: true });
    } catch (e) {
      console.error('delete custom mcop error:', e);
      res.status(500).json({ error: 'Failed to delete' });
    }
  });

  app.post("/api/custom-mcops/:slug/rescore", requireMcopAdmin, async (req: any, res) => {
    try {
      rescoreAllForMcop(req.mcop.id).catch(err => console.error('rescore error:', err));
      invalidateFeedCache(`custom-feed:${req.params.slug}:`);
      invalidateFeedCache(`custom-outlets:${req.params.slug}`);
      res.json({ ok: true, message: 'Rescore started' });
    } catch (e) {
      res.status(500).json({ error: 'Failed to start rescore' });
    }
  });

  // Manual articles CRUD (read = team access; write = mcop admin)
  app.get("/api/custom-mcops/:slug/articles", requireCustomMcopAccess, async (req, res) => {
    try {
      const mcop = await storage.getCustomMcopBySlug(req.params.slug);
      if (!mcop) return res.status(404).json({ error: 'Not found' });
      const list = await storage.getCustomMcopArticles(mcop.id);
      res.json(list);
    } catch (e) {
      res.status(500).json({ error: 'Failed to list articles' });
    }
  });
  // Auto-fill the "Submit Article" form by scraping a URL: returns suggested
  // title, source, og:image (persisted to object storage), and AI-generated
  // summary bullets. Admin can edit the values before saving.
  app.post("/api/custom-mcops/:slug/scrape-url-preview", requireMcopAdmin, async (req: any, res) => {
    try {
      const url = String(req.body?.url || '').trim();
      if (!url) return res.status(400).json({ error: 'URL is required' });
      try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

      const { extractArticlePreview } = await import('./streamPrefetch');
      const preview = await extractArticlePreview(url);
      res.json(preview);
    } catch (e: any) {
      const msg = e?.message || 'Failed to scrape URL';
      // SSRF / validation rejections should be 400, not 500
      if (msg.includes('not allowed')) return res.status(400).json({ error: msg });
      console.error('scrape-url-preview error:', e);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/custom-mcops/:slug/articles", requireMcopAdmin, async (req: any, res) => {
    try {
      const body = req.body || {};
      const title = String(body.title || '').trim();
      const url = String(body.url || '').trim();
      if (!title || !url) return res.status(400).json({ error: 'Title and URL required' });
      const created = await storage.addCustomMcopArticle({
        mcopId: req.mcop.id,
        title,
        url,
        imageUrl: body.imageUrl ?? null,
        summaryBullets: Array.isArray(body.summaryBullets) ? body.summaryBullets.filter((b: any) => typeof b === 'string') : null,
        source: body.source ?? null,
        priorityScore: typeof body.priorityScore === 'number' ? body.priorityScore : 50,
      });
      invalidateFeedCache(`custom-feed:${req.params.slug}:`);
      invalidateFeedCache(`custom-outlets:${req.params.slug}`);
      res.json(created);
    } catch (e) {
      console.error('add custom mcop article error:', e);
      res.status(500).json({ error: 'Failed to add article' });
    }
  });
  app.patch("/api/custom-mcops/:slug/articles/:id", requireMcopAdmin, async (req: any, res) => {
    try {
      const article = await storage.getCustomMcopArticleById(req.params.id);
      if (!article || article.mcopId !== req.mcop.id) return res.status(404).json({ error: 'Not found' });
      const body = req.body || {};
      const fields: any = {};
      if (typeof body.title === 'string') fields.title = body.title;
      if (typeof body.url === 'string') fields.url = body.url;
      if ('imageUrl' in body) fields.imageUrl = body.imageUrl;
      if (Array.isArray(body.summaryBullets)) fields.summaryBullets = body.summaryBullets.filter((b: any) => typeof b === 'string');
      if ('source' in body) fields.source = body.source;
      if (typeof body.priorityScore === 'number') fields.priorityScore = body.priorityScore;
      const updated = await storage.updateCustomMcopArticle(req.params.id, fields);
      invalidateFeedCache(`custom-feed:${req.params.slug}:`);
      invalidateFeedCache(`custom-outlets:${req.params.slug}`);
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: 'Failed to update' });
    }
  });
  // Edit a scraped headline or manual submission from the MCOP admin (image/title/bullets/priority)
  app.patch("/api/custom-mcops/:slug/feed-articles/:id", requireMcopAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      const body = req.body || {};
      const type = body.type;
      if (type !== 'scraped' && type !== 'manual') {
        return res.status(400).json({ error: 'type must be "scraped" or "manual"' });
      }

      // Verify the target row exists before any writes
      if (type === 'scraped') {
        const existing = await db.select({ id: headlines.id }).from(headlines).where(eq(headlines.id, id)).limit(1);
        if (existing.length === 0) return res.status(404).json({ error: 'Headline not found' });
      } else {
        const existing = await db.select({ id: manualSubmissions.id }).from(manualSubmissions).where(eq(manualSubmissions.id, id)).limit(1);
        if (existing.length === 0) return res.status(404).json({ error: 'Manual submission not found' });
      }

      // Title
      if (typeof body.title === 'string' && body.title.trim().length > 0) {
        const title = body.title.trim();
        if (type === 'scraped') {
          await storage.updateHeadlineTitle(id, title, normalizeTitle(title));
        } else {
          await storage.updateManualSubmissionTitle(id, title);
        }
      }

      // Priority override (1-100, or null to clear)
      if ('priorityOverride' in body) {
        const p = body.priorityOverride;
        if (p !== null && (typeof p !== 'number' || p < 1 || p > 100)) {
          return res.status(400).json({ error: 'priorityOverride must be null or 1-100' });
        }
        if (type === 'scraped') {
          await storage.updateHeadlinePriority(id, p);
        } else {
          await storage.updateManualSubmissionPriority(id, p);
        }
      }

      // Image and bullets — write directly to the underlying table
      const mediaUpdate: any = {};
      if ('ogImageUrl' in body) mediaUpdate.ogImageUrl = body.ogImageUrl;
      if ('summaryBullets' in body) {
        const bullets = Array.isArray(body.summaryBullets)
          ? body.summaryBullets.filter((b: any) => typeof b === 'string')
          : [];
        mediaUpdate.summaryBullets = bullets.length > 0 ? bullets : null;
      }
      if (Object.keys(mediaUpdate).length > 0) {
        mediaUpdate.mediaScrapedAt = new Date();
        mediaUpdate.manuallyEdited = true;
        if (type === 'scraped') {
          await db.update(headlines).set(mediaUpdate).where(eq(headlines.id, id));
        } else {
          await db.update(manualSubmissions).set(mediaUpdate).where(eq(manualSubmissions.id, id));
        }
      }

      invalidateFeedCache(`custom-feed:${req.params.slug}:`);
      invalidateFeedCache(`custom-outlets:${req.params.slug}`);
      // This edits the SHARED headlines/manual_submissions rows, which also surface
      // in Classic + Stream → drop their caches too, not just this MCOP's.
      invalidateMainFeeds();
      res.json({ success: true });
    } catch (e) {
      console.error('mcop edit feed-article error:', e);
      res.status(500).json({ error: 'Failed to update' });
    }
  });

  app.delete("/api/custom-mcops/:slug/articles/:id", requireMcopAdmin, async (req: any, res) => {
    try {
      const article = await storage.getCustomMcopArticleById(req.params.id);
      if (!article || article.mcopId !== req.mcop.id) return res.status(404).json({ error: 'Not found' });
      await storage.deleteCustomMcopArticle(req.params.id);
      invalidateFeedCache(`custom-feed:${req.params.slug}:`);
      invalidateFeedCache(`custom-outlets:${req.params.slug}`);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete' });
    }
  });

  // Manual screenshots CRUD
  app.get("/api/custom-mcops/:slug/screenshots", requireCustomMcopAccess, async (req, res) => {
    try {
      const mcop = await storage.getCustomMcopBySlug(req.params.slug);
      if (!mcop) return res.status(404).json({ error: 'Not found' });
      const list = await storage.getCustomMcopScreenshots(mcop.id);
      res.json(list);
    } catch (e) {
      res.status(500).json({ error: 'Failed to list screenshots' });
    }
  });
  app.post("/api/custom-mcops/:slug/screenshots", requireMcopAdmin, async (req: any, res) => {
    try {
      const body = req.body || {};
      const caption = String(body.caption || '').trim();
      const imageUrl = String(body.imageUrl || '').trim();
      if (!caption || !imageUrl) return res.status(400).json({ error: 'Caption and image URL required' });
      const created = await storage.addCustomMcopScreenshot({
        mcopId: req.mcop.id,
        caption,
        imageUrl,
        sourceLabel: body.sourceLabel ?? null,
        linkUrl: body.linkUrl ?? null,
        priorityScore: typeof body.priorityScore === 'number' ? body.priorityScore : 50,
      });
      invalidateFeedCache(`custom-feed:${req.params.slug}:`);
      invalidateFeedCache(`custom-outlets:${req.params.slug}`);
      res.json(created);
    } catch (e) {
      console.error('add custom mcop screenshot error:', e);
      res.status(500).json({ error: 'Failed to add screenshot' });
    }
  });
  app.delete("/api/custom-mcops/:slug/screenshots/:id", requireMcopAdmin, async (req: any, res) => {
    try {
      const all = await storage.getCustomMcopScreenshots(req.mcop.id);
      if (!all.some(s => s.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
      await storage.deleteCustomMcopScreenshot(req.params.id);
      invalidateFeedCache(`custom-feed:${req.params.slug}:`);
      invalidateFeedCache(`custom-outlets:${req.params.slug}`);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete' });
    }
  });

  // Hidden items management (Sadmin only)
  app.post("/api/custom-mcops/:slug/summarize-text", requireMcopAdmin, async (req: any, res) => {
    try {
      const { text, headline } = req.body || {};
      if (!text || typeof text !== 'string' || text.trim().length < 50) {
        return res.status(400).json({ error: 'Text must be at least 50 characters' });
      }
      if (!isAIConfigured()) {
        return res.status(500).json({ error: 'AI not configured' });
      }
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a military intelligence analyst. Generate exactly 3 concise bullet points summarizing this article. Each bullet must be 15 words or fewer. Bullet 1: What is the big change or announcement in this story. Bullet 2: What is the background context. Bullet 3: Any supplemental information. Always spell out publication, outlet, and organization names in full (e.g. "The Daily Wire" not "TDW", "The Wall Street Journal" not "WSJ", "Associated Press" not "AP"). Return only the 3 bullets, one per line, without bullet markers or numbering.',
          },
          {
            role: 'user',
            content: `Headline: ${headline || 'News article'}\n\nArticle text:\n${String(text).slice(0, 3000)}`,
          },
        ],
        max_tokens: 200,
        temperature: 0.3,
      });
      const responseText = completion.choices[0]?.message?.content || '';
      const bullets = responseText
        .split('\n')
        .map((line: string) => line.replace(/^[-•*\d.)\s]+/, '').trim())
        .filter((line: string) => line.length > 0)
        .slice(0, 3)
        .map((line: string) => line.split(/\s+/).slice(0, 15).join(' '));
      res.json({ bullets });
    } catch (error: any) {
      console.error('mcop summarize-text error:', error?.message || error);
      res.status(500).json({ error: `Failed to summarize: ${error?.message || 'Unknown error'}` });
    }
  });

  // Cached + single-flight coalesced (same pattern as the viewer feed): this
  // handler runs the SAME heavy getPrimaryFeed(48, ...) as the per-MCOP feed
  // plus roster queries, and several admins opening the outlet panel at once
  // (or polling) would otherwise stack identical expensive computes. Keyed by
  // slug; roster/feed-shaping writes invalidate `custom-outlets:${slug}`
  // alongside `custom-feed:${slug}:` so hide/unhide reflects promptly.
  // x-mcop-no-cache still bypasses cache + coalescing (handled inside
  // serveCoalescedFeed).
  app.get("/api/custom-mcops/:slug/outlets", requireMcopAdmin, async (req: any, res) => {
    try {
      await serveCoalescedFeed(req, res, `custom-outlets:${req.mcop.slug}`, async () => {
        const [primaryFeed, manualArticles, hiddenKeys] = await Promise.all([
          storage.getPrimaryFeed(48, undefined, req.mcop.slug),
          storage.getCustomMcopArticles(req.mcop.id),
          storage.getCustomMcopHiddenKeys(req.mcop.id),
        ]);
        const hiddenOutlets = new Set<string>();
        hiddenKeys.forEach(k => { if (k.startsWith('outlet:')) hiddenOutlets.add(k.slice(7)); });

        const counts = new Map<string, { name: string; count: number }>();
        const add = (raw: string | null | undefined) => {
          if (!raw) return;
          const name = String(raw).trim();
          if (!name) return;
          const key = name.toLowerCase();
          const cur = counts.get(key);
          if (cur) cur.count += 1;
          else counts.set(key, { name, count: 1 });
        };
        primaryFeed.forEach(h => add(h.source));
        manualArticles.forEach(a => add(a.source));

        // Seed with the canonical static list so outlets without active stories
        // still appear (admins can hide them pre-emptively).
        const { getKnownOutlets } = await import('./knownOutlets');
        for (const k of getKnownOutlets(req.mcop.slug)) {
          if (!counts.has(k.key)) counts.set(k.key, { name: k.name, count: 0 });
        }

        return Array.from(counts.entries())
          .map(([key, v]) => ({ key, name: v.name, count: v.count, hidden: hiddenOutlets.has(key) }))
          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      });
    } catch (e) {
      console.error('outlets error:', e);
      res.status(500).json({ error: 'Failed to load outlets' });
    }
  });

  app.get("/api/custom-mcops/:slug/hidden", requireMcopAdmin, async (req: any, res) => {
    try {
      const items = await storage.getCustomMcopHiddenItems(req.mcop.id);
      res.json(items);
    } catch (e) {
      console.error('list hidden error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  app.post("/api/custom-mcops/:slug/hidden", requireMcopAdmin, async (req: any, res) => {
    try {
      const sourceType = String(req.body?.sourceType || '').trim();
      const sourceId = String(req.body?.sourceId || '').trim();
      if (!sourceType || !sourceId) return res.status(400).json({ error: 'sourceType and sourceId required' });
      await storage.addCustomMcopHiddenItem(req.mcop.id, sourceType, sourceId);
      invalidateFeedCache(`custom-feed:${req.params.slug}:`);
      invalidateFeedCache(`custom-outlets:${req.params.slug}`);
      res.json({ ok: true });
    } catch (e) {
      console.error('hide item error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  app.delete("/api/custom-mcops/:slug/hidden", requireMcopAdmin, async (req: any, res) => {
    try {
      const sourceType = String(req.body?.sourceType || req.query?.sourceType || '').trim();
      const sourceId = String(req.body?.sourceId || req.query?.sourceId || '').trim();
      if (!sourceType || !sourceId) return res.status(400).json({ error: 'sourceType and sourceId required' });
      await storage.removeCustomMcopHiddenItem(req.mcop.id, sourceType, sourceId);
      invalidateFeedCache(`custom-feed:${req.params.slug}:`);
      invalidateFeedCache(`custom-outlets:${req.params.slug}`);
      res.json({ ok: true });
    } catch (e) {
      console.error('unhide item error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  app.get("/api/custom-mcops/:slug/feed", requireCustomMcopAccess, async (req: any, res) => {
    try {
      const mcop = await storage.getCustomMcopBySlug(req.params.slug);
      if (!mcop) return res.status(404).json({ error: 'Not found' });

      const isMcopAdmin = !!req.session?.adminAuthenticated || req.session?.customMcopAuth?.[mcop.id] === true || hasWarfighterAdminAccess(req, req.params.slug);

      // Short-TTL cache + single-flight coalescing for the VIEWER feed only
      // (keyed by slug). Admin reads bypass the cache AND coalescing entirely so
      // an admin always sees their own edits live, and the admin payload (which
      // exposes hidden/blocked items) can never be served to a viewer. The
      // viewer payload is identical for all non-admin viewers of this slug
      // (hidden keys + scores are per-MCOP, not per-user), so on a cold cache
      // concurrent viewers of one MCOP plus the ~25s auto-refresh share a SINGLE
      // heavy compute instead of each stacking their own — the same self-DoS the
      // main feeds already guard against (Task #701). x-mcop-no-cache still
      // bypasses both cache and coalescing (isolation-harness invariant). Admin
      // writes call invalidateFeedCache(`custom-feed:${slug}:`) so viewers
      // refresh promptly.
      const mcopFeedCacheKey = `custom-feed:${mcop.slug}:viewer`;

      const computeMcopFeed = async () => {
      const [primaryFeed, truthPosts, secWarPosts, rapidPosts, dowPosts, sentDef, alerts, manualArticles, manualScreenshots, hiddenKeys, influencerXPostsRaw] = await Promise.all([
        // 18-hour window matches the main MCOP and Stream pages so a scraped
        // story won't linger on Warfighter longer than on the primary feeds.
        storage.getPrimaryFeed(18, undefined, mcop.slug),
        storage.getRecentTruthSocialPosts(10),
        storage.getRecentXPosts(20),
        storage.getRecentRapidResponsePosts(20),
        storage.getRecentDOWResponsePosts(20),
        storage.getRecentSentDefenderPosts(20),
        storage.getRecentFirstAlerts(30),
        storage.getCustomMcopArticles(mcop.id),
        storage.getCustomMcopScreenshots(mcop.id),
        storage.getCustomMcopHiddenKeys(mcop.id),
        storage.getRecentInfluencerXPosts(50),
      ]);

      const isHidden = (sourceType: string, sourceId: string) => hiddenKeys.has(`${sourceType}:${sourceId}`);
      const hiddenOutlets = new Set<string>();
      const hiddenXAccounts = new Set<string>();
      const hiddenInfluencerXAccounts = new Set<string>();
      hiddenKeys.forEach(k => {
        if (k.startsWith('outlet:')) hiddenOutlets.add(k.slice(7));
        else if (k.startsWith('xAccount:')) hiddenXAccounts.add(k.slice(9));
        else if (k.startsWith('influencerXAccount:')) hiddenInfluencerXAccounts.add(k.slice('influencerXAccount:'.length));
      });
      const isOutletHidden = (source: string | null | undefined) =>
        !!source && hiddenOutlets.has(source.trim().toLowerCase());
      // General-X account selector — the X handles a custom MCOP viewer can hide.
      // Derived from the canonical social-account catalog (Task #1038).
      const ALL_X_ACCOUNTS = CATALOG_GENERAL_X_ACCOUNTS;
      const enabledXAccounts = ALL_X_ACCOUNTS.filter(a => !hiddenXAccounts.has(a));
      const isXAccountEnabled = (acct: string) => !hiddenXAccounts.has(acct);
      const enabledInfluencerXAccounts = INFLUENCER_X_HANDLES.filter(a => !hiddenInfluencerXAccounts.has(a));
      const isInfluencerXAccountEnabled = (acct: string) => !hiddenInfluencerXAccounts.has(acct);

      // Pull custom MCOP scores for both scraped headlines and manual submissions
      const scrapedIds = primaryFeed.filter(x => x.type === 'scraped').map(x => x.id);
      const manualIds = primaryFeed.filter(x => x.type === 'manual').map(x => x.id);
      const [headlineScoreMap, manualScoreMap] = await Promise.all([
        storage.getCustomMcopScores(mcop.id, 'headline', scrapedIds),
        storage.getCustomMcopScores(mcop.id, 'manual', manualIds),
      ]);
      const scoreMap = new Map<string, { priorityScore: number; isRelevant: boolean }>([
        ...Array.from(headlineScoreMap.entries()),
        ...Array.from(manualScoreMap.entries()),
      ]);

      const scrapedRanked = (mcop.feedFromMcop === false ? [] : primaryFeed)
        .map(h => {
          const s = scoreMap.get(h.id);
          const sourceType = h.type === 'manual' ? 'manual' : 'headline';
          const rawScore = s?.priorityScore ?? -1;
          // Apply the same time-decay used for primary-feed priority to per-MCOP scored items.
          const decayedScore = s
            ? calculateDepreciatedPriority(rawScore, null, h.scrapedAt, null).depreciatedPriority
            : rawScore;
          return { h, sourceType, score: decayedScore, rawScore, isRelevant: s?.isRelevant ?? true, scored: !!s };
        })
        .filter(x => x.isRelevant && !isHidden(x.sourceType, x.h.id) && !isOutletHidden(x.h.source))
        .sort((a, b) => {
          // Scored items first (higher decayed score wins); unscored fall to bottom by depreciated priority then recency
          if (a.scored && b.scored) return b.score - a.score;
          if (a.scored && !b.scored) return -1;
          if (!a.scored && b.scored) return 1;
          const dp = (b.h.depreciatedPriority ?? 0) - (a.h.depreciatedPriority ?? 0);
          if (dp !== 0) return dp;
          return new Date(b.h.scrapedAt).getTime() - new Date(a.h.scrapedAt).getTime();
        })
        .map(x => ({
          id: x.h.id,
          title: x.h.title,
          url: x.h.url,
          source: x.h.source,
          scrapedAt: x.h.scrapedAt,
          articlePublishedAt: x.h.articlePublishedAt ?? null,
          imageUrl: x.h.videoUrl ? `VIDEO:${x.h.videoUrl}` : x.h.ogImageUrl,
          summaryBullets: x.h.summaryBullets ?? [],
          priorityScore: x.scored ? x.score : (x.h.depreciatedPriority ?? x.h.priorityOverride ?? x.h.priorityScore),
          priorityOverride: x.h.priorityOverride ?? null,
          basePriorityScore: x.scored ? x.rawScore : x.h.priorityScore,
          type: x.sourceType,
          isCustomArticle: false,
        }));

      // Match the 18-hour scraped-headline cutoff so admin-submitted articles
      // also drop off Warfighter after 18 hours instead of lingering indefinitely.
      const CUSTOM_ARTICLE_MAX_AGE_MS = 18 * 60 * 60 * 1000;
      const customArticleCutoff = Date.now() - CUSTOM_ARTICLE_MAX_AGE_MS;
      const customArticleEntries = manualArticles
        .filter(a => !isOutletHidden(a.source))
        .filter(a => new Date(a.createdAt).getTime() >= customArticleCutoff)
        .map(a => {
        const decayed = calculateDepreciatedPriority(a.priorityScore, null, a.createdAt, null).depreciatedPriority;
        return {
          id: `custom-${a.id}`,
          title: a.title,
          url: a.url,
          source: a.source,
          scrapedAt: a.createdAt,
          articlePublishedAt: a.createdAt,
          imageUrl: a.imageUrl,
          summaryBullets: a.summaryBullets ?? [],
          priorityScore: decayed,
          priorityOverride: null,
          basePriorityScore: a.priorityScore,
          type: 'custom' as const,
          isCustomArticle: true,
        };
      });

      const ranked = [...scrapedRanked, ...customArticleEntries]
        .sort((a, b) => {
          const ds = (b.priorityScore ?? 0) - (a.priorityScore ?? 0);
          if (ds !== 0) return ds;
          return new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime();
        })
        .slice(0, 16);

      const xPosts = [
        ...secWarPosts
          .filter(p => !isHidden('x_post', p.id) && isXAccountEnabled(p.sourceAccount || 'SecWar'))
          .map(p => ({ ...p, sourceType: 'x_post', sourceAccount: p.sourceAccount || 'SecWar' })),
        ...(isXAccountEnabled('Rapidresponse47') ? rapidPosts.filter(p => !isHidden('rapidresponse_post', p.id)).map(p => ({ id: p.id, sourceType: 'rapidresponse_post', postId: p.postId, content: p.content, postedAt: p.postedAt, xUrl: p.xUrl, sourceAccount: 'Rapidresponse47', isRetweet: false, retweetedFrom: null, scrapedAt: p.scrapedAt, imageUrl: null })) : []),
        ...(isXAccountEnabled('DOWResponse') ? dowPosts.filter(p => !isHidden('dow_response_post', p.id)).map(p => ({ id: p.id, sourceType: 'dow_response_post', postId: p.postId, content: p.content, postedAt: p.postedAt, xUrl: p.xUrl, sourceAccount: 'DOWResponse', isRetweet: false, retweetedFrom: null, scrapedAt: p.scrapedAt, imageUrl: null })) : []),
        ...(isXAccountEnabled('sentdefender') ? sentDef.filter(p => !isHidden('sentdefender_post', p.id)).map(p => ({ id: p.id, sourceType: 'sentdefender_post', postId: p.postId, content: p.content, postedAt: p.postedAt, xUrl: p.xUrl, sourceAccount: 'sentdefender', isRetweet: false, retweetedFrom: null, scrapedAt: p.scrapedAt, imageUrl: p.imageUrl || null, videoUrl: p.videoUrl || null })) : []),
      ].sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());

      const filteredTruth = truthPosts.filter(p => !isHidden('truth_social', p.id));
      const filteredAlerts = alerts.filter(a => !isHidden('first_alert', a.id));
      const influencerXPosts = influencerXPostsRaw
        .filter(p => !isHidden('x_post', p.id) && isInfluencerXAccountEnabled(p.sourceAccount))
        .map(p => ({ ...p, sourceType: 'x_post' as const }));

      const mcopFeedPayload = {
        mcop: { slug: mcop.slug, name: mcop.name },
        topStories: ranked,
        truthSocialPosts: filteredTruth,
        xPosts,
        influencerXPosts,
        firstAlerts: filteredAlerts,
        screenshots: manualScreenshots,
        scoredCount: scoreMap.size,
        enabledXAccounts,
        enabledInfluencerXAccounts,
        isMcopAdmin,
      };
        return mcopFeedPayload;
      };

      // Admin reads bypass cache + coalescing entirely (live edits + admin-only
      // payload). Viewer reads are single-flight coalesced by the viewer cache
      // key so concurrent cache-miss viewers of one MCOP share one compute;
      // serveCoalescedFeed writes the viewer cache on success and honors
      // x-mcop-no-cache exactly as the main feeds do.
      if (isMcopAdmin) {
        res.json(await computeMcopFeed());
      } else {
        await serveCoalescedFeed(req, res, mcopFeedCacheKey, computeMcopFeed);
      }
    } catch (e) {
      console.error('custom mcop feed error:', e);
      res.status(500).json({ error: 'Failed to fetch feed' });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
