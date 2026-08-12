---
name: Curated enrichment retryability
description: Rules for curated_items bullets/media enrichment — stamping, failure reasons, back-off windows
---

# Curated enrichment retryability

- A curated row is only "done" when stamping logic says so; empty AI output must either record a TERMINAL reason (`short_text`, `social`, `carried_no_bullets` in `bullets_failure_reason`) or leave the row retryable. **Why:** rows stamped `media_scraped_at` with a real image but empty bullets used to be permanently blank (~80% of Top Stories lacked bullets).
- **How to apply:** any new enrichment output added to `cacheCuratedItemMedia` must decide: terminal-with-reason (stamp done) or transient (fall to the retryable branch, bounded by MAX_MEDIA_ATTEMPTS). There are THREE skip filters that must agree: the SQL backfill filter (`staleCuratedMediaFilters`), the in-memory prefetch filter, and `enrichOneItem`'s `hasCachedMedia` — changing one without the others causes either permanent blanks or endless reselect churn.
- Backfill lookback windows must exceed the worst ingest burst: a 6h window let burst rows age out un-attempted forever (now 30h). Enrichment is network-bound (~15s–2min/item), so capacity is far below burst ingest rates.
- Operator visibility: `GET /api/admin/curated/bullets-coverage` and `POST /api/admin/curated/backfill-bullets` (admin-gated; ADMIN_PASSWORD is not set in dev, so exercise the logic via SQL or a tsx one-off instead).
