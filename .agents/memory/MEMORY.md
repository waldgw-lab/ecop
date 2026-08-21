# Memory index

- [Media COP legacy transplant](media-cop-migration.md) — imported app lives whole in artifacts/media-cop and owns `/` incl. `/api`; scaffold api-server parked at /scaffold-api; avoid drizzle push here.
- [Curated enrichment retryability](curated-enrichment-retry.md) — empty AI output needs a terminal reason or stays retryable; three skip filters must agree; backfill window must exceed ingest bursts.
- [Curated prefs sync semantics](curated-prefs-sync-semantics.md) — absent server key ≠ reset (only explicit null clears); prefs used outside /curated need their own push; route server-first.
- [Media COP timeout zombies](media-cop-timeout-zombies.md) — Promise.race timeouts need a cancellation generation or the zombie body hogs the browser lock and freezes all X lane stamps; never pkill a sibling lock-holder.
- [Media COP scrape budgets](media-cop-scrape-budgets.md) — chain lanes need sub-budgets; heavy X scrapers go on dedicated crons, never the chain tail; 0-tweet+rendered-profile = rate limit, not bad cookies.
- [Curated taxonomy & regions](curated-taxonomy-regions.md) — region is a strict allowlist at every write path; topic additions touch vocab+prompt+inference; drizzle turns JS-array params into tuples, build ARRAY[...] via sql.join.
- [Curated cluster fragmentation](curated-cluster-fragmentation.md) — missed merges = over-applied prompt rules or token morphology; fix prompts/recall, never precision bars.
- [Curated fill vs custom size](curated-fill-vs-custom-size.md) — user-set pane heights must exit the social bloc's abspos fill layout; inner max-height alone can't grow the section.
- [Media COP deployment target](media-cop-deployment.md) — prod must be single-instance Reserved VM; autoscale suspends crons → "stale after first hour" feeds; X relay never heartbeats in prod.
- [Operational AI pause](operational-ai-pause.md) — a provider kill switch must also freeze AI retry/bookkeeping state; mixed media jobs may continue image-only with pause-safe writes.
