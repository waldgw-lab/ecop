---
name: Media COP scrape chain budgets
description: Why the 10-min scrape chain timed out and the budget/lock rules that keep it under its 14-min hard bound
---

# Scrape chain budget rules

- The main full-scrape chain has a 14-min hard bound and a 10-min backfill soft budget. Any multi-account X lane inside it must get its own SUB-budget (e.g. 5 min), because a lane with per-account sleeps will consume the whole soft budget and the unbounded tail scrapers (RapidResponse/DOW/SentDefender, ~2-3 min each with 60s zero-post retries) then blow the hard bound.
- **Why:** even after moving OSINT out of the chain, cycles still timed out until the @SecWar lane was capped; the soft budget alone only stops *new* accounts, it doesn't reserve time for the tail.
- Heavy X scrapers (OSINT 19 accounts, Journalist) live on their own crons (:25/:55, :05/:35) serialized by the shared scrape/browser locks. Anything holding the browser lock 5+ min mid-chain can push the chain into timeout — schedule initial boot runs AFTER the boot chain's 14-min window (OSINT initial run is at boot+16 min for this reason).
- **How to apply:** when adding a new scrape lane, never append it to the chain tail; give it a dedicated cron offset from :00/:10/... chain starts, an in-flight guard, a relay-healthy skip, and pass a hard per-run deadline.
- X returning "0 tweet elements" with the profile page rendered is usually per-IP rate limiting after heavy scraping, not expired cookies; it recovers on later cron runs.
- Dev diagnosis: login via POST /api/auth/login with $APP_PASSWORD, then read /api/scrape-metadata (lastScrapeTime vs lastErrorTime tells you if the last cycle completed or timed out). Deployment (prod) runs old code until redeployed — its timeout stamps can confuse dev verification.
