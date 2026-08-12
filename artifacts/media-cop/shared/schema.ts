import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, real, index, jsonb, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique("users_username_key"),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const headlines = pgTable("headlines", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull().unique("headlines_title_key"),
  normalizedTitle: text("normalized_title").notNull(),
  url: text("url").notNull(),
  category: text("category").notNull(),
  source: text("source").notNull(),
  summary: text("summary").notNull(),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
  articlePublishedAt: timestamp("article_published_at"),
  priorityScore: integer("priority_score").notNull().default(0),
  priorityOverride: integer("priority_override"),
  priorityOverrideAt: timestamp("priority_override_at"),
  tags: text("tags").array().notNull().default(sql`'{}'`),
  clusterId: varchar("cluster_id"),
  isClusterRepresentative: boolean("is_cluster_representative").default(true),
  ogImageUrl: text("og_image_url"),
  videoUrl: text("video_url"),
  summaryBullets: text("summary_bullets").array(),
  // Condensed, ATTRIBUTED claims / key on-the-record statements pulled from the
  // article body (Task #256) — additive detail shown beneath the 3-bullet summary
  // in the detail/preview panel (e.g. "Israeli security sources were cited saying…").
  // Distinct from summaryBullets (which stay generic what-changed/background/extra).
  attributedClaims: text("attributed_claims").array(),
  mediaScrapedAt: timestamp("media_scraped_at"),
  // Page-detected content kind, CURATED-LANE use only. 'audio' = a podcast /
  // audio story (e.g. NPR audio) identified at enrichment time from the fetched
  // page; audio URLs are indistinguishable from text-article URLs, so unlike
  // video/opinion this cannot be derived from the URL and must be stored. NULL =
  // not yet checked or a normal reported article. Read ONLY by curated-gated
  // surfaces (kept out of standalone curated Top Stories / Top Narratives and out
  // of a cluster's face) — NEVER by the main feed / Classic / Visual / public API.
  contentKind: text("content_kind"),
  manuallyEdited: boolean("manually_edited").default(false),
  // When set (non-null, non-empty), this headline is only visible inside the
  // listed custom-MCOP slugs (e.g. ['warfighter']). NULL = globally visible.
  restrictedToMcops: text("restricted_to_mcops").array(),
  // Full article text carried from the bot/scraper at write time. NULL means
  // the scrape failed (paywall / hard-block) → stored summary is title-derived
  // and eligible for upgrade when enrichment later recovers the article body.
  fullText: text("full_text"),
}, (table) => ({
  scrapedAtIdx: sql`CREATE INDEX IF NOT EXISTS scraped_at_idx ON ${table} (scraped_at DESC)`,
}));

export const insertHeadlineSchema = createInsertSchema(headlines).omit({
  id: true,
  scrapedAt: true,
  articlePublishedAt: true,
  priorityScore: true,
  tags: true,
  normalizedTitle: true,
}).extend({
  articlePublishedAt: z.date().nullable().optional(),
  priorityScore: z.number().optional(),
  tags: z.array(z.string()).optional(),
});

export type InsertHeadline = z.infer<typeof insertHeadlineSchema>;
export type Headline = typeof headlines.$inferSelect;

export const truthSocialPosts = pgTable("truth_social_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: text("post_id").notNull().unique("truth_social_posts_post_id_key"),
  content: text("content").notNull(),
  postedAt: timestamp("posted_at").notNull(),
  truthSocialUrl: text("truth_social_url").notNull(),
  imageUrl: text("image_url"),
  videoUrl: text("video_url"),
  videoThumbnailUrl: text("video_thumbnail_url"),
  isReblog: boolean("is_reblog").notNull().default(false),
  rebloggedFrom: text("reblogged_from"),
  extractedImageText: text("extracted_image_text"),
  isHidden: boolean("is_hidden").notNull().default(false),
  isManual: boolean("is_manual").notNull().default(false),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS posted_at_idx ON ${table} (posted_at DESC)`,
}));

export const insertTruthSocialPostSchema = createInsertSchema(truthSocialPosts).omit({
  id: true,
  scrapedAt: true,
});

export type InsertTruthSocialPost = z.infer<typeof insertTruthSocialPostSchema>;
export type TruthSocialPost = typeof truthSocialPosts.$inferSelect;

export const relayTruthSocialPosts = pgTable("relay_truth_social_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: text("post_id").notNull(),
  content: text("content").notNull(),
  postedAt: timestamp("posted_at").notNull(),
  truthSocialUrl: text("truth_social_url").notNull(),
  imageUrl: text("image_url"),
  videoUrl: text("video_url"),
  videoThumbnailUrl: text("video_thumbnail_url"),
  isReblog: boolean("is_reblog").notNull().default(false),
  rebloggedFrom: text("reblogged_from"),
  rawPayload: text("raw_payload"),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
});

export const insertRelayTruthSocialPostSchema = createInsertSchema(relayTruthSocialPosts).omit({
  id: true,
  receivedAt: true,
});

export type InsertRelayTruthSocialPost = z.infer<typeof insertRelayTruthSocialPostSchema>;
export type RelayTruthSocialPost = typeof relayTruthSocialPosts.$inferSelect;

export const xPosts = pgTable("x_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: text("post_id").notNull().unique("x_posts_post_id_key"),
  content: text("content").notNull(),
  postedAt: timestamp("posted_at").notNull(),
  xUrl: text("x_url").notNull(),
  sourceAccount: text("source_account").notNull().default('SecWar'),
  accountCategory: text("account_category").notNull().default('default'),
  isRetweet: boolean("is_retweet").notNull().default(false),
  retweetedFrom: text("retweeted_from"),
  imageUrl: text("image_url"),
  // Set by the background X media prefetch after it attempts to resolve the
  // post's og:image. Stamped even when no real image is found (text-only post)
  // so we don't re-fetch x.com for the same post every cycle. Keeps live
  // x.com scraping out of the /api/stream request path.
  mediaScrapedAt: timestamp("media_scraped_at"),
  isHidden: boolean("is_hidden").notNull().default(false),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS x_posted_at_idx ON ${table} (posted_at DESC)`,
  accountCategoryIdx: sql`CREATE INDEX IF NOT EXISTS x_account_category_idx ON ${table} (account_category)`,
}));

export const insertXPostSchema = createInsertSchema(xPosts).omit({
  id: true,
  scrapedAt: true,
});

export type InsertXPost = z.infer<typeof insertXPostSchema>;
export type XPost = typeof xPosts.$inferSelect;

export const rapidResponsePosts = pgTable("rapidresponse_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Name the constraint to match the EXISTING db constraint (Postgres' default
  // `<table>_<col>_key`). A bare .unique() makes drizzle-kit expect `..._unique`
  // and try to "add" a constraint that already exists, which triggers the
  // interactive truncate prompt on `db:push`. Both dev and prod already have
  // `rapidresponse_posts_post_id_key`, so this aligns the schema to reality.
  postId: text("post_id").notNull().unique("rapidresponse_posts_post_id_key"),
  content: text("content").notNull(),
  postedAt: timestamp("posted_at").notNull(),
  xUrl: text("x_url").notNull(),
  imageUrl: text("image_url"),
  isRetweet: boolean("is_retweet").notNull().default(false),
  retweetedFrom: text("retweeted_from"),
  isHidden: boolean("is_hidden").notNull().default(false),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS rapidresponse_posted_at_idx ON ${table} (posted_at DESC)`,
}));

export const insertRapidResponsePostSchema = createInsertSchema(rapidResponsePosts).omit({
  id: true,
  scrapedAt: true,
});

export type InsertRapidResponsePost = z.infer<typeof insertRapidResponsePostSchema>;
export type RapidResponsePost = typeof rapidResponsePosts.$inferSelect;

export const dowResponsePosts = pgTable("dow_response_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: text("post_id").notNull().unique("dow_response_posts_post_id_key"),
  content: text("content").notNull(),
  postedAt: timestamp("posted_at").notNull(),
  xUrl: text("x_url").notNull(),
  imageUrl: text("image_url"),
  isRetweet: boolean("is_retweet").notNull().default(false),
  retweetedFrom: text("retweeted_from"),
  isHidden: boolean("is_hidden").notNull().default(false),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS dow_response_posted_at_idx ON ${table} (posted_at DESC)`,
}));

export const insertDOWResponsePostSchema = createInsertSchema(dowResponsePosts).omit({
  id: true,
  scrapedAt: true,
});

export type InsertDOWResponsePost = z.infer<typeof insertDOWResponsePostSchema>;
export type DOWResponsePost = typeof dowResponsePosts.$inferSelect;

export const sentDefenderPosts = pgTable("sentdefender_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: text("post_id").notNull().unique("sentdefender_posts_post_id_key"),
  content: text("content").notNull(),
  postedAt: timestamp("posted_at").notNull(),
  xUrl: text("x_url").notNull(),
  imageUrl: text("image_url"),
  videoUrl: text("video_url"),
  isRetweet: boolean("is_retweet").notNull().default(false),
  retweetedFrom: text("retweeted_from"),
  isHidden: boolean("is_hidden").notNull().default(false),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS sentdefender_posted_at_idx ON ${table} (posted_at DESC)`,
}));

export const insertSentDefenderPostSchema = createInsertSchema(sentDefenderPosts).omit({
  id: true,
  scrapedAt: true,
});

export type InsertSentDefenderPost = z.infer<typeof insertSentDefenderPostSchema>;
export type SentDefenderPost = typeof sentDefenderPosts.$inferSelect;

export const osintPosts = pgTable("osint_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: text("post_id").notNull().unique("osint_posts_post_id_key"),
  content: text("content").notNull(),
  postedAt: timestamp("posted_at").notNull(),
  xUrl: text("x_url").notNull(),
  sourceAccount: text("source_account").notNull(),
  imageUrl: text("image_url"),
  videoUrl: text("video_url"),
  isRetweet: boolean("is_retweet").notNull().default(false),
  retweetedFrom: text("retweeted_from"),
  isHidden: boolean("is_hidden").notNull().default(false),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS osint_posted_at_idx ON ${table} (posted_at DESC)`,
  sourceAccountIdx: sql`CREATE INDEX IF NOT EXISTS osint_source_account_idx ON ${table} (source_account)`,
}));

export const insertOsintPostSchema = createInsertSchema(osintPosts).omit({
  id: true,
  scrapedAt: true,
});

export type InsertOsintPost = z.infer<typeof insertOsintPostSchema>;
export type OsintPost = typeof osintPosts.$inferSelect;

// Journalists X Feed (Task #182) — CURATED-LANE ONLY. Mirrors osint_posts shape
// but lives in its own table so journalist posts can NEVER leak into any
// osint_posts consumer (team /api/osint-posts, the public REST API, the MCOP
// Bot archive, or Dashboard/Stream). Read ONLY by the curated-gated
// /api/curated/journalist-posts endpoint.
export const journalistPosts = pgTable("journalist_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: text("post_id").notNull().unique("journalist_posts_post_id_key"),
  content: text("content").notNull(),
  postedAt: timestamp("posted_at").notNull(),
  xUrl: text("x_url").notNull(),
  sourceAccount: text("source_account").notNull(),
  imageUrl: text("image_url"),
  videoUrl: text("video_url"),
  isRetweet: boolean("is_retweet").notNull().default(false),
  retweetedFrom: text("retweeted_from"),
  isHidden: boolean("is_hidden").notNull().default(false),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS journalist_posted_at_idx ON ${table} (posted_at DESC)`,
  sourceAccountIdx: sql`CREATE INDEX IF NOT EXISTS journalist_source_account_idx ON ${table} (source_account)`,
}));

export const insertJournalistPostSchema = createInsertSchema(journalistPosts).omit({
  id: true,
  scrapedAt: true,
});

export type InsertJournalistPost = z.infer<typeof insertJournalistPostSchema>;
export type JournalistPost = typeof journalistPosts.$inferSelect;

export const flightTrackingPosts = pgTable("flight_tracking_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: text("post_id").notNull(),
  content: text("content").notNull(),
  postedAt: timestamp("posted_at").notNull(),
  xUrl: text("x_url").notNull(),
  sourceAccount: text("source_account").notNull(),
  imageUrl: text("image_url"),
  videoUrl: text("video_url"),
  screenshotUrl: text("screenshot_url"),
  isHidden: boolean("is_hidden").notNull().default(false),
  submittedBy: text("submitted_by"),
  submittedAt: timestamp("submitted_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS flight_tracking_posted_at_idx ON ${table} (posted_at DESC)`,
}));

export const insertFlightTrackingPostSchema = createInsertSchema(flightTrackingPosts).omit({
  id: true,
  submittedAt: true,
});

export type InsertFlightTrackingPost = z.infer<typeof insertFlightTrackingPostSchema>;
export type FlightTrackingPost = typeof flightTrackingPosts.$inferSelect;


export const manualSubmissions = pgTable("manual_submissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  url: text("url").notNull(),
  category: text("category").notNull(),
  source: text("source").notNull(),
  summary: text("summary").notNull(),
  pdfPath: text("pdf_path"),
  submittedAt: timestamp("submitted_at").notNull().defaultNow(),
  // Real article publish date when known (from the team submission's RSS
  // pubDate / trusted link-analysis extraction). NULL when no trusted signal
  // exists — the feed mapping then emits null so the UI honestly shows
  // "First seen" instead of fabricating a fresh "Published" stamp from
  // submittedAt (Task: DW 21h-old article shown as "Published 16 min ago").
  articlePublishedAt: timestamp("article_published_at"),
  submittedBy: text("submitted_by").notNull(),
  priorityScore: integer("priority_score").notNull().default(0),
  priorityOverride: integer("priority_override"),
  priorityOverrideAt: timestamp("priority_override_at"),
  tags: text("tags").array().notNull().default(sql`'{}'`),
  clusterId: varchar("cluster_id"),
  isClusterRepresentative: boolean("is_cluster_representative").default(true),
  ogImageUrl: text("og_image_url"),
  videoUrl: text("video_url"),
  summaryBullets: text("summary_bullets").array(),
  // Condensed, ATTRIBUTED claims / key statements from the article body (Task #256).
  attributedClaims: text("attributed_claims").array(),
  mediaScrapedAt: timestamp("media_scraped_at"),
  // Page-detected content kind (curated-lane use only) — see headlines.contentKind.
  contentKind: text("content_kind"),
  manuallyEdited: boolean("manually_edited").default(false),
  // Full article text carried from the bot's scrape at post time. NULL means the
  // scrape failed (paywall / hard-block) → summary is title-derived and eligible
  // for upgrade when enrichment later recovers the article body.
  fullText: text("full_text"),
}, (table) => ({
  submittedAtIdx: sql`CREATE INDEX IF NOT EXISTS manual_submitted_at_idx ON ${table} (submitted_at DESC)`,
}));

export const headlineClusters = pgTable("headline_clusters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  isUserCreated: boolean("is_user_created").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type HeadlineCluster = typeof headlineClusters.$inferSelect;

export const insertManualSubmissionSchema = createInsertSchema(manualSubmissions).omit({
  id: true,
  submittedAt: true,
}).extend({
  priorityScore: z.number().optional(),
  tags: z.array(z.string()).optional(),
  pdfPath: z.string().nullable().optional(),
});

export type InsertManualSubmission = z.infer<typeof insertManualSubmissionSchema>;
export type ManualSubmission = typeof manualSubmissions.$inferSelect;

export const firstAlerts = pgTable("first_alerts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  alertId: text("alert_id").notNull().unique("first_alerts_alert_id_key"),
  headline: text("headline").notNull(),
  subHeadline: text("sub_headline"),
  url: text("url").notNull(),
  publishedAt: timestamp("published_at").notNull(),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
  alertTopics: text("alert_topics").array().notNull().default(sql`'{}'`),
  alertLists: text("alert_lists").array().notNull().default(sql`'{}'`),
  alertType: text("alert_type"),
  location: text("location"),
  latitude: text("latitude"),
  longitude: text("longitude"),
  publicPostLink: text("public_post_link"),
  publicPostText: text("public_post_text"),
  termsOfUse: text("terms_of_use"),
}, (table) => ({
  publishedAtIdx: sql`CREATE INDEX IF NOT EXISTS first_alert_published_at_idx ON ${table} (published_at DESC)`,
}));

export const insertFirstAlertSchema = createInsertSchema(firstAlerts).omit({
  id: true,
  scrapedAt: true,
}).extend({
  alertTopics: z.array(z.string()).optional(),
  alertLists: z.array(z.string()).optional(),
  alertType: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  subHeadline: z.string().nullable().optional(),
  latitude: z.string().nullable().optional(),
  longitude: z.string().nullable().optional(),
  publicPostLink: z.string().nullable().optional(),
  publicPostText: z.string().nullable().optional(),
  termsOfUse: z.string().nullable().optional(),
});

export type InsertFirstAlert = z.infer<typeof insertFirstAlertSchema>;
export type FirstAlert = typeof firstAlerts.$inferSelect;

export const blockedHeadlines = pgTable("blocked_headlines", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  normalizedTitle: text("normalized_title").notNull().unique("blocked_headlines_normalized_title_key"),
  blockedAt: timestamp("blocked_at").notNull().defaultNow(),
}, (table) => ({
  blockedAtIdx: sql`CREATE INDEX IF NOT EXISTS blocked_at_idx ON ${table} (blocked_at DESC)`,
}));

export const insertBlockedHeadlineSchema = createInsertSchema(blockedHeadlines).omit({
  id: true,
  blockedAt: true,
});

export type InsertBlockedHeadline = z.infer<typeof insertBlockedHeadlineSchema>;
export type BlockedHeadline = typeof blockedHeadlines.$inferSelect;

// Low-credibility-source items pulled out of the scrape gate and held for
// on-demand review. These are NEVER surfaced in any normal feed — they live in
// their own table so headline/feed queries naturally exclude them.
export const quarantinedHeadlines = pgTable("quarantined_headlines", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  normalizedTitle: text("normalized_title").notNull().unique("quarantined_headlines_normalized_title_key"),
  url: text("url").notNull(),
  source: text("source").notNull(),
  reason: text("reason").notNull(),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
}, (table) => ({
  quarantinedScrapedAtIdx: sql`CREATE INDEX IF NOT EXISTS quarantined_scraped_at_idx ON ${table} (scraped_at DESC)`,
}));

export const insertQuarantinedHeadlineSchema = createInsertSchema(quarantinedHeadlines).omit({
  id: true,
  scrapedAt: true,
});

export type InsertQuarantinedHeadline = z.infer<typeof insertQuarantinedHeadlineSchema>;
export type QuarantinedHeadline = typeof quarantinedHeadlines.$inferSelect;

