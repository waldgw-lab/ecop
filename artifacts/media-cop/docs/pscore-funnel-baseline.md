# P-Scoring & Relevance Funnel — Baseline Measurement (Phase 0)

**Scope:** Measurement and reporting only. **No behavior changed** — no scores, prompts,
decay curves, pre-filter keyword lists, or candidate-selection logic were touched. All
downstream behavior changes are owned by `pscore-relevance-gate-source-calibration.md`.

**Date of measurement:** 2026-06-29
**Method:** Read-only production SQL (`executeSql … environment: production`) over the live
tables, plus static reads of the scoring/selection/decay code paths. Both validation
harnesses re-run at the end to confirm the codebase is unchanged in behavior. The exact,
runnable measurement queries are checked in alongside this report at
`docs/pscore-funnel-baseline-queries.sql` so the baseline can be reproduced deterministically.

**Lanes covered:** Main (Classic + Visual, table `headlines`), Curated (`curated_items` +
live `curated_cluster_members`), Custom MCOP (`custom_mcop_scores`), War (`war_articles`).

---

## 0. Where each lane gets its score

| Lane | Scorer | Declump at source? | Default on missing field | Default on AI error |
|---|---|---|---|---|
| Main (Classic/Visual) | `aiAnalyzer.analyzeBatchHeadlines` (gpt-4o-mini) | **No** | `priority_score \|\| 50` | batch → `[]` (whole batch unscored); single → `is_relevant=false, score=1` |
| Curated | `aiAnalyzer.analyzeCuratedChunk` (gpt-4o-mini) | **Yes** — `declumpCuratedScores()` runs before storage | `priority_score \|\| 50` | chunk → `[]` |
| Custom MCOP | `customMcopScorer.scoreBatch` (gpt-4o-mini, per-MCOP prompt) | No | `\|\| 50`, clamped 0–100 | empty/parse-fail → all `score=50, is_relevant=true` |
| War | `war_articles` (own source/admin) | No | n/a | n/a |

Two structural notes that the numbers below repeatedly expose:

1. **The `\|\| 50` fallback is overloaded.** A genuine model score of `0` and a *missing/
   null* score both collapse to exactly `50`. So "50" is not a real priority value in any
   lane — it is a mixture of "model said middling" and "model returned nothing." This is the
   single biggest source of round-number clumping in the un-declumped lanes.
2. **Only the curated lane declumps.** Main, Custom MCOP, and War store the raw model output,
   so model tie-clumping (especially at 90/70/50) passes straight through to the feed.

---

## 1. Score distribution & round-number clumping

### 1a. Main lane — `headlines` (N = 54)

- **avg 32.3**, min 5, max 90.
- **Round-multiples-of-10: 35 / 54 = 65%.**
- **Exactly 50: 22 / 54 = 41%.** This is the `\|\| 50` default fallback dominating the lane.
- Histogram: `90:1  80:2  70:2  65:1  50:22  25:1  10:8  5:17`.
- The two visible clumps are **50 (the default)** and a low-relevance tail at **5 (17 rows)
  and 10 (8 rows)** — items the AI kept but scored near the floor.
- **No at-source declump** runs on this lane, so any tie the model returns is stored verbatim.

> **Finding:** the main lane is dominated by the default-50 fallback, not by differentiated
> scoring. 41% of live rows carry the value that means "the model gave us nothing usable."

### 1b. Curated lane — `curated_items` (N = 3369)

- **avg 60.1**, min 3, max 95.
- **Round-multiples-of-10: 564 / 3369 = 16.7%** — markedly lower than the un-declumped lanes,
  confirming `declumpCuratedScores()` is doing its job at the 90/80/70 ties.
- **But a dense mid-band remains at 55–65** (per-value counts):
  `62:260  58:247  60:244  65:200  57:196  56:191  63:174  61:170  59:165`.
  Roughly a third of the pool is compressed into an 11-point window. Declump breaks exact
  ties; it does **not** widen the rubric's natural central tendency.
- Residual clumps survive at `85:91  75:102  70:115  50:112  45:146`.

> **Finding:** declump removed the round-number problem but left a **55–65 compression
> band**. Within a same-event cluster this narrow band gives clustering candidate-selection
> very little signal to rank on.

### 1c. Custom MCOP — `custom_mcop_scores` (N = 5071)

- **avg 18.1** (low by design — per-user `EXCLUDE/DOWNRANK` prompts push most items down),
  min 1, max 95.
- **Round-multiples-of-10: 1136 / 5071 = 22.4%.**
- **Exactly 50: 150** rows (the `\|\| 50` / parse-fallback default).
- No declump; raw model output stored. Clumping is milder than main lane only because the
  per-MCOP prompt spreads scores across the 1–100 range more than the main rubric does.

### 1d. War — `war_articles` (N = 54)

