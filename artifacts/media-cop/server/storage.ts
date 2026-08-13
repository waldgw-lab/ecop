import { type User, type InsertUser, type Headline, type InsertHeadline, type TruthSocialPost, type InsertTruthSocialPost, type XPost, type InsertXPost, type RapidResponsePost, type InsertRapidResponsePost, type DOWResponsePost, type InsertDOWResponsePost, type SentDefenderPost, type InsertSentDefenderPost, type OsintPost, type InsertOsintPost, type ManualSubmission, type InsertManualSubmission, type FirstAlert, type InsertFirstAlert, type ScrapeMetadata, type InsertScrapeMetadata, type TeamChatMessage, type InsertTeamChatMessage, type TeamSubject, type InsertTeamSubject, type TeamSubmission, type InsertTeamSubmission, type TeamSubmissionRead, type TeamSubmissionComment, type InsertTeamSubmissionComment, type DrudgeBotPost, type InsertDrudgeBotPost, type BBCBotPost, type InsertBBCBotPost, type SocialBotPost, type InsertSocialBotPost, type BlockedBotContent, type InsertBlockedBotContent, type FoxNewsBotPost, type InsertFoxNewsBotPost, type ABCNewsBotPost, type InsertABCNewsBotPost, type CBSNewsBotPost, type InsertCBSNewsBotPost, type NBCNewsBotPost, type InsertNBCNewsBotPost, type APNewsBotPost, type InsertAPNewsBotPost, type ReutersBotPost, type InsertReutersBotPost, type RSSBotPost, type InsertRSSBotPost, type TeamMember, type WarArticle, type InsertWarArticle, type WarSettings, type AiSettings, type AiProviderMode, type WarOverride, type InsertWarOverride, type WarScreenshot, type InsertWarScreenshot, type FlightTrackingPost, type InsertFlightTrackingPost, type ArticleQuote, type InsertArticleQuote, type RelayTruthSocialPost, type InsertRelayTruthSocialPost, type QuarantinedHeadline, type InsertQuarantinedHeadline, type FilterMetrics, quarantinedHeadlines, filterMetrics, users, headlines, truthSocialPosts, relayTruthSocialPosts, xPosts, rapidResponsePosts, dowResponsePosts, sentDefenderPosts, osintPosts, journalistPosts, type JournalistPost, type InsertJournalistPost, manualSubmissions, firstAlerts, blockedHeadlines, scrapeMetadata, relayHeartbeats, type RelayHeartbeat, feedHealthState, type FeedHealthStateRow, teamChatMessages, teamSubjects, teamSubmissions, teamSubmissionReads, teamSubmissionComments, drudgeBotPosts, bbcBotPosts, socialBotPosts, blockedBotContent, foxNewsBotPosts, abcNewsBotPosts, cbsNewsBotPosts, nbcNewsBotPosts, apNewsBotPosts, reutersBotPosts, rssBotPosts, teamMembers, warfighterCyberAllowed, curatedViewTesters, warArticles, warSettings, aiSettings, warOverrides, warScreenshots, flightTrackingPosts, articleQuotes, customMcops, customMcopScores, customMcopArticles, customMcopScreenshots, customMcopHiddenItems, type CustomMcop, type InsertCustomMcop, type CustomMcopScore, type CustomMcopArticle, type InsertCustomMcopArticle, type CustomMcopScreenshot, type InsertCustomMcopScreenshot, type CustomMcopHiddenItem, outletRegistry, type OutletRegistry, curatedItems, type CuratedItem, type InsertCuratedItem, curatedClusterMembers, type CuratedClusterMember, curatedStorySynthesis, type CuratedStorySynthesis, curatedClassifications, type CuratedClassification, type InsertCuratedClassification, curatedPriorityOverrides, type CuratedPriorityOverride, curatedLinkReplacements, type CuratedLinkReplacement, curatedStoryArchive, type CuratedStoryArchive, type CuratedArchiveMember, curatedProcessSplitOverlays, type CuratedProcessSplitOverlay, type InsertCuratedProcessSplitOverlay, curatedClusterMetrics, type CuratedClusterMetrics, type InsertCuratedClusterMetrics, competingCoverageCache, type CompetingCoverageItem , classificationTopicProposals, type ClassificationTopicProposal, curatedHiddenStories, type CuratedHiddenStory, curatedImageReplacements, type CuratedImageReplacement, curatedHiddenImages, type CuratedHiddenImage, curatedHeadlineOverrides, type CuratedHeadlineOverride, curatedLiveBroadcastFirings, curatedLiveBroadcastModerations, type CuratedLiveBroadcastFiring, type InsertCuratedLiveBroadcastFiring, type CuratedLiveBroadcastModeration, type CuratedLiveBroadcastOverrides, meltwaterTelemetry, type MeltwaterTelemetry, curatedIntakeTelemetry, type CuratedIntakeTelemetry, curatedGateVerdicts, type CuratedGateVerdict, curatedOverrideEvents, type CuratedOverrideEvent, type InsertCuratedOverrideEvent, curatedManualLinks, type CuratedManualLink, type InsertCuratedManualLink, curatedManualEvictions, type CuratedManualEviction, type InsertCuratedManualEviction, curatedManualMoves, type CuratedManualMove, type InsertCuratedManualMove, curatedFeedbackSettings, type CuratedFeedbackSettings, curatedMemberConfirmations, type CuratedMemberConfirmation, curatedLearnedRules, type CuratedLearnedRule, type InsertCuratedLearnedRule, curatedViewFeedback, type CuratedViewFeedback, type InsertCuratedViewFeedback, curatedContentKindOverrides, type CuratedContentKindOverride, watchTopicTelemetry, committeeHearings, type CommitteeHearing, type InsertCommitteeHearing, curatedEditorialEpisodes, type CuratedEditorialEpisode, type InsertCuratedEditorialEpisode, curatedEditorialEpisodeEvents, type CuratedEditorialEpisodeEvent, curatedEditorialObservations, type CuratedEditorialObservation, curatedLegacyRuleInventory, type CuratedLegacyRuleInventory } from "@shared/schema";
import { db, withDbRetry } from "./db";
import { CURATED_EPISODE_HARD_AGE_MS } from "./curatedEpisode";
import { archiveRowStatus, type ArchiveStatus } from "./curatedStaleness";
import { eq, ne, desc, gte, lt, lte, sql, inArray, notInArray, isNull, isNotNull, and, or, like, ilike } from "drizzle-orm";
import { CURATED_ONLY_OSINT_HANDLES } from "./curatedOnlyOsint";
import { OTHER_EMERGING, coerceRegionField } from "@shared/classificationVocab";
import { stripBriefingPreamble, stripBriefingPreambleFromMessage } from "./summarySanitizer";
import { MAIN_FEED_PROMOTION_THRESHOLD, qualifiesForMainFeedPromotion } from "./relevanceDefinition";
import { normalizeIdentityUrl } from "./urlIdentity";
import { buildCuratedOnlyOutletIds, isCuratedOnlyForMainFeed } from "./curatedOnlyOutlets";
import { isSnoozeCooldownActive } from "./scoreAdjustments";
import { buildOutletIndex, type OutletIndex } from "@shared/outletRegistry";
import { dedupPrimaryFeed } from "./feedDedup";

// Fail-OPEN main-feed admission context (Task #533): the registry-derived set of
// "curated only" outlet IDs plus an outlet-resolver index, cached ~5 min. Used
// ONLY to skip auto-promoting a curated-only outlet onto the main feed. A build
// failure or an unresolved/unknown outlet never blocks promotion (fail-open).
let _curatedOnlyMainFeedCtx: { at: number; ids: Set<string>; index: OutletIndex } | null = null;
const CURATED_ONLY_MAINFEED_TTL_MS = 5 * 60 * 1000;

// Curated synthesis prune grace (headline-stability fix). Rows whose signature
// fell out of the current pass are kept this long before deletion so a
// consolidation-lane A -> B -> A member-set flip-back finds its cached synthesis
// (full reuse — zero LLM call) instead of re-rolling a fresh headline. Exported
// for the regression gate. 6h ≈ well past any realistic flip-back horizon
// (~10-min passes) while still clearing dead signatures within the news cycle.
export const CURATED_SYNTHESIS_PRUNE_GRACE_MS = 6 * 60 * 60 * 1000;

// Topic name constants
const FLASH_TOPIC_NAME = 'FLASH: TOP STORIES';
const CJCS_TOPIC_NAME = 'CJCS MENTIONS';
const MOST_RECENT_TOPIC_NAME = 'MOST RECENT';
const MATA_OSINT_TOPIC_NAME = 'MATA / OSINT SOCIAL MEDIA';
const MOST_RECENT_HOURS = 3;

/**
 * Calculate depreciated priority score based on headline age
 * - Hours 0-2: No depreciation
 * - Hour 3+: -10 points per hour
 * - Floor: 20 points minimum
 * 
 * Uses priorityOverrideAt if present (when manual override was set),
 * otherwise uses scrapedAt (original timestamp)
 */
export function calculateDepreciatedPriority(
  priorityScore: number,
  priorityOverride: number | null,
  scrapedAt: Date,
  priorityOverrideAt: Date | null = null,
  articlePublishedAt: Date | null = null
): { originalPriority: number; depreciatedPriority: number } {
  const originalPriority = priorityOverride ?? priorityScore;

  if (priorityOverride !== null && priorityOverride !== undefined) {
    return { originalPriority, depreciatedPriority: priorityOverride };
  }

  const now = new Date();
  // Anchor decay to the article's PUBLISHED date — the same date the UI shows as
  // "Xh ago" — when it is available and parseable, falling back to first-seen
  // scrapedAt otherwise. This keeps the decay clock matched to the displayed age
  // so an article published 20h ago decays even if it was only re-listed recently.
  let ageAnchor = new Date(scrapedAt);
  if (articlePublishedAt != null) {
    const pub = new Date(articlePublishedAt);
    if (!Number.isNaN(pub.getTime())) ageAnchor = pub;
  }
  const ageInHours = (now.getTime() - ageAnchor.getTime()) / (1000 * 60 * 60);
  
  if (ageInHours <= 2) {
    return { originalPriority, depreciatedPriority: originalPriority };
  }
  
  // Decay slope (Task #444, Step 4). The Phase-0 baseline measured ~83% of decayed
  // items pinned at the floor (20), i.e. the old -10/hr slope crushed the ranking
  // signal within a handful of hours — past ~10h everything looked identical. A
  // gentler -6/hr slope (keeping the 2h grace and the floor of 20) preserves a
  // meaningful spread for longer so recency still ranks, without ever raising a
  // score. This is DISPLAY / RANKING ONLY — depreciation is never a clustering
  // admission gate (per the curated-decay-anchoring invariant), so harnesses that
  // strip priority/decay fields are unaffected.
  const hoursToDepreciate = Math.floor(ageInHours - 2);
  const depreciation = hoursToDepreciate * 6;
  const depreciatedPriority = Math.max(20, originalPriority - depreciation);
  
  return { originalPriority, depreciatedPriority };
}

/**
 * Importance-aware decay parameters for the CURATED lane (Task #1129,
 * tightened per user feedback).
 *
 * The flat -6/hr curve inverts intent: a P-95 critical story loses rank
 * fastest in absolute terms and drops below a fresh P-60 within ~8 hours.
 * Tiering fixes that without letting high-score stories park indefinitely:
 *   - low/mid band (P < 70): unchanged — 2h grace, -6/hr.
 *   - critical band (P >= 85): 3h grace, -4/hr — a P85 story at 5h shows
 *     ~77, keeping fresh breaking news naturally above older same-score
 *     coverage (P95 @ 12h ≈ 59, crossover with a fresh P-60 near 12h).
 *   - transition band (70..85): grace and slope linearly interpolated so
 *     there is no cliff at a boundary.
 */
export function curatedDecayParams(originalPriority: number): {
  graceHours: number;
  slopePerHour: number;
} {
  if (originalPriority < 70) return { graceHours: 2, slopePerHour: 6 };
  if (originalPriority >= 85) return { graceHours: 3, slopePerHour: 4 };
  const t = (originalPriority - 70) / 15;
  return { graceHours: 2 + t * 1, slopePerHour: 6 - t * 2 };
}

/**
 * Select the timestamp Curated may use as an item's effective age anchor.
 *
 * Publication time normally wins, but an upstream clock/timezone error can put
 * it ahead of the server clock. Such a date must not make an item look newer
 * than its first-seen time, produce a negative "hours old" value, or suspend
 * priority decay. Fall back to scrapedAt when it is valid; if neither input is
 * usable, use now as the safe zero-age anchor.
 */
export function getCuratedEffectiveAgeAnchor(
  scrapedAt: Date | null | undefined,
  articlePublishedAt: Date | null | undefined,
  nowMs = Date.now(),
): Date {
  const firstSeen = scrapedAt ? new Date(scrapedAt) : null;
  const published = articlePublishedAt ? new Date(articlePublishedAt) : null;
  const hasValidFirstSeen = !!firstSeen && !Number.isNaN(firstSeen.getTime());
  const hasValidPublished = !!published && !Number.isNaN(published.getTime());

  // A future publication instant is not a valid age anchor for Curated. This
  // deliberately includes small skews: first-seen is the honest fallback.
  if (hasValidPublished && published!.getTime() <= nowMs) return published!;
  if (hasValidFirstSeen) return firstSeen!;
  return new Date(nowMs);
}

/**
 * CURATED-LANE variant of calculateDepreciatedPriority with the
 * importance-aware curve above. Same signature and invariants as the flat
 * helper: manual overrides bypass decay, published-date anchoring with
 * scrapedAt fallback, floor of 20, minimum 2h grace, and the result never
 * exceeds the original score. DISPLAY / RANKING ONLY — never a clustering
 * admission gate. Main-feed callers (getPrimaryFeed, custom-MCOP) stay on
 * the flat calculateDepreciatedPriority on purpose (Task #1129 out-of-scope).
 */
export function calculateCuratedDepreciatedPriority(
  priorityScore: number,
  priorityOverride: number | null,
  scrapedAt: Date,
  priorityOverrideAt: Date | null = null,
  articlePublishedAt: Date | null = null,
  nowMs = Date.now(),
): { originalPriority: number; depreciatedPriority: number } {
  const originalPriority = priorityOverride ?? priorityScore;

  if (priorityOverride !== null && priorityOverride !== undefined) {
    return { originalPriority, depreciatedPriority: priorityOverride };
  }

  const ageAnchor = getCuratedEffectiveAgeAnchor(scrapedAt, articlePublishedAt, nowMs);
  const ageInHours = Math.max(0, (nowMs - ageAnchor.getTime()) / (1000 * 60 * 60));

  const { graceHours, slopePerHour } = curatedDecayParams(originalPriority);

  if (ageInHours <= graceHours) {
    return { originalPriority, depreciatedPriority: originalPriority };
  }

  const hoursToDepreciate = Math.floor(ageInHours - graceHours);
  const depreciation = hoursToDepreciate * slopePerHour;
  // No rounding: rounding up a fractional score would violate never-raise.
  const depreciatedPriority = Math.max(20, originalPriority - depreciation);

  return { originalPriority, depreciatedPriority };
}

export interface CuratedLinkReviewEvidence {
  title: string;
  source: string;
  url: string;
  articlePublishedAt?: Date | null;
  scrapedAt?: Date | null;
  publishedAt?: Date | null;
  role?: string | null;
  summary?: string | null;
  summaryBullets?: string[] | null;
}

// Summary returned by observeCuratedEditorialOutcomesAfterCluster (Task #1180).
// Pure counters so the caller can log a one-line telemetry summary without ever
// re-reading the episode table. `scanned` is the number of ACTIVE episodes the
// bounded scan examined (never the full retained history).
export interface CuratedEditorialOutcomeObservationSummary {
  scanned: number;
  applied: number;
  deferred: number;
  conflicted: number;
  dormant: number;
  superseded: number;
  undone: number;
  failed: number;
  latencyMs: number;
}

function requestedIdentitySnapshot(
  ep: CuratedEditorialEpisode,
  clusterByUrl: Map<string, string>,
  scoreByUrl: Map<string, number>,
): Array<{ url: string; clusterId: string | null; score: number | null }> {
  const req = (ep.requestedJson && typeof ep.requestedJson === 'object'
    ? ep.requestedJson
    : {}) as Record<string, unknown>;
  const values = [
    ...(Array.isArray(req.requestedMemberUrls) ? req.requestedMemberUrls : []),
    ...(Array.isArray(req.requestedSeparateFromUrls) ? req.requestedSeparateFromUrls : []),
    ...(Array.isArray(req.requestedAbsentUrls) ? req.requestedAbsentUrls : []),
  ];
  const urls = Array.from(new Set(
    values
      .filter((u): u is string => typeof u === 'string' && u.length > 0)
      .map((u) => normalizeIdentityUrl(u)),
  ));
  return urls.map((url) => ({
    url,
    clusterId: clusterByUrl.get(url) ?? null,
    score: scoreByUrl.get(url) ?? null,
  }));
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Headline operations
  getAllHeadlines(): Promise<Headline[]>;
  getRecentHeadlines(hours: number): Promise<Headline[]>;
  addHeadline(headline: InsertHeadline, normalizedTitle: string): Promise<Headline>;
  getHeadlineByTitle(title: string): Promise<Headline | undefined>;
  getHeadlineById(id: string): Promise<Headline | undefined>;
  getSimilarHeadlines(normalizedTitle: string, hours: number): Promise<Headline[]>;
  updateHeadline(id: string, updates: Partial<InsertHeadline>, normalizedTitle?: string): Promise<Headline>;
  clearOldHeadlines(hours: number): Promise<void>;

  // Curated lane (Task #89) — SEPARATE curated store + isolated cluster mapping.
  // These are read ONLY by the curated-gated endpoints/jobs. They MUST NEVER be
  // used by getPrimaryFeed, the public REST API, custom MCOPs, or Classic/Visual.
  addCuratedItem(item: InsertCuratedItem, normalizedTitle: string): Promise<CuratedItem>;
  getCuratedStoreItems(hours: number): Promise<CuratedItem[]>;
  getRecentAPCuratedItems(hours: number, limit: number): Promise<Pick<CuratedItem, 'id' | 'url' | 'title'>[]>;
  repairAPCuratedTitleByUrl(url: string, title: string, normalizedTitle: string): Promise<boolean>;
  // Lean projection for the State-Controlled Narratives lens (perf): only the
  // columns that lens reads, so a wide curated-store window doesn't ship the
  // heavy article body/claims over the serverless driver on the request path.
  getCuratedStoreItemsForNarratives(hours: number): Promise<Pick<CuratedItem, 'id' | 'title' | 'source' | 'url' | 'category' | 'priorityScore' | 'articlePublishedAt' | 'scrapedAt' | 'contentKind' | 'summary' | 'summaryBullets'>[]>;
  // Lean curated-store projection for the public /api/v1/state-media lane. Reads
  // only the contract columns (newest-scraped first, bounded by `max`); the
  // adversary/contrast filtering + dedup happens in the API layer via the shared
  // registry helpers, so this stays a plain read.
  getCuratedItemsForStateMedia(max: number): Promise<Pick<CuratedItem, 'id' | 'title' | 'source' | 'url' | 'priorityScore' | 'articlePublishedAt' | 'scrapedAt' | 'contentKind' | 'summary' | 'summaryBullets'>[]>;
  // Lean curated-store projection for the learned-rule compiler's retrospective
  // impact preview (Task #887): the FULL item corpus in the lookback window
  // (not just corrected items), so an approval card can show the real
  // outlet×category blast radius a rule would have had. Columns are limited to
  // exactly what the impact math needs (identity + match keys + score).
  getCuratedItemsForImpactPreview(hours: number): Promise<Pick<CuratedItem, 'url' | 'title' | 'source' | 'category' | 'priorityScore'>[]>;
  getCuratedItemByUrl(url: string): Promise<CuratedItem | undefined>;
  getCuratedLinkReviewEvidence(urls: string[]): Promise<CuratedLinkReviewEvidence[]>;
  /** Retro-cap: lower an item's machine priority_score to `cap` only when the
   * stored score exceeds it. Curated-lane ONLY — called from the content-kind
   * override endpoint (Task #1027). No-op when the item is not found. */
  updateCuratedItemPriorityScore(id: string, score: number): Promise<void>;
  getExistingCuratedUrls(urls: string[]): Promise<Set<string>>;
  getCuratedItemsByIds(ids: string[]): Promise<Map<string, CuratedItem>>;
  getSimilarCuratedItems(normalizedTitle: string, hours: number): Promise<CuratedItem[]>;
  // Unbounded same-outlet similarity pass (Task #708). Returns every stored item
  // from the given canonical source whose normalizedTitle clears the 0.85
  // similarity bar within the window — NO top-N cap — so a same-outlet re-emit
  // at a different URL is never crowded out of the dedup window by a busy event
  // that already has many near-identical headlines from OTHER outlets. Called in
  // parallel with getSimilarCuratedItems and merged before isSameArticleDuplicate.
  getSimilarCuratedItemsForOutlet(source: string, normalizedTitle: string, hours: number): Promise<CuratedItem[]>;
  // Batched dedup corpus (Task #1105). ONE lean read of the identity columns the
  // same-article fuzzy de-dupe needs (url + source + normalizedTitle +
  // scrapedAt) for the whole store window, so the curated ingest can run the
  // similarity checks IN MEMORY per pass instead of two Neon round-trips per
  // candidate (~275 ms/item — the RSS backlog bottleneck).
  getCuratedDedupCorpus(hours: number): Promise<Array<{ url: string; source: string; normalizedTitle: string; scrapedAt: Date }>>;
  clearOldCuratedItems(hours: number): Promise<void>;
  normalizeCuratedItemSources(resolveCanonical: (source: string, url: string) => string | null): Promise<number>;
  getCuratedClassificationsByUrls(urls: string[]): Promise<Map<string, CuratedClassification>>;
  upsertCuratedClassifications(rows: InsertCuratedClassification[], opts?: { onlyIfAi?: boolean }): Promise<void>;
  // Per-item human content-kind override (Task #892). Separate table so AI
  // enrichment never clobbers it. All four display values demote to opinion-like
  // behavior (attach-only in clustering; excluded from headline surfaces).
  getCuratedContentKindOverrides(): Promise<Map<string, string>>;
  getCuratedContentKindOverrideByUrl(url: string): Promise<string | null>;
  setCuratedContentKindOverride(url: string, kind: string | null, editor: string): Promise<void>;
  // Canonical-key resolver: maps a DISPLAY url (possibly a dead-link
  // replacement) back to normalizeIdentityUrl(<original stored url>) so the
  // override always keys on the article's real identity.
  resolveCuratedContentKindTargetUrl(url: string): Promise<string>;
  // Retention prune (Task #892/#893): a mark is bound to the article that was
  // live when the editor set it. Curated items age out of the store at 48h, so
  // any override untouched for `days` (well past the window) is definitionally
  // stale — deleting it prevents the mark from silently re-attaching to a NEW
  // story that later appears at the same (reused) URL. Returns rows deleted.
  pruneStaleCuratedContentKindOverrides(days: number): Promise<number>;
  recordClassificationProposal(p: { kind?: string; proposedLabel: string; sampleTitle?: string | null; rationale?: string | null }): Promise<void>;
  getClassificationProposals(): Promise<ClassificationTopicProposal[]>;
  // Read-only vocabulary-drift surface (Task #351). Aggregates in-window curated
  // classification rows that fell to the `Other / Emerging` catch-all, grouped by
  // their specific free-form category/legacy_category, with counts, sample
  // headlines, and first/last-seen. CURATED-LANE read only — never mutates.
  getCatchAllTopicClusters(hours: number, limit: number): Promise<Array<{ category: string; count: number; firstSeen: Date; lastSeen: Date; sampleTitles: string[] }>>;
  replaceCuratedClusterMembers(members: Array<Omit<CuratedClusterMember, 'id' | 'createdAt'>>): Promise<void>;
  appendCuratedClusterMemberIfAbsent(member: Omit<CuratedClusterMember, 'id' | 'createdAt'>): Promise<boolean>;
  // Omit `hours` for the authoritative current membership snapshot. The table is
  // replaced transactionally on each full pass, so created_at is not story age
  // and must not be used to hide still-live members from classification.
  getCuratedClusterMembers(hours?: number): Promise<CuratedClusterMember[]>;
  getCuratedClusterMembersByClusterId(clusterId: string): Promise<CuratedClusterMember[]>;
  // Cross-pass member-confirmation hysteresis (Task #645). Bump increments (or
  // starts at 1) the persisted streak for one provisional member and returns
  // the resulting count; called by BOTH the full clustering pass (semantic
  // adversary-attach) and the incremental-attach bridge — the two ONLY
  // volatile addition paths. Prune deletes every confirmation row whose key is
  // not in the given active set, called ONLY by the full pass (the sole
  // authoritative reconciler) so a dropped/promoted member's streak resets
  // instead of resurrecting a stale count on a later re-appearance.
  bumpCuratedMemberConfirmation(clusterId: string, itemType: string, itemId: string): Promise<number>;
  pruneCuratedMemberConfirmations(activeKeys: string[]): Promise<void>;
  // Bounded override-safe re-check bookkeeping (Task #350, curated-lane only).
  setCuratedRecheckDisagreeCounts(updates: Array<{ url: string; count: number }>): Promise<void>;
  clearCuratedAiClassifications(urls: string[], staleAt: Date): Promise<string[]>;
  // Curated lane (Task #90) — story synthesis cache keyed by content signature.
  getCuratedStorySynthesisMap(): Promise<Map<string, CuratedStorySynthesis>>;
  getCuratedStorySynthesisBySignature(signature: string): Promise<CuratedStorySynthesis | undefined>;
  upsertCuratedStorySynthesis(row: { signature: string; headline: string; lede: string; facts: string[]; spins: Record<string, string>; alignments: Record<string, { align: string[]; diverge: string[]; pct?: number }>; attributedClaims?: string[]; contentHash?: string; corroborated?: boolean | null; synthesizedThrough?: Date | null }): Promise<void>;
  pruneCuratedStorySynthesisNotIn(signatures: string[]): Promise<void>;
  bustCuratedStorySynthesisContentHash(signatures: string[]): Promise<void>;
  // Curated lane — historical story archive (one row per FORMED story, keyed by
  // signature = clusterId). Read ONLY by the curated-gated archive endpoint.
  upsertCuratedStoryArchive(row: { signature: string; headline: string; lede: string; facts: string[]; category: string | null; region: string | null; country: string | null; sourceCount: number; repTitle: string | null; repSource: string | null; repUrl: string | null; ogImageUrl: string | null; members: CuratedArchiveMember[]; splitLineageKey?: string | null }): Promise<{ action: 'exact' | 'carry_forward' | 'insert'; absorbed: number }>;
  searchCuratedStoryArchive(opts: { query?: string; limit?: number; offset?: number }): Promise<{ items: Array<CuratedStoryArchive & { status: ArchiveStatus }>; total: number }>;
  getCuratedArchiveGraceCandidates(withinHours: number, maxRows: number): Promise<CuratedStoryArchive[]>;
  pruneCuratedStoryArchive(retentionDays: number): Promise<void>;
  // Curated lane — clustering flight-recorder metrics (one row per pass).
  // Append-only observability; read ONLY by the curated-gated metrics endpoint.
  recordCuratedClusterMetrics(row: InsertCuratedClusterMetrics): Promise<void>;
  getCuratedClusterMetrics(limit: number): Promise<CuratedClusterMetrics[]>;
  // Curated lane — "smart process re-partition" overlays. Persisted AI split
  // decisions re-applied each pass. Read/written ONLY inside the curated
  // clustering pass (fail-closed isolation; never on the public API).
  getActiveCuratedSplitOverlays(): Promise<CuratedProcessSplitOverlay[]>;
  upsertCuratedSplitOverlay(row: InsertCuratedProcessSplitOverlay & { id?: string }): Promise<CuratedProcessSplitOverlay>;
  pruneCuratedSplitOverlaysOlderThan(staleHours: number): Promise<void>;
  // Curated EDITOR manual-link overlay (human must-link). Active ones are applied
  // every clustering pass; the full list (incl. revoked) is the oversight audit
  // trail. Curated-only.
  getActiveCuratedManualLinks(): Promise<CuratedManualLink[]>;
  getCuratedManualLink(id: string): Promise<CuratedManualLink | undefined>;
  getRecentCuratedManualLinks(limit: number, after?: Date | null, before?: Date | null): Promise<CuratedManualLink[]>;
  createCuratedManualLink(row: InsertCuratedManualLink): Promise<CuratedManualLink>;
  createCuratedManualLinkConsolidated(
    row: InsertCuratedManualLink,
    options: { absorbOverlaps: boolean; effectiveUrlCap: number },
  ): Promise<{
    row: CuratedManualLink;
    effectiveMemberUrls: string[];
    effectiveKind: 'link' | 'merge';
    supersededIds: string[];
  }>;
  revokeCuratedManualLink(id: string, revokedBy: string): Promise<CuratedManualLink | undefined>;
  pruneCuratedManualLinksOlderThan(staleHours: number): Promise<void>;
  // Curated EDITOR manual-EVICTION overlay (human cannot-link — the mirror-image
  // of the manual-link). Active ones are applied every clustering pass to remove
  // a wrongly-merged member from its cluster; the full list (incl. revoked) is
  // the oversight audit trail. Curated-only.
  getActiveCuratedManualEvictions(): Promise<CuratedManualEviction[]>;
  getCuratedManualEviction(id: string): Promise<CuratedManualEviction | undefined>;
  getRecentCuratedManualEvictions(limit: number, after?: Date | null, before?: Date | null): Promise<CuratedManualEviction[]>;
  createCuratedManualEviction(row: InsertCuratedManualEviction): Promise<CuratedManualEviction>;
  revokeCuratedManualEviction(id: string, revokedBy: string): Promise<CuratedManualEviction | undefined>;
  pruneCuratedManualEvictionsOlderThan(staleHours: number): Promise<void>;
  // Curated EDITOR manual-MOVE overlay (human "belongs in that OTHER story" —
  // atomic evict-from-source + attach-to-target, its own overlay so it can
  // never fuse the two clusters). Active ones are applied every clustering
  // pass; the full list (incl. revoked) is the oversight audit trail.
  // Curated-only.
  getActiveCuratedManualMoves(): Promise<CuratedManualMove[]>;
  getCuratedManualMove(id: string): Promise<CuratedManualMove | undefined>;
  getRecentCuratedManualMoves(limit: number, after?: Date | null, before?: Date | null): Promise<CuratedManualMove[]>;
  createCuratedManualMove(row: InsertCuratedManualMove): Promise<CuratedManualMove>;
  revokeCuratedManualMove(id: string, revokedBy: string): Promise<CuratedManualMove | undefined>;
  revokeActiveCuratedManualMovesForUrl(itemUrl: string): Promise<number>;
  pruneCuratedManualMovesOlderThan(staleHours: number): Promise<void>;
  // Episode-origination (firstSeenAt) lookup keyed by signature (Task #334) —
  // drives age-bounded stable-id reuse in the clustering engine. Curated-only.
  getCuratedArchiveOriginationBySignatures(signatures: string[]): Promise<Map<string, Date>>;
  // One-time/maintenance backlog cleanup: collapse existing duplicate (same-story)
  // archive rows into one survivor each. Dry-run by default. Curated-only.
  normalizeCuratedArchiveDuplicates(opts: { dryRun?: boolean; windowHours?: number }): Promise<{ dryRun: boolean; windowHours: number; scanned: number; duplicateGroups: number; rowsAbsorbed: number; groups: Array<{ survivorHeadline: string; absorbed: number; totalSources: number; sampleHeadlines: string[] }> }>;
  // One-time/maintenance cleanup: close legacy over-age "zombie" archive rows by
  // bounding their members to the most-recent episode window. Dry-run by default.
  // Curated-only.
  boundOverAgeCuratedArchiveEpisodes(opts: { dryRun?: boolean; windowHours?: number }): Promise<{ dryRun: boolean; windowHours: number; scanned: number; boundedRows: number; sourcesRemoved: number; rows: Array<{ headline: string; before: number; after: number; spanHours: number }> }>;
  // Curated-only manual Priority overrides (allowlist-gated editing). Keyed by a
  // standalone item's stable curated key (`main:<id>` / `curated:<id>`) or a
  // cluster's deterministic id (`cluster:<clusterId>`). Read/written ONLY by the
  // curated-gated endpoints — never touches the main-feed priority_override.
  getCuratedPriorityOverrides(): Promise<Map<string, number>>;
  setCuratedPriorityOverride(key: string, priorityScore: number, updatedBy: string): Promise<void>;
  // Curated lane (Task #226) — dead-link tracking + allowlist-gated replacement
  // overlay. All curated-only; never touches the main feed.
  getCuratedLinkReplacements(): Promise<Map<string, string>>;
  setCuratedLinkReplacement(key: string, url: string, updatedBy: string): Promise<void>;
  // Curated-only editor HIDE overlay (Task #380). Allowlist-gated take-down of a
  // bad curated story. Read/written ONLY by the curated-gated endpoints; never
  // touches the main feed, Classic/Visual, custom MCOPs, or the public API.
  getCuratedHiddenStories(): Promise<CuratedHiddenStory[]>;
  setCuratedHiddenStory(key: string, clusterId: string | null, memberKeys: string[], hiddenBy: string): Promise<void>;
  removeCuratedHiddenStory(key: string): Promise<void>;
  // Curated-only editor PHOTO overlays (Task #380 expansion). Single-source image
  // replacement (keyed `main:<id>`/`curated:<id>`) + hidden cluster member photos
  // (keyed by image URL). Read/written ONLY by the curated-gated endpoints; never
  // touches the main feed, Classic/Visual, custom MCOPs, or the public API.
  getCuratedImageReplacements(): Promise<Map<string, string>>;
  setCuratedImageReplacement(key: string, url: string, updatedBy: string): Promise<void>;
  removeCuratedImageReplacement(key: string): Promise<void>;
  getCuratedHiddenImages(): Promise<Set<string>>;
  setCuratedHiddenImage(imageUrl: string, hiddenBy: string): Promise<void>;
  removeCuratedHiddenImage(imageUrl: string): Promise<void>;
  // Curated lane — editor HEADLINE + BULLETS + CLAIMS overlay. Allowlist-gated,
  // CURATED-ONLY: stores a display-only correction to a story's generated text.
  // Never touches headlines/manual_submissions or any non-curated reader.
  getCuratedHeadlineOverrides(): Promise<Map<string, { headline: string | null; bullets: string[] | null; claims: string[] | null; provenance: string }>>;
  setCuratedHeadlineOverride(key: string, headline: string | null, bullets: string[] | null, claims: string[] | null, updatedBy: string, provenance?: string): Promise<void>;
  removeCuratedHeadlineOverride(key: string): Promise<void>;
  getCuratedItemsForLinkCheck(hours: number, maxItems: number): Promise<CuratedItem[]>;
  recordCuratedLinkCheck(id: string, result: 'dead' | 'alive' | 'unknown'): Promise<void>;
  applyCuratedLinkReplacement(id: string): Promise<void>;
  // Curated lane (Task #203) — "Competing Coverage" cache (GDELT top stories,
  // ranked by coverage volume). Read ONLY by the curated-gated endpoint.
  getCompetingCoverage(): Promise<{ domestic: CompetingCoverageItem[]; international: CompetingCoverageItem[]; buzz: CompetingCoverageItem[]; updatedAt: number | null }>;
  upsertCompetingCoverage(scope: string, items: CompetingCoverageItem[]): Promise<void>;
  clearAllHeadlines(): Promise<void>;
  updateHeadlinePriority(id: string, priorityOverride: number | null): Promise<void>;
  updateHeadlineTitle(id: string, title: string, normalizedTitle: string): Promise<void>;
  blockHeadline(id: string, type?: 'scraped' | 'manual'): Promise<void>;
  isHeadlineBlocked(normalizedTitle: string): Promise<boolean>;
  
  // Truth Social operations
  getRecentTruthSocialPosts(limit: number): Promise<TruthSocialPost[]>;
  getCuratedTruthSocialPosts(since: Date, maxRows: number): Promise<TruthSocialPost[]>;
  addTruthSocialPost(post: InsertTruthSocialPost): Promise<TruthSocialPost>;
  getTruthSocialPostByPostId(postId: string): Promise<TruthSocialPost | undefined>;
  getTruthSocialPostByContentPrefix(contentPrefix: string): Promise<TruthSocialPost | undefined>;
  getTruthSocialPostByTruthSocialUrl(truthSocialUrl: string): Promise<TruthSocialPost | undefined>;
  updateTruthSocialPost(id: string, fields: Partial<InsertTruthSocialPost>): Promise<void>;
  updateTruthSocialPostImage(id: string, imageUrl: string | null): Promise<void>;
  updateTruthSocialPostMedia(id: string, fields: { imageUrl?: string | null; videoUrl?: string | null; videoThumbnailUrl?: string | null }): Promise<void>;
  updateTruthSocialPostExtractedText(id: string, extractedImageText: string): Promise<void>;
  deleteTruthSocialPost(id: string): Promise<void>;
  clearAllTruthSocialPosts(): Promise<number>;

  // Relay Truth Social staging operations
  addRelayTruthSocialPost(post: InsertRelayTruthSocialPost): Promise<RelayTruthSocialPost>;
  getRelayTruthSocialPostByPostId(postId: string): Promise<RelayTruthSocialPost | undefined>;
  getRecentRelayTruthSocialPosts(limit: number): Promise<RelayTruthSocialPost[]>;
  getRelayTruthSocialPostsMissingMedia(): Promise<RelayTruthSocialPost[]>;
  updateRelayTruthSocialPostMedia(id: string, fields: { imageUrl?: string | null; videoUrl?: string | null; videoThumbnailUrl?: string | null }): Promise<void>;
  
  // X/Twitter operations
  getRecentXPosts(limit: number): Promise<XPost[]>;
  getCuratedXPosts(since: Date, maxRows: number): Promise<XPost[]>;
  getCuratedOsintPosts(since: Date, maxRows: number, sourceAccount: string): Promise<OsintPost[]>;
  getRecentInfluencerXPosts(limit: number): Promise<XPost[]>;
  addXPost(post: InsertXPost): Promise<XPost>;
  getXPostByPostId(postId: string): Promise<XPost | undefined>;
  
  // RapidResponse operations
  getRecentRapidResponsePosts(limit: number): Promise<RapidResponsePost[]>;
  getCuratedRapidResponsePosts(since: Date, maxRows: number): Promise<RapidResponsePost[]>;
  addRapidResponsePost(post: InsertRapidResponsePost): Promise<RapidResponsePost>;
  getRapidResponsePostByPostId(postId: string): Promise<RapidResponsePost | undefined>;
  
  // DOWResponse operations
  getRecentDOWResponsePosts(limit: number): Promise<DOWResponsePost[]>;
  getCuratedDOWResponsePosts(since: Date, maxRows: number): Promise<DOWResponsePost[]>;
  addDOWResponsePost(post: InsertDOWResponsePost): Promise<DOWResponsePost>;
  getDOWResponsePostByPostId(postId: string): Promise<DOWResponsePost | undefined>;
  
  // SentDefender operations
  getRecentSentDefenderPosts(limit: number): Promise<SentDefenderPost[]>;
  getCuratedSentDefenderPosts(since: Date, maxRows: number): Promise<SentDefenderPost[]>;
  addSentDefenderPost(post: InsertSentDefenderPost): Promise<SentDefenderPost>;
  getSentDefenderPostByPostId(postId: string): Promise<SentDefenderPost | undefined>;
  
  // OSINT feed operations
  getRecentOsintPosts(limit: number, sourceAccount?: string): Promise<OsintPost[]>;
  addOsintPost(post: InsertOsintPost): Promise<OsintPost>;
  getOsintPostByPostId(postId: string): Promise<OsintPost | undefined>;

  // Journalists feed operations (Task #182) — curated-lane-only, isolated table.
  getRecentJournalistPosts(limit: number, sourceAccount?: string): Promise<JournalistPost[]>;
  getCuratedJournalistPosts(since: Date, maxRows: number, sourceAccount: string): Promise<JournalistPost[]>;
  addJournalistPost(post: InsertJournalistPost): Promise<JournalistPost>;
  getJournalistPostByPostId(postId: string): Promise<JournalistPost | undefined>;
  
  // Flight tracking post operations
  getRecentFlightTrackingPosts(limit: number): Promise<FlightTrackingPost[]>;
  addFlightTrackingPost(post: InsertFlightTrackingPost): Promise<FlightTrackingPost>;
  getFlightTrackingPostByPostId(postId: string): Promise<FlightTrackingPost | undefined>;

  // X feed management (hide/unhide across all X post tables)
  getAllXFeedPosts(limit: number): Promise<any[]>;
  hideXFeedPost(source: string, id: string, hidden: boolean): Promise<void>;

  // Manual Submission operations
  getAllManualSubmissions(): Promise<ManualSubmission[]>;
  getManualSubmissionByUrl(url: string): Promise<ManualSubmission | undefined>;
  getRecentManualSubmissions(hours: number): Promise<ManualSubmission[]>;
  addManualSubmission(submission: InsertManualSubmission): Promise<ManualSubmission>;
  getManualSubmissionById(id: string): Promise<ManualSubmission | undefined>;
  updateManualSubmissionPriority(id: string, priorityOverride: number | null): Promise<void>;
  updateManualSubmissionTitle(id: string, title: string): Promise<void>;
  updateHeadlineUrl(id: string, url: string): Promise<void>;
  updateManualSubmissionUrl(id: string, url: string): Promise<void>;
  
  // First Alert operations
  getRecentFirstAlerts(limit: number): Promise<FirstAlert[]>;
  addFirstAlert(alert: InsertFirstAlert): Promise<FirstAlert>;
  getFirstAlertByAlertId(alertId: string): Promise<FirstAlert | undefined>;
  getDataMinrNewsArticles(hours: number): Promise<FirstAlert[]>;
  
  // Primary feed (combines headlines + manual submissions)
  // mcopSlug: when omitted, headlines marked `restricted_to_mcops` are EXCLUDED
  // (this is what the main MCOP, Stream page, /war, prefetch, and public API
  // want). When passed, rows whose `restricted_to_mcops` array contains this
  // slug are also included (used by /api/custom-mcops/:slug/feed).
  getPrimaryFeed(hours: number, limit?: number, mcopSlug?: string): Promise<Array<Headline & { pdfPath?: string | null; type: 'scraped' | 'manual'; originalPriority: number; depreciatedPriority: number }>>;
  
  // Scrape metadata operations
  getScrapeMetadata(): Promise<ScrapeMetadata | undefined>;
  updateScrapeMetadata(updates: Partial<InsertScrapeMetadata>): Promise<void>;

  // Meltwater per-search run telemetry (read path used by Coverage + the
  // Registry ingestion-health builder).
  getMeltwaterTelemetries(): Promise<MeltwaterTelemetry[]>;

  // Durable relay heartbeat operations (Task #340) — one row per relay name
  // ('x' / 'truth-social'). Lets the in-memory relay heartbeat survive a
  // restart so MCOP stays in WATCHDOG mode across redeploys when the relay was
  // recently healthy. Written throttled / fire-and-forget by the relay services.
  getRelayHeartbeatAt(relay: string): Promise<Date | null>;
  setRelayHeartbeatAt(relay: string, at: Date): Promise<void>;

  // One-shot relay-outage escalation marker (Task #1020) — set when the outage
  // SMS for the current episode has been sent, cleared (null) on recovery.
  // Durable so a redeploy mid-outage never re-fires the escalation SMS.
  getRelayOutageEscalatedAt(relay: string): Promise<Date | null>;
  setRelayOutageEscalatedAt(relay: string, at: Date | null): Promise<void>;

  // Durable RSS feed-health state (Task #553) — one row per feed URL. Lets the
  // per-feed unhealthy streak / last outcome survive a restart so a long-dead
  // feed shows as stale/broken on the Coverage tab immediately after a redeploy
  // instead of resetting to "healthy" for 3 fresh cycles. Restored into the
  // feedHealthTracker's in-memory Map on boot; written fire-and-forget.
  getAllFeedHealthState(): Promise<FeedHealthStateRow[]>;
  upsertFeedHealthState(row: {
    url: string;
    sourceName: string;
    scope: string;
    lastOutcome: string;
    lastDetail: string | null;
    consecutiveUnhealthy: number;
    recent: string[];
    lastHealthyAt: Date | null;
    lastSeenAt: Date;
    totalCycles: number;
  }): Promise<void>;
  
  // Quarantine + filter-observability operations
  addQuarantinedHeadline(item: InsertQuarantinedHeadline): Promise<boolean>;
  getQuarantinedHeadlines(limit?: number): Promise<QuarantinedHeadline[]>;
  incrementFilterMetrics(deltas: { financeWeatherRescued?: number; financeWeatherDropped?: number; quarantined?: number }): Promise<void>;
  getFilterMetrics(): Promise<FilterMetrics | undefined>;
  
  // Team chat operations
  getRecentChatMessages(limit: number): Promise<TeamChatMessage[]>;
  addChatMessage(message: InsertTeamChatMessage): Promise<TeamChatMessage>;
  addChatMessageIdempotent(message: InsertTeamChatMessage & { clientRequestId: string }): Promise<{ message: TeamChatMessage; inserted: boolean }>;
  deleteChatMessage(messageId: string): Promise<TeamChatMessage | null>;
  
  // Team subjects operations
  getAllSubjects(): Promise<TeamSubject[]>;
  getSubjectById(id: string): Promise<TeamSubject | undefined>;
  getSubjectByName(name: string): Promise<TeamSubject | undefined>;
  addSubject(subject: InsertTeamSubject): Promise<TeamSubject>;
  updateSubject(id: string, fields: Partial<InsertTeamSubject>): Promise<TeamSubject | undefined>;
  
  // Unified search across all news tables
  unifiedNewsSearch(query: string, limit?: number): Promise<Array<{
    id: string;
    title: string;
    url: string;
    summary: string;
    fullText: string | null;
    source: string;
    sourceTable: 'team_submission' | 'mcop_feed' | 'headline' | 'rss_bot';
    priorityScore: number;
    date: Date;
  }>>;
  getAllNewsForBot(): Promise<Array<{
    id: string;
    title: string;
    url: string;
    summary: string;
    fullText: string | null;
    source: string;
    sourceTable: string;
    sourceType: string;
    priorityScore: number;
    date: Date;
  }>>;

  // Team submissions operations
  getSubmissionsBySubject(subjectId: string): Promise<TeamSubmission[]>;
  getRecentSubmissions(limit: number): Promise<TeamSubmission[]>;
  getAllSubmissionsForNewsBot(): Promise<TeamSubmission[]>;
  getRecentTeamSubmissionsForCurated(hours: number, limit: number): Promise<TeamSubmission[]>;
  getRecentHeadlinesForCurated(hours: number, limit: number): Promise<Headline[]>;
  // Bounded social/flash getters for curated intake (Task #138). Mirror the
  // team-submission bounded getter: time window + capped count, freshest first.
  getRecentXPostsForCurated(hours: number, limit: number): Promise<XPost[]>;
  getRecentTruthSocialPostsForCurated(hours: number, limit: number): Promise<TruthSocialPost[]>;
  getRecentFirstAlertsForCurated(hours: number, limit: number): Promise<FirstAlert[]>;
  getSubmissionByUrl(url: string): Promise<TeamSubmission | undefined>;
  getTeamSubmissionById(id: string): Promise<TeamSubmission | undefined>;
  addSubmission(submission: InsertTeamSubmission): Promise<TeamSubmission>;
  updateSubmissionStatus(id: string, status: string, subjectId?: string): Promise<void>;
  finalizeSubmissionAnalysis(id: string, data: { headline: string; summary: string; sourceType: string; subjectId: string; sourceName?: string; publishedAt?: Date | null; fullText?: string; priorityScore?: number; scoreSource?: string; flashSubjectId?: string | null; cjcsSubjectId?: string | null; mataOsintSubjectId?: string | null; skipAutoMCOP?: boolean; ogImageUrl?: string | null }): Promise<void>;
  getUnscoredFallbackSubmissions(maxRetries: number, windowHours: number, limit: number): Promise<TeamSubmission[]>;
  markScoreRetryFailure(submissionId: string): Promise<void>;
  findOrCreateSubject(name: string, createdBy: string): Promise<TeamSubject>;
  createUserTopic(name: string, createdBy: string): Promise<TeamSubject>;
  getSubjectsWithSubmissions(): Promise<Array<TeamSubject & { submissions: TeamSubmission[] }>>;
  
  // Submission comments
  getCommentsForSubmission(submissionId: string): Promise<TeamSubmissionComment[]>;
  getCommentCountsForSubmissions(submissionIds: string[]): Promise<Record<string, number>>;
  addComment(comment: InsertTeamSubmissionComment): Promise<TeamSubmissionComment>;
  deleteComment(commentId: string): Promise<void>;

  // Submission read tracking
  getUserReadSubmissions(userId: string): Promise<string[]>;
  toggleSubmissionRead(userId: string, submissionId: string): Promise<boolean>;
  getSubjectsWithSubmissionsForUser(userId: string): Promise<Array<TeamSubject & { submissions: (TeamSubmission & { isRead: boolean })[], unreadCount: number, unreadNewsCount: number, unreadSocialCount: number }>>;
  
  // Priority score updates
  updateSubmissionPriority(submissionId: string, priorityScore: number): Promise<TeamSubmission | null>;
  updateSubmissionQuestionable(submissionId: string, isQuestionable: boolean): Promise<void>;
  
  // MCOP submission tracking
  markTeamSubmissionAsMCOP(submissionId: string, userId: string): Promise<void>;
  
  // Active/Archived subjects
  getActiveAndArchivedSubjects(userId: string): Promise<{
    active: Array<TeamSubject & { submissions: (TeamSubmission & { isRead: boolean })[], unreadCount: number, unreadNewsCount: number, unreadSocialCount: number }>,
    archived: Array<TeamSubject & { submissions: (TeamSubmission & { isRead: boolean })[], unreadCount: number, unreadNewsCount: number, unreadSocialCount: number }>
  }>;
  
  // Topic management operations
  reorderSubjects(updates: Array<{ id: string; isActive: boolean; position: number }>): Promise<void>;
  updateSubjectActiveStatus(id: string, isActive: boolean): Promise<TeamSubject | null>;
  archiveExpiredWatchTopics(): Promise<number>;
  // Task #1039: watch-topic detail fields + telemetry
  updateWatchTopicDetail(id: string, fields: {
    name?: string;
    description?: string | null;
    watchTopicLabel?: string | null;
    lifecycleMode?: string;
    boostStrength?: string;
    orKeywords?: string[];
    andKeywords?: string[];
    notKeywords?: string[];
    topicId?: string | null;
    focusArea?: string | null;
    estimatedActiveUntil?: Date | null;
  }): Promise<TeamSubject | null>;
  recordWatchTopicMatch(input: {
    topicId: string;
    baseScore: number;
    boostedScore: number;
    canonicalUrl: string;
    steeringKind: 'priority' | 'bolo' | 'us-implication';
    boostStrength?: string | null;
    intakeMode: 'gate' | 'reuse';
    boloRescueAttempted: boolean;
    boloRescueUsed: boolean;
    boloBudgetBlocked: boolean;
    usImplicationApplied: boolean;
    usImplicationReason?: string | null;
    eventKey: string;
  }): Promise<void>;
  getWatchTopicTelemetryForCanonicalUrls(canonicalUrls: string[], since: Date): Promise<typeof watchTopicTelemetry.$inferSelect[]>;
  getWatchTopicStats(topicId: string): Promise<{ avgMatchesPerDay: number; avgBaseScore: number; currentBoostStrength: string }>;
  pruneWatchTopicTelemetry(olderThanDays?: number): Promise<number>;
  smartDecayExtendIfActive(topicId: string, extensionDays?: number, minMatchesPerDay?: number): Promise<boolean>;
  deleteSubjectWithMode(id: string, mode: 'delete' | 'move'): Promise<{ success: boolean; movedCount?: number }>;
  getActiveSubjects(): Promise<TeamSubject[]>;
  getSmartDecayExpiryCandidates(): Promise<TeamSubject[]>;
  getInactiveSubjects(): Promise<TeamSubject[]>;
  
  // DrudgeBot operations
  isDrudgeBotArticlePosted(articleUrl: string): Promise<boolean>;
  addDrudgeBotPost(post: InsertDrudgeBotPost): Promise<DrudgeBotPost>;
  getRecentDrudgeBotPosts(limit: number): Promise<DrudgeBotPost[]>;
  
  // BBCBot operations
  isBBCBotArticlePosted(articleUrl: string): Promise<boolean>;
  addBBCBotPost(post: InsertBBCBotPost): Promise<BBCBotPost>;
  getRecentBBCBotPosts(limit: number): Promise<BBCBotPost[]>;
  
  // SocialBot operations
  isSocialPostReposted(postId: string, source: string): Promise<boolean>;
  addSocialBotPost(post: InsertSocialBotPost): Promise<SocialBotPost>;
  getTruthSocialPostsSince(since: Date): Promise<TruthSocialPost[]>;
  getXPostsSince(since: Date, sourceAccount?: string): Promise<XPost[]>;
  
  // FoxNewsBot operations
  isFoxNewsBotArticlePosted(articleUrl: string): Promise<boolean>;
  addFoxNewsBotPost(post: InsertFoxNewsBotPost): Promise<FoxNewsBotPost>;
  
  // ABCNewsBot operations
  isABCNewsBotArticlePosted(articleUrl: string): Promise<boolean>;
  addABCNewsBotPost(post: InsertABCNewsBotPost): Promise<ABCNewsBotPost>;
  
  // CBSNewsBot operations
  isCBSNewsBotArticlePosted(articleUrl: string): Promise<boolean>;
  addCBSNewsBotPost(post: InsertCBSNewsBotPost): Promise<CBSNewsBotPost>;
  
  // NBCNewsBot operations
  isNBCNewsBotArticlePosted(articleUrl: string): Promise<boolean>;
  addNBCNewsBotPost(post: InsertNBCNewsBotPost): Promise<NBCNewsBotPost>;
  
  // APNewsBot operations
  isAPNewsBotArticlePosted(articleUrl: string): Promise<boolean>;
  addAPNewsBotPost(post: InsertAPNewsBotPost): Promise<APNewsBotPost>;
  
  // ReutersBot operations
  isReutersBotArticlePosted(articleUrl: string): Promise<boolean>;
  addReutersBotPost(post: InsertReutersBotPost): Promise<ReutersBotPost>;
  
  // RSSBot operations
  isRSSBotArticlePosted(articleUrl: string): Promise<boolean>;
  addRSSBotPost(post: InsertRSSBotPost): Promise<RSSBotPost>;
  isArticlePostedByAnyBot(articleUrl: string): Promise<boolean>;
  
  // Team member operations
  getAllTeamMembers(): Promise<TeamMember[]>;
  getTeamMemberByEmail(email: string): Promise<TeamMember | undefined>;
  addTeamMember(email: string, addedBy: string): Promise<TeamMember>;
  removeTeamMember(id: string): Promise<void>;
  isTeamMember(email: string): Promise<boolean>;

  // Warfighter/Cyber allowed list (separate from team members and curated testers)
  isWarfighterCyberAllowed(email: string): Promise<boolean>;

  // Curated View tester allowlist (separate from team members)
  isCuratedViewTester(email: string): Promise<boolean>;

  // Curated View feedback inbox (CURATED-ONLY)
  createCuratedViewFeedback(item: InsertCuratedViewFeedback): Promise<CuratedViewFeedback>;
  listCuratedViewFeedback(): Promise<CuratedViewFeedback[]>;
  markCuratedViewFeedbackReviewed(id: string, reviewedBy: string): Promise<void>;
  markCuratedViewFeedbackReviewedBulk(ids: string[], reviewedBy: string): Promise<void>;
  unmarkCuratedViewFeedbackReviewed(id: string): Promise<void>;
  deleteCuratedViewFeedback(id: string): Promise<void>;
  deleteCuratedViewFeedbackBulk(ids: string[]): Promise<void>;
  getCuratedViewFeedbackUnreviewedCount(): Promise<number>;
  
  insertArticleQuotes(quotes: InsertArticleQuote[]): Promise<void>;
  searchArticleQuotes(params: { speaker?: string; tag?: string; keyword?: string; fromDate?: string; toDate?: string; limit?: number; offset?: number }): Promise<{ quotes: ArticleQuote[]; total: number }>;
  getQuotesForStory(storyId: string): Promise<ArticleQuote[]>;
  hasQuotesForStory(storyId: string): Promise<boolean>;
  getArticleQuoteStats(): Promise<{ totalQuotes: number; storiesProcessed: number; storiesRemaining: number }>;

  // Custom MCOPs
  listCustomMcops(): Promise<CustomMcop[]>;
  getCustomMcopBySlug(slug: string): Promise<CustomMcop | undefined>;
  getCustomMcopById(id: string): Promise<CustomMcop | undefined>;
  createCustomMcop(data: InsertCustomMcop): Promise<CustomMcop>;
  updateCustomMcop(id: string, fields: Partial<InsertCustomMcop>): Promise<CustomMcop | undefined>;
  setCustomMcopPasswordHash(id: string, hash: string): Promise<void>;
  deleteCustomMcop(id: string): Promise<void>;
  getCustomMcopScores(mcopId: string, sourceType: string, sourceIds: string[]): Promise<Map<string, CustomMcopScore>>;
  getScoredHeadlineIdsForMcop(mcopId: string): Promise<Set<string>>;
  upsertCustomMcopScore(mcopId: string, sourceType: string, sourceId: string, priorityScore: number, isRelevant: boolean, reason?: string | null): Promise<void>;
  // Custom MCOP manual articles
  getCustomMcopArticles(mcopId: string): Promise<CustomMcopArticle[]>;
  getCustomMcopArticleById(id: string): Promise<CustomMcopArticle | undefined>;
  addCustomMcopArticle(article: InsertCustomMcopArticle): Promise<CustomMcopArticle>;
  updateCustomMcopArticle(id: string, updates: Partial<InsertCustomMcopArticle>): Promise<CustomMcopArticle>;
  deleteCustomMcopArticle(id: string): Promise<void>;
  // Custom MCOP manual screenshots
  getCustomMcopScreenshots(mcopId: string): Promise<CustomMcopScreenshot[]>;
  addCustomMcopScreenshot(screenshot: InsertCustomMcopScreenshot): Promise<CustomMcopScreenshot>;
  deleteCustomMcopScreenshot(id: string): Promise<void>;
  // Custom MCOP hidden items (per-MCOP curation by Sadmins)
  getCustomMcopHiddenItems(mcopId: string): Promise<CustomMcopHiddenItem[]>;
  getCustomMcopHiddenKeys(mcopId: string): Promise<Set<string>>;
  addCustomMcopHiddenItem(mcopId: string, sourceType: string, sourceId: string): Promise<void>;
  removeCustomMcopHiddenItem(mcopId: string, sourceType: string, sourceId: string): Promise<void>;
  // Outlet registry (canonical source knowledge — Curated view + Team oversight only)
  getOutletRegistry(): Promise<OutletRegistry[]>;
  getOutletRegistryById(id: string): Promise<OutletRegistry | undefined>;
  applyOutletEnrichment(
    id: string,
    fields: Record<string, unknown>,
    source: string,
    confirmed: boolean,
  ): Promise<{ updatedFields: number; confirmed: boolean }>;
  setOutletManualOverride(
    id: string,
    overrides: Record<string, unknown>,
    user: string,
  ): Promise<OutletRegistry | undefined>;
  setOutletBehaviorOverride(
    id: string,
    behaviorOverride: 'attach' | 'corroborating' | null,
    user: string,
  ): Promise<OutletRegistry | undefined>;
  clearOutletManualOverride(id: string, field: string): Promise<OutletRegistry | undefined>;
  setOutletLogoUrl(id: string, logoUrl: string, user: string): Promise<OutletRegistry | undefined>;

  // Live Broadcast Firing log (curated-only, fire-and-forget)
  insertLiveBroadcastFiring(firing: InsertCuratedLiveBroadcastFiring): Promise<CuratedLiveBroadcastFiring>;
  stampLiveBroadcastFiringEnded(id: string, endedAt: Date): Promise<void>;
  getLiveBroadcastFiringById(id: string): Promise<CuratedLiveBroadcastFiring | undefined>;
  getRecentLiveBroadcastFirings(hours: number, limit?: number): Promise<CuratedLiveBroadcastFiring[]>;
  getLiveBroadcastModeration(eventKey: string): Promise<CuratedLiveBroadcastModeration | undefined>;
  getLiveBroadcastModerations(eventKeys: string[]): Promise<Map<string, CuratedLiveBroadcastModeration>>;
  setLiveBroadcastModeration(eventKey: string, suppressed: boolean, overrides: CuratedLiveBroadcastOverrides, updatedBy: string): Promise<CuratedLiveBroadcastModeration>;

  // Committee hearing tracker (Task #1077). Written only by the hourly
  // hearingTracker poll; read by the curated banner signal + testimony intake.
  upsertCommitteeHearing(hearing: InsertCommitteeHearing): Promise<CommitteeHearing>;
  getCommitteeHearingsInWindow(fromMs: number, toMs: number): Promise<CommitteeHearing[]>;

  // Curated lane — editor-OVERRIDE LEARNING LOG (Task #540). Append-only event
  // log + single-row capture-pause flag. Written by the curated moderation
  // endpoints; read ONLY by the curated-gated override-log endpoint. Never read
  // by any feed path (fail-closed isolation).
  recordCuratedOverrideEvent(event: InsertCuratedOverrideEvent): Promise<string>;
  captureCuratedOverrideEvidenceAtomic(
    event: InsertCuratedOverrideEvent,
    captureEpisode: (eventId: string, transactionStorage: unknown) => Promise<string | null>,
  ): Promise<{ eventId: string; episodeId: string }>;
  attachCuratedOverrideEventReasons(id: string, reasonKeys: string[], reasonNote: string | null): Promise<void>;
  getCuratedOverrideEvents(limit: number): Promise<CuratedOverrideEvent[]>;
  getCuratedOverrideEventsSince(since: Date, max: number): Promise<CuratedOverrideEvent[]>;
  getCuratedOverrideEventsBefore(before: Date, max: number): Promise<CuratedOverrideEvent[]>;
  // Precise snapshot lookup for a clustered/standalone member (covers BOTH
  // `main:<id>` and `curated:<id>` rows surfaced in curated) at action time.
  getCuratedClusterMemberByItem(itemType: string, itemId: string): Promise<CuratedClusterMember | undefined>;
  getCuratedFeedbackSettings(): Promise<CuratedFeedbackSettings>;
  setCuratedCapturePaused(paused: boolean, updatedBy: string): Promise<CuratedFeedbackSettings>;
  resetCuratedOverrideLog(updatedBy: string): Promise<CuratedFeedbackSettings>;

  // Curated lane — editor-feedback LEARNING LOOP (Task #659). Compiled
  // candidate rules (approval queue) + applied/revocable state. Curated-only.
  getCuratedLearnedRules(statuses?: string[]): Promise<CuratedLearnedRule[]>;
  getCuratedLearnedRuleById(id: string): Promise<CuratedLearnedRule | undefined>;
  getCuratedLearnedRuleBySignature(signature: string): Promise<CuratedLearnedRule | undefined>;
  upsertSuggestedCuratedLearnedRule(row: InsertCuratedLearnedRule): Promise<CuratedLearnedRule>;
  decideCuratedLearnedRule(
    id: string,
    updates: Partial<Pick<CuratedLearnedRule, 'status' | 'snoozedUntil' | 'decidedBy' | 'decidedAt' | 'appliedState'>>,
  ): Promise<CuratedLearnedRule | undefined>;

  // Curated lane — EDITORIAL EPISODE + OBSERVATION/OUTCOME model (Task #1180).
  // Additive, curated-only observability built ON TOP OF the immutable
  // curated_override_events log. NEVER alters feeds, human overrides, outlet
  // roles, or training labels. See shared/schema.ts for the full contract.
  // Upsert/collapse an episode around its stable signature (atomic; merges
  // persistence counters + JSON snapshots without ever mutating raw events).
  upsertCuratedEditorialEpisode(
    row: InsertCuratedEditorialEpisode,
    opts?: { collapse?: boolean },
  ): Promise<CuratedEditorialEpisode>;
  // Attach one-or-more IMMUTABLE curated_override_events to an episode BY
  // REFERENCE (idempotent on (episodeId, eventId)); recomputes persistence
  // counters (eventCount / editorCount / first/lastEventAt) from the links.
  attachCuratedEditorialEpisodeEvents(
    episodeId: string,
    events: Array<{ eventId: string; eventAction?: string | null; eventEditor?: string | null; eventAt?: Date | null }>,
  ): Promise<CuratedEditorialEpisode | undefined>;
  getCuratedEditorialEpisodeById(id: string): Promise<CuratedEditorialEpisode | undefined>;
  getCuratedEditorialEpisodeBySignature(signature: string): Promise<CuratedEditorialEpisode | undefined>;
  getCuratedEditorialEpisodeEvents(episodeId: string): Promise<CuratedEditorialEpisodeEvent[]>;
  // List/filter episodes (all filters optional; AND-combined).
  listCuratedEditorialEpisodes(filter?: {
    lifecycle?: string[];
    actionFamily?: string;
    canonicalUrl?: string;
    verified?: boolean;
    ambiguous?: boolean;
    limit?: number;
  }): Promise<CuratedEditorialEpisode[]>;
  // Append/upsert a lifecycle observation. When observationKey is provided the
  // row upserts in place; otherwise it appends. Bumps observationCount.
  appendCuratedEditorialObservation(
    episodeId: string,
    obs: { observationKey?: string | null; kind?: string; note?: string | null; detailJson?: Record<string, unknown> | null; observedBy?: string },
  ): Promise<CuratedEditorialObservation>;
  getCuratedEditorialObservations(episodeId: string): Promise<CuratedEditorialObservation[]>;
  // Update the single authoritative present-tense OUTCOME (and optional
  // lifecycle / lineage) on an episode in place.
  updateCuratedEditorialOutcome(
    episodeId: string,
    updates: Partial<Pick<CuratedEditorialEpisode,
      'outcome' | 'outcomeNote' | 'lifecycle' | 'verified' | 'ambiguous' |
      'contradictsEpisodeId' | 'supersededById' | 'undoneByEventId'>>,
  ): Promise<CuratedEditorialEpisode | undefined>;
  // Frozen legacy learned-rule inventory (read-only observability; inert).
  listCuratedLegacyRuleInventory(disposition?: string): Promise<CuratedLegacyRuleInventory[]>;
  setCuratedLegacyRuleDisposition(
    id: string,
    input: { disposition: 'acknowledge' | 'archive' | 'discard'; dispositionedBy: string; dispositionedAt: Date },
  ): Promise<CuratedLegacyRuleInventory | undefined>;

  // Curated lane — AUTHORITATIVE OUTCOME OBSERVATION after a cluster pass
  // (Task #1180 follow-through). Called immediately after
  // replaceCuratedClusterMembers in FULL authoritative mode: scans ONLY the
  // small set of UNSETTLED + RECENT active editorial episodes (never full
  // retained history), compares each episode's REQUESTED normalized
  // member/story/ranking context against the FINAL kept membership + available
  // priority state, appends an observation keyed by the cluster revision/pass,
  // and updates the authoritative outcome (applied | deferred | conflicted |
  // dormant | superseded | undone | failed) only as DEFENSIBLY OBSERVABLE from
  // the final state — NEVER inferred from the mere presence of an overlay write.
  // Bounded by `cap` + `recentWindowMs` so cost scales with ACTIVE episodes, not
  // history. Fail-soft (returns a zeroed summary on any error) and CURATED-ONLY:
  // never writes a human pin or an outlet role. See impl for the full contract.
  observeCuratedEditorialOutcomesAfterCluster(
    input: {
      clusterRevision: string;
      keptMembers: Array<Pick<CuratedClusterMember, 'clusterId' | 'itemType' | 'itemId' | 'url' | 'priorityScore' | 'isRepresentative'>>;
      mode?: 'full' | 'reshape' | 'immediate';
      latencyMs?: number;
      cap?: number;
      recentWindowMs?: number;
      observedBy?: string;
      actionFamilies?: string[];
    },
  ): Promise<CuratedEditorialOutcomeObservationSummary>;

  // Live spread of RAW AI-assigned main-feed scores (Task #1093 follow-through).
  // Read-only aggregate for the Scoring oversight tab — see impl for semantics.
  getMainScoreSpread(windowDays?: number): Promise<{
    windowDays: number;
    totalScored: number;
    bands: Array<{ min: number; max: number; count: number }>;
    topValues: Array<{ score: number; count: number; sharePct: number }>;
    humanOverrides: number;
    unscoredFallback: number;
    otherScoreSources: number;
    generatedAt: string;
  }>;

  // Curated-intake admission telemetry (Task #950). Per-source, last-write-wins.
  getCuratedIntakeTelemetry(): Promise<CuratedIntakeTelemetry[]>;
  upsertCuratedIntakeTelemetry(rows: Array<{
    sourceName: string;
    lastLabel: string;
    lastRunAt: Date;
    ingested: number;
    dropInvalid: number;
    dropDupUrl: number;
    dropDupBatch: number;
    dropRelevanceRejected: number;
    dropRelevanceFinance: number;
    dropGateUnscored: number;
    dropFuzzyDup: number;
    dropBlocked: number;
    invalidOnlyStreak?: number;
    // Task #1114: items postponed to the next pass (soft-deadline), NOT dropped.
    deferred: number;
  }>): Promise<void>;
  mergeCuratedIntakeFeedStats(feedStats: Map<string, {
    fetched: number;
    kept: number;
    aged: number;
    dupInPass: number;
    // Task #1114: feed-URL fetches that failed this pass + trimmed reason.
    fetchFailures?: number;
    lastFetchError?: string | null;
    // Task #1114: pass-state marker override. Default: kept > 0 (candidates are
    // awaiting admission). Synthetic observability rows must pass false.
    admissionPending?: boolean;
  }>): Promise<void>;

  // Persisted curated gate verdicts (Task #1083). Durable mirror of the
  // in-memory gate-verdict memo cache; curated-lane only.
  loadCuratedGateVerdicts(limit: number): Promise<CuratedGateVerdict[]>;
  saveCuratedGateVerdicts(rows: Array<{ title: string; verdict: unknown; expiresAt: Date }>): Promise<void>;
}

// Generic words dropped before comparing two archived-story headlines, so two
// stories aren't judged "the same" merely for sharing connective tissue. Periods
// and apostrophes are stripped WITHOUT inserting a space first (so "U.S." -> "us"
// matches "US") before this filter runs.
const ARCHIVE_HEADLINE_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'and', 'or', 'amid', 'over',
  'as', 'after', 'before', 'with', 'at', 'by', 'from', 'into', 'is', 'are', 'be',
  'its', 'new', 'amid', 'amidst', 'about', 'than', 'then', 'out', 'up', 'off',
  'near', 'say', 'says', 'said', 'report', 'reports', 'reported', 'latest',
  'breaking', 'update', 'updates', 'live', 'now',
]);

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getAllHeadlines(): Promise<Headline[]> {
    return await db
      .select()
      .from(headlines)
      .orderBy(desc(sql`COALESCE(${headlines.priorityOverride}, ${headlines.priorityScore})`), desc(headlines.scrapedAt));
  }

  async getRecentHeadlines(hours: number): Promise<Headline[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await db
      .select()
      .from(headlines)
      .where(gte(headlines.scrapedAt, cutoff))
      .orderBy(desc(sql`COALESCE(${headlines.priorityOverride}, ${headlines.priorityScore})`), desc(headlines.scrapedAt));
  }

  async addHeadline(insertHeadline: InsertHeadline, normalizedTitle: string): Promise<Headline> {
    // Strip any leading AI audience-framing preamble / heading the model echoed
    // (e.g. "# Key Facts Summary", "# Summary for Senior Leadership") before it
    // is persisted and can reach the Classic/Visual feeds. No-op on clean prose.
    const [headline] = await db
      .insert(headlines)
      .values({
        ...insertHeadline,
        summary: stripBriefingPreamble(insertHeadline.summary),
        normalizedTitle
      })
      .returning();
    return headline;
  }

  async getHeadlineById(id: string): Promise<Headline | undefined> {
    const [headline] = await db
      .select()
      .from(headlines)
      .where(eq(headlines.id, id));
    return headline;
  }

  async getHeadlineByTitle(title: string): Promise<Headline | undefined> {
    const [headline] = await db
      .select()
      .from(headlines)
      .where(eq(headlines.title, title));
    return headline || undefined;
  }

  async getSimilarHeadlines(normalizedTitle: string, hours: number): Promise<Headline[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    // Get all recent headlines and compute similarity in application code
    // This avoids dependency on pg_trgm extension which may not be available in production
    const recentHeadlines = await db
      .select()
      .from(headlines)
      .where(gte(headlines.scrapedAt, cutoff));
    
    // Calculate Levenshtein distance for each headline
    const headlinesWithSimilarity = recentHeadlines.map(headline => ({
      headline,
      similarity: this.calculateSimilarity(headline.normalizedTitle, normalizedTitle)
    }));
    
    // Filter by similarity threshold and sort
    const similar = headlinesWithSimilarity
      .filter(item => item.similarity > 0.85)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
      .map(item => item.headline);
    
    return similar;
  }

  private calculateSimilarity(str1: string, str2: string): number {
    // Calculate similarity using Levenshtein distance
    const distance = this.levenshteinDistance(str1, str2);
    const maxLength = Math.max(str1.length, str2.length);
    if (maxLength === 0) return 1;
    return 1 - (distance / maxLength);
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  async updateHeadline(id: string, updates: Partial<InsertHeadline>, normalizedTitle?: string): Promise<Headline> {
    const updateData: any = { ...updates };
    if (normalizedTitle !== undefined) {
      updateData.normalizedTitle = normalizedTitle;
    }
    const [headline] = await db
      .update(headlines)
      .set(updateData)
      .where(eq(headlines.id, id))
      .returning();
    return headline;
  }

  async clearOldHeadlines(hours: number): Promise<void> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    await db
      .delete(headlines)
      .where(lt(headlines.scrapedAt, cutoff));
  }

  async clearAllHeadlines(): Promise<void> {
    await db.delete(headlines);
  }

  // ---------------------------------------------------------------------------
  // Curated lane (Task #89) — SEPARATE store. These methods touch ONLY the
  // curated_items / curated_cluster_members tables. They are never called from
  // getPrimaryFeed, the public REST API, custom MCOPs, or Classic/Visual, so
  // curated-only content cannot leak into the main app (fail-closed).
  // ---------------------------------------------------------------------------
  async addCuratedItem(insertItem: InsertCuratedItem, normalizedTitle: string): Promise<CuratedItem> {
    // Write-time audience-leak guard. Curated summaries are copied from a source
    // candidate (a headline / manual / team submission), so a leaked
    // "# Summary for <audience>" heading the model echoed upstream can ride
    // along into the curated lane even after the source row is healed. Strip it
    // at the single curated insert chokepoint so the curated card never shows
    // the artifact. No-op on clean summaries; null/undefined passes through.
    const safeSummary = insertItem.summary == null
      ? insertItem.summary
      : stripBriefingPreamble(insertItem.summary);
    const [item] = await db
      .insert(curatedItems)
      .values({ ...insertItem, summary: safeSummary, normalizedTitle })
      .onConflictDoNothing({ target: curatedItems.url })
      .returning();
    if (item) return item;
    // URL already present — return the existing row so callers can dedupe.
    const existing = await this.getCuratedItemByUrl(insertItem.url);
    return existing!;
  }

  async getCuratedStoreItems(hours: number): Promise<CuratedItem[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    // Task #631 pattern: anchor the window to the DISPLAYED age — the article's
    // own published date falling back to first-seen scrapedAt — matching the
    // same anchor the standalone age-out gate uses. Without this, items whose
    // scrapedAt is slightly outside the window but whose articlePublishedAt was
    // recently updated (e.g. re-published / RSS date-bumped articles) are
    // excluded from the pool even though they would pass the age-out gate and
    // are legitimately fresh from the reader's perspective.
    const effectiveDate = sql`COALESCE(${curatedItems.articlePublishedAt}, ${curatedItems.scrapedAt})`;
    return await db
      .select()
      .from(curatedItems)
      .where(gte(effectiveDate, cutoff))
      .orderBy(desc(curatedItems.priorityScore), desc(effectiveDate));
  }

  async getRecentAPCuratedItems(
    hours: number,
    limit: number,
  ): Promise<Pick<CuratedItem, 'id' | 'url' | 'title'>[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return db
      .select({
        id: curatedItems.id,
        url: curatedItems.url,
        title: curatedItems.title,
      })
      .from(curatedItems)
      .where(and(
        gte(curatedItems.scrapedAt, cutoff),
        inArray(curatedItems.source, ['AP News', 'Associated Press']),
      ))
      .orderBy(desc(curatedItems.scrapedAt))
      .limit(Math.max(1, Math.min(limit, 100)));
  }

  async repairAPCuratedTitleByUrl(
    url: string,
    title: string,
    normalizedTitle: string,
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const affectedClusters = await tx
        .selectDistinct({ signature: curatedClusterMembers.clusterId })
        .from(curatedClusterMembers)
        .where(and(
          eq(curatedClusterMembers.url, url),
          inArray(curatedClusterMembers.source, ['AP News', 'Associated Press']),
        ));

      const updated = await tx
        .update(curatedItems)
        .set({ title, normalizedTitle })
        .where(and(
          eq(curatedItems.url, url),
          inArray(curatedItems.source, ['AP News', 'Associated Press']),
          ne(curatedItems.title, title),
        ))
        .returning({ id: curatedItems.id });
      if (updated.length === 0) return false;

      // Keep the current detail-card snapshot coherent until the next clustering
      // pass rebuilds members from the repaired raw row.
      await tx
        .update(curatedClusterMembers)
        .set({ title })
        .where(and(
          eq(curatedClusterMembers.url, url),
          inArray(curatedClusterMembers.source, ['AP News', 'Associated Press']),
        ));

      // Story signatures are member-identity based, so a corrected member title
      // would otherwise keep reusing synthesis generated from the corrupt text.
      // Delete only synthesis rows for currently affected clusters; the next
      // clustering pass regenerates them from the repaired member snapshot.
      const signatures = affectedClusters.map((row) => row.signature);
      if (signatures.length > 0) {
        await tx
          .delete(curatedStorySynthesis)
          .where(inArray(curatedStorySynthesis.signature, signatures));
      }

      // A title correction changes the article's semantic input. Release only
      // machine-generated labels so the classifier can regenerate them; human
      // editorial classifications stay protected.
      await tx
        .update(curatedClassifications)
        .set({
          region: null,
          country: null,
          primaryTopic: null,
          scope: null,
          conflictTrack: null,
          countryPair: null,
          classifiedAt: new Date(),
        })
        .where(and(
          eq(curatedClassifications.url, url),
          eq(curatedClassifications.provenance, 'ai'),
        ));
      return true;
    });
  }

  // Lean variant of getCuratedStoreItems for the State-Controlled Narratives
  // lens — selects ONLY the columns that lens uses (it never touches the heavy
  // `content` body / attributedClaims), so a wide 36h window is a small transfer
  // instead of multiple MB on the request path. Same filter/order as the full
  // read. CURATED-LANE ONLY.
  //
  // Task #631: the window is anchored to the DISPLAYED age (published date,
  // falling back to first-seen scrapedAt when published is null/unparseable) —
  // the same anchor `calculateDepreciatedPriority` uses for decay — so an
  // item's shown "Xh/Xd ago" and its inclusion in the window always agree.
  // Previously this filtered on scrapedAt (first-seen) alone, which could keep
  // an old-published/recently-relisted row in while excluding a freshly
  // published row whose row was first seen just outside the window.
  async getCuratedStoreItemsForNarratives(hours: number): Promise<Pick<CuratedItem, 'id' | 'title' | 'source' | 'url' | 'category' | 'priorityScore' | 'articlePublishedAt' | 'scrapedAt' | 'contentKind' | 'summary' | 'summaryBullets' | 'linkDeadAt'>[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const effectiveDate = sql`COALESCE(${curatedItems.articlePublishedAt}, ${curatedItems.scrapedAt})`;
    return await db
      .select({
        id: curatedItems.id,
        title: curatedItems.title,
        source: curatedItems.source,
        url: curatedItems.url,
        category: curatedItems.category,
        priorityScore: curatedItems.priorityScore,
        articlePublishedAt: curatedItems.articlePublishedAt,
        scrapedAt: curatedItems.scrapedAt,
        contentKind: curatedItems.contentKind,
        summary: curatedItems.summary,
        summaryBullets: curatedItems.summaryBullets,
        linkDeadAt: curatedItems.linkDeadAt,
      })
      .from(curatedItems)
      .where(gte(effectiveDate, cutoff))
      .orderBy(desc(curatedItems.priorityScore), desc(effectiveDate));
  }

  // Lean projection for the learned-rule compiler's impact preview (Task #887).
  // Returns EVERY curated item in the window (same displayed-age anchor as the
  // other curated-store reads) with only the columns impact math needs — so the
  // compiler can count the true outlet×category blast radius without shipping
  // article bodies. CURATED-LANE ONLY.
  async getCuratedItemsForImpactPreview(hours: number): Promise<Pick<CuratedItem, 'url' | 'title' | 'source' | 'category' | 'priorityScore'>[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const effectiveDate = sql`COALESCE(${curatedItems.articlePublishedAt}, ${curatedItems.scrapedAt})`;
    return await db
      .select({
        url: curatedItems.url,
        title: curatedItems.title,
        source: curatedItems.source,
        category: curatedItems.category,
        priorityScore: curatedItems.priorityScore,
      })
      .from(curatedItems)
      .where(gte(effectiveDate, cutoff));
  }

  async getCuratedItemsForStateMedia(max: number): Promise<Pick<CuratedItem, 'id' | 'title' | 'source' | 'url' | 'priorityScore' | 'articlePublishedAt' | 'scrapedAt' | 'contentKind' | 'summary' | 'summaryBullets'>[]> {
    return await db
      .select({
        id: curatedItems.id,
        title: curatedItems.title,
        source: curatedItems.source,
        url: curatedItems.url,
        priorityScore: curatedItems.priorityScore,
        articlePublishedAt: curatedItems.articlePublishedAt,
        scrapedAt: curatedItems.scrapedAt,
        contentKind: curatedItems.contentKind,
        summary: curatedItems.summary,
        summaryBullets: curatedItems.summaryBullets,
      })
      .from(curatedItems)
      .orderBy(desc(curatedItems.scrapedAt))
      .limit(max);
  }

  async getCuratedItemByUrl(url: string): Promise<CuratedItem | undefined> {
    const [item] = await db
      .select()
      .from(curatedItems)
      .where(eq(curatedItems.url, url));
    return item || undefined;
  }

  // Targeted evidence hydration for the editor's existing manual-link review.
  // Reads only the selected URL set across the same current Curated inputs and
  // member snapshots; it never scans whole feed windows and never writes.
  async getCuratedLinkReviewEvidence(urls: string[]): Promise<CuratedLinkReviewEvidence[]> {
    const exactUrls = Array.from(new Set(urls.filter(Boolean)));
    if (exactUrls.length === 0) return [];
    const [curatedRows, headlineRows, manualRows, memberRows] = await Promise.all([
      db.select({
        title: curatedItems.title,
        source: curatedItems.source,
        url: curatedItems.url,
        articlePublishedAt: curatedItems.articlePublishedAt,
        scrapedAt: curatedItems.scrapedAt,
        role: curatedItems.role,
        summary: curatedItems.summary,
        summaryBullets: curatedItems.summaryBullets,
      }).from(curatedItems).where(inArray(curatedItems.url, exactUrls)),
      db.select({
        title: headlines.title,
        source: headlines.source,
        url: headlines.url,
        articlePublishedAt: headlines.articlePublishedAt,
        scrapedAt: headlines.scrapedAt,
        summary: headlines.summary,
        summaryBullets: headlines.summaryBullets,
      }).from(headlines).where(inArray(headlines.url, exactUrls)),
      db.select({
        title: manualSubmissions.title,
        source: manualSubmissions.source,
        url: manualSubmissions.url,
        articlePublishedAt: manualSubmissions.articlePublishedAt,
        scrapedAt: manualSubmissions.submittedAt,
        summary: manualSubmissions.summary,
        summaryBullets: manualSubmissions.summaryBullets,
      }).from(manualSubmissions).where(inArray(manualSubmissions.url, exactUrls)),
      db.select({
        title: curatedClusterMembers.title,
        source: curatedClusterMembers.source,
        url: curatedClusterMembers.url,
        publishedAt: curatedClusterMembers.publishedAt,
        role: curatedClusterMembers.role,
        summary: curatedClusterMembers.summary,
      }).from(curatedClusterMembers).where(inArray(curatedClusterMembers.url, exactUrls)),
    ]);
    return [...curatedRows, ...headlineRows, ...manualRows, ...memberRows];
  }

  // Batched existing-URL presence check (Task: read-path starvation fix). The
  // curated ingest dedup used to issue one getCuratedItemByUrl round trip PER
  // candidate (up to ~1,300/pass), which added tens of seconds of sequential DB
  // awaits to a pass and helped push it past budget. This returns just the set
  // of URLs already in the store in one chunked IN-query. Curated-lane only.
  async getExistingCuratedUrls(urls: string[]): Promise<Set<string>> {
    const present = new Set<string>();
    if (urls.length === 0) return present;
    const CHUNK = 500;
    for (let i = 0; i < urls.length; i += CHUNK) {
      const slice = urls.slice(i, i + CHUNK);
      const rows = await db
        .select({ url: curatedItems.url })
        .from(curatedItems)
        .where(inArray(curatedItems.url, slice));
      for (const r of rows) present.add(r.url);
    }
    return present;
  }

  async updateCuratedItemPriorityScore(id: string, score: number): Promise<void> {
    await db
      .update(curatedItems)
      .set({ priorityScore: score })
      .where(eq(curatedItems.id, id));
  }

  async getCuratedItemsByIds(ids: string[]): Promise<Map<string, CuratedItem>> {
    const map = new Map<string, CuratedItem>();
    if (ids.length === 0) return map;
    const rows = await db
      .select()
      .from(curatedItems)
      .where(inArray(curatedItems.id, ids));
    for (const row of rows) map.set(row.id, row);
    return map;
  }

  async getSimilarCuratedItems(normalizedTitle: string, hours: number): Promise<CuratedItem[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const recent = await db
      .select()
      .from(curatedItems)
      .where(gte(curatedItems.scrapedAt, cutoff));
    return recent
      .map(item => ({ item, similarity: this.calculateSimilarity(item.normalizedTitle, normalizedTitle) }))
      .filter(x => x.similarity > 0.85)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
      .map(x => x.item);
  }

  // Unbounded same-outlet similarity pass (Task #708). No top-N cap: every
  // stored item from this source that clears the 0.85 bar is returned so a
  // re-emit at a different URL cannot be crowded out of the dedup window by a
  // busy event with many near-identical headlines from other outlets.
  //
  // Task #718: the caller scopes `hours` to a tight re-emit window (12h) rather
  // than the full 48h store window. A same-outlet re-publish via another
  // feed/section is near-instantaneous (minutes-to-an-hour), so the shorter
  // window keeps a high-volume outlet (Reuters, AP) from dragging its entire day
  // of rows into memory on every ingest. The blank-source guard already
  // short-circuits when the candidate has no resolvable outlet.
  async getSimilarCuratedItemsForOutlet(source: string, normalizedTitle: string, hours: number): Promise<CuratedItem[]> {
    if (!source) return [];
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const recent = await db
      .select()
      .from(curatedItems)
      .where(and(gte(curatedItems.scrapedAt, cutoff), eq(curatedItems.source, source)));
    return recent.filter(
      item => this.calculateSimilarity(item.normalizedTitle, normalizedTitle) > 0.85,
    );
  }

  async clearOldCuratedItems(hours: number): Promise<void> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    await db.delete(curatedItems).where(lt(curatedItems.scrapedAt, cutoff));
  }

  // Batched dedup corpus (Task #1105): lean projection only — never the wide
  // row (summary/bullets/claims would ship megabytes over the serverless
  // driver for a whole 48h window).
  async getCuratedDedupCorpus(hours: number): Promise<Array<{ url: string; source: string; normalizedTitle: string; scrapedAt: Date }>> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return db
      .select({
        url: curatedItems.url,
        source: curatedItems.source,
        normalizedTitle: curatedItems.normalizedTitle,
        scrapedAt: curatedItems.scrapedAt,
      })
      .from(curatedItems)
      .where(gte(curatedItems.scrapedAt, cutoff));
  }

  // One-time, idempotent backfill (Task #313). Rewrites the stored `source` of
  // existing curated_items rows to the registry CANONICAL outlet name, mirroring
  // the ingest-time canonicalization added in Task #310 so historical rows with
  // pre-fix raw names ("Cnbc" vs "CNBC") collapse to one outlet for per-outlet
  // counts + clustering corroboration. The resolver is the SAME findOutlet path
  // ingest uses; it returns the canonical name when the outlet resolves, else
  // null (unregistered outlets are left untouched). Already-canonical rows skip
  // (no-op on rerun). Curated-lane only — touches ONLY curated_items.
  async normalizeCuratedItemSources(
    resolveCanonical: (source: string, url: string) => string | null,
  ): Promise<number> {
    const rows = await db
      .select({ id: curatedItems.id, source: curatedItems.source, url: curatedItems.url })
      .from(curatedItems);
    // Group the ids that need rewriting by their target canonical name so we can
    // batch updates (one UPDATE per canonical, chunked under the bind-param cap).
    const byCanonical = new Map<string, string[]>();
    for (const row of rows) {
      const canonical = resolveCanonical(row.source, row.url);
      if (!canonical || canonical === row.source) continue; // unregistered / already canonical
      const list = byCanonical.get(canonical) ?? [];
      list.push(row.id);
      byCanonical.set(canonical, list);
    }
    let updated = 0;
    const CHUNK = 500;
    for (const [canonical, ids] of Array.from(byCanonical.entries())) {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        await db
          .update(curatedItems)
          .set({ source: canonical })
          .where(inArray(curatedItems.id, slice));
        updated += slice.length;
      }
    }
    return updated;
  }

  // Content-based classification overlay (keyed by article URL). Read ONLY by the
  // curated route + its background backfill — never by any shared feed.
  async getCuratedClassificationsByUrls(urls: string[]): Promise<Map<string, CuratedClassification>> {
    const map = new Map<string, CuratedClassification>();
    if (urls.length === 0) return map;
    // URL identity normalization (Task #927): the overlay is keyed by the shared
    // canonical identity URL (normalizeIdentityUrl) so cosmetic variants of the
    // SAME article (trailing slash, tracking query, fragment, casing) resolve to
    // ONE row — the same collapse clustering already does. Query by the canonical
    // key but return the map keyed by each caller's ORIGINAL url so every existing
    // `.get(rawUrl)` lookup keeps working unchanged. Curated-lane only.
    const normByOriginal = new Map<string, string>();
    const normSet = new Set<string>();
    for (const u of urls) {
      const n = normalizeIdentityUrl(u);
      normByOriginal.set(u, n);
      if (n) normSet.add(n);
    }
    const normList = Array.from(normSet);
    const rowsByNorm = new Map<string, CuratedClassification>();
    // Chunk the IN-list so very large windows don't blow the bind-param limit.
    const CHUNK = 500;
    for (let i = 0; i < normList.length; i += CHUNK) {
      const slice = normList.slice(i, i + CHUNK);
      const rows = await db
        .select()
        .from(curatedClassifications)
        .where(inArray(curatedClassifications.url, slice));
      for (const r of rows) rowsByNorm.set(r.url, r);
    }
    for (const [orig, n] of Array.from(normByOriginal.entries())) {
      const row = n ? rowsByNorm.get(n) : undefined;
      if (row) map.set(orig, row);
    }
    return map;
  }

  async upsertCuratedClassifications(rows: InsertCuratedClassification[], opts?: { onlyIfAi?: boolean }): Promise<void> {
    if (rows.length === 0) return;
    for (const raw of rows) {
      // `category` is NOT NULL — coalesce defensively so a caller that only sets
      // the structured object (no specific label) can never trip the constraint.
      let row = { ...raw, category: raw.category ?? 'general' };
      // Keep the caller's ORIGINAL url for the curated_items lookup below (that
      // table stores raw URLs), but persist the overlay under the canonical
      // identity key (Task #927) so trailing-slash / tracking-query / fragment /
      // casing variants of the SAME article collapse to ONE overlay row and can
      // never split a Topic label or a human override. Curated-lane only.
      const rawUrl = row.url;
      const canonicalUrl = normalizeIdentityUrl(row.url);
      if (canonicalUrl && canonicalUrl !== row.url) {
        row = { ...row, url: canonicalUrl };
      }
      // Region hygiene (write-time chokepoint): the model sometimes duplicates
      // the COUNTRY into the region field (region="United Kingdom",
      // country="United Kingdom"), corrupting region's area-of-impact
      // semantics. coerceRegionField canonicalizes vocab spellings and nulls
      // that corruption class ONLY — off-list broad labels ("Asia") are
      // preserved. Never touches a human-authored row (generate-once lock).
      if (row.provenance !== 'human') {
        const cleanedRegion = coerceRegionField(row.region ?? null, row.country ?? null);
        if (cleanedRegion !== (row.region ?? null)) {
          row = { ...row, region: cleanedRegion };
        }
      }
      // Editor-feedback LEARNING LOOP (Task #659) classification-relabel
      // enforcement RETIRED (Task #1180). Legacy aggregate learned
      // outlet+fromTopic->toTopic relabel rules are no longer enforced, so an
      // AI-authored label is written as-is. Direct human overlays
      // (provenance='human') and outlet roles are unaffected.
      await db
        .insert(curatedClassifications)
        .values(row)
        .onConflictDoUpdate({
          target: curatedClassifications.url,
          set: {
            category: row.category,
            region: row.region ?? null,
            country: row.country ?? null,
            // Structured classification enrichment object (Task #336). Persisted
            // alongside the legacy fields so all curated readers share one source
            // of truth.
            primaryTopic: row.primaryTopic ?? null,
            scope: row.scope ?? null,
            conflictTrack: row.conflictTrack ?? null,
            countryPair: row.countryPair ?? null,
            legacyCategory: row.legacyCategory ?? null,
            proposedTopic: row.proposedTopic ?? null,
            // Provenance of the new label (Task #350): AI writers stamp 'ai',
            // the reviewer override stamps 'human'. A null incoming value leaves
            // the row unprotected only if it was already null — existing 'human'
            // rows are never re-upserted by the AI path (generate-once lock), so
            // a human override can't be silently demoted here.
            provenance: row.provenance ?? null,
            classifiedAt: new Date(),
            // A (re)classification produces a FRESH label, so any accumulated
            // cluster-disagreement count is stale — reset it (the cooldown anchor
            // recheckLastAt is left intact so a just-cleared row can't thrash).
            recheckDisagreeCount: 0,
          },
          // onlyIfAi (Task #350): the bounded re-check force-reclassify must NEVER
          // clobber a human override that lands AFTER the guarded clear but DURING
          // the (multi-second) AI call. Guarding the DO-UPDATE on the STORED row
          // still being provenance='ai' makes the protection atomic — if a human
          // override flipped the row to 'human' in that window, this update is a
          // no-op and the human label survives.
          ...(opts?.onlyIfAi
            ? { setWhere: eq(curatedClassifications.provenance, 'ai') }
            : {}),
        });
    }
  }

  // Persist the bounded re-check's per-row disagreement counters (Task #350).
  // Groups updates by their target count so a single UPDATE covers each value,
  // and HARD-GUARDS on provenance='ai' so a human-overridden bucket can never
  // have its counter touched. CURATED-LANE only.
  async setCuratedRecheckDisagreeCounts(updates: Array<{ url: string; count: number }>): Promise<void> {
    if (updates.length === 0) return;
    const byCount = new Map<number, string[]>();
    for (const u of updates) {
      // Match on the canonical overlay key (Task #927) so a URL variant still
      // resolves to the single merged row.
      const key = normalizeIdentityUrl(u.url);
      if (!key) continue;
      const list = byCount.get(u.count) ?? [];
      list.push(key);
      byCount.set(u.count, list);
    }
    const CHUNK = 500;
    for (const [count, urls] of Array.from(byCount.entries())) {
      for (let i = 0; i < urls.length; i += CHUNK) {
        const slice = urls.slice(i, i + CHUNK);
        await db
          .update(curatedClassifications)
          .set({ recheckDisagreeCount: count })
          .where(and(
            inArray(curatedClassifications.url, slice),
            eq(curatedClassifications.provenance, 'ai'),
          ));
      }
    }
  }

  // Clear an AI-generated label so the cron re-sharpens it (Task #350). Nulls the
  // primary_topic and resets the legacy category to the generic bucket (so the
  // GENERATE-ONCE lock re-opens), stamps recheck_last_at = now as a COOLDOWN
  // anchor, resets the disagreement counter, and ages classified_at so the row is
  // immediately eligible for re-classification. HARD-GUARDED on provenance='ai'
  // so a human override is NEVER cleared. Returns the URLs it actually cleared, so
  // the caller force-reclassifies ONLY those (a row that flipped to 'human' before
  // the clear is excluded and never re-stamped as AI). CURATED-LANE only.
  async clearCuratedAiClassifications(urls: string[], staleAt: Date): Promise<string[]> {
    if (urls.length === 0) return [];
    // Match on the canonical overlay key (Task #927); map each canonical key back
    // to the caller's ORIGINAL url(s) so the returned "cleared" list is in the
    // caller's own key space (the caller filters its input by this set).
    const rawByNorm = new Map<string, string[]>();
    for (const u of urls) {
      const n = normalizeIdentityUrl(u);
      if (!n) continue;
      const list = rawByNorm.get(n) ?? [];
      list.push(u);
      rawByNorm.set(n, list);
    }
    const normList = Array.from(rawByNorm.keys());
    const cleared: string[] = [];
    const CHUNK = 500;
    for (let i = 0; i < normList.length; i += CHUNK) {
      const slice = normList.slice(i, i + CHUNK);
      const updated = await db
        .update(curatedClassifications)
        .set({
          primaryTopic: null,
          category: 'general',
          recheckDisagreeCount: 0,
          recheckLastAt: new Date(),
          classifiedAt: staleAt,
        })
        .where(and(
          inArray(curatedClassifications.url, slice),
          eq(curatedClassifications.provenance, 'ai'),
        ))
        .returning({ url: curatedClassifications.url });
      for (const row of updated) {
        for (const orig of rawByNorm.get(row.url) ?? []) cleared.push(orig);
      }
    }
    return cleared;
  }

  // Human-gated topic proposals log (Task #336). Records (or bumps the count of)
  // an off-list topic/track the curated generator could not place. Never adopts a
  // live label — a human reviews `status` before any code change. CURATED-ONLY.
  async recordClassificationProposal(p: {
    kind?: string;
    proposedLabel: string;
    sampleTitle?: string | null;
    rationale?: string | null;
  }): Promise<void> {
    const label = (p.proposedLabel || '').trim();
    if (!label) return;
    const kind = p.kind || 'primary_topic';
    await db
      .insert(classificationTopicProposals)
      .values({
        kind,
        proposedLabel: label,
        sampleTitle: p.sampleTitle ?? null,
        rationale: p.rationale ?? null,
      })
      .onConflictDoUpdate({
        target: [classificationTopicProposals.kind, classificationTopicProposals.proposedLabel],
        set: {
          occurrences: sql`${classificationTopicProposals.occurrences} + 1`,
          lastProposedAt: new Date(),
        },
      });
  }

  async getClassificationProposals(): Promise<ClassificationTopicProposal[]> {
    return await db
      .select()
      .from(classificationTopicProposals)
      .orderBy(desc(classificationTopicProposals.occurrences));
  }

  async getCatchAllTopicClusters(
    hours: number,
    limit: number,
  ): Promise<Array<{ category: string; count: number; firstSeen: Date; lastSeen: Date; sampleTitles: string[] }>> {
    const result = await db.execute(sql`
      SELECT
        COALESCE(NULLIF(TRIM(cc.legacy_category), ''), cc.category) AS category,
        COUNT(*)::int AS count,
        MIN(cc.classified_at) AS first_seen,
        MAX(cc.classified_at) AS last_seen,
        (ARRAY_AGG(ci.title ORDER BY cc.classified_at DESC)
          FILTER (WHERE ci.title IS NOT NULL))[1:3] AS sample_titles
      FROM curated_classifications cc
      LEFT JOIN curated_items ci ON ci.url = cc.url
      WHERE cc.primary_topic = ${OTHER_EMERGING}
        AND cc.classified_at >= NOW() - (INTERVAL '1 hour' * ${hours})
      GROUP BY 1
      ORDER BY count DESC, last_seen DESC
      LIMIT ${limit}
    `);
    return (result.rows as any[]).map((r) => ({
      category: String(r.category ?? 'Other / Emerging'),
      count: Number(r.count ?? 0),
      firstSeen: r.first_seen ? new Date(r.first_seen) : new Date(0),
      lastSeen: r.last_seen ? new Date(r.last_seen) : new Date(0),
      sampleTitles: Array.isArray(r.sample_titles) ? (r.sample_titles as string[]).filter(Boolean) : [],
    }));
  }

  async replaceCuratedClusterMembers(
    members: Array<Omit<CuratedClusterMember, 'id' | 'createdAt'>>,
  ): Promise<void> {
    // Recompute-each-run semantics: wipe the mapping, then re-insert the freshly
    // computed membership. This NEVER touches headlines.cluster_id.
    //
    // Wrapped in a transaction so the table is never observable EMPTY: the old
    // non-transactional delete-then-chunked-insert left a window where a
    // concurrent /cluster-members read (or its 30s cache) could capture zero
    // members for an existing cluster and serve a single-source fallback.
    const CHUNK = 500;
    await db.transaction(async (tx) => {
      await tx.delete(curatedClusterMembers);
      for (let i = 0; i < members.length; i += CHUNK) {
        await tx.insert(curatedClusterMembers).values(members.slice(i, i + CHUNK));
      }
    });
  }

  async appendCuratedClusterMemberIfAbsent(
    member: Omit<CuratedClusterMember, 'id' | 'createdAt'>,
  ): Promise<boolean> {
    // Incremental attach bridge (Task #439). Folds ONE freshly-arrived standalone
    // item into an existing curated cluster between full clustering passes, so a
    // single-source card that clearly belongs to a formed story doesn't sit alone
    // for up to ~5 min until the next wipe-and-rebuild pass reconciles it.
    //
    // Idempotent: an item already mapped to ANY cluster (by item_type+item_id) is
    // never double-inserted. createdAt defaults to now(), so getCuratedClusterMembers
    // (windowed by createdAt) immediately folds the appended row into the read path.
    // The next full replaceCuratedClusterMembers pass wipes the table and re-derives
    // membership authoritatively, so this row is at most ~5 min ahead of that pass.
    //
    // CURATED-LANE ONLY: writes ONLY curated_cluster_members — NEVER
    // headlines.cluster_id (which feeds Classic/Visual) or any shared feed table.
    const existing = await db
      .select({ id: curatedClusterMembers.id })
      .from(curatedClusterMembers)
      .where(
        and(
          eq(curatedClusterMembers.itemType, member.itemType),
          eq(curatedClusterMembers.itemId, member.itemId),
        ),
      )
      .limit(1);
    if (existing.length > 0) return false;
    await db.insert(curatedClusterMembers).values(member);
    return true;
  }

  async getCuratedClusterMembers(hours?: number): Promise<CuratedClusterMember[]> {
    if (hours == null) {
      return await db.select().from(curatedClusterMembers);
    }
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await db
      .select()
      .from(curatedClusterMembers)
      .where(gte(curatedClusterMembers.createdAt, cutoff));
  }

  async getCuratedClusterMembersByClusterId(clusterId: string): Promise<CuratedClusterMember[]> {
    return await db
      .select()
      .from(curatedClusterMembers)
      .where(eq(curatedClusterMembers.clusterId, clusterId));
  }

  // Cross-pass member-confirmation hysteresis (Task #645). See IStorage for the
  // full contract. Side table survives the per-pass wipe of
  // curated_cluster_members, so a volatile (provisional) member's streak
  // persists across the full-pass rewrite that would otherwise erase it.
  async bumpCuratedMemberConfirmation(clusterId: string, itemType: string, itemId: string): Promise<number> {
    const key = `${clusterId}:${itemType}:${itemId}`;
    const [row] = await db
      .insert(curatedMemberConfirmations)
      .values({ key, clusterId, itemType, itemId, streak: 1, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: curatedMemberConfirmations.key,
        set: {
          streak: sql`${curatedMemberConfirmations.streak} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ streak: curatedMemberConfirmations.streak });
    return row?.streak ?? 1;
  }

  async pruneCuratedMemberConfirmations(activeKeys: string[]): Promise<void> {
    if (activeKeys.length === 0) {
      await db.delete(curatedMemberConfirmations);
      return;
    }
    await db
      .delete(curatedMemberConfirmations)
      .where(notInArray(curatedMemberConfirmations.key, activeKeys));
  }

  // ---------------------------------------------------------------------------
  // Curated lane (Task #90) — story synthesis cache. Keyed by content signature
  // (NOT cluster id) so it survives the per-pass cluster-id regeneration in
  // replaceCuratedClusterMembers. Read ONLY by curated-gated endpoints.
  // ---------------------------------------------------------------------------
  async getCuratedStorySynthesisMap(): Promise<Map<string, CuratedStorySynthesis>> {
    const rows = await db.select().from(curatedStorySynthesis);
    return new Map(rows.map((r) => [r.signature, r]));
  }

  async getCuratedStorySynthesisBySignature(signature: string): Promise<CuratedStorySynthesis | undefined> {
    const [row] = await db
      .select()
      .from(curatedStorySynthesis)
      .where(eq(curatedStorySynthesis.signature, signature));
    return row || undefined;
  }

  async upsertCuratedStorySynthesis(row: {
    signature: string;
    headline: string;
    lede: string;
    facts: string[];
    spins: Record<string, string>;
    alignments: Record<string, { align: string[]; diverge: string[]; pct?: number }>;
    attributedClaims?: string[];
    contentHash?: string;
    corroborated?: boolean | null;
    synthesizedThrough?: Date | null;
  }): Promise<void> {
    await db
      .insert(curatedStorySynthesis)
      .values({ ...row, attributedClaims: row.attributedClaims ?? [], contentHash: row.contentHash ?? null, corroborated: row.corroborated ?? null, synthesizedThrough: row.synthesizedThrough ?? null, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: curatedStorySynthesis.signature,
        set: {
          headline: row.headline,
          lede: row.lede,
          facts: row.facts,
          spins: row.spins,
          alignments: row.alignments,
          attributedClaims: row.attributedClaims ?? [],
          contentHash: row.contentHash ?? null,
          corroborated: row.corroborated ?? null,
          // Only advance the synthesized-through marker when the caller supplies
          // one (a real re-synthesis). Passing undefined leaves the prior value.
          ...(row.synthesizedThrough !== undefined ? { synthesizedThrough: row.synthesizedThrough } : {}),
          updatedAt: new Date(),
        },
      });
  }

  async pruneCuratedStorySynthesisNotIn(signatures: string[]): Promise<void> {
    // Grace window (headline-stability fix): the same-event consolidation lane's
    // pass-to-pass oscillation can flip a story's member set (and therefore its
    // signature) A -> B -> A across consecutive passes. An immediate hard delete
    // of "not in this pass" rows meant the flip-BACK always re-synthesized from
    // scratch — a fresh LLM headline roll every ~10 min that let editorialized
    // wording land and display. Keeping recently-touched rows for a short grace
    // lets a signature flip-back find its cached row (full reuse when the member
    // set flipped back exactly — zero LLM call) and keeps the prior headline
    // available as the continuity anchor. Rows in active use are never pruned
    // regardless of age; the table is tiny (~40 rows) so growth stays bounded.
    const cutoff = new Date(Date.now() - CURATED_SYNTHESIS_PRUNE_GRACE_MS);
    if (signatures.length === 0) {
      await db.delete(curatedStorySynthesis).where(lt(curatedStorySynthesis.updatedAt, cutoff));
      return;
    }
    await db
      .delete(curatedStorySynthesis)
      .where(
        and(
          notInArray(curatedStorySynthesis.signature, signatures),
          lt(curatedStorySynthesis.updatedAt, cutoff),
        ),
      );
  }

  async bustCuratedStorySynthesisContentHash(signatures: string[]): Promise<void> {
    if (signatures.length === 0) return;
    // Null the contentHash (leaving the synthesis text intact) so the next
    // clustering pass's reuse gate (contentChanged) is forced to re-synthesize
    // these stories. Used only for degraded oversized anchor-split releases.
    await db
      .update(curatedStorySynthesis)
      .set({ contentHash: null })
      .where(inArray(curatedStorySynthesis.signature, signatures));
  }

  // ---------------------------------------------------------------------------
  // Curated lane — HISTORICAL story archive. Upserted off the hot path during the
  // clustering cron: one row per FORMED story keyed by signature (= clusterId), so
  // a recurring story keeps a single row (firstSeenAt preserved, lastSeenAt +
  // content refreshed). Read ONLY by the curated-gated archive endpoint; never by
  // any shared feed (fail-closed isolation).
  // ---------------------------------------------------------------------------
  async upsertCuratedStoryArchive(row: {
    signature: string; headline: string; lede: string; facts: string[];
    attributedClaims?: string[];
    category: string | null; region: string | null; country: string | null;
    sourceCount: number; repTitle: string | null; repSource: string | null;
    repUrl: string | null; ogImageUrl: string | null; members: CuratedArchiveMember[];
    splitLineageKey?: string | null;
  }): Promise<{ action: 'exact' | 'carry_forward' | 'insert'; absorbed: number }> {
    const now = new Date();
    const S = row.signature;
    const currentMembers = row.members ?? [];
    // Split-lineage of the story being written (null for ordinary stories). The
    // carry-forward/absorb matcher below is GATED on lineage equality so that two
    // sub-stories split off the same developing-process mega-cluster — which share
    // many member tokens by construction — can NEVER merge back into one another,
    // and a split child never collides with a non-split (null-lineage) prior row.
    const curLineage = this.normalizeSplitLineage(row.splitLineageKey);
    // Only carry a story's identity forward from a RECENT superseded version — an
    // old version untouched for >48h is treated as a genuinely separate episode.
    const MERGE_WINDOW_MS = 48 * 60 * 60 * 1000;
    // Display / synthesis fields refreshed on every touch. signature / members /
    // sourceCount / lastSeenAt are handled per-branch; firstSeenAt is NEVER
    // updated (preserved from first capture).
    const refresh = {
      headline: row.headline,
      lede: row.lede,
      facts: row.facts,
      attributedClaims: row.attributedClaims ?? [],
      category: row.category,
      region: row.region,
      country: row.country,
      repTitle: row.repTitle,
      repSource: row.repSource,
      repUrl: row.repUrl,
      ogImageUrl: row.ogImageUrl,
      splitLineageKey: curLineage,
    };

    // 1) Exact signature match — the recurring-story fast path. The unique
    //    constraint is on signature, so this MUST be tried first. Union members so
    //    a story whose grouping briefly returns to a prior shape never loses
    //    sources.
    const [exact] = await db
      .select()
      .from(curatedStoryArchive)
      .where(eq(curatedStoryArchive.signature, S))
      .limit(1);
    if (exact) {
      // NOT episode-bounded by design (Task #355 carve-out): an exact-signature
      // match means the live member-URL SET hashes identically to the stored row,
      // i.e. the same set — so the union cannot accrete and there is no blob to
      // bound. The zombie is an EVER-ACCUMULATING story whose set (and thus
      // signature) changes every pass, so it can NEVER sit on this fast path;
      // bounding here would only risk trimming a genuinely stable recurring
      // identity. Episode bounding lives on the carry-forward + insert paths the
      // churning zombie actually travels.
      const merged = this.unionArchiveMembers(currentMembers, exact.members ?? []);
      await db
        .update(curatedStoryArchive)
        .set({ ...refresh, members: merged, sourceCount: merged.length, lastSeenAt: now })
        .where(eq(curatedStoryArchive.id, exact.id));
      return { action: 'exact', absorbed: 0 };
    }

    // 2) Collapsing carry-forward. A story's signature changes the moment an outlet
    //    joins/drops or the AI regroups its members — and high-churn mega-stories
    //    change membership EVERY pass, so the OLD signature's row goes "not live"
    //    and would surface as a FALSE "phased out" duplicate while the story is
    //    still on the feed under the NEW signature. Picking only ONE match per pass
    //    also let the carry-forward ROTATE among a backlog of duplicates, bumping
    //    each one's lastSeenAt and floating them all to the top of the archive. So:
    //    find ALL superseded (not-live) recent versions of THIS story and COLLAPSE
    //    them into a single survivor — union every source so none is lost, keep the
    //    earliest firstSeenAt, rewrite the survivor's signature to the current live
    //    one (which the read endpoint's notLive filter then hides) and delete the
    //    absorbed duplicates. Only not-live rows are touched, so two genuinely
    //    distinct CONCURRENT (live) stories can never collapse together.
    const liveRows = await db
      .selectDistinct({ sig: curatedClusterMembers.clusterId })
      .from(curatedClusterMembers);
    const liveSigs = new Set(liveRows.map((r) => r.sig));
    const cutoff = new Date(now.getTime() - MERGE_WINDOW_MS);
    const recent = await db
      .select()
      .from(curatedStoryArchive)
      .where(gte(curatedStoryArchive.lastSeenAt, cutoff));

    const curTokens = new Set(
      currentMembers.map((m) => this.archiveMemberToken(m)).filter((t) => t.length > 0),
    );
    const curRep = this.normalizeArchiveUrl(row.repUrl);
    const curHeadTokens = this.archiveHeadlineTokens(row.headline);

    const matches: CuratedStoryArchive[] = [];
    for (const c of recent) {
      if (c.signature === S) continue; // handled by the exact path above
      if (liveSigs.has(c.signature)) continue; // never merge into a still-live story
      // Split-lineage guard: a sub-story may only carry forward into a PRIOR
      // version of the SAME lineage. Siblings (different child of the same split)
      // and non-split rows (null lineage) are never absorbed across the boundary.
      if (!this.sameSplitLineage(curLineage, c.splitLineageKey)) continue;
      // Episode boundary (Task #334): never carry the current (live, ~now-old)
      // story forward INTO an archive version whose episode already exceeded the
      // hard age cap. Without this, a churned signature would re-attach to the old
      // multi-day episode row — preserving its day-0 firstSeenAt and keeping it
      // perpetually "live" (the zombie-row bypass). An over-age candidate is a
      // PRIOR episode and must stay closed; the current story inserts a fresh row.
      if (now.getTime() - new Date(c.firstSeenAt).getTime() > CURATED_EPISODE_HARD_AGE_MS) continue;
      if (this.archiveRowMatches({ curTokens, curRep, curHeadTokens, region: row.region }, c)) {
        matches.push(c);
      }
    }

    if (matches.length > 0) {
      // Survivor = the EARLIEST first-seen version (preserves the story's original
      // identity / firstSeenAt). Union members across the current pass AND every
      // matched duplicate so the collapsed row retains all sources ever seen.
      matches.sort(
        (a, b) => new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime(),
      );
      const survivor = matches[0];
      const absorbedIds = matches.slice(1).map((m) => m.id);
      let mergedMembers = currentMembers;
      for (const m of matches) mergedMembers = this.unionArchiveMembers(mergedMembers, m.members ?? []);
      // Episode boundary (Task #355): the carry-forward survivor must also stay
      // within one episode window so a long-churning story never archives a blob.
      mergedMembers = this.boundMembersToRecentEpisode(mergedMembers);
      const earliestFirstSeen = matches.reduce(
        (min, c) => Math.min(min, new Date(c.firstSeenAt).getTime()),
        new Date(survivor.firstSeenAt).getTime(),
      );
      try {
        await db.transaction(async (tx) => {
          if (absorbedIds.length > 0) {
            await tx
              .delete(curatedStoryArchive)
              .where(inArray(curatedStoryArchive.id, absorbedIds));
          }
          await tx
            .update(curatedStoryArchive)
            .set({
              signature: S,
              ...refresh,
              members: mergedMembers,
              sourceCount: mergedMembers.length,
              firstSeenAt: new Date(earliestFirstSeen),
              lastSeenAt: now,
            })
            .where(eq(curatedStoryArchive.id, survivor.id));
        });
        return { action: 'carry_forward', absorbed: absorbedIds.length };
      } catch {
        // Extremely unlikely under the single-worker clustering cron: a row with
        // signature=S appeared between our lookup and this update. Fall through to
        // the upsert, which resolves cleanly on the unique constraint.
      }
    }

    // 3) Genuinely new story — insert (or upsert if S raced in). Episode-bound the
    //    members (Task #355) for uniformity; a no-op for a fresh story whose
    //    members sit inside the live recency window.
    const boundedCurrent = this.boundMembersToRecentEpisode(currentMembers);
    await db
      .insert(curatedStoryArchive)
      .values({
        ...row,
        members: boundedCurrent,
        sourceCount: boundedCurrent.length,
        attributedClaims: row.attributedClaims ?? [],
        splitLineageKey: curLineage,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: curatedStoryArchive.signature,
        set: {
          ...refresh,
          members: boundedCurrent,
          sourceCount: boundedCurrent.length,
          lastSeenAt: now,
        },
      });
    return { action: 'insert', absorbed: 0 };
  }

  // Episode origination lookup (Task #334). Returns, for each given signature,
  // the archived story's preserved firstSeenAt (= when the episode broke). The
  // clustering engine uses it to decide whether a prior-pass clusterId is still
  // within its episode window and may be RECLAIMED, or has aged out and must be
  // surrendered so the continuing story rolls to a fresh, bounded episode. Batched
  // (one IN query); empty input → empty map; missing signature simply absent
  // (caller treats absent as "no archive row yet → eligible"). Curated lane only.
  async getCuratedArchiveOriginationBySignatures(
    signatures: string[],
  ): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    const uniq = Array.from(new Set(signatures.filter((s) => !!s)));
    if (uniq.length === 0) return out;
    const rows = await db
      .select({ signature: curatedStoryArchive.signature, firstSeenAt: curatedStoryArchive.firstSeenAt })
      .from(curatedStoryArchive)
      .where(inArray(curatedStoryArchive.signature, uniq));
    for (const r of rows) out.set(r.signature, new Date(r.firstSeenAt));
    return out;
  }

  // Identity token for an archived member: the normalized article URL when present
  // (so the same article keeps ONE identity even across its main:/curated: key
  // flip), else a source+title fallback for URL-less members. Empty string means
  // "no usable identity" and is filtered out before set membership.
  private archiveMemberToken(m: CuratedArchiveMember): string {
    const u = this.normalizeArchiveUrl(m.url);
    if (u.length > 0) return u;
    const s = (m.source ?? '').trim().toLowerCase();
    const t = (m.title ?? '').trim().toLowerCase();
    return s.length > 0 || t.length > 0 ? `${s}::${t}` : '';
  }

  // Union two archived-member lists, deduped by identity token. CURRENT-pass
  // members win (fresher tier / spin / metadata); members present ONLY in the
  // older snapshot are retained so the story stays intact across membership churn.
  private unionArchiveMembers(
    current: CuratedArchiveMember[],
    existing: CuratedArchiveMember[],
  ): CuratedArchiveMember[] {
    const byToken = new Map<string, CuratedArchiveMember>();
    const add = (m: CuratedArchiveMember) => {
      const t = this.archiveMemberToken(m);
      if (t.length === 0) return;
      const prior = byToken.get(t);
      if (!prior) {
        byToken.set(t, m);
        return;
      }
      // Same source seen twice across snapshots: keep the first member's fields
      // but never lose a known published date — prefer a present date over a
      // missing one so the per-source date survives across clustering passes.
      if (!prior.publishedAt && m.publishedAt) {
        byToken.set(t, { ...prior, publishedAt: m.publishedAt });
      }
    };
    for (const m of current) add(m);
    for (const m of existing) add(m);
    return Array.from(byToken.values());
  }

  // Bound a member set to a SINGLE episode window (Task #355). Drops DATED
  // members older than CURATED_EPISODE_HARD_AGE_MS before the newest dated member
  // so no archive row can ever store / present an unbounded multi-day blob of
  // sources (the "1,863 sources spanning 5 days" zombie). Members with no usable
  // date are retained (no basis to time-bound them). It is a NO-OP whenever the
  // dated span already fits inside the episode cap, so a normal story — including
  // a legitimate multi-day developing-process story (<=48h, below the 60h cap) —
  // is never trimmed. Applied on every archive WRITE (exact fast-path union,
  // carry-forward survivor, and fresh insert) so even the exact-signature path,
  // which previously bypassed the episode boundary, can no longer accrete an
  // over-age blob. Curated lane only.
  private boundMembersToRecentEpisode(
    members: CuratedArchiveMember[],
  ): CuratedArchiveMember[] {
    const dated = members
      .map((m) => (m.publishedAt ? new Date(m.publishedAt).getTime() : NaN))
      .filter((t) => Number.isFinite(t)) as number[];
    if (dated.length === 0) return members; // no dates -> cannot time-bound
    const newest = Math.max(...dated);
    if (newest - Math.min(...dated) <= CURATED_EPISODE_HARD_AGE_MS) return members;
    const floor = newest - CURATED_EPISODE_HARD_AGE_MS;
    return members.filter((m) => {
      if (!m.publishedAt) return true; // keep undated
      const t = new Date(m.publishedAt).getTime();
      if (!Number.isFinite(t)) return true;
      return t >= floor;
    });
  }

  // Delegates to the single shared normalizer (server/urlIdentity.ts), which is
  // also what curatedSynthesis.normalizeMemberUrl uses — so a member's archive
  // token always matches the clustering pass's identity for the same article.
  private normalizeArchiveUrl(u: string | null | undefined): string {
    return normalizeIdentityUrl(u);
  }

  // Significant token set of a generalized story headline, used to tell whether
  // two archive rows describe the same story. Strips periods/apostrophes WITHOUT a
  // space ("U.S." -> "us"), then splits on other punctuation and drops stopwords.
  private archiveHeadlineTokens(s: string | null | undefined): Set<string> {
    if (!s) return new Set();
    return new Set(
      s
        .toLowerCase()
        .replace(/[.'’]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2 && !ARCHIVE_HEADLINE_STOPWORDS.has(w)),
    );
  }

  // Jaccard similarity of two headline token sets (0..1).
  private headlineSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let shared = 0;
    small.forEach((t) => { if (large.has(t)) shared++; });
    const union = a.size + b.size - shared;
    return union > 0 ? shared / union : 0;
  }

  // Decide whether an archived story version `c` is the SAME real-world story as
  // the current one. Conservative by design — the cost of a false merge (two
  // distinct stories collapsed) is worse than a missed merge (a stray duplicate).
  // Anchors (any one suffices):
  //   A. identical normalized representative URL (the story's "face"); OR
  //   B. strong member overlap — >=3 shared sources AND (containment>=0.4 OR
  //      Jaccard>=0.2). CONTAINMENT (shared / smaller set) is used alongside
  //      Jaccard because a mega-story's member count swings wildly pass-to-pass
  //      (e.g. 306<->76), which deflates Jaccard even when one set is a near-subset
  //      of the other; OR
  //   C. near-identical generalized headline (sim>=0.82) AND at least one shared
  //      source.
  // Hard guard: if BOTH rows carry a region and the regions differ, they are
  // different stories — never merge across a region conflict.
  // Normalize a split-lineage key: empty/whitespace → null so an unset lineage is
  // a single canonical value. Curated lane only.
  private normalizeSplitLineage(key: string | null | undefined): string | null {
    const k = (key ?? '').trim();
    return k.length > 0 ? k : null;
  }

  // Two archive rows may only merge (carry-forward / dedup-absorb) when their
  // split-lineage keys are EQUAL after normalization. null === null (ordinary
  // stories) merges as before; a sub-story (set lineage) never merges with a
  // sibling (different lineage) or with a non-split row (null). Curated lane only.
  private sameSplitLineage(a: string | null | undefined, b: string | null | undefined): boolean {
    return this.normalizeSplitLineage(a) === this.normalizeSplitLineage(b);
  }

  private archiveRowMatches(
    cur: { curTokens: Set<string>; curRep: string; curHeadTokens: Set<string>; region: string | null },
    c: CuratedStoryArchive,
  ): boolean {
    const curRegion = (cur.region ?? '').trim().toLowerCase();
    const cRegion = (c.region ?? '').trim().toLowerCase();
    if (curRegion && cRegion && curRegion !== cRegion) return false;

    // Anchor A: representative URL.
    if (cur.curRep.length > 0 && this.normalizeArchiveUrl(c.repUrl) === cur.curRep) return true;

    const cTokens = new Set(
      (c.members ?? []).map((m) => this.archiveMemberToken(m)).filter((t) => t.length > 0),
    );
    let shared = 0;
    for (const t of Array.from(cur.curTokens)) if (cTokens.has(t)) shared++;
    const unionSize = new Set([...Array.from(cur.curTokens), ...Array.from(cTokens)]).size;
    const jaccard = unionSize > 0 ? shared / unionSize : 0;
    const minSize = Math.min(cur.curTokens.size, cTokens.size);
    const containment = minSize > 0 ? shared / minSize : 0;

    // Anchor B: member overlap.
    if (shared >= 3 && (containment >= 0.4 || jaccard >= 0.2)) return true;

    // Anchor C: near-identical headline + a shared source.
    if (shared >= 1) {
      const headSim = this.headlineSimilarity(cur.curHeadTokens, this.archiveHeadlineTokens(c.headline));
      if (headSim >= 0.82) return true;
    }

    // Anchor D (Task #355): absorb a SMALL same-event FRAGMENT. A 1–2 source
    // sliver of an event can never reach anchor B's >=3 shared-token bar, so a
    // genuine fragment (e.g. one late wire pickup of a story that already has a
    // 400-source parent episode) is structurally un-absorbable under A–C and
    // lingers as its own near-duplicate card. Fold it in ONLY when it is the same
    // event: at least one shared member with the parent (`shared >= 1`),
    // reinforced by a strong topic signal — a near-identical generalized headline
    // (sim >= 0.5) OR multiple shared significant headline tokens AND the same
    // explicit region. The hard region-conflict veto above still applies, and the
    // callers gate every candidate to within the episode window, so this can
    // never bridge two genuinely distinct stories or two large episodes (one side
    // must be a <=2 source fragment).
    if (minSize > 0 && minSize <= 2 && shared >= 1) {
      const cHeadTokens = this.archiveHeadlineTokens(c.headline);
      const headSim = this.headlineSimilarity(cur.curHeadTokens, cHeadTokens);
      if (headSim >= 0.5) return true;
      let sharedHead = 0;
      for (const t of Array.from(cur.curHeadTokens)) if (cHeadTokens.has(t)) sharedHead++;
      const sameRegion = curRegion.length > 0 && cRegion.length > 0 && curRegion === cRegion;
      if (sharedHead >= 2 && sameRegion) return true;
    }
    return false;
  }

  async searchCuratedStoryArchive(opts: { query?: string; limit?: number; offset?: number }): Promise<{ items: Array<CuratedStoryArchive & { status: ArchiveStatus }>; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const q = (opts.query ?? '').trim();
    const searchClause = q
      ? or(
          ilike(curatedStoryArchive.headline, `%${q}%`),
          ilike(curatedStoryArchive.lede, `%${q}%`),
          ilike(curatedStoryArchive.repTitle, `%${q}%`),
          ilike(curatedStoryArchive.repSource, `%${q}%`),
          ilike(curatedStoryArchive.category, `%${q}%`),
          ilike(curatedStoryArchive.region, `%${q}%`),
          ilike(curatedStoryArchive.country, `%${q}%`),
          sql`array_to_string(${curatedStoryArchive.facts}, ' ') ILIKE ${'%' + q + '%'}`,
        )
      : undefined;
    // Only surface a story VERSION once its exact source grouping has left the
    // live feed. A formed story's grouping (signature = clusterId) is present in
    // curated_cluster_members while it is still live, so excluding those leaves
    // the archive showing only superseded / gone versions — never a near-duplicate
    // of a story still on the feed. cluster_id is NOT NULL, so the NOT IN has no
    // null-pruning gotcha; an empty live set leaves every archived row visible.
    const notLive = notInArray(
      curatedStoryArchive.signature,
      db.selectDistinct({ sig: curatedClusterMembers.clusterId }).from(curatedClusterMembers),
    );
    const whereClause = searchClause ? and(searchClause, notLive) : notLive;
    const rows = await db
      .select()
      .from(curatedStoryArchive)
      .where(whereClause)
      .orderBy(desc(curatedStoryArchive.lastSeenAt))
      .limit(limit)
      .offset(offset);
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(curatedStoryArchive)
      .where(whereClause);
    // Honest archive status (read-only). A not-live row whose stored members are
    // still fresh is 'active' (eligible, simply not currently surfaced in Top
    // Stories — e.g. crowded out by the priority cap or a transient missed pass),
    // NOT 'phased_out'. Derived from the SAME staleness rule the clustering pass
    // uses, so the label the archive shows never contradicts the engine.
    const now = Date.now();
    const items = rows.map((r) => ({
      ...r,
      status: archiveRowStatus(
        (r.members ?? []) as CuratedArchiveMember[],
        now,
        r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : null,
      ),
    }));
    return { items, total: Number(total) };
  }

  // Recently-seen but currently NOT-live archived stories for the clustering
  // grace lane (Part B). A story that dropped out of Top Stories for a transient
  // missed pass — yet whose articles are still fresh — should be re-admitted to
  // the next clustering payload so it can re-form, instead of flapping permanently
  // into the archive. Returns the most-recently-seen not-live rows within the
  // grace window, capped; the clustering engine applies the freshness /
  // episode-age / contributing-only filters before using them.
  async getCuratedArchiveGraceCandidates(withinHours: number, maxRows: number): Promise<CuratedStoryArchive[]> {
    const cutoff = new Date(Date.now() - Math.max(0, withinHours) * 60 * 60 * 1000);
    const notLive = notInArray(
      curatedStoryArchive.signature,
      db.selectDistinct({ sig: curatedClusterMembers.clusterId }).from(curatedClusterMembers),
    );
    return db
      .select()
      .from(curatedStoryArchive)
      .where(and(gte(curatedStoryArchive.lastSeenAt, cutoff), notLive))
      .orderBy(desc(curatedStoryArchive.lastSeenAt))
      .limit(Math.max(1, maxRows));
  }

  async pruneCuratedStoryArchive(retentionDays: number): Promise<void> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    await db.delete(curatedStoryArchive).where(lt(curatedStoryArchive.lastSeenAt, cutoff));
  }

  // Curated lane — clustering flight-recorder. Append one snapshot per pass.
  // Pure observability; never read outside the curated-gated metrics endpoint.
  async recordCuratedClusterMetrics(row: InsertCuratedClusterMetrics): Promise<void> {
    await db.insert(curatedClusterMetrics).values(row);
  }

  async getCuratedClusterMetrics(limit: number): Promise<CuratedClusterMetrics[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    return await db
      .select()
      .from(curatedClusterMetrics)
      .orderBy(desc(curatedClusterMetrics.createdAt))
      .limit(safeLimit);
  }

  // Curated lane — "smart process re-partition" overlays. All persisted split
  // decisions (both 'active' splits and 'intact' verdicts). The clustering pass
  // applies the active ones and consults the intact ones for the cooldown gate.
  // Curated-only (never read on a shared feed / public API).
  async getActiveCuratedSplitOverlays(): Promise<CuratedProcessSplitOverlay[]> {
    return await db
      .select()
      .from(curatedProcessSplitOverlays)
      .orderBy(desc(curatedProcessSplitOverlays.lastEvaluatedAt));
  }

  // Insert a fresh overlay, or update an existing one in place when `id` is given
  // (the re-evaluation path keeps the SAME overlay id so the child lineage keys —
  // `<id>:<childKey>` — stay stable across re-evaluations). Returns the row.
  async upsertCuratedSplitOverlay(
    row: InsertCuratedProcessSplitOverlay & { id?: string },
  ): Promise<CuratedProcessSplitOverlay> {
    if (row.id) {
      const { id, ...rest } = row;
      const [updated] = await db
        .update(curatedProcessSplitOverlays)
        .set({ ...rest, lastEvaluatedAt: new Date() })
        .where(eq(curatedProcessSplitOverlays.id, id))
        .returning();
      if (updated) return updated;
      // Row was pruned between read and write — fall through to a fresh insert.
    }
    const [inserted] = await db
      .insert(curatedProcessSplitOverlays)
      .values({ ...row })
      .returning();
    return inserted;
  }

  // Drop overlays not re-evaluated within `staleHours` (their mega-cluster is long
  // gone). Bounded housekeeping so the table never grows without limit; the live
  // application path only ever matches overlays whose tokens still cover a group.
  async pruneCuratedSplitOverlaysOlderThan(staleHours: number): Promise<void> {
    const cutoff = new Date(Date.now() - Math.max(1, staleHours) * 60 * 60 * 1000);
    await db
      .delete(curatedProcessSplitOverlays)
      .where(lt(curatedProcessSplitOverlays.lastEvaluatedAt, cutoff));
  }

  // ---- Curated EDITOR manual-link overlay (human must-link) --------------------
  // Only ACTIVE rows are applied by the clustering pass. Keyed by normalized member
  // URL, so an overlay whose items have aged out simply matches nothing (no-op).
  async getActiveCuratedManualLinks(): Promise<CuratedManualLink[]> {
    return await db
      .select()
      .from(curatedManualLinks)
      .where(eq(curatedManualLinks.status, 'active'))
      .orderBy(desc(curatedManualLinks.updatedAt));
  }

  async getCuratedManualLink(id: string): Promise<CuratedManualLink | undefined> {
    const [row] = await db
      .select()
      .from(curatedManualLinks)
      .where(eq(curatedManualLinks.id, id))
      .limit(1);
    return row;
  }

  // Recent rows (active AND revoked) for the Source Oversight editor-update trail.
  async getRecentCuratedManualLinks(limit: number, after?: Date | null, before?: Date | null): Promise<CuratedManualLink[]> {
    const conditions: ReturnType<typeof gte>[] = [];
    if (after) conditions.push(gte(curatedManualLinks.createdAt, after));
    if (before) conditions.push(lt(curatedManualLinks.createdAt, before));
    return await db
      .select()
      .from(curatedManualLinks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(curatedManualLinks.updatedAt))
      .limit(Math.max(1, Math.min(500, limit)));
  }

  // Dedup on (kind + normalized member-URL SET): linking the same set of URLs
  // again (double-click, re-confirm minutes later) REFRESHES the existing active
  // row instead of inserting a duplicate — one row per set means the must-link
  // is applied once per pass and the Source Oversight audit trail stays clean.
  // The surviving row keeps its original createdBy/createdAt (who/when); only
  // updatedAt (and the latest label/AI-verdict context) is refreshed.
  async createCuratedManualLink(row: InsertCuratedManualLink): Promise<CuratedManualLink> {
    const setKey = (urls: string[] | null | undefined) =>
      Array.from(new Set(urls ?? [])).sort().join('\n');
    const incomingKey = setKey(row.memberUrls as string[] | undefined);
    if (incomingKey) {
      const active = await db
        .select()
        .from(curatedManualLinks)
        .where(eq(curatedManualLinks.status, 'active'));
      const existing = active.find(
        (r) => r.kind === (row.kind ?? 'link') && setKey(r.memberUrls) === incomingKey,
      );
      if (existing) {
        const [updated] = await db
          .update(curatedManualLinks)
          .set({
            updatedAt: new Date(),
            label: row.label ?? existing.label,
            aiVerdict: row.aiVerdict ?? existing.aiVerdict,
            aiReasoning: row.aiReasoning ?? existing.aiReasoning,
            overrodeAi: row.overrodeAi ?? existing.overrodeAi,
            reasonKeys: row.reasonKeys !== undefined ? row.reasonKeys : existing.reasonKeys,
            reasonNote: row.reasonNote !== undefined ? row.reasonNote : existing.reasonNote,
          })
          .where(eq(curatedManualLinks.id, existing.id))
          .returning();
        return updated;
      }
    }
    const [inserted] = await db
      .insert(curatedManualLinks)
      .values({ ...row })
      .returning();
    return inserted;
  }

  /**
   * Create/refresh the effective union row and revoke every absorbed active row
   * atomically. The surviving row is explicitly excluded from revocation because
   * an identical retry may refresh an existing row that also appears in the
   * caller's overlap snapshot.
   */
  async createCuratedManualLinkConsolidated(
    row: InsertCuratedManualLink,
    options: { absorbOverlaps: boolean; effectiveUrlCap: number },
  ): Promise<{
    row: CuratedManualLink;
    effectiveMemberUrls: string[];
    effectiveKind: 'link' | 'merge';
    supersededIds: string[];
  }> {
    return await db.transaction(async (tx) => {
      // One database-wide lock for the small manual-link overlay domain. This
      // closes both queued stale-snapshot races and multi-process duplicate
      // inserts: every consolidated writer re-reads active rows under this lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1180, 41)`);

      const setKey = (urls: string[] | null | undefined) =>
        Array.from(new Set(urls ?? [])).sort().join('\n');
      const requestedUrls = Array.from(new Set((row.memberUrls as string[] | undefined) ?? []));
      const selection = new Set(requestedUrls);
      const unioned = new Set(requestedUrls);
      let effectiveKind: 'link' | 'merge' = row.kind === 'merge' ? 'merge' : 'link';
      const supersededIds: string[] = [];
      const active = await tx
        .select()
        .from(curatedManualLinks)
        .where(eq(curatedManualLinks.status, 'active'))
        .orderBy(desc(curatedManualLinks.updatedAt));

      if (options.absorbOverlaps) {
        for (const candidate of active) {
          const candidateUrls = Array.from(new Set(candidate.memberUrls ?? []));
          if (!candidateUrls.some((url) => selection.has(url))) continue;
          supersededIds.push(candidate.id);
          if (candidate.kind === 'merge') effectiveKind = 'merge';
          for (const url of candidateUrls) {
            if (unioned.size >= Math.max(requestedUrls.length, options.effectiveUrlCap)) break;
            unioned.add(url);
          }
        }
      }
      const effectiveMemberUrls = Array.from(unioned);
      const effectiveRow: InsertCuratedManualLink = {
        ...row,
        memberUrls: effectiveMemberUrls,
        kind: effectiveKind,
      };
      const incomingKey = setKey(effectiveMemberUrls);
      let surviving: CuratedManualLink | undefined;

      if (incomingKey) {
        const existing = active.find(
          (candidate) =>
            candidate.kind === effectiveKind
            && setKey(candidate.memberUrls) === incomingKey,
        );
        if (existing) {
          const [updated] = await tx
            .update(curatedManualLinks)
            .set({
              updatedAt: new Date(),
              label: effectiveRow.label ?? existing.label,
              aiVerdict: effectiveRow.aiVerdict ?? existing.aiVerdict,
              aiReasoning: effectiveRow.aiReasoning ?? existing.aiReasoning,
              overrodeAi: effectiveRow.overrodeAi ?? existing.overrodeAi,
              reasonKeys: effectiveRow.reasonKeys !== undefined ? effectiveRow.reasonKeys : existing.reasonKeys,
              reasonNote: effectiveRow.reasonNote !== undefined ? effectiveRow.reasonNote : existing.reasonNote,
            })
            .where(eq(curatedManualLinks.id, existing.id))
            .returning();
          surviving = updated;
        }
      }

      if (!surviving) {
        const [inserted] = await tx
          .insert(curatedManualLinks)
          .values({ ...effectiveRow })
          .returning();
        surviving = inserted;
      }

      const revokeIds = Array.from(new Set(supersededIds))
        .filter((id) => id && id !== surviving!.id);
      if (revokeIds.length > 0) {
        await tx
          .update(curatedManualLinks)
          .set({ status: 'revoked', updatedAt: new Date() })
          .where(and(
            inArray(curatedManualLinks.id, revokeIds),
            eq(curatedManualLinks.status, 'active'),
          ));
      }
      return {
        row: surviving,
        effectiveMemberUrls,
        effectiveKind,
        supersededIds: revokeIds,
      };
    });
  }

  // Soft-delete: mark revoked (kept for the audit trail) so it stops being applied.
  // createdBy is preserved (who created the link matters more than who revoked it).
  async revokeCuratedManualLink(id: string, _revokedBy: string): Promise<CuratedManualLink | undefined> {
    const [updated] = await db
      .update(curatedManualLinks)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(curatedManualLinks.id, id))
      .returning();
    return updated;
  }

  // Bounded housekeeping — drop REVOKED rows older than staleHours (active rows are
  // kept as long as the editor leaves them in place; their items no-op once gone).
  async pruneCuratedManualLinksOlderThan(staleHours: number): Promise<void> {
    const cutoff = new Date(Date.now() - Math.max(1, staleHours) * 60 * 60 * 1000);
    await db
      .delete(curatedManualLinks)
      .where(and(eq(curatedManualLinks.status, 'revoked'), lt(curatedManualLinks.updatedAt, cutoff)));
  }

  // ---- Curated EDITOR manual-EVICTION overlay (cannot-link) --------------------
  async getActiveCuratedManualEvictions(): Promise<CuratedManualEviction[]> {
    return await db
      .select()
      .from(curatedManualEvictions)
      .where(eq(curatedManualEvictions.status, 'active'))
      .orderBy(desc(curatedManualEvictions.updatedAt));
  }

  async getCuratedManualEviction(id: string): Promise<CuratedManualEviction | undefined> {
    const [row] = await db
      .select()
      .from(curatedManualEvictions)
      .where(eq(curatedManualEvictions.id, id))
      .limit(1);
    return row;
  }

  // Recent rows (active AND revoked) for the Source Oversight editor-update trail.
  async getRecentCuratedManualEvictions(limit: number, after?: Date | null, before?: Date | null): Promise<CuratedManualEviction[]> {
    const conditions: ReturnType<typeof gte>[] = [];
    if (after) conditions.push(gte(curatedManualEvictions.createdAt, after));
    if (before) conditions.push(lt(curatedManualEvictions.createdAt, before));
    return await db
      .select()
      .from(curatedManualEvictions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(curatedManualEvictions.updatedAt))
      .limit(Math.max(1, Math.min(500, limit)));
  }

  // Dedup on the evicted URL + anchor SET: evicting the same article from the
  // same cluster again REFRESHES the existing active row instead of inserting a
  // duplicate — one row per (evictedUrl, anchor-set) means it is applied once per
  // pass and the audit trail stays clean. The surviving row keeps its original
  // createdBy/createdAt (who/when); only updatedAt + latest label/reason context
  // is refreshed.
  async createCuratedManualEviction(row: InsertCuratedManualEviction): Promise<CuratedManualEviction> {
    const setKey = (urls: string[] | null | undefined) =>
      Array.from(new Set(urls ?? [])).sort().join('\n');
    const evUrl = (row.evictedUrl ?? '').trim();
    const incomingAnchorKey = setKey(row.anchorUrls as string[] | undefined);
    if (evUrl) {
      const active = await db
        .select()
        .from(curatedManualEvictions)
        .where(eq(curatedManualEvictions.status, 'active'));
      const existing = active.find(
        (r) => r.evictedUrl === evUrl && setKey(r.anchorUrls) === incomingAnchorKey,
      );
      if (existing) {
        const [updated] = await db
          .update(curatedManualEvictions)
          .set({
            updatedAt: new Date(),
            label: row.label ?? existing.label,
            reasonKeys: row.reasonKeys !== undefined ? row.reasonKeys : existing.reasonKeys,
            reasonNote: row.reasonNote !== undefined ? row.reasonNote : existing.reasonNote,
          })
          .where(eq(curatedManualEvictions.id, existing.id))
          .returning();
        return updated;
      }
    }
    const [inserted] = await db
      .insert(curatedManualEvictions)
      .values({ ...row })
      .returning();
    return inserted;
  }

  // Soft-delete: mark revoked (kept for the audit trail) so it stops being applied.
  async revokeCuratedManualEviction(id: string, _revokedBy: string): Promise<CuratedManualEviction | undefined> {
    const [updated] = await db
      .update(curatedManualEvictions)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(curatedManualEvictions.id, id))
      .returning();
    return updated;
  }

  // Bounded housekeeping — drop REVOKED rows older than staleHours (active rows are
  // kept as long as the editor leaves them in place; their items no-op once gone).
  async pruneCuratedManualEvictionsOlderThan(staleHours: number): Promise<void> {
    const cutoff = new Date(Date.now() - Math.max(1, staleHours) * 60 * 60 * 1000);
    await db
      .delete(curatedManualEvictions)
      .where(and(eq(curatedManualEvictions.status, 'revoked'), lt(curatedManualEvictions.updatedAt, cutoff)));
  }

  // ---- Curated EDITOR manual-MOVE overlay (mirror of the eviction CRUD) ----

  async getActiveCuratedManualMoves(): Promise<CuratedManualMove[]> {
    return await db
      .select()
      .from(curatedManualMoves)
      .where(eq(curatedManualMoves.status, 'active'))
      .orderBy(desc(curatedManualMoves.updatedAt));
  }

  async getCuratedManualMove(id: string): Promise<CuratedManualMove | undefined> {
    const [row] = await db
      .select()
      .from(curatedManualMoves)
      .where(eq(curatedManualMoves.id, id))
      .limit(1);
    return row;
  }

  async getRecentCuratedManualMoves(limit: number, after?: Date | null, before?: Date | null): Promise<CuratedManualMove[]> {
    const conditions: ReturnType<typeof gte>[] = [];
    if (after) conditions.push(gte(curatedManualMoves.createdAt, after));
    if (before) conditions.push(lt(curatedManualMoves.createdAt, before));
    return await db
      .select()
      .from(curatedManualMoves)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(curatedManualMoves.updatedAt))
      .limit(Math.max(1, Math.min(500, limit)));
  }

  // ONE active move per item — latest wins. Re-moving the same article to the
  // SAME target (same anchor sets) refreshes the existing active row; any other
  // active move for the item is revoked first by the route (via
  // revokeActiveCuratedManualMovesForUrl) so the audit trail records the switch.
  async createCuratedManualMove(row: InsertCuratedManualMove): Promise<CuratedManualMove> {
    const setKey = (urls: string[] | null | undefined) =>
      Array.from(new Set(urls ?? [])).sort().join('\n');
    const itemUrl = (row.itemUrl ?? '').trim();
    const incomingSrcKey = setKey(row.sourceAnchorUrls as string[] | undefined);
    const incomingTgtKey = setKey(row.targetAnchorUrls as string[] | undefined);
    if (itemUrl) {
      const active = await db
        .select()
        .from(curatedManualMoves)
        .where(eq(curatedManualMoves.status, 'active'));
      const existing = active.find(
        (r) => r.itemUrl === itemUrl
          && setKey(r.sourceAnchorUrls) === incomingSrcKey
          && setKey(r.targetAnchorUrls) === incomingTgtKey,
      );
      if (existing) {
        const [updated] = await db
          .update(curatedManualMoves)
          .set({
            updatedAt: new Date(),
            label: row.label ?? existing.label,
            reasonKeys: row.reasonKeys !== undefined ? row.reasonKeys : existing.reasonKeys,
            reasonNote: row.reasonNote !== undefined ? row.reasonNote : existing.reasonNote,
          })
          .where(eq(curatedManualMoves.id, existing.id))
          .returning();
        return updated;
      }
    }
    const [inserted] = await db
      .insert(curatedManualMoves)
      .values({ ...row })
      .returning();
    return inserted;
  }

  // Soft-delete: mark revoked (kept for the audit trail) so it stops being applied.
  async revokeCuratedManualMove(id: string, _revokedBy: string): Promise<CuratedManualMove | undefined> {
    const [updated] = await db
      .update(curatedManualMoves)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(curatedManualMoves.id, id))
      .returning();
    return updated;
  }

  // "Latest wins" support: revoke every active move for this item URL (called by
  // the route before inserting a replacement move, and by the eviction/link
  // routes when the editor makes a conflicting decision about the same item).
  async revokeActiveCuratedManualMovesForUrl(itemUrl: string): Promise<number> {
    const url = (itemUrl ?? '').trim();
    if (!url) return 0;
    const updated = await db
      .update(curatedManualMoves)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(and(eq(curatedManualMoves.status, 'active'), eq(curatedManualMoves.itemUrl, url)))
      .returning();
    return updated.length;
  }

  // Bounded housekeeping — drop REVOKED rows older than staleHours.
  async pruneCuratedManualMovesOlderThan(staleHours: number): Promise<void> {
    const cutoff = new Date(Date.now() - Math.max(1, staleHours) * 60 * 60 * 1000);
    await db
      .delete(curatedManualMoves)
      .where(and(eq(curatedManualMoves.status, 'revoked'), lt(curatedManualMoves.updatedAt, cutoff)));
  }

  // One-time/maintenance pass that cleans up the EXISTING backlog of duplicate
  // archive rows the old single-match carry-forward left behind. The going-forward
  // collapsing carry-forward only fires when a story is still live (a current pass
  // touches it); stories that already fully phased out keep their stale duplicates
  // forever, so this sweeps them. Greedy-groups not-live rows with the SAME matcher
  // the live path uses, keeps the earliest-first-seen survivor per group, unions
  // every source, refreshes the survivor's display fields from the FRESHEST member
  // of the group, and deletes the rest. It deliberately does NOT bump lastSeenAt to
  // now — these are phased-out stories and must keep their real recency, not jump to
  // the top of the archive. dryRun (the default) computes the grouping and returns a
  // summary without writing anything.
  async normalizeCuratedArchiveDuplicates(opts: { dryRun?: boolean; windowHours?: number }): Promise<{ dryRun: boolean; windowHours: number; scanned: number; duplicateGroups: number; rowsAbsorbed: number; groups: Array<{ survivorHeadline: string; absorbed: number; totalSources: number; sampleHeadlines: string[] }> }> {
    const dryRun = opts.dryRun !== false; // default TRUE (safe)
    const windowHours = Math.min(Math.max(opts.windowHours ?? 720, 1), 24 * 90); // default 30d, max 90d
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    // A live story's current version must never be ABSORBED (it would vanish
    // from the live feed mapping's perspective) — but it CAN act as a group's
    // SURVIVOR (Task #1088). Excluding live rows entirely let same-day
    // duplicates accumulate: while a story was live under signature A, churned
    // not-live versions (B, C, …) of the same story could never be folded into
    // it, so the sweep saw 2–3 "alive" copies per day that only converged after
    // the story phased out. Live rows now participate in grouping as anchors;
    // only not-live rows are ever deleted/absorbed.
    const liveRows = await db
      .selectDistinct({ sig: curatedClusterMembers.clusterId })
      .from(curatedClusterMembers);
    const liveSigs = new Set(liveRows.map((r) => r.sig));
    const rows = (
      await db
        .select()
        .from(curatedStoryArchive)
        .where(gte(curatedStoryArchive.lastSeenAt, cutoff))
    )
      .sort((a, b) => new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime());

    // Greedy single-pass grouping: each row joins the first existing group whose
    // EARLIEST representative it matches (same anchors as the live carry-forward),
    // else it starts a new group. Earliest-first ordering makes group[0] the
    // survivor.
    type Grp = { rows: CuratedStoryArchive[] };
    const groups: Grp[] = [];
    for (const r of rows) {
      const rTokens = new Set(
        (r.members ?? []).map((m) => this.archiveMemberToken(m)).filter((t) => t.length > 0),
      );
      const rRep = this.normalizeArchiveUrl(r.repUrl);
      const rHead = this.archiveHeadlineTokens(r.headline);
      let placed = false;
      const rFirst = new Date(r.firstSeenAt).getTime();
      for (const g of groups) {
        // Split-lineage guard: never collapse two rows of differing lineage —
        // sibling sub-stories (and a sub-story vs. a non-split row) stay separate.
        if (!this.sameSplitLineage(r.splitLineageKey, g.rows[0].splitLineageKey)) continue;
        // Episode boundary (Task #334): a group is ONE episode. Rows are sorted
        // earliest-first so g.rows[0] is the episode survivor; only fold in a
        // matching row whose origination is within the hard age cap of it. This
        // collapses within-episode churn fragments while refusing to merge two
        // distinct temporal episodes of the same ongoing story back into a single
        // multi-day mega-row (which would recreate the zombie this task removes).
        if (rFirst - new Date(g.rows[0].firstSeenAt).getTime() > CURATED_EPISODE_HARD_AGE_MS) continue;
        if (
          this.archiveRowMatches(
            { curTokens: rTokens, curRep: rRep, curHeadTokens: rHead, region: r.region },
            g.rows[0],
          )
        ) {
          g.rows.push(r);
          placed = true;
          break;
        }
      }
      if (!placed) groups.push({ rows: [r] });
    }

    const dupGroups = groups.filter((g) => g.rows.length > 1);
    let rowsAbsorbed = 0;
    const summary: Array<{ survivorHeadline: string; absorbed: number; totalSources: number; sampleHeadlines: string[] }> = [];

    for (const g of dupGroups) {
      // Live-row handling (Task #1088): a group may contain at most ONE live
      // row — that row becomes the survivor (its signature keeps resolving in
      // the live feed mapping) and only the not-live rows are absorbed into it.
      // Two live rows in one group means two concurrently-live stories the
      // cluster engine's own consolidation must reconcile first — merging
      // either away here would desync the live mapping, so skip (fail-closed).
      const liveInGroup = g.rows.filter((r) => liveSigs.has(r.signature));
      if (liveInGroup.length >= 2) continue;
      const survivor = liveInGroup[0] ?? g.rows[0]; // live row wins, else earliest first-seen
      const survivorIsLive = liveInGroup.length === 1;
      const absorbed = g.rows.filter((r) => r.id !== survivor.id);
      // Union members across the whole group so no source is lost.
      let mergedMembers: CuratedArchiveMember[] = survivor.members ?? [];
      for (const m of absorbed) mergedMembers = this.unionArchiveMembers(mergedMembers, m.members ?? []);
      // Freshest row (max lastSeenAt) supplies the display fields + lastSeenAt so the
      // collapsed row reflects the most recent version, without jumping to "now".
      const freshest = g.rows.reduce((f, c) =>
        new Date(c.lastSeenAt).getTime() > new Date(f.lastSeenAt).getTime() ? c : f, survivor);
      const earliestFirstSeen = g.rows.reduce(
        (min, c) => Math.min(min, new Date(c.firstSeenAt).getTime()),
        new Date(survivor.firstSeenAt).getTime(),
      );
      rowsAbsorbed += absorbed.length;
      summary.push({
        survivorHeadline: freshest.headline,
        absorbed: absorbed.length,
        totalSources: mergedMembers.length,
        sampleHeadlines: Array.from(new Set(g.rows.map((r) => r.headline))).slice(0, 4),
      });

      if (!dryRun) {
        await db.transaction(async (tx) => {
          await tx
            .delete(curatedStoryArchive)
            .where(inArray(curatedStoryArchive.id, absorbed.map((a) => a.id)));
          await tx
            .update(curatedStoryArchive)
            .set(
              survivorIsLive
                ? {
                    // A LIVE survivor's display fields are owned by the live
                    // upsert (its synthesis refreshes them every pass) — only
                    // fold in the absorbed rows' members + earliest origination.
                    // Never touch its lastSeenAt/headline here (fail-closed).
                    members: mergedMembers,
                    sourceCount: mergedMembers.length,
                    firstSeenAt: new Date(earliestFirstSeen),
                  }
                : {
                    headline: freshest.headline,
                    lede: freshest.lede,
                    facts: freshest.facts,
                    attributedClaims: freshest.attributedClaims,
                    category: freshest.category,
                    region: freshest.region,
                    country: freshest.country,
                    repTitle: freshest.repTitle,
                    repSource: freshest.repSource,
                    repUrl: freshest.repUrl,
                    ogImageUrl: freshest.ogImageUrl,
                    members: mergedMembers,
                    sourceCount: mergedMembers.length,
                    firstSeenAt: new Date(earliestFirstSeen),
                    lastSeenAt: freshest.lastSeenAt,
                  },
            )
            .where(eq(curatedStoryArchive.id, survivor.id));
        });
      }
    }

    // Largest groups first so the summary highlights the worst offenders.
    summary.sort((a, b) => b.absorbed - a.absorbed);
    return {
      dryRun,
      windowHours,
      scanned: rows.length,
      duplicateGroups: dupGroups.length,
      rowsAbsorbed,
      groups: summary,
    };
  }

  // One-time/maintenance pass that CLOSES the legacy over-age "zombie" rows the
  // pre-cap (pre-Task #334) carry-forward accreted — a single archive row holding
  // a multi-day blob of sources (e.g. 1,863 sources spanning 5 days) that displays
  // as one absurd story. The episode cap added going-forward cannot retroactively
  // bound these already-phased-out rows (they are never touched by a live pass
  // again), so this sweeps them: for each NOT-live row whose dated-member span
  // exceeds the episode cap, it bounds the stored members to the most-recent
  // episode window (drops dated members older than CURATED_EPISODE_HARD_AGE_MS
  // before the newest dated member), recomputes sourceCount, and pulls firstSeenAt
  // forward to the earliest RETAINED member so the row honestly reads as one
  // bounded, closed episode. It does NOT touch lastSeenAt (keeps real recency) and
  // never widens a row. dryRun (the default) returns the plan without writing.
  // Curated lane only.
  async boundOverAgeCuratedArchiveEpisodes(opts: { dryRun?: boolean; windowHours?: number }): Promise<{ dryRun: boolean; windowHours: number; scanned: number; boundedRows: number; sourcesRemoved: number; rows: Array<{ headline: string; before: number; after: number; spanHours: number }> }> {
    const dryRun = opts.dryRun !== false; // default TRUE (safe)
    const windowHours = Math.min(Math.max(opts.windowHours ?? 2160, 1), 24 * 90); // default 90d, max 90d
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    // Only NOT-live rows — a live story's current version must never be trimmed.
    const liveRows = await db
      .selectDistinct({ sig: curatedClusterMembers.clusterId })
      .from(curatedClusterMembers);
    const liveSigs = new Set(liveRows.map((r) => r.sig));
    const rows = (
      await db
        .select()
        .from(curatedStoryArchive)
        .where(gte(curatedStoryArchive.lastSeenAt, cutoff))
    ).filter((r) => !liveSigs.has(r.signature));

    let boundedRows = 0;
    let sourcesRemoved = 0;
    const affected: Array<{ headline: string; before: number; after: number; spanHours: number }> = [];

    for (const r of rows) {
      const members = (r.members ?? []) as CuratedArchiveMember[];
      const dated = members
        .map((m) => (m.publishedAt ? new Date(m.publishedAt).getTime() : NaN))
        .filter((t) => Number.isFinite(t)) as number[];
      if (dated.length === 0) continue; // cannot time-bound an undated row
      const newest = Math.max(...dated);
      const oldest = Math.min(...dated);
      if (newest - oldest <= CURATED_EPISODE_HARD_AGE_MS) continue; // already one episode
      const bounded = this.boundMembersToRecentEpisode(members);
      if (bounded.length >= members.length) continue; // nothing trimmed
      const retainedDated = bounded
        .map((m) => (m.publishedAt ? new Date(m.publishedAt).getTime() : NaN))
        .filter((t) => Number.isFinite(t)) as number[];
      const newFirstSeen = retainedDated.length > 0 ? Math.min(...retainedDated) : new Date(r.firstSeenAt).getTime();
      boundedRows += 1;
      sourcesRemoved += members.length - bounded.length;
      affected.push({
        headline: r.headline,
        before: members.length,
        after: bounded.length,
        spanHours: Math.round((newest - oldest) / 3_600_000),
      });
      if (!dryRun) {
        await db
          .update(curatedStoryArchive)
          .set({
            members: bounded,
            sourceCount: bounded.length,
            firstSeenAt: new Date(newFirstSeen),
          })
          .where(eq(curatedStoryArchive.id, r.id));
      }
    }

    affected.sort((a, b) => (b.before - b.after) - (a.before - a.after));
    return {
      dryRun,
      windowHours,
      scanned: rows.length,
      boundedRows,
      sourcesRemoved,
      rows: affected.slice(0, 50),
    };
  }

  // ---------------------------------------------------------------------------
  // Curated-only manual Priority overrides (allowlist-gated). Applied ONLY when
  // building the curated top-stories feed; never written to the main-feed
  // priority_override columns (curated lane isolation).
  // ---------------------------------------------------------------------------
  async getCuratedPriorityOverrides(): Promise<Map<string, number>> {
    const rows = await db.select().from(curatedPriorityOverrides);
    return new Map(rows.map((r) => [r.key, r.priorityScore]));
  }

  async setCuratedPriorityOverride(key: string, priorityScore: number, updatedBy: string): Promise<void> {
    await db
      .insert(curatedPriorityOverrides)
      .values({ key, priorityScore, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: curatedPriorityOverrides.key,
        set: { priorityScore, updatedBy, updatedAt: new Date() },
      });
  }

  // ---------------------------------------------------------------------------
  // Curated lane (Task #226) — dead-link tracking + allowlist-gated replacement
  // overlay. CURATED-ONLY: read/written solely by the curated-gated endpoints,
  // the curated liveness cron, and the curated enrichment path. Never touches
  // headlines/manual_submissions (lane isolation).
  // ---------------------------------------------------------------------------
  async getCuratedLinkReplacements(): Promise<Map<string, string>> {
    const rows = await db.select().from(curatedLinkReplacements);
    return new Map(rows.map((r) => [r.key, r.url]));
  }

  async setCuratedLinkReplacement(key: string, url: string, updatedBy: string): Promise<void> {
    await db
      .insert(curatedLinkReplacements)
      .values({ key, url, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: curatedLinkReplacements.key,
        set: { url, updatedBy, updatedAt: new Date() },
      });
  }

  // ---------------------------------------------------------------------------
  // Curated-only editor HIDE overlay (Task #380). Allowlist-gated take-down of a
  // bad curated story. CURATED-ONLY: read/written solely by the curated-gated
  // endpoints. Never touches headlines/manual_submissions or any non-curated
  // reader (lane isolation).
  // ---------------------------------------------------------------------------
  async getCuratedHiddenStories(): Promise<CuratedHiddenStory[]> {
    return await db.select().from(curatedHiddenStories);
  }

  async setCuratedHiddenStory(key: string, clusterId: string | null, memberKeys: string[], hiddenBy: string): Promise<void> {
    await db
      .insert(curatedHiddenStories)
      .values({ key, clusterId, memberKeys, hiddenBy, hiddenAt: new Date() })
      .onConflictDoUpdate({
        target: curatedHiddenStories.key,
        set: { clusterId, memberKeys, hiddenBy, hiddenAt: new Date() },
      });
  }

  async removeCuratedHiddenStory(key: string): Promise<void> {
    await db.delete(curatedHiddenStories).where(eq(curatedHiddenStories.key, key));
  }

  // ---------------------------------------------------------------------------
  // Curated-only editor PHOTO overlays (Task #380 expansion). Allowlist-gated
  // single-source image replacement + cluster member photo hide. CURATED-ONLY:
  // read/written solely by the curated-gated endpoints. Never touches
  // headlines/manual_submissions or any non-curated reader (lane isolation).
  // ---------------------------------------------------------------------------
  async getCuratedImageReplacements(): Promise<Map<string, string>> {
    const rows = await db.select().from(curatedImageReplacements);
    return new Map(rows.map((r) => [r.key, r.url]));
  }

  async setCuratedImageReplacement(key: string, url: string, updatedBy: string): Promise<void> {
    await db
      .insert(curatedImageReplacements)
      .values({ key, url, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: curatedImageReplacements.key,
        set: { url, updatedBy, updatedAt: new Date() },
      });
  }

  async removeCuratedImageReplacement(key: string): Promise<void> {
    await db.delete(curatedImageReplacements).where(eq(curatedImageReplacements.key, key));
  }

  async getCuratedHiddenImages(): Promise<Set<string>> {
    const rows = await db.select().from(curatedHiddenImages);
    return new Set(rows.map((r) => r.imageUrl));
  }

  async setCuratedHiddenImage(imageUrl: string, hiddenBy: string): Promise<void> {
    await db
      .insert(curatedHiddenImages)
      .values({ imageUrl, hiddenBy, hiddenAt: new Date() })
      .onConflictDoNothing({ target: curatedHiddenImages.imageUrl });
  }

  async removeCuratedHiddenImage(imageUrl: string): Promise<void> {
    await db.delete(curatedHiddenImages).where(eq(curatedHiddenImages.imageUrl, imageUrl));
  }

  // ---------------------------------------------------------------------------
  // Curated lane — editor HEADLINE + BULLETS + CLAIMS overlay. Allowlist-gated,
  // CURATED-ONLY: stores display-only corrections. NEVER touches headlines/manual_submissions or any non-curated
  // reader (lane isolation). The stored title/normalizedTitle is never mutated.
  // ---------------------------------------------------------------------------
  async getCuratedHeadlineOverrides(): Promise<Map<string, { headline: string | null; bullets: string[] | null; claims: string[] | null; provenance: string }>> {
    const rows = await db.select().from(curatedHeadlineOverrides);
    return new Map(rows.map((r) => [r.key, { headline: r.headline ?? null, bullets: r.bullets ?? null, claims: r.claims ?? null, provenance: r.provenance ?? 'human' }]));
  }

  // provenance defaults to 'human' — the manual #176 editor path. A 'human' row
  // is protected: the automated repair writer (setAutoCuratedHeadlineOverride)
  // never clobbers it. A human edit always wins (overwrites an 'auto' row).
  async setCuratedHeadlineOverride(key: string, headline: string | null, bullets: string[] | null, claims: string[] | null, updatedBy: string, provenance: string = 'human'): Promise<void> {
    await db
      .insert(curatedHeadlineOverrides)
      .values({ key, headline, bullets, claims, updatedBy, updatedAt: new Date(), provenance })
      .onConflictDoUpdate({
        target: curatedHeadlineOverrides.key,
        set: { headline, bullets, claims, updatedBy, updatedAt: new Date(), provenance },
      });
  }

  // Automated headline repair (Task #176 automated counterpart). Writes an
  // 'auto'-provenance headline override ONLY when no row exists or the existing
  // row is itself 'auto' — a human ('human') override is NEVER clobbered. Single
  // conditional upsert (no read-then-write race). Headline-only (never bullets).
  async setAutoCuratedHeadlineOverride(key: string, headline: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO curated_headline_overrides (key, headline, bullets, claims, updated_by, updated_at, provenance)
      VALUES (${key}, ${headline}, NULL, NULL, 'auto', NOW(), 'auto')
      ON CONFLICT (key) DO UPDATE SET
        headline = EXCLUDED.headline,
        updated_by = 'auto',
        updated_at = NOW(),
        provenance = 'auto'
      WHERE curated_headline_overrides.provenance <> 'human'
    `);
  }

  async removeCuratedHeadlineOverride(key: string): Promise<void> {
    await db.delete(curatedHeadlineOverrides).where(eq(curatedHeadlineOverrides.key, key));
  }

  // Liveness round-robin: curated rows inside the display window, oldest-checked
  // first (never-checked rows — NULL link_checked_at — come first), capped so a
  // single cron tick does a bounded number of outbound probes.
  async getCuratedItemsForLinkCheck(hours: number, maxItems: number): Promise<CuratedItem[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await db
      .select()
      .from(curatedItems)
      .where(gte(curatedItems.scrapedAt, cutoff))
      .orderBy(sql`${curatedItems.linkCheckedAt} ASC NULLS FIRST`)
      .limit(maxItems);
  }

  // Stamp the result of one liveness probe. Always advances link_checked_at so
  // the round-robin moves on. 'dead' sets link_dead_at (preserving the original
  // first-dead time via COALESCE so the displayed "unavailable since" stays
  // stable); 'alive' clears it (a 2xx revival); 'unknown' (transient 5xx/timeout/
  // 403/429/network) leaves the flag untouched — never flag on a transient error.
  async recordCuratedLinkCheck(id: string, result: 'dead' | 'alive' | 'unknown'): Promise<void> {
    const now = new Date();
    if (result === 'dead') {
      await db.update(curatedItems).set({
        linkDeadAt: sql`COALESCE(${curatedItems.linkDeadAt}, ${now})`,
        linkCheckedAt: now,
      }).where(eq(curatedItems.id, id));
    } else if (result === 'alive') {
      await db.update(curatedItems).set({
        linkDeadAt: null,
        linkCheckedAt: now,
      }).where(eq(curatedItems.id, id));
    } else {
      await db.update(curatedItems).set({
        linkCheckedAt: now,
      }).where(eq(curatedItems.id, id));
    }
  }

  // After an allowlisted user stores a replacement URL: clear the dead flag and
  // RESET the enrichment state (media_scraped_at/attempt counters/checked-at) so
  // the prefetch+backfill+liveness path re-fetches photo/bullets and re-probes
  // from the new (overlay) URL on the next cycle. curated_items.url is left
  // UNCHANGED so clustering identity stays stable.
  async applyCuratedLinkReplacement(id: string): Promise<void> {
    await db.update(curatedItems).set({
      linkDeadAt: null,
      mediaScrapedAt: null,
      mediaAttemptCount: 0,
      lastMediaAttemptAt: null,
      linkCheckedAt: null,
    }).where(eq(curatedItems.id, id));
  }

  async getCompetingCoverage(): Promise<{ domestic: CompetingCoverageItem[]; international: CompetingCoverageItem[]; buzz: CompetingCoverageItem[]; updatedAt: number | null }> {
    const rows = await db.select().from(competingCoverageCache);
    let domestic: CompetingCoverageItem[] = [];
    let international: CompetingCoverageItem[] = [];
    let buzz: CompetingCoverageItem[] = [];
    let updatedAt: number | null = null;
    for (const r of rows) {
      if (r.scope === "domestic") domestic = r.items;
      else if (r.scope === "international") international = r.items;
      else if (r.scope === "buzz") buzz = r.items;
      // Buzz refreshes on its own (best-effort) cadence and may be stale or absent;
      // keep the "as of" stamp tied to the coverage backbone only.
      if (r.scope !== "buzz") {
        const t = r.updatedAt ? new Date(r.updatedAt).getTime() : null;
        if (t && (updatedAt === null || t > updatedAt)) updatedAt = t;
      }
    }
    return { domestic, international, buzz, updatedAt };
  }

  async upsertCompetingCoverage(scope: string, items: CompetingCoverageItem[]): Promise<void> {
    await db
      .insert(competingCoverageCache)
      .values({ scope, items, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: competingCoverageCache.scope,
        set: { items, updatedAt: new Date() },
      });
  }

  async updateHeadlinePriority(id: string, priorityOverride: number | null): Promise<void> {
    if (priorityOverride === null) {
      await db
        .update(headlines)
        .set({ priorityOverride: null, priorityOverrideAt: null })
        .where(eq(headlines.id, id));
      return;
    }

    const [existing] = await db.select({
      priorityScore: headlines.priorityScore,
      priorityOverride: headlines.priorityOverride,
      priorityOverrideAt: headlines.priorityOverrideAt,
    }).from(headlines).where(eq(headlines.id, id)).limit(1);

    const effectiveOldPriority = existing?.priorityOverride ?? existing?.priorityScore ?? 0;
    const isIncrease = priorityOverride > effectiveOldPriority;

    await db
      .update(headlines)
      .set({
        priorityOverride,
        priorityOverrideAt: isIncrease ? new Date() : (existing?.priorityOverrideAt ?? null),
      })
      .where(eq(headlines.id, id));
  }

  async updateManualSubmissionPriority(id: string, priorityOverride: number | null): Promise<void> {
    if (priorityOverride === null) {
      await db
        .update(manualSubmissions)
        .set({ priorityOverride: null, priorityOverrideAt: null })
        .where(eq(manualSubmissions.id, id));
      return;
    }

    const [existing] = await db.select({
      priorityScore: manualSubmissions.priorityScore,
      priorityOverride: manualSubmissions.priorityOverride,
      priorityOverrideAt: manualSubmissions.priorityOverrideAt,
    }).from(manualSubmissions).where(eq(manualSubmissions.id, id)).limit(1);

    const effectiveOldPriority = existing?.priorityOverride ?? existing?.priorityScore ?? 0;
    const isIncrease = priorityOverride > effectiveOldPriority;

    await db
      .update(manualSubmissions)
      .set({
        priorityOverride,
        priorityOverrideAt: isIncrease ? new Date() : (existing?.priorityOverrideAt ?? null),
      })
      .where(eq(manualSubmissions.id, id));
  }

  async updateHeadlineTitle(id: string, title: string, normalizedTitle: string): Promise<void> {
    await db
      .update(headlines)
      .set({ title, normalizedTitle })
      .where(eq(headlines.id, id));
  }

  async updateManualSubmissionTitle(id: string, title: string): Promise<void> {
    await db
      .update(manualSubmissions)
      .set({ title })
      .where(eq(manualSubmissions.id, id));
  }

  async updateHeadlineUrl(id: string, url: string): Promise<void> {
    await db
      .update(headlines)
      .set({ url })
      .where(eq(headlines.id, id));
  }

  async updateManualSubmissionUrl(id: string, url: string): Promise<void> {
    await db
      .update(manualSubmissions)
      .set({ url })
      .where(eq(manualSubmissions.id, id));
  }

  async blockHeadline(id: string, type?: 'scraped' | 'manual'): Promise<void> {
    try {
      let normalizedTitle: string | null = null;

      if (type !== 'manual') {
        const [headline] = await db
          .select()
          .from(headlines)
          .where(eq(headlines.id, id));
        if (headline) {
          normalizedTitle = headline.normalizedTitle;
          await db
            .insert(blockedHeadlines)
            .values({ normalizedTitle })
            .onConflictDoNothing();
          await db.delete(headlines).where(eq(headlines.id, id));
          return;
        }
      }

      if (type !== 'scraped') {
        const [manual] = await db
          .select()
          .from(manualSubmissions)
          .where(eq(manualSubmissions.id, id));
        if (manual) {
          normalizedTitle = manual.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
          await db
            .insert(blockedHeadlines)
            .values({ normalizedTitle })
            .onConflictDoNothing();
          await db.delete(manualSubmissions).where(eq(manualSubmissions.id, id));
          return;
        }
      }

      throw new Error('Headline not found');
    } catch (error: any) {
      if (error.message === 'Headline not found') throw error;
      console.error('Error blocking headline:', error);
      throw new Error('Failed to block headline');
    }
  }

  async isHeadlineBlocked(normalizedTitle: string): Promise<boolean> {
    const [blocked] = await db
      .select()
      .from(blockedHeadlines)
      .where(eq(blockedHeadlines.normalizedTitle, normalizedTitle));
    
    return !!blocked;
  }

  async getRecentTruthSocialPosts(limit: number, includeHidden: boolean = false): Promise<TruthSocialPost[]> {
    if (includeHidden) {
      return await db
        .select()
        .from(truthSocialPosts)
        .orderBy(desc(truthSocialPosts.postedAt))
        .limit(limit);
    }
    return await db
      .select()
      .from(truthSocialPosts)
      .where(eq(truthSocialPosts.isHidden, false))
      .orderBy(desc(truthSocialPosts.postedAt))
      .limit(limit);
  }

  async getCuratedTruthSocialPosts(since: Date, maxRows: number): Promise<TruthSocialPost[]> {
    return await db
      .select()
      .from(truthSocialPosts)
      .where(and(
        eq(truthSocialPosts.isHidden, false),
        gte(truthSocialPosts.postedAt, since)
      ))
      .orderBy(desc(truthSocialPosts.postedAt))
      .limit(maxRows);
  }

  async hideTruthSocialPost(id: string, hidden: boolean): Promise<void> {
    await db
      .update(truthSocialPosts)
      .set({ isHidden: hidden })
      .where(eq(truthSocialPosts.id, id));
  }

  async addTruthSocialPost(insertPost: InsertTruthSocialPost): Promise<TruthSocialPost> {
    const [post] = await db
      .insert(truthSocialPosts)
      .values(insertPost)
      .returning();
    return post;
  }

  async getTruthSocialPostByPostId(postId: string): Promise<TruthSocialPost | undefined> {
    const [post] = await db
      .select()
      .from(truthSocialPosts)
      .where(eq(truthSocialPosts.postId, postId));
    return post || undefined;
  }

  async getTruthSocialPostByContentPrefix(contentPrefix: string): Promise<TruthSocialPost | undefined> {
    const [post] = await db
      .select()
      .from(truthSocialPosts)
      .where(like(truthSocialPosts.content, `${contentPrefix}%`));
    return post || undefined;
  }

  async getTruthSocialPostByTruthSocialUrl(truthSocialUrl: string): Promise<TruthSocialPost | undefined> {
    const [post] = await db
      .select()
      .from(truthSocialPosts)
      .where(eq(truthSocialPosts.truthSocialUrl, truthSocialUrl));
    return post || undefined;
  }

  async updateTruthSocialPost(id: string, fields: Partial<InsertTruthSocialPost>): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    await db.update(truthSocialPosts).set(fields).where(eq(truthSocialPosts.id, id));
  }

  async updateTruthSocialPostImage(id: string, imageUrl: string | null): Promise<void> {
    await db
      .update(truthSocialPosts)
      .set({ imageUrl })
      .where(eq(truthSocialPosts.id, id));
  }

  async updateTruthSocialPostMedia(
    id: string,
    fields: { imageUrl?: string | null; videoUrl?: string | null; videoThumbnailUrl?: string | null }
  ): Promise<void> {
    const update: Record<string, string | null> = {};
    if (fields.imageUrl !== undefined) update.imageUrl = fields.imageUrl;
    if (fields.videoUrl !== undefined) update.videoUrl = fields.videoUrl;
    if (fields.videoThumbnailUrl !== undefined) update.videoThumbnailUrl = fields.videoThumbnailUrl;
    if (Object.keys(update).length === 0) return;
    await db.update(truthSocialPosts).set(update).where(eq(truthSocialPosts.id, id));
  }

  async updateTruthSocialPostExtractedText(id: string, extractedImageText: string): Promise<void> {
    await db
      .update(truthSocialPosts)
      .set({ extractedImageText })
      .where(eq(truthSocialPosts.id, id));
  }

  async deleteTruthSocialPost(id: string): Promise<void> {
    await db.delete(truthSocialPosts).where(eq(truthSocialPosts.id, id));
  }

  async clearAllTruthSocialPosts(): Promise<number> {
    const allPosts = await db.select().from(truthSocialPosts);
    const count = allPosts.length;
    await db.delete(truthSocialPosts);
    return count;
  }

  async getRecentXPosts(limit: number): Promise<XPost[]> {
    return await db
      .select()
      .from(xPosts)
      .where(and(
        eq(xPosts.isHidden, false),
        sql`${xPosts.accountCategory} <> 'influencer'`
      ))
      .orderBy(desc(xPosts.postedAt))
      .limit(limit);
  }

  async getCuratedXPosts(since: Date, maxRows: number): Promise<XPost[]> {
    return await db
      .select()
      .from(xPosts)
      .where(and(
        eq(xPosts.isHidden, false),
        sql`${xPosts.accountCategory} <> 'influencer'`,
        gte(xPosts.postedAt, since)
      ))
      .orderBy(desc(xPosts.postedAt))
      .limit(maxRows);
  }

  async getRecentInfluencerXPosts(limit: number): Promise<XPost[]> {
    return await db
      .select()
      .from(xPosts)
      .where(and(
        eq(xPosts.isHidden, false),
        eq(xPosts.accountCategory, 'influencer')
      ))
      .orderBy(desc(xPosts.postedAt))
      .limit(limit);
  }

  async addXPost(insertPost: InsertXPost): Promise<XPost> {
    const [post] = await db
      .insert(xPosts)
      .values(insertPost)
      .returning();
    return post;
  }

  async getXPostByPostId(postId: string): Promise<XPost | undefined> {
    const [post] = await db
      .select()
      .from(xPosts)
      .where(eq(xPosts.postId, postId));
    return post || undefined;
  }

  async getRecentRapidResponsePosts(limit: number): Promise<RapidResponsePost[]> {
    return await db
      .select()
      .from(rapidResponsePosts)
      .where(eq(rapidResponsePosts.isHidden, false))
      .orderBy(desc(rapidResponsePosts.postedAt))
      .limit(limit);
  }

  async getCuratedRapidResponsePosts(since: Date, maxRows: number): Promise<RapidResponsePost[]> {
    return await db
      .select()
      .from(rapidResponsePosts)
      .where(and(
        eq(rapidResponsePosts.isHidden, false),
        gte(rapidResponsePosts.postedAt, since)
      ))
      .orderBy(desc(rapidResponsePosts.postedAt))
      .limit(maxRows);
  }

  async addRapidResponsePost(insertPost: InsertRapidResponsePost): Promise<RapidResponsePost> {
    const [post] = await db
      .insert(rapidResponsePosts)
      .values(insertPost)
      .returning();
    return post;
  }

  async getRapidResponsePostByPostId(postId: string): Promise<RapidResponsePost | undefined> {
    const [post] = await db
      .select()
      .from(rapidResponsePosts)
      .where(eq(rapidResponsePosts.postId, postId));
    return post || undefined;
  }

  async getRecentDOWResponsePosts(limit: number): Promise<DOWResponsePost[]> {
    return await db
      .select()
      .from(dowResponsePosts)
      .where(eq(dowResponsePosts.isHidden, false))
      .orderBy(desc(dowResponsePosts.postedAt))
      .limit(limit);
  }

  async getCuratedDOWResponsePosts(since: Date, maxRows: number): Promise<DOWResponsePost[]> {
    return await db
      .select()
      .from(dowResponsePosts)
      .where(and(
        eq(dowResponsePosts.isHidden, false),
        gte(dowResponsePosts.postedAt, since)
      ))
      .orderBy(desc(dowResponsePosts.postedAt))
      .limit(maxRows);
  }

  async addDOWResponsePost(insertPost: InsertDOWResponsePost): Promise<DOWResponsePost> {
    const [post] = await db
      .insert(dowResponsePosts)
      .values(insertPost)
      .returning();
    return post;
  }

  async getDOWResponsePostByPostId(postId: string): Promise<DOWResponsePost | undefined> {
    const [post] = await db
      .select()
      .from(dowResponsePosts)
      .where(eq(dowResponsePosts.postId, postId));
    return post || undefined;
  }

  async getRecentSentDefenderPosts(limit: number): Promise<SentDefenderPost[]> {
    return await db
      .select()
      .from(sentDefenderPosts)
      .where(eq(sentDefenderPosts.isHidden, false))
      .orderBy(desc(sentDefenderPosts.postedAt))
      .limit(limit);
  }

  async getCuratedSentDefenderPosts(since: Date, maxRows: number): Promise<SentDefenderPost[]> {
    return await db
      .select()
      .from(sentDefenderPosts)
      .where(and(
        eq(sentDefenderPosts.isHidden, false),
        gte(sentDefenderPosts.postedAt, since)
      ))
      .orderBy(desc(sentDefenderPosts.postedAt))
      .limit(maxRows);
  }

  async addSentDefenderPost(insertPost: InsertSentDefenderPost): Promise<SentDefenderPost> {
    const [post] = await db
      .insert(sentDefenderPosts)
      .values(insertPost)
      .returning();
    return post;
  }

  async getSentDefenderPostByPostId(postId: string): Promise<SentDefenderPost | undefined> {
    const [post] = await db
      .select()
      .from(sentDefenderPosts)
      .where(eq(sentDefenderPosts.postId, postId));
    return post || undefined;
  }

  async getRecentOsintPosts(limit: number, sourceAccount?: string): Promise<OsintPost[]> {
    // Combatant-command handles are curated-only: hide them from the main OSINT
    // feed even when explicitly requested by account. See server/curatedOnlyOsint.ts.
    if (sourceAccount) {
      return await db
        .select()
        .from(osintPosts)
        .where(and(
          eq(osintPosts.sourceAccount, sourceAccount),
          eq(osintPosts.isHidden, false),
          notInArray(osintPosts.sourceAccount, [...CURATED_ONLY_OSINT_HANDLES]),
        ))
        .orderBy(desc(osintPosts.postedAt))
        .limit(limit);
    }
    return await db
      .select()
      .from(osintPosts)
      .where(and(
        eq(osintPosts.isHidden, false),
        notInArray(osintPosts.sourceAccount, [...CURATED_ONLY_OSINT_HANDLES]),
      ))
      .orderBy(desc(osintPosts.postedAt))
      .limit(limit);
  }

  async getCuratedOsintPosts(since: Date, maxRows: number, sourceAccount: string): Promise<OsintPost[]> {
    return await db
      .select()
      .from(osintPosts)
      .where(and(
        eq(osintPosts.sourceAccount, sourceAccount),
        eq(osintPosts.isHidden, false),
        gte(osintPosts.postedAt, since)
      ))
      .orderBy(desc(osintPosts.postedAt))
      .limit(maxRows);
  }

  async addOsintPost(insertPost: InsertOsintPost): Promise<OsintPost> {
    const [post] = await db
      .insert(osintPosts)
      .values(insertPost)
      .returning();
    return post;
  }

  async getOsintPostByPostId(postId: string): Promise<OsintPost | undefined> {
    const [post] = await db
      .select()
      .from(osintPosts)
      .where(eq(osintPosts.postId, postId));
    return post || undefined;
  }

  async getRecentJournalistPosts(limit: number, sourceAccount?: string): Promise<JournalistPost[]> {
    if (sourceAccount) {
      return await db
        .select()
        .from(journalistPosts)
        .where(and(eq(journalistPosts.sourceAccount, sourceAccount), eq(journalistPosts.isHidden, false)))
        .orderBy(desc(journalistPosts.postedAt))
        .limit(limit);
    }
    return await db
      .select()
      .from(journalistPosts)
      .where(eq(journalistPosts.isHidden, false))
      .orderBy(desc(journalistPosts.postedAt))
      .limit(limit);
  }

  async getCuratedJournalistPosts(since: Date, maxRows: number, sourceAccount: string): Promise<JournalistPost[]> {
    return await db
      .select()
      .from(journalistPosts)
      .where(and(
        eq(journalistPosts.sourceAccount, sourceAccount),
        eq(journalistPosts.isHidden, false),
        gte(journalistPosts.postedAt, since)
      ))
      .orderBy(desc(journalistPosts.postedAt))
      .limit(maxRows);
  }

  async addJournalistPost(insertPost: InsertJournalistPost): Promise<JournalistPost> {
    const [post] = await db
      .insert(journalistPosts)
      .values(insertPost)
      .returning();
    return post;
  }

  async getJournalistPostByPostId(postId: string): Promise<JournalistPost | undefined> {
    const [post] = await db
      .select()
      .from(journalistPosts)
      .where(eq(journalistPosts.postId, postId));
    return post || undefined;
  }

  async getRecentFlightTrackingPosts(limit: number): Promise<FlightTrackingPost[]> {
    return await db
      .select()
      .from(flightTrackingPosts)
      .where(eq(flightTrackingPosts.isHidden, false))
      .orderBy(desc(flightTrackingPosts.postedAt))
      .limit(limit);
  }

  async addFlightTrackingPost(insertPost: InsertFlightTrackingPost): Promise<FlightTrackingPost> {
    const [post] = await db
      .insert(flightTrackingPosts)
      .values(insertPost)
      .returning();
    return post;
  }

  async getFlightTrackingPostByPostId(postId: string): Promise<FlightTrackingPost | undefined> {
    const [post] = await db
      .select()
      .from(flightTrackingPosts)
      .where(eq(flightTrackingPosts.postId, postId));
    return post || undefined;
  }

  async getAllXFeedPosts(limit: number): Promise<any[]> {
    const [xResults, rapidResults, dowResults, sentResults, osintResults, flightResults] = await Promise.all([
      db.select().from(xPosts).orderBy(desc(xPosts.postedAt)).limit(limit),
      db.select().from(rapidResponsePosts).orderBy(desc(rapidResponsePosts.postedAt)).limit(limit),
      db.select().from(dowResponsePosts).orderBy(desc(dowResponsePosts.postedAt)).limit(limit),
      db.select().from(sentDefenderPosts).orderBy(desc(sentDefenderPosts.postedAt)).limit(limit),
      db.select().from(osintPosts).where(notInArray(osintPosts.sourceAccount, [...CURATED_ONLY_OSINT_HANDLES])).orderBy(desc(osintPosts.postedAt)).limit(limit),
      db.select().from(flightTrackingPosts).orderBy(desc(flightTrackingPosts.postedAt)).limit(limit),
    ]);

    const tagged = [
      ...xResults.map(p => ({ ...p, source: 'x_posts' as const })),
      ...rapidResults.map(p => ({ ...p, source: 'rapid' as const })),
      ...dowResults.map(p => ({ ...p, source: 'dow' as const })),
      ...sentResults.map(p => ({ ...p, source: 'sentdefender' as const })),
      ...osintResults.map(p => ({ ...p, source: 'osint' as const })),
      ...flightResults.map(p => ({ ...p, source: 'flight' as const })),
    ];

    tagged.sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());
    return tagged.slice(0, limit);
  }

  async hideXFeedPost(source: string, id: string, hidden: boolean): Promise<void> {
    switch (source) {
      case 'x_posts':
        await db.update(xPosts).set({ isHidden: hidden }).where(eq(xPosts.id, id));
        break;
      case 'rapid':
        await db.update(rapidResponsePosts).set({ isHidden: hidden }).where(eq(rapidResponsePosts.id, id));
        break;
      case 'dow':
        await db.update(dowResponsePosts).set({ isHidden: hidden }).where(eq(dowResponsePosts.id, id));
        break;
      case 'sentdefender':
        await db.update(sentDefenderPosts).set({ isHidden: hidden }).where(eq(sentDefenderPosts.id, id));
        break;
      case 'osint':
        await db.update(osintPosts).set({ isHidden: hidden }).where(eq(osintPosts.id, id));
        break;
      case 'flight':
        await db.update(flightTrackingPosts).set({ isHidden: hidden }).where(eq(flightTrackingPosts.id, id));
        break;
      default:
        throw new Error(`Unknown source: ${source}`);
    }
  }


  async getAllManualSubmissions(): Promise<ManualSubmission[]> {
    return await db
      .select()
      .from(manualSubmissions)
      .orderBy(desc(manualSubmissions.priorityScore), desc(manualSubmissions.submittedAt));
  }

  // Targeted exact-URL lookup (matches the raw stored url, same as the prior
  // getAllManualSubmissions().some(s => s.url === url) dedup check) so the
  // reviewed-submission path can dedup in O(1) instead of scanning every row.
  async getManualSubmissionByUrl(url: string): Promise<ManualSubmission | undefined> {
    const [submission] = await db
      .select()
      .from(manualSubmissions)
      .where(eq(manualSubmissions.url, url))
      .limit(1);
    return submission;
  }

  async getRecentManualSubmissions(hours: number): Promise<ManualSubmission[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await db
      .select()
      .from(manualSubmissions)
      .where(gte(manualSubmissions.submittedAt, cutoff))
      .orderBy(desc(manualSubmissions.priorityScore), desc(manualSubmissions.submittedAt));
  }

  async addManualSubmission(insertSubmission: InsertManualSubmission): Promise<ManualSubmission> {
    // Strip any leading AI audience-framing preamble / heading the model echoed
    // before it is persisted and can reach a feed surface. No-op on clean prose.
    // Plausibility-bound the article publish date at this single chokepoint
    // (same bound the curated intake applies, Task #653): callers pass dates
    // from several upstream sources (team-sub RSS pubDate, link-analysis
    // extraction) and a malformed/future value must never stamp a misleading
    // "Published" date. Implausible collapses to null → UI shows "First seen".
    const rawPub = insertSubmission.articlePublishedAt
      ? new Date(insertSubmission.articlePublishedAt)
      : null;
    const boundedPub =
      rawPub && !isNaN(rawPub.getTime()) &&
      rawPub.getFullYear() > 2000 &&
      rawPub.getTime() <= Date.now()
        ? rawPub
        : null;
    const values: InsertManualSubmission = {
      ...insertSubmission,
      summary: stripBriefingPreamble(insertSubmission.summary),
      articlePublishedAt: boundedPub,
    };
    const [submission] = await db
      .insert(manualSubmissions)
      .values(values)
      .returning();
    return submission;
  }

  async getManualSubmissionById(id: string): Promise<ManualSubmission | undefined> {
    const [submission] = await db
      .select()
      .from(manualSubmissions)
      .where(eq(manualSubmissions.id, id));
    return submission || undefined;
  }

  async getRecentFirstAlerts(limit: number): Promise<FirstAlert[]> {
    return await db
      .select()
      .from(firstAlerts)
      .orderBy(desc(firstAlerts.publishedAt))
      .limit(limit);
  }

  async addFirstAlert(insertAlert: InsertFirstAlert): Promise<FirstAlert> {
    const [alert] = await db
      .insert(firstAlerts)
      .values(insertAlert)
      .returning();
    return alert;
  }

  async getFirstAlertByAlertId(alertId: string): Promise<FirstAlert | undefined> {
    const [alert] = await db
      .select()
      .from(firstAlerts)
      .where(eq(firstAlerts.alertId, alertId));
    return alert || undefined;
  }

  async getDataMinrNewsArticles(hours: number): Promise<FirstAlert[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await db
      .select()
      .from(firstAlerts)
      .where(sql`${firstAlerts.publicPostLink} IS NULL AND ${firstAlerts.publishedAt} >= ${cutoff}`)
      .orderBy(desc(firstAlerts.publishedAt));
  }

  async getPrimaryFeed(hours: number, limit?: number, mcopSlug?: string): Promise<Array<Headline & { pdfPath?: string | null; type: 'scraped' | 'manual'; originalPriority: number; depreciatedPriority: number }>> {
    // Get recent headlines and manual submissions from the specified time window
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    // restricted_to_mcops gating:
    // - No slug passed (main MCOP, Stream, /war, prefetch, public API):
    //     only rows with restricted_to_mcops IS NULL.
    // - Slug passed (custom MCOP feed):
    //     rows with IS NULL OR slug = ANY(restricted_to_mcops).
    const restrictionFilter = mcopSlug
      ? sql`(${headlines.restrictedToMcops} IS NULL OR ${mcopSlug} = ANY(${headlines.restrictedToMcops}))`
      : sql`${headlines.restrictedToMcops} IS NULL`;

    // T001: bound the worst-case rows materialized here. getPrimaryFeed builds a
    // combined in-memory array and dedupes it O(n^2); with no SQL cap, a busy 48h
    // window could materialize thousands of rows on a memory-starved VM. Each
    // source is fetched MOST-RECENT-FIRST and capped at PRIMARY_FEED_FETCH_CAP.
    // The final ranking sort below is by AGE-DECAYED priority, so the only rows a
    // generous cap can drop are the oldest in the window — which already rank at
    // the bottom and never reach any feed's visible slice. Both columns are
    // indexed (scraped_at_idx / manual_submitted_at_idx), so ORDER BY ... LIMIT is
    // index-backed, not a full sort. Semantics-preserving for the visible feed.
    const PRIMARY_FEED_FETCH_CAP = 1000;

    // Fetch headlines - filter by scrapedAt (when they appeared on Drudge)
    // Only include headlines that are either:
    // 1. Not in a cluster (clusterId is null), OR
    // 2. The representative of their cluster (isClusterRepresentative is true)
    const recentHeadlines = await db
      .select()
      .from(headlines)
      .where(
        and(
          gte(headlines.scrapedAt, cutoff),
          or(
            isNull(headlines.clusterId),
            eq(headlines.isClusterRepresentative, true)
          ),
          restrictionFilter
        )
      )
      .orderBy(desc(headlines.scrapedAt))
      .limit(PRIMARY_FEED_FETCH_CAP);
    
    // Fetch manual submissions - same logic for clusters
    const recentSubmissions = await db
      .select()
      .from(manualSubmissions)
      .where(
        and(
          gte(manualSubmissions.submittedAt, cutoff),
          or(
            isNull(manualSubmissions.clusterId),
            eq(manualSubmissions.isClusterRepresentative, true)
          )
        )
      )
      .orderBy(desc(manualSubmissions.submittedAt))
      .limit(PRIMARY_FEED_FETCH_CAP);
    
    // Convert to unified format with type discriminator and depreciated priority
    type CombinedHeadline = Headline & { pdfPath?: string | null; type: 'scraped' | 'manual'; originalPriority: number; depreciatedPriority: number };
    
    const combined: CombinedHeadline[] = [
      ...recentHeadlines.map(h => {
        const { originalPriority, depreciatedPriority } = calculateDepreciatedPriority(
          h.priorityScore, 
          h.priorityOverride, 
          h.scrapedAt, 
          h.priorityOverrideAt,
          h.articlePublishedAt
        );
        return { 
          ...h, 
          pdfPath: undefined as string | null | undefined, 
          type: 'scraped' as const,
          originalPriority,
          depreciatedPriority
        };
      }),
      ...recentSubmissions.map(sub => {
        const { originalPriority, depreciatedPriority } = calculateDepreciatedPriority(
          sub.priorityScore, 
          sub.priorityOverride, 
          sub.submittedAt, 
          sub.priorityOverrideAt
        );
        return {
          id: sub.id,
          title: sub.title,
          normalizedTitle: sub.title.toLowerCase(),
          url: sub.url,
          category: sub.category,
          source: sub.source,
          summary: sub.summary,
          scrapedAt: sub.submittedAt,
          // Real publish date only — never fabricate one from submittedAt.
          // NULL flows through to the curated view, which then honestly
          // renders "First seen" (its trusted-signal fallback) instead of a
          // fake fresh "Published" stamp for old team-promoted articles.
          articlePublishedAt: sub.articlePublishedAt ?? null,
          priorityScore: sub.priorityScore,
          priorityOverride: sub.priorityOverride,
          priorityOverrideAt: sub.priorityOverrideAt,
          tags: sub.tags,
          pdfPath: sub.pdfPath,
          clusterId: sub.clusterId,
          isClusterRepresentative: sub.isClusterRepresentative,
          ogImageUrl: sub.ogImageUrl ?? null,
          videoUrl: sub.videoUrl ?? null,
          summaryBullets: sub.summaryBullets ?? null,
          attributedClaims: sub.attributedClaims ?? null,
          mediaScrapedAt: sub.mediaScrapedAt ?? null,
          contentKind: sub.contentKind ?? null,
          manuallyEdited: sub.manuallyEdited ?? false,
          restrictedToMcops: null as string[] | null,
          fullText: sub.fullText ?? null,
          type: 'manual' as const,
          originalPriority,
          depreciatedPriority
        };
      })
    ];
    
    // Sort by depreciated priority, then by date
    combined.sort((a, b) => {
      if (b.depreciatedPriority !== a.depreciatedPriority) {
        return b.depreciatedPriority - a.depreciatedPriority;
      }
      const dateA = new Date(a.articlePublishedAt || a.scrapedAt).getTime();
      const dateB = new Date(b.articlePublishedAt || b.scrapedAt).getTime();
      return dateB - dateA;
    });
    
    // Deduplicate by title similarity, preferring manual (user-submitted) entries
    // over scraped headlines so user-curated media (reviewed image/bullets) is
    // preserved.
    //
    // Task #684: this dedup is O(n^2) and is the heaviest synchronous pass
    // reachable from the Classic (/api/headline-feed), Visual (/api/stream), and
    // custom-MCOP feed handlers, which all delegate ranking+dedup here. It lives
    // in the shared `dedupPrimaryFeed` helper, which yields to the event loop
    // every CURATED_YIELD_CHUNK iterations so other requests interleave on this
    // single-process app — the same fix #681 applied to the curated read. Only
    // the scheduling changes; the output is byte-identical (locked by
    // scripts/feed-dedup-parity.test.ts).
    return dedupPrimaryFeed(combined, limit);
  }

  async getScrapeMetadata(): Promise<ScrapeMetadata | undefined> {
    const [metadata] = await db
      .select()
      .from(scrapeMetadata)
      .where(eq(scrapeMetadata.id, 'global'));
    return metadata || undefined;
  }

  async updateScrapeMetadata(updates: Partial<InsertScrapeMetadata>): Promise<void> {
    await db
      .insert(scrapeMetadata)
      .values({
        id: 'global',
        ...updates,
      } as InsertScrapeMetadata)
      .onConflictDoUpdate({
        target: scrapeMetadata.id,
        set: updates,
      });
  }

  async getRelayHeartbeatAt(relay: string): Promise<Date | null> {
    const [row] = await db
      .select()
      .from(relayHeartbeats)
      .where(eq(relayHeartbeats.relay, relay));
    return row?.lastHeartbeatAt ?? null;
  }

  async setRelayHeartbeatAt(relay: string, at: Date): Promise<void> {
    await db
      .insert(relayHeartbeats)
      .values({ relay, lastHeartbeatAt: at, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: relayHeartbeats.relay,
        set: { lastHeartbeatAt: at, updatedAt: new Date() },
      });
  }

  async getRelayOutageEscalatedAt(relay: string): Promise<Date | null> {
    const [row] = await db
      .select()
      .from(relayHeartbeats)
      .where(eq(relayHeartbeats.relay, relay));
    return row?.outageEscalatedAt ?? null;
  }

  async setRelayOutageEscalatedAt(relay: string, at: Date | null): Promise<void> {
    // Upsert so the marker can be stamped even if the heartbeat row was never
    // created in this environment (dev DB edge). On the conflict (normal) path
    // last_heartbeat_at is untouched; the insert path uses epoch — "stale
    // forever" — which matches reality for a relay that never heartbeated here.
    await db
      .insert(relayHeartbeats)
      .values({ relay, lastHeartbeatAt: new Date(0), outageEscalatedAt: at, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: relayHeartbeats.relay,
        set: { outageEscalatedAt: at, updatedAt: new Date() },
      });
  }

  async getAllFeedHealthState(): Promise<FeedHealthStateRow[]> {
    return await db.select().from(feedHealthState);
  }

  async upsertFeedHealthState(row: {
    url: string;
    sourceName: string;
    scope: string;
    lastOutcome: string;
    lastDetail: string | null;
    consecutiveUnhealthy: number;
    recent: string[];
    lastHealthyAt: Date | null;
    lastSeenAt: Date;
    totalCycles: number;
  }): Promise<void> {
    const values = {
      url: row.url,
      sourceName: row.sourceName,
      scope: row.scope,
      lastOutcome: row.lastOutcome,
      lastDetail: row.lastDetail,
      consecutiveUnhealthy: row.consecutiveUnhealthy,
      recent: row.recent,
      lastHealthyAt: row.lastHealthyAt,
      lastSeenAt: row.lastSeenAt,
      totalCycles: row.totalCycles,
      updatedAt: new Date(),
    };
    await db
      .insert(feedHealthState)
      .values(values)
      .onConflictDoUpdate({
        target: feedHealthState.url,
        set: {
          sourceName: values.sourceName,
          scope: values.scope,
          lastOutcome: values.lastOutcome,
          lastDetail: values.lastDetail,
          consecutiveUnhealthy: values.consecutiveUnhealthy,
          recent: values.recent,
          lastHealthyAt: values.lastHealthyAt,
          lastSeenAt: values.lastSeenAt,
          totalCycles: values.totalCycles,
          updatedAt: values.updatedAt,
        },
      });
  }

  // Persist a quarantined low-credibility-source item. De-duplicated on
  // normalizedTitle: returns true if a new row was inserted, false if it
  // already existed.
  async addQuarantinedHeadline(item: InsertQuarantinedHeadline): Promise<boolean> {
    const result = await db
      .insert(quarantinedHeadlines)
      .values(item)
      .onConflictDoNothing({ target: quarantinedHeadlines.normalizedTitle })
      .returning({ id: quarantinedHeadlines.id });
    return result.length > 0;
  }

  async getQuarantinedHeadlines(limit: number = 200): Promise<QuarantinedHeadline[]> {
    return await db
      .select()
      .from(quarantinedHeadlines)
      .orderBy(desc(quarantinedHeadlines.scrapedAt))
      .limit(limit);
  }

  async incrementFilterMetrics(deltas: { financeWeatherRescued?: number; financeWeatherDropped?: number; quarantined?: number }): Promise<void> {
    const rescued = deltas.financeWeatherRescued ?? 0;
    const dropped = deltas.financeWeatherDropped ?? 0;
    const quarantined = deltas.quarantined ?? 0;
    await db
      .insert(filterMetrics)
      .values({
        id: 'global',
        financeWeatherRescued: rescued,
        financeWeatherDropped: dropped,
        quarantined,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: filterMetrics.id,
        set: {
          financeWeatherRescued: sql`${filterMetrics.financeWeatherRescued} + ${rescued}`,
          financeWeatherDropped: sql`${filterMetrics.financeWeatherDropped} + ${dropped}`,
          quarantined: sql`${filterMetrics.quarantined} + ${quarantined}`,
          updatedAt: new Date(),
        },
      });
  }

  async getFilterMetrics(): Promise<FilterMetrics | undefined> {
    const [metrics] = await db
      .select()
      .from(filterMetrics)
      .where(eq(filterMetrics.id, 'global'));
    return metrics || undefined;
  }

  async getRecentChatMessages(limit: number): Promise<TeamChatMessage[]> {
    return await db
      .select()
      .from(teamChatMessages)
      .orderBy(desc(teamChatMessages.createdAt))
      .limit(limit);
  }

  async addChatMessage(insertMessage: InsertTeamChatMessage): Promise<TeamChatMessage> {
    // Bot chat messages bake the article summary into the composed text
    // (**title**\n\n<summary>\n\n<url>). If an audience-framing heading leaked
    // into that summary, strip it here — the single chokepoint every bot routes
    // through — so it never reaches the Team feed.
    //
    // GATE: only the bot-composed shape is sanitized. A human message could
    // legitimately contain a second-paragraph markdown heading, so the message
    // sanitizer (which is shape-based: split at the first blank line, strip a
    // leading heading off the body) must not touch free-form human text. Every
    // bot composes the exact same envelope — a leading bold title (`**...**`)
    // and a trailing http(s) URL — so require BOTH before sanitizing.
    const raw = insertMessage.message;
    const isBotComposed =
      typeof raw === 'string' &&
      raw.startsWith('**') &&
      /https?:\/\/\S+\s*$/.test(raw);
    const safeMessage = isBotComposed ? stripBriefingPreambleFromMessage(raw) : raw;
    const [message] = await db
      .insert(teamChatMessages)
      .values({
        ...insertMessage,
        message: safeMessage,
      })
      .returning();
    return message;
  }

  async addChatMessageIdempotent(
    insertMessage: InsertTeamChatMessage & { clientRequestId: string },
  ): Promise<{ message: TeamChatMessage; inserted: boolean }> {
    const raw = insertMessage.message;
    const isBotComposed =
      typeof raw === 'string' &&
      raw.startsWith('**') &&
      /https?:\/\/\S+\s*$/.test(raw);
    const safeMessage = isBotComposed ? stripBriefingPreambleFromMessage(raw) : raw;
    const inserted = await db
      .insert(teamChatMessages)
      .values({ ...insertMessage, message: safeMessage })
      .onConflictDoNothing({
        target: [teamChatMessages.userId, teamChatMessages.clientRequestId],
      })
      .returning();
    if (inserted[0]) return { message: inserted[0], inserted: true };
    // ON CONFLICT waits for a concurrent winning insert to commit, but allow a
    // tiny bounded visibility retry for transaction/isolation edge cases.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [existing] = await db
        .select()
        .from(teamChatMessages)
        .where(and(
          eq(teamChatMessages.userId, insertMessage.userId),
          eq(teamChatMessages.clientRequestId, insertMessage.clientRequestId),
        ))
        .limit(1);
      if (existing) return { message: existing, inserted: false };
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
    throw new Error('Idempotent chat insert conflicted but existing row was not visible after bounded retry');
  }

  async deleteChatMessage(messageId: string): Promise<TeamChatMessage | null> {
    const [deleted] = await db
      .delete(teamChatMessages)
      .where(eq(teamChatMessages.id, messageId))
      .returning();
    return deleted || null;
  }

  async getAllSubjects(): Promise<TeamSubject[]> {
    return await db
      .select()
      .from(teamSubjects)
      .orderBy(desc(teamSubjects.createdAt));
  }

  async getSubjectById(id: string): Promise<TeamSubject | undefined> {
    const [subject] = await db
      .select()
      .from(teamSubjects)
      .where(eq(teamSubjects.id, id));
    return subject || undefined;
  }

  async getSubjectByName(name: string): Promise<TeamSubject | undefined> {
    const normalizedName = name.trim().toLowerCase();
    const [subject] = await db
      .select()
      .from(teamSubjects)
      .where(sql`LOWER(TRIM(${teamSubjects.name})) = ${normalizedName}`);
    return subject || undefined;
  }

  async addSubject(insertSubject: InsertTeamSubject): Promise<TeamSubject> {
    const [subject] = await db
      .insert(teamSubjects)
      .values(insertSubject)
      .returning();
    return subject;
  }

  async updateSubject(id: string, fields: Partial<InsertTeamSubject>): Promise<TeamSubject | undefined> {
    const [subject] = await db
      .update(teamSubjects)
      .set(fields)
      .where(eq(teamSubjects.id, id))
      .returning();
    return subject || undefined;
  }

  async getSubmissionsBySubject(subjectId: string): Promise<TeamSubmission[]> {
    return await db
      .select()
      .from(teamSubmissions)
      .where(and(eq(teamSubmissions.subjectId, subjectId), isNull(teamSubmissions.deletedAt)))
      .orderBy(desc(teamSubmissions.createdAt));
  }

  async unifiedNewsSearch(query: string, limit: number = 200): Promise<Array<{
    id: string;
    title: string;
    url: string;
    summary: string;
    fullText: string | null;
    source: string;
    sourceTable: 'team_submission' | 'mcop_feed' | 'headline' | 'rss_bot';
    priorityScore: number;
    date: Date;
  }>> {
    const pattern = `%${query}%`;

    const [teamResults, manualResults, headlineResults, rssResults] = await Promise.all([
      db.select({
        id: teamSubmissions.id,
        title: teamSubmissions.headline,
        url: teamSubmissions.sourceUrl,
        summary: teamSubmissions.summary,
        fullText: teamSubmissions.fullText,
        source: teamSubmissions.sourceName,
        priorityScore: teamSubmissions.priorityScore,
        date: teamSubmissions.createdAt,
      }).from(teamSubmissions).where(
        and(
          isNull(teamSubmissions.deletedAt),
          eq(teamSubmissions.isQuestionable, false),
          or(
            ilike(teamSubmissions.headline, pattern),
            ilike(teamSubmissions.summary, pattern),
            ilike(teamSubmissions.fullText, pattern),
            ilike(teamSubmissions.sourceName, pattern),
          )
        )
      ).orderBy(desc(teamSubmissions.createdAt)).limit(limit),

      db.select({
        id: manualSubmissions.id,
        title: manualSubmissions.title,
        url: manualSubmissions.url,
        summary: manualSubmissions.summary,
        source: manualSubmissions.source,
        priorityScore: manualSubmissions.priorityScore,
        date: manualSubmissions.submittedAt,
      }).from(manualSubmissions).where(
        or(
          ilike(manualSubmissions.title, pattern),
          ilike(manualSubmissions.summary, pattern),
          ilike(manualSubmissions.source, pattern),
        )
      ).orderBy(desc(manualSubmissions.submittedAt)).limit(limit),

      db.select({
        id: headlines.id,
        title: headlines.title,
        url: headlines.url,
        summary: headlines.summary,
        source: headlines.source,
        priorityScore: headlines.priorityScore,
        date: headlines.scrapedAt,
      }).from(headlines).where(
        or(
          ilike(headlines.title, pattern),
          ilike(headlines.summary, pattern),
          ilike(headlines.source, pattern),
        )
      ).orderBy(desc(headlines.scrapedAt)).limit(limit),

      db.select({
        id: rssBotPosts.id,
        title: rssBotPosts.articleTitle,
        url: rssBotPosts.articleUrl,
        summary: rssBotPosts.summary,
        source: rssBotPosts.sourceName,
        date: rssBotPosts.postedAt,
      }).from(rssBotPosts).where(
        or(
          ilike(rssBotPosts.articleTitle, pattern),
          ilike(rssBotPosts.summary, pattern),
          ilike(rssBotPosts.sourceName, pattern),
        )
      ).orderBy(desc(rssBotPosts.postedAt)).limit(limit),
    ]);

    const seen = new Set<string>();
    const normalizeUrl = (u: string): string => {
      try {
        const urlObj = new URL(u);
        return ('https://' + urlObj.host + urlObj.pathname).replace(/\/+$/, '');
      } catch {
        return u.split('?')[0].split('#')[0].replace(/\/+$/, '').replace(/^http:/, 'https:');
      }
    };

    const all: Array<{
      id: string; title: string; url: string; summary: string; fullText: string | null;
      source: string; sourceTable: 'team_submission' | 'mcop_feed' | 'headline' | 'rss_bot';
      priorityScore: number; date: Date;
    }> = [];

    for (const r of teamResults) {
      const norm = normalizeUrl(r.url);
      if (seen.has(norm)) continue;
      seen.add(norm);
      all.push({ ...r, title: r.title || '', source: r.source || 'Unknown', fullText: r.fullText || null, priorityScore: r.priorityScore || 0, date: r.date || new Date(), sourceTable: 'team_submission' });
    }
    for (const r of manualResults) {
      const norm = normalizeUrl(r.url);
      if (seen.has(norm)) continue;
      seen.add(norm);
      all.push({ ...r, fullText: null, priorityScore: r.priorityScore || 0, date: r.date || new Date(), sourceTable: 'mcop_feed' });
    }
    for (const r of headlineResults) {
      const norm = normalizeUrl(r.url);
      if (seen.has(norm)) continue;
      seen.add(norm);
      all.push({ ...r, fullText: null, priorityScore: r.priorityScore || 0, date: r.date || new Date(), sourceTable: 'headline' });
    }
    for (const r of rssResults) {
      const norm = normalizeUrl(r.url);
      if (seen.has(norm)) continue;
      seen.add(norm);
      all.push({ ...r, fullText: null, priorityScore: 0, date: r.date || new Date(), sourceTable: 'rss_bot' });
    }

    all.sort((a, b) => {
      const pDiff = b.priorityScore - a.priorityScore;
      if (pDiff !== 0) return pDiff;
      return b.date.getTime() - a.date.getTime();
    });

    return all.slice(0, limit);
  }

  async getAllNewsForBot(): Promise<Array<{
    id: string;
    title: string;
    url: string;
    summary: string;
    fullText: string | null;
    source: string;
    sourceTable: string;
    sourceType: string;
    priorityScore: number;
    date: Date;
  }>> {
    const [teamResults, manualResults, headlineResults, rssResults] = await Promise.all([
      db.select({
        id: teamSubmissions.id,
        title: teamSubmissions.headline,
        url: teamSubmissions.sourceUrl,
        summary: teamSubmissions.summary,
        fullText: teamSubmissions.fullText,
        source: teamSubmissions.sourceName,
        sourceType: teamSubmissions.sourceType,
        priorityScore: teamSubmissions.priorityScore,
        date: teamSubmissions.createdAt,
      }).from(teamSubmissions).where(
        and(isNull(teamSubmissions.deletedAt), eq(teamSubmissions.isQuestionable, false))
      ).orderBy(desc(teamSubmissions.createdAt)),

      db.select({
        id: manualSubmissions.id,
        title: manualSubmissions.title,
        url: manualSubmissions.url,
        summary: manualSubmissions.summary,
        source: manualSubmissions.source,
        priorityScore: manualSubmissions.priorityScore,
        date: manualSubmissions.submittedAt,
      }).from(manualSubmissions).orderBy(desc(manualSubmissions.submittedAt)),

      db.select({
        id: headlines.id,
        title: headlines.title,
        url: headlines.url,
        summary: headlines.summary,
        source: headlines.source,
        priorityScore: headlines.priorityScore,
        date: headlines.scrapedAt,
      }).from(headlines).orderBy(desc(headlines.scrapedAt)),

      db.select({
        id: rssBotPosts.id,
        title: rssBotPosts.articleTitle,
        url: rssBotPosts.articleUrl,
        summary: rssBotPosts.summary,
        source: rssBotPosts.sourceName,
        date: rssBotPosts.postedAt,
      }).from(rssBotPosts).orderBy(desc(rssBotPosts.postedAt)),
    ]);

    const seen = new Set<string>();
    const normalizeUrl = (u: string): string => {
      try {
        const urlObj = new URL(u);
        return ('https://' + urlObj.host + urlObj.pathname).replace(/\/+$/, '');
      } catch {
        return u.split('?')[0].split('#')[0].replace(/\/+$/, '').replace(/^http:/, 'https:');
      }
    };

    const all: Array<{
      id: string; title: string; url: string; summary: string; fullText: string | null;
      source: string; sourceTable: string; sourceType: string; priorityScore: number; date: Date;
    }> = [];

    for (const r of teamResults) {
      const norm = normalizeUrl(r.url);
      if (seen.has(norm)) continue;
      seen.add(norm);
      all.push({ ...r, title: r.title || '', source: r.source || 'Unknown', fullText: r.fullText || null, sourceType: r.sourceType || 'news', priorityScore: r.priorityScore || 0, date: r.date || new Date(), sourceTable: 'team_submission' });
    }
    for (const r of manualResults) {
      const norm = normalizeUrl(r.url);
      if (seen.has(norm)) continue;
      seen.add(norm);
      all.push({ ...r, fullText: null, sourceType: 'news', priorityScore: r.priorityScore || 0, date: r.date || new Date(), sourceTable: 'mcop_feed' });
    }
    for (const r of headlineResults) {
      const norm = normalizeUrl(r.url);
      if (seen.has(norm)) continue;
      seen.add(norm);
      all.push({ ...r, fullText: null, sourceType: 'news', priorityScore: r.priorityScore || 0, date: r.date || new Date(), sourceTable: 'headline' });
    }
    for (const r of rssResults) {
      const norm = normalizeUrl(r.url);
      if (seen.has(norm)) continue;
      seen.add(norm);
      all.push({ ...r, fullText: null, sourceType: 'news', priorityScore: 0, date: r.date || new Date(), sourceTable: 'rss_bot' });
    }

    all.sort((a, b) => {
      const pDiff = b.priorityScore - a.priorityScore;
      if (pDiff !== 0) return pDiff;
      return b.date.getTime() - a.date.getTime();
    });

    return all;
  }

  async getRecentSubmissions(limit: number): Promise<TeamSubmission[]> {
    return await db
      .select()
      .from(teamSubmissions)
      .where(isNull(teamSubmissions.deletedAt))
      .orderBy(desc(teamSubmissions.createdAt))
      .limit(limit);
  }

  async getAllSubmissionsForNewsBot(): Promise<TeamSubmission[]> {
    return await db
      .select()
      .from(teamSubmissions)
      .where(and(isNull(teamSubmissions.deletedAt), eq(teamSubmissions.isQuestionable, false)))
      .orderBy(desc(teamSubmissions.createdAt));
  }

  // Curated lane (Task #137) — recent, credible team submissions for curated
  // intake. Excludes deleted, questionable, and OSINT/social-flagged rows so
  // only real news wires flow into the isolated curated store (their lane role
  // is still resolved from the registry, fail-closed to attach-only).
  async getRecentTeamSubmissionsForCurated(hours: number, limit: number): Promise<TeamSubmission[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await db
      .select()
      .from(teamSubmissions)
      .where(and(
        isNull(teamSubmissions.deletedAt),
        eq(teamSubmissions.isQuestionable, false),
        eq(teamSubmissions.isMataOsint, false),
        gte(teamSubmissions.createdAt, cutoff),
      ))
      // NULLS LAST: Postgres sorts NULL first on DESC, so unscored submissions
      // (e.g. POTUS Truth posts, intentionally NULL) would otherwise crowd
      // scored items out of the capped candidate slice.
      .orderBy(sql`${teamSubmissions.priorityScore} DESC NULLS LAST`, desc(teamSubmissions.createdAt))
      .limit(limit);
  }

  // Main-feed headline table → curated parity bridge. Returns recent rows from
  // the shared `headlines` table (Warfighter RSS active in prod; Drudge when
  // enabled; manual headline adds) so the curated lane can mirror them and stay
  // a SUPERSET of the main feed. Bounded by window + limit, priority-first (an
  // admin override wins), the same bounding the team-submission getter uses so
  // the wider aperture can't flood the curated store / LLM clustering payload.
  async getRecentHeadlinesForCurated(hours: number, limit: number): Promise<Headline[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await db
      .select()
      .from(headlines)
      .where(gte(headlines.scrapedAt, cutoff))
      // NULLS LAST for the same reason as the team-submission getter above:
      // unscored rows would otherwise crowd scored ones out of the capped slice.
      .orderBy(sql`COALESCE(${headlines.priorityOverride}, ${headlines.priorityScore}) DESC NULLS LAST`, desc(headlines.scrapedAt))
      .limit(limit);
  }

  // Bounded social/flash getters for curated intake (Task #138). Each returns
  // recent, non-hidden rows within a time window, freshest first, capped — the
  // same bounding the team-submission getter uses so the wider aperture can't
  // flood the curated store / LLM clustering payload.
  async getRecentXPostsForCurated(hours: number, limit: number): Promise<XPost[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await db
      .select()
      .from(xPosts)
      .where(and(
        eq(xPosts.isHidden, false),
        // The x_posts table holds only official US government accounts; exclude
        // the influencer category (those are not official-account corroboration).
        sql`${xPosts.accountCategory} <> 'influencer'`,
        gte(xPosts.postedAt, cutoff),
      ))
      .orderBy(desc(xPosts.postedAt))
      .limit(limit);
  }

  async getRecentTruthSocialPostsForCurated(hours: number, limit: number): Promise<TruthSocialPost[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await db
      .select()
      .from(truthSocialPosts)
      .where(and(
        eq(truthSocialPosts.isHidden, false),
        gte(truthSocialPosts.postedAt, cutoff),
      ))
      .orderBy(desc(truthSocialPosts.postedAt))
      .limit(limit);
  }

  async getRecentFirstAlertsForCurated(hours: number, limit: number): Promise<FirstAlert[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await db
      .select()
      .from(firstAlerts)
      .where(gte(firstAlerts.publishedAt, cutoff))
      .orderBy(desc(firstAlerts.publishedAt))
      .limit(limit);
  }

  async getSubmissionByUrl(url: string): Promise<TeamSubmission | undefined> {
    // Normalize URL for consistent comparison: https protocol, no query params/fragments, no trailing slashes
    const normalizeUrl = (u: string): string => {
      try {
        const urlObj = new URL(u);
        let normalized = 'https://' + urlObj.host + urlObj.pathname;
        normalized = normalized.replace(/\/+$/, '');
        return normalized;
      } catch {
        let normalized = u.split('?')[0].split('#')[0].replace(/\/+$/, '');
        normalized = normalized.replace(/^http:/, 'https:');
        return normalized;
      }
    };
    
    const normalizedUrl = normalizeUrl(url);
    
    // Use SQL-side normalization to match against stored URLs (handles legacy data with different formats)
    const [submission] = await db
      .select()
      .from(teamSubmissions)
      .where(sql`REPLACE(REGEXP_REPLACE(SPLIT_PART(SPLIT_PART(${teamSubmissions.sourceUrl}, '?', 1), '#', 1), '/+$', ''), 'http://', 'https://') = ${normalizedUrl}`)
      .limit(1);
    return submission || undefined;
  }

  async getTeamSubmissionById(id: string): Promise<TeamSubmission | undefined> {
    const [submission] = await db
      .select()
      .from(teamSubmissions)
      .where(eq(teamSubmissions.id, id))
      .limit(1);
    return submission || undefined;
  }

  async markTeamSubmissionAsMCOP(submissionId: string, userId: string): Promise<void> {
    await db
      .update(teamSubmissions)
      .set({
        mcopSubmittedAt: new Date(),
        mcopSubmittedBy: userId,
        updatedAt: new Date()
      })
      .where(eq(teamSubmissions.id, submissionId));
  }
  
  async updateSubmissionPriority(submissionId: string, priorityScore: number): Promise<TeamSubmission | null> {
    // Get the FLASH topic for potential assignment
    const flashTopic = await this.getSubjectByName(FLASH_TOPIC_NAME);
    const flashSubjectId = flashTopic?.id || null;
    
    // Determine if this should be added to FLASH (priority 66+)
    const shouldBeInFlash = priorityScore >= 66;
    
    // Update the submission
    const [updated] = await db
      .update(teamSubmissions)
      .set({
        priorityScore,
        // Task #811: a manual score edit owns the score — mark it 'human' so the
        // background score-retry job never re-scores (and overwrites) it.
        scoreSource: 'human',
        flashSubjectId: shouldBeInFlash ? flashSubjectId : null,
        updatedAt: new Date()
      })
      .where(eq(teamSubmissions.id, submissionId))
      .returning();
    
    if (!updated) {
      return null;
    }
    
    // Note: Auto-submission to MCOP (creating manual_submission record) is now handled in the routes
    // This storage function only updates the priority and flash assignment
    
    return updated;
  }

  // Task #811: find recent team submissions whose score is the UNSCORED_BOT_PRIORITY
  // floor applied because the AI scorer failed (score_source='unscored_fallback'),
  // still under the retry cap, not deleted, and inside a bounded recency window so
  // we never churn old rows. Ordered oldest-first so the earliest-failed items are
  // retried first.
  async getUnscoredFallbackSubmissions(maxRetries: number, windowHours: number, limit: number): Promise<TeamSubmission[]> {
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    return await db
      .select()
      .from(teamSubmissions)
      .where(and(
        eq(teamSubmissions.scoreSource, 'unscored_fallback'),
        lt(teamSubmissions.scoreRetryCount, maxRetries),
        gte(teamSubmissions.createdAt, cutoff),
        isNull(teamSubmissions.deletedAt),
      ))
      .orderBy(teamSubmissions.createdAt)
      .limit(limit);
  }

  // Task #811: record that a re-scoring attempt ran but still didn't yield a real
  // score. Only bumps the counter (leaves score_source='unscored_fallback') so the
  // item is retried again next cycle until it hits the cap.
  async markScoreRetryFailure(submissionId: string): Promise<void> {
    await db
      .update(teamSubmissions)
      .set({ scoreRetryCount: sql`${teamSubmissions.scoreRetryCount} + 1`, updatedAt: new Date() })
      .where(eq(teamSubmissions.id, submissionId));
  }

  async updateSubmissionQuestionable(submissionId: string, isQuestionable: boolean): Promise<void> {
    await db
      .update(teamSubmissions)
      .set({ isQuestionable, updatedAt: new Date() })
      .where(eq(teamSubmissions.id, submissionId));
  }

  async addSubmission(insertSubmission: InsertTeamSubmission): Promise<TeamSubmission> {
    // Strip any leading AI audience-framing preamble (e.g. a "# Summary for the
    // Chairman of the Joint Chiefs of Staff" heading the model echoed) before it
    // is persisted and can reach any external feed surface. No-op on clean prose.
    const values: InsertTeamSubmission = {
      ...insertSubmission,
      summary: stripBriefingPreamble(insertSubmission.summary),
    };
    const [submission] = await db
      .insert(teamSubmissions)
      .values(values)
      .returning();
    return submission;
  }

  async updateSubmissionStatus(id: string, status: string, subjectId?: string): Promise<void> {
    const updates: Partial<TeamSubmission> = { 
      status,
      updatedAt: new Date()
    };
    if (subjectId !== undefined) {
      updates.subjectId = subjectId;
    }
    await db
      .update(teamSubmissions)
      .set(updates)
      .where(eq(teamSubmissions.id, id));
  }

  async finalizeSubmissionAnalysis(
    id: string,
    data: { headline: string; summary: string; sourceType: string; subjectId: string; sourceName?: string; publishedAt?: Date | null; fullText?: string; priorityScore?: number; scoreSource?: string; flashSubjectId?: string | null; cjcsSubjectId?: string | null; mataOsintSubjectId?: string | null; skipAutoMCOP?: boolean; ogImageUrl?: string | null }
  ): Promise<void> {
    const existing = await this.getTeamSubmissionById(id);
    const hasUserSetHeadline = existing && existing.headline && existing.headline !== 'Processing...' && existing.status === 'processed';

    // Strip any leading AI audience-framing preamble the model may have echoed
    // (e.g. a "# Summary for the Chairman of the Joint Chiefs of Staff" heading)
    // before persisting; never reaches an external feed surface. No-op on prose.
    const cleanSummary = stripBriefingPreamble(data.summary);

    const updates: Record<string, any> = {
      headline: hasUserSetHeadline ? existing.headline : data.headline,
      summary: hasUserSetHeadline ? (existing as any).summary || cleanSummary : cleanSummary,
      sourceType: data.sourceType,
      subjectId: data.subjectId,
      status: 'processed',
      updatedAt: new Date(),
    };
    if (hasUserSetHeadline) {
      console.log(`[finalizeSubmissionAnalysis] Preserving user-set headline for ${id}: "${existing.headline}"`);
    }
    if (data.sourceName) {
      updates.sourceName = data.sourceName;
    }
    if (data.publishedAt !== undefined) {
      updates.publishedAt = data.publishedAt;
    }
    if (data.fullText) {
      updates.fullText = data.fullText;
    }
    if (data.ogImageUrl) {
      updates.ogImageUrl = data.ogImageUrl;
    }
    let effectivePriority = data.priorityScore;
    if (data.priorityScore !== undefined) {
      const existingScore = existing?.priorityScore;
      const userSetHigherScore = existingScore != null && existingScore > data.priorityScore;
      
      if (userSetHigherScore) {
        console.log(`[finalizeSubmissionAnalysis] Preserving user-set priority ${existingScore} for ${id} (AI wanted ${data.priorityScore})`);
        effectivePriority = existingScore;
        // A preserved user score is human-owned provenance; never let a later
        // AI/fallback write flip it back to a retryable state (Task #811).
        updates.scoreSource = 'human';
      } else {
        updates.priorityScore = data.priorityScore;
        // Record score provenance (Task #811). Defaults to 'ai' when the caller
        // doesn't specify so the common path stays correct; bots pass
        // 'unscored_fallback' when the scorer failed so the retry job can find it.
        updates.scoreSource = data.scoreSource ?? 'ai';
      }
    }
    if (data.flashSubjectId !== undefined) {
      updates.flashSubjectId = data.flashSubjectId;
    }
    if (data.cjcsSubjectId !== undefined) {
      updates.cjcsSubjectId = data.cjcsSubjectId;
    }
    if (data.mataOsintSubjectId !== undefined) {
      updates.mataOsintSubjectId = data.mataOsintSubjectId;
    }
    await db
      .update(teamSubmissions)
      .set(updates)
      .where(eq(teamSubmissions.id, id));
    
    const meetsScoreBar = qualifiesForMainFeedPromotion(effectivePriority, data.sourceType);
    const promoSource = data.sourceName ?? (existing as any)?.sourceName ?? 'unknown';

    // Resolve the team submission ONCE up front when it could auto-promote — its
    // sourceUrl is needed both to resolve the outlet (curated-only check) and to
    // build the MCOP row below. Skipped for the caller-handled path (skipAutoMCOP).
    let promoSubmission: TeamSubmission | undefined;
    let curatedOnlyBlocked = false;
    if (meetsScoreBar && !data.skipAutoMCOP) {
      promoSubmission = await this.getTeamSubmissionById(id);
      // Fail-OPEN, positive-only (Task #533): keep an item off the main feed ONLY
      // when its outlet POSITIVELY resolves to a "curated only" registry row in
      // Source Oversight. Unknown / unresolved outlets still promote. The curated
      // lane ingests everything regardless; this governs only main/Classic/Visual/
      // Warfighter auto-promotion.
      curatedOnlyBlocked = await this.isOutletCuratedOnlyForMainFeed(promoSource, promoSubmission?.sourceUrl ?? null);
    }

    // [FUNNEL:PROMOTE] live main-feed admission decision. EVERY bot / RSS / social /
    // reviewed-submission path flows through here, so this single line baselines the
    // whole main-feed funnel: does this item clear the MAIN_FEED_PROMOTION_THRESHOLD
    // news bar that auto-promotes it into Classic/Visual, or stay Team-chat-only?
    // Observability only (the actual insert is still logged by [Bot Auto-MCOP]).
    // Task #522 lowered the bar to the rubric MODERATE floor; Task #533 adds the
    // curated-only outlet skip. Task #570: for borderline just-below-bar items
    // (45-49), also log the headline so operators can sample what's held back and
    // decide whether future bar or scoring-rubric tuning is warranted.
    {
      const dest = !meetsScoreBar
        ? 'CHAT-ONLY'
        : curatedOnlyBlocked
          ? 'CHAT-ONLY(curated-only outlet)'
          : (data.skipAutoMCOP ? 'MAIN(caller-handled)' : 'MAIN');
      const isBorderlineBelow =
        typeof effectivePriority === 'number' &&
        effectivePriority >= MAIN_FEED_PROMOTION_THRESHOLD - 5 &&
        effectivePriority < MAIN_FEED_PROMOTION_THRESHOLD;
      const headlineNote =
        isBorderlineBelow && data.headline
          ? ` headline="${data.headline.substring(0, 80)}"`
          : '';
      console.log(`[FUNNEL:PROMOTE] source="${promoSource}" type=${data.sourceType} score=${effectivePriority ?? 'n/a'} bar=${meetsScoreBar ? `MEET>=${MAIN_FEED_PROMOTION_THRESHOLD}` : `BELOW<${MAIN_FEED_PROMOTION_THRESHOLD}`}${curatedOnlyBlocked ? ' curated_only=SKIP' : ''}${headlineNote} -> ${dest}`);
    }

    // Auto-submit to MCOP front page if effective priority meets the main-feed
    // promotion bar and it's a news article. Uses whichever is higher: the AI score
    // or the user-set score. Skip when caller handles MCOP creation (e.g. reviewed
    // submissions with user-curated media) OR when the outlet is curated-only.
    if (!data.skipAutoMCOP && meetsScoreBar && !curatedOnlyBlocked) {
      try {
        // Reuse the submission resolved above (avoids a second fetch).
        const submission = promoSubmission;
        if (submission && submission.sourceUrl) {
          // Check if URL already exists in manual_submissions
          const existingSubmissions = await this.getAllManualSubmissions();
          const urlExists = existingSubmissions.some(s => s.url === submission.sourceUrl);
          
          if (!urlExists) {
            console.log(`[Bot Auto-MCOP] Priority ${effectivePriority} - Auto-submitting to MCOP: "${data.headline?.substring(0, 50)}..."`);
            
            // Get the subject name for tags
            let subjectName: string | null = null;
            if (data.subjectId) {
              const subject = await this.getSubjectById(data.subjectId);
              if (subject) {
                subjectName = subject.name;
              }
            }
            
            // Build tags array
            const tags: string[] = [];
            if (subjectName && subjectName !== 'FLASH: TOP STORIES') {
              tags.push(subjectName);
            }
            
            // Carry over the team submission's already-scraped og:image so the
            // Warfighter MCOP row arrives with at least an image instead of a
            // placeholder shield. (team_submissions does not store bullets;
            // those are generated later by the backfill cron, which now runs
            // every 5 minutes.) Leave mediaScrapedAt NULL so the backfill knows
            // this row still needs bullet generation.
            const carriedImage = submission.ogImageUrl ?? null;

            // Create manual submission for the headline feed.
            // Carry over fullText from the bot's post-time scrape so the
            // stream-prefetch enrichment can detect title-derived summaries
            // (fullText NULL = paywall/blocked at post time → upgrade eligible).
            await this.addManualSubmission({
              title: data.headline,
              url: submission.sourceUrl,
              category: 'Defense',
              source: data.sourceName || 'Team Submission',
              summary: data.summary || '',
              submittedBy: `Bot: ${data.sourceName || 'News Bot'}`,
              priorityScore: effectivePriority,
              tags,
              pdfPath: null,
              ogImageUrl: carriedImage,
              fullText: data.fullText || null,
              // Real publish date (RSS pubDate / trusted link-analysis
              // extraction) so the feed never fabricates one from submit time;
              // plausibility-bounded inside addManualSubmission.
              articlePublishedAt: data.publishedAt ?? null,
            });
            
            // Mark the team submission as MCOP-submitted
            await db
              .update(teamSubmissions)
              .set({
                mcopSubmittedAt: new Date(),
                mcopSubmittedBy: 'system-auto'
              })
              .where(eq(teamSubmissions.id, id));
            
            console.log(`[Bot Auto-MCOP] SUCCESS: Added to MCOP front page`);
          } else {
            console.log(`[Bot Auto-MCOP] URL already in MCOP, skipping: ${submission.sourceUrl}`);
          }
        }
      } catch (mcopError) {
        console.error('[Bot Auto-MCOP] Error auto-submitting to MCOP:', mcopError);
      }
    }
  }

  async findOrCreateSubject(name: string, createdBy: string): Promise<TeamSubject> {
    // Normalize the name to ensure consistent casing
    const normalizedName = name.trim();
    
    // Try to find existing subject first (case-insensitive search)
    let subject = await this.getSubjectByName(normalizedName);
    if (subject) {
      return subject;
    }
    
    // If not found, fall back to "Emerging" topic instead of creating a new one
    // This prevents auto-creation of topics by bots/AI - only the explicit user
    // "Create new topic" action (createUserTopic) may add a brand-new topic.
    console.log(`[Topics] No match for "${normalizedName}", falling back to "Emerging"`);
    const emergingSubject = await this.getSubjectByName('Emerging');
    if (emergingSubject) {
      return emergingSubject;
    }
    
    // If Emerging doesn't exist, create it (should only happen on first run)
    try {
      subject = await this.addSubject({
        name: 'Emerging',
        description: 'New topics that do not fit other categories',
        origin: 'manual',
        createdBy: 'system',
      });
      return subject;
    } catch (error: any) {
      // If conflict (duplicate), fetch the existing one
      if (error.code === '23505') {
        const existing = await this.getSubjectByName('Emerging');
        if (existing) return existing;
      }
      throw error;
    }
  }

  /**
   * Explicit user-initiated topic creation. Unlike findOrCreateSubject (which
   * fails closed to "Emerging" for bots/AI), this genuinely creates a new
   * manual topic when one does not already exist. Reuses an existing topic if
   * the name matches case-insensitively, so it never makes duplicates.
   */
  async createUserTopic(name: string, createdBy: string): Promise<TeamSubject> {
    const trimmedName = name.trim();
    const existing = await this.getSubjectByName(trimmedName);
    if (existing) {
      return existing;
    }
    try {
      const subject = await this.addSubject({
        name: trimmedName,
        description: null,
        origin: 'manual',
        createdBy,
      });
      console.log(`[Topics] Created new user topic: "${trimmedName}"`);
      return subject;
    } catch (error: any) {
      // If conflict (duplicate created concurrently), fetch the existing one
      if (error.code === '23505') {
        const conflict = await this.getSubjectByName(trimmedName);
        if (conflict) return conflict;
      }
      throw error;
    }
  }

  async getSubjectsWithSubmissions(): Promise<Array<TeamSubject & { submissions: TeamSubmission[] }>> {
    const subjects = await this.getAllSubjects();
    const allSubmissions = await db
      .select()
      .from(teamSubmissions)
      .where(and(eq(teamSubmissions.status, 'processed'), isNull(teamSubmissions.deletedAt)))
      .orderBy(desc(teamSubmissions.createdAt));
    
    return subjects.map(subject => ({
      ...subject,
      submissions: allSubmissions.filter(s => s.subjectId === subject.id)
    }));
  }

  async getUserReadSubmissions(userId: string): Promise<string[]> {
    const reads = await db
      .select({ submissionId: teamSubmissionReads.submissionId })
      .from(teamSubmissionReads)
      .where(eq(teamSubmissionReads.userId, userId));
    return reads.map(r => r.submissionId);
  }

  async getCommentsForSubmission(submissionId: string): Promise<TeamSubmissionComment[]> {
    return await db
      .select()
      .from(teamSubmissionComments)
      .where(eq(teamSubmissionComments.submissionId, submissionId))
      .orderBy(teamSubmissionComments.createdAt);
  }

  async getCommentCountsForSubmissions(submissionIds: string[]): Promise<Record<string, number>> {
    if (submissionIds.length === 0) return {};
    const results = await db
      .select({
        submissionId: teamSubmissionComments.submissionId,
        count: sql<number>`count(*)::int`,
      })
      .from(teamSubmissionComments)
      .where(inArray(teamSubmissionComments.submissionId, submissionIds))
      .groupBy(teamSubmissionComments.submissionId);
    const counts: Record<string, number> = {};
    for (const r of results) {
      counts[r.submissionId] = r.count;
    }
    return counts;
  }

  async addComment(comment: InsertTeamSubmissionComment): Promise<TeamSubmissionComment> {
    const [result] = await db
      .insert(teamSubmissionComments)
      .values(comment)
      .returning();
    return result;
  }

  async deleteComment(commentId: string): Promise<void> {
    await db
      .delete(teamSubmissionComments)
      .where(eq(teamSubmissionComments.id, commentId));
  }

  async toggleSubmissionRead(userId: string, submissionId: string): Promise<boolean> {
    // Check if already read
    const [existing] = await db
      .select()
      .from(teamSubmissionReads)
      .where(sql`${teamSubmissionReads.userId} = ${userId} AND ${teamSubmissionReads.submissionId} = ${submissionId}`);
    
    if (existing) {
      // Unmark as read
      await db
        .delete(teamSubmissionReads)
        .where(sql`${teamSubmissionReads.userId} = ${userId} AND ${teamSubmissionReads.submissionId} = ${submissionId}`);
      return false;
    } else {
      // Mark as read
      await db.insert(teamSubmissionReads).values({
        userId,
        submissionId,
      });
      return true;
    }
  }

  async getSubjectsWithSubmissionsForUser(userId: string): Promise<Array<TeamSubject & { submissions: (TeamSubmission & { isRead: boolean })[], unreadCount: number, unreadNewsCount: number, unreadSocialCount: number }>> {
    const subjects = await this.getAllSubjects();
    const allSubmissions = await db
      .select()
      .from(teamSubmissions)
      .where(and(eq(teamSubmissions.status, 'processed'), isNull(teamSubmissions.deletedAt)))
      .orderBy(desc(teamSubmissions.createdAt));
    
    // Get all read submission IDs for this user
    const readSubmissionIds = await this.getUserReadSubmissions(userId);
    const readSet = new Set(readSubmissionIds);
    
    return subjects.map(subject => {
      const subjectSubmissions = allSubmissions.filter(s => s.subjectId === subject.id);
      const submissionsWithRead = subjectSubmissions.map(s => ({
        ...s,
        isRead: readSet.has(s.id)
      }));
      // Sort: news before social, then unread before read
      submissionsWithRead.sort((a, b) => {
        // First: news articles before social media
        const aIsNews = a.sourceType !== 'social_media';
        const bIsNews = b.sourceType !== 'social_media';
        if (aIsNews !== bIsNews) return aIsNews ? -1 : 1;
        // Second: unread before read
        if (a.isRead !== b.isRead) return a.isRead ? 1 : -1;
        return 0;
      });
      const unreadItems = submissionsWithRead.filter(s => !s.isRead);
      const unreadCount = unreadItems.length;
      const unreadNewsCount = unreadItems.filter(s => s.sourceType !== 'social_media').length;
      const unreadSocialCount = unreadItems.filter(s => s.sourceType === 'social_media').length;
      return {
        ...subject,
        submissions: submissionsWithRead,
        unreadCount,
        unreadNewsCount,
        unreadSocialCount
      };
    });
  }

  async getActiveAndArchivedSubjects(userId: string): Promise<{
    active: Array<TeamSubject & { 
      submissions: (TeamSubmission & { isRead: boolean })[], 
      unreadCount: number, 
      unreadNewsCount: number, 
      unreadSocialCount: number 
    }>,
    archived: Array<TeamSubject & { 
      submissions: (TeamSubmission & { isRead: boolean })[], 
      unreadCount: number, 
      unreadNewsCount: number, 
      unreadSocialCount: number 
    }>
  }> {
    const subjects = await this.getAllSubjects();

    // Performance: this panel only ever displays recent items — a topic must
    // have activity within the last 24h to appear at all, the active list shows
    // the last 14h, and the archived list shows recently aged-out items. Loading
    // the entire processed-submissions history on every request is the main
    // reason this endpoint is slow, so bound the query to a recent window. A full
    // week comfortably covers every active window above and keeps a generous
    // archive; older items intentionally fall out of this panel.
    const SUBJECTS_LOOKBACK_HOURS = 24 * 7;
    const lookbackCutoff = new Date(Date.now() - SUBJECTS_LOOKBACK_HOURS * 60 * 60 * 1000);

    const allSubmissions = await db
      .select()
      .from(teamSubmissions)
      .where(and(
        eq(teamSubmissions.status, 'processed'),
        isNull(teamSubmissions.deletedAt),
        gte(teamSubmissions.createdAt, lookbackCutoff)
      ))
      .orderBy(desc(teamSubmissions.createdAt));
    
    const readSubmissionIds = await this.getUserReadSubmissions(userId);
    const readSet = new Set(readSubmissionIds);
    
    const now = Date.now();
    const ACTIVE_CUTOFF_HOURS = 14;
    const SUBJECT_ACTIVE_HOURS = 24;
    const FLASH_CUTOFF_HOURS = 12;
    const FLASH_MAX_NEWS = 8;
    const FLASH_MAX_SOCIAL = 8;
    const activeCutoff = now - ACTIVE_CUTOFF_HOURS * 60 * 60 * 1000;
    const subjectActiveCutoff = now - SUBJECT_ACTIVE_HOURS * 60 * 60 * 1000;
    const flashCutoff = now - FLASH_CUTOFF_HOURS * 60 * 60 * 1000;

    const sortSubmissions = (subs: (TeamSubmission & { isRead: boolean })[]) => {
      return subs.sort((a, b) => {
        // Sort order: unread news → unread social → read news → read social
        // Within each category, sort by time (most recent first)
        const aWeight = (a.isRead ? 2 : 0) + (a.sourceType === 'social_media' ? 1 : 0);
        const bWeight = (b.isRead ? 2 : 0) + (b.sourceType === 'social_media' ? 1 : 0);
        if (aWeight !== bWeight) return aWeight - bWeight;
        // Within same category, sort by time (most recent first)
        const aTime = new Date(a.publishedAt || a.createdAt).getTime();
        const bTime = new Date(b.publishedAt || b.createdAt).getTime();
        return bTime - aTime;
      });
    };

    const calcCounts = (subs: (TeamSubmission & { isRead: boolean })[]) => {
      const unreadItems = subs.filter(s => !s.isRead);
      return {
        unreadCount: unreadItems.length,
        unreadNewsCount: unreadItems.filter(s => s.sourceType !== 'social_media').length,
        unreadSocialCount: unreadItems.filter(s => s.sourceType === 'social_media').length
      };
    };

    const activeSubjects: Array<TeamSubject & { submissions: (TeamSubmission & { isRead: boolean })[], unreadCount: number, unreadNewsCount: number, unreadSocialCount: number }> = [];
    const archivedSubjects: Array<TeamSubject & { submissions: (TeamSubmission & { isRead: boolean })[], unreadCount: number, unreadNewsCount: number, unreadSocialCount: number }> = [];

    for (const subject of subjects) {
      // Skip Joe Priority / BOLO subjects - they have their own section
      if (subject.category === 'joe_priority' || subject.category === 'bolo') continue;
      
      const isFlashTopic = subject.name === FLASH_TOPIC_NAME;
      const isCJCSTopic = subject.name === CJCS_TOPIC_NAME;
      const isMataOsintTopic = subject.name === MATA_OSINT_TOPIC_NAME;
      const isSpecialTopic = isFlashTopic || isCJCSTopic || isMataOsintTopic;
      
      // For FLASH topic: include submissions where flashSubjectId matches
      // For CJCS topic: include submissions where cjcsSubjectId matches
      // For MATA/OSINT topic: include submissions where mataOsintSubjectId matches
      // For regular topics: include submissions where subjectId matches
      let subjectSubmissions: TeamSubmission[];
      if (isFlashTopic) {
        subjectSubmissions = allSubmissions.filter(s => s.flashSubjectId === subject.id);
      } else if (isCJCSTopic) {
        subjectSubmissions = allSubmissions.filter(s => s.cjcsSubjectId === subject.id);
      } else if (isMataOsintTopic) {
        subjectSubmissions = allSubmissions.filter(s => s.mataOsintSubjectId === subject.id);
      } else {
        subjectSubmissions = allSubmissions.filter(s => s.subjectId === subject.id);
      }
      
      // Special topics (FLASH, CJCS) should always appear in Active Topics, even with no submissions
      // Regular topics only appear if they have submissions
      if (subjectSubmissions.length === 0 && !isSpecialTopic) continue;

      const submissionsWithRead = subjectSubmissions.map(s => ({
        ...s,
        isRead: readSet.has(s.id)
      }));

      // Split into active and archived based on topic type
      // Special topics (FLASH, CJCS) use 12h cutoff, regular topics use 14h
      const activeSubmissions: (TeamSubmission & { isRead: boolean })[] = [];
      const archivedSubmissions: (TeamSubmission & { isRead: boolean })[] = [];
      const topicCutoff = isSpecialTopic ? flashCutoff : activeCutoff;

      for (const sub of submissionsWithRead) {
        const subTime = new Date(sub.publishedAt || sub.createdAt).getTime();
        if (subTime >= topicCutoff) {
          activeSubmissions.push(sub);
        } else {
          archivedSubmissions.push(sub);
        }
      }

      // Check if subject has any recent activity (any submission in last 24h)
      // Skip this check for special topics (they only show recent 12h items anyway)
      const hasRecentActivity = isSpecialTopic || submissionsWithRead.some(s => {
        const subTime = new Date(s.publishedAt || s.createdAt).getTime();
        return subTime >= subjectActiveCutoff;
      });

      // Add to active if has recent activity AND has active submissions
      // Special topics always appear in Active Topics even if empty
      if (hasRecentActivity && (activeSubmissions.length > 0 || isSpecialTopic)) {
        let sorted = sortSubmissions(activeSubmissions);
        
        // For FLASH topic: limit to 8 news + 8 social, sorted by priority
        if (isFlashTopic) {
          // Sort by priority first (highest priority first)
          sorted = sorted.sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));
          
          // Split into news and social
          const newsItems = sorted.filter(s => s.sourceType !== 'social_media');
          const socialItems = sorted.filter(s => s.sourceType === 'social_media');
          
          // Limit each to 8
          const limitedNews = newsItems.slice(0, FLASH_MAX_NEWS);
          const limitedSocial = socialItems.slice(0, FLASH_MAX_SOCIAL);
          
          // Combine and resort by priority
          sorted = [...limitedNews, ...limitedSocial].sort((a, b) => 
            (b.priorityScore || 0) - (a.priorityScore || 0)
          );
        }
        
        activeSubjects.push({
          ...subject,
          submissions: sorted,
          ...calcCounts(sorted)
        });
      }

      // FLASH topic should NOT appear in archived (only shows 12h of content)
      // CJCS MENTIONS should appear in archived like other topics
      if (!isFlashTopic) {
        // Always add to archived - show all submissions that are >14h old
        // Subjects appear in archived even if only to show history once items age
        if (archivedSubmissions.length > 0) {
          const sorted = sortSubmissions(archivedSubmissions);
          archivedSubjects.push({
            ...subject,
            submissions: sorted,
            ...calcCounts(sorted)
          });
        } else if (activeSubmissions.length > 0 || isCJCSTopic) {
          // Subject has activity but nothing archived yet - include with empty submissions
          // so it appears in archived panel header even if collapsed shows "No archived items"
          // CJCS MENTIONS always appears in archived (like it always appears in active)
          archivedSubjects.push({
            ...subject,
            submissions: [],
            unreadCount: 0,
            unreadNewsCount: 0,
            unreadSocialCount: 0
          });
        }
      }
    }

    // Build MOST RECENT virtual topic: all submissions from last 3 hours across all topics
    // Use createdAt (when posted to system) not publishedAt (original article date)
    const mostRecentCutoff = now - MOST_RECENT_HOURS * 60 * 60 * 1000;
    const recentSubmissions = allSubmissions
      .filter(s => {
        const subTime = new Date(s.createdAt).getTime();
        return subTime >= mostRecentCutoff;
      })
      .map(s => ({
        ...s,
        isRead: readSet.has(s.id)
      }));

    // Sort MOST RECENT purely by time (newest first), not by read/unread grouping
    const sortedRecent = [...recentSubmissions].sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return bTime - aTime;
    });
    const recentCounts = calcCounts(sortedRecent);

    // Find or create a placeholder subject entry for MOST RECENT
    const mostRecentSubject = subjects.find(s => s.name === MOST_RECENT_TOPIC_NAME);
    const mostRecentEntry = {
      id: mostRecentSubject?.id || 'most-recent-virtual',
      name: MOST_RECENT_TOPIC_NAME,
      description: 'All stories and posts from the past 3 hours',
      origin: 'manual' as const,
      createdAt: mostRecentSubject?.createdAt || new Date(),
      createdBy: mostRecentSubject?.createdBy || null,
      isActive: true,
      position: -1,
      category: null,
      isPriorityWatch: false,
      isBoloWatch: false,
      watchKeywords: [],
      estimatedDurationDays: null,
      estimatedActiveUntil: null,
      autoArchiveReason: null,
      topicId: null,
      focusArea: null,
      sourcePrompt: mostRecentSubject?.sourcePrompt ?? null,
      watchTopicLabel: mostRecentSubject?.watchTopicLabel ?? null,
      lifecycleMode: mostRecentSubject?.lifecycleMode ?? 'smart_decay',
      boostStrength: mostRecentSubject?.boostStrength ?? 'standard',
      orKeywords: mostRecentSubject?.orKeywords ?? [],
      andKeywords: mostRecentSubject?.andKeywords ?? [],
      notKeywords: mostRecentSubject?.notKeywords ?? [],
      submissions: sortedRecent,
      ...recentCounts
    };

    activeSubjects.push(mostRecentEntry);

    // Sort active subjects: FLASH first, then MOST RECENT, then CJCS MENTIONS, then MATA/OSINT, then rest
    activeSubjects.sort((a, b) => {
      const order = (name: string) => {
        if (name === FLASH_TOPIC_NAME) return 0;
        if (name === MOST_RECENT_TOPIC_NAME) return 1;
        if (name === CJCS_TOPIC_NAME) return 2;
        if (name === MATA_OSINT_TOPIC_NAME) return 3;
        return 4;
      };
      return order(a.name) - order(b.name);
    });
    
    // Sort archived subjects to ensure CJCS MENTIONS appears first
    archivedSubjects.sort((a, b) => {
      if (a.name === CJCS_TOPIC_NAME) return -1;
      if (b.name === CJCS_TOPIC_NAME) return 1;
      return 0;
    });

    return { active: activeSubjects, archived: archivedSubjects };
  }
  
  // DrudgeBot operations
  async isDrudgeBotArticlePosted(articleUrl: string): Promise<boolean> {
    // URLs are now stored in normalized form, so direct comparison works
    const [post] = await db
      .select()
      .from(drudgeBotPosts)
      .where(eq(drudgeBotPosts.articleUrl, articleUrl))
      .limit(1);
    return !!post;
  }
  
  async addDrudgeBotPost(post: InsertDrudgeBotPost): Promise<DrudgeBotPost> {
    const [newPost] = await db
      .insert(drudgeBotPosts)
      .values({ ...post, summary: stripBriefingPreamble(post.summary) })
      .returning();
    return newPost;
  }
  
  async getRecentDrudgeBotPosts(limit: number): Promise<DrudgeBotPost[]> {
    return await db
      .select()
      .from(drudgeBotPosts)
      .orderBy(desc(drudgeBotPosts.postedAt))
      .limit(limit);
  }
  
  // BBCBot operations
  async isBBCBotArticlePosted(articleUrl: string): Promise<boolean> {
    // URLs are now stored in normalized form, so direct comparison works
    const [post] = await db
      .select()
      .from(bbcBotPosts)
      .where(eq(bbcBotPosts.articleUrl, articleUrl))
      .limit(1);
    return !!post;
  }
  
  async addBBCBotPost(post: InsertBBCBotPost): Promise<BBCBotPost> {
    const [newPost] = await db
      .insert(bbcBotPosts)
      .values({ ...post, summary: stripBriefingPreamble(post.summary) })
      .returning();
    return newPost;
  }
  
  async getRecentBBCBotPosts(limit: number): Promise<BBCBotPost[]> {
    return await db
      .select()
      .from(bbcBotPosts)
      .orderBy(desc(bbcBotPosts.postedAt))
      .limit(limit);
  }
  
  // FoxNewsBot operations
  async isFoxNewsBotArticlePosted(articleUrl: string): Promise<boolean> {
    const [post] = await db
      .select()
      .from(foxNewsBotPosts)
      .where(eq(foxNewsBotPosts.articleUrl, articleUrl))
      .limit(1);
    return !!post;
  }
  
  async addFoxNewsBotPost(post: InsertFoxNewsBotPost): Promise<FoxNewsBotPost> {
    const [newPost] = await db
      .insert(foxNewsBotPosts)
      .values({ ...post, summary: stripBriefingPreamble(post.summary) })
      .returning();
    return newPost;
  }
  
  // ABCNewsBot operations
  async isABCNewsBotArticlePosted(articleUrl: string): Promise<boolean> {
    const [post] = await db
      .select()
      .from(abcNewsBotPosts)
      .where(eq(abcNewsBotPosts.articleUrl, articleUrl))
      .limit(1);
    return !!post;
  }
  
  async addABCNewsBotPost(post: InsertABCNewsBotPost): Promise<ABCNewsBotPost> {
    const [newPost] = await db
      .insert(abcNewsBotPosts)
      .values({ ...post, summary: stripBriefingPreamble(post.summary) })
      .returning();
    return newPost;
  }
  
  // CBSNewsBot operations
  async isCBSNewsBotArticlePosted(articleUrl: string): Promise<boolean> {
    const [post] = await db
      .select()
      .from(cbsNewsBotPosts)
      .where(eq(cbsNewsBotPosts.articleUrl, articleUrl))
      .limit(1);
    return !!post;
  }
  
  async addCBSNewsBotPost(post: InsertCBSNewsBotPost): Promise<CBSNewsBotPost> {
    const [newPost] = await db
      .insert(cbsNewsBotPosts)
      .values({ ...post, summary: stripBriefingPreamble(post.summary) })
      .returning();
    return newPost;
  }
  
  // NBCNewsBot operations
  async isNBCNewsBotArticlePosted(articleUrl: string): Promise<boolean> {
    const [post] = await db
      .select()
      .from(nbcNewsBotPosts)
      .where(eq(nbcNewsBotPosts.articleUrl, articleUrl))
      .limit(1);
    return !!post;
  }
  
  async addNBCNewsBotPost(post: InsertNBCNewsBotPost): Promise<NBCNewsBotPost> {
    const [newPost] = await db
      .insert(nbcNewsBotPosts)
      .values({ ...post, summary: stripBriefingPreamble(post.summary) })
      .returning();
    return newPost;
  }
  
  // APNewsBot operations
  async isAPNewsBotArticlePosted(articleUrl: string): Promise<boolean> {
    const [post] = await db
      .select()
      .from(apNewsBotPosts)
      .where(eq(apNewsBotPosts.articleUrl, articleUrl))
      .limit(1);
    return !!post;
  }
  
  async addAPNewsBotPost(post: InsertAPNewsBotPost): Promise<APNewsBotPost> {
    const [newPost] = await db
      .insert(apNewsBotPosts)
      .values({ ...post, summary: stripBriefingPreamble(post.summary) })
      .returning();
    return newPost;
  }
  
  // ReutersBot operations
  async isReutersBotArticlePosted(articleUrl: string): Promise<boolean> {
    const [post] = await db
      .select()
      .from(reutersBotPosts)
      .where(eq(reutersBotPosts.articleUrl, articleUrl))
      .limit(1);
    return !!post;
  }
  
  async addReutersBotPost(post: InsertReutersBotPost): Promise<ReutersBotPost> {
    const [newPost] = await db
      .insert(reutersBotPosts)
      .values({ ...post, summary: stripBriefingPreamble(post.summary) })
      .returning();
    return newPost;
  }

  async isRSSBotArticlePosted(articleUrl: string): Promise<boolean> {
    const [post] = await db
      .select()
      .from(rssBotPosts)
      .where(eq(rssBotPosts.articleUrl, articleUrl))
      .limit(1);
    return !!post;
  }

  async addRSSBotPost(post: InsertRSSBotPost): Promise<RSSBotPost> {
    const [newPost] = await db
      .insert(rssBotPosts)
      .values({ ...post, summary: stripBriefingPreamble(post.summary) })
      .returning();
    return newPost;
  }

  async isArticlePostedByAnyBot(articleUrl: string): Promise<boolean> {
    const checks = await withDbRetry(() => Promise.all([
      db.select().from(drudgeBotPosts).where(eq(drudgeBotPosts.articleUrl, articleUrl)).limit(1),
      db.select().from(bbcBotPosts).where(eq(bbcBotPosts.articleUrl, articleUrl)).limit(1),
      db.select().from(foxNewsBotPosts).where(eq(foxNewsBotPosts.articleUrl, articleUrl)).limit(1),
      db.select().from(abcNewsBotPosts).where(eq(abcNewsBotPosts.articleUrl, articleUrl)).limit(1),
      db.select().from(cbsNewsBotPosts).where(eq(cbsNewsBotPosts.articleUrl, articleUrl)).limit(1),
      db.select().from(nbcNewsBotPosts).where(eq(nbcNewsBotPosts.articleUrl, articleUrl)).limit(1),
      db.select().from(apNewsBotPosts).where(eq(apNewsBotPosts.articleUrl, articleUrl)).limit(1),
      db.select().from(reutersBotPosts).where(eq(reutersBotPosts.articleUrl, articleUrl)).limit(1),
      db.select().from(rssBotPosts).where(eq(rssBotPosts.articleUrl, articleUrl)).limit(1),
    ]));
    return checks.some(result => result.length > 0);
  }

  // Mark submission as Joe emailed
  async markSubmissionAsJoeEmailed(submissionId: string, emailedBy: string): Promise<TeamSubmission | null> {
    const [submission] = await db
      .update(teamSubmissions)
      .set({
        joeEmailedAt: new Date(),
        joeEmailedBy: emailedBy,
        updatedAt: new Date()
      })
      .where(eq(teamSubmissions.id, submissionId))
      .returning();
    return submission || null;
  }

  // Soft delete a team submission and block bot re-posting
  async softDeleteSubmission(submissionId: string, deletedBy: string): Promise<TeamSubmission | null> {
    const [submission] = await db
      .update(teamSubmissions)
      .set({
        deletedAt: new Date(),
        deletedBy: deletedBy,
        updatedAt: new Date()
      })
      .where(eq(teamSubmissions.id, submissionId))
      .returning();
    
    if (submission) {
      // Block bot from re-posting this content
      const normalizedUrl = this.normalizeUrlForBlocking(submission.sourceUrl);
      try {
        await db.insert(blockedBotContent).values({
          normalizedUrl,
          sourceType: submission.sourceType,
          headline: submission.headline,
          blockedBy: deletedBy
        }).onConflictDoNothing();
      } catch (error) {
        console.error('[Storage] Error blocking bot content:', error);
      }
    }
    
    return submission || null;
  }

  // Normalize URL for bot blocking (consistent format)
  private normalizeUrlForBlocking(url: string): string {
    try {
      const urlObj = new URL(url);
      let normalized = 'https://' + urlObj.host + urlObj.pathname;
      normalized = normalized.replace(/\/+$/, '');
      return normalized.toLowerCase();
    } catch {
      let normalized = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
      normalized = normalized.replace(/^http:/, 'https:');
      return normalized.toLowerCase();
    }
  }

  // Check if bot content is blocked (deleted by user)
  async isBotContentBlocked(url: string): Promise<boolean> {
    const normalizedUrl = this.normalizeUrlForBlocking(url);
    const [blocked] = await db
      .select()
      .from(blockedBotContent)
      .where(eq(blockedBotContent.normalizedUrl, normalizedUrl))
      .limit(1);
    return !!blocked;
  }

  // Get all active subjects (for topic management)
  async getActiveSubjects(): Promise<TeamSubject[]> {
    return await db
      .select()
      .from(teamSubjects)
      .where(eq(teamSubjects.isActive, true))
      .orderBy(teamSubjects.position);
  }

  // Targeted query for the scheduler's smart-decay extension loop: only active
  // topics with an AI-estimated active window set and not on the 'hold'
  // lifecycle. Avoids loading the full subject list every night.
  async getSmartDecayExpiryCandidates(): Promise<TeamSubject[]> {
    return await db
      .select()
      .from(teamSubjects)
      .where(
        and(
          eq(teamSubjects.isActive, true),
          isNotNull(teamSubjects.estimatedActiveUntil),
          or(
            isNull(teamSubjects.lifecycleMode),
            ne(teamSubjects.lifecycleMode, 'hold'),
          ),
        ),
      );
  }

  async getInactiveSubjects(): Promise<TeamSubject[]> {
    return await db
      .select()
      .from(teamSubjects)
      .where(eq(teamSubjects.isActive, false))
      .orderBy(teamSubjects.position);
  }

  // Reorder subjects with position and active status updates
  async reorderSubjects(updates: Array<{ id: string; isActive: boolean; position: number }>): Promise<void> {
    for (const update of updates) {
      await db
        .update(teamSubjects)
        .set({ isActive: update.isActive, position: update.position })
        .where(eq(teamSubjects.id, update.id));
    }
  }

  // Update subject active status (move between active/old)
  async updateSubjectActiveStatus(id: string, isActive: boolean): Promise<TeamSubject | null> {
    const [updated] = await db
      .update(teamSubjects)
      .set({ isActive })
      .where(eq(teamSubjects.id, id))
      .returning();
    return updated || null;
  }

  // Auto-archive watch topics whose AI-estimated active window has elapsed.
  // Respects lifecycleMode: 'hold' topics are NEVER auto-archived. Smart-decay
  // topics are archived only when expired AND NOT extended by recent match volume.
  async archiveExpiredWatchTopics(): Promise<number> {
    const archived = await db
      .update(teamSubjects)
      .set({ isActive: false, autoArchiveReason: 'Expired after AI-estimated watch duration' })
      .where(and(
        eq(teamSubjects.isActive, true),
        isNotNull(teamSubjects.estimatedActiveUntil),
        lt(teamSubjects.estimatedActiveUntil, new Date()),
        // 'hold' topics are exempt from auto-archive.
        sql`(lifecycle_mode IS NULL OR lifecycle_mode = 'smart_decay')`,
      ))
      .returning({ id: teamSubjects.id });
    return archived.length;
  }

  // Task #1039: update editable watch-topic detail fields.
  async updateWatchTopicDetail(id: string, fields: {
    name?: string;
    description?: string | null;
    watchTopicLabel?: string | null;
    lifecycleMode?: string;
    boostStrength?: string;
    orKeywords?: string[];
    andKeywords?: string[];
    notKeywords?: string[];
    topicId?: string | null;
    focusArea?: string | null;
    estimatedActiveUntil?: Date | null;
  }): Promise<TeamSubject | null> {
    const update: Record<string, unknown> = {};
    if (fields.name !== undefined) update.name = fields.name;
    if ('description' in fields) update.description = fields.description;
    if ('watchTopicLabel' in fields) update.watchTopicLabel = fields.watchTopicLabel;
    if (fields.lifecycleMode !== undefined) update.lifecycleMode = fields.lifecycleMode;
    if (fields.boostStrength !== undefined) update.boostStrength = fields.boostStrength;
    if (fields.orKeywords !== undefined) update.orKeywords = fields.orKeywords;
    if (fields.andKeywords !== undefined) update.andKeywords = fields.andKeywords;
    if (fields.notKeywords !== undefined) update.notKeywords = fields.notKeywords;
    if ('topicId' in fields) update.topicId = fields.topicId;
    if ('focusArea' in fields) update.focusArea = fields.focusArea;
    if ('estimatedActiveUntil' in fields) update.estimatedActiveUntil = fields.estimatedActiveUntil;
    if (Object.keys(update).length === 0) {
      const [row] = await db.select().from(teamSubjects).where(eq(teamSubjects.id, id)).limit(1);
      return row || null;
    }
    const [updated] = await db.update(teamSubjects).set(update as any).where(eq(teamSubjects.id, id)).returning();
    return updated || null;
  }

  // Task #1039: record one match telemetry row (fire-and-forget, non-blocking).
  async recordWatchTopicMatch(input: {
    topicId: string; baseScore: number; boostedScore: number; canonicalUrl: string;
    steeringKind: 'priority' | 'bolo' | 'us-implication'; boostStrength?: string | null;
    intakeMode: 'gate' | 'reuse'; boloRescueAttempted: boolean; boloRescueUsed: boolean;
    boloBudgetBlocked: boolean; usImplicationApplied: boolean; usImplicationReason?: string | null;
    eventKey: string;
  }): Promise<void> {
    await db.insert(watchTopicTelemetry).values(input).onConflictDoNothing({
      target: watchTopicTelemetry.eventKey,
    });
  }

  async getWatchTopicTelemetryForCanonicalUrls(canonicalUrls: string[], since: Date): Promise<typeof watchTopicTelemetry.$inferSelect[]> {
    const urls = [...new Set(canonicalUrls.filter(Boolean))];
    if (urls.length === 0) return [];
    return await db.select().from(watchTopicTelemetry).where(and(
      inArray(watchTopicTelemetry.canonicalUrl, urls),
      gte(watchTopicTelemetry.matchedAt, since),
    ));
  }

  // Task #1039: compute per-topic impact stats from the telemetry table.
  async getWatchTopicStats(topicId: string): Promise<{ avgMatchesPerDay: number; avgBaseScore: number; currentBoostStrength: string }> {
    const WINDOW_DAYS = 30;
    const since = new Date(Date.now() - WINDOW_DAYS * 86400_000);
    const [subject] = await db.select({ boostStrength: teamSubjects.boostStrength })
      .from(teamSubjects).where(eq(teamSubjects.id, topicId)).limit(1);
    const [agg] = await db.select({
      count: sql<number>`count(*)::int`,
      avgBase: sql<number>`coalesce(avg(base_score),0)::float`,
    }).from(watchTopicTelemetry).where(
      and(
        sql`topic_id = ${topicId}`,
        sql`matched_at >= ${since}`,
      )
    );
    const count = agg?.count ?? 0;
    const avgMatchesPerDay = count / WINDOW_DAYS;
    return {
      avgMatchesPerDay: Math.round(avgMatchesPerDay * 10) / 10,
      avgBaseScore: Math.round(agg?.avgBase ?? 0),
      currentBoostStrength: subject?.boostStrength || 'standard',
    };
  }

  // Task #1039: prune old telemetry rows (keep only last ~30 days by default).
  async pruneWatchTopicTelemetry(olderThanDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
    const deleted = await db.delete(watchTopicTelemetry)
      .where(sql`matched_at < ${cutoff}`)
      .returning({ id: watchTopicTelemetry.id });
    return deleted.length;
  }

  // Task #1039: smart-decay auto-extension. If a topic has had ≥ minMatchesPerDay
  // average matches in the last 7 days, extend its estimatedActiveUntil forward
  // by extensionDays so an active story isn't archived mid-stream. Returns true
  // if extended.
  async smartDecayExtendIfActive(topicId: string, extensionDays = 7, minMatchesPerDay = 0.5): Promise<boolean> {
    const CHECK_DAYS = 7;
    const since = new Date(Date.now() - CHECK_DAYS * 86400_000);
    const [agg] = await db.select({ count: sql<number>`count(*)::int` })
      .from(watchTopicTelemetry)
      .where(and(sql`topic_id = ${topicId}`, sql`matched_at >= ${since}`));
    const recentCount = agg?.count ?? 0;
    const ratePerDay = recentCount / CHECK_DAYS;
    if (ratePerDay < minMatchesPerDay) return false;
    const [subject] = await db.select({ estimatedActiveUntil: teamSubjects.estimatedActiveUntil })
      .from(teamSubjects).where(eq(teamSubjects.id, topicId)).limit(1);
    if (!subject?.estimatedActiveUntil) return false;
    // Only extend if the current expiry is within the next week (imminent).
    const now = new Date();
    const daysUntilExpiry = (subject.estimatedActiveUntil.getTime() - now.getTime()) / 86400_000;
    if (daysUntilExpiry > extensionDays) return false;
    const newExpiry = new Date(now.getTime() + extensionDays * 86400_000);
    await db.update(teamSubjects)
      .set({ estimatedActiveUntil: newExpiry, autoArchiveReason: null })
      .where(eq(teamSubjects.id, topicId));
    return true;
  }

  // Delete subject with mode: 'delete' removes submissions, 'move' relocates them
  async deleteSubjectWithMode(id: string, mode: 'delete' | 'move'): Promise<{ success: boolean; movedCount?: number }> {
    const subject = await this.getSubjectById(id);
    if (!subject) {
      return { success: false };
    }

    // Get all submissions for this subject (both regular and flash)
    const submissions = await db
      .select()
      .from(teamSubmissions)
      .where(and(
        or(eq(teamSubmissions.subjectId, id), eq(teamSubmissions.flashSubjectId, id)),
        isNull(teamSubmissions.deletedAt)
      ));

    if (mode === 'delete') {
      // Soft delete all submissions for this subject
      for (const submission of submissions) {
        await this.softDeleteSubmission(submission.id, 'topic_deletion');
      }
    } else if (submissions.length > 0) {
      // Move submissions to closest matching topic or Emerging
      let emergingSubject = await this.getSubjectByName('Emerging');
      
      // If Emerging doesn't exist, create it
      if (!emergingSubject) {
        emergingSubject = await this.addSubject({
          name: 'Emerging',
          description: 'Newly emerging topics and uncategorized items',
          origin: 'manual',
          createdBy: 'system'
        });
      }
      
      const allSubjects = await this.getAllSubjects();
      const otherSubjects = allSubjects.filter(s => s.id !== id && s.name !== 'FLASH: TOP STORIES');

      for (const submission of submissions) {
        // Find closest matching topic by checking subject name similarity
        let targetSubjectId = emergingSubject.id;
        
        // Try to find a matching subject based on headline keywords
        if (otherSubjects.length > 1) {
          const headlineLower = submission.headline.toLowerCase();
          for (const otherSubject of otherSubjects) {
            if (otherSubject.id === emergingSubject.id) continue;
            const subjectNameLower = otherSubject.name.toLowerCase();
            // Simple keyword matching: check if subject name words appear in headline
            const words = subjectNameLower.split(/\s+/).filter(w => w.length > 3);
            const matches = words.some(word => headlineLower.includes(word));
            if (matches) {
              targetSubjectId = otherSubject.id;
              break;
            }
          }
        }

        // Update both subjectId and clear flashSubjectId if it matched the deleted topic
        const updateData: { subjectId?: string; flashSubjectId?: string | null } = {};
        if (submission.subjectId === id) {
          updateData.subjectId = targetSubjectId;
        }
        if (submission.flashSubjectId === id) {
          updateData.flashSubjectId = null;
        }
        
        if (Object.keys(updateData).length > 0) {
          await db
            .update(teamSubmissions)
            .set(updateData)
            .where(eq(teamSubmissions.id, submission.id));
        }
      }
    }

    // Delete the subject itself
    await db.delete(teamSubjects).where(eq(teamSubjects.id, id));

    return { success: true, movedCount: mode === 'move' ? submissions.length : undefined };
  }

  // SocialBot operations
  async isSocialPostReposted(postId: string, source: string): Promise<boolean> {
    const [existing] = await db
      .select()
      .from(socialBotPosts)
      .where(and(
        eq(socialBotPosts.postId, postId),
        eq(socialBotPosts.source, source)
      ))
      .limit(1);
    return !!existing;
  }

  async addSocialBotPost(post: InsertSocialBotPost): Promise<SocialBotPost> {
    const [newPost] = await db
      .insert(socialBotPosts)
      .values(post)
      .returning();
    return newPost;
  }

  async getTruthSocialPostsSince(since: Date): Promise<TruthSocialPost[]> {
    return await db
      .select()
      .from(truthSocialPosts)
      .where(gte(truthSocialPosts.postedAt, since))
      .orderBy(desc(truthSocialPosts.postedAt));
  }

  async getXPostsSince(since: Date, sourceAccount?: string): Promise<XPost[]> {
    const conditions = [gte(xPosts.postedAt, since)];
    if (sourceAccount) {
      conditions.push(eq(xPosts.sourceAccount, sourceAccount));
    }
    return await db
      .select()
      .from(xPosts)
      .where(and(...conditions))
      .orderBy(desc(xPosts.postedAt));
  }

  async getAllTeamMembers(): Promise<TeamMember[]> {
    return await db
      .select()
      .from(teamMembers)
      .orderBy(desc(teamMembers.addedAt));
  }

  async getTeamMemberByEmail(email: string): Promise<TeamMember | undefined> {
    const normalizedEmail = email.toLowerCase().trim();
    const [member] = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.email, normalizedEmail))
      .limit(1);
    return member;
  }

  async addTeamMember(email: string, addedBy: string): Promise<TeamMember> {
    const normalizedEmail = email.toLowerCase().trim();
    const [member] = await db
      .insert(teamMembers)
      .values({ email: normalizedEmail, addedBy })
      .returning();
    return member;
  }

  async removeTeamMember(id: string): Promise<void> {
    await db.delete(teamMembers).where(eq(teamMembers.id, id));
  }

  async isTeamMember(email: string): Promise<boolean> {
    const normalizedEmail = email.toLowerCase().trim();
    const [member] = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.email, normalizedEmail))
      .limit(1);
    return !!member;
  }

  async isWarfighterCyberAllowed(email: string): Promise<boolean> {
    const normalizedEmail = email.toLowerCase().trim();
    const [row] = await db
      .select()
      .from(warfighterCyberAllowed)
      .where(eq(warfighterCyberAllowed.email, normalizedEmail))
      .limit(1);
    return !!row;
  }

  async isCuratedViewTester(email: string): Promise<boolean> {
    const normalizedEmail = email.toLowerCase().trim();
    const [tester] = await db
      .select()
      .from(curatedViewTesters)
      .where(eq(curatedViewTesters.email, normalizedEmail))
      .limit(1);
    return !!tester;
  }

  async getWarArticles(): Promise<WarArticle[]> {
    return db.select().from(warArticles).orderBy(desc(warArticles.priorityScore), desc(warArticles.createdAt));
  }

  async getWarArticleById(id: string): Promise<WarArticle | undefined> {
    const results = await db.select().from(warArticles).where(eq(warArticles.id, id)).limit(1);
    return results[0];
  }

  async addWarArticle(article: InsertWarArticle): Promise<WarArticle> {
    const [result] = await db.insert(warArticles).values(article).returning();
    return result;
  }

  async updateWarArticle(id: string, updates: Partial<InsertWarArticle>): Promise<WarArticle> {
    const [result] = await db.update(warArticles)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(warArticles.id, id))
      .returning();
    return result;
  }

  async deleteWarArticle(id: string): Promise<void> {
    await db.delete(warArticles).where(eq(warArticles.id, id));
  }

  async getWarSettings(): Promise<WarSettings> {
    const results = await db.select().from(warSettings).where(eq(warSettings.id, 'global')).limit(1);
    if (results.length === 0) {
      const [created] = await db.insert(warSettings).values({ id: 'global', feedFromMcop: true }).returning();
      return created;
    }
    return results[0];
  }

  async updateWarSettings(feedFromMcop: boolean): Promise<WarSettings> {
    const [result] = await db.update(warSettings)
      .set({ feedFromMcop, updatedAt: new Date() })
      .where(eq(warSettings.id, 'global'))
      .returning();
    return result;
  }

  async getAiSettings(): Promise<AiSettings> {
    const results = await db.select().from(aiSettings).where(eq(aiSettings.id, 'global')).limit(1);
    if (results.length === 0) {
      const [created] = await db.insert(aiSettings).values({ id: 'global', provider: 'auto' }).returning();
      return created;
    }
    return results[0];
  }

  async updateAiSettings(provider: AiProviderMode): Promise<AiSettings> {
    const [result] = await db.insert(aiSettings)
      .values({ id: 'global', provider, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: aiSettings.id,
        set: { provider, updatedAt: new Date() },
      })
      .returning();
    return result;
  }

  async getWarOverrides(): Promise<WarOverride[]> {
    return db.select().from(warOverrides);
  }

  async getWarOverrideByHeadlineId(headlineId: string): Promise<WarOverride | undefined> {
    const results = await db.select().from(warOverrides).where(eq(warOverrides.headlineId, headlineId)).limit(1);
    return results[0];
  }

  async upsertWarOverride(headlineId: string, updates: { title?: string | null; imageUrl?: string | null; summaryBullets?: string[] | null; priorityScore?: number | null }): Promise<WarOverride> {
    const existing = await this.getWarOverrideByHeadlineId(headlineId);
    if (existing) {
      const [result] = await db.update(warOverrides)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(warOverrides.headlineId, headlineId))
        .returning();
      return result;
    } else {
      const [result] = await db.insert(warOverrides)
        .values({ headlineId, ...updates })
        .returning();
      return result;
    }
  }

  async deleteWarOverride(headlineId: string): Promise<void> {
    await db.delete(warOverrides).where(eq(warOverrides.headlineId, headlineId));
  }

  async getWarScreenshots(): Promise<WarScreenshot[]> {
    return db.select().from(warScreenshots).orderBy(desc(warScreenshots.createdAt));
  }

  async addWarScreenshot(screenshot: InsertWarScreenshot): Promise<WarScreenshot> {
    const [result] = await db.insert(warScreenshots).values(screenshot).returning();
    return result;
  }

  async updateWarScreenshot(id: string, updates: Partial<InsertWarScreenshot>): Promise<WarScreenshot> {
    const [result] = await db.update(warScreenshots)
      .set(updates)
      .where(eq(warScreenshots.id, id))
      .returning();
    return result;
  }

  async deleteWarScreenshot(id: string): Promise<void> {
    await db.delete(warScreenshots).where(eq(warScreenshots.id, id));
  }

  async insertArticleQuotes(quotes: InsertArticleQuote[]): Promise<void> {
    if (quotes.length === 0) return;
    await db.insert(articleQuotes).values(quotes);
  }

  async searchArticleQuotes(params: { speaker?: string; tag?: string; keyword?: string; fromDate?: string; toDate?: string; limit?: number; offset?: number }): Promise<{ quotes: ArticleQuote[]; total: number }> {
    const conditions: any[] = [];

    if (params.speaker) {
      conditions.push(ilike(articleQuotes.normalizedSpeaker, `%${params.speaker}%`));
    }
    if (params.tag) {
      conditions.push(sql`${params.tag} = ANY(${articleQuotes.subjectTags})`);
    }
    if (params.keyword) {
      conditions.push(
        or(
          ilike(articleQuotes.quoteText, `%${params.keyword}%`),
          ilike(articleQuotes.context, `%${params.keyword}%`),
          ilike(articleQuotes.normalizedSpeaker, `%${params.keyword}%`)
        )
      );
    }
    if (params.fromDate) {
      conditions.push(gte(articleQuotes.dateSpoken, new Date(params.fromDate)));
    }
    if (params.toDate) {
      const endDate = new Date(params.toDate);
      endDate.setUTCDate(endDate.getUTCDate() + 1);
      conditions.push(lt(articleQuotes.dateSpoken, endDate));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(articleQuotes)
      .where(whereClause);

    const quotes = await db
      .select()
      .from(articleQuotes)
      .where(whereClause)
      .orderBy(desc(articleQuotes.createdAt))
      .limit(limit)
      .offset(offset);

    return { quotes, total: countResult?.count || 0 };
  }

  async getQuotesForStory(storyId: string): Promise<ArticleQuote[]> {
    return await db.select().from(articleQuotes).where(eq(articleQuotes.storyId, storyId));
  }

  async hasQuotesForStory(storyId: string): Promise<boolean> {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(articleQuotes)
      .where(eq(articleQuotes.storyId, storyId));
    return (result?.count || 0) > 0;
  }

  async getArticleQuoteStats(): Promise<{ totalQuotes: number; storiesProcessed: number; storiesRemaining: number }> {
    const [quotesCount] = await db.select({ count: sql<number>`count(*)::int` }).from(articleQuotes);
    const [processedCount] = await db.select({ count: sql<number>`count(DISTINCT story_id)::int` }).from(articleQuotes);
    const [totalWithText] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(teamSubmissions)
      .where(and(
        isNull(teamSubmissions.deletedAt),
        sql`${teamSubmissions.fullText} IS NOT NULL AND length(${teamSubmissions.fullText}) > 100`
      ));

    const totalQuotes = quotesCount?.count || 0;
    const storiesProcessed = processedCount?.count || 0;
    const storiesRemaining = Math.max(0, (totalWithText?.count || 0) - storiesProcessed);

    return { totalQuotes, storiesProcessed, storiesRemaining };
  }

  async addRelayTruthSocialPost(post: InsertRelayTruthSocialPost): Promise<RelayTruthSocialPost> {
    const [result] = await db
      .insert(relayTruthSocialPosts)
      .values(post)
      .returning();
    return result;
  }

  async getRelayTruthSocialPostByPostId(postId: string): Promise<RelayTruthSocialPost | undefined> {
    const [post] = await db
      .select()
      .from(relayTruthSocialPosts)
      .where(eq(relayTruthSocialPosts.postId, postId));
    return post || undefined;
  }

  async getRecentRelayTruthSocialPosts(limit: number): Promise<RelayTruthSocialPost[]> {
    return await db
      .select()
      .from(relayTruthSocialPosts)
      .orderBy(desc(relayTruthSocialPosts.receivedAt))
      .limit(limit);
  }

  async getRelayTruthSocialPostsMissingMedia(): Promise<RelayTruthSocialPost[]> {
    return await db
      .select()
      .from(relayTruthSocialPosts)
      .where(
        or(
          and(
            isNull(relayTruthSocialPosts.imageUrl),
            isNull(relayTruthSocialPosts.videoUrl),
          ),
          isNull(relayTruthSocialPosts.videoThumbnailUrl),
        ),
      )
      .orderBy(desc(relayTruthSocialPosts.receivedAt));
  }

  async updateRelayTruthSocialPostMedia(
    id: string,
    fields: { imageUrl?: string | null; videoUrl?: string | null; videoThumbnailUrl?: string | null }
  ): Promise<void> {
    const update: Record<string, string | null> = {};
    if (fields.imageUrl !== undefined) update.imageUrl = fields.imageUrl;
    if (fields.videoUrl !== undefined) update.videoUrl = fields.videoUrl;
    if (fields.videoThumbnailUrl !== undefined) update.videoThumbnailUrl = fields.videoThumbnailUrl;
    if (Object.keys(update).length === 0) return;
    await db.update(relayTruthSocialPosts).set(update).where(eq(relayTruthSocialPosts.id, id));
  }

  // ===== Custom MCOPs =====
  async listCustomMcops(): Promise<CustomMcop[]> {
    return await db.select().from(customMcops).orderBy(desc(customMcops.createdAt));
  }

  async getCustomMcopBySlug(slug: string): Promise<CustomMcop | undefined> {
    const [row] = await db.select().from(customMcops).where(eq(customMcops.slug, slug));
    return row || undefined;
  }

  async getCustomMcopById(id: string): Promise<CustomMcop | undefined> {
    const [row] = await db.select().from(customMcops).where(eq(customMcops.id, id));
    return row || undefined;
  }

  async createCustomMcop(data: InsertCustomMcop): Promise<CustomMcop> {
    const [row] = await db.insert(customMcops).values(data).returning();
    return row;
  }

  async updateCustomMcop(id: string, fields: Partial<InsertCustomMcop>): Promise<CustomMcop | undefined> {
    const [row] = await db
      .update(customMcops)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(customMcops.id, id))
      .returning();
    return row || undefined;
  }

  async deleteCustomMcop(id: string): Promise<void> {
    await db.delete(customMcopScores).where(eq(customMcopScores.mcopId, id));
    await db.delete(customMcopArticles).where(eq(customMcopArticles.mcopId, id));
    await db.delete(customMcopScreenshots).where(eq(customMcopScreenshots.mcopId, id));
    await db.delete(customMcops).where(eq(customMcops.id, id));
  }

  async setCustomMcopPasswordHash(id: string, hash: string): Promise<void> {
    await db
      .update(customMcops)
      .set({ adminPasswordHash: hash, updatedAt: new Date() })
      .where(eq(customMcops.id, id));
  }

  async getCustomMcopArticles(mcopId: string): Promise<CustomMcopArticle[]> {
    return db
      .select()
      .from(customMcopArticles)
      .where(eq(customMcopArticles.mcopId, mcopId))
      .orderBy(desc(customMcopArticles.priorityScore), desc(customMcopArticles.createdAt));
  }

  async getCustomMcopArticleById(id: string): Promise<CustomMcopArticle | undefined> {
    const [row] = await db.select().from(customMcopArticles).where(eq(customMcopArticles.id, id)).limit(1);
    return row || undefined;
  }

  async addCustomMcopArticle(article: InsertCustomMcopArticle): Promise<CustomMcopArticle> {
    const [row] = await db.insert(customMcopArticles).values(article).returning();
    return row;
  }

  async updateCustomMcopArticle(id: string, updates: Partial<InsertCustomMcopArticle>): Promise<CustomMcopArticle> {
    const [row] = await db
      .update(customMcopArticles)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(customMcopArticles.id, id))
      .returning();
    return row;
  }

  async deleteCustomMcopArticle(id: string): Promise<void> {
    await db.delete(customMcopArticles).where(eq(customMcopArticles.id, id));
  }

  async getCustomMcopScreenshots(mcopId: string): Promise<CustomMcopScreenshot[]> {
    return db
      .select()
      .from(customMcopScreenshots)
      .where(eq(customMcopScreenshots.mcopId, mcopId))
      .orderBy(desc(customMcopScreenshots.createdAt));
  }

  async addCustomMcopScreenshot(screenshot: InsertCustomMcopScreenshot): Promise<CustomMcopScreenshot> {
    const [row] = await db.insert(customMcopScreenshots).values(screenshot).returning();
    return row;
  }

  async deleteCustomMcopScreenshot(id: string): Promise<void> {
    await db.delete(customMcopScreenshots).where(eq(customMcopScreenshots.id, id));
  }

  async getCustomMcopScores(mcopId: string, sourceType: string, sourceIds: string[]): Promise<Map<string, CustomMcopScore>> {
    if (sourceIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(customMcopScores)
      .where(
        and(
          eq(customMcopScores.mcopId, mcopId),
          eq(customMcopScores.sourceType, sourceType),
          inArray(customMcopScores.sourceId, sourceIds),
        ),
      );
    const map = new Map<string, CustomMcopScore>();
    for (const row of rows) map.set(row.sourceId, row);
    return map;
  }

  async getScoredHeadlineIdsForMcop(mcopId: string): Promise<Set<string>> {
    const rows = await db
      .select({ sourceId: customMcopScores.sourceId })
      .from(customMcopScores)
      .where(and(eq(customMcopScores.mcopId, mcopId), eq(customMcopScores.sourceType, 'headline')));
    return new Set(rows.map(r => r.sourceId));
  }

  async upsertCustomMcopScore(mcopId: string, sourceType: string, sourceId: string, priorityScore: number, isRelevant: boolean, reason?: string | null): Promise<void> {
    await db
      .insert(customMcopScores)
      .values({ mcopId, sourceType, sourceId, priorityScore, isRelevant, reason: reason ?? null })
      .onConflictDoUpdate({
        target: [customMcopScores.mcopId, customMcopScores.sourceType, customMcopScores.sourceId],
        set: { priorityScore, isRelevant, reason: reason ?? null, scoredAt: new Date() },
      });
  }

  async getCustomMcopHiddenItems(mcopId: string): Promise<CustomMcopHiddenItem[]> {
    return db
      .select()
      .from(customMcopHiddenItems)
      .where(eq(customMcopHiddenItems.mcopId, mcopId))
      .orderBy(desc(customMcopHiddenItems.hiddenAt));
  }

  async getCustomMcopHiddenKeys(mcopId: string): Promise<Set<string>> {
    const rows = await db
      .select({ sourceType: customMcopHiddenItems.sourceType, sourceId: customMcopHiddenItems.sourceId })
      .from(customMcopHiddenItems)
      .where(eq(customMcopHiddenItems.mcopId, mcopId));
    return new Set(rows.map(r => `${r.sourceType}:${r.sourceId}`));
  }

  async addCustomMcopHiddenItem(mcopId: string, sourceType: string, sourceId: string): Promise<void> {
    await db
      .insert(customMcopHiddenItems)
      .values({ mcopId, sourceType, sourceId })
      .onConflictDoNothing();
  }

  async removeCustomMcopHiddenItem(mcopId: string, sourceType: string, sourceId: string): Promise<void> {
    await db
      .delete(customMcopHiddenItems)
      .where(and(
        eq(customMcopHiddenItems.mcopId, mcopId),
        eq(customMcopHiddenItems.sourceType, sourceType),
        eq(customMcopHiddenItems.sourceId, sourceId),
      ));
  }

  // Outlet registry — canonical source knowledge / labeling layer. Read only by
  // the Curated view + Team oversight surface; never joined by any shared feed.
  async getOutletRegistry(): Promise<OutletRegistry[]> {
    return await db.select().from(outletRegistry).orderBy(outletRegistry.canonicalName);
  }

  async getOutletRegistryById(id: string): Promise<OutletRegistry | undefined> {
    const [row] = await db.select().from(outletRegistry).where(eq(outletRegistry.id, id));
    return row;
  }

  // Fail-OPEN main-feed admission context (Task #533): build + cache (~5 min) the
  // registry-derived "curated only" outlet IDs and an outlet-resolver index. On
  // any error returns null so callers allow the promotion (never block on a build
  // failure).
  private async getCuratedOnlyMainFeedCtx(): Promise<{ ids: Set<string>; index: OutletIndex } | null> {
    try {
      const now = Date.now();
      if (_curatedOnlyMainFeedCtx && now - _curatedOnlyMainFeedCtx.at < CURATED_ONLY_MAINFEED_TTL_MS) {
        return _curatedOnlyMainFeedCtx;
      }
      const rows = await this.getOutletRegistry();
      _curatedOnlyMainFeedCtx = {
        at: now,
        ids: buildCuratedOnlyOutletIds(rows),
        index: buildOutletIndex(rows),
      };
      return _curatedOnlyMainFeedCtx;
    } catch (err) {
      console.error('[FUNNEL:PROMOTE] curated-only context build failed (fail-open, allowing promotion):', err);
      return null;
    }
  }

  // Returns true ONLY when the outlet POSITIVELY resolves to a registry row that
  // is marked "curated only" in Source Oversight. Unknown / unresolved outlets,
  // or an empty/failed context, return false (allowed) so a missing registry
  // entry can never silently block a legitimate main-feed source. Resolves by
  // sourceName first, then by the article URL's domain.
  async isOutletCuratedOnlyForMainFeed(sourceName?: string | null, sourceUrl?: string | null): Promise<boolean> {
    const ctx = await this.getCuratedOnlyMainFeedCtx();
    if (!ctx) return false;
    return isCuratedOnlyForMainFeed(ctx.index, ctx.ids, sourceName ?? null, sourceUrl ?? null);
  }

  // Apply reference-derived descriptive fields. Fields present in manualOverrides
  // are skipped (overrides win). Updates per-field provenance and, on a strong
  // match, upgrades confirmation. NEVER touches `role` (no auto-promotion) and
  // never downgrades confirmation.
  async applyOutletEnrichment(
    id: string,
    fields: Record<string, unknown>,
    source: string,
    confirmed: boolean,
  ): Promise<{ updatedFields: number; confirmed: boolean }> {
    const row = await this.getOutletRegistryById(id);
    if (!row) return { updatedFields: 0, confirmed: false };

    const overrides = (row.manualOverrides ?? {}) as Record<string, unknown>;
    const provenance = { ...((row.enrichmentProvenance ?? {}) as Record<string, { source: string; at: string }>) };
    const nowIso = new Date().toISOString();

    const set: Record<string, unknown> = {};
    let updatedFields = 0;
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      if (field in overrides) continue; // manual override wins, never clobbered
      if ((row as Record<string, unknown>)[field] === value) continue; // no-op
      set[field] = value;
      provenance[field] = { source, at: nowIso };
      updatedFields++;
    }

    // Upgrade confirmation only (never downgrade). Strong matches confirm.
    const shouldConfirm = confirmed && row.confirmationStatus !== "confirmed";

    if (updatedFields === 0 && !shouldConfirm) {
      // Still stamp lastEnrichedAt so the oversight UI shows it was checked.
      await db.update(outletRegistry)
        .set({ lastEnrichedAt: new Date() })
        .where(eq(outletRegistry.id, id));
      return { updatedFields: 0, confirmed: false };
    }

    await db.update(outletRegistry)
      .set({
        ...set,
        enrichmentProvenance: provenance,
        ...(shouldConfirm ? { confirmationStatus: "confirmed" } : {}),
        lastEnrichedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(outletRegistry.id, id));

    return { updatedFields, confirmed: shouldConfirm };
  }

  // Human manual override: values win over machine data and persist across
  // enrichment refreshes. Records manual provenance per field.
  async setOutletManualOverride(
    id: string,
    overrides: Record<string, unknown>,
    user: string,
  ): Promise<OutletRegistry | undefined> {
    const row = await this.getOutletRegistryById(id);
    if (!row) return undefined;

    const mergedOverrides = { ...((row.manualOverrides ?? {}) as Record<string, unknown>) };
    const provenance = { ...((row.enrichmentProvenance ?? {}) as Record<string, { source: string; at: string }>) };
    const nowIso = new Date().toISOString();

    const set: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(overrides)) {
      mergedOverrides[field] = value;
      set[field] = value;
      provenance[field] = { source: `manual:${user}`, at: nowIso };
    }

    const [updated] = await db.update(outletRegistry)
      .set({ ...set, manualOverrides: mergedOverrides, enrichmentProvenance: provenance, updatedAt: new Date() })
      .where(eq(outletRegistry.id, id))
      .returning();
    return updated;
  }

  // Editor-feedback LEARNING LOOP (Task #659) — outlet-behavior-flip rule
  // approval/revoke. `behaviorOverride` ('attach' | 'corroborating' | null) is
  // NOT a real outlet_registry column (only deriveOutletBehavior in
  // shared/outletRegistry.ts reads it out of manualOverrides), so this writes
  // ONLY the jsonb overlay — unlike setOutletManualOverride, which also sets a
  // same-named top-level column and would fail on a non-existent column here.
  async setOutletBehaviorOverride(
    id: string,
    behaviorOverride: 'attach' | 'corroborating' | null,
    user: string,
  ): Promise<OutletRegistry | undefined> {
    const row = await this.getOutletRegistryById(id);
    if (!row) return undefined;
    const mergedOverrides = { ...((row.manualOverrides ?? {}) as Record<string, unknown>) };
    if (behaviorOverride === null) {
      delete mergedOverrides.behaviorOverride;
    } else {
      mergedOverrides.behaviorOverride = behaviorOverride;
    }
    const provenance = { ...((row.enrichmentProvenance ?? {}) as Record<string, { source: string; at: string }>) };
    provenance.behaviorOverride = { source: `manual:${user}`, at: new Date().toISOString() };
    const [updated] = await db.update(outletRegistry)
      .set({ manualOverrides: mergedOverrides, enrichmentProvenance: provenance, updatedAt: new Date() })
      .where(eq(outletRegistry.id, id))
      .returning();
    return updated;
  }

  // Remove a manual override for a field so enrichment can manage it again. The
  // field's current value is left as-is until the next enrichment pass.
  async clearOutletManualOverride(id: string, field: string): Promise<OutletRegistry | undefined> {
    const row = await this.getOutletRegistryById(id);
    if (!row) return undefined;

    const mergedOverrides = { ...((row.manualOverrides ?? {}) as Record<string, unknown>) };
    delete mergedOverrides[field];

    const [updated] = await db.update(outletRegistry)
      .set({ manualOverrides: mergedOverrides, updatedAt: new Date() })
      .where(eq(outletRegistry.id, id))
      .returning();
    return updated;
  }

  async setOutletLogoUrl(id: string, logoUrl: string, user: string): Promise<OutletRegistry | undefined> {
    const row = await this.getOutletRegistryById(id);
    if (!row) return undefined;
    const provenance = { ...((row.enrichmentProvenance ?? {}) as Record<string, { source: string; at: string }>) };
    provenance["logoUrl"] = { source: `manual:${user}`, at: new Date().toISOString() };
    const [updated] = await db.update(outletRegistry)
      .set({ logoUrl, enrichmentProvenance: provenance, updatedAt: new Date() })
      .where(eq(outletRegistry.id, id))
      .returning();
    return updated;
  }

  async insertLiveBroadcastFiring(firing: InsertCuratedLiveBroadcastFiring): Promise<CuratedLiveBroadcastFiring> {
    const [row] = await db.insert(curatedLiveBroadcastFirings).values(firing).returning();
    return row;
  }

  async stampLiveBroadcastFiringEnded(id: string, endedAt: Date): Promise<void> {
    await db.update(curatedLiveBroadcastFirings)
      .set({ endedAt })
      .where(eq(curatedLiveBroadcastFirings.id, id));
  }

  async getLiveBroadcastFiringById(id: string): Promise<CuratedLiveBroadcastFiring | undefined> {
    const [row] = await db.select().from(curatedLiveBroadcastFirings)
      .where(eq(curatedLiveBroadcastFirings.id, id)).limit(1);
    return row;
  }

  async upsertCommitteeHearing(hearing: InsertCommitteeHearing): Promise<CommitteeHearing> {
    const [row] = await db.insert(committeeHearings)
      .values(hearing)
      .onConflictDoUpdate({
        target: committeeHearings.eventUrl,
        set: {
          committee: hearing.committee,
          title: hearing.title,
          startsAt: hearing.startsAt ?? null,
          witnesses: hearing.witnesses ?? [],
          trackedLeaders: hearing.trackedLeaders ?? [],
          bannerLeader: hearing.bannerLeader ?? null,
          testimonyUrls: hearing.testimonyUrls ?? [],
          lastSeenAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async getCommitteeHearingsInWindow(fromMs: number, toMs: number): Promise<CommitteeHearing[]> {
    return await db.select().from(committeeHearings)
      .where(and(
        isNotNull(committeeHearings.startsAt),
        gte(committeeHearings.startsAt, new Date(fromMs)),
        lte(committeeHearings.startsAt, new Date(toMs)),
      ))
      .orderBy(committeeHearings.startsAt);
  }

  async getRecentLiveBroadcastFirings(hours: number, limit = 200): Promise<CuratedLiveBroadcastFiring[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await db.select()
      .from(curatedLiveBroadcastFirings)
      .where(gte(curatedLiveBroadcastFirings.createdAt, since))
      .orderBy(desc(curatedLiveBroadcastFirings.createdAt))
      .limit(limit);
  }

  async getLiveBroadcastModeration(eventKey: string): Promise<CuratedLiveBroadcastModeration | undefined> {
    const [row] = await db.select().from(curatedLiveBroadcastModerations)
      .where(eq(curatedLiveBroadcastModerations.eventKey, eventKey)).limit(1);
    return row;
  }

  async getLiveBroadcastModerations(eventKeys: string[]): Promise<Map<string, CuratedLiveBroadcastModeration>> {
    if (eventKeys.length === 0) return new Map();
    const rows = await db.select().from(curatedLiveBroadcastModerations)
      .where(inArray(curatedLiveBroadcastModerations.eventKey, Array.from(new Set(eventKeys))));
    return new Map(rows.map((row) => [row.eventKey, row]));
  }

  async setLiveBroadcastModeration(
    eventKey: string,
    suppressed: boolean,
    overrides: CuratedLiveBroadcastOverrides,
    updatedBy: string,
  ): Promise<CuratedLiveBroadcastModeration> {
    const [row] = await db.insert(curatedLiveBroadcastModerations)
      .values({ eventKey, suppressed, overrides, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: curatedLiveBroadcastModerations.eventKey,
        set: { suppressed, overrides, updatedBy, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  // ---------------------------------------------------------------------------
  // Meltwater run telemetry — one row per search (keyed by search label).
  // Persisted after each Meltwater bot run so the Coverage tab health card
  // shows real status per-search even after a redeploy. Never stores the API key.
  // ---------------------------------------------------------------------------

  async getMeltwaterTelemetries(): Promise<MeltwaterTelemetry[]> {
    try {
      return await db.select().from(meltwaterTelemetry).orderBy(meltwaterTelemetry.id);
    } catch {
      return [];
    }
  }

  // Curated-intake admission telemetry (Task #950).
  async getCuratedIntakeTelemetry(): Promise<CuratedIntakeTelemetry[]> {
    try {
      return await db.select().from(curatedIntakeTelemetry).orderBy(curatedIntakeTelemetry.sourceName);
    } catch {
      return [];
    }
  }

  async upsertCuratedIntakeTelemetry(rows: Array<{
    sourceName: string;
    lastLabel: string;
    lastRunAt: Date;
    ingested: number;
    dropInvalid: number;
    dropDupUrl: number;
    dropDupBatch: number;
    dropRelevanceRejected: number;
    dropRelevanceFinance: number;
    dropGateUnscored: number;
    dropFuzzyDup: number;
    dropBlocked: number;
    deferred: number;
  }>): Promise<void> {
    if (rows.length === 0) return;
    for (const r of rows) {
      // ON CONFLICT: update only the ADMISSION-level counters (ingested + drop_* +
      // deferred) and the last-run metadata. Do NOT touch fetched/kept/aged/
      // dup_in_pass/fetch_failures/last_fetch_error — those are the RSS feed-fetch
      // stats written separately by mergeCuratedIntakeFeedStats.
      // This prevents upsertCuratedIntakeTelemetry (called from admitCuratedCandidates,
      // which does NOT have feed-fetch counts) from racing with mergeCuratedIntakeFeedStats
      // (called from runCuratedIngestPass right after the RSS fetch) and zeroing those out.
      // Writing admission totals also CLEARS admission_pending — the pass-state
      // marker set by the feed-stats write — because the zeroed counters have now
      // been replaced by this pass's final results (Task #1114).
      const insertValues = {
        sourceName: r.sourceName,
        lastLabel: r.lastLabel,
        lastRunAt: r.lastRunAt,
        // fetched/kept/aged/dupInPass left at their defaults (0) on INSERT for
        // non-RSS sources; for RSS sources mergeCuratedIntakeFeedStats fills them.
        fetched: 0,
        kept: 0,
        aged: 0,
        dupInPass: 0,
        fetchFailures: 0,
        lastFetchError: null as string | null,
        ingested: r.ingested,
        dropInvalid: r.dropInvalid,
        dropDupUrl: r.dropDupUrl,
        dropDupBatch: r.dropDupBatch,
        dropRelevanceRejected: r.dropRelevanceRejected,
        dropRelevanceFinance: r.dropRelevanceFinance,
        dropGateUnscored: r.dropGateUnscored,
        dropFuzzyDup: r.dropFuzzyDup,
        dropBlocked: r.dropBlocked,
        invalidOnlyStreak: r.ingested === 0
          && r.dropInvalid > 0
          && r.dropDupUrl === 0
          && r.dropDupBatch === 0
          && r.dropRelevanceRejected === 0
          && r.dropRelevanceFinance === 0
          && r.dropGateUnscored === 0
          && r.dropFuzzyDup === 0
          && r.dropBlocked === 0
          && r.deferred === 0
          ? 1
          : 0,
        deferred: r.deferred,
        admissionPending: false,
        updatedAt: new Date(),
      };
      const admissionOnlySet = {
        lastRunAt: r.lastRunAt,
        ingested: r.ingested,
        dropInvalid: r.dropInvalid,
        dropDupUrl: r.dropDupUrl,
        dropDupBatch: r.dropDupBatch,
        dropRelevanceRejected: r.dropRelevanceRejected,
        dropRelevanceFinance: r.dropRelevanceFinance,
        dropGateUnscored: r.dropGateUnscored,
        dropFuzzyDup: r.dropFuzzyDup,
        dropBlocked: r.dropBlocked,
        // A lone malformed item is informational. Persist only a pattern of
        // completed invalid-only passes as operational evidence; feed-stat
        // writes deliberately leave this intact while a pass is in flight.
        invalidOnlyStreak: sql`
          CASE WHEN
            ${r.ingested} = 0
            AND ${r.dropInvalid} > 0
            AND ${r.dropDupUrl} = 0
            AND ${r.dropDupBatch} = 0
            AND ${r.dropRelevanceRejected} = 0
            AND ${r.dropRelevanceFinance} = 0
            AND ${r.dropGateUnscored} = 0
            AND ${r.dropFuzzyDup} = 0
            AND ${r.dropBlocked} = 0
            AND ${r.deferred} = 0
            AND ${curatedIntakeTelemetry.aged} = 0
            AND ${curatedIntakeTelemetry.dupInPass} = 0
            THEN ${curatedIntakeTelemetry.invalidOnlyStreak} + 1
          ELSE 0
          END`,
        deferred: r.deferred,
        admissionPending: false,
        updatedAt: new Date(),
      };
      await db
        .insert(curatedIntakeTelemetry)
        .values(insertValues)
        .onConflictDoUpdate({
          target: [curatedIntakeTelemetry.sourceName, curatedIntakeTelemetry.lastLabel],
          set: admissionOnlySet,
        });
    }
  }

  // Persisted curated gate verdicts (Task #1083). Load prunes expired rows
  // first (lazy TTL enforcement — same semantics as the in-memory cache's
  // per-read expiry check), then returns the freshest non-expired rows up to
  // `limit`. Fail-soft: any error returns [] so a hydrate failure only means
  // one cold pass, never a wedged ingest.
  async loadCuratedGateVerdicts(limit: number): Promise<CuratedGateVerdict[]> {
    try {
      await db.delete(curatedGateVerdicts).where(lt(curatedGateVerdicts.expiresAt, new Date()));
      return await db
        .select()
        .from(curatedGateVerdicts)
        .orderBy(desc(curatedGateVerdicts.expiresAt))
        .limit(limit);
    } catch {
      return [];
    }
  }

  // Batched write-through upsert. Chunked so a large pass (hundreds of fresh
  // verdicts) stays within parameter limits; last write wins per title.
  async saveCuratedGateVerdicts(rows: Array<{ title: string; verdict: unknown; expiresAt: Date }>): Promise<void> {
    if (rows.length === 0) return;
    const CHUNK = 100;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map(r => ({
        title: r.title,
        verdict: r.verdict as any,
        expiresAt: r.expiresAt,
      }));
      await db
        .insert(curatedGateVerdicts)
        .values(chunk)
        .onConflictDoUpdate({
          target: curatedGateVerdicts.title,
          set: {
            verdict: sql`excluded.verdict`,
            expiresAt: sql`excluded.expires_at`,
          },
        });
    }
    // Prune-on-write (review follow-up): load-time pruning only runs once per
    // process (boot hydrate), so a long-lived single-instance deploy would let
    // expired rows accumulate between redeploys. Each write-through pass also
    // clears expired rows — bounded work on the indexed expires_at column, and
    // callers invoke this fire-and-forget so it never eats gate/insert budget.
    await db.delete(curatedGateVerdicts).where(lt(curatedGateVerdicts.expiresAt, new Date()));
  }

  async mergeCuratedIntakeFeedStats(feedStats: Map<string, {
    fetched: number;
    kept: number;
    aged: number;
    dupInPass: number;
    fetchFailures?: number;
    lastFetchError?: string | null;
    admissionPending?: boolean;
  }>): Promise<void> {
    if (feedStats.size === 0) return;
    for (const [sourceName, stats] of feedStats) {
      const now = new Date();
      const fetchFailures = stats.fetchFailures ?? 0;
      const lastFetchError = stats.lastFetchError ?? null;
      // Pass-state marker (Task #1114): from this write until admission totals
      // land, the zeroed admission counters below are NOT final results. Only
      // pending when the source actually has candidates awaiting admission
      // (kept > 0); synthetic observability rows pass false explicitly.
      const admissionPending = stats.admissionPending ?? stats.kept > 0;
      await db
        .insert(curatedIntakeTelemetry)
        .values({
          sourceName,
          lastLabel: 'rss',
          lastRunAt: now,
          fetched: stats.fetched,
          kept: stats.kept,
          aged: stats.aged,
          dupInPass: stats.dupInPass,
          fetchFailures,
          lastFetchError,
          admissionPending,
          // Admission counters start at 0 on INSERT; they will be patched by
          // upsertCuratedIntakeTelemetry when admitCuratedCandidates completes.
          ingested: 0,
          dropInvalid: 0,
          dropDupUrl: 0,
          dropDupBatch: 0,
          dropRelevanceRejected: 0,
          dropRelevanceFinance: 0,
          dropGateUnscored: 0,
          dropFuzzyDup: 0,
          dropBlocked: 0,
          deferred: 0,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [curatedIntakeTelemetry.sourceName, curatedIntakeTelemetry.lastLabel],
          // Reset the ENTIRE row to a coherent snapshot for this pass: update
          // feed-fetch stats AND zero-out all admission counters.  This way the
          // stored row always reflects ONE pass — never a mix of current feed-
          // fetch numbers with stale admission counters from a prior pass.
          // admitCuratedCandidates will then increment the zeroed counters as
          // items are processed via upsertCuratedIntakeTelemetry. While that is
          // in flight, admission_pending = true marks the zeros as provisional
          // so a mid-pass reader can't mistake them for final results.
          set: {
            lastRunAt: now,
            fetched: stats.fetched,
            kept: stats.kept,
            aged: stats.aged,
            dupInPass: stats.dupInPass,
            fetchFailures,
            lastFetchError,
            admissionPending,
            // Reset admission counters so this pass starts from zero.
            ingested: 0,
            dropInvalid: 0,
            dropDupUrl: 0,
            dropDupBatch: 0,
            dropRelevanceRejected: 0,
            dropRelevanceFinance: 0,
            dropGateUnscored: 0,
            dropFuzzyDup: 0,
            dropBlocked: 0,
            deferred: 0,
            updatedAt: now,
          },
        });
    }
  }

  async setMeltwaterTelemetry(searchLabel: string, snapshot: {
    lastRunAt: Date;
    outcome: string;
    httpStatus: number | null;
    ingested: number;
    skipped: number;
    dayRemaining: number | null;
    dayLimit: number | null;
    dayResetAt: Date | null;
    minuteRemaining: number | null;
    overflow: boolean;
  }): Promise<void> {
    await db
      .insert(meltwaterTelemetry)
      .values({ id: searchLabel, ...snapshot, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: meltwaterTelemetry.id,
        set: { ...snapshot, updatedAt: new Date() },
      });
  }

  // Curated lane — editor-OVERRIDE LEARNING LOG (Task #540). Append-only events
  // + a single-row capture-pause flag. CURATED-ONLY: written by the curated
  // moderation endpoints, read ONLY by the curated-gated override-log endpoint.
  // Never read by any feed path (fail-closed isolation).
  // ---------------------------------------------------------------------------
  async recordCuratedOverrideEvent(event: InsertCuratedOverrideEvent): Promise<string> {
    // createInsertSchema represents jsonb as the broad JSON union, while Drizzle's
    // typed insert knows these two columns are object snapshots. Runtime values
    // are already constrained by captureCuratedOverrideEvent to plain objects.
    const [row] = await db.insert(curatedOverrideEvents).values(event as typeof curatedOverrideEvents.$inferInsert).returning({ id: curatedOverrideEvents.id });
    return row.id;
  }

  async captureCuratedOverrideEvidenceAtomic(
    event: InsertCuratedOverrideEvent,
    captureEpisode: (eventId: string, transactionStorage: unknown) => Promise<string | null>,
  ): Promise<{ eventId: string; episodeId: string }> {
    return await db.transaction(async (tx) => {
      const [raw] = await tx
        .insert(curatedOverrideEvents)
        .values(event as typeof curatedOverrideEvents.$inferInsert)
        .returning({ id: curatedOverrideEvents.id });

      // Minimal transaction-scoped storage adapter consumed by
      // captureEditorialEpisode. Keeping every query on `tx` makes the immutable
      // raw row, episode, lineage, and attachment one all-or-nothing evidence unit.
      const transactionStorage = {
        getCuratedEditorialEpisodeBySignature: async (signature: string) => {
          const [value] = await tx.select()
            .from(curatedEditorialEpisodes)
            .where(eq(curatedEditorialEpisodes.signature, signature));
          return value;
        },
        findRecentCuratedEditorialEpisode: async (input: {
          actionFamily: string;
          storyKey: string | null;
          canonicalUrl: string | null;
          direction: string;
          since: Date;
        }) => {
          const identity = input.storyKey
            ? eq(curatedEditorialEpisodes.storyKey, input.storyKey)
            : input.canonicalUrl
              ? eq(curatedEditorialEpisodes.canonicalUrl, input.canonicalUrl)
              : undefined;
          if (!identity) return undefined;
          const [value] = await tx.select()
            .from(curatedEditorialEpisodes)
            .where(and(
              eq(curatedEditorialEpisodes.actionFamily, input.actionFamily),
              identity,
              eq(curatedEditorialEpisodes.direction, input.direction),
              eq(curatedEditorialEpisodes.lifecycle, 'open'),
              gte(curatedEditorialEpisodes.updatedAt, input.since),
            ))
            .orderBy(desc(curatedEditorialEpisodes.updatedAt))
            .limit(1);
          return value;
        },
        upsertCuratedEditorialEpisode: async (
          row: InsertCuratedEditorialEpisode,
          opts?: { collapse?: boolean },
        ) => {
          const now = new Date();
          const [existing] = await tx.select()
            .from(curatedEditorialEpisodes)
            .where(eq(curatedEditorialEpisodes.signature, row.signature));
          if (!existing) {
            const [inserted] = await tx.insert(curatedEditorialEpisodes)
              .values({ ...(row as typeof curatedEditorialEpisodes.$inferInsert), updatedAt: now })
              .returning();
            return inserted;
          }
          if (opts?.collapse === false) return existing;
          const pick = <T>(next: T | null | undefined, prev: T): T =>
            (next === undefined || next === null) ? prev : next;
          const [updated] = await tx.update(curatedEditorialEpisodes)
            .set({
              actionFamily: row.actionFamily || existing.actionFamily,
              action: row.action || existing.action,
              reasonKeys: row.reasonKeys?.length ? row.reasonKeys : existing.reasonKeys,
              reasonNote: pick(row.reasonNote, existing.reasonNote),
              canonicalUrl: pick(row.canonicalUrl, existing.canonicalUrl),
              storyKey: pick(row.storyKey, existing.storyKey),
              outletId: pick(row.outletId, existing.outletId),
              beforeJson: pick(row.beforeJson as Record<string, unknown> | null | undefined, existing.beforeJson),
              requestedJson: pick(row.requestedJson as Record<string, unknown> | null | undefined, existing.requestedJson),
              actualJson: pick(row.actualJson as Record<string, unknown> | null | undefined, existing.actualJson),
              alternativesJson: pick(row.alternativesJson as Record<string, unknown>[] | null | undefined, existing.alternativesJson),
              provenanceJson: pick(row.provenanceJson as Record<string, unknown> | null | undefined, existing.provenanceJson),
              editorSurface: pick(row.editorSurface, existing.editorSurface),
              direction: pick(row.direction, existing.direction),
              verified: existing.verified || Boolean(row.verified),
              ambiguous: existing.ambiguous || Boolean(row.ambiguous),
              observationCount: (existing.observationCount ?? 0) + 1,
              updatedAt: now,
            })
            .where(eq(curatedEditorialEpisodes.id, existing.id))
            .returning();
          return updated;
        },
        findLatestCuratedEditorialEpisodeForIdentity: async (input: {
          storyKey: string | null;
          canonicalUrl: string | null;
          excludeEpisodeId: string;
          actionFamily?: string | null;
          differentDirection?: string | null;
          excludeActionFamily?: string | null;
        }) => {
          const identity = input.storyKey
            ? eq(curatedEditorialEpisodes.storyKey, input.storyKey)
            : input.canonicalUrl
              ? eq(curatedEditorialEpisodes.canonicalUrl, input.canonicalUrl)
              : undefined;
          if (!identity) return undefined;
          const conds = [identity, ne(curatedEditorialEpisodes.id, input.excludeEpisodeId)];
          if (input.actionFamily) conds.push(eq(curatedEditorialEpisodes.actionFamily, input.actionFamily));
          if (input.differentDirection) conds.push(ne(curatedEditorialEpisodes.direction, input.differentDirection));
          if (input.excludeActionFamily) conds.push(ne(curatedEditorialEpisodes.actionFamily, input.excludeActionFamily));
          const [value] = await tx.select()
            .from(curatedEditorialEpisodes)
            .where(and(...conds))
            .orderBy(desc(curatedEditorialEpisodes.updatedAt))
            .limit(1);
          return value;
        },
        updateCuratedEditorialOutcome: async (
          episodeId: string,
          updates: Partial<Pick<CuratedEditorialEpisode,
            'outcome' | 'outcomeNote' | 'lifecycle' | 'verified' | 'ambiguous' |
            'contradictsEpisodeId' | 'supersededById' | 'undoneByEventId'>>,
        ) => {
          const [updated] = await tx.update(curatedEditorialEpisodes)
            .set({ ...updates, updatedAt: new Date() })
            .where(eq(curatedEditorialEpisodes.id, episodeId))
            .returning();
          return updated;
        },
        attachCuratedEditorialEpisodeEvents: async (
          episodeId: string,
          events: Array<{ eventId: string; eventAction?: string | null; eventEditor?: string | null; eventAt?: Date | null }>,
        ) => {
          for (const value of events) {
            await tx.insert(curatedEditorialEpisodeEvents)
              .values({
                episodeId,
                eventId: value.eventId,
                eventAction: value.eventAction ?? null,
                eventEditor: value.eventEditor ?? null,
                eventAt: value.eventAt ?? null,
              })
              .onConflictDoNothing({
                target: [curatedEditorialEpisodeEvents.episodeId, curatedEditorialEpisodeEvents.eventId],
              });
          }
          const links = await tx.select()
            .from(curatedEditorialEpisodeEvents)
            .where(eq(curatedEditorialEpisodeEvents.episodeId, episodeId));
          const editors = new Set(links.map((link) => link.eventEditor).filter(Boolean));
          const eventDates = links.map((link) => link.eventAt).filter((value): value is Date => !!value);
          const [updated] = await tx.update(curatedEditorialEpisodes)
            .set({
              eventCount: links.length,
              editorCount: editors.size,
              firstEventAt: eventDates.length ? new Date(Math.min(...eventDates.map((value) => value.getTime()))) : null,
              lastEventAt: eventDates.length ? new Date(Math.max(...eventDates.map((value) => value.getTime()))) : null,
              updatedAt: new Date(),
            })
            .where(eq(curatedEditorialEpisodes.id, episodeId))
            .returning();
          return updated;
        },
      };

      const episodeId = await captureEpisode(raw.id, transactionStorage);
      if (!episodeId) throw new Error('durable editorial episode was not persisted');
      return { eventId: raw.id, episodeId };
    });
  }

  async attachCuratedOverrideEventReasons(id: string, reasonKeys: string[], reasonNote: string | null): Promise<void> {
    await db.update(curatedOverrideEvents)
      .set({ reasonKeys: reasonKeys.length > 0 ? reasonKeys : null, reasonNote: reasonNote || null })
      .where(eq(curatedOverrideEvents.id, id));
  }

  async getCuratedOverrideEvents(limit: number): Promise<CuratedOverrideEvent[]> {
    return await db.select()
      .from(curatedOverrideEvents)
      .orderBy(desc(curatedOverrideEvents.createdAt))
      .limit(limit);
  }

  async getCuratedOverrideEventsSince(since: Date, max: number): Promise<CuratedOverrideEvent[]> {
    return await db.select()
      .from(curatedOverrideEvents)
      .where(gte(curatedOverrideEvents.createdAt, since))
      .orderBy(desc(curatedOverrideEvents.createdAt))
      .limit(max);
  }

  async getCuratedOverrideEventsBefore(before: Date, max: number): Promise<CuratedOverrideEvent[]> {
    return await db.select()
      .from(curatedOverrideEvents)
      .where(lt(curatedOverrideEvents.createdAt, before))
      .orderBy(desc(curatedOverrideEvents.createdAt))
      .limit(max);
  }

  async getCuratedClusterMemberByItem(itemType: string, itemId: string): Promise<CuratedClusterMember | undefined> {
    const [row] = await db.select()
      .from(curatedClusterMembers)
      .where(and(
        eq(curatedClusterMembers.itemType, itemType),
        eq(curatedClusterMembers.itemId, itemId),
      ))
      .orderBy(desc(curatedClusterMembers.createdAt))
      .limit(1);
    return row;
  }

  async getCuratedFeedbackSettings(): Promise<CuratedFeedbackSettings> {
    const [row] = await db.select()
      .from(curatedFeedbackSettings)
      .where(eq(curatedFeedbackSettings.id, 'global'))
      .limit(1);
    if (row) return row;
    // Default (capture active) without forcing a write on every read.
    return { id: 'global', capturePaused: false, acknowledgedAt: null, updatedBy: null, updatedAt: new Date() };
  }

  async setCuratedCapturePaused(paused: boolean, updatedBy: string): Promise<CuratedFeedbackSettings> {
    const [row] = await db.insert(curatedFeedbackSettings)
      .values({ id: 'global', capturePaused: paused, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: curatedFeedbackSettings.id,
        // Only touch the pause fields — leave acknowledgedAt (the reset
        // checkpoint) untouched so pausing/resuming never clears the view.
        set: { capturePaused: paused, updatedBy, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  // Non-destructive reset of the Adjustments learning log: stamp a checkpoint so
  // the report/recent/brief only count editor actions logged AFTER it. Raw rows
  // are preserved (audit). Curated-only.
  async resetCuratedOverrideLog(updatedBy: string): Promise<CuratedFeedbackSettings> {
    const now = new Date();
    const [row] = await db.insert(curatedFeedbackSettings)
      .values({ id: 'global', acknowledgedAt: now, updatedBy, updatedAt: now })
      .onConflictDoUpdate({
        target: curatedFeedbackSettings.id,
        set: { acknowledgedAt: now, updatedBy, updatedAt: now },
      })
      .returning();
    return row;
  }

  // Live spread of RAW analyzer-assigned MAIN-FEED scores (Task #1093 follow-
  // through). Replaces the manual post-publish "band histogram" prod audit:
  // the Scoring oversight tab shows, from the last `windowDays` of
  // team_submissions (the bot/RSS funnel record — one row per screened item,
  // so no double count with the auto-promoted manual_submissions copy), how
  // AI scores distribute by tens-band plus the most-repeated exact values
  // (favorite-number clumping was the #1093 miscalibration signature).
  // NEWS FUNNEL ONLY (sourceType='news'): AI-scored social rows are a
  // different calibration surface and would pollute this read (65 such rows
  // in a sample window vs ~3.7k news). scoreSource='ai' (and legacy null →
  // default 'ai') only — human overrides and the unscored fallback are
  // counted separately; UNKNOWN scoreSource values are quarantined into
  // otherScoreSources, never folded into the AI spread. Scores are stored RAW
  // (decay is display-only elsewhere), so this reads exactly what the
  // analyzer assigned. Read-only aggregate.
  async getMainScoreSpread(windowDays: number = 7): Promise<{
    windowDays: number;
    totalScored: number;
    bands: Array<{ min: number; max: number; count: number }>;
    topValues: Array<{ score: number; count: number; sharePct: number }>;
    humanOverrides: number;
    unscoredFallback: number;
    otherScoreSources: number;
    generatedAt: string;
  }> {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        scoreSource: teamSubmissions.scoreSource,
        score: teamSubmissions.priorityScore,
        n: sql<number>`count(*)::int`,
      })
      .from(teamSubmissions)
      .where(and(gte(teamSubmissions.createdAt, since), eq(teamSubmissions.sourceType, 'news')))
      .groupBy(teamSubmissions.scoreSource, teamSubmissions.priorityScore);

    const bands = Array.from({ length: 10 }, (_, i) => ({
      min: i * 10,
      max: i === 9 ? 100 : i * 10 + 9,
      count: 0,
    }));
    const exact = new Map<number, number>();
    let totalScored = 0;
    let humanOverrides = 0;
    let unscoredFallback = 0;
    let otherScoreSources = 0;
    for (const r of rows) {
      if (r.score === null || r.score === undefined) continue;
      const src = r.scoreSource ?? 'ai'; // legacy rows predate the column default
      if (src === 'human') { humanOverrides += r.n; continue; }
      if (src === 'unscored_fallback') { unscoredFallback += r.n; continue; }
      if (src !== 'ai') { otherScoreSources += r.n; continue; } // unknown/dirty values never pollute the AI spread
      totalScored += r.n;
      const b = Math.min(9, Math.max(0, Math.floor(r.score / 10)));
      bands[b].count += r.n;
      exact.set(r.score, (exact.get(r.score) || 0) + r.n);
    }
    const topValues = [...exact.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 6)
      .map(([score, count]) => ({
        score,
        count,
        sharePct: totalScored > 0 ? Math.round((count / totalScored) * 100) : 0,
      }));
    return {
      windowDays,
      totalScored,
      bands,
      topValues,
      humanOverrides,
      unscoredFallback,
      otherScoreSources,
      generatedAt: new Date().toISOString(),
    };
  }

  // Curated lane — editor-feedback LEARNING LOOP (Task #659). Compiled
  // candidate rules (approval queue). CURATED-ONLY: compiler writes
  // 'suggested' rows; a human decides via decideCuratedLearnedRule; enforcement
  // (classification/must-link/irrelevance-suppression) only ever reads
  // status='approved' rows, live, through server/curatedLearnedRulesCache.ts.
  async getCuratedLearnedRules(statuses?: string[]): Promise<CuratedLearnedRule[]> {
    const q = db.select().from(curatedLearnedRules);
    if (statuses && statuses.length > 0) {
      return await q.where(inArray(curatedLearnedRules.status, statuses))
        .orderBy(desc(curatedLearnedRules.updatedAt));
    }
    return await q.orderBy(desc(curatedLearnedRules.updatedAt));
  }

  async getCuratedLearnedRuleById(id: string): Promise<CuratedLearnedRule | undefined> {
    const [row] = await db.select().from(curatedLearnedRules).where(eq(curatedLearnedRules.id, id));
    return row;
  }

  async getCuratedLearnedRuleBySignature(signature: string): Promise<CuratedLearnedRule | undefined> {
    const [row] = await db.select().from(curatedLearnedRules).where(eq(curatedLearnedRules.signature, signature));
    return row;
  }

  // Insert a fresh 'suggested' row, or — if one already exists for this exact
  // signature and is still 'suggested' (or a 'snoozed' row whose cooldown has
  // elapsed) — refresh its evidence in place. Never touches an
  // approved/rejected/revoked row, or a still-cooling-down snoozed row (the
  // caller is responsible for pre-filtering those; this is a defensive floor).
  async upsertSuggestedCuratedLearnedRule(row: InsertCuratedLearnedRule): Promise<CuratedLearnedRule> {
    const existing = await this.getCuratedLearnedRuleBySignature(row.signature);
    if (!existing) {
      const [inserted] = await db.insert(curatedLearnedRules).values(row as typeof curatedLearnedRules.$inferInsert).returning();
      return inserted;
    }
    if (existing.status !== 'suggested' && existing.status !== 'snoozed') {
      return existing;
    }
    // A snoozed rule whose cooldown has NOT yet elapsed must stay hidden — do
    // not resurface it as 'suggested' until snoozedUntil passes. Only refresh a
    // snoozed row in place once its cooldown has expired.
    if (isSnoozeCooldownActive(existing.status, existing.snoozedUntil)) {
      return existing;
    }
    const [updated] = await db.update(curatedLearnedRules)
      .set({
        label: row.label,
        payload: row.payload,
        evidenceCount: row.evidenceCount,
        evidenceSamples: row.evidenceSamples,
        confidence: row.confidence,
        status: 'suggested',
        snoozedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(curatedLearnedRules.id, existing.id))
      .returning();
    return updated;
  }

  async decideCuratedLearnedRule(
    id: string,
    updates: Partial<Pick<CuratedLearnedRule, 'status' | 'snoozedUntil' | 'decidedBy' | 'decidedAt' | 'appliedState'>>,
  ): Promise<CuratedLearnedRule | undefined> {
    const [updated] = await db.update(curatedLearnedRules)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(curatedLearnedRules.id, id))
      .returning();
    return updated;
  }

  // ===========================================================================
  // Curated lane — EDITORIAL EPISODE + OBSERVATION/OUTCOME model (Task #1180).
  // Additive, curated-only observability built ON TOP OF the immutable
  // curated_override_events log. These methods NEVER mutate raw override events
  // (they attach BY REFERENCE), NEVER touch human overrides / outlet roles, and
  // NEVER emit training labels. Fail-closed isolation from every feed path.
  // ---------------------------------------------------------------------------

  // Upsert/collapse an episode keyed by its stable signature. On collapse, an
  // existing episode is enriched in place: identity/family/action/direction and
  // JSON snapshots are filled where newly provided (COALESCE-style — a null in
  // the incoming row never wipes an existing value), and reason keys/note refresh
  // if provided. A fresh signature inserts a new episode. Atomic via ON CONFLICT.
  async upsertCuratedEditorialEpisode(
    row: InsertCuratedEditorialEpisode,
    opts?: { collapse?: boolean },
  ): Promise<CuratedEditorialEpisode> {
    const collapse = opts?.collapse !== false; // default: collapse onto signature
    const now = new Date();
    const existing = await this.getCuratedEditorialEpisodeBySignature(row.signature);
    if (!existing) {
      const [inserted] = await db.insert(curatedEditorialEpisodes)
        .values({ ...(row as typeof curatedEditorialEpisodes.$inferInsert), updatedAt: now })
        .returning();
      return inserted;
    }
    if (!collapse) return existing;
    // COALESCE-merge: only overwrite a column when the incoming value is present.
    const pick = <T>(next: T | null | undefined, prev: T): T =>
      (next === undefined || next === null) ? prev : next;
    const [updated] = await db.update(curatedEditorialEpisodes)
      .set({
        actionFamily: row.actionFamily ? row.actionFamily : existing.actionFamily,
        action: row.action ? row.action : existing.action,
        reasonKeys: (row.reasonKeys && row.reasonKeys.length > 0) ? row.reasonKeys : existing.reasonKeys,
        reasonNote: pick(row.reasonNote, existing.reasonNote),
        canonicalUrl: pick(row.canonicalUrl, existing.canonicalUrl),
        storyKey: pick(row.storyKey, existing.storyKey),
        outletId: pick(row.outletId, existing.outletId),
        beforeJson: pick(row.beforeJson as Record<string, unknown> | null | undefined, existing.beforeJson),
        requestedJson: pick(row.requestedJson as Record<string, unknown> | null | undefined, existing.requestedJson),
        actualJson: pick(row.actualJson as Record<string, unknown> | null | undefined, existing.actualJson),
        alternativesJson: pick(row.alternativesJson as Record<string, unknown>[] | null | undefined, existing.alternativesJson),
        provenanceJson: pick(row.provenanceJson as Record<string, unknown> | null | undefined, existing.provenanceJson),
        editorSurface: pick(row.editorSurface, existing.editorSurface),
        direction: pick(row.direction, existing.direction),
        // Sticky flags: once verified/ambiguous set true, a collapse never clears
        // them silently (explicit updates go through updateCuratedEditorialOutcome).
        verified: existing.verified || Boolean(row.verified),
        ambiguous: existing.ambiguous || Boolean(row.ambiguous),
        observationCount: (existing.observationCount ?? 0) + 1,
        updatedAt: now,
      })
      .where(eq(curatedEditorialEpisodes.id, existing.id))
      .returning();
    return updated;
  }

  async getCuratedEditorialEpisodeById(id: string): Promise<CuratedEditorialEpisode | undefined> {
    const [row] = await db.select().from(curatedEditorialEpisodes).where(eq(curatedEditorialEpisodes.id, id));
    return row;
  }

  async getCuratedEditorialEpisodeBySignature(signature: string): Promise<CuratedEditorialEpisode | undefined> {
    const [row] = await db.select().from(curatedEditorialEpisodes).where(eq(curatedEditorialEpisodes.signature, signature));
    return row;
  }

  async findRecentCuratedEditorialEpisode(input: {
    actionFamily: string;
    storyKey: string | null;
    canonicalUrl: string | null;
    direction: string;
    since: Date;
  }): Promise<CuratedEditorialEpisode | undefined> {
    const identity = input.storyKey
      ? eq(curatedEditorialEpisodes.storyKey, input.storyKey)
      : input.canonicalUrl
        ? eq(curatedEditorialEpisodes.canonicalUrl, input.canonicalUrl)
        : undefined;
    if (!identity) return undefined;
    const [row] = await db.select()
      .from(curatedEditorialEpisodes)
      .where(and(
        eq(curatedEditorialEpisodes.actionFamily, input.actionFamily),
        identity,
        eq(curatedEditorialEpisodes.direction, input.direction),
        eq(curatedEditorialEpisodes.lifecycle, 'open'),
        gte(curatedEditorialEpisodes.updatedAt, input.since),
      ))
      .orderBy(desc(curatedEditorialEpisodes.updatedAt))
      .limit(1);
    return row;
  }

  async findLatestCuratedEditorialEpisodeForIdentity(input: {
    storyKey: string | null;
    canonicalUrl: string | null;
    excludeEpisodeId: string;
    actionFamily?: string | null;
    differentDirection?: string | null;
    excludeActionFamily?: string | null;
  }): Promise<CuratedEditorialEpisode | undefined> {
    const identity = input.storyKey
      ? eq(curatedEditorialEpisodes.storyKey, input.storyKey)
      : input.canonicalUrl
        ? eq(curatedEditorialEpisodes.canonicalUrl, input.canonicalUrl)
        : undefined;
    if (!identity) return undefined;
    const conds = [
      identity,
      ne(curatedEditorialEpisodes.id, input.excludeEpisodeId),
    ];
    if (input.actionFamily) conds.push(eq(curatedEditorialEpisodes.actionFamily, input.actionFamily));
    if (input.differentDirection) conds.push(ne(curatedEditorialEpisodes.direction, input.differentDirection));
    if (input.excludeActionFamily) conds.push(ne(curatedEditorialEpisodes.actionFamily, input.excludeActionFamily));
    const [row] = await db.select()
      .from(curatedEditorialEpisodes)
      .where(and(...conds))
      .orderBy(desc(curatedEditorialEpisodes.updatedAt))
      .limit(1);
    return row;
  }

  async getCuratedEditorialEpisodeEvents(episodeId: string): Promise<CuratedEditorialEpisodeEvent[]> {
    return await db.select()
      .from(curatedEditorialEpisodeEvents)
      .where(eq(curatedEditorialEpisodeEvents.episodeId, episodeId))
      .orderBy(desc(curatedEditorialEpisodeEvents.eventAt));
  }

  async findCuratedEditorialEpisodeIdByEventId(eventId: string): Promise<string | null> {
    const [row] = await db.select({ episodeId: curatedEditorialEpisodeEvents.episodeId })
      .from(curatedEditorialEpisodeEvents)
      .where(eq(curatedEditorialEpisodeEvents.eventId, eventId))
      .orderBy(desc(curatedEditorialEpisodeEvents.attachedAt))
      .limit(1);
    return row?.episodeId ?? null;
  }

  // Attach immutable override events by reference (idempotent), then recompute
  // the persistence counters from the full link set so they always agree with
  // the attached rows even after a re-run. Raw events are never touched.
  async attachCuratedEditorialEpisodeEvents(
    episodeId: string,
    events: Array<{ eventId: string; eventAction?: string | null; eventEditor?: string | null; eventAt?: Date | null }>,
  ): Promise<CuratedEditorialEpisode | undefined> {
    const episode = await this.getCuratedEditorialEpisodeById(episodeId);
    if (!episode) return undefined;
    for (const e of events) {
      await db.insert(curatedEditorialEpisodeEvents)
        .values({
          episodeId,
          eventId: e.eventId,
          eventAction: e.eventAction ?? null,
          eventEditor: e.eventEditor ?? null,
          eventAt: e.eventAt ?? null,
        })
        .onConflictDoNothing({ target: [curatedEditorialEpisodeEvents.episodeId, curatedEditorialEpisodeEvents.eventId] });
    }
    // Recompute counters from the authoritative link set.
    const links = await this.getCuratedEditorialEpisodeEvents(episodeId);
    const editors = new Set<string>();
    let firstAt: Date | null = null;
    let lastAt: Date | null = null;
    for (const l of links) {
      if (l.eventEditor) editors.add(l.eventEditor);
      if (l.eventAt) {
        if (!firstAt || l.eventAt < firstAt) firstAt = l.eventAt;
        if (!lastAt || l.eventAt > lastAt) lastAt = l.eventAt;
      }
    }
    const [updated] = await db.update(curatedEditorialEpisodes)
      .set({
        eventCount: links.length,
        editorCount: editors.size,
        firstEventAt: firstAt,
        lastEventAt: lastAt,
        updatedAt: new Date(),
      })
      .where(eq(curatedEditorialEpisodes.id, episodeId))
      .returning();
    return updated;
  }

  async listCuratedEditorialEpisodes(filter?: {
    lifecycle?: string[];
    actionFamily?: string;
    canonicalUrl?: string;
    verified?: boolean;
    ambiguous?: boolean;
    limit?: number;
  }): Promise<CuratedEditorialEpisode[]> {
    const conds = [];
    if (filter?.lifecycle && filter.lifecycle.length > 0) conds.push(inArray(curatedEditorialEpisodes.lifecycle, filter.lifecycle));
    if (filter?.actionFamily) conds.push(eq(curatedEditorialEpisodes.actionFamily, filter.actionFamily));
    if (filter?.canonicalUrl) conds.push(eq(curatedEditorialEpisodes.canonicalUrl, filter.canonicalUrl));
    if (filter?.verified !== undefined) conds.push(eq(curatedEditorialEpisodes.verified, filter.verified));
    if (filter?.ambiguous !== undefined) conds.push(eq(curatedEditorialEpisodes.ambiguous, filter.ambiguous));
    const q = db.select().from(curatedEditorialEpisodes);
    const rows = conds.length > 0
      ? await q.where(and(...conds)).orderBy(desc(curatedEditorialEpisodes.updatedAt)).limit(filter?.limit ?? 500)
      : await q.orderBy(desc(curatedEditorialEpisodes.updatedAt)).limit(filter?.limit ?? 500);
    return rows;
  }

  async appendCuratedEditorialObservation(
    episodeId: string,
    obs: { observationKey?: string | null; kind?: string; note?: string | null; detailJson?: Record<string, unknown> | null; observedBy?: string },
  ): Promise<CuratedEditorialObservation> {
    const now = new Date();
    const values = {
      episodeId,
      observationKey: obs.observationKey ?? null,
      kind: obs.kind ?? 'observed',
      note: obs.note ?? null,
      detailJson: obs.detailJson ?? null,
      observedBy: obs.observedBy ?? '',
      updatedAt: now,
    } as typeof curatedEditorialObservations.$inferInsert;
    let out: CuratedEditorialObservation;
    if (obs.observationKey) {
      const [row] = await db.insert(curatedEditorialObservations)
        .values(values)
        .onConflictDoUpdate({
          target: [curatedEditorialObservations.episodeId, curatedEditorialObservations.observationKey],
          set: { kind: values.kind, note: values.note, detailJson: values.detailJson, observedBy: values.observedBy, updatedAt: now },
        })
        .returning();
      out = row;
    } else {
      const [row] = await db.insert(curatedEditorialObservations).values(values).returning();
      out = row;
    }
    // Bump the persistence counter on the parent episode (best-effort).
    const count = await db.select({ n: sql<number>`count(*)::int` })
      .from(curatedEditorialObservations)
      .where(eq(curatedEditorialObservations.episodeId, episodeId));
    await db.update(curatedEditorialEpisodes)
      .set({ observationCount: count[0]?.n ?? 0, updatedAt: now })
      .where(eq(curatedEditorialEpisodes.id, episodeId));
    return out;
  }

  async getCuratedEditorialObservations(episodeId: string): Promise<CuratedEditorialObservation[]> {
    return await db.select()
      .from(curatedEditorialObservations)
      .where(eq(curatedEditorialObservations.episodeId, episodeId))
      .orderBy(desc(curatedEditorialObservations.createdAt));
  }

  async updateCuratedEditorialOutcome(
    episodeId: string,
    updates: Partial<Pick<CuratedEditorialEpisode,
      'outcome' | 'outcomeNote' | 'lifecycle' | 'verified' | 'ambiguous' |
      'contradictsEpisodeId' | 'supersededById' | 'undoneByEventId'>>,
  ): Promise<CuratedEditorialEpisode | undefined> {
    const [updated] = await db.update(curatedEditorialEpisodes)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(curatedEditorialEpisodes.id, episodeId))
      .returning();
    return updated;
  }

  // Frozen legacy learned-rule inventory (Task #1180). Read-only observability:
  // this table is inert (never enforced, never a training label). Optionally
  // filter by disposition ('frozen-review' | 'historical-only' | ...).
  async listCuratedLegacyRuleInventory(disposition?: string): Promise<CuratedLegacyRuleInventory[]> {
    const q = db.select().from(curatedLegacyRuleInventory);
    if (disposition) {
      return await q.where(eq(curatedLegacyRuleInventory.disposition, disposition))
        .orderBy(desc(curatedLegacyRuleInventory.frozenAt));
    }
    return await q.orderBy(desc(curatedLegacyRuleInventory.frozenAt));
  }

  async setCuratedLegacyRuleDisposition(
    id: string,
    input: { disposition: 'acknowledge' | 'archive' | 'discard'; dispositionedBy: string; dispositionedAt: Date },
  ): Promise<CuratedLegacyRuleInventory | undefined> {
    const [updated] = await db.update(curatedLegacyRuleInventory)
      .set({
        disposition: input.disposition,
        dispositionedBy: input.dispositionedBy,
        dispositionedAt: input.dispositionedAt,
      })
      .where(eq(curatedLegacyRuleInventory.id, id))
      .returning();
    return updated;
  }

  // ===========================================================================
  // Curated lane — AUTHORITATIVE OUTCOME OBSERVATION after a cluster pass
  // (Task #1180 follow-through). Runs immediately after
  // replaceCuratedClusterMembers in FULL authoritative mode. The whole point is
  // to answer, from the AUTHORITATIVE final state, "did this editorial intent
  // actually take effect?" — NOT "did we write an overlay row?" (an overlay can
  // be written and then no-op'd by an aging-out, a false-merge dissolution, an
  // anchor-split veto, or a contrary later edit).
  //
  // BOUNDED BY DESIGN — cost scales with ACTIVE episodes, not retained history:
  //   * by default only membership-relevant families emitted by the evidence
  //     contract ('grouping-positive', 'grouping-negative', and 'lineage'),
  //     lifecycle 'open' (unsettled), and updatedAt within the recent window are
  //     scanned, ordered newest-first, hard-capped at `cap`.
  //   * the ranking observer explicitly passes ['priority']; cluster passes do
  //     not evaluate ranking episodes as membership evidence.
  //   * settled / superseded / undone / contradicted episodes and anything older
  //     than the window are NEVER read — a huge historical backlog can't slow a
  //     pass. The bounded read is the load-bearing scalability guarantee.
  //
  // PER-EPISODE, defensibly observable from the final membership + priority:
  //   undone      — episode carries an undo linkage (editor already reversed it).
  //   superseded  — episode carries a supersede linkage.
  //   dormant     — NONE of the requested identities appear in this pass at all
  //                 (no observable subject → we assert nothing about success).
  //   conflicted  — requested identities present but arranged CONTRARY to intent
  //                 (requested-together members split across clusters, or a
  //                 requested-absent member is present, or a requested priority
  //                 floor is contradicted by a lower authoritative score).
  //   deferred    — partially/ambiguously observable (some requested identities
  //                 present, not enough to confirm applied; ranking not yet
  //                 reflecting the request).
  //   applied     — the FINAL kept membership + priority state defensibly
  //                 satisfies the request. Never asserted from an overlay write.
  //   failed      — a per-episode error while evaluating (isolated + counted).
  //
  // Appends ONE observation per episode keyed by the cluster revision/pass
  // (idempotent re-run of the same pass upserts in place, so a retried pass never
  // double-counts). Increments a persistence PASS counter + records latency and
  // the final actual JSON on the episode (in actualJson.observation, leaving the
  // human-authored fields untouched). Fail-soft: any top-level error returns a
  // zeroed summary and never throws into the caller. CURATED-ONLY: never writes a
  // human pin (curated_priority_overrides) or an outlet role (outlet_registry).
  async observeCuratedEditorialOutcomesAfterCluster(
    input: {
      clusterRevision: string;
      keptMembers: Array<Pick<CuratedClusterMember, 'clusterId' | 'itemType' | 'itemId' | 'url' | 'priorityScore' | 'isRepresentative'>>;
      mode?: 'full' | 'reshape' | 'immediate';
      latencyMs?: number;
      cap?: number;
      recentWindowMs?: number;
      observedBy?: string;
      actionFamilies?: string[];
    },
  ): Promise<CuratedEditorialOutcomeObservationSummary> {
    const startedAt = Date.now();
    const summary: CuratedEditorialOutcomeObservationSummary = {
      scanned: 0, applied: 0, deferred: 0, conflicted: 0,
      dormant: 0, superseded: 0, undone: 0, failed: 0, latencyMs: 0,
    };
    try {
      const cap = Math.max(1, Math.min(input.cap ?? 200, 1000));
      const recentWindowMs = Math.max(60_000, input.recentWindowMs ?? 3 * 60 * 60 * 1000);
      const observedBy = input.observedBy ?? 'cluster-pass';
      const revision = input.clusterRevision;
      const windowStart = new Date(startedAt - recentWindowMs);

      // BOUNDED SCAN — active (unsettled) + recent membership/lineage episodes
      // only by default, newest first, hard-capped. These values MUST stay in
      // lockstep with shared/editorialEvidence.ts ACTION_FAMILY. Priority is
      // observed separately by the ranking build via an explicit override.
      const actionFamilies = input.actionFamilies?.length
        ? input.actionFamilies
        : ['grouping-positive', 'grouping-negative', 'lineage'];
      const episodes = await db.select()
        .from(curatedEditorialEpisodes)
        .where(and(
          inArray(curatedEditorialEpisodes.actionFamily, actionFamilies),
          eq(curatedEditorialEpisodes.lifecycle, 'open'),
          gte(curatedEditorialEpisodes.updatedAt, windowStart),
        ))
        .orderBy(desc(curatedEditorialEpisodes.updatedAt))
        .limit(cap);
      summary.scanned = episodes.length;
      if (episodes.length === 0) {
        summary.latencyMs = Date.now() - startedAt;
        return summary;
      }

      // Build final-state indexes ONCE (over the kept membership this pass).
      // normalizeIdentityUrl gives us the same identity the requestedJson uses.
      const clusterByUrl = new Map<string, string>();     // identity url -> clusterId
      const presentUrls = new Set<string>();
      const scoreByUrl = new Map<string, number>();       // identity url -> priorityScore
      for (const m of input.keptMembers) {
        if (!m.url) continue;
        const key = normalizeIdentityUrl(m.url);
        presentUrls.add(key);
        clusterByUrl.set(key, m.clusterId);
        // Keep the MAX authoritative score seen for the identity (rep wins ties).
        const prev = scoreByUrl.get(key);
        if (prev === undefined || m.priorityScore > prev) scoreByUrl.set(key, m.priorityScore);
      }
      // Priority OVERLAYS are READ-ONLY context here — they tell us what an editor
      // ASKED for, never what actually shipped. We use the authoritative kept
      // scoreByUrl as the ground truth so we never infer success from an overlay.
      const now = new Date();

      for (const ep of episodes) {
        try {
          // Terminal lineage first — an undo/supersede is authoritative regardless
          // of this pass's membership.
          let outcome: 'applied' | 'deferred' | 'conflicted' | 'dormant' | 'superseded' | 'undone' | 'failed';
          if (ep.undoneByEventId) {
            outcome = 'undone';
          } else if (ep.supersededById) {
            outcome = 'superseded';
          } else {
            outcome = this._assessCuratedClusterOutcome(ep, { presentUrls, clusterByUrl, scoreByUrl });
          }

          // Persistence PASS counter + latency + final actual snapshot, folded into
          // actualJson.observation so the human-authored requested/before fields
          // stay untouched.
          const prevActual = (ep.actualJson && typeof ep.actualJson === 'object' ? ep.actualJson : {}) as Record<string, unknown>;
          const prevObs = (prevActual.observation && typeof prevActual.observation === 'object' ? prevActual.observation : {}) as Record<string, unknown>;
          const priorPassCount = typeof prevObs.passCount === 'number' ? prevObs.passCount : 0;
          const passCount = priorPassCount + 1;
          const observation = {
            outcome,
            revision,
            passCount,
            latencyMs: input.latencyMs ?? (Date.now() - startedAt),
            mode: input.mode ?? 'full',
            observedAt: now.toISOString(),
            finalMembership: requestedIdentitySnapshot(ep, clusterByUrl, scoreByUrl),
          };

          // Persist the idempotent observation and authoritative episode state
          // together. This keeps one episode atomic and removes the former
          // append-helper COUNT + parent-update round trips from every pass.
          const lifecycle = outcome === 'undone' ? 'undone'
            : outcome === 'superseded' ? 'superseded'
            : ep.lifecycle; // stays 'open' — never auto-settles from a pass
          await db.transaction(async (tx) => {
            await tx.insert(curatedEditorialObservations)
              .values({
                episodeId: ep.id,
                observationKey: `cluster-pass:${revision}`,
                kind: 'observed',
                note: `cluster-pass outcome=${outcome} pass#${passCount}`,
                detailJson: observation,
                observedBy,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: [
                  curatedEditorialObservations.episodeId,
                  curatedEditorialObservations.observationKey,
                ],
                set: {
                  kind: 'observed',
                  note: `cluster-pass outcome=${outcome} pass#${passCount}`,
                  detailJson: observation,
                  observedBy,
                  updatedAt: now,
                },
              });
            await tx.update(curatedEditorialEpisodes)
              .set({
                outcome,
                actualJson: { ...prevActual, observation },
                lifecycle,
                verified: outcome === 'applied',
                ambiguous: outcome === 'conflicted' || outcome === 'deferred',
                observationCount: sql<number>`(
                  SELECT count(*)::int
                  FROM ${curatedEditorialObservations}
                  WHERE ${curatedEditorialObservations.episodeId} = ${ep.id}
                )`,
                updatedAt: now,
              })
              .where(eq(curatedEditorialEpisodes.id, ep.id));
          });

          summary[outcome] += 1;
        } catch (perEpErr) {
          summary.failed += 1;
          console.warn(
            '[CuratedEditorialOutcome] per-episode observation failed (non-fatal):',
            perEpErr instanceof Error ? perEpErr.message : perEpErr,
          );
        }
      }
    } catch (err) {
      // Fail-soft: a scan/observe failure must NEVER break a clustering pass.
      console.warn(
        '[CuratedEditorialOutcome] outcome observation skipped (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
    summary.latencyMs = Date.now() - startedAt;
    return summary;
  }

  // Pure, defensible comparison of ONE episode's requestedJson against the final
  // authoritative membership/priority indexes. No DB, no writes — extracted so it
  // is unit-testable and can never accidentally mutate state. Returns the outcome
  // WITHOUT ever consulting whether an overlay row exists.
  private _assessCuratedClusterOutcome(
    ep: CuratedEditorialEpisode,
    idx: { presentUrls: Set<string>; clusterByUrl: Map<string, string>; scoreByUrl: Map<string, number> },
  ): 'applied' | 'deferred' | 'conflicted' | 'dormant' {
    const req = (ep.requestedJson && typeof ep.requestedJson === 'object' ? ep.requestedJson : {}) as Record<string, unknown>;
    const rawUrls = Array.isArray(req.requestedMemberUrls) ? req.requestedMemberUrls as unknown[] : [];
    const requestedUrls = rawUrls
      .filter((u): u is string => typeof u === 'string' && u.length > 0)
      .map((u) => normalizeIdentityUrl(u));
    // Requested-ABSENT identities (an unlink / eviction / move-out intent).
    const rawAbsent = Array.isArray(req.requestedAbsentUrls) ? req.requestedAbsentUrls as unknown[] : [];
    const absentUrls = rawAbsent
      .filter((u): u is string => typeof u === 'string' && u.length > 0)
      .map((u) => normalizeIdentityUrl(u));
    const expectTogether = req.expectTogether !== false; // default: link/merge intent
    const rawSeparate = Array.isArray(req.requestedSeparateFromUrls) ? req.requestedSeparateFromUrls as unknown[] : [];
    const separateUrls = rawSeparate
      .filter((u): u is string => typeof u === 'string' && u.length > 0)
      .map((u) => normalizeIdentityUrl(u));
    const requestedMinPriority = typeof req.requestedMinPriority === 'number' ? req.requestedMinPriority : null;

    // No observable subject at all this pass → dormant (assert nothing).
    const anyPresent = requestedUrls.some((u) => idx.presentUrls.has(u))
      || absentUrls.some((u) => idx.presentUrls.has(u));
    if (requestedUrls.length === 0 && absentUrls.length === 0) return 'dormant';
    if (!anyPresent) return 'dormant';

    // CONFLICT checks (contrary to intent) take precedence over applied/deferred.
    // 1. A requested-ABSENT identity that is present CONTRADICTS an unlink intent.
    for (const u of absentUrls) {
      if (idx.presentUrls.has(u)) {
        // If it should be absent from a specific story but sits elsewhere, that's
        // fine; only a conflict when it's present AND (no story scoping given).
        return 'conflicted';
      }
    }

    // Evict/move-out means "not grouped with these source anchors", NOT "gone
    // from Curated." Evaluate that explicit relationship without treating a
    // healthy standalone/re-homed item as a conflict.
    if (separateUrls.length > 0 && requestedUrls.length > 0) {
      const subject = requestedUrls[0];
      const subjectCluster = idx.clusterByUrl.get(subject);
      if (subjectCluster) {
        for (const anchor of separateUrls) {
          if (idx.clusterByUrl.get(anchor) === subjectCluster) return 'conflicted';
        }
      }
    }

    if (requestedUrls.length > 0) {
      const present = requestedUrls.filter((u) => idx.presentUrls.has(u));
      const missing = requestedUrls.length - present.length;
      if (expectTogether && present.length >= 2) {
        // All present requested members must share ONE cluster to be "applied".
        const clusters = new Set(present.map((u) => idx.clusterByUrl.get(u)));
        if (clusters.size > 1) return 'conflicted'; // requested-together, but split
      }
      // Priority floor check against the AUTHORITATIVE kept score (never an overlay).
      if (requestedMinPriority !== null) {
        for (const u of present) {
          const score = idx.scoreByUrl.get(u);
          if (score !== undefined && score < requestedMinPriority) return 'conflicted';
        }
      }
      // Fully observable + consistent → applied. Partially observable → deferred.
      if (present.length === requestedUrls.length) {
        if (expectTogether && present.length >= 2) {
          const clusters = new Set(present.map((u) => idx.clusterByUrl.get(u)));
          return clusters.size === 1 ? 'applied' : 'conflicted';
        }
        return 'applied';
      }
      if (missing > 0) return 'deferred';
    }

    // Only requested-absent identities were involved and all are correctly absent.
    if (absentUrls.length > 0) return 'applied';
    return 'deferred';
  }

  // Curated View feedback inbox
  async createCuratedViewFeedback(item: InsertCuratedViewFeedback): Promise<CuratedViewFeedback> {
    const [row] = await db.insert(curatedViewFeedback).values(item).returning();
    return row;
  }

  async listCuratedViewFeedback(): Promise<CuratedViewFeedback[]> {
    return db
      .select()
      .from(curatedViewFeedback)
      .orderBy(desc(curatedViewFeedback.submittedAt));
  }

  // Content-kind overrides are keyed by the CANONICAL article identity:
  // normalizeIdentityUrl(<ORIGINAL stored url>). Normalization happens HERE at
  // the storage boundary (write, point-read, and bulk-read all normalize) so
  // every caller — endpoint, clustering pass, top-stories build — agrees on
  // one key even if a caller passes a tracking-query variant. Dead-link
  // REPLACEMENT urls are a different identity entirely; callers holding a
  // display url must first map it back via
  // resolveCuratedContentKindTargetUrl() below.
  async getCuratedContentKindOverrides(): Promise<Map<string, string>> {
    const rows = await db.select().from(curatedContentKindOverrides);
    // Normalize on read too — heals any legacy row stored pre-normalization.
    return new Map(rows.map(r => [normalizeIdentityUrl(r.url), r.kind]));
  }

  async getCuratedContentKindOverrideByUrl(url: string): Promise<string | null> {
    const key = normalizeIdentityUrl(url);
    const [row] = await db
      .select()
      .from(curatedContentKindOverrides)
      .where(eq(curatedContentKindOverrides.url, key))
      .limit(1);
    return row?.kind ?? null;
  }

  async setCuratedContentKindOverride(url: string, kind: string | null, editor: string): Promise<void> {
    const key = normalizeIdentityUrl(url);
    if (!kind) {
      await db.delete(curatedContentKindOverrides).where(eq(curatedContentKindOverrides.url, key));
    } else {
      await db
        .insert(curatedContentKindOverrides)
        .values({ url: key, kind, editor, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: curatedContentKindOverrides.url,
          set: { kind, editor, updatedAt: new Date() },
        });
    }
  }

  // Map a DISPLAY url back to the canonical override key. When an editor marks
  // a story whose dead link got a replacement overlay (Task #226), the popup
  // holds the REPLACEMENT url — but clustering and the payload builders key
  // overrides by the ORIGINAL stored url. Without this reverse mapping the
  // mark would sit under the replacement identity and the item would never be
  // demoted. Replacements are curated-lane only and the table is tiny, so a
  // full scan is fine. Falls through to the normalized input when the url is
  // not a known replacement (the common case).
  async resolveCuratedContentKindTargetUrl(url: string): Promise<string> {
    // Returns the RAW original stored url (not pre-normalized): the override
    // write/read boundary normalizes keys itself, and the raw url is what
    // exact-match consumers (e.g. the audit-snapshot lookup by stored row url)
    // need — a pre-normalized url could miss a stored row that carries
    // tracking params.
    const norm = normalizeIdentityUrl(url);
    try {
      const replacements = await this.getCuratedLinkReplacements();
      for (const [key, replUrl] of replacements) {
        if (normalizeIdentityUrl(replUrl) !== norm) continue;
        if (!key.startsWith('curated:')) continue;
        const id = key.slice('curated:'.length);
        const [row] = await db
          .select({ url: curatedItems.url })
          .from(curatedItems)
          .where(eq(curatedItems.id, id))
          .limit(1);
        if (row?.url) return row.url;
      }
    } catch {
      // fail-soft: treat as a non-replacement url
    }
    return url;
  }

  async pruneStaleCuratedContentKindOverrides(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const deleted = await db
      .delete(curatedContentKindOverrides)
      .where(lt(curatedContentKindOverrides.updatedAt, cutoff))
      .returning({ url: curatedContentKindOverrides.url });
    return deleted.length;
  }

  async markCuratedViewFeedbackReviewed(id: string, reviewedBy: string): Promise<void> {
    await db
      .update(curatedViewFeedback)
      .set({ reviewed: true, reviewedBy, reviewedAt: new Date() })
      .where(eq(curatedViewFeedback.id, id));
  }

  async markCuratedViewFeedbackReviewedBulk(ids: string[], reviewedBy: string): Promise<void> {
    if (ids.length === 0) return;
    await db
      .update(curatedViewFeedback)
      .set({ reviewed: true, reviewedBy, reviewedAt: new Date() })
      .where(inArray(curatedViewFeedback.id, ids));
  }

  async unmarkCuratedViewFeedbackReviewed(id: string): Promise<void> {
    await db
      .update(curatedViewFeedback)
      .set({ reviewed: false, reviewedBy: null, reviewedAt: null })
      .where(eq(curatedViewFeedback.id, id));
  }

  async deleteCuratedViewFeedback(id: string): Promise<void> {
    await db.delete(curatedViewFeedback).where(eq(curatedViewFeedback.id, id));
  }

  async deleteCuratedViewFeedbackBulk(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.delete(curatedViewFeedback).where(inArray(curatedViewFeedback.id, ids));
  }

  async getCuratedViewFeedbackUnreviewedCount(): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(curatedViewFeedback)
      .where(eq(curatedViewFeedback.reviewed, false));
    return row?.count ?? 0;
  }
}

export const storage = new DatabaseStorage();
