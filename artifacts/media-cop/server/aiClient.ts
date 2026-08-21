import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import pLimit from 'p-limit';

/**
 * Shared AI client for all former-OpenAI calls.
 *
 * Every call that used to hit OpenAI directly (`new OpenAI({ apiKey:
 * process.env.OPENAI_API_KEY })`) now routes through Replit's OpenRouter AI
 * Integration. The OpenAI account hit its quota cap (429 insufficient_quota),
 * so the whole app moves to OpenRouter while keeping behavior identical.
 *
 * Model tiers (cost-optimized after a head-to-head eval on this app's exact
 * conflict-news prompts — see .agents/memory/gpt5-safety-refusals.md):
 *   - gpt-4o-mini         -> google/gemini-2.5-flash-lite (high-volume light
 *                            tier: relevance / scoring / summaries / filtering;
 *                            ~33% cheaper than gpt-4o-mini and drop-in clean —
 *                            valid JSON at the app's tight max_tokens, no
 *                            safety refusals)
 *   - gpt-4o-mini-pinned  -> openai/gpt-4o-mini (QUALITY-SENSITIVE light-tier
 *                            paths kept on the proven model: main-feed +
 *                            team-submission CLUSTERING, which is provider-
 *                            sensitive grouping, and the curated controlled-
 *                            vocab CLASSIFIER, whose labels are generate-once
 *                            locked and costly to get wrong)
 *   - gpt-4o-vision       -> google/gemini-2.5-flash (vision OCR — image input
 *                            at ~8x lower cost than gpt-4o)
 *   - gpt-4o              -> openai/gpt-4o (heavy reasoning: curated clustering,
 *                            synthesis, briefing cards)
 * Every tier keeps a reliable cross-provider fallback via ANTHROPIC_MODEL_MAP
 * below (gemini-flash-lite -> claude-haiku, gemini-flash/gpt-4o -> claude-sonnet),
 * orchestrated transparently so a primary outage never disables a feature.
 *
 * NOTE: these were briefly mapped to the gpt-5 family, but gpt-5's stricter
 * safety layer intermittently REFUSED conflict-heavy news prompts (e.g. it
 * hard-blocked Team link submissions about strikes — review-link returned 422),
 * so the mapping was reverted to the proven-reliable gpt-4o family. The gpt-5
 * refusal-retry below is retained as a dormant safeguard: it is keyed on the
 * gpt-5 family, so it is inert on gpt-4o and re-activates automatically if the
 * map is ever pointed back at gpt-5.
 *
 * Call sites are left byte-identical (same prompts, temperature, response_format,
 * and the same `model: 'gpt-4o'` / `'gpt-4o-mini'` strings). The model string is
 * translated to its OpenRouter id inside the wrapper below, so no prompt or
 * parameter changes are needed at any call site.
 *
 * RATE-AWARENESS: ~50 call sites funnel through here, and on busy minutes
 * (curated classify + curated clustering + hourly news-bot bursts on the same
 * minute) the concurrent fan-out saturates OpenRouter into transient 429s. A
 * single 429 used to waste a whole pass (e.g. curated clustering returned
 * "Error identifying clusters"). To absorb those blips WITHOUT changing models,
 * prompts, cadence, or any caller logic, this client now adds three layers
 * around the provider call:
 *   1. a global concurrency limiter + adaptive minimum spacing between requests,
 *      so a burst is metered out instead of hitting the provider all at once;
 *   2. a bounded retry (exponential backoff + jitter, honoring Retry-After) for
 *      TRANSIENT provider failures (429 / 5xx / network) only; and
 *   3. the pre-existing circuit breaker, which still trips on sustained
 *      saturation (each exhausted retry counts as exactly one provider failure).
 * Genuine failures (bad input, malformed output, real bugs) are never retried
 * and surface immediately, so every caller's existing try/catch fallback fires
 * exactly as before on a final, unrecovered failure.
 *
 * A process-wide circuit breaker short-circuits calls after repeated provider
 * failures (429 / 5xx / network) so a quota cap or outage produces a short
 * cooldown instead of a retry-storm (the RSS bot, news bots, and cron scrapers
 * otherwise re-fire the same batch every cycle).
 *
 * PROVIDER FALLBACK: OpenRouter has its own credit pool that can run dry (HTTP
 * 402 "Insufficient credits"), which would otherwise kill EVERY AI feature at
 * once. To stay resilient, this client transparently falls back to Replit's
 * ANTHROPIC integration (a separate credit pool) whenever the OpenRouter call
 * fails for any reason OR the circuit breaker is open. The Anthropic path uses
 * the @anthropic-ai/sdk Messages API under the hood but is adapted to return
 * the exact same OpenAI ChatCompletion shape, so all ~50 call sites stay
 * byte-identical. gpt-4o -> claude-sonnet-4-5, gpt-4o-mini -> claude-haiku-4-5.
 * Anthropic failures never trip the OpenRouter circuit breaker.
 */

const OPENROUTER_BASE_URL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;
const OPENROUTER_API_KEY = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;

const ANTHROPIC_BASE_URL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
const ANTHROPIC_API_KEY = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;

/**
 * Authoritative operator kill switch. This is intentionally independent of
 * credentials and provider preference: stored settings and fallback routing can
 * never re-enable AI while the switch is active.
 */
export function isAIIntegrationsDisabled(): boolean {
  return process.env.AI_INTEGRATIONS_DISABLED === 'true';
}

export class AIIntegrationsDisabledError extends Error {
  readonly code = 'AI_INTEGRATIONS_DISABLED';
  readonly status = 503;

  constructor() {
    super('AI integrations are disabled by operator configuration.');
    this.name = 'AIIntegrationsDisabledError';
  }
}

