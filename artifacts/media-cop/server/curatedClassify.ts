// =============================================================================
// Curated lane — CONTENT-BASED classification backfill. Populates the
// `curated_classifications` overlay (keyed by article URL) so the curated view's
// "Category · Country/Region" label reflects the ARTICLE CONTENT for EVERY
// displayed row — both the main-feed union rows (which only carry a broad legacy
// bucket) and legacy curated rows that predate per-item classification.
//
// This job READS the main feed only to learn which URLs/titles are on display;
// it writes ONLY to `curated_classifications`. It never mutates `headlines`, the
// public REST API, custom MCOPs, or Classic/Visual (fail-closed isolation).
// =============================================================================
import { storage, calculateCuratedDepreciatedPriority } from './storage';
import { analyzeCuratedBatch } from './aiAnalyzer';
import type { CuratedAnalysisResult } from './aiAnalyzer';
import { invalidateCuratedReadCache } from './curatedCacheBus';
import { isConfirmedCuratedMember } from './curatedCluster';

// Test-only seam: lets deterministic tests stub the LLM call without a network
// hit. Production always leaves this null (no behavioral difference).
let _classifyAnalyzeImpl: ((titles: string[]) => Promise<CuratedAnalysisResult[]>) | null = null;
export function __setClassifyAnalyzeForTest(
  fn: ((titles: string[]) => Promise<CuratedAnalysisResult[]>) | null,
): void {
  _classifyAnalyzeImpl = fn;
}
import { inferPersistablePrimaryTopic, OTHER_EMERGING } from '@shared/classificationVocab';
import type { InsertCuratedClassification } from '@shared/schema';

// Match the curated view's default display window + a small margin so anything
// that can surface gets classified before it's shown.
const WINDOW_HOURS = 24;
// Auto-size the classification candidate window to the RENDERED display set
// (Task #350). The editor Curated view can render up to VISIBLE_STORY_LIMIT
// stories drawn from a
// BLENDED union of the main feed + curated store, ranked by the SAME time-decayed
// score and given a corroboration boost. A displayed story can be a multi-member
// cluster, so the URL candidate set that maps onto the visible window is several
// times the story count. We therefore (a) MERGE both stores into one pool ranked
// by the decayed score the view uses, and (b) take the top CANDIDATE_WINDOW —
// sized to the display window × an avg-members factor plus a small margin. This
// replaces the old fixed, SEPARATE raw caps (80 feed / 120 curated): those keyed
// off RAW priority while the display keys off DECAY/blend, so the classified set
// diverged from what users see and on-screen rows went unclassified ("General").
// Total budget (~200 + recency) is unchanged vs. the old 80+120 — only its
// alignment to the display improves; the actual LLM spend is bounded by the
// per-pass MISSING set (content rotation), not by this window size.
// Must mirror the route's editor-only maximum (`/api/curated/top-stories`,
// clamped to 100). Public/default callers still request 40, but classification
// coverage and lag monitoring must include every card an editor can see.
const VISIBLE_STORY_LIMIT = 100;
const MEMBERS_PER_STORY = 4;    // generous avg members per displayed cluster
const CANDIDATE_MARGIN = 40;    // headroom just below the fold
// Keep the existing ranked baseline. The top 100 visible rows are fully
// contained in this 200-row slice; specialized recency, SCN, and cluster-member
// lanes may append high-value candidates beyond it, as before.
const CANDIDATE_WINDOW = 200;
// Recency fast-lane (Task #350): the newest items entering the window must get
// classified PROMPTLY even when their (pre-decay) priority ranks them below the
// fold, so a freshly-ingested card doesn't sit on "General" until it accrues
// rank. Add the N most-recently-scraped rows from the merged pool on top of the
// ranked window (deduped). classifyCuratedUrls already classifies missing URLs
// first, so a fresh row included here is picked up the very next pass.
const RECENCY_LANE = 30;
const BATCH = 25; // titles per analyzer call

