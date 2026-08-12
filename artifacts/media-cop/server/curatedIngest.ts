// -----------------------------------------------------------------------------
// Curated lane (Task #89, widened in Task #137) — WIDER-APERTURE ingest into the
// SEPARATE curated store. This job ONLY ever writes to `curated_items` /
// `curated_classifications` via storage; it NEVER touches `headlines`, the
// public REST API, custom MCOPs, or Classic/Visual.
//
// Intake sources (all funnel through the SAME isolated admission path so the
// isolation, dedup, age-out, clustering and synthesis machinery is reused):
//   1. Curated RSS feeds (the original wide-aperture source) — generous gate.
//   2. Team submissions (RSS-bot-screened + manual wires) — already screened
//      upstream, admitted WITHOUT a second LLM call (classified lazily by the
//      overlay backfill cron).
//   3. Main-pipeline rejects (Drudge scraper + RSS feeds that fail the strict
//      CJCS gate) — routed through the generous curated gate by the scraper /
//      RSS bot via `admitCuratedCandidates`.
//
// Admission for EVERY source: de-dupe (by URL, then by fuzzy title against the
// curated store) → relevance gate (or reuse upstream screening) → resolve lane
// TIER (contributing vs attach-only) from the Outlet Registry via findOutlet →
// write to the curated store with its role. Role default is attach-only
// (fail-closed) when an outlet is unknown; blocked outlets are hard-excluded and
// never enter the store at all.
// -----------------------------------------------------------------------------
import Parser from 'rss-parser';
import { storage } from './storage';
import { invalidateCuratedReadCache } from './curatedCacheBus';
import { requestCuratedReshape } from './curatedAutoReshape';
import { analyzeCuratedBatchChunked, translateCuratedTitlesToEnglish, CURATED_GATE_AI_BACKSTOP_MS, type CuratedAnalysisResult } from './aiAnalyzer';
import { isCuratedAiHarnessStub } from './curatedHarnessStub';
import { OTHER_EMERGING } from '@shared/classificationVocab';
import { normalizeTitle } from './titleNormalizer';
import { titleSimilarityAbove } from './titleSimilarity';
import { isRecentArticle } from './articleDateFilter';
import { buildOutletIndex, findOutlet, deriveOutletBehavior } from '@shared/outletRegistry';
import { normalizeIdentityUrl } from './urlIdentity';
import { CURATED_FEEDS, CURATED_TITLE_TRANSLATE_SOURCES, type CuratedFeedConfig } from './curatedFeeds';
import { yieldToEventLoop, CURATED_YIELD_CHUNK } from './eventLoop';
import { generateSummaryBullets, cacheCuratedItemMedia, persistImageToStorage, isFaviconUrl, isHardBlockedOutlet, enrichFreshHardBlockedCurated } from './streamPrefetch';
import { cleanSocialPostText } from './socialPostText';
import { CATALOG_SOCIAL_OSINT_ACCOUNTS, CATALOG_CURATED_JOURNALIST_ACCOUNTS, CATALOG_RAPIDRESPONSE_HANDLES, CATALOG_DOWRESPONSE_HANDLES, CATALOG_SENTDEFENDER_HANDLES, isApprovedCuratedAttachmentAccount } from '@shared/socialAccountCatalog';
import { fetchWithResilience } from './resilientFetch';
import { isYahooSyndicationUrl, resolveYahooSyndicatedPublisher } from './syndicationResolver';
import { CURATED_SOFT_CAP, capSoftPoliticsPriority, evalCuratedSoftCap, evalCuratedCapabilityCap, evalCuratedAnalysisOpinionCap, CURATED_ANALYSIS_OPINION_CAP, isCuratedNonRelevantConsumerFinance, evalCuratedDomesticCrimeCap, CURATED_DOMESTIC_CRIME_CAP, evalCuratedDirectUsImplicationTieBreak } from './scoreAdjustments';
import { isWatchTopicSteeringEnabled, loadActiveWatchTopics, matchWatchTopics, applyPriorityBoost, applyPriorityBoostWithStrength, createRescueBudget, type CompiledWatchTopic } from './watchTopicMatcher';
import type { InsertCuratedItem, InsertCuratedClassification } from '@shared/schema';

// Re-exported from the consolidated deterministic score-adjustment rules table
// (Task #444). The curated soft-politics cap now lives in ./scoreAdjustments so
// all deterministic caps share one auditable, testable home; re-exported here so
// existing importers (e.g. scripts/curated-soft-cap.test.ts) keep working.
export { CURATED_SOFT_CAP, capSoftPoliticsPriority, CURATED_ANALYSIS_OPINION_CAP, evalCuratedAnalysisOpinionCap, CURATED_DOMESTIC_CRIME_CAP, evalCuratedDomesticCrimeCap };

const CURATED_WINDOW_HOURS = 48; // how long curated items live in the store
// Editor content-kind marks (Task #892) are URL-keyed and must not outlive the
// article they were set on: prune marks untouched for this many days so a
// stale mark can't re-attach to a new story at a reused URL. Kept far above
// CURATED_WINDOW_HOURS so a mark always covers the item's full curated life.
const CONTENT_KIND_OVERRIDE_RETENTION_DAYS = 14;
// Two-window dedup design (Task #718): the cross-outlet similarity pass uses the
// full 48h store window (CURATED_WINDOW_HOURS) because independent outlets can
// corroborate the same event hours or a day apart, so the whole store is the
// relevant corroboration window. The same-outlet re-emit pass, by contrast, only
// needs a much tighter window: a single outlet re-publishing the SAME story via
// another feed/section does so within minutes-to-an-hour, essentially never a day
// later. Scoping that query to 12h keeps a high-volume outlet (Reuters, AP) from
// dragging its entire day of rows into memory on every ingest just to check for a
// near-instant re-emit.
const CURATED_OUTLET_REEMIT_WINDOW_HOURS = 12;
const MAX_PER_FEED = 25;         // cap items pulled per source per pass

// A near-dupe stored curated row, reduced to the only two fields the same-article
// decision needs (the URL identity and the canonical outlet name).
export interface SimilarCuratedRef {
  url: string | null | undefined;
  source: string | null | undefined;
}

// Same-article-only fuzzy-dup decision for the curated lane (Task #602). Given a
// candidate (its URL + canonical outlet) and the set of already-stored curated
// rows whose normalized TITLE is near-identical to it, decide whether the
// candidate is a TRUE duplicate of the SAME article — same normalized URL
// IDENTITY (a tracking-param/feed variant of the same link), or the SAME OUTLET
// re-emitting the story via multiple feeds/sections — in which case it must
// collapse. A near-dupe whose only matches come from DIFFERENT outlets is NOT a
// duplicate: independent sources publishing near-identical headlines are the
// strongest same-event signal and must be admitted as separate nodes so
// clustering can merge them into one corroborated story. Pure + exported for the
// regression test; curated-lane only.
export function isSameArticleDuplicate(
  candUrl: string | null | undefined,
  candOutlet: string | null | undefined,
  similar: ReadonlyArray<SimilarCuratedRef>,
): boolean {
  const candIdentity = normalizeIdentityUrl(candUrl ?? '');
  const cOutlet = (candOutlet ?? '').trim().toLowerCase();
  return similar.some((s) => {
    const sIdentity = normalizeIdentityUrl(s.url ?? '');
    if (candIdentity && sIdentity && candIdentity === sIdentity) return true; // same link
    const sOutlet = (s.source ?? '').trim().toLowerCase();
    return !!cOutlet && !!sOutlet && cOutlet === sOutlet; // same outlet re-emit
  });
}


// rss-parser's built-in HTTP client sends `User-Agent: rss-parser`, which some
// CDN-fronted outlets hard-block with a 403 (e.g. Cloudflare-fronted Arab News:
// 200 to a browser UA, 403 to rss-parser's). We therefore fetch each curated
// feed ourselves via fetchWithResilience (rotating browser UA + bounded retry on
// transient/UA-block failures, Task #383) and hand the body to
// parser.parseString(). Verified against the full CURATED_FEEDS list: every feed
// that previously parsed via parseURL still parses this way (no regressions).
// Curated-lane only.

// Team-submission intake bounds (Task #137). Keeps the per-pass volume bounded
// so the wider aperture can't flood the store / LLM clustering payload.
const TEAM_INTAKE_WINDOW_HOURS = 30;
const MAX_TEAM_SUBMISSIONS = 160;

// Headline-table intake bounds (main→curated parity bridge). The curated lane is
// meant to be a SUPERSET of the main feed, but the shared `headlines` table was
// the one main-feed source with NO curated intake (RSS, team/bot submissions and
// social already funnel in). Warfighter RSS (active in prod) and the Drudge
// scraper write straight to `headlines`, so those items never reached curated.
// Bounded like the team-submission intake so the wider aperture stays safe; real
// prod volume here is small (Warfighter = 3 outlets, Drudge dormant).
const HEADLINES_INTAKE_WINDOW_HOURS = 30;
const MAX_HEADLINES_FOR_CURATED = 200;

// Inline pre-enrichment bounds (Task #202). When a reuse-mode submission already
// arrives with a real (non-favicon) photo AND text we already hold, we generate
// its summary bullets inline at ingest (reusing the existing bullet helper — NO
// new article fetch) and stamp the curated row enriched, so it lands on the
// curated card fully formed instead of queueing for the rate-limited background
// worker. Bounded so a single ingest pass (up to 120 submissions) cannot fire
// 120 sequential LLM calls: only the top MAX_INLINE_ENRICH_PER_PASS rows by
// priority are enriched inline (with bounded concurrency), and every other row
// simply falls through to the existing worker exactly as today — it still shows
// its carried image + summary text immediately in the meantime.
const MAX_INLINE_ENRICH_PER_PASS = 24;
// T005: keep this STRICTLY BELOW the shared aiClient global concurrency (4) so a
// curated enrichment burst never claims every global slot — it leaves at least
// one free for co-running AI jobs (main clustering, classify, news bots) instead
// of fully serializing them behind curated. The gate phase
// (CURATED_GATE_CONCURRENCY=3) and this enrich phase run SEQUENTIALLY within a
// pass, so curated peaks at 3 in-flight provider calls, always ≤ the global cap.
const INLINE_ENRICH_CONCURRENCY = 3;

// Social/flash intake bounds (Task #138). Each source is capped independently so
// a chatty feed can't crowd out the others or bloat the clustering payload.
const SOCIAL_INTAKE_WINDOW_HOURS = 24;
const MAX_PER_SOCIAL_SOURCE = 40;
// Social posts have no headline — their body IS the "title" the clustering LLM
// sees. Cap it so a long post can't bloat the payload; the full text rides along
// as the summary for synthesis context.
const SOCIAL_TITLE_MAX_CHARS = 280;

function socialTitle(content: string): string {
  // Strip the relay's raw HTML + decode entities BEFORE truncating so the title
  // is clean post text, never literal `</p>` (Task #354).
  const clean = cleanSocialPostText(content).replace(/\s+/g, ' ').trim();
  return clean.length > SOCIAL_TITLE_MAX_CHARS
    ? clean.slice(0, SOCIAL_TITLE_MAX_CHARS - 1).trimEnd() + '…'
    : clean;
}

// Deterministic FNV-1a string hash — used only to spread reuse-mode baselines
// stably within a bucket (same URL always nudges the same way), never security.
function stableStrHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Differentiated baseline for reuse-mode items that arrive WITHOUT an upstream
// priority score (Task #248). Previously these (official social posts, Truth
// Social, DataMinr flash, and team submissions with no score) all collapsed to a
// flat 50, so they tied in the clustering candidate pool and split related
// stories into duplicate standalone rows. We derive a cheap, DETERMINISTIC
// baseline from the outlet's registry role + the item's recency, plus a small
// stable per-URL jitter to break remaining ties. No new AI call. This baseline
// only ever replaces the old flat-50 default; any real upstream score still wins.
/** @internal exported for unit tests (Task #1027) */
export function deriveReuseBaselinePriority(
  role: string | undefined,
  pub: Date | null,
  key: string,
  // Task #1071: relay/social posts (X/Truth relay, OSINT/journalist lanes,
  // DataMinr) carry NO trusted external pub signal — their lane-table scrapedAt
  // is the only honest age we hold. When pub is null and this fallback is
  // provided (set ONLY by the social/flash intake, deterministically), the
  // STALENESS deduction fires on scrapedAt age so a 4-day-old relay post can't
  // score the same as a fresh one. The recency BONUS still requires a trusted
  // pub date (scrapedAt is first-seen, never a "published fresh" claim).
  scrapedAtFallback?: Date | null,
): number {
  // Role base: trusted reporting outlets sit a touch higher than attach-only
  // social, which sits above contrast/anchor-only and unknown sources. All stay
  // BELOW the genuinely-critical band — reuse items must earn the top by
  // clustering, not by default.
  let base: number;
  switch (role) {
    case 'contributing': base = 52; break;
    case 'attach-only': base = 44; break;
    case 'anchor-only': base = 40; break;
    default: base = 36;
  }
  // Recency bonus: fresher items rank higher (drives candidate selection toward
  // the live news edge).
  let recencyBonus = 0;
  if (pub && !isNaN(pub.getTime())) {
    const ageH = (Date.now() - pub.getTime()) / 3_600_000;
    if (ageH <= 2) recencyBonus = 12;
    else if (ageH <= 6) recencyBonus = 8;
    else if (ageH <= 12) recencyBonus = 4;
    else if (ageH <= 24) recencyBonus = 1;
  }
  // Staleness deduction (Task #1027): penalise items whose trusted publish date
  // significantly pre-dates the moment of admission (i.e. old news entering the
  // queue for the first time). The recency bonus already fades to 0 for items
  // older than 24 h; this extends the curve into NEGATIVE territory for items
  // that are 48 h or 72 h stale so they score meaningfully below the base,
  // letting fresh items win candidate selection. Applies only when we have a
  // plausible pub date (null pub = no penalty — honest unknown > punish it).
  let stalenessDed = 0;
  const staleRef =
    pub && !isNaN(pub.getTime())
      ? pub
      : (scrapedAtFallback && !isNaN(scrapedAtFallback.getTime()) ? scrapedAtFallback : null);
  if (staleRef) {
    const ageH = (Date.now() - staleRef.getTime()) / 3_600_000;
    if (ageH > 72) stalenessDed = 10;
    else if (ageH > 48) stalenessDed = 5;
  }
  // Stable per-URL jitter (0-7) so two items in the same role+recency bucket
  // don't re-collide. Deterministic: same URL → same jitter across passes.
  const jitter = stableStrHash(key) % 8;
  return Math.max(1, Math.min(89, base + recencyBonus - stalenessDed + jitter));
}

/**
 * Stable final-boundary spreading for machine-authored Curated scores. Analyzer
 * de-clumping can only see one provider batch; this URL-keyed nudge also covers
 * single-item gate calls and reuse/social/flash admissions across independent
 * batches. It only lowers by 0..3, so it never invents importance. Explicit
 * upstream/team scores never call this helper.
 */
export function spreadMachineCuratedPriority(score: number, key: string, protectedFloor = 1): number {
  const bounded = Math.max(1, Math.min(100, Math.round(score)));
  return Math.max(
    Math.max(1, Math.min(100, Math.round(protectedFloor))),
    bounded - (stableStrHash(normalizeIdentityUrl(key) || key) % 4),
  );
}

// Re-entrancy guard + watchdog (root-cause fix). A curated ingest pass funnels
// through several network/AI/DB awaits (RSS fetch + body read, AI admission
// gate, social/flash intake). If ANY of them never settles — e.g. a server
// streams response headers then stalls the body so the read never finishes —
// the try/finally in runCuratedIngest never runs, `isIngestRunning` stays true
// forever, and EVERY subsequent scheduled pass logs "Already running, skipping
// this pass". That silently wedges curated ingest indefinitely (no new content,
// stale Top Stories) until a redeploy. We defend two ways, mirroring the
// StreamPrefetch backfill mutex watchdog:
//   1) wrap the whole pass in a hard timeout so a hung await still releases the
//      guard within INGEST_MAX_DURATION_MS (primary self-heal), and
//   2) treat a guard older than INGEST_MAX_DURATION_MS as wedged and force-reset
//      it so the next scheduled pass can proceed (belt-and-suspenders).
let isIngestRunning = false;
let ingestStartedAt = 0;
// Hard-timeout ceiling. Env-overridable ONLY so the abort-abandonment
// regression test (scripts/curated-ingest-gate-timeout.test.ts) can shorten it
// to seconds in its own process; production never sets the variable.
const INGEST_MAX_DURATION_MS =
  Number(process.env.CURATED_INGEST_MAX_DURATION_MS) > 0
    ? Number(process.env.CURATED_INGEST_MAX_DURATION_MS)
    : 8 * 60 * 1000; // 8 min — comfortably above a normal pass
