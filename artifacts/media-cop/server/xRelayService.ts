import { createHash } from 'crypto';
import type { IStorage } from './storage';
import { X_POSTS_ACCOUNTS } from './xScraper';
import { OSINT_ACCOUNTS, JOURNALIST_ACCOUNTS } from './osintScraper';
import { INFLUENCER_X_HANDLES } from '@shared/influencerXAccounts';
import {
  CATALOG_RAPIDRESPONSE_HANDLES,
  CATALOG_DOWRESPONSE_HANDLES,
  CATALOG_SENTDEFENDER_HANDLES,
} from '@shared/socialAccountCatalog';
import { suppressAttachmentOnlySocialImage } from './socialPostText';

// ============================================================================
// X / Twitter relay ingestion ("Evangelist Vortex" / EV).
//
// Mirrors the proven Truth Social relay architecture (external VM → webhook →
// in-memory heartbeat → WATCHDOG/PRIMARY mode), extended to X's multiple handle
// lanes. EV pushes tweet data to POST /api/webhooks/x-relay; this module
// normalizes each payload, routes it to the correct lane table by handle, and
// dedups by postId. The existing Playwright scrapers stay as automatic per-lane
// fallback — when the relay is healthy they naturally become backfill-only
// (dedup-by-postId skips anything the relay already inserted); when the relay
// goes stale (>15 min) they resume PRIMARY full-scrape duty.
//
// Fail-closed: a tweet from an unknown handle is logged and skipped, never
// written into the wrong lane. No new tables; promotes directly into the same
// lane tables the scrapers write (x_posts / osint_posts / journalist_posts /
// rapidresponse_posts / dow_response_posts / sentdefender_posts).
// ============================================================================

let lastXRelayReceivedAt = 0;
const X_RELAY_STALE_THRESHOLD = 15 * 60 * 1000; // 15 minutes — same as Truth Social relay

// --- Durable heartbeat persistence (Task #340) -----------------------------
// The in-memory value above stays the fast read path. We additionally persist
// the timestamp so it survives a redeploy/restart — otherwise MCOP boots into
// PRIMARY (scraper) mode after every deploy even when EV was healthy seconds
// earlier. The durable write is throttled (at most once per minute) and
// fire-and-forget so a burst of relay posts never hammers the DB or adds
// latency to the webhook response.
const X_RELAY_KEY = 'x';
const X_RELAY_PERSIST_INTERVAL = 60 * 1000; // throttle durable writes to ≤1/min
let xRelayStorage: IStorage | null = null;
let lastXRelayPersistedAt = 0;

// Seed the in-memory heartbeat from the persisted copy on boot and wire up the
// storage handle used by the throttled writes. Safe to call once at startup.
export async function initXRelayHeartbeat(storage: IStorage): Promise<void> {
  xRelayStorage = storage;
  try {
    const persisted = await storage.getRelayHeartbeatAt(X_RELAY_KEY);
    if (persisted) {
      const ts = persisted.getTime();
      if (!Number.isNaN(ts) && ts > lastXRelayReceivedAt) {
        lastXRelayReceivedAt = ts;
        lastXRelayPersistedAt = ts; // already in sync — no immediate re-write
        console.log(`[X-Relay] Restored heartbeat from storage: ${persisted.toISOString()} (${Math.round((Date.now() - ts) / 1000)}s ago)`);
      }
    } else {
      console.log('[X-Relay] No persisted heartbeat to restore');
    }
  } catch (err) {
    console.error('[X-Relay] Failed to restore persisted heartbeat:', err);
  }
}

export function updateXRelayHeartbeat(): void {
  const now = Date.now();
  lastXRelayReceivedAt = now;
  if (xRelayStorage && (now - lastXRelayPersistedAt) >= X_RELAY_PERSIST_INTERVAL) {
    lastXRelayPersistedAt = now;
    xRelayStorage
      .setRelayHeartbeatAt(X_RELAY_KEY, new Date(now))
      .catch(err => console.error('[X-Relay] Failed to persist heartbeat:', err));
  }
}