export function assertAIIntegrationsEnabled(): void {
  if (isAIIntegrationsDisabled()) throw new AIIntegrationsDisabledError();
}

/** True when the primary OpenRouter AI Integration is configured. */
export function isOpenRouterConfigured(): boolean {
  return !isAIIntegrationsDisabled() && !!(OPENROUTER_BASE_URL && OPENROUTER_API_KEY);
}

/** True when the Anthropic AI Integration (fallback provider) is configured. */
export function isAnthropicConfigured(): boolean {
  return !isAIIntegrationsDisabled() && !!(ANTHROPIC_BASE_URL && ANTHROPIC_API_KEY);
}

/**
 * True when AT LEAST ONE provider is configured. Callers use this to gate AI
 * features on/off; with the Anthropic fallback in place, AI is available as
 * long as either provider is reachable.
 */
export function isAIConfigured(): boolean {
  return isOpenRouterConfigured() || isAnthropicConfigured();
}

// --- Provider mode (Team-page toggle) --------------------------------------
// Global, process-wide selection of which AI brain the app uses, cached in
// memory and backed by the ai_settings DB row (loaded once at boot, updated by
// the Team-page toggle endpoint).
//   'auto'       -> pick the primary provider AUTOMATICALLY from live provider
//                   health (default): prefer OpenRouter, but route to Anthropic
//                   while OpenRouter is rate-limited/cooling down, and switch
//                   back once it recovers — no human toggle required.
//   'openrouter' -> force OpenRouter primary with automatic Anthropic fallback
//   'internal'   -> force the Anthropic integration primary with automatic
//                   OpenRouter fallback
// Regardless of mode, a provider whose circuit breaker is open (rate-limited)
// is skipped automatically in favor of the other, so AI never depends on
// someone manually flipping a switch.
type ProviderMode = 'openrouter' | 'internal' | 'auto';
let providerMode: ProviderMode = 'auto';

/** Current global AI provider mode. */
export function getProviderMode(): ProviderMode {
  return providerMode;
}

/** Update the global AI provider mode (called at boot and by the toggle). */
export function setProviderMode(mode: ProviderMode): void {
  if (mode !== 'openrouter' && mode !== 'internal' && mode !== 'auto') return;
  if (providerMode !== mode) {
    console.log(`[AIClient] provider mode set to '${mode}'`);
  }
  providerMode = mode;
}

// Resolve the active mode to a concrete PRIMARY provider. Manual modes map
// straight through; 'auto' chooses from live circuit-breaker health — prefer
// OpenRouter (broader rate budget + better curated grouping) unless it is
// cooling down while Anthropic is healthy. The downstream orchestrator still
// falls back to the other provider on any failure, so this only decides which
// provider is TRIED FIRST.
function resolveEffectiveMode(): 'openrouter' | 'internal' {
  if (providerMode === 'openrouter' || providerMode === 'internal') return providerMode;
  const orConfigured = isOpenRouterConfigured();
  const anthropicConfigured = isAnthropicConfigured();
  if (!orConfigured) return 'internal';
  if (!anthropicConfigured) return 'openrouter';
  if (isBreakerOpen('openrouter') && !isBreakerOpen('anthropic')) return 'internal';
  return 'openrouter';
}

// Lazily constructed. We deliberately do NOT build the client at module load:
// `new OpenAI({ apiKey: undefined })` silently falls back to the OPENAI_API_KEY
// env var and hits api.openai.com directly — the exact quota-capped account we
// are migrating away from. Building it only once OpenRouter is confirmed
// configured guarantees a call can never silently route back to OpenAI.
let rawClient: OpenAI | null = null;

function getClient(): OpenAI {
  assertAIIntegrationsEnabled();
  if (!rawClient) {
    rawClient = new OpenAI({
      baseURL: OPENROUTER_BASE_URL,
      apiKey: OPENROUTER_API_KEY,
    });
  }
  return rawClient;
}

// Translate the legacy OpenAI model strings used across the codebase to their
// OpenRouter ids. Anything not in this map passes through unchanged.
const MODEL_MAP: Record<string, string> = {
  'gpt-4o-mini': 'google/gemini-2.5-flash-lite',
  'gpt-4o-mini-pinned': 'openai/gpt-4o-mini',
  'gpt-4o-vision': 'google/gemini-2.5-flash',
  'gpt-4o': 'openai/gpt-4o',
};

function mapModel(model: string): string {
  return MODEL_MAP[model] ?? model;
}

// --- Anthropic fallback client --------------------------------------------
// Lazily constructed, same rationale as the OpenRouter client above (never
// build at module load). The Anthropic integration is a SEPARATE Replit AI
// integration with its own credit pool, so it can serve traffic when
// OpenRouter is empty.
let rawAnthropic: Anthropic | null = null;

function getAnthropic(): Anthropic {
  assertAIIntegrationsEnabled();
  if (!rawAnthropic) {
    rawAnthropic = new Anthropic({
      apiKey: ANTHROPIC_API_KEY,
      baseURL: ANTHROPIC_BASE_URL,
    });
  }
  return rawAnthropic;
}

// Map the legacy OpenAI model tiers (and their OpenRouter ids) to the closest
// Claude model available via the Anthropic integration.
const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  'gpt-4o': 'claude-sonnet-4-5',
  'openai/gpt-4o': 'claude-sonnet-4-5',
  'gpt-4o-mini': 'claude-haiku-4-5',
  'openai/gpt-4o-mini': 'claude-haiku-4-5',
  // Cost-optimized tiers keep an explicit, reliable Claude fallback so a primary
  // (gemini / gpt-4o) outage transparently routes to Anthropic, never disabling
  // the feature. Keyed on BOTH the logical call-site string and the mapped
  // primary id (the orchestrator passes the logical string; the id keys are
  // belt-and-suspenders in case a mapped id is ever passed through).
  'gpt-4o-mini-pinned': 'claude-haiku-4-5',
  'gpt-4o-vision': 'claude-sonnet-4-5',
  'google/gemini-2.5-flash-lite': 'claude-haiku-4-5',
  'google/gemini-2.5-flash': 'claude-sonnet-4-5',
};
const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

