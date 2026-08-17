// Process-wide Playwright browser mutex.
//
// Every Playwright scraper in this app (xScraper, rapidResponseScraper,
// dowResponseScraper, sentDefenderScraper, osintScraper) cleans up orphaned
// Chromium with `pkill -9 -f "chromium.*--headless"`, which kills EVERY headless
// Chromium on the box — including a different scraper family's live browser.
// The per-family locks (X-scrape lock, OSINT scrape lock) only serialize within
// a family, so when an offset cron (InfluencerX at :15/:45, Journalist at
// :05/:35) overlaps the main */10 scrape chain mid-browser, the two destroy each
// other's sessions ("Force-killing browser instance" churn) and spike CPU,
// which in turn starves the event loop and slows every HTTP request + DB query.
//
// This single global lock guarantees only ONE browser-launching scrape runs at a
// time process-wide, so a family's pkill can never reach a sibling's browser.
// It is a simple promise-chain mutex (same proven pattern as the existing
// per-family locks) — it only queues, it never times out or force-releases, and
// the wrapped scrapers all self-bound with their own internal per-item timeouts,
// so the chain always drains.

let browserQueue: Promise<unknown> = Promise.resolve();

// Current holder telemetry (Task #34). Lets the scheduler's timeout path decide
// whether a forceKillAllBrowsers() would hit its OWN wedged chain (safe) or an
// innocent sibling family (OSINT/Journalist/Influencer) that happens to hold
// the lock right now — killing the latter's live browser mid-scrape caused
// empty results and retry churn during the Aug 17 2026 stall.
let currentHolder: { label: string; sinceMs: number } | null = null;

export function getBrowserLockHolder(): { label: string; heldForMs: number } | null {
  return currentHolder
    ? { label: currentHolder.label, heldForMs: Date.now() - currentHolder.sinceMs }
    : null;
}

export interface BrowserLockOptions {
  // Invoked at the moment the lock is acquired, BEFORE any browser work starts.
  // If it throws, the lock is immediately released and fn() never runs. This is
  // the cooperative-cancellation seam: a scrape run that was revoked while
  // QUEUED for this lock must not proceed to launch a browser once the queue
  // finally reaches it — checking only before enqueueing leaves a window where
  // a cancelled run still executes a full lane after a sibling releases.
  onAcquire?: () => void;
}

export function withBrowserLock<T>(label: string, fn: () => Promise<T>, opts?: BrowserLockOptions): Promise<T> {
  const next = browserQueue.then(async () => {
    if (opts?.onAcquire) {
      try {
        opts.onAcquire();
      } catch (e) {
        console.warn(`[Browser-Lock] ${label} abandoned at acquisition (cancelled while queued)`);
        throw e;
      }
    }
    console.log(`[Browser-Lock] Acquired by ${label}`);
    const startedAt = Date.now();
    currentHolder = { label, sinceMs: startedAt };
    try {
      return await fn();
    } finally {
      currentHolder = null;
      console.log(`[Browser-Lock] Released by ${label} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    }
  });
  // Don't propagate failures into the queue chain (a rejected run must not wedge
  // every subsequent scrape).
  browserQueue = next.catch(() => undefined);
  return next as Promise<T>;
}
