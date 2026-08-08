// =============================================================================
// Curated EPISODE lifecycle bound (Task #334).
//
// A single curated story IDENTITY (clusterId / archive signature) may represent
// at most ONE episode of this duration. Beyond it, a story that is still being
// reported rolls over to a NEW identity / archive episode instead of perpetually
// extending one multi-day row. This is the bound that makes a 5-day /
// 1,855-source zombie archive row impossible: the live clustering is a sliding
// recency window that, for a continuously-covered mega-story, never goes stale
// (its earliest member is always recent), so the per-pass staleness phase-out
// alone can never close it. The episode cap is an ABSOLUTE wall measured from
// the story's preserved origination (archive firstSeenAt), independent of the
// sliding member window.
//
// Shared by BOTH the clustering engine (stable-id reuse eligibility) AND the
// storage archive layer (carry-forward + normalize episode-boundary guards) so
// the two agree on exactly where one episode ends and the next begins. Curated
// lane only — never touches shared feeds or the public API.
//
// 60h (2.5 days) balances closure against continuity: long enough that a normal
// multi-day developing process (deal / ceasefire / summit, capped at 48h by the
// PHASEOUT_PROCESS ceiling) stays ONE episode, short enough that a perpetually
// covered story is forced to close and re-open as bounded successive episodes.
// =============================================================================
export const CURATED_EPISODE_HARD_AGE_H = 60;
export const CURATED_EPISODE_HARD_AGE_MS = CURATED_EPISODE_HARD_AGE_H * 60 * 60 * 1000;

// True when an episode that originated at `originationMs` is still within the
// episode window as of `nowMs`. A null/unknown origination returns true (treated
// as in-window) so a brand-new story with no archive row yet is never blocked.
export function isWithinEpisodeAge(
  originationMs: number | null | undefined,
  nowMs: number,
): boolean {
  if (originationMs == null) return true;
  return nowMs - originationMs <= CURATED_EPISODE_HARD_AGE_MS;
}

// Pure eligibility decision for stable-IDENTITY reuse (Task #334). A prior-pass
// clusterId may be RECLAIMED by a freshly formed story only when:
//   - the prior cluster survived this pass's staleness phase-out (keep), AND
//   - its episode has not exceeded the hard age cap (or has no archive row yet,
//     i.e. originationMs is null — allow, so first/second formation isn't churned).
// A phased-out OR over-age identity is surrendered, forcing the continuing story
// to mint a fresh signature → a new, bounded archive episode → the old episode
// goes not-live and closes. Exported (pure, no DB) for the regression gate.
export function isPriorIdentityReclaimable(opts: {
  keep: boolean;
  originationMs: number | null;
  nowMs: number;
}): boolean {
  if (!opts.keep) return false;
  return isWithinEpisodeAge(opts.originationMs, opts.nowMs);
}