function mapAnthropicModel(model: string): string {
  return ANTHROPIC_MODEL_MAP[model] ?? ANTHROPIC_DEFAULT_MODEL;
}

// --- Circuit breaker -------------------------------------------------------
// After FAILURE_THRESHOLD consecutive provider-side failures, open the breaker
// for COOLDOWN_MS. While open, calls reject immediately (callers already have
// try/catch fallbacks) instead of hammering a saturated provider.
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

type Provider = 'openrouter' | 'anthropic';
interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
}
// Per-provider circuit breakers. OpenRouter and Anthropic each get their own
// failure counter + cooldown, so a rate-limit storm on ONE provider trips only
// that provider's breaker — letting the orchestrator route around it to the
// healthy provider instead of stalling all AI.
const breakers: Record<Provider, BreakerState> = {
  openrouter: { consecutiveFailures: 0, openUntil: 0 },
  anthropic: { consecutiveFailures: 0, openUntil: 0 },
};

/** True while the given provider's breaker is open (cooling down). */
function isBreakerOpen(provider: Provider): boolean {
  return Date.now() < breakers[provider].openUntil;
}

export class AICircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AICircuitOpenError';
  }
}

// Build the breaker-open error with the current remaining cooldown. Centralized
// so every open-breaker check (entry + per-attempt + pre-call) reads the live
// remaining time consistently.
function circuitOpenError(provider: Provider): AICircuitOpenError {
  return new AICircuitOpenError(
    `${provider} AI provider circuit open; cooling down for ${Math.ceil((breakers[provider].openUntil - Date.now()) / 1000)}s`,
  );
}

function isProviderFailure(err: any): boolean {
  // The operator shutdown is an intentional, terminal state — never retry it,
  // count it against a provider circuit, or present it as a provider outage.
  if (err instanceof AIIntegrationsDisabledError) return false;
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  const code = err?.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') {
    return true;
  }
  // OpenAI SDK wraps connection problems as APIConnectionError.
  if (err?.name === 'APIConnectionError' || err?.name === 'APIConnectionTimeoutError') return true;
  return false;
}

/**
 * True when an error from an AI call is TRANSIENT (provider rate-limit, 5xx,
 * network blip, or an open circuit breaker) and therefore worth a bounded
 * retry — as opposed to a genuine, non-retryable failure (bad input, malformed
 * output, etc.). Callers use this to surface a "try again in a moment" signal
 * instead of a hard error. Reuses the same classification the circuit breaker
 * uses, so there is a single source of truth for "provider-side failure".
 */
export function isTransientAIError(err: any): boolean {
  if (err instanceof AICircuitOpenError) return true;
  return isProviderFailure(err);
}

// --- Observability counters ------------------------------------------------
// Lightweight running totals so the effect of the rate-awareness is verifiable
// from the deployment logs (and assertable in tests) without changing any
// call-site behavior. These are best-effort metrics, not exact accounting.
const metrics = {
  retryAttempts: 0, // total times a transient failure was retried
  rateLimitsSeen: 0, // total 429 responses observed
  circuitOpens: 0, // total times the breaker tripped open
  fallbacksAttempted: 0, // total times the Anthropic fallback was attempted
  fallbacksSucceeded: 0, // total times the Anthropic fallback returned a result
  anthropicFailures: 0, // total times the Anthropic fallback itself failed
};

/** Snapshot of the rate-awareness counters (observability / tests). */
export function getAIClientMetrics(): Readonly<typeof metrics> {
  return { ...metrics };
}

function recordSuccess(provider: Provider): void {
  breakers[provider].consecutiveFailures = 0;
}

function recordFailure(provider: Provider): void {
  const b = breakers[provider];
  b.consecutiveFailures += 1;
  if (b.consecutiveFailures >= FAILURE_THRESHOLD) {
    b.openUntil = Date.now() + COOLDOWN_MS;
    b.consecutiveFailures = 0;
    metrics.circuitOpens += 1;
    console.error(
      `[AIClient] ${provider} circuit breaker OPEN for ${COOLDOWN_MS / 1000}s after ${FAILURE_THRESHOLD} consecutive provider failures ` +
        `(opens=${metrics.circuitOpens}, 429s=${metrics.rateLimitsSeen}, retries=${metrics.retryAttempts})`,
    );
  }
}

// --- Concurrency limiter + adaptive spacing --------------------------------
// A process-wide concurrency limiter caps how many requests are in flight to
// the provider at once, and an adaptive minimum spacing meters out the *start*
// of each request so a same-minute burst (classify + clustering + news bots)
// is fanned out over time instead of arriving simultaneously. The spacing
// widens when a 429 is seen and relaxes back toward baseline as calls succeed.
const CONCURRENCY = 3;
const BASE_SPACING_MS = 250; // minimum gap between request starts when healthy
const MAX_SPACING_MS = 4_000; // ceiling so spacing never stalls a pass outright
const SPACING_BUMP_MS = 600; // floor the gap jumps to on the first 429

const limit = pLimit(CONCURRENCY);

let currentSpacingMs = BASE_SPACING_MS;
// Monotonic reservation clock: each request reserves the next slot
// `currentSpacingMs` after the previous reservation, so concurrent callers are
// spaced out evenly rather than thundering in together.
let nextAllowedAt = 0;

