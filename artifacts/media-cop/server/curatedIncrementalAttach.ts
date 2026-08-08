// =============================================================================
// Curated incremental-attach bridge (Task #439).
//
// The curated lane is fully rebuilt every ~5 min by clusterCuratedLane (a
// wipe-and-re-derive pass). Between those passes, a freshly-scraped article that
// CLEARLY belongs to an already-formed Top Story sits on the page as a lonely
// single-source card until the next full pass folds it in. This bridge closes
// that gap: a lightweight, NO-AI cron that folds a small bounded number of such
// standalone items into the cluster they obviously belong to, so the read path
// shows them inside the story right away.
//
// It is deliberately CONSERVATIVE — it only attaches an item that matches
// EXACTLY ONE existing formed cluster under the SAME strict same-event matcher
// the clustering pass uses (token overlap + time window + category veto). An
// item that matches zero, or two-or-more, clusters is left alone for the full
// pass to decide. The full pass remains authoritative: it wipes the table and
// re-derives membership from scratch, so an appended row is at most ~5 min ahead
// of (and always reconciled by) the next pass.
//
// CURATED-LANE ONLY, fail-closed:
//   - reads ONLY the curated cluster members + the curated/main candidate feeds;
//   - writes ONLY curated_cluster_members (via appendCuratedClusterMemberIfAbsent)
//     — NEVER headlines.cluster_id or any shared feed table;
//   - TWO classes of outlet fold in:
//       * CONTRIBUTING (trusted news) — the original behavior; AND
//       * adversary STATE-MEDIA CONTRAST (sourceIdentifier 'news-cpc' — RT / TASS /
//         Sputnik / Global Times / Xinhua / Press TV).
//         Contrast folds in as anchor-only, isRepresentative:false, and is NEVER
//         counted toward a cluster's contributing total, so it can never seed,
//         represent, or inform a story — folding it early only adds the "adversary
//         media" member (and its image) to a story that is ALREADY formed, up to
//         ~5 min sooner. This is the same way the full pass already uses adversary
//         media; the bridge just lowers the attach latency.
//     Social/flash, attach-only, anchor-primary (official releases), US mixed-
//     factuality (non-CPC) contrast, blocked and unknown outlets are all skipped
//     (fail-closed) — they can never stand alone or seed/represent a story;
//   - only clusters that are already FORMED (>= 2 contributing publishers) are
//     attach targets, so this never invents a story — and contrast attaches ONLY
//     to such an already-formed story, never creating one.
//
// Note: this bridge is independent of the Task #450 "State-controlled Narratives"
// lens, which reads curated_items directly and never curated_cluster_members — so
// a cluster_members-only write here cannot change that lens.
// =============================================================================
import { storage } from './storage';
import {
  buildOutletIndex,
  findOutlet,
  deriveOutletBehavior,
  deriveBehavior,
  isSocialFlashOutlet,
  type BehaviorResult,
} from '@shared/outletRegistry';
import {
  significantTitleTokens,
  significantCandidateTokens,
  looksSameEvent,
  withinSameEventWindow,
} from './curatedCluster';
import { isSingleWellFormedHttpUrl } from './curatedIngest';
import { normalizeIdentityUrl } from './urlIdentity';
import { invalidateCuratedReadCache } from './curatedCacheBus';
import type { CuratedClusterMember } from '@shared/schema';

// --- windows / bounds --------------------------------------------------------
// Look back only a few hours for fresh standalone candidates (a stale single-
// source card is the full pass's job, not this bridge's).
const CANDIDATE_WINDOW_HOURS = 6;
// Build the formed-cluster picture from the same ~18h window the clustering pass
// uses, so a candidate can attach to a story formed earlier in the cycle.
const CLUSTER_WINDOW_HOURS = 18;
// Hard cap on appends per run — keep this cheap and bounded; the full pass mops
// up anything beyond the cap on its next tick.
const MAX_ATTACH_PER_RUN = 20;
// Within the overall per-run cap, bound how many appends may be adversary
// STATE-MEDIA contrast members. Trusted contributing recall runs FIRST and may
// use the full overall budget; contrast only fills what is left, and never more
// than this sub-cap — so adversary media can never crowd out trusted recall.
const MAX_CONTRAST_ATTACH_PER_RUN = 10;
// An item needs at least this many significant title tokens to be matchable at
// all (a 1-word title carries no event signal — fail closed).
const MIN_CANDIDATE_TOKENS = 2;
// A cluster is a valid attach target only once it is a real multi-source story.
const MIN_CONTRIBUTING_PUBLISHERS = 2;