// Re-classification of rows stuck on a generic label is gated by a cooldown so a
// genuinely-generic item isn't re-sent to the LLM on every cron tick, and bounded
// per pass so a backlog of generics can't blow the per-cycle LLM budget. The
// upsert refreshes classifiedAt, so a row that comes back generic again
// self-backs-off for the next full window.
//
// Two-tier cooldown + budget (Task #995): items actively on screen get a much
// shorter retry window and a dedicated sub-budget so a full display window of
// "Other / Emerging" cards can be serviced in ONE pass rather than trickling
// over many hours.
const RECLASSIFY_GENERIC_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h — off-screen items
const RECLASSIFY_ONSCREEN_COOLDOWN_MS = 30 * 60 * 1000;     // 30 min — on-screen items
// The full editor-visible set is serviced in one pass. Production showed the old
// 40-row cap permanently lagging the 100-card view under provider timeouts.
const MAX_ONSCREEN_RECLASSIFY_PER_PASS = VISIBLE_STORY_LIMIT;
// Keep background work bounded so a large SCN/off-screen backlog cannot sit in
// front of the visible cards and serialize dozens of 55-second analyzer calls.
const MAX_OFFSCREEN_MISSING_PER_PASS = 40;
const MAX_RECLASSIFY_PER_PASS = 25;          // off-screen reclassify budget (unchanged)

// A category that conveys no real topic — treated as "unclassified" so the
// backfill keeps trying to sharpen it. Kept deliberately tight (fully-empty or
// bucket words only) so a real specific phrase is never mistaken for generic.
const GENERIC_CATEGORIES = new Set([
  'general', 'news', 'world', 'update', 'uncategorized', 'misc', 'other',
  // 'duplicate' is a stale legacy bucket word that conveys no topic; treating it
  // as generic keeps it from winning a cluster's category vote (so the cluster
  // shows a real member category instead) and out of the displayed Topic slot.
  'duplicate',
  // 'defense' is a content-blind placeholder hardcoded onto EVERY team/manual
  // submission (server/routes.ts addManualSubmission), not a real per-story
  // topic the AI ever assigns. When such a row blends into the curated window
  // without an overlay classification it must NOT win the Topic slot as a
  // uniform "Defense" — treating it as generic lets inference supply a real
  // topic and keeps it out of the cluster category vote.
  'defense',
  // Genre / non-strategic labels that are NOT strategic topics. The analyzer /
  // scraper sometimes writes a piece's GENRE ("Opinion", "Analysis", an
  // "Op-Ed") or a soft-news kind ("Personal Announcement", a bare
  // "Announcement") into the free-form category. These are not real topics, so
  // treating them as generic (a) keeps them out of the displayed Topic chip and
  // the cluster category vote, and (b) lets the backfill re-classify the row to
  // a real primary_topic. Exact-normalized match only — a specific phrase like
  // "Intelligence Analysis" is unaffected. (The client's Topic chip no longer
  // renders raw categories at all — Task #912 allowlist — so this set now
  // guards only the SERVER's reclassify eligibility and cluster category vote;
  // for opinion, see isOpinionGenreCategory.)
  'opinion', 'analysis', 'opinion / analysis', 'op-ed', 'editorial',
  'commentary', 'column', 'personal announcement', 'announcement',
]);

/** True when a category is empty or a meaningless bucket word. */
export function isGenericCategory(category: string | null | undefined): boolean {
  if (!category) return true;
  const c = category.trim().toLowerCase();
  if (!c) return true;
  return GENERIC_CATEGORIES.has(c);
}

let isRunning = false;
let rerunRequested = false;
let scheduledTimer: NodeJS.Timeout | null = null;

interface Candidate {
  url: string;
  title: string;
}

/**
 * Classify a specific set of URL+title candidates and upsert the results into
 * the overlay. Returns the number of (re)classified rows. Safe to call from
 * ingest for instant classification of freshly stored items.
 *
 * Selection when `force` is false: newly-seen URLs (missing from the overlay)
 * are always classified; in addition, a BOUNDED batch of rows stuck on a
 * generic label whose last classification is older than the cooldown are
 * re-classified, so weak/failed labels get sharpened over time without
 * re-sending genuinely-generic items every cron tick. `force` (re)classifies
 * every candidate regardless of overlay state.
 */