function widenSpacing(): void {
  currentSpacingMs = Math.min(MAX_SPACING_MS, Math.max(currentSpacingMs * 2, SPACING_BUMP_MS));
}

function relaxSpacing(): void {
  if (currentSpacingMs > BASE_SPACING_MS) {
    currentSpacingMs = Math.max(BASE_SPACING_MS, Math.floor(currentSpacingMs * 0.85));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reserve this request's spacing slot and wait until it is due. Done OUTSIDE
// the concurrency limiter so waiting for spacing never holds a concurrency slot.
async function waitForSpacing(): Promise<void> {
  const now = Date.now();
  const scheduled = Math.max(now, nextAllowedAt);
  nextAllowedAt = scheduled + currentSpacingMs;
  const wait = scheduled - now;
  if (wait > 0) await sleep(wait);
}

// --- Bounded transient retry ----------------------------------------------
// On a TRANSIENT provider failure (429 / 5xx / network) retry the identical
// request a bounded number of times with exponential backoff + jitter,
// honoring a Retry-After header when present. Genuine (non-transient) errors
// are re-thrown immediately and never masked.
const MAX_ATTEMPTS = 3; // total attempts (=> up to 2 retries)
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.max(when - Date.now(), 0);
  return null;
}

// Pull a Retry-After header off an OpenAI SDK / fetch error, tolerating both a
// Headers-like object (`.get`) and a plain object map.
function retryAfterFromError(err: any): number | null {
  const headers = err?.headers ?? err?.response?.headers;
  if (!headers) return null;
  let raw: string | null | undefined = null;
  if (typeof headers.get === 'function') {
    raw = headers.get('retry-after');
  } else {
    raw = headers['retry-after'] ?? headers['Retry-After'];
  }
  return parseRetryAfterMs(raw);
}

function computeBackoffMs(attempt: number, err: any): number {
  const retryAfter = retryAfterFromError(err);
  if (retryAfter != null) return Math.min(retryAfter, MAX_BACKOFF_MS);
  const base = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = Math.random() * base * 0.5; // up to +50% jitter
  return Math.min(Math.floor(base + jitter), MAX_BACKOFF_MS);
}

/**
 * Run a single provider call through the concurrency limiter + adaptive
 * spacing, with a bounded retry on transient failures. The concurrency slot is
 * held ONLY for the duration of the actual provider call — spacing waits and
 * backoff sleeps happen outside the slot so they never deadlock or needlessly
 * starve other callers. Records circuit-breaker success/failure: a recovered
 * call records success; an exhausted retry records exactly one failure (so the
 * breaker still trips on sustained saturation) and re-throws.
 */
async function spacedLimitedCall(
  fn: () => Promise<OpenAI.Chat.Completions.ChatCompletion>,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  assertAIIntegrationsEnabled();
  let lastErr: any;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    assertAIIntegrationsEnabled();
    // Do not retry into an open breaker (it may have tripped during a backoff
    // from other concurrent calls). Stop and let the caller's fallback run.
    if (isBreakerOpen('openrouter')) throw circuitOpenError('openrouter');

    await waitForSpacing();

    try {
      // Re-check inside the concurrency slot, immediately before the provider
      // call: the breaker can trip during the spacing wait or while queued in
      // the limiter (from other concurrent calls), and we must not fire a
      // request into an open breaker. AICircuitOpenError is not a provider
      // failure, so the catch below re-throws it immediately (no retry).
      const result = await limit(() => {
        assertAIIntegrationsEnabled();
        if (isBreakerOpen('openrouter')) throw circuitOpenError('openrouter');
        return fn();
      });
      recordSuccess('openrouter');
      relaxSpacing();
      return result;
    } catch (err) {
      // Genuine failures are surfaced immediately and never masked by a retry.
      if (!isProviderFailure(err)) throw err;

      lastErr = err;
      const status = (err as any)?.status ?? (err as any)?.response?.status;
      if (status === 429) {
        metrics.rateLimitsSeen += 1;
        widenSpacing();
      }

      const isLast = attempt === MAX_ATTEMPTS - 1;
      if (isLast) {
        // Exhausted: count as exactly one provider failure so the breaker still
        // trips on sustained saturation, then re-throw for the caller fallback.
        recordFailure('openrouter');
        throw err;
      }

      metrics.retryAttempts += 1;
      const backoff = computeBackoffMs(attempt, err);
      console.warn(
        `[AIClient] transient provider failure (status=${status ?? (err as any)?.code ?? (err as any)?.name}); ` +
          `retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS - 1}, ` +
          `429s=${metrics.rateLimitsSeen}, retries=${metrics.retryAttempts}, spacing=${currentSpacingMs}ms)`,
      );
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// --- gpt-5 safety-refusal recovery ----------------------------------------
// gpt-5 is a reasoning model with a stricter safety layer than gpt-4o: on a
// minority of conflict-heavy news prompts (strikes, casualties, etc.) it
// returns a plain-text refusal ("I'm sorry, but I cannot assist with that
// request.") instead of the requested JSON. Callers then log it as MALFORMED
// LLM OUTPUT and waste the whole pass (e.g. a curated clustering cycle produces
// zero stories). The refusal is OFTEN non-deterministic at the low temperatures
// used here, so a bounded retry of the identical request sometimes recovers —
// but NOT reliably: in prod, gpt-5-mini refused certain conflict stories across
// both retries and hard-blocked Team link submissions, which is what forced the
// MODEL_MAP revert to gpt-4o above. This retry is therefore now DORMANT (scoped
// to the gpt-5 family AND json-mode requests only); it adds a trivial branch on
// gpt-4o and re-activates if the map is ever pointed back at gpt-5.
const MAX_REFUSAL_RETRIES = 2;

function isSafetyRefusal(result: OpenAI.Chat.Completions.ChatCompletion): boolean {
  const msg = result.choices?.[0]?.message as
    | (OpenAI.Chat.Completions.ChatCompletionMessage & { refusal?: string | null })
    | undefined;
  if (!msg) return false;
  if (msg.refusal) return true;
  const content = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (!content) return false;
  // A genuine json-mode success is parseable JSON; only treat NON-JSON apology
  // text as a refusal so a valid JSON payload that merely contains "sorry"
  // (e.g. extracted post text) never trips a needless retry.
  try {
    JSON.parse(content);
    return false;
  } catch {
    /* not JSON — fall through to phrase check */
  }
  return /^(i['’]m sorry|i am sorry|sorry,|i cannot|i can['’]t|i (?:'m|am) unable|i will not|i won['’]t)\b/i.test(
    content,
  );
}

// OpenRouter's primary path can hand back JSON wrapped in a ```json code fence
// (some routed providers — notably Claude — do this even in json_object mode),
// which makes the many callers that JSON.parse(message.content) directly throw
// "Unexpected token '`'" and silently drop the whole batch. The Anthropic
// fallback already normalizes this (see `wantsJson` below); mirror it here so
// BOTH provider paths return bare, parseable JSON for json-mode calls.
function sanitizeResultJson(result: OpenAI.Chat.Completions.ChatCompletion): void {
  const msg = result?.choices?.[0]?.message;
  if (msg && typeof msg.content === 'string') {
    msg.content = sanitizeJsonText(msg.content);
  }
}

// --- Provider: OpenRouter (primary) ---------------------------------------
async function createViaOpenRouter(
  body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  options?: OpenAI.RequestOptions,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const mappedModel = mapModel(body.model);
  const mappedBody = { ...body, model: mappedModel };

  // Only the gpt-5 family + json-mode calls are eligible for refusal recovery.
  const wantsJson =
    (mappedBody.response_format as { type?: string } | undefined)?.type === 'json_object';
  const maxRetries = wantsJson && mappedModel.startsWith('openai/gpt-5') ? MAX_REFUSAL_RETRIES : 0;

  let lastResult: OpenAI.Chat.Completions.ChatCompletion | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // The provider call (with concurrency, spacing, transient retry, and
    // circuit-breaker accounting) lives in spacedLimitedCall; it throws on a
    // final unrecovered provider failure so the orchestrator can fall back.
    const result = await spacedLimitedCall(() => getClient().chat.completions.create(mappedBody, options));
    // Normalize a possible ```json fence BEFORE the refusal check and return, so
    // every json-mode caller (and isSafetyRefusal) sees bare, parseable JSON.
    if (wantsJson) sanitizeResultJson(result);
    lastResult = result;
    if (attempt < maxRetries && isSafetyRefusal(result)) {
      console.warn(
        `[AIClient] gpt-5 returned a safety refusal on a JSON request; retrying (${attempt + 1}/${maxRetries})`,
      );
      continue;
    }
    return result;
  }
  // Exhausted retries while still refusing: hand back the last (refusal) result
  // so the caller's existing malformed-output fail-safe takes over.
  return lastResult as OpenAI.Chat.Completions.ChatCompletion;
}

// --- Provider: Anthropic (fallback) ---------------------------------------
// Adapts an OpenAI ChatCompletion request to the Anthropic Messages API and
// converts the response back to the OpenAI ChatCompletion shape so callers are
// unchanged.

// Compact, secret-safe error descriptor for fallback logs (status/name + a
// short message slice — never the full prompt, image, or any credential).
function describeErr(err: any): string {
  const status = err?.status ?? err?.response?.status;
  const name = err?.name;
  const msg = typeof err?.message === 'string' ? err.message.slice(0, 140) : '';
  return [status != null ? `status=${status}` : null, name ? `name=${name}` : null, msg ? `msg=${msg}` : null]
    .filter(Boolean)
    .join(' ');
}

function anthropicTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('\n');
  }
  return '';
}

