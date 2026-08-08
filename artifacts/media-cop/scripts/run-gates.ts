/**
 * scripts/run-gates.ts — the single consolidated CI gate runner.
 *
 * WHY THIS EXISTS
 * ---------------
 * Each safety check used to be registered as its OWN `.replit` workflow
 * (test-title-cleaner, test-curated-soft-cap, ...). The workflow-management
 * tool caps creation at 10 workflows, and the gate list had already grown well
 * past that — so new `scripts/*.test.ts` gates could no longer be added as
 * their own workflow. This runner collapses every gate into ONE validation
 * command ("gates") so the per-workflow cap is no longer a blocker.
 *
 * HOW TO ADD A NEW GATE  (repeatable, documented step)
 * ----------------------------------------------------
 *   1. Write the check at `scripts/<your-check>.test.ts` (or `.ts`/`.mjs`).
 *      Exit 0 = PASS, exit 1 = FAIL. If the check talks to the LIVE dev server
 *      or AI and can be transiently INCONCLUSIVE, follow the convention in
 *      `scripts/harness-reliability.ts` and exit 3 for "inconclusive, re-run",
 *      then set `inconclusive3: true` on its manifest entry below.
 *   2. Add ONE entry to the GATES array below.
 *      - New gates default to the FAST tier (slow?: false/omitted).
 *      - Mark a gate `slow: true` ONLY when it is structurally long-running
 *        (e.g. a full tsc pass, a minutes-long live harness). The two current
 *        slow gates are `server-refs` (~43s tsc) and `curated-isolation` (~40s).
 *   3. That's it — no new workflow is created. The "gates" validation command
 *      (npx tsx scripts/run-gates.ts) picks it up automatically.
 *
 * USAGE
 *   npx tsx scripts/run-gates.ts            # run every gate (full CI mode)
 *   npx tsx scripts/run-gates.ts --fast     # run only fast-tier gates
 *   npx tsx scripts/run-gates.ts --full     # explicit alias for full mode
 *   npx tsx scripts/run-gates.ts --serial   # disable safe offline concurrency
 *   npx tsx scripts/run-gates.ts --jobs=2   # cap offline workers (default 4)
 *   npx tsx scripts/run-gates.ts --list     # print the gate manifest and exit
 *   npx tsx scripts/run-gates.ts <name>...  # run only the named gate(s)
 *   npx tsx scripts/run-gates.ts --fresh    # ignore the resume checkpoint (below)
 *
 * RESUME CHECKPOINT (restart-churn protection)
 *   The `gates` workflow is restarted from scratch by the platform on every
 *   file edit, throwing away all progress mid-suite — historically the #1
 *   reason a "10 minute" suite took an hour of wall clock. To make restarts
 *   cheap, the runner persists each gate's PASS to `.local/gates-state.json`
 *   keyed by an exact workspace-state hash (git HEAD + full tracked diff +
 *   porcelain status + content hash of every untracked non-ignored file).
 *   On start, gates that already PASSED for the *identical* workspace state
 *   within the last 90 minutes are skipped (logged loudly as "resumed").
 *   ANY file change — tracked or untracked — invalidates the whole checkpoint,
 *   so a resumed PASS is exactly as trustworthy as the original run. Saves
 *   MERGE with the on-disk state (a named single-gate run must not stomp the
 *   workflow's accumulated checkpoint); FAIL/INCONCLUSIVE tombstone their
 *   entry so a failure is never resurrected from disk. Safety rules:
 *     - only PASS is ever reused; FAIL/INCONCLUSIVE always re-run.
 *     - a gate named explicitly on the CLI always runs (never resumed).
 *     - `--fresh` (or GATES_NO_RESUME=1) forces a full re-run.
 *     - test mode (GATES_MANIFEST_JSON) never reads or writes the checkpoint.
 *
 * SCHEDULING SAFETY
 *   Gates are ISOLATED by default. Only names in PARALLEL_SAFE_GATE_NAMES have
 *   been reviewed as deterministic, offline, and free of shared-resource use.
 *   Consecutive approved gates share a bounded pool; every isolated gate is a
 *   barrier that drains the pool and then runs alone. DB-writing, dev-server,
 *   browser, live-feed, live-AI, and structurally slow checks therefore never
 *   overlap another gate. New gates fail closed to isolated until reviewed.
 *
 * FAST vs FULL TIERS
 *   --fast  skips gates marked `slow: true` (currently: server-refs, curated-isolation).
 *           It still covers the large fast manifest, so targeted gate names are
 *           preferable for tight edit loops.
 *   --full  (or no flag) runs ALL gates including the two heavy ones. Use before
 *           publishing or when the TypeScript surface / isolation guarantees need
 *           re-verification. Registered as the "gates" validation command.
 *   Both tiers share identical exit-code and keep-going semantics.
 *
 * EXIT CODES (this runner)
 *   0 = every gate PASSED (INCONCLUSIVE gates are logged loudly but do NOT
 *       block, exactly as the old per-workflow `exit 3 -> exit 0` wrappers did).
 *   1 = at least one gate FAILED — a genuine regression. Fails loudly.
 *
 * KEEP-GOING GUARANTEE (Task #774)
 *   A single gate FAILing (or crashing, or timing out) must NEVER prevent the
 *   remaining gates from executing. Every gate always runs; all failures are
 *   reported together in the final summary and the runner exits 1 only after
 *   the full pass. To make that hold in practice:
 *     - each gate run is wrapped in its own try/catch so an unexpected
 *       exception records a FAIL for that gate and the loop continues, and
 *     - gates are spawned in their own process group and the timeout kills the
 *       WHOLE group (kill -pid), so a timed-out gate can't leave an orphaned
 *       grandchild (bash -c's tsx child) running underneath later gates.
 *
 * NOTE: this file only ORCHESTRATES existing checks. It never imports or
 * modifies any production code path.
 */

import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