export async function classifyCuratedUrls(
  candidates: Candidate[],
  force = false,
  // onlyIfAi (Task #350): when set, the write is atomically guarded so it only
  // updates a row whose STORED provenance is still 'ai'. Used by the bounded
  // re-check's force-reclassify so a human override that lands during the AI call
  // is never overwritten. Default false = normal classify behavior.
  // onScreenUrls (Task #995): the set of URLs currently in the display window.
  // On-screen items get a shorter reclassify cooldown and a dedicated sub-budget
  // so a full window of "Other / Emerging" cards clears in one pass.
  opts: { onlyIfAi?: boolean; onScreenUrls?: Set<string> } = {},
): Promise<number> {
  // De-dupe by URL, drop empties.
  const byUrl = new Map<string, string>();
  for (const c of candidates) {
    if (!c.url || !c.title?.trim()) continue;
    if (!byUrl.has(c.url)) byUrl.set(c.url, c.title.trim());
  }
  if (byUrl.size === 0) return 0;

  let pending = Array.from(byUrl.entries());
  if (!force) {
    const existing = await storage.getCuratedClassificationsByUrls(
      pending.map(([url]) => url),
    );
    const now = Date.now();
    const missing: Array<[string, string, boolean]> = [];
    const stale: Array<[string, string, boolean]> = [];
    for (const [url, title] of pending) {
      const row = existing.get(url);
      const isOnScreen = opts.onScreenUrls?.has(url) ?? false;
      if (!row) { missing.push([url, title, isOnScreen]); continue; }
      // GENERATE-ONCE lock: a row is (re)classified ONLY until it has a
      // SPECIFIC controlled primary_topic. Once a real bucket is set — by the AI
      // generator OR a human override — the row is LOCKED and the cron never
      // reclassifies it, so an automated pass can't churn a human's bucket or a
      // settled label. Two classes remain reclassify-eligible (cooldown-gated):
      //   1. Legacy rows with no primary_topic at all (predate structured classification).
      //   2. AI-generated rows stuck on 'Other / Emerging' — the catch-all is a
      //      classifier failure, not a settled human decision; human-overridden rows
      //      with provenance='human' remain protected and are never touched.
      // A force/repair pass (force=true) skips this whole block and can reclassify
      // everything including human rows, so it is only used in controlled contexts.
      const isOtherEmerging = row.primaryTopic === OTHER_EMERGING;
      const needsUpgrade = !row.primaryTopic || (isOtherEmerging && row.provenance === 'ai');
      if (needsUpgrade) {
        const age = now - new Date(row.classifiedAt).getTime();
        // Task #995: on-screen items (in the current display window) use the
        // short cooldown so a full window of blank cards clears within one pass.
        // Off-screen items keep the long cooldown to protect AI budget.
        const cooldown = isOnScreen ? RECLASSIFY_ONSCREEN_COOLDOWN_MS : RECLASSIFY_GENERIC_COOLDOWN_MS;
        if (age >= cooldown) stale.push([url, title, isOnScreen] as [string, string, boolean]);
      }
    }
    // Newly-seen URLs first; then on-screen stale (priority sub-budget), then
    // off-screen stale. On-screen items have a dedicated cap matching the full
    // visible window; off-screen keep the original cap.
    const onScreenMissing = missing.filter(([,, on]) => on);
    const offScreenMissing = missing.filter(([,, on]) => !on);
    const onScreenStale = stale.filter(([,, on]) => on);
    const offScreenStale = stale.filter(([,, on]) => !on);
    pending = [
      ...onScreenMissing.map(([url, title]): [string, string] => [url, title]),
      ...onScreenStale
        .slice(0, MAX_ONSCREEN_RECLASSIFY_PER_PASS)
        .map(([url, title]): [string, string] => [url, title]),
      ...offScreenMissing
        .slice(0, MAX_OFFSCREEN_MISSING_PER_PASS)
        .map(([url, title]): [string, string] => [url, title]),
      ...offScreenStale
        .slice(0, MAX_RECLASSIFY_PER_PASS)
        .map(([url, title]): [string, string] => [url, title]),
    ];
  }
  if (pending.length === 0) return 0;

  let classified = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    const titles = slice.map(([, title]) => title);
    let analyses: CuratedAnalysisResult[];
    try {
      analyses = await (_classifyAnalyzeImpl ?? analyzeCuratedBatch)(titles);
    } catch (error) {
      // Fail-soft per provider-sized batch. A transient timeout on the first 25
      // visible URLs must not abort every later visible batch; missing rows remain
      // unlocked and retry naturally on the next pass.
      console.error(
        `[CuratedClassify] Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(pending.length / BATCH)} failed; continuing:`,
        error,
      );
      continue;
    }
    // Key analyzer results by title (the analyzer echoes titles verbatim).
    const byTitle = new Map(analyses.map((a) => [a.title, a]));

    const rows: InsertCuratedClassification[] = [];
    const proposals: Array<{ kind: string; proposedLabel: string; sampleTitle: string }> = [];
    slice.forEach(([url, title]) => {
      // The analyzer already binds each result to its exact input title (by the
      // model-echoed index, else an unambiguous title match) and DROPS anything
      // it can't bind, so an exact title match here is reliable. A title that
      // isn't present was dropped upstream → leave this URL unclassified and
      // retry on a later pass. NO positional guess: it would persist another
      // story's analysis under the generate-once lock (e.g. a US market story
      // stamped "South Korea / Semiconductor Cluster").
      const a = byTitle.get(title);
      if (!a) return;

      // Keyword-router post-check: if the AI returned 'Other / Emerging' but the
      // deterministic keyword router fires a confident real topic, use the inferred
      // topic instead. This is a cheap, fail-closed rescue — it never overrides a
      // real topic, and the restricted post-check returns null when no confident
      // persistable match exists, so a genuinely ambiguous story still lands on
      // the catch-all and
      // gets re-sharpened by the normal reclassify cycle. Example catch: the
      // Hormuz-blockade story that the AI put in 'Other / Emerging' despite
      // matching the Maritime Security keyword set.
      let primaryTopic = a.primaryTopic;
      if (primaryTopic === OTHER_EMERGING) {
        // This intentionally excludes read-time-only outage rescue rules. A
        // truthy result is a legacy high-confidence routing rule that was already
        // allowed to persist before the display rescue expanded.
        const inferred = inferPersistablePrimaryTopic(title);
        if (inferred) {
          primaryTopic = inferred as typeof primaryTopic;
        }
      }

      rows.push({
        url,
        category: a.category || 'general',
        region: a.region ?? null,
        country: a.country ?? null,
        // Task #336: persist the controlled-vocabulary object once. legacyCategory
        // stays null here — it is reserved for the one-time historical REMAP that
        // retains a pre-existing free-form label for audit.
        primaryTopic,
        scope: a.scope ?? null,
        conflictTrack: a.conflictTrack ?? null,
        countryPair: a.countryPair ?? null,
        proposedTopic: a.proposedTopic ?? null,
        // AI-generated label (Task #350) — eligible for the bounded re-check.
        provenance: 'ai',
      });
      if (a.proposedTopic) {
        proposals.push({ kind: 'primary_topic', proposedLabel: a.proposedTopic, sampleTitle: title });
      }
    });
    if (rows.length) {
      await storage.upsertCuratedClassifications(rows, { onlyIfAi: opts.onlyIfAi });
      classified += rows.length;
    }
    // Human-gated proposals log: record any off-list topic the model wanted to add.
    for (const p of proposals) {
      try {
        await storage.recordClassificationProposal(p);
      } catch (e) {
        console.error('[CuratedClassify] Failed to record topic proposal:', e);
      }
    }
  }
  // A (re)classify changed the label the curated readers display; clear the
  // curated read cache so the new label shows on the next read (Task #336).
  if (classified > 0) invalidateCuratedReadCache();
  return classified;
}

