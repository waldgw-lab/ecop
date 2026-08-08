/**
 * server/curatedClusterScore.ts
 *
 * Pure aggregation function that computes a curated Top Story cluster's
 * displayed P score with three invariants:
 *
 *   1. Provisional (not-yet-confirmed) bridge-attach members are EXCLUDED from
 *      the score — they don't move the badge, consistent with how they are
 *      already excluded from sourceCount and the visible member list.
 *
 *   2. Late-joiner bounded lift: a confirmed member published more than
 *      SAME_EVENT_WINDOW_HOURS after its event window's anchor, WITHOUT
 *      corroboration, may only lift the cluster score by at most
 *      LATE_JOINER_LIFT_CAP points above the cooled base. A lone late
 *      syndication of a day-old story should not reset the cluster to P85
 *      just because the joiner is inside its own 2-h no-decay grace.
 *
 *   3. CORROBORATED FRESH BURST rolls the event window: confirmed members are
 *      greedily partitioned into event windows by published date (a new window
 *      opens when a member is published more than SAME_EVENT_WINDOW_HOURS
 *      after the current window's ANCHOR — anchor-based, NOT chained gaps, so
 *      a slow syndication drip can never stretch one window forever). The
 *      earliest window is the core (always uncapped — current behaviour). A
 *      LATER window is "corroborated" when it holds >= 2 members from >= 2
 *      distinct publishers — mirroring the story-formation gate's >=2
 *      corroborating publishers philosophy — and then scores UNCAPPED: a
 *      multi-day story with a genuine new development (several independent
 *      outlets publishing fresh) displays its real fresh priority instead of
 *      being pinned to the decayed floor + 10. Singleton / single-publisher
 *      late windows stay capped (invariant 2).
 *
 * All logic is deterministic and dependency-free beyond calculateCuratedDepreciatedPriority
 * from storage.ts, so the gate test can exercise it without a DB or network.
 */

import { calculateCuratedDepreciatedPriority } from './storage';
import { SAME_EVENT_WINDOW_HOURS } from './curatedCluster';

/** How many P-score points an uncorroborated late joiner may add above the story's cooled base. */
export const LATE_JOINER_LIFT_CAP = 10;

export interface MemberScoreInput {
  /** Raw, undecayed priority score (same field used by the main-feed decay loop). */
  originalPriority: number;
  /** First-seen timestamp — used as decay anchor when articlePublishedAt is absent. */
  scrapedAt: Date | string;
  /** Article published date — preferred decay anchor; null/undefined falls back to scrapedAt. */
  articlePublishedAt: Date | string | null | undefined;
  /**
   * True when this member has passed the hysteresis-confirmation gate
   * (isConfirmedCuratedMember); false = provisional, excluded from scoring.
   */
  confirmed: boolean;
  /**
   * Whether this member has ranking authority. Curated attach/contrast/primary
   * members may remain visible in the story, but only corroborating members may
   * raise its displayed priority or refresh its effective date.
   *
   * Optional for backwards compatibility with existing callers/fixtures:
   * omitted means eligible.
   */
  contributesToRanking?: boolean;
  /**
   * Distinct-publisher identity for fresh-burst corroboration (url host,
   * www-stripped; fallback source name). Missing/empty keys are treated as
   * DISTINCT unknown publishers — matching how the clustering engine treats
   * unattributable members — so absence of metadata degrades toward the
   * legacy >=2-members rule rather than silently never corroborating.
   */
  publisherKey?: string | null;
}

/**
 * Compute the cluster's displayed priority score.
 *
 * @param members         All live cluster members with their confirmed flag.
 * @param repFallbackScore  Stored representative's priorityScore (used when no
 *                          live confirmed member resolves).
 * @param repFallbackCreatedAt  Stored representative's createdAt (decay anchor
 *                              for the fallback path).
 */
