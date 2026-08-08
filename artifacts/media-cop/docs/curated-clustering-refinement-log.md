# Curated Clustering Refinement Log

A running, append-only record of every deliberate change to **curated lane**
clustering / refinement behavior, paired with the metric movement it actually
produced. The point is to stop over- and under-correcting by *guessing*: before
touching a knob, read the last few entries; after a change ships, come back and
fill in what the **flight recorder** showed.

## How this works

- **The flight recorder** writes one row per `clusterCuratedLane` pass to the
  `curated_cluster_metrics` table (fail-open — a metrics failure can never break
  a clustering pass). Read recent snapshots via the curated-gated endpoint:

  ```
  GET /api/curated/cluster-metrics?limit=100
  ```

  (Curated-only; never exposed on the public `/api/v1` API.)

- **Tagging a change.** Set the `CURATED_REFINEMENT_TAG` env var to a short
  label (e.g. `2026-06-anchor-veto`) before/at deploy so every row written
  while that change is live carries the tag in `refinement_tag`. That lets you
  filter the recorder to "rows since my change" without guessing by timestamp.
  Leave it unset (NULL) for an untagged baseline.

### What each metric means

Shape of what shipped this pass:

- `formed_stories` — kept multi-source stories after dissolutions/releases.
- `total_members` — total cluster members kept.
- `max_cluster_size` / `median_cluster_size` / `p95_cluster_size` — member-count
  distribution across kept clusters. A climbing `max`/`p95` with flat `median`
  is the classic "one mega-cluster swallowing everything" signature.
- `large_clusters` — clusters with > 20 members (mega-cluster count).
- `developing_process_clusters` — kept clusters classified as a developing
  PROCESS (multi-day deal/negotiation). These are intentionally **exempt** from
  the anchor-split backstop; watch this alongside `anchor_split_developing_skips`.
- `unsynthesized_formed_stories` — stories that formed but had no synthesis yet
  (archive will pick them up next pass). Persistently high = synthesis is
  starving.

Refinement-backstop behavior:

- `false_merge_dissolutions` — clusters dissolved this pass because synthesis /
  corroboration judged them a false merge.
- `anchor_split_audited` — clusters the anchor-split backstop actually examined.
- `anchor_split_released` — members released to standalone cards by the backstop.
- `anchor_split_vetoes` — audits where the backstop declined to release (kept the
  cluster intact). High vetoes vs. low releases = the backstop is being cautious.
- `anchor_split_developing_skips` — clusters HARD-SKIPPED before classify because
  they are developing-process. This must stay > 0 whenever big multi-day stories
  are live; a sudden drop to 0 means the developing-process guard regressed.
- `release_cap_clamps` — passes where a single cluster wanted to release more
  than the per-cluster cap (`ANCHOR_SPLIT_MAX_RELEASES_PER_CLUSTER = 3`) and was
  clamped. Frequent clamps = the backstop is trying to shred a cluster; treat as
  a signal to investigate, not to raise the cap.

Archive churn (from the upsert branch the archive already computes):

- `archive_rows_seen` — distinct formed stories the archive considered.
- `archive_exact_updates` — stories whose signature matched an existing archive
  row exactly (stable membership — healthy).
- `archive_carry_forward_merges` — stories merged forward into a recent prior
  version because membership churned (the signature changed). Climbing
  carry-forwards = membership is thrashing pass-to-pass.
- `archive_inserted` — brand-new archive rows.
- `archive_absorbed_duplicates` — older duplicate archive rows absorbed during a
  carry-forward merge.
- `archive_skipped_unsynthesized` — formed stories not archived this pass because
  synthesis hadn't landed (same population as `unsynthesized_formed_stories`).

### Reading the numbers (rules of thumb)

- **Mega-cluster forming:** `max_cluster_size` / `p95_cluster_size` /
  `large_clusters` climbing while `median_cluster_size` stays flat.
- **Backstop over-correcting (fragmenting):** `anchor_split_released` and
  `release_cap_clamps` up, `formed_stories` down, `archive_carry_forward_merges`
  up (membership thrashing). Back off, don't push harder.
- **Backstop under-correcting:** real distinct events stuck in one cluster while
  `anchor_split_vetoes` is high and `anchor_split_released` ~0.
- **Developing-process regression:** `anchor_split_developing_skips` drops to 0
  while big multi-day stories are live — the developing-process guard broke.
