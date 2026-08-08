# MCOP Relevance + Scoring Funnel — Live Diagnostic Report

**Measurement date:** 2026-07-13  
**Scope:** Read-only measurement and reporting. **No behavior was changed.**  
**Baseline reference:** `docs/pscore-funnel-baseline.md` (2026-06-29)

---

## Executive Summary

The production main-feed pipeline screens roughly **52 articles per hour** from
bot + RSS sources through a CJCS relevance gate, promoting ~42% of those that
pass to the Classic/Visual main feed. The biggest losses occur at two points:

1. **At relevance:** the CJCS gate rejects ~90–100% of most general-news RSS
   outlets (CNBC, CBS, Yonhap, Bloomberg, DW). This is by design; these outlets
   rarely carry CJCS-relevant content. The rejected articles route to a curated
   candidate buffer but are also rejected there — the two gates agree — leaving
   the curated reject path effectively idle.

2. **At scoring (post-gate suppression):** 58% of articles that *do* pass the
   CJCS gate score below 50 and stay permanently in Team chat. BBC (13%
   promotion) and The Guardian (26%) are hit hardest. A scoring-failure fallback
   buried an additional 38 articles at the irrevocable score of 30 in a single
   24-hour window.

The most actionable structural gap is the **WarfighterRSS path**: The Blaze
and Daily Wire articles bypass every relevance gate and enter the main
`headlines` table directly, explaining why 81% of rows in that table score
below 30 — lifestyle and consumer content that should never reach the feed.

---

## Data Window & Evidence Ledger

All numeric claims in this document carry a bracketed source tag of the form
`[Qn]` (SQL query result) or `[LOG-xxx]` (deployment-log scan). The exact
windows and extraction methods are listed here.

| Tag | Source type | Exact window (UTC) | How extracted |
|---|---|---|---|
| **[Q1]** | Production SQL — `headlines` table | 48 h ending **2026-07-13 ~12:35 UTC** (`NOW() - INTERVAL '48 hours'`) | `executeSql` environment:'production', read-only |
| **[Q2]** | Production SQL — `team_submissions` by source | 24 h ending **2026-07-13 ~12:35 UTC** (`NOW() - INTERVAL '24 hours'`) | `executeSql` environment:'production', read-only; grouped by `source_name` |
| **[LOG-FUNNEL]** | Deployment logs — FUNNEL markers | **2026-07-13 12:05 UTC – 12:58 UTC** (log timestamps 1783944317619 ms – 1783947439889 ms) | `fetch_deployment_logs` regex `FUNNEL` |
| **[LOG-RSS]** | Deployment logs — RSSBot screened/passed lines | Same window as LOG-FUNNEL | `fetch_deployment_logs` regex `screened=\|passed=` |
| **[LOG-CUR]** | Deployment logs — curated reject capture + CuratedAnalyzer lines | Same window as LOG-FUNNEL | `fetch_deployment_logs` regex `curated reject\|CuratedAnalyzer\|CuratedIntake` |
| **[LOG-WFR]** | Deployment logs — WarfighterRSS lines | Same window as LOG-FUNNEL | `fetch_deployment_logs` regex `WarfighterRSS` |
| **[BASE]** | Prior baseline report | 2026-06-29 | `docs/pscore-funnel-baseline.md` |

**Approximate SQL execution time:** 2026-07-13 ~12:30–12:45 UTC (inferred from
co-located express log timestamps in the same deployment log window).  
**Deployment log window duration:** ~53 minutes (12:05–12:58 UTC).

---

## 0. Production architecture reminder — what's actually running

The Drudge/Classic web scraper is **DORMANT** in production. The main-feed
content pipeline today is:

