---
name: Curated taxonomy & region canonicalization
description: How curated topic/region vocab changes must be rolled out; drizzle array-param pitfall.
---

**Rule:** Region is a strict allowlist gate at every write path (analyzer map-time, storage upsert, boot migration). Off-list values are aliased via the shared `REGION_ALIASES` map or NULLED — never persisted; raw off-list values go to the proposals log (kind 'region') for audit. "Central Asia" is deliberately unaliased (client derives it from country).

**Why:** Off-list model regions ("Asia" ≈ 743 rows) fragmented the Focus filters into duplicates of canonical theaters.

**How to apply:** Adding a topic = touch PRIMARY_TOPICS + short labels + aliases + legacy remap + keyword inference + prompt few-shots; UI facets seed from PRIMARY_TOPICS automatically, and cluster topic voting is generic over stored strings. Bounded reclassification = NULL primary_topic (AI provenance only, candidate-window rows, capped) and age classified_at past cooldown; the normal cron re-labels.

**Drizzle pitfall:** `sql\`ANY(${jsArray}::text[])\`` fails — drizzle expands a JS array param into a tuple ("cannot cast type record to text[]"). Build `ARRAY[${sql.join(vals.map(v=>sql\`${v}\`), sql\`, \`)}]::text[]` instead.