export function computeClusterPriorityScore(
  members: MemberScoreInput[],
  repFallbackScore: number,
  repFallbackCreatedAt: Date | string,
): number {
  // Only confirmed CORROBORATING members contribute to the score. Attach-only
  // social/OSINT, contrast, and primary-origin rows remain visible coverage but
  // carry no ranking authority.
  const confirmed = members.filter(
    (m) => m.confirmed && m.contributesToRanking !== false,
  );

  if (confirmed.length === 0) {
    // No confirmed live member resolves → use the stored rep, decayed by age.
    return calculateCuratedDepreciatedPriority(
      repFallbackScore,
      null,
      new Date(repFallbackCreatedAt),
    ).depreciatedPriority;
  }

  // Decay each confirmed member by its own article age.
  const decayed = confirmed.map((m, i) => {
    const pub = m.articlePublishedAt ? new Date(m.articlePublishedAt) : null;
    const pubMs = pub && Number.isFinite(pub.getTime()) ? pub.getTime() : null;
    const pk = (m.publisherKey ?? '').trim().toLowerCase();
    return {
      score: calculateCuratedDepreciatedPriority(
        m.originalPriority,
        null,
        new Date(m.scrapedAt),
        null,
        pub,
      ).depreciatedPriority,
      pubMs,
      // Unknown publisher → unique synthetic key (degrades to the >=2-members rule).
      publisherKey: pk !== '' ? pk : `__unknown_${i}`,
    };
  });

  const validPubs = decayed.map((d) => d.pubMs).filter((t): t is number => t !== null);

  if (validPubs.length === 0) {
    // No published dates at all — treat all as core (current behaviour).
    return Math.max(...decayed.map((d) => d.score));
  }

  const windowMs = SAME_EVENT_WINDOW_HOURS * 3_600_000;

  // Greedy anchor-based event windows over members WITH a published date.
  // Sorted ascending; a new window opens when the member is published more
  // than one event window after the CURRENT window's anchor (its first
  // member). Anchor-based on purpose: chained gap-joining would let a <12h
  // syndication drip make every late joiner "core", reintroducing the bug
  // the late-joiner cap exists to prevent.
  const dated = decayed
    .filter((d): d is typeof d & { pubMs: number } => d.pubMs !== null)
    .sort((a, b) => a.pubMs - b.pubMs);
  type EventWindow = { anchorMs: number; scores: number[]; publishers: Set<string> };
  const windows: EventWindow[] = [];
  for (const d of dated) {
    const w = windows[windows.length - 1];
    if (w && d.pubMs - w.anchorMs <= windowMs) {
      w.scores.push(d.score);
      w.publishers.add(d.publisherKey);
    } else {
      windows.push({ anchorMs: d.pubMs, scores: [d.score], publishers: new Set([d.publisherKey]) });
    }
  }

  // Members with no published date are core per task spec (their decay already
  // ran off scrapedAt).
  const coreScores: number[] = decayed.filter((d) => d.pubMs === null).map((d) => d.score);
  coreScores.push(...windows[0].scores);

  // A later window is corroborated (uncapped) when >=2 members from >=2
  // distinct publishers published fresh together — a real new development.
  const corroboratedScores: number[] = [];
  const cappedWindowMaxes: number[] = [];
  for (const w of windows.slice(1)) {
    if (w.scores.length >= 2 && w.publishers.size >= 2) {
      corroboratedScores.push(...w.scores);
    } else {
      cappedWindowMaxes.push(Math.max(...w.scores));
    }
  }

  // Cooled base = the story's honest current heat: max decayed score across
  // core AND corroborated fresh-burst windows.
  const cooledBase = Math.max(
    coreScores.length > 0 ? Math.max(...coreScores) : 20,
    corroboratedScores.length > 0 ? Math.max(...corroboratedScores) : -Infinity,
  );

  if (cappedWindowMaxes.length === 0) {
    return cooledBase;
  }

  // Uncorroborated late windows may lift at most LATE_JOINER_LIFT_CAP above
  // the cooled base.
  const cappedLate = Math.min(Math.max(...cappedWindowMaxes), cooledBase + LATE_JOINER_LIFT_CAP);
  return Math.max(cooledBase, cappedLate);
}

/**
 * Freshest timestamp that may drive a cluster's effective date / pin decay.
 * Uses the exact same confirmed + ranking-authority boundary as P-score
 * aggregation so attached coverage can never make an older story look newly
 * updated.
 */
export function freshestRankingMemberAt(
  members: MemberScoreInput[],
): Date | null {
  let freshestMs = -Infinity;
  for (const member of members) {
    if (!member.confirmed || member.contributesToRanking === false) continue;
    const raw = member.articlePublishedAt ?? member.scrapedAt;
    const ms = raw ? new Date(raw).getTime() : NaN;
    if (Number.isFinite(ms)) freshestMs = Math.max(freshestMs, ms);
  }
  return Number.isFinite(freshestMs) ? new Date(freshestMs) : null;
}
