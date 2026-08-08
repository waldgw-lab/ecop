// =============================================================================
// Curated auto-reshape dispatcher (Task #430 follow-up) — DORMANT BY DEFAULT.
//
// Automation-first self-healing for the Curated lane. When CURATED_AUTO_RESHAPE
// is enabled, cheap DETERMINISTIC re-shapes (reshapeCuratedLane) are fired —
// debounced + coalesced — off the signals that actually make the visible curated
// lane wrong (new source ingested, plus a periodic backstop), so the lane heals
// itself BETWEEN the scheduled full clustering passes instead of waiting for the
// next cron tick or for an editor to notice and click "Re-cluster".
//
// The re-shape it triggers reuses the previous pass's grouping and skips every
// expensive LLM pass, so it carries ZERO new AI cost and re-runs only the
// deterministic stages (representative/"face" re-selection, decay/age-out,
// identical-title syndication merge, archive carry-forward). It routes through
// the SAME single in-flight guard (isClusteringRunning) as the cron + manual
// full pass, so it can never overlap them.
//
// CURATED-LANE ONLY: the re-shape writes solely to curated_cluster_members and
// never touches the main/Classic/Visual/custom-MCOP feeds or the public API.
//
// FLAG OFF (default) = pure no-op: this module ships SHELVED and changes nothing
// about live behavior until the flag is explicitly turned on.
//
// NOTE: deliberately NOT wired into the generic curated cache invalidator — a
// re-shape invalidates that cache on success, so hooking the invalidator would
// create a reshape -> invalidate -> reshape feedback loop. Triggers are placed
// at explicit semantic sites instead.
// =============================================================================
import { invalidateCuratedReadCache } from './curatedCacheBus';

// Coalesce a burst of signals into ONE re-shape. Long enough to absorb an
// ingest/enrichment burst, short enough to feel responsive between full passes.
const DEBOUNCE_MS = 45_000;
// If the single in-flight guard is busy (a full cron/manual pass is running),
// re-arm after this delay so the requested re-shape isn't lost behind it.
const RETRY_MS = 60_000;
// Bound the re-arming so a permanently-busy guard can never spin forever.
const MAX_REARMS = 3;

let timer: ReturnType<typeof setTimeout> | null = null;
const pendingReasons = new Set<string>();
let rearms = 0;

/** Feature flag — default OFF. The whole capability ships shelved behind this. */
export function isCuratedAutoReshapeEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((process.env.CURATED_AUTO_RESHAPE ?? '').trim());
}

/**
 * Request a debounced curated re-shape. Safe to call from any hot path: when the
 * flag is OFF it returns immediately, and when ON it merely coalesces into a
 * single pending timer. Never throws.
 */
export function requestCuratedReshape(reason: string): void {
  if (!isCuratedAutoReshapeEnabled()) return; // shelved → no-op
  pendingReasons.add(reason);
  if (timer) return; // already armed; this signal coalesces into the pending run
  timer = setTimeout(fire, DEBOUNCE_MS);
}

async function fire(): Promise<void> {
  timer = null;
  const reasons = Array.from(pendingReasons);
  pendingReasons.clear();
  // Re-check the flag at fire time — it may have been turned off during the
  // debounce window.
  if (!isCuratedAutoReshapeEnabled()) {
    rearms = 0;
    return;
  }
  try {
    // Dynamic import keeps this module free of a static curatedCluster dependency
    // (avoids an import cycle: curatedCluster never imports this dispatcher).
    const { reshapeCuratedLane } = await import('./curatedCluster');
    const res = await reshapeCuratedLane();
    if (res.skipped) {
      // A full pass (cron / manual) or another re-shape held the single guard.
      // Re-arm once (bounded) so this re-shape isn't lost behind a long pass.
      if (rearms < MAX_REARMS) {
        rearms++;
        for (const r of reasons) pendingReasons.add(r);
        if (!timer) timer = setTimeout(fire, RETRY_MS);
      } else {
        rearms = 0;
      }
      return;
    }
    rearms = 0;
    // Reflect the new grouping on the next read. CURATED read cache ONLY — never
    // the main feeds (curated isolation is the hard invariant).
    invalidateCuratedReadCache('top-stories');
    invalidateCuratedReadCache('cluster-members');
    console.log(
      `[CuratedAutoReshape] re-shaped — stories: ${res.stories}, members: ${res.members} ` +
        `(reasons: ${reasons.join(', ')})`,
    );
  } catch (err) {
    rearms = 0;
    console.warn(
      '[CuratedAutoReshape] re-shape failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
}
