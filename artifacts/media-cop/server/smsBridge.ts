/**
 * server/smsBridge.ts — runtime controller for the primary/backup Termux SMS
 * bridge failover (Task #773).
 *
 * Responsibilities:
 *  - Track per-device heartbeats (in-memory fast path + throttled persist to
 *    relay_heartbeats so state survives a redeploy — same pattern as the
 *    Truth Social / X relay heartbeats).
 *  - Decide which device is ACTIVE on every /pending poll via the pure
 *    decision logic in server/smsFailoverLogic.ts (auto down-detection,
 *    hysteresis, auto failback, manual override).
 *  - Claim/lease semantics for outbound messages so the two phones can never
 *    double-send the same message.
 *  - Inbound dedup (same from+body within a window) so a question texted to
 *    both SIMs only gets one MCOP Bot reply.
 *
 * The decision logic itself is pure and lives in smsFailoverLogic.ts; this
 * module owns all the stateful/database wiring.
 */

import { sql as dsql, eq, desc } from 'drizzle-orm';
import { db } from './db';
import {
  smsQueue, smsBridgeState, smsFailoverEvents, relayHeartbeats,
  type SmsQueueMessage, type SmsFailoverEvent,
} from '@shared/schema';
import {
  decideSmsActiveRole, isDeviceAlive, inboundDedupKey,
  CLAIM_LEASE_MS, INBOUND_DEDUP_WINDOW_MS, PRIMARY_DOWN_MS, PENDING_STUCK_MAX_AGE_MS,
  type SmsDeviceRole, type SmsOverrideMode,
} from './smsFailoverLogic';

// Heartbeat persistence keys in the shared relay_heartbeats table.
const HB_KEY: Record<SmsDeviceRole, string> = {
  primary: 'sms-bridge-primary',
  backup: 'sms-bridge-backup',
};
// Throttle heartbeat DB writes — the phones poll every ~5s and we don't need
// sub-30s persistence granularity (it only matters across restarts).
const HB_PERSIST_INTERVAL_MS = 30 * 1000;

interface BridgeRuntime {
  initialized: boolean;
  lastSeen: Record<SmsDeviceRole, number | null>;
  lastPersisted: Record<SmsDeviceRole, number>;
  activeDevice: SmsDeviceRole;
  override: SmsOverrideMode;
  lastSwitchAtMs: number | null;
  /** Start of the primary's current continuous healthy streak (for failback hysteresis). */
  primaryHealthySinceMs: number | null;
  primaryConsecutiveFailures: number;
  /** Inbound dedup: key -> last-seen ms epoch. */
  inboundSeen: Map<string, number>;
}

const state: BridgeRuntime = {
  initialized: false,
  lastSeen: { primary: null, backup: null },
  lastPersisted: { primary: 0, backup: 0 },
  activeDevice: 'primary',
  override: 'auto',
  lastSwitchAtMs: null,
  primaryHealthySinceMs: null,
  primaryConsecutiveFailures: 0,
  inboundSeen: new Map(),
};

export function parseDeviceRole(raw: unknown): SmsDeviceRole {
  // Backward compatible: an old bridge script that sends no role IS the primary.
  return raw === 'backup' ? 'backup' : 'primary';
}

/** Restore persisted heartbeats + controller state. Await before serving polls. */
export async function initSmsBridge(): Promise<void> {
  if (state.initialized) return;
  try {
    for (const role of ['primary', 'backup'] as SmsDeviceRole[]) {
      const [row] = await db.select().from(relayHeartbeats).where(eq(relayHeartbeats.relay, HB_KEY[role]));
      if (row?.lastHeartbeatAt) state.lastSeen[role] = row.lastHeartbeatAt.getTime();
    }
    const [persisted] = await db.select().from(smsBridgeState).where(eq(smsBridgeState.id, 'global'));
    if (persisted) {
      state.activeDevice = persisted.activeDevice === 'backup' ? 'backup' : 'primary';
      state.override = (['auto', 'primary', 'backup'] as const).includes(persisted.overrideMode as any)
        ? (persisted.overrideMode as SmsOverrideMode)
        : 'auto';
      state.lastSwitchAtMs = persisted.lastSwitchAt ? persisted.lastSwitchAt.getTime() : null;
    }
  } catch (err) {
    console.error('[sms-bridge] failed to restore persisted state (continuing with defaults):', err);
  }
  state.initialized = true;
}

async function persistHeartbeat(role: SmsDeviceRole, at: Date): Promise<void> {
  await db.insert(relayHeartbeats)
    .values({ relay: HB_KEY[role], lastHeartbeatAt: at, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: relayHeartbeats.relay,
      set: { lastHeartbeatAt: at, updatedAt: new Date() },
    });
}