function toAnthropicImageBlock(url: string): any {
  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;,]+);base64,([\s\S]*)$/);
    if (!m) throw new Error('[AIClient] Anthropic fallback: unsupported inline image data URL.');
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  }
  // Remote http(s) image: Anthropic supports a URL image source.
  return { type: 'image', source: { type: 'url', url } };
}

function toAnthropicContent(content: unknown): string | any[] {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const blocks: any[] = [];
    for (const part of content as any[]) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        blocks.push({ type: 'text', text: part.text });
      } else if (part?.type === 'image_url' && part.image_url?.url) {
        blocks.push(toAnthropicImageBlock(part.image_url.url));
      }
    }
    return blocks;
  }
  return '';
}

function mergeAnthropicContent(a: string | any[], b: string | any[]): string | any[] {
  if (typeof a === 'string' && typeof b === 'string') return `${a}\n${b}`;
  const asBlocks = (x: string | any[]): any[] =>
    typeof x === 'string' ? [{ type: 'text', text: x }] : x;
  return [...asBlocks(a), ...asBlocks(b)];
}

function isEmptyContent(content: string | any[]): boolean {
  if (typeof content === 'string') return content.trim() === '';
  return content.length === 0;
}

// Split an OpenAI message list into Anthropic's top-level `system` + a
// user/assistant message list. Merges consecutive same-role messages, drops
// empty ones, and guarantees the first message is a user turn (Anthropic
// rejects lists that do not start with a user message).
function convertMessages(
  messages: any[],
  wantsJson: boolean,
): { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string | any[] }> } {
  const systemParts: string[] = [];
  const out: Array<{ role: 'user' | 'assistant'; content: string | any[] }> = [];

  for (const m of messages ?? []) {
    if (m?.role === 'system') {
      const t = anthropicTextFromContent(m.content);
      if (t.trim()) systemParts.push(t);
      continue;
    }
    if (m?.role !== 'user' && m?.role !== 'assistant') continue; // tool/function unused here
    const role: 'user' | 'assistant' = m.role;
    const content = toAnthropicContent(m.content);
    if (isEmptyContent(content)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      prev.content = mergeAnthropicContent(prev.content, content);
    } else {
      out.push({ role, content });
    }
  }

  if (out.length === 0 || out[0].role !== 'user') {
    out.unshift({ role: 'user', content: 'Please respond to the instructions above.' });
  }

  let system = systemParts.join('\n\n');
  if (wantsJson) {
    system =
      (system ? `${system}\n\n` : '') +
      'IMPORTANT: Respond with ONLY a single valid JSON value. Do not wrap it in markdown code fences, and do not include any text before or after the JSON.';
  }
  return { system: system || undefined, messages: out };
}

