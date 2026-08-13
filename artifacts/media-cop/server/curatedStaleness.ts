// =============================================================================
// Curated staleness / phase-out helpers (extracted from curatedCluster.ts).
//
// These pure functions decide whether a curated story should be PHASED OUT
// (dropped from Top Stories) based on its members' publishedAt timestamps. They
// live in their own module so BOTH the clustering engine (server/curatedCluster.ts)
// AND the storage archive layer (server/storage.ts) can share one source of
// truth — curatedCluster already imports storage, so importing these from
// curatedCluster into storage would create a circular dependency.
//
// Curated lane only — never touches shared feeds or the public API.
// =============================================================================

// Staleness phase-out (Task #177): a clustered story drops once it goes stale.
// Computed per cluster from its members' publishedAt timestamps:
//   origination = earliest member publishedAt (when the story broke)
//   lastUpdate  = latest member publishedAt (the same items re-clustering NEVER
//                 advances this — only genuinely newer reporting joining does)
// A cluster phases out when EITHER it originated > SOFT_AGE_H ago AND has had no
// substantial update for > STALE_GAP_H, OR it originated > HARD_AGE_H ago.
const PHASEOUT_SOFT_AGE_H = 16;
const PHASEOUT_STALE_GAP_H = 8;
const PHASEOUT_HARD_AGE_H = 22;

// Developing diplomatic / negotiation PROCESS phase-out (a proposed deal,
// ceasefire/peace negotiation, summit, signing, treaty, memorandum). Unlike a
// discrete strike, such a story legitimately develops over MULTIPLE days — its
// reporting stretches across 24-48h while still concerning the SAME proposed
// agreement. The 22h hard cap, tuned for kinetic incidents, prematurely kills
// it. While the story is still ACTIVELY updating (a fresh member within
// PHASEOUT_PROCESS_ACTIVE_GAP_H) we extend the absolute ceiling to
// PHASEOUT_PROCESS_HARD_AGE_H; once it goes quiet it falls back to the normal
// soft/hard rule and drops like any stale story. Strikes never get this exemption.
const PHASEOUT_PROCESS_ACTIVE_GAP_H = 6;
const PHASEOUT_PROCESS_HARD_AGE_H = 48;

// General actively-updating clustered-story extension (Task #301). A multi-source
// clustered story that is STILL being reported by trusted (contributing) outlets
// is legitimately live past the 22h kinetic hard cap even when it is not a
// diplomatic "process" story. While a fresh CONTRIBUTING member (NOT an attach /
// adversary repost) lands within PHASEOUT_ACTIVE_GAP_H we extend the absolute
// ceiling to PHASEOUT_ACTIVE_HARD_AGE_H — bounded BELOW the 48h process ceiling
// so nothing zombies forever, and strictly additive: a story that does NOT
// qualify falls through to the soft/hard rule unchanged.
const PHASEOUT_ACTIVE_GAP_H = 6;
const PHASEOUT_ACTIVE_HARD_AGE_H = 36;

// Conservative diplomatic/negotiation PROCESS vocabulary. Matched against member
// TITLES only to decide whether a cluster is a developing process story (the
// phase-out exemption above). Signing is matched only as `signed`/`signing`/`to
// sign` — NOT bare `sign`/`signs` — so "signs of escalation" / "Trump signs an
// order" / "signals" never trip it. "peace" only counts when followed by a
// process word (so "peace prize"/"peace prospects" don't qualify).
// Vocabulary extended (2026-07-14) to cover policy-proposal ARCS (propose →
// reaction → reversal) such as the Hormuz transit-toll saga: Iran proposing
// shipping tolls/fees, US/allied reaction, Iran walking back, new counter-
// proposal, etc. "reversal", "walk back", "concession", and "counter-proposal"
// are added so multi-day proposal-reaction-reversal sequences qualify for the
// existing developing-process time-split exemption. Strikes stay never-exempt.
const PROCESS_TERM_RE =
  /\b(?:deals?|agreements?|accords?|cease[- ]?fire|truce|treat(?:y|ies)|pact|negotiat\w+|talks?|summit|memorand(?:um|a)|framework|proposals?|finaliz\w+|peace\s+(?:talks?|deal|plan|process|agreement)|signed|signing|to\s+sign|diplomat\w+|reversal|reverses?|reversed|walk(?:s|ed|ing)?\s+back|walk-?back|concessions?|counter-?proposals?|counter-?offers?)\b/i;