- **avg 56.4**, min 4, max 90.
- **Round-multiples-of-10: 51 / 54 = 94%** — the most clumped lane measured.
- **Exactly 50: 29 / 54 = 54%.**
- This lane has its own admin/source path and no declump; over half the rows sit on the
  default and almost everything is on a round number.

> **Cross-lane summary of clumping**

| Lane | N | avg | % on ×10 | % at exactly 50 |
|---|---|---|---|---|
| Main | 54 | 32.3 | **65%** | **41%** |
| Curated | 3369 | 60.1 | **16.7%** | 3.3% |
| Custom MCOP | 5071 | 18.1 | 22.4% | 3.0% |
| War | 54 | 56.4 | **94%** | **54%** |

The contrast is the headline result: **the one lane that declumps (Curated) is the only lane
without a round-number / default-50 problem.**

---

## 2. Cross-batch comparability of same-event rows

Two rows describing the same event are scored in different AI batches, so their scores are
only as comparable as the rubric is absolute. Measured two ways:

- **Exact-title duplicates (curated):** almost entirely removed by URL/title dedup — only
  **1** cross-batch exact-title group survived (Saudi Aramco, `72` vs `25`, **spread 47**).
  So exact dupes are not the problem; near-dupes within a cluster are.
- **Live same-event clusters (`curated_cluster_members`, 54 member-rows across 5 clusters
  with >1 member):** avg **10.8 members/cluster**, **avg intra-cluster score spread 21**,
  **max spread 34**. Concrete examples: one cluster spans `51→85` (spread 34), another
  `52→85` (spread 33).

> **Finding:** rows the system itself has judged to be the *same story* routinely land **20–34
> points apart**. The curated rescue/candidate lanes (Section 4) currently absorb this
> incomparability — i.e. breadth is preserved *despite* the score spread, not because of it.
> This is the direct evidence that motivates a cross-batch normalization effort; it confirms
> the premise without prescribing the fix.

---

## 3. Relevance-gate quality

The main-lane relevance funnel has three stages before a headline is stored:

1. **Deterministic keyword pre-filter** (`scraper.ts`):
   - `HARD_EXCLUSION_KEYWORDS` → hard-dropped before any AI call (entertainment/sports/
     consumer-medical/etc.).
   - `FINANCE_WEATHER_KEYWORDS` → drop-eligible but rescuable.
   - `CRITICAL / HIGH_PRIORITY / MILITARY_KEYWORDS` → fast-track keep.
   - Drops are **logged** (`After pre-filtering: … removed N`) but **not persisted**, so the
     false-negative rate of the deterministic stage **cannot be reconstructed from the DB**.
     This is an instrumentation gap, not a behavior bug.
2. **AI relevance gate** (`analyzeBatchHeadlines` / `analyzeHeadlineRelevance`):
   - **Fail-closed on error.** A batch error returns `[]` → the *entire batch* is silently
     dropped from the main feed. A single-item error returns `is_relevant=false, score=1`.
     Under an AI 429 storm this means quiet main-feed false-negatives with no DB trace.
3. **Reject → curated re-route** (`scraper.ts` → `admitCuratedCandidates(mode:'gate')`):
   - Strict-gate rejects and low-cred items are **rerouted into the isolated curated lane as
     attach-only** (bounded by `MAX_CURATED_REJECTS`), never re-entering Classic/Visual.
   - This is the safety valve for main-gate false-negatives — but it is itself **AI-budget
     bounded** (the isolation harness this run logged `admitCuratedCandidates exceeded 5000ms
     AI budget`), so under load some rerouted rejects are skipped entirely.

> **Finding:** the gate is conservatively **fail-closed** (good for noise, bad for recall),
> and the two places where genuine items are silently lost — (a) whole-batch AI errors and
> (b) un-persisted deterministic pre-filter drops — are exactly the places with **no
> measurable audit trail today.** Any recall tuning downstream needs that audit trail first.

---

## 4. Curated node-selection rescue counts

Candidate selection for the clustering LLM is hard-bounded and trust-aware
(`curatedCluster.ts`):

| Budget | Value | Purpose |
|---|---|---|
| `MAX_NODES` | 140 | base LLM payload (top items by priority) |
| `RESCUE_BUDGET` | 60 | overflow same-event / near-dup rescue (incl. archive-grace sub-lane) |
| `EVENT_BUCKET_BUDGET` | 80 | same-event bucket seeding so standalone rows can cluster |
| `SOCIAL_RESCUE_BUDGET` | 40 | reserve slots for social/flash items |
| `CONTRAST_RESCUE_BUDGET` | 40 | reserve slots for adversary/contrast breadth |
| `PRIMARY_ADVERSARY_CAP` | 56 (= 40% of 140) | caps adversary/attach share of the primary cut so trusted contributors aren't crowded out |