interface Gate {
  /** Stable identifier, used for --list and single-gate selection. */
  name: string;
  /** Shell command to run the check. */
  cmd: string;
  /**
   * When true, an exit code of 3 is treated as INCONCLUSIVE (non-blocking,
   * "re-run") per the harness-reliability convention rather than a failure.
   */
  inconclusive3?: boolean;
  /** Per-gate hard timeout (ms) safety net. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * When true, this gate is structurally long-running (e.g. a full tsc pass
   * or a minutes-long live harness). The `--fast` tier skips slow gates so
   * everyday iteration completes in seconds. Default: false (fast tier).
   * New gates should omit this field — defaulting to fast keeps new gates
   * automatically included in the everyday check without extra annotation.
   */
  slow?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 min safety net for healthy runs
const DEFAULT_PARALLEL_JOBS = 4;
const MAX_PARALLEL_JOBS = 8;

type SchedulingClass = 'parallel-offline' | 'isolated';

/**
 * The gate manifest. This is the single source of truth for which checks run
 * in CI — it intentionally mirrors the checks that were previously individual
 * `.replit` workflows. Keep it explicit: only entries listed here are wired as
 * blocking gates, and gate-manifest-coverage prevents orphaned test files.
 */
const GATES: Gate[] = [
  {
    // Was the `curated-isolation` workflow: a blocking self-heal precheck,
    // then the big isolation harness (exit 3 = inconclusive/non-blocking).
    name: 'curated-isolation',
    // The harness prints "[iso] all isolation guarantees hold" ONLY when main()
    // ran to completion. If a future entry-guard/runner change ever let the
    // module load without running main() (see the invokedDirectly guard in
    // curated-isolation-harness.ts), the process could exit 0 WITHOUT running any
    // check — a silent vacuous pass of this fail-closed gate. So on exit 0 we
    // require that completion line; its absence fails the gate loudly (exit 1).
    cmd:
      'npx tsx scripts/test-sigkill-self-heal.ts && ' +
      '(out=$(npx tsx scripts/curated-isolation-harness.ts 2>&1); code=$?; echo "$out"; ' +
      "if [ \"$code\" -eq 3 ]; then echo '[gate] curated-isolation INCONCLUSIVE (exit 3) treated as non-blocking'; exit 0; " +
      'elif [ "$code" -eq 0 ] && ! echo "$out" | grep -q "all isolation guarantees hold"; then ' +
      "echo '[gate] curated-isolation VACUOUS-PASS GUARD: harness exited 0 without its completion line (main() did not run) — failing'; exit 1; " +
      'else exit "$code"; fi)',
    timeoutMs: 25 * 60 * 1000,
    slow: true,
  },
  { name: 'title-cleaner', cmd: 'npx tsx scripts/title-cleaner.test.ts' },
  // Task #1038 — canonical social-account catalog contract + projection drift.
  // Locks shared/socialAccountCatalog.ts as the single source of truth for the
  // approved roster: every scraper/relay/curated/UI list is derived from it.
  { name: 'social-account-catalog-drift', cmd: 'npx tsx scripts/social-account-catalog-drift.test.ts' },
  { name: 'curated-social-attachment-matrix', cmd: 'npx tsx scripts/curated-social-attachment-matrix.test.ts' },
  { name: 'curated-social-card-attach', cmd: 'npx tsx scripts/curated-social-card-attach.test.ts' },
  { name: 'admin-flag-persistence', cmd: 'npx tsx scripts/admin-flag-persistence.test.ts', inconclusive3: true },
  // Task: confirm topic matching & cluster dedup survive the {"clusters":[...]}
  // json_object format change (headlineCluster + teamSubmissionCluster). AI is
  // stubbed at the mutable openai.chat.completions.create seam; uses the dev DB.
  { name: 'cluster-json-format', cmd: 'npx tsx scripts/cluster-json-format.test.ts' },
  { name: 'watch-topic-priority', cmd: 'npx tsx scripts/watch-topic-priority.test.ts' },
  // Boolean OR/AND/NOT keyword-box matching + parameterized boost strength.
  // Pure + offline (dependency-free core only), deterministic — exit 0/1.
  { name: 'watch-topic-bool-match', cmd: 'npx tsx scripts/watch-topic-bool-match.test.ts' },
  { name: 'watch-steering-persistence', cmd: 'npx tsx scripts/watch-steering-persistence.test.ts', inconclusive3: true },
  { name: 'watch-steering-boot-order', cmd: 'node scripts/check-watch-steering-boot-order.mjs' },
  { name: 'curated-soft-cap', cmd: 'npx tsx scripts/curated-soft-cap.test.ts' },
  // Task #1180 — trustworthy editorial episodes replace aggregate learned
  // scoring/rule generation. Pure contract + persistence/coordinator coverage.
  { name: 'curated-editorial-evidence', cmd: 'npx tsx scripts/curated-editorial-evidence.test.ts' },
  { name: 'curated-editorial-outcome-queue', cmd: 'npx tsx scripts/curated-editorial-outcome-queue.test.ts' },
  { name: 'curated-manual-mutation-coordinator', cmd: 'npx tsx scripts/curated-manual-mutation-coordinator.test.ts' },
  { name: 'curated-manual-mutation-live-wiring', cmd: 'npx tsx scripts/curated-manual-mutation-live-wiring.test.ts' },
  // Task #1027 — editor-correction lessons applied to curated tuning.
  // Four deterministic gates cover Steps 1–4: new soft-cap families, staleness
  // deduction, retro-cap on content-kind override, and domestic-crime cap.
  { name: 'curated-entertainment-cap', cmd: 'npx tsx scripts/curated-entertainment-cap.test.ts' },
  { name: 'curated-staleness-penalty', cmd: 'npx tsx scripts/curated-staleness-penalty.test.ts' },
  { name: 'curated-domestic-crime-cap', cmd: 'npx tsx scripts/curated-domestic-crime-cap.test.ts' },
  { name: 'curated-retrocap-content-kind', cmd: 'npx tsx scripts/curated-retrocap-content-kind.test.ts' },
  { name: 'adversary-crowding', cmd: 'npx tsx scripts/curated-adversary-crowding.test.ts' },
  { name: 'ap-news-title-binding', cmd: 'npx tsx scripts/ap-news-title-binding.test.ts' },
  { name: 'curated-web-scraper', cmd: 'npx tsx scripts/curated-web-scraper.test.ts' },
  { name: 'curated-nonrss-fetch-telemetry', cmd: 'npx tsx scripts/curated-nonrss-fetch-telemetry.test.ts' },
  { name: 'curated-yahoo-desyndication', cmd: 'npx tsx scripts/curated-yahoo-desyndication.test.ts' },
  { name: 'curated-nodecap', cmd: 'npx tsx scripts/curated-nodecap-repro.ts' },
  { name: 'curated-rescue-starvation', cmd: 'npx tsx scripts/curated-rescue-starvation.test.ts' },
  { name: 'curated-refusal-retryable', cmd: 'npx tsx scripts/curated-refusal-retryable.test.ts' },
  { name: 'curated-dominant-angle', cmd: 'npx tsx scripts/curated-dominant-angle.test.ts' },
  { name: 'curated-corroboration', cmd: 'npx tsx scripts/curated-corroboration.test.ts' },
  { name: 'curated-missed-merge-reconcile', cmd: 'npx tsx scripts/curated-missed-merge-reconcile.test.ts' },
  { name: 'curated-json-salvage', cmd: 'npx tsx scripts/curated-json-salvage.test.ts' },
  { name: 'malformed-ai-disposition', cmd: 'npx tsx scripts/malformed-ai-disposition.test.ts' },
  { name: 'curated-whitehouse-live', cmd: 'npx tsx scripts/curated-whitehouse-live.test.ts' },
  { name: 'state-media-api', cmd: 'npx tsx scripts/state-media-api.test.ts', inconclusive3: true },
  { name: 'methodology-links', cmd: 'npx tsx scripts/methodology-anchor-links.test.ts' },
  { name: 'main-feed-promotion-bar', cmd: 'npx tsx scripts/main-feed-promotion-bar.test.ts' },
  // Task: buried-story safety net (server/scoreRetry.ts). Seeds unscored_fallback
  // fixtures in the dev DB, stubs the scorer at the mutable openai seam, and
  // asserts rescore→finalize→promote, retry-cap stop, and window filtering.
  { name: 'score-retry', cmd: 'npx tsx scripts/score-retry.test.ts' },
  { name: 'meltwater-health', cmd: 'npx tsx scripts/meltwater-health.test.ts' },
  { name: 'meltwater-curated', cmd: 'npx tsx scripts/meltwater-curated.test.ts' },
  { name: 'curated-hard-blocked-paywall2', cmd: 'npx tsx scripts/curated-hard-blocked-paywall2.test.ts' },
  // Task #1022: doomed-enrichment short-circuits — Bloomberg newsletter/feature
  // URLs (RSS-image + single bounded CPC only) and CPC-image-doomed hosts
  // (chinaview/kcnawatch image-only CPC skip), plus the prefetch back-off slot
  // filter. Pure/unit + source-structure checks; no live network.
  { name: 'curated-doomed-shortcircuit', cmd: 'npx tsx scripts/curated-doomed-enrichment-shortcircuit.test.ts' },
  { name: 'curated-dark-default', cmd: 'npx tsx scripts/curated-dark-default.test.ts' },
  { name: 'escalation-scoring', cmd: 'npx tsx scripts/statecraft-escalation-scoring.test.ts', inconclusive3: true },
  // Live-model contract: both visible-Curated scoring provenances must keep
  // routine local/incremental conflict updates below protected strategic
  // developments. Provider/result failures exit 3 (inconclusive, re-run).
  { name: 'local-conflict-importance-scoring', cmd: 'npx tsx scripts/local-conflict-importance-scoring.test.ts', inconclusive3: true },
  { name: 'score-spread', cmd: 'npx tsx scripts/score-spread.test.ts' },
  { name: 'curated-ingest-dedup', cmd: 'npx tsx scripts/curated-ingest-dedup.test.ts' },
  { name: 'curated-reemit-window', cmd: 'npx tsx scripts/curated-same-outlet-reemit-window.e2e.test.ts' },
  { name: 'curated-soft-deadline', cmd: 'npx tsx scripts/curated-soft-deadline.test.ts' },
  { name: 'curated-corroboration-e2e', cmd: 'npx tsx scripts/curated-corroboration-e2e.test.ts' },
  { name: 'curated-missed-merge', cmd: 'npx tsx scripts/curated-missed-merge-diagnostic.test.ts' },
  // Unified same-event consolidation lane (phase-fragment union-find). Pure +
  // deterministic — pins group<->group >=2-link merges, overlay skip, caps,
  // and the flag-off standalone-only degrade.
  { name: 'curated-same-event-consolidation', cmd: 'npx tsx scripts/curated-same-event-consolidation.test.ts' },
  { name: 'curated-manual-link-sticky', cmd: 'npx tsx scripts/curated-manual-link-sticky.test.ts' },
  { name: 'curated-exchange-merge', cmd: 'npx tsx scripts/curated-exchange-merge.test.ts' },
  { name: 'server-refs', cmd: 'node scripts/check-server-refs.mjs', slow: true },
  { name: 'curated-region-vocab', cmd: 'npx tsx scripts/curated-region-vocab.test.ts' },
  { name: 'curated-topic-inference', cmd: 'npx tsx scripts/curated-topic-inference.test.ts' },
  { name: 'curated-detail-metadata', cmd: 'npx tsx scripts/curated-detail-metadata.test.ts' },
  // Near-miss topic coercion aliases + prompt-exemplar on-list guard: observed
  // production off-list labels snap to their intended real topic, ambiguous
  // variants stay in the catch-all, and every few-shot "primary_topic" in the
  // analyzer prompt is on the controlled list. Pure + deterministic.
  { name: 'curated-topic-alias', cmd: 'npx tsx scripts/curated-topic-alias.test.ts' },
  { name: 'feed-coalesce', cmd: 'npx tsx scripts/feed-coalesce.test.ts' },
  { name: 'feed-serialized-serve', cmd: 'npx tsx scripts/feed-serialized-serve.test.ts' },
  { name: 'schema-coverage', cmd: 'npx tsx scripts/verify-schema-coverage.ts' },
  { name: 'curated-timeout-recovery', cmd: 'npx tsx scripts/curated-timeout-recovery.test.ts' },
  { name: 'curated-synthesis-garbage', cmd: 'npx tsx scripts/curated-synthesis-garbage.test.ts' },
  { name: 'curated-synthesis-outage', cmd: 'npx tsx scripts/curated-synthesis-outage.test.ts' },
  { name: 'curated-synthesis-render', cmd: 'npx tsx scripts/curated-synthesis-render.test.ts' },
  { name: 'curated-manual-link', cmd: 'npx tsx scripts/curated-manual-link.test.ts' },
  { name: 'curated-manual-link-repartition', cmd: 'npx tsx scripts/curated-manual-link-repartition.test.ts' },
  { name: 'curated-manual-link-dedup', cmd: 'npx tsx scripts/curated-manual-link-dedup.test.ts' },
  { name: 'curated-manual-link-consolidation-transaction', cmd: 'npx tsx scripts/curated-manual-link-consolidation-transaction.test.ts', inconclusive3: true },
  // Overlapping editor merge rows must UNION into one story, never partition
  // (prod incident: a subset retry merge split the story in two). Pure logic.
  { name: 'curated-manual-merge-union', cmd: 'npx tsx scripts/curated-manual-merge-union.test.ts' },
  { name: 'st-logo-detection', cmd: 'npx tsx scripts/straits-times-logo-detection.test.ts' },
  { name: 'auto-headline-override', cmd: 'npx tsx scripts/auto-headline-override.test.ts' },
  { name: 'sms-failover', cmd: 'npx tsx scripts/sms-failover.test.ts' },
  // Task #1040: SMS pipeline health verdict (green/amber/red boundaries) and
  // the one-shot incident/recovery email trigger logic — pure logic + seam-
  // injected state machine, no live DB / real email / network.
  { name: 'sms-alert-health', cmd: 'npx tsx scripts/sms-alert-health.test.ts' },
  { name: 'curated-revision-auth', cmd: 'npx tsx scripts/curated-revision-auth.test.ts' },
  { name: 'curated-revision-signal', cmd: 'npx tsx scripts/curated-revision-signal.test.ts', inconclusive3: true },
  { name: 'mcop-bot-curated', cmd: 'npx tsx scripts/mcop-bot-curated.test.ts' },
  { name: 'curated-feedback-persistence', cmd: 'npx tsx scripts/curated-feedback-persistence.test.ts', inconclusive3: true },
  { name: 'curated-meta-filler', cmd: 'npx tsx scripts/curated-meta-filler-bullets.test.ts' },
  { name: 'curated-member-bullets-quality', cmd: 'npx tsx scripts/curated-member-bullets-quality.test.ts' },
  { name: 'curated-claims-dedup', cmd: 'npx tsx scripts/curated-claims-dedup.test.ts' },
  { name: 'junk-page-detection', cmd: 'npx tsx scripts/junk-page-detection.test.ts' },
  { name: 'live-broadcast-precedence', cmd: 'npx tsx scripts/live-broadcast-precedence.test.ts' },
  { name: 'curated-live-alert-moderation', cmd: 'npx tsx scripts/curated-live-alert-moderation.test.ts' },
  { name: 'curated-opinion-analysis', cmd: 'npx tsx scripts/curated-opinion-analysis.test.ts' },
  { name: 'curated-analysis-cap', cmd: 'npx tsx scripts/curated-analysis-cap.test.ts', inconclusive3: true },
  { name: 'curated-pair-coherence', cmd: 'npx tsx scripts/curated-pair-coherence.test.ts' },
  { name: 'title-only-summary-upgrade', cmd: 'npx tsx scripts/title-only-summary-upgrade.test.ts' },
  { name: 'curated-synthesis-anchor', cmd: 'npx tsx scripts/curated-synthesis-anchor.test.ts' },
  { name: 'curated-headline-stability', cmd: 'npx tsx scripts/curated-headline-stability.test.ts', inconclusive3: true },
  { name: 'stale-status-sanitizer', cmd: 'npx tsx scripts/stale-status-sanitizer.test.ts' },
  { name: 'curated-radar-nondisruption', cmd: 'npx tsx scripts/curated-radar-nondisruption.test.ts', inconclusive3: true },
  { name: 'curated-radar-attribution', cmd: 'npx tsx scripts/curated-radar-attribution.test.ts' },
  { name: 'joe-priorities-bolo-bounded', cmd: 'npx tsx scripts/joe-priorities-bolo-bounded-query.test.ts' },
  { name: 'curated-editorial-episode-persistence', cmd: 'npx tsx scripts/curated-editorial-episode-persistence.test.ts', inconclusive3: true },
  { name: 'curated-editorial-outcome-observation', cmd: 'npx tsx scripts/curated-editorial-outcome-observation.test.ts', inconclusive3: true },
  { name: 'curated-editorial-evidence-atomicity', cmd: 'npx tsx scripts/curated-editorial-evidence-atomicity.test.ts', inconclusive3: true },
  { name: 'curated-content-kind-override', cmd: 'npx tsx scripts/curated-content-kind-override.test.ts', inconclusive3: true },
  { name: 'curated-store-window', cmd: 'npx tsx scripts/curated-store-window.test.ts', inconclusive3: true },
  { name: 'curated-late-joiner-score', cmd: 'npx tsx scripts/curated-late-joiner-score.test.ts' },
  { name: 'curated-attach-ranking-isolation', cmd: 'npx tsx scripts/curated-attach-ranking-isolation.test.ts' },
  { name: 'curated-tiered-decay', cmd: 'npx tsx scripts/curated-tiered-decay.test.ts' },
  { name: 'curated-stale-synopsis-refresh', cmd: 'npx tsx scripts/curated-stale-synopsis-refresh.test.ts' },
  { name: 'curated-recover-published-date', cmd: 'npx tsx scripts/curated-recover-published-date.test.ts' },
  { name: 'curated-published-date-recovery', cmd: 'npx tsx scripts/curated-published-date-recovery.test.ts' },
  { name: 'curated-classification-url-merge', cmd: 'npx tsx scripts/curated-classification-url-merge.test.ts' },
  { name: 'curated-opinion-attach-adjustments', cmd: 'npx tsx scripts/curated-opinion-attach-adjustments.test.ts', inconclusive3: true },
  { name: 'curated-steering-attribution', cmd: 'npx tsx scripts/curated-steering-attribution.test.ts' },
  { name: 'curated-radar-attach-reason', cmd: 'npx tsx scripts/curated-radar-attach-reason.test.ts' },
  { name: 'curated-single-source-spin', cmd: 'npx tsx scripts/curated-single-source-spin.test.ts' },
  // Task #779: analyzer + translator fail-safe on malformed/empty/wrong-shape
  // AI replies — analyzer returns [] (retry, never throw/fabricate), translator
  // preserves every original title (never drops an input). Deterministic,
  // stubbed completion, no live AI.
  { name: 'curated-analyzer-translator-failsafe', cmd: 'npx tsx scripts/curated-analyzer-translator-failsafe.test.ts' },
  // Task #950: per-source admission telemetry check — verifies restored feeds
  // (Bloomberg off-host, Al-Monitor, Yonhap, HuffPost, NewsNation) are monitored
  // and flags relevance-only silence (no duplicate/other disposition) as a FAIL.
  // Broad-feed mixed filtering is informational. Exit 3 (inconclusive)
  // when no ingest pass has completed yet (no telemetry rows).
  { name: 'curated-intake-telemetry', cmd: 'npx tsx scripts/curated-intake-telemetry-check.ts', inconclusive3: true },
  // Task #954: megacluster synthesis freshness — verifies the RECENT/BACKGROUND
  // corroborating-block split fires for war/kinetic clusters spanning >12h, and
  // that shouldRefreshStaleSynopsis uses the 1h kinetic cooldown. Pure + deterministic
  // (no DB, no network, no AI). inconclusive3 in case of transient import issues.
  { name: 'curated-megacluster-freshness', cmd: 'npx tsx scripts/curated-megacluster-freshness.test.ts', inconclusive3: true },
  // Multi-crisis over-merge, lever D: a large dollar figure ("$100 billion")
  // used to tokenize into {100, billion} — 2 shared tokens — welding unrelated
  // money stories (chip fab, tanker deal, Pentagon program) into one megacluster.
  // canonicalizeMoneyFigures de-bridges them (removed out of context, one fused
  // token in a defense-spending context). Pure + deterministic (no DB/LLM/net).
  { name: 'curated-money-debridge', cmd: 'npx tsx scripts/curated-money-debridge.test.ts' },
  // Multi-crisis over-merge, levers B+C: the anchor-split disjoint-actor hint.
  // For an OVERSIZED cluster, tag any member whose named geopolitical actors are
  // ALL outside the cluster's dominant actor core as a strong different-event
  // candidate (the LLM stays decider). Verifies the tag fires on a genuinely
  // foreign member (TSMC/Taiwan, Russia/Ukraine) and stays OFF for same-core
  // members, no-actor members, and normal-size clusters. Pure + deterministic.
  { name: 'curated-classifier-actor-hint', cmd: 'npx tsx scripts/curated-classifier-actor-hint.test.ts' },
  // Task #970: legislative/budget stories must not merge into kinetic-strikes clusters.
  // Regression for the Iran war megacluster absorbing the congressional $95B funding
  // fight, NDAA stall, and $1.5T defense budget battle.
  // (A) NEGATIVE: coherence guard evicts budget/appropriations items from a kinetic cluster.
  // (B) POSITIVE: pure kinetic same-incident angles (strike+interception+casualties+reaction) kept intact.
  // (C) POSITIVE: pure funding items cluster among themselves without eviction.
  // (D) STATIC: all three LLM prompts contain the new carve-out text.
  // Pure + deterministic (no DB / LLM / network).
  { name: 'curated-legislative-budget-split', cmd: 'npx tsx scripts/curated-legislative-budget-split.test.ts' },
  // Task #986: Topic–Focus label fixes — catch-all reclassify eligibility + SCN lane.
  // (1) AI 'Other / Emerging' rows are reclassify-eligible; human rows are protected.
  // (2) Null-primaryTopic (legacy) rows are eligible; real-topic rows are locked.
  // (3) Keyword router rescues obviously-routable catch-all misses (Hormuz → Maritime).
  // (4) SCN lane structure: curated-store items below the CANDIDATE_WINDOW ranked cut
  //     are still added to the classification candidate set via the SCN extension.
  // Pure + deterministic (no DB / LLM / network).
  { name: 'curated-classify-eligibility', cmd: 'npx tsx scripts/curated-classify-eligibility.test.ts' },
  // Task #999: verifies classification lag drops to 0 after one pass for fresh
  // on-screen items, and that the diagnostic warn IS emitted when items are
  // freshly stuck on Other/Emerging within the 30-min on-screen reclassify
  // cooldown. Pure + deterministic (no DB / LLM / network).
  { name: 'curated-classify-lag', cmd: 'npx tsx scripts/curated-classify-lag.test.ts' },
  { name: 'team-review-idempotency', cmd: 'npx tsx scripts/team-review-idempotency.test.ts' },
  // Task #733: end-to-end proof that the runCuratedIngest hard timeout abandons
  // a STALLED in-flight AI relevance-gate call (analyzeCuratedBatchChunked, gate
  // mode) via the AbortError path — not just that loop boundaries honor the
  // signal (that's curated-ingest-abort's job). Blocking fake gate via the
  // aiAnalyzer test seam, fetch + storage stubbed (no live AI / network / DB).
  { name: 'curated-ingest-gate-timeout', cmd: 'npx tsx scripts/curated-ingest-gate-timeout.test.ts' },
  // Task #1084: never-converting-verdicts regression — with a slow stubbed
  // analyzer and a tight soft deadline, gate analysis must stop at the insert
  // reserve cutoff and the insert loop must convert verdict-bearing items into
  // rows IN THE SAME PASS (verdict-first ordering). Guards against removal of
  // GATE_INSERT_RESERVE_MS or the stable partition (perma-deferral, ingested=0).
  // Storage + analyzer stubbed (no live AI / network / DB). Takes ~13s.
  { name: 'curated-ingest-verdict-conversion', cmd: 'npx tsx scripts/curated-ingest-verdict-conversion.test.ts' },
  { name: 'curated-gate-verdict-replay', cmd: 'npx tsx scripts/curated-gate-verdict-replay.test.ts' },
  // Cold-start half: persisted, unexpired verdicts hydrate before the first
  // gate pass; unknown/expired titles still reach the analyzer.
  { name: 'curated-gate-verdict-hydration', cmd: 'npx tsx scripts/curated-gate-verdict-hydration.test.ts' },
  // Task #987: end-to-end proof that the clusterCuratedLane hard timeout
  // abandons a STALLED in-flight AI clustering call (createCuratedClusterCompletion)
  // via the AbortError+raceWithAbort path — the same wedge pattern Task #733
  // fixed for the ingest gate. Blocking fake provider via the test seam,
  // storage stubbed (no live AI / network / DB).
  { name: 'curated-cluster-timeout', cmd: 'npx tsx scripts/curated-cluster-timeout.test.ts' },
  // Task #1004: shared-actor false-merge regression — two stories that share only
  // a country/bilateral relationship (US-China) but describe different actions
  // (AI cooperation speech vs. election-interference accusation) must never be
  // merged into one cluster. Covers:
  //   (A) NEGATIVE — coherence guard evicts election-accusation thread from AI-speech cluster
  //   (B) POSITIVE — pure AI-cooperation cluster: guard evicts nothing
  //   (C) POSITIVE — pure election-interference cluster: guard evicts nothing
  //   (D) STATIC   — new rule phrases are present in the three LLM prompts
  //   (E) LIVE AI  — identifyCuratedClusters produces no cross-group cluster
  { name: 'curated-shared-actor-false-merge', cmd: 'npx tsx scripts/curated-shared-actor-false-merge.test.ts', inconclusive3: true },
  // Shared-country/action-subject regression: a valid dominant pair must evict
  // an unrelated minority event even when all items concern the same country;
  // same-incident angles and differently worded reports of one proceeding stay.
  // Both existing AI calls are stubbed; no live AI, DB, or persistence.
  { name: 'curated-shared-actor-action-gate', cmd: 'npx tsx scripts/curated-shared-actor-action-gate.test.ts' },
  // Task #1133: cause-effect false-merge regression — a downstream economic/
  // market consequence (fuel-price hike) of a military/geopolitical event
  // (Hormuz strike command decision) must never merge with the event itself.
  //   (A) NEGATIVE — 2-item conflict+fuel-price pair dissolves, no story forms
  //   (B)/(C) POSITIVE — legitimate same-event kinetic / economic pairs still form
  //   (D) STATIC   — downstream-effect rule present in BOTH prompts + strict
  //                  2-item same-incident test present in the coherence guard
  //   (E) LIVE AI  — identifyCuratedClusters never cross-merges cause and effect
  { name: 'curated-cause-effect-false-merge', cmd: 'npx tsx scripts/curated-cause-effect-false-merge.test.ts', inconclusive3: true },
  // Task #898: static leak guard for BRAND-NEW public feed endpoints. Scans
  // server/routes.ts for object-spreads of raw getPrimaryFeed rows that don't
  // route through stripInternalArticleFields (curated-gated handlers and
  // `// feed-strip-exempt:` annotated blocks exempt). Closes the gap left by
  // the surface-enumerated isolation-harness Phase 8 list. Pure static +
  // deterministic (no DB / LLM / network), with a synthetic self-test so the
  // analyzer can't rot into a vacuous pass.
  { name: 'public-feed-strip', cmd: 'npx tsx scripts/public-feed-strip.test.ts' },
  // Task #996: watchdog scraper-status reset. Drives the private guard state into
  // the two watchdog force-clear conditions (elapsed > MAX; guard set with no
  // start time) via a test-only seam and invokes the REAL runSelfHealingCheck,
  // asserting each path writes { scrapeStatus: 'idle' }. A negative control
  // (no watchdog condition → no reset) prevents a vacuous pass. Deterministic
  // (storage writes stubbed/captured; no live scrape / AI / network).
  { name: 'watchdog-idle-reset', cmd: 'npx tsx scripts/watchdog-idle-reset.test.ts' },
  // AUTO-HEAL must respect X relay health: while the EV relay heartbeat is
  // healthy, stale X-lane timestamps / frozen blocking counters must NOT fire
  // recovery browser scrapes (relay delivers those lanes); when the relay is
  // stale the fallback recovery must fire unchanged. Drives the REAL
  // runSelfHealingCheck via the scheduler test seam with stubbed metadata;
  // the real recovery scrape is suppressed so no live browser work runs.
  { name: 'x-autoheal-relay', cmd: 'npx tsx scripts/x-autoheal-relay.test.ts' },
  // -------------------------------------------------------------------------
  // Task #740: the previously WRITTEN-BUT-UNWIRED checks. Every scripts/*.test.ts
  // that existed without a manifest entry was triaged and (all 41 of them) wired
  // below — none were superseded or structurally unrunnable. All were verified
  // to pass and exit deterministically before wiring. Pure/deterministic checks
  // carry no flags; the ones that touch the dev DB are still quick and exit 0/1;
  // wsj-feed-image talks to LIVE WSJ feeds and follows the exit-3 convention.
  // -------------------------------------------------------------------------
  { name: 'ai-json-fence-sanitize', cmd: 'npx tsx scripts/ai-json-fence-sanitize.test.ts' },
  { name: 'ai-transient-retry', cmd: 'npx tsx scripts/ai-transient-retry.test.ts' },
  { name: 'curated-analyzer-alignment', cmd: 'npx tsx scripts/curated-analyzer-alignment.test.ts' },
  { name: 'curated-anchor-split', cmd: 'npx tsx scripts/curated-anchor-split.test.ts' },
  { name: 'curated-archive-grace', cmd: 'npx tsx scripts/curated-archive-grace.test.ts' },
  // Hits the DEV database (marker-namespaced writes + cleanup) — still quick.
  { name: 'curated-archive-merge', cmd: 'npx tsx scripts/curated-archive-merge.test.ts' },
  { name: 'curated-capability-cap', cmd: 'npx tsx scripts/curated-capability-cap.test.ts' },
  { name: 'curated-cluster-body-snippet', cmd: 'npx tsx scripts/curated-cluster-body-snippet.test.ts' },
  { name: 'curated-coherence-guard', cmd: 'npx tsx scripts/curated-coherence-guard.test.ts' },
  { name: 'curated-finance-reject', cmd: 'npx tsx scripts/curated-finance-reject.test.ts' },
  { name: 'curated-focus-inference', cmd: 'npx tsx scripts/curated-focus-inference.test.ts' },
  { name: 'curated-garbage-recovery', cmd: 'npx tsx scripts/curated-garbage-recovery.test.ts' },
  { name: 'curated-identical-title-merge', cmd: 'npx tsx scripts/curated-identical-title-merge.test.ts' },
  { name: 'curated-identity-reuse', cmd: 'npx tsx scripts/curated-identity-reuse.test.ts' },
  { name: 'curated-incremental-attach', cmd: 'npx tsx scripts/curated-incremental-attach.test.ts' },
  { name: 'curated-ingest-abort', cmd: 'npx tsx scripts/curated-ingest-abort.test.ts' },
  { name: 'curated-ingest-throughput', cmd: 'npx tsx scripts/curated-ingest-throughput.test.ts' },
  { name: 'curated-layout-guardrail', cmd: 'npx tsx scripts/curated-layout-guardrail.test.ts' },
  { name: 'curated-live-future-date', cmd: 'npx tsx scripts/curated-live-future-date.test.ts' },
  { name: 'curated-live-social-indicator', cmd: 'npx tsx scripts/curated-live-social-indicator.test.ts' },
  { name: 'social-attachment-image', cmd: 'npx tsx scripts/social-attachment-image-suppression.test.ts' },
  { name: 'potus-truth-avatar', cmd: 'npx tsx scripts/potus-truth-avatar.test.ts' },
  { name: 'curated-live-stream-link', cmd: 'npx tsx scripts/curated-live-stream-link.test.ts' },
  { name: 'curated-member-confirmation', cmd: 'npx tsx scripts/curated-member-confirmation.test.ts' },
  { name: 'curated-npr-audio', cmd: 'npx tsx scripts/curated-npr-audio.test.ts' },
  { name: 'curated-only-derivation', cmd: 'npx tsx scripts/curated-only-derivation.test.ts' },
  { name: 'curated-only-mainfeed-gate', cmd: 'npx tsx scripts/curated-only-mainfeed-gate.test.ts' },
  // Hits the DEV database (marker-namespaced rows + cleanup) — still quick.
  { name: 'curated-only-osint', cmd: 'npx tsx scripts/curated-only-osint.test.ts' },
  { name: 'curated-process-repartition', cmd: 'npx tsx scripts/curated-process-repartition.test.ts' },
  // In-memory-store e2e over the REAL similarity/admission code paths.
  { name: 'curated-same-outlet-crowded-window', cmd: 'npx tsx scripts/curated-same-outlet-crowded-window.e2e.test.ts' },
  { name: 'curated-semantic-adversary-attach', cmd: 'npx tsx scripts/curated-semantic-adversary-attach.test.ts' },
  { name: 'curated-url-guard', cmd: 'npx tsx scripts/curated-url-guard.test.ts' },
  { name: 'curated-url-identity', cmd: 'npx tsx scripts/curated-url-identity.test.ts' },
  { name: 'curated-vocab-normalization', cmd: 'npx tsx scripts/curated-vocab-normalization.test.ts' },
  { name: 'feed-dedup-parity', cmd: 'npx tsx scripts/feed-dedup-parity.test.ts' },
  { name: 'feed-health-tracker', cmd: 'npx tsx scripts/feed-health-tracker.test.ts' },
  { name: 'ie-highlights-parser', cmd: 'npx tsx scripts/ie-highlights-parser.test.ts' },
  { name: 'scoring-relevance-overview', cmd: 'npx tsx scripts/scoring-relevance-overview.test.ts' },
  { name: 'summary-sanitizer', cmd: 'npx tsx scripts/summary-sanitizer.test.ts' },
  { name: 'timestamp-extractor', cmd: 'npx tsx scripts/timestamp-extractor.test.ts' },
  // LIVE WSJ RSS fetch — network failure is a precondition, exits 3 per
  // scripts/harness-reliability.ts.
  { name: 'wsj-feed-image', cmd: 'npx tsx scripts/wsj-feed-image.test.ts', inconclusive3: true },
  // Manual-eviction durability: story-sticky anchor expansion keeps an editor
  // "remove from story" firing after full membership churn, while the
  // fail-closed guards stop it from ever firing on an unrelated group. Pins
  // expandManualEvictionAnchors + applyManualEvictions invariants (durability,
  // fail-closed scaling, adoption guards/caps, link precedence, re-seed,
  // determinism). Pure + deterministic (no DB / LLM / network).
  { name: 'curated-eviction-durability', cmd: 'npx tsx scripts/curated-eviction-durability.test.ts' },
  // Attach-only/CPC member controls: editors may detach or move them without
  // exposing content-kind/reclassification controls.
  { name: 'curated-attach-only-editor-controls', cmd: 'npx tsx scripts/curated-attach-only-editor-controls.test.ts' },
  // Curated-only filled actions use the shared brand treatment while the
  // application's default button palette remains untouched.
  { name: 'curated-primary-actions', cmd: 'npx tsx scripts/curated-primary-actions.test.ts' },
  // Manual-move durability: the editor "move member to that OTHER story"
  // overlay re-homes atomically WITHOUT fusing source and target clusters
  // (the reason it is a dedicated overlay, not an evict+link composite).
  // Pins applyManualMoves invariants (re-home/no-fusion, idempotence, link
  // precedence, target/source anchor guards, degrade-to-eviction gate,
  // standalone re-seed, determinism). Pure + deterministic (no DB/LLM/network).
  { name: 'curated-move-durability', cmd: 'npx tsx scripts/curated-move-durability.test.ts' },
  // Meta-gate: fails if any scripts/*.test.ts is neither wired into this manifest
  // nor explicitly excluded — prevents the "written-but-unwired safety check"
  // gap (the reason Task #740 existed) from ever silently recurring.
  // Pure + deterministic (reads the repo, no DB / LLM / network).
  { name: 'gate-manifest-coverage', cmd: 'npx tsx scripts/gate-manifest-coverage.test.ts' },
  // Synthetic orchestration checks (nested runner processes + temp files).
  // Kept isolated because it intentionally exercises scheduling and timeouts.
  { name: 'run-gates-runner', cmd: 'npx tsx scripts/run-gates-runner.test.ts' },
];

/**
 * Explicit, reviewed allowlist for bounded concurrency. This is deliberately
 * separate from the Gate defaults: a typo, omission, or brand-new manifest
 * entry remains isolated rather than accidentally racing a shared resource.
 *
 * Admission rule: deterministic and offline, with no DB access/writes, running
 * dev-server dependency, browser, live network/feed, or live AI/provider call.
 */
const PARALLEL_SAFE_GATE_NAMES = new Set<string>([
  'title-cleaner',
  'social-account-catalog-drift',
  'curated-social-attachment-matrix',
  'curated-social-card-attach',
  'watch-topic-priority',
  'watch-topic-bool-match',
  'watch-steering-boot-order',
  'curated-soft-cap',
  'curated-editorial-evidence',
  'curated-editorial-outcome-queue',
  'curated-manual-mutation-coordinator',
  'curated-manual-mutation-live-wiring',
  'curated-entertainment-cap',
  'curated-staleness-penalty',
  'curated-domestic-crime-cap',
  'curated-retrocap-content-kind',
  'adversary-crowding',
  'ap-news-title-binding',
  'curated-web-scraper',
  'curated-nonrss-fetch-telemetry',
  'curated-yahoo-desyndication',
  'curated-nodecap',
  'curated-rescue-starvation',
  'curated-refusal-retryable',
  'curated-dominant-angle',
  'curated-corroboration',
  'curated-missed-merge-reconcile',
  'curated-json-salvage',
  'malformed-ai-disposition',
  'curated-whitehouse-live',
  'methodology-links',
  'main-feed-promotion-bar',
  'meltwater-health',
  'meltwater-curated',
  'curated-hard-blocked-paywall2',
  'curated-doomed-shortcircuit',
  'curated-dark-default',
  'score-spread',
  'curated-ingest-dedup',
  'curated-soft-deadline',
  'curated-corroboration-e2e',
  'curated-missed-merge',
  'curated-same-event-consolidation',
  'curated-manual-link-sticky',
  'curated-exchange-merge',
  'curated-region-vocab',
  'curated-topic-inference',
  'curated-detail-metadata',
  'curated-topic-alias',
  'feed-coalesce',
  'feed-serialized-serve',
  'curated-timeout-recovery',
  'curated-synthesis-garbage',
  'curated-synthesis-outage',
  'curated-synthesis-render',
  'curated-manual-link',
  'curated-manual-link-repartition',
  'curated-manual-merge-union',
  'st-logo-detection',
  'auto-headline-override',
  'sms-alert-health',
  'curated-revision-auth',
  'mcop-bot-curated',
  'curated-meta-filler',
  'curated-member-bullets-quality',
  'curated-claims-dedup',
  'junk-page-detection',
  'live-broadcast-precedence',
  'curated-live-alert-moderation',
  'curated-opinion-analysis',
  'curated-pair-coherence',
  'title-only-summary-upgrade',
  'curated-synthesis-anchor',
  'stale-status-sanitizer',
  'curated-radar-attribution',
  'joe-priorities-bolo-bounded',
  'curated-late-joiner-score',
  'curated-attach-ranking-isolation',
  'curated-tiered-decay',
  'curated-stale-synopsis-refresh',
  'curated-recover-published-date',
  'curated-published-date-recovery',
  'curated-classification-url-merge',
  'curated-steering-attribution',
  'curated-radar-attach-reason',
  'curated-single-source-spin',
  'curated-analyzer-translator-failsafe',
  'curated-megacluster-freshness',
  'curated-money-debridge',
  'curated-classifier-actor-hint',
  'curated-legislative-budget-split',
  'curated-classify-eligibility',
  'curated-classify-lag',
  'team-review-idempotency',
  'curated-ingest-gate-timeout',
  'curated-ingest-verdict-conversion',
  'curated-gate-verdict-replay',
  'curated-gate-verdict-hydration',
  'curated-cluster-timeout',
  'curated-shared-actor-action-gate',
  'public-feed-strip',
  'watchdog-idle-reset',
  'x-autoheal-relay',
  'ai-json-fence-sanitize',
  'ai-transient-retry',
  'curated-analyzer-alignment',
  'curated-anchor-split',
  'curated-archive-grace',
  'curated-capability-cap',
  'curated-cluster-body-snippet',
  'curated-coherence-guard',
  'curated-finance-reject',
  'curated-focus-inference',
  'curated-garbage-recovery',
  'curated-identical-title-merge',
  'curated-identity-reuse',
  'curated-incremental-attach',
  'curated-ingest-abort',
  'curated-ingest-throughput',
  'curated-layout-guardrail',
  'curated-live-future-date',
  'curated-live-social-indicator',
  'social-attachment-image',
  'potus-truth-avatar',
  'curated-live-stream-link',
  'curated-member-confirmation',
  'curated-npr-audio',
  'curated-only-derivation',
  'curated-only-mainfeed-gate',
  'curated-process-repartition',
  'curated-semantic-adversary-attach',
  'curated-url-guard',
  'curated-url-identity',
  'curated-vocab-normalization',
  'feed-dedup-parity',
  'feed-health-tracker',
  'ie-highlights-parser',
  'scoring-relevance-overview',
  'summary-sanitizer',
  'timestamp-extractor',
  'curated-eviction-durability',
  'curated-attach-only-editor-controls',
  'curated-move-durability',
  'gate-manifest-coverage',
]);

function schedulingClass(gate: Gate, serialMode: boolean): SchedulingClass {
  return !serialMode && PARALLEL_SAFE_GATE_NAMES.has(gate.name) ? 'parallel-offline' : 'isolated';
}

type Outcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

interface GateResult {
  name: string;
  outcome: Outcome;
  exitCode: number | null;
  durationMs: number;
  note?: string;
}

function runGate(gate: Gate): Promise<GateResult> {
  const timeoutMs = gate.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  return new Promise<GateResult>((resolve) => {
    // detached: true puts the gate in its OWN process group so the timeout can
    // kill the whole group (bash -c AND its tsx/node grandchildren). Killing
    // only the bash wrapper would orphan the real check, leaving it running
    // underneath — and interfering with — every later gate.
    const child = spawn('bash', ['-c', gate.cmd], { stdio: 'inherit', detached: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL'); // whole process group
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL'); // group already gone or not killable — best effort
      }
    }, timeoutMs);

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      if (timedOut) {
        resolve({
          name: gate.name,
          outcome: 'FAIL',
          exitCode,
          durationMs,
          note: `timed out after ${Math.round(timeoutMs / 1000)}s`,
        });
        return;
      }
      if (exitCode === 0) {
        resolve({ name: gate.name, outcome: 'PASS', exitCode, durationMs });
        return;
      }
      if (exitCode === 3 && gate.inconclusive3) {
        resolve({
          name: gate.name,
          outcome: 'INCONCLUSIVE',
          exitCode,
          durationMs,
          note: 'exit 3 treated as non-blocking (re-run) per harness-reliability convention',
        });
        return;
      }
      resolve({ name: gate.name, outcome: 'FAIL', exitCode, durationMs });
    };

    child.on('error', (err) => {
      console.error(`[gates] failed to spawn "${gate.name}": ${err.message}`);
      finish(1);
    });
    child.on('close', (code) => finish(code));
  });
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Test-only seam: GATES_MANIFEST_JSON replaces the manifest with an inline
 * JSON array of Gate entries, so the runner's keep-going/exit semantics can be
 * verified with cheap synthetic gates instead of the real (long) checks.
 * Never set in CI — the real manifest above is the source of truth.
 */