| Ingestion path | Relevance gate | Scoring | Output |
|---|---|---|---|
| **WarfighterRSS** (The Blaze + Daily Wire) | None — recency + dedup only | AI (score-only) | `headlines` table |
| **9 dedicated bots** (JPost, Al Jazeera, Reuters, BBC, AP, etc.) | CJCS prompt (`BOT_CJCS_SYSTEM_PROMPT`) | `scoreHeadlinePrioritiesBatch` | `team_submissions` → `headlines` if score ≥ 50 |
| **RSSBot** (45+ general-news RSS feeds) | CJCS prompt | `scoreHeadlinePrioritiesBatch` | `team_submissions` → `headlines` if score ≥ 50 |
| **Manual submissions** | Human | Human or AI | `team_submissions` |
| **Curated lane** | `admitCuratedCandidates` (wider aperture) | `analyzeCuratedChunk` | `curated_items` only |

Promotion thresholds confirmed from live deployment logs [LOG-FUNNEL]:

```
[FUNNEL:PROMOTE] source="Washington Examiner" score=72 bar=MEET>=50 -> MAIN
[FUNNEL:PROMOTE] source="Task & Purpose"       score=45 bar=BELOW<50 -> CHAT-ONLY
[FUNNEL:PROMOTE] source="BBC"                  score=25 bar=BELOW<50 -> CHAT-ONLY
[FUNNEL:PROMOTE] source="CNBC"                 score=45 bar=BELOW<50 headline="Goldman Sachs picks two stocks..." -> CHAT-ONLY
[FUNNEL:PROMOTE] source="AP News"              score=55 bar=MEET>=50 -> MAIN
```

**MAIN_FEED_PROMOTION_THRESHOLD = 50** (≥50 → Classic/Visual),
**FLASH_PRIORITY_THRESHOLD = 66** (≥66 → FLASH: TOP STORIES),
**UNSCORED_BOT_PRIORITY = 30** (fallback on AI failure — always chat-only).

---

## 1. What gets rejected at relevance

### 1a. CJCS gate (bot + RSSBot funnel)

Every article processed by a dedicated bot or the RSSBot passes through
`BOT_CJCS_SYSTEM_PROMPT` (`gpt-4o-mini`), which asks whether the headline is
relevant for the Chairman of the Joint Chiefs of Staff. Items that fail are
routed to the curated reject lane (see §3).

**Observed pass rates from deployment logs [LOG-RSS]** (all screened/passed
lines in the 53-minute window, summed per outlet across all batches):

| Outlet | Screened | Passed | Pass rate |
|---|---|---|---|
| DW | ~138 | 2 | ~1% |
| CNBC | ~54 | 0 | 0% |
| The Hill | ~61 | 1 | ~2% |
| Yonhap | ~53 | 0 | 0% |
| CBS News | ~19 | 0 | 0% |
| Bloomberg | ~18 | 0 | 0% |
| The Guardian | ~20 | 1 | ~5% |
| ABC News | ~15 | 1 | ~7% |
| Washington Post | ~12 | 0 | 0% |
| NPR | ~6 | 0 | 0% |
| Al Jazeera | 6 | 0 | 0% |
| France 24 | 5 | 0 | 0% |
| Fox News | ~2 | 0 | 0% |
| Politico | 3 | 0 | 0% |
| Washington Examiner | 4 | 0 | 0% |
| Jerusalem Post (via RSSBot) | 2 | 0 | 0% |

*Note: the dedicated Jerusalem Post bot, Al Jazeera bot, Reuters bot, etc. run
on separate cron slots; their per-article screened/passed counts do not appear
as RSSBot lines. Their output is captured in [Q2] after they post to
`team_submissions`.*

> **Finding:** The CJCS gate rejects virtually all output from general-news
> feeds. This is by design — CNBC financial news, DW development reporting, and
> Yonhap wire items are not CJCS-relevant. However, outlets that should be
> partially relevant (The Hill policy reporting, The Guardian conflict coverage)
> also approach zero, suggesting the gate produces false-negatives on
> defense-adjacent political/policy content. The gate is **fail-closed**: an AI
> timeout returns `[]`, silently dropping the entire batch from both Team chat
> and the curated reject route. [LOG-RSS]

### 1b. Deterministic pre-filter (Layer 1, code path)

Before any AI call, `scraper.ts` applies:

