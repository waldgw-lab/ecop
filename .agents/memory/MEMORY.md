# Memory index

- [Media COP legacy transplant](media-cop-migration.md) — imported app lives whole in artifacts/media-cop and owns `/` incl. `/api`; scaffold api-server parked at /scaffold-api; avoid drizzle push here.
- [Curated enrichment retryability](curated-enrichment-retry.md) — empty AI output needs a terminal reason or stays retryable; three skip filters must agree; backfill window must exceed ingest bursts.
- [Curated prefs sync semantics](curated-prefs-sync-semantics.md) — absent server key ≠ reset (only explicit null clears); prefs used outside /curated need their own push; route server-first.
- [Media COP scrape budgets](media-cop-scrape-budgets.md) — chain lanes need sub-budgets; heavy X scrapers go on dedicated crons, never the chain tail; 0-tweet+rendered-profile = rate limit, not bad cookies.
