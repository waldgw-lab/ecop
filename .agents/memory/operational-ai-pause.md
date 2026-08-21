---
name: Operational AI pause
description: Durable shutdown semantics for disabling AI without damaging recovery state or unrelated ingestion.
---

An operational AI pause must be authoritative over provider selection, retries, fallbacks, direct SDK clients, and scheduled AI work. It must not be modeled as a provider outage.

**Why:** Blocking provider requests alone still lets scheduled jobs execute failure paths. Those paths can consume retry budgets, stamp backoff timestamps, clear historical AI-derived fields, or create repeated error noise, making recovery worse when AI is restored.

**How to apply:** Guard both the shared gateway and every direct provider request boundary. Make AI-only scheduled lanes exit before candidate reads or bookkeeping. For mixed media jobs, allow image/date recovery but preserve bullets, claims, source framing, summaries, failure reasons, and retry counters. Keep the production view pause separately controlled from the server-side AI stop so development remains available for recovery.