export function getXRelayHeartbeat(): number {
  return lastXRelayReceivedAt;
}

export function isXRelayHealthy(): boolean {
  if (lastXRelayReceivedAt === 0) return false;
  return (Date.now() - lastXRelayReceivedAt) < X_RELAY_STALE_THRESHOLD;
}

export function getXRelayMode(): 'WATCHDOG' | 'PRIMARY' {
  return isXRelayHealthy() ? 'WATCHDOG' : 'PRIMARY';
}

// ---------------------------------------------------------------------------
// Handle → lane registry. Built from the canonical source-of-truth account
// lists so the relay routes to exactly the same tables the scrapers populate.
// Lookups are case-insensitive and tolerate a leading '@'.
// ---------------------------------------------------------------------------
export type XRelayLane =
  | 'x-default'
  | 'x-influencer'
  | 'osint'
  | 'journalist'
  | 'rapidresponse'
  | 'dowresponse'
  | 'sentdefender';

// Dedicated single-handle lanes (their own scrapers/tables). Derived from the
// canonical social-account catalog (Task #1038).
const RAPIDRESPONSE_HANDLES = CATALOG_RAPIDRESPONSE_HANDLES;
const DOWRESPONSE_HANDLES = CATALOG_DOWRESPONSE_HANDLES;
const SENTDEFENDER_HANDLES = CATALOG_SENTDEFENDER_HANDLES;

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, '').toLowerCase();
}

const HANDLE_LANE_REGISTRY: Map<string, XRelayLane> = (() => {
  const map = new Map<string, XRelayLane>();
  const register = (handles: readonly string[], lane: XRelayLane) => {
    for (const h of handles) {
      const key = normalizeHandle(h);
      // First registration wins so a handle can't be silently reassigned to a
      // different lane by list ordering — keeps routing deterministic.
      if (!map.has(key)) map.set(key, lane);
    }
  };
  // Dedicated lanes first so their handles always win over any overlap.
  register(RAPIDRESPONSE_HANDLES, 'rapidresponse');
  register(DOWRESPONSE_HANDLES, 'dowresponse');
  register(SENTDEFENDER_HANDLES, 'sentdefender');
  register(OSINT_ACCOUNTS, 'osint');
  register(JOURNALIST_ACCOUNTS, 'journalist');
  register(INFLUENCER_X_HANDLES, 'x-influencer');
  register(X_POSTS_ACCOUNTS, 'x-default');
  return map;
})();

export function resolveXRelayLane(handle: string | null | undefined): XRelayLane | null {
  if (!handle) return null;
  return HANDLE_LANE_REGISTRY.get(normalizeHandle(handle)) ?? null;
}

