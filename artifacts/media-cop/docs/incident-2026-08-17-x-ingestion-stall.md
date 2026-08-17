# Incident root cause — X ingestion dark ~50 min (Aug 17 2026, 12:44–13:35 UTC)

## Symptom
A 12:44 UTC `Timeout (840000ms) for runFullScrape` was followed by every
Playwright X lane freezing: X posts, RapidResponse, DOW, and SentDefender last
stamped ~13:21 UTC; the OSINT cron missed its 13:25 and 13:55 runs. The EV
relay independently stopped heartbeating at 13:25 (stale mcop2 → mcop3 307
redirect — fixed on the EV side, out of scope here). The app itself stayed
healthy the whole time; nobody was alerted until a stale Coverage banner hours
later. Ingestion self-recovered by ~14:21.

## Evidence
Production logs before the ~14:02 redeploy were not retained, but the SAME
failure signature reproduced live in the deployment logs at 14:19–14:34 UTC
and was captured verbatim:

```
14:19:07 [Browser-Lock] Acquired by updateOsintPosts          ← OSINT takes the global browser mutex
14:20:00 Running scheduled scrape...                          ← next chain cycle starts
14:25:00 [Scheduler] OSINT X scrape already in progress, skipping
14:30:00 ⚠️ Skipping scheduled scrape - previous scrape still in progress
14:31:28 [Browser-Lock] Released by updateOsintPosts (741s)   ← OSINT held the lock 12+ min
14:31:28 [X-Scrape-Lock] Acquired by updateXPosts
14:31:28 [X-Scrape] Time budget reached — stopping after 0/10 accounts   ← budget burned WAITING
14:33:15 [Scheduler] Backfill time budget exhausted — skipping inter-scraper cooldown
14:34:04 [Scheduler] runFullScrape exceeded its hard bound — force-killing browsers…
14:34:04 Error in scrape: ScrapeTimeoutError: Timeout (840000ms) for runFullScrape
```

(The log also shows *two* interleaved "Running scheduled scrape..." lines with
different relay-heartbeat ages at 14:10/14:20 — two concurrent server
instances, consistent with autoscale running >1 instance; see the deployment
memory note that prod must be a single-instance Reserved VM.)

## Root cause — three interacting defects (not rate limiting, not credentials)

1. **Timed-out chains became lock-hogging zombies.** `runFullScrape` raced its
   body against a 14-min hard bound with `Promise.race`, which cannot cancel
   the body. On timeout, the body kept running in the background — sleeping
   through 45s cooldowns and **re-acquiring the process-wide browser lock for
   each remaining lane** — for many more minutes.

2. **Lock-wait burned every waiter's own budget.** The browser lock
   (`browserLock.ts`) is a promise-chain mutex with no holder bound. While the
   zombie (or a long OSINT run) held/queued it, the next cycle's lanes queued
   behind it and their own 14-min budgets and per-lane sub-deadlines elapsed
   *while waiting*. Each subsequent cycle therefore also timed out **before
   reaching the one place lane stamps are written** (the single batch stamp at
   the end of a successful body) — so `xPosts/rapidResponse/dow/sentDefender
   LastScrapeTime` all froze even though cycles were "running". The OSINT
   cron's `osintRunning` guard stayed true while its run sat in the lock queue,
   so :25/:55 ticks logged "already in progress, skipping".

3. **Timeout-path `forceKillAllBrowsers` killed innocent lock holders.** The
   pkill on the hard-bound path killed *every* headless Chromium — including
   the live browser of whichever sibling family (e.g. OSINT) currently held
   the lock — causing empty results and retry churn that extended the pile-up.

Recovery was passive: once the queued zombies drained, the next clean cycle
stamped all lanes (~13:35–14:21).

## Fixes (Task #34)

- **Cooperative cancellation generation** (`scheduler.ts`): every run captures
  `scrapeGeneration`; the timeout catch and both watchdog force-clear paths
  bump it; the body checks at every lane boundary and after every cooldown and
  aborts (`ScrapeCancelledError`) before taking the browser lock again. The
  check also runs **inside the browser-lock acquisition callback** (`onAcquire`
  seam in `browserLock.ts`), so a run revoked while *queued* for the lock
  abandons the moment the queue reaches it — it can never run a lane after
  revocation. A cancelled run can never write the batch lane stamps.
- **Holder-aware force-kill** (centralized policy used by the timeout path and
  every auto-heal/watchdog recovery path): `browserLock.ts` tracks the current
  holder; browsers are only pkilled when the lock is free or held by the
  chain's own lanes — a sibling family's live browser is left alone (the
  generation bump already contains the zombie).
- **Per-lane stall watchdog** (`xLaneStallWatchdog.ts` + 5-min cron): compares
  each lane's stamp to its cadence (gated on relay health and on when PRIMARY
  mode began) and, within one cycle, logs a distinct `[X-Lane-Watchdog]` line
  and surfaces an operator alert on the Coverage/oversight pipeline panel,
  classifying **scheduler-stalled** vs **lanes-stalled** vs **scrapes-empty**.

Gates: `scripts/x-lane-stall-watchdog.test.ts`,
`scripts/scrape-cancellation.test.ts`.

## Related (out of scope here)
- Task #15 — chain-internal budget rework (lock-wait time should not count
  against lane budgets).
- EV relay redirect fix — already done upstream (direct mcop3 posts, 5-min
  keepalive).
- Two concurrent prod instances observed in logs — deployment must be a
  single-instance Reserved VM (see `media-cop-deployment` memory note).
