import type { Response } from "express";
import generateETag from "etag";
import { sampleEventLoopDelay } from "./eventLoop";

// ---------------------------------------------------------------------------
// Non-curated feed cache + single-flight request coalescing (prod perf).
//
// Extracted from routes.ts so the coalescing edge behavior can be exercised by
// an automated harness (scripts/feed-coalesce.test.ts) without booting the full
// Express app. `createFeedCoalescer()` owns the per-process cache Map and the
// in-flight Map and returns the same helper set routes.ts destructures, so
// every existing call site stays byte-identical.
//
// The heavy read feeds — /api/stream, /api/headline-feed (Classic),
// /api/custom-mcops/:slug/feed, /api/war/feed — each run several DB queries on
// every request and return a payload that is identical for every user in the
// same audience class. A short TTL collapses the repeat work without changing
// what is shown; each route's auth guard still runs first, so only the COMPUTED
// data is served from memory when warm.
//
// Kept SEPARATE from the curated-lane-only curatedReadCache so the invariant
// "curated never shares a cache with Classic/Visual/custom-MCOP" holds.
//
// Honors `x-mcop-no-cache`: the curated isolation harness sends that header on
// every request and relies on it to (a) prove byte-identity across a pass and
// (b) inject a canary then read each feed asserting absence. If a cache did
// not honor it, a stale pre-injection snapshot could mask a real leak, so the
// header MUST force a fresh compute on every cached feed (incl. /api/stream).
// The bypass path also still serves via res.json on its own fresh compute — it
// never reads the serialized cache.
//
// Keys are namespaced by feed (+ params/slug/role) so audiences and slugs
// never collide. Error responses are never cached.
//
// SERIALIZED-RESPONSE CACHING (Task #1023): production logs showed coalescing
// collapsed the COMPUTE but not the SERVE — every warm hit and every coalesced
// waiter paid its own res.json → JSON.stringify + express ETag hash of a
// multi-hundred-KB payload on the single event loop (same-ms coalesced pairs
// finished ~700ms apart; even 304s cost seconds because the ETag is computed
// from a full fresh stringify). The cache entry now carries the serialized
// body + ETag, computed ONCE per fill (lazily on first serve), so warm hits
// and waiters just send pre-built bytes and If-None-Match matches short-circuit
// to a near-free 304. `JSON.stringify(data)` + `etag(body, {weak:true})` are
// exactly what express res.json/send produce (no `json spaces`/`etag` app
// overrides exist), so response bytes are byte-identical to the previous path.

type FeedCacheEntry = {
  at: number;
  ttl: number;
  data: any;
  // Lazily-computed serialized form (see header comment). Never read by the
  // raw getFeedCache()/setFeedCache() object-semantics callers.
  body?: string;
  etag?: string;
};

export const FEED_CACHE_MAX_KEYS = 200;
export const FEED_CACHE_TTL_MS = 25_000;

// A prewarm refresh only does real work when the cached entry is missing,
// expired, or older than this — keeps a ~20s keeper tick from recomputing a
// just-filled entry.
export const FEED_PREWARM_MIN_AGE_MS = 15_000;

// Aggregate serve counters per feed family (first `:`-segment of the cache
// key). Logged as one summary line every FEED_STATS_LOG_INTERVAL_MS so prod
// hit/miss/coalesce rates are visible without per-request log spam.
export type FeedServeStats = {
  hit: number;
  miss: number;
  coalesced: number;
  bypass: number;
  notModified: number; // 304s served from the precomputed ETag (subset of hit/coalesced)
  prewarm: number;     // background prewarm computes (not request-driven)
  computeMsTotal: number;
  computeMsMax: number;
};
const FEED_STATS_LOG_INTERVAL_MS = 5 * 60_000;
const zeroStats = (): FeedServeStats => ({
  hit: 0, miss: 0, coalesced: 0, bypass: 0, notModified: 0, prewarm: 0, computeMsTotal: 0, computeMsMax: 0,
});

