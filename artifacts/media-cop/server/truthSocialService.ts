import { scrapeTruthSocialPrimary } from './truthSocialScraper';
import { scrapeTruthSocialBackup } from './truthSocialBackupScraper';
import { processPostImages } from './imageTextExtractor';
import { IStorage } from './storage';
import { sendPOTUSAlert } from './twilioService';
import {
  isAttachmentOnlySocialContent,
} from './socialPostText';

let lastRelayReceivedAt: number = 0;
const RELAY_STALE_THRESHOLD = 15 * 60 * 1000;

// --- Durable heartbeat persistence (Task #340) -----------------------------
// The in-memory value above stays the fast read path. We additionally persist
// the timestamp so it survives a redeploy/restart — otherwise MCOP boots into
// PRIMARY (scraper) mode after every deploy even when the relay was healthy
// seconds earlier. The durable write is throttled (at most once per minute) and
// fire-and-forget so a burst of relay posts never hammers the DB or adds
// latency to the webhook response. Mirrors the X relay (server/xRelayService.ts).
const RELAY_KEY = 'truth-social';
const RELAY_PERSIST_INTERVAL = 60 * 1000; // throttle durable writes to ≤1/min
let relayStorage: IStorage | null = null;
let lastRelayPersistedAt = 0;

// Seed the in-memory heartbeat from the persisted copy on boot and wire up the
// storage handle used by the throttled writes. Safe to call once at startup.
export async function initRelayHeartbeat(storage: IStorage): Promise<void> {
  relayStorage = storage;
  try {
    const persisted = await storage.getRelayHeartbeatAt(RELAY_KEY);
    if (persisted) {
      const ts = persisted.getTime();
      if (!Number.isNaN(ts) && ts > lastRelayReceivedAt) {
        lastRelayReceivedAt = ts;
        lastRelayPersistedAt = ts; // already in sync — no immediate re-write
        console.log(`[Relay] Restored Truth Social heartbeat from storage: ${persisted.toISOString()} (${Math.round((Date.now() - ts) / 1000)}s ago)`);
      }
    } else {
      console.log('[Relay] No persisted Truth Social heartbeat to restore');
    }
  } catch (err) {
    console.error('[Relay] Failed to restore persisted Truth Social heartbeat:', err);
  }
}

export function updateRelayHeartbeat() {
  const now = Date.now();
  lastRelayReceivedAt = now;
  if (relayStorage && (now - lastRelayPersistedAt) >= RELAY_PERSIST_INTERVAL) {
    lastRelayPersistedAt = now;
    relayStorage
      .setRelayHeartbeatAt(RELAY_KEY, new Date(now))
      .catch(err => console.error('[Relay] Failed to persist Truth Social heartbeat:', err));
  }
}

export function getRelayHeartbeat(): number {
  return lastRelayReceivedAt;
}

export function isRelayHealthy(): boolean {
  if (lastRelayReceivedAt === 0) return false;
  return (Date.now() - lastRelayReceivedAt) < RELAY_STALE_THRESHOLD;
}

export function filterAvatarImage(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  if (/\/(avatars?|accounts?\/avatars?|profile_images?|headers?)\//i.test(imageUrl)) {
    console.log(`[TruthSocial] Filtered avatar/profile image: ${imageUrl}`);
    return null;
  }
  return imageUrl;
}

export function filterTruthSocialPostImage(
  _content: string | null | undefined,
  imageUrl: string | null | undefined,
): string | null {
  // Keep legitimate image-only Truth Social posts visible in the dedicated
  // social feed. Curated story/card media has its own source-aware selector
  // (curatedStoryImages.ts), which independently rejects all social images.
  return filterAvatarImage(imageUrl);
}

export function extractTruthSocialPayloadImage(rawPayload: string | null | undefined): string | null {
  if (!rawPayload) return null;
  try {
    const parsed = JSON.parse(rawPayload);
    const attachments = Array.isArray(parsed?.media_attachments) ? parsed.media_attachments : [];
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== 'object') continue;
      const type = String(attachment.type || '').toLowerCase();
      if (type !== 'image' && type !== 'photo') continue;
      const candidate = attachment.url || attachment.remote_url || attachment.preview_url;
      const filtered = filterAvatarImage(typeof candidate === 'string' ? candidate : null);
      if (filtered) return filtered;
    }
  } catch {
    // Historical relay payloads are untrusted input. A malformed row must not
    // prevent startup or block repair of the remaining valid rows.
  }
  return null;
}

