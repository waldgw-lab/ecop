// =============================================================================
// Resilient HTTP fetch for curated ingest scraping (Task #383).
//
// Curated intake leans on plain `fetch()` against third-party RSS feeds and news
// section pages. Two weaknesses hurt throughput under load:
//   1. A SINGLE hardcoded browser User-Agent. When an outlet's CDN starts
//      403-blocking that exact UA, the source silently drops out of curated with
//      no recovery until someone notices.
//   2. NO retry. An intermittent network blip / timeout / transient 5xx / 429 on
//      a feed fetch is logged and skipped for the whole pass, so a momentary
//      hiccup costs a full cycle of fresh stories from that source.
//
// This helper adds both, in ONE place shared by the RSS curated ingest and the
// curated-only website scrapers:
//   - Rotates through a small pool of real browser User-Agents, advancing the UA
//     on every retry so a UA-specific block is escaped on a later attempt.
//   - Bounded retry (exponential backoff + jitter, honoring Retry-After) on
//     TRANSIENT failures only: thrown network/timeout/abort errors and retriable
//     HTTP statuses (403 / 408 / 425 / 429 / 5xx). A non-retriable response
//     (e.g. 404) is returned immediately so the caller decides — genuine
//     failures are never masked or retried forever.
//
// It returns the final Response (even when !ok) so each caller keeps its own
// existing success/failure handling; it only throws when every attempt threw.
// Curated ingest scraping only — does not touch any shared feed or AI path.
// =============================================================================

// Real, current browser User-Agents across engines so a UA-specific block on one
// rarely blocks all. Order is deliberate (Chrome first — most widely accepted).
const BROWSER_USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

// Statuses worth a retry with a different UA / after a short wait. 403 is
// included on purpose: a CDN UA-block typically surfaces as 403 to one UA and
// 200 to another, which is exactly what UA rotation recovers.
const RETRIABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2; // total attempts = retries + 1
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 6_000;

// Per-URL circuit breaker (T004: fail-fast on dead sources). The RSS feed bot
// already has one; the curated fetch path did not, so a dead feed URL (DNS
// failure / connection refused / persistent timeout) burned the full
// retries × timeout (~45s) EVERY pass and helped push scrape cycles toward the
// 15-min watchdog. After FETCH_FAILURE_THRESHOLD passes in which EVERY attempt
// threw (no Response at all — i.e. the URL is unreachable, not merely erroring),
// the URL is skipped immediately for FETCH_COOLDOWN_MS, then retried once to
// self-heal. A URL that returns ANY Response (even a non-ok status like 404) is
// reachable, so its counter resets — genuine HTTP errors stay with the caller
// and are never masked, retried forever, or circuit-broken.
const FETCH_FAILURE_THRESHOLD = 3;
const FETCH_COOLDOWN_MS = 30 * 60 * 1000; // 30 min
const urlFailureState = new Map<string, { failures: number; skipUntil: number }>();

export interface ResilientFetchOptions {
  /** Accept header for this request (RSS vs HTML). */
  accept?: string;
  /** Per-attempt timeout in ms. */
  timeoutMs?: number;
  /** Number of RETRIES after the first attempt (total attempts = retries + 1). */
  retries?: number;
  /** Log tag for diagnostics. */
  label?: string;
  /** Any additional request headers. */
  extraHeaders?: Record<string, string>;
}

// Deterministic FNV-1a hash so each URL starts on a STABLE but spread UA index
// (different feeds don't all hammer the same UA first), and retries advance from
// there. Not security-sensitive.
function hashIndex(s: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % mod;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.max(when - Date.now(), 0);
  return null;
}

function backoffMs(attempt: number, retryAfter: number | null): number {
  if (retryAfter != null) return Math.min(retryAfter, MAX_BACKOFF_MS);
  const base = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = Math.random() * base * 0.5; // up to +50%
  return Math.min(Math.floor(base + jitter), MAX_BACKOFF_MS);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fetch a URL with User-Agent rotation and bounded transient retry. Returns the
 * final Response (even when !response.ok) so the caller keeps its own handling;
 * throws only when EVERY attempt threw (network/timeout). Curated scraping only.
 */
export async function fetchWithResilience(
  url: string,
  opts: ResilientFetchOptions = {},
): Promise<Response> {
  const {
    accept = 'application/rss+xml, application/xml, text/xml, */*',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    label = 'ResilientFetch',
    extraHeaders,
  } = opts;

  const totalAttempts = Math.max(1, retries + 1);
  const uaStart = hashIndex(url, BROWSER_USER_AGENTS.length);
  let lastErr: unknown;

  // Circuit breaker: skip a URL that has been unreachable on the last several
  // passes until its cooldown elapses, so a dead source costs ~0ms instead of
  // the full retries × timeout every pass.
  const breaker = urlFailureState.get(url);
  if (breaker && breaker.skipUntil > Date.now()) {
    throw new Error(
      `[${label}] skipping ${url}: circuit open after ${breaker.failures} unreachable passes ` +
        `(retry in ${Math.ceil((breaker.skipUntil - Date.now()) / 1000)}s)`,
    );
  }

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const ua = BROWSER_USER_AGENTS[(uaStart + attempt) % BROWSER_USER_AGENTS.length];
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': ua, Accept: accept, ...(extraHeaders ?? {}) },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });

      // Retriable status → wait + rotate UA, unless this was the last attempt
      // (then hand the response back so the caller logs/skips as it does today).
      if (RETRIABLE_STATUSES.has(resp.status) && attempt < totalAttempts - 1) {
        const wait = backoffMs(attempt, parseRetryAfterMs(resp.headers.get('retry-after')));
        console.warn(
          `[${label}] HTTP ${resp.status} from ${url}; retrying with rotated UA in ${wait}ms ` +
            `(attempt ${attempt + 1}/${totalAttempts})`,
        );
        await sleep(wait);
        continue;
      }
      // Got a Response (even a non-ok status) → the URL is reachable; clear any
      // breaker state so a recovered source resumes immediately.
      if (urlFailureState.has(url)) urlFailureState.delete(url);
      return resp;
    } catch (err) {
      lastErr = err;
      if (attempt < totalAttempts - 1) {
        const wait = backoffMs(attempt, null);
        console.warn(
          `[${label}] fetch error for ${url} (${(err as Error).message}); retrying with rotated UA in ${wait}ms ` +
            `(attempt ${attempt + 1}/${totalAttempts})`,
        );
        await sleep(wait);
        continue;
      }
    }
  }
  // Every attempt threw (no Response to hand back) → the URL is unreachable this
  // pass. Record it; trip the breaker once it has failed THRESHOLD passes in a
  // row so the next pass fails fast instead of burning the full timeout budget.
  const prev = urlFailureState.get(url) ?? { failures: 0, skipUntil: 0 };
  const failures = prev.failures + 1;
  urlFailureState.set(url, {
    failures,
    skipUntil: failures >= FETCH_FAILURE_THRESHOLD ? Date.now() + FETCH_COOLDOWN_MS : 0,
  });
  throw lastErr ?? new Error(`[${label}] fetch failed for ${url}`);
}
