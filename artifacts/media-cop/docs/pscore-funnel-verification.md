# Main-Feed Promotion Bar — Verification of the Lowered Bar (Task #524)

**Verifies:** Task #522 (lower `MAIN_FEED_PROMOTION_THRESHOLD` from 66 → 50 so more
relevance-screened MODERATE bot/RSS items reach the main Classic/Visual feed).
**Method:** read-only production deployment logs — the `[FUNNEL:PROMOTE]` (per-item
MAIN vs CHAT-ONLY decision) and `[FUNNEL:SCORE]` (per-batch P-score distribution)
instrumentation added for exactly this measurement. Both logs print the live
`bar=` value, so they self-describe whichever threshold is actually deployed.
**Date:** 2026-06-29. **Window sampled:** ~3.5h of live bot/RSS traffic.

---

## 0. Headline finding — the lowered bar is NOT live in production yet

**Every** `[FUNNEL:PROMOTE]` and `[FUNNEL:SCORE]` line in the current production
logs shows `bar=66` (`MEET>=66` / `BELOW<66` / `ge66`). A targeted search for any
`bar=50` decision (`MEET>=50` / `BELOW<50`) returned **zero** rows.

The repo constant is `MAIN_FEED_PROMOTION_THRESHOLD = 50`, and it has no env
override — so if the current code were deployed the logs would read `bar=50`. They
read `bar=66`. **Conclusion: the deployed build predates Task #522's merge; the
50-bar change has not been republished.**

Because the change is not live, the literal "after republish, measure the lowered
bar's effect" cannot be performed against real bar=50 traffic. What follows is a
**projection** built from the real, live bar=66 P-score distribution — the same
items, re-bucketed against a 50 cut. This is a strong predictor (it uses real
production scores) but is explicitly **not** a post-deployment measurement. The
final confirmation step is simply: republish, then re-read these same two logs —
they will then print `bar=50` automatically.

---

## 1. Live P-score distribution (bar=66), N = 250 scored bot/RSS items

Aggregated `[FUNNEL:SCORE] byTens` across the window:

| Band | Count | Share |
|---|---|---|
| 0–9   | 95 | 38.0% |
| 10–19 | 69 | 27.6% |
| 20–29 | 20 | 8.0% |
| 30–39 | 1  | 0.4% |
| 40–49 | 0  | 0.0% |
| 50–59 | 7  | 2.8% |
| 60–69 | 30 | 12.0% |
| 70–79 | 18 | 7.2% |
| 80–89 | 10 | 4.0% |
| 90+   | 0  | 0.0% |

The distribution is bimodal: a large low-relevance tail (**73.6% sit at 0–29**) and
a smaller credible-news cluster at **50–89 (26.0%)**. The 30–49 band is nearly
empty (1 item) — i.e. there is a clean gap just below the new bar, so a 50 cut does
**not** slice through a dense clump.

---

## 2. Current vs projected MAIN share

| | Bar | → MAIN | → CHAT-ONLY |
|---|---|---|---|
| **Current (live)** | 66 | **29 / 250 = 11.6%** | 221 = 88.4% |
| **Projected** | 50 | **65 / 250 = 26.0%** | 185 = 74.0% |

- Lowering 66 → 50 raises the bot/RSS MAIN share **+14.4 pts (≈2.2×)**.
- The newly-promoted items are exactly the **50–69 MODERATE / situational-awareness
  band** (37 items, 14.8% of scored) that the 66 bar was cutting through — minus the
  66–69 sliver that already promoted. This is the band Task #522 intended to recover.
- **Not flooding:** 74% of scored items still stay chat-only at 50. The entire
  low-relevance tail (0–49 = 73.6%+) remains excluded. The cut lands in the empty
  30–49 gap, not mid-clump.

> Note on populations: `[FUNNEL:SCORE]` covers the raw scorer batch (includes the
> big 0–29 tail); `[FUNNEL:PROMOTE]` covers items that reached the finalize gate
> after the BOT_CJCS relevance screen. Both confirm the same bar (66) and the same
> qualitative picture; the 26% projection is the conservative all-scored view.

---

## 3. Spot-check — are the 50–65 items situational-awareness-worthy?

The `[FUNNEL:PROMOTE]` lines currently logged as `BELOW<66 -> CHAT-ONLY` with a
score in 50–65 (i.e. the items that a 50 bar would newly promote) come from:

`Reuters` (50/55/60/65), `AP News`, `Al Jazeera` (50/60/65), `Jerusalem Post` (55),
`Military Times` (50/65), `France 24` (65), `DW` (60), `The Hill` (55/65),
`Bloomberg` (65), `BBC` (65).

Every one is an established defense / foreign-affairs wire or outlet, and 50–69 is
the rubric's explicit MODERATE band (regional conflicts, defense-relevant politics,
sanctions/trade, readiness). These are mid-tier credible-source items — precisely
what a common operating picture should carry — **not** low-value noise. No evidence
the lowered bar would flood the feed with junk.

---

## 4. Decision — keep the knob at 50

The projection supports the Task #522 choice:
- Recovers the intended MODERATE situational-awareness band from credible outlets.
- Leaves the 0–49 low-relevance tail excluded (74% still chat-only).
- Cuts in the empty 30–49 gap, so it is robust to small distribution shifts.

**`MAIN_FEED_PROMOTION_THRESHOLD` is left at 50.** No re-tune warranted by the data.

## 5. Remaining step (owner: republish)

This verification is projected from live bar=66 data. To close it definitively:
1. Republish so the deployed build carries `MAIN_FEED_PROMOTION_THRESHOLD = 50`.
2. Re-read `[FUNNEL:PROMOTE]` / `[FUNNEL:SCORE]` — they will then print `bar=50`.
3. Confirm the measured MAIN share lands near the projected ~26% and that the feed
   volume is comfortable; if it reads too permissive/strict, nudge the single
   constant and re-measure. No prompt or scraper change is ever needed for this.