/**
 * Repair image-only Truth Social cards affected by the former ingest-time
 * suppression rule. The relay staging table retains the original payload, so
 * this is idempotent and restores only missing images on attachment-only rows.
 */
export async function repairTruthSocialAttachmentImages(storage: IStorage): Promise<number> {
  const relayRows = await storage.getRecentRelayTruthSocialPosts(500);
  let repaired = 0;

  for (const relayRow of relayRows) {
    if (!isAttachmentOnlySocialContent(relayRow.content)) continue;
    const recoveredImage = relayRow.imageUrl || extractTruthSocialPayloadImage(relayRow.rawPayload);
    if (!recoveredImage) continue;

    if (!relayRow.imageUrl) {
      await storage.updateRelayTruthSocialPostMedia(relayRow.id, { imageUrl: recoveredImage });
    }

    const mainPost = await storage.getTruthSocialPostByPostId(relayRow.postId);
    if (
      mainPost &&
      !mainPost.imageUrl &&
      isAttachmentOnlySocialContent(mainPost.content)
    ) {
      await storage.updateTruthSocialPostImage(mainPost.id, recoveredImage);
      repaired++;
    }
  }

  if (repaired > 0) {
    console.log(`[TruthSocial] Restored images for ${repaired} attachment-only post(s)`);
  }
  return repaired;
}

// Normalize content for duplicate detection - removes URLs, whitespace, punctuation
function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, '') // Remove URLs
    .replace(/\s+/g, '') // Remove all whitespace  
    .replace(/[^\w]/g, '') // Remove punctuation
    .trim();
}

// Check if two posts are duplicates based on content similarity
function isDuplicateContent(content1: string, content2: string, logMatch: boolean = false): boolean {
  const norm1 = normalizeContent(content1);
  const norm2 = normalizeContent(content2);
  
  if (norm1.length < 10 || norm2.length < 10) {
    return false;
  }
  
  if (norm1.substring(0, 80) === norm2.substring(0, 80)) {
    if (logMatch) {
      console.log(`  Dedup match (first-80): "${content1.substring(0, 50)}..." matched "${content2.substring(0, 50)}..."`);
    }
    return true;
  }
  
  if (norm1.length > 50 && norm2.length > 50) {
    const sub1 = norm1.substring(0, 50);
    const sub2 = norm2.substring(0, 50);
    if (sub1.length >= 30 && sub2.length >= 30) {
      if (norm1.substring(0, 50) === norm2.substring(0, 50)) {
        if (logMatch) {
          console.log(`  Dedup match (first-50): "${content1.substring(0, 50)}..." matched "${content2.substring(0, 50)}..."`);
        }
        return true;
      }
    }
  }
  
  return false;
}

// Grace period: when the bridge is healthy and the scraper sees a very fresh
// post, defer it for one cycle so the bridge has a chance to deliver first.
// This prevents the race where the scraper writes a degraded version moments
// before the bridge would have delivered the canonical version.
const SCRAPER_GRACE_PERIOD_MS = 3 * 60 * 1000;
function shouldDeferToBridge(postedAt: Date | string, relayHealthy: boolean): boolean {
  if (!relayHealthy) return false;
  const ageMs = Date.now() - new Date(postedAt).getTime();
  return ageMs >= 0 && ageMs < SCRAPER_GRACE_PERIOD_MS;
}