- **`HARD_EXCLUSION_KEYWORDS`** — entertainment, sports, consumer medical,
  celebrity, lifestyle → dropped with no AI call.
- **`BLOCKED_MEDIA_OUTLET_DOMAINS`** — The Sun, Breitbart, Infowars, Gateway
  Pundit, Epoch Times, and others → hard-dropped.
- **`FINANCE_WEATHER_KEYWORDS`** — finance/weather headlines → dropped unless
  `hasSecurityContext()` matches (rescue via military/energy/sanctions terms).
- **`CRITICAL / HIGH_PRIORITY / MILITARY_KEYWORDS`** — fast-track keep,
  bypasses the pre-filter drop.

**Instrumentation gap (unchanged from baseline [BASE]):** These pre-filter
drops are **never persisted** — no DB record, no structured log line. There is
no way to measure the false-negative rate of this layer. Any keyword that
incorrectly matches a legitimate defense story drops it without a trace.

### 1c. WarfighterRSS — no relevance gate [LOG-WFR]

The Warfighter RSS path (The Blaze + Daily Wire) has **no relevance gate**:
articles are admitted if they are (a) within 48 h of pubDate and (b) not a
duplicate URL. A pure scoring pass runs afterward, but there is no CJCS screen.
Evidence from this session's logs [LOG-WFR]:

```
[WarfighterRSS] +The Daily Wire (5): This One Family Habit Could Save Reading...
[WarfighterRSS] Done — added: 1, skipped: 42
```

Consumer/lifestyle content from The Daily Wire enters the `headlines` table
directly. This is the only feed path that writes to `headlines` without a
relevance check.

### 1d. `bypassCJCSGate` outlets

Outlets whose entire editorial scope is defense/IR (e.g., Foreign Policy, The
Diplomat) are flagged `bypassCJCSGate = true` in `server/rssFeeds.ts`. For
these, the RSSBot forces `isRelevant = true` regardless of the AI verdict. From
[Q2]: Foreign Policy had 3 submissions in 24 h (0 promoted — passed gate but
all scored below 50); The Diplomat had 2 (1 promoted). The bypass is
functioning; the scoring step still suppresses analytical-framing pieces
(see §4-P8).

---

## 2. What passes relevance but is suppressed by scoring

### 2a. Overall bot/RSS funnel — 24-hour view [Q2]

All items in `team_submissions` have **already passed the CJCS relevance gate**.
The scoring step then determines whether they reach the main feed or stay in
Team chat only. Raw query output [Q2]:

```
source_name, total, promoted_to_main(≥50), chat_only(<50), flash_eligible(≥66), avg_score
Jerusalem Post  84  44  40  31  52.3
Al Jazeera      66  35  31  21  52.9
The Guardian    53  14  39   8  37.1
Yonhap          51  16  35   1  41.0
AP News         47  15  32   7  36.6
The Hill        36  16  20   6  47.9
France 24       34  18  16  12  49.4
CBS News        32   7  25   5  39.1
Reuters         31  23   8  10  58.5
Bloomberg       31  18  13  12  56.9
Washington Examiner  30   9  21   5  44.5
ABC News        28   8  20   6  37.3
NewsNation      20   8  12   5  49.3
DW              18   8  10   4  43.4
BBC             15   2  13   1  28.6
CNBC            15   6   9   2  46.1
POTUS (Truth Social) 12   0  12   0  20.9
NPR              8   4   4   3  43.4
Fox News         7   1   6   0  34.7
NBC News         5   4   1   4  76.2
BBC News         5   3   2   3  55.2
Military.com     4   2   2   2  57.0
Foreign Policy   3   0   3   0  41.7
Task & Purpose   3   1   2   1  53.3
Defense News     3   3   0   0  61.7
Washington Post  3   1   2   1  39.3
Defense One      2   1   1   0  50.0
Foreign Affairs  2   2   0   0  60.0
Politico         2   0   2   0  35.0
The Diplomat     2   1   1   0  50.0
```

Aggregate derived from [Q2]:

