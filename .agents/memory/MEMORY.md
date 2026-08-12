# Memory index

- [Media COP legacy transplant](media-cop-migration.md) — imported app lives whole in artifacts/media-cop and owns `/` incl. `/api`; scaffold api-server parked at /scaffold-api; avoid drizzle push here.
- [Curated enrichment retryability](curated-enrichment-retry.md) — empty AI output needs a terminal reason or stays retryable; three skip filters must agree; backfill window must exceed ingest bursts.