// Per-DB-op bound for the curated ingest pass (Neon serverless reads over a
// WebSocket). A normal read is sub-second; this only trips if a connection
// stalls. Promise.race can't cancel the underlying Neon query, but it releases
// the await so one stalled DB call can't consume the whole pass budget — a
// finer-grained companion to the whole-pass INGEST_MAX_DURATION_MS. Curated-only.
const CURATED_DB_TIMEOUT_MS = 30 * 1000;

// SOFT per-pass deadline (read-path starvation fix). The 8-min hard timeout
// above is a WEDGE backstop, not a work budget — grinding for the full 8 min
// monopolizes the single-process event loop + shared AI/DB and starves user-
// facing reads (the Team page's thin /api/team/subjects spiked to 100s+). This
// soft deadline caps how long ONE pass keeps STARTING new work: once reached,
// each intake stage/loop stops dequeuing new work and returns its partial
// counts NORMALLY (never an AbortError — that stays reserved for the hard-
// timeout wedge backstop). URL-dedup makes reprocessing idempotent and the
// 5-min cron drains the remainder next tick. Mirrors the deadlineMs soft-
// deadline pattern in osintScraper.ts / xScraper.ts. Curated-lane only.
const INGEST_SOFT_DEADLINE_MS = 120 * 1000;

// Per-stage sub-budgets (stage-starvation fix). Previously every stage got the
// FULL 120s soft deadline, so the RSS stage routinely consumed all of it and
// team/social/headline stages were deferred every pass (violating the "curated
// is a superset of main" guarantee). Each cheap stage gets its own deadline
// slice counted from the pass start — guaranteeing every stage runs in every
// pass. Backlog-drain fix (Task #1075): the cheap reuse-mode stages now run
// FIRST (they are small, bounded, and have no AI gate — typically a few
// seconds each), and the RSS stage runs LAST with an ADAPTIVE budget: all
// remaining time up to the overall soft deadline. In the common case the
// cheap stages finish in ~10s, so RSS gets ~110s instead of the old fixed
// 75s — while starvation stays impossible because the cheap stages already
// ran before RSS can spend a single millisecond.
//   Team:     20s cap — reuse-mode only, small volume, no AI gate.
//   Social:   15s cap — reuse-mode, small volume (3 sources × 40 items max).
//   Headlines: 10s cap — reuse-mode, small volume (Warfighter RSS, Drudge dormant).
//   RSS:      everything left until INGEST_SOFT_DEADLINE_MS (min ~75s).
const TEAM_STAGE_BUDGET_MS     =  20_000;
const SOCIAL_STAGE_BUDGET_MS   =  15_000;
const HEADLINES_STAGE_BUDGET_MS = 10_000;

// -----------------------------------------------------------------------------
// Gate-verdict memo cache (RSS backlog-drain fix, Task #1075). The curated RSS
// feeds return largely the SAME items every 5-min pass; ingested items are
// screened out by URL dedup, but relevance-REJECTED items have no stored row,
// so every pass re-paid the full AI gate for the same ~700 titles — the gate
// alone consumed the whole RSS budget, the admit loop deferred everything, and
// the backlog never drained. This memoizes the analyzer's verdict PER TITLE
// (TTL-bounded, in-memory — correct on the single-instance vm deploy, same
// process-local pattern as the feed read cache) so a title is analyzed ONCE:
// subsequent passes admit/reject it from the cached verdict at DB speed.
// This does NOT change admission criteria — it replays the exact verdict the
// live analyzer produced; after the TTL the title is re-analyzed fresh.
// Curated-lane only.
// -----------------------------------------------------------------------------
const GATE_VERDICT_TTL_MS = 6 * 60 * 60 * 1000; // 6h — well under the 48h store window
const GATE_VERDICT_CACHE_MAX = 5000;            // bound memory; evicts oldest entries
// Slice of the stage budget held back from chunked gate analysis so the insert
// loop is guaranteed time to convert verdicts (cached + fresh) into rows.
// Must exceed the analyzer's worst-case IN-FLIGHT chunk overshoot (a chunk
// started just before the analysis cutoff can run up to its own per-chunk
// backstop past it), or the insert loop still starts already-expired and
// defers all. Task #1083: derived from the exported backstop (+15s insert
// headroom) instead of a hand-kept constant, so tightening the chunk timeout
// automatically widens the analysis window (55s backstop → 70s reserve vs the
// old 75s → 90s: ~20s more fresh analysis per pass).
const GATE_INSERT_RESERVE_MS = CURATED_GATE_AI_BACKSTOP_MS + 15_000;
const gateVerdictCache = new Map<string, { verdict: CuratedAnalysisResult; expires: number }>();

// Durable verdict persistence (Task #1083). The memo cache above is per-process,
// so every redeploy cold-started it and the first passes after a deploy re-paid
// the AI gate for the same ~700 backlog titles. Verdicts are now write-through
// mirrored to the curated_gate_verdicts table (fire-and-forget — never eats the
// insert budget) and hydrated ONCE into the memo cache at the first gate-mode
// pass after boot. Cached-verdict semantics are unchanged: same TTL, same
// replay-exact-verdict behavior; a hydrate failure just means one cold pass.
let gateVerdictHydrated = false;

async function hydrateGateVerdictCache(): Promise<void> {
  if (gateVerdictHydrated) return;
  try {
    const rows = await withCuratedTimeout(
      storage.loadCuratedGateVerdicts(GATE_VERDICT_CACHE_MAX),
      CURATED_DB_TIMEOUT_MS,
      'loadCuratedGateVerdicts',
    );
    let restored = 0;
    for (const r of rows) {
      const expires = r.expiresAt instanceof Date ? r.expiresAt.getTime() : new Date(r.expiresAt as any).getTime();
      if (!Number.isFinite(expires) || Date.now() >= expires) continue;
      if (gateVerdictCache.size >= GATE_VERDICT_CACHE_MAX) break;
      // Never clobber a verdict cached live in this process (fresher).
      if (!gateVerdictCache.has(r.title)) {
        gateVerdictCache.set(r.title, { verdict: r.verdict as CuratedAnalysisResult, expires });
        restored++;
      }
    }
    gateVerdictHydrated = true;
    if (restored > 0) {
      console.log(`[CuratedIngest] Gate verdict cache hydrated: ${restored} persisted verdict(s) restored (warm start)`);
    }
  } catch (e) {
    // Fail-soft: leave gateVerdictHydrated=false so the next pass retries.
    console.warn('[CuratedIngest] Gate verdict hydrate failed (cold pass, will retry):', (e as Error).message);
  }
}

// Fire-and-forget write-through of freshly-analyzed verdicts. Deliberately NOT
// awaited by the ingest pass — persistence must never consume gate/insert
// budget; a lost write only costs a re-analysis after the next redeploy.
function persistGateVerdicts(analyses: CuratedAnalysisResult[]): void {
  if (analyses.length === 0) return;
  const expiresAt = new Date(Date.now() + GATE_VERDICT_TTL_MS);
  void storage
    .saveCuratedGateVerdicts(analyses.map(a => ({ title: a.title, verdict: a, expiresAt })))
    .catch(e => console.warn('[CuratedIngest] Gate verdict persist failed (non-fatal):', (e as Error).message));
}

function getCachedGateVerdict(title: string): CuratedAnalysisResult | undefined {
  const hit = gateVerdictCache.get(title);
  if (!hit) return undefined;
  if (Date.now() >= hit.expires) {
    gateVerdictCache.delete(title);
    return undefined;
  }
  return hit.verdict;
}

function cacheGateVerdict(title: string, verdict: CuratedAnalysisResult): void {
  // Simple oldest-first eviction (Map preserves insertion order).
  if (gateVerdictCache.size >= GATE_VERDICT_CACHE_MAX) {
    const oldest = gateVerdictCache.keys().next().value;
    if (oldest !== undefined) gateVerdictCache.delete(oldest);
  }
  gateVerdictCache.set(title, { verdict, expires: Date.now() + GATE_VERDICT_TTL_MS });
}

// -----------------------------------------------------------------------------
// Reuse-mode skip memo (Task #1106). The team/social intakes re-load largely the
// SAME candidate windows every 5-min pass; INSERTED items are screened out by
// the batched URL-dedup, but SKIPPED items (fuzzy-dup, blocked outlet, learned
// suppression) have no stored row, so every pass re-paid their per-item DB
// round-trips — two similarity queries each — inside the 20s/15s stage slices.
// With ~150 repeat skips that alone exceeded the slice, so the loop deferred
// its tail EVERY pass and the "Soft deadline reached — deferring" line never
// cleared. This memoizes the skip verdict PER URL (TTL-bounded, in-memory —
// same single-instance-vm pattern as the gate-verdict cache) so an already-
// judged URL is dropped in the cheap synchronous screen at zero DB cost.
// Safety: only DETERMINISTIC-within-TTL reasons are memoized —
//   fuzzy-dup: the duplicate row it collapsed against lives 48h in the store,
//     far beyond the 2h TTL, so the verdict cannot go stale;
//   blocked / learned-irrelevance-suppressed: registry & learned-rule changes
//     take effect within one TTL.
// Reuse mode ONLY — gate-mode admission (AI verdicts) is untouched, and skip
// attribution telemetry keeps the ORIGINAL reason so per-source stats stay
// meaningful. Curated-lane only.
// -----------------------------------------------------------------------------
const REUSE_SKIP_MEMO_TTL_MS = 2 * 60 * 60 * 1000; // 2h — well under dup-row 48h life
const REUSE_SKIP_MEMO_MAX = 4000;                  // bound memory; oldest-first eviction
const REUSE_SKIP_MEMO_REASONS = new Set(['fuzzy-dup', 'blocked', 'learned-irrelevance-suppressed']);
const reuseSkipMemo = new Map<string, { reason: string; expires: number }>();

function getReuseSkipMemo(url: string): string | undefined {
  const hit = reuseSkipMemo.get(url);
  if (!hit) return undefined;
  if (Date.now() >= hit.expires) {
    reuseSkipMemo.delete(url);
    return undefined;
  }
  return hit.reason;
}

function cacheReuseSkip(url: string, reason: string): void {
  if (!REUSE_SKIP_MEMO_REASONS.has(reason)) return;
  if (reuseSkipMemo.size >= REUSE_SKIP_MEMO_MAX) {
    const oldest = reuseSkipMemo.keys().next().value;
    if (oldest !== undefined) reuseSkipMemo.delete(oldest);
  }
  reuseSkipMemo.set(url, { reason, expires: Date.now() + REUSE_SKIP_MEMO_TTL_MS });
}

// Per-label rotation cursor for the reuse-mode insert loop (Task #1106). Even
// with the skip memo, a cold pass (post-deploy) can still hit the stage slice
// mid-list; a FIXED processing order would then defer the SAME tail items
// every cold pass. Rotating the start offset by how many items were processed
// makes any deferred tail drain across passes — the same starvation fix as
// the curatedFeedCursor for RSS feeds. Reuse mode only (gate mode has its own
// verdict-first partition ordering that must be preserved).
const reuseInsertCursors = new Map<string, number>();

// Backlog drain guard (Task #1075): if the RSS stage keeps deferring a large
// number of items for several consecutive passes, the throughput fix has
// regressed — make that loudly visible instead of silent.
const RSS_BACKLOG_WARN_THRESHOLD = 200;   // deferred items per pass
const RSS_BACKLOG_WARN_CONSECUTIVE = 3;   // passes in a row before warning
let rssBacklogConsecutiveHighPasses = 0;

// True once the soft deadline has passed. Unlike throwIfAborted (hard timeout →
// throw), a soft-deadline hit is a GRACEFUL stop: callers break/return with
// whatever they've done so far.
function isPastDeadline(deadlineMs?: number): boolean {
  return deadlineMs !== undefined && Date.now() >= deadlineMs;
}

// Round-robin start offset into CURATED_FEEDS across passes (read-path
// starvation fix). When a pass stops fetching feeds at the soft deadline, the
// NEXT pass resumes at the first feed it didn't reach, so tail feeds are never
// perpetually deferred. Advanced by the number of feeds actually attempted.
let curatedFeedCursor = 0;

// Throws an AbortError immediately if signal has already been fired. Used at
// loop-iteration boundaries so the background pass stops queueing new AI / DB
// work as soon as the outer timeout aborts the controller.
function throwIfAborted(signal: AbortSignal | undefined, label?: string): void {
  if (signal?.aborted) {
    const err = new Error(`Ingest cancelled${label ? ` (${label})` : ''}`);
    err.name = 'AbortError';
    throw err;
  }
}

function withCuratedTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  controller?: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Signal the AbortController so every loop boundary inside the pass can
      // detect the cancellation and stop queuing new AI / DB / network calls.
      // The underlying awaits that are already in-flight will still settle, but
      // the pass won't start any NEW work iterations after the abort.
      controller?.abort();
      const err = new Error(`Timeout (${ms}ms) for ${label}`);
      // When this timeout is the pass-level wedge backstop (a controller was
      // provided and has just been aborted), surface the rejection AS an
      // AbortError so runCuratedIngest's catch takes the cancellation path
      // ("Pass cancelled early") rather than logging a fatal error. Plain DB
      // op timeouts (no controller) keep the generic Timeout error.
      if (controller) err.name = 'AbortError';
      reject(err);
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// A curated candidate URL must be a SINGLE well-formed http(s) URL (Task #427).
// The Drudge-rejects path once produced a row whose URL was two URLs joined by a
// space ("https://www.drudgereport.com https://www.hollywoodreporter.com/…") —
// an href with a leading space got the drudgereport base prepended. That broke
// `new URL()`, so source resolution threw and fell back to "Unknown Source", and
// the broken URL corrupted the item's identity/dedup key. The legacy gate check
// (`/^https?:\/\//i`) accepted it because it only matched the PREFIX. We now
// require the whole string to parse as one http(s) URL with no internal
// whitespace, so a malformed/space-joined candidate is dropped before storage
// rather than admitted under a junk fallback label. Curated-lane only.
export function isSingleWellFormedHttpUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const url = raw.trim();
  if (!url || /\s/.test(url)) return false; // empty or internal whitespace → not one URL
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return ('https://' + u.host + u.pathname).replace(/\/+$/, '');
  } catch {
    return url.split('?')[0].split('#')[0].replace(/\/+$/, '').replace(/^http:/, 'https:');
  }
}

interface CuratedCandidate {
  title: string;
  url: string;
  normalizedUrl: string;
  source: string;
  pubDate?: string;
}

// A generic candidate for admission into the isolated curated store. Used by the
// RSS curated ingest, the main-pipeline reject capture (scraper / RSS bot), and
// team-submission intake.
export interface CuratedIntakeCandidate {
  title: string;
  url: string;
  source: string;
  pubDate?: string | Date | null;
  // Optional precomputed enrichment. In 'reuse' mode these are carried straight
  // onto the curated row (no LLM call); in 'gate' mode the analyzer fills the
  // gaps and these act as fallbacks.
  priorityScore?: number;
  summary?: string;
  ogImageUrl?: string | null;
  videoUrl?: string | null;
  tags?: string[];
  category?: string;
  // Full article body (when we already hold it). Used ONLY for inline bullet
  // generation in reuse mode (Task #202); falls back to `summary` when absent.
  fullText?: string | null;
  // Task #1071: lane-table first-seen timestamp for relay/social posts. Set
  // ONLY by the social/flash intake (deterministic marker of a relay/social
  // item). Used solely as the STALENESS fallback in
  // deriveReuseBaselinePriority when no trusted pub date exists — never
  // stored, never displayed as a publish date.
  scrapedAt?: Date | null;
}

type AdmitMode =
  // Run the generous curated analyzer; admit only is_relevant items and take
  // the analyzer's content-based category/region/country.
  | 'gate'
  // Already screened upstream (team submissions); admit without an LLM call.
  // Geography is classified lazily by the URL-keyed overlay backfill cron.
  | 'reuse';