// Kinetic-operation vocabulary. Matched against member TITLES to identify a
// cluster whose CHARACTER is predominantly kinetic (military strikes, attacks,
// interceptions, blockade, bombardment). A kinetic mega-story — such as a war
// in progress — must NOT inherit the developing-process phase-out extension or
// anchor-split hard-skip merely because a few of its headlines incidentally
// mention ceasefire/deal talks happening alongside the kinetic events. Those
// exemptions exist for diplomatic PROCESSES, not for ongoing military operations.
// Conservative vocabulary: only high-confidence, unambiguous kinetic actions.
const KINETIC_TERM_RE =
  /\b(?:strikes?|struck|attack(?:s|ed|ing)?|bombs?|bombed|bombing|missiles?|rockets?|intercept(?:s|ed|ions?|ing)|blockade[sd]?|blockading|warships?|airstrikes?|air\s*strikes?|bombardment|shelling|launches?\s+(?:missiles?|rockets?|drones?)|launched\s+(?:missiles?|rockets?|drones?|airstrikes?)|drone\s+strike|military\s+operat\w+|special\s+operat\w+|killed\s+in\s+(?:strike|attack|raid|bombing|airstrike)|raid(?:s|ed|ing)?|amphibious|naval\s+(?:strike|attack|blockade))\b/i;

// True when a cluster is PREDOMINANTLY KINETIC (strikes / attacks / blockade /
// interceptions / bombardment). Requires a clear kinetic majority:
// >= 3 kinetic titles AND kinetic >= 2× process titles. This threshold ensures a
// legitimate diplomatic-process cluster that incidentally references "attacks" or
// "strikes" (e.g. a ceasefire negotiation with a few "strike-halted" headlines)
// is never wrongly stripped of its process extension, while a war story whose
// dominant character is kinetic (US–Iran strikes, naval blockade) is correctly
// identified even when a handful of members mention ceasefire/deal talks.
// Pure + exported so the carry-over decay gate, anchor-split skip, and phase-out
// function share the same classifier. Curated-lane only, never touches shared feeds.
export function isKineticDominantCluster(
  titles: Array<string | null | undefined>,
): boolean {
  let kinetic = 0;
  let process = 0;
  for (const t of titles) {
    if (!t) continue;
    if (KINETIC_TERM_RE.test(t)) kinetic++;
    if (PROCESS_TERM_RE.test(t)) process++;
  }
  // Clear kinetic majority: >= 3 kinetic titles and kinetic >= 2x process titles.
  return kinetic >= 3 && kinetic >= process * 2;
}

// True when a cluster is a developing diplomatic/negotiation PROCESS story:
// >= 2 of its member titles carry process vocabulary. The cluster has already
// passed the LLM grouping + coherence guard, so two deal-worded titles inside it
// are a strong signal it is genuinely a deal/negotiation story (not a strike that
// merely mentions a deal once). A false positive only lets an actively-updating
// cluster live a little longer (a staleness nudge, never a merge), so the bar is
// deliberately cheap. Pure + exported for the node-cap repro's regression gate.
// VETO: a kinetic-dominant cluster (isKineticDominantCluster) is never classified
// as a developing process even when it meets the >= 2 title bar — a war story
// must not inherit diplomacy exemptions because a few members mention ceasefire.
export function isDevelopingProcessCluster(
  titles: Array<string | null | undefined>,
): boolean {
  // A kinetic-dominant cluster (strikes / attacks / blockade) must not inherit
  // the developing-process phase-out extension or anchor-split hard-skip, even
  // when a few of its titles incidentally mention ceasefire/deal negotiations.
  if (isKineticDominantCluster(titles)) return false;
  let n = 0;
  for (const t of titles) {
    if (t && PROCESS_TERM_RE.test(t)) {
      n++;
      if (n >= 2) return true;
    }
  }
  return false;
}

