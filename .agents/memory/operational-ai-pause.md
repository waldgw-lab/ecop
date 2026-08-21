---
name: Operational AI pause
description: Durable shutdown semantics for disabling AI without damaging recovery state or unrelated ingestion.
---

An operational AI pause must be authoritative over provider selection, retries, fallbacks, direct SDK clients, and scheduled AI work. It must not be modeled as a provider outage.

**Why:** Blocking provider requests alone still lets scheduled jobs execute failure paths. Those paths can consume retry budgets, stamp backoff timestamps, clear historical AI-derived fields, or create repeated error noise, making recovery worse when AI is restored.

**How to apply:** Guard both the shared gateway and every direct provider request boundary. Make AI-only scheduled lanes exit before candidate reads or bookkeeping. For mixed media jobs, allow image/date recovery but preserve bullets, claims, source framing, summaries, failure reasons, and retry counters. Keep the production view pause separately controlled from the server-side AI stop so development remains available for recovery.

When the operator wants a public phase-out banner but no backend activity at all, production must be static hosting of the banner build rather than a running server with a UI gate. A server-side kill switch can stop AI, but the process can still run non-AI schedulers, source scrapers, and API routes.

**Why:** A UI-only pause previously left the production Node process active, so DataMinr, Playwright X, Truth Social, media jobs, and inbound APIs continued even though the page looked phased out.

**How to apply:** Keep the development server available, but configure production to serve only the built static directory with no production run command. Ensure the paused entry does not eagerly load the application bundle or third-party fonts, then verify its actual browser request list contains only local static assets.

For artifact-managed static production, `publicDir` resolves from the workspace root, not from the artifact directory.

**Why:** An artifact-relative `dist/...` value passed configuration validation but published without a static handler, causing every route—including `/`—to return an internal server error.

**How to apply:** Use the workspace-relative path to the artifact's built public directory and verify that `index.html` exists at that exact path before republishing. Remove production sections from sibling API artifacts when the deployment must contain no backend service.