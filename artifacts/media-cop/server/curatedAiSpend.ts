// =============================================================================
// Curated AI spend telemetry (Task #1100). LOG-ONLY, measurement-first.
//
// Before any Curated model downgrade (the cost-dial / tiered-synthesis work),
// the spend must be measurable: today the shared aiClient normalizes token
// usage onto every ChatCompletion response, but nothing aggregates it per call
// family — so "synthesis dominates Curated spend" is an inference, not a
// number. This module is a tiny in-process accumulator that attributes Curated
// AI usage to its call family and emits ONE compact summary log line per
// family at the end of each clustering pass.
//
// Families:
//   - 'clustering'  — every call through curatedCluster's chain helper
//                     (grouping, coherence guard, semantic adversary attach,
//                     process re-partition, anchor-split classifier).
//   - 'synthesis'   — every call through curatedSynthesis's chain helper
//                     (story synthesis incl. the contrast alignment %).
// The cheap per-article extraction/enrichment tier runs on its own crons, not
// inside the clustering pass, so it is intentionally NOT aggregated here — the
// per-pass summary would mis-attribute it.
//
// Synthesis additionally carries the quality guardrail counters needed to
// judge a later model change: junk/meta-filler detector hits, skipped-and-
// retried syntheses, and continuity churn (re-synths that changed an existing
// headline).
//
// HARD CONSTRAINTS (the whole point of this module):
//   - Measurement only: no model/routing/prompt/cache/output change anywhere.
//   - Never throws into a call path — recording is defensive and best-effort.
//   - Per-process accumulator, flushed (logged + reset) by the owning
//     clustering pass. Deploy is single-instance (Reserved VM), so one
//     accumulator per process is exact; calls that ever ran outside a pass
//     would simply attribute to the next pass's flush (acceptable drift for
//     log-only telemetry).
// =============================================================================

export type CuratedAiFamily = 'clustering' | 'synthesis';

// Minimal structural view of a ChatCompletion — tolerant of test stubs that
// return partial objects. `usage` is the aiClient-normalized token block (the
// Anthropic fallback path synthesizes the same shape); `model` is the model
// that ACTUALLY served (the Anthropic fallback stamps the real Claude model
// even when the requested chain entry was an OpenRouter id).
interface CompletionLike {
  model?: string | null;
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
  } | null;
}

interface FamilyAgg {
  calls: number; // logical chain-level calls attempted (ok + failed)
  ok: number; // returned a completion (any provider in the chain)
  failed: number; // threw out of the chain (all providers failed / abort / genuine error)
  promptTokens: number;
  completionTokens: number;
  usageMissing: number; // ok calls whose response carried no parsable usage block
  models: Map<string, number>; // served model -> count
}

function emptyAgg(): FamilyAgg {
  return {
    calls: 0,
    ok: 0,
    failed: 0,
    promptTokens: 0,
    completionTokens: 0,
    usageMissing: 0,
    models: new Map(),
  };
}

interface SynthQualityAgg {
  junkFillerLines: number; // meta-filler lines dropped from facts/attributedClaims
  skipRetry: number; // syntheses skipped this pass (malformed reply or API error) that retry next pass
  resynths: number; // syntheses that carried a prior headline (continuity anchor present)
  headlineChanged: number; // of those, how many persisted a DIFFERENT headline (continuity churn)
}

function emptyQuality(): SynthQualityAgg {
  return { junkFillerLines: 0, skipRetry: 0, resynths: 0, headlineChanged: 0 };
}

const agg: Record<CuratedAiFamily, FamilyAgg> = {
  clustering: emptyAgg(),
  synthesis: emptyAgg(),
};
let synthQuality: SynthQualityAgg = emptyQuality();

/**
 * Record a successful chain-level call. `requestedModel` is the chain entry the
 * helper asked for — used only as the served-model label when the response
 * carries no model string (e.g. a minimal test stub).
 */
export function recordCuratedAiCallOk(
  family: CuratedAiFamily,
  response: CompletionLike | null | undefined,
  requestedModel: string,
): void {
  try {
    const a = agg[family];
    a.calls++;
    a.ok++;
    const served =
      (typeof response?.model === 'string' && response.model.trim()) || requestedModel;
    a.models.set(served, (a.models.get(served) ?? 0) + 1);
    const p = response?.usage?.prompt_tokens;
    const c = response?.usage?.completion_tokens;
    if (typeof p === 'number' && Number.isFinite(p) && p >= 0) {
      a.promptTokens += p;
    } else {
      a.usageMissing++;
      return;
    }
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
      a.completionTokens += c;
    }
  } catch {
    // Telemetry must never disturb the call path.
  }
}

/** Record a chain-level call that ultimately threw (all providers / abort). */
export function recordCuratedAiCallFailure(family: CuratedAiFamily): void {
  try {
    const a = agg[family];
    a.calls++;
    a.failed++;
  } catch {
    /* never throw */
  }
}

/** Meta-filler/junk lines the synthesis parser dropped from facts + claims. */
export function recordCuratedSynthJunkLines(count: number): void {
  if (Number.isFinite(count) && count > 0) synthQuality.junkFillerLines += count;
}

/**
 * A synthesis that was SKIPPED this pass (malformed/empty/wrong-shape reply or
 * an API/network failure) and will retry next pass — the "story not
 * synthesized this pass (cluster preserved, retries next pass)" family.
 */
export function recordCuratedSynthSkipRetry(): void {
  synthQuality.skipRetry++;
}

/**
 * A re-synthesis of a story that already carried a cached headline (the
 * continuity anchor was passed). `changed` = the persisted headline differs
 * from the prior one — the continuity-churn signal.
 */
export function recordCuratedSynthResynth(changed: boolean): void {
  synthQuality.resynths++;
  if (changed) synthQuality.headlineChanged++;
}

function formatModels(models: Map<string, number>): string {
  if (models.size === 0) return '{}';
  const parts = Array.from(models.entries())
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([m, n]) => `${m}:${n}`);
  return `{${parts.join(',')}}`;
}

/**
 * Emit the per-family summary lines for the pass that just ended, then reset.
 * A 'full' pass always logs both families (zeros included — "everything
 * reused/cached" is itself signal); a cheap deterministic re-shape logs only
 * families that actually did something, so the frequent zero-AI re-shapes
 * don't spam the log.
 */
export function flushCuratedAiSpendTelemetry(passLabel: string): void {
  try {
    const always = passLabel === 'full';
    for (const family of ['clustering', 'synthesis'] as const) {
      const a = agg[family];
      const quality = family === 'synthesis' ? synthQuality : null;
      const anyQuality =
        !!quality &&
        (quality.junkFillerLines > 0 ||
          quality.skipRetry > 0 ||
          quality.resynths > 0 ||
          quality.headlineChanged > 0);
      if (!always && a.calls === 0 && !anyQuality) continue;
      const usageMissing = a.usageMissing > 0 ? ` usageMissing=${a.usageMissing}` : '';
      const qualityStr = quality
        ? ` junkFillerLines=${quality.junkFillerLines} skipRetry=${quality.skipRetry} resynths=${quality.resynths} headlineChanged=${quality.headlineChanged}`
        : '';
      console.log(
        `[CuratedAiSpend] pass=${passLabel} family=${family} calls=${a.calls} ok=${a.ok} fail=${a.failed}` +
          ` promptTokens=${a.promptTokens} completionTokens=${a.completionTokens}${usageMissing}` +
          ` models=${formatModels(a.models)}${qualityStr}`,
      );
    }
  } catch {
    /* log-only — never disturb the pass */
  } finally {
    agg.clustering = emptyAgg();
    agg.synthesis = emptyAgg();
    synthQuality = emptyQuality();
  }
}
