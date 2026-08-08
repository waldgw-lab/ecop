import { drizzle } from 'drizzle-orm/neon-serverless';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@shared/schema';
import { sql } from 'drizzle-orm';
import { compileWatchTopic, hasKeywordGate, matchesTopic, type CompiledWatchTopic } from './watchTopicMatchCore';
import { normalizeIdentityUrl } from './urlIdentity';
import { normalizeTitle } from './titleNormalizer';
import { groupOverlayRowsByCanonical, pickOverlaySurvivor, type OverlayMergeRow } from './curatedClassificationMerge';

// Configure WebSocket for Neon
neonConfig.webSocketConstructor = ws;

export async function ensureDatabaseSchema() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set, database initialization is not ready');
    return false;
  }

  try {
    console.log('Checking database schema...');
    
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Bound DDL waits so a lock held by another running instance (e.g. the
      // dev server's scrapers inserting into the same tables) can never hang
      // schema init forever. Without this, an ALTER TABLE waiting on a lock
      // blocks startup indefinitely and the server never opens its port in
      // deployment (healthcheck 500s / crash loop).
      options: '-c lock_timeout=10000 -c statement_timeout=120000',
    });
    const db = drizzle(pool, { schema });

    // One-time cleanup: drop orphaned Polymarket tables. The Polymarket feature
    // was fully removed (code, schema, routes, frontend), but production has its
    // own DB where these tables linger as dead weight. Idempotent (IF EXISTS) so
    // this is a harmless no-op on every subsequent boot. Child (FK) table first.
    await db.execute(sql`DROP TABLE IF EXISTS polymarket_price_history CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS polymarket_bets CASCADE`);

    // Check if blocked_headlines table exists
    const tablesResult = await db.execute(sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('users', 'headlines', 'blocked_headlines', 'truth_social_posts', 'x_posts', 'rapidresponse_posts', 'dow_response_posts', 'first_alerts', 'manual_submissions', 'social_bot_posts')
    `);

    const existingTables = tablesResult.rows.map((row: any) => row.table_name);
    console.log('Existing tables:', existingTables);

    const requiredTables = [
      'users',
      'headlines',
      'blocked_headlines',
      'truth_social_posts',
      'x_posts',
      'sentdefender_posts',
      'rapidresponse_posts',
      'dow_response_posts',
      'first_alerts',
      'manual_submissions',
      'social_bot_posts'
    ];

    const missingTables = requiredTables.filter(table => !existingTables.includes(table));

    if (missingTables.length > 0) {
      console.log(`Creating missing tables: ${missingTables.join(', ')}`);
      
      // Create tables using raw SQL to ensure they exist
      if (missingTables.includes('users')) {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS users (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL
          )
        `);
      }

      if (missingTables.includes('headlines')) {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS headlines (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            title TEXT NOT NULL UNIQUE,
            normalized_title TEXT NOT NULL,
            url TEXT NOT NULL,
            category TEXT NOT NULL,
            source TEXT NOT NULL,
            summary TEXT NOT NULL,
            scraped_at TIMESTAMP NOT NULL DEFAULT NOW(),
            article_published_at TIMESTAMP,
            priority_score INTEGER NOT NULL DEFAULT 0,
            priority_override INTEGER,
            tags TEXT[] NOT NULL DEFAULT '{}'
          )
        `);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS scraped_at_idx ON headlines (scraped_at DESC)`);
      }

      if (missingTables.includes('blocked_headlines')) {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS blocked_headlines (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            normalized_title TEXT NOT NULL UNIQUE,
            blocked_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
      }

      if (missingTables.includes('truth_social_posts')) {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS truth_social_posts (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            post_id TEXT NOT NULL UNIQUE,
            content TEXT NOT NULL,
            posted_at TIMESTAMP NOT NULL,
            truth_social_url TEXT NOT NULL,
            scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS posted_at_idx ON truth_social_posts (posted_at DESC)`);
      }

      if (missingTables.includes('x_posts')) {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS x_posts (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            post_id TEXT NOT NULL UNIQUE,
            content TEXT NOT NULL,
            posted_at TIMESTAMP NOT NULL,
            x_url TEXT NOT NULL,
            scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS x_posted_at_idx ON x_posts (posted_at DESC)`);
      }

      if (missingTables.includes('rapidresponse_posts')) {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS rapidresponse_posts (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            post_id TEXT NOT NULL UNIQUE,
            content TEXT NOT NULL,
            posted_at TIMESTAMP NOT NULL,
            x_url TEXT NOT NULL,
            scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS rapidresponse_posted_at_idx ON rapidresponse_posts (posted_at DESC)`);
      }

      if (missingTables.includes('dow_response_posts')) {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS dow_response_posts (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            post_id TEXT NOT NULL UNIQUE,
            content TEXT NOT NULL,
            posted_at TIMESTAMP NOT NULL,
            x_url TEXT NOT NULL,
            scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS dow_response_posted_at_idx ON dow_response_posts (posted_at DESC)`);
      }

      if (missingTables.includes('sentdefender_posts')) {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS sentdefender_posts (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            post_id TEXT NOT NULL UNIQUE,
            content TEXT NOT NULL,
            posted_at TIMESTAMP NOT NULL,
            x_url TEXT NOT NULL,
            image_url TEXT,
            video_url TEXT,
            scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS sentdefender_posted_at_idx ON sentdefender_posts (posted_at DESC)`);
        console.log('✅ Created sentdefender_posts table');
      }

      if (missingTables.includes('first_alerts')) {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS first_alerts (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            alert_id TEXT NOT NULL UNIQUE,
            headline TEXT NOT NULL,
            sub_headline TEXT,
            alert_topics TEXT[] NOT NULL DEFAULT '{}',
            alert_lists TEXT[] NOT NULL DEFAULT '{}',
            alert_type TEXT,
            location TEXT,
            latitude TEXT,
            longitude TEXT,
            public_post_link TEXT,
            public_post_text TEXT,
            terms_of_use TEXT,
            event_time TIMESTAMP,
            scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS first_alerts_event_time_idx ON first_alerts (event_time DESC)`);
      }

      if (missingTables.includes('manual_submissions')) {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS manual_submissions (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            summary TEXT,
            pdf_url TEXT,
            category TEXT NOT NULL DEFAULT 'Manual Submission',
            source TEXT NOT NULL DEFAULT 'Manual Entry',
            submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
            article_published_at TIMESTAMP,
            priority_score INTEGER NOT NULL DEFAULT 50,
            tags TEXT[] NOT NULL DEFAULT '{}'
          )
        `);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS manual_submitted_at_idx ON manual_submissions (submitted_at DESC)`);
      }

      if (missingTables.includes('social_bot_posts')) {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS social_bot_posts (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            post_id TEXT NOT NULL,
            source TEXT NOT NULL,
            chat_message_id VARCHAR,
            posted_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS social_bot_posted_at_idx ON social_bot_posts (posted_at DESC)`);
        await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS social_bot_post_id_source_idx ON social_bot_posts (post_id, source)`);
      }

      console.log('✅ Database schema initialized successfully');
    } else {
      console.log('✅ All required tables exist');
    }

    // ---------------------------------------------------------------------
    // Comprehensive table backfill. Every pgTable defined in shared/schema.ts
    // (and the integration-owned tables it re-exports) must be created here so
    // a fresh/reset database boots with no 42P01 ("relation does not exist")
    // errors. Tables are created idempotently (CREATE TABLE IF NOT EXISTS) and
    // in foreign-key dependency order so referencing tables come after their
    // targets. This runs BEFORE the ALTER / FK-dependent CREATE statements
    // below (e.g. article_quotes REFERENCES team_submissions), which would
    // otherwise fail on a clean boot.
    // ---------------------------------------------------------------------
    try {
      // --- Team chat + subjects (referenced by many tables) ---
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS team_chat_messages (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id VARCHAR NOT NULL,
          user_name TEXT NOT NULL,
          user_profile_image TEXT,
          message TEXT NOT NULL,
          client_request_id VARCHAR,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`ALTER TABLE team_chat_messages ADD COLUMN IF NOT EXISTS client_request_id VARCHAR`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS team_chat_created_at_idx ON team_chat_messages (created_at DESC)`);
      // PostgreSQL UNIQUE permits multiple NULLs, so a normal composite unique
      // index protects reviewed request identities while ordinary chat remains
      // unrestricted. Recreate to heal any earlier partial-index variant: Drizzle
      // ON CONFLICT needs a matching non-partial conflict target.
      await db.execute(sql`DROP INDEX IF EXISTS team_chat_client_request_uniq`);
      await db.execute(sql`CREATE UNIQUE INDEX team_chat_client_request_uniq ON team_chat_messages (user_id, client_request_id)`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS team_subjects (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          origin TEXT NOT NULL DEFAULT 'ai',
          created_by VARCHAR,
          is_active BOOLEAN NOT NULL DEFAULT true,
          position INTEGER NOT NULL DEFAULT 0,
          category TEXT,
          is_priority_watch BOOLEAN NOT NULL DEFAULT false,
          is_bolo_watch BOOLEAN NOT NULL DEFAULT false,
          watch_keywords TEXT[] NOT NULL DEFAULT '{}'::text[],
          estimated_duration_days INTEGER,
          estimated_active_until TIMESTAMP,
          auto_archive_reason TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS team_subjects_name_idx ON team_subjects (name)`);
      // Unified watch-topic columns (idempotent for existing databases).
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS is_priority_watch BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS is_bolo_watch BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS watch_keywords TEXT[] NOT NULL DEFAULT '{}'::text[]`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS topic_id VARCHAR`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS focus_area TEXT`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS estimated_duration_days INTEGER`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS estimated_active_until TIMESTAMP`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS auto_archive_reason TEXT`);
      // Backfill behavior flags from the legacy single-valued category.
      await db.execute(sql`UPDATE team_subjects SET is_priority_watch = true WHERE category = 'joe_priority' AND is_priority_watch = false`);
      await db.execute(sql`UPDATE team_subjects SET is_bolo_watch = true WHERE category = 'bolo' AND is_bolo_watch = false`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS team_submissions (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          chat_message_id VARCHAR REFERENCES team_chat_messages(id),
          submitted_by VARCHAR NOT NULL,
          submitted_by_name TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_url TEXT NOT NULL,
          source_name TEXT,
          headline TEXT NOT NULL,
          summary TEXT NOT NULL,
          full_text TEXT,
          subject_id VARCHAR REFERENCES team_subjects(id),
          flash_subject_id VARCHAR REFERENCES team_subjects(id),
          cjcs_subject_id VARCHAR REFERENCES team_subjects(id),
          joe_priority_subject_id VARCHAR REFERENCES team_subjects(id),
          priority_score INTEGER DEFAULT 0,
          score_source TEXT DEFAULT 'ai',
          score_retry_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          published_at TIMESTAMP,
          mcop_submitted_at TIMESTAMP,
          mcop_submitted_by VARCHAR,
          joe_emailed_at TIMESTAMP,
          joe_emailed_by VARCHAR,
          deleted_at TIMESTAMP,
          deleted_by VARCHAR,
          cluster_id VARCHAR,
          is_cluster_representative BOOLEAN NOT NULL DEFAULT false,
          is_questionable BOOLEAN NOT NULL DEFAULT false,
          is_mata_osint BOOLEAN NOT NULL DEFAULT false,
          mata_osint_subject_id VARCHAR REFERENCES team_subjects(id),
          flight_tracking_posted_at TIMESTAMP,
          og_image_url TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS team_submissions_created_at_idx ON team_submissions (created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS team_submissions_subject_id_idx ON team_submissions (subject_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS team_submissions_cluster_id_idx ON team_submissions (cluster_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS team_submissions_joe_priority_processed_idx ON team_submissions (joe_priority_subject_id, created_at DESC) WHERE status = 'processed' AND deleted_at IS NULL`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS team_submission_comments (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          submission_id VARCHAR NOT NULL REFERENCES team_submissions(id) ON DELETE CASCADE,
          user_id VARCHAR NOT NULL,
          user_name TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS team_submission_reads (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id VARCHAR NOT NULL,
          submission_id VARCHAR NOT NULL REFERENCES team_submissions(id) ON DELETE CASCADE,
          read_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      // --- Headline clustering + quarantine + filter/scrape metadata ---
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS headline_clusters (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          is_user_created BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS quarantined_headlines (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT NOT NULL,
          normalized_title TEXT NOT NULL UNIQUE,
          url TEXT NOT NULL,
          source TEXT NOT NULL,
          reason TEXT NOT NULL,
          scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS quarantined_scraped_at_idx ON quarantined_headlines (scraped_at DESC)`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS filter_metrics (
          id VARCHAR PRIMARY KEY DEFAULT 'global',
          finance_weather_rescued INTEGER NOT NULL DEFAULT 0,
          finance_weather_dropped INTEGER NOT NULL DEFAULT 0,
          quarantined INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS scrape_metadata (
          id VARCHAR PRIMARY KEY DEFAULT 'global',
          last_scrape_time TIMESTAMP NOT NULL DEFAULT NOW(),
          headlines_last_scrape_time TIMESTAMP,
          headlines_last_count INTEGER NOT NULL DEFAULT 0,
          truth_social_last_scrape_time TIMESTAMP,
          truth_social_last_count INTEGER NOT NULL DEFAULT 0,
          x_posts_last_scrape_time TIMESTAMP,
          x_posts_last_count INTEGER NOT NULL DEFAULT 0,
          x_posts_consecutive_empty INTEGER NOT NULL DEFAULT 0,
          rapid_response_last_scrape_time TIMESTAMP,
          rapid_response_last_count INTEGER NOT NULL DEFAULT 0,
          rapid_response_consecutive_empty INTEGER NOT NULL DEFAULT 0,
          dow_response_last_scrape_time TIMESTAMP,
          dow_response_last_count INTEGER NOT NULL DEFAULT 0,
          dow_response_consecutive_empty INTEGER NOT NULL DEFAULT 0,
          sent_defender_last_scrape_time TIMESTAMP,
          sent_defender_last_count INTEGER NOT NULL DEFAULT 0,
          sent_defender_consecutive_empty INTEGER NOT NULL DEFAULT 0,
          osint_last_scrape_time TIMESTAMP,
          osint_last_count INTEGER NOT NULL DEFAULT 0,
          osint_consecutive_empty INTEGER NOT NULL DEFAULT 0,
          influencer_x_last_scrape_time TIMESTAMP,
          influencer_x_last_count INTEGER NOT NULL DEFAULT 0,
          influencer_x_consecutive_empty INTEGER NOT NULL DEFAULT 0,
          first_alerts_last_scrape_time TIMESTAMP,
          first_alerts_last_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          last_error_time TIMESTAMP,
          scrape_status TEXT NOT NULL DEFAULT 'idle',
          last_blocking_recovery_time TIMESTAMP,
          blocking_recovery_count INTEGER NOT NULL DEFAULT 0
        )
      `);

      // --- Durable relay heartbeats (Task #340) ---
      // One row per relay ('x' / 'truth-social'). Lets the in-memory relay
      // heartbeat survive a redeploy so MCOP stays in WATCHDOG mode instead of
      // falling back to PRIMARY (scrapers) after every restart.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS relay_heartbeats (
          relay VARCHAR PRIMARY KEY,
          last_heartbeat_at TIMESTAMP NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          outage_escalated_at TIMESTAMP
        )
      `);

      // Task #1020: one-shot relay-outage escalation marker (nullable — set when
      // the outage SMS for the current episode was sent, cleared on recovery).
      await db.execute(sql`
        ALTER TABLE relay_heartbeats ADD COLUMN IF NOT EXISTS outage_escalated_at TIMESTAMP
      `);

      // --- Durable app-level feature flags ---
      // Single-row (id='global') table that persists in-memory feature flags
      // across restarts so admin toggles (e.g. Watch Topic steering) don't
      // silently reset to OFF on every redeploy.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS app_flags (
          id VARCHAR PRIMARY KEY DEFAULT 'global',
          watch_topic_steering_enabled BOOLEAN NOT NULL DEFAULT false,
          clustering_enabled BOOLEAN NOT NULL DEFAULT true,
          topic_clustering_enabled BOOLEAN NOT NULL DEFAULT true,
          drudge_scraper_enabled BOOLEAN NOT NULL DEFAULT false,
          joe_priority_matching_enabled BOOLEAN NOT NULL DEFAULT true,
          bot_states JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      // Idempotent column backfill for pre-existing app_flags tables. Defaults
      // match the in-memory defaults in server/clusterConfig.ts (both ON).
      await db.execute(sql`ALTER TABLE app_flags ADD COLUMN IF NOT EXISTS clustering_enabled BOOLEAN NOT NULL DEFAULT true`);
      await db.execute(sql`ALTER TABLE app_flags ADD COLUMN IF NOT EXISTS topic_clustering_enabled BOOLEAN NOT NULL DEFAULT true`);
      // Defaults match server/scraperConfig.ts (Drudge OFF) and
      // server/clusterConfig.ts (Joe Priority matching ON).
      await db.execute(sql`ALTER TABLE app_flags ADD COLUMN IF NOT EXISTS drudge_scraper_enabled BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE app_flags ADD COLUMN IF NOT EXISTS joe_priority_matching_enabled BOOLEAN NOT NULL DEFAULT true`);
      // Per-bot enable/disable overrides (server/scraperConfig.ts). Empty
      // object = all bots on their in-memory defaults.
      await db.execute(sql`ALTER TABLE app_flags ADD COLUMN IF NOT EXISTS bot_states JSONB NOT NULL DEFAULT '{}'::jsonb`);
      // Same-event duplicate reconciliation (curated one-merge-per-pass backstop).
      // Dark-launched OFF by default (matches server/clusterConfig.ts).
      await db.execute(sql`ALTER TABLE app_flags ADD COLUMN IF NOT EXISTS curated_missed_merge_reconcile_enabled BOOLEAN NOT NULL DEFAULT false`);

      // --- Durable RSS feed-health state (Task #553) ---
      // One row per feed URL. Lets the per-feed unhealthy streak / last outcome
      // survive a redeploy so a feed that has been dead for days still shows as
      // stale/broken on the Coverage tab immediately after a restart, instead of
      // resetting to "healthy" and going blind until 3 fresh cycles re-detect it.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS feed_health_state (
          url VARCHAR PRIMARY KEY,
          source_name TEXT NOT NULL,
          scope VARCHAR NOT NULL,
          last_outcome VARCHAR NOT NULL,
          last_detail TEXT,
          consecutive_unhealthy INTEGER NOT NULL DEFAULT 0,
          recent TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
          last_healthy_at TIMESTAMP,
          last_seen_at TIMESTAMP NOT NULL,
          total_cycles INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      // --- Meltwater run telemetry (Task #543) ---
      // Single-row snapshot of the most recent Meltwater bot run. Persisted so
      // the Coverage tab health card shows real status after redeploys. Never
      // stores the API key, request headers, or raw response bodies.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS meltwater_telemetry (
          id VARCHAR PRIMARY KEY DEFAULT 'global',
          last_run_at TIMESTAMP NOT NULL,
          outcome VARCHAR(32) NOT NULL,
          http_status INTEGER,
          ingested INTEGER NOT NULL DEFAULT 0,
          skipped INTEGER NOT NULL DEFAULT 0,
          day_remaining INTEGER,
          day_limit INTEGER,
          day_reset_at TIMESTAMP,
          minute_remaining INTEGER,
          overflow BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      // Task #607: window-overflow observability column on existing deployments.
      await db.execute(sql`
        ALTER TABLE meltwater_telemetry
          ADD COLUMN IF NOT EXISTS overflow BOOLEAN NOT NULL DEFAULT FALSE
      `);

      // --- Per-source curated-intake telemetry (Task #950) ---
      // One row per source canonical name, last-write-wins after each ingest pass.
      // Captures the full admission funnel (fetched → kept → ingested, plus each
      // drop reason) so the Coverage tab can surface WHY a configured source is
      // delivering zero rows instead of just flagging it as silent.
      // CURATED-ONLY observability: never read by any main-feed path.
      // Only drop and recreate when the table has the OLD single-column primary key
      // (source_name alone, from the initial Task #950 deploy). That schema has no
      // historical rows worth preserving because the old migration itself dropped on
      // every restart. The new composite PK (source_name, last_label) keeps rows
      // durable across restarts — so once migrated we NEVER drop again.
      await db.execute(sql`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_name      = kcu.table_name
            WHERE tc.table_name       = 'curated_intake_telemetry'
              AND tc.constraint_type  = 'PRIMARY KEY'
            GROUP BY tc.constraint_name
            HAVING COUNT(*) = 1
          ) THEN
            DROP TABLE curated_intake_telemetry;
          END IF;
        END $$;
        CREATE TABLE IF NOT EXISTS curated_intake_telemetry (
          source_name VARCHAR NOT NULL,
          last_label TEXT NOT NULL,
          last_run_at TIMESTAMP NOT NULL,
          fetched INTEGER NOT NULL DEFAULT 0,
          kept INTEGER NOT NULL DEFAULT 0,
          aged INTEGER NOT NULL DEFAULT 0,
          dup_in_pass INTEGER NOT NULL DEFAULT 0,
          ingested INTEGER NOT NULL DEFAULT 0,
          drop_invalid INTEGER NOT NULL DEFAULT 0,
          drop_dup_url INTEGER NOT NULL DEFAULT 0,
          drop_dup_batch INTEGER NOT NULL DEFAULT 0,
          drop_relevance_rejected INTEGER NOT NULL DEFAULT 0,
          drop_relevance_finance INTEGER NOT NULL DEFAULT 0,
          drop_gate_unscored INTEGER NOT NULL DEFAULT 0,
          drop_fuzzy_dup INTEGER NOT NULL DEFAULT 0,
          drop_blocked INTEGER NOT NULL DEFAULT 0,
           invalid_only_streak INTEGER NOT NULL DEFAULT 0,
          deferred INTEGER NOT NULL DEFAULT 0,
          fetch_failures INTEGER NOT NULL DEFAULT 0,
          last_fetch_error TEXT,
          admission_pending BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          PRIMARY KEY (source_name, last_label)
        )
      `);
      // Honest-funnel columns (Task #1114) on pre-existing deployments:
      // deferred-to-next-pass counts, per-feed fetch-failure telemetry, and the
      // mid-pass admission_pending marker. Idempotent ADD COLUMN IF NOT EXISTS
      // so existing telemetry rows survive (never drop/recreate this table).
      await db.execute(sql`
        ALTER TABLE curated_intake_telemetry
          ADD COLUMN IF NOT EXISTS deferred INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS fetch_failures INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS last_fetch_error TEXT,
          ADD COLUMN IF NOT EXISTS admission_pending BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS invalid_only_streak INTEGER NOT NULL DEFAULT 0
      `);

      // Persisted curated gate verdicts (Task #1083): durable mirror of the
      // in-memory gate-verdict memo cache so a redeploy doesn't cold-start it
      // and re-pay the AI gate for the whole RSS backlog. TTL via expires_at.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_gate_verdicts (
          title TEXT PRIMARY KEY,
          verdict JSONB NOT NULL,
          expires_at TIMESTAMP NOT NULL
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_gate_verdicts_expires_idx ON curated_gate_verdicts (expires_at)`);

      // --- Per-outlet news bot dedup tables (identical shape) ---
      const botPostTables: { table: string; prefix: string }[] = [
        { table: 'drudge_bot_posts', prefix: 'drudge_bot' },
        { table: 'bbc_bot_posts', prefix: 'bbc_bot' },
        { table: 'fox_news_bot_posts', prefix: 'fox_news_bot' },
        { table: 'abc_news_bot_posts', prefix: 'abc_news_bot' },
        { table: 'cbs_news_bot_posts', prefix: 'cbs_news_bot' },
        { table: 'nbc_news_bot_posts', prefix: 'nbc_news_bot' },
        { table: 'ap_news_bot_posts', prefix: 'ap_news_bot' },
        { table: 'reuters_bot_posts', prefix: 'reuters_bot' },
      ];
      for (const { table, prefix } of botPostTables) {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS ${sql.raw(table)} (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            article_url TEXT NOT NULL UNIQUE,
            article_title TEXT NOT NULL,
            summary TEXT NOT NULL,
            chat_message_id VARCHAR REFERENCES team_chat_messages(id),
            posted_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS ${sql.raw(prefix + '_posted_at_idx')} ON ${sql.raw(table)} (posted_at DESC)`);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS ${sql.raw(prefix + '_url_idx')} ON ${sql.raw(table)} (article_url)`);
      }

      // rss_bot_posts has an extra source_name column + index
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS rss_bot_posts (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          article_url TEXT NOT NULL UNIQUE,
          article_title TEXT NOT NULL,
          summary TEXT NOT NULL,
          source_name TEXT NOT NULL,
          chat_message_id VARCHAR REFERENCES team_chat_messages(id),
          posted_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS rss_bot_posted_at_idx ON rss_bot_posts (posted_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS rss_bot_url_idx ON rss_bot_posts (article_url)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS rss_bot_source_idx ON rss_bot_posts (source_name)`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS blocked_bot_content (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          normalized_url TEXT NOT NULL UNIQUE,
          source_type TEXT NOT NULL,
          headline TEXT,
          blocked_by VARCHAR NOT NULL,
          blocked_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS blocked_bot_content_url_idx ON blocked_bot_content (normalized_url)`);

      // --- Team members ---
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS team_members (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          email TEXT NOT NULL UNIQUE,
          added_by TEXT NOT NULL,
          added_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS team_members_email_idx ON team_members (email)`);

      // Team members whose access has been revoked. Removed on every startup so
      // the change propagates to production on the next deploy (production is
      // read-only to ad-hoc tooling, so this is the supported removal path).
      // NOTE: this is an always-on revoke list — these emails cannot be re-added
      // through the normal "Add member" UI without first removing them here and
      // republishing, otherwise the next restart would re-delete them.
      const teamRevokedEmails = [
        '42bummy@gmail.com',
        'annabel.g.monroe.mil@mail.mil',
        'benjamin.applebaum.civ@mail.mil',
        'christopher.a.macak.mil@mail.mil',
        'haley.h.nystrom.civ@mail.mil',
        'jason.a.lambert.mil@mail.mil',
        'lauren.m.spaziano.mil@mail.mil',
        'olivia.a.lynch2.mil@mail.mil',
        'william.j.dixon60.civ@mail.mil',
        'leah.m.ganoni.mil@mail.mil',
        'michael.f.wolff2.mil@us.navy.mil',
        'emily.a.heddon.civ@mail.mil',
        'joshua.j.pena8.mil@mail.mil',
      ];
      for (const email of teamRevokedEmails) {
        await db.execute(sql`
          DELETE FROM team_members WHERE lower(email) = ${email}
        `);
      }
      console.log(`✅ Reconciled team_members revoke list (${teamRevokedEmails.length} emails)`);

      // --- War dashboard tables ---
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS war_articles (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          image_url TEXT,
          summary_bullets TEXT[],
          source TEXT,
          priority_score INTEGER NOT NULL DEFAULT 50,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS war_settings (
          id VARCHAR PRIMARY KEY DEFAULT 'global',
          feed_from_mcop BOOLEAN NOT NULL DEFAULT true,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS ai_settings (
          id VARCHAR PRIMARY KEY DEFAULT 'global',
          provider VARCHAR NOT NULL DEFAULT 'openrouter',
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS war_overrides (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          headline_id VARCHAR NOT NULL UNIQUE,
          title TEXT,
          image_url TEXT,
          summary_bullets TEXT[],
          priority_score INTEGER,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      // --- Custom MCOP tables ---
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS custom_mcops (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          general_prompt TEXT NOT NULL DEFAULT '',
          look_for_now TEXT NOT NULL DEFAULT '',
          exclude TEXT NOT NULL DEFAULT '',
          feed_from_mcop BOOLEAN NOT NULL DEFAULT true,
          admin_password_hash TEXT,
          created_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS custom_mcop_articles (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          mcop_id VARCHAR NOT NULL,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          image_url TEXT,
          summary_bullets TEXT[],
          source TEXT,
          priority_score INTEGER NOT NULL DEFAULT 50,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS custom_mcop_articles_mcop_idx ON custom_mcop_articles (mcop_id)`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS custom_mcop_screenshots (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          mcop_id VARCHAR NOT NULL,
          caption TEXT NOT NULL,
          image_url TEXT NOT NULL,
          source_label TEXT,
          link_url TEXT,
          priority_score INTEGER NOT NULL DEFAULT 50,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS custom_mcop_screenshots_mcop_idx ON custom_mcop_screenshots (mcop_id)`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS custom_mcop_scores (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          mcop_id VARCHAR NOT NULL,
          source_type TEXT NOT NULL,
          source_id VARCHAR NOT NULL,
          priority_score INTEGER NOT NULL DEFAULT 0,
          is_relevant BOOLEAN NOT NULL DEFAULT true,
          reason TEXT,
          scored_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS custom_mcop_scores_uniq_idx ON custom_mcop_scores (mcop_id, source_type, source_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS custom_mcop_scores_mcop_idx ON custom_mcop_scores (mcop_id)`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS custom_mcop_hidden_items (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          mcop_id VARCHAR NOT NULL,
          source_type TEXT NOT NULL,
          source_id VARCHAR NOT NULL,
          hidden_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS custom_mcop_hidden_items_uniq_idx ON custom_mcop_hidden_items (mcop_id, source_type, source_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS custom_mcop_hidden_items_mcop_idx ON custom_mcop_hidden_items (mcop_id)`);

      // --- Integration-owned tables re-exported through the schema namespace
      //     (shared/models/chat.ts + shared/models/auth.ts). These are queried
      //     by endpoints (MCOP bot archive, Replit Auth) but were never created
      //     here, so a fresh DB would 42P01 on them too. ---
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS conversations (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS replit_sessions (
          sid VARCHAR PRIMARY KEY,
          sess JSONB NOT NULL,
          expire TIMESTAMP NOT NULL
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_replit_session_expire" ON replit_sessions (expire)`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS replit_users (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          email VARCHAR UNIQUE,
          first_name VARCHAR,
          last_name VARCHAR,
          profile_image_url VARCHAR,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Per-user Curated View preferences store. Keyed by the Replit OIDC `sub`
      // (same as replit_users.id). Stores a compact JSONB payload of all
      // user-configurable localStorage settings so the layout follows the user
      // across devices/browsers. Curated-lane only — never read by any other feed.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_user_preferences (
          user_id VARCHAR PRIMARY KEY REFERENCES replit_users(id) ON DELETE CASCADE,
          prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      console.log('✅ Ensured all schema-defined tables exist (comprehensive backfill)');
    } catch (error) {
      console.error('❌ Error ensuring schema-defined tables exist:', error);
      throw error;
    }

    // Add priority_override_at column to headlines if it doesn't exist
    try {
      await db.execute(sql`
        ALTER TABLE headlines 
        ADD COLUMN IF NOT EXISTS priority_override_at TIMESTAMP
      `);
      console.log('✅ Added priority_override_at column to headlines table');
    } catch (error) {
      console.log('Column priority_override_at already exists in headlines table');
    }

    // Add priority_override_at column to manual_submissions if it doesn't exist
    try {
      await db.execute(sql`
        ALTER TABLE manual_submissions 
        ADD COLUMN IF NOT EXISTS priority_override_at TIMESTAMP
      `);
      console.log('✅ Added priority_override_at column to manual_submissions table');
    } catch (error) {
      console.log('Column priority_override_at already exists in manual_submissions table');
    }

    // Add stream media columns to manual_submissions table
    try {
      await db.execute(sql`
        ALTER TABLE manual_submissions 
        ADD COLUMN IF NOT EXISTS og_image_url TEXT,
        ADD COLUMN IF NOT EXISTS video_url TEXT,
        ADD COLUMN IF NOT EXISTS summary_bullets TEXT[],
        ADD COLUMN IF NOT EXISTS media_scraped_at TIMESTAMP
      `);
      console.log('✅ Added stream media columns to manual_submissions table');
    } catch (error) {
      console.log('Stream media columns already exist in manual_submissions table');
    }

    // Add full_text column to manual_submissions (bot post-time article text;
    // NULL = scrape failed → summary is title-derived and eligible for upgrade
    // by the stream-prefetch enrichment when article text is later recovered).
    try {
      await db.execute(sql`
        ALTER TABLE manual_submissions
        ADD COLUMN IF NOT EXISTS full_text TEXT
      `);
      console.log('✅ Added full_text column to manual_submissions table');
    } catch (error) {
      console.log('full_text column already exists in manual_submissions table');
    }

    // Real article publish date for team-promoted / manual items. Previously
    // manual_submissions had NO publish-date column, so the feed mapping
    // fabricated one from submitted_at — a 21h-old DW article showed as
    // trusted "Published 16 min ago" on Curated. NULL = no trusted signal
    // (UI honestly shows "First seen").
    try {
      await db.execute(sql`
        ALTER TABLE manual_submissions
        ADD COLUMN IF NOT EXISTS article_published_at TIMESTAMP
      `);
      console.log('✅ Added article_published_at column to manual_submissions table');
    } catch (error) {
      console.log('article_published_at column already exists in manual_submissions table');
    }

    // Boot-time heal 1/3: backfill manual_submissions.article_published_at
    // from the team submission that carried the article in (RSS pubDate /
    // trusted link-analysis extraction). MIN() = the earliest publish claim
    // per URL — the most conservative choice, can only make an item look
    // OLDER, never fresher. Idempotent (IS NULL guard) and re-run every boot
    // so reviewed-flow rows (which write null) get healed once a dated bot
    // copy of the same URL exists. Bounded windows keep the scan cheap.
    try {
      const healed = await db.execute(sql`
        UPDATE manual_submissions ms
        SET article_published_at = sub.pub
        FROM (
          SELECT source_url, MIN(published_at) AS pub
          FROM team_submissions
          WHERE published_at IS NOT NULL
            AND published_at > '2000-01-01'
            AND published_at <= NOW() + INTERVAL '24 hours'
            AND created_at > NOW() - INTERVAL '60 days'
          GROUP BY source_url
        ) sub
        WHERE ms.url = sub.source_url
          AND ms.article_published_at IS NULL
          AND ms.submitted_at > NOW() - INTERVAL '30 days'
      `);
      const n = (healed as any)?.rowCount ?? 0;
      if (n > 0) console.log(`✅ Backfilled article_published_at on ${n} manual_submissions from team_submissions`);
    } catch (error) {
      console.log('manual_submissions article_published_at backfill skipped:', (error as Error).message);
    }

    // Boot-time heal 2/3: curated_items rows whose article_published_at was
    // fabricated from the team submission's INGEST time (the old
    // `s.publishedAt ?? s.createdAt` intake fallback). Identified precisely:
    // the stored stamp byte-equals the team sub's created_at at millisecond
    // precision (the JS Date round-trip truncates Postgres µs → ms, hence
    // date_trunc). Replace with the real published_at when the team sub has
    // one, else NULL (honest "First seen"). Idempotent: once rewritten, the
    // ms-equality no longer matches.
    try {
      const healed = await db.execute(sql`
        UPDATE curated_items ci
        SET article_published_at = CASE
          WHEN ts.published_at IS NOT NULL
           AND ts.published_at > '2000-01-01'
           AND ts.published_at <= NOW() + INTERVAL '24 hours'
          THEN ts.published_at
          ELSE NULL
        END
        FROM team_submissions ts
        WHERE ci.url = ts.source_url
          AND ci.article_published_at IS NOT NULL
          AND date_trunc('milliseconds', ts.created_at) = ci.article_published_at
          AND ts.created_at > NOW() - INTERVAL '60 days'
      `);
      const n = (healed as any)?.rowCount ?? 0;
      if (n > 0) console.log(`✅ Healed ${n} curated_items rows with ingest-time stamped as article_published_at (team-sub intake)`);
    } catch (error) {
      console.log('curated_items team-sub publish-date heal skipped:', (error as Error).message);
    }

    // Boot-time heal 3/3: same class of fake stamp from the headlines-parity
    // intake (the old `h.articlePublishedAt ?? h.scrapedAt` fallback) — the
    // headline row itself has NO real publish date, so the curated copy must
    // not claim one either.
    try {
      const healed = await db.execute(sql`
        UPDATE curated_items ci
        SET article_published_at = NULL
        FROM headlines h
        WHERE ci.url = h.url
          AND h.article_published_at IS NULL
          AND ci.article_published_at IS NOT NULL
          AND date_trunc('milliseconds', h.scraped_at) = ci.article_published_at
          AND h.scraped_at > NOW() - INTERVAL '60 days'
      `);
      const n = (healed as any)?.rowCount ?? 0;
      if (n > 0) console.log(`✅ Healed ${n} curated_items rows with scrape-time stamped as article_published_at (headlines intake)`);
    } catch (error) {
      console.log('curated_items headlines publish-date heal skipped:', (error as Error).message);
    }

    // Add full_text column to headlines (same semantics as manual_submissions:
    // NULL = bot/scraper had no article text at write time → summary is a
    // title-derived fallback eligible for upgrade by stream-prefetch enrichment).
    try {
      await db.execute(sql`
        ALTER TABLE headlines
        ADD COLUMN IF NOT EXISTS full_text TEXT
      `);
      console.log('✅ Added full_text column to headlines table');
    } catch (error) {
      console.log('full_text column already exists in headlines table');
    }

    // Add account_category column to x_posts table (separates 'default' vs 'influencer' feeds)
    try {
      await db.execute(sql`
        ALTER TABLE x_posts
        ADD COLUMN IF NOT EXISTS account_category TEXT NOT NULL DEFAULT 'default'
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS x_account_category_idx ON x_posts (account_category)`);
      console.log('✅ Added account_category column to x_posts table');
    } catch (error) {
      console.log('Column account_category already exists in x_posts table');
    }

    // Create social_bot_posts table for tracking reposted social media posts
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS social_bot_posts (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          post_id TEXT NOT NULL,
          source TEXT NOT NULL,
          chat_message_id VARCHAR REFERENCES team_chat_messages(id),
          posted_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS social_bot_posted_at_idx ON social_bot_posts (posted_at DESC)`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS social_bot_post_id_source_idx ON social_bot_posts (post_id, source)`);
      console.log('✅ Created social_bot_posts table');
    } catch (error) {
      console.log('Table social_bot_posts already exists or error:', error);
    }

    // CRITICAL: Verify truth_social_posts table schema matches expected structure
    // This handles cases where production database might have outdated schema
    try {
      console.log('Verifying truth_social_posts table schema...');
      
      // Check if table exists
      const tableCheck = await db.execute(sql`
        SELECT COUNT(*) as count 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'truth_social_posts'
      `);
      
      const tableExists = (tableCheck.rows[0] as any)?.count > 0;
      
      if (!tableExists) {
        console.log('Creating truth_social_posts table (not found)...');
        await db.execute(sql`
          CREATE TABLE truth_social_posts (
            id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
            post_id TEXT NOT NULL UNIQUE,
            content TEXT NOT NULL,
            posted_at TIMESTAMP NOT NULL,
            truth_social_url TEXT NOT NULL,
            scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS posted_at_idx ON truth_social_posts (posted_at DESC)`);
        console.log('✅ Created truth_social_posts table');
      } else {
        // Table exists - verify all required columns exist
        const columnsCheck = await db.execute(sql`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'truth_social_posts'
        `);
        
        const existingColumns = new Set(
          (columnsCheck.rows as any[]).map(r => r.column_name)
        );
        
        const requiredColumns = ['id', 'post_id', 'content', 'posted_at', 'truth_social_url', 'scraped_at'];
        const missingColumns = requiredColumns.filter(c => !existingColumns.has(c));
        
        if (missingColumns.length > 0) {
          console.log(`⚠️ truth_social_posts table missing columns: ${missingColumns.join(', ')}`);
          
          // Add missing columns
          for (const col of missingColumns) {
            if (col === 'truth_social_url') {
              await db.execute(sql`ALTER TABLE truth_social_posts ADD COLUMN IF NOT EXISTS truth_social_url TEXT NOT NULL DEFAULT ''`);
            } else if (col === 'scraped_at') {
              await db.execute(sql`ALTER TABLE truth_social_posts ADD COLUMN IF NOT EXISTS scraped_at TIMESTAMP NOT NULL DEFAULT NOW()`);
            } else if (col === 'content') {
              await db.execute(sql`ALTER TABLE truth_social_posts ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT ''`);
            } else if (col === 'posted_at') {
              await db.execute(sql`ALTER TABLE truth_social_posts ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP NOT NULL DEFAULT NOW()`);
            } else if (col === 'post_id') {
              await db.execute(sql`ALTER TABLE truth_social_posts ADD COLUMN IF NOT EXISTS post_id TEXT NOT NULL DEFAULT ''`);
            }
          }
          console.log('✅ Added missing columns to truth_social_posts');
        } else {
          console.log('✅ truth_social_posts table schema verified');
        }
        
        // Clean up empty-content posts that break dedup logic
        const emptyResult = await db.execute(sql`
          DELETE FROM truth_social_posts 
          WHERE content IS NULL OR content = '' OR LENGTH(TRIM(content)) = 0
        `);
        if (emptyResult.rowCount && emptyResult.rowCount > 0) {
          console.log(`🧹 Cleaned up ${emptyResult.rowCount} empty Truth Social posts (dedup fix)`);
        }

        // Log current table stats for debugging
        const countResult = await db.execute(sql`SELECT COUNT(*) as count FROM truth_social_posts`);
        console.log(`📊 truth_social_posts has ${(countResult.rows[0] as any)?.count || 0} rows`);
      }
    } catch (error) {
      console.error('❌ Error verifying truth_social_posts schema:', error);
    }

    // Create team_submission_clusters table for grouping related submissions within topics
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS team_submission_clusters (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          subject_id VARCHAR REFERENCES team_subjects(id),
          is_user_created BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      console.log('✅ Created team_submission_clusters table');
    } catch (error) {
      console.log('Table team_submission_clusters already exists');
    }

    // Add cluster_id and is_cluster_representative columns to team_submissions
    try {
      await db.execute(sql`
        ALTER TABLE team_submissions 
        ADD COLUMN IF NOT EXISTS cluster_id VARCHAR
      `);
      await db.execute(sql`
        ALTER TABLE team_submissions 
        ADD COLUMN IF NOT EXISTS is_cluster_representative BOOLEAN NOT NULL DEFAULT false
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS team_submissions_cluster_id_idx ON team_submissions (cluster_id)
      `);
      console.log('✅ Added cluster columns to team_submissions table');
    } catch (error) {
      console.log('Cluster columns already exist in team_submissions table');
    }

    // Add cjcs_subject_id column for CJCS Mentions topic
    try {
      await db.execute(sql`
        ALTER TABLE team_submissions 
        ADD COLUMN IF NOT EXISTS cjcs_subject_id VARCHAR REFERENCES team_subjects(id)
      `);
      console.log('✅ Added cjcs_subject_id column to team_submissions table');
    } catch (error) {
      console.log('cjcs_subject_id column already exists in team_submissions table');
    }

    // Add sentdefender columns to scrape_metadata
    try {
      await db.execute(sql`ALTER TABLE scrape_metadata ADD COLUMN IF NOT EXISTS sent_defender_last_scrape_time TIMESTAMP`);
      await db.execute(sql`ALTER TABLE scrape_metadata ADD COLUMN IF NOT EXISTS sent_defender_last_count INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE scrape_metadata ADD COLUMN IF NOT EXISTS sent_defender_consecutive_empty INTEGER NOT NULL DEFAULT 0`);
      console.log('✅ Added sentdefender columns to scrape_metadata table');
    } catch (error) {
      console.log('sentdefender columns already exist in scrape_metadata table');
    }

    // Add influencer X columns to scrape_metadata (for the Influencer X column on Warfighter page)
    try {
      await db.execute(sql`ALTER TABLE scrape_metadata ADD COLUMN IF NOT EXISTS influencer_x_last_scrape_time TIMESTAMP`);
      await db.execute(sql`ALTER TABLE scrape_metadata ADD COLUMN IF NOT EXISTS influencer_x_last_count INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE scrape_metadata ADD COLUMN IF NOT EXISTS influencer_x_consecutive_empty INTEGER NOT NULL DEFAULT 0`);
      console.log('✅ Added influencer X columns to scrape_metadata table');
    } catch (error) {
      console.log('influencer X columns already exist in scrape_metadata table');
    }

    // Add video_url column to sentdefender_posts
    try {
      await db.execute(sql`ALTER TABLE sentdefender_posts ADD COLUMN IF NOT EXISTS video_url TEXT`);
      console.log('✅ Added video_url column to sentdefender_posts table');
    } catch (error) {
      console.log('video_url column already exists in sentdefender_posts table');
    }

    // Create war_screenshots table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS war_screenshots (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        caption TEXT NOT NULL,
        image_url TEXT NOT NULL,
        source_label TEXT,
        priority_score INTEGER NOT NULL DEFAULT 50,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS war_screenshots_created_at_idx ON war_screenshots (created_at DESC)`);
    try {
      await db.execute(sql`ALTER TABLE war_screenshots ADD COLUMN IF NOT EXISTS link_url TEXT`);
      console.log('✅ Added link_url column to war_screenshots table');
    } catch (e) {
      console.log('link_url column already exists in war_screenshots table');
    }
    console.log('✅ Ensured war_screenshots table exists');

    // Create osint_posts table for @MATA_osint, @CENTCOM
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS osint_posts (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        posted_at TIMESTAMP NOT NULL,
        x_url TEXT NOT NULL,
        source_account TEXT NOT NULL,
        image_url TEXT,
        video_url TEXT,
        scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS osint_posted_at_idx ON osint_posts (posted_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS osint_source_account_idx ON osint_posts (source_account)`);
    console.log('✅ Ensured osint_posts table exists');

    // Create journalist_posts table (Task #182) — curated-lane-only Journalists
    // X Feed. Mirrors osint_posts but isolated so journalist posts never leak
    // into any osint_posts consumer.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS journalist_posts (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        posted_at TIMESTAMP NOT NULL,
        x_url TEXT NOT NULL,
        source_account TEXT NOT NULL,
        image_url TEXT,
        video_url TEXT,
        is_hidden BOOLEAN NOT NULL DEFAULT false,
        scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS journalist_posted_at_idx ON journalist_posts (posted_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS journalist_source_account_idx ON journalist_posts (source_account)`);
    console.log('✅ Ensured journalist_posts table exists');

    // Create flight_tracking_posts table for manual flight tracking uploads
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS flight_tracking_posts (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id TEXT NOT NULL,
        content TEXT NOT NULL,
        posted_at TIMESTAMP NOT NULL,
        x_url TEXT NOT NULL,
        source_account TEXT NOT NULL,
        image_url TEXT,
        video_url TEXT,
        screenshot_url TEXT,
        submitted_by TEXT,
        submitted_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS flight_tracking_posted_at_idx ON flight_tracking_posts (posted_at DESC)`);
    try {
      await db.execute(sql`ALTER TABLE flight_tracking_posts ADD COLUMN IF NOT EXISTS video_url TEXT`);
    } catch (e) {
      console.warn(`⚠️ Migration step "add flight_tracking_posts.video_url" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log('✅ Ensured flight_tracking_posts table exists');

    // Add is_hidden column to all X post tables
    try {
      await db.execute(sql`ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE rapidresponse_posts ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE dow_response_posts ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE sentdefender_posts ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE osint_posts ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE flight_tracking_posts ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false`);

      // Curated-lane content-kind flag (podcast/audio detection). Nullable so it
      // is safe to add to existing rows; populated at enrichment time and read
      // ONLY by curated-gated surfaces. Added to all three stores that feed the
      // curated union (headlines + manual_submissions main rows, curated_items).
      await db.execute(sql`ALTER TABLE headlines ADD COLUMN IF NOT EXISTS content_kind TEXT`);
      await db.execute(sql`ALTER TABLE manual_submissions ADD COLUMN IF NOT EXISTS content_kind TEXT`);
      await db.execute(sql`ALTER TABLE curated_items ADD COLUMN IF NOT EXISTS content_kind TEXT`);
      await db.execute(sql`ALTER TABLE curated_items ADD COLUMN IF NOT EXISTS video_url TEXT`);
      // Attributed claims / key statements (Task #256). Nullable text[] added to all
      // three article stores that feed the curated union; populated at enrichment
      // time alongside summary_bullets and shown as an additive detail section.
      await db.execute(sql`ALTER TABLE headlines ADD COLUMN IF NOT EXISTS attributed_claims TEXT[]`);
      await db.execute(sql`ALTER TABLE manual_submissions ADD COLUMN IF NOT EXISTS attributed_claims TEXT[]`);
      await db.execute(sql`ALTER TABLE curated_items ADD COLUMN IF NOT EXISTS attributed_claims TEXT[]`);
      // Publish-date backfill back-off (Task #1088). Mirrors the media
      // attempt-count back-off so the pubdate backfill stops re-fetching the
      // same unrecoverable rows (blocked hosts / no structured date signal)
      // every cron pass. Curated-lane only.
      await db.execute(sql`ALTER TABLE curated_items ADD COLUMN IF NOT EXISTS pubdate_attempt_count INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE curated_items ADD COLUMN IF NOT EXISTS last_pubdate_attempt_at TIMESTAMP`);
      // Catch-all repair counter (Task #1088). Lets the boot-time catch-all
      // repair skip chronically ambiguous 'Other / Emerging' rows after a few
      // repair cycles instead of re-resetting (and re-AI-classifying) the same
      // population on every redeploy. Curated-lane only.
      await db.execute(sql`ALTER TABLE curated_classifications ADD COLUMN IF NOT EXISTS catchall_repair_count INTEGER NOT NULL DEFAULT 0`);
      // Repost ("retweet") flags for the OSINT and Press curated X feeds (follow-up
      // to the curated Hide-Reposts toggle). x_posts already carries these; add them
      // to the other social lane tables so the toggle can actually filter reposts.
      // Populated by the EV relay (when EV sends a retweet flag) and the backfill
      // scrapers; default false so existing rows are unaffected.
      await db.execute(sql`ALTER TABLE osint_posts ADD COLUMN IF NOT EXISTS is_retweet BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE osint_posts ADD COLUMN IF NOT EXISTS retweeted_from TEXT`);
      await db.execute(sql`ALTER TABLE journalist_posts ADD COLUMN IF NOT EXISTS is_retweet BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE journalist_posts ADD COLUMN IF NOT EXISTS retweeted_from TEXT`);
      await db.execute(sql`ALTER TABLE sentdefender_posts ADD COLUMN IF NOT EXISTS is_retweet BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE sentdefender_posts ADD COLUMN IF NOT EXISTS retweeted_from TEXT`);
      // The U.S. X Feed also folds in the Rapid Response 47 and DOW Rapid Response
      // accounts; add the same repost flags to their tables so the Hide-Reposts
      // toggle covers every account in that feed too. These tables also feed the
      // Visual stream and public API, but those serializers hardcode the repost
      // fields, so the new columns stay curated-only.
      await db.execute(sql`ALTER TABLE rapidresponse_posts ADD COLUMN IF NOT EXISTS is_retweet BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE rapidresponse_posts ADD COLUMN IF NOT EXISTS retweeted_from TEXT`);
      await db.execute(sql`ALTER TABLE dow_response_posts ADD COLUMN IF NOT EXISTS is_retweet BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE dow_response_posts ADD COLUMN IF NOT EXISTS retweeted_from TEXT`);
      console.log('✅ Added is_hidden column to X post tables');
    } catch (e) {
      console.log('is_hidden columns already exist in X post tables');
    }

    // Add MATA/OSINT columns to team_submissions
    try {
      await db.execute(sql`ALTER TABLE team_submissions ADD COLUMN IF NOT EXISTS is_mata_osint BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE team_submissions ADD COLUMN IF NOT EXISTS mata_osint_subject_id VARCHAR REFERENCES team_subjects(id)`);
      await db.execute(sql`ALTER TABLE team_submissions ADD COLUMN IF NOT EXISTS flight_tracking_posted_at TIMESTAMP`);
      console.log('✅ Added MATA/OSINT columns to team_submissions table');
    } catch (error) {
      console.log('MATA/OSINT columns already exist in team_submissions table');
    }

    try {
      await db.execute(sql`ALTER TABLE team_submissions ADD COLUMN IF NOT EXISTS og_image_url TEXT`);
      console.log('✅ Added og_image_url column to team_submissions table');
    } catch (error) {
      console.log('og_image_url column already exists in team_submissions table');
    }

    // Score-provenance columns (Task #811): distinguish a genuine AI score from
    // the UNSCORED_BOT_PRIORITY floor applied on a scorer timeout/malformed
    // reply, and cap how many times the retry job re-scores a fallback row.
    try {
      await db.execute(sql`ALTER TABLE team_submissions ADD COLUMN IF NOT EXISTS score_source TEXT DEFAULT 'ai'`);
      await db.execute(sql`ALTER TABLE team_submissions ADD COLUMN IF NOT EXISTS score_retry_count INTEGER NOT NULL DEFAULT 0`);
      console.log('✅ Added score_source/score_retry_count columns to team_submissions table');
    } catch (error) {
      console.log('score provenance columns already exist in team_submissions table');
    }

    // Add osint columns to scrape_metadata
    try {
      await db.execute(sql`ALTER TABLE scrape_metadata ADD COLUMN IF NOT EXISTS osint_last_scrape_time TIMESTAMP`);
      await db.execute(sql`ALTER TABLE scrape_metadata ADD COLUMN IF NOT EXISTS osint_last_count INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE scrape_metadata ADD COLUMN IF NOT EXISTS osint_consecutive_empty INTEGER NOT NULL DEFAULT 0`);
      console.log('✅ Added osint columns to scrape_metadata table');
    } catch (error) {
      console.log('osint columns already exist in scrape_metadata table');
    }

    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS article_quotes (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          quote_text TEXT NOT NULL,
          speaker_name TEXT NOT NULL,
          normalized_speaker TEXT NOT NULL,
          location TEXT,
          subject_tags TEXT[] NOT NULL DEFAULT '{}',
          context TEXT NOT NULL,
          source_url TEXT NOT NULL,
          date_spoken TIMESTAMP,
          story_id VARCHAR NOT NULL REFERENCES team_submissions(id),
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS article_quotes_story_id_idx ON article_quotes(story_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS article_quotes_normalized_speaker_idx ON article_quotes(normalized_speaker)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS article_quotes_created_at_idx ON article_quotes(created_at)`);
      try {
        await db.execute(sql`ALTER TABLE article_quotes ADD COLUMN IF NOT EXISTS speaker_title TEXT`);
        await db.execute(sql`ALTER TABLE article_quotes ADD COLUMN IF NOT EXISTS event TEXT`);
        console.log('✅ Added speaker_title and event columns to article_quotes');
      } catch (e) {
        console.warn(`⚠️ Migration step "add article_quotes.speaker_title/event columns" failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      console.log('✅ Ensured article_quotes table exists');
    } catch (error) {
      console.log('article_quotes table already exists');
    }

    try {
      await db.execute(sql`ALTER TABLE headlines ADD COLUMN IF NOT EXISTS manually_edited BOOLEAN DEFAULT FALSE`);
      await db.execute(sql`ALTER TABLE manual_submissions ADD COLUMN IF NOT EXISTS manually_edited BOOLEAN DEFAULT FALSE`);
      console.log('✅ Added manually_edited column to headlines and manual_submissions tables');
    } catch (error) {
      console.log('manually_edited column already exists');
    }

    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS daily_news_scrubs (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          filename TEXT NOT NULL,
          storage_path TEXT NOT NULL,
          cao_date TIMESTAMP NOT NULL,
          uploaded_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`ALTER TABLE daily_news_scrubs ADD COLUMN IF NOT EXISTS html_content TEXT`);
      console.log('✅ Ensured daily_news_scrubs table exists');
    } catch (error) {
      console.log('daily_news_scrubs table already exists');
    }

    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS sms_alert_subscribers (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          phone_number TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      console.log('✅ Ensured sms_alert_subscribers table exists');
    } catch (error) {
      console.log('sms_alert_subscribers table already exists');
    }

    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS relay_truth_social_posts (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          post_id TEXT NOT NULL,
          content TEXT NOT NULL,
          posted_at TIMESTAMP NOT NULL,
          truth_social_url TEXT NOT NULL,
          image_url TEXT,
          video_url TEXT,
          video_thumbnail_url TEXT,
          is_reblog BOOLEAN NOT NULL DEFAULT false,
          reblogged_from TEXT,
          received_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS relay_received_at_idx ON relay_truth_social_posts (received_at DESC)`);
      await db.execute(sql`ALTER TABLE relay_truth_social_posts ADD COLUMN IF NOT EXISTS raw_payload TEXT`);
      console.log('✅ Ensured relay_truth_social_posts table exists');
    } catch (error) {
      console.log('relay_truth_social_posts table already exists');
    }

    // Add restricted_to_mcops column to headlines for warfighter-only outlets
    // (The Blaze, The Epoch Times, The Daily Wire). NULL = globally visible;
    // a non-empty array means the headline only shows on the listed MCOP slugs.
    try {
      await db.execute(sql`ALTER TABLE headlines ADD COLUMN IF NOT EXISTS restricted_to_mcops TEXT[]`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS headlines_restricted_to_mcops_idx ON headlines (restricted_to_mcops) WHERE restricted_to_mcops IS NOT NULL`);
      console.log('✅ Ensured restricted_to_mcops column on headlines');
    } catch (error) {
      console.log('restricted_to_mcops column already exists on headlines');
    }

    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS sms_queue (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          to_number TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          direction TEXT NOT NULL DEFAULT 'outbound',
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          sent_at TIMESTAMP,
          error TEXT,
          claimed_by TEXT,
          claimed_at TIMESTAMP
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS sms_queue_status_idx ON sms_queue (status, direction)`);
      // Task #773: claim/lease columns on existing deployments (idempotent).
      await db.execute(sql`ALTER TABLE sms_queue ADD COLUMN IF NOT EXISTS claimed_by TEXT`);
      await db.execute(sql`ALTER TABLE sms_queue ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP`);
      console.log('✅ Ensured sms_queue table exists');
    } catch (error) {
      console.log('sms_queue table already exists');
    }

    // --- SMS bridge failover state + event log (Task #773) ---
    // sms_bridge_state: single-row persisted controller state (active device +
    // manual override) so a redeploy doesn't bounce the role or forget an
    // override. sms_failover_events: append-only role-switch history for the
    // admin SMS status surface.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS sms_bridge_state (
          id VARCHAR PRIMARY KEY DEFAULT 'global',
          override_mode TEXT NOT NULL DEFAULT 'auto',
          active_device TEXT NOT NULL DEFAULT 'primary',
          last_switch_at TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS sms_failover_events (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          from_device TEXT NOT NULL,
          to_device TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS sms_failover_events_created_at_idx ON sms_failover_events (created_at DESC)`);
      console.log('✅ Ensured SMS bridge failover tables exist');
    } catch (error) {
      console.log('SMS bridge failover tables already exist');
    }

    // Warfighter/Cyber allowed list — grants full admin (view + curate) access
    // to the warfighter and cyber gated MCOPs for approved users. Independent
    // of team_members and curated_view_testers. Seeded in code; changes ship
    // on publish (production is read-only to ad-hoc tooling).
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS warfighter_cyber_allowed (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          email TEXT NOT NULL UNIQUE,
          added_by TEXT NOT NULL,
          added_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS warfighter_cyber_allowed_email_idx ON warfighter_cyber_allowed (email)`);
      const warfighterCyberSeedEmails = [
        'chelsea.l.durante.mil@mail.mil',
      ];
      for (const email of warfighterCyberSeedEmails) {
        await db.execute(sql`
          INSERT INTO warfighter_cyber_allowed (email, added_by)
          VALUES (${email}, 'system-seed')
          ON CONFLICT (email) DO NOTHING
        `);
      }
      // Revoked entries removed on every startup (same pattern as curated_view_testers).
      const warfighterCyberRevokedEmails: string[] = [];
      for (const email of warfighterCyberRevokedEmails) {
        await db.execute(sql`DELETE FROM warfighter_cyber_allowed WHERE email = ${email}`);
      }
      console.log('✅ Ensured warfighter_cyber_allowed table exists and reconciled entries');
    } catch (error) {
      console.log('warfighter_cyber_allowed table already exists or error:', error);
    }

    // Curated View tester allowlist — separate, additive table that gates the
    // hidden Curated View. Independent of team_members. Seeded with the
    // initial wave of testers.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_view_testers (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          email TEXT NOT NULL UNIQUE,
          added_by TEXT NOT NULL,
          added_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_view_testers_email_idx ON curated_view_testers (email)`);
      const curatedSeedEmails = [
        'chelsea.l.durante.mil@mail.mil',
        'gerhard.a.wald.mil@mail.mil',
        'waldgw@gmail.com',
        'joseph.r.holstead.civ@mail.mil',
        'william.j.dixon60.civ@mail.mil',
        'joel.j.gill.civ@mail.mil',
      ];
      for (const email of curatedSeedEmails) {
        await db.execute(sql`
          INSERT INTO curated_view_testers (email, added_by)
          VALUES (${email}, 'system-seed')
          ON CONFLICT (email) DO NOTHING
        `);
      }
      // Testers whose access has been revoked. Removed on every startup so the
      // change propagates to production on the next deploy (production is
      // read-only to ad-hoc tooling, so this is the supported removal path).
      const curatedRevokedEmails = [
        '42bummy@gmail.com',
      ];
      for (const email of curatedRevokedEmails) {
        await db.execute(sql`
          DELETE FROM curated_view_testers WHERE email = ${email}
        `);
      }
      console.log('✅ Ensured curated_view_testers table exists and reconciled testers');
    } catch (error) {
      console.log('curated_view_testers table already exists');
    }

    // Create outlet_registry table — canonical source knowledge / labeling layer
    // (read only by the Curated view + Team oversight; never an admission gate).
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS outlet_registry (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          key TEXT NOT NULL UNIQUE,
          canonical_name TEXT NOT NULL,
          aliases TEXT[] NOT NULL DEFAULT '{}',
          domains TEXT[] NOT NULL DEFAULT '{}',
          logo_slug TEXT,
          logo_brand_color TEXT,
          logo_object_fit TEXT,
          origin_country TEXT,
          origin_region TEXT,
          factuality TEXT,
          role TEXT NOT NULL DEFAULT 'attach-only',
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS outlet_registry_key_idx ON outlet_registry (key)`);
      console.log('✅ Ensured outlet_registry table exists');
    } catch (error) {
      console.log('outlet_registry table already exists or error:', error);
    }

    // Retire the legacy "Meltwater" catch-all pseudo-outlets. Meltwater is a data
    // pipe, not an outlet: items are now attributed to their real publisher, so
    // these two seeded rows are removed from the registry on every boot — the
    // supported removal path since production is read-only to ad-hoc tooling.
    // Idempotent. Run as separate statements so a not-yet-created curated_items
    // table on a fresh DB can't skip the registry cleanup.
    try {
      const meltwaterCatchAllNames = ['Meltwater CPC/SWL/EPC', 'Meltwater Social CPC/SWL/EPC'];
      for (const name of meltwaterCatchAllNames) {
        await db.execute(sql`DELETE FROM outlet_registry WHERE canonical_name = ${name}`);
      }
      console.log('✅ Retired Meltwater catch-all pseudo-outlets from registry');
    } catch (error) {
      console.log('Meltwater registry cleanup skipped or error:', error);
    }
    try {
      const meltwaterCatchAllNames = ['Meltwater CPC/SWL/EPC', 'Meltwater Social CPC/SWL/EPC'];
      for (const name of meltwaterCatchAllNames) {
        await db.execute(sql`DELETE FROM curated_items WHERE source = ${name}`);
      }
    } catch (error) {
      console.log('Meltwater legacy curated-item cleanup skipped or error:', error);
    }

    // Outlet enrichment + oversight columns (Task #84). Additive only — the
    // registry stays a labeling layer; no shared feed reads these.
    try {
      await db.execute(sql`
        ALTER TABLE outlet_registry
        ADD COLUMN IF NOT EXISTS logo_url TEXT,
        ADD COLUMN IF NOT EXISTS confirmation_status TEXT NOT NULL DEFAULT 'unconfirmed',
        ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS enrichment_provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS manual_overrides JSONB NOT NULL DEFAULT '{}'::jsonb
      `);
      // Existing rows are all hand-seeded; treat them as confirmed so enrichment
      // can layer reference data on top without "demoting" curated outlets. New
      // rows discovered later start 'unconfirmed' (attach-only) until verified.
      await db.execute(sql`
        UPDATE outlet_registry
        SET confirmation_status = 'confirmed'
        WHERE confirmation_status = 'unconfirmed'
          AND last_enriched_at IS NULL
          AND manual_overrides = '{}'::jsonb
      `);
      console.log('✅ Ensured outlet_registry enrichment columns exist');
    } catch (error) {
      console.log('outlet_registry enrichment columns already exist or error:', error);
    }

    // Behavior-engine identity columns (source identifier / ownership). Additive
    // only — these match shared/schema.ts. Without them, outlet seeding and
    // curated clustering hit Postgres 42703 on insert/update.
    try {
      await db.execute(sql`
        ALTER TABLE outlet_registry
        ADD COLUMN IF NOT EXISTS source_identifier TEXT,
        ADD COLUMN IF NOT EXISTS other_source_type TEXT,
        ADD COLUMN IF NOT EXISTS ownership JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT false
      `);
      // Display-only human-readable name for handle-keyed rows (Task: registry
      // display names). Nullable; seed-owned identity column. Never read by
      // resolution/tiering/Coverage — those key off canonical_name/aliases.
      await db.execute(sql`
        ALTER TABLE outlet_registry
        ADD COLUMN IF NOT EXISTS display_name TEXT
      `);
      console.log('✅ Ensured outlet_registry identity columns exist');
    } catch (error) {
      console.log('outlet_registry identity columns already exist or error:', error);
    }

    // Retire the legacy source-labeling columns. Every outlet now carries an
    // explicit source_identifier; source_character was NOT NULL, so leaving it in
    // place would 23502-fail seed upserts that no longer provide it.
    try {
      await db.execute(sql`
        ALTER TABLE outlet_registry
        DROP COLUMN IF EXISTS source_character,
        DROP COLUMN IF EXISTS state_controlled,
        DROP COLUMN IF EXISTS bias
      `);
      console.log('✅ Dropped legacy outlet_registry labeling columns');
    } catch (error) {
      console.log('outlet_registry legacy columns already dropped or error:', error);
    }

    // Curated lane (Task #89) — a SEPARATE curated store + isolated two-tier
    // cluster membership. Read ONLY by the curated-gated endpoints; never by
    // getPrimaryFeed, the public REST API, custom MCOPs, or Classic/Visual.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_items (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT NOT NULL,
          normalized_title TEXT NOT NULL,
          url TEXT NOT NULL UNIQUE,
          category TEXT NOT NULL DEFAULT 'general',
          source TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          summary_bullets TEXT[],
          og_image_url TEXT,
          media_scraped_at TIMESTAMP,
          media_attempt_count INTEGER NOT NULL DEFAULT 0,
          last_media_attempt_at TIMESTAMP,
          priority_score INTEGER NOT NULL DEFAULT 0,
          role TEXT NOT NULL DEFAULT 'attach-only',
          cluster_id VARCHAR,
          scraped_at TIMESTAMP NOT NULL DEFAULT NOW(),
          article_published_at TIMESTAMP,
          tags TEXT[] NOT NULL DEFAULT '{}'
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_items_scraped_at_idx ON curated_items (scraped_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_items_normalized_title_idx ON curated_items (normalized_title)`);
      // Additive backfill for pre-existing curated_items tables that predate the
      // content-based classification columns (region/country). Without these the
      // curated Top Stories read/write hits Postgres 42703.
      await db.execute(sql`
        ALTER TABLE curated_items
        ADD COLUMN IF NOT EXISTS region TEXT,
        ADD COLUMN IF NOT EXISTS country TEXT,
        ADD COLUMN IF NOT EXISTS media_scraped_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS media_attempt_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_media_attempt_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS media_rescue_at TIMESTAMP
      `);
      // One-time enrichment rescue (Task #339, widened Task #644, widened again
      // for WSJ). Hard-blocked outlets (Bloomberg, Reuters, WSJ — the same set
      // as isHardBlockedOutlet in server/streamPrefetch.ts) 403/401 the curated
      // direct/strengthened fetches; before paywall2 was added to the curated
      // breaker chain, those rows could exhaust MAX_MEDIA_ATTEMPTS (6) and
      // freeze permanently on a favicon (media_scraped_at NULL). Give each such
      // FROZEN row a single fresh, bounded set of attempts through the improved
      // (now longer-budget) chain by clearing its back-off counters. Guarded by
      // media_rescue_at IS NULL so it runs ONCE PER ROW: a row that still fails
      // climbs back to the cap and is never rescued again — the back-off/cap
      // mechanism itself is preserved, not removed. Curated lane only. Reuters
      // rows added alongside Bloomberg (Task #644) to cover the full hard-blocked
      // set that now gets the priority-first recurring backfill + immediate
      // post-ingest fast-path, so the rescued rows land in a window that can
      // actually reach them (see staleCuratedMediaFilters' media_rescue_at
      // exemption). WSJ added alongside (same paywall class, same routing fix).
      // Isolated in its own try/catch: this is a one-time COSMETIC image
      // backfill, so a failure here (lock contention, statement timeout) must
      // never abort the additive curated-table DDL that follows in this same
      // outer try block — skipping those ALTERs would risk later 42703 errors.
      try {
        await db.execute(sql`
          UPDATE curated_items
          SET media_attempt_count = 0,
              last_media_attempt_at = NULL,
              media_rescue_at = now()
          WHERE media_rescue_at IS NULL
            AND media_scraped_at IS NULL
            AND media_attempt_count >= 6
            AND (
              source ILIKE '%bloomberg%' OR url ILIKE '%bloomberg.com%'
              OR source ILIKE '%reuters%' OR url ILIKE '%reuters.com%'
              OR source ILIKE '%wall street journal%' OR source ILIKE '%wsj%' OR url ILIKE '%wsj.com%'
            )
        `);
      } catch (rescueErr) {
        console.error('[Migrate] Hard-blocked media-rescue backfill failed (non-fatal):', rescueErr);
      }
      // Dead-link tracking (Task #226). Additive backfill for pre-existing
      // curated_items tables: link_dead_at is stamped when a liveness probe
      // confirms HTTP 404/410; link_checked_at records the last probe so the
      // cron round-robins oldest-first. Without these the curated read/write
      // hits Postgres 42703.
      await db.execute(sql`
        ALTER TABLE curated_items
        ADD COLUMN IF NOT EXISTS link_dead_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS link_checked_at TIMESTAMP
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_cluster_members (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          cluster_id VARCHAR NOT NULL,
          item_type TEXT NOT NULL,
          item_id VARCHAR NOT NULL,
          role TEXT NOT NULL,
          title TEXT NOT NULL,
          source TEXT NOT NULL,
          url TEXT NOT NULL,
          category TEXT,
          summary TEXT,
          published_at TIMESTAMP,
          priority_score INTEGER NOT NULL DEFAULT 0,
          og_image_url TEXT,
          is_representative BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      // Additive backfill for pre-existing curated_cluster_members tables that
      // predate the snapshotted ranking/hero columns — without these the curated
      // Top Stories read hits Postgres 42703.
      await db.execute(sql`
        ALTER TABLE curated_cluster_members
        ADD COLUMN IF NOT EXISTS priority_score INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS og_image_url TEXT,
        ADD COLUMN IF NOT EXISTS summary TEXT,
        ADD COLUMN IF NOT EXISTS behavior_class TEXT NOT NULL DEFAULT 'corroborating',
        ADD COLUMN IF NOT EXISTS behavior_label TEXT,
        ADD COLUMN IF NOT EXISTS provisional BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS confirmed_streak INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS content_kind TEXT
      `);
      // Cross-pass member-confirmation hysteresis (Task #645). Side table that
      // SURVIVES the per-pass wipe of curated_cluster_members above, so a
      // volatile (provisional) member's streak persists across the rewrite.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_member_confirmations (
          key TEXT PRIMARY KEY,
          cluster_id VARCHAR NOT NULL,
          item_type TEXT NOT NULL,
          item_id VARCHAR NOT NULL,
          streak INTEGER NOT NULL DEFAULT 1,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_cluster_members_cluster_idx ON curated_cluster_members (cluster_id)`);
      // Read-path scale (Task #382). getCuratedClusterMembers(hours) filters by
      // `created_at >= cutoff` on every /api/curated/top-stories request; with no
      // index on created_at that is a full scan whose cost grows with the table.
      // Back it with a DESC index so the hot curated read stays fast as the
      // members table grows. Curated-lane only.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_cluster_members_created_at_idx ON curated_cluster_members (created_at DESC)`);

      // Curated lane (Task #90) — story SYNTHESIS cache keyed by content
      // signature (sha256 of sorted member keys), so it survives per-pass
      // cluster-id churn. Read ONLY by curated-gated endpoints.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_story_synthesis (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          signature TEXT NOT NULL UNIQUE,
          headline TEXT NOT NULL DEFAULT '',
          lede TEXT NOT NULL DEFAULT '',
          facts TEXT[] NOT NULL DEFAULT '{}',
          spins JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`ALTER TABLE curated_story_synthesis ADD COLUMN IF NOT EXISTS headline TEXT NOT NULL DEFAULT ''`);
      await db.execute(sql`ALTER TABLE curated_story_synthesis ADD COLUMN IF NOT EXISTS alignments JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await db.execute(sql`ALTER TABLE curated_story_synthesis ADD COLUMN IF NOT EXISTS content_hash TEXT`);
      // Attributed claims / key statements (Task #256). Nullable so rows written
      // before this column existed re-synthesize once (null !== a generated array).
      await db.execute(sql`ALTER TABLE curated_story_synthesis ADD COLUMN IF NOT EXISTS attributed_claims TEXT[]`);
      // False-merge backstop verdict (Task #362). Nullable so rows written before
      // this column existed re-synthesize once to pick up a verdict (null !== a
      // generated boolean). The clustering pass DISSOLVES corroborated=false rows.
      await db.execute(sql`ALTER TABLE curated_story_synthesis ADD COLUMN IF NOT EXISTS corroborated BOOLEAN`);
      // Monotonic "synthesized-through" marker (Task #920). Nullable so rows
      // written before this column existed re-synthesize once to backfill it
      // (null !== a stamped timestamp). Drives the long-lived-story synopsis
      // refresh trigger and the honest displayed "Updated" time.
      await db.execute(sql`ALTER TABLE curated_story_synthesis ADD COLUMN IF NOT EXISTS synthesized_through TIMESTAMP`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_story_synthesis_signature_idx ON curated_story_synthesis (signature)`);

      // ONE-TIME synthesis-cache reset for the headline-tone fix (July 2026).
      // The fix adds a HEADLINE CONTINUITY anchor + prune grace, which would
      // otherwise LOCK IN the editorialized headlines already stored (reuse
      // preserves them; a contentHash bust would re-synthesize WITH the bad
      // headline as the continuity anchor). Wipe the cache exactly once per DB
      // so every current story re-rolls fresh under the hardened tone rules —
      // guarded by a marker row so restarts never repeat the wipe.
      try {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS boot_heal_markers (
            key TEXT PRIMARY KEY,
            applied_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
        const marker = await db.execute(sql`
          INSERT INTO boot_heal_markers (key)
          VALUES ('curated_synthesis_tone_reset_2026_07')
          ON CONFLICT (key) DO NOTHING
        `);
        if (marker.rowCount && marker.rowCount > 0) {
          const wiped = await db.execute(sql`DELETE FROM curated_story_synthesis`);
          console.log(
            `🧹 One-time curated synthesis cache reset (headline-tone fix): ${wiped.rowCount ?? 0} rows cleared — next clustering pass re-rolls all headlines under hardened tone rules`,
          );
        }
      } catch (error) {
        console.log('Curated synthesis tone-reset heal skipped or error:', error);
      }

      // ONE-TIME synthesis re-roll for the causal-neutrality fix (Task #1111,
      // July 2026). The new prompt rules (single-origin causal framing barred
      // from headlines, wire-origin collapsed corroboration counting) only apply
      // on re-synthesis, and the HEADLINE CONTINUITY anchor would otherwise keep
      // an already-stored single-origin-causal headline. Reuses the
      // marker-guarded pattern but BUSTS contentHash instead of deleting rows:
      // a null contentHash forces exactly one re-synthesis per story on the next
      // pass WITHOUT the continuity anchor (priorHeadline is only passed when
      // cached.contentHash != null), while cards keep their current content
      // until the re-roll lands — no blank stories, no mass churn thereafter.
      try {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS boot_heal_markers (
            key TEXT PRIMARY KEY,
            applied_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
        const marker = await db.execute(sql`
          INSERT INTO boot_heal_markers (key)
          VALUES ('curated_synthesis_causal_neutrality_reset_2026_07')
          ON CONFLICT (key) DO NOTHING
        `);
        if (marker.rowCount && marker.rowCount > 0) {
          const busted = await db.execute(
            sql`UPDATE curated_story_synthesis SET content_hash = NULL`,
          );
          console.log(
            `🧹 One-time curated synthesis causal-neutrality re-roll: contentHash busted on ${busted.rowCount ?? 0} rows — each story re-synthesizes once under the new headline rules (no continuity anchor for that roll)`,
          );
        }
      } catch (error) {
        console.log('Curated synthesis causal-neutrality heal skipped or error:', error);
      }

      // Content-based classification overlay, keyed by article URL. Single source
      // of truth for the curated view's "Category · Country/Region" label across
      // BOTH the main-feed union rows and the curated store. Read ONLY by
      // curated-gated endpoints (fail-closed isolation).
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_classifications (
          url TEXT PRIMARY KEY,
          category TEXT NOT NULL DEFAULT 'general',
          region TEXT,
          country TEXT,
          classified_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      // Structured classification ENRICHMENT object columns (Task #336). All
      // nullable so legacy rows re-classify (null !== a generated value).
      await db.execute(sql`
        ALTER TABLE curated_classifications
        ADD COLUMN IF NOT EXISTS primary_topic TEXT,
        ADD COLUMN IF NOT EXISTS scope TEXT,
        ADD COLUMN IF NOT EXISTS conflict_track TEXT,
        ADD COLUMN IF NOT EXISTS country_pair TEXT[],
        ADD COLUMN IF NOT EXISTS legacy_category TEXT,
        ADD COLUMN IF NOT EXISTS proposed_topic TEXT
      `);
      // Provenance + re-check bookkeeping (Task #350). All curated-lane only.
      await db.execute(sql`
        ALTER TABLE curated_classifications
        ADD COLUMN IF NOT EXISTS provenance TEXT,
        ADD COLUMN IF NOT EXISTS recheck_disagree_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS recheck_last_at TIMESTAMP
      `);
      // Provenance backfill (Task #350). Pre-existing rows predate the marker and
      // we CANNOT tell a past human override from an AI label, so default the
      // unknown legacy backlog to the PROTECTED value ('human') — the bounded
      // re-check then never clobbers anything already settled. New AI writes stamp
      // 'ai' explicitly and human overrides stamp 'human', so this WHERE only ever
      // touches the legacy backlog and is a no-op once converged.
      await db.execute(sql`
        UPDATE curated_classifications SET provenance = 'human' WHERE provenance IS NULL
      `);
      // ── URL-identity overlay merge (Task #927; idempotent) ──────────────────
      // The overlay is now keyed by the shared canonical identity URL
      // (normalizeIdentityUrl) so cosmetic variants of the SAME article
      // (trailing slash / tracking query / fragment / casing) resolve to ONE
      // row — the same collapse clustering already does. Historically it was
      // keyed by the RAW url, so a double-ingested article split into two rows
      // that could disagree on primary_topic or strand a human override on one
      // variant. Collapse every colliding group to a single canonical-key row:
      // a provenance='human' row always wins; otherwise prefer a non-null
      // primary_topic, then the most recently classified. All other columns
      // (audit fields, recheck counters) are preserved from the surviving row.
      // Single rows on a non-canonical key are re-keyed so reads (which now
      // query by the canonical key) find them. Re-runs converge to zero merges.
      // CURATED-LANE only — never touches curated_items / shared tables.
      try {
        const overlayRows = ((await db.execute(sql`
          SELECT url, primary_topic, provenance, classified_at
          FROM curated_classifications
        `)).rows as any[]);
        const groups = groupOverlayRowsByCanonical(overlayRows as OverlayMergeRow[]);
        let mergedDupes = 0;
        let reKeyed = 0;
        for (const [canonical, list] of Array.from(groups.entries())) {
          const needsReKey = list.length === 1 && list[0].url !== canonical;
          if (list.length <= 1 && !needsReKey) continue;
          // Pick the survivor: human > non-null primary_topic > most recent.
          const survivor = pickOverlaySurvivor(list);
          // Delete every non-survivor row (may include a row already sitting at
          // the canonical key — removing it first prevents a PK collision on the
          // re-key below).
          for (const r of list) {
            if (r.url === survivor.url) continue;
            await db.execute(sql`DELETE FROM curated_classifications WHERE url = ${r.url}`);
            mergedDupes++;
          }
          // Re-key the survivor onto the canonical URL if it isn't already.
          if (survivor.url !== canonical) {
            await db.execute(sql`
              UPDATE curated_classifications SET url = ${canonical} WHERE url = ${survivor.url}
            `);
            reKeyed++;
          }
        }
        if (mergedDupes > 0 || reKeyed > 0) {
          console.log(`[Migrate] Curated classification URL-identity merge: removed ${mergedDupes} duplicate row(s), re-keyed ${reKeyed} row(s) to canonical (Task #927)`);
        }
      } catch (err) {
        console.error('[Migrate] Curated classification URL-identity merge failed (non-fatal):', err);
      }
      // Conflict-track vocabulary maintenance (idempotent; curated-lane only).
      // The track formerly named "U.S.-Iran Confrontation" was renamed to
      // "U.S.-Iran Conflict"; normalize stored rows so counts + the displayed
      // chip match the current governed list. "Red Sea Crisis" was retired as a
      // named active conflict (no successor) → null it out so a stale chip never
      // renders. Re-running is a no-op once converged; prod applies this at boot.
      await db.execute(sql`
        UPDATE curated_classifications
        SET conflict_track = 'U.S.-Iran Conflict'
        WHERE conflict_track = 'U.S.-Iran Confrontation'
      `);
      await db.execute(sql`
        UPDATE curated_classifications
        SET conflict_track = NULL
        WHERE conflict_track = 'Red Sea Crisis'
      `);
      // ── Disaster/Health catch-all correction (Task #408; idempotent) ────────
      // A handful of stored rows whose specific free-form `category` clearly
      // names a public-health / natural-disaster / severe-weather / environ-
      // mental subject (e.g. "Public Health", "Natural Disaster", "Wildfire")
      // were sitting on the "Other / Emerging" catch-all. Re-bucket ONLY those
      // whose category DETERMINISTICALLY maps to "Public Health, Disaster &
      // Environmental Security" via the SHARED remap (no parallel mapping) — any
      // other bucket or no clear mapping is left untouched. Guarded on
      // provenance='ai' so a human override is NEVER clobbered (the legacy
      // backlog was backfilled to the protected 'human' default above).
      // Reversible: the original free-form label is snapshotted into
      // legacy_category. Idempotent: the WHERE excludes already-upgraded rows so
      // re-running is a no-op. CURATED-LANE only. No-op once converged.
      try {
        const { remapLegacyCategory, OTHER_EMERGING } = await import('@shared/classificationVocab');
        const DISASTER_HEALTH = 'Public Health, Disaster & Environmental Security';
        const catchAllRows = await db.execute(sql`
          SELECT url, category, legacy_category FROM curated_classifications
          WHERE primary_topic = ${OTHER_EMERGING} AND provenance = 'ai'
        `);
        let rebucketed = 0;
        for (const row of catchAllRows.rows as any[]) {
          const r = remapLegacyCategory(row.category as string);
          if (r.matched && r.primaryTopic === DISASTER_HEALTH) {
            await db.execute(sql`
              UPDATE curated_classifications
              SET primary_topic = ${DISASTER_HEALTH},
                  proposed_topic = NULL,
                  legacy_category = COALESCE(legacy_category, ${row.category})
              WHERE url = ${row.url}
                AND primary_topic = ${OTHER_EMERGING}
                AND provenance = 'ai'
            `);
            rebucketed++;
          }
        }
        if (rebucketed > 0) {
          console.log(`[Migrate] Re-bucketed ${rebucketed} catch-all curated rows to "Disaster & Health" (Task #408)`);
        }
      } catch (err) {
        console.error('[Migrate] Disaster/Health catch-all correction failed (non-fatal):', err);
      }
      // ── Briefing-preamble heal (idempotent; write-only-if-changed) ──────────
      // Several news bots summarized articles with a prompt that named the
      // audience ("...for the Chairman of the Joint Chiefs of Staff"). The model
      // occasionally echoed that framing back as a LEADING markdown heading or
      // label, e.g. "# Summary for Chairman of the Joint Chiefs of Staff\n\n
      // <actual news>". That leading artifact must never surface on Curated /
      // Classic / Visual / custom-MCOP / the public API, so strip it from
      // already-stored summaries here. stripBriefingPreamble only removes a
      // LEADING audience-framing heading/label, so legitimate inline mentions of
      // the real Chairman are preserved; a row that is NOTHING but the artifact
      // (heading-only, no body) is intentionally blanked to '' (valid for the
      // NOT NULL column and better than surfacing the artifact).
      // The LIKE/ILIKE WHERE is only a cheap candidate filter — the function
      // decides the actual strip, so over-selection is harmless (UPDATE only runs
      // when the value actually changes). No-op once converged.
      try {
        const { stripBriefingPreamble, stripBriefingPreambleFromMessage } = await import('./summarySanitizer');
        // Main article tables PLUS every per-bot post table that stores a raw
        // `summary` column — the same leaked audience-framing heading can be
        // baked into any of them. social_bot_posts has no summary column, so it
        // is intentionally absent.
        const summaryTables = [
          'team_submissions', 'headlines', 'manual_submissions',
          'drudge_bot_posts', 'bbc_bot_posts', 'fox_news_bot_posts',
          'abc_news_bot_posts', 'cbs_news_bot_posts', 'nbc_news_bot_posts',
          'ap_news_bot_posts', 'reuters_bot_posts', 'rss_bot_posts',
          // curated_items.summary is copied from a source candidate at ingest, so
          // a leaked audience heading on a pre-fix source row can persist in the
          // curated lane even after the source itself was healed. Heal it here too.
          'curated_items',
        ];
        for (const table of summaryTables) {
          const res = await db.execute(sql`
            SELECT id, summary FROM ${sql.raw(table)}
            WHERE summary IS NOT NULL AND (
              summary LIKE '#%'
              OR summary ILIKE 'summary for %'
              OR summary ILIKE 'briefing for %'
              OR summary ILIKE 'brief for %'
              OR summary ILIKE 'intelligence summary for %'
              OR summary ILIKE 'executive summary for %'
              OR summary ILIKE 'here is a summary for %'
              OR summary ILIKE 'here''s a summary for %'
            )
          `);
          let fixed = 0;
          for (const row of res.rows as any[]) {
            const cleaned = stripBriefingPreamble(row.summary as string);
            if (cleaned !== row.summary) {
              await db.execute(sql`UPDATE ${sql.raw(table)} SET summary = ${cleaned} WHERE id = ${row.id}`);
              fixed++;
            }
          }
          if (fixed > 0) {
            console.log(`[Migrate] Stripped leading briefing preamble from ${fixed} ${table} summaries`);
          }
        }

        // Bot chat messages bake the summary into a composed string
        // (**title**\n\n<summary>\n\n<url>), so the row-level summary strip above
        // can't reach them. Heal them with the message-aware sanitizer, which
        // splits off the leading title segment and strips an audience-framing
        // heading that leads the body. Candidate filter is cheap; the function
        // decides the real change, so over-selection is harmless (UPDATE only on
        // change). No-op once converged; leaves human messages untouched.
        try {
          const msgRes = await db.execute(sql`
            SELECT id, message FROM team_chat_messages
            WHERE message IS NOT NULL AND (
              message ILIKE '%# summary for %'
              OR message ILIKE '%# briefing for %'
              OR message ILIKE '%# brief for %'
              OR message ILIKE '%# intelligence summary%'
              OR message ILIKE '%# executive summary%'
              OR message ILIKE '%' || E'\n\n' || 'summary for %'
              OR message ILIKE '%' || E'\n\n' || 'briefing for %'
              OR message ILIKE '%' || E'\n\n' || 'here is a summary for %'
              OR message ILIKE '%' || E'\n\n' || 'here''s a summary for %'
            )
          `);
          let msgFixed = 0;
          for (const row of msgRes.rows as any[]) {
            const cleaned = stripBriefingPreambleFromMessage(row.message as string);
            if (cleaned !== row.message) {
              await db.execute(sql`UPDATE team_chat_messages SET message = ${cleaned} WHERE id = ${row.id}`);
              msgFixed++;
            }
          }
          if (msgFixed > 0) {
            console.log(`[Migrate] Stripped leaked briefing heading from ${msgFixed} team_chat_messages`);
          }
        } catch (msgErr) {
          console.error('[Migrate] Chat-message preamble heal failed (non-fatal):', msgErr);
        }
      } catch (err) {
        console.error('[Migrate] Briefing-preamble heal failed (non-fatal):', err);
      }

      // ── Meta-filler bullet heal (idempotent; write-only-if-changed) ─────────
      // The per-article summarizer's old "exactly 3 bullets" prompt padded thin
      // excerpts with META-COMMENTARY bullets ("The article does not provide
      // further details…", "…not specified in the excerpt") which were stored
      // and rendered as summary bullets / synthesis facts on curated cards.
      // The writers now drop these lines (server/metaFiller.ts), but already-
      // stored rows must be healed here. Per-LINE strip: real bullets on the
      // same row survive; the ILIKE WHERE is only a cheap candidate filter —
      // isMetaFillerLine decides the actual strip (subject-anchored to the
      // article/excerpt itself, so genuine reporting like "Officials did not
      // provide further details" or "not specified in the report" is never
      // touched). UPDATE only runs when the array actually changes; no-op once
      // converged. A curated_items row left with NO bullets also gets its
      // media/back-off state reset (mirroring the refusal heal) so the now
      // filler-aware enrichment worker re-attempts it cleanly.
      try {
        const { stripMetaFillerLines } = await import('./metaFiller');
        const targets: Array<{ table: string; col: string; emptyVal: 'null' | 'empty' }> = [
          { table: 'headlines', col: 'summary_bullets', emptyVal: 'null' },
          { table: 'headlines', col: 'attributed_claims', emptyVal: 'null' },
          { table: 'manual_submissions', col: 'summary_bullets', emptyVal: 'null' },
          { table: 'manual_submissions', col: 'attributed_claims', emptyVal: 'null' },
          { table: 'war_articles', col: 'summary_bullets', emptyVal: 'null' },
          { table: 'war_overrides', col: 'summary_bullets', emptyVal: 'null' },
          { table: 'custom_mcop_articles', col: 'summary_bullets', emptyVal: 'null' },
          { table: 'curated_items', col: 'summary_bullets', emptyVal: 'null' },
          { table: 'curated_items', col: 'attributed_claims', emptyVal: 'null' },
          { table: 'curated_story_synthesis', col: 'facts', emptyVal: 'empty' },
          { table: 'curated_story_synthesis', col: 'attributed_claims', emptyVal: 'null' },
          { table: 'curated_story_archive', col: 'facts', emptyVal: 'empty' },
          { table: 'curated_story_archive', col: 'attributed_claims', emptyVal: 'empty' },
        ];
        for (const { table, col, emptyVal } of targets) {
          // Per-target guard: an error on one target (e.g. schema drift on a
          // column) must not silently skip every LATER target this boot.
          try {
          const joined = sql.raw(`array_to_string(${col}, E'\\n')`);
          const res = await db.execute(sql`
            SELECT id, ${sql.raw(col)} AS lines FROM ${sql.raw(table)}
            WHERE ${sql.raw(col)} IS NOT NULL AND array_length(${sql.raw(col)}, 1) > 0 AND (
              ${joined} ILIKE '%article does not%'
              OR ${joined} ILIKE '%article did not%'
              OR ${joined} ILIKE '%article doesn''t%'
              OR ${joined} ILIKE '%excerpt does not%'
              OR ${joined} ILIKE '%excerpt did not%'
              OR ${joined} ILIKE '%article lacks%'
              OR ${joined} ILIKE '%excerpt lacks%'
              OR ${joined} ILIKE '%in the excerpt%'
              OR ${joined} ILIKE '%in the article%'
              OR ${joined} ILIKE '%no attributed%'
              OR ${joined} ILIKE '%attributed claims%'
              OR ${joined} ILIKE '%provided text%'
              OR ${joined} ILIKE '%given text%'
              OR ${joined} ILIKE '%provided content%'
              OR ${joined} ILIKE '%provided material%'
              OR ${joined} ILIKE '%provided excerpt%'
              OR ${joined} ILIKE '%source material%'
              OR ${joined} ILIKE '%given content%'
              OR ${joined} ILIKE '%given excerpt%'
              OR ${joined} ILIKE '%article published on%'
              OR ${joined} ILIKE '%comes from sources%'
              OR ${joined} ILIKE '%no closer to%'
            )
          `);
          let fixed = 0;
          for (const row of res.rows as any[]) {
            const before = row.lines as string[];
            const after = stripMetaFillerLines(before);
            if (after.length === before.length) continue;
            if (after.length > 0) {
              // Pass the survivors as JSONB text and convert server-side —
              // avoids any driver-specific JS-array-to-text[] serialization.
              await db.execute(sql`
                UPDATE ${sql.raw(table)}
                SET ${sql.raw(col)} = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(after)}::jsonb))
                WHERE id = ${row.id}
              `);
            } else if (emptyVal === 'empty') {
              await db.execute(sql`UPDATE ${sql.raw(table)} SET ${sql.raw(col)} = '{}' WHERE id = ${row.id}`);
            } else if (table === 'curated_items' && col === 'summary_bullets') {
              // Bullets were ALL filler — clear them AND reset the media/back-off
              // state so the enrichment worker gives the row a fresh attempt
              // (same reset the AI-refusal heal uses; back-off rules then apply).
              await db.execute(sql`
                UPDATE curated_items SET summary_bullets = NULL,
                  media_scraped_at = NULL, media_attempt_count = 0, last_media_attempt_at = NULL
                WHERE id = ${row.id}
              `);
            } else {
              await db.execute(sql`UPDATE ${sql.raw(table)} SET ${sql.raw(col)} = NULL WHERE id = ${row.id}`);
            }
            fixed++;
          }
          if (fixed > 0) {
            console.log(`[Migrate] Stripped meta-filler lines from ${fixed} ${table}.${col} row(s)`);
          }
          } catch (targetErr) {
            console.error(`[Migrate] Meta-filler heal failed for ${table}.${col} (non-fatal, continuing):`, targetErr);
          }
        }
      } catch (err) {
        console.error('[Migrate] Meta-filler bullet heal failed (non-fatal):', err);
      }
      // Human-gated topic proposals log (Task #336).
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS classification_topic_proposals (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          kind TEXT NOT NULL DEFAULT 'primary_topic',
          proposed_label TEXT NOT NULL,
          sample_title TEXT,
          rationale TEXT,
          occurrences INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'pending',
          first_proposed_at TIMESTAMP NOT NULL DEFAULT NOW(),
          last_proposed_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS classification_topic_proposals_kind_label_idx ON classification_topic_proposals (kind, proposed_label)`);
      console.log('✅ Ensured curated lane tables exist (curated_items, curated_cluster_members, curated_story_synthesis, curated_classifications, classification_topic_proposals)');
    } catch (error) {
      console.log('curated lane tables already exist or error:', error);
    }

    // Curated-only manual Priority overrides set by allowlisted Curated-view
    // users. CURATED-ONLY: applied solely when building the curated top-stories
    // feed; NEVER written to headlines.priority_override or
    // manual_submissions.priority_override (which feed Classic/Visual/custom-MCOP/
    // public-API). Keyed by a standalone item's stable curated key
    // (`main:<id>` / `curated:<id>`) or a cluster's deterministic id
    // (`cluster:<clusterId>`). Read ONLY by the curated-gated endpoint.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_priority_overrides (
          key TEXT PRIMARY KEY,
          priority_score INTEGER NOT NULL,
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      console.log('✅ Ensured curated_priority_overrides table exists');
    } catch (error) {
      console.log('curated_priority_overrides table already exists or error:', error);
    }

    // Curated-only dead-link REPLACEMENTS (Task #226). Allowlist-gated overlay
    // that redirects a curated item's article URL to a working one WITHOUT
    // mutating curated_items.url (keeps clustering identity stable). Keyed by the
    // item's stable curated key (`curated:<id>`). Read ONLY by curated-gated
    // endpoints / the curated enrichment+liveness path — NEVER the main feed,
    // Classic/Visual, custom MCOPs, or the public REST API.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_link_replacements (
          key TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      console.log('✅ Ensured curated_link_replacements table exists');
    } catch (error) {
      console.log('curated_link_replacements table already exists or error:', error);
    }

    // Curated-only editor HIDE overlay (Task #380). Allowlist-gated take-down of a
    // bad curated story. CURATED-ONLY: read solely when building the curated
    // top-stories feed to EXCLUDE the story; never written to or read by the main
    // feed, Classic/Visual, custom MCOPs, or the public REST API. Keyed by the
    // story's stable key (`cluster:<clusterId>` | `main:<id>` | `curated:<id>`).
    // cluster_id + member_keys are captured at hide-time so the hide survives a
    // re-cluster that changes the deterministic clusterId or representative.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_hidden_stories (
          key TEXT PRIMARY KEY,
          cluster_id TEXT,
          member_keys TEXT[],
          hidden_by TEXT NOT NULL,
          hidden_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      console.log('✅ Ensured curated_hidden_stories table exists');
    } catch (error) {
      console.log('curated_hidden_stories table already exists or error:', error);
    }

    // Curated-only editor PHOTO overlays (Task #380 expansion). Allowlist-gated,
    // CURATED-ONLY: read SOLELY when building the curated top-stories feed. Never
    // written to / read by the main feed, Classic/Visual, custom MCOPs, or the
    // public REST API. image_replacements redirects a single-source item's DISPLAY
    // photo (keyed `main:<id>`/`curated:<id>`); hidden_images suppresses a cluster
    // member's photo (keyed by image URL, deduped) so it drops from previews.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_image_replacements (
          key TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      console.log('✅ Ensured curated_image_replacements table exists');
    } catch (error) {
      console.log('curated_image_replacements table already exists or error:', error);
    }
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_hidden_images (
          image_url TEXT PRIMARY KEY,
          hidden_by TEXT NOT NULL,
          hidden_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      console.log('✅ Ensured curated_hidden_images table exists');
    } catch (error) {
      console.log('curated_hidden_images table already exists or error:', error);
    }

    // Curated lane — EDITOR manual-link overlay (human counterpart of the split
    // overlay). Records an editor's deliberate "these are ONE story" decision
    // (link a stray item into a story, or merge selected items). Consumed in the
    // clustering pass as a deterministic must-link keyed by normalized member URL,
    // so it survives the per-pass member wipe and overrides the AI grouping guard
    // for those items only. Also the editor-update audit trail surfaced in Source
    // Oversight (who/when/AI verdict + reasoning/override). CURATED-ONLY: never
    // read by Classic/Visual/custom-MCOP or the public API.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_manual_links (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          member_urls TEXT[] NOT NULL DEFAULT '{}',
          label TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'link',
          created_by TEXT NOT NULL DEFAULT '',
          ai_verdict TEXT NOT NULL DEFAULT 'skipped',
          ai_reasoning TEXT NOT NULL DEFAULT '',
          overrode_ai BOOLEAN NOT NULL DEFAULT FALSE,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_manual_links_status_idx ON curated_manual_links (status)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_manual_links_updated_idx ON curated_manual_links (updated_at)`);
      // Optional reason columns added later (idempotent on existing deployments).
      await db.execute(sql`ALTER TABLE curated_manual_links ADD COLUMN IF NOT EXISTS reason_keys TEXT[]`);
      await db.execute(sql`ALTER TABLE curated_manual_links ADD COLUMN IF NOT EXISTS reason_note TEXT`);
      // One-time/idempotent DEDUP sweep (Task #778): the editor UI could record
      // the same link twice as separate active rows (identical member-URL set,
      // minutes apart), so each set was re-applied N times per clustering pass
      // and cluttered the Source Oversight audit log. Collapse EXACT duplicates
      // (same kind + same member-URL SET, both still active) by deleting the
      // younger rows and keeping the OLDEST — preserving the original who/when
      // on the surviving row. Going forward createCuratedManualLink upserts, so
      // this only ever cleans historical residue (no-op when clean).
      const dedupResult = await db.execute(sql`
        DELETE FROM curated_manual_links a
        USING curated_manual_links b
        WHERE a.status = 'active' AND b.status = 'active'
          AND a.kind = b.kind
          AND a.id <> b.id
          AND (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(a.member_urls) x)
            = (SELECT array_agg(DISTINCT y ORDER BY y) FROM unnest(b.member_urls) y)
          AND (a.created_at > b.created_at OR (a.created_at = b.created_at AND a.id > b.id))
      `);
      const dedupCount = (dedupResult as any)?.rowCount ?? 0;
      if (dedupCount > 0) {
        console.log(`✅ Collapsed ${dedupCount} duplicate active curated_manual_links row(s)`);
      }
      console.log('✅ Ensured curated_manual_links table exists');
    } catch (error) {
      console.log('curated_manual_links table already exists or error:', error);
    }

    // Curated lane — EDITOR manual-EVICTION overlay (the mirror-image of the
    // manual-link above): an editor's decision that ONE article does NOT belong
    // in the story it was wrongly clustered into. Applied in the clustering pass
    // AFTER the must-link reconcile — the evicted member is removed from any
    // group that is still substantially the wrongly-merged cluster (identified
    // by the snapshot of its sibling anchor URLs) and falls back to a standalone
    // node. Keyed by NORMALIZED identity URL so it survives the main:/curated:
    // key flip and membership churn. Fail-closed: no-ops when the evicted URL
    // aged out or the cluster dispersed. CURATED-ONLY: never read by
    // Classic/Visual/custom-MCOP or the public API.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_manual_evictions (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          evicted_url TEXT NOT NULL,
          anchor_urls TEXT[] NOT NULL DEFAULT '{}',
          label TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL DEFAULT '',
          reason_keys TEXT[],
          reason_note TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_manual_evictions_status_idx ON curated_manual_evictions (status)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_manual_evictions_updated_idx ON curated_manual_evictions (updated_at)`);
      console.log('✅ Ensured curated_manual_evictions table exists');
    } catch (error) {
      console.log('curated_manual_evictions table already exists or error:', error);
    }

    // Curated lane — editor manual MOVE overlay (curated-only, mirrors the
    // eviction table above). A move atomically re-homes ONE article from its
    // source story into an editor-chosen target story. Stored as its own
    // overlay (NOT an eviction + manual-link pair) because manual links are
    // reconciled BEFORE evictions in the clustering pass — a link containing
    // the moved item would fuse the source and target clusters. Applied by
    // applyManualMoves AFTER evictions, anchor-guarded on both the source and
    // target side. CURATED-ONLY: never read by Classic/Visual/custom-MCOP or
    // the public API.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_manual_moves (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          item_url TEXT NOT NULL,
          source_anchor_urls TEXT[] NOT NULL DEFAULT '{}',
          target_anchor_urls TEXT[] NOT NULL DEFAULT '{}',
          label TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL DEFAULT '',
          reason_keys TEXT[],
          reason_note TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_manual_moves_status_idx ON curated_manual_moves (status)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_manual_moves_updated_idx ON curated_manual_moves (updated_at)`);
      console.log('✅ Ensured curated_manual_moves table exists');
    } catch (error) {
      console.log('curated_manual_moves table already exists or error:', error);
    }

    // Curated lane — editor-feedback LEARNING LOOP (Task #659). Compiled
    // candidate rules (approval queue) mined from curated_override_events +
    // curated_manual_links. CURATED-ONLY, fail-closed: applying a rule is
    // never automatic, only a human Approve in Source Oversight writes it live.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_learned_rules (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          rule_type TEXT NOT NULL,
          signature TEXT NOT NULL,
          label TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          evidence_count INTEGER NOT NULL DEFAULT 0,
          evidence_samples JSONB NOT NULL DEFAULT '[]'::jsonb,
          confidence TEXT NOT NULL DEFAULT 'low',
          status TEXT NOT NULL DEFAULT 'suggested',
          snoozed_until TIMESTAMP,
          applied_state JSONB,
          decided_by TEXT,
          decided_at TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_learned_rules_signature_idx ON curated_learned_rules (signature)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_learned_rules_status_idx ON curated_learned_rules (status)`);
      console.log('✅ Ensured curated_learned_rules table exists');
    } catch (error) {
      console.log('curated_learned_rules table already exists or error:', error);
    }

    // =========================================================================
    // Curated lane — EDITORIAL EPISODE + OBSERVATION/OUTCOME model (Task #1180).
    // Additive, curated-only observability layer built ON TOP OF the immutable
    // curated_override_events log. Episodes collapse raw events into a single
    // legible editorial intent with lifecycle + persistence counters + lineage;
    // observations record how the intent evolved; the outcome is the single
    // authoritative present-tense disposition. Raw events are attached BY
    // REFERENCE (never edited/deleted). NEVER alters feeds, human overrides,
    // outlet roles, or training labels. Idempotent (IF NOT EXISTS / IF EXISTS).
    // =========================================================================
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_editorial_episodes (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          signature TEXT NOT NULL UNIQUE,
          action_family TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL DEFAULT '',
          reason_keys TEXT[],
          reason_note TEXT,
          canonical_url TEXT,
          story_key TEXT,
          outlet_id TEXT,
          before_json JSONB,
          requested_json JSONB,
          actual_json JSONB,
          alternatives_json JSONB,
          provenance_json JSONB,
          editor_surface TEXT,
          direction TEXT,
          verified BOOLEAN NOT NULL DEFAULT FALSE,
          ambiguous BOOLEAN NOT NULL DEFAULT FALSE,
          lifecycle TEXT NOT NULL DEFAULT 'open',
          outcome TEXT,
          outcome_note TEXT,
          event_count INTEGER NOT NULL DEFAULT 0,
          editor_count INTEGER NOT NULL DEFAULT 0,
          observation_count INTEGER NOT NULL DEFAULT 0,
          first_event_at TIMESTAMP,
          last_event_at TIMESTAMP,
          contradicts_episode_id VARCHAR,
          superseded_by_id VARCHAR,
          undone_by_event_id VARCHAR,
          created_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_editorial_episodes_signature_idx ON curated_editorial_episodes (signature)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_editorial_episodes_action_family_idx ON curated_editorial_episodes (action_family)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_editorial_episodes_lifecycle_idx ON curated_editorial_episodes (lifecycle)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_editorial_episodes_canonical_url_idx ON curated_editorial_episodes (canonical_url)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_editorial_episodes_updated_idx ON curated_editorial_episodes (updated_at)`);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS curated_editorial_episodes_active_observer_idx
        ON curated_editorial_episodes (action_family, lifecycle, updated_at DESC)
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_editorial_episode_events (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          episode_id VARCHAR NOT NULL,
          event_id VARCHAR NOT NULL,
          event_action TEXT,
          event_editor TEXT,
          event_at TIMESTAMP,
          attached_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_editorial_episode_events_episode_idx ON curated_editorial_episode_events (episode_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_editorial_episode_events_event_idx ON curated_editorial_episode_events (event_id)`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS curated_editorial_episode_events_uniq ON curated_editorial_episode_events (episode_id, event_id)`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_editorial_observations (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          episode_id VARCHAR NOT NULL,
          observation_key TEXT,
          kind TEXT NOT NULL DEFAULT 'observed',
          note TEXT,
          detail_json JSONB,
          observed_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_editorial_observations_episode_idx ON curated_editorial_observations (episode_id)`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS curated_editorial_observations_uniq ON curated_editorial_observations (episode_id, observation_key)`);
      console.log('✅ Ensured curated_editorial_episode tables exist');
    } catch (error) {
      console.log('curated_editorial_episode tables already exist or error:', error);
    }

    // =========================================================================
    // Curated lane — FROZEN LEGACY LEARNED-RULE INVENTORY (Task #1180). The
    // Task #659 curated_learned_rules approval queue is retired in favor of the
    // editorial-episode model. This migration FREEZES the legacy rows into an
    // inert inventory (never enforced, never a training label, never writes to
    // overlays/outlet roles) so their history stays reviewable:
    //   approved            -> disposition 'frozen-review'   (was live)
    //   suggested | snoozed -> disposition 'historical-only' (never applied)
    //   anything else       -> disposition 'historical-other'(preserved verbatim)
    // Idempotent: keyed by the source legacy_rule_id with ON CONFLICT DO NOTHING,
    // so re-running never duplicates and never touches immutable history. The
    // legacy curated_learned_rules rows are LEFT INTACT (not deleted) — this only
    // COPIES them into the frozen inventory.
    // =========================================================================
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_legacy_rule_inventory (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          legacy_rule_id VARCHAR NOT NULL UNIQUE,
          rule_type TEXT NOT NULL DEFAULT '',
          signature TEXT NOT NULL DEFAULT '',
          label TEXT NOT NULL DEFAULT '',
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          legacy_status TEXT NOT NULL DEFAULT '',
          disposition TEXT NOT NULL DEFAULT 'historical-other',
          dispositioned_by TEXT,
          dispositioned_at TIMESTAMP,
          evidence_count INTEGER NOT NULL DEFAULT 0,
          frozen_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`ALTER TABLE curated_legacy_rule_inventory ADD COLUMN IF NOT EXISTS dispositioned_by TEXT`);
      await db.execute(sql`ALTER TABLE curated_legacy_rule_inventory ADD COLUMN IF NOT EXISTS dispositioned_at TIMESTAMP`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_legacy_rule_inventory_disposition_idx ON curated_legacy_rule_inventory (disposition)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_legacy_rule_inventory_legacy_status_idx ON curated_legacy_rule_inventory (legacy_status)`);

      // Transition legacy rows into the frozen inventory. Only runs if the legacy
      // table exists (a fresh DB has no legacy rows — the copy is a no-op). The
      // disposition is derived from the legacy status. ON CONFLICT keeps this
      // idempotent and non-destructive: existing frozen rows are never rewritten,
      // and the source curated_learned_rules rows are never modified or deleted.
      const legacyExists = await db.execute(sql`SELECT to_regclass('public.curated_learned_rules') AS reg`);
      const hasLegacy = Boolean((legacyExists as any).rows?.[0]?.reg);
      if (hasLegacy) {
        await db.execute(sql`
          INSERT INTO curated_legacy_rule_inventory
            (legacy_rule_id, rule_type, signature, label, payload, legacy_status, disposition, evidence_count)
          SELECT
            r.id,
            COALESCE(r.rule_type, ''),
            COALESCE(r.signature, ''),
            COALESCE(r.label, ''),
            COALESCE(r.payload, '{}'::jsonb),
            COALESCE(r.status, ''),
            CASE
              WHEN r.status = 'approved' THEN 'frozen-review'
              WHEN r.status IN ('suggested', 'snoozed') THEN 'historical-only'
              ELSE 'historical-other'
            END,
            COALESCE(r.evidence_count, 0)
          FROM curated_learned_rules r
          ON CONFLICT (legacy_rule_id) DO NOTHING
        `);
      }
      console.log('✅ Ensured curated_legacy_rule_inventory (frozen legacy rules) exists');
    } catch (error) {
      console.log('curated_legacy_rule_inventory table already exists or error:', error);
    }

    // Curated lane — HISTORICAL story ARCHIVE. The live curated_cluster_members
    // table is wiped+rebuilt each pass, so only the current snapshot exists. This
    // table preserves every FORMED story over time: one row per story keyed by the
    // deterministic content signature (= clusterId). Written off the hot path
    // during the clustering cron (upsert by signature). Read ONLY by the
    // curated-gated /api/curated/archive endpoint (fail-closed isolation).
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_story_archive (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          signature TEXT NOT NULL UNIQUE,
          headline TEXT NOT NULL DEFAULT '',
          lede TEXT NOT NULL DEFAULT '',
          facts TEXT[] NOT NULL DEFAULT '{}',
          attributed_claims TEXT[] NOT NULL DEFAULT '{}',
          category TEXT,
          region TEXT,
          country TEXT,
          source_count INTEGER NOT NULL DEFAULT 0,
          rep_title TEXT,
          rep_source TEXT,
          rep_url TEXT,
          og_image_url TEXT,
          members JSONB NOT NULL DEFAULT '[]'::jsonb,
          first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`ALTER TABLE curated_story_archive ADD COLUMN IF NOT EXISTS attributed_claims TEXT[] NOT NULL DEFAULT '{}'`);
      // Split-lineage guard (smart process re-partition): sub-stories split off
      // the same developing-process mega-cluster carry distinct lineage keys so
      // archive carry-forward/absorb can never merge siblings back into one.
      await db.execute(sql`ALTER TABLE curated_story_archive ADD COLUMN IF NOT EXISTS split_lineage_key TEXT`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_story_archive_last_seen_idx ON curated_story_archive (last_seen_at)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_story_archive_signature_idx ON curated_story_archive (signature)`);
      console.log('✅ Ensured curated_story_archive table exists');
    } catch (error) {
      console.log('curated_story_archive table already exists or error:', error);
    }

    // Curated lane — "smart process re-partition" OVERLAY (option b). Persists an
    // AI split decision (children keyed by member-signature tokens) so a large/old
    // developing-process mega-cluster is broken into coexisting sub-stories
    // deterministically on every pass, surviving the per-pass member-table wipe.
    // CURATED-ONLY: applied solely inside the curated clustering pass; never feeds
    // Classic/Visual/custom-MCOP or the public API. FK-free observability/control.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_process_split_overlays (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          children JSONB NOT NULL DEFAULT '[]'::jsonb,
          verdict_hash TEXT NOT NULL DEFAULT '',
          evaluated_member_hash TEXT NOT NULL DEFAULT '',
          evaluated_member_count INTEGER NOT NULL DEFAULT 0,
          trigger_reason TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          last_evaluated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_process_split_overlays_last_evaluated_idx ON curated_process_split_overlays (last_evaluated_at)`);
      console.log('✅ Ensured curated_process_split_overlays table exists');
    } catch (error) {
      console.log('curated_process_split_overlays table already exists or error:', error);
    }

    // Curated lane — clustering "flight recorder". One row appended per
    // clusterCuratedLane pass capturing the shape of what shipped + refinement
    // backstop behavior + archive churn. FK-free, append-only observability —
    // written fail-open AFTER archiving (a metrics failure can never break a
    // pass). Read ONLY by the curated-gated /api/curated/cluster-metrics
    // endpoint (fail-closed isolation; never on the public API).
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_cluster_metrics (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          refinement_tag TEXT,
          formed_stories INTEGER NOT NULL DEFAULT 0,
          total_members INTEGER NOT NULL DEFAULT 0,
          max_cluster_size INTEGER NOT NULL DEFAULT 0,
          median_cluster_size INTEGER NOT NULL DEFAULT 0,
          p95_cluster_size INTEGER NOT NULL DEFAULT 0,
          large_clusters INTEGER NOT NULL DEFAULT 0,
          developing_process_clusters INTEGER NOT NULL DEFAULT 0,
          unsynthesized_formed_stories INTEGER NOT NULL DEFAULT 0,
          false_merge_dissolutions INTEGER NOT NULL DEFAULT 0,
          anchor_split_audited INTEGER NOT NULL DEFAULT 0,
          anchor_split_released INTEGER NOT NULL DEFAULT 0,
          anchor_split_vetoes INTEGER NOT NULL DEFAULT 0,
          anchor_split_developing_skips INTEGER NOT NULL DEFAULT 0,
          release_cap_clamps INTEGER NOT NULL DEFAULT 0,
          archive_rows_seen INTEGER NOT NULL DEFAULT 0,
          archive_exact_updates INTEGER NOT NULL DEFAULT 0,
          archive_carry_forward_merges INTEGER NOT NULL DEFAULT 0,
          archive_inserted INTEGER NOT NULL DEFAULT 0,
          archive_absorbed_duplicates INTEGER NOT NULL DEFAULT 0,
          archive_skipped_unsynthesized INTEGER NOT NULL DEFAULT 0,
          smart_repartition_audited INTEGER NOT NULL DEFAULT 0,
          smart_repartition_triggered INTEGER NOT NULL DEFAULT 0,
          smart_repartition_cache_hits INTEGER NOT NULL DEFAULT 0,
          smart_repartition_children_created INTEGER NOT NULL DEFAULT 0,
          smart_repartition_members_moved INTEGER NOT NULL DEFAULT 0,
          smart_repartition_failed INTEGER NOT NULL DEFAULT 0,
          smart_repartition_cooldown_skipped INTEGER NOT NULL DEFAULT 0,
          prevention_repartition_audited INTEGER NOT NULL DEFAULT 0,
          prevention_repartition_triggered INTEGER NOT NULL DEFAULT 0,
          prevention_repartition_children_created INTEGER NOT NULL DEFAULT 0
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_cluster_metrics_created_at_idx ON curated_cluster_metrics (created_at)`);
      // Idempotent column adds for pre-existing tables (Task #391 smart re-partition).
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS smart_repartition_audited INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS smart_repartition_triggered INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS smart_repartition_cache_hits INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS smart_repartition_children_created INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS smart_repartition_members_moved INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS smart_repartition_failed INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS smart_repartition_cooldown_skipped INTEGER NOT NULL DEFAULT 0`);
      // Idempotent column adds (Task #414 early process-prevention split).
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS prevention_repartition_audited INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS prevention_repartition_triggered INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS prevention_repartition_children_created INTEGER NOT NULL DEFAULT 0`);
      // Idempotent column adds (Task #626 suspected missed-corroboration alarm).
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS suspected_missed_merges INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS suspected_missed_merge_samples TEXT`);
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS anchor_split_oversized_escapes INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS anchor_split_oversized_released INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE curated_cluster_metrics ADD COLUMN IF NOT EXISTS missed_merge_reconciled INTEGER NOT NULL DEFAULT 0`);
      console.log('✅ Ensured curated_cluster_metrics table exists');
    } catch (error) {
      console.log('curated_cluster_metrics table already exists or error:', error);
    }

    // Curated lane (Task #203) — "Competing Coverage" cache. One row per scope
    // ('domestic' | 'international'); items is a JSONB array of {rank, headline}.
    // No FKs — populated solely by the background GDELT job, read only by the
    // curated-gated endpoint.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS competing_coverage_cache (
          scope TEXT PRIMARY KEY,
          items JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      console.log('✅ Ensured competing_coverage_cache table exists');
    } catch (error) {
      console.log('competing_coverage_cache table already exists or error:', error);
    }

    // ---------------------------------------------------------------------
    // Schema-drift column backfill. Several base tables are created above with
    // an INCOMPLETE column set versus shared/schema.ts, and not every missing
    // column is added by an earlier ALTER. On a fresh/reset DB those gaps
    // surface as Postgres 42703 ("column does not exist") the moment an
    // endpoint inserts/selects them (e.g. submitting an article needs
    // manual_submissions.submitted_by). Every ADD COLUMN here is idempotent
    // (IF NOT EXISTS); NOT NULL columns carry a DEFAULT so the ALTER is also
    // safe on pre-existing tables that already hold rows.
    // Verified by replaying migrate against an empty Postgres schema and
    // diffing columns against the schema definitions (.local/verify-migrate.ts).
    // ---------------------------------------------------------------------
    try {
      await db.execute(sql`
        ALTER TABLE headlines
        ADD COLUMN IF NOT EXISTS cluster_id VARCHAR,
        ADD COLUMN IF NOT EXISTS is_cluster_representative BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS og_image_url TEXT,
        ADD COLUMN IF NOT EXISTS video_url TEXT,
        ADD COLUMN IF NOT EXISTS summary_bullets TEXT[],
        ADD COLUMN IF NOT EXISTS media_scraped_at TIMESTAMP
      `);

      await db.execute(sql`
        ALTER TABLE truth_social_posts
        ADD COLUMN IF NOT EXISTS image_url TEXT,
        ADD COLUMN IF NOT EXISTS video_url TEXT,
        ADD COLUMN IF NOT EXISTS video_thumbnail_url TEXT,
        ADD COLUMN IF NOT EXISTS is_reblog BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS reblogged_from TEXT,
        ADD COLUMN IF NOT EXISTS extracted_image_text TEXT,
        ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT false
      `);

      await db.execute(sql`
        ALTER TABLE x_posts
        ADD COLUMN IF NOT EXISTS source_account TEXT NOT NULL DEFAULT 'SecWar',
        ADD COLUMN IF NOT EXISTS is_retweet BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS retweeted_from TEXT,
        ADD COLUMN IF NOT EXISTS image_url TEXT,
        ADD COLUMN IF NOT EXISTS media_scraped_at TIMESTAMP
      `);

      await db.execute(sql`ALTER TABLE rapidresponse_posts ADD COLUMN IF NOT EXISTS image_url TEXT`);
      await db.execute(sql`ALTER TABLE dow_response_posts ADD COLUMN IF NOT EXISTS image_url TEXT`);

      await db.execute(sql`
        ALTER TABLE first_alerts
        ADD COLUMN IF NOT EXISTS url TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS published_at TIMESTAMP NOT NULL DEFAULT NOW()
      `);

      // T001: index the published_at column that getRecentFirstAlerts ORDERs BY.
      // The fresh-DB branch above only creates first_alerts_event_time_idx, and
      // shared/schema.ts's published_at index declaration is never executed by
      // this boot migrator — so on EXISTING databases an
      // `ORDER BY published_at DESC LIMIT n` top-N-sorts the whole table
      // (~200k rows) on every read, a heap/CPU cost under load. This always-run,
      // idempotent CREATE backfills the index on existing DBs (no-op once present).
      await db.execute(sql`CREATE INDEX IF NOT EXISTS first_alert_published_at_idx ON first_alerts (published_at DESC)`);

      // Relax stray NOT NULL constraints on EXISTING databases whose first_alerts
      // table was created by an older migrate.ts. shared/schema.ts treats
      // alert_type as nullable and has no event_time column, so a schema-conformant
      // insert omits them and 23502s if these columns are still NOT NULL.
      // DROP NOT NULL is idempotent (no-op when already nullable / on fresh DBs).
      await db.execute(sql`
        ALTER TABLE first_alerts
        ALTER COLUMN alert_type DROP NOT NULL,
        ALTER COLUMN event_time DROP NOT NULL
      `);

      await db.execute(sql`
        ALTER TABLE manual_submissions
        ADD COLUMN IF NOT EXISTS pdf_path TEXT,
        ADD COLUMN IF NOT EXISTS submitted_by TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS priority_override INTEGER,
        ADD COLUMN IF NOT EXISTS cluster_id VARCHAR,
        ADD COLUMN IF NOT EXISTS is_cluster_representative BOOLEAN DEFAULT true
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_live_broadcast_firings (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          event_key TEXT NOT NULL,
          state TEXT NOT NULL,
          leader TEXT NOT NULL,
          title TEXT NOT NULL,
          watch_url TEXT NOT NULL,
          source TEXT,
          starts_at TIMESTAMP,
          first_observed_at TIMESTAMP NOT NULL,
          ended_at TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`ALTER TABLE curated_live_broadcast_firings ADD COLUMN IF NOT EXISTS event_key TEXT`);
      await db.execute(sql`UPDATE curated_live_broadcast_firings SET event_key = 'legacy:' || id WHERE event_key IS NULL`);
      await db.execute(sql`ALTER TABLE curated_live_broadcast_firings ALTER COLUMN event_key SET NOT NULL`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_live_broadcast_firings_event_key_idx ON curated_live_broadcast_firings (event_key)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_live_broadcast_firings_created_at_idx ON curated_live_broadcast_firings (created_at DESC)`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_live_broadcast_moderations (
          event_key TEXT PRIMARY KEY,
          suppressed BOOLEAN NOT NULL DEFAULT false,
          overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      // Committee hearing tracker (Task #1077). Scheduled HASC/SASC hearings
      // with a key-defense-leader witness. Written only by the hourly
      // hearingTracker poll; read by the curated live-broadcast banner signal
      // and testimony intake. Never read by any main-feed path.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS committee_hearings (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          committee TEXT NOT NULL,
          title TEXT NOT NULL,
          event_url TEXT NOT NULL UNIQUE,
          starts_at TIMESTAMP,
          witnesses TEXT[] NOT NULL DEFAULT '{}',
          tracked_leaders TEXT[] NOT NULL DEFAULT '{}',
          banner_leader TEXT,
          testimony_urls TEXT[] NOT NULL DEFAULT '{}',
          first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS committee_hearings_starts_at_idx ON committee_hearings (starts_at DESC)`);

      // Curated lane — editor-OVERRIDE LEARNING LOG (Task #540). Append-only event
      // log of every Curated moderation action + content snapshot, plus a single-row
      // capture-pause flag. Curated-only; read solely by the curated-gated
      // override-log endpoint (never by any feed path).
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_override_events (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          action TEXT NOT NULL,
          story_key TEXT,
          item_url TEXT,
          headline TEXT,
          outlet TEXT,
          country TEXT,
          region TEXT,
          content_kind TEXT,
          original_score INTEGER,
          original_reasoning TEXT,
          original_topic TEXT,
          original_category TEXT,
          new_value TEXT,
          editor TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      // Idempotent column adds for tables created before these columns existed.
      await db.execute(sql`ALTER TABLE curated_override_events ADD COLUMN IF NOT EXISTS original_reasoning TEXT`);
      await db.execute(sql`ALTER TABLE curated_override_events ADD COLUMN IF NOT EXISTS reason_keys TEXT[]`);
      await db.execute(sql`ALTER TABLE curated_override_events ADD COLUMN IF NOT EXISTS reason_note TEXT`);
      await db.execute(sql`ALTER TABLE curated_override_events ADD COLUMN IF NOT EXISTS before_value JSONB`);
      await db.execute(sql`ALTER TABLE curated_override_events ADD COLUMN IF NOT EXISTS after_value JSONB`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_override_events_created_at_idx ON curated_override_events (created_at DESC)`);
      // Scoring Radar telemetry columns (Task #834).
      await db.execute(sql`ALTER TABLE curated_override_events ADD COLUMN IF NOT EXISTS raw_score INTEGER`);
      await db.execute(sql`ALTER TABLE curated_override_events ADD COLUMN IF NOT EXISTS decayed_score INTEGER`);
      await db.execute(sql`ALTER TABLE curated_override_events ADD COLUMN IF NOT EXISTS item_age_hours DOUBLE PRECISION`);
      await db.execute(sql`ALTER TABLE curated_override_events ADD COLUMN IF NOT EXISTS surfacing_state TEXT`);
      await db.execute(sql`ALTER TABLE curated_override_events ADD COLUMN IF NOT EXISTS from_radar BOOLEAN DEFAULT false`);
      // Exact URL identity only: adjustment attribution never falls back to title,
      // outlet, or proximity alone.
      await db.execute(sql`ALTER TABLE curated_override_events ADD COLUMN IF NOT EXISTS canonical_url TEXT`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS curated_override_events_canonical_url_created_at_idx ON curated_override_events (canonical_url, created_at DESC)`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_feedback_settings (
          id TEXT PRIMARY KEY DEFAULT 'global',
          capture_paused BOOLEAN NOT NULL DEFAULT false,
          updated_by TEXT,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`ALTER TABLE curated_feedback_settings ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP`);

      // One-time Straits Times brand-logo heal (Task #761). ST publishes breaking
      // stories with their "ST" masthead logo as the og:image share image, then
      // swaps it for a real photo later. MCOP scrapes the article during the early
      // "logo window", persists the 6 KB logo to object storage, and stamps the row
      // done (media_scraped_at IS NOT NULL). It then never re-scrapes, so the card
      // stays stuck on the logo even after ST attaches a real photo.
      //
      // The content-based logo detector added in the same task prevents NEW rows
      // from being stamped done with a logo. This one-time heal resets rows already
      // stuck, so the recurring backfill picks them up and re-fetches the real photo.
      // Guarded by media_rescue_at IS NULL so it runs ONCE PER ROW: a row that
      // re-fails climbs back through the back-off and is never rescued a second time.
      // og_image_url is also cleared so the client shows the neutral fallback (not
      // the stored logo) during the short window before re-enrichment completes.
      // Isolated in its own try/catch: a failure here must never abort the DDL above.
      try {
        await db.execute(sql`
          UPDATE curated_items
          SET og_image_url = NULL,
              media_scraped_at = NULL,
              media_attempt_count = 0,
              last_media_attempt_at = NULL,
              media_rescue_at = now()
          WHERE media_rescue_at IS NULL
            AND media_scraped_at IS NOT NULL
            AND og_image_url IS NOT NULL
            AND (
              url ILIKE '%straitstimes.com%'
              OR source ILIKE '%straits times%'
            )
        `);
      } catch (stHealErr) {
        console.error('[Migrate] Straits Times logo-heal backfill failed (non-fatal):', stHealErr);
      }

      console.log('✅ Backfilled schema-drift columns to match shared/schema.ts');
    } catch (error) {
      console.error('❌ Error backfilling schema-drift columns:', error);
      throw error;
    }

    // Curated lane — editor HEADLINE + BULLETS overlay. Allowlist-gated, CURATED-
    // ONLY: stores a manual correction to a story's display headline and/or summary
    // bullets. Keyed by `main:<id>` / `curated:<id>` (standalone) or
    // `cluster:<clusterId>` (formed cluster). Applied ONLY when building the curated
    // top-stories read path. The stored `title` / `normalizedTitle` is NEVER mutated
    // (clustering / dedup identity stays intact). NEVER read by headlines,
    // manual_submissions, Classic/Visual, custom MCOPs, or the public REST API.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_headline_overrides (
          key TEXT PRIMARY KEY,
          headline TEXT,
          bullets TEXT[],
          claims TEXT[],
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          provenance TEXT NOT NULL DEFAULT 'human'
        )
      `);
      // Idempotent ALTER for pre-existing tables missing the provenance column
      // (Task #176 automated headline repair). Existing rows were all editor-set
      // so they default to 'human' and stay protected from auto clobber.
      await db.execute(sql`
        ALTER TABLE curated_headline_overrides
        ADD COLUMN IF NOT EXISTS provenance TEXT NOT NULL DEFAULT 'human'
      `);
      await db.execute(sql`
        ALTER TABLE curated_headline_overrides
        ADD COLUMN IF NOT EXISTS claims TEXT[]
      `);
      console.log('✅ Ensured curated_headline_overrides table exists');
    } catch (error) {
      console.log('curated_headline_overrides table already exists or error:', error);
    }

    // Curated View feedback inbox — submissions from any Curated viewer.
    // CURATED-ONLY: never read by any feed or public API.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_view_feedback (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          feedback_type TEXT NOT NULL,
          message TEXT NOT NULL,
          anonymous BOOLEAN NOT NULL DEFAULT FALSE,
          wants_follow_up BOOLEAN NOT NULL DEFAULT FALSE,
          contact_name TEXT,
          contact_email TEXT,
          contact_org TEXT,
          reviewed BOOLEAN NOT NULL DEFAULT FALSE,
          reviewed_by TEXT,
          reviewed_at TIMESTAMP,
          submitted_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      console.log('✅ Ensured curated_view_feedback table exists');
    } catch (error) {
      console.log('curated_view_feedback table already exists or error:', error);
    }

    // Priority/BOLO mis-tag heal (Task #884). The pre-keyword-gate AI tagger
    // tagged every defense-adjacent headline to a topic (e.g. 63/63 junk on
    // "Defense Spending Bill"). Clear joePrioritySubjectId on recent submissions
    // whose HEADLINE fails the topic's deterministic keyword gate — the exact
    // gate the tagger now enforces (watchTopicMatchCore.matchesTopic), so a
    // cleared row can never be re-tagged into a heal loop. Safety rails:
    //   • joePrioritySubjectId is written ONLY by joePriorityMatcher (grep-
    //     verified; routes.ts only reads it), so every link is AI-assigned —
    //     no human assignment can be clobbered.
    //   • Topics with no usable keyword gate are SKIPPED (legacy topics without
    //     watchKeywords keep their historical tags untouched).
    //   • Bounded to a 60-day window; older history is left alone.
    //   • Idempotent: healed rows have NULL and drop out of the next boot's scan.
    //   • Non-fatal: any error is logged and boot continues.
    try {
      const topicRows = (await db.execute(sql`
        SELECT id, name, watch_keywords, or_keywords, and_keywords, not_keywords, boost_strength, is_priority_watch, is_bolo_watch
        FROM team_subjects
      `)).rows as Array<{ id: string; name: string; watch_keywords: string[] | null; or_keywords: string[] | null; and_keywords: string[] | null; not_keywords: string[] | null; boost_strength: string | null; is_priority_watch: boolean | null; is_bolo_watch: boolean | null }>;

      const gates = new Map<string, CompiledWatchTopic | null>();
      for (const t of topicRows) {
        const compiled = compileWatchTopic({
          id: t.id,
          name: t.name,
          isPriorityWatch: t.is_priority_watch,
          isBoloWatch: t.is_bolo_watch,
          watchKeywords: t.watch_keywords,
          orKeywords: t.or_keywords,
          andKeywords: t.and_keywords,
          notKeywords: t.not_keywords,
          boostStrength: t.boost_strength,
        });
        gates.set(t.id, hasKeywordGate(compiled) ? compiled : null);
      }

      const subRows = (await db.execute(sql`
        SELECT id, headline, joe_priority_subject_id
        FROM team_submissions
        WHERE joe_priority_subject_id IS NOT NULL
          AND status = 'processed'
          AND deleted_at IS NULL
          AND created_at > NOW() - INTERVAL '60 days'
      `)).rows as Array<{ id: string; headline: string | null; joe_priority_subject_id: string }>;

      const toClear: string[] = [];
      for (const s of subRows) {
        const gate = gates.get(s.joe_priority_subject_id);
        if (gate === undefined) continue; // topic row gone — leave untouched
        if (gate === null) continue;      // no usable keywords — fail-safe, keep tag
        if (!matchesTopic(gate, s.headline || '')) toClear.push(s.id);
      }

      for (let i = 0; i < toClear.length; i += 200) {
        const chunk = toClear.slice(i, i + 200);
        await db.execute(sql`
          UPDATE team_submissions
          SET joe_priority_subject_id = NULL
          WHERE id = ANY(ARRAY[${sql.join(chunk.map(id => sql`${id}`), sql`, `)}]::varchar[])
        `);
      }

      if (toClear.length > 0) {
        console.log(`✅ [WatchTopicHeal] Cleared ${toClear.length}/${subRows.length} Priority/BOLO submission tags whose headline fails the topic keyword gate`);
      } else {
        console.log(`✅ [WatchTopicHeal] No mis-tagged Priority/BOLO submissions in window (${subRows.length} checked)`);
      }
    } catch (healErr) {
      console.error('[Migrate] Priority/BOLO mis-tag heal failed (non-fatal):', healErr);
    }

    // Curated lane — per-item human content-kind override (Task #892). An editor
    // can mark any article as analysis/opinion/editorial/other, which demotes it
    // to attach-only in clustering and bars it from every curated headline surface.
    // Protected from AI clobber by living in its own table. CURATED-ONLY.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS curated_content_kind_overrides (
          url TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          editor TEXT NOT NULL DEFAULT 'system',
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      console.log('✅ Ensured curated_content_kind_overrides table exists');
    } catch (error) {
      console.log('curated_content_kind_overrides table already exists or error:', error);
    }

    // --- Single-source spin column (Task #937, curated-lane only) ---
    // Nullable text column on curated_items for the per-article angle/framing
    // characterization generated at enrichment time. Null for social posts or
    // when no discernible angle exists; rendered in the standalone detail view.
    try {
      await db.execute(sql`ALTER TABLE curated_items ADD COLUMN IF NOT EXISTS source_spin TEXT`);
    } catch (error) {
      console.log('source_spin column already exists or error:', error);
    }

    // --- Task #1039: watch-topic detail popup schema additions ---
    // New columns on team_subjects (all idempotent, default-safe for existing rows).
    try {
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS source_prompt TEXT`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS watch_topic_label TEXT`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS lifecycle_mode TEXT NOT NULL DEFAULT 'smart_decay'`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS boost_strength TEXT NOT NULL DEFAULT 'standard'`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS or_keywords TEXT[] NOT NULL DEFAULT '{}'::text[]`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS and_keywords TEXT[] NOT NULL DEFAULT '{}'::text[]`);
      await db.execute(sql`ALTER TABLE team_subjects ADD COLUMN IF NOT EXISTS not_keywords TEXT[] NOT NULL DEFAULT '{}'::text[]`);
      // Backfill any NULL lifecycle/boost values on active watch topics so that
      // queries filtering directly on lifecycle_mode / boost_strength behave
      // consistently (defensive: the ADD COLUMN defaults cover fresh rows, but
      // columns added via an earlier nullable path in prod could still be NULL).
      await db.execute(sql`UPDATE team_subjects SET lifecycle_mode = 'smart_decay' WHERE lifecycle_mode IS NULL`);
      await db.execute(sql`UPDATE team_subjects SET boost_strength = 'standard' WHERE boost_strength IS NULL`);
      console.log('✅ Ensured team_subjects Task #1039 columns exist');
    } catch (error) {
      console.log('team_subjects Task #1039 columns already exist or error:', error);
    }

    // New table: watch_topic_telemetry — lightweight per-match records for impact stats.
    // Bounded retention (~30 days) pruned daily by the scheduler.
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS watch_topic_telemetry (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          topic_id VARCHAR NOT NULL,
          base_score INTEGER NOT NULL,
          boosted_score INTEGER NOT NULL,
          matched_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS watch_topic_telemetry_topic_id_idx ON watch_topic_telemetry (topic_id, matched_at DESC)`);
      await db.execute(sql`ALTER TABLE watch_topic_telemetry ADD COLUMN IF NOT EXISTS event_key VARCHAR`);
      await db.execute(sql`ALTER TABLE watch_topic_telemetry ADD COLUMN IF NOT EXISTS canonical_url TEXT`);
      await db.execute(sql`ALTER TABLE watch_topic_telemetry ADD COLUMN IF NOT EXISTS steering_kind TEXT NOT NULL DEFAULT 'priority'`);
      await db.execute(sql`ALTER TABLE watch_topic_telemetry ADD COLUMN IF NOT EXISTS boost_strength TEXT`);
      await db.execute(sql`ALTER TABLE watch_topic_telemetry ADD COLUMN IF NOT EXISTS intake_mode TEXT`);
      await db.execute(sql`ALTER TABLE watch_topic_telemetry ADD COLUMN IF NOT EXISTS bolo_rescue_attempted BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE watch_topic_telemetry ADD COLUMN IF NOT EXISTS bolo_rescue_used BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE watch_topic_telemetry ADD COLUMN IF NOT EXISTS bolo_budget_blocked BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE watch_topic_telemetry ADD COLUMN IF NOT EXISTS us_implication_applied BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE watch_topic_telemetry ADD COLUMN IF NOT EXISTS us_implication_reason TEXT`);
      // PostgreSQL UNIQUE permits many NULLs, so this is both retry-safe for new
      // decisions and compatible with historical identity-less telemetry.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS watch_topic_telemetry_event_key_unique ON watch_topic_telemetry (event_key)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS watch_topic_telemetry_canonical_url_matched_at_idx ON watch_topic_telemetry (canonical_url, matched_at DESC)`);
      console.log('✅ Ensured watch_topic_telemetry table exists');
    } catch (error) {
      console.log('watch_topic_telemetry table already exists or error:', error);
    }

    // --- Region-field hygiene heal (idempotent, curated-only) ---
    // The AI sometimes duplicated the COUNTRY into curated_classifications.region
    // (region="United Kingdom", country="United Kingdom"), corrupting the
    // area-of-impact semantics that Top Narratives geo bucketing relies on.
    // Write-time coercion (storage.upsertCuratedClassifications) now blocks new
    // occurrences; this one-time-per-boot sweep nulls the existing corrupted rows.
    // NARROW by design: only rows where region literally equals country AND the
    // value is not a canonical region; human-authored rows are never touched.
    // Re-running is a no-op once clean.
    try {
      const healed = await db.execute(sql`
        UPDATE curated_classifications
        SET region = NULL
        WHERE region IS NOT NULL
          AND country IS NOT NULL
          AND LOWER(TRIM(region)) = LOWER(TRIM(country))
          AND provenance IS DISTINCT FROM 'human'
          AND LOWER(TRIM(region)) NOT IN (
            'middle east','europe','indo-pacific','latin america','africa','arctic',
            'red sea','persian gulf','korean peninsula','south china sea','north america','global'
          )
      `);
      const n = (healed as any)?.rowCount ?? 0;
      if (n > 0) {
        console.log(`✅ Region hygiene heal: nulled ${n} country-duplicated region value(s)`);
      }
    } catch (error) {
      console.log('Region hygiene heal skipped or error:', error);
    }

    // --- Task #1136: heal `[Source] "…"` AI list-formatting echo in headlines ---
    // The bot screening prompts list candidates as `N. [SourceName] "title"`, and
    // the model sometimes echoed that whole formatting back as english_title, so
    // stored/displayed headlines read `[The Hill] "Netanyahu vows …"`. Write-time
    // sanitization (titleTranslator.sanitizeEchoedTitle) now blocks new
    // occurrences; this idempotent per-boot sweep rewrites already-stored rows.
    // NARROW by design: only the full echo shape — a leading `[X]` tag whose
    // remainder is ENTIRELY quote-wrapped. A genuinely quoted or bracketed real
    // headline never matches; human-authored overlays are never touched.
    // Re-running is a no-op once clean (matching rowcount goes to zero).
    try {
      // Full echo shape: [Tag] "whole rest quoted" (straight or curly quotes).
      const ECHO = `^\\[[^\\]\\n]{1,80}\\]\\s*["\u201C](.+)["\u201D]\\s*$`;

      // 1. team_submissions.headline — the feed card's displayed headline.
      //    Bot rows only (echo could only come from bot AI screening); an
      //    editor-set priority never changes the headline, so no human clobber.
      const subs = await db.execute(sql`
        UPDATE team_submissions
        SET headline = regexp_replace(headline, ${ECHO}, '\\1')
        WHERE headline ~ ${ECHO}
      `);

      // 2. team_chat_messages.message — bot post bodies start with the bold
      //    headline: `**[Source] "title"**\n\n…`. Rewrite only that bold segment.
      const CHAT_ECHO = `^\\*\\*\\[[^\\]\\n]{1,80}\\]\\s*["\u201C]([^\\n]+)["\u201D]\\*\\*`;
      const chats = await db.execute(sql`
        UPDATE team_chat_messages
        SET message = regexp_replace(message, ${CHAT_ECHO}, '**\\1**')
        WHERE message ~ ${CHAT_ECHO}
      `);

      // 3. curated_items.title — the curated lane copies the display title on
      //    reuse-mode intake. normalized_title must be recomputed in lockstep
      //    (TS normalizeTitle), so do this one row-by-row (bounded: echo rows only).
      const curatedRows = await db.execute(sql`
        SELECT id, title FROM curated_items WHERE title ~ ${ECHO}
      `);
      let curatedHealed = 0;
      for (const row of (curatedRows.rows ?? []) as Array<{ id: string; title: string }>) {
        const m = row.title.match(/^\[[^\]\n]{1,80}\]\s*["\u201C](.+)["\u201D]\s*$/s);
        if (!m) continue;
        const clean = m[1].trim();
        if (clean.length < 6) continue;
        await db.execute(sql`
          UPDATE curated_items
          SET title = ${clean}, normalized_title = ${normalizeTitle(clean)}
          WHERE id = ${row.id}
        `);
        curatedHealed++;
      }

      // 4. curated_headline_overrides — auto-provenance overlays that copied an
      //    echoed title. NEVER touch provenance='human' (editor overrides).
      const overrides = await db.execute(sql`
        UPDATE curated_headline_overrides
        SET headline = regexp_replace(headline, ${ECHO}, '\\1')
        WHERE headline IS NOT NULL
          AND headline ~ ${ECHO}
          AND provenance IS DISTINCT FROM 'human'
      `);

      const total =
        ((subs as any)?.rowCount ?? 0) +
        ((chats as any)?.rowCount ?? 0) +
        curatedHealed +
        ((overrides as any)?.rowCount ?? 0);
      if (total > 0) {
        console.log(
          `✅ Headline echo heal (Task #1136): submissions=${(subs as any)?.rowCount ?? 0}, chat=${(chats as any)?.rowCount ?? 0}, curated=${curatedHealed}, overrides=${(overrides as any)?.rowCount ?? 0}`,
        );
      }
    } catch (error) {
      console.log('Headline echo heal skipped or error:', error);
    }

    // Release-critical readiness proof for reviewed Team-save idempotency.
    // Earlier migration sections intentionally catch many optional/backfill
    // failures so the app can still boot, but this runtime route names the new
    // column directly and its ON CONFLICT clause requires this exact unique
    // index. Never report schema ready unless PostgreSQL confirms both.
    const teamIdempotencySchema = await db.execute(sql`
      SELECT
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'team_chat_messages'
            AND column_name = 'client_request_id'
        ) AS has_column,
        EXISTS (
          SELECT 1
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'team_chat_messages'
            AND indexname = 'team_chat_client_request_uniq'
            AND indexdef ILIKE '%UNIQUE INDEX%'
            AND indexdef ILIKE '%(user_id, client_request_id)%'
        ) AS has_unique_index
    `);
    const readiness = teamIdempotencySchema.rows[0] as any;
    if (!readiness?.has_column || !readiness?.has_unique_index) {
      await pool.end();
      throw new Error(
        `Required Team idempotency schema missing after migration ` +
        `(column=${Boolean(readiness?.has_column)}, uniqueIndex=${Boolean(readiness?.has_unique_index)})`,
      );
    }

    await pool.end();
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize database schema:', error);
    throw error;
  }
}