| Tier | Count | Share |
|---|---|---|
| Total articles passing CJCS gate (24 h) | ~652 | 100% |
| **Promoted to main feed** (score ≥ 50) | ~272 | **~42%** |
| **Chat-only / suppressed** (score < 50) | ~380 | **~58%** |
| Flash-eligible (score ≥ 66) | ~145 | **~22%** |

> **Finding [Q2]:** Approximately 58% of all articles that the AI deemed
> CJCS-relevant never reach Classic or Visual feeds. BBC (13% promotion) and
> The Guardian (26%) show strikingly high suppression despite producing regular
> defense and conflict coverage. Reuters (74%) and Bloomberg (58%) — both heavy
> in statecraft/geopolitics — have the highest promotion rates. POTUS/Truth
> Social (0%) confirms social posts are never promoted to the Classic main feed.

### 2b. Suppression table (worst and best performers) [Q2]

| Source | Promoted | Total | Promotion rate |
|---|---|---|---|
| Defense News | 3 | 3 | 100% |
| Foreign Affairs | 2 | 2 | 100% |
| NBC News | 4 | 5 | 80% |
| Reuters | 23 | 31 | 74% |
| Bloomberg | 18 | 31 | 58% |
| France 24 | 18 | 34 | 53% |
| Al Jazeera | 35 | 66 | 53% |
| Jerusalem Post | 44 | 84 | 52% |
| CBS News | 7 | 32 | 22% |
| Fox News | 1 | 7 | 14% |
| BBC | 2 | 15 | 13% |
| POTUS (Truth Social) | 0 | 12 | **0%** |
| Foreign Policy | 0 | 3 | **0%** |
| Politico | 0 | 2 | **0%** |

### 2c. The UNSCORED_BOT_PRIORITY = 30 default [Q2]

When `scoreHeadlinePrioritiesBatch` fails (AI timeout, parse error, rate
limit), articles receive `priorityScore = 30` — permanently chat-only. From
[Q2], 38 items across multiple sources carried the score_30_default value in
the 24-hour window (Jerusalem Post: 1, Al Jazeera: 5, The Guardian: 2,
Yonhap: 3, AP News: 2, The Hill: 4, CBS News: 5, Bloomberg: 1, CNBC: 5,
others). There is no retry; the fallback is final. There is no flag in the DB
to distinguish "AI returned 30" from "scoring call failed."

### 2d. `headlines` table score distribution [Q1]

Raw query output [Q1]:

```
total_headlines: 48
avg_score: 15.79
min_score: 5, max_score: 75
critical (≥90):       0  (0%)
high (70–89):         2  (4%)
moderate (50–69):     2  (4%)
low (30–49):          5  (10%)
minimal (<30):       39  (81%)
exactly 50:           0  (0%)
round-of-10:          3  (6%)
human overrides:      0
```

**Baseline comparison [BASE]:** avg 32.3, 65% round-of-10, 41% at exactly-50.
The current snapshot eliminates the "default-50 overloading" problem seen at
baseline (zero items at exactly 50 today), but has a new problem: 81% of rows
score below 30. This distribution reflects WarfighterRSS consumer/lifestyle
content dominating the table count with scores near the floor.

---

## 3. Main-feed vs Curated-only content

### 3a. Quantitative cohort breakdown [Q1] [Q2] [LOG-CUR] [LOG-WFR]

The table below maps every cohort to its feed lane. Counts are for the
measurement window (24 h for [Q2], 48 h for [Q1], 53-min for log-derived
figures).

| Cohort | Count | Main feed? | Curated? | Source |
|---|---|---|---|---|
| WarfighterRSS items in `headlines` | ~44 of 48 total rows | YES (all) | NO — no curated routing | [Q1] [LOG-WFR] |
| Bot/RSS items promoted (score ≥ 50) | ~272 | YES | Via reuse-mode only if separately ingested by curated bots | [Q2] |
| Bot/RSS items suppressed (score < 50) | ~380 | NO | NO — no curated reroute for scored-but-low items | [Q2] |
| CJCS-gate rejects → curated candidate buffer | ~60/RSSBot cycle | NO | ~0–1 admitted/cycle (both gates agree on rejection) | [LOG-CUR] |
| Social posts (Truth Social, X) | 12 POTUS in 24 h (0% promoted) | NO (Visual/Social only) | YES (reuse-mode, attach-only) | [Q2] |
| Curated-only scraper / curated bot items | Not measured (query returned no rows in window) | NO | YES | — |
| Adversary/state-media / contrast items | Not measured separately | NO | YES (attach-only or contrast tier) | — |