// Lightweight cumulative counters for pre-filter observability. Single global
// row. Only aggregate COUNTS are stored — dropped items themselves are never
// persisted.
export const filterMetrics = pgTable("filter_metrics", {
  id: varchar("id").primaryKey().default('global'),
  financeWeatherRescued: integer("finance_weather_rescued").notNull().default(0),
  financeWeatherDropped: integer("finance_weather_dropped").notNull().default(0),
  quarantined: integer("quarantined").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FilterMetrics = typeof filterMetrics.$inferSelect;

export const scrapeMetadata = pgTable("scrape_metadata", {
  id: varchar("id").primaryKey().default('global'),
  lastScrapeTime: timestamp("last_scrape_time").notNull().defaultNow(),
  headlinesLastScrapeTime: timestamp("headlines_last_scrape_time"),
  headlinesLastCount: integer("headlines_last_count").notNull().default(0),
  truthSocialLastScrapeTime: timestamp("truth_social_last_scrape_time"),
  truthSocialLastCount: integer("truth_social_last_count").notNull().default(0),
  xPostsLastScrapeTime: timestamp("x_posts_last_scrape_time"),
  xPostsLastCount: integer("x_posts_last_count").notNull().default(0),
  xPostsConsecutiveEmpty: integer("x_posts_consecutive_empty").notNull().default(0),
  rapidResponseLastScrapeTime: timestamp("rapid_response_last_scrape_time"),
  rapidResponseLastCount: integer("rapid_response_last_count").notNull().default(0),
  rapidResponseConsecutiveEmpty: integer("rapid_response_consecutive_empty").notNull().default(0),
  dowResponseLastScrapeTime: timestamp("dow_response_last_scrape_time"),
  dowResponseLastCount: integer("dow_response_last_count").notNull().default(0),
  dowResponseConsecutiveEmpty: integer("dow_response_consecutive_empty").notNull().default(0),
  sentDefenderLastScrapeTime: timestamp("sent_defender_last_scrape_time"),
  sentDefenderLastCount: integer("sent_defender_last_count").notNull().default(0),
  sentDefenderConsecutiveEmpty: integer("sent_defender_consecutive_empty").notNull().default(0),
  osintLastScrapeTime: timestamp("osint_last_scrape_time"),
  osintLastCount: integer("osint_last_count").notNull().default(0),
  osintConsecutiveEmpty: integer("osint_consecutive_empty").notNull().default(0),
  influencerXLastScrapeTime: timestamp("influencer_x_last_scrape_time"),
  influencerXLastCount: integer("influencer_x_last_count").notNull().default(0),
  influencerXConsecutiveEmpty: integer("influencer_x_consecutive_empty").notNull().default(0),
  firstAlertsLastScrapeTime: timestamp("first_alerts_last_scrape_time"),
  firstAlertsLastCount: integer("first_alerts_last_count").notNull().default(0),
  lastError: text("last_error"),
  lastErrorTime: timestamp("last_error_time"),
  scrapeStatus: text("scrape_status").notNull().default('idle'),
  lastBlockingRecoveryTime: timestamp("last_blocking_recovery_time"),
  blockingRecoveryCount: integer("blocking_recovery_count").notNull().default(0),
});

export const insertScrapeMetadataSchema = createInsertSchema(scrapeMetadata);

export type InsertScrapeMetadata = z.infer<typeof insertScrapeMetadataSchema>;
export type ScrapeMetadata = typeof scrapeMetadata.$inferSelect;

// Durable last-heartbeat timestamps for the inbound relays (EV X/Twitter and
// Truth Social). One row per relay, keyed by a stable name ('x' /
// 'truth-social'). The in-memory heartbeat in each relay service stays the fast
// read path; this table only exists so the value survives a redeploy/restart —
// without it MCOP boots into PRIMARY (scraper) mode after every deploy even when
// the relay was healthy seconds earlier. Written throttled / fire-and-forget so
// relay latency is never affected; seeded back into memory on boot.
export const relayHeartbeats = pgTable("relay_heartbeats", {
  relay: varchar("relay").primaryKey(),
  lastHeartbeatAt: timestamp("last_heartbeat_at").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  // Task #1020: one-shot relay-outage escalation marker. Set when the outage
  // SMS for the CURRENT outage episode has been sent; cleared (NULL) when the
  // relay recovers. Durable so a redeploy mid-outage never re-fires the SMS.
  outageEscalatedAt: timestamp("outage_escalated_at"),
});

export type RelayHeartbeat = typeof relayHeartbeats.$inferSelect;

// Durable RSS feed-health state (Task #553). One row per feed URL. The
// feedHealthTracker keeps these in memory as the fast read path, but persists
// each per-feed unhealthy streak / last outcome here so a feed that has been
// dead for days still shows as stale/broken on the Coverage tab immediately
// after a restart/redeploy — instead of resetting to "healthy" and going blind
// for 3 fresh cycles. Restored into memory on boot before the scheduler starts.
export const feedHealthState = pgTable("feed_health_state", {
  url: varchar("url").primaryKey(),
  sourceName: text("source_name").notNull(),
  scope: varchar("scope").notNull(),
  lastOutcome: varchar("last_outcome").notNull(),
  lastDetail: text("last_detail"),
  consecutiveUnhealthy: integer("consecutive_unhealthy").notNull().default(0),
  recent: text("recent").array().notNull().default(sql`ARRAY[]::text[]`),
  lastHealthyAt: timestamp("last_healthy_at"),
  lastSeenAt: timestamp("last_seen_at").notNull(),
  totalCycles: integer("total_cycles").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FeedHealthStateRow = typeof feedHealthState.$inferSelect;

// Team chat messages
export const teamChatMessages = pgTable("team_chat_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  userName: text("user_name").notNull(),
  userProfileImage: text("user_profile_image"),
  message: text("message").notNull(),
  // Durable retry identity for reviewed submissions. Null for ordinary/bot chat.
  clientRequestId: varchar("client_request_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  createdAtIdx: sql`CREATE INDEX IF NOT EXISTS team_chat_created_at_idx ON ${table} (created_at DESC)`,
  clientRequestUniq: uniqueIndex("team_chat_client_request_uniq").on(table.userId, table.clientRequestId),
}));

export const insertTeamChatMessageSchema = createInsertSchema(teamChatMessages).omit({
  id: true,
  createdAt: true,
});

export type InsertTeamChatMessage = z.infer<typeof insertTeamChatMessageSchema>;
export type TeamChatMessage = typeof teamChatMessages.$inferSelect;

// Team subjects (categories for organizing submitted stories)
export const teamSubjects = pgTable("team_subjects", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique("team_subjects_name_key"),
  description: text("description"),
  origin: text("origin").notNull().default('ai'),
  createdBy: varchar("created_by"),
  isActive: boolean("is_active").notNull().default(true),
  position: integer("position").notNull().default(0),
  category: text("category"),
  // Unified "watch topic" behavior flags. A topic can boost priority, act as a
  // BOLO (bypass the relevance filter), or both. `category` is retained for
  // backward compatibility and derived from these flags.
  isPriorityWatch: boolean("is_priority_watch").notNull().default(false),
  isBoloWatch: boolean("is_bolo_watch").notNull().default(false),
  // AI-extracted distinctive context keywords used for deterministic matching.
  watchKeywords: text("watch_keywords").array().notNull().default(sql`'{}'::text[]`),
  // Classification of a watch topic: which content Topic it falls under (a
  // self-reference to another team_subjects row, the same list shown in the
  // submission Topic selector) and a narrower AI-suggested focus area.
  topicId: varchar("topic_id"),
  focusArea: text("focus_area"),
  // Lifecycle: AI estimate of how long the topic stays relevant + computed expiry.
  estimatedDurationDays: integer("estimated_duration_days"),
  estimatedActiveUntil: timestamp("estimated_active_until"),
  autoArchiveReason: text("auto_archive_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // --- Fields added for detail popup (Task #1039) ---
  // Raw user prompt that originally created this topic (read-only provenance, never modified).
  sourcePrompt: text("source_prompt"),
  // Curated vocabulary label from the 20-topic PRIMARY_TOPICS list (separate from the
  // inline topicId classification field which points at a team_subjects row).
  watchTopicLabel: text("watch_topic_label"),
  // Lifecycle mode: 'smart_decay' = auto-archive after window elapses (with
  // auto-extension while matching at volume); 'hold' = never auto-archived.
  lifecycleMode: text("lifecycle_mode").notNull().default('smart_decay'),
  // Per-topic boost strength: scales the priority nudge within the hard ceiling.
  // 'standard' reproduces pre-Task-#1039 behavior so existing topics are unchanged.
  boostStrength: text("boost_strength").notNull().default('standard'),
  // Boolean keyword boxes (evaluated as: (AI gate OR (orBox AND andBox)) AND NOT notBox).
  // Terms in parentheses are treated as exact phrases; otherwise normal normalization.
  // Empty arrays leave the current AI-keyword-only behavior unchanged.
  orKeywords: text("or_keywords").array().notNull().default(sql`'{}'::text[]`),
  andKeywords: text("and_keywords").array().notNull().default(sql`'{}'::text[]`),
  notKeywords: text("not_keywords").array().notNull().default(sql`'{}'::text[]`),
}, (table) => ({
  nameIdx: sql`CREATE INDEX IF NOT EXISTS team_subjects_name_idx ON ${table} (name)`,
}));

export const insertTeamSubjectSchema = createInsertSchema(teamSubjects).omit({
  id: true,
  createdAt: true,
}).extend({
  origin: z.enum(['ai', 'manual']).optional(),
  category: z.enum(['joe_priority', 'bolo']).nullable().optional(),
  isPriorityWatch: z.boolean().optional(),
  isBoloWatch: z.boolean().optional(),
  watchKeywords: z.array(z.string()).optional(),
  topicId: z.string().nullable().optional(),
  focusArea: z.string().nullable().optional(),
  estimatedDurationDays: z.number().int().positive().nullable().optional(),
  estimatedActiveUntil: z.date().nullable().optional(),
  autoArchiveReason: z.string().nullable().optional(),
  sourcePrompt: z.string().nullable().optional(),
  lifecycleMode: z.enum(['smart_decay', 'hold']).optional(),
  boostStrength: z.enum(['weak', 'standard', 'strong']).optional(),
  orKeywords: z.array(z.string()).optional(),
  andKeywords: z.array(z.string()).optional(),
  notKeywords: z.array(z.string()).optional(),
});

export type InsertTeamSubject = z.infer<typeof insertTeamSubjectSchema>;
export type TeamSubject = typeof teamSubjects.$inferSelect;

// Match telemetry for Priority/BOLO watch topics (Task #1039).
// Written non-blocking at the curated steering chokepoint; auto-pruned to ~30 days.
export const watchTopicTelemetry = pgTable("watch_topic_telemetry", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Stable, URL-identity-bound decision key. Prevents retries of the same intake
  // decision from inflating operational telemetry.
  eventKey: varchar("event_key").unique(),
  topicId: varchar("topic_id").notNull(),
  baseScore: integer("base_score").notNull(),
  boostedScore: integer("boosted_score").notNull(),
  canonicalUrl: text("canonical_url"),
  steeringKind: text("steering_kind").notNull().default("priority"),
  boostStrength: text("boost_strength"),
  intakeMode: text("intake_mode"),
  boloRescueAttempted: boolean("bolo_rescue_attempted").notNull().default(false),
  boloRescueUsed: boolean("bolo_rescue_used").notNull().default(false),
  boloBudgetBlocked: boolean("bolo_budget_blocked").notNull().default(false),
  usImplicationApplied: boolean("us_implication_applied").notNull().default(false),
  usImplicationReason: text("us_implication_reason"),
  matchedAt: timestamp("matched_at").notNull().defaultNow(),
});

export const insertWatchTopicTelemetrySchema = createInsertSchema(watchTopicTelemetry).omit({ id: true });
export type InsertWatchTopicTelemetry = z.infer<typeof insertWatchTopicTelemetrySchema>;
export type WatchTopicTelemetry = typeof watchTopicTelemetry.$inferSelect;

// Team submissions (analyzed news stories and social media posts)
export const teamSubmissions = pgTable("team_submissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  chatMessageId: varchar("chat_message_id").references(() => teamChatMessages.id),
  submittedBy: varchar("submitted_by").notNull(),
  submittedByName: text("submitted_by_name").notNull(),
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceName: text("source_name"),
  headline: text("headline").notNull(),
  summary: text("summary").notNull(),
  fullText: text("full_text"),
  subjectId: varchar("subject_id").references(() => teamSubjects.id),
  flashSubjectId: varchar("flash_subject_id").references(() => teamSubjects.id),
  cjcsSubjectId: varchar("cjcs_subject_id").references(() => teamSubjects.id),
  joePrioritySubjectId: varchar("joe_priority_subject_id").references(() => teamSubjects.id),
  priorityScore: integer("priority_score").default(0),
  // Provenance of priorityScore (Task #811). 'ai' = a real batch scorer result;
  // 'unscored_fallback' = the AI scorer timed out / returned malformed and the
  // UNSCORED_BOT_PRIORITY floor was applied (retryable — never a genuine score);
  // 'human' = an editor set/overrode the score (never auto-retried).
  scoreSource: text("score_source").default('ai'),
  // How many times the background re-scoring job has retried an
  // 'unscored_fallback' row (Task #811). Capped so a persistently unscorable
  // item stops churning the AI budget.
  scoreRetryCount: integer("score_retry_count").notNull().default(0),
  status: text("status").notNull().default('pending'),
  publishedAt: timestamp("published_at"),
  mcopSubmittedAt: timestamp("mcop_submitted_at"),
  mcopSubmittedBy: varchar("mcop_submitted_by"),
  joeEmailedAt: timestamp("joe_emailed_at"),
  joeEmailedBy: varchar("joe_emailed_by"),
  deletedAt: timestamp("deleted_at"),
  deletedBy: varchar("deleted_by"),
  clusterId: varchar("cluster_id"),
  isClusterRepresentative: boolean("is_cluster_representative").notNull().default(false),
  isQuestionable: boolean("is_questionable").notNull().default(false),
  isMataOsint: boolean("is_mata_osint").notNull().default(false),
  mataOsintSubjectId: varchar("mata_osint_subject_id").references(() => teamSubjects.id),
  flightTrackingPostedAt: timestamp("flight_tracking_posted_at"),
  ogImageUrl: text("og_image_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  createdAtIdx: sql`CREATE INDEX IF NOT EXISTS team_submissions_created_at_idx ON ${table} (created_at DESC)`,
  subjectIdIdx: sql`CREATE INDEX IF NOT EXISTS team_submissions_subject_id_idx ON ${table} (subject_id)`,
  clusterIdIdx: sql`CREATE INDEX IF NOT EXISTS team_submissions_cluster_id_idx ON ${table} (cluster_id)`,
}));

export const insertTeamSubmissionSchema = createInsertSchema(teamSubmissions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  status: z.enum(['pending', 'processed', 'failed']).optional(),
  publishedAt: z.date().nullable().optional(),
});

export type InsertTeamSubmission = z.infer<typeof insertTeamSubmissionSchema>;
export type TeamSubmission = typeof teamSubmissions.$inferSelect;

// Comments on team submissions
export const teamSubmissionComments = pgTable("team_submission_comments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  submissionId: varchar("submission_id").notNull().references(() => teamSubmissions.id, { onDelete: 'cascade' }),
  userId: varchar("user_id").notNull(),
  userName: text("user_name").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTeamSubmissionCommentSchema = createInsertSchema(teamSubmissionComments).omit({
  id: true,
  createdAt: true,
});

export type InsertTeamSubmissionComment = z.infer<typeof insertTeamSubmissionCommentSchema>;
export type TeamSubmissionComment = typeof teamSubmissionComments.$inferSelect;

// Track which submissions each user has read
export const teamSubmissionReads = pgTable("team_submission_reads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  submissionId: varchar("submission_id").notNull().references(() => teamSubmissions.id, { onDelete: 'cascade' }),
  readAt: timestamp("read_at").notNull().defaultNow(),
});

export type TeamSubmissionRead = typeof teamSubmissionReads.$inferSelect;

// Clusters for grouping related team submissions within topics
export const teamSubmissionClusters = pgTable("team_submission_clusters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  subjectId: varchar("subject_id").references(() => teamSubjects.id),
  isUserCreated: boolean("is_user_created").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TeamSubmissionCluster = typeof teamSubmissionClusters.$inferSelect;

// Track articles posted by DrudgeBot to avoid duplicates
export const drudgeBotPosts = pgTable("drudge_bot_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  articleUrl: text("article_url").notNull().unique("drudge_bot_posts_article_url_key"),
  articleTitle: text("article_title").notNull(),
  summary: text("summary").notNull(),
  chatMessageId: varchar("chat_message_id").references(() => teamChatMessages.id),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS drudge_bot_posted_at_idx ON ${table} (posted_at DESC)`,
  urlIdx: sql`CREATE INDEX IF NOT EXISTS drudge_bot_url_idx ON ${table} (article_url)`,
}));

export const insertDrudgeBotPostSchema = createInsertSchema(drudgeBotPosts).omit({
  id: true,
  postedAt: true,
});

export type InsertDrudgeBotPost = z.infer<typeof insertDrudgeBotPostSchema>;
export type DrudgeBotPost = typeof drudgeBotPosts.$inferSelect;

// Track articles posted by BBCBot to avoid duplicates
export const bbcBotPosts = pgTable("bbc_bot_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  articleUrl: text("article_url").notNull().unique("bbc_bot_posts_article_url_key"),
  articleTitle: text("article_title").notNull(),
  summary: text("summary").notNull(),
  chatMessageId: varchar("chat_message_id").references(() => teamChatMessages.id),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS bbc_bot_posted_at_idx ON ${table} (posted_at DESC)`,
  urlIdx: sql`CREATE INDEX IF NOT EXISTS bbc_bot_url_idx ON ${table} (article_url)`,
}));

export const insertBBCBotPostSchema = createInsertSchema(bbcBotPosts).omit({
  id: true,
  postedAt: true,
});

export type InsertBBCBotPost = z.infer<typeof insertBBCBotPostSchema>;
export type BBCBotPost = typeof bbcBotPosts.$inferSelect;