/**
 * Build the curated-view candidate window: the URLs most likely on screen, as a
 * single pool MERGED from the main feed + curated store and ranked by the SAME
 * time-decayed score the curated view uses (Task #350). Returns the decayed-
 * ranked top CANDIDATE_WINDOW UNION the RECENCY_LANE newest rows UNION every
 * in-window cluster member (displayed regardless of rank — Task #611), deduped
 * by URL.
 *
 * Exported so the dev coverage script measures coverage over EXACTLY the set the
 * backfill classifies (no logic drift between "what we classify" and "what we
 * measure"). Read-only; CURATED-LANE only — reads the feed/curated store, writes
 * nothing.
 *
 * Task #995: also returns `onScreenUrls` — the set of URLs in the top
 * VISIBLE_STORY_LIMIT slots by decayed score (the URLs an editor can actually see
 * now). Used by classifyCuratedUrls to apply the shorter on-screen cooldown
 * and the priority sub-budget for the reclassify pass.
 */
export async function buildCuratedCandidateWindow(): Promise<{ candidates: Candidate[]; onScreenUrls: Set<string> }> {
  const [feed, curatedStore, clusterMembers] = await Promise.all([
    // No limit: we rank the FULL in-window pool ourselves and slice below, so
    // the budget tracks the blended display order rather than a per-store cap.
    storage.getPrimaryFeed(WINDOW_HOURS),
    storage.getCuratedStoreItems(WINDOW_HOURS),
    // Displayed cluster members (Task #611): a displayed Top Story can be a
    // multi-member cluster whose NON-representative members rank below the
    // decayed-window cut, so they never entered the ranked/recency slices above
    // and went unclassified — landing on the "Global · DEMO" focus fallback.
    // They ARE on screen by definition, so include every in-window member.
    // The membership table is the transactionally-replaced CURRENT snapshot.
    // Its createdAt records when this mapping row was written, not whether the
    // underlying article/story is still visible, so never window it here.
    storage.getCuratedClusterMembers(),
  ]);

  type Pooled = { url: string; title: string; score: number; scrapedAt: Date };
  const pool: Pooled[] = [];
  // Main-feed rows ALREADY arrive decayed (depreciatedPriority === the score the
  // view ranks them by) — do NOT decay them a second time.
  for (const f of feed) {
    if (!f.url || !f.title) continue;
    pool.push({
      url: f.url,
      title: f.title,
      score: f.depreciatedPriority ?? f.originalPriority ?? f.priorityScore ?? 0,
      scrapedAt: f.scrapedAt,
    });
  }
  // getCuratedStoreItems() orders by RAW priorityScore, but the curated VIEW
  // decays each curated-store row on the main-feed curve before ranking it.
  // Decay each here on the SAME curve so a curated row's pool score is directly
  // comparable to a (pre-decayed) main-feed row's.
  for (const c of curatedStore) {
    if (!c.url || !c.title) continue;
    pool.push({
      url: c.url,
      title: c.title,
      score: calculateCuratedDepreciatedPriority(
        c.priorityScore, null, c.scrapedAt, null, c.articlePublishedAt ?? null,
      ).depreciatedPriority,
      scrapedAt: c.scrapedAt,
    });
  }

  // Decayed-ranked window (tracks the blended display order) ...
  const rankedPool = [...pool].sort((a, b) => b.score - a.score);
  const ranked = rankedPool.slice(0, CANDIDATE_WINDOW);
  // ... plus the recency fast-lane (newest first), so a fresh low-rank row is
  // classified before it accrues enough rank to enter the ranked window.
  const recent = [...pool]
    .sort((a, b) => new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime())
    .slice(0, RECENCY_LANE);

  // Task #995: on-screen = the top VISIBLE_STORY_LIMIT slots by decayed score.
  // These are the URLs an editor can actually see; they get the shorter reclassify
  // cooldown and the priority sub-budget in classifyCuratedUrls.
  const onScreenUrls = new Set<string>(
    rankedPool.slice(0, VISIBLE_STORY_LIMIT).map((p) => p.url).filter(Boolean),
  );

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const p of [...ranked, ...recent]) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    candidates.push({ url: p.url, title: p.title });
  }
  // Guaranteed-displayed cluster members (Task #611): every in-window member is
  // on screen regardless of its rank, so add any not already covered above. The
  // classify pass only spends AI on URLs MISSING from the overlay, so the budget
  // stays bounded by genuinely-unclassified members (the member table is already
  // capped per pass by the clustering engine).
  for (const m of clusterMembers.filter(isConfirmedCuratedMember)) {
    if (!m.url || !m.title) continue;
    // Every active cluster member is displayed in the story detail, regardless
    // of its raw rank, so it belongs to the visible-priority classification lane.
    onScreenUrls.add(m.url);
    if (seen.has(m.url)) continue;
    seen.add(m.url);
    candidates.push({ url: m.url, title: m.title });
  }

  // SCN lane: add ALL curated-store rows that aren't already covered by the
  // ranked/recency/cluster windows above. The State-Controlled Narratives lens
  // shows adversary/state-media items (CGTN, China Daily, teleSUR, …) that
  // score below the CANDIDATE_WINDOW cut and therefore never reached the ranked
  // slice — their overlay rows stayed NULL and the lens showed null/heuristic
  // Topic·Focus labels instead of controlled-vocabulary ones. Including every
  // curated-store item here costs nothing extra in AI spend: classifyCuratedUrls
  // only calls the LLM on URLs MISSING from the overlay (or reclassify-eligible
  // catch-all rows), so already-classified items are a cheap DB read, not an AI
  // call. Budget remains bounded by content rotation, not window size.
  for (const c of curatedStore) {
    if (!c.url || !c.title) continue;
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    candidates.push({ url: c.url, title: c.title });
  }

  return { candidates, onScreenUrls };
}