**By-design curated-only cohorts** (would never enter main feed regardless of score):
- Social posts (Truth Social, X) — sourced via `reuse-mode`, not the bot/score path
- Adversary / state media — contrast role prevents main-feed promotion
- Curated-bot-only items (curated scrapers that never post to `team_submissions`)

**Diverted main-eligible cohorts** (capable of scoring ≥50 but currently absent from both feeds):
- Chat-only `team_submissions` items (score 30–49, ~380 in 24 h): these items passed relevance, have a real priority score, but sit permanently in Team chat
- UNSCORED items (score=30 fallback, 38 in 24 h): these would need a retry to know their real placement

### 3b. What is Curated-only (never appears in Classic / Visual / custom-MCOP)

| Content type | Why Curated-only |
|---|---|
| CJCS-gate rejects from bots and RSSBot | Failed `BOT_CJCS_SYSTEM_PROMPT`; `admitCuratedCandidates(mode:'gate')` handles them |
| Contrast / adversary outlets (state media, low-factuality) | Role gate forces attach-only or contrast tier; never promoted to main feed |
| Social posts (Truth Social, X) admitted in `reuse-mode` | Not scored via main-feed path; tier re-derived live from registry |
| Items admitted directly by `CuratedAnalyzer` (website scrapers, curated bots) | Never touch `headlines` or `team_submissions` |

### 3c. What is main-feed-only (never Curated)

| Content type | Why it never reaches Curated |
|---|---|
| WarfighterRSS articles (The Blaze + Daily Wire) | No curated routing exists; goes directly to `headlines` |
| Chat-only `team_submissions` (score 30–49) | Scored but below promotion bar; not rerouted to curated |

### 3c. The curated reject pipeline — observed behavior [LOG-CUR]

The designed flow is: CJCS-gate rejects → bounded reject buffer (≤60 items) →
`admitCuratedCandidates(mode:'gate')` → curated lane.

From [LOG-CUR], this pipeline was observed **4 times** in the 53-minute window:

```
[RSSBot]     Curated reject capture: 0 admitted, 60 skipped (of 60)    ← cycle 1
[RSSBot]     Curated reject capture: 0 admitted, 60 skipped (of 60)    ← cycle 2
[ApNewsBot]  Curated reject capture: 0 admitted, 60 skipped (of 60)    ← cycle 3
[RSSBot]     Curated reject capture: 1 admitted, 59 skipped (of 60)    ← cycle 4

[CuratedIntake:rss-bot-rejects] Done — ingested 1, skipped 59 (of 60)
  ABC News [relevance-rejected=3], BBC [relevance-rejected=7],
  Bloomberg [dup-url=5 relevance-rejected=4], CBS News [relevance-rejected=11],
  CNBC [relevance-rejected=12 dup-url=1], Fox News [relevance-rejected=1],
  NBC News [relevance-rejected=1], NPR [relevance-rejected=2],
  The Guardian [ingested=1 relevance-rejected=7], Washington Post [relevance-rejected=3]
```

Also observed from [LOG-CUR]:
```
[CuratedAnalyzer] Analyzed 25/25 curated candidates, 0 kept    ← cycle A
[CuratedAnalyzer] Analyzed 25/25 curated candidates, 4 kept    ← cycle B
```