export async function scrapeAllTruthSocial(storage: IStorage): Promise<number> {
  let addedCount = 0;
  let primaryCount = 0;
  let backupCount = 0;
  
  const relayHealthy = isRelayHealthy();
  const heartbeat = getRelayHeartbeat();
  const relayAge = heartbeat > 0 ? Math.round((Date.now() - heartbeat) / 1000) : -1;
  const mode = relayHealthy ? 'WATCHDOG' : 'PRIMARY';
  
  console.log(`[TruthSocial] Scraper mode: ${mode} | Relay heartbeat: ${relayAge === -1 ? 'NEVER' : `${relayAge}s ago`} | Relay healthy: ${relayHealthy}`);
  
  const recentPosts = await storage.getRecentTruthSocialPosts(100);
  
  console.log('Scraping primary source (TrumpsTruth.org)...');
  const primaryPosts = await scrapeTruthSocialPrimary();
  
  for (const post of primaryPosts) {
    try {
      const attachmentOnly = isAttachmentOnlySocialContent(post.content);
      post.imageUrl = filterTruthSocialPostImage(post.content, post.imageUrl);

      const existingById = await storage.getTruthSocialPostByPostId(post.postId);
      if (existingById) {
        if (!existingById.imageUrl && post.imageUrl) {
          await storage.updateTruthSocialPostImage(existingById.id, post.imageUrl);
          if (relayHealthy) console.log(`[Watchdog] Enriched image for relay post ${post.postId}`);
        }
        continue;
      }

      // Bridge-wins: if a row already exists for this Truth Social URL (the
      // bridge got there first), enrich it with any media the scraper has and
      // skip — never duplicate.
      if (post.truthSocialUrl) {
        const urlMatch = await storage.getTruthSocialPostByTruthSocialUrl(post.truthSocialUrl);
        if (urlMatch) {
          if (!urlMatch.imageUrl && post.imageUrl) {
            await storage.updateTruthSocialPostImage(urlMatch.id, post.imageUrl);
          }
          continue;
        }
      }

      if (!attachmentOnly) {
        const isDuplicate = recentPosts.some(existing => isDuplicateContent(post.content, existing.content, true));
        if (isDuplicate) {
          continue;
        }
      }

      // Grace period: if the bridge is healthy and the post is very fresh,
      // defer this scraper insert by a cycle so the bridge can deliver the
      // canonical version first.
      if (shouldDeferToBridge(post.postedAt, relayHealthy)) {
        console.log(`[TruthSocial] Deferring fresh scraper post ${post.postId} (age < 3min, bridge healthy) — waiting for bridge`);
        continue;
      }

      if (relayHealthy) {
        console.log(`[Watchdog] BACKFILL: Scraper found post ${post.postId} missing from relay — adding: "${post.content.substring(0, 60)}..."`);
      }
      
      await storage.addTruthSocialPost(post);
      const postAge = Date.now() - new Date(post.postedAt).getTime();
      if (postAge < 60 * 60 * 1000) {
        sendPOTUSAlert({
          content: post.content,
          postedAt: post.postedAt,
          truthSocialUrl: post.truthSocialUrl,
          imageUrl: post.imageUrl,
          extractedImageText: null,
          isReblog: post.isReblog,
          rebloggedFrom: post.rebloggedFrom,
        }).catch(err => console.error('[SMS] Fire-and-forget error:', err));
      }
      recentPosts.push({ content: post.content, postId: post.postId, imageUrl: post.imageUrl } as any);
      primaryCount++;
      addedCount++;
    } catch (error) {
      console.error(`Error saving primary post ${post.postId}:`, error);
    }
  }
  
  console.log(`Primary source: Added ${primaryCount} new posts${relayHealthy ? ' (watchdog backfill)' : ''}`);
  
  console.log('Scraping backup source (CivicTracker)...');
  const backupPosts = await scrapeTruthSocialBackup();
  
  for (const post of backupPosts) {
    try {
      const attachmentOnly = isAttachmentOnlySocialContent(post.content);
      post.imageUrl = filterTruthSocialPostImage(post.content, post.imageUrl);

      const existingById = await storage.getTruthSocialPostByPostId(post.postId);
      if (existingById) {
        if (!existingById.imageUrl && post.imageUrl) {
          await storage.updateTruthSocialPostImage(existingById.id, post.imageUrl);
          console.log(`Updated image for existing post ${post.postId}`);
        }
        continue;
      }

      if (post.truthSocialUrl) {
        const urlMatch = await storage.getTruthSocialPostByTruthSocialUrl(post.truthSocialUrl);
        if (urlMatch) {
          if (!urlMatch.imageUrl && post.imageUrl) {
            await storage.updateTruthSocialPostImage(urlMatch.id, post.imageUrl);
          }
          continue;
        }
      }

      if (!attachmentOnly) {
        const contentMatch = recentPosts.find(existing => isDuplicateContent(post.content, existing.content, true));
        if (contentMatch) {
          if (!contentMatch.imageUrl && post.imageUrl && contentMatch.id) {
            await storage.updateTruthSocialPostImage(contentMatch.id, post.imageUrl);
          }
          continue;
        }
      }

      if (shouldDeferToBridge(post.postedAt, relayHealthy)) {
        console.log(`[TruthSocial] Deferring fresh backup scraper post ${post.postId} (age < 3min, bridge healthy) — waiting for bridge`);
        continue;
      }

      if (relayHealthy) {
        console.log(`[Watchdog] BACKFILL: Backup scraper found post ${post.postId} missing — adding: "${post.content.substring(0, 60)}..."`);
      }
      
      await storage.addTruthSocialPost(post);
      const postAge = Date.now() - new Date(post.postedAt).getTime();
      if (postAge < 60 * 60 * 1000) {
        sendPOTUSAlert({
          content: post.content,
          postedAt: post.postedAt,
          truthSocialUrl: post.truthSocialUrl,
          imageUrl: post.imageUrl,
          extractedImageText: null,
          isReblog: post.isReblog,
          rebloggedFrom: post.rebloggedFrom,
        }).catch(err => console.error('[SMS] Fire-and-forget error:', err));
      }
      recentPosts.push({ content: post.content, postId: post.postId, imageUrl: post.imageUrl } as any);
      backupCount++;
      addedCount++;
    } catch (error) {
      console.error(`Error saving backup post ${post.postId}:`, error);
    }
  }
  
  console.log(`Backup source: Added ${backupCount} new posts${relayHealthy ? ' (watchdog backfill)' : ''}`);
  console.log(`[TruthSocial] ${mode} mode complete: ${addedCount} new posts total (${primaryCount} primary, ${backupCount} backup)`);
  
  // Post-processing: analyze images for text extraction on posts that haven't been processed yet
  try {
    const allRecentPosts = await storage.getRecentTruthSocialPosts(50);
    const postsNeedingAnalysis = allRecentPosts.filter(
      p => p.imageUrl && !p.extractedImageText
    );
    
    if (postsNeedingAnalysis.length > 0) {
      console.log(`[ImageTextExtractor] Found ${postsNeedingAnalysis.length} posts with images needing analysis`);
      
      const extractedTexts = await processPostImages(
        postsNeedingAnalysis.map(p => ({
          postId: p.postId,
          imageUrl: p.imageUrl,
          content: p.content,
        }))
      );
      
      const entries = Array.from(extractedTexts.entries());
      for (let i = 0; i < entries.length; i++) {
        const [postId, text] = entries[i];
        const post = postsNeedingAnalysis.find(p => p.postId === postId);
        if (post) {
          await storage.updateTruthSocialPostExtractedText(post.id, text);
        }
      }
    }
  } catch (error) {
    console.error('[ImageTextExtractor] Error during image analysis:', error);
  }
  
  return addedCount;
}

