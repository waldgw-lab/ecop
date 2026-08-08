-- ============================================================================
-- P-Scoring & Relevance Funnel — Baseline measurement queries (Phase 0)
-- Companion to docs/pscore-funnel-baseline.md
--
-- READ-ONLY. Run against PRODUCTION read replica to reproduce the baseline
-- numbers. These are the exact aggregates used in the report; re-running them
-- will drift only as the live tables change (the report fixes its snapshot at
-- 2026-06-29). Nothing here mutates data.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Section 1a — MAIN lane (Classic + Visual): headlines
-- ----------------------------------------------------------------------------
SELECT
  count(*)                                            AS total,
  round(avg(priority_score), 1)                       AS avg,
  count(*) FILTER (WHERE priority_score % 10 = 0)     AS round10,
  count(*) FILTER (WHERE priority_score = 50)         AS p50,
  min(priority_score)                                 AS min,
  max(priority_score)                                 AS max
FROM headlines;

-- Per-value histogram (main)
SELECT priority_score, count(*) AS n
FROM headlines
GROUP BY priority_score
ORDER BY priority_score DESC;


-- ----------------------------------------------------------------------------
-- Section 1b — CURATED lane: curated_items
-- ----------------------------------------------------------------------------
SELECT
  count(*)                                            AS total,
  round(avg(priority_score), 1)                       AS avg,
  count(*) FILTER (WHERE priority_score % 10 = 0)     AS round10,
  count(*) FILTER (WHERE priority_score = 50)         AS p50,
  min(priority_score)                                 AS min,
  max(priority_score)                                 AS max
FROM curated_items;

-- Per-value histogram (curated) — exposes the 55-65 compression band
SELECT priority_score, count(*) AS n
FROM curated_items
GROUP BY priority_score
ORDER BY n DESC
LIMIT 25;


-- ----------------------------------------------------------------------------
-- Section 1c — CUSTOM MCOP lane: custom_mcop_scores
-- ----------------------------------------------------------------------------
SELECT
  count(*)                                            AS total,
  round(avg(priority_score), 1)                       AS avg,
  count(*) FILTER (WHERE priority_score % 10 = 0)     AS round10,
  count(*) FILTER (WHERE priority_score = 50)         AS p50,
  min(priority_score)                                 AS min,
  max(priority_score)                                 AS max
FROM custom_mcop_scores;


-- ----------------------------------------------------------------------------
-- Section 1d — WAR lane: war_articles
-- ----------------------------------------------------------------------------
SELECT
  count(*)                                            AS total,
  round(avg(priority_score), 1)                       AS avg,
  count(*) FILTER (WHERE priority_score % 10 = 0)     AS round10,
  count(*) FILTER (WHERE priority_score = 50)         AS p50,
  min(priority_score)                                 AS min,
  max(priority_score)                                 AS max
FROM war_articles;


-- ----------------------------------------------------------------------------
-- Section 2 — Cross-batch comparability of same-event rows (curated)
-- ----------------------------------------------------------------------------
-- (a) Exact-title duplicates that survived dedup, and their score spread.
SELECT title,
       count(*)                       AS copies,
       min(priority_score)            AS min_score,
       max(priority_score)            AS max_score,
       max(priority_score) - min(priority_score) AS spread
FROM curated_items
GROUP BY title
HAVING count(*) > 1
ORDER BY spread DESC
LIMIT 20;

-- (b) Intra-cluster score spread on LIVE same-event clusters.
--     Each cluster the system itself grouped should describe one event;
--     the spread shows how incomparable the per-batch scores are.
SELECT m.cluster_id,
       count(*)                       AS members,
       min(ci.priority_score)         AS min_score,
       max(ci.priority_score)         AS max_score,
       max(ci.priority_score) - min(ci.priority_score) AS spread
FROM curated_cluster_members m
JOIN curated_items ci ON ci.id = m.curated_item_id
GROUP BY m.cluster_id
HAVING count(*) > 1
ORDER BY spread DESC;


-- ----------------------------------------------------------------------------
-- Section 5 — Decay behavior (curated, flat -10/hr, floor 20)
-- ----------------------------------------------------------------------------
-- Decay logic lives in code (server/storage.ts calculateDepreciatedPriority);
-- it is display-only and anchored to article_published_at (else scraped_at).
-- This query reproduces the decayed-vs-base distribution and floor saturation.
WITH d AS (
  SELECT
    priority_score AS base_score,
    GREATEST(
      20,
      priority_score - 10 * GREATEST(
        0,
        FLOOR(
          EXTRACT(EPOCH FROM (now() - COALESCE(article_published_at, scraped_at))) / 3600.0
        ) - 2            -- 0-2h grace before decay starts
      )
    ) AS decayed_score,
    EXTRACT(EPOCH FROM (now() - COALESCE(article_published_at, scraped_at))) / 3600.0 AS age_hours
  FROM curated_items
  WHERE COALESCE(article_published_at, scraped_at) IS NOT NULL
)
SELECT
  count(*)                                              AS total,
  round(avg(base_score), 1)                             AS avg_base,
  round(avg(decayed_score), 1)                          AS avg_decayed,
  count(*) FILTER (WHERE decayed_score = 20)            AS at_floor,
  round(100.0 * count(*) FILTER (WHERE decayed_score = 20) / count(*), 1) AS pct_at_floor,
  count(*) FILTER (WHERE age_hours < 2)                 AS age_0_2h,
  count(*) FILTER (WHERE age_hours >= 2  AND age_hours < 8)  AS age_2_8h,
  count(*) FILTER (WHERE age_hours >= 8  AND age_hours < 24) AS age_8_24h,
  count(*) FILTER (WHERE age_hours >= 24)               AS age_24h_plus
FROM d;


-- ----------------------------------------------------------------------------
-- Section 4 — Curated clustering flight recorder (persisted metrics)
-- ----------------------------------------------------------------------------
-- Rescue-lane counters (rescuedActiveOrNearDup, rescuedEventBucket, etc.) are
-- runtime-logged only and NOT persisted; what IS persisted is this table.
SELECT
  round(avg(formed_stories), 1)              AS avg_formed_stories,
  round(avg(false_merge_dissolutions), 1)    AS avg_false_merge_diss,
  round(avg(anchor_split_released), 1)       AS avg_anchor_released,
  round(avg(smart_repartitions), 1)          AS avg_smart_repart,
  round(avg(repartition_members_moved), 1)   AS avg_repart_members_moved,
  round(avg(prevented_repartitions), 1)      AS avg_prevented_repart,
  round(avg(archive_carry_forward), 1)       AS avg_archive_carry,
  round(avg(archive_absorbed), 1)            AS avg_archive_absorbed
FROM (
  SELECT * FROM curated_cluster_metrics ORDER BY id DESC LIMIT 100
) recent;