// ---------------------------------------------------------------------------
// PURE matching core (unit-tested in scripts/curated-incremental-attach.test.ts).
// ---------------------------------------------------------------------------

/** A standalone item considered for folding into an existing cluster. */
export interface AttachCandidate {
  key: string; // `${itemType}:${itemId}`
  tokens: Set<string>; // significantTitleTokens(title)
  bodyTokens?: Set<string>; // significantCandidateTokens — title+body union (Task #747)
  publishedAt: Date | null;
  category: string | null; // classification overlay category, else item category
}

/** One contributing member of a formed cluster, reduced to match inputs. */
export interface AttachClusterMember {
  tokens: Set<string>;
  publishedAt: Date | null;
}

/** A formed cluster reduced to everything selectAttachClusterId needs. */
export interface AttachClusterInfo {
  clusterId: string;
  repTokens: Set<string>;
  repPublishedAt: Date | null;
  category: string | null;
  contributing: AttachClusterMember[];
  contributingCount: number;
}

export interface ManualLinkMemberTokens {
  tokens: Set<string>;
  publishedAt: Date | null;
}
function isKnownCategory(c: string | null | undefined): boolean {
  if (!c) return false;
  const v = c.trim().toLowerCase();
  return v !== '' && v !== 'general' && v !== 'other' && v !== 'other / emerging';
}

/** Returns the only widened target, otherwise null. This preserves ambiguity. */
export function selectManualLinkWidenedClusterId(
  cand: AttachCandidate,
  clusters: AttachClusterInfo[],
  widened: Map<string, ManualLinkMemberTokens[]>,
): string | null {
  if (cand.tokens.size < MIN_CANDIDATE_TOKENS) return null;
  const eligible = new Map(clusters.filter(c => c.contributingCount >= MIN_CONTRIBUTING_PUBLISHERS).map(c => [c.clusterId, c]));
  const hits = new Set<string>();
  for (const [clusterId, members] of widened) {
    const cluster = eligible.get(clusterId);
    if (!cluster || (isKnownCategory(cand.category) && isKnownCategory(cluster.category) &&
      cand.category!.trim().toLowerCase() !== cluster.category!.trim().toLowerCase())) continue;
    const candidateSets = [cand.tokens, ...(cand.bodyTokens && cand.bodyTokens.size > cand.tokens.size ? [cand.bodyTokens] : [])];
    if (candidateSets.some(tokens => members.some(m => withinSameEventWindow(cand.publishedAt, m.publishedAt) && looksSameEvent(tokens, m.tokens)))) hits.add(clusterId);
  }
  return hits.size === 1 ? [...hits][0] : null;
}
/**
 * Decide which existing cluster a candidate should fold into — or null.
 *
 * Returns a clusterId ONLY when the candidate strictly matches EXACTLY ONE
 * formed cluster; returns null on zero matches OR ambiguity (>= 2 matches), so
 * an uncertain item is left for the authoritative full pass. A match requires
 * the SAME same-event evidence the clustering recall gate uses: a time window +
 * token overlap, never bridging a known-category conflict.
 */