/**
 * Background pass: gather the URLs currently eligible for the curated view (the
 * decayed-ranked + recency-fast-laned blended display window) and classify any
 * that are missing from the overlay, then run the bounded, override-safe label
 * re-check. Runs on a cron so labels catch up as content rotates.
 */
export async function backfillCuratedClassifications(): Promise<{ classified: number; cleared: number }> {
  if (isRunning) {
    rerunRequested = true;
    console.log('[CuratedClassify] Already running, skipping this pass');
    return { classified: 0, cleared: 0 };
  }
  isRunning = true;
  try {
    const { candidates, onScreenUrls } = await buildCuratedCandidateWindow();
    const classified = await classifyCuratedUrls(candidates, false, { onScreenUrls });
    if (classified > 0) {
      console.log(`[CuratedClassify] Classified ${classified} new curated-view URLs`);
    }
    // Bounded, override-safe re-check: clear AI labels that persistently and
    // strongly disagree with their cluster's live topic vote so the cron
    // re-sharpens them (Task #350). Runs after classify so the vote reads the
    // freshest labels; failures are isolated (never abort the classify result).
    let cleared = 0;
    try {
      ({ cleared } = await recheckMisclassifiedClusterMembers());
    } catch (e) {
      console.error('[CuratedClassify] Re-check pass failed:', e);
    }

    // Task #995 — classification-lag diagnostic: count on-screen items that are
    // still unlabeled (null primary_topic) or stuck on "Other / Emerging" AFTER
    // this pass. A non-zero count here means the reclassify queue is falling
    // behind the content rotation (e.g. cooldown still active for some items).
    // This surfaces in deployment logs without needing a DB query.
    if (onScreenUrls.size > 0) {
      try {
        const onScreenCandidates = candidates.filter((c) => onScreenUrls.has(c.url));
        if (onScreenCandidates.length > 0) {
          const overlay = await storage.getCuratedClassificationsByUrls(
            onScreenCandidates.map((c) => c.url),
          );
          let lagCount = 0;
          for (const c of onScreenCandidates) {
            const row = overlay.get(c.url);
            if (!row || !row.primaryTopic || row.primaryTopic === OTHER_EMERGING) lagCount++;
          }
          if (lagCount > 0) {
            console.warn(
              `[CuratedClassify] Lag: ${lagCount}/${onScreenUrls.size} on-screen items still unlabeled (null or Other/Emerging)`,
            );
          }
        }
      } catch (e) {
        console.error('[CuratedClassify] Lag diagnostic failed:', e);
      }
    }

    return { classified, cleared };
  } catch (error) {
    console.error('[CuratedClassify] Error:', error);
    return { classified: 0, cleared: 0 };
  } finally {
    isRunning = false;
    if (rerunRequested) {
      rerunRequested = false;
      scheduleCuratedClassificationBackfill(250);
    }
  }
}

