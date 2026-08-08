# Why BBC & Analytical Outlets Score Low Despite Passing the CJCS Gate

**Investigation date:** 2026-07-18
**Scope:** Measurement + root-cause analysis, followed by one targeted prompt change (a single additive MODERATE-band bullet in `NEW_ANALYZER_SYSTEM_PROMPT` — see "Applied change" below). **No thresholds were changed**; the legacy prompt is untouched and the change is reversible via `USE_LEGACY_ANALYZER_PROMPT`.
**Follow-on to:** `docs/relevance-scoring-funnel-diagnostic.md` (§2b, §4-P3, §4-P8)

---

## Question

The funnel diagnostic found BBC at 13% promotion and Foreign Policy at 0%
despite `bypassCJCSGate = true` (Foreign Policy / The Diplomat) or heavy
defense/conflict coverage (BBC). These outlets publish material the relevance
gate accepts as CJCS-relevant, yet the priority scorer assigns them below 50 and
they stay permanently chat-only. Why?

## Method

Read-only queries against the **production** read replica (30-day window,
`source_type='news'`, `priority_score IS NOT NULL`). Sampled ~85 below-50
headlines across BBC, Foreign Policy, The Diplomat, and Politico, plus the full
score distribution for those four outlets. Cross-read the live scoring rubric
(`server/relevanceDefinition.ts` → `NEW_ANALYZER_SYSTEM_PROMPT`) and the batch
scoring path (`server/aiAnalyzer.ts` → `scoreHeadlineChunk` /
`scoreHeadlinePrioritiesBatch`).

## Finding 1 — It is NOT the relevance gate or the bypass flag

Every sampled item is present in `team_submissions` with `is_relevant=true`
(that is why it is scored at all). Foreign Policy and The Diplomat bypass the
CJCS gate correctly. The loss is entirely at the **scoring** step, exactly as
§4-P8 inferred. So the bypass flag is working; the problem is downstream.

## Finding 2 — Analytical/policy items pile up at exactly 45 (one notch under the bar)

Score distribution for BBC + Foreign Policy + The Diplomat + Politico, 30 days:

```
 score  count        score  count
     5    146            50      9
    30     76            52     15
    35     64            55     89
    38     14            62     28
    45     85 ◄──        65     87
    48      3            72     47
```

**85 items sit at exactly 45** — the largest single spike anywhere in the
sub-50 range, and it is glued to the value one below the promotion bar (50).
The 46–49 slots are nearly empty (48:3, 40:3, 42:3, 43:2). 45 is not a smooth
tail; it is a discrete **attractor**. The model is repeatedly reaching for "this
is clearly relevant, but I can't justify MODERATE" and parking the item just
under the bar.

## Finding 3 — What actually landed at 45 (a representative sample)

These are not noise. They are core common-operating-picture material:

- Foreign Policy: "Restocking the Pentagon"; "Washington Shouldn't Fear NATO
  Expansion"; "Why Netanyahu Is Crying Wolf on Turkey"; "Trump's Trans-Atlantic
  Tech Schism"; "NATO Is Still a Sick Puppy".
- The Diplomat: "10 Years Ago, the Philippines Won a Major Victory in the South
  China Sea. Did It Matter?"; "USS Ronald Reagan Drug Case Raises Questions
  About Off-Base Reach in Japan"; "Whither an International Response to China's
  Ethnic Unity Law?".
- Politico: "Trump's $1.5T defense budget is in trouble"; "Mitch McConnell's
  absence is throwing Trump's Pentagon budget boost in doubt"; "Judge blocks
  Pentagon's press escort policy".
- BBC: "JD Vance accuses Israel of 'manipulating' US public opinion to prolong
  Iran war"; "Bowen: For all his bluster, Trump has no better option than talks
  with Iran".

The common thread: they **analyze, explain, or frame** a strategic dynamic
rather than **report a new discrete event**.

## Root cause — the rubric equates importance with a discrete, urgent EVENT

Reading `NEW_ANALYZER_SYSTEM_PROMPT`, every qualifying bullet above LOW is
phrased around a fresh action/development/escalation:

- **95–100 / 85–94:** active combat, WMD, "major moves", "developments demanding
  immediate action".
- **70–84 (HIGH):** "theater-shaping developments", "NDAA passage", "a new
  front", "STATECRAFT WITH ACTIVE ESCALATION".
- **50–69 (MODERATE):** "regional conflicts", "diplomatic or political
  **developments**", "sanctions/trade **moves**", "recruitment/retention
  **trends**".
- **20–49 (LOW):** "routine policy... news", "**ordinary diplomatic color**",
  "**Relevant-but-minor developments with no near-term strategic consequence**".

An analytical/policy/explanatory piece reports no new discrete event, so it
matches **none** of the MODERATE bullets (all of which require a "development",
"move", or "trend"). The only bullet that fits its shape is the LOW-band catch-
all "ordinary diplomatic color / relevant-but-minor with no near-term
consequence." The model files strategic *analysis* there and clumps it at ~45.

The prompt also actively reinforces this: it repeatedly warns *"a correctly-
relevant story can still score low"* and *"NEVER raise a score just because a
topic sounds exciting."* Those guardrails are correct for hype suppression, but
combined with the missing MODERATE home for analysis, they push the model to
discount framing/explainer value by default.