- **Churn / instability:** `archive_carry_forward_merges` and `archive_inserted`
  high relative to `archive_exact_updates`.

## Entry template

Copy this block for every change. Fill the "Observed" fields in *after* the
change has run for enough passes to read the recorder.

```
### YYYY-MM-DD — <short title>  (tag: <CURATED_REFINEMENT_TAG or "—">)

- **Observed problem:** what looked wrong in the feed / metrics.
- **Hypothesis:** why it was happening.
- **Knobs touched:** files + constants/flags changed (e.g.
  ANCHOR_SPLIT_MAX_RELEASES_PER_CLUSTER, developing-process skip).
- **Expected metric movement:** which columns should move and which way.
- **Observed metric movement:** what the recorder actually showed (cite columns
  + before/after, and the tag you filtered on).
- **Archive effect:** carry-forward / insert / absorbed change.
- **Decision:** keep / revert / tune further (and the next thing to watch).
```

## Entries

### 2026-06-23 — Baseline + anchor-split hardening  (tag: —)

- **Observed problem:** the anchor-split backstop could fragment a legitimate
  developing-PROCESS mega-cluster (e.g. a multi-day US–Iran track or the
  Starmer storyline), splitting one real running story into scattered standalone
  cards. There was also no durable record of clustering behavior over time, so
  each tuning attempt was a guess that risked over- or under-correcting.
- **Hypothesis:** without a deterministic guard, the backstop occasionally
  released members out of a developing-process cluster (which legitimately spans
  many sub-events) and treated normal multi-day evolution as a false merge.
- **Knobs touched:**
  - `server/curatedCluster.ts` — `anchorAwareSplitFormedStories` now HARD-SKIPS
    any candidate where `isDevelopingProcessCluster(titles)` is true *before*
    `classifyAnchorEventMembers` (counted as `developingProcessSkips`), and
    clamps releases per cluster to `ANCHOR_SPLIT_MAX_RELEASES_PER_CLUSTER = 3`
    (counted as `releaseCapClamps`). Fail-open preserved; the backstop still
    can never dissolve a cluster.
  - Added the flight recorder: `curated_cluster_metrics` table
    (`shared/schema.ts`, `server/migrate.ts`), storage
    (`recordCuratedClusterMetrics` / `getCuratedClusterMetrics`), a per-pass
    write at the end of `clusterCuratedLane` (fail-open), and the read-only
    `GET /api/curated/cluster-metrics` endpoint.
- **Expected metric movement:** `anchor_split_developing_skips` > 0 whenever a
  developing-process story is live; `release_cap_clamps` rare and only when a
  cluster genuinely tries to shed many members; `large_clusters` for real
  developing-process stories should stay intact rather than dropping to 0.
- **Observed metric movement (first live pass, 2026-06-23 12:10 UTC, tag —):**
  `formed_stories=9`, `total_members=41`, `max_cluster_size=16`,
  `median_cluster_size=3`, `p95_cluster_size=16`, `large_clusters=0`,
  `developing_process_clusters=2`. Anchor-split backstop: `anchor_split_audited=5`,
  `anchor_split_developing_skips=2` (the two developing-process clusters were
  HARD-SKIPPED before classify — guard working), `anchor_split_released=1`,
  `anchor_split_vetoes=0`, `release_cap_clamps=0` (no cluster tried to shed >3).
  `false_merge_dissolutions=2`. The distribution is healthy: `median` 3 with
  `max`/`p95` 16 and `large_clusters=0` — no runaway mega-cluster, and the two
  multi-day stories stayed intact rather than being fragmented.
- **Archive effect:** clean — `archive_rows_seen=9`, `archive_exact_updates=6`,
  `archive_carry_forward_merges=3`, `archive_inserted=0`,
  `archive_absorbed_duplicates=1`, `archive_skipped_unsynthesized=0`. Mostly
  exact updates with a few carry-forwards (expected on a first pass after the
  change); no thrashing.
- **Decision:** shipped as the new baseline. Next: watch that
  `anchor_split_developing_skips` tracks live developing-process stories and that
  `release_cap_clamps` stays low; if releases/clamps spike with `formed_stories`
  falling, the backstop is over-correcting — back off rather than push harder.

### 2026-06-23 — Smart process re-partition (option B)  (tag: —)