// Shared staleness decision (Task #177). Returns true when a cluster should be
// PHASED OUT (dropped) given its members' publishedAt timestamps (ms). Applied
// uniformly to BOTH carry-over clusters AND clusters freshly formed in the
// current pass — otherwise the 22h hard cap would only bound carried clusters
// and a brand-new cluster built from live-window items aged 22-24h would still
// display. With no usable timestamps it returns false (no basis to phase out;
// caller decides the fallback). When opts.developingProcess is set AND the story
// is still actively updating, the hard ceiling is relaxed to
// PHASEOUT_PROCESS_HARD_AGE_H (see the process constants above). Exported for the
// node-cap repro's deterministic regression gate.
export function isClusterPhasedOut(
  pubTimesMs: number[],
  nowMs: number,
  opts?: { developingProcess?: boolean; lastContributingMs?: number },
): boolean {
  if (pubTimesMs.length === 0) return false;
  const ageH = (nowMs - Math.min(...pubTimesMs)) / 3_600_000;
  // Update recency across ALL members — drives the existing soft/hard rule (a
  // mis-attached or re-clustered member never advances it; only genuinely newer
  // reporting joining does). Left untouched so non-qualifying stories phase out
  // EXACTLY as before.
  const sinceUpdateH = (nowMs - Math.max(...pubTimesMs)) / 3_600_000;
  // Update recency measured ONLY against CONTRIBUTING (trusted) members, when the
  // caller supplies it (Task #301). An attach-only / adversary repost therefore
  // cannot keep a story "fresh" for the ceiling-extension gates below — a spurious
  // update can never hold a story open. Falls back to the all-member recency for
  // back-compat when not supplied (e.g. the pure regression gates).
  const sinceContribH =
    opts?.lastContributingMs != null
      ? (nowMs - opts.lastContributingMs) / 3_600_000
      : sinceUpdateH;
  // Developing process story still actively updating: only the raised absolute
  // ceiling applies, so a multi-day deal that just got a fresh report survives.
  if (opts?.developingProcess && sinceContribH <= PHASEOUT_PROCESS_ACTIVE_GAP_H) {
    return ageH > PHASEOUT_PROCESS_HARD_AGE_H;
  }
  // General actively-updating multi-source story (Task #301): a fresh CONTRIBUTING
  // report within the active gap earns a bounded ceiling extension. Strictly
  // additive — only reached when the caller passes lastContributingMs (i.e. it is
  // a real multi-source clustered story still being reported by trusted outlets).
  if (opts?.lastContributingMs != null && sinceContribH <= PHASEOUT_ACTIVE_GAP_H) {
    return ageH > PHASEOUT_ACTIVE_HARD_AGE_H;
  }
  return (
    (ageH > PHASEOUT_SOFT_AGE_H && sinceUpdateH > PHASEOUT_STALE_GAP_H) ||
    ageH > PHASEOUT_HARD_AGE_H
  );
}

// Newest CONTRIBUTING (corroborating) member timestamp (ms) for a cluster, or
// undefined when fewer than two contributing members carry a usable date. Gating
// the general phase-out extension on this keeps it to genuinely multi-source
// stories whose freshness comes from trusted reporting — never an adversary or
// attach-only repost (Task #301). Accepts either the live LaneNode shape (`cls`)
// or a stored member row (`behaviorClass`).
export function lastContributingMs(
  members: Array<{
    cls?: string | null;
    behaviorClass?: string | null;
    publishedAt?: Date | string | null;
  }>,
): number | undefined {
  const ts = members
    .filter((m) => (m.cls ?? m.behaviorClass) === 'corroborating')
    .map((m) => (m.publishedAt ? new Date(m.publishedAt).getTime() : NaN))
    .filter((t) => Number.isFinite(t)) as number[];
  return ts.length >= 2 ? Math.max(...ts) : undefined;
}

