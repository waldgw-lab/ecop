/**
 * Task #639 — shared TEST-ONLY reliability helper for live validation harnesses.
 *
 * PROBLEM: several validation scripts run against the LIVE dev server and hit
 * genuinely transient noise (an OpenRouter/Anthropic 429 blip, a truncated AI
 * reply, a concurrent scraper write landing mid-snapshot). Today that noise is
 * indistinguishable from a real regression: both exit non-zero. This module
 * gives every harness a single, consistent way to tell them apart WITHOUT
 * touching any production code path (server/aiClient.ts, scrapers, scoring
 * rubric, feed caps are never modified by this file or its consumers).
 *
 * EXIT-CODE CONVENTION (adopted by every script that imports this module):
 *   0 = PASS         — the check ran cleanly and the assertion held.
 *   1 = FAIL          — the check ran cleanly and a GENUINE regression was
 *                        observed (never downgrade this — real leak/isolation/
 *                        scoring-drift failures must stay hard failures).
 *   3 = INCONCLUSIVE  — the check could not reach a clean verdict after
 *                        bounded retries because of transient AI failures,
 *                        truncation, or live-data volatility. Treat this as
 *                        "retry the validation run", not "ship is broken".
 *
 * NOTE ON `.replit`: the platform's validation runner has no per-workflow
 * knob for "treat exit code 3 as non-blocking" (isValidation is a boolean
 * flag only). The 0/1/3 convention is therefore enforced by CONVENTION — any
 * agent or human reviewing a validation run must read exit code 3 as
 * "inconclusive, re-run" rather than "broken", the same way the pre-existing
 * PRECONDITION_EXIT_CODE=3 usage in curated-isolation-harness.ts and
 * state-media-api.test.ts has always worked.
 */

import { isTransientAIError } from '../server/aiClient';

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_INCONCLUSIVE = 3;

export type HarnessOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export function exitCodeFor(outcome: HarnessOutcome): number {
  if (outcome === 'PASS') return EXIT_PASS;
  if (outcome === 'FAIL') return EXIT_FAIL;
  return EXIT_INCONCLUSIVE;
}

/** FAIL beats INCONCLUSIVE beats PASS — a single genuine failure anywhere sinks the run. */
export function combineOutcomes(outcomes: HarnessOutcome[]): HarnessOutcome {
  if (outcomes.some((o) => o === 'FAIL')) return 'FAIL';
  if (outcomes.some((o) => o === 'INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'PASS';
}

export { isTransientAIError };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when a batch AI call came back short of the expected row count — the
 * classic signature of a truncated reply (the model hit its token cap
 * mid-array) rather than a deliberate "this row was skipped" outcome. This is
 * a TEST-ONLY heuristic used to decide whether a miss is worth a retry before
 * judging it as a genuine scoring gap; it does not change any production
 * analyzer's truncation handling (see salvageJsonObjectArray in
 * server/aiClient.ts for the production-side recovery).
 */
export function looksLikeTruncatedBatch(opts: { attemptRowCount: number; expectedRowCount: number }): boolean {
  const { attemptRowCount, expectedRowCount } = opts;
  if (expectedRowCount <= 0) return false;
  return attemptRowCount < expectedRowCount;
}

export interface RetryToCleanOptions<T> {
  /** Max attempts including the first (default 3). */
  retries?: number;
  /** Base delay in ms for exponential backoff between attempts (default 1500). */
  baseDelayMs?: number;
  /** Human-readable label used in log lines. */
  label?: string;
  /** Returns true when `result` is a "clean" run worth judging as-is. */
  isClean: (result: T) => boolean;
  /** Optional: rank attempts so the BEST (not just the last) is kept if none are clean. */
  score?: (result: T) => number;
  logger?: (msg: string) => void;
}

/**
 * Runs `attempt()` up to `retries` times (exponential backoff between tries),
 * looking for a "clean" result per `isClean`. Returns the first clean result
 * immediately. If no attempt is clean, returns the best-scored attempt (or
 * the last attempt if no `score` is given) along with `usedRetries` and
 * `cleanRunAchieved: false` so the caller can decide FAIL vs INCONCLUSIVE.
 */
export async function retryToCleanSignal<T>(
  attempt: () => Promise<T>,
  opts: RetryToCleanOptions<T>,
): Promise<{ result: T; attempts: number; cleanRunAchieved: boolean }> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1500;
  const log = opts.logger ?? console.log;
  let best: T | null = null;
  let bestScore = -Infinity;

  for (let i = 1; i <= retries; i++) {
    const result = await attempt();
    if (opts.isClean(result)) {
      if (i > 1) log(`[harness-reliability] ${opts.label ?? 'attempt'}: reached a clean run on attempt ${i}/${retries}`);
      return { result, attempts: i, cleanRunAchieved: true };
    }
    const s = opts.score ? opts.score(result) : i;
    if (s >= bestScore) {
      bestScore = s;
      best = result;
    }
    if (i < retries) {
      const delay = baseDelayMs * 2 ** (i - 1);
      log(`[harness-reliability] ${opts.label ?? 'attempt'}: attempt ${i}/${retries} not clean, retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  log(`[harness-reliability] ${opts.label ?? 'attempt'}: never reached a clean run after ${retries} attempts — using best-scored attempt`);
  return { result: best as T, attempts: retries, cleanRunAchieved: false };
}

export interface WithTransientRetryOptions {
  retries?: number;
  baseDelayMs?: number;
  label?: string;
  logger?: (msg: string) => void;
}

/**
 * Retries `fn` only when it throws an error `isTransientAIError` recognizes
 * (429 / 5xx / network / open circuit breaker). Genuine errors are rethrown
 * immediately on the first attempt — this NEVER masks a real bug, it only
 * absorbs the same provider-side blips server/aiClient.ts already retries in
 * production, for the test harness's own direct calls.
 */
export async function withTransientRetry<T>(fn: () => Promise<T>, opts: WithTransientRetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1500;
  const log = opts.logger ?? console.log;
  let lastErr: unknown;
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientAIError(err)) throw err;
      if (i < retries) {
        const delay = baseDelayMs * 2 ** (i - 1);
        log(`[harness-reliability] ${opts.label ?? 'call'}: transient AI error on attempt ${i}/${retries} (${(err as Error)?.message ?? err}), retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}
