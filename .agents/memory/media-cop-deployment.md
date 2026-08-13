---
name: Media COP deployment target
description: Why prod must be a Reserved VM, and how autoscale staleness presented
---

Rule: keep the media-cop production deployment on `deploymentTarget = "vm"` (single instance).

**Why:** The app's ingestion is all in-process node-cron (OSINT X scrape :25/:55, 10-min main chain, RSS bots). On autoscale, prod suspends between requests, so cron ticks silently never fire — symptom was "feeds fresh right after republish, then stale": scrapes stamped only in the first hour after boot, later ticks missing. Fixed Aug 13 2026 by switching `.replit` deploymentTarget to `vm`.

**How to apply:** If prod feeds go stale again, first check `scrape_metadata` timestamps in prod against the cron schedule before suspecting cookies/rate limits. Never scale to multiple instances or revert to autoscale without a distributed scheduler lock — re-entrancy guards and relay heartbeat state are module-local. Also note: the X relay ("EV") has never heartbeated in prod (no `x` row in relay_heartbeats), so Playwright PRIMARY mode is the normal operating mode there.
