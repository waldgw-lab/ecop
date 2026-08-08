/**
 * Self-tuning pacer for the AI summary / relevance batch loops (news bots).
 *
 * Implements an AIMD strategy ("additive-increase / multiplicative-decrease") —
 * the same family TCP uses to find the fastest rate a link can carry without
 * dropping packets. Applied here to AI summary creation it gives exactly the
 * behaviour described by the user: start fast, and when the AI provider pushes
 * back (HTTP 429 rate-limit) widen the gap 1s -> 2s -> 4s and shrink the batch;
 * when calls succeed again, step the gap back down and grow the batch toward the
 * ceiling, so it converges on the largest/fastest summary rate that does NOT
 * cause failures.
 *
 * It sits ON TOP of, and is complementary to, the per-request spacing already in
 * `aiClient.ts`:
 *   - aiClient controls the micro-gap between *individual* AI requests.
 *   - this controls how many summaries a single cron fires per wave (batch size)
 *     and how long it pauses *between* waves (inter-batch delay), so colliding
 *     crons no longer dump a 30-item burst into the limiter all at once.
 *
 * Rate-limit pressure is detected WITHOUT changing every bot's error handling:
 * the bots' relevance helpers swallow provider errors internally and return [],
 * so instead we watch `aiClient`'s global `rateLimitsSeen` counter and treat any
 * increase across a batch as back-pressure. This means a batch counts as
 * "rate-limited" whenever a 429 was observed during it — even if a retry later
 * rescued the call — which is precisely the signal we want to back off on.
 *
 * State is process-global and shared across all summary channels. That is
 * correct because every channel hits the same OpenRouter/Anthropic quota and the
 * deployment is a single Reserved VM (one process), so a back-off learned by one
 * bot usefully carries into the next bot that runs.
 */
import { getAIClientMetrics } from './aiClient';

// Batch size: start at the historical 30 (so healthy operation is unchanged),
// halve on back-pressure, grow back additively on success.
const MAX_BATCH = 30;
const MIN_BATCH = 6;
const BATCH_GROW_STEP = 6; // additive increase per clean batch

// Inter-batch gap (ms): 0 when healthy (no slowdown), jumps to FIRST_BACKOFF on
// the first 429 then doubles up to MAX_DELAY; halves back down on success.
const FIRST_BACKOFF_MS = 1_000; // "try a 1s gap"
const MAX_DELAY_MS = 8_000; // ceiling so we never stall a whole cron
const DELAY_FLOOR_MS = 250; // below this we just drop back to 0

let currentBatchSize = MAX_BATCH;
let currentDelayMs = 0;

/** Current adaptive batch size (number of items per AI wave). */
export function nextBatchSize(): number {
  return currentBatchSize;
}

/** Current adaptive pause to apply between batches, in milliseconds. */
export function interBatchDelayMs(): number {
  return currentDelayMs;
}

/**
 * Feed back the outcome of the batch that just ran so the controller can tune.
 * `rateLimited` = a provider 429 was observed while that batch was in flight.
 */
export function recordBatchOutcome(rateLimited: boolean): void {
  if (rateLimited) {
    // Multiplicative decrease: back off hard (1s -> 2s -> 4s -> 8s) and shrink
    // the batch so the next wave puts far less pressure on the provider.
    currentDelayMs = Math.min(
      MAX_DELAY_MS,
      Math.max(currentDelayMs * 2, FIRST_BACKOFF_MS),
    );
    currentBatchSize = Math.max(MIN_BATCH, Math.floor(currentBatchSize / 2));
  } else {
    // Recovery: step the gap back down toward zero and grow the batch back
    // toward the ceiling, converging on the best sustainable rate.
    const relaxed = Math.floor(currentDelayMs * 0.5);
    currentDelayMs = relaxed < DELAY_FLOOR_MS ? 0 : relaxed;
    currentBatchSize = Math.min(MAX_BATCH, currentBatchSize + BATCH_GROW_STEP);
  }
}

/** Inspect the current controller state (for logging / diagnostics). */
export function getAdaptiveBatchState(): { batchSize: number; delayMs: number } {
  return { batchSize: currentBatchSize, delayMs: currentDelayMs };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Yield `items` in self-tuning batches. Drop-in replacement for a fixed
 * `for (const batch of batches)` loop:
 *
 *     for await (const batch of adaptiveBatches(newArticles)) {
 *       ...existing per-batch body (AI relevance + summary + post)...
 *     }
 *
 * Between batches it applies the adaptive delay; after each batch it measures
 * the provider rate-limit delta and tunes the size/gap for the next one. If the
 * consuming loop breaks or throws, the generator simply stops — no extra work.
 */
export async function* adaptiveBatches<T>(items: T[]): AsyncGenerator<T[]> {
  let idx = 0;
  let first = true;
  while (idx < items.length) {
    if (!first) {
      const d = interBatchDelayMs();
      if (d > 0) await sleep(d);
    }
    first = false;

    const size = nextBatchSize();
    const batch = items.slice(idx, idx + size);
    idx += batch.length;

    const before = getAIClientMetrics().rateLimitsSeen;
    yield batch; // consumer runs its AI relevance/summary work here
    const rateLimited = getAIClientMetrics().rateLimitsSeen > before;
    recordBatchOutcome(rateLimited);
  }
}
