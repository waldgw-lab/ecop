# Media Common Operating Picture

## Overview
Pilot Bravo is a real-time news aggregation application for military leadership. It monitors, scrapes, and categorizes defense-related news using AI, presenting it in a dense, scannable format inspired by the Bloomberg Terminal — a real-time common operating picture of defense news to support informed decision-making.

## User Preferences
Preferred communication style: Simple, everyday language.

Admin safety valves: keep manual admin toggles (kill switches / opt-ins) as safety valves, but automate as much as necessary — when functions depend on a toggled feature, they should handle its state automatically (degrade gracefully or self-manage) rather than requiring extra manual intervention.

## System Architecture

### Frontend
- **Stack:** React 18 + TypeScript, Vite, Wouter (routing), TanStack Query (server state).
- **UI:** Shadcn/ui (Radix + Tailwind), "New York" style with custom typography and design tokens. Page routes are code-split with `lazy()`/`Suspense`.

### Backend
- **Stack:** Express.js + TypeScript. RESTful endpoints for feeds, manual submissions, and admin operations.
- **Storage:** PostgreSQL (Neon Serverless) via Drizzle ORM for permanent data; Replit App Storage for uploaded PDFs and scraped images. Shared TypeScript types + Zod schemas across client/server.

#### Feeds
- **Main feed:** `/api/headline-feed` (Classic) combines scraped headlines and manual submissions, AI-prioritized. `/api/stream` (Visual) adds Truth Social, X, and DataMinr posts on top.
- **Feed read cache:** A short-TTL (~25s) in-memory cache backs the heavy read feeds (headline-feed, stream, custom-MCOP, war). Per-MCOP feeds cache the viewer payload only; all feeds honor an `x-mcop-no-cache` bypass; feed-shaping writes invalidate the relevant cache immediately.
- **War Dashboard:** Independent `/war` dashboard with its own content source and admin interface.
- **Custom MCOPs:** Per-MCOP feeds with their own admin curation, hidden-item controls, and an "Auto-fill from URL" submit flow (SSRF-guarded URL preview).

#### News Ingestion
- **Web scraping:** Cheerio, RSS Parser, and Playwright across many sources, plus DataMinr First Alert API. Supports manual X-post screenshot upload with GPT-4o vision extraction.
- **Truth Social relay (primary):** VM relay bridge promotes posts directly into storage with avatar filtering, image OCR, and POTUS SMS alerts. Scrapers run backfill-only while the relay heartbeat is healthy, full-scrape when stale.
- **X/Twitter relay ("Evangelist Vortex"):** VM relay routes each post by handle to the correct lane table via a fail-closed registry; unknown handles are skipped. Scrapers fall back to backfill-only while the relay is healthy. Contract: `docs/ev-x-relay-contract.md`.
- **RSS Feed Monitor:** Polls 45+ curated defense/major-outlet feeds every 5 min with AI relevance filtering; each source posts under its own identity. Feed list in `server/rssFeeds.ts`.
- **News posting bots:** Multiple AI bots (DrudgeBot, BBCBot, etc.) summarize and post CJCS-relevant articles to Team chat.
- **Scheduled operations:** `node-cron` scraping (~every 10 min) with re-entrancy guards and a self-healing watchdog.

#### AI Features
- **Priority scoring:** AI assigns strategic-importance scores to headlines; admins can override or block.
- **Headline clustering:** Incremental AI duplicate detection groups related stories.
- **Curated lane:** Isolated AI-clustered "Top Stories" view with its own storage, clustering, classification, and read cache — fail-closed so curated content never crosses into the main/Classic/Visual/custom-MCOP feeds or the public API.
- **MCOP Bot:** Deep-research Q&A assistant (Claude via OpenRouter, falls back to Anthropic) with iterative tool use over the source tables; single endpoint `/api/team/mcopBot`.
- **Quote database:** AI extraction of quotes from submissions, searchable.
- **Global Narrative Summary (Beta):** AI summaries of how 7 world regions cover conflicts (RSS + scraping + GDELT).
- **Leadership Quotes:** AI-generated category summaries with inline editing, grouped by speaker.
- **AI provider routing:** Former-OpenAI calls route through `server/aiClient.ts` on OpenRouter with concurrency limiting, adaptive request spacing, bounded transient-error retry, and a circuit breaker.

