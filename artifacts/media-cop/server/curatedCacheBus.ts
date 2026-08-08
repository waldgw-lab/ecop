// =============================================================================
// Curated read-cache invalidation bus (Task #336). The curated feed read cache
// is a closure inside routes.ts, but classification (re)writes happen in
// background jobs (curatedClassify cron, curatedIngest). This tiny module lets
// those jobs invalidate the curated read cache without importing routes.ts.
//
// routes.ts registers its invalidator at startup; jobs call
// invalidateCuratedReadCache() after any classification write so a reclassified
// label is reflected on the next read instead of waiting out the cache TTL.
// CURATED-LANE ONLY — this only ever touches the curated read cache.
// =============================================================================

// ---------------------------------------------------------------------------
// Revision counter — bumped on every curated feed-shaping write so clients can
// detect "something changed" without polling the heavy top-stories endpoint.
// Per-process only (single-VM Reserved deployment). CURATED-LANE ONLY.
// ---------------------------------------------------------------------------
let curatedRevision = 0;
let curatedRevisionAt = Date.now();

/** Increment the curated revision. Called by routes.ts on every cache invalidation. */
export function bumpCuratedRevision(): void {
  curatedRevision++;
  curatedRevisionAt = Date.now();
}

/** Read the current curated revision + timestamp. Zero-cost — no DB, no compute. */
export function getCuratedRevision(): { revision: number; updatedAt: number } {
  return { revision: curatedRevision, updatedAt: curatedRevisionAt };
}

// ---------------------------------------------------------------------------
// Invalidation bus (original Task #336 plumbing, extended to also bump revision)
// ---------------------------------------------------------------------------
type Invalidator = (prefix?: string) => void;

let registered: Invalidator | null = null;

/** routes.ts calls this once at startup to expose its curated cache invalidator. */
export function registerCuratedCacheInvalidator(fn: Invalidator): void {
  registered = fn;
}

/**
 * Invalidate the curated read cache (optionally a single prefix). No-op until
 * routes.ts has registered its invalidator, so it is safe to call from jobs that
 * may run before the HTTP layer is wired. Bumps the per-process revision counter
 * so viewers polling /api/curated/revision notice the change.
 *
 * The registered invalidator (routes.ts `invalidateCuratedCache`) bumps the
 * revision itself, so when it is wired we delegate the bump to it and do NOT
 * double-count. Only when no invalidator is registered yet (a job firing before
 * the HTTP layer is up — no clients are polling that early anyway) do we bump
 * directly so the change is still recorded.
 */
export function invalidateCuratedReadCache(prefix?: string): void {
  if (registered) {
    try {
      registered(prefix); // bumps the revision as part of its work
    } catch {
      // Invalidation is best-effort; a short TTL backstops any miss.
    }
    return;
  }
  bumpCuratedRevision();
}

// ---------------------------------------------------------------------------
// Top-Stories prewarmer bus — lets routes.ts register its prewarmTopStories
// closure so background-job invalidations (via invalidateCuratedReadCache) can
// trigger a warm rebuild without importing routes.ts. CURATED-LANE ONLY.
// ---------------------------------------------------------------------------
type Prewarmer = () => Promise<void>;
let registeredPrewarmer: Prewarmer | null = null;

/** routes.ts registers its prewarmTopStories closure here after it is defined. */
export function registerCuratedTopStoriesPrewarmer(fn: Prewarmer): void {
  registeredPrewarmer = fn;
}

/**
 * Fire the top-stories prewarmer in the background (non-blocking). No-op if
 * no prewarmer is registered yet. The prewarmer itself is cold-only guarded
 * (skips if still warm), so calling it speculatively is safe.
 */
export function triggerCuratedTopStoriesPrewarm(): void {
  registeredPrewarmer?.().catch(() => {});
}