// Read-time status of an ARCHIVED (not-live) curated story. 'phased_out' means
// the story genuinely aged out per the shared staleness rule; 'active' means its
// articles are still fresh and eligible — it simply isn't currently surfaced in
// Top Stories (e.g. crowded out by the priority cap or a transient missed pass).
// Used by the storage archive read so the UI never mislabels a still-fresh story
// as "phased out".
// 'superseded' = the story is live in Top Stories right now under a NEWER
// grouping (a live cluster shares at least one member article); this archived
// version is the older snapshot it replaced. Derived at read time in
// searchCuratedStoryArchive — archiveRowStatus itself never returns it.
export type ArchiveStatus = 'active' | 'phased_out' | 'superseded';

// Pure status derivation from an archive row's stored members. Mirrors EXACTLY
// the verdict the clustering pass would reach (all member publish times for the
// base age-out rule; trusted contributing timestamps for the active-extension
// gate; process-vocabulary exemption from the member titles), so the label the
// archive shows agrees with whether clustering still considers the story alive.
export function archiveMembersPhasedOut(
  members: Array<{
    title?: string | null;
    publishedAt?: Date | string | null;
    behaviorClass?: string | null;
    cls?: string | null;
  }>,
  nowMs: number,
): boolean {
  const pubTimes = members
    .map((m) => (m.publishedAt ? new Date(m.publishedAt).getTime() : NaN))
    .filter((t) => Number.isFinite(t)) as number[];
  return isClusterPhasedOut(pubTimes, nowMs, {
    developingProcess: isDevelopingProcessCluster(members.map((m) => m.title)),
    lastContributingMs: lastContributingMs(members),
  });
}

// A NOT-LIVE archive row that no live clustering pass has refreshed in this long
// is permanently orphaned — it will never re-surface — regardless of (missing or
// anomalous) member dates. Set above the longest legitimate live ceiling (the
// 48h developing-process cap) so a genuinely re-surfacing multi-day process
// story is never prematurely labelled "phased out", while a truly dead row stops
// reading "Active" forever (Task #355).
const ARCHIVE_ORPHAN_LASTSEEN_H = 48;
const ARCHIVE_ORPHAN_LASTSEEN_MS = ARCHIVE_ORPHAN_LASTSEEN_H * 60 * 60 * 1000;

// Honest read-time status for an ARCHIVED (not-live) curated story (Task #355).
// The bare member-date rule (`archiveMembersPhasedOut`) returns "not phased out"
// when a row carries NO usable member dates — there is simply no basis to age it
// out. The archive read previously mapped that to 'active', so the ~41% of rows
// with zero dated members (legacy / undated captures) rendered
// "Active — not currently in Top Stories" forever even though they are
// permanently orphaned. Truthful derivation instead:
//   • No usable freshness EVIDENCE (no dated member) → 'phased_out' (archived).
//   • Not refreshed by a live pass in > ARCHIVE_ORPHAN_LASTSEEN_H → 'phased_out'
//     (permanently orphaned), even if some member date looks fresh (anomalous /
//     future-dated rows).
//   • Otherwise defer to the shared staleness rule.
// 'active' therefore requires positive freshness evidence; the default for an
// undated / stale not-live row is the honest 'phased_out'. Curated lane only.
export function archiveRowStatus(
  members: Array<{
    title?: string | null;
    publishedAt?: Date | string | null;
    behaviorClass?: string | null;
    cls?: string | null;
  }>,
  nowMs: number,
  lastSeenAtMs: number | null,
): ArchiveStatus {
  const hasUsableDate = members.some(
    (m) => m.publishedAt != null && Number.isFinite(new Date(m.publishedAt).getTime()),
  );
  if (!hasUsableDate) return 'phased_out';
  if (lastSeenAtMs != null && nowMs - lastSeenAtMs > ARCHIVE_ORPHAN_LASTSEEN_MS) {
    return 'phased_out';
  }
  return archiveMembersPhasedOut(members, nowMs) ? 'phased_out' : 'active';
}