/**
 * Coalesced immediate follow-up for membership replacement/incremental attach.
 * The 10-minute cron remains the safety net; this closes the visible-label gap
 * after a cluster changes without allowing overlapping classifier passes.
 */
export function scheduleCuratedClassificationBackfill(delayMs = 1_000): void {
  rerunRequested = true;
  if (scheduledTimer) return;
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null;
    rerunRequested = false;
    void backfillCuratedClassifications().catch((error) => {
      console.error('[CuratedClassify] Scheduled follow-up failed:', error);
    });
  }, Math.max(0, delayMs));
  scheduledTimer.unref?.();
}

// ── Bounded, override-safe label re-check (Task #350) ────────────────────────
// A row classified once is normally LOCKED (generate-once). But the curated view
// derives a cluster's displayed Topic from a LIVE majority vote of its members'
// labels, so a single member whose ORIGINAL AI label disagrees with the rest of
// its cluster shows the "wrong" topic on its own detail line while the cluster
// header shows the majority. This re-check finds AI labels that PERSISTENTLY and
// STRONGLY disagree with their cluster's live topic vote and clears just those,
// so the cron re-sharpens them. It is deliberately conservative:
//   • Only 'ai' rows are ever touched ('human'/unknown are protected).
//   • A row must disagree across THRESHOLD consecutive passes (not one blip).
//   • The disagreeing label must be a STRICT minority vs a ≥MIN_VOTE_SUPPORT
//     majority (a tie or co-leader is never cleared).
//   • At most MAX_RECHECK_CLEAR_PER_PASS rows are cleared per pass (bounded cost).
//   • A just-cleared row is cooldown-gated so a stubborn re-sharpen can't thrash.
const RECHECK_WINDOW_HOURS = 24;            // cluster-member lookback
const RECHECK_MIN_VOTE_SUPPORT = 2;         // majority must have ≥2 votes
const RECHECK_DISAGREE_THRESHOLD = 3;       // consecutive disagreeing passes → clear
const MAX_RECHECK_CLEAR_PER_PASS = 10;      // bounded clears per pass
const RECHECK_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h post-clear cooldown