// Clean up existing duplicate Truth Social posts in the database
export async function deduplicateTruthSocialPosts(storage: IStorage): Promise<number> {
  console.log('[Dedup] Starting Truth Social deduplication...');
  
  const allPosts = await storage.getRecentTruthSocialPosts(500);
  const seenContent = new Map<string, { id: string; postedAt: Date }>();
  const duplicateIds: string[] = [];
  
  // Sort by postedAt so we keep the earliest post
  allPosts.sort((a, b) => new Date(a.postedAt).getTime() - new Date(b.postedAt).getTime());
  
  for (const post of allPosts) {
    const normalized = normalizeContent(post.content).substring(0, 80);
    
    if (normalized.length < 20) continue; // Skip very short posts
    
    const existing = seenContent.get(normalized);
    if (existing) {
      // This is a duplicate - mark for deletion
      duplicateIds.push(post.id);
      console.log(`[Dedup] Found duplicate: "${post.content.substring(0, 50)}..." (keeping post from ${existing.postedAt})`);
    } else {
      seenContent.set(normalized, { id: post.id, postedAt: post.postedAt });
    }
  }
  
  // Delete duplicates
  for (const id of duplicateIds) {
    await storage.deleteTruthSocialPost(id);
  }
  
  console.log(`[Dedup] Removed ${duplicateIds.length} duplicate Truth Social posts`);
  return duplicateIds.length;
}