// Track articles posted by FoxNewsBot to avoid duplicates
export const foxNewsBotPosts = pgTable("fox_news_bot_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  articleUrl: text("article_url").notNull().unique("fox_news_bot_posts_article_url_key"),
  articleTitle: text("article_title").notNull(),
  summary: text("summary").notNull(),
  chatMessageId: varchar("chat_message_id").references(() => teamChatMessages.id),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS fox_news_bot_posted_at_idx ON ${table} (posted_at DESC)`,
  urlIdx: sql`CREATE INDEX IF NOT EXISTS fox_news_bot_url_idx ON ${table} (article_url)`,
}));

export const insertFoxNewsBotPostSchema = createInsertSchema(foxNewsBotPosts).omit({
  id: true,
  postedAt: true,
});

export type InsertFoxNewsBotPost = z.infer<typeof insertFoxNewsBotPostSchema>;
export type FoxNewsBotPost = typeof foxNewsBotPosts.$inferSelect;

// Track articles posted by ABCNewsBot to avoid duplicates
export const abcNewsBotPosts = pgTable("abc_news_bot_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  articleUrl: text("article_url").notNull().unique("abc_news_bot_posts_article_url_key"),
  articleTitle: text("article_title").notNull(),
  summary: text("summary").notNull(),
  chatMessageId: varchar("chat_message_id").references(() => teamChatMessages.id),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS abc_news_bot_posted_at_idx ON ${table} (posted_at DESC)`,
  urlIdx: sql`CREATE INDEX IF NOT EXISTS abc_news_bot_url_idx ON ${table} (article_url)`,
}));

export const insertABCNewsBotPostSchema = createInsertSchema(abcNewsBotPosts).omit({
  id: true,
  postedAt: true,
});

export type InsertABCNewsBotPost = z.infer<typeof insertABCNewsBotPostSchema>;
export type ABCNewsBotPost = typeof abcNewsBotPosts.$inferSelect;

// Track articles posted by CBSNewsBot to avoid duplicates
export const cbsNewsBotPosts = pgTable("cbs_news_bot_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  articleUrl: text("article_url").notNull().unique("cbs_news_bot_posts_article_url_key"),
  articleTitle: text("article_title").notNull(),
  summary: text("summary").notNull(),
  chatMessageId: varchar("chat_message_id").references(() => teamChatMessages.id),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS cbs_news_bot_posted_at_idx ON ${table} (posted_at DESC)`,
  urlIdx: sql`CREATE INDEX IF NOT EXISTS cbs_news_bot_url_idx ON ${table} (article_url)`,
}));

export const insertCBSNewsBotPostSchema = createInsertSchema(cbsNewsBotPosts).omit({
  id: true,
  postedAt: true,
});

export type InsertCBSNewsBotPost = z.infer<typeof insertCBSNewsBotPostSchema>;
export type CBSNewsBotPost = typeof cbsNewsBotPosts.$inferSelect;

// Track articles posted by NBCNewsBot to avoid duplicates
export const nbcNewsBotPosts = pgTable("nbc_news_bot_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  articleUrl: text("article_url").notNull().unique("nbc_news_bot_posts_article_url_key"),
  articleTitle: text("article_title").notNull(),
  summary: text("summary").notNull(),
  chatMessageId: varchar("chat_message_id").references(() => teamChatMessages.id),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS nbc_news_bot_posted_at_idx ON ${table} (posted_at DESC)`,
  urlIdx: sql`CREATE INDEX IF NOT EXISTS nbc_news_bot_url_idx ON ${table} (article_url)`,
}));

export const insertNBCNewsBotPostSchema = createInsertSchema(nbcNewsBotPosts).omit({
  id: true,
  postedAt: true,
});

export type InsertNBCNewsBotPost = z.infer<typeof insertNBCNewsBotPostSchema>;
export type NBCNewsBotPost = typeof nbcNewsBotPosts.$inferSelect;

// Track articles posted by APNewsBot to avoid duplicates
export const apNewsBotPosts = pgTable("ap_news_bot_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  articleUrl: text("article_url").notNull().unique("ap_news_bot_posts_article_url_key"),
  articleTitle: text("article_title").notNull(),
  summary: text("summary").notNull(),
  chatMessageId: varchar("chat_message_id").references(() => teamChatMessages.id),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS ap_news_bot_posted_at_idx ON ${table} (posted_at DESC)`,
  urlIdx: sql`CREATE INDEX IF NOT EXISTS ap_news_bot_url_idx ON ${table} (article_url)`,
}));

export const insertAPNewsBotPostSchema = createInsertSchema(apNewsBotPosts).omit({
  id: true,
  postedAt: true,
});

export type InsertAPNewsBotPost = z.infer<typeof insertAPNewsBotPostSchema>;
export type APNewsBotPost = typeof apNewsBotPosts.$inferSelect;

// Track articles posted by ReutersBot to avoid duplicates
export const reutersBotPosts = pgTable("reuters_bot_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  articleUrl: text("article_url").notNull().unique("reuters_bot_posts_article_url_key"),
  articleTitle: text("article_title").notNull(),
  summary: text("summary").notNull(),
  chatMessageId: varchar("chat_message_id").references(() => teamChatMessages.id),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS reuters_bot_posted_at_idx ON ${table} (posted_at DESC)`,
  urlIdx: sql`CREATE INDEX IF NOT EXISTS reuters_bot_url_idx ON ${table} (article_url)`,
}));

export const insertReutersBotPostSchema = createInsertSchema(reutersBotPosts).omit({
  id: true,
  postedAt: true,
});

export type InsertReutersBotPost = z.infer<typeof insertReutersBotPostSchema>;
export type ReutersBotPost = typeof reutersBotPosts.$inferSelect;