/** Specific = a real topic that can carry a cluster vote (not null / Other). */
function isSpecificTopic(t: string | null | undefined): boolean {
  return !!t && t.trim() !== '' && t.trim() !== 'Other / Emerging';
}

/**
 * Clear AI primary-topic labels that persistently + strongly disagree with their
 * cluster's live topic vote, then immediately re-classify the cleared set so the
 * label re-sharpens. Returns the number cleared. CURATED-LANE only; never touches
 * a 'human' (or unknown-provenance) row.
 */
export async function recheckMisclassifiedClusterMembers(): Promise<{ cleared: number }> {
  const members = (await storage.getCuratedClusterMembers()).filter(isConfirmedCuratedMember);
  if (members.length === 0) return { cleared: 0 };

  // Join the overlay by URL (cluster members store no primary_topic of their own).
  const urls = Array.from(new Set(members.map((m) => m.url).filter(Boolean)));
  const overlay = await storage.getCuratedClassificationsByUrls(urls);

  // Group members by cluster.
  const byCluster = new Map<string, typeof members>();
  for (const m of members) {
    if (!m.clusterId) continue;
    const list = byCluster.get(m.clusterId) ?? [];
    list.push(m);
    byCluster.set(m.clusterId, list);
  }

  const now = Date.now();
  const counterUpdates: Array<{ url: string; count: number }> = [];
  const clearCandidates: Array<{ url: string; title: string; count: number }> = [];

  for (const clusterMembers of Array.from(byCluster.values())) {
    if (clusterMembers.length < 2) continue;
    // Tally specific-topic votes from the overlay-applied labels.
    const topicVotes = new Map<string, number>();
    for (const m of clusterMembers) {
      const t = overlay.get(m.url)?.primaryTopic;
      if (!isSpecificTopic(t)) continue;
      const tk = t!.trim();
      topicVotes.set(tk, (topicVotes.get(tk) ?? 0) + 1);
    }
    if (topicVotes.size === 0) continue;
    // Winner + its support. A clear majority requires ≥MIN_VOTE_SUPPORT votes.
    let winner: string | null = null;
    let winnerCount = 0;
    for (const [tk, c] of Array.from(topicVotes.entries())) {
      if (c > winnerCount) { winner = tk; winnerCount = c; }
    }
    if (!winner || winnerCount < RECHECK_MIN_VOTE_SUPPORT) continue;

    const seenInCluster = new Set<string>();
    for (const m of clusterMembers) {
      if (seenInCluster.has(m.url)) continue; // one verdict per URL per cluster
      seenInCluster.add(m.url);
      const cls = overlay.get(m.url);
      if (!cls) continue;
      // PROTECTED: only AI labels are ever re-checked.
      if (cls.provenance !== 'ai') continue;
      const t = cls.primaryTopic;
      if (!isSpecificTopic(t)) continue; // generics handled by normal reclassify
      const tk = t!.trim();
      if (tk === winner) {
        // Agreement → reset any accumulated disagreement count.
        if ((cls.recheckDisagreeCount ?? 0) > 0) counterUpdates.push({ url: m.url, count: 0 });
        continue;
      }
      // STRICT minority only: a co-leader / tie with the winner is never cleared.
      const myCount = topicVotes.get(tk) ?? 0;
      if (myCount >= winnerCount) continue;
      // Cooldown: a just-cleared row is left alone so a re-sharpen can't thrash.
      if (cls.recheckLastAt && now - new Date(cls.recheckLastAt).getTime() < RECHECK_COOLDOWN_MS) continue;
      const next = (cls.recheckDisagreeCount ?? 0) + 1;
      if (next >= RECHECK_DISAGREE_THRESHOLD) {
        clearCandidates.push({ url: m.url, title: m.title, count: next });
      } else {
        counterUpdates.push({ url: m.url, count: next });
      }
    }
  }

  // Bound the clears per pass; rows over the cap keep their (threshold-reached)
  // count and clear on the next pass.
  const toClear = clearCandidates.slice(0, MAX_RECHECK_CLEAR_PER_PASS);
  for (const overflow of clearCandidates.slice(MAX_RECHECK_CLEAR_PER_PASS)) {
    counterUpdates.push({ url: overflow.url, count: overflow.count });
  }

  if (counterUpdates.length > 0) {
    await storage.setCuratedRecheckDisagreeCounts(counterUpdates);
  }

  if (toClear.length === 0) {
    if (counterUpdates.length > 0) invalidateCuratedReadCache();
    return { cleared: 0 };
  }

  // Age classified_at past the generic-reclassify cooldown so the cleared rows are
  // immediately eligible (and remain so if the force re-classify below misses any).
  const staleAt = new Date(now - RECLASSIFY_GENERIC_COOLDOWN_MS - 1000);
  const clearedUrls = await storage.clearCuratedAiClassifications(toClear.map((c) => c.url), staleAt);
  const cleared = clearedUrls.length;
  if (cleared > 0) {
    console.log(`[CuratedClassify] Re-check cleared ${cleared} persistently cluster-disagreeing AI label(s)`);
    // Force-reclassify ONLY the URLs storage actually cleared. A row that flipped to
    // a human override between our snapshot and the guarded clear is skipped by the
    // provenance='ai' guard, so it is absent here and is never re-stamped as AI.
    // onlyIfAi additionally guards the WRITE: if a human override lands DURING the
    // (multi-second) AI call below, the upsert sees provenance='human' and is a
    // no-op, so the human label survives that window too. (force past the
    // generate-once lock is safe for these AI rows we just cleared.)
    const clearedSet = new Set(clearedUrls);
    const toReclassify = toClear.filter((c) => clearedSet.has(c.url));
    try {
      await classifyCuratedUrls(
        toReclassify.map((c) => ({ url: c.url, title: c.title })),
        true,
        { onlyIfAi: true },
      );
    } catch (e) {
      console.error('[CuratedClassify] Re-classify after re-check clear failed:', e);
    }
    invalidateCuratedReadCache();
  }
  return { cleared };
}