export function selectAttachClusterId(
  cand: AttachCandidate,
  clusters: AttachClusterInfo[],
): string | null {
  if (cand.tokens.size < MIN_CANDIDATE_TOKENS) return null;
  const matches: string[] = [];
  for (const k of clusters) {
    if (k.contributingCount < MIN_CONTRIBUTING_PUBLISHERS) continue;
    // Category veto — both known and different => not the same story.
    if (
      isKnownCategory(cand.category) &&
      isKnownCategory(k.category) &&
      cand.category!.trim().toLowerCase() !== k.category!.trim().toLowerCase()
    ) {
      continue;
    }
    let matched = false;
    // Strongest: same event as the cluster's representative headline.
    if (
      withinSameEventWindow(cand.publishedAt, k.repPublishedAt) &&
      looksSameEvent(cand.tokens, k.repTokens)
    ) {
      matched = true;
    } else {
      // Otherwise: same event as >= 2 distinct contributing members (so a lone
      // generic-word overlap with a single member can never pull an item in).
      let n = 0;
      for (const m of k.contributing) {
        if (
          withinSameEventWindow(cand.publishedAt, m.publishedAt) &&
          looksSameEvent(cand.tokens, m.tokens)
        ) {
          n++;
          if (n >= 2) break;
        }
      }
      if (n >= 2) matched = true;
    }
    // Body-aware fallback (Task #747): if title-only match failed and the candidate
    // has a wider combined token set, try body tokens against the cluster's
    // representative and members. Same looksSameEvent bar — only inputs widen.
    // Guards: bodyTokens must be strictly wider than title tokens (i.e. body added
    // something), and we still require EXACTLY ONE cluster match (the ambiguity
    // guard is unchanged). Rescues thin-headline items like quote-based reports
    // whose body names the event actors that the title omitted.
    if (!matched && cand.bodyTokens && cand.bodyTokens.size > cand.tokens.size) {
      const bt = cand.bodyTokens;
      if (
        withinSameEventWindow(cand.publishedAt, k.repPublishedAt) &&
        looksSameEvent(bt, k.repTokens)
      ) {
        matched = true;
      } else {
        let n = 0;
        for (const m of k.contributing) {
          if (
            withinSameEventWindow(cand.publishedAt, m.publishedAt) &&
            looksSameEvent(bt, m.tokens)
          ) {
            n++;
            if (n >= 2) break;
          }
        }
        if (n >= 2) matched = true;
      }
    }
    if (matched) matches.push(k.clusterId);
  }
  return matches.length === 1 ? matches[0] : null;
}

export type AttachReason = 'would-auto-attach' | 'ambiguous' | 'no-match' | 'manual-only';

export interface AttachRecommendation {
  reason: AttachReason;
  /** Present only when reason === 'would-auto-attach'. */
  matchedClusterId?: string;
  /** Number of clusters that matched (0 for no-match/manual-only, 1 for would-auto-attach, ≥2 for ambiguous). */
  matchCount: number;
}

/**
 * Like selectAttachClusterId but exposes the FULL match picture — count and
 * matched clusterIds — so callers can distinguish the four cases:
 *   - exactly one match → 'would-auto-attach' (same logic as the bridge)
 *   - ≥2 matches      → 'ambiguous' (bridge fail-closes on ambiguity)
 *   - zero matches    → 'no-match'
 *   - (caller must set 'manual-only' for lanes the bridge skips entirely)
 *
 * Pure + deterministic: same token/time/category matching as selectAttachClusterId.
 * Exported so the scoring-radar payload builder can surface a bridge-faithful
 * reason for each attach candidate without duplicating the matching core.
 */
export function classifyAttachCandidate(
  cand: AttachCandidate,
  clusters: AttachClusterInfo[],
): AttachRecommendation {
  if (cand.tokens.size < MIN_CANDIDATE_TOKENS) {
    return { reason: 'no-match', matchCount: 0 };
  }
  const matches: string[] = [];
  for (const k of clusters) {
    if (k.contributingCount < MIN_CONTRIBUTING_PUBLISHERS) continue;
    if (
      isKnownCategory(cand.category) &&
      isKnownCategory(k.category) &&
      cand.category!.trim().toLowerCase() !== k.category!.trim().toLowerCase()
    ) {
      continue;
    }
    let matched = false;
    if (
      withinSameEventWindow(cand.publishedAt, k.repPublishedAt) &&
      looksSameEvent(cand.tokens, k.repTokens)
    ) {
      matched = true;
    } else {
      let n = 0;
      for (const m of k.contributing) {
        if (
          withinSameEventWindow(cand.publishedAt, m.publishedAt) &&
          looksSameEvent(cand.tokens, m.tokens)
        ) {
          n++;
          if (n >= 2) break;
        }
      }
      if (n >= 2) matched = true;
    }
    if (!matched && cand.bodyTokens && cand.bodyTokens.size > cand.tokens.size) {
      const bt = cand.bodyTokens;
      if (
        withinSameEventWindow(cand.publishedAt, k.repPublishedAt) &&
        looksSameEvent(bt, k.repTokens)
      ) {
        matched = true;
      } else {
        let n = 0;
        for (const m of k.contributing) {
          if (
            withinSameEventWindow(cand.publishedAt, m.publishedAt) &&
            looksSameEvent(bt, m.tokens)
          ) {
            n++;
            if (n >= 2) break;
          }
        }
        if (n >= 2) matched = true;
      }
    }
    if (matched) matches.push(k.clusterId);
  }
  if (matches.length === 0) return { reason: 'no-match', matchCount: 0 };
  if (matches.length === 1) return { reason: 'would-auto-attach', matchedClusterId: matches[0], matchCount: 1 };
  return { reason: 'ambiguous', matchCount: matches.length };
}