async function persistControllerState(): Promise<void> {
  await db.insert(smsBridgeState)
    .values({
      id: 'global',
      overrideMode: state.override,
      activeDevice: state.activeDevice,
      lastSwitchAt: state.lastSwitchAtMs ? new Date(state.lastSwitchAtMs) : null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: smsBridgeState.id,
      set: {
        overrideMode: state.override,
        activeDevice: state.activeDevice,
        lastSwitchAt: state.lastSwitchAtMs ? new Date(state.lastSwitchAtMs) : null,
        updatedAt: new Date(),
      },
    });
}

/** Record that a device just polled. Throttled persist to the DB. */
export async function recordBridgePoll(role: SmsDeviceRole, now: number = Date.now()): Promise<void> {
  await initSmsBridge();
  state.lastSeen[role] = now;
  if (now - state.lastPersisted[role] >= HB_PERSIST_INTERVAL_MS) {
    state.lastPersisted[role] = now;
    persistHeartbeat(role, new Date(now)).catch((err) =>
      console.error(`[sms-bridge] heartbeat persist failed (${role}):`, err));
  }
}

/**
 * Age (ms) of the oldest RECENT deliverable outbound message, or null when
 * the recent queue is clear. Bounded to PENDING_STUCK_MAX_AGE_MS so an
 * ancient undelivered backlog can't permanently trip the stuck-queue trigger.
 */