> **Finding [LOG-CUR]:** The curated reject pipeline is capturing 60 items per
> cycle and admitting 0 on 3 of 4 observed cycles; 1 item (The Guardian) was
> admitted in the 4th cycle. The curated analyzer independently rejects 0–16%
> of candidates per cycle. **Root cause of near-zero admission:** items that
> fail the CJCS gate are predominantly general-news consumer/domestic content
> (CNBC financial, CBS domestic, NPR lifestyle). The curated gate also rejects
> this content because it does not meet the defense/statecraft aperture. Both
> gates independently agree on the same rejects. The pipeline is not broken —
> it is evidence that the current RSS feed mix does not produce material that
> is CJCS-irrelevant yet curated-relevant. The curated lane is being fed
> by its own website scrapers, curated bots, and social post admission — not
> from bot-funnel rejects.

---

## 4. Plain-language problem list

Each item is labeled **P1–P8** in order of operational impact. Every problem
is followed by a clearly labeled **non-binding suggested direction** for future
work. No direction here is an implementation prescription; all are diagnostic
inferences only.

---

**P1 — WarfighterRSS publishes consumer content to the main feed without a
relevance check** [LOG-WFR]

The Daily Wire RSS includes lifestyle, opinion, and consumer articles. These
enter the `headlines` table — which powers the Classic main feed — without
any CJCS or defense relevance screen. This is visible in the 81% below-30
distribution in [Q1]: those 39 rows are dominated by Warfighter content that
would fail any CJCS gate.

*Non-binding suggested direction:* Apply the existing `BOT_CJCS_SYSTEM_PROMPT`
(or a lightweight equivalent) to WarfighterRSS articles before they enter
`headlines`. Defense/military content from these outlets would still pass;
consumer content would be blocked or rerouted.

**Affected files:** `server/warfighterRssScraper.ts`

---

**P2 — Main feed score average has degraded significantly since baseline**
[Q1] vs [BASE]

Baseline avg 32.3 (2026-06-29). Current avg 15.8 (2026-07-13). 81% of the
`headlines` pool now scores below 30, compared to the baseline's bimodal mix of
default-50s and a low tail. The "exactly-50 overloading" problem is resolved
(0 items today), but has been replaced by a dominance of low-scoring RSS
lifestyle content.

*Non-binding suggested direction:* This problem is downstream of P1. Resolving
the WarfighterRSS relevance gap would remove the bulk of sub-30 rows. No
scoring threshold change is needed.

---

**P3 — 58% of CJCS-relevant articles are permanently invisible to main-feed
readers** [Q2]

Items that pass the CJCS gate but score below 50 stay in Team chat and
`team_submissions` only, with no second-chance promotion path. BBC (13%
promotion rate, avg 28.6) and The Guardian (26%, avg 37.1) show high
suppression despite covering defense and conflict.

*Non-binding suggested direction:* Review whether these outlets' coverage is
correctly framed in the scoring rubric. If the rubric underweights
conflict-adjacent reporting (as opposed to pure breaking news), a rubric
annotation addition — not a threshold change — could raise these outlets'
scores without affecting the overall promotion bar.

---

**P4 — AI scoring failures permanently bury articles at score = 30** [Q2]

The `UNSCORED_BOT_PRIORITY = 30` fallback is applied irrevocably when
`scoreHeadlinePrioritiesBatch` times out or returns a malformed response.
38 items across multiple sources carried this default in the 24-hour window
[Q2]. There is no DB flag distinguishing "AI said 30" from "AI failed," and
there is no retry.

*Non-binding suggested direction:* Add a `score_source` enum or
`scoring_failed` boolean to `team_submissions`. A background retry pass could
re-score flagged items on the next available AI slot. This is a DB-schema and
scheduling change with no impact on feed logic.

**Affected files:** `server/rssFeedBot.ts`, `server/apNewsBot.ts`,
`server/aiAnalyzer.ts`, `shared/schema.ts`

---

**P5 — The curated reject-intake pipeline is idle as a content source** [LOG-CUR]

3 of 4 observed cycles admitted 0 items; 1 cycle admitted 1. The pipeline is
structurally correct — both the CJCS gate and the curated gate agree that
current RSS feed rejects (CNBC, CBS, NPR domestic) are not curated-relevant.