// =============================================================================
// Long-lived-story SYNOPSIS refresh (Task #920).
//
// A clustered story that legitimately outlives the 22h kinetic cap (the 48h
// developing-process lane or the 36h general active-extension) keeps a FROZEN
// synopsis: re-synthesis only fires when the member-presence fingerprint
// changes, so a story whose member SET has settled but that keeps drawing fresh
// contributing reports freezes a stale lede/facts. These pure helpers decide
// when to force a one-shot re-synthesis for such a story, bounded so it can
// never loop. Curated lane only.
// =============================================================================

// A long-lived story only qualifies for a stale-synopsis refresh once it has
// aged past the normal kinetic hard cap — younger stories still re-synthesize on
// ordinary member-presence changes, so there is nothing to rescue there.
const STALE_SYNOPSIS_MIN_AGE_H = PHASEOUT_HARD_AGE_H; // 22h
// The freshest contributing content must lead the last synthesized-through
// marker by a MEANINGFUL margin before we re-synthesize — a few minutes of
// timestamp jitter must not trigger a refresh.
const STALE_SYNOPSIS_MARGIN_MS = 45 * 60 * 1000; // 45 min
// At most one stale-synopsis refresh per this cooldown, so a fast-moving story
// refreshes ONCE per development, not every clustering pass.
const STALE_SYNOPSIS_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h (non-kinetic default)
// Kinetic-dominant clusters (ongoing strikes / blockades / war operations) move
// faster than diplomatic-process stories — the 2h cooldown leaves an hour-long
// lag before a new wave of strikes updates the headline. Use a shorter 1h window
// so actively-developing war stories re-synthesize up to once per hour.
const STALE_SYNOPSIS_COOLDOWN_KINETIC_MS = 60 * 60 * 1000; // 1h

// Freshest CONTRIBUTING (corroborating) member content-timestamp — the freshest
// article the synopsis is allowed to have incorporated. Attach-only / adversary
// reposts never count (they can't move the reported facts). Returns undefined
// when no contributing member carries a usable date.
export function freshestContributingContentMs(
  members: Array<{
    behaviorClass?: string | null;
    cls?: string | null;
    publishedAt?: Date | string | null;
  }>,
): number | undefined {
  const ts = members
    .filter((m) => (m.cls ?? m.behaviorClass) === 'corroborating')
    .map((m) => (m.publishedAt ? new Date(m.publishedAt).getTime() : NaN))
    .filter((t) => Number.isFinite(t)) as number[];
  return ts.length ? Math.max(...ts) : undefined;
}

// Should a long-lived story's synopsis be re-synthesized this pass? Pure and
// self-terminating: because every synthesis stamps synthesizedThrough =
// freshestContribMs, the (freshestContribMs - synthesizedThroughMs) delta drops
// to 0 immediately after a refresh, so this returns false again until GENUINELY
// newer contributing content lands. The cooldown bounds it to once per window.
// When isKineticDominant is true, the shorter kinetic cooldown is used so
// actively-developing war stories re-synthesize up to once per hour rather than
// once per 2 hours.
export function shouldRefreshStaleSynopsis(o: {
  ageH: number;
  freshestContribMs?: number;
  synthesizedThroughMs: number | null;
  msSinceLastSynthesis: number;
  isKineticDominant?: boolean;
}): boolean {
  if (o.ageH <= STALE_SYNOPSIS_MIN_AGE_H) return false;
  if (o.freshestContribMs == null || o.synthesizedThroughMs == null) return false;
  if (o.freshestContribMs - o.synthesizedThroughMs <= STALE_SYNOPSIS_MARGIN_MS) return false;
  const cooldown = o.isKineticDominant
    ? STALE_SYNOPSIS_COOLDOWN_KINETIC_MS
    : STALE_SYNOPSIS_COOLDOWN_MS;
  if (o.msSinceLastSynthesis <= cooldown) return false;
  return true;
}

export const STALE_SYNOPSIS_TUNING = {
  STALE_SYNOPSIS_MIN_AGE_H,
  STALE_SYNOPSIS_MARGIN_MS,
  STALE_SYNOPSIS_COOLDOWN_MS,
  STALE_SYNOPSIS_COOLDOWN_KINETIC_MS,
};
