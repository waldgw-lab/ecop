// Cooperative event-loop yielding for long synchronous in-memory passes.
//
// This app runs as a SINGLE Node process (see replit.md — one Reserved VM
// instance), so a long synchronous loop after a DB fetch blocks the event loop
// and stalls EVERY other in-flight request until it finishes. `await`ing a
// setImmediate hands control back to the poll phase, letting other requests run,
// then resumes. It changes ONLY scheduling: every value/order is computed from
// the same in-request snapshot, so the payload is byte-identical to a
// non-yielding run.
export const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

// Passive event-loop delay histogram (perf_hooks). Enabled at module load —
// the sampling overhead is negligible (20ms resolution timer). Consumers call
// sampleEventLoopDelay() to read the p95/max over the window since the last
// sample and reset the histogram. Used by the feed-cache 5-minute summary log
// so production shows whether the single process is stalling reads.
import { monitorEventLoopDelay } from "node:perf_hooks";
const loopDelayHistogram = monitorEventLoopDelay({ resolution: 20 });
loopDelayHistogram.enable();

export function sampleEventLoopDelay(): { p95Ms: number; maxMs: number } {
  const p95Ms = loopDelayHistogram.percentile(95) / 1e6;
  const maxMs = loopDelayHistogram.max / 1e6;
  loopDelayHistogram.reset();
  return {
    p95Ms: Math.round(p95Ms * 10) / 10,
    maxMs: Math.round(maxMs * 10) / 10,
  };
}

// Yield roughly every this-many iterations of an O(N) hot loop — small enough to
// keep tail latency for other requests low, large enough that the yield overhead
// stays negligible relative to the per-item work.
export const CURATED_YIELD_CHUNK = 64;
