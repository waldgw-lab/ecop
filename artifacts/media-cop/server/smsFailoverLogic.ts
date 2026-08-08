/**
 * server/smsFailoverLogic.ts — PURE decision logic for the SMS bridge
 * primary/backup failover controller (Task #773).
 *
 * No database or environment imports on purpose: the CI gate
 * (scripts/sms-failover.test.ts) exercises these functions directly with
 * synthetic clocks. The runtime wiring lives in server/smsBridge.ts.
 */

export type SmsDeviceRole = 'primary' | 'backup';
export type SmsOverrideMode = 'auto' | 'primary' | 'backup';

// --- Tuning constants -------------------------------------------------------
// The bridge script polls every ~5s. All thresholds are deliberately generous
// multiples of that so a brief network blip never flips roles (hysteresis).

/** Primary considered DOWN when it hasn't polled for this long. */
export const PRIMARY_DOWN_MS = 2 * 60 * 1000;
/** A device counts as "alive enough to take over" if it polled this recently. */
export const DEVICE_ALIVE_MS = 90 * 1000;
/**
 * Failover also engages when the oldest deliverable outbound message has sat
 * unsent this long even though the primary is nominally polling (wedged
 * sender, SIM problem, etc.).
 */
export const PENDING_STUCK_MS = 3 * 60 * 1000;
/**
 * Stuck-queue signal only considers messages created within this window.
 * Ancient never-delivered rows (e.g. a backlog from a week the bridge was
 * off entirely) are garbage, not a liveness signal — without this bound they
 * would keep the failover controller flapping forever.
 */
export const PENDING_STUCK_MAX_AGE_MS = 60 * 60 * 1000;
/** Consecutive failed confirms from the primary that trigger failover. */
export const PRIMARY_FAILURE_THRESHOLD = 3;
/**
 * Failback hysteresis: the primary must have been polling healthily,
 * continuously, for this long before the queue is handed back.
 */
export const FAILBACK_STABLE_MS = 3 * 60 * 1000;
/** Minimum spacing between automatic role switches (anti-flap). */
export const MIN_SWITCH_INTERVAL_MS = 60 * 1000;
/**
 * Claim lease: a fetched-but-never-confirmed message returns to pending after
 * this long so the (possibly different) active device can retry it.
 */
export const CLAIM_LEASE_MS = 2 * 60 * 1000;
/** Inbound dedup window: identical from+body within this window is a dup. */
export const INBOUND_DEDUP_WINDOW_MS = 5 * 60 * 1000;

export interface SmsRoleInput {
  now: number;
  override: SmsOverrideMode;
  currentActive: SmsDeviceRole;
  /** ms epoch of each device's last poll, or null if never seen. */
  primaryLastSeenMs: number | null;
  backupLastSeenMs: number | null;
  /** ms epoch of the last automatic/manual role switch, or null. */
  lastSwitchAtMs: number | null;
  /**
   * ms epoch marking the start of the primary's CURRENT continuous healthy
   * streak (maintained by the caller; null when primary is not healthy).
   */
  primaryHealthySinceMs: number | null;
  /** Age (ms) of the oldest deliverable outbound message, or null if none. */
  oldestPendingAgeMs: number | null;
  /** Consecutive success:false confirms from the primary since its last success. */
  primaryConsecutiveFailures: number;
}

export interface SmsRoleDecision {
  active: SmsDeviceRole;
  switched: boolean;
  /** Human-readable reason, set only when switched. */
  reason: string | null;
}

export function isDeviceAlive(lastSeenMs: number | null, now: number, windowMs: number = DEVICE_ALIVE_MS): boolean {
  return lastSeenMs !== null && now - lastSeenMs < windowMs;
}

/**
 * Decide which device should be receiving the SMS queue right now.
 * Pure function — all state comes in via the input.
 */
export function decideSmsActiveRole(input: SmsRoleInput): SmsRoleDecision {
  const {
    now, override, currentActive,
    primaryLastSeenMs, backupLastSeenMs,
    lastSwitchAtMs, primaryHealthySinceMs,
    oldestPendingAgeMs, primaryConsecutiveFailures,
  } = input;

  // Manual override always wins — no hysteresis, no aliveness checks. The
  // user explicitly forced a device; honor it even if it looks down.
  if (override === 'primary' || override === 'backup') {
    return {
      active: override,
      switched: currentActive !== override,
      reason: currentActive !== override ? `manual-override:${override}` : null,
    };
  }

  const primaryHealthy = isDeviceAlive(primaryLastSeenMs, now, PRIMARY_DOWN_MS);
  const backupAlive = isDeviceAlive(backupLastSeenMs, now, DEVICE_ALIVE_MS);
  const switchAllowed = lastSwitchAtMs === null || now - lastSwitchAtMs >= MIN_SWITCH_INTERVAL_MS;

  if (currentActive === 'primary') {
    // Reasons the primary is considered unable to deliver:
    const reasons: string[] = [];
    if (!primaryHealthy) reasons.push('primary-not-polling');
    // Stuck queue: old enough to prove the sender is wedged, but recent
    // enough to be a real live message (see PENDING_STUCK_MAX_AGE_MS).
    if (
      oldestPendingAgeMs !== null &&
      oldestPendingAgeMs >= PENDING_STUCK_MS &&
      oldestPendingAgeMs < PENDING_STUCK_MAX_AGE_MS
    ) reasons.push('pending-stuck');
    if (primaryConsecutiveFailures >= PRIMARY_FAILURE_THRESHOLD) reasons.push('primary-send-failures');

    // Only fail over when the backup is actually there to catch the queue.
    if (reasons.length > 0 && backupAlive && switchAllowed) {
      return { active: 'backup', switched: true, reason: reasons.join('+') };
    }
    return { active: 'primary', switched: false, reason: null };
  }

  // currentActive === 'backup'
  // Failback requires the primary to be CONTINUOUSLY healthy for the
  // hysteresis window — a single fresh poll after an outage is not enough.
  const primaryStableLongEnough =
    primaryHealthy &&
    primaryHealthySinceMs !== null &&
    now - primaryHealthySinceMs >= FAILBACK_STABLE_MS;

  if (primaryStableLongEnough && switchAllowed) {
    return { active: 'primary', switched: true, reason: 'primary-recovered' };
  }

  // Backup died while active and the primary is at least polling: hand back
  // immediately (some deliverer is better than none). Bypasses the stability
  // window but still respects the min-switch spacing.
  if (!backupAlive && primaryHealthy && switchAllowed) {
    return { active: 'primary', switched: true, reason: 'backup-lost+primary-polling' };
  }

  return { active: 'backup', switched: false, reason: null };
}

/**
 * Availability predicate for a queue row under claim/lease semantics.
 * A row is deliverable when it's an outbound pending row whose claim (if any)
 * has expired. Mirrors the SQL used by claimPendingMessages — keep in sync.
 */
export function isMessageAvailable(
  row: { status: string; direction: string; claimedAt: Date | null },
  now: number,
  leaseMs: number = CLAIM_LEASE_MS,
): boolean {
  if (row.status !== 'pending' || row.direction !== 'outbound') return false;
  if (row.claimedAt === null) return true;
  return now - row.claimedAt.getTime() >= leaseMs;
}

/** Normalize an inbound SMS into a dedup key (from+body within window). */
export function inboundDedupKey(from: string, body: string): string {
  const num = from.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const text = body.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${num}|${text}`;
}