// ---------------------------------------------------------------------------
// Payload normalization — tolerant field resolver mirroring the Truth Social
// relay's normalizeRelayPost so EV can send a variety of field names.
// ---------------------------------------------------------------------------
function resolveField(obj: any, ...candidates: string[]): any {
  for (const key of candidates) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

function generatePostId(content: string): string {
  return 'xrelay-' + createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export interface NormalizedXRelayPost {
  handle: string;
  postId: string;
  content: string;
  postedAt: Date;
  xUrl: string;
  imageUrl: string | null;
  videoUrl: string | null;
  isRetweet: boolean;
  retweetedFrom: string | null;
}

export function normalizeXRelayPost(raw: any): NormalizedXRelayPost | null {
  if (!raw || typeof raw !== 'object') return null;

  const handle = resolveField(
    raw,
    'handle', 'username', 'account', 'sourceAccount', 'source_account',
    'screen_name', 'screenName', 'user', 'author', 'authorHandle',
  );
  const handleStr = handle ? String(handle).trim().replace(/^@+/, '') : null;
  if (!handleStr) return null;

  const content = resolveField(
    raw,
    'content', 'text', 'body', 'message', 'status', 'description',
    'post_content', 'post_text', 'full_text', 'tweet', 'tweet_text', 'note',
  );
  // X posts can be media-only; allow empty content but coerce to a string.
  const contentStr = content !== undefined && content !== null ? String(content) : '';

  const postId = resolveField(
    raw,
    'postId', 'post_id', 'id', 'statusId', 'status_id', 'tweetId', 'tweet_id',
    'externalId', 'external_id', 'uid',
  );
  const postIdStr = postId ? String(postId) : generatePostId(contentStr || `${handleStr}-${Date.now()}`);

  const timestamp = resolveField(
    raw,
    'postedAt', 'posted_at', 'created_at', 'createdAt', 'timestamp', 'date',
    'published_at', 'publishedAt', 'time',
  );
  let postedAt: Date;
  if (timestamp) {
    const parsed = new Date(timestamp);
    postedAt = isNaN(parsed.getTime()) ? new Date() : parsed;
  } else {
    postedAt = new Date();
  }

  const url = resolveField(
    raw,
    'xUrl', 'x_url', 'url', 'link', 'post_url', 'permalink', 'href',
    'tweet_url', 'tweetUrl', 'source_url',
  );
  const xUrl = url ? String(url) : `https://x.com/${handleStr}/status/${postIdStr}`;

  let imageUrl = resolveField(
    raw,
    'imageUrl', 'image_url', 'image', 'media_url', 'photo', 'photo_url',
    'picture', 'thumbnail', 'thumb', 'media_image',
  );
  let videoUrl = resolveField(
    raw,
    'videoUrl', 'video_url', 'video', 'media_video', 'video_link',
  );

  // Mastodon/Twitter-style media_attachments array unwrap (same as Truth relay).
  const attachments = resolveField(raw, 'media_attachments', 'mediaAttachments', 'attachments', 'media');
  if (Array.isArray(attachments) && attachments.length > 0) {
    for (const att of attachments) {
      if (!att || typeof att !== 'object') continue;
      const attType = String(att.type || '').toLowerCase();
      if (!imageUrl && (attType === 'image' || attType === 'photo')) {
        const imgSrc = att.url || att.remote_url;
        if (imgSrc) imageUrl = imgSrc;
      }
      if (!videoUrl && (attType === 'video' || attType === 'gifv' || attType === 'animated_gif')) {
        const vidSrc = att.url || att.remote_url;
        if (vidSrc) videoUrl = vidSrc;
      }
      if (imageUrl && videoUrl) break;
    }
  }

  const isRetweet = !!resolveField(raw, 'isRetweet', 'is_retweet', 'isRepost', 'is_repost', 'retweet', 'repost');
  const retweetedFrom = resolveField(raw, 'retweetedFrom', 'retweeted_from', 'repostedFrom', 'reposted_from', 'rt_from');

  return {
    handle: handleStr,
    postId: postIdStr,
    content: contentStr,
    postedAt,
    xUrl,
    imageUrl: suppressAttachmentOnlySocialImage(
      contentStr,
      imageUrl ? String(imageUrl) : null,
    ),
    videoUrl: videoUrl ? String(videoUrl) : null,
    isRetweet,
    retweetedFrom: retweetedFrom ? String(retweetedFrom) : null,
  };
}

// ---------------------------------------------------------------------------
// Routing — dedup by postId against the target lane table, then insert. Mirrors
// the scraper's own write path exactly (same fields, raw media URLs, no OCR /
// object-storage persistence — the X scrapers don't do those either).
// ---------------------------------------------------------------------------
export type XRelayRouteResult = 'inserted' | 'duplicate' | 'unknown-handle' | 'error';

export async function routeXRelayPost(
  storage: IStorage,
  post: NormalizedXRelayPost,
): Promise<XRelayRouteResult> {
  const lane = resolveXRelayLane(post.handle);
  if (!lane) {
    console.warn(`[X-Relay] Unknown handle @${post.handle} — skipping (fail-closed, no lane)`);
    return 'unknown-handle';
  }

  try {
    switch (lane) {
      case 'x-default':
      case 'x-influencer': {
        const existing = await storage.getXPostByPostId(post.postId);
        if (existing) return 'duplicate';
        await storage.addXPost({
          postId: post.postId,
          content: post.content,
          postedAt: post.postedAt,
          xUrl: post.xUrl,
          sourceAccount: post.handle,
          accountCategory: lane === 'x-influencer' ? 'influencer' : 'default',
          isRetweet: post.isRetweet,
          retweetedFrom: post.retweetedFrom,
          imageUrl: post.imageUrl,
          isHidden: false,
        });
        return 'inserted';
      }
      case 'osint': {
        const existing = await storage.getOsintPostByPostId(post.postId);
        if (existing) return 'duplicate';
        await storage.addOsintPost({
          postId: post.postId,
          content: post.content,
          postedAt: post.postedAt,
          xUrl: post.xUrl,
          sourceAccount: post.handle,
          imageUrl: post.imageUrl,
          videoUrl: post.videoUrl,
          isRetweet: post.isRetweet,
          retweetedFrom: post.retweetedFrom,
          isHidden: false,
        });
        return 'inserted';
      }
      case 'journalist': {
        const existing = await storage.getJournalistPostByPostId(post.postId);
        if (existing) return 'duplicate';
        await storage.addJournalistPost({
          postId: post.postId,
          content: post.content,
          postedAt: post.postedAt,
          xUrl: post.xUrl,
          sourceAccount: post.handle,
          imageUrl: post.imageUrl,
          videoUrl: post.videoUrl,
          isRetweet: post.isRetweet,
          retweetedFrom: post.retweetedFrom,
          isHidden: false,
        });
        return 'inserted';
      }
      case 'rapidresponse': {
        const existing = await storage.getRapidResponsePostByPostId(post.postId);
        if (existing) return 'duplicate';
        await storage.addRapidResponsePost({
          postId: post.postId,
          content: post.content,
          postedAt: post.postedAt,
          xUrl: post.xUrl,
          imageUrl: post.imageUrl,
          isRetweet: post.isRetweet,
          retweetedFrom: post.retweetedFrom,
          isHidden: false,
        });
        return 'inserted';
      }
      case 'dowresponse': {
        const existing = await storage.getDOWResponsePostByPostId(post.postId);
        if (existing) return 'duplicate';
        await storage.addDOWResponsePost({
          postId: post.postId,
          content: post.content,
          postedAt: post.postedAt,
          xUrl: post.xUrl,
          imageUrl: post.imageUrl,
          isRetweet: post.isRetweet,
          retweetedFrom: post.retweetedFrom,
          isHidden: false,
        });
        return 'inserted';
      }
      case 'sentdefender': {
        const existing = await storage.getSentDefenderPostByPostId(post.postId);
        if (existing) return 'duplicate';
        await storage.addSentDefenderPost({
          postId: post.postId,
          content: post.content,
          postedAt: post.postedAt,
          xUrl: post.xUrl,
          imageUrl: post.imageUrl,
          videoUrl: post.videoUrl,
          isRetweet: post.isRetweet,
          retweetedFrom: post.retweetedFrom,
          isHidden: false,
        });
        return 'inserted';
      }
    }
  } catch (error: any) {
    // Unique-constraint race (concurrent scraper insert) is a benign duplicate.
    if (error?.code === '23505') return 'duplicate';
    console.error(`[X-Relay] Error routing post ${post.postId} (@${post.handle} → ${lane}):`, error);
    return 'error';
  }
}

// Unwrap the relay body into an array of raw post objects (mirrors the Truth
// Social relay's extractPostsFromBody tolerance for {posts:[...]}, {data:[...]},
// a bare array, or a single object).
export function extractXRelayPosts(body: any): any[] {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (typeof body === 'object') {
    const arrayField =
      body.posts ?? body.data ?? body.items ?? body.tweets ?? body.results ?? body.records;
    if (Array.isArray(arrayField)) return arrayField;
    // Single post object.
    return [body];
  }
  return [];
}