// Find the first balanced {...} or [...] JSON value in a string (tolerating
// quoted strings/escapes), used to recover JSON that Claude wrapped in
// prose/fences despite being asked for raw JSON.
function extractFirstJson(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// Claude (even when asked) can wrap JSON in ```json fences or surround it with
// prose. Normalize to a bare, parseable JSON string for the many callers that
// JSON.parse() the content. Falls back to the raw text if nothing parses, so
// the caller's own malformed-output handling still fires.
function sanitizeJsonText(text: string): string {
  let t = text.trim();
  // Case 1: a COMPLETE ```json ... ``` fence (closing fence present).
  const fence = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fence) {
    t = fence[1].trim();
  } else {
    // Case 2: the reply was TRUNCATED at the token cap, so it opens with a
    // ```json fence but never emits the closing ``` (and the JSON itself is cut
    // off). The anchored regex above can't match, so strip the dangling opener
    // (and a trailing fence if one happens to be present) on their own. This
    // guarantees the returned text never begins with a stray backtick — callers
    // that JSON.parse() directly then fail with a normal "end of JSON" error
    // (caught by their own fallback) instead of "Unexpected token '`'".
    t = t
      .replace(/^```(?:json)?[ \t]*\r?\n?/i, '')
      .replace(/\r?\n?```$/i, '')
      .trim();
  }
  try {
    JSON.parse(t);
    return t;
  } catch {
    /* fall through to extraction */
  }
  const candidate = extractFirstJson(t);
  if (candidate) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* give back the fence-stripped text below */
    }
  }
  // Return the fence-stripped text (NOT the raw original) so a truncated fenced
  // reply never reaches a caller with a leading backtick.
  return t;
}

/**
 * Tolerant parse for an AI reply that is supposed to be JSON. Strips any
 * ```json fence (including an UNTERMINATED one left by a truncated reply) and
 * parses. Returns null instead of throwing, so callers fall back gracefully on
 * malformed/cut-off output rather than crashing on a stray backtick.
 */
export function parseAiJson<T = any>(content: string | null | undefined): T | null {
  if (!content) return null;
  try {
    return JSON.parse(sanitizeJsonText(content)) as T;
  } catch {
    return null;
  }
}

/**
 * Recover the COMPLETE objects from a JSON array reply that may have been cut
 * off mid-array at the token cap. Used by batch analyzers so a truncated batch
 * still yields the items that fully came back (the rest are simply retried on
 * the next pass) instead of dropping the whole batch. Reads the FIRST array in
 * the (fence-stripped) text and returns every balanced {...} element it can
 * parse, stopping at the first incomplete element.
 */
export function salvageJsonObjectArray(content: string | null | undefined): any[] {
  if (!content) return [];
  const t = sanitizeJsonText(content);
  // Prefer the array under a known result key so stray brackets in any leading
  // prose can't misdirect the scan; fall back to the first array otherwise.
  const keyed = t.match(/"(?:results|headlines|analyses|articles|items|data)"\s*:\s*\[/i);
  const arrStart = keyed ? t.indexOf('[', keyed.index!) : t.indexOf('[');
  if (arrStart < 0) return [];
  const objs: any[] = [];
  let i = arrStart + 1;
  const n = t.length;
  while (i < n) {
    while (i < n && (t[i] === ',' || t[i] === '\n' || t[i] === '\r' || t[i] === '\t' || t[i] === ' ')) i++;
    if (i >= n || t[i] === ']') break;
    if (t[i] !== '{') break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    const start = i;
    let end = -1;
    for (; i < n; i++) {
      const ch = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          i++;
          break;
        }
      }
    }
    if (end < 0) break; // truncated object — stop here
    try {
      objs.push(JSON.parse(t.slice(start, end + 1)));
    } catch {
      break;
    }
  }
  return objs;
}

/**
 * Tolerant extraction of the result-object array from a batch-analyzer reply
 * shaped like `{ "results": [ {...}, {...} ] }`. Production model output on the
 * gpt-4o-mini batch paths intermittently comes back with an unterminated string
 * or a trailing-comma/truncation at the token cap, so a bare `JSON.parse` throws
 * and the WHOLE batch is dropped (`[FUNNEL:AI] BATCH FAILED`).
 *
 * Instead we:
 *   1. Try a full tolerant parse (`parseAiJson`, which fence-strips first) and
 *      return the keyed array if it's well-formed.
 *   2. Otherwise salvage every COMPLETE `{...}` element from the (fence-stripped)
 *      array, so a reply cut off mid-array still yields the items that fully came
 *      back — the missing tail is simply picked up on the next pass.
 *
 * Returns `[]` only when nothing parseable is present (a genuinely malformed or
 * non-array reply), preserving each caller's existing fail-closed/open branch.
 * The `salvaged` flag lets callers log when recovery kicked in.
 */