function resolveManifest(): Gate[] {
  const raw = process.env.GATES_MANIFEST_JSON;
  if (!raw) return GATES;
  console.log('[gates] WARNING: GATES_MANIFEST_JSON is set — running a synthetic manifest (test mode).');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((g) => typeof g?.name !== 'string' || typeof g?.cmd !== 'string')) {
    throw new Error('GATES_MANIFEST_JSON must be a JSON array of {name, cmd, ...} entries');
  }
  return parsed as Gate[];
}
function parseJobs(args: string[]): number {
  const arg = args.find((value) => value.startsWith('--jobs='));
  const envValue = process.env.GATES_JOBS;
  const raw = arg?.slice('--jobs='.length) ?? envValue ?? String(DEFAULT_PARALLEL_JOBS);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid gate worker count "${raw}" (use --jobs=1..${MAX_PARALLEL_JOBS} or GATES_JOBS)`);
  }
  const jobs = Number(raw);
  if (jobs < 1 || jobs > MAX_PARALLEL_JOBS) {
    throw new Error(`gate worker count must be between 1 and ${MAX_PARALLEL_JOBS}; got ${jobs}`);
  }
  return jobs;
}

/* ---------------------------------------------------------------------------
 * RESUME CHECKPOINT — see the header comment for the full contract.
 * ------------------------------------------------------------------------- */

const DEFAULT_RESUME_STATE_FILE = '.local/gates-state.json';
const RESUME_TTL_MS = 90 * 60 * 1000; // stale checkpoints are worthless — expire them

interface ResumeEntry {
  /** Hash of the gate's cmd at the time it passed — manifest edits invalidate it. */
  cmdHash: string;
  /** Epoch ms when the gate passed. */
  at: number;
}

interface ResumeState {
  workspaceHash: string;
  entries: Record<string, ResumeEntry>;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Exact-workspace-state fingerprint: HEAD commit + the full tracked diff +
 * the porcelain status (captures adds/renames/untracked names) + the CONTENT
 * hash of every untracked (non-ignored) file. Porcelain alone lists untracked
 * files by name only, so without the last part an edit to an already-untracked
 * file (e.g. a brand-new gate script) would be invisible and a stale PASS
 * could be resumed. Any edit to any tracked OR untracked file — or any new
 * file — changes the hash and invalidates every checkpointed PASS. Returns
 * null (resume disabled) if git is unavailable for any reason: fail-closed
 * toward re-running everything.
 */
function computeWorkspaceHash(): string | null {
  try {
    const opts = { maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] as const };
    const head = execSync('git rev-parse HEAD', opts).toString();
    const diff = execSync('git --no-optional-locks diff HEAD', opts).toString();
    const status = execSync('git --no-optional-locks status --porcelain', opts).toString();
    // Content hashes of untracked files (one git blob hash per line, in the
    // same order as the ls-files listing). Empty output when none exist.
    const untracked = execSync(
      'git --no-optional-locks ls-files --others --exclude-standard | git hash-object --stdin-paths',
      { ...opts, shell: '/bin/sh' },
    ).toString();
    return sha256(`${head}\0${diff}\0${status}\0${untracked}`);
  } catch {
    return null;
  }
}

function loadResumeEntries(workspaceHash: string, stateFile: string): Record<string, ResumeEntry> {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as ResumeState;
    if (!parsed || parsed.workspaceHash !== workspaceHash || typeof parsed.entries !== 'object') {
      return {};
    }
    const now = Date.now();
    const fresh: Record<string, ResumeEntry> = {};
    for (const [name, entry] of Object.entries(parsed.entries)) {
      if (
        entry &&
        typeof entry.cmdHash === 'string' &&
        typeof entry.at === 'number' &&
        now - entry.at < RESUME_TTL_MS
      ) {
        fresh[name] = entry;
      }
    }
    return fresh;
  } catch {
    return {}; // missing/corrupt checkpoint — run everything
  }
}

/**
 * Persist checkpoint entries, MERGING with whatever is already on disk for the
 * same workspace hash. Merging matters: a named single-gate run (`run-gates.ts
 * some-gate`) only tracks its own entries, and a plain overwrite would stomp
 * the full-suite checkpoint accumulated by the gates workflow. Union keeps
 * both. `tombstones` are gates THIS run explicitly invalidated (FAIL or
 * INCONCLUSIVE) — they are removed even if the on-disk state still has them,
 * so a failure always forces a re-run. A different workspace hash on disk is
 * discarded wholesale (stale state).
 */
function saveResumeEntries(
  workspaceHash: string,
  entries: Record<string, ResumeEntry>,
  tombstones: Set<string>,
  stateFile: string,
): void {
  try {
    const stateDir = stateFile.includes('/') ? stateFile.slice(0, stateFile.lastIndexOf('/')) : '.';
    mkdirSync(stateDir, { recursive: true });
    const merged: Record<string, ResumeEntry> = {
      ...loadResumeEntries(workspaceHash, stateFile), // {} if hash differs / file missing
      ...entries,
    };
    for (const name of tombstones) delete merged[name];
    const state: ResumeState = { workspaceHash, entries: merged };
    writeFileSync(stateFile, JSON.stringify(state));
  } catch {
    // best-effort: a failed checkpoint write must never fail the suite
  }
}

async function main() {
  const suiteStarted = Date.now();
  const args = process.argv.slice(2);
  const manifest = resolveManifest();
  const serialMode = args.includes('--serial');
  const jobs = serialMode ? 1 : parseJobs(args);
  const syntheticMode = !!process.env.GATES_MANIFEST_JSON;
  const stateFile =
    syntheticMode && process.env.GATES_TEST_STATE_FILE
      ? process.env.GATES_TEST_STATE_FILE
      : DEFAULT_RESUME_STATE_FILE;

  if (args.includes('--list')) {
    const fastCount = manifest.filter((g) => !g.slow).length;
    const slowCount = manifest.filter((g) => g.slow).length;
    const parallelCount = manifest.filter((g) => schedulingClass(g, false) === 'parallel-offline').length;
    console.log(
      `Gate manifest (${manifest.length} gates: ${fastCount} fast, ${slowCount} slow; ` +
        `${parallelCount} parallel-offline, ${manifest.length - parallelCount} isolated):`,
    );
    for (const g of manifest) {
      const tags = [
        g.slow ? '[slow]' : '[fast]',
        `[${schedulingClass(g, false)}]`,
        g.inconclusive3 ? '[exit-3=inconclusive]' : '',
      ].filter(Boolean).join('  ');
      console.log(`  ${g.name}  ${tags}`);
      console.log(`      ${g.cmd}`);
    }
    process.exit(0);
  }

  // Tier selection: --fast skips slow gates; --full (or no flag) runs all.
  const fastMode = args.includes('--fast');

  // Build the set of gates to run.
  let toRun = manifest;

  // Apply tier filter first (before named selectors).
  if (fastMode) {
    toRun = toRun.filter((g) => !g.slow);
  }

  // Apply named-gate selectors (compatible with both tiers).
  const namedSelectors = args.filter((a) => !a.startsWith('--'));
  if (namedSelectors.length > 0) {
    const known = new Set(manifest.map((g) => g.name));
    const unknown = namedSelectors.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      console.error(`[gates] unknown gate(s): ${unknown.join(', ')}`);
      console.error(`[gates] run "npx tsx scripts/run-gates.ts --list" to see valid names.`);
      process.exit(2);
    }
    toRun = toRun.filter((g) => namedSelectors.includes(g.name));
  }

  const tierLabel = fastMode ? 'FAST tier' : 'FULL';
  const classCounts = {
    parallel: toRun.filter((g) => schedulingClass(g, serialMode) === 'parallel-offline').length,
    isolated: toRun.filter((g) => schedulingClass(g, serialMode) === 'isolated').length,
  };
  console.log(`\n=== CI gates: running ${toRun.length} gate(s) [${tierLabel}] ===`);
  console.log(
    `[gates] scheduler: ${serialMode ? 'serial fallback' : `barrier pool, max ${jobs} offline workers`}; ` +
      `${classCounts.parallel} parallel-offline, ${classCounts.isolated} isolated\n`,
  );
  if (fastMode) {
    const skipped = manifest.filter((g) => g.slow).map((g) => g.name);
    console.log(`[gates] --fast mode: skipping slow gate(s): ${skipped.join(', ')}\n`);
  }

  // ---- Resume checkpoint: skip gates that already PASSED for this exact
  // workspace state (see header contract). Disabled in synthetic test mode,
  // with --fresh / GATES_NO_RESUME=1, or when git is unavailable.
  const freshMode = args.includes('--fresh') || process.env.GATES_NO_RESUME === '1';
  const workspaceHash =
    syntheticMode && process.env.GATES_TEST_WORKSPACE_HASH
      ? process.env.GATES_TEST_WORKSPACE_HASH
      : syntheticMode
        ? null
        : computeWorkspaceHash();
  const resumeEntries: Record<string, ResumeEntry> =
    workspaceHash && !freshMode ? loadResumeEntries(workspaceHash, stateFile) : {};

  const results: GateResult[] = [];
  const pending: Gate[] = [];
  for (const gate of toRun) {
    const entry = resumeEntries[gate.name];
    const explicitlyNamed = namedSelectors.includes(gate.name);
    if (!explicitlyNamed && entry && entry.cmdHash === sha256(gate.cmd)) {
      const agoMin = Math.round((Date.now() - entry.at) / 60000);
      results.push({
        name: gate.name,
        outcome: 'PASS',
        exitCode: 0,
        durationMs: 0,
        note: `resumed — passed ${agoMin}m ago in this identical workspace state (--fresh to force re-run)`,
      });
    } else {
      pending.push(gate);
    }
  }
  if (results.length > 0) {
    console.log(
      `[gates] RESUME: ${results.length} gate(s) already PASSED for this identical workspace state ` +
        `(checkpoint ${stateFile}); running the remaining ${pending.length}. Use --fresh to re-run everything.\n`,
    );
  }
  // Track live checkpoint entries for this run: start from the (validated)
  // resumed entries and add/remove as gates finish. `tombstones` collects
  // gates this run explicitly invalidated (FAIL/INCONCLUSIVE) so the merge-on-
  // save in saveResumeEntries can never resurrect them from disk.
  const liveEntries: Record<string, ResumeEntry> = {};
  const tombstones = new Set<string>();
  for (const r of results) {
    const gate = toRun.find((g) => g.name === r.name);
    if (gate) liveEntries[gate.name] = { cmdHash: sha256(gate.cmd), at: resumeEntries[gate.name].at };
  }

  const pendingIndex = new Map(pending.map((gate, index) => [gate.name, index]));

  const recordResult = (gate: Gate, result: GateResult) => {
    results.push(result);
    console.log(
      `----- gate ${gate.name}: ${result.outcome}` +
        ` (exit ${result.exitCode}, ${fmtDuration(result.durationMs)})` +
        `${result.note ? ` — ${result.note}` : ''} -----`,
    );

    // Checkpoint after EVERY completed gate. Node serializes these synchronous
    // updates even when child processes finish close together, so no write race
    // can lose an entry.
    if (workspaceHash) {
      if (result.outcome === 'PASS') {
        liveEntries[gate.name] = { cmdHash: sha256(gate.cmd), at: Date.now() };
        tombstones.delete(gate.name);
      } else {
        delete liveEntries[gate.name];
        tombstones.add(gate.name);
      }
      saveResumeEntries(workspaceHash, liveEntries, tombstones, stateFile);
    }
  };

  const executeGate = async (gate: Gate): Promise<void> => {
    const index = pendingIndex.get(gate.name) ?? 0;
    console.log(
      `\n----- [${index + 1}/${pending.length}] gate: ${gate.name}` +
        `${gate.slow ? ' [slow]' : ''} [${schedulingClass(gate, serialMode)}] -----`,
    );
    // Keep-going guarantee: a gate must never abort the runner. Any unexpected
    // exception while running a gate is recorded as that gate's FAIL and the
    // loop continues, so a flaky early gate can't silently skip later gates.
    let result: GateResult;
    try {
      result = await runGate(gate);
    } catch (err: any) {
      console.error(`[gates] gate "${gate.name}" crashed the runner-side harness: ${err?.stack ?? err}`);
      result = {
        name: gate.name,
        outcome: 'FAIL',
        exitCode: null,
        durationMs: 0,
        note: 'runner-side exception while executing this gate (recorded as FAIL, run continued)',
      };
    }
    recordResult(gate, result);
  };

  const runParallelBatch = async (batch: Gate[]): Promise<void> => {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(jobs, batch.length) }, async () => {
      while (cursor < batch.length) {
        const gate = batch[cursor++];
        await executeGate(gate);
      }
    });
    await Promise.all(workers);
  };

  // Isolated gates are full barriers: drain each consecutive offline batch,
  // run the isolated gate alone, then admit the next offline batch.
  for (let i = 0; i < pending.length; ) {
    const gate = pending[i];
    if (schedulingClass(gate, serialMode) === 'isolated') {
      await executeGate(gate);
      i++;
      continue;
    }
    const batch: Gate[] = [];
    while (i < pending.length && schedulingClass(pending[i], serialMode) === 'parallel-offline') {
      batch.push(pending[i++]);
    }
    await runParallelBatch(batch);
  }

  // Completion order is nondeterministic in the offline pool. Summaries and
  // coverage comparisons remain deterministic in selected-manifest order.
  const resultByName = new Map(results.map((result) => [result.name, result]));
  const orderedResults = toRun.map((gate) => resultByName.get(gate.name)).filter((r): r is GateResult => !!r);
  if (orderedResults.length !== toRun.length || resultByName.size !== results.length) {
    console.error(
      `[gates] internal result collection error: expected ${toRun.length}, ` +
        `collected ${results.length} (${resultByName.size} unique)`,
    );
    process.exit(1);
  }

  const failed = orderedResults.filter((r) => r.outcome === 'FAIL');
  const inconclusive = orderedResults.filter((r) => r.outcome === 'INCONCLUSIVE');
  const passed = orderedResults.filter((r) => r.outcome === 'PASS');
  const elapsedMs = Date.now() - suiteStarted;

  console.log(`\n=== CI gates summary [${tierLabel}] ===`);
  for (const r of orderedResults) {
    console.log(
      `  ${r.outcome.padEnd(12)} ${r.name.padEnd(32)} ${fmtDuration(r.durationMs).padStart(6)}` +
        `${r.note ? `  (${r.note})` : ''}`,
    );
  }
  console.log(
    `\n${passed.length} passed, ${failed.length} failed, ${inconclusive.length} inconclusive` +
      ` of ${orderedResults.length} gate(s) in ${fmtDuration(elapsedMs)}.`,
  );
  const slowest = [...orderedResults]
    .filter((result) => result.durationMs > 0)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10);
  console.log(
    `[gates] slowest checks: ` +
      (slowest.length > 0
        ? slowest.map((result) => `${result.name} ${fmtDuration(result.durationMs)}`).join(', ')
        : 'none executed (all resumed)'),
  );

  if (failed.length > 0) {
    console.error(`\n[gates] FAILURES: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
  if (inconclusive.length > 0) {
    console.log(
      `\n[gates] ${inconclusive.length} inconclusive gate(s) (non-blocking, re-run to confirm): ` +
        inconclusive.map((f) => f.name).join(', '),
    );
  }
  console.log(`\n[gates] all blocking gates passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[gates] runner crashed: ${err?.stack ?? err}`);
  process.exit(1);
});