**This is a rubric-coverage gap, not a threshold problem and not a bypass bug.**
Strategic analysis of NATO expansion, the defense budget, or South China Sea
posture is at least as valuable to a common operating picture as a routine
event report — but the rubric gives it no qualifying band above LOW.

## Contributing factor (secondary) — the batch scoring turn under-cues scoring

`scoreHeadlineChunk` (`server/aiAnalyzer.ts:1204`) — the exact path that scores
bot/RSS items — sends this user turn:

> "Analyze ALL N headlines and assign appropriate strategic **tags** to each.
> Mark is_relevant=true for military/strategic topics, false for non-military
> topics"

It never asks the model to *score*, nor to spread scores relative to each other.
The scoring rubric lives only in the system prompt. Compare the curated path
(`analyzeCuratedChunk`, line 730), whose user turn explicitly says "SCORE THESE
ITEMS RELATIVE TO EACH OTHER... SPREAD the priority_score values across the full
range." A user turn that foregrounds tags and stays silent on scoring makes a
safe middling-low default (45) more likely and plausibly amplifies the clump.

## What was NOT the cause (ruled out)

- **Not the bypass flag** — bypassed outlets are scored, is_relevant=true.
- **Not model temperature** — temperature is 0.3 on every scoring path; a
  clump at one specific value (45) is a rubric/instruction effect, not sampling
  variance.
- **Not the promotion threshold (50)** — moving the bar would sweep in genuine
  LOW items too; the fix must lift *analysis specifically*, not the floor.
- **Not the UNSCORED_BOT_PRIORITY=30 fallback** — that produces the separate 30
  spike (76 items), a different problem (§4-P4), not the 45 clump.

---

## Applied change (targeted, scoped — verified with a controlled before/after)

**Status: APPLIED on 2026-07-18** (originally proposed-only; the user asked to
fold the implementation into this task). A single additive bullet gives
strategic analysis a home in MODERATE without touching any other band,
threshold, or the hype-suppression guardrails.

Added to the **50–69 (MODERATE)** band in `NEW_ANALYZER_SYSTEM_PROMPT`:

> - Substantive strategic ANALYSIS, explainer, or policy-framing on a live
>   national-security / defense / foreign-policy question (e.g. alliance posture,
>   the defense budget, an adversary's strategy, a contested theater) — score its
>   analytical value to leadership even when it reports no new discrete event.
>   Do NOT default such pieces to LOW merely because they are analysis rather
>   than breaking news; reserve LOW for genuinely minor or routine items.

Rationale for keeping it in MODERATE (not HIGH): analysis without a new
escalation event should reach the feed (≥50) but should not out-rank active
kinetic developments; MODERATE (50–69) is the correct home, right at/above the
promotion bar.

### Controlled before/after — results (2026-07-18)

Harness: `.local/ab-analytical-prompt.ts` (read-only; reproduces the exact
production scoring call — same model `gpt-4o-mini`, temperature 0.3, the same
`scoreHeadlineChunk` user turn, 20-title chunks). BEFORE = live prompt with the
new bullet stripped; AFTER = live prompt. Sample: 60 production analytical
items from the 42–48 band (BBC/FP/Diplomat/Politico, 30-day window) + 40
production control items scored 20–40 (genuinely minor: routine appointments,
weather color, sports-adjacent politics).

| Cohort | mean BEFORE | mean AFTER | crossed <50→≥50 | landed ≥70 |
|---|---|---|---|---|
| Analytical (n=60) | 46.6 | 47.5 | 4 | 1 |
| Controls (n=40) | 31.6 | 33.8 | 2 | 1 |

Reading:
- **Targeted lift, no flood.** Clearly strategic analysis moved up over the
  bar ("NATO's New Enemy Is the Thermometer" 45→55, "Whither an International
  Response to China's Ethnic Unity Law?" 50→58, "US Tariffs Won't End Forced
  Labor…" 50→57, "Debate in Delhi on Trump, Trust, and Strategic Choices"
  50→55); marginal analytical color ("The Battle for Borsch", EU carbon-cuts
  pacing) correctly stayed low. Items already strategic scored HIGH-adjacent
  under BOTH prompts ("Trump's $1.5T defense budget is in trouble" 70→70).
- **Controls held.** 2/40 borderline crossings, both statecraft-adjacent
  (Canada-smoke → tariff threat). No ballooning of promotion volume: total
  crossings across both cohorts were 6/100.
- **Replay caveat.** The re-scored BEFORE run did not reproduce the discrete
  45-clump — replayed in analytical-heavy batches, scores spread naturally.
  The production clump therefore also depends on batch composition (analysis
  mixed into event-heavy scrape batches), which a replay cannot fully
  reproduce. The bullet removes the rubric gap; the residual clumping lever is
  the user-turn fix below.
- **Escalation gate: PASS.** `npx tsx scripts/statecraft-escalation-scoring.test.ts`
  → scored 11/11, HIGH(70+)=10, MODERATE=1 (within accepted tolerance), LOW=0.

The change is instantly reversible via the existing
`USE_LEGACY_ANALYZER_PROMPT` toggle.

### Optional secondary (NOT applied — separate change if clumping persists)

Bring the `scoreHeadlineChunk` user turn in line with the curated path — mention
scoring and relative spread explicitly. Deliberately left out of this change so
the rubric annotation's effect stays isolated; monitor the production score
distribution for the 45-clump after this deploys, and only then consider it as
its own independently-A/B'd change.