export function parseBatchResultArray(
  content: string | null | undefined,
): { results: any[]; salvaged: boolean } {
  const parsed = parseAiJson<any>(content);
  if (parsed) {
    if (Array.isArray(parsed)) return { results: parsed, salvaged: false };
    if (typeof parsed === 'object') {
      const arr =
        parsed.results ?? parsed.headlines ?? parsed.analyses ?? parsed.items ?? parsed.data;
      if (Array.isArray(arr)) return { results: arr, salvaged: false };
    }
  }
  // Full parse failed (truncation / unterminated string) or produced no usable
  // array — recover the complete objects that DID come back.
  const salvaged = salvageJsonObjectArray(content);
  return { results: salvaged, salvaged: salvaged.length > 0 };
}

/**
 * Build a short, single-line snippet of a raw AI reply for diagnostic logging.
 * Collapses whitespace and truncates so a "Malformed AI response" log line stays
 * readable and bounded even when the model returned a large truncated blob. Used
 * by the batch/scoring parse sites to attach the offending payload to a distinct
 * malformed-response marker so operators can tell a bad AI payload apart from an
 * API/network failure in the logs.
 */
export function aiResponseSnippet(content: string | null | undefined, max = 300): string {
  if (!content) return '<empty>';
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}… [${oneLine.length} chars]` : oneLine;
}

function mapStopReason(
  reason: string | null | undefined,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

// Run an Anthropic call through the SAME concurrency limiter + spacing as the
// OpenRouter path (so a fallback storm can't overrun the provider), with a
// bounded transient retry. Crucially, Anthropic failures are NOT recorded
// against the OpenRouter circuit breaker.
async function anthropicCall<T>(fn: () => Promise<T>): Promise<T> {
  assertAIIntegrationsEnabled();
  let lastErr: any;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    assertAIIntegrationsEnabled();
    // Do not retry into an open Anthropic breaker (it may have tripped during a
    // backoff from other concurrent calls). Stop and let the orchestrator route
    // to OpenRouter instead of hammering a provider we know is rate-limited.
    if (isBreakerOpen('anthropic')) throw circuitOpenError('anthropic');
    await waitForSpacing();
    try {
      const result = await limit(() => {
        assertAIIntegrationsEnabled();
        if (isBreakerOpen('anthropic')) throw circuitOpenError('anthropic');
        return fn();
      });
      recordSuccess('anthropic');
      relaxSpacing();
      return result;
    } catch (err) {
      // Genuine failures (and the breaker-open signal) surface immediately.
      if (!isProviderFailure(err)) throw err;
      lastErr = err;
      const status = (err as any)?.status ?? (err as any)?.response?.status;
      if (status === 429) {
        metrics.rateLimitsSeen += 1;
        widenSpacing();
      }
      if (attempt === MAX_ATTEMPTS - 1) {
        // Exhausted: count exactly one Anthropic failure so its breaker trips on
        // sustained saturation, then re-throw for the orchestrator's fallback.
        recordFailure('anthropic');
        throw err;
      }
      metrics.retryAttempts += 1;
      const backoff = computeBackoffMs(attempt, err);
      console.warn(
        `[AIClient] transient Anthropic failure (${describeErr(err)}); retrying in ${backoff}ms ` +
          `(attempt ${attempt + 1}/${MAX_ATTEMPTS - 1})`,
      );
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function createViaAnthropic(
  body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const b = body as any;
  // The adapter cannot faithfully translate these, and silently dropping them
  // would corrupt output — fail loudly instead. (No aiClient caller uses them.)
  if (b.stream) throw new Error('[AIClient] Anthropic fallback does not support streaming.');
  if (b.tools || b.tool_choice || b.functions || b.function_call) {
    throw new Error('[AIClient] Anthropic fallback does not support tool/function calling.');
  }
  if (typeof b.n === 'number' && b.n > 1) {
    throw new Error('[AIClient] Anthropic fallback does not support n > 1.');
  }

  const wantsJson =
    (body.response_format as { type?: string } | undefined)?.type === 'json_object';
  const model = mapAnthropicModel(body.model);
  const { system, messages } = convertMessages(body.messages as any[], wantsJson);

  const maxTokens =
    typeof body.max_tokens === 'number' && body.max_tokens > 0
      ? body.max_tokens
      : typeof b.max_completion_tokens === 'number' && b.max_completion_tokens > 0
        ? b.max_completion_tokens
        : ANTHROPIC_DEFAULT_MAX_TOKENS;

  let temperature: number | undefined =
    typeof body.temperature === 'number' ? body.temperature : undefined;
  if (temperature !== undefined) temperature = Math.max(0, Math.min(1, temperature));

  const params: any = {
    model,
    max_tokens: maxTokens,
    messages,
    ...(system ? { system } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };

  const msg: any = await anthropicCall(() => getAnthropic().messages.create(params));

  let text = anthropicTextFromContent(msg?.content);
  if (wantsJson) text = sanitizeJsonText(text);

  const completion = {
    id: msg?.id ?? `anthropic-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: msg?.model ?? model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text, refusal: null },
        finish_reason: mapStopReason(msg?.stop_reason),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: msg?.usage?.input_tokens ?? 0,
      completion_tokens: msg?.usage?.output_tokens ?? 0,
      total_tokens: (msg?.usage?.input_tokens ?? 0) + (msg?.usage?.output_tokens ?? 0),
    },
  } as unknown as OpenAI.Chat.Completions.ChatCompletion;
  return completion;
}