/**
 * Reduce the current cluster-member rows into the per-cluster match picture.
 * Only clusters with >= 2 CONTRIBUTING (corroborating) members are returned —
 * an item can only ever fold into an already-formed multi-source story.
 */
export function buildAttachClusters(
  members: Array<Pick<CuratedClusterMember, 'clusterId' | 'behaviorClass' | 'title' | 'category' | 'publishedAt' | 'isRepresentative'>>,
): AttachClusterInfo[] {
  const byId = new Map<string, typeof members>();
  for (const m of members) {
    const arr = byId.get(m.clusterId);
    if (arr) arr.push(m);
    else byId.set(m.clusterId, [m]);
  }
  const out: AttachClusterInfo[] = [];
  for (const [clusterId, ms] of Array.from(byId.entries())) {
    const contributing = ms.filter((m) => m.behaviorClass === 'corroborating');
    if (contributing.length < MIN_CONTRIBUTING_PUBLISHERS) continue;
    const rep = ms.find((m) => m.isRepresentative) ?? ms[0];
    // Dominant KNOWN category among members, else null (no false veto).
    const counts = new Map<string, number>();
    for (const m of ms) {
      if (isKnownCategory(m.category)) {
        const key = m.category!.trim().toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    let category: string | null = null;
    let best = 0;
    for (const [k, n] of Array.from(counts.entries())) {
      if (n > best) {
        best = n;
        category = k;
      }
    }
    out.push({
      clusterId,
      repTokens: significantTitleTokens(rep.title),
      repPublishedAt: rep.publishedAt ?? null,
      category,
      contributing: contributing.map((m) => ({
        tokens: significantTitleTokens(m.title),
        publishedAt: m.publishedAt ?? null,
      })),
      contributingCount: contributing.length,
    });
  }
  return out;
}

/**
 * Is this an adversary STATE-MEDIA contrast outlet — the "adversary media" the
 * curated lane already surfaces (RT / TASS / Sputnik / Global Times / Xinhua /
 * Press TV, all sourceIdentifier 'news-cpc')?
 *
 * Deliberately NARROW: only NON-social CPC NEWS contrast qualifies. It EXCLUDES
 *   - social contrast (sourceIdentifier 'social-cpc' — its own lanes, also caught
 *     by isSocialFlashOutlet); and
 *   - US mixed/low-factuality "contrast" (contrast via the factuality branch, not
 *     '-cpc') — that is not adversary state media and must not ride in as such.
 * Pure + unit-tested.
 */
export function isAdversaryNewsContrast(
  behavior: Pick<BehaviorResult, 'role' | 'label'>,
  outlet: { sourceIdentifier?: string | null } | null | undefined,
): boolean {
  if (behavior.role !== 'anchor-only' || behavior.label !== 'contrast') return false;
  const sid = outlet?.sourceIdentifier;
  if (typeof sid !== 'string') return false;
  // 'news-cpc' qualifies; 'social-cpc' / any other family does not.
  return sid.endsWith('-cpc') && sid.split('-')[0] === 'news';
}

// ---------------------------------------------------------------------------
// IO orchestration.
// ---------------------------------------------------------------------------
let isRunning = false;

export interface IncrementalAttachResult {
  attached: number;
  candidates: number;
  clusters: number;
}

export async function runCuratedIncrementalAttach(): Promise<IncrementalAttachResult> {
  if (isRunning) return { attached: 0, candidates: 0, clusters: 0 };
  isRunning = true;
  try {
    const [members, registry] = await Promise.all([
      storage.getCuratedClusterMembers(CLUSTER_WINDOW_HOURS),
      storage.getOutletRegistry(),
    ]);
    if (members.length === 0) return { attached: 0, candidates: 0, clusters: 0 };

    const clusters = buildAttachClusters(members);
    if (clusters.length === 0) {
      return { attached: 0, candidates: 0, clusters: 0 };
    }

    const outletIndex = buildOutletIndex(registry);

    // Identity sets of everything already mapped — by member key AND by
    // normalized URL — so we never double-attach the same article.
    const memberKeys = new Set<string>();
    const memberUrls = new Set<string>();
    for (const m of members) {
      memberKeys.add(`${m.itemType}:${m.itemId}`);
      const nu = normalizeIdentityUrl(m.url);
      if (nu) memberUrls.add(nu);
    }

    const [feed, curatedStore] = await Promise.all([
      storage.getPrimaryFeed(CANDIDATE_WINDOW_HOURS),
      storage.getCuratedStoreItems(CANDIDATE_WINDOW_HOURS),
    ]);

    // EDITOR manual-EVICTION overlay (curated-only): an item an editor pulled out
    // of a wrongly-merged story must stay OUT between full passes too, or this
    // bridge would silently fold it right back in. Make the evicted URLs
    // bridge-inert (never a fold candidate). Fail-OPEN: any error leaves the
    // bridge exactly as before. The next full pass (every ~5 min) reconciles the
    // authoritative membership; the item stays standalone until re-linked.
    const evictedIdentityUrls = new Set<string>();
    try {
      const activeEvictions = await storage.getActiveCuratedManualEvictions();
      for (const ev of activeEvictions) {
        const nu = normalizeIdentityUrl(ev.evictedUrl);
        if (nu) evictedIdentityUrls.add(nu);
      }
    } catch (e) {
      console.warn('[CuratedIncrementalAttach] Could not load editor manual-evictions (continuing without):', e);
    }

    // EDITOR manual-LINK cluster widening (Task #1027, Step 5). An editor may
    // force two items into the same cluster via a manual link. The standard
    // selectAttachClusterId checks only CONTRIBUTING members for token-matching.
    // For clusters that have an active manual link, widen the match surface to
    // ALL members — including attach-only adversary members that would normally
    // be invisible to the token matcher. This lets a new article that shares
    // an event with a link-only (attach-only) member correctly fold in.
    // Stored as: clusterId → array of all member token sets + publishedAt.
    const manualLinkClusterTokens = new Map<string, ManualLinkMemberTokens[]>();
    const manualLinkClusterContribCounts = new Map<string, number>();
    try {
      const activeLinks = await storage.getActiveCuratedManualLinks();
      if (activeLinks.length > 0) {
        // URL-identity → clusterId index from current member rows.
        const urlToCid = new Map<string, string>();
        for (const m of members) {
          const nu = normalizeIdentityUrl(m.url);
          if (nu) urlToCid.set(nu, m.clusterId);
        }
        const linkedCids = new Set<string>();
        for (const ml of activeLinks) {
          for (const u of (ml.memberUrls ?? [])) {
            const nu = normalizeIdentityUrl(u);
            if (!nu) continue;
            const cid = urlToCid.get(nu);
            if (cid) linkedCids.add(cid);
          }
        }
        for (const cid of linkedCids) {
          const cMembers = members.filter(m => m.clusterId === cid);
          const contribCount = cMembers.filter(m => m.behaviorClass === 'corroborating').length;
          // Only widen the match surface for FORMED clusters (≥2 contributing).
          if (contribCount < 2) continue;
          manualLinkClusterTokens.set(
            cid,
            cMembers.map(m => ({
              tokens: significantTitleTokens(m.title),
              publishedAt: m.publishedAt ?? null,
            })),
          );
          manualLinkClusterContribCounts.set(cid, contribCount);
        }
      }
    } catch (e) {
      console.warn('[CuratedIncrementalAttach] Could not load manual-link cluster index (continuing without):', e);
    }

    // Classification overlay supplies the content-based category for the veto.
    const classUrls = Array.from(
      new Set([...feed.map((f) => f.url), ...curatedStore.map((c) => c.url)]),
    );
    const classMap = await storage.getCuratedClassificationsByUrls(classUrls);

    // Normalize main + curated candidates into one shape, mirroring the
    // feed->node mapping the clustering pass uses (priority + publishedAt).
    interface RawCandidate {
      itemType: 'main' | 'curated';
      itemId: string;
      title: string;
      source: string;
      url: string;
      summary: string | null;
      ogImageUrl: string | null;
      category: string | null;
      publishedAt: Date | null;
      priority: number;
    }
    const raws: RawCandidate[] = [];
    for (const f of feed) {
      raws.push({
        itemType: 'main',
        itemId: f.id,
        title: f.title,
        source: f.source,
        url: f.url,
        summary: f.summary ?? null,
        ogImageUrl: f.ogImageUrl ?? null,
        category: f.category ?? null,
        publishedAt: f.articlePublishedAt ?? f.scrapedAt ?? null,
        priority: f.priorityOverride ?? f.priorityScore ?? 0,
      });
    }
    for (const c of curatedStore) {
      raws.push({
        itemType: 'curated',
        itemId: c.id,
        title: c.title,
        source: c.source,
        url: c.url,
        summary: c.summary ?? null,
        ogImageUrl: c.ogImageUrl ?? null,
        category: c.category ?? null,
        publishedAt: c.articlePublishedAt ?? c.scrapedAt ?? null,
        priority: c.priorityScore ?? 0,
      });
    }

    // Classify each candidate's eligibility lane ONCE. Two lanes fold in:
    //   - 'contributing': trusted news (corroborating) — the original behavior;
    //   - 'contrast': adversary STATE-MEDIA news (isAdversaryNewsContrast).
    // Everything else (social/flash, attach-only, anchor-primary, blocked,
    // unknown, non-CPC mixed-factuality contrast) is fail-closed skipped.
    type Lane = 'contributing' | 'contrast';
    interface Eligible {
      raw: RawCandidate;
      key: string;
      behavior: BehaviorResult;
      lane: Lane;
    }
    const contributingQ: Eligible[] = [];
    const contrastQ: Eligible[] = [];
    for (const raw of raws) {
      const key = `${raw.itemType}:${raw.itemId}`;
      if (memberKeys.has(key)) continue;
      if (!isSingleWellFormedHttpUrl(raw.url)) continue;
      const nu = normalizeIdentityUrl(raw.url);
      if (nu && memberUrls.has(nu)) continue;
      if (nu && evictedIdentityUrls.has(nu)) continue; // editor evicted -> bridge-inert
      if (!raw.source || raw.source === 'Unknown Source') continue;

      const outlet = findOutlet(outletIndex, raw.source, raw.url);
      const behavior = outlet ? deriveOutletBehavior(outlet) : deriveBehavior({});
      if (behavior.blocked) continue;
      if (isSocialFlashOutlet(outlet)) continue; // social never folds via this bridge

      if (behavior.role === 'contributing') {
        contributingQ.push({ raw, key, behavior, lane: 'contributing' });
      } else if (isAdversaryNewsContrast(behavior, outlet)) {
        contrastQ.push({ raw, key, behavior, lane: 'contrast' });
      }
      // else: fail-closed skip.
    }

    // Anti-flap: process contrast in a deterministic order (priority desc, then
    // most-recent, then key) so the same items win the sub-cap each run. The
    // contributing lane keeps its natural feed order (unchanged behavior).
    contrastQ.sort((a, b) => {
      const pd = (b.raw.priority || 0) - (a.raw.priority || 0);
      if (pd !== 0) return pd;
      const bt = b.raw.publishedAt?.getTime() ?? 0;
      const at = a.raw.publishedAt?.getTime() ?? 0;
      if (bt !== at) return bt - at;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    let attached = 0;
    let considered = 0;
    let contrastAttached = 0;

    // Attempt to fold one eligible candidate into its single matching formed
    // cluster. Returns true only when a row was actually appended.
    const tryAttach = async (e: Eligible): Promise<boolean> => {
      const { raw, key, behavior } = e;
      // Re-check identity guards (an earlier append this run may have claimed it).
      if (memberKeys.has(key)) return false;
      const nu = normalizeIdentityUrl(raw.url);
      if (nu && memberUrls.has(nu)) return false;

      considered++;
      const titleToks = significantTitleTokens(raw.title);
      const combinedToks = significantCandidateTokens({
        title: raw.title,
        bullets: null,
        summary: raw.summary,
      });
      const cand: AttachCandidate = {
        key,
        tokens: titleToks,
        bodyTokens: combinedToks.size > titleToks.size ? combinedToks : undefined,
        publishedAt: raw.publishedAt,
        category: classMap.get(raw.url)?.category ?? raw.category ?? null,
      };
      const strictTarget = selectAttachClusterId(cand, clusters);
      // Manual-link cluster widened match (Task #1027, Step 5): if the standard
      // contributing-only match missed this candidate, try matching against ALL
      // members (including attach-only) of clusters that have an active editor
      // manual link. Fail-closed: any match must still be a FORMED cluster
      // (contribCount ≥ 2, guarded when building manualLinkClusterTokens above).
      const widenedTarget = manualLinkClusterTokens.size
        ? selectManualLinkWidenedClusterId(cand, clusters, manualLinkClusterTokens)
        : null;
      // A strict target is authoritative unless the widened path introduces a
      // different compatible target, in which case the union is ambiguous.
      const targetClusterId = strictTarget && (!widenedTarget || widenedTarget === strictTarget)
        ? strictTarget
        : (!strictTarget ? widenedTarget : null);
      if (!targetClusterId) return false;

      // Cross-pass member-confirmation hysteresis (Task #645): every bridge
      // attach is volatile by definition (it exists BECAUSE the full pass
      // hasn't run since this item arrived), so it always starts provisional
      // and reads its persisted streak. Fail-closed: on error stays at 0
      // (withheld) rather than a false confirmation. The full pass reconciles
      // (bumps/prunes) this same key once it re-forms the cluster.
      let confirmedStreak = 0;
      try {
        confirmedStreak = await storage.bumpCuratedMemberConfirmation(targetClusterId, raw.itemType, raw.itemId);
      } catch (confirmErr) {
        console.warn(
          '[CuratedIncrementalAttach] Member-confirmation bump failed (non-fatal, stays withheld):',
          confirmErr instanceof Error ? confirmErr.message : confirmErr,
        );
      }

      const ok = await storage.appendCuratedClusterMemberIfAbsent({
        clusterId: targetClusterId,
        itemType: raw.itemType,
        itemId: raw.itemId,
        role: behavior.role, // 'contributing' | 'anchor-only' (contrast)
        behaviorClass: behavior.cls, // 'corroborating' | 'anchor-only'
        behaviorLabel: behavior.label, // null (contributing) | 'contrast'
        contentKind: null, // reported article — no page-detected kind snapshot here
        title: raw.title,
        source: raw.source,
        url: raw.url,
        category: cand.category,
        summary: raw.summary,
        publishedAt: raw.publishedAt,
        priorityScore: Math.round(raw.priority) || 0,
        ogImageUrl: raw.ogImageUrl, // contrast media rides along, same as adversary media
        isRepresentative: false, // an attached item never becomes a story's face
        provisional: true,
        confirmedStreak,
      });
      if (ok) {
        attached++;
        memberKeys.add(key);
        if (nu) memberUrls.add(nu);
        void import('./curatedClassify')
          .then(({ scheduleCuratedClassificationBackfill }) => scheduleCuratedClassificationBackfill())
          .catch((error) => console.warn('[CuratedIncrementalAttach] Classification follow-up scheduling failed:', error));
      }
      return ok;
    };

    // Phase 1: trusted contributing recall — highest priority, may use the full
    // overall budget (unchanged behavior).
    for (const e of contributingQ) {
      if (attached >= MAX_ATTACH_PER_RUN) break;
      await tryAttach(e);
    }
    // Phase 2: adversary-media (contrast) recall — only the budget left over,
    // and never more than its own sub-cap, so it can't starve contributing.
    for (const e of contrastQ) {
      if (attached >= MAX_ATTACH_PER_RUN) break;
      if (contrastAttached >= MAX_CONTRAST_ATTACH_PER_RUN) break;
      if (await tryAttach(e)) contrastAttached++;
    }

    if (attached > 0) {
      invalidateCuratedReadCache();
      console.log(
        `[CuratedIncrementalAttach] folded ${attached} standalone item(s) into existing clusters` +
          (contrastAttached > 0 ? ` (${contrastAttached} adversary-media/contrast)` : ''),
      );
    }
    return { attached, candidates: considered, clusters: clusters.length };
  } catch (error) {
    console.warn(
      '[CuratedIncrementalAttach] non-fatal:',
      error instanceof Error ? error.message : error,
    );
    return { attached: 0, candidates: 0, clusters: 0 };
  } finally {
    isRunning = false;
  }
}