`selectCandidateNodes` returns per-pass counters — `rescuedActiveOrNearDup`,
`rescuedArchiveGrace`, `rescuedEventBucket`, `rescuedIdenticalTitle`, `rescuedSocial`,
`rescuedContrast`, and the cap accounting `primaryAdversary` / `primaryContributing`.

> **Instrumentation gap:** these rescue counters are **runtime-logged only, never persisted**.
> A deployment-log search across the current window returned no occurrences, so per-pass
> rescue volume is **not measurable historically.** What *is* persisted is the
> `curated_cluster_metrics` flight recorder (1219 rows). Over the most recent 100 passes:

| Metric | avg/pass |
|---|---|
| formed_stories | 5.6 |
| false_merge_dissolutions | 10 |
| anchor_split_released | 34 |
| smart_repartitions | 2 |
| repartition_members_moved | 646 |
| prevented_repartitions | 2 |
| archive_carry_forward | 158 |
| archive_absorbed | 25 |

> **Finding:** clustering churn is heavy (646 members moved/pass, 158 archive carry-forwards)
> but the **node-selection rescue lanes that decide what even reaches the LLM are a blind
> spot** — the one part of the funnel with budgets explicitly tuned for recall vs. precision
> has no persisted telemetry.

---

## 5. Decay behavior (curated, flat −10/hr, floor 20)

`storage.ts calculateDepreciatedPriority`: 0–2h grace, then **−10 points/hour**, **floor 20**,
anchored to `article_published_at` (else `scraped_at`); human overrides bypass decay. Decay is
**display-only** and is **not** a clustering-admission gate (curated re-anchors to published
date). Measured over the curated pool with timestamps (N = 3346):

- **83.1% (2779 rows) are pinned at the floor (20).**
- **avg base score 60.1 → avg decayed score 25.1.**
- Time-to-floor under the flat curve: a **50 hits floor in 5h**, a **65 in 7h**, an **85 in 9h**.
- Age buckets: `0–2h:156   2–8h:509   8–24h:1002   24h+:1679`.

> **Finding:** the flat −10/hr / floor-20 curve **saturates the pool at the floor** — within
> ~half a day the overwhelming majority of curated items are indistinguishable at score 20.
> Because decay is display-only and re-anchored, this does **not** corrupt clustering, but it
> does mean **decayed priority carries almost no ranking signal for anything older than a few
> hours.** Any retune must respect that this curve is a shared display seam.

---

## 6. Recommendations (for the downstream calibration task)

Ranked by evidence strength. **Phase 0 prescribes nothing here — these are the directions the
baseline data supports**; implementation is owned entirely by
`pscore-relevance-gate-source-calibration.md`.

1. **At-source declump for the un-declumped lanes (strong, Main especially).**
   65% round / 41%-at-50 on Main and 94% / 54% on War are caused by (a) no declump and (b) the
   overloaded `\|\| 50` fallback. Two cheap, low-risk wins: run the existing
   `declumpCuratedScores`-style spread on Main, and **stop collapsing `0`/missing into `50`**
   (distinguish "no score" from "middling").

2. **Make the silent false-negative paths auditable (strong, prerequisite).**
   Persist (or at least structured-log) the deterministic pre-filter drops and the whole-batch
   AI-error drops. Today the two places genuine items disappear have **no DB trace**, so recall
   tuning is flying blind. This should land *before* any gate-threshold change.

3. **Persist the node-selection rescue counters (strong, low-risk).**
   The rescue lanes are the recall/precision dial of the curated funnel yet emit no durable
   telemetry. Adding their counts to the existing `curated_cluster_metrics` flight recorder is a
   self-contained instrumentation change.

4. **Curated rubric spread, not just declump (moderate).**
   Declump fixed round-number ties but left a 55–65 compression band that starves cluster
   candidate-ranking. Worth widening the rubric's central spread; lower urgency than #1 since
   declump already removed the worst clumping.

5. **Decay retune (moderate, handle with care).**
   83% floor-saturation says the flat −10/hr curve is too steep for the pool's volume/age mix.
   A gentler slope or higher floor would restore ranking signal — but decay is a shared
   display-only seam, so change it in isolation with the curated harness as the guard.

6. **Cross-batch normalization (separate effort).**
   The 20–34-point intra-cluster spread confirms same-event incomparability is real. It is
   currently masked by the rescue lanes, so it is lower-priority than the clumping fixes, but
   the evidence validates pursuing a normalization pass as its own task.

---

## 7. Validation — harnesses still pass (no behavior changed)

- `scripts/relevance-harness.ts` (snapshot → compare): **headline-feed byte-identical, stream
  byte-identical.** (custom-cyber had no baseline in the snapshot pass due to the known
  localhost-auth slug-resolution quirk — not a regression.)
- `scripts/curated-isolation-harness.ts`: **all isolation guarantees hold** — every intake
  non-leak (team + reject), write-scope, and social-window assertion passed.

Both confirm this Phase-0 work is measurement-only.