// --- Orchestrator: OpenRouter primary, Anthropic fallback ------------------
async function create(
  body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  options?: OpenAI.RequestOptions,
  routing?: { preferOpenRouter?: boolean },
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  assertAIIntegrationsEnabled();
  const orConfigured = isOpenRouterConfigured();
  const anthropicConfigured = isAnthropicConfigured();

  // Fail safe (never back to OpenAI) when NO provider is configured. Every call
  // site already wraps this in try/catch, so a missing provider gracefully
  // disables AI features instead of routing to a dead account.
  if (!orConfigured && !anthropicConfigured) {
    throw new Error(
      'AI provider not configured: neither the OpenRouter nor the Anthropic Replit integration env vars are set.',
    );
  }

  // Resolve the active mode to a concrete primary. A curated-clustering caller
  // may PIN OpenRouter (routing.preferOpenRouter) regardless of the toggle;
  // otherwise 'auto' is resolved from live provider health, and the manual
  // modes map straight through. This is what makes provider switching automatic
  // and not dependent on a human flipping the Team-page toggle.
  const mode = routing?.preferOpenRouter ? 'openrouter' : resolveEffectiveMode();

  // Anthropic-primary path: route to the Anthropic integration first (Internal
  // AI mode, or 'auto' selected Anthropic because OpenRouter is cooling down).
  // If Anthropic is not configured, fall through to the OpenRouter path so the
  // mode can never fully disable AI.
  if (mode === 'internal' && anthropicConfigured) {
    // EFFICIENCY: when Anthropic is itself cooling down (rate-limited) and a
    // healthy OpenRouter is available, skip Anthropic entirely and serve from
    // OpenRouter for the cooldown instead of paying retry/backoff on a provider
    // we already know is throttled. Anthropic is probed again automatically as
    // soon as its breaker closes.
    if (!(isBreakerOpen('anthropic') && orConfigured && !isBreakerOpen('openrouter'))) {
      try {
        return await createViaAnthropic(body);
      } catch (err) {
        metrics.anthropicFailures += 1;
        // Two-way failover: the Anthropic-primary selection must never be a
        // one-way dead end. If Anthropic fails and OpenRouter is configured,
        // fall back to it so a provider hiccup can't silently stop AI.
        if (!orConfigured) throw err;
        metrics.fallbacksAttempted += 1;
        console.warn(
          `[AIClient] Internal AI (Anthropic) call failed (${describeErr(err)}); falling back to OpenRouter`,
        );
        try {
          const result = await createViaOpenRouter(body, options);
          metrics.fallbacksSucceeded += 1;
          return result;
        } catch (fallbackErr) {
          console.error(
            `[AIClient] OpenRouter fallback also failed (${describeErr(fallbackErr)})`,
          );
          throw err; // surface the ORIGINAL Internal AI error to the caller
        }
      }
    }
    // Anthropic cooling down + OpenRouter healthy -> fall through to OpenRouter.
    console.warn('[AIClient] Anthropic cooling down; routing to OpenRouter for the cooldown');
  }

  const breakerOpen = orConfigured && isBreakerOpen('openrouter');

  // Primary path: OpenRouter, unless it is unconfigured or cooling down.
  if (orConfigured && !breakerOpen) {
    try {
      return await createViaOpenRouter(body, options);
    } catch (err) {
      if (!anthropicConfigured) throw err;
      metrics.fallbacksAttempted += 1;
      console.warn(
        `[AIClient] OpenRouter call failed (${describeErr(err)}); falling back to Anthropic integration`,
      );
      try {
        const result = await createViaAnthropic(body);
        metrics.fallbacksSucceeded += 1;
        return result;
      } catch (fallbackErr) {
        metrics.anthropicFailures += 1;
        console.error(`[AIClient] Anthropic fallback also failed (${describeErr(fallbackErr)})`);
        throw err; // surface the ORIGINAL OpenRouter error to the caller
      }
    }
  }

  // OpenRouter unavailable (unconfigured) or breaker open -> go to Anthropic.
  if (anthropicConfigured) {
    if (breakerOpen) {
      metrics.fallbacksAttempted += 1;
      console.warn('[AIClient] OpenRouter circuit open; routing directly to Anthropic integration');
    }
    try {
      const result = await createViaAnthropic(body);
      if (breakerOpen) metrics.fallbacksSucceeded += 1;
      return result;
    } catch (fallbackErr) {
      metrics.anthropicFailures += 1;
      throw fallbackErr;
    }
  }

  // Only OpenRouter is configured but its breaker is open: preserve original
  // fail-fast behavior so callers' try/catch fallbacks run during cooldown.
  throw circuitOpenError('openrouter');
}

/**
 * Drop-in replacement for an OpenAI client. Exposes the only surface the app
 * uses (`chat.completions.create`) so existing call sites work unchanged.
 */
export const openai = {
  chat: {
    completions: {
      create,
    },
  },
};

/**
 * Curated clustering quality is provider-sensitive: gpt-4o groups multi-document
 * news markedly better than Claude, which over-fragments a single developing
 * event into several near-duplicate clusters. This variant runs the SAME
 * orchestrator (concurrency, spacing, retry, breaker, Anthropic fallback) but
 * PINS the primary to OpenRouter regardless of the global "Internal AI" toggle,
 * so the toggle can route every OTHER feature to Claude without degrading
 * curated grouping. Still falls back to Anthropic on a transient OpenRouter
 * failure, so it never disables AI.
 */
export async function createPreferOpenRouter(
  body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  options?: OpenAI.RequestOptions,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  return create(body, options, { preferOpenRouter: true });
}

// Test-only handle to the pure adapter helpers. Not used by any app call site;
// exported so the fallback's request/response transforms can be unit-tested
// without making network calls.
export const __aiClientInternals = {
  convertMessages,
  toAnthropicContent,
  toAnthropicImageBlock,
  sanitizeJsonText,
  extractFirstJson,
  mapAnthropicModel,
  mapStopReason,
};
