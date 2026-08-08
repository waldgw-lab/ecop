// Truth Social relay outage report (originally Task #1020).
//
// The SMS escalation ("MCOP SYSTEM ALERT: Truth Social relay DOWN/RESTORED"
// texts to all active subscribers) was removed at the user's request. What
// remains is the silent, read-only outage report: the Team page Coverage tab
// reads getTruthRelayOutageReport() to render a prominent "relay DOWN /
// fallback active" banner. It is derived live from the relay heartbeat
// (server/truthSocialService.ts) so it clears automatically on recovery.
//
// Read-only with respect to the relay itself: this module never restarts
// anything, never sends SMS, and never touches RELAY_STALE_THRESHOLD.

import { getRelayHeartbeat } from './truthSocialService';
import type { IStorage } from './storage';

export const TRUTH_RELAY_OUTAGE_THRESHOLD_MS = 45 * 60 * 1000;

// Injectable seams for tests (ESM module imports are read-only).
export const relayOutageDeps = {
  getHeartbeat: (): number => getRelayHeartbeat(),
  now: (): number => Date.now(),
};

export interface RelayOutageReport {
  /** Heartbeat stale past the outage threshold — drives the Coverage banner. */
  active: boolean;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  thresholdMs: number;
  /** Fallback scraper freshness (scrape metadata), so the banner can attest coverage. */
  fallbackLastRunAt: string | null;
  fallbackFresh: boolean;
}

/**
 * Live outage status for the Coverage tab banner. Derived from the in-memory
 * heartbeat on every call, so the banner clears automatically on recovery.
 */
export async function getTruthRelayOutageReport(storage: IStorage): Promise<RelayOutageReport> {
  const now = relayOutageDeps.now();
  const hb = relayOutageDeps.getHeartbeat();
  const hbAge = hb > 0 ? now - hb : null;
  const active = hbAge !== null && hbAge >= TRUTH_RELAY_OUTAGE_THRESHOLD_MS;

  let fallbackLastRunAt: Date | null = null;
  try {
    const meta = await storage.getScrapeMetadata();
    fallbackLastRunAt = meta?.truthSocialLastScrapeTime ? new Date(meta.truthSocialLastScrapeTime) : null;
  } catch {
    fallbackLastRunAt = null;
  }
  // Scrapers run on the ~10-min cron; <25 min matches pipelineHealth's freshness bar.
  const fallbackFresh = fallbackLastRunAt !== null && now - fallbackLastRunAt.getTime() < 25 * 60 * 1000;

  return {
    active,
    heartbeatAt: hb > 0 ? new Date(hb).toISOString() : null,
    heartbeatAgeMs: hbAge,
    thresholdMs: TRUTH_RELAY_OUTAGE_THRESHOLD_MS,
    fallbackLastRunAt: fallbackLastRunAt ? fallbackLastRunAt.toISOString() : null,
    fallbackFresh,
  };
}
