---
name: Media COP timeout zombies & lock discipline
description: Cancellation and force-kill rules for the shared Playwright browser lock and Promise.race scrape timeouts.
---

**Rule 1:** Any `Promise.race`-style timeout around multi-lane scrape work must pair with cooperative cancellation (a generation counter), and the cancellation check must run **inside the browser-lock acquisition callback**, not just before enqueueing — a run revoked while queued would otherwise still execute a full lane once the queue reaches it.

**Why:** A timed-out chain body cannot be cancelled by the race; left alone it keeps re-acquiring the process-wide browser lock lane-by-lane, starving all later cycles' lanes and offset crons for ~an hour, with lane stamps frozen (they're only written at the end of a successful body).

**How to apply:** Bump the generation in the timeout catch AND every watchdog force-clear path; check it at each lane boundary, after each cooldown, before the final batch stamp, and via the lock's `onAcquire` seam.

**Rule 2:** `forceKillAllBrowsers` (pkill of all headless Chromium) must go through the holder-aware policy: kill only when the browser lock is free or held by the chain's own lanes; never when a sibling family (OSINT/Journalist/Influencer) holds it — killing an innocent live browser mid-scrape causes empty results and retry churn.

**Why:** Recovery paths that pkill unconditionally repeatedly destroyed a healthy sibling's session and extended stalls instead of ending them.

**Rule 3:** Per-lane stall watchdogs comparing stamps vs cadence must gate on relay health AND on when scraper-primary mode began — stamps are legitimately old right after a relay-health transition; alerting on raw age creates false alarms.