async function getOldestDeliverableAgeMs(now: number): Promise<number | null> {
  const rows = await db.execute(dsql`
    SELECT created_at FROM sms_queue
    WHERE status = 'pending' AND direction = 'outbound'
      AND created_at > ${new Date(now - PENDING_STUCK_MAX_AGE_MS)}
      AND (claimed_at IS NULL OR claimed_at < ${new Date(now - CLAIM_LEASE_MS)})
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const createdAt = (rows.rows[0] as any)?.created_at;
  if (!createdAt) return null;
  return now - new Date(createdAt).getTime();
}

/**
 * Evaluate the failover controller. Called on every /pending poll (cheap:
 * one small query + pure logic). Applies + persists any role switch, logging
 * it to sms_failover_events.
 */
export async function evaluateActiveDevice(now: number = Date.now()): Promise<SmsDeviceRole> {
  await initSmsBridge();

  // Maintain the primary's continuous-healthy streak for failback hysteresis.
  const primaryHealthy = isDeviceAlive(state.lastSeen.primary, now, PRIMARY_DOWN_MS);
  if (primaryHealthy) {
    if (state.primaryHealthySinceMs === null) state.primaryHealthySinceMs = now;
  } else {
    state.primaryHealthySinceMs = null;
  }

  let oldestPendingAgeMs: number | null = null;
  try {
    oldestPendingAgeMs = await getOldestDeliverableAgeMs(now);
  } catch (err) {
    console.error('[sms-bridge] oldest-pending probe failed (treating as none):', err);
  }

  const decision = decideSmsActiveRole({
    now,
    override: state.override,
    currentActive: state.activeDevice,
    primaryLastSeenMs: state.lastSeen.primary,
    backupLastSeenMs: state.lastSeen.backup,
    lastSwitchAtMs: state.lastSwitchAtMs,
    primaryHealthySinceMs: state.primaryHealthySinceMs,
    oldestPendingAgeMs,
    primaryConsecutiveFailures: state.primaryConsecutiveFailures,
  });

  if (decision.switched) {
    const from = state.activeDevice;
    state.activeDevice = decision.active;
    state.lastSwitchAtMs = now;
    if (decision.active === 'primary') state.primaryConsecutiveFailures = 0;
    console.log(`[sms-bridge] ACTIVE DEVICE SWITCH: ${from} -> ${decision.active} (${decision.reason})`);
    try {
      await db.insert(smsFailoverEvents).values({
        fromDevice: from,
        toDevice: decision.active,
        reason: decision.reason ?? 'unknown',
      });
      await persistControllerState();
    } catch (err) {
      console.error('[sms-bridge] failed to persist role switch:', err);
    }
  }
  return state.activeDevice;
}

/**
 * Atomically claim up to `limit` deliverable outbound messages for a device.
 * FOR UPDATE SKIP LOCKED guarantees two concurrent polls can never claim the
 * same row; the lease (CLAIM_LEASE_MS) returns unconfirmed rows to the pool.
 */
export async function claimPendingMessages(
  role: SmsDeviceRole,
  limit: number = 20,
  now: number = Date.now(),
  executor: Pick<typeof db, 'execute'> = db,
): Promise<SmsQueueMessage[]> {
  const leaseCutoff = new Date(now - CLAIM_LEASE_MS);
  const result = await executor.execute(dsql`
    UPDATE sms_queue SET claimed_by = ${role}, claimed_at = ${new Date(now)}
    WHERE id IN (
      SELECT id FROM sms_queue
      WHERE status = 'pending' AND direction = 'outbound'
        AND (claimed_at IS NULL OR claimed_at < ${leaseCutoff})
      ORDER BY created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, to_number, body, status, direction, created_at, sent_at, error, claimed_by, claimed_at
  `);
  return result.rows.map((r: any) => ({
    id: r.id,
    toNumber: r.to_number,
    body: r.body,
    status: r.status,
    direction: r.direction,
    createdAt: r.created_at ? new Date(r.created_at) : null,
    sentAt: r.sent_at ? new Date(r.sent_at) : null,
    error: r.error,
    claimedBy: r.claimed_by,
    claimedAt: r.claimed_at ? new Date(r.claimed_at) : null,
  })) as SmsQueueMessage[];
}

/** Track confirm outcomes for the failure-based failover trigger. */
export function noteConfirmResult(role: SmsDeviceRole, success: boolean): void {
  if (role !== 'primary') return;
  if (success) {
    state.primaryConsecutiveFailures = 0;
  } else {
    state.primaryConsecutiveFailures += 1;
  }
}

/**
 * Inbound dedup: true when the same from+body was already processed within
 * the dedup window (both phones forwarding the same inbound SIM copy, or the
 * same phone re-listing an SMS it already forwarded).
 * In-memory only — single-instance VM deploy (see cache/deploy topology memo).
 */
export function isDuplicateInbound(from: string, body: string, now: number = Date.now()): boolean {
  const key = inboundDedupKey(from, body);
  // Opportunistic sweep so the map can't grow unbounded.
  if (state.inboundSeen.size > 500) {
    for (const [k, ts] of state.inboundSeen) {
      if (now - ts >= INBOUND_DEDUP_WINDOW_MS) state.inboundSeen.delete(k);
    }
  }
  const prev = state.inboundSeen.get(key);
  state.inboundSeen.set(key, now);
  return prev !== undefined && now - prev < INBOUND_DEDUP_WINDOW_MS;
}

/** Set the manual override (auto | primary | backup), persisted. */
export async function setBridgeOverride(mode: SmsOverrideMode): Promise<void> {
  await initSmsBridge();
  state.override = mode;
  // Apply immediately so the very next poll reflects the override.
  await evaluateActiveDevice();
  await persistControllerState();
}

export interface SmsBridgeStatus {
  activeDevice: SmsDeviceRole;
  override: SmsOverrideMode;
  primaryLastSeen: string | null;
  backupLastSeen: string | null;
  primaryAlive: boolean;
  backupAlive: boolean;
  primaryConsecutiveFailures: number;
  lastSwitchAt: string | null;
  recentEvents: { fromDevice: string; toDevice: string; reason: string; createdAt: string }[];
}

/** Snapshot for the admin SMS status surface. */
export async function getBridgeStatus(now: number = Date.now()): Promise<SmsBridgeStatus> {
  await initSmsBridge();
  let recent: SmsFailoverEvent[] = [];
  try {
    recent = await db.select().from(smsFailoverEvents)
      .orderBy(desc(smsFailoverEvents.createdAt)).limit(10);
  } catch (err) {
    console.error('[sms-bridge] failed to read failover events:', err);
  }
  return {
    activeDevice: state.activeDevice,
    override: state.override,
    primaryLastSeen: state.lastSeen.primary ? new Date(state.lastSeen.primary).toISOString() : null,
    backupLastSeen: state.lastSeen.backup ? new Date(state.lastSeen.backup).toISOString() : null,
    // Alive thresholds mirror the controller's own eligibility rules so the
    // admin panel never shows a device as "alive" that the controller would
    // not treat as such: primary is declared down after PRIMARY_DOWN_MS;
    // the backup must satisfy the stricter takeover window DEVICE_ALIVE_MS.
    primaryAlive: isDeviceAlive(state.lastSeen.primary, now, PRIMARY_DOWN_MS),
    backupAlive: isDeviceAlive(state.lastSeen.backup, now),
    primaryConsecutiveFailures: state.primaryConsecutiveFailures,
    lastSwitchAt: state.lastSwitchAtMs ? new Date(state.lastSwitchAtMs).toISOString() : null,
    recentEvents: recent.map((e) => ({
      fromDevice: e.fromDevice,
      toDevice: e.toDevice,
      reason: e.reason,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}
