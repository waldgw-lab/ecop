# Did #414 (Prevent giant curated mega-clusters) land? — Partially landed

**One-line verdict:** In production, curated mega-cards are currently bounded to the dev target (live max 28, recent-hour max 31, no cards ≥37) and the size-split overlays re-evaluate fresh — so the over-clustering axis meets its done-criteria right now — but the observation window since publish is short (~1.5h) and overlapped an out-of-memory crash loop, the new *early-prevention* gate has fired 0 times (the bounding is being done by the pre-existing backstop + fresh overlay re-evaluation), and the under-clustering (recall) axis is **indeterminate** because the baseline numbers can't be reproduced apples-to-apples.

## Lineage
- #414 (Prevent giant curated mega-clusters) — parent, **Merged & live** (merged 06-23 22:39; republished to prod ~06-24 midday).
- #423 (Verify mega-cluster fix landed in prod) — this verification, Active. No follow-up chain, no drafts, no other related tasks.

## Is #414 actually live in prod?
- **Yes, but exact publish minute is inferred, not log-confirmed.** No server-startup/build marker was visible in the deployment-log window. The flight-recorder columns for #414 (`prevention_repartition_*`) read non-null (=0) from the *first* metrics row (06-23 15:07) — but that is a schema-migration default backfill, **not** proof the code ran then (the column is added with a default, so pre-publish rows also show 0).
- Best estimate: **publish ~06-24 12:40** — it merged the night before, this verify-after-publish task was created 06-24 12:40, and the live max-cluster size dropped from the pre-publish 37–38 range (10:00–12:00 today) to 27–31 from ~13:00 onward. That regime change lines up with a midday publish.

## "Done looks like" — claim by claim

1. **Biggest card size / p95 drop from 37–38 toward dev ~29–31; no longer persistently two cards ≥37.** — **Met (current window).**
   - Evidence (live clusters now): top sizes 28, 23, 16, 13, 8, 8, 8, 6 — max 28, no card ≥37.
   - Evidence (flight recorder): recent hour max 31 / avg 28 / p95 31. Pre-publish hours today (10:00–12:00) showed 37–38 (matching the documented prod baseline); post-publish hours show 27–31 (matching the dev target).

2. **Size-split overlay re-evaluates on a fresh cadence (not cooldown-frozen on a stale ~88-member decision); splits actually fire; sub-stories stay coherent.** — **Met.**
   - Evidence: 6 active split overlays; newest re-evaluated 06-24 14:04 (≈6 min before the snapshot), oldest 16.6h — a healthy spread, not all frozen on one stale decision. `smart_repartition_triggered` events recur across the day. The pre-publish "stuck ~1.5h on one 88-member decision with cooldown-skipped on most passes" symptom is gone.

3. **Under-clustering / recall not worse than the pre-publish prod numbers (missed-attach all-roles, missed-attach contributing-only, standalone-should-merge-strict).** — **Indeterminate (no evidence of a #414-caused regression).**
   - Replicated over the last 24h of standalone `curated_items` (same multi-distinctive-token match rule):
     - missed-attach all roles: **312 / 1773 = 17.6%** (prod baseline ~9.3%, dev ~3.6%)
     - missed-attach contributing-only: **106 / 868 = 12.2%** (prod baseline ~4.2%, dev ~4.6%)
     - standalone-should-merge strict: **1179 / 1773 = 66.5%** (prod baseline ~39.9%, dev ~29.3%)
   - These are higher than *both* baselines, but the comparison is not trustworthy:
     - **No reproducible baseline.** The pre-publish numbers were computed ad-hoc in the prior session; there is no saved diagnostic script in the repo, so the exact denominator/rule can't be matched.
     - **Volume confound (the task warns about this).** The task notes "matched volume (~110 dev / ~131 prod sources) is the cleanest comparison; volume swings move counts." The live window has only **62 distinct sources** but **1,773 standalone items** — a denser feed mechanically inflates both missed-attach and should-merge rates.
     - **No mechanism for #414 to harm recall.** #414 *splits* over-large clusters; it does not create standalone single-source items. So an elevated standalone-recall rate cannot be caused by #414 — it points to ingest/volume, not this fix.

## Shortfalls / caveats (quantified)
- **Early-prevention gate is dormant in prod.** Across all **199** recorded passes (06-23 15:07 → 06-24 14:03), `prevention_repartition_audited = 0` and `prevention_repartition_triggered = 0`. The mega-cards are being held down by the *pre-existing* backstop (≥50 members, or ≥25 and ≥16h old) plus fresh overlay re-evaluation — **not** by #414's new early gate. By design the early gate only fires for *developing-process* clusters that are 30–49 members and <16h old, or 18–24 members and 8–16h old; prod's process clusters appear to age past 16h before hitting that window. Net: #414's headline mechanism is unproven live (it simply hasn't needed to fire — but also can't be confirmed working).
- **Large *non*-developing-process clusters are never split by either path.** Both the backstop and the prevention gate only consider clusters that `isDevelopingProcessCluster` flags. A genuinely large single-event cluster (e.g. a major breaking story with 37–50+ sources) is left intact by repartition — which is arguably correct, but means the "bound" isn't a hard cap. The historical 55–66-member cards (06-23 15:00–18:00, pre-publish) and the 37–38 recurrence (10:00–12:00 today, pre-publish) fall in this category.
- **Short, OOM-disrupted observation window.** Post-publish data is only ~1.5h, and prod hit a `FATAL ERROR: Reached heap limit / JavaScript heap out of memory` crash loop roughly **13:28–13:51** (recovered and serving by ~14:05). This is the known single-VM heap-OOM issue; it degrades clustering reliability and lowers confidence in the post-publish numbers.

## Recommended next actions (read-only — recommendations only)
- **File:** "Merge curated duplicates sooner (attach on ingest, not next pass)" — directly addresses the user's NK-destroyer example (NBC standalone P82 sitting next to the 15-source cluster P81 that it should have joined). Highest priority; the user explicitly asked for this.
- **File:** "Make the mega-cluster prevention actually engage in production" — the new early gate has 0 activity over 199 passes and large non-process clusters are never split; revisit thresholds / candidacy so the fix demonstrably bites (the task explicitly defers re-tuning to a follow-up).
- **File:** "Add a saved curated-clustering recall check" — a persisted diagnostic so future verification is apples-to-apples instead of ad-hoc (this is exactly why axis 3 came back indeterminate).
- **File:** "Stop the deployed app from running out of memory" — the heap-OOM crash loop degrades clustering and measurement; the known single-VM heap pressure issue.