- **Observed problem:** the anchor-split hardening above correctly stops a
  developing-PROCESS mega-cluster from being *fragmented* into scattered
  standalone cards — but it does so by leaving the whole story as ONE giant card.
  Over days a long-running track (e.g. a multi-week US–Iran negotiation) accretes
  several genuinely distinct CURRENT sub-threads (inspections vs. a sanctions
  vote vs. a leader statement). Presenting them as a single card buries the
  sub-stories; the user wants them as a small set of *coexisting* sub-stories,
  each with its own synthesis / lifecycle / archive row — without ever dropping a
  member or letting the pieces silently re-merge.
- **Hypothesis:** a developing-process cluster that is *large or old enough* can
  be split into its distinct current sub-threads by a one-shot AI pass, PROVIDED
  the verdict is durable (the curated cluster table is rebuilt every pass, so a
  re-decided split would be non-deterministic and thrash) and the archive treats
  the siblings as distinct lineages (so it never carry-forward-merges them back
  into one story).
- **Knobs touched:**
  - New `server/curatedRepartition.ts` — the pure, deterministic core:
    `applySplitOverlays` (routes each live node to its child by persisted member
    token, an unknown token to the best child by title/anchor overlap, and an
    ambiguous unknown to the residual PARENT — never drops a member), plus the
    gated `evaluateProcessRepartition` (size/age gate, 2h cooldown,
    material-change gate, balance caps, fail-closed) and helpers.
  - New overlay table `curated_process_split_overlays` (`shared/schema.ts`,
    `server/migrate.ts`, storage `getActiveCuratedSplitOverlays` /
    `upsertCuratedSplitOverlay`) — persists the AI verdict as a per-child
    member-token set so the split is STABLE across passes. UUID id doubles as the
    lineage parent key; child lineage = `<id>:<childKey>`.
  - `server/curatedCluster.ts` — after `reconciledGroups`, loads active overlays,
    gates candidates by `REPARTITION_MIN_CANDIDATE_SIZE` (25) AND
    `isDevelopingProcessCluster`, evaluates at most
    `MAX_REPARTITION_AI_EVALS_PER_PASS` (2) per pass via
    `createCuratedClusterCompletion` (gpt-4o, json_object) + loose JSON parse,
    persists the overlay, then `applySplitOverlays` → split groups. Every failure
    path (gate miss / cooldown / AI error / unparseable / cap failure) falls back
    to the reconciled identity. `PendingStory.splitLineageKey` threads each
    child's lineage into Phase B and into `archiveFormedStories` →
    `upsertCuratedStoryArchive` so siblings archive as distinct stories.
  - Flight recorder extended: 7 `smartRepartition*` integer columns on
    `curated_cluster_metrics` (`shared/schema.ts`, `server/migrate.ts`, write
    site, curated-gated endpoint) — candidates / evals / splits / children /
    intact / cooldown-skips / failures per pass.
- **Balance contract:** at most `MAX_CHILDREN` (5) children; each child must have
  `>= 2` corroborating distinct publishers or the whole verdict is treated as
  leave-intact; "leave intact" is allowed and recorded (status `intact`) so the
  cooldown suppresses re-asking. No data loss: the union of children + residual
  parent always equals the input cluster.
- **Expected metric movement:** `smart_repartition_candidates` > 0 only when a
  developing-process cluster reaches size 25 (or 50 outright);
  `smart_repartition_ai_evals` capped at 2/pass; `smart_repartition_splits`
  rare and only on genuinely multi-threaded mega-stories;
  `smart_repartition_failures` should stay ~0 (a non-zero count is fail-closed —
  the cluster stayed intact, nothing dropped).
- **Observed behavior (isolation-harness pass, 2026-06-23):** the live pass
  produced `max_cluster_size=16` (< the size-25 gate floor), so NO cluster
  qualified for a re-partition eval — the feature correctly stayed a no-op
  (`below_gate`), the clustering pass completed normally (`9 total stories`,
  developing-process clusters detected and left intact by anchor-split), and the
  full `curated-isolation` harness reported **all isolation guarantees hold**
  with my code in the path. The split path itself is pinned by the deterministic
  regression suite below rather than by a live mega-cluster (which only appears at
  production volume).
- **Tests:** `scripts/curated-process-repartition.test.ts` (41 checks, no
  network/DB/AI — model + persist injected): deterministic application across
  reordered inputs, no member loss, new-member routing (known/unknown/ambiguous),
  size/age gate, cooldown + material-change, AI-failure fail-closed (null /
  throw / unparseable → intact, persists nothing), balance caps (< 2 corroborated
  children → leave intact), and distinct sibling lineage keys (archive
  non-merge). All curated suites + the isolation harness re-run green.