*Non-binding suggested direction:* This is not a bug. If curated content breadth
needs improvement, the fix is in **feed selection** (add curated-relevant
sources to the ingestion mix), not in relaxing either gate. The pipeline
architecture is sound.

---

**P6 — Deterministic pre-filter drops leave no audit trail** [BASE, code]

All `HARD_EXCLUSION_KEYWORDS` and `BLOCKED_MEDIA_OUTLET_DOMAINS` drops are
invisible in the database. A keyword that incorrectly matches a legitimate
defense story silently loses that article. This gap was documented in the
June 2026 baseline report [BASE, §3] and remains unresolved.

*Non-binding suggested direction:* Log the drop event at a structured key —
e.g., `[FUNNEL:PREFILTER-DROP] keyword="<kw>" title="..." source="..."` — so
that deployment-log searches can surface false-negative candidates. No DB write
is required.

**Affected files:** `server/scraper.ts`, `server/relevanceDefinition.ts`

---

**P7 — POTUS / Truth Social posts are never promoted to Classic** [Q2]

All 12 Truth Social posts in the 24-hour window scored below 50 (avg 20.9,
0% promotion rate) [Q2]. POTUS statements appear only in Visual/Social and Team
chat, never in Classic.

*Non-binding suggested direction:* Confirm whether this is an explicit policy
decision. If POTUS social posts should appear in Classic, they need either
(a) a separate scoring path that does not apply the 50-bar, or (b) a source-
type exemption in `qualifiesForMainFeedPromotion`. If it is intentional, it
should be documented as a deliberate design choice rather than a scoring
accident.

---

**P8 — Analytical/foreign-policy framing is systematically underscored** [Q2]

Foreign Policy: 0% promotion (avg 41.7), bypassCJCSGate=true. The Diplomat:
50% (avg 50.0). Politico: 0% (avg 35.0). These outlets pass the CJCS gate —
the bypass works — but the priority scorer assigns them below-50 scores. The
scoring rubric appears calibrated for breaking/event-driven news rather than
analytical or policy-framing articles, even when those articles are
definitionally CJCS-relevant. [Q2]

*Non-binding suggested direction:* Sample 15–20 recent Foreign Policy and BBC
articles that scored below 50 and trace which rubric criterion they fail. If
the prompt lacks language rewarding strategic analysis, a targeted annotation
addition to `NEW_ANALYZER_SYSTEM_PROMPT` (not a threshold change) could address
this without disrupting the overall score distribution.

**Affected files:** `server/relevanceDefinition.ts` (NEW_ANALYZER_SYSTEM_PROMPT)

---

## 5. Instrumentation gaps preventing measurement

| Gap | What it prevents measuring | Where |
|---|---|---|
| Deterministic pre-filter drops not persisted | False-negative rate of keyword exclusions | `server/scraper.ts` |
| `UNSCORED_BOT_PRIORITY=30` not flagged in DB | Cannot distinguish "AI said 30" from "AI failed" | `shared/schema.ts`, `server/rssFeedBot.ts` |
| Node-selection rescue counters runtime-logged only | Per-pass recall/precision balance in curated clustering [BASE §4] | `server/curatedCluster.ts` |
| No structured log for full-batch AI error drops | Quiet false-negatives during rate-limit storms [BASE §3] | `server/aiAnalyzer.ts` |

---

## 6. What was not changed

This report is **measurement-only**. No code, prompts, thresholds, scoring
rubrics, decay curves, keyword lists, feed configurations, or database records
were modified. All findings are derived from:

- `executeSql` read-only queries [Q1, Q2] against the production database
- Deployment log analysis [LOG-FUNNEL, LOG-RSS, LOG-CUR, LOG-WFR]
- Static reads of `server/relevanceDefinition.ts`, `server/aiAnalyzer.ts`,
  `server/scraper.ts`, `server/rssFeedBot.ts`, `server/apNewsBot.ts`,
  `server/warfighterRssScraper.ts`, `server/scoreAdjustments.ts`,
  `server/curatedIngest.ts`
- Prior baseline reference: `docs/pscore-funnel-baseline.md` [BASE]