export const rssBotPosts = pgTable("rss_bot_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  articleUrl: text("article_url").notNull().unique("rss_bot_posts_article_url_key"),
  articleTitle: text("article_title").notNull(),
  summary: text("summary").notNull(),
  sourceName: text("source_name").notNull(),
  chatMessageId: varchar("chat_message_id").references(() => teamChatMessages.id),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS rss_bot_posted_at_idx ON ${table} (posted_at DESC)`,
  urlIdx: sql`CREATE INDEX IF NOT EXISTS rss_bot_url_idx ON ${table} (article_url)`,
  sourceIdx: sql`CREATE INDEX IF NOT EXISTS rss_bot_source_idx ON ${table} (source_name)`,
}));

export const insertRSSBotPostSchema = createInsertSchema(rssBotPosts).omit({
  id: true,
  postedAt: true,
});

export type InsertRSSBotPost = z.infer<typeof insertRSSBotPostSchema>;
export type RSSBotPost = typeof rssBotPosts.$inferSelect;

// Track social media posts reposted by SocialBot to avoid duplicates
export const socialBotPosts = pgTable("social_bot_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: text("post_id").notNull(),
  source: text("source").notNull(), // 'POTUS' or 'SecWar'
  chatMessageId: varchar("chat_message_id").references(() => teamChatMessages.id),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
}, (table) => ({
  postedAtIdx: sql`CREATE INDEX IF NOT EXISTS social_bot_posted_at_idx ON ${table} (posted_at DESC)`,
  postIdSourceIdx: sql`CREATE UNIQUE INDEX IF NOT EXISTS social_bot_post_id_source_idx ON ${table} (post_id, source)`,
}));

export const insertSocialBotPostSchema = createInsertSchema(socialBotPosts).omit({
  id: true,
  postedAt: true,
});

export type InsertSocialBotPost = z.infer<typeof insertSocialBotPostSchema>;
export type SocialBotPost = typeof socialBotPosts.$inferSelect;

// Track content blocked from bot re-posting (when users delete submissions)
export const blockedBotContent = pgTable("blocked_bot_content", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  normalizedUrl: text("normalized_url").notNull().unique("blocked_bot_content_normalized_url_key"),
  sourceType: text("source_type").notNull(),
  headline: text("headline"),
  blockedBy: varchar("blocked_by").notNull(),
  blockedAt: timestamp("blocked_at").notNull().defaultNow(),
}, (table) => ({
  normalizedUrlIdx: sql`CREATE INDEX IF NOT EXISTS blocked_bot_content_url_idx ON ${table} (normalized_url)`,
}));

export const insertBlockedBotContentSchema = createInsertSchema(blockedBotContent).omit({
  id: true,
  blockedAt: true,
});

export type InsertBlockedBotContent = z.infer<typeof insertBlockedBotContentSchema>;
export type BlockedBotContent = typeof blockedBotContent.$inferSelect;

export const teamMembers = pgTable("team_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique("team_members_email_key"),
  addedBy: text("added_by").notNull(),
  addedAt: timestamp("added_at").notNull().defaultNow(),
}, (table) => ({
  emailIdx: sql`CREATE INDEX IF NOT EXISTS team_members_email_idx ON ${table} (email)`,
}));

export const insertTeamMemberSchema = createInsertSchema(teamMembers).omit({
  id: true,
  addedAt: true,
});

export type InsertTeamMember = z.infer<typeof insertTeamMemberSchema>;
export type TeamMember = typeof teamMembers.$inferSelect;

// Warfighter/Cyber allowed list — grants full admin (view + curate) access to
// the gated warfighter and cyber MCOPs for approved users, bypassing the
// password screen. Seeded in code; changes ship on publish.
export const warfighterCyberAllowed = pgTable("warfighter_cyber_allowed", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique("warfighter_cyber_allowed_email_key"),
  addedBy: text("added_by").notNull(),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export const insertWarfighterCyberAllowedSchema = createInsertSchema(warfighterCyberAllowed).omit({
  id: true,
  addedAt: true,
});

export type InsertWarfighterCyberAllowed = z.infer<typeof insertWarfighterCyberAllowedSchema>;
export type WarfighterCyberAllowed = typeof warfighterCyberAllowed.$inferSelect;

// Curated View tester allowlist — completely separate from team_members.
// Controls visibility/access of the hidden Curated View ONLY. Growing or
// shrinking this list must never affect Team/Stream Manager access.
export const curatedViewTesters = pgTable("curated_view_testers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique("curated_view_testers_email_key"),
  addedBy: text("added_by").notNull(),
  addedAt: timestamp("added_at").notNull().defaultNow(),
}, (table) => ({
  emailIdx: sql`CREATE INDEX IF NOT EXISTS curated_view_testers_email_idx ON ${table} (email)`,
}));

export const insertCuratedViewTesterSchema = createInsertSchema(curatedViewTesters).omit({
  id: true,
  addedAt: true,
});

export type InsertCuratedViewTester = z.infer<typeof insertCuratedViewTesterSchema>;
export type CuratedViewTester = typeof curatedViewTesters.$inferSelect;

// War page articles - independently managed stories for the War dashboard
export const warArticles = pgTable("war_articles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  url: text("url").notNull(),
  imageUrl: text("image_url"),
  summaryBullets: text("summary_bullets").array(),
  source: text("source"),
  priorityScore: integer("priority_score").notNull().default(50),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertWarArticleSchema = createInsertSchema(warArticles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWarArticle = z.infer<typeof insertWarArticleSchema>;
export type WarArticle = typeof warArticles.$inferSelect;

// War page settings - controls for the War dashboard
export const warSettings = pgTable("war_settings", {
  id: varchar("id").primaryKey().default('global'),
  feedFromMcop: boolean("feed_from_mcop").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type WarSettings = typeof warSettings.$inferSelect;

// AI provider routing settings - global singleton controlling which AI brain
// the shared aiClient uses. 'auto' = pick the primary provider automatically
// from live provider health (default); 'openrouter' = force OpenRouter primary
// with automatic Anthropic fallback; 'internal' = force the internally
// integrated Anthropic models primary with automatic OpenRouter fallback.
// In every mode a rate-limited provider is skipped automatically for the other.
export const aiSettings = pgTable("ai_settings", {
  id: varchar("id").primaryKey().default('global'),
  provider: varchar("provider").notNull().default('auto'),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type AiSettings = typeof aiSettings.$inferSelect;
export type AiProviderMode = 'openrouter' | 'internal' | 'auto';

export const warOverrides = pgTable("war_overrides", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  headlineId: varchar("headline_id").notNull().unique("war_overrides_headline_id_key"),
  title: text("title"),
  imageUrl: text("image_url"),
  summaryBullets: text("summary_bullets").array(),
  priorityScore: integer("priority_score"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertWarOverrideSchema = createInsertSchema(warOverrides).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWarOverride = z.infer<typeof insertWarOverrideSchema>;
export type WarOverride = typeof warOverrides.$inferSelect;

export const warScreenshots = pgTable("war_screenshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  caption: text("caption").notNull(),
  imageUrl: text("image_url").notNull(),
  sourceLabel: text("source_label"),
  linkUrl: text("link_url"),
  priorityScore: integer("priority_score").notNull().default(50),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertWarScreenshotSchema = createInsertSchema(warScreenshots).omit({
  id: true,
  createdAt: true,
});

export type InsertWarScreenshot = z.infer<typeof insertWarScreenshotSchema>;
export type WarScreenshot = typeof warScreenshots.$inferSelect;

export const articleQuotes = pgTable("article_quotes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  quoteText: text("quote_text").notNull(),
  speakerName: text("speaker_name").notNull(),
  normalizedSpeaker: text("normalized_speaker").notNull(),
  location: text("location"),
  speakerTitle: text("speaker_title"),
  event: text("event"),
  subjectTags: text("subject_tags").array().notNull().default(sql`'{}'::text[]`),
  context: text("context").notNull(),
  sourceUrl: text("source_url").notNull(),
  dateSpoken: timestamp("date_spoken"),
  storyId: varchar("story_id").notNull().references(() => teamSubmissions.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("article_quotes_story_id_idx").on(table.storyId),
  index("article_quotes_normalized_speaker_idx").on(table.normalizedSpeaker),
  index("article_quotes_created_at_idx").on(table.createdAt),
]);

export const insertArticleQuoteSchema = createInsertSchema(articleQuotes).omit({
  id: true,
  createdAt: true,
});

export type InsertArticleQuote = z.infer<typeof insertArticleQuoteSchema>;
export type ArticleQuote = typeof articleQuotes.$inferSelect;

export const dailyNewsScrubs = pgTable("daily_news_scrubs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  filename: text("filename").notNull(),
  storagePath: text("storage_path").notNull(),
  caoDate: timestamp("cao_date").notNull(),
  uploadedBy: text("uploaded_by"),
  htmlContent: text("html_content"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertDailyNewsScrubSchema = createInsertSchema(dailyNewsScrubs).omit({
  id: true,
  createdAt: true,
});

export type InsertDailyNewsScrub = z.infer<typeof insertDailyNewsScrubSchema>;
export type DailyNewsScrub = typeof dailyNewsScrubs.$inferSelect;

export const smsAlertSubscribers = pgTable("sms_alert_subscribers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNumber: text("phone_number").notNull().unique("sms_alert_subscribers_phone_number_key"),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSmsAlertSubscriberSchema = createInsertSchema(smsAlertSubscribers).omit({
  id: true,
  createdAt: true,
});

export type InsertSmsAlertSubscriber = z.infer<typeof insertSmsAlertSubscriberSchema>;
export type SmsAlertSubscriber = typeof smsAlertSubscribers.$inferSelect;

export const smsQueue = pgTable("sms_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  toNumber: text("to_number").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("pending"),
  direction: text("direction").notNull().default("outbound"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  sentAt: timestamp("sent_at"),
  error: text("error"),
  // Claim/lease fields (Task #773 — primary/backup bridge failover). When the
  // ACTIVE bridge device fetches pending messages, each returned row is claimed
  // for that device (claimed_by + claimed_at). A claimed row is invisible to
  // subsequent fetches until the lease expires (claimed_at older than the lease
  // window) — at which point it returns to pending for whichever device is
  // active THEN. Status stays 'pending' while claimed so existing status-based
  // counts keep working; confirm still flips status to sent/failed idempotently.
  claimedBy: text("claimed_by"),
  claimedAt: timestamp("claimed_at"),
});

export type SmsQueueMessage = typeof smsQueue.$inferSelect;

// Single-row persisted state for the SMS bridge failover controller (Task
// #773). Survives restarts so a redeploy doesn't bounce the active role or
// forget a manual override. Hysteresis timing (primary-healthy-since) is
// intentionally in-memory only — after a restart the controller re-observes
// the primary before failing back, which is the safe direction.
export const smsBridgeState = pgTable("sms_bridge_state", {
  id: varchar("id").primaryKey().default('global'),
  // 'auto' | 'primary' | 'backup' — manual override forces a device; auto lets
  // the failover controller decide.
  overrideMode: text("override_mode").notNull().default('auto'),
  activeDevice: text("active_device").notNull().default('primary'),
  lastSwitchAt: timestamp("last_switch_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type SmsBridgeState = typeof smsBridgeState.$inferSelect;

// Single-row persisted app-level feature flags that must survive restarts.
// When no row exists the in-memory defaults apply (steering defaults OFF;
// clustering + topic clustering default ON, matching server/clusterConfig.ts).
export const appFlags = pgTable("app_flags", {
  id: varchar("id").primaryKey().default('global'),
  watchTopicSteeringEnabled: boolean("watch_topic_steering_enabled").notNull().default(false),
  // Main-feed clustering + topic clustering toggles both default ON in memory
  // (see server/clusterConfig.ts), so the persisted defaults match.
  clusteringEnabled: boolean("clustering_enabled").notNull().default(true),
  topicClusteringEnabled: boolean("topic_clustering_enabled").notNull().default(true),
  // Drudge scraper defaults OFF in memory (see server/scraperConfig.ts);
  // Joe Priority/BOLO matching defaults ON (see server/clusterConfig.ts).
  drudgeScraperEnabled: boolean("drudge_scraper_enabled").notNull().default(false),
  joePriorityMatchingEnabled: boolean("joe_priority_matching_enabled").notNull().default(true),
  // Same-event duplicate reconciliation (curated Top Stories one-merge-per-pass
  // backstop, see server/curatedCluster.ts). Dark-launched: defaults OFF so it
  // does nothing until an admin flips it, and it can be toggled without a
  // redeploy. Fail-closed — merges at most one high-confidence sibling pair.
  curatedMissedMergeReconcileEnabled: boolean("curated_missed_merge_reconcile_enabled").notNull().default(false),
  // Per-bot enable/disable states (server/scraperConfig.ts botStates).
  // The full current map is snapshotted on every toggle; keys missing from
  // the stored map (e.g. newly added bots, or an empty '{}' before the first
  // toggle) fall back at boot to the in-memory defaults
  // (BOTS_DISABLED_BY_DEFAULT: drudgeBot OFF, rest ON).
  botStates: jsonb("bot_states").$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Append-only log of SMS bridge role changes (failover/failback/manual
// override) so the admin surface can show recent failover history.
export const smsFailoverEvents = pgTable("sms_failover_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromDevice: text("from_device").notNull(),
  toDevice: text("to_device").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  createdAtIdx: sql`CREATE INDEX IF NOT EXISTS sms_failover_events_created_at_idx ON ${table} (created_at DESC)`,
}));

export type SmsFailoverEvent = typeof smsFailoverEvents.$inferSelect;

// Custom MCOPs - per-user War-style dashboards with editable priority prompts
export const customMcops = pgTable("custom_mcops", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  slug: text("slug").notNull().unique("custom_mcops_slug_key"),
  name: text("name").notNull(),
  generalPrompt: text("general_prompt").notNull().default(''),
  lookForNow: text("look_for_now").notNull().default(''),
  exclude: text("exclude").notNull().default(''),
  feedFromMcop: boolean("feed_from_mcop").notNull().default(true),
  adminPasswordHash: text("admin_password_hash"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCustomMcopSchema = createInsertSchema(customMcops).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  adminPasswordHash: true,
});
export type InsertCustomMcop = z.infer<typeof insertCustomMcopSchema>;
export type CustomMcop = typeof customMcops.$inferSelect;

// Manual articles attached to a custom MCOP (mirrors warArticles)
export const customMcopArticles = pgTable("custom_mcop_articles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  mcopId: varchar("mcop_id").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  imageUrl: text("image_url"),
  summaryBullets: text("summary_bullets").array(),
  source: text("source"),
  priorityScore: integer("priority_score").notNull().default(50),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  mcopIdx: index("custom_mcop_articles_mcop_idx").on(table.mcopId),
}));
export const insertCustomMcopArticleSchema = createInsertSchema(customMcopArticles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCustomMcopArticle = z.infer<typeof insertCustomMcopArticleSchema>;
export type CustomMcopArticle = typeof customMcopArticles.$inferSelect;

// Manual social media screenshots attached to a custom MCOP (mirrors warScreenshots)
export const customMcopScreenshots = pgTable("custom_mcop_screenshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  mcopId: varchar("mcop_id").notNull(),
  caption: text("caption").notNull(),
  imageUrl: text("image_url").notNull(),
  sourceLabel: text("source_label"),
  linkUrl: text("link_url"),
  priorityScore: integer("priority_score").notNull().default(50),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  mcopIdx: index("custom_mcop_screenshots_mcop_idx").on(table.mcopId),
}));
export const insertCustomMcopScreenshotSchema = createInsertSchema(customMcopScreenshots).omit({
  id: true,
  createdAt: true,
});
export type InsertCustomMcopScreenshot = z.infer<typeof insertCustomMcopScreenshotSchema>;
export type CustomMcopScreenshot = typeof customMcopScreenshots.$inferSelect;

// Per-MCOP per-headline priority scores
export const customMcopScores = pgTable("custom_mcop_scores", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  mcopId: varchar("mcop_id").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: varchar("source_id").notNull(),
  priorityScore: integer("priority_score").notNull().default(0),
  isRelevant: boolean("is_relevant").notNull().default(true),
  reason: text("reason"),
  scoredAt: timestamp("scored_at").notNull().defaultNow(),
}, (table) => ({
  uniqIdx: index("custom_mcop_scores_uniq_idx").on(table.mcopId, table.sourceType, table.sourceId),
  mcopIdx: index("custom_mcop_scores_mcop_idx").on(table.mcopId),
}));

export type CustomMcopScore = typeof customMcopScores.$inferSelect;

// Per-MCOP hidden items — Sadmins can hide auto-scraped items just from
// their MCOP feed (no global effect).
export const customMcopHiddenItems = pgTable("custom_mcop_hidden_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  mcopId: varchar("mcop_id").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: varchar("source_id").notNull(),
  hiddenAt: timestamp("hidden_at").notNull().defaultNow(),
}, (table) => ({
  uniqIdx: index("custom_mcop_hidden_items_uniq_idx").on(table.mcopId, table.sourceType, table.sourceId),
  mcopIdx: index("custom_mcop_hidden_items_mcop_idx").on(table.mcopId),
}));

export type CustomMcopHiddenItem = typeof customMcopHiddenItems.$inferSelect;

// =============================================================================
// OUTLET REGISTRY — canonical source knowledge layer.
// One row per outlet, keyed by a normalized name. This is a KNOWLEDGE / LABELING
// layer only: it is NEVER an admission gate, and it is read ONLY by the Curated
// view + Team oversight surface. No shared feed query (primary/classic/visual/
// custom MCOP/public API) joins this table. Additive only.
// =============================================================================
export const outletRegistry = pgTable("outlet_registry", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Normalized canonical name (see normalizeOutletName in shared/outletRegistry).
  key: text("key").notNull().unique("outlet_registry_key_key"),
  canonicalName: text("canonical_name").notNull(),
  // Human-readable display name for handle-keyed rows (e.g. "Open Source
  // Intel" for canonicalName "Osint613"). DISPLAY-ONLY: resolution, tiering,
  // and Coverage matching key off canonicalName/aliases only. Seed-owned
  // identity column; null for outlets whose canonical name is already proper.
  displayName: text("display_name"),
  // Alternate display names that should resolve to this outlet (raw, un-normalized).
  aliases: text("aliases").array().notNull().default(sql`'{}'`),
  // Registrable domains for domain-based matching (e.g. "apnews.com").
  domains: text("domains").array().notNull().default(sql`'{}'`),
  // Stable logo slug -> client bundles the actual asset. Brand color + object-fit
  // hints (folded in from Curated's SOURCE_ICON_BG / SOURCE_ICON_FIT).
  logoSlug: text("logo_slug"),
  logoBrandColor: text("logo_brand_color"),
  logoObjectFit: text("logo_object_fit"),
  // Uploaded logo served from the object-storage PUBLIC folder. When present it
  // takes precedence over logoSlug in the client SourceIcon. Bundled-slug logos
  // keep working because this stays null for them.
  logoUrl: text("logo_url"),
  originCountry: text("origin_country"),
  originRegion: text("origin_region"),
  factuality: text("factuality"),
  // Behavior-engine identity (see shared/outletRegistry deriveBehavior). The
  // Source Identifier maps News/Social/Release + origin/CPC; Other Source Type
  // refines an "other" identifier (video/podcast/opinion/…). Every seeded outlet
  // sets sourceIdentifier explicitly; it is nullable only for not-yet-enriched
  // rows discovered at runtime.
  sourceIdentifier: text("source_identifier"),
  otherSourceType: text("other_source_type"),
  // Ownership categories (max 3) used for fact-diversity weighting + display.
  ownership: jsonb("ownership").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  // Hard, everywhere exclusion (including the curated lane). Curated-only gate —
  // never wired into the main feed's own blocking list.
  blocked: boolean("blocked").notNull().default(false),
  // Derived role: contributing-trusted vs attach-only (labeling, not a gate).
  role: text("role").notNull().default('attach-only'),
  // Whether enrichment (or the hand-curated seed) could confirm this outlet
  // against a reference source. Unconfirmed outlets are NEVER auto-promoted —
  // they default to attach-only until a human confirms them.
  confirmationStatus: text("confirmation_status").notNull().default('unconfirmed'),
  // When the enrichment service last touched this row.
  lastEnrichedAt: timestamp("last_enriched_at"),
  // Per-field provenance for machine-set values: field -> { source, at }.
  // "source" is the adapter name (or "seed"/"manual:<user>"); "at" is an ISO ts.
  enrichmentProvenance: jsonb("enrichment_provenance")
    .$type<Record<string, { source: string; at: string }>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  // Manual overrides that WIN over machine values and persist across refreshes:
  // field -> value. Enrichment never overwrites a field present here.
  manualOverrides: jsonb("manual_overrides")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  keyIdx: index("outlet_registry_key_idx").on(table.key),
}));

export const insertOutletRegistrySchema = createInsertSchema(outletRegistry).omit({
  id: true,
  updatedAt: true,
});
export type InsertOutletRegistry = z.infer<typeof insertOutletRegistrySchema>;
export type OutletRegistry = typeof outletRegistry.$inferSelect;

// =============================================================================
// Curated lane (Task #89) — a SEPARATE curated store, fully isolated from the
// main `headlines` table. Content here is ingested with a WIDER aperture
// (adversary outlets, international/mainstream B-list, opinion, #82 quarantine,
// social as attach-only) and is read ONLY by the curated-gated endpoints. It
// MUST NEVER be read by getPrimaryFeed, the public REST API, custom MCOPs, or
// the Classic/Visual views. Fail-closed: curated-only content never leaks.
// =============================================================================
export const curatedItems = pgTable("curated_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  normalizedTitle: text("normalized_title").notNull(),
  url: text("url").notNull().unique("curated_items_url_key"),
  // Content-based classification (NOT outlet geography). `category` is the
  // story's specific subject (e.g. "Taiwan Politics", "China-Taiwan Relations").
  // `region` is the broad geographic operating environment (Middle East,
  // Indo-Pacific, Europe, Global, …); `country` is the single dominant country
  // when one clearly dominates the story (else null → the view shows region).
  category: text("category").notNull().default('general'),
  region: text("region"),
  country: text("country"),
  source: text("source").notNull(),
  summary: text("summary").notNull().default(''),
  summaryBullets: text("summary_bullets").array(),
  // Condensed, ATTRIBUTED claims / key statements from the article body (Task #256).
  attributedClaims: text("attributed_claims").array(),
  // Per-article one-sentence angle/framing characterization for standalone single-source
  // curated items (Task #937). Generated at enrichment time from the article's own text
  // only — no background knowledge or outlet reputation. Null for social posts or when
  // the framing is neutral/straight-news with no discernible angle. Curated-lane only.
  sourceSpin: text("source_spin"),
  ogImageUrl: text("og_image_url"),
  // Provenance for a re-hosted image (Task: stop re-hosted placeholder logos).
  // When ogImageUrl is an `/objects/stream-images/…` path, this records the
  // ORIGINAL remote URL the bytes were fetched from, so placeholder/logo checks
  // (isPlaceholderImageUrl) remain possible AFTER re-hosting destroys the URL.
  // NULL for legacy rows re-hosted before this column existed and for carried-
  // over images whose origin the main lane did not record.
  ogImageSourceUrl: text("og_image_source_url"),
  // One-time placeholder re-check marker for the legacy-row backfill: stamped
  // when the boot-time sweep has examined this row's re-hosted image for a
  // placeholder origin (via provenance or a page re-fetch), so the sweep never
  // re-fetches the same row twice.
  placeholderRecheckAt: timestamp("placeholder_recheck_at"),
  // Curated-only source video. Social/flash posts may retain supported video in
  // Additional Coverage, but this field is never consulted for story stills,
  // representatives, formation, or any non-curated feed.
  videoUrl: text("video_url"),
  // Page-detected content kind (curated-lane use only) — see headlines.contentKind.
  // 'audio' marks a podcast/audio story so it is kept out of standalone curated
  // Top Stories / Top Narratives and can never be a cluster's representative,
  // while remaining eligible to attach to / help FORM a cluster.
  contentKind: text("content_kind"),
  // Enrichment-tracking timestamp (mirrors headlines.media_scraped_at). Set when
  // the stream-media worker has run the paywall-breaker/AI pipeline (or carried
  // over media from an already-enriched store) for this row. Left NULL when only
  // a placeholder/favicon image was found, so the backfill keeps retrying it.
  mediaScrapedAt: timestamp("media_scraped_at"),
  // Enrichment back-off tracking (Task #132). When a row fails to recover
  // SUBSTANTIVE media (no real article image AND no AI bullets — e.g. an
  // adversary outlet whose paywall bypass keeps timing out), the worker stamps
  // last_media_attempt_at and increments media_attempt_count instead of leaving
  // the row untouched. The prefetch + backfill then apply an escalating back-off
  // (attemptCount * 30 min) and stop retrying after a max attempt cap, so the
  // same failing rows no longer churn the paywall breaker every cycle. Reset to
  // 0 once substantive media is finally recovered.
  mediaAttemptCount: integer("media_attempt_count").notNull().default(0),
  lastMediaAttemptAt: timestamp("last_media_attempt_at"),
  // One-time enrichment-rescue marker (Task #339). Stamped when the boot migrator
  // gives a row that hit MAX_MEDIA_ATTEMPTS a single fresh, bounded set of
  // attempts through the improved breaker chain (e.g. favicon-stuck Bloomberg rows
  // that were permanently backed off before paywall2 was added to the curated
  // chain). NULL ⇒ never rescued; set ⇒ already rescued, so the back-off cap is
  // NOT re-lifted on later redeploys (the rescue is one-time PER ROW).
  mediaRescueAt: timestamp("media_rescue_at"),
  // Publish-date backfill back-off (Task #1088). Mirrors the media back-off
  // above: each failed / no-trusted-signal recovery attempt stamps
  // last_pubdate_attempt_at and increments pubdate_attempt_count so the
  // backfill applies an escalating back-off (attemptCount * 30 min) and stops
  // retrying after a max cap — instead of re-fetching the same unrecoverable
  // rows (blocked hosts, pages without structured date signals) every 15 min.
  pubdateAttemptCount: integer("pubdate_attempt_count").notNull().default(0),
  lastPubdateAttemptAt: timestamp("last_pubdate_attempt_at"),
  priorityScore: integer("priority_score").notNull().default(0),
  // Curated-lane tier, resolved at ingest from outlet_registry.role via
  // findOutlet. 'contributing' = trusted source that can help FORM a story;
  // 'attach-only' = adversary/opinion/low-cred/social/unknown — may only JOIN
  // an existing story, never seed one.
  role: text("role").notNull().default('attach-only'),
  clusterId: varchar("cluster_id"),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
  articlePublishedAt: timestamp("article_published_at"),
  tags: text("tags").array().notNull().default(sql`'{}'`),
  // Dead-link tracking (Task #226). `linkDeadAt` is stamped when a background
  // liveness probe confirmed the article URL is genuinely GONE (HTTP 404/410
  // after following redirects) — never for transient 5xx/timeout/403/429 or a
  // paywall 200. Set ⇒ the Curated view shows a "link unavailable" state instead
  // of "Open article" and (for allowlisted users) a Replace-link control. The
  // row KEEPS all metadata and cluster membership; the flag is display-only and
  // is IGNORED by clustering. `linkCheckedAt` records the last probe so the
  // liveness cron can round-robin (oldest-checked first). Cleared on a 2xx
  // revival or when an allowlisted user replaces the link.
  linkDeadAt: timestamp("link_dead_at"),
  linkCheckedAt: timestamp("link_checked_at"),
});

export const insertCuratedItemSchema = createInsertSchema(curatedItems).omit({
  id: true,
  scrapedAt: true,
  normalizedTitle: true,
  mediaScrapedAt: true,
  mediaAttemptCount: true,
  lastMediaAttemptAt: true,
  mediaRescueAt: true,
  pubdateAttemptCount: true,
  lastPubdateAttemptAt: true,
  linkDeadAt: true,
  linkCheckedAt: true,
}).extend({
  articlePublishedAt: z.date().nullable().optional(),
  summaryBullets: z.array(z.string()).nullable().optional(),
  attributedClaims: z.array(z.string()).nullable().optional(),
  tags: z.array(z.string()).optional(),
  clusterId: z.string().nullable().optional(),
});
export type InsertCuratedItem = z.infer<typeof insertCuratedItemSchema>;
export type CuratedItem = typeof curatedItems.$inferSelect;

// Curated-lane dead-link REPLACEMENTS (Task #226). Allowlist-gated overlay that
// redirects a curated item's article URL to a working one WITHOUT mutating
// curated_items.url — keeping clustering identity (which keys off url/title)
// stable. Keyed by the item's stable curated key (`curated:<id>`). Read ONLY in
// the curated path (top-stories + cluster-members display URL, the liveness
// probe, and enrichment refetch); it NEVER leaks into the main feed, Classic /
// Visual surfaces, custom MCOPs, or the public REST API. Mirrors the isolation
// of curated_priority_overrides.
export const curatedLinkReplacements = pgTable("curated_link_replacements", {
  key: text("key").primaryKey(),
  url: text("url").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type CuratedLinkReplacement = typeof curatedLinkReplacements.$inferSelect;

// =============================================================================
// Curated lane — CONTENT-BASED classification overlay, keyed by article URL.
// The curated view UNIONs the main feed (headlines/manual) with the curated
// store. Main-feed rows only carry a broad legacy bucket (e.g. "General") and no
// geography, and legacy curated rows predate per-item classification. This table
// is the SINGLE source of truth for the curated view's "Category · Country/Region"
// label: a background job classifies every URL in the display window (from BOTH
// stores) and the curated route overlays the result onto each row by URL. It is
// read ONLY by the curated-gated endpoints — never by getPrimaryFeed, the public
// REST API, custom MCOPs, or Classic/Visual (fail-closed isolation). Geography
// reflects the ARTICLE CONTENT, never the outlet's origin.
// =============================================================================
export const curatedClassifications = pgTable("curated_classifications", {
  url: text("url").primaryKey(),
  // Legacy free-form subject phrase (e.g. "Taiwan Politics"). KEPT for backward
  // compatibility + as the going-forward fallback source, but no longer the
  // display label — see primaryTopic below.
  category: text("category").notNull().default('general'),
  // Broad geographic operating environment (Middle East, Indo-Pacific, …).
  region: text("region"),
  // Single dominant country when one clearly dominates the story; else null →
  // the view shows the broader region. (= the object's topic_country.)
  country: text("country"),
  classifiedAt: timestamp("classified_at").notNull().defaultNow(),
  // ---- Structured classification ENRICHMENT object (Task #336) ----
  // The controlled-vocabulary primary_topic (enforced in code via
  // shared/classificationVocab.ts). One of the 20 topics or 'Other / Emerging'.
  // Nullable so legacy rows written before this column re-classify (null !== a
  // generated value); readers fall back to remapping `category`.
  primaryTopic: text("primary_topic"),
  // scope enum: Global/International · Regional · National/Domestic.
  scope: text("scope"),
  // Optional governed conflict_track (a FIELD, never a primary_topic).
  conflictTrack: text("conflict_track"),
  // EXACTLY two FULL country names when the story is fundamentally a relationship
  // / conflict / negotiation / strike / dispute between two countries (Task #336,
  // Topic·Focus model). The ONLY source for a non-conflict two-country Focus
  // (e.g. "U.S.–Israel"); tracked-conflict pairs derive for free from
  // conflict_track at read time. Nullable. CURATED-LANE display only.
  countryPair: text("country_pair").array(),
  // AUDIT — the ORIGINAL free-form label retained when a row is remapped to the
  // controlled vocabulary, so the historical remap is reversible.
  legacyCategory: text("legacy_category"),
  // When the model judged nothing on the list fit, the proposed new topic is
  // mirrored here (also logged to classification_topic_proposals). Display-only
  // signal; never an auto-adopted live label.
  proposedTopic: text("proposed_topic"),
  // Provenance of the CURRENT label (Task #350): 'ai' = generated by the curated
  // classifier / gate-mode ingest; 'human' = set by a reviewer override. The
  // bounded re-check that clears a persistently cluster-disagreeing label acts
  // ONLY on 'ai' rows; NULL / unknown is treated as PROTECTED (never auto-cleared).
  // The boot migrator backfills pre-existing rows to 'human' (the safe default),
  // so nothing already settled is ever clobbered. CURATED-LANE only.
  provenance: text("provenance"),
  // Re-check bookkeeping (Task #350, curated-lane only). How many CONSECUTIVE
  // cron passes this AI label has strongly disagreed (minority vs a ≥2 majority)
  // with its cluster's live topic vote; on reaching the threshold the label is
  // cleared so the cron re-sharpens it. Reset to 0 on agreement or re-classify.
  recheckDisagreeCount: integer("recheck_disagree_count").notNull().default(0),
  // Last time the re-check CLEARED this row — a cooldown anchor so a stubborn
  // re-sharpen that keeps coming back wrong can't thrash. NULL = never cleared.
  recheckLastAt: timestamp("recheck_last_at"),
  // Catch-all repair bookkeeping (Task #1088, curated-lane only). How many times
  // the boot-time catch-all repair (repairCatchAllClassifications) has reset this
  // AI 'Other / Emerging' row's reclassify eligibility. Rows that keep coming
  // back as 'Other / Emerging' after several repair cycles are genuinely
  // ambiguous — the repair skips rows at/above its cap so the same population
  // stops being re-reset (and re-AI'd) on every redeploy. Never reset; a row
  // that later earns a real topic simply leaves the repair's candidate set.
  catchallRepairCount: integer("catchall_repair_count").notNull().default(0),
  // Reserved for Phase-2 body-inference fields (actor_country, affected_country,
  // event_country, entities, narrative_target) — added later WITHOUT a rewrite;
  // intentionally NOT a column yet (title-only inference would be empty/wrong).
});

export type CuratedClassification = typeof curatedClassifications.$inferSelect;
export type InsertCuratedClassification = typeof curatedClassifications.$inferInsert;

// =============================================================================
// Curated classification — HUMAN-GATED topic proposals log (Task #336).
// When the curated generator judges that NOTHING on the enforced primary_topic
// list fits an item, it coerces the item to `Other / Emerging` and records a
// structured proposal here instead of inventing a live label. A human reviews
// these and may add an approved topic to the code list. The AI can NEVER
// self-expand the live vocabulary in prod. CURATED-LANE ONLY.
// =============================================================================
export const classificationTopicProposals = pgTable("classification_topic_proposals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // 'primary_topic' | 'conflict_track' — which governed list the proposal is for.
  kind: text("kind").notNull().default('primary_topic'),
  // The normalized proposed label (used to de-dupe + count occurrences).
  proposedLabel: text("proposed_label").notNull(),
  // A representative item title + rationale, for the human reviewer.
  sampleTitle: text("sample_title"),
  rationale: text("rationale"),
  // How many times the model has proposed this label (bumped on conflict).
  occurrences: integer("occurrences").notNull().default(1),
  // 'pending' | 'approved' | 'rejected' — human-gated; default pending.
  status: text("status").notNull().default('pending'),
  firstProposedAt: timestamp("first_proposed_at").notNull().defaultNow(),
  lastProposedAt: timestamp("last_proposed_at").notNull().defaultNow(),
});
export type ClassificationTopicProposal = typeof classificationTopicProposals.$inferSelect;
export type InsertClassificationTopicProposal = typeof classificationTopicProposals.$inferInsert;

// Isolated two-tier clustering membership for the curated lane. Recomputed each
// pass. Maps cluster (story) ids to member rows drawn from BOTH the main feed
// (itemType 'main' — headlines/manual) and the curated store (itemType
// 'curated'). Crucially this is a SEPARATE mapping so curated clustering never
// mutates headlines.cluster_id (which feeds Classic/Visual).
export const curatedClusterMembers = pgTable("curated_cluster_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clusterId: varchar("cluster_id").notNull(),
  itemType: text("item_type").notNull(), // 'main' | 'curated'
  itemId: varchar("item_id").notNull(),
  role: text("role").notNull(), // 'contributing' | 'anchor-only' | 'attach-only'
  // Display trust-tier (Task #121) — the behavior class+label computed at
  // formation time, threaded to the client so the detail view can split
  // corroborating / primary-origin / contrast / attach WITHOUT re-deriving from
  // the registry at read time (which fails closed to attach for unregistered
  // members and would mis-bucket real ones).
  behaviorClass: text("behavior_class").notNull().default('corroborating'), // 'corroborating' | 'anchor-only' | 'attach'
  behaviorLabel: text("behavior_label"), // 'primary' | 'contrast' | null
  // Page-detected content kind (Task #650: audio/opinion), snapshotted from the
  // live source row at formation time so a member's Opinion/Analysis badge in
  // the "Videos & Opinions" area matches the same effective-kind signal that
  // demoted it out of the contributing tier. Null for a normal reported article.
  contentKind: text("content_kind"),
  title: text("title").notNull(),
  source: text("source").notNull(),
  url: text("url").notNull(),
  category: text("category"),
  // Snapshot of the article's OWN standalone AI summary/lede at clustering time,
  // so the detail dialog can show each contributing outlet's lede sentence and so
  // aged-out members re-injected into a still-active cluster keep synthesis context.
  summary: text("summary"),
  publishedAt: timestamp("published_at"),
  // Snapshotted at clustering time so a FORMED story can still be ranked
  // (priorityScore) and show a hero image (ogImageUrl) even after its live
  // source row churns out of the window (id rotation / aging).
  priorityScore: integer("priority_score").notNull().default(0),
  ogImageUrl: text("og_image_url"),
  isRepresentative: boolean("is_representative").notNull().default(false),
  // Cross-pass confirmation hysteresis (Task #645). Only the two VOLATILE
  // addition paths — this pass's semantic adversary-attach and the between-
  // passes incremental-attach bridge — ever write provisional:true. Core
  // Phase-A grouped members (the trusted corroborating set that formed the
  // story) are never provisional and are always displayed immediately.
  // confirmedStreak is a denormalized snapshot of curatedMemberConfirmations
  // taken at write time so the hot read path can gate display with no extra
  // query. A provisional member is shown only once confirmedStreak >= 2
  // (persisted across >=2 consecutive passes) — see server/routes.ts
  // isConfirmedCuratedMember.
  provisional: boolean("provisional").notNull().default(false),
  confirmedStreak: integer("confirmed_streak").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type CuratedClusterMember = typeof curatedClusterMembers.$inferSelect;

// Side table that SURVIVES the per-pass wipe-and-rebuild of
// curated_cluster_members (Task #645). Tracks how many consecutive passes a
// given provisional (volatile) member has persisted for a given cluster, so
// the write path can stamp confirmedStreak onto the member row it writes.
// Keyed by clusterId+itemType+itemId so a re-formed cluster (new clusterId)
// or a member re-attaching to a DIFFERENT cluster restarts the hysteresis
// clock rather than inheriting an unrelated streak. Curated-lane only.
export const curatedMemberConfirmations = pgTable("curated_member_confirmations", {
  key: text("key").primaryKey(), // `${clusterId}:${itemType}:${itemId}`
  clusterId: varchar("cluster_id").notNull(),
  itemType: text("item_type").notNull(),
  itemId: varchar("item_id").notNull(),
  streak: integer("streak").notNull().default(1),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CuratedMemberConfirmation = typeof curatedMemberConfirmations.$inferSelect;

// =============================================================================
// Curated lane (Task #90) — story SYNTHESIS cache for FORMED stories. The
// "cluster-and-compare" refinement layer: a neutral lede, 2-3 facts corroborated
// across DIVERSE contributing source TYPES, and a per-source one-sentence spin
// characterization. Computed OFF the hot path during the curated clustering pass
// and keyed by a content SIGNATURE (sha256 of the sorted `${itemType}:${itemId}`
// member keys) so it survives the per-pass cluster-id churn and is only
// regenerated when a story's membership actually changes. Read ONLY by the
// curated-gated endpoints; never by any shared feed (fail-closed isolation).
// =============================================================================
export const curatedStorySynthesis = pgTable("curated_story_synthesis", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // sha256 of the sorted member keys — stable across cluster-id regeneration.
  signature: text("signature").notNull().unique("curated_story_synthesis_signature_key"),
  // Short, neutral newspaper-style headline — generalized across the cluster (no
  // single source's framing). Distinct from, and much shorter than, the lede.
  headline: text("headline").notNull().default(''),
  // Neutral, unbiased one-sentence lede — derived ONLY from contributing sources.
  lede: text("lede").notNull().default(''),
  // 2-3 facts corroborated across DIVERSE contributing source TYPES (diversity-
  // weighted, never vote-counting; adversary / attach-only never contribute).
  facts: text("facts").array().notNull().default(sql`'{}'`),
  // Condensed, ATTRIBUTED claims / key statements corroborated or sourced across
  // the cluster (Task #256) — additive detail shown beneath the Corroborated Facts.
  // Preserves source discipline (claims are attributed, never folded into facts).
  // Nullable on purpose: rows written before this column existed re-synthesize once
  // (null !== a generated array, which may legitimately be empty []).
  attributedClaims: text("attributed_claims").array(),
  // Per-source spin map: `${itemType}:${itemId}` -> one-sentence characterization
  // of that outlet's angle. Covers BOTH contributing and attached members.
  spins: jsonb("spins")
    .$type<Record<string, string>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  // Per-CONTRAST-source alignment breakdown (Task #121): `${itemType}:${itemId}`
  // -> the claims that ALIGN with the corroborated facts vs. those that DIVERGE.
  // Derived ONLY for contrast members (CPC / low-factuality shown as part of the
  // story); the corroborated facts themselves still come only from reliable news.
  alignments: jsonb("alignments")
    .$type<Record<string, { align: string[]; diverge: string[]; pct?: number }>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  // Secondary hash over per-member enrichment-CONTEXT presence (Task #207). Lets a
  // story that FORMED before its members were enriched re-synthesize once when
  // summaries/bullets land, instead of freezing a titles-only lede. Nullable: rows
  // written before this column existed re-synthesize once (null !== new hash).
  contentHash: text("content_hash"),
  // FALSE-MERGE backstop verdict (Task #362). false ONLY when this story's
  // corroborated facts each trace to a single independently-owned contributor —
  // the structural tell of two unrelated stories merged into one. The clustering
  // pass DISSOLVES such a cluster (members released to stand-alone) instead of
  // presenting a bogus single corroborated Top Story. Nullable: rows written
  // before this column existed re-synthesize once to pick up a verdict.
  corroborated: boolean("corroborated"),
  // Monotonic "synthesized-through" marker (Task #920): the freshest CONTRIBUTING
  // (corroborating) member content-timestamp this synopsis was actually built
  // from. The refresh trigger compares a long-lived story's freshest contributing
  // content against this — firing a re-synthesis ONCE per genuinely-newer
  // development (so a mature cluster whose member set has settled but keeps
  // drawing fresh reports no longer freezes a stale lede/facts). Also the honest
  // basis for the displayed "Updated" time so it can never advertise a freshness
  // the text lacks. Nullable: rows written before this column existed re-synthesize
  // once to backfill it (null !== a stamped timestamp).
  synthesizedThrough: timestamp("synthesized_through"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  signatureIdx: index("curated_story_synthesis_signature_idx").on(table.signature),
}));

export type CuratedStorySynthesis = typeof curatedStorySynthesis.$inferSelect;

// =============================================================================
// Curated lane — HISTORICAL story ARCHIVE. The live curated_cluster_members table
// is WIPED and rebuilt on every clustering pass, so only the CURRENT snapshot of
// formed stories ever exists. This table preserves every FORMED story over time:
// one row per story keyed by the deterministic content SIGNATURE (which equals
// the cluster's clusterId), recording when it was first and last seen plus the
// latest synthesized headline / lede / corroborated facts and a snapshot of its
// member sources. Written off the hot path during the clustering cron (upsert by
// signature → firstSeenAt is preserved, lastSeenAt + content refreshed). Read
// ONLY by the curated-gated /api/curated/archive endpoint; NEVER by getPrimaryFeed,
// the public REST API, custom MCOPs, or Classic/Visual (fail-closed isolation).
// =============================================================================
export type CuratedArchiveMember = {
  source: string;
  title: string;
  url: string;
  // Display trust-tier snapshotted at clustering time.
  behaviorClass: string; // 'corroborating' | 'anchor-only' | 'attach'
  behaviorLabel: string | null; // 'primary' | 'contrast' | null
  // One-sentence characterization of this outlet's angle (from the synthesis).
  spin: string | null;
  // Article's publication date/time snapshotted at archive time (ISO string), so
  // a phased-out story shows each source's date exactly as it did live. Null when
  // the source's date is genuinely unknown (never fabricated). Optional so older
  // archived rows captured before this field existed deserialize cleanly.
  publishedAt?: string | null;
};

export const curatedStoryArchive = pgTable("curated_story_archive", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Deterministic content signature (= the cluster's clusterId). Stable across
  // passes while membership is unchanged, so a recurring story upserts one row.
  signature: text("signature").notNull().unique("curated_story_archive_signature_key"),
  // Short, neutral generalized headline (from the synthesis cache).
  headline: text("headline").notNull().default(''),
  // Neutral one-sentence lede derived from contributing sources only.
  lede: text("lede").notNull().default(''),
  // 2-3 corroborated key facts.
  facts: text("facts").array().notNull().default(sql`'{}'`),
  // Snapshot of the synthesis attributed claims / key statements (Task #256).
  attributedClaims: text("attributed_claims").array().notNull().default(sql`'{}'`),
  // Content-based classification of the representative article (NOT outlet origin).
  category: text("category"),
  region: text("region"),
  country: text("country"),
  // Total members (contributing + attached) at last capture.
  sourceCount: integer("source_count").notNull().default(0),
  // Representative ("face") of the story at last capture — supplies the card's
  // headline link + hero image.
  repTitle: text("rep_title"),
  repSource: text("rep_source"),
  repUrl: text("rep_url"),
  ogImageUrl: text("og_image_url"),
  // Split-lineage guard (smart process re-partition). When a developing-process
  // mega-cluster is split into coexisting sub-stories, each child story carries
  // the SAME parent overlay id but a DISTINCT child suffix
  // (`<overlayId>:<childKey>`). The archive carry-forward/absorb matcher refuses
  // to merge two rows whose split-lineage keys disagree, so sibling sub-stories
  // (which share many tokens by construction) can NEVER collapse back into one
  // another. Null for ordinary (non-split) stories, whose matching behavior is
  // unchanged. Curated-lane only.
  splitLineageKey: text("split_lineage_key"),
  // Snapshot of the member sources so the archive renders without the (long-gone)
  // live cluster rows.
  members: jsonb("members")
    .$type<CuratedArchiveMember[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
}, (table) => ({
  lastSeenIdx: index("curated_story_archive_last_seen_idx").on(table.lastSeenAt),
  signatureIdx: index("curated_story_archive_signature_idx").on(table.signature),
}));

export type CuratedStoryArchive = typeof curatedStoryArchive.$inferSelect;

// =============================================================================
// Curated lane — "smart process re-partition" OVERLAY (option b). A persisted
// split decision that breaks ONE large/old developing-process mega-cluster into
// several coexisting CURRENT sub-stories ("general progress", "VPOTUS", "IAEA
// inspections", "Rubio", …). The live curated_cluster_members table is wiped and
// rebuilt every pass, so the AI verdict is stored HERE — keyed by member-
// signature TOKENS — and re-applied deterministically on every subsequent pass
// (a group is matched to its overlay by token COVERAGE, which survives cluster-id
// churn). Each child then flows through the normal formation/phase-out/synthesis/
// archive pipeline as a first-class story. CURATED-ONLY: read and applied solely
// inside the curated clustering pass; never feeds Classic/Visual/custom-MCOP or
// the public API. Fail-closed: when no overlay matches, grouping is unchanged.
// =============================================================================
export type CuratedSplitChild = {
  // Stable, deterministic key for this child partition (slug of the label, made
  // unique within the overlay). The child's archive/lifecycle lineage key is
  // `<overlayId>:<childKey>`.
  childKey: string;
  // Human-readable label for the sub-story (debug/observability only; the live
  // headline still comes from synthesis of the child's members).
  label: string;
  // Strongest identity tokens for this child (the defining/"key article" member
  // tokens + representative title tokens). Used to ROUTE new, previously-unseen
  // members to the right child by overlap.
  anchorTokens: string[];
  // Every member-signature token assigned to this child at evaluation time. Used
  // both to route known members deterministically and (unioned across children)
  // to MATCH a live group to this overlay by coverage.
  memberTokens: string[];
};

export const curatedProcessSplitOverlays = pgTable("curated_process_split_overlays", {
  // UUID — also the STABLE lineage parent key. Child lineage = `<id>:<childKey>`.
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // The child partitions the AI decided on. An EMPTY array means "leave intact"
  // (status 'intact') — recorded so the cooldown/material-change gate suppresses
  // re-asking a cluster the model already judged should stay as one.
  children: jsonb("children").$type<CuratedSplitChild[]>().notNull().default(sql`'[]'::jsonb`),
  // Hash of the verdict (child layout) — lets a refresh detect a no-op.
  verdictHash: text("verdict_hash").notNull().default(''),
  // Member-token-set hash + count at last AI evaluation — the material-change gate
  // (only re-ask the model once the membership has changed enough since this).
  evaluatedMemberHash: text("evaluated_member_hash").notNull().default(''),
  evaluatedMemberCount: integer("evaluated_member_count").notNull().default(0),
  // Why the evaluation fired ('size' | 'age') — observability only.
  triggerReason: text("trigger_reason"),
  // 'active' = split is applied; 'intact' = model said keep as one (kept only so
  // the cooldown suppresses repeated asks; never partitions a group).
  status: text("status").notNull().default('active'),
  lastEvaluatedAt: timestamp("last_evaluated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  lastEvaluatedIdx: index("curated_process_split_overlays_last_evaluated_idx").on(table.lastEvaluatedAt),
}));

export const insertCuratedProcessSplitOverlaySchema = createInsertSchema(curatedProcessSplitOverlays).omit({
  id: true,
  createdAt: true,
});
export type InsertCuratedProcessSplitOverlay = z.infer<typeof insertCuratedProcessSplitOverlaySchema>;
export type CuratedProcessSplitOverlay = typeof curatedProcessSplitOverlays.$inferSelect;

// =============================================================================
// Curated lane — EDITOR manual-link overlay (the human counterpart of the split
// overlay above). Records an editor's deliberate decision that a set of articles
// MUST live in ONE story — either "link this stray item into that story" or
// "merge these selected items into one story". This is the inverse of the split
// overlay: split forces members APART, this forces them TOGETHER. Consumed in the
// clustering pass as an additional deterministic must-link group (alongside the
// identical-title must-link), so it OVERRIDES the AI coherence/grouping guard for
// exactly those items and survives the per-pass member wipe. Keyed by NORMALIZED
// member URL (not cluster id or item key) so it stays valid even as the same
// article flips between a main:<id> and curated:<id> key across passes. Doubles as
// the editor-update AUDIT LOG surfaced in Source Oversight: it retains who acted,
// when, the AI's second-opinion verdict + reasoning, and whether the editor
// overrode an AI objection — feeding later clustering-logic tuning. Fail-closed:
// when fewer than two of its member URLs are present in a pass (aged out), the
// overlay simply no-ops. CURATED-ONLY: never read by Classic/Visual/custom-MCOP
// or the public API.
// =============================================================================
export const curatedManualLinks = pgTable("curated_manual_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Normalized identity URLs (>= 2) of the articles the editor forced together.
  memberUrls: text("member_urls").array().notNull().default(sql`'{}'::text[]`),
  // Human-readable label for oversight display — the target story's headline at
  // link time ('link'), or a short summary of the merge ('merge'). Display only.
  label: text("label").notNull().default(''),
  // 'link' = a stray item joined an existing story; 'merge' = multiple selected
  // items merged into one story. Observability / oversight only.
  kind: text("kind").notNull().default('link'),
  createdBy: text("created_by").notNull().default(''),
  // AI second-opinion captured at propose time: 'concur' | 'object' | 'skipped'
  // (skipped = AI unavailable / errored — fail-open, the editor still decides).
  aiVerdict: text("ai_verdict").notNull().default('skipped'),
  aiReasoning: text("ai_reasoning").notNull().default(''),
  // True when the editor proceeded despite an AI 'object' verdict — the signal
  // most useful for tuning clustering logic later.
  overrodeAi: boolean("overrode_ai").notNull().default(false),
  // Optional editor-supplied reason keys (controlled vocab from
  // shared/curatedReasonVocab.ts LINK_MERGE_REASONS) and a free-text note.
  // Nullable — selecting zero reasons is valid; the link applies unchanged.
  reasonKeys: text("reason_keys").array(),
  reasonNote: text("reason_note"),
  // 'active' = applied every pass; 'revoked' = editor unlinked (kept for the
  // audit trail, no longer applied).
  status: text("status").notNull().default('active'),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  statusIdx: index("curated_manual_links_status_idx").on(table.status),
  updatedIdx: index("curated_manual_links_updated_idx").on(table.updatedAt),
}));

export const insertCuratedManualLinkSchema = createInsertSchema(curatedManualLinks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCuratedManualLink = z.infer<typeof insertCuratedManualLinkSchema>;
export type CuratedManualLink = typeof curatedManualLinks.$inferSelect;

// =============================================================================
// Curated lane — EDITOR manual-EVICTION overlay (the mirror-image of the
// manual-link above). Records an editor's deliberate decision that ONE article
// does NOT belong in a story it was wrongly clustered into — the corrective
// "split this stray member OUT of that megacluster" control. Where the manual
// link is a must-link (force items TOGETHER), this is a cannot-link (force ONE
// item APART from a specific cluster). Consumed in the clustering pass AFTER the
// must-link reconcile: the evicted member is removed from any group that is
// still substantially the wrongly-merged cluster (identified by the snapshot of
// its sibling "anchor" URLs, using the SAME anchor-guard fraction as the manual-
// link story-sticky expansion so a churned membership can't dodge it), and it
// falls back to a normal STANDALONE node — the >= 2-corroborating formation gate
// is never weakened. Keyed by NORMALIZED identity URL (not cluster id or item
// key) so it survives the main:<id> <-> curated:<id> key flip and membership
// churn across passes. Doubles as an editor-update AUDIT signal surfaced in
// Source Oversight and captured into curated_override_events (action
// 'manual-evict') so the learning loop can see which merges editors reject.
// Fail-closed: when the evicted URL has aged out, or the cluster it named has
// dispersed (anchors no longer present together), the overlay simply no-ops —
// it can NEVER split a legitimately-merged member. CURATED-ONLY: never read by
// Classic/Visual/custom-MCOP or the public API.
// =============================================================================
export const curatedManualEvictions = pgTable("curated_manual_evictions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Normalized identity URL of the ONE article the editor removed from a story.
  evictedUrl: text("evicted_url").notNull(),
  // Normalized identity URLs of the OTHER members on screen at click time — the
  // snapshot that identifies WHICH cluster the eviction applies to. The eviction
  // only fires against a group that still contains the anchor-guard fraction of
  // these, so it targets the wrongly-merged cluster and no other.
  anchorUrls: text("anchor_urls").array().notNull().default(sql`'{}'::text[]`),
  // Human-readable label for oversight display — "removed <title> from <story>".
  label: text("label").notNull().default(''),
  createdBy: text("created_by").notNull().default(''),
  // Optional editor-supplied reason keys (controlled vocab from
  // shared/curatedReasonVocab.ts LINK_MERGE_REASONS — the same split/merge
  // vocabulary) and a free-text note. Nullable — zero reasons is valid.
  reasonKeys: text("reason_keys").array(),
  reasonNote: text("reason_note"),
  // 'active' = applied every pass; 'revoked' = editor undid the eviction (kept
  // for the audit trail, no longer applied).
  status: text("status").notNull().default('active'),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  statusIdx: index("curated_manual_evictions_status_idx").on(table.status),
  updatedIdx: index("curated_manual_evictions_updated_idx").on(table.updatedAt),
}));

export const insertCuratedManualEvictionSchema = createInsertSchema(curatedManualEvictions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCuratedManualEviction = z.infer<typeof insertCuratedManualEvictionSchema>;
export type CuratedManualEviction = typeof curatedManualEvictions.$inferSelect;

// Curated lane — editor manual MOVE overlay (curated-only). A move is a
// human's decision that ONE article belongs in a DIFFERENT story: it composes
// "pull out of the source cluster" with "attach to the target cluster" as one
// atomic overlay. It is deliberately NOT stored as an eviction + manual-link
// pair: manual links are reconciled BEFORE evictions in the clustering pass, so
// a link containing the moved item would FUSE the source and target clusters
// (and link-precedence would then block the eviction). The dedicated overlay is
// applied by its own pure step (applyManualMoves) AFTER evictions, guarded on
// BOTH sides (source anchors identify what to extract from; target anchors
// identify where to land), so it can never merge two clusters.
export const curatedManualMoves = pgTable("curated_manual_moves", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Normalized identity URL of the ONE article the editor moved.
  itemUrl: text("item_url").notNull(),
  // Normalized identity URLs of the OTHER source-cluster members on screen at
  // click time — identifies WHICH cluster the item is being moved OUT of.
  sourceAnchorUrls: text("source_anchor_urls").array().notNull().default(sql`'{}'::text[]`),
  // Normalized identity URLs of the target-cluster members at click time —
  // identifies WHICH cluster the item is being moved INTO.
  targetAnchorUrls: text("target_anchor_urls").array().notNull().default(sql`'{}'::text[]`),
  label: text("label").notNull().default(''),
  createdBy: text("created_by").notNull().default(''),
  reasonKeys: text("reason_keys").array(),
  reasonNote: text("reason_note"),
  // 'active' = applied every pass; 'revoked' = editor undid the move (kept for
  // the audit trail, no longer applied).
  status: text("status").notNull().default('active'),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  statusIdx: index("curated_manual_moves_status_idx").on(table.status),
  updatedIdx: index("curated_manual_moves_updated_idx").on(table.updatedAt),
}));

export const insertCuratedManualMoveSchema = createInsertSchema(curatedManualMoves).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCuratedManualMove = z.infer<typeof insertCuratedManualMoveSchema>;
export type CuratedManualMove = typeof curatedManualMoves.$inferSelect;

// =============================================================================
// Curated lane — editor-feedback LEARNING LOOP (Task #659). The compiler
// (server/curatedRuleCompiler.ts) mines `curated_override_events` +
// `curated_manual_links` into a small set of overarching CANDIDATE rules of
// exactly 4 kinds:
//   'outlet-behavior-flip'   — an outlet's behavior class should flip
//                              (attach-only <-> corroborating).
//   'classification-relabel' — a standing outlet+topic -> topic remap.
//   'must-link'               — a standing outlet-pair clustering bias.
//   'irrelevance-suppression' — the only CONTENT-specific type: an
//                              outlet+category pattern editors keep hiding.
// Compiling is fully automated (deterministic, no LLM — the existing AI brief
// stays separate/advisory/untouched); APPLYING a rule is never automatic. A
// human must Approve in the Source Oversight "Adjustments" tab. Approval
// writes through the EXISTING deterministic overlays (outlet_registry manual
// override for the flip type; for the other 3 types, an 'approved' row here
// IS the live-consulted overlay — see server/curatedLearnedRulesCache.ts).
// Revoking flips status back and (for the flip type) restores the prior
// outlet_registry override — CURATED-ONLY, fail-closed, fully reversible.
// Never touches Classic/Visual/custom-MCOP/public API or main-feed
// scoring/clustering.
// =============================================================================
export const curatedLearnedRules = pgTable("curated_learned_rules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ruleType: text("rule_type").notNull(),
  // Stable dedupe key for this exact rule (see server/curatedRuleCompiler.ts
  // signature builders) — prevents re-suggesting an already-rejected/approved
  // rule and lets a re-compile refresh evidence on an existing 'suggested' row.
  signature: text("signature").notNull(),
  // Human-readable one-line description shown in the approval queue.
  label: text("label").notNull(),
  // Action-specific data needed to APPLY the rule, e.g.
  // { outlet, direction } | { outlet, fromTopic, toTopic } |
  // { outletA, outletB } | { outlet, category }.
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  evidenceCount: integer("evidence_count").notNull().default(0),
  // Small, bounded sample of the raw signal (headline/outlet/action/newValue)
  // so an approver can see WHY the rule was proposed. Display-only.
  evidenceSamples: jsonb("evidence_samples").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
  confidence: text("confidence").notNull().default('low'), // 'high' | 'medium' | 'low'
  // 'suggested' | 'approved' | 'rejected' | 'snoozed' | 'revoked'
  status: text("status").notNull().default('suggested'),
  snoozedUntil: timestamp("snoozed_until"),
  // Exact prior state to restore on revoke (only meaningful for
  // 'outlet-behavior-flip', which performs a real write). Null for the other
  // 3 types, which are self-reversing (enforcement only consults 'approved' rows).
  appliedState: jsonb("applied_state").$type<Record<string, unknown> | null>(),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  signatureIdx: index("curated_learned_rules_signature_idx").on(table.signature),
  statusIdx: index("curated_learned_rules_status_idx").on(table.status),
}));

export const insertCuratedLearnedRuleSchema = createInsertSchema(curatedLearnedRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCuratedLearnedRule = z.infer<typeof insertCuratedLearnedRuleSchema>;
export type CuratedLearnedRule = typeof curatedLearnedRules.$inferSelect;

// =============================================================================
// Curated lane — clustering "flight recorder". One row appended per
// clusterCuratedLane pass capturing the SHAPE of what shipped (size
// distribution, developing-process count) plus the BEHAVIOR of the refinement
// backstops (anchor-split audits / vetoes / developing-process skips / release
// caps, false-merge dissolutions) and ARCHIVE churn (exact / carry-forward /
// insert branch counts). Lets us see over time whether a tweak over- or
// under-corrected without guessing. Written fail-open AFTER archiving — a
// metrics failure can NEVER break a clustering pass. CURATED-ONLY: read solely
// by the curated-gated metrics endpoint; never feeds Classic/Visual/custom-MCOP
// or the public API. FK-free (pure observability) so it can never block a pass.
// =============================================================================
export const curatedClusterMetrics = pgTable("curated_cluster_metrics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Optional free-text label of the refinement in effect (env CURATED_REFINEMENT_TAG)
  // so a deploy / knob change can be correlated with the metric shift.
  refinementTag: text("refinement_tag"),
  // Shape of what shipped this pass.
  formedStories: integer("formed_stories").notNull().default(0),
  totalMembers: integer("total_members").notNull().default(0),
  maxClusterSize: integer("max_cluster_size").notNull().default(0),
  medianClusterSize: integer("median_cluster_size").notNull().default(0),
  p95ClusterSize: integer("p95_cluster_size").notNull().default(0),
  largeClusters: integer("large_clusters").notNull().default(0),
  developingProcessClusters: integer("developing_process_clusters").notNull().default(0),
  unsynthesizedFormedStories: integer("unsynthesized_formed_stories").notNull().default(0),
  // Refinement-backstop behavior.
  falseMergeDissolutions: integer("false_merge_dissolutions").notNull().default(0),
  anchorSplitAudited: integer("anchor_split_audited").notNull().default(0),
  anchorSplitReleased: integer("anchor_split_released").notNull().default(0),
  anchorSplitVetoes: integer("anchor_split_vetoes").notNull().default(0),
  anchorSplitDevelopingSkips: integer("anchor_split_developing_skips").notNull().default(0),
  // Oversized-cluster escape hatch (megacluster over-merge fix). oversizedEscapes:
  // developing-process clusters this pass that crossed the size/dominance threshold
  // and had their anchor-split HARD-SKIP LIFTED so the LLM classifier audited them
  // (instead of leaving them intact). oversizedReleased: members actually released
  // from those oversized clusters. Watch: escapes > 0 but released ~ 0 => classifier
  // truncation or prompt bias (the fix is silently no-op'ing).
  anchorSplitOversizedEscapes: integer("anchor_split_oversized_escapes").notNull().default(0),
  anchorSplitOversizedReleased: integer("anchor_split_oversized_released").notNull().default(0),
  releaseCapClamps: integer("release_cap_clamps").notNull().default(0),
  // Archive churn (already-known upsert branch counts).
  archiveRowsSeen: integer("archive_rows_seen").notNull().default(0),
  archiveExactUpdates: integer("archive_exact_updates").notNull().default(0),
  archiveCarryForwardMerges: integer("archive_carry_forward_merges").notNull().default(0),
  archiveInserted: integer("archive_inserted").notNull().default(0),
  archiveAbsorbedDuplicates: integer("archive_absorbed_duplicates").notNull().default(0),
  archiveSkippedUnsynthesized: integer("archive_skipped_unsynthesized").notNull().default(0),
  // Smart process re-partition (curated-only AI mega-cluster split).
  smartRepartitionAudited: integer("smart_repartition_audited").notNull().default(0),
  smartRepartitionTriggered: integer("smart_repartition_triggered").notNull().default(0),
  smartRepartitionCacheHits: integer("smart_repartition_cache_hits").notNull().default(0),
  smartRepartitionChildrenCreated: integer("smart_repartition_children_created").notNull().default(0),
  smartRepartitionMembersMoved: integer("smart_repartition_members_moved").notNull().default(0),
  smartRepartitionFailed: integer("smart_repartition_failed").notNull().default(0),
  smartRepartitionCooldownSkipped: integer("smart_repartition_cooldown_skipped").notNull().default(0),
  // Early process-prevention split (Task #414) — the SUBSET of the smart-repartition
  // counters above attributable to the early/online prevention gate (a developing-
  // process cluster split BEFORE it reached the 50-member backstop). These count
  // ONLY evals that qualified via the lower process-early thresholds, so we can see
  // how much splitting is now prevention vs the legacy post-hoc backstop.
  preventionRepartitionAudited: integer("prevention_repartition_audited").notNull().default(0),
  preventionRepartitionTriggered: integer("prevention_repartition_triggered").notNull().default(0),
  preventionRepartitionChildrenCreated: integer("prevention_repartition_children_created").notNull().default(0),
  // Suspected MISSED-corroboration alarm (Task #626). Count of standalone-Top-Story
  // groups this pass whose titles are highly similar, same-event window, and from
  // >= 2 distinct publishers, yet did NOT merge — the silent-regression symptom if
  // the clustering LLM stops grouping obvious fuzzy near-dupes. Observability only
  // (no auto-remerge). `samples` holds a bounded JSON snapshot of the flagged
  // groups (titles + publishers) so the team can eyeball them from the recorder.
  suspectedMissedMerges: integer("suspected_missed_merges").notNull().default(0),
  suspectedMissedMergeSamples: text("suspected_missed_merge_samples"),
  // Same-event duplicate reconciliation (one-merge-per-pass backstop). Count of
  // sibling formed-story pairs actually merged this pass (0 or 1 by design). Watch
  // this rise as suspected_missed_merges falls while max_cluster_size stays bounded.
  missedMergeReconciled: integer("missed_merge_reconciled").notNull().default(0),
}, (table) => ({
  createdAtIdx: index("curated_cluster_metrics_created_at_idx").on(table.createdAt),
}));

export const insertCuratedClusterMetricsSchema = createInsertSchema(curatedClusterMetrics).omit({
  id: true,
  createdAt: true,
});
export type InsertCuratedClusterMetrics = z.infer<typeof insertCuratedClusterMetricsSchema>;
export type CuratedClusterMetrics = typeof curatedClusterMetrics.$inferSelect;

// =============================================================================
// Curated lane — manual Priority overrides set by allowlisted Curated-view users.
// CURATED-ONLY: these are applied ONLY when building the curated top-stories
// feed and MUST NEVER be written to headlines.priority_override or
// manual_submissions.priority_override (which feed Classic/Visual/custom-MCOP/
// public-API). Keyed by either a standalone item's stable curated key
// (`main:<id>` / `curated:<id>`) or a cluster's deterministic clusterId
// (stored as `cluster:<clusterId>`). A set override is exempt from time-decay,
// mirroring how priority_override is exempt on the main feed.
// =============================================================================
export const curatedPriorityOverrides = pgTable("curated_priority_overrides", {
  // `main:<id>` | `curated:<id>` for standalone items; `cluster:<clusterId>`
  // for a whole cluster.
  key: text("key").primaryKey(),
  priorityScore: integer("priority_score").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CuratedPriorityOverride = typeof curatedPriorityOverrides.$inferSelect;

// =============================================================================
// Curated lane — editor HIDE overlay (Task #380). Allowlist-gated take-down of a
// bad curated story (hallucinated synthesis, mislabeled, or propaganda that
// slipped through). CURATED-ONLY: read solely when building the curated
// top-stories feed to EXCLUDE the story; NEVER touches headlines /
// manual_submissions or any non-curated reader (fail-closed lane isolation).
// Keyed by the story's stable key (`cluster:<clusterId>` for a whole cluster, or
// a standalone item's `main:<id>` / `curated:<id>`). `clusterId` + `memberKeys`
// are captured at hide-time so the hide SURVIVES re-clustering even when the
// cluster's deterministic id or representative churns: any captured member key
// resurfacing standalone, or as a new cluster's rep, stays suppressed.
// =============================================================================
export const curatedHiddenStories = pgTable("curated_hidden_stories", {
  // Canonical story key: `cluster:<clusterId>` | `main:<id>` | `curated:<id>`.
  key: text("key").primaryKey(),
  // The clusterId at hide-time (null for a standalone story).
  clusterId: text("cluster_id"),
  // Every member item key (`<type>:<id>`) at hide-time — flattened into the
  // hidden set so a churned/re-clustered version of the same story stays hidden.
  memberKeys: text("member_keys").array(),
  hiddenBy: text("hidden_by").notNull(),
  hiddenAt: timestamp("hidden_at").notNull().defaultNow(),
});

export type CuratedHiddenStory = typeof curatedHiddenStories.$inferSelect;

// =============================================================================
// Curated lane — editor PHOTO overlays (Task #380 expansion). Two allowlist-gated,
// CURATED-ONLY image controls applied SOLELY when building the curated top-stories
// feed; never written to / read by headlines, manual_submissions, or any
// non-curated reader (fail-closed lane isolation).
//
//  - curated_image_replacements: replace the photo on a SINGLE-SOURCE standalone
//    item. Keyed by the item's stable curated key (`main:<id>` / `curated:<id>`).
//    The replacement URL becomes the DISPLAY image; the underlying row's
//    ogImageUrl is never mutated (matches the dead-link replacement pattern).
//  - curated_hidden_images: HIDE an individual cluster member's photo so it drops
//    from every preview/carousel. Keyed by the image URL itself (cluster photos
//    are deduped by URL), so the hide survives member churn and a re-cluster.
// =============================================================================
export const curatedImageReplacements = pgTable("curated_image_replacements", {
  // `main:<id>` | `curated:<id>` — the single-source standalone item's stable key.
  key: text("key").primaryKey(),
  url: text("url").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CuratedImageReplacement = typeof curatedImageReplacements.$inferSelect;

export const curatedHiddenImages = pgTable("curated_hidden_images", {
  // The image URL being suppressed (curated-lane only).
  imageUrl: text("image_url").primaryKey(),
  hiddenBy: text("hidden_by").notNull(),
  hiddenAt: timestamp("hidden_at").notNull().defaultNow(),
});

export type CuratedHiddenImage = typeof curatedHiddenImages.$inferSelect;

// =============================================================================
// Curated lane — editor HEADLINE + BULLETS overlay. Allowlist-gated, CURATED-
// ONLY: stores a manual correction to a story's headline and/or summary bullets.
// Keyed by the item's stable curated key (`main:<id>` / `curated:<id>`) or a
// cluster's deterministic id (`cluster:<clusterId>`). Applied ONLY when building
// the curated top-stories read path — never written to / read by headlines,
// manual_submissions, or any non-curated reader (fail-closed lane isolation).
// The stored `title` / `normalizedTitle` is NEVER mutated; this is a display-
// only overlay that leaves clustering / dedup identity completely intact.
// =============================================================================
export const curatedHeadlineOverrides = pgTable("curated_headline_overrides", {
  // `main:<id>` | `curated:<id>` for standalone items; `cluster:<clusterId>`
  // for a whole cluster.
  key: text("key").primaryKey(),
  // Corrected headline text; null means no headline override (bullets-only edit).
  headline: text("headline"),
  // Corrected summary bullets; null means no bullets override (headline-only edit).
  bullets: text("bullets").array(),
  // Corrected attributed claims; null means use AI-generated claims. Curated-only
  // display overlay, so an editor correction is never overwritten by enrichment.
  claims: text("claims").array(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  // 'human' = editor-set via the #176 tool (protected — auto repair NEVER
  // clobbers it); 'auto' = system-recovered headline from the paywall/CPC
  // bypass during curated enrichment. Existing rows default to 'human'.
  provenance: text("provenance").notNull().default('human'),
});

export type CuratedHeadlineOverride = typeof curatedHeadlineOverrides.$inferSelect;

// =============================================================================
// Curated lane — "Competing Coverage" cache (Task #203). A topic-agnostic
// snapshot of what the U.S./World is actually covering MOST right now, used as a
// blind-spot radar against MCOP's defense-focused feed. Sourced from Google News
// RSS topic feeds and ranked by coverage VOLUME (independent of MCOP's scoring).
// One row per scope: 'domestic' (top U.S. stories), 'international' (top global
// stories), and 'buzz' (a single best-effort search/social-trend item).
// Refreshed by a background job; READ ONLY by the curated-gated endpoint — never
// by getPrimaryFeed, the public REST API, custom MCOPs, or Classic/Visual
// (fail-closed isolation). These are REAL article headlines (with a clickable
// Google News link), not generalized summaries.
// =============================================================================
export type CompetingCoverageItem = {
  rank: number;
  headline: string;
  // Enriched fields are ALL OPTIONAL: production rows may still hold the legacy
  // GDELT-era { rank, headline } shape, so every reader must tolerate absence.
  url?: string;          // Google News redirect URL (NOT decoded — 302s in-browser)
  source?: string;       // outlet name (from RSS <source> / "Headline - Source")
  outletCount?: number;  // how many outlets carry the story (consensus signal)
  category?: string;     // Google News topic the story came from
  blindSpot?: boolean;   // true = absent from MCOP's own feed (off leadership's radar)
  publishedAt?: number;  // epoch ms of the article pubDate, when known
  kind?: "coverage" | "buzz"; // 'buzz' = best-effort trending item
};

export const competingCoverageCache = pgTable("competing_coverage_cache", {
  // 'domestic' | 'international' | 'buzz'
  scope: text("scope").primaryKey(),
  items: jsonb("items")
    .$type<CompetingCoverageItem[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CompetingCoverageRow = typeof competingCoverageCache.$inferSelect;

// =============================================================================
// Curated Live Broadcast Firing Log
// Persistent record of every banner transition. Written fire-and-forget by
// the live-broadcast status aggregator; read via the curated-gated firings
// endpoint. Curated-only: never read by Classic/Visual/custom-MCOP/public API.
// =============================================================================
export const curatedLiveBroadcastFirings = pgTable("curated_live_broadcast_firings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Stable, state-independent identity for one detector event. The same key is
  // reused as an alert moves upcoming → live → recently_ended, so a human
  // correction remains attached across recomputes and process restarts.
  eventKey: text("event_key").notNull(),
  state: text("state").notNull(),          // 'live' | 'upcoming' | 'recently_ended'
  leader: text("leader").notNull(),
  title: text("title").notNull(),
  watchUrl: text("watch_url").notNull(),
  source: text("source"),                  // signal descriptor; null for recently_ended
  startsAt: timestamp("starts_at"),
  firstObservedAt: timestamp("first_observed_at").notNull(),
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCuratedLiveBroadcastFiringSchema = createInsertSchema(curatedLiveBroadcastFirings).omit({
  id: true,
  createdAt: true,
});

export type InsertCuratedLiveBroadcastFiring = z.infer<typeof insertCuratedLiveBroadcastFiringSchema>;
export type CuratedLiveBroadcastFiring = typeof curatedLiveBroadcastFirings.$inferSelect;

export type CuratedLiveBroadcastOverrides = {
  state?: "upcoming" | "live" | "recently_ended";
  leader?: string;
  title?: string;
  watchUrl?: string;
  startsAt?: string | null;
  since?: string | null;
  endsAt?: string | null;
};

// Curated-only, event-keyed moderation overlay for Live Watch. Detector output
// remains immutable in curated_live_broadcast_firings; this row contains only
// the editor-visible suppression/correction layer.
export const curatedLiveBroadcastModerations = pgTable("curated_live_broadcast_moderations", {
  eventKey: text("event_key").primaryKey(),
  suppressed: boolean("suppressed").notNull().default(false),
  overrides: jsonb("overrides")
    .$type<CuratedLiveBroadcastOverrides>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CuratedLiveBroadcastModeration = typeof curatedLiveBroadcastModerations.$inferSelect;

// Durable Meltwater run telemetry (Task #543). Single-row keyed 'global'.
// Persisted after every Meltwater bot run so the status panel on the Coverage
// tab survives redeploys and shows real history even when the bot is dormant.
// NEVER stores the API key, request headers, or raw response bodies.
export const meltwaterTelemetry = pgTable("meltwater_telemetry", {
  id: varchar("id").primaryKey().default('global'),
  // Timestamp of the most recent completed run attempt (success, throttle, or error).
  lastRunAt: timestamp("last_run_at").notNull(),
  // Outcome of that run: 'success' | 'rate-limited' | 'error'
  outcome: varchar("outcome", { length: 32 }).notNull(),
  // HTTP status returned by the Meltwater API (null when not reached, e.g. in-flight guard).
  httpStatus: integer("http_status"),
  // Count of documents admitted / skipped in the last successful run.
  ingested: integer("ingested").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  // Daily quota counters from response headers.
  dayRemaining: integer("day_remaining"),
  dayLimit: integer("day_limit"),
  // Seconds until the daily window resets (stored as absolute ISO timestamp to survive uptime).
  dayResetAt: timestamp("day_reset_at"),
  // Per-minute quota.
  minuteRemaining: integer("minute_remaining"),
  // Window-overflow flag (Task #607): true when a run hit the per-page document
  // cap on its final fetched page (after the bounded pagination budget) and the
  // lookback window still held more documents than were pulled — i.e. some
  // content was left behind this cycle. Pure observability for the de-clumping
  // cadence; it never gates ingestion or admission.
  overflow: boolean("overflow").notNull().default(false),
  // When the telemetry row was last written.
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type MeltwaterTelemetry = typeof meltwaterTelemetry.$inferSelect;

// =============================================================================
// Curated lane — per-source ADMISSION TELEMETRY (Task #950). One row per source
// canonical name, last-write-wins on each ingest pass. Captures the full intake
// funnel: how many items the feed returned, how many survived pre-AI screening,
// and which drop reason consumed the rest. CURATED-ONLY observability: written
// by the curated ingest path after every pass, read ONLY by the coverage
// endpoint. Never read by getPrimaryFeed, Classic/Visual, custom MCOPs, or the
// public REST API. Persisting this survives redeploys so the Coverage tab shows
// actionable history even when the ingest cron is between runs.
// =============================================================================
export const curatedIntakeTelemetry = pgTable("curated_intake_telemetry", {
  // Canonical source name as stored by curatedIngest (feed.sourceName / source field).
  sourceName: varchar("source_name").notNull(),
  // The intake label of the pass that touched this source ('rss' | 'team' | 'social' |
  // 'breaking-defense-offhost' | etc.). Part of the composite PK so that the same
  // source name appearing in multiple intake lanes (e.g. "Reuters" in rss + team)
  // keeps SEPARATE rows and does not overwrite one lane's counters with another's.
  lastLabel: text("last_label").notNull(),
  lastRunAt: timestamp("last_run_at").notNull(),
  // Feed-fetch level (RSS and off-host paths only; 0 for team/social intakes).
  fetched: integer("fetched").notNull().default(0),  // items the feed returned
  kept: integer("kept").notNull().default(0),         // survived recency + dedup
  aged: integer("aged").notNull().default(0),         // dropped: older than window
  dupInPass: integer("dup_in_pass").notNull().default(0), // dropped: URL already seen this pass
  // Admission-level (all intake paths, from admitCuratedCandidates).
  ingested: integer("ingested").notNull().default(0),
  dropInvalid: integer("drop_invalid").notNull().default(0),
  dropDupUrl: integer("drop_dup_url").notNull().default(0),
  dropDupBatch: integer("drop_dup_batch").notNull().default(0),
  dropRelevanceRejected: integer("drop_relevance_rejected").notNull().default(0),
  dropRelevanceFinance: integer("drop_relevance_finance").notNull().default(0),
  dropGateUnscored: integer("drop_gate_unscored").notNull().default(0),
  dropFuzzyDup: integer("drop_fuzzy_dup").notNull().default(0),
  dropBlocked: integer("drop_blocked").notNull().default(0),
  // Consecutive completed passes whose only admission outcome was malformed
  // content. A lone bad item is informational; repeated invalid-only passes
  // indicate a source-normalization fault worth surfacing to operators.
  invalidOnlyStreak: integer("invalid_only_streak").notNull().default(0),
  // Honest-funnel additions (Task #1114).
  // Candidates kept for this source whose admission was postponed to a later
  // pass (soft-deadline stop before they were processed). NOT a drop: the next
  // pass retries them (URL-dedup makes that idempotent). Lets a perpetually-
  // deferred source surface as "pending" instead of writing no counter at all.
  deferred: integer("deferred").notNull().default(0),
  // Feed-URL fetches that FAILED this pass (HTTP error / DNS / parser).
  // fetchFailures > 0 with fetched = 0 means the silence is a fetch problem,
  // not filtering; lastFetchError carries the trimmed reason string.
  fetchFailures: integer("fetch_failures").notNull().default(0),
  lastFetchError: text("last_fetch_error"),
  // Pass-state marker: true from the feed-stats write (which zeroes admission
  // counters for the new pass) until admission totals land — so a mid-pass
  // reader never mistakes zeroed counters for final results.
  admissionPending: boolean("admission_pending").notNull().default(false),
  // When the telemetry row was last written (for display on the Coverage tab).
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // Composite PK: one row per (source, intake-label) pair so RSS and team/social
  // snapshots for the same canonical outlet name stay independent.
  pk: primaryKey({ columns: [table.sourceName, table.lastLabel] }),
}));

export type CuratedIntakeTelemetry = typeof curatedIntakeTelemetry.$inferSelect;

// =============================================================================
// Committee hearing tracker (Task #1077). Scheduled HASC / SASC hearings whose
// witness list includes a KEY US defense leader (SecDef, CJCS/VCJCS, service
// secretaries/chiefs, combatant commanders). Written ONLY by the hourly
// hearingTracker poll; read by the curated live-broadcast banner signal (a
// hearing with a mappable banner leader can light the "upcoming"/"live" cue)
// and by testimony intake (posted PDFs go through the NORMAL curated admission
// gate — nothing here bypasses relevance scoring). Never read by any main-feed
// path.
// =============================================================================
export const committeeHearings = pgTable("committee_hearings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  committee: text("committee").notNull(),          // 'HASC' | 'SASC'
  title: text("title").notNull(),
  // Canonical hearing detail-page URL — the stable identity key for upserts.
  eventUrl: text("event_url").notNull().unique(),
  // Scheduled start (parsed from the committee calendar, America/New_York wall
  // time converted to UTC). Null when the calendar listed a date but no time.
  startsAt: timestamp("starts_at"),
  // Raw witness lines as scraped from the detail page (name + role text).
  witnesses: text("witnesses").array().notNull().default(sql`'{}'`),
  // Which key-leader roster entries matched the witness list (e.g. 'secdef',
  // 'cjcs', 'cocom'). Empty = hearing seen but no tracked leader → ignored by
  // the banner signal and testimony intake.
  trackedLeaders: text("tracked_leaders").array().notNull().default(sql`'{}'`),
  // The BroadcastLeader label the banner may fire under, or null when the
  // matched roster entries have no precise banner mapping (fail-closed: such
  // hearings are tracked + testimony-ingested but never light the banner).
  bannerLeader: text("banner_leader"),
  // Posted testimony / opening-statement document URLs found on the detail page.
  testimonyUrls: text("testimony_urls").array().notNull().default(sql`'{}'`),
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
});

export const insertCommitteeHearingSchema = createInsertSchema(committeeHearings).omit({
  id: true,
  firstSeenAt: true,
  lastSeenAt: true,
});

export type InsertCommitteeHearing = z.infer<typeof insertCommitteeHearingSchema>;
export type CommitteeHearing = typeof committeeHearings.$inferSelect;

// =============================================================================
// Curated lane — editor-OVERRIDE LEARNING LOG (Task #540). A human-in-the-loop
// feedback loop (NOT an auto-tuner): every editor moderation action on the
// Curated view (hide/un-hide story, hide/un-hide image, priority pin, topic/
// category override, photo replace, link replace, outlet block/unblock) is
// appended here as an IMMUTABLE event the moment it happens, together with a
// SNAPSHOT of the content acted on (headline, outlet, country/region, content
// kind, the AI's original P-score, the original topic/category) so the signal
// about WHAT editors keep suppressing/boosting can be compiled into a report +
// an AI-written actionable brief. CURATED-ONLY observability: written by the
// curated moderation endpoints, read ONLY by the curated-gated override-log
// endpoint — never by getPrimaryFeed, Classic/Visual, custom MCOPs, or the
// public REST API, and it NEVER alters feed output (fail-closed isolation).
// =============================================================================
export const curatedOverrideEvents = pgTable("curated_override_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Scoring/relevance + metadata actions:
  // 'hide-story' | 'unhide-story' | 'priority-override' | 'hide-image' |
  // 'unhide-image' | 'replace-image' | 'replace-link' | 'classification' |
  // 'outlet-block' | 'outlet-unblock'
  // CLUSTERING-behavior actions (editor manual link/merge/unlink of stories) —
  // bucketed separately in the report + brief so they inform clustering tuning
  // (server/curatedCluster.ts), NOT scoring/relevance:
  // 'manual-link' | 'manual-merge' | 'manual-unlink'
  action: text("action").notNull(),
  // The server-built story key when applicable:
  // `cluster:<clusterId>` | `main:<id>` | `curated:<id>` (null for image-URL /
  // outlet-scoped actions).
  storyKey: text("story_key"),
  // The article URL (when resolvable) or the image URL for image actions.
  itemUrl: text("item_url"),
  // URL identity used for exact steering attribution. Unlike itemUrl it omits
  // tracking-only query parameters and is never inferred from a title or outlet.
  canonicalUrl: text("canonical_url"),
  // --- Content snapshot at action time (best-effort from the curated store) ---
  headline: text("headline"),
  outlet: text("outlet"),
  country: text("country"),
  region: text("region"),
  contentKind: text("content_kind"),
  // The AI's original P-score on the item/representative at action time.
  originalScore: integer("original_score"),
  // The AI's original scoring reasoning/rationale at action time (the cluster
  // representative's rationale where available) — so the log records WHY the AI
  // scored it as it did, alongside the editor's contrary action.
  originalReasoning: text("original_reasoning"),
  // The original controlled-vocabulary topic + specific category at action time.
  originalTopic: text("original_topic"),
  originalCategory: text("original_category"),
  // Human-readable description of the action + value, e.g. "pinned to 95",
  // "hidden", "re-labeled to China-Taiwan Relations", "outlet blocked".
  newValue: text("new_value"),
  // Machine-readable before/after snapshots for actions whose audit value is
  // richer than one label (notably Live Watch edits). Existing actions may
  // leave these null; they remain immutable with the event row.
  beforeValue: jsonb("before_value").$type<Record<string, unknown> | null>(),
  afterValue: jsonb("after_value").$type<Record<string, unknown> | null>(),
  editor: text("editor").notNull(),
  // Optional editor-supplied reason keys (controlled vocab) + free-text note.
  // Nullable — only P-score adjustments and manual link/merge carry reasons;
  // all other action types leave these null.
  reasonKeys: text("reason_keys").array(),
  reasonNote: text("reason_note"),
  // Scoring-radar telemetry (Task #834). Populated when a correction originates
  // from the Scoring Radar panel so the learning loop can distinguish radar-driven
  // promotions/demotions from organic editor actions in the main Top Stories view.
  // rawScore: AI's original undecayed P-score at action time (may differ from
  //   originalScore which reflects the cluster-rep's score for cluster overrides).
  rawScore: integer("raw_score"),
  // decayedScore: the effective displayed score at the moment the editor acted.
  decayedScore: integer("decayed_score"),
  // itemAgeHours: article age in hours at action time (drives decay).
  itemAgeHours: real("item_age_hours"),
  // surfacingState: why this item was NOT in Top Stories when the editor acted.
  // 'surfaced' = was in Top Stories (standard correction, not from radar).
  // 'below-cut' = eligible but ranked below the feed limit.
  // 'not-enriched' = missing bullets or real image (seeding gate failure).
  // 'attach-only' = outlet role prevents standalone seeding.
  // 'opinion-video' = content-kind gate bars it from Top Stories.
  // 'age-out' = article older than the feed window.
  // 'in-cluster' = item is a member of a formed story (already surfacing).
  surfacingState: text("surfacing_state"),
  // fromRadar: true when this action was initiated from the Scoring Radar panel.
  fromRadar: boolean("from_radar").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCuratedOverrideEventSchema = createInsertSchema(curatedOverrideEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertCuratedOverrideEvent = z.infer<typeof insertCuratedOverrideEventSchema>;
export type CuratedOverrideEvent = typeof curatedOverrideEvents.$inferSelect;

// Curated lane — single-row settings for the editor-override learning log
// (Task #540). `capturePaused` stops new events from being logged (persisted so
// it survives restarts). Curated-only; never read by any feed path.
export const curatedFeedbackSettings = pgTable("curated_feedback_settings", {
  id: text("id").primaryKey().default('global'),
  capturePaused: boolean("capture_paused").notNull().default(false),
  // Reset checkpoint: editor actions logged at/before this time are excluded from
  // the Adjustments report/recent/brief view (non-destructive — raw rows stay for
  // audit). Lets an editor clear the area after a tuning brief has been applied so
  // the next cycle measures only fresh signal. Curated-only; never read by a feed.
  acknowledgedAt: timestamp("acknowledged_at"),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CuratedFeedbackSettings = typeof curatedFeedbackSettings.$inferSelect;

// Curated View feedback — submissions from any Curated viewer (request or
// question about MCOP). Reviewed by editors in Source
// Oversight. CURATED-ONLY: never read by any feed or public API.
export const curatedViewFeedback = pgTable("curated_view_feedback", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // 'request' | 'suggestion' | 'question'
  feedbackType: text("feedback_type").notNull(),
  message: text("message").notNull(),
  anonymous: boolean("anonymous").notNull().default(false),
  wantsFollowUp: boolean("wants_follow_up").notNull().default(false),
  // Contact fields — null when anonymous or when follow-up not requested.
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactOrg: text("contact_org"),
  reviewed: boolean("reviewed").notNull().default(false),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  submittedAt: timestamp("submitted_at").notNull().defaultNow(),
});

// Curated lane — per-item human content-kind override (Task #892). Keyed by
// article URL (same identity as curated_classifications). An editor can mark
// a single article as analysis/opinion/editorial/other to demote it regardless
// of what AI enrichment detected. Protected from AI clobber by living in its
// own table (never overwritten by enrichment). CURATED-ONLY: gated to the
// curated lane; never read by Classic/Visual/custom-MCOP/public-API.
export const curatedContentKindOverrides = pgTable("curated_content_kind_overrides", {
  url: text("url").primaryKey(),
  // 'analysis' | 'opinion' | 'editorial' | 'other'
  kind: text("kind").notNull(),
  editor: text("editor").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type CuratedContentKindOverride = typeof curatedContentKindOverrides.$inferSelect;

export const insertCuratedViewFeedbackSchema = createInsertSchema(curatedViewFeedback).omit({
  id: true,
  reviewed: true,
  reviewedBy: true,
  reviewedAt: true,
  submittedAt: true,
}).extend({
  feedbackType: z.enum(['request', 'suggestion', 'question']),
  message: z.string().min(1).max(4000),
  contactName: z.string().max(200).optional().nullable(),
  contactEmail: z.string().email().max(300).optional().nullable(),
  contactOrg: z.string().max(200).optional().nullable(),
});

export type InsertCuratedViewFeedback = z.infer<typeof insertCuratedViewFeedbackSchema>;
export type CuratedViewFeedback = typeof curatedViewFeedback.$inferSelect;

// =============================================================================
// Persisted curated gate verdicts (Task #1083). Durable mirror of the in-memory
// gate-verdict memo cache in server/curatedIngest.ts: a redeploy previously
// cold-started the cache, so the first passes after every deploy re-paid the
// full AI gate for the same ~700 backlog titles. Rows are written after each
// gate phase and hydrated once at the first gate-mode pass after boot. Rows
// expire on the same TTL as the memo cache (expires_at) and are pruned lazily.
// Curated-lane only — nothing outside curated ingest reads this table.
// =============================================================================
export const curatedGateVerdicts = pgTable("curated_gate_verdicts", {
  // The exact analyzed title (same key as the in-memory memo cache).
  title: text("title").primaryKey(),
  // The full CuratedAnalysisResult verdict, replayed verbatim on cache hit.
  verdict: jsonb("verdict").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

export type CuratedGateVerdict = typeof curatedGateVerdicts.$inferSelect;

// =============================================================================
// Curated lane — EDITORIAL EPISODE + OBSERVATION/OUTCOME model (Task #1180).
//
// PURPOSE. The existing curated_override_events table (Task #540) is an
// APPEND-ONLY, IMMUTABLE log of individual editor moderation actions. It is
// perfect as raw evidence but it is deliberately flat: a single editorial
// decision ("this outlet keeps getting wrongly promoted, so I demote it every
// day") is scattered across many separate rows, and there is nowhere durable to
// record the SHAPE of that decision, whether it was later contradicted, undone,
// or superseded, or what the authoritative present-tense OUTCOME of the editor's
// intent actually is.
//
// This model adds that durable layer WITHOUT ever mutating the immutable event
// log. An EPISODE is a normalized, editor-facing grouping of one-or-more raw
// override events that together express a single editorial intent. Episodes are
// mutable (they collapse/upsert as new evidence arrives), carry lifecycle +
// persistence counters, and record contradiction / supersede / undo LINEAGE so
// the history of an intent is legible. Raw events are ATTACHED by reference
// (curated_editorial_episode_events) — the events themselves are never copied,
// edited, or deleted. OBSERVATIONS are append/upsert lifecycle notes on an
// episode; the OUTCOME is the single authoritative present-tense disposition.
//
// STRICT ISOLATION. This is additive, curated-only OBSERVABILITY. It NEVER
// alters feed output, NEVER creates training labels, NEVER writes through to
// human overrides or outlet roles, and is read only by curated-gated surfaces.
// The word "episode" here is EDITORIAL (an intent grouping) and is unrelated to
// the story-lifecycle "episode" bound in server/curatedEpisode.ts.
// =============================================================================
export const curatedEditorialEpisodes = pgTable("curated_editorial_episodes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Stable dedupe/collapse key for this exact editorial intent. Two raw events
  // that express the same intent (same normalized identities + action family)
  // collapse onto the same episode via this signature. Unique so upsert is
  // atomic.
  signature: text("signature").notNull().unique(),
  // The coarse ACTION FAMILY the intent belongs to — used to bucket episodes in
  // the review surface. Free-form controlled vocab set by the caller, e.g.
  // 'scoring' | 'relevance' | 'clustering' | 'classification' | 'outlet' |
  // 'image' | 'link'. Distinct from `action` which is the finest-grained verb.
  actionFamily: text("action_family").notNull().default(''),
  // The finest-grained action verb driving this episode (mirrors the raw event
  // action vocabulary, e.g. 'hide-story' | 'priority-override' | 'manual-link').
  action: text("action").notNull().default(''),
  // Controlled-vocab reason keys + free-text note summarizing WHY (editor-supplied,
  // carried from the raw events / collapse). Nullable — zero reasons is valid.
  reasonKeys: text("reason_keys").array(),
  reasonNote: text("reason_note"),
  // --- Normalized IDENTITIES the episode is about (any subset may be null). ---
  // Normalized identity URL (tracking params stripped) of the article/story
  // acted on. Never inferred from a title/outlet — mirrors override event
  // canonicalUrl semantics.
  canonicalUrl: text("canonical_url"),
  // Server-built story key at collapse time (`cluster:<id>` | `main:<id>` |
  // `curated:<id>`), when applicable.
  storyKey: text("story_key"),
  // Normalized outlet identity (outlet id/slug) the intent concerns, when the
  // intent is outlet-scoped. Read-only reference — this model NEVER writes to
  // outlet_registry or mutates outlet roles.
  outletId: text("outlet_id"),
  // --- Rich JSON snapshots (immutable per-collapse; append semantics). ---
  // The BEFORE state (what the AI/system had), the editor's REQUESTED change,
  // the ACTUAL applied result, any ALTERNATIVES the editor rejected, and the
  // PROVENANCE (where the signal came from: radar / organic / batch, source
  // event ids, collapse trail). All best-effort, all nullable.
  beforeJson: jsonb("before_json").$type<Record<string, unknown> | null>(),
  requestedJson: jsonb("requested_json").$type<Record<string, unknown> | null>(),
  actualJson: jsonb("actual_json").$type<Record<string, unknown> | null>(),
  alternativesJson: jsonb("alternatives_json").$type<Record<string, unknown>[] | null>(),
  provenanceJson: jsonb("provenance_json").$type<Record<string, unknown> | null>(),
  // The editor SURFACE the intent originated from, e.g. 'source-oversight' |
  // 'scoring-radar' | 'top-stories' | 'archive'. Free-form.
  editorSurface: text("editor_surface"),
  // DIRECTION of the intent: 'promote' | 'demote' | 'relabel' | 'suppress' |
  // 'link' | 'unlink' | 'neutral'. Free-form controlled vocab.
  direction: text("direction"),
  // VERIFIED = an editor confirmed this episode's intent is correct/intended.
  // AMBIGUOUS = the collapse is uncertain (conflicting evidence) and needs human
  // eyes. Both default false; neither ever gates a feed.
  verified: boolean("verified").notNull().default(false),
  ambiguous: boolean("ambiguous").notNull().default(false),
  // LIFECYCLE of the episode itself:
  // 'open'        — actively accumulating evidence.
  // 'settled'     — the intent is stable / authoritative.
  // 'contradicted'— a later opposing episode/event exists (see lineage).
  // 'superseded'  — replaced by a newer episode (see supersededById).
  // 'undone'      — the editor reversed the action (see undoneByEventId).
  lifecycle: text("lifecycle").notNull().default('open'),
  // The single authoritative present-tense OUTCOME label, e.g.
  // 'demoted' | 'promoted' | 'hidden' | 'relabeled' | 'reverted' | 'no-op'.
  // Updated in place by updateCuratedEditorialOutcome — the current truth.
  outcome: text("outcome"),
  // Free-text human note about the authoritative outcome (nullable).
  outcomeNote: text("outcome_note"),
  // --- PERSISTENCE counters + timestamps (how durable/repeated the intent is). ---
  // How many raw override events have collapsed onto this episode.
  eventCount: integer("event_count").notNull().default(0),
  // How many distinct editors contributed to this episode.
  editorCount: integer("editor_count").notNull().default(0),
  // How many times the episode has been re-observed/collapsed (persistence).
  observationCount: integer("observation_count").notNull().default(0),
  // Earliest / latest raw evidence timestamps folded into this episode (from the
  // immutable events), independent of the row's own created/updated stamps.
  firstEventAt: timestamp("first_event_at"),
  lastEventAt: timestamp("last_event_at"),
  // --- LINEAGE (never deletes history; points at the related rows). ---
  // If this episode CONTRADICTS a prior episode, the prior episode id.
  contradictsEpisodeId: varchar("contradicts_episode_id"),
  // If this episode was SUPERSEDED, the newer episode id that replaced it.
  supersededById: varchar("superseded_by_id"),
  // If the editor UNDID the intent, the immutable override event id of the undo.
  undoneByEventId: varchar("undone_by_event_id"),
  createdBy: text("created_by").notNull().default(''),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  signatureIdx: index("curated_editorial_episodes_signature_idx").on(table.signature),
  actionFamilyIdx: index("curated_editorial_episodes_action_family_idx").on(table.actionFamily),
  lifecycleIdx: index("curated_editorial_episodes_lifecycle_idx").on(table.lifecycle),
  canonicalUrlIdx: index("curated_editorial_episodes_canonical_url_idx").on(table.canonicalUrl),
  updatedIdx: index("curated_editorial_episodes_updated_idx").on(table.updatedAt),
  // Matches the bounded authoritative-observer lookup. PostgreSQL can scan the
  // final btree column backward for ORDER BY updated_at DESC.
  activeObserverIdx: index("curated_editorial_episodes_active_observer_idx")
    .on(table.actionFamily, table.lifecycle, table.updatedAt),
}));

export const insertCuratedEditorialEpisodeSchema = createInsertSchema(curatedEditorialEpisodes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCuratedEditorialEpisode = z.infer<typeof insertCuratedEditorialEpisodeSchema>;
export type CuratedEditorialEpisode = typeof curatedEditorialEpisodes.$inferSelect;

// Curated lane — RAW-EVENT LINKAGE for editorial episodes (Task #1180). One row
// per (episode, immutable override event) attachment. The join is BY REFERENCE:
// the raw event id points at curated_override_events, which stays immutable and
// is NEVER edited/deleted by this model. Unique on (episodeId, eventId) so
// re-attaching the same event during a collapse is idempotent.
export const curatedEditorialEpisodeEvents = pgTable("curated_editorial_episode_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  episodeId: varchar("episode_id").notNull(),
  // The immutable curated_override_events.id being attached (soft reference — no
  // FK so a pruned/rotated event can never break the link table).
  eventId: varchar("event_id").notNull(),
  // Snapshot of the raw event's action + editor + timestamp at attach time, so
  // the episode is legible even if the source event later rotates out of the
  // retention window. Display-only.
  eventAction: text("event_action"),
  eventEditor: text("event_editor"),
  eventAt: timestamp("event_at"),
  attachedAt: timestamp("attached_at").notNull().defaultNow(),
}, (table) => ({
  episodeIdx: index("curated_editorial_episode_events_episode_idx").on(table.episodeId),
  eventIdx: index("curated_editorial_episode_events_event_idx").on(table.eventId),
  uniq: uniqueIndex("curated_editorial_episode_events_uniq").on(table.episodeId, table.eventId),
}));

export type CuratedEditorialEpisodeEvent = typeof curatedEditorialEpisodeEvents.$inferSelect;

// Curated lane — LIFECYCLE OBSERVATIONS on an editorial episode (Task #1180).
// Append/upsert notes recording how an episode evolved (re-observed, verified,
// contradicted, undone, superseded). Distinct from the single authoritative
// OUTCOME on the episode row: observations are the trail, the outcome is the
// present truth. `observationKey` lets a caller UPSERT a specific observation
// (e.g. one per pass/day) instead of appending a duplicate; when null the row is
// a pure append.
export const curatedEditorialObservations = pgTable("curated_editorial_observations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  episodeId: varchar("episode_id").notNull(),
  // Optional idempotency key for upsert-in-place (unique with episodeId). Null =
  // append-only observation.
  observationKey: text("observation_key"),
  // 'observed' | 'verified' | 'contradicted' | 'undone' | 'superseded' | 'note'.
  kind: text("kind").notNull().default('observed'),
  note: text("note"),
  // Structured detail snapshot for this observation (nullable).
  detailJson: jsonb("detail_json").$type<Record<string, unknown> | null>(),
  observedBy: text("observed_by").notNull().default(''),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  episodeIdx: index("curated_editorial_observations_episode_idx").on(table.episodeId),
  uniq: uniqueIndex("curated_editorial_observations_uniq").on(table.episodeId, table.observationKey),
}));

export type CuratedEditorialObservation = typeof curatedEditorialObservations.$inferSelect;

// =============================================================================
// Curated lane — FROZEN LEGACY LEARNED-RULE INVENTORY / DISPOSITION (Task #1180).
//
// The Task #659 curated_learned_rules approval queue is being retired in favor
// of the editorial-episode model above. Rather than DELETE the historical rows
// (which would erase legible editorial history) or leave them live (which would
// keep enforcing), the migration FREEZES them: every legacy rule is copied into
// this inventory with a DISPOSITION describing what happened to it. This table
// is INERT — it is never consulted by enforcement, never produces a training
// label, and never writes through to overlays/outlet roles. It exists purely so
// the retired queue's contents remain reviewable.
//
// DISPOSITIONS set by the idempotent migration:
//   'frozen-review'    — legacy status was 'approved' (was live): moved into a
//                        frozen review inventory, NO LONGER enforced, kept for
//                        human review of what had been applied.
//   'historical-only'  — legacy status was 'suggested' or 'snoozed': archived as
//                        historical-only (never approved, purely informational).
//   'historical-other' — any other legacy status ('rejected' | 'revoked' | …):
//                        preserved verbatim as historical record.
// =============================================================================
export const curatedLegacyRuleInventory = pgTable("curated_legacy_rule_inventory", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // The source curated_learned_rules.id this inventory row was frozen from
  // (unique so the migration is idempotent — re-running never duplicates).
  legacyRuleId: varchar("legacy_rule_id").notNull().unique(),
  // Verbatim snapshot of the legacy rule at freeze time (display/audit only).
  ruleType: text("rule_type").notNull().default(''),
  signature: text("signature").notNull().default(''),
  label: text("label").notNull().default(''),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  // The legacy status the rule carried at freeze time.
  legacyStatus: text("legacy_status").notNull().default(''),
  // The disposition assigned by the migration (see enum in the block comment).
  disposition: text("disposition").notNull().default('historical-other'),
  // Explicit later editorial disposition of the inert inventory row. These
  // fields are audit metadata only and can never reactivate enforcement.
  dispositionedBy: text("dispositioned_by"),
  dispositionedAt: timestamp("dispositioned_at"),
  evidenceCount: integer("evidence_count").notNull().default(0),
  frozenAt: timestamp("frozen_at").notNull().defaultNow(),
}, (table) => ({
  dispositionIdx: index("curated_legacy_rule_inventory_disposition_idx").on(table.disposition),
  legacyStatusIdx: index("curated_legacy_rule_inventory_legacy_status_idx").on(table.legacyStatus),
}));

export type CuratedLegacyRuleInventory = typeof curatedLegacyRuleInventory.$inferSelect;

export * from "./models/auth";