- **Decision:** shipped behind a conservative gate (size 50, or age 16h + size
  25; AI budget 2/pass). Next: once a real developing-process cluster crosses the
  gate in production, read `smart_repartition_*` — if `splits` fire on stories
  that should stay whole, raise the gate or tighten the prompt rather than
  loosening the caps; if `failures` climb, it is fail-closed (no data loss) but
  the model/parse needs attention.

### 2026-06-24 — Mega-cluster prevention: make it kick in + scope decision (Task #440)

- **Observed problem (from #423 verify):** #414's EARLY-prevention split gate had
  fired 0 times across the first 199 recorded passes (06-23 15:07 -> 06-24 14:03).
  The over-large cards were held down only by the legacy >=50 backstop + fresh
  overlay re-evaluation, so #414's headline mechanism was unproven live. Two gaps:
  (1) the early gate only caught process clusters at 30-49 members <16h old, or
  18-24 members 8-16h old — but prod process stories age PAST 16h while still at a
  modest 15-17 members, falling between the early floor and the backstop; (2) BOTH
  paths only consider `isDevelopingProcessCluster` clusters, so a large NON-process
  single-event card is split by neither.
- **Gap #1 fix (process clusters) — shipped:** added an aged-process recall branch
  to `passesRepartitionGate` (`SPLIT_PROCESS_OLD_AGE_H=16`,
  `SPLIT_PROCESS_OLD_AGE_SIZE_FLOOR=15`) and lowered the caller candidate floor
  `REPARTITION_PROCESS_MIN_CANDIDATE_SIZE` 18 -> 15 so a developing-process cluster
  that aged past 16h at 15-17 members ENTERS the loop and reaches the model before
  it balloons. Process-only, fail-closed, still guarded by the AI `leave_intact`
  verdict + the >=2-publishers-per-child cap. Pinned by new checks in
  `scripts/curated-process-repartition.test.ts`.
- **Gap #2 (non-process clusters) — evidence-backed decision: LEAVE INTACT.** The
  largest live non-process cluster during the window was **21 members / 15
  publishers, all the SAME single event** ("IAEA inspectors will visit Iran's
  nuclear sites": ABC, NPR, BBC, AP, DW, TASS, …). Collapsing 21 outlets into ONE
  card is exactly the product goal — a dense common-operating-picture, not 21
  dupes. The historical 40-66-member cards were likewise single mega-events
  (initial Iran strike / ceasefire coverage). Splitting them would FRAGMENT one
  story into near-duplicate cards (a recall regression), so non-process clusters
  are intentionally never sent to the repartition model. The bound against a
  genuine FALSE-merge is delivered the OTHER way — `anchorAwareSplitFormedStories`
  releases off-anchor members (anchor_split_released ~121 over 36h) + the
  false-merge dissolution path — neither of which fragments a real single story.
- **Before/after readout (flight recorder, prod, 243 passes 06-23 15:07 ->
  06-24 18:52):**
  - **Prevention is now PROVEN live:** `prevention_repartition_triggered` = 3
    (first at 06-24 14:07, immediately after the #423 14:03 cutoff), from 13
    prevention-bucket audits — up from the 0 in #423. Total
    `smart_repartition_triggered` = 18 (backstop 15 + prevention 3).
  - **Which path split:** backstop (>=50 / old+large) did the bulk (15 splits);
    early prevention did 3; the anchor-split backstop released 121 members
    (the dominant control on non-process / false-merge breadth).
  - **Cluster size:** BEFORE the prevention deploy (06-23 ~15:00-19:00, Iran
    strike breaking) max/p95 ran 40-66. AFTER it deployed (~06-24 14:00+) max/p95
    settled to mostly 16-23 with only rare single-event spikes to 40-41 that were
    evaluated and correctly left intact. 36h avg max = 32, avg p95 = 31, avg
    median = 7 (median small; the top card is large only because the biggest news
    event draws heavy single-event coverage — by design).
- **Knobs touched:** `server/curatedRepartition.ts` (aged-process gate branch),
  `server/curatedCluster.ts` (candidate floor 18->15; gap-#2 decision documented
  inline with the IAEA evidence). Curated-lane only; fail-closed; no recall
  regression (non-process consolidation preserved on purpose).
- **Decision / next:** prevention firing > 0 satisfies the proof bar; the recall
  branch widens WHICH process clusters get looked at without storming the AI
  budget (largest-first + prevention budget 1/pass means a calm pass spends its
  single eval on the aged modest cluster, a busy pass on the bigger one). If
  `prevention_repartition_triggered` ever splits a story that should stay whole,
  raise the recall floors / tighten the prompt rather than loosening caps. Do NOT
  extend repartition to non-process clusters — that re-opens the IAEA-style
  fragmentation this entry rules out.

### 2026-06-30 — Confirm aged-process recall split is live after publish (Task #448)

- **What this verifies:** #440 added the aged-process *recall* branch in
  `passesRepartitionGate` (`SPLIT_PROCESS_OLD_AGE_H=16`,
  `SPLIT_PROCESS_OLD_AGE_SIZE_FLOOR=15`) plus the candidate floor
  `REPARTITION_PROCESS_MIN_CANDIDATE_SIZE` 18 → 15, so a developing-process
  cluster that ages past 16h while still modest (15–17 members) ENTERS the loop
  instead of falling between the 18-member early floor and the 50-member
  backstop. This entry is the post-publish readout confirming that wider band
  actually fires in production — and that it does NOT shred stories that should
  stay whole.
- **Deployed code confirmed:** `server/curatedRepartition.ts` carries the recall
  branch (16h / 15-member floor) and `server/curatedCluster.ts` the candidate
  floor 15; a fresh app restart is present in the deployment logs on 06-30.
- **Flight-recorder readout (prod, `curated_cluster_metrics`, 1498 passes
  2026-06-23 15:07 → 2026-06-30 17:07):**
  - `prevention_repartition_triggered` SUM = **58** (up from the **3** that #440's
    proof captured), `prevention_repartition_audited` = 949,
    `prevention_repartition_children_created` = 142. Per-day prev_triggered:
    06-24=6, 06-25=23, 06-26=16, 06-27=0 (only 20 passes — restart gap), 06-28=5,
    06-29=4, 06-30=4. It keeps climbing across deploys — the path is alive, not a
    one-off.
  - `smart_repartition_triggered` SUM = 101 (backstop + prevention);
    `smart_repartition_failed` SUM = **2 total, 0 since 06-25** — fail-closed and
    healthy (a non-zero failure leaves the cluster intact, drops nothing).
- **Splits land on genuinely multi-threaded process stories (overlay audit,
  `curated_process_split_overlays`):**
  - The recall band is firing: ACTIVE `trigger_reason='age'` overlays span
    member counts 15–39 (24 of them), and the modest 15–17-member band split into
    2–4 children repeatedly, including AFTER the 06-30 restart — e.g. 17 members →
    3 children (06-30 09:14) and 15 members → 2 children (06-30 04:59). Each child
    carries the ≥2-distinct-publisher balance requirement, so an active split is a
    genuinely multi-publisher, multi-thread story, not a single event.
  - **No over-splitting of whole stories:** the model declined to split where it
    should — 11 aged overlays in the 15–26-member band are recorded `intact`
    (status='intact', age trigger), and the 118-member single mega-event seen on
    06-28 (`max_cluster_size=118`) was evaluated `intact, size` and LEFT WHOLE,
    exactly the IAEA-style consolidation #440 rules must protect.
- **Decision:** the wider aged-process recall path is **proven live and behaving
  conservatively** — it splits modest aged multi-thread process clusters into
  their sub-stories while leaving single events and stories the model judges
  cohesive intact. No knob change: the recall floors
  (`SPLIT_PROCESS_OLD_AGE_H`/`SPLIT_PROCESS_OLD_AGE_SIZE_FLOOR`) and the candidate
  floor stay as shipped. Next watch: if a future `prevention_repartition_triggered`
  bump coincides with a real single event appearing as fragmented sibling cards,
  raise the recall floors / tighten the prompt rather than loosening caps.

### 2026-07-15 — Kinetic-dominant veto + per-member rolling-window decay  (tag: —)

- **Observed problem:** a long-running US–Iran war card (67+ sources, first seen
  Jul 13) accumulated ALL coverage since day 0 instead of tracking the current
  situation (Jul 15 naval blockade + IRGC counter-strikes). Three root causes:
  (1) carry-over re-injects ALL prior cluster members wholesale, so the Jul 13
  strike reporting stays forever as long as fresh coverage keeps the cluster alive;
  (2) the cluster was mis-classified as `developing-process` because a handful of
  its headlines mentioned "ceasefire/deal" negotiations happening alongside the
  kinetic events — this granted it the 48h phase-out ceiling AND the anchor-split
  hard-skip, neither of which is appropriate for a war story; (3) the only closure
  wall was the 60h episode cap, which just rolls cluster identity without shedding
  old coverage.
- **Hypothesis:** (a) a kinetic-dominant cluster (strikes / attacks / blockade /
  interceptions) must not inherit the developing-process exemptions just because a
  few of its titles incidentally mention ceasefire/deal — the exemption exists for
  diplomatic PROCESSES, not wars; (b) per-member rolling-window decay in carry-over
  would shed members whose coverage is genuinely expired relative to NOW, making the
  live card reflect the current situation rather than day-0 reporting.
- **Knobs touched:**
  - `server/curatedStaleness.ts` — added `KINETIC_TERM_RE` (high-confidence
    kinetic vocabulary: strikes, attack, missiles, rockets, intercept, blockade,
    airstrikes, bombardment, shelling, etc.) and `isKineticDominantCluster(titles)`
    (exported): returns true when kinetic titles ≥ 3 AND kinetic ≥ 2× process
    titles; this threshold keeps a real diplomatic-process cluster that incidentally
    references a few "strike-halted" headlines from being wrongly stripped of its
    extension. Modified `isDevelopingProcessCluster()`: prepends a
    `isKineticDominantCluster()` veto — returns false immediately if the cluster is
    kinetic-dominant, even when process vocab ≥ 2 titles.
  - `server/curatedCluster.ts` — added `CARRY_MEMBER_ROLL_WINDOW_H = 24` and
    `CARRY_MEMBER_PROCESS_ROLL_WINDOW_H = 48` constants. In the carry-over loop,
    captured the `clusterIsProcess` flag once (reused for phase-out gate and decay
    window). Added per-member rolling-window decay gate in the inner carry-over
    `for (const m of mem)` loop: members whose `publishedAt < now - rollWindowMs`
    are skipped (decay off). Members without `publishedAt` are always retained.
    `memberDecayCutoffMs` is null when the cluster has no dated members — gate is
    then a no-op (all-or-nothing phase-out handles that cluster). Also imported
    `isKineticDominantCluster` (unused directly in the main loop, available for
    future use); the kinetic veto flows entirely through the modified
    `isDevelopingProcessCluster`.
  - **Downstream effect on anchor-split:** with `isDevelopingProcessCluster`
    returning `false` for kinetic-dominant clusters, the anchor-split
    `developingProcessSkips` hard-skip is no longer triggered for them — kinetic
    clusters are now auditable by the event-identity classifier, allowing genuinely
    new developments (naval blockade, IRGC counter-strikes) to fork out from an
    older-anchor card. The oversized escape hatch is unchanged and still applies.
  - **Downstream effect on re-partition:** re-partition is `isDevelopingProcessCluster`
    gated — kinetic clusters were never re-partition candidates, and they remain so.
    No change needed.
- **Expected metric movement:** `anchor_split_developing_skips` should DROP for
  kinetic mega-stories (they are no longer hard-skipped); `anchor_split_audited`
  may rise on active-war passes. Carry-over member counts for kinetic clusters
  should fall (old coverage shed); archive `carry_forward_merges` may rise slightly
  as the signature changes when old members decay off. No formation regression
  expected — the live window (24h ingest) supplies fresh corroborating members; the
  decay only removes the aged-out tail.
- **Observed metric movement:** pending first live pass post-deploy.
- **Archive effect:** pending; expect `archive_carry_forward_merges` to tick up on
  first pass for the US-Iran cluster (signature changes) then stabilize at exact
  updates once the membership settles to the current-situation window.
- **Decision:** shipped. Regression suite (62 gates) passes. Next: watch that
  `anchor_split_developing_skips` still fires for genuine diplomatic-process
  stories (e.g. Iran nuclear deal track) and that kinetic clusters do NOT zombie
  past their natural phase-out window. If `anchor_split_audited` spikes on a
  kinetic story that should stay whole (single event, 35 sources), check that the
  classifier correctly returns `same_event_attach` for the bulk — the formation
  gate veto ensures the kept set never drops below the corroboration floor.

### 2026-07-16 — Multi-crisis megacluster hardening: eviction overlay + money de-bridge + disjoint-actor classifier hint  (tag: —)

- **Observed problem:** on a busy multi-crisis day the prod curated US–Iran "Military
  Ops" card grew to **162 members** and had silently absorbed genuinely UNRELATED
  events — a Taiwan TSMC $100bn chip-fab investment, Black-Sea oil-tanker attacks,
  and Russia drone strikes on Ukraine. The anchor-split event-identity classifier
  released ~0: the foreign members share surface vocabulary ("strike", "deal",
  "$100 billion", region words) with the anchor, so the same-event-biased LLM saw a
  coherent-looking cluster. There was also no editor tool to manually evict a member
  once a bad merge landed in the live feed.
- **Hypothesis:** the over-merge is a *recall-side* precision failure with three
  independent contributing vectors, each fixable without weakening the formation
  gate: (D) a large dollar figure tokenizes into `{100, billion}` — two shared
  distinctive tokens — so two unrelated money stories clear the ≥2-shared-token
  recall bar and weld together; (B/C) even after de-bridging, the LLM anchor-split
  classifier needs a deterministic nudge to overcome its same-event bias when a
  member's named actors lie entirely outside the cluster's real actor core; and the
  metering only counted oversized *process* audits, hiding oversized non-process
  audits from the flight recorder. An editor eviction overlay is the human backstop
  for whatever the automated levers miss.
- **Knobs touched:**
  - **Lever D — money de-bridge (`server/curatedCluster.ts`):** added
    `canonicalizeMoneyFigures`, run inside `significantTitleTokens`. A money figure
    now collapses to a SINGLE token, and OUTSIDE a defense-spending context is
    removed entirely — so a bare dollar amount can never be the SECOND shared token
    the ≥2 bar needs. In a defense-spending context it fuses to one shared
    `moneyfigure` token, so two reports of the SAME budget/procurement/arms deal
    still corroborate (mirror of the casualty/displacement single-token passes; the
    intent here is PRECISION, not recall). Gate:
    `scripts/curated-money-debridge.test.ts` (16 checks, pure/deterministic),
    registered in the `run-gates.ts` manifest as `curated-money-debridge`.
  - **Levers B+C — disjoint-actor classifier hint (`server/curatedCluster.ts`):**
    added exported pure helpers — `ANCHOR_ACTOR_VOCAB` (22 actor→alias-regex
    entries), `extractActorTokens(title)`, `computeDominantActors(titles)`
    (dominance threshold `max(2, ceil(0.1 * n))`), `memberHasDisjointActors(title,
    core)`, and `buildAnchorClassifierMemberLines(members, oversized)`. For an
    OVERSIZED cluster only, `buildAnchorClassifierMemberLines` tags any member whose
    named actors are ALL outside the dominant core with `[DIFFERENT CORE ACTORS:
    ...]` and returns `{list, dominant, hintedCount}`. `classifyAnchorEventMembers`
    now builds its MEMBERS block through this helper and, when
    `dominant.length > 0 && hintedCount > 0`, appends an "ACTOR SIGNAL" line to the
    oversized OVERRIDE block naming the core and telling the LLM the tagged members
    are strong `different_event_split` candidates. **The LLM stays the sole
    decider** — the tag only counters its same-event bias; a member with no
    recognized actor or any shared core actor is never tagged, so a missed match can
    only WITHHOLD a nudge, never force a split (precision-first, fail toward keep).
    Gate: `scripts/curated-classifier-actor-hint.test.ts` (22 checks,
    pure/deterministic), registered as `curated-classifier-actor-hint`.
  - **Oversized metering decouple (`server/curatedCluster.ts`):** `oversizedEscapes++`
    now fires for EVERY oversized audit (process AND non-process), with
    branch-specific log lines, instead of only counting the process clusters whose
    developing-process hard-skip was lifted. The `isProcess && !oversized` hard-skip
    is unchanged. `curated_cluster_metrics` now reflects the true oversized audit
    load.
  - **Editor eviction overlay (T001 — `shared/schema.ts` `curatedManualEvictions`,
    `server/migrate.ts`, `server/storage.ts`, `server/routes.ts` evict/un-evict
    endpoints, `server/curatedIncrementalAttach.ts`, `client/src/pages/Curated.tsx`
    `EvictMemberControl`):** a curated-editor-gated, audit-logged overlay that pins a
    member OUT of a cluster (CORRECT/SPLIT eviction) and re-excludes it on every
    subsequent pass, so a human correction survives the wipe-and-rebuild. Curated-only,
    fail-closed; never leaks to main/Classic/Visual/custom-MCOP/public API.
- **Guardrails preserved (unchanged):** `MIN_CONTRIBUTING_TO_FORM = 2`
  (≥2-corroborating / ≥2-distinct-publisher formation gate);
  `ANCHOR_SPLIT_OVERSIZED_MAX_RELEASES` veto / 40-cap; fail-open on AI/DB errors
  (a null classifier result keeps the cluster intact); the developing-process
  `isProcess && !oversized` hard-skip.
- **Expected metric movement:** on a genuine multi-crisis pass, `anchor_split_released`
  should rise for the megacluster (foreign events fork out) while `formed_stories`
  stays healthy (the released members form their own cards or stand alone);
  `max_cluster_size` / `p95_cluster_size` should fall for the mega-story;
  `oversizedEscapes` should now be ≥ its old value (non-process oversized audits are
  counted too). No formation regression — the de-bridge only removes a *bridging*
  token, and the actor hint only fires on oversized clusters and only withholds or
  nudges, never forces.
- **Observed metric movement:** pending first live multi-crisis pass post-deploy.
- **Archive effect:** pending; expect a one-time `carry_forward_merges` tick as the
  megacluster signature changes when foreign members fork off, then stabilize.
- **Decision:** shipped. All curated gates pass via the manifest runner
  (`curated-money-debridge` + `curated-classifier-actor-hint` both green) and
  `npm run build` is clean (the T001 `Curated.tsx` eviction UI builds under the
  eager transform). Next: after the next real multi-crisis day, read
  `anchor_split_released` / `max_cluster_size` for the US–Iran lineage and confirm
  the foreign events (Taiwan chips, tanker attacks, Russia drones) surfaced as their
  own cards; if the classifier still under-releases despite tags, the ACTOR SIGNAL
  wording (not the deterministic tag) is the next knob — do NOT lower the formation
  gate or the release cap.

## Anchor-split oversized release resilience (mega-cluster escape under AI degradation)

- **Symptom (user report + prod logs):** a persistent oversized US–Iran cluster
  (`2eb9ce35…`, ~65–72 members / ~220 clustered) kept absorbing genuinely
  different events and never split. Every pass logged
  `Anchor-split: re-synthesis unavailable for story …; release of N member(s) SKIPPED (left intact)`.
  Root cause: `resolveAnchorSplitCommit` is strictly FAIL-OPEN — it commits ZERO
  releases unless the KEPT cluster was successfully re-synthesized+persisted. During
  an AI-provider stall (see prod OpenRouter/Anthropic 60–75s timeout storm) synthesis
  returns null every pass, so the classifier-approved releases could never commit and
  the mega-cluster grew unbounded off unrelated info.
- **Fix:** oversized exception in `resolveAnchorSplitCommit` — when `oversized` is
  true AND re-synthesis was unavailable, STILL commit the classifier-approved
  releases (do NOT touch the dissolved verdict, since there is no fresh corroboration
  read). Normal-size clusters keep the strict fail-open. Rationale: a huge kept set
  trivially satisfies the formation gate, and the stale synthesis (built over a
  slightly larger set) is negligibly different and self-heals next pass (its
  `contentHash` no longer matches the shrunken member set → forced re-synthesis).
- **Scope guardrails preserved:** release cap (`ANCHOR_SPLIT_OVERSIZED_MAX_RELEASES`),
  the formation-gate veto in `applyAnchorEventSplitDecisions`, the developing-process
  hard-skip (only lifted for oversized), and the disjoint-actor hint are all unchanged.
  The false-merge dissolution path is untouched (dissolved verdict never flips in the
  degraded release).
- **Tests:** `scripts/curated-anchor-split.test.ts` gains (h2) oversized+resynth-failed
  → released anyway/no dissolved delta, and (h3) oversized+empty → no-op. Full
  `curated-anchor-split` gate green; `npm run build` clean.
- **Expected metric movement:** during an AI stall, `anchor_split_released` /
  `oversizedReleased` should now be > 0 for the mega-cluster (previously pinned at 0
  with repeated SKIPPED warnings), and `max_cluster_size` / `p95_cluster_size` for the
  US–Iran lineage should fall pass-over-pass instead of ratcheting up.
- **Observed metric movement:** pending first live oversized pass post-deploy.
- **Decision:** shipped.