export interface FeedCoalescer {
  shouldBypassFeedCache: (req: any) => boolean;
  getFeedCache: (req: any, key: string) => any | undefined;
  setFeedCache: (key: string, data: any, ttlMs?: number) => void;
  invalidateFeedCache: (prefix?: string) => void;
  invalidateMainFeeds: () => void;
  serveCoalescedFeed: (
    req: any,
    res: Response,
    cacheKey: string,
    compute: () => Promise<any>,
    ttlMs?: number,
  ) => Promise<void>;
  // Background refresh for a hot key: skips when a compute is already in
  // flight or the entry is fresher than minAgeMs; otherwise computes, fills
  // the cache AND pre-serializes so no request ever pays the stringify.
  // Best-effort — errors are logged and swallowed (the route still computes
  // on demand). Concurrent cache-miss requests coalesce onto the prewarm.
  prewarmFeed: (
    key: string,
    compute: () => Promise<any>,
    opts?: { ttlMs?: number; minAgeMs?: number },
  ) => Promise<void>;
  // Millisecond timestamp of the last non-bypass request read for a key (any
  // of hit/miss/coalesced). Used by the keep-warm loop to idle out keys nobody
  // is watching. Undefined = never read since boot.
  lastFeedReadAt: (key: string) => number | undefined;
  // Register a callback fired (fire-and-forget) whenever invalidateMainFeeds
  // drops the Classic+Visual keys, so a keep-warm loop can rebuild them right
  // after a feed-shaping write instead of waiting for the next tick.
  onMainFeedsInvalidated: (fn: () => void) => void;
  // Test-only introspection: how many keys currently have an in-flight promise.
  _inFlightSize: () => number;
  // Test-only introspection: aggregate serve counters per feed family.
  _stats: () => Record<string, FeedServeStats>;
}

