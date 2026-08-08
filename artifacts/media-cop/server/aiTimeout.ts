// Shared per-call AI hang-protection.
//
// A provider can accept a request and then stall indefinitely. An unbounded
// `await` on such a call can wedge the whole scrape pass (this happened in
// production: a sustained AI rate-limit storm froze the main scrape for ~16h).
// To prevent that, every main-feed AI call uses TWO bounds — the identical,
// already-proven pattern the curated lane relies on:
//
//   1. A per-request SDK timeout + `maxRetries: 0` passed as the call's options
//      argument. On the primary (OpenRouter) provider path this aborts the HTTP
//      request at the source. `maxRetries: 0` is safe because the shared AI
//      client (server/aiClient.ts) already owns transient retry, request
//      spacing, provider fallback, and the circuit breaker — we must NOT
//      duplicate retry logic at the call site.
//   2. This `withAiTimeout` race-based backstop, which releases the `await` even
//      on the Anthropic fallback path (the fallback ignores per-request options
//      and cannot be cancelled at the call site). The backstop is slightly
//      longer than the SDK timeout so the source-level cancel wins when it can.
//
// On a stall the wrapped promise rejects, which flows into each call site's
// existing catch path (skip this batch/item, retry next cycle) — it must never
// crash the scrape or surface a hard error to users.
//
// --- Storm fast-skip (mild back-off) ---------------------------------------
// The per-call bounds above stop any single AI call from hanging, but during a
// SUSTAINED rate-limit storm the scrape still does dozens of AI calls in a row,
// each failing slowly — their cumulative time can blow past the scrape
// watchdog so the pass never finishes cleanly. To bound that cumulative cost,
// once several main-feed AI calls fail inside a short window we treat the
// provider as "storming" and FAST-SKIP subsequent calls for a brief cooldown:
// the call returns immediately (its existing catch degrades it just like a
// timeout) so the scrape finishes its pass and retries on the next cycle. This
// is intentionally conservative — it only trips on a genuine cluster of
// failures and self-clears as soon as the cooldown lapses. It is process-wide
// across the main feed only; the curated lane uses its own timeout helper and
// is unaffected.

const FAILURE_WINDOW_MS = 90_000; // look-back window for counting failures
const FAILURE_THRESHOLD = 4; // failures within the window that signal a storm
const COOLDOWN_MS = 90_000; // how long to fast-skip once a storm is detected

let recentFailures: number[] = [];
let cooldownUntil = 0;

function recordAiFailure(): void {
  const now = Date.now();
  recentFailures.push(now);
  recentFailures = recentFailures.filter((t) => t > now - FAILURE_WINDOW_MS);
  if (recentFailures.length >= FAILURE_THRESHOLD && now >= cooldownUntil) {
    cooldownUntil = now + COOLDOWN_MS;
    recentFailures = [];
    console.warn(
      `[aiTimeout] AI storm detected (${FAILURE_THRESHOLD}+ failures in ${FAILURE_WINDOW_MS / 1000}s) — ` +
        `fast-skipping main-feed AI calls for ${COOLDOWN_MS / 1000}s so the scrape can finish and retry next cycle.`,
    );
  }
}

/** True while a recent burst of AI failures has us in the fast-skip cooldown. */
export function isAiInCooldown(): boolean {
  return Date.now() < cooldownUntil;
}

export function withAiTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  // The storm fast-skip cooldown is MAIN-FEED ONLY. It defaults on so the many
  // main-feed call sites participate without per-site changes. The curated lane
  // (e.g. analyzeCuratedChunk) MUST pass { trackStorm: false } so a main-feed AI
  // storm can neither fast-skip curated calls nor be tripped by curated failures
  // — curated isolation is non-negotiable.
  opts?: { trackStorm?: boolean },
): Promise<T> {
  const trackStorm = opts?.trackStorm !== false;
  // During a storm cooldown, don't block the scrape behind another doomed call.
  // The underlying request was already issued; let it settle (and drain through
  // the shared client's spacing) in the background while we degrade right away.
  if (trackStorm && isAiInCooldown()) {
    promise.catch(() => {});
    return Promise.reject(new Error(`AI cooldown active — skipping ${label}`));
  }
  return new Promise<T>((resolve, reject) => {
    // Record at most one failure per wrapped call: a timeout followed by a
    // late underlying rejection is still a single failed call.
    let failed = false;
    const markFailure = () => {
      if (failed) return;
      failed = true;
      if (trackStorm) recordAiFailure();
    };
    const timer = setTimeout(() => {
      markFailure();
      reject(new Error(`Timeout (${ms}ms) for ${label}`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); markFailure(); reject(e); },
    );
  });
}

// Per-request SDK timeout (source-level cancellation on the primary path) and a
// slightly longer race backstop (covers the fallback path). Generous on purpose
// so they only trip on a genuine hang, never a slow-but-progressing reply —
// these match the values the curated lane already runs with in production.
export const AI_CALL_TIMEOUT_MS = 60_000;
export const AI_CALL_BACKSTOP_MS = 75_000;