// Per-source feed-fetch stats (Task #950). Task #1114 added fetch-failure
// capture so a 403/DNS/parser failure becomes the source's stated funnel
// reason instead of living only in logs.
export interface CuratedFeedFetchStat {
  fetched: number;
  kept: number;
  aged: number;
  dupInPass: number;
  fetchFailures: number;
  lastFetchError: string | null;
}

type FeedFetchResult = {
  candidates: CuratedCandidate[];
  feedStats: Map<string, CuratedFeedFetchStat>;
};

async function fetchCuratedFeeds(signal?: AbortSignal, deadlineMs?: number): Promise<FeedFetchResult> {
  const out: CuratedCandidate[] = [];
  const seen = new Set<string>();
  // Per-source fetch stats (Task #950): aggregated across all feed URLs for a
  // given sourceName so multi-URL sources (e.g. Politico) report one combined row.
  const feedStats = new Map<string, CuratedFeedFetchStat>();
  const getFeedStat = (src: string): CuratedFeedFetchStat => {
    let s = feedStats.get(src);
    if (!s) {
      s = { fetched: 0, kept: 0, aged: 0, dupInPass: 0, fetchFailures: 0, lastFetchError: null };
      feedStats.set(src, s);
    }
    return s;
  };
  const bumpFeedStat = (src: string, field: 'fetched' | 'kept' | 'aged' | 'dupInPass') => {
    getFeedStat(src)[field]++;
  };
  // Task #1114: persist per-feed fetch failures (HTTP status / DNS / parser)
  // so the Coverage funnel can state the reason instead of showing silence.
  const recordFetchFailure = (src: string, message: string) => {
    const s = getFeedStat(src);
    s.fetchFailures++;
    const msg = (message || 'fetch failed').trim();
    s.lastFetchError = msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
  };

  // Rotate the start (read-path starvation fix) so a pass that stops early at
  // the soft deadline doesn't defer the SAME tail feeds every cycle — the next
  // pass resumes where this one left off.
  const len = CURATED_FEEDS.length;
  const start = len > 0 ? curatedFeedCursor % len : 0;
  const ordered: CuratedFeedConfig[] = [
    ...CURATED_FEEDS.slice(start),
    ...CURATED_FEEDS.slice(0, start),
  ];

  // Bounded-parallel fetch (read-path starvation fix). Feeds were fetched
  // strictly one-at-a-time — up to 15s × retries each — so a handful of slow
  // feeds could consume most of the pass budget before any AI work began. A
  // small worker pool fetches several at once (network I/O, so it doesn't block
  // the event loop) while still respecting the soft deadline and MAX_PER_FEED.
  // Retries are dropped to 1 here (fetchWithResilience's per-URL circuit breaker
  // already fast-fails persistently-dead feeds), so one feed can't burn ~45s.
  const FEED_FETCH_CONCURRENCY = 4;
  let idx = 0;
  let attempted = 0;

  const worker = async () => {
    // A per-worker parser: parseString holds no cross-call state, but giving
    // each worker its own instance keeps the parallel parses fully independent.
    const parser = new Parser({ timeout: 15000 });
    while (true) {
      throwIfAborted(signal, 'fetchCuratedFeeds');
      // Soft-deadline graceful stop: leave the rest of `ordered` for the next
      // pass (the cursor below makes it resume there).
      if (isPastDeadline(deadlineMs)) return;
      const myIdx = idx++;
      if (myIdx >= ordered.length) return;
      attempted++;
      const feed = ordered[myIdx];
      // Per-feed fetch instrumentation (Task #403): make a silent feed
      // attributable to a SPECIFIC reason rather than just "0 admitted".
      let totalItems = 0;   // items the feed returned
      let aged = 0;         // dropped: older than the recency window
      let dupInPass = 0;    // dropped: same URL already seen this pass
      let kept = 0;         // emitted as candidates
      try {
        const resp = await fetchWithResilience(feed.url, {
          accept: 'application/rss+xml, application/xml, text/xml, */*',
          timeoutMs: 15000,
          retries: 1,
          label: `CuratedIngest:${feed.sourceName}`,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const parsed = await parser.parseString(await resp.text());
        // Yield after the CPU-heavy XML parse so a big feed can't stall pending
        // HTTP requests on this single-process VM.
        await yieldToEventLoop();
        for (const item of parsed.items || []) {
          totalItems++;
          if (kept >= MAX_PER_FEED) break;
          if (!item.title || !item.link) continue;
          const normalizedUrl = normalizeUrl(item.link);
          if (seen.has(normalizedUrl)) { dupInPass++; bumpFeedStat(feed.sourceName, 'dupInPass'); continue; }
          if (!isRecentArticle(item.pubDate, 'CuratedIngest')) { aged++; bumpFeedStat(feed.sourceName, 'aged'); continue; }
          seen.add(normalizedUrl);
          out.push({
            title: item.title.trim(),
            url: item.link,
            normalizedUrl,
            source: feed.sourceName,
            pubDate: item.pubDate,
          });
          kept++;
          bumpFeedStat(feed.sourceName, 'kept');
        }
        // Stamp fetched count once for the whole feed (not per-item, to avoid
        // a loop of bumpFeedStat calls; fetched == totalItems for this source URL).
        for (let fi = 0; fi < totalItems; fi++) bumpFeedStat(feed.sourceName, 'fetched');
        // Surface feeds that fetched fine but yielded nothing usable — the most
        // common quiet failure (a reachable feed gone stale, or wholly duped).
        if (kept === 0) {
          console.warn(
            `[CuratedIngest] feed ${feed.sourceName}: 0 candidates (items=${totalItems} aged-out=${aged} dup-in-pass=${dupInPass}) ${feed.url}`,
          );
        } else {
          console.log(
            `[CuratedIngest] feed ${feed.sourceName}: kept=${kept} (items=${totalItems} aged-out=${aged} dup-in-pass=${dupInPass})`,
          );
        }
      } catch (error) {
        console.error(`[CuratedIngest] Failed feed ${feed.sourceName} (${feed.url}):`, (error as Error).message);
        recordFetchFailure(feed.sourceName, (error as Error).message);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(FEED_FETCH_CONCURRENCY, ordered.length) }, () => worker()),
  );

  // Advance the cursor past the feeds we attempted so the next pass resumes at
  // the first un-attempted feed. When every feed was attempted this is a no-op
  // (mod len), so a healthy pass keeps a stable ordering.
  if (len > 0) curatedFeedCursor = (curatedFeedCursor + attempted) % len;
  const deferredFeeds = ordered.length - attempted;
  if (deferredFeeds > 0) {
    console.log(
      `[CuratedIngest] Soft deadline reached during feed fetch — deferred ${deferredFeeds}/${ordered.length} feed(s) to next pass (resume at index ${curatedFeedCursor})`,
    );
  }
  return { candidates: out, feedStats };
}

// -----------------------------------------------------------------------------
// SHARED admission path. Every curated intake source funnels through here so the
// isolation guarantee lives in ONE place: this only ever writes to
// curated_items / curated_classifications. NEVER touches any shared feed.
// -----------------------------------------------------------------------------
// Deterministic relevant verdict for the curated-isolation harness (Task #492).
// Marks every title relevant with neutral classification defaults so the
// reject-capture intake path runs end-to-end without an AI call. Curated-only,
// gated by isCuratedAiHarnessStub() at the call site.
function harnessStubGateAnalysis(title: string): CuratedAnalysisResult {
  return {
    title,
    is_relevant: true,
    reason: 'harness-stub deterministic relevance',
    tags: [],
    priority_score: 50,
    category: 'general',
    region: null,
    country: null,
    primaryTopic: OTHER_EMERGING,
    scope: null,
    conflictTrack: null,
    countryPair: null,
    proposedTopic: null,
  };
}

export async function admitCuratedCandidates(
  candidates: CuratedIntakeCandidate[],
  opts: { mode: AdmitMode; label: string; enrichInline?: boolean; signal?: AbortSignal; deadlineMs?: number },
): Promise<{ ingested: number; skipped: number }> {
  if (candidates.length === 0) return { ingested: 0, skipped: 0 };

  // Bail before the very FIRST DB/AI call if the outer pass has already been
  // aborted by the hard timeout. Without this entry guard, a pre-aborted pass
  // would still fire storage.getOutletRegistry() (and, in gate mode, the AI
  // relevance batch) before the per-item loop's own abort checks kicked in —
  // exactly the "keep hammering shared resources after the timeout" behaviour
  // the abort signal exists to prevent.
  throwIfAborted(opts.signal, `admitCuratedCandidates:entry:${opts.label}`);

  // Resolve lane TIER from the registry (single source of truth for trust).
  const registry = await withCuratedTimeout(
    storage.getOutletRegistry(),
    CURATED_DB_TIMEOUT_MS,
    'getOutletRegistry',
  );
  const outletIndex = buildOutletIndex(registry);

  // Per-source × per-reason drop instrumentation (Task #403). When a configured
  // source reads as "silent", this attributes WHERE its candidates went (invalid,
  // duplicate URL, intra-batch dupe, relevance gate, fuzzy near-dupe, blocked
  // outlet) instead of just a single opaque skip count.
  const drops = new Map<string, Record<string, number>>();
  const bump = (src: string | null | undefined, reason: string) => {
    const key = src || '(unknown)';
    let r = drops.get(key);
    if (!r) { r = {}; drops.set(key, r); }
    r[reason] = (r[reason] || 0) + 1;
  };
  // Per-source ADMITTED counter, reported alongside the drop attribution so the
  // end-of-pass summary shows ingested vs each drop reason for every source —
  // a source reading "silent" then shows whether it admitted 0 AND why the rest
  // dropped (Task #403).
  const ingestedBySource = new Map<string, number>();
  const bumpIngested = (src: string | null | undefined) => {
    const key = src || '(unknown)';
    ingestedBySource.set(key, (ingestedBySource.get(key) || 0) + 1);
  };
  // Per-source DEFERRED counter (Task #1114): items this pass never processed
  // because a soft-deadline stop fired first (screening loop or insert loop).
  // NOT a drop — the next pass retries them idempotently via URL-dedup. Without
  // this, a source whose whole batch sits past the deadline every pass writes
  // no per-source counter at all and vanishes from the Coverage funnel.
  const deferredBySource = new Map<string, number>();
  const bumpDeferred = (src: string | null | undefined) => {
    const key = src || '(unknown)';
    deferredBySource.set(key, (deferredBySource.get(key) || 0) + 1);
  };

  // Persist per-source admission telemetry (Task #950; Task #1114 added the
  // deferred counter and always-write-on-exit semantics). Called on EVERY
  // normal exit path — including the all-dup/invalid quiet-pass early return —
  // because mergeCuratedIntakeFeedStats has already zeroed this pass's
  // admission counters and set admission_pending for RSS rows; skipping the
  // write would leave those rows frozen "mid-pass" forever. Fail-soft: a DB
  // write error must NEVER abort the ingest pass or alter its return value.
  const persistAdmissionTelemetry = async () => {
    const allSources = new Set<string>([
      ...ingestedBySource.keys(),
      ...drops.keys(),
      ...deferredBySource.keys(),
    ]);
    if (allSources.size === 0) return;
    // Per-source ingested + per-reason drop attribution (Task #403): pinpoint
    // WHY a source delivered nothing this pass (e.g. all relevance-rejected vs.
    // all fuzzy-deduped vs. all gate-unscored), and how many it DID admit.
    const summary = Array.from(allSources)
      .map((src) => {
        const got = ingestedBySource.get(src) || 0;
        const reasons = drops.get(src);
        const parts = reasons
          ? Object.entries(reasons)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, n]) => `${reason}=${n}`)
              .join(' ')
          : '';
        const deferred = deferredBySource.get(src) || 0;
        return `${src} [ingested=${got}${parts ? ' ' + parts : ''}${deferred > 0 ? ` deferred=${deferred}` : ''}]`;
      })
      .sort()
      .join('; ');
    console.log(`[CuratedIntake:${opts.label}] By source — ${summary}`);
    const now = new Date();
    const telemetryRows = Array.from(allSources).map((src) => {
      const got = ingestedBySource.get(src) || 0;
      const r = drops.get(src) || {};
      return {
        sourceName: src,
        lastLabel: opts.label,
        lastRunAt: now,
        ingested: got,
        dropInvalid: r['invalid'] || 0,
        dropDupUrl: r['dup-url'] || 0,
        dropDupBatch: r['dup-in-batch'] || 0,
        dropRelevanceRejected: r['relevance-rejected'] || 0,
        dropRelevanceFinance: r['relevance-rejected-finance'] || 0,
        dropGateUnscored: r['gate-unscored'] || 0,
        dropFuzzyDup: r['fuzzy-dup'] || 0,
        dropBlocked: r['blocked'] || 0,
        deferred: deferredBySource.get(src) || 0,
      };
    });
    await storage.upsertCuratedIntakeTelemetry(telemetryRows).catch((err) => {
      console.warn(`[CuratedIntake:${opts.label}] Failed to persist admission telemetry (non-fatal):`, (err as Error).message);
    });
  };

  // De-dupe against what is already in the curated store (URL exact match) and
  // against duplicates within this batch.
  const fresh: CuratedIntakeCandidate[] = [];
  let skipped = 0;
  const seenUrls = new Set<string>();
  // Cheap SYNCHRONOUS screens first (invalid URL / unknown source / finance
  // reject / intra-batch dup), collecting the survivors + their URLs for ONE
  // batched existing-URL lookup below (read-path starvation fix) instead of a DB
  // round trip per candidate. Yields periodically so screening a large batch
  // can't monopolize the event loop on this single-process VM.
  const toCheck: CuratedIntakeCandidate[] = [];
  let screenI = 0;
  // Index-based so a soft-deadline stop can attribute the unscreened tail as
  // DEFERRED (Task #1114) instead of it silently vanishing from the funnel.
  let screenStop = candidates.length;
  for (let ci = 0; ci < candidates.length; ci++) {
    const c = candidates[ci];
    // Stop dequeuing new candidates if the ingest-pass timeout has aborted the
    // controller — this prevents further work from piling up after the outer
    // pass has already been abandoned.
    throwIfAborted(opts.signal, 'admitCuratedCandidates:dedup-loop');
    // Soft-deadline graceful stop: leave the rest for the next pass (URL-dedup
    // makes reprocessing idempotent).
    if (isPastDeadline(opts.deadlineMs)) { screenStop = ci; break; }
    if (++screenI % CURATED_YIELD_CHUNK === 0) await yieldToEventLoop();
    // Drop candidates with no title or a URL that is not a single well-formed
    // http(s) URL (Task #427) — including the space-joined-two-URLs case that
    // produced the "Unknown Source" row. A candidate that can't yield a
    // parseable identity URL is rejected here, never stored under a fallback
    // label. We then carry the TRIMMED url forward so a merely-padded-but-valid
    // URL is stored clean.
    if (!c.title || !isSingleWellFormedHttpUrl(c.url)) { skipped++; bump(c.source, 'invalid'); continue; }
    // Fail-closed on an unresolved source (Task #427). When attribution never
    // got past the junk "Unknown Source" fallback, drop the candidate rather
    // than store it under a label that corrupts dedup/identity — applies to
    // EVERY intake path, not just the Drudge-rejects path that produces it.
    if (!c.source || c.source.trim() === '' || c.source.trim() === 'Unknown Source') {
      skipped++; bump(c.source || 'Unknown Source', 'invalid'); continue;
    }
    // Deterministic curated-lane RELEVANCE reject — personal/consumer-finance &
    // money-management how-to ("4 bank accounts to put your money", best credit
    // cards, savings/retirement tips). A true EARLY gate: runs for EVERY intake
    // path here (both 'gate' and 'reuse' modes) BEFORE the AI relevance batch, so
    // a finance item never reaches the analyzer (saves tokens) and 'reuse' items
    // (Meltwater / social) — which have NO AI gate at all — are still screened.
    // Needed because the AI gate periodically mis-keeps these (the prompting CNBC
    // item scored P67). Economic STATECRAFT (sanctions, tariffs, trade war, export
    // controls, supply chains, defense-industrial finance) is protected by the
    // strategic guard inside the helper, so real statecraft is never rejected.
    if (isCuratedNonRelevantConsumerFinance(c.title)) {
      skipped++; bump(c.source, 'relevance-rejected-finance'); continue;
    }
    c.url = c.url.trim();
    // Reuse-mode skip memo (Task #1106): a URL this process already judged a
    // deterministic skip (fuzzy-dup / blocked / learned-suppressed) within the
    // TTL is dropped HERE at zero DB cost, instead of re-paying its per-item
    // similarity queries in the insert loop every pass. Attribution keeps the
    // original reason so per-source telemetry stays meaningful.
    if (opts.mode === 'reuse') {
      const memoReason = getReuseSkipMemo(c.url);
      if (memoReason) { skipped++; bump(c.source, memoReason); continue; }
    }
    if (seenUrls.has(c.url)) { skipped++; bump(c.source, 'dup-in-batch'); continue; }
    seenUrls.add(c.url);
    toCheck.push(c);
  }
  // Everything the screening loop never reached was postponed, not judged.
  for (let ci = screenStop; ci < candidates.length; ci++) bumpDeferred(candidates[ci].source);
  // ONE batched round trip for the already-in-store (URL exact match) check,
  // replacing up to ~1,300 sequential getCuratedItemByUrl calls per pass.
  const existingUrls = await withCuratedTimeout(
    storage.getExistingCuratedUrls(toCheck.map((c) => c.url)),
    CURATED_DB_TIMEOUT_MS,
    'getExistingCuratedUrls',
  );
  for (const c of toCheck) {
    if (existingUrls.has(c.url)) { skipped++; bump(c.source, 'dup-url'); continue; }
    fresh.push(c);
  }
  if (fresh.length === 0) {
    console.log(`[CuratedIntake:${opts.label}] All ${candidates.length} candidates already present / invalid`);
    // Task #1114: still persist the attribution (dup-url / invalid / deferred)
    // and clear the pass-state marker — a quiet pass where EVERY candidate was
    // already in store used to skip the write, leaving RSS rows stuck on
    // zeroed "fetched N / admitted 0 / no reasons" counters.
    await persistAdmissionTelemetry();
    return { ingested: 0, skipped };
  }

  // Non-English → English title translation (Task #656). Sources flagged in
  // CURATED_TITLE_TRANSLATE_SOURCES (e.g. Prensa Latina's Spanish `.cu` feed)
  // publish headlines in another language, but every curated headline surface —
  // including the State-Controlled Narratives lens — renders the RAW stored
  // title with no per-item English synthesis. So we translate the title IN
  // PLACE here, once, on the genuinely-new `fresh` items only, at the single
  // chokepoint BEFORE the relevance gate, the same-article fuzzy de-dupe, and
  // the insert. Rewriting c.title means English flows through the gate,
  // clustering (so these adversary items can attach to the English trusted
  // stories they contrast), dedup, storage, and display in one place — no
  // schema change, URL identity preserved. Fail-safe: any translation miss
  // keeps the original title (still displays), and the whole step is skipped
  // under the AI harness stub so the isolation harness stays deterministic.
  // Abort before launching any AI work (translation + gate analysis) so a
  // timed-out pass doesn't start new network calls at this boundary.
  throwIfAborted(opts.signal, 'admitCuratedCandidates:pre-translate');
  if (!isCuratedAiHarnessStub()) {
    const toTranslate = fresh.filter(
      (c) => c.source && CURATED_TITLE_TRANSLATE_SOURCES.has(c.source),
    );
    if (toTranslate.length > 0) {
      try {
        const translations = await translateCuratedTitlesToEnglish(
          toTranslate.map((c) => c.title),
        );
        let applied = 0;
        for (const c of toTranslate) {
          const en = translations.get(c.title);
          if (en && en.trim().length > 2 && en.trim() !== c.title) {
            c.title = en.trim();
            applied++;
          }
        }
        if (applied > 0) {
          console.log(
            `[CuratedIntake:${opts.label}] Translated ${applied}/${toTranslate.length} non-English title(s) to English`,
          );
        }
      } catch (error) {
        console.error(
          '[CuratedIntake] Non-English title translation failed (non-fatal, keeping originals):',
          (error as Error).message,
        );
      }
    }
  }

  // Relevance gate. 'gate' = run the generous curated analyzer once over the
  // whole batch; 'reuse' = items were already screened upstream.
  let analysisByTitle = new Map<string, CuratedAnalysisResult>();
  if (opts.mode === 'gate') {
    // Bounded-concurrency chunked analysis (Task #383): a larger backlog is split
    // into <=25-title chunks run with a small worker pool (each chunk still
    // metered by the shared rate-limited AI client), instead of one giant serial
    // call that would block the pipeline and risk truncation.
    // T006: send the gate only the UNIQUE, non-empty titles. The analysis is
    // keyed by title (looked up per-item below), so collapsing duplicate titles
    // (syndicated wire stories reprinted under an identical headline by several
    // outlets) and dropping whitespace-only ones cuts redundant AI work WITHOUT
    // dropping any candidate — every fresh item still flows through the
    // trust-aware fuzzy de-dupe and the insert loop unchanged. Pure AI-volume
    // reduction; curated quality and isolation are untouched.
    const uniqueGateTitles = Array.from(
      new Set(fresh.map(c => c.title).filter(t => t.trim().length > 0)),
    );
    // Test-harness deterministic gate (Task #492): when the curated-isolation
    // harness sets CURATED_AI_HARNESS_STUB=1 in its OWN process, the LLM gate is
    // replaced by a deterministic relevant verdict so the reject-capture intake
    // side-effect ALWAYS runs (and can be HARD-asserted) instead of depending on
    // a live model surviving a 429 storm. The production server never sets the
    // flag, so the live admission gate is unaffected. Tier is still derived from
    // the registry below (unknown source → attach-only), so isolation is intact.
    if (isCuratedAiHarnessStub()) {
      // Harness stub is deterministic and free — never touches the memo cache
      // so a harness run can't pollute (or be polluted by) live verdicts.
      analysisByTitle = new Map(uniqueGateTitles.map(t => [t, harnessStubGateAnalysis(t)]));
    } else {
      // Gate-verdict memo (Task #1075): replay cached verdicts and only send
      // titles the analyzer has NOT seen within the TTL. This is what lets the
      // steady ~700-item RSS backlog drain — repeat titles cost zero AI time.
      // Task #1083: warm the memo cache from the persisted verdict table once
      // per boot so a redeploy doesn't cold-start the backlog drain.
      await hydrateGateVerdictCache();
      const cachedHits: CuratedAnalysisResult[] = [];
      const missTitles: string[] = [];
      for (const t of uniqueGateTitles) {
        const cached = getCachedGateVerdict(t);
        if (cached) cachedHits.push(cached);
        else missTitles.push(t);
      }
      const gateStart = Date.now();
      // Reserve a slice of the remaining budget for the INSERT loop below
      // (Task #1075 follow-through): without this, chunked analysis runs right
      // up to the soft deadline, the insert loop starts already-expired, and
      // every analyzed item is deferred — verdicts pile up in the memo cache
      // but ingested stays 0 forever. Analysis stops early; the insert loop
      // then has guaranteed time to convert cached + fresh verdicts into rows.
      // Clamped to never EXCEED the pass soft deadline: when little budget
      // remains, analysis gets whatever is left (min 10s floor, capped at the
      // deadline) rather than overrunning the pass.
      const analysisDeadlineMs = opts.deadlineMs !== undefined
        ? Math.min(opts.deadlineMs, Math.max(Date.now() + 10_000, opts.deadlineMs - GATE_INSERT_RESERVE_MS))
        : undefined;
      const analyses = missTitles.length > 0
        ? await analyzeCuratedBatchChunked(missTitles, { signal: opts.signal, deadlineMs: analysisDeadlineMs })
        : [];
      // Cache every verdict the analyzer actually returned (keyed by the echoed
      // title — same key used for lookup below). Titles the analyzer did NOT
      // return (chunk truncation / deadline cut) are deliberately NOT cached, so
      // they get a fresh attempt next pass instead of a frozen 'gate-unscored'.
      for (const a of analyses) cacheGateVerdict(a.title, a);
      // Durable mirror (Task #1083): fire-and-forget so persistence never eats
      // the reserved insert window.
      persistGateVerdicts(analyses);
      console.log(
        `[CuratedIntake:${opts.label}] Gate phase: ${cachedHits.length} cached verdict(s), ` +
        `${analyses.length}/${missTitles.length} freshly analyzed in ${Math.round((Date.now() - gateStart) / 1000)}s`,
      );
      analysisByTitle = new Map([...cachedHits, ...analyses].map(a => [a.title, a]));
    }
  }

  // Watch-topic steering (Task #884 — CURATED-ONLY per user directive
  // 2026-07-15): load active Priority/BOLO topics ONCE per ingest pass.
  // Priority topics nudge MACHINE scores up (after the deterministic caps,
  // below); BOLO topics rescue keyword-matched items the relevance gate would
  // drop (bounded budget). Fail-closed: flag off, load failure, or no topics
  // => empty list => zero behavior change. This is the ONLY lane where
  // steering fires — main-feed call sites are hard-disabled via
  // isMainFeedWatchSteeringEnabled(). Nothing here writes outside the curated
  // store, so lane isolation is intact.
  let watchTopics: CompiledWatchTopic[] = [];
  const watchRescueBudget = createRescueBudget();
  if (isWatchTopicSteeringEnabled()) {
    try {
      watchTopics = await loadActiveWatchTopics();
      if (watchTopics.length > 0) {
        console.log(`[CuratedIntake:${opts.label}] Watch-topic steering active: ${watchTopics.length} topic(s)`);
      }
    } catch (err) {
      console.error('[CuratedIntake] Failed to load watch topics (steering skipped this pass):', (err as Error).message);
    }
  }

  // Batched dedup corpus (Task #1105). The per-item getSimilarCuratedItems +
  // getSimilarCuratedItemsForOutlet reads each pulled the whole store window
  // over the Neon serverless driver per candidate (~275 ms/item) — that DB
  // round-trip cost, not the AI gate, is what plateaued the RSS backlog at
  // ~300-350 deferrals per pass. Load the lean identity corpus ONCE per admit
  // call and run the identical similarity math in memory (same >0.85 bar,
  // same top-5 cross-outlet slice, same 12h same-outlet re-emit window).
  // Freshly-inserted rows are appended to the corpus so later items in the
  // SAME batch still dedup against them, exactly as the per-item DB reads did.
  type DedupRow = { url: string; source: string; normalizedTitle: string; scrapedAt: Date };
  const dedupCorpus: DedupRow[] = fresh.length > 0
    ? await withCuratedTimeout(
        storage.getCuratedDedupCorpus(CURATED_WINDOW_HOURS),
        CURATED_DB_TIMEOUT_MS,
        'getCuratedDedupCorpus',
      )
    : [];

  let ingested = 0;
  const overlayRows: InsertCuratedClassification[] = [];
  // Task #336: off-list topics the gate analyzer wanted to add → human-gated log.
  const overlayProposals: Array<{ kind: string; proposedLabel: string; sampleTitle: string }> = [];
  // Rows eligible for inline pre-enrichment (Task #202): reuse-mode rows that
  // arrived WITH a real (non-favicon) photo + text. Collected here, then the
  // top-priority slice is enriched inline after the insert loop (bounded).
  const inlineQueue: { id: string; title: string; image: string; text: string; priority: number }[] = [];
  // Freshly-admitted hard-blocked (Bloomberg/Reuters) row ids (Task #644):
  // collected regardless of mode/enrichInline — unlike the inline-bullets path
  // above, these rows arrive with NO photo and NO usable text (gate-mode wire
  // headlines), so they can't be pre-enriched from data already in hand. They
  // still need the full paywall-breaker chain, which is expensive, so it runs
  // in a bounded, mutex-guarded background pass (enrichFreshHardBlockedCurated)
  // fired once after the insert loop instead of blocking every ingest cycle.
  const freshHardBlockedIds: string[] = [];
  let processed = 0;
  // Gate mode: process verdict-bearing items FIRST (stable partition) so the
  // reserved insert window converts analyzed items into rows; unscored items
  // (which would only be skipped as 'gate-unscored') take the deferral slots.
  let insertOrder: CuratedIntakeCandidate[];
  let reuseStartCursor = 0;
  if (opts.mode === 'gate') {
    insertOrder = [...fresh.filter(c => analysisByTitle.has(c.title)), ...fresh.filter(c => !analysisByTitle.has(c.title))];
  } else {
    // Reuse-mode rotation (Task #1106): start where the previous pass for this
    // label left off, so a slice-deferred tail is never the SAME items every
    // pass (mirrors curatedFeedCursor for RSS feeds).
    reuseStartCursor = fresh.length > 0 ? (reuseInsertCursors.get(opts.label) ?? 0) % fresh.length : 0;
    insertOrder = [...fresh.slice(reuseStartCursor), ...fresh.slice(0, reuseStartCursor)];
  }
  for (const c of insertOrder) {
    // Stop queueing new inserts / DB lookups once the outer timeout has fired.
    throwIfAborted(opts.signal, `admitCuratedCandidates:${opts.label}`);
    // Soft-deadline graceful stop: defer the remaining items to the next pass
    // (URL-dedup makes reprocessing idempotent) rather than grind past budget.
    if (isPastDeadline(opts.deadlineMs)) {
      console.log(`[CuratedIntake:${opts.label}] Soft deadline reached — deferring ${fresh.length - processed} remaining item(s) to next pass`);
      break;
    }
    processed++;
    if (processed % CURATED_YIELD_CHUNK === 0) await yieldToEventLoop();
    let category = c.category || 'general';
    let region: string | null = null;
    let country: string | null = null;
    let summary = c.summary || '';
    let priorityScore = c.priorityScore ?? 50;
    // Safe score provenance at admission: absence means this path must derive a
    // machine score (gate analyzer or reuse baseline); presence means an upstream
    // caller deliberately supplied the value. Numeric magnitude alone is never
    // used to guess provenance.
    const isMachineAuthoredPriority = c.priorityScore == null;
    let tags = c.tags ?? [];
    const steeringCanonicalUrl = normalizeIdentityUrl(c.url);
    let boloTopicIds: string[] = [];
    let boloRescueAttempted = false;
    let boloRescueUsed = false;
    let boloBudgetBlocked = false;
    // Task #336: structured classification object (gate mode only — reuse mode
    // has no analyzer, so the overlay backfill cron classifies it later).
    let gateAnalysis: CuratedAnalysisResult | undefined;

    if (opts.mode === 'gate') {
      const analysis = analysisByTitle.get(c.title);
      // Fail-closed on the gate too, but attribute the two distinct causes
      // separately (Task #403): 'gate-unscored' = the analyzer returned no row
      // for this title (chunk truncation / title-unmatched), 'relevance-rejected'
      // = the analyzer scored it and judged it off-topic. A whole source showing
      // 'gate-unscored' points at an analyzer/chunking problem, whereas
      // 'relevance-rejected' is the gate working as intended.
      if (!analysis) { skipped++; bump(c.source, 'gate-unscored'); continue; }
      // BOLO watch rescue (curated-only): a headline the analyzer judged
      // off-topic is still admitted when it keyword-matches an active BOLO
      // watch topic, bounded by the per-pass rescue budget so one noisy topic
      // can never flood the lane. Only relevance-rejected items are eligible —
      // 'gate-unscored' stays a hard skip (no classification at all).
      let boloRescued = false;
      if (!analysis.is_relevant) {
        boloTopicIds = watchTopics.length > 0 ? matchWatchTopics(watchTopics, c.title).boloTopicIds : [];
        boloRescueAttempted = boloTopicIds.length > 0;
        if (boloTopicIds.length > 0 && watchRescueBudget.consume(boloTopicIds)) {
          boloRescued = true;
          boloRescueUsed = true;
          console.log(`[WatchTopicMatcher] BOLO rescue (curated) kept: "${(c.title || '').substring(0, 80)}"`);
        } else {
          boloBudgetBlocked = boloTopicIds.length > 0;
          // Rejected BOLO attempts are still steering decisions. Record exact
          // identity + budget outcome, but never fabricate a later attribution.
          for (const topicId of boloTopicIds) {
            storage.recordWatchTopicMatch({
              topicId, baseScore: c.priorityScore ?? analysis.priority_score ?? 50,
              boostedScore: c.priorityScore ?? analysis.priority_score ?? 50,
              canonicalUrl: steeringCanonicalUrl, steeringKind: 'bolo', intakeMode: 'gate',
              boloRescueAttempted: true, boloRescueUsed: false, boloBudgetBlocked: true,
              usImplicationApplied: false,
              eventKey: `${steeringCanonicalUrl}|${topicId}|bolo|blocked`,
            }).catch((err) => console.warn('[WatchTopicMatcher] Telemetry write (BOLO blocked) failed (non-fatal):', err?.message));
          }
          skipped++; bump(c.source, 'relevance-rejected'); continue;
        }
      }
      gateAnalysis = analysis;
      category = analysis.category || category;
      region = analysis.region ?? null;
      country = analysis.country ?? null;
      summary = c.summary || analysis.reason || '';
      priorityScore = c.priorityScore ?? analysis.priority_score ?? 50;
      tags = analysis.tags ?? tags;
      // Rescued items carry a 'Watch' tag so editors can see WHY an
      // off-relevance item is in the lane (mirrors the main-feed convention).
      if (boloRescued) tags = Array.from(new Set([...tags, 'Watch']));
    }

    // Yahoo News de-syndication (Task #1057). Yahoo is an aggregator: its items
    // originate at AP/Reuters/etc. but the URL domain is yahoo.com. Before we
    // resolve the outlet, inspect the article's page meta/JSON-LD for the REAL
    // publisher and re-attribute to it, so an item legitimately sourced from a
    // corroborating wire counts toward story formation instead of being pinned to
    // the attach-only "Yahoo News" fallback. The Yahoo registry entry is only
    // used when the real publisher can't be determined. Fail-open: any error
    // leaves the source as-is (resolves to Yahoo News downstream). Curated-lane
    // only.
    if (isYahooSyndicationUrl(c.url)) {
      const resolved = await resolveYahooSyndicatedPublisher(c.url, outletIndex, {
        timeoutMs: opts.deadlineMs ? 8000 : 10000,
      });
      if (resolved.outlet) {
        console.log(
          `[CuratedIntake:${opts.label}] Yahoo de-syndication: "${c.source}" -> "${resolved.outlet.canonicalName}" (detected "${resolved.publisherName}")`,
        );
        c.source = resolved.outlet.canonicalName;
      } else if (resolved.publisherName) {
        // Detected a publisher name that doesn't map to any registered outlet —
        // still better than "Yahoo": attribute to the raw detected name so the
        // downstream registry lookup / display isn't the aggregator.
        console.log(
          `[CuratedIntake:${opts.label}] Yahoo de-syndication (unregistered): "${c.source}" -> "${resolved.publisherName}"`,
        );
        c.source = resolved.publisherName;
      }
    }

    // Behavior class from registry (single source of truth). Unknown outlets
    // derive to attach-only (fail-closed). Blocked outlets are hard-excluded —
    // they never enter the curated store at all. Resolved BEFORE the fuzzy de-dupe
    // so the de-dupe can be trust-aware (Task #403).
    const outlet = findOutlet(outletIndex, c.source, c.url);
    const behavior = outlet
      ? deriveOutletBehavior(outlet)
      : deriveOutletBehavior({ factuality: null });
    if (behavior.blocked) {
      skipped++; bump(c.source, 'blocked');
      if (opts.mode === 'reuse') cacheReuseSkip(c.url, 'blocked');
      continue;
    }

    // Editor-feedback LEARNING LOOP (Task #659) learned irrelevance-suppression
    // enforcement RETIRED (Task #1180). Legacy aggregate learned rules are no
    // longer enforced in the curated ingest hot path, so no candidate is ever
    // rejected on a standing outlet×category suppression rule. Direct human
    // overlays and outlet roles are unaffected.

    // Same-article-only fuzzy title de-dupe within the curated store (Task #602):
    // collapse a near-dupe ONLY when it is the SAME article (same URL identity, or
    // the same outlet re-emitting it); admit independent outlets' near-dupes so
    // clustering corroborates them. See isSameArticleDuplicate above for the why.
    //
    // Task #708: Run both similarity queries in parallel — the cross-outlet
    // similarity-ranked window (top-5) AND an unbounded same-outlet pass — so a
    // same-outlet re-emit at a different URL is never crowded out of the dedup
    // window when a busy event already has many near-identical headlines from other
    // outlets. The two result sets are merged (union by URL) before the check.
    const normalizedTitle = normalizeTitle(c.title);
    const candOutlet = outlet?.canonicalName ?? c.source;
    // Task #1105: both similarity passes now run IN MEMORY against the
    // once-per-pass corpus snapshot — zero DB round-trips per candidate. Same
    // decision surface as before: cross-outlet = top-5 by similarity across the
    // full 48h window; same-outlet = every match within the 12h re-emit window
    // (Task #718), unioned by URL before isSameArticleDuplicate.
    const reemitCutoffMs = Date.now() - CURATED_OUTLET_REEMIT_WINDOW_HOURS * 60 * 60 * 1000;
    const scoredMatches: Array<{ row: DedupRow; sim: number }> = [];
    const sameOutletSimilar: DedupRow[] = [];
    for (const row of dedupCorpus) {
      const sim = titleSimilarityAbove(row.normalizedTitle, normalizedTitle, 0.85);
      if (sim === 0) continue;
      scoredMatches.push({ row, sim });
      if (
        row.source === candOutlet &&
        (row.scrapedAt instanceof Date ? row.scrapedAt.getTime() : new Date(row.scrapedAt as any).getTime()) >= reemitCutoffMs
      ) {
        sameOutletSimilar.push(row);
      }
    }
    scoredMatches.sort((a, b) => b.sim - a.sim);
    const similar = scoredMatches.slice(0, 5).map(x => x.row);
    // Merge: union by URL so rows appearing in both sets are included once.
    const seenSimilarUrls = new Set(similar.map(s => s.url));
    const merged = [
      ...similar,
      ...sameOutletSimilar.filter(s => !seenSimilarUrls.has(s.url)),
    ];
    if (merged.length > 0) {
      if (isSameArticleDuplicate(c.url, candOutlet, merged)) {
        skipped++; bump(c.source, 'fuzzy-dup');
        if (opts.mode === 'reuse') cacheReuseSkip(c.url, 'fuzzy-dup');
        continue;
      }
      // else: near-dupe(s) only from OTHER outlets → admit as a separate node so
      // downstream clustering merges them into one corroborated story.
    }

    // Bound to a plausible range (Task #653): candidate pubDate comes from
    // several upstream sources (RSS pubDate, Meltwater, submission
    // publishedAt) — none re-scrape article HTML meta tags here, so this is
    // not where the "updated tag mistaken for publish" bug enters, but a
    // malformed/future-dated upstream value must still never stamp a
    // misleading fresh date. Even a small future skew is rejected: first-seen
    // is the honest fallback and downstream workers must never see a negative
    // age. Anything implausible collapses to null, which the curated view then
    // honestly renders as "First seen".
    const pubCandidate = c.pubDate ? new Date(c.pubDate) : null;
    const pub =
      pubCandidate && !isNaN(pubCandidate.getTime()) &&
      pubCandidate.getFullYear() > 2000 &&
      pubCandidate.getTime() <= Date.now()
        ? pubCandidate
        : null;
    // Reuse-mode baseline (Task #248): items admitted without a second LLM call
    // and WITHOUT an upstream score previously all defaulted to a flat 50, so they
    // tied in the clustering candidate pool. Derive a differentiated baseline from
    // the outlet's registry role + recency instead. Gate-mode scores (from the
    // analyzer) and any real upstream score (a team-page priority) are untouched.
    if (opts.mode !== 'gate' && isMachineAuthoredPriority) {
      priorityScore = deriveReuseBaselinePriority(behavior.role, pub, c.url, c.scrapedAt ?? null);
    }
    // Deterministic soft-politics safety cap (Task #262). Curated-lane ONLY,
    // cap-only: a clearly-soft item (tourism / PR / branding / routine
    // appointment) that landed in a high band is pulled back into the low band.
    // Applied to gate-mode (analyzer) scores AND machine-derived reuse baselines,
    // but NEVER to a real human-set upstream score (a team-page priority that
    // arrived with the candidate) — that is left untouched, as are curated pins
    // (a separate table, never written here). Genuine statecraft / defense
    // leadership is protected by the strategic guard inside the helper.
    if (isMachineAuthoredPriority) {
      const capped = evalCuratedSoftCap(c.title, category, priorityScore);
      if (capped.reason) {
        console.log(
          `[SCORE:CAP] lane=curated rule=${capped.reason} ${priorityScore}->${capped.score} src=${c.source} :: "${(c.title || '').substring(0, 80)}"`,
        );
      }
      priorityScore = capped.score;
    }
    // Domestic-crime / partisan-politics score cap ≤60 (Task #1027). Editors
    // repeatedly down-pinned crime-trial narratives and purely partisan rhetoric
    // that the gate analyzer had scored 61–74. These belong at most in the
    // Low-Strategic tier (50–60). CURATED_STRATEGIC_GUARD fires inside the
    // helper — NG deployments, terror investigations, and any story with a
    // national-security anchor are left untouched. CAP-ONLY, machine-score
    // only, curated-lane ONLY.
    if (isMachineAuthoredPriority) {
      const capped = evalCuratedDomesticCrimeCap(c.title, priorityScore);
      if (capped.reason) {
        console.log(
          `[SCORE:CAP] lane=curated rule=${capped.reason} ${priorityScore}->${capped.score} src=${c.source} :: "${(c.title || '').substring(0, 80)}"`,
        );
      }
      priorityScore = capped.score;
    }
    // Capability-feature temper cap (Task #480 lever 2). Curated-lane ONLY,
    // cap-only. Runs right after the soft cap, on GATE-mode ANALYZER scores only
    // (c.priorityScore == null → the score is the analyzer's, never a real
    // human/upstream score, and never a reuse baseline): a capability SHOWCASE or
    // trend FEATURE the analyzer over-scored into the top band is pulled to
    // CURATED_CAPABILITY_CAP so discrete strategic EVENTS out-rank "look at our
    // new hardware" / "future of warfare" pieces. Unlike the soft cap this
    // deliberately fires ON defense vocab (which the soft cap's strategic guard
    // exempts), but ONLY on feature framing with NO event verb, so a real strike
    // is never tempered.
    if (opts.mode === 'gate' && isMachineAuthoredPriority) {
      const tempered = evalCuratedCapabilityCap(c.title, priorityScore);
      if (tempered.reason) {
        console.log(
          `[SCORE:CAP] lane=curated rule=${tempered.reason} ${priorityScore}->${tempered.score} src=${c.source} :: "${(c.title || '').substring(0, 80)}"`,
        );
      }
      priorityScore = tempered.score;
    }
    // Analysis / opinion / explainer score cap (2026-07-14). Editors repeatedly
    // down-pinned analysis/commentary pieces the gate analyzer had scored 72-85.
    // URL-detectable opinion/analysis/explainer/live-blog items are capped to
    // CURATED_ANALYSIS_OPINION_CAP so discrete breaking events reliably out-rank
    // them. Same guard as the soft cap (gate + machine-derived baselines), never
    // human-set upstream scores. CAP-ONLY, curated-lane ONLY.
    if (isMachineAuthoredPriority) {
      const capped = evalCuratedAnalysisOpinionCap(c.url, priorityScore);
      if (capped.reason) {
        console.log(
          `[SCORE:CAP] lane=curated rule=${capped.reason} ${priorityScore}->${capped.score} src=${c.source} :: "${(c.title || '').substring(0, 80)}"`,
        );
      }
      priorityScore = capped.score;
    }
    // Approved LEARNED scoring cap (Task #678) enforcement RETIRED (Task #1180).
    // Legacy aggregate learned outlet×category scoring caps are no longer
    // enforced in the curated ingest hot path — priorityScore is left as
    // computed by the deterministic caps above. Direct human overlays and
    // outlet roles are unaffected.
    // Priority-watch boost (Task #884 — CURATED-ONLY per user directive
    // 2026-07-15). A headline matching an active Priority watch topic's
    // keyword gate gets a bounded upward nudge (floor 66 / cap 85, never
    // lowers). Applied AFTER the deterministic caps so an explicit human
    // watch wins over generic tempering, but with the SAME human-score guard
    // as the caps: only gate-mode analyzer scores and machine-derived reuse
    // baselines are ever touched — a real human/upstream score is sacred.
    // Same log format as the main-feed site so prod verification greps one line.
    let protectedMachineFloor = 1;
    if (watchTopics.length > 0 && isMachineAuthoredPriority) {
      const wm = matchWatchTopics(watchTopics, c.title);
      const baseScore = priorityScore; // capture BEFORE any reassignment
      // --- Priority topics: apply boost and record telemetry ---
      if (wm.priorityTopicIds.length > 0) {
        const matchedPriorityTopics = watchTopics.filter(t => t.isPriorityWatch && wm.priorityTopicIds.includes(t.id));
        // Preserve the explicit editorial floor while allowing the final
        // machine-only URL spread to break ties above it.
        for (const t of matchedPriorityTopics) {
          protectedMachineFloor = Math.max(
            protectedMachineFloor,
            t.boostStrength === 'strong' ? 72 : t.boostStrength === 'weak' ? 60 : 66,
          );
        }
        let bestBoosted = baseScore;
        for (const t of matchedPriorityTopics) {
          const candidate = applyPriorityBoostWithStrength(baseScore, (t.boostStrength ?? 'standard') as 'weak' | 'standard' | 'strong');
          if (candidate > bestBoosted) bestBoosted = candidate;
        }
        if (bestBoosted !== baseScore) {
          console.log(`[WatchTopicMatcher] Priority boost ${baseScore}->${bestBoosted} (${matchedPriorityTopics.length} topic(s) matched): "${(c.title || '').substring(0, 80)}"`);
          priorityScore = bestBoosted;
        }
        for (const t of matchedPriorityTopics) {
          const boostedForTopic = applyPriorityBoostWithStrength(baseScore, (t.boostStrength ?? 'standard') as 'weak' | 'standard' | 'strong');
          storage.recordWatchTopicMatch({
            topicId: t.id, baseScore, boostedScore: boostedForTopic,
            canonicalUrl: steeringCanonicalUrl, steeringKind: 'priority',
            boostStrength: t.boostStrength, intakeMode: opts.mode,
            boloRescueAttempted, boloRescueUsed, boloBudgetBlocked,
            usImplicationApplied: false,
            eventKey: `${steeringCanonicalUrl}|${t.id}|priority|${opts.mode}|${baseScore}|${boostedForTopic}`,
          })
            .catch((err) => console.warn('[WatchTopicMatcher] Telemetry write (priority) failed (non-fatal):', err?.message));
        }
      }
      // --- BOLO-only topics: record telemetry (no score boost for BOLO) ---
      const boloOnlyIds = wm.boloTopicIds.filter(id => !wm.priorityTopicIds.includes(id));
      if (boloOnlyIds.length > 0) {
        const matchedBoloTopics = watchTopics.filter(t => boloOnlyIds.includes(t.id));
        for (const t of matchedBoloTopics) {
          storage.recordWatchTopicMatch({
            topicId: t.id, baseScore, boostedScore: baseScore,
            canonicalUrl: steeringCanonicalUrl, steeringKind: 'bolo',
            intakeMode: opts.mode, boloRescueAttempted, boloRescueUsed, boloBudgetBlocked,
            usImplicationApplied: false,
            eventKey: `${steeringCanonicalUrl}|${t.id}|bolo|${opts.mode}|${boloRescueUsed ? 'used' : 'matched'}`,
          })
            .catch((err) => console.warn('[WatchTopicMatcher] Telemetry write (BOLO) failed (non-fatal):', err?.message));
        }
      }
    }
    // A narrow comparison nudge for already-admitted machine-scored conflict
    // reporting. Applied after all deterministic caps and before no other lane
    // can observe it; it cannot rescue an analyzer reject or touch human scores.
    if (isMachineAuthoredPriority) {
      const usTieBreak = evalCuratedDirectUsImplicationTieBreak(c.title, summary, priorityScore);
      if (usTieBreak.applied) {
        const baseScore = priorityScore;
        priorityScore = usTieBreak.score;
        console.log(`[SCORE:US-IMPLICATION] lane=curated ${baseScore}->${priorityScore} src=${c.source} :: "${(c.title || '').substring(0, 80)}"`);
        storage.recordWatchTopicMatch({
          topicId: '__us_implication__', baseScore, boostedScore: priorityScore,
          canonicalUrl: steeringCanonicalUrl, steeringKind: 'us-implication',
          intakeMode: opts.mode, boloRescueAttempted, boloRescueUsed, boloBudgetBlocked,
          usImplicationApplied: true, usImplicationReason: usTieBreak.reason,
          eventKey: `${steeringCanonicalUrl}|__us_implication__|${opts.mode}|${baseScore}|${priorityScore}`,
        }).catch((err) => console.warn('[WatchTopicMatcher] Telemetry write (U.S. implication) failed (non-fatal):', err?.message));
      }
    }
    // Final machine-score boundary: catches plateaus reintroduced by independent
    // gate batches, watch floors, and reuse/social paths. Human/upstream scores
    // are identified by the candidate carrying priorityScore and remain exact.
    if (isMachineAuthoredPriority) {
      priorityScore = spreadMachineCuratedPriority(priorityScore, c.url, protectedMachineFloor);
    }
    const insert: InsertCuratedItem = {
      title: c.title,
      url: c.url,
      // Content-based classification (subject + geography of the STORY, never
      // the outlet's geography). country may be null → the curated view falls
      // back to showing the broader region.
      category,
      region,
      country,
      // Canonicalize the stored display name at ingest (Task #310). When the
      // outlet resolves in the registry, persist its canonical name so casing/
      // spelling variants ("CNBC"/"Cnbc", "POLITICO"/...) collapse to one outlet
      // for per-outlet counts and clustering corroboration. Fall back to the raw
      // provided source only for genuinely unregistered outlets. This is a
      // display/storage-name change only — admission and role are unaffected.
      source: outlet?.canonicalName ?? c.source,
      summary,
      summaryBullets: null,
      ogImageUrl: c.ogImageUrl ?? null,
      videoUrl: c.videoUrl ?? null,
      priorityScore,
      role: behavior.role,
      clusterId: null,
      articlePublishedAt: pub && !isNaN(pub.getTime()) ? pub : null,
      tags,
    };
    try {
      const stored = await storage.addCuratedItem(insert, normalizedTitle);
      // Mirror the classification into the URL-keyed overlay (the curated view's
      // single source of truth) when we actually have a content-based label —
      // reusing the analysis we already have, no extra LLM call. In 'reuse' mode
      // we have no geography, so the overlay backfill cron classifies it later.
      if (opts.mode === 'gate' && gateAnalysis) {
        // Write the FULL controlled-vocabulary object once (single source of
        // truth) — no extra LLM call, the gate analysis is already in hand. This
        // replaces the old partial category/region/country-only mirror so a
        // freshly gated row lands with its structured topic instead of waiting
        // for the backfill cron to upgrade it. legacyCategory stays null (that
        // column is reserved for the historical remap audit trail).
        overlayRows.push({
          url: c.url,
          category,
          region,
          country,
          primaryTopic: gateAnalysis.primaryTopic,
          scope: gateAnalysis.scope ?? null,
          conflictTrack: gateAnalysis.conflictTrack ?? null,
          countryPair: gateAnalysis.countryPair ?? null,
          proposedTopic: gateAnalysis.proposedTopic ?? null,
          // AI-generated label (Task #350) — eligible for the bounded re-check.
          provenance: 'ai',
        });
        if (gateAnalysis.proposedTopic) {
          overlayProposals.push({ kind: 'primary_topic', proposedLabel: gateAnalysis.proposedTopic, sampleTitle: c.title });
        }
      }
      // Inline pre-enrichment eligibility (Task #202): only when the caller asked
      // for it (team reuse) AND the row arrived with a REAL (non-favicon) photo.
      // Rows without a real photo are intentionally left untouched here so they
      // stay retryable (no favicon ever falsely stamped as enriched) and fall
      // through to the existing worker exactly as today.
      if (opts.enrichInline && stored?.id && c.ogImageUrl && !isFaviconUrl(c.ogImageUrl)) {
        inlineQueue.push({
          id: stored.id,
          title: c.title,
          image: c.ogImageUrl,
          // Prefer the full article body for bullet quality; fall back to the
          // submission summary. No new fetch — this is text we already hold.
          text: c.fullText || c.summary || '',
          priority: priorityScore,
        });
      }
      // Fast-path eligibility (Task #644): any freshly-admitted row from a
      // hard-blocked outlet, independent of mode/enrichInline — this is the
      // root-cause fix for gate-mode Bloomberg/Reuters rows that previously had
      // to wait for the next recurring prefetch/backfill cron.
      if (stored?.id && isHardBlockedOutlet(c.url)) {
        freshHardBlockedIds.push(stored.id);
      }
      ingested++;
      bumpIngested(c.source);
      // Keep the in-memory corpus current so later items in this same batch
      // dedup against the row we just inserted (matches the visibility the
      // old per-item DB reads had).
      dedupCorpus.push({
        url: c.url,
        source: insert.source,
        normalizedTitle,
        scrapedAt: new Date(),
      });
    } catch (error) {
      console.error(`[CuratedIntake:${opts.label}] Failed to store "${c.title}":`, (error as Error).message);
    }
  }
  // Attribute the never-reached tail as DEFERRED (Task #1114): the soft-deadline
  // break above postponed these items, it did not drop them. (`processed` is
  // incremented immediately after the deadline check, so `insertOrder.slice(processed)`
  // is exactly the set of items the loop never entered.)
  for (const c of insertOrder.slice(processed)) bumpDeferred(c.source);
  // Advance the reuse-mode rotation cursor past the items this pass actually
  // processed, so a slice-deferred tail resumes there next pass (Task #1106).
  if (opts.mode !== 'gate' && fresh.length > 0) {
    reuseInsertCursors.set(opts.label, (reuseStartCursor + processed) % fresh.length);
  }

  if (overlayRows.length) {
    try {
      // Classify-once + preserve human overrides (Task #336). A URL that already
      // carries a classification with a primary_topic was either gated before
      // (generate-once) or set by a reviewer in the manual-submission form; the
      // gate analyzer must NOT overwrite it. Legacy rows (category but null
      // primary_topic) are NOT skipped — they still get upgraded here.
      const existing = await storage.getCuratedClassificationsByUrls(
        overlayRows.map((r) => r.url),
      );
      const freshRows = overlayRows.filter((r) => {
        const prior = existing.get(r.url);
        return !(prior && prior.primaryTopic);
      });
      if (freshRows.length) {
        await storage.upsertCuratedClassifications(freshRows);
        // New/updated curated labels → clear the curated read cache (Task #336).
        invalidateCuratedReadCache();
      }
    } catch (error) {
      console.error(`[CuratedIntake:${opts.label}] Failed to upsert classification overlay:`, (error as Error).message);
    }
  }

  // Human-gated proposals log: record any off-list topic the gate analyzer
  // wanted to add (curated-lane only, never auto-promoted into the enum).
  for (const p of overlayProposals) {
    try {
      await storage.recordClassificationProposal(p);
    } catch (error) {
      console.error(`[CuratedIntake:${opts.label}] Failed to record topic proposal:`, (error as Error).message);
    }
  }

  // Inline pre-enrichment (Task #202). Generate summary bullets from text we
  // already hold and stamp the curated row enriched, so qualifying rows land on
  // the card fully formed instead of queueing for the rate-limited worker.
  // BOUNDED: only the top MAX_INLINE_ENRICH_PER_PASS rows by priority are
  // processed, with INLINE_ENRICH_CONCURRENCY in flight at once, so an ingest
  // pass can't fire dozens of sequential LLM calls or overrun its cron interval.
  // Every other eligible row simply falls through to the existing worker — it
  // already shows its carried image + summary text in the meantime.
  // Skip inline AI enrichment entirely under the curated-isolation harness
  // (Task #492): the harness's reuse-intake canary carries no photo (fast DB
  // path), so enrichment only exists to enrich OTHER live rows — which would make
  // unnecessary AI calls and mutate live data inside the gate. Skipping keeps the
  // harness fast and non-disruptive; production is unaffected (flag never set).
  if (opts.enrichInline && inlineQueue.length > 0 && !isCuratedAiHarnessStub()) {
    inlineQueue.sort((a, b) => b.priority - a.priority);
    const batch = inlineQueue.slice(0, MAX_INLINE_ENRICH_PER_PASS);
    let cursor = 0;
    let enrichedInline = 0;
    const runner = async () => {
      while (cursor < batch.length) {
        // Stop inline enrichment once the outer timeout has fired — don't queue
        // new AI/storage calls when the pass is already being torn down. Also
        // stop at the soft deadline: inline enrich is the most expensive AI work
        // in the pass, so past-budget it must defer to the next cron tick.
        if (opts.signal?.aborted || isPastDeadline(opts.deadlineMs)) break;
        const row = batch[cursor++];
        try {
          // Generate bullets from text we already hold (no new article fetch).
          // Returns [] when the text is too short — the row still gets stamped
          // with its real image and falls back to its summary text on the card.
          // Track refusal + failure reason (Task #14): a refusal or transient
          // AI failure must keep the row retryable instead of being stamped
          // done-with-no-bullets forever; the recorded reason explains any gap.
          const bulletsMeta: { refused?: boolean; reason?: import('./streamPrefetch').BulletsFailureReason } = {};
          const bullets = await generateSummaryBullets(
            row.title,
            row.text,
            bulletsMeta,
            // row.text is fullText || summary; passing it as the fallback too
            // lets short-but-substantive (>80 char) summaries still produce
            // best-effort bullets instead of failing the >200-char body gate.
            { mode: 'curated-evidence', fallbackText: row.text },
          );
          // Persist the image to object storage (no-op for already-persisted
          // /objects/ paths; rejects favicons). cacheCuratedItemMedia stamps
          // media_scraped_at ONLY when a real image survives, so an image that
          // fails to persist leaves the row retryable (back-off intact).
          const persisted = await persistImageToStorage(row.image);
          // Record provenance when the image was actually re-hosted from a
          // remote URL, so placeholder checks stay possible after re-hosting.
          const imageSourceUrl =
            persisted && persisted !== row.image && /^https?:\/\//i.test(row.image)
              ? row.image
              : null;
          await cacheCuratedItemMedia(
            row.id, persisted, bullets, undefined, [], !!bulletsMeta.refused,
            null, false, null, null, imageSourceUrl,
            bullets.length > 0 ? null : (bulletsMeta.reason ?? 'empty_output'),
          );
          enrichedInline++;
        } catch (error) {
          console.error(`[CuratedIntake:${opts.label}] Inline enrich failed for "${row.title.substring(0, 50)}":`, (error as Error).message);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(INLINE_ENRICH_CONCURRENCY, batch.length) }, runner),
    );
    if (enrichedInline > 0) {
      console.log(`[CuratedIntake:${opts.label}] Inline pre-enriched ${enrichedInline} row(s) (of ${inlineQueue.length} eligible)`);
    }
  }

  // Event-driven hard-blocked fast-path (Task #644). Fire-and-forget: do not
  // await, so a slow paywall2 breaker fetch never delays the ingest pass or
  // the caller's response. Best-effort — if the shared worker mutex is busy
  // this is a no-op (logged inside the helper) and the row is still reached by
  // the next priority-sorted recurring prefetch/backfill pass.
  if (freshHardBlockedIds.length > 0) {
    console.log(`[CuratedIntake:${opts.label}] Kicking off immediate enrichment for ${freshHardBlockedIds.length} fresh hard-blocked row(s)`);
    enrichFreshHardBlockedCurated(freshHardBlockedIds).catch((error) => {
      console.error(`[CuratedIntake:${opts.label}] Fresh hard-blocked enrichment failed (non-fatal):`, (error as Error).message);
    });
  }

  console.log(`[CuratedIntake:${opts.label}] Done — ingested ${ingested}, skipped ${skipped} (of ${candidates.length})`);
  await persistAdmissionTelemetry();
  // Self-healing automation (Task #430 follow-up, DORMANT by default): a freshly
  // ingested source may belong to an existing story. Request a cheap DETERMINISTIC
  // re-shape so it merges WITHOUT waiting for the next full cron pass. No-op unless
  // CURATED_AUTO_RESHAPE is enabled; debounced + routed through the single guard.
  if (ingested > 0) requestCuratedReshape('intake');
  return { ingested, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bypass-host attribution guard (Task #1114). Team members often submit
// archive/paywall-bypass links (archive.ph, web.archive.org, 12ft.io, …).
// Without a guard the stored curated `source` label degrades to the HOST
// ("Archive") — a junk one-off source that surfaces as unresolved in Coverage
// and can never match a registry outlet. When the REAL target URL is embedded
// in the bypass link (archive.ph/o/<id>/<url>, wayback /web/<ts>/<url>,
// 12ft.io/<url> or ?q=, …) we re-attribute the LABEL to the real publisher —
// registry canonical name when known, else the target hostname. Label-only:
// the stored/display URL stays the submitted bypass link (that is the point of
// submitting it), and short-code links with no embedded target keep their
// existing label (nothing to attribute from; never guess).
// Hostname-matched, never substring (SSRF-lesson hygiene), and attribution-only
// — this code never fetches anything.
const BYPASS_ATTRIBUTION_HOSTS = new Set([
  'archive.is', 'archive.ph', 'archive.today', 'archive.li', 'archive.md',
  'archive.vn', 'archive.fo', '12ft.io', '1ft.io', 'removepaywall.com',
  'outline.com', 'txtify.it', 'smry.ai', 'freedium.cfd',
]);
export function isBypassAttributionHost(urlStr: string | null | undefined): boolean {
  if (!urlStr) return false;
  try {
    const host = new URL(urlStr).hostname.toLowerCase().replace(/^www\./, '');
    return BYPASS_ATTRIBUTION_HOSTS.has(host)
      || host === 'archive.org' || host.endsWith('.archive.org')
      || host === 'webcache.googleusercontent.com';
  } catch {
    return false;
  }
}

// Labels that mean "attributed to the bypass host (or to nothing)" — the only
// labels we ever overwrite with a non-registry hostname fallback. A legitimate
// publisher label ("Wall Street Journal") is kept unless the registry itself
// resolves the embedded target to a canonical outlet.
const JUNK_BYPASS_LABELS = new Set([
  'archive', 'archive today', 'archive.today', 'archive.ph', 'archive.is',
  'archive.org', 'archive.md', 'archive.li', 'archive.vn', 'archive.fo',
  'wayback machine', 'wayback', 'web archive', 'internet archive',
  '12ft', '12ft.io', '1ft', '1ft.io', 'removepaywall', 'removepaywall.com',
  'remove paywall', 'outline', 'outline.com', 'txtify', 'smry', 'freedium',
  'webcache', 'google cache', 'team submission', 'news source',
  'unknown', 'unknown source',
]);
export function isJunkBypassLabel(name: string | null | undefined): boolean {
  if (!name) return true;
  return JUNK_BYPASS_LABELS.has(name.trim().toLowerCase());
}

function sanitizeBypassTarget(raw: string): string | null {
  try {
    const t = new URL(raw);
    if (t.protocol !== 'http:' && t.protocol !== 'https:') return null;
    // Never attribute to another bypass host (nested archive-of-archive links).
    if (isBypassAttributionHost(t.href)) return null;
    return t.href;
  } catch {
    return null;
  }
}

// Extract the real target URL embedded in a bypass link. Returns null when the
// link is a short code carrying no target. Tolerates percent-encoded targets
// and scheme slashes collapsed to a single one (https:/example.com) by an
// upstream URL normalizer.
export function extractBypassTargetUrl(urlStr: string): string | null {
  let u: URL;
  try { u = new URL(urlStr); } catch { return null; }
  if (!isBypassAttributionHost(urlStr)) return null;
  for (const p of ['url', 'q', 'u', 'target', 'link']) {
    const v = u.searchParams.get(p)?.trim();
    if (v && /^https?:\/\//i.test(v)) {
      const s = sanitizeBypassTarget(v);
      if (s) return s;
    }
  }
  const rest = `${u.pathname}${u.search}`;
  let m = rest.match(/https?:\/{1,2}[^\s"'<>]+/i);
  if (!m) {
    try {
      m = decodeURIComponent(rest).match(/https?:\/{1,2}[^\s"'<>]+/i);
    } catch {
      // Malformed percent-escapes — treat as no embedded URL.
    }
  }
  return m ? sanitizeBypassTarget(m[0].replace(/^(https?):\/+/i, '$1://')) : null;
}

// Resolve the label a bypass-hosted submission should carry. Returns null when
// no better attribution exists (caller keeps the current label).
export function resolveBypassAttribution(
  bypassUrl: string,
  currentLabel: string,
  outletIndex: ReturnType<typeof buildOutletIndex> | null,
): string | null {
  const target = extractBypassTargetUrl(bypassUrl);
  if (!target) return null;
  // Registry publisher wins outright — deterministic URL evidence beats any
  // upstream label (same principle as the Yahoo de-syndication resolver).
  const outlet = outletIndex ? findOutlet(outletIndex, null, target) : undefined;
  if (outlet) return outlet.canonicalName;
  // Unregistered target: only replace a JUNK label, and only with something
  // more honest — the real publisher's hostname.
  if (isJunkBypassLabel(currentLabel)) {
    try {
      return new URL(target).hostname.replace(/^www\./i, '');
    } catch {
      return null;
    }
  }
  return null;
}

// Team submissions (RSS-bot-screened + manually-submitted wires) — the
// highest-value curated intake. They already passed an upstream relevance bar
// and carry a priority score + summary, so they are admitted WITHOUT a second
// LLM call. Their lane role still comes from the registry (fail-closed
// attach-only for unknown / social sources), so a low-trust submission can only
// JOIN a formed story, never seed one.
export async function ingestTeamSubmissionsToCurated(signal?: AbortSignal, deadlineMs?: number): Promise<{ ingested: number; skipped: number }> {
  let subs;
  try {
    // Under the curated-isolation harness (Task #492) the intake makes NO AI
    // calls, but fuzzy-deduping the full MAX_TEAM_SUBMISSIONS backlog against the
    // large curated store is ~15s of DB work that needlessly inflates the fast
    // gate. The harness only needs its just-inserted (newest) canary to land to
    // exercise the reuse-intake side-effect, so cap the candidate set to a small
    // recent slice there. Prod is unaffected (the stub flag is never set).
    const maxSubs = isCuratedAiHarnessStub() ? 8 : MAX_TEAM_SUBMISSIONS;
    subs = await storage.getRecentTeamSubmissionsForCurated(TEAM_INTAKE_WINDOW_HOURS, maxSubs);
  } catch (error) {
    console.error('[CuratedIntake:team] Failed to load team submissions:', (error as Error).message);
    return { ingested: 0, skipped: 0 };
  }
  // Bypass-host attribution guard (Task #1114): resolve the real publisher for
  // archive/paywall-bypass submissions BEFORE the curated row is written, so
  // junk one-off "Archive" sources stop surfacing as unresolved in Coverage.
  // The registry index is only built when a submission actually needs it;
  // fail-open on any registry error (keep the submitted labels).
  let bypassOutletIndex: ReturnType<typeof buildOutletIndex> | null = null;
  if (subs.some((s) => isBypassAttributionHost(s.sourceUrl))) {
    try {
      bypassOutletIndex = buildOutletIndex(await storage.getOutletRegistry());
    } catch (error) {
      console.warn('[CuratedIntake:team] Registry unavailable for bypass attribution (non-fatal):', (error as Error).message);
    }
  }
  const candidates: CuratedIntakeCandidate[] = subs
    .filter(s => s.headline && s.sourceUrl && /^https?:\/\//i.test(s.sourceUrl))
    .map(s => {
      let source = s.sourceName || 'Team Submission';
      if (isBypassAttributionHost(s.sourceUrl)) {
        const resolved = resolveBypassAttribution(s.sourceUrl, source, bypassOutletIndex);
        if (resolved && resolved !== source) {
          console.log(`[CuratedIntake:team] Bypass-host re-attribution: "${source}" → "${resolved}" (${s.sourceUrl.slice(0, 80)})`);
          source = resolved;
        }
      }
      return {
      title: s.headline,
      url: s.sourceUrl,
      source,
      // Real publish date only. The old `?? s.createdAt` fallback stamped the
      // team-sub INGEST time into curated_items.article_published_at, which the
      // curated view rendered as a trusted "Published X ago" — making day-old
      // articles look minutes fresh (batch-identical timestamps across outlets).
      // NULL is honest: the view falls back to "First seen".
      pubDate: s.publishedAt ?? null,
      // Pass the real team-page score through untouched; when absent leave it
      // undefined so the reuse-mode baseline (role + recency) applies instead of
      // a flat 50 (Task #248).
      priorityScore: s.priorityScore ?? undefined,
      summary: s.summary || '',
      ogImageUrl: s.ogImageUrl ?? null,
      // Full article body (when present) drives higher-quality inline bullets;
      // generateSummaryBullets falls back to summary when this is absent.
      fullText: s.fullText ?? null,
      };
    });
  // enrichInline: team submissions ~91% arrive with a photo and ~96% with a
  // summary, so generate bullets + stamp them enriched at ingest (Task #202).
  return admitCuratedCandidates(candidates, { mode: 'reuse', label: 'team', enrichInline: true, signal, deadlineMs });
}

// Main-feed headline table → curated (parity bridge). The curated lane is meant
// to be a SUPERSET of the main feed: anything that reaches Classic/Visual should
// also be available in curated (curated additionally carries content that never
// reaches main). RSS feeds, team/bot submissions and social already funnel in,
// but the shared `headlines` table did not — Warfighter RSS (active in prod) and
// the Drudge scraper write straight to it, so those main-feed items never
// reached curated. This closes that gap.
//
// Admitted WITHOUT a second LLM relevance call (mode 'reuse'): these already
// cleared the main-feed bar and the parity intent is that curated must NOT
// re-drop a main-feed item. The lane TIER still comes from the Outlet Registry
// (fail-closed attach-only for unknown sources), the deterministic finance /
// soft-politics caps + URL/title dedup still apply, and geography/topic are
// classified later by the overlay backfill cron; media is filled by the curated
// prefetch/backfill (same as the RSS/social intake). Curated-lane only — reads
// the shared headlines table but writes ONLY to curated_items, so the curated
// isolation guarantee (curated never crosses into headlines / Classic / Visual /
// custom-MCOP / public API) is unaffected.
export async function ingestHeadlinesToCurated(signal?: AbortSignal, deadlineMs?: number): Promise<{ ingested: number; skipped: number }> {
  let rows;
  try {
    rows = await storage.getRecentHeadlinesForCurated(HEADLINES_INTAKE_WINDOW_HOURS, MAX_HEADLINES_FOR_CURATED);
  } catch (error) {
    console.error('[CuratedIntake:headlines] Failed to load headlines:', (error as Error).message);
    return { ingested: 0, skipped: 0 };
  }
  const candidates: CuratedIntakeCandidate[] = rows
    .filter(h => h.title && h.url && /^https?:\/\//i.test(h.url))
    .map(h => ({
      title: h.title,
      url: h.url,
      source: h.source,
      // Real publish date only — same honesty rule as the team-sub intake
      // above: never let scrapedAt masquerade as a trusted "Published" stamp.
      pubDate: h.articlePublishedAt ?? null,
      // Pass the real main-feed score through (admin override wins); when 0/absent
      // the reuse-mode baseline (role + recency) applies instead.
      priorityScore: (h.priorityOverride ?? h.priorityScore) || undefined,
      summary: h.summary || '',
      ogImageUrl: h.ogImageUrl ?? null,
    }));
  return admitCuratedCandidates(candidates, { mode: 'reuse', label: 'headlines', signal, deadlineMs });
}

// Social/flash intake (Task #138) — recent X posts, Truth Social posts, and
// DataMinr First Alerts admitted into the isolated curated store so they can
// participate in clustering. Like team intake they are admitted WITHOUT a second
// LLM call (mode 'reuse'); geography is classified later by the overlay backfill
// cron. Trust tier is NOT decided here — it is re-derived live from the Outlet
// Registry by the cluster engine/read endpoint off each item's source+url:
//   - X posts carry their official-account handle as the source → resolves to
//     social-us-official → ATTACH (social media may JOIN a story of >=2 trusted
//     sources but never stands alone, anchors, counts toward formation, or
//     supplies the story's media).
//   - Truth Social posts carry "POTUS" → social-us-official → ATTACH (same rule).
//   - DataMinr First Alerts carry "DataMinr First Alert" → other → ATTACH
//     (may JOIN a formed story, never seeds or corroborates).
export async function ingestSocialFlashToCurated(signal?: AbortSignal, deadlineMs?: number): Promise<{ ingested: number; skipped: number }> {
  const candidates: CuratedIntakeCandidate[] = [];
  const addApproved = (
    lane: 'x-default' | 'osint' | 'journalist' | 'rapidresponse' | 'dowresponse' | 'sentdefender',
    handle: string,
    candidate: CuratedIntakeCandidate,
  ) => {
    if (!isApprovedCuratedAttachmentAccount(handle, lane)) return;
    candidates.push({ ...candidate, ogImageUrl: null });
  };

  // 1) Official US-government X posts (x_posts table holds only official accounts).
  try {
    const xp = await storage.getRecentXPostsForCurated(SOCIAL_INTAKE_WINDOW_HOURS, MAX_PER_SOCIAL_SOURCE);
    for (const p of xp) {
      if (!p.content || !p.xUrl || !/^https?:\/\//i.test(p.xUrl)) continue;
      addApproved('x-default', p.sourceAccount, {
        title: socialTitle(p.content),
        url: p.xUrl,
        // The exact scraper handle resolves to the official-account registry row.
        source: p.sourceAccount || 'SecWar',
        pubDate: p.postedAt ?? null,
        scrapedAt: p.scrapedAt ?? null,
        summary: cleanSocialPostText(p.content),
      });
    }
  } catch (error) {
    console.error('[CuratedIntake:social] Failed to load X posts:', (error as Error).message);
  }

  // 2) Truth Social posts (the POTUS feed).
  try {
    const ts = await storage.getRecentTruthSocialPostsForCurated(SOCIAL_INTAKE_WINDOW_HOURS, MAX_PER_SOCIAL_SOURCE);
    for (const p of ts) {
      if (!p.content || !p.truthSocialUrl || !/^https?:\/\//i.test(p.truthSocialUrl)) continue;
      candidates.push({
        title: socialTitle(p.content),
        url: p.truthSocialUrl,
        source: 'POTUS',
        pubDate: p.postedAt ?? null,
        scrapedAt: p.scrapedAt ?? null,
        summary: cleanSocialPostText(p.content),
        ogImageUrl: null,
        videoUrl: p.videoUrl ?? null,
      });
    }
  } catch (error) {
    console.error('[CuratedIntake:social] Failed to load Truth Social posts:', (error as Error).message);
  }

  // 3) DataMinr First Alerts (flash wire) — attach-only.
  try {
    const fa = await storage.getRecentFirstAlertsForCurated(SOCIAL_INTAKE_WINDOW_HOURS, MAX_PER_SOCIAL_SOURCE);
    for (const a of fa) {
      if (!a.headline || !a.url || !/^https?:\/\//i.test(a.url)) continue;
      candidates.push({
        title: cleanSocialPostText(a.headline) || a.headline,
        url: a.url,
        source: 'DataMinr First Alert',
        pubDate: a.publishedAt ?? null,
        scrapedAt: a.scrapedAt ?? null,
        summary: cleanSocialPostText(a.subHeadline || ''),
      });
    }
  } catch (error) {
    console.error('[CuratedIntake:social] Failed to load First Alerts:', (error as Error).message);
  }

  // 4) Combatant-command + OSINT-analyst posts (stored in osint_posts). These
  // appear in the curated U.S. X Feed and OSINT X Feed but previously had NO
  // curated_items row, so a manual-link to one of these posts could never grip
  // (the must-link rescue looks up nodes by URL). Ingesting them here (reuse
  // mode) gives each post a curated_items row keyed by its xUrl, so the
  // editor's attach-to-story link actually fires in the next clustering pass.
  // All are attach-only by registry role (fail-closed); they never seed, count
  // toward formation, anchor, or supply the story's representative/media.
  // Derived from the canonical social-account catalog (Task #1038): combatant
  // commands + WhiteHouse (curated U.S. X Feed, incl. legacy @INDOPACOM display
  // alias) followed by the OSINT analysts (curated OSINT X Feed). Edit the
  // roster in shared/socialAccountCatalog.ts.
  const SOCIAL_OSINT_ACCOUNTS = CATALOG_SOCIAL_OSINT_ACCOUNTS;
  const socialSince = new Date(Date.now() - SOCIAL_INTAKE_WINDOW_HOURS * 3_600_000);
  for (const acct of SOCIAL_OSINT_ACCOUNTS) {
    try {
      const posts = await storage.getCuratedOsintPosts(socialSince, MAX_PER_SOCIAL_SOURCE, acct);
      for (const p of posts) {
        if (!p.content || !p.xUrl || !/^https?:\/\//i.test(p.xUrl)) continue;
        addApproved('osint', p.sourceAccount, {
          title: socialTitle(p.content),
          url: p.xUrl,
          source: p.sourceAccount,
          pubDate: p.postedAt ?? null,
          scrapedAt: p.scrapedAt ?? null,
          summary: cleanSocialPostText(p.content),
          videoUrl: p.videoUrl ?? null,
        });
      }
    } catch (error) {
      console.error(`[CuratedIntake:social] Failed to load OSINT posts for ${acct}:`, (error as Error).message);
    }
  }

  // 5) Journalist posts — attach-only, curated-only table. Same rationale as
  // OSINT above: they previously had no curated_items row, so a manual-link
  // could not grip. Ingesting here gives them one.
  const SOCIAL_JOURNALIST_ACCOUNTS = CATALOG_CURATED_JOURNALIST_ACCOUNTS;
  for (const acct of SOCIAL_JOURNALIST_ACCOUNTS) {
    try {
      const posts = await storage.getCuratedJournalistPosts(socialSince, MAX_PER_SOCIAL_SOURCE, acct);
      for (const p of posts) {
        if (!p.content || !p.xUrl || !/^https?:\/\//i.test(p.xUrl)) continue;
        addApproved('journalist', p.sourceAccount, {
          title: socialTitle(p.content),
          url: p.xUrl,
          source: p.sourceAccount,
          pubDate: p.postedAt ?? null,
          scrapedAt: p.scrapedAt ?? null,
          summary: cleanSocialPostText(p.content),
          videoUrl: p.videoUrl ?? null,
        });
      }
    } catch (error) {
      console.error(`[CuratedIntake:social] Failed to load journalist posts for ${acct}:`, (error as Error).message);
    }
  }

  const dedicated = [
    { lane: 'rapidresponse' as const, handles: CATALOG_RAPIDRESPONSE_HANDLES, load: () => storage.getCuratedRapidResponsePosts(socialSince, MAX_PER_SOCIAL_SOURCE) },
    { lane: 'dowresponse' as const, handles: CATALOG_DOWRESPONSE_HANDLES, load: () => storage.getCuratedDOWResponsePosts(socialSince, MAX_PER_SOCIAL_SOURCE) },
    { lane: 'sentdefender' as const, handles: CATALOG_SENTDEFENDER_HANDLES, load: () => storage.getCuratedSentDefenderPosts(socialSince, MAX_PER_SOCIAL_SOURCE) },
  ];
  for (const d of dedicated) {
    for (const handle of d.handles) {
      try {
        for (const p of await d.load()) {
          if (!p.content || !p.xUrl || !/^https?:\/\//i.test(p.xUrl)) continue;
          addApproved(d.lane, handle, {
            title: socialTitle(p.content),
            url: p.xUrl,
            source: handle,
            pubDate: p.postedAt ?? null,
            scrapedAt: p.scrapedAt ?? null,
            summary: cleanSocialPostText(p.content),
            videoUrl: 'videoUrl' in p && typeof p.videoUrl === 'string' ? p.videoUrl : null,
          });
        }
      } catch (error) {
        console.error(`[CuratedIntake:social] Failed to load ${d.lane} posts for ${handle}:`, (error as Error).message);
      }
    }
  }

  return admitCuratedCandidates(candidates, { mode: 'reuse', label: 'social', signal, deadlineMs });
}

async function runCuratedIngestPass(signal: AbortSignal, deadlineMs: number): Promise<{ ingested: number; skipped: number }> {
  console.log('[CuratedIngest] Starting wide-aperture curated ingest...');

  // Per-stage deadline slices (stage-starvation fix + Task #1075 backlog-drain
  // reorder). deadlineMs is the OVERALL pass ceiling (passed from the soft-
  // deadline wrapper). The cheap reuse-mode stages (team/social/headlines) run
  // FIRST, each capped by its own slice counted from the actual pass start, so
  // they can never be starved. The RSS stage (AI gate, the heavy one) runs LAST
  // with an ADAPTIVE budget: everything left until the overall soft deadline —
  // typically ~110s when the cheap stages finish in seconds, vs the old fixed
  // 75s.
  const passStart = Date.now();
  // Each stage's slice is computed from the moment THAT stage starts (not from
  // passStart): stage deadlines are soft, so a prior stage can overrun its
  // slice (e.g. team inline enrichment), and cumulative-from-passStart slices
  // would then arrive already expired and silently defer the later cheap
  // stages. Every stage deadline is clamped to the OVERALL pass ceiling.
  const clamp = (dl: number) => Math.min(dl, deadlineMs);

  // Drop stale curated rows so the store stays a rolling window.
  await withCuratedTimeout(
    storage.clearOldCuratedItems(CURATED_WINDOW_HOURS),
    CURATED_DB_TIMEOUT_MS,
    'clearOldCuratedItems',
  );

  // Retention prune for editor content-kind marks (Task #892): a mark is bound
  // to the article that was live when the editor set it. Items age out of the
  // curated store at CURATED_WINDOW_HOURS, so an override untouched for 14 days
  // is definitionally stale — pruning it prevents the mark from silently
  // re-attaching to a NEW story that later reuses the same URL. Fail-soft:
  // pruning must never block the ingest pass.
  try {
    const pruned = await withCuratedTimeout(
      storage.pruneStaleCuratedContentKindOverrides(CONTENT_KIND_OVERRIDE_RETENTION_DAYS),
      CURATED_DB_TIMEOUT_MS,
      'pruneStaleContentKindOverrides',
    );
    if (pruned > 0) {
      console.log(`[CuratedIngest] Pruned ${pruned} stale content-kind override(s) (>${CONTENT_KIND_OVERRIDE_RETENTION_DAYS}d old)`);
    }
  } catch (e) {
    console.warn('[CuratedIngest] Content-kind override prune failed (non-fatal):', (e as Error).message);
  }

  let ingested = 0;
  let skipped = 0;

  // 1) Team submissions — already screened upstream, admitted without re-AI.
  // Runs FIRST within its own deadline slice so RSS can never starve it.
  throwIfAborted(signal, 'before-team');
  try {
    const teamDL = clamp(Date.now() + TEAM_STAGE_BUDGET_MS);
    if (isPastDeadline(teamDL)) {
      console.log(`[CuratedIngest] Stage 1/4 team: slice expired, deferring to next pass`);
    }
    const team = isPastDeadline(teamDL) ? { ingested: 0, skipped: 0 } : await ingestTeamSubmissionsToCurated(signal, teamDL);
    ingested += team.ingested;
    skipped += team.skipped;
    const teamElapsed = Math.round((Date.now() - passStart) / 1000);
    console.log(
      `[CuratedIngest] Stage 1/4 team: ingested=${team.ingested} skipped=${team.skipped} elapsed=${teamElapsed}s`,
    );
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    console.error('[CuratedIngest] Team-submission intake failed (non-fatal):', (error as Error).message);
  }

  // 2) Social/flash (Task #138) — X posts, Truth Social, DataMinr First Alerts,
  // admitted without re-AI; trust tier re-derived live from the registry.
  // Runs within its own deadline slice regardless of prior stage durations.
  throwIfAborted(signal, 'before-social');
  try {
    const socialDL = clamp(Date.now() + SOCIAL_STAGE_BUDGET_MS);
    if (isPastDeadline(socialDL)) {
      console.log(`[CuratedIngest] Stage 2/4 social: slice expired, deferring to next pass`);
    }
    const social = isPastDeadline(socialDL) ? { ingested: 0, skipped: 0 } : await ingestSocialFlashToCurated(signal, socialDL);
    ingested += social.ingested;
    skipped += social.skipped;
    const socialElapsed = Math.round((Date.now() - passStart) / 1000);
    console.log(
      `[CuratedIngest] Stage 2/4 social: ingested=${social.ingested} skipped=${social.skipped} elapsed=${socialElapsed}s`,
    );
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    console.error('[CuratedIngest] Social/flash intake failed (non-fatal):', (error as Error).message);
  }

  // 3) Main-feed headline table (parity bridge) — Warfighter RSS (active) +
  // Drudge (when enabled) + manual headline adds, admitted without re-AI so the
  // curated lane stays a SUPERSET of the main feed.
  // Runs within its own deadline slice regardless of prior stage durations.
  throwIfAborted(signal, 'before-headlines');
  try {
    const headlinesDL = clamp(Date.now() + HEADLINES_STAGE_BUDGET_MS);
    if (isPastDeadline(headlinesDL)) {
      console.log(`[CuratedIngest] Stage 3/4 headlines: slice expired, deferring to next pass`);
    }
    const headlinesIntake = isPastDeadline(headlinesDL) ? { ingested: 0, skipped: 0 } : await ingestHeadlinesToCurated(signal, headlinesDL);
    ingested += headlinesIntake.ingested;
    skipped += headlinesIntake.skipped;
    const headlinesElapsed = Math.round((Date.now() - passStart) / 1000);
    console.log(
      `[CuratedIngest] Stage 3/4 headlines: ingested=${headlinesIntake.ingested} skipped=${headlinesIntake.skipped} elapsed=${headlinesElapsed}s`,
    );
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    console.error('[CuratedIngest] Headline intake failed (non-fatal):', (error as Error).message);
  }

  // 4) Curated RSS feeds — the heavy stage (feed fetch + AI gate) runs LAST
  // with an ADAPTIVE budget: all remaining time up to the overall soft
  // deadline (Task #1075). Cheap stages already ran, so no starvation risk.
  throwIfAborted(signal, 'before-rss');
  const fetchStart = Date.now();
  const { candidates, feedStats } = await fetchCuratedFeeds(signal, deadlineMs);
  const fetchSecs = Math.round((Date.now() - fetchStart) / 1000);
  // Persist feed-fetch level stats (fetched/kept/aged/dupInPass) BEFORE running
  // admitCuratedCandidates.  mergeCuratedIntakeFeedStats resets all admission
  // counters to 0 on conflict, so it must run first to give admission a clean
  // slate.  admitCuratedCandidates then writes absolute per-source admission
  // totals via upsertCuratedIntakeTelemetry, which replaces (not increments)
  // the zeroed counters.  Fail-soft: a telemetry write error must never abort
  // the ingest pass.
  if (feedStats.size > 0) {
    await storage.mergeCuratedIntakeFeedStats(feedStats).catch((err) => {
      console.warn('[CuratedIngest] Failed to persist RSS feed stats (non-fatal):', (err as Error).message);
    });
  }
  let rssDeferredCount = 0;
  if (candidates.length > 0) {
    // Sort RSS candidates newest-first (backlog-convergence fix). When the RSS
    // admission deadline is hit mid-batch, the freshest items have already been
    // processed and the remainder are the oldest — which will age out of feeds
    // on their own anyway. This prevents the backlog from accumulating
    // perpetually-deferred stale items.
    const sortedCandidates = [...candidates].sort((a, b) => {
      const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta; // descending: newest first
    });
    const rssDeadlineHit = isPastDeadline(deadlineMs);
    let rss = { ingested: 0, skipped: 0 };
    if (rssDeadlineHit) {
      // Whole-stage deferral (Task #1114): the pass budget was consumed before
      // RSS admission could even start, so EVERY fetched candidate is deferred.
      // Persist per-source deferred counts so the zeroed-counter rows written
      // by mergeCuratedIntakeFeedStats above resolve to an honest "pending —
      // deferred to next pass" instead of reading as a final "admitted 0".
      const stageDeferred = new Map<string, number>();
      for (const c of sortedCandidates) {
        const key = c.source || '(unknown)';
        stageDeferred.set(key, (stageDeferred.get(key) || 0) + 1);
      }
      const now = new Date();
      await storage.upsertCuratedIntakeTelemetry(
        Array.from(stageDeferred.entries()).map(([sourceName, n]) => ({
          sourceName,
          lastLabel: 'rss',
          lastRunAt: now,
          ingested: 0,
          dropInvalid: 0,
          dropDupUrl: 0,
          dropDupBatch: 0,
          dropRelevanceRejected: 0,
          dropRelevanceFinance: 0,
          dropGateUnscored: 0,
          dropFuzzyDup: 0,
          dropBlocked: 0,
          deferred: n,
        })),
      ).catch((err) => {
        console.warn('[CuratedIngest] Failed to persist stage-deferral telemetry (non-fatal):', (err as Error).message);
      });
    } else {
      rss = await admitCuratedCandidates(
        sortedCandidates.map(c => ({ title: c.title, url: c.url, source: c.source, pubDate: c.pubDate })),
        { mode: 'gate', label: 'rss', signal, deadlineMs },
      );
    }
    ingested += rss.ingested;
    skipped += rss.skipped;
    const rssElapsed = Math.round((Date.now() - passStart) / 1000);
    rssDeferredCount = Math.max(0, candidates.length - rss.ingested - rss.skipped);
    console.log(
      `[CuratedIngest] Stage 4/4 RSS: ingested=${rss.ingested} skipped=${rss.skipped}` +
      (rssDeferredCount > 0 ? ` deferred≈${rssDeferredCount}` : '') +
      ` fetch=${fetchSecs}s elapsed=${rssElapsed}s`,
    );
  } else {
    console.log(`[CuratedIngest] Stage 4/4 RSS: no candidates fetched (fetch=${fetchSecs}s)`);
  }

  // Backlog drain guard (Task #1075): a persistently-high deferred count means
  // the RSS stage has stopped converging — warn loudly and surface it in the
  // intake telemetry table (synthetic "(rss-backlog)" row, read only by the
  // curated coverage endpoint) so it shows up without log spelunking.
  if (rssDeferredCount > RSS_BACKLOG_WARN_THRESHOLD) {
    rssBacklogConsecutiveHighPasses++;
    if (rssBacklogConsecutiveHighPasses >= RSS_BACKLOG_WARN_CONSECUTIVE) {
      console.warn(
        `[CuratedIngest] ⚠️ BACKLOG DRAIN GUARD: RSS stage deferred ~${rssDeferredCount} item(s) for ` +
        `${rssBacklogConsecutiveHighPasses} consecutive passes — intake is not converging`,
      );
      // `fetched` carries the deferred count; `kept` carries the consecutive-
      // pass streak (mergeCuratedIntakeFeedStats is the write path that updates
      // those two columns on conflict). Purely observability — read only by the
      // curated coverage endpoint, never by any feed path. admissionPending is
      // forced false: this synthetic row has no admission phase to wait for.
      await storage.mergeCuratedIntakeFeedStats(new Map([[
        '(rss-backlog)',
        { fetched: rssDeferredCount, kept: rssBacklogConsecutiveHighPasses, aged: 0, dupInPass: 0, admissionPending: false },
      ]])).catch((err) => {
        console.warn('[CuratedIngest] Drain-guard telemetry write failed (non-fatal):', (err as Error).message);
      });
    }
  } else {
    if (rssBacklogConsecutiveHighPasses >= RSS_BACKLOG_WARN_CONSECUTIVE) {
      // The guard had tripped (synthetic row written) and this pass converged —
      // zero the row once so the Coverage banner clears instead of showing a
      // stale warning forever (Task #1114). If a redeploy resets the in-memory
      // streak while a stale row lingers, the client's freshness window hides it.
      await storage.mergeCuratedIntakeFeedStats(new Map([[
        '(rss-backlog)',
        { fetched: 0, kept: 0, aged: 0, dupInPass: 0, admissionPending: false },
      ]])).catch((err) => {
        console.warn('[CuratedIngest] Drain-guard clear failed (non-fatal):', (err as Error).message);
      });
    }
    rssBacklogConsecutiveHighPasses = 0;
  }

  const totalElapsed = Math.round((Date.now() - passStart) / 1000);
  console.log(`[CuratedIngest] Done — ingested ${ingested}, skipped ${skipped}, elapsed ${totalElapsed}s`);
  return { ingested, skipped };
}

export async function runCuratedIngest(): Promise<{ ingested: number; skipped: number }> {
  if (isIngestRunning) {
    const elapsed = Date.now() - ingestStartedAt;
    if (elapsed < INGEST_MAX_DURATION_MS) {
      console.log('[CuratedIngest] Already running, skipping this pass');
      return { ingested: 0, skipped: 0 };
    }
    // The previous pass blew past the max duration without releasing the guard —
    // a never-settling await wedged it. Force-reset so ingest self-heals instead
    // of staying stuck until a redeploy.
    console.error(
      `[CuratedIngest] Previous pass stuck for ${Math.round(elapsed / 1000)}s — force-resetting wedged guard`,
    );
  }
  isIngestRunning = true;
  ingestStartedAt = Date.now();
  // Create an AbortController shared between the timeout wrapper and the pass.
  // When the hard timeout fires, it calls controller.abort() BEFORE rejecting
  // the outer promise, so every loop boundary inside the pass (per-feed, per-
  // item, inline enrichment) can detect the cancellation via signal.aborted
  // and stop queuing new AI / DB / network calls immediately — rather than
  // running on in the background and hammering shared resources.
  const controller = new AbortController();
  // SOFT deadline: caps how long this pass keeps STARTING new work before it
  // gracefully returns its partial counts (the 5-min cron drains the rest, and
  // URL-dedup makes that idempotent). Distinct from the hard timeout below,
  // which is a wedge backstop that throws AbortError.
  const deadlineMs = Date.now() + INGEST_SOFT_DEADLINE_MS;
  try {
    // Hard timeout so a hung await (stalled feed body / AI / DB call) can never
    // wedge ingest forever: the guard is always released by the finally below
    // within INGEST_MAX_DURATION_MS. controller is aborted before the reject so
    // the background pass drains without starting new work iterations.
    return await withCuratedTimeout(
      runCuratedIngestPass(controller.signal, deadlineMs),
      INGEST_MAX_DURATION_MS,
      'runCuratedIngest',
      controller,
    );
  } catch (error) {
    const isAbort = (error as Error).name === 'AbortError';
    if (!isAbort) {
      console.error('[CuratedIngest] Fatal error:', error);
    } else {
      console.warn('[CuratedIngest] Pass cancelled early by timeout signal — no new work will start');
    }
    return { ingested: 0, skipped: 0 };
  } finally {
    isIngestRunning = false;
  }
}

// -----------------------------------------------------------------------------
// One-time, idempotent backfill (Task #313). Task #310 fixed the going-forward
// root cause — new curated rows store the registry CANONICAL outlet name at
// ingest — but historical rows already in the store still carry pre-fix raw
// names ("Cnbc" vs "CNBC", differently-cased "POLITICO", …), so per-outlet
// counts and clustering corroboration stay fragmented for past data until those
// rows age out. This heals the existing data immediately by resolving each
// stored row through the SAME findOutlet path ingest uses and rewriting `source`
// to the canonical name when (and only when) the outlet resolves.
//
// Idempotent: already-canonical rows resolve to themselves and are skipped, so a
// rerun (every boot) is a no-op. Unregistered outlets are left untouched
// (findOutlet returns undefined). Curated-lane only — touches ONLY curated_items
// via storage.normalizeCuratedItemSources; never any shared feed, so the curated
// isolation guarantee is unaffected.
// -----------------------------------------------------------------------------
export async function normalizeCuratedSourceNames(): Promise<number> {
  try {
    const registry = await storage.getOutletRegistry();
    const outletIndex = buildOutletIndex(registry);
    const updated = await storage.normalizeCuratedItemSources((source, url) => {
      const outlet = findOutlet(outletIndex, source, url);
      return outlet?.canonicalName ?? null;
    });
    if (updated > 0) {
      console.log(`✅ [CuratedIngest] Normalized ${updated} curated row(s) to canonical outlet names`);
    }
    return updated;
  } catch (error) {
    console.error('[CuratedIngest] normalizeCuratedSourceNames error:', (error as Error).message);
    return 0;
  }
}