export function createFeedCoalescer(): FeedCoalescer {
  const feedReadCache = new Map<string, FeedCacheEntry>();
  const lastReadAt = new Map<string, number>();

  const stats = new Map<string, FeedServeStats>();
  let statsDirty = false;
  const statFor = (cacheKey: string): FeedServeStats => {
    const family = cacheKey.split(":")[0];
    let s = stats.get(family);
    if (!s) {
      s = zeroStats();
      stats.set(family, s);
    }
    statsDirty = true;
    return s;
  };
  const recordCompute = (s: FeedServeStats, ms: number): void => {
    s.computeMsTotal += ms;
    if (ms > s.computeMsMax) s.computeMsMax = ms;
  };
  // One compact summary line per window (only when something happened), plus
  // the event-loop delay percentiles over the same window — the "is the single
  // process stalling reads" signal the task asked to measure.
  const statsLogTimer = setInterval(() => {
    if (!statsDirty) return;
    statsDirty = false;
    const parts: string[] = [];
    for (const [family, s] of stats) {
      const total = s.hit + s.miss + s.coalesced + s.bypass;
      if (total === 0 && s.prewarm === 0) continue;
      parts.push(
        `${family}: hit=${s.hit} miss=${s.miss} coalesced=${s.coalesced} bypass=${s.bypass} 304=${s.notModified} prewarm=${s.prewarm} computeMsMax=${Math.round(s.computeMsMax)}`,
      );
      stats.set(family, zeroStats());
    }
    if (parts.length === 0) return;
    const el = sampleEventLoopDelay();
    console.log(`[FeedCache] 5m summary — ${parts.join(" | ")} | loopDelayP95=${el.p95Ms}ms max=${el.maxMs}ms`);
  }, FEED_STATS_LOG_INTERVAL_MS);
  statsLogTimer.unref?.();

  const shouldBypassFeedCache = (req: any): boolean => !!req?.headers?.['x-mcop-no-cache'];

  const readEntry = (key: string): FeedCacheEntry | undefined => {
    const entry = feedReadCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > entry.ttl) { feedReadCache.delete(key); return undefined; }
    return entry;
  };
  const getFeedCache = (req: any, key: string): any | undefined => {
    if (shouldBypassFeedCache(req)) return undefined;
    return readEntry(key)?.data;
  };
  const writeEntry = (key: string, data: any, ttlMs: number = FEED_CACHE_TTL_MS): FeedCacheEntry => {
    const entry: FeedCacheEntry = { at: Date.now(), ttl: ttlMs, data };
    feedReadCache.set(key, entry);
    if (feedReadCache.size > FEED_CACHE_MAX_KEYS) {
      const now = Date.now();
      for (const k of Array.from(feedReadCache.keys())) {
        const e = feedReadCache.get(k);
        if (e && now - e.at > e.ttl) feedReadCache.delete(k);
      }
      for (const k of Array.from(feedReadCache.keys())) {
        if (feedReadCache.size <= FEED_CACHE_MAX_KEYS) break;
        feedReadCache.delete(k); // oldest insertion first (Map preserves order)
      }
    }
    return entry;
  };
  const setFeedCache = (key: string, data: any, ttlMs: number = FEED_CACHE_TTL_MS): void => {
    writeEntry(key, data, ttlMs);
  };
  const invalidateFeedCache = (prefix?: string): void => {
    if (!prefix) { feedReadCache.clear(); return; }
    for (const k of Array.from(feedReadCache.keys())) {
      if (k.startsWith(prefix)) feedReadCache.delete(k);
    }
  };
  // The Classic (/api/headline-feed) and Visual (/api/stream) feeds both derive
  // from the shared headline + manual-submission core, so any write to that core
  // must drop BOTH cached feeds — otherwise admin moderation (block / priority /
  // title / url edits) and new manual submissions stay invisible for up to the
  // 25s TTL. Social-only writes (Truth/X posts) appear ONLY on Stream and call
  // invalidateFeedCache('stream') directly instead.
  let mainFeedsInvalidatedHook: (() => void) | null = null;
  const invalidateMainFeeds = (): void => {
    invalidateFeedCache('headline-feed');
    invalidateFeedCache('stream');
    // Let the keep-warm loop rebuild the dropped keys right away (debounced on
    // the registered side) so the next poll after a write is still a warm hit.
    if (mainFeedsInvalidatedHook) {
      try { mainFeedsInvalidatedHook(); } catch { /* keep-warm is best-effort */ }
    }
  };

  // Serialize once per cache fill (lazily on the first serialized serve) and
  // reuse for every subsequent hit/waiter/304. See header comment.
  const ensureSerialized = (entry: FeedCacheEntry): { body: string; etag: string } => {
    if (entry.body === undefined) {
      entry.body = JSON.stringify(entry.data);
      entry.etag = generateETag(entry.body, { weak: true });
    }
    return { body: entry.body, etag: entry.etag! };
  };
  const sendCachedEntry = (req: any, res: Response, entry: FeedCacheEntry, s: FeedServeStats): void => {
    const { body, etag } = ensureSerialized(entry);
    // Set the ETag BEFORE consulting req.fresh — express's freshness check
    // compares the request's If-None-Match against the RESPONSE ETag header.
    res.set('ETag', etag);
    if ((req as any)?.fresh) {
      s.notModified++;
      res.status(304).end();
      return;
    }
    res.type('application/json').send(body);
  };

  // Single-flight (request coalescing) for the public feeds — /api/stream,
  // /api/headline-feed and /api/war/feed (Task #680). Mirrors the pattern
  // already used for curated Top Stories (topStoriesInFlight): each of these
  // feeds runs several DB queries per compute, and on a cold cache the ~25s
  // auto-refresh plus concurrent viewers can stack multiple identical heavy
  // computes at once — the same self-DoS the curated read already guards
  // against. While one compute is in flight, concurrent cache-miss callers for
  // the same key await that SAME promise and serve the payload it caches
  // instead of each launching their own recompute. The in-flight entry is
  // ALWAYS cleared on both success and error. `x-mcop-no-cache` (isolation
  // harness) bypasses coalescing entirely so it always sees a fresh, uncoalesced
  // compute — exactly as it bypasses the cache read/write path.
  //
  // FAILURE ISOLATION (Task #687): a leader compute FAILURE must never be
  // served to the coalesced waiters. Waiters catch the shared rejection and
  // fall through to compute once themselves, so a transient DB/AI blip on the
  // leader does not cascade into a feed-wide 500. The in-flight key is cleared
  // on both paths so a failure can never wedge the key.
  //
  // The in-flight promise resolves with the CACHE ENTRY (not the raw payload)
  // so every waiter serves the same pre-serialized bytes the leader produced.
  const feedInFlight = new Map<string, Promise<FeedCacheEntry>>();
  const serveCoalescedFeed = async (
    req: any,
    res: Response,
    cacheKey: string,
    compute: () => Promise<any>,
    ttlMs: number = FEED_CACHE_TTL_MS,
  ): Promise<void> => {
    const bypass = shouldBypassFeedCache(req);
    if (!bypass) {
      lastReadAt.set(cacheKey, Date.now());
      const entry = readEntry(cacheKey);
      if (entry !== undefined) {
        const s = statFor(cacheKey);
        s.hit++;
        sendCachedEntry(req, res, entry, s);
        return;
      }
      const existing = feedInFlight.get(cacheKey);
      if (existing) {
        try {
          const sharedEntry = await existing;
          const s = statFor(cacheKey);
          s.coalesced++;
          sendCachedEntry(req, res, sharedEntry, s);
          return;
        } catch {
          // Leader compute failed — fall through and try once ourselves.
        }
      }
    }

    let resolveInFlight: ((v: FeedCacheEntry) => void) | undefined;
    let rejectInFlight: ((e: any) => void) | undefined;
    let inFlightKey: string | null = null;
    if (!bypass) {
      const p = new Promise<FeedCacheEntry>((resolve, reject) => {
        resolveInFlight = resolve;
        rejectInFlight = reject;
      });
      p.catch(() => {}); // coalesced waiters attach their own handlers
      feedInFlight.set(cacheKey, p);
      inFlightKey = cacheKey;
    }

    try {
      const s = statFor(cacheKey);
      if (bypass) s.bypass++; else s.miss++;
      const t0 = Date.now();
      const payload = await compute();
      recordCompute(s, Date.now() - t0);
      const entry = writeEntry(cacheKey, payload, ttlMs);
      if (inFlightKey) {
        // Leader path: serialize once and serve the same bytes the waiters and
        // later warm hits will reuse.
        resolveInFlight?.(entry);
        feedInFlight.delete(inFlightKey);
        inFlightKey = null;
        sendCachedEntry(req, res, entry, s);
      } else {
        // Bypass path (x-mcop-no-cache): unchanged — fresh compute served via
        // res.json. The compute still WRITES the cache (only its read is
        // bypassed), same as before.
        res.json(payload);
      }
    } catch (error) {
      if (inFlightKey) {
        rejectInFlight?.(error);
        feedInFlight.delete(inFlightKey);
        inFlightKey = null;
      }
      throw error;
    }
  };

  // Background keep-warm refresh (Task #1023). Registers as the in-flight
  // leader so any request landing mid-prewarm coalesces onto it instead of
  // recomputing.
  const prewarmFeed = async (
    key: string,
    compute: () => Promise<any>,
    opts?: { ttlMs?: number; minAgeMs?: number },
  ): Promise<void> => {
    const minAgeMs = opts?.minAgeMs ?? FEED_PREWARM_MIN_AGE_MS;
    if (feedInFlight.has(key)) return; // a leader is already computing this key
    const existing = readEntry(key);
    if (existing && Date.now() - existing.at < minAgeMs) return; // fresh enough
    let resolveInFlight!: (v: FeedCacheEntry) => void;
    let rejectInFlight!: (e: any) => void;
    const p = new Promise<FeedCacheEntry>((resolve, reject) => {
      resolveInFlight = resolve;
      rejectInFlight = reject;
    });
    p.catch(() => {});
    feedInFlight.set(key, p);
    try {
      const s = statFor(key);
      s.prewarm++;
      const t0 = Date.now();
      const payload = await compute();
      recordCompute(s, Date.now() - t0);
      const entry = writeEntry(key, payload, opts?.ttlMs ?? FEED_CACHE_TTL_MS);
      // Pre-serialize off the request path so no request ever pays the
      // stringify+etag for this fill.
      ensureSerialized(entry);
      resolveInFlight(entry);
    } catch (error) {
      rejectInFlight(error);
      console.error(`[FeedCache] prewarm failed for ${key}:`, error instanceof Error ? error.message : error);
    } finally {
      feedInFlight.delete(key);
    }
  };

  return {
    shouldBypassFeedCache,
    getFeedCache,
    setFeedCache,
    invalidateFeedCache,
    invalidateMainFeeds,
    serveCoalescedFeed,
    prewarmFeed,
    lastFeedReadAt: (key: string) => lastReadAt.get(key),
    onMainFeedsInvalidated: (fn: () => void) => { mainFeedsInvalidatedHook = fn; },
    _inFlightSize: () => feedInFlight.size,
    _stats: () => Object.fromEntries(stats),
  };
}