#### Other Features
- **Manual submission & review:** Form-based submission with optional PDF upload; AI analyzes priority/tags; reviewable/editable before posting.
- **Stream media pre-fetch:** Background process caches images + AI summary bullets for top headlines (images persisted to object storage, SSRF-validated); a backfill cron repairs rows bumped out of the top window.
- **Topic system:** Predefined and user-created topics with AI matching and a "FLASH: TOP STORIES" surface.
- **Senior Leader PA Events:** Scrapes POTUS schedule and senior-leader public-affairs events; supports manual email import.
- **Market Ticker:** Scrolling financial/geopolitical ticker via `yahoo-finance2` with a server-side cache.
- **Paywall bypass:** External API fallback for article content extraction.
- **Public REST API:** Read-only `/api/v1/` for external apps, authenticated via `X-API-Key`.

#### Testing & CI Gates
- **Consolidated gate runner:** All automated safety checks run through one manifest-driven runner, `scripts/run-gates.ts`, registered as a single `gates` validation command. This replaced ~24 individual per-check workflows, which had exceeded the platform's 10-workflow creation cap and blocked adding new gates.
- **Current manifest:** The full suite contains 167 gates (165 fast-tier and 2 slow). The default full run still executes all 167. The runner reports each result, scheduling-class counts, total elapsed time, and the ten slowest checks.
- **Measured runtime:** On August 5, 2026, a fresh serial full run passed 166/166 legacy gates in 327 seconds. Fresh optimized runs passed all 167 gates (the same 166 plus the new runner regression gate) in 203 and 193 seconds, a 38–41% wall-clock reduction with no added failures or inconclusive results.
- **Adding a new gate:** Write `scripts/<name>.test.ts` (exit 0 = pass, 1 = fail; exit 3 = inconclusive/re-run per `scripts/harness-reliability.ts`), then add one `GATES` entry. New gates are isolated by default. Add a name to `PARALLEL_SAFE_GATE_NAMES` only after proving it is deterministic/offline and uses no DB, dev server, browser, live network/feed, or live AI.
- **Running gates:** `npx tsx scripts/run-gates.ts` runs the safe optimized full suite. Use `--serial` for the one-at-a-time debugging fallback, `--jobs=N` (1–8, default 4) to bound offline workers, `--fast` to skip the 2 slow gates, `--list` to inspect the manifest/classes, or pass one or more gate names for targeted execution. `--fresh` bypasses resume checkpoints.
- **One suite at a time:** only the full `gates` suite is registered as a validation. Do not launch a second overlapping full/fast suite: isolated scheduling protects resources inside one runner, not across two independent runners. If a DB-writing gate fails during an external overlap, re-run it alone before treating it as a regression.

## External Dependencies
- **News sources:** Drudge Report, Truth Social, X/Twitter, DataMinr First Alert API, GDELT DOC 2.0 API, and many RSS feeds (Press TV, Tehran Times, Global Times, RT, Sputnik, TASS, Times of Israel, Jerusalem Post, Haaretz, Al Jazeera, Al Arabiya, BBC, DW, France24, Reuters, AP, Fox News, NPR, CNN, and major US outlets).
- **AI services:** OpenAI (via OpenRouter) and Anthropic (Claude).
- **Infrastructure:** Neon Serverless PostgreSQL; Replit App Storage; Playwright (browser automation).
- **Other services:** CloudMailin (email ingestion), Yahoo Finance (market data), Twilio / Termux SMS bridge (SMS alerts), Project Quasar API (Iran narrative).
