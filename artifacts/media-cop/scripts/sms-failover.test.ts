/**
 * scripts/sms-failover.test.ts — CI gate for the primary/backup Termux SMS
 * bridge failover (Task #773).
 *
 * Part 1 (always runs, no DB): exercises the pure decision logic in
 * server/smsFailoverLogic.ts — auto failover triggers, hysteresis/failback,
 * manual override, anti-flap spacing, claim-lease availability predicate,
 * inbound dedup keying, and the backward-compatible role parse.
 *
 * Part 2 (only when DATABASE_URL is set): a live claim-exclusivity check
 * against the dev sms_queue — inserts marker rows, claims them twice for the
 * two devices, asserts no row is handed out twice within the lease, then
 * cleans up its rows.
 *
 * Exit codes per the harness-reliability convention: 0 pass, 1 fail.
 */

import {
  decideSmsActiveRole, isDeviceAlive, isMessageAvailable, inboundDedupKey,
  PRIMARY_DOWN_MS, DEVICE_ALIVE_MS, PENDING_STUCK_MS, PENDING_STUCK_MAX_AGE_MS, PRIMARY_FAILURE_THRESHOLD,
  FAILBACK_STABLE_MS, MIN_SWITCH_INTERVAL_MS, CLAIM_LEASE_MS,
  type SmsRoleInput,
} from '../server/smsFailoverLogic';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const NOW = Date.now();

function baseInput(overrides: Partial<SmsRoleInput> = {}): SmsRoleInput {
  return {
    now: NOW,
    override: 'auto',
    currentActive: 'primary',
    primaryLastSeenMs: NOW - 5_000,
    backupLastSeenMs: NOW - 5_000,
    lastSwitchAtMs: null,
    primaryHealthySinceMs: NOW - 60 * 60 * 1000,
    oldestPendingAgeMs: null,
    primaryConsecutiveFailures: 0,
    ...overrides,
  };
}

console.log('[sms-failover] Part 1: pure decision logic');

// --- steady state ---
{
  const d = decideSmsActiveRole(baseInput());
  check('healthy primary stays active', d.active === 'primary' && !d.switched);
}

// --- failover: primary stops polling ---
{
  const d = decideSmsActiveRole(baseInput({ primaryLastSeenMs: NOW - PRIMARY_DOWN_MS - 1000 }));
  check('primary silent > down window → failover to backup', d.active === 'backup' && d.switched && (d.reason ?? '').includes('primary-not-polling'));
}

// --- failover blocked when backup is not alive ---
{
  const d = decideSmsActiveRole(baseInput({
    primaryLastSeenMs: NOW - PRIMARY_DOWN_MS - 1000,
    backupLastSeenMs: NOW - DEVICE_ALIVE_MS - 1000,
  }));
  check('no failover when backup is dead too', d.active === 'primary' && !d.switched);
}

// --- failover: stuck queue while primary nominally polls ---
{
  const d = decideSmsActiveRole(baseInput({ oldestPendingAgeMs: PENDING_STUCK_MS + 1000 }));
  check('stuck pending queue → failover', d.active === 'backup' && d.switched && (d.reason ?? '').includes('pending-stuck'));
  // Ancient garbage backlog must NOT count as a stuck queue (would flap forever).
  const stale = decideSmsActiveRole(baseInput({ oldestPendingAgeMs: PENDING_STUCK_MAX_AGE_MS + 1000 }));
  check('ancient pending backlog does NOT trigger failover', stale.active === 'primary' && !stale.switched);
}

// --- failover: consecutive send failures ---
{
  const d = decideSmsActiveRole(baseInput({ primaryConsecutiveFailures: PRIMARY_FAILURE_THRESHOLD }));
  check('repeated send failures → failover', d.active === 'backup' && d.switched && (d.reason ?? '').includes('primary-send-failures'));
  const d2 = decideSmsActiveRole(baseInput({ primaryConsecutiveFailures: PRIMARY_FAILURE_THRESHOLD - 1 }));
  check('failures below threshold do not fail over', d2.active === 'primary' && !d2.switched);
}

// --- anti-flap: min switch spacing ---
{
  const d = decideSmsActiveRole(baseInput({
    primaryLastSeenMs: NOW - PRIMARY_DOWN_MS - 1000,
    lastSwitchAtMs: NOW - MIN_SWITCH_INTERVAL_MS + 5000,
  }));
  check('switch suppressed within min switch interval', d.active === 'primary' && !d.switched);
}

// --- failback hysteresis ---
{
  const freshRecovery = decideSmsActiveRole(baseInput({
    currentActive: 'backup',
    primaryHealthySinceMs: NOW - FAILBACK_STABLE_MS + 30_000,
  }));
  check('freshly recovered primary does NOT get queue back yet (hysteresis)', freshRecovery.active === 'backup' && !freshRecovery.switched);

  const stable = decideSmsActiveRole(baseInput({
    currentActive: 'backup',
    primaryHealthySinceMs: NOW - FAILBACK_STABLE_MS - 1000,
  }));
  check('primary stable past hysteresis window → failback', stable.active === 'primary' && stable.switched && stable.reason === 'primary-recovered');
}

// --- backup dies while active, primary polling → immediate handback ---
{
  const d = decideSmsActiveRole(baseInput({
    currentActive: 'backup',
    backupLastSeenMs: NOW - DEVICE_ALIVE_MS - 1000,
    primaryHealthySinceMs: NOW - 10_000, // NOT yet stable
  }));
  check('backup lost + primary polling → immediate handback', d.active === 'primary' && d.switched && (d.reason ?? '').includes('backup-lost'));
}

// --- neither device alive: stay put (no thrash) ---
{
  const d = decideSmsActiveRole(baseInput({
    currentActive: 'backup',
    primaryLastSeenMs: NOW - PRIMARY_DOWN_MS - 1000,
    backupLastSeenMs: NOW - DEVICE_ALIVE_MS - 1000,
    primaryHealthySinceMs: null,
  }));
  check('both dead → no switch', d.active === 'backup' && !d.switched);
}

// --- manual override ---
{
  const forceBackup = decideSmsActiveRole(baseInput({ override: 'backup' }));
  check('override backup wins over healthy primary', forceBackup.active === 'backup' && forceBackup.switched);
  const forcePrimaryDead = decideSmsActiveRole(baseInput({
    override: 'primary',
    currentActive: 'backup',
    primaryLastSeenMs: null, // never seen — override still honored
  }));
  check('override primary honored even when primary looks down', forcePrimaryDead.active === 'primary' && forcePrimaryDead.switched);
  const overrideNoop = decideSmsActiveRole(baseInput({ override: 'primary' }));
  check('override matching current role is not a switch', overrideNoop.active === 'primary' && !overrideNoop.switched);
}

// --- isDeviceAlive ---
{
  check('isDeviceAlive null → false', !isDeviceAlive(null, NOW));
  check('isDeviceAlive fresh → true', isDeviceAlive(NOW - 1000, NOW));
  check('isDeviceAlive stale → false', !isDeviceAlive(NOW - DEVICE_ALIVE_MS - 1, NOW));
}

// --- claim-lease availability predicate ---
{
  check('unclaimed pending outbound is available',
    isMessageAvailable({ status: 'pending', direction: 'outbound', claimedAt: null }, NOW));
  check('freshly claimed row is NOT available',
    !isMessageAvailable({ status: 'pending', direction: 'outbound', claimedAt: new Date(NOW - 10_000) }, NOW));
  check('expired lease returns row to the pool',
    isMessageAvailable({ status: 'pending', direction: 'outbound', claimedAt: new Date(NOW - CLAIM_LEASE_MS - 1000) }, NOW));
  check('sent row never available',
    !isMessageAvailable({ status: 'sent', direction: 'outbound', claimedAt: null }, NOW));
  check('inbound row never available',
    !isMessageAvailable({ status: 'pending', direction: 'inbound', claimedAt: null }, NOW));
}

// --- inbound dedup key normalization ---
{
  check('dedup key normalizes formatting + country code',
    inboundDedupKey('+1 (555) 123-4567', 'What is the latest? ') === inboundDedupKey('5551234567', 'what is  the LATEST?'));
  check('different bodies produce different keys',
    inboundDedupKey('5551234567', 'question one') !== inboundDedupKey('5551234567', 'question two'));
  check('different senders produce different keys',
    inboundDedupKey('5551234567', 'same question') !== inboundDedupKey('5559876543', 'same question'));
}

async function part2Db(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('[sms-failover] Part 2 skipped: no DATABASE_URL');
    return;
  }
  console.log('[sms-failover] Part 2: live claim exclusivity (dev DB)');
  const { db } = await import('../server/db');
  const { sql } = await import('drizzle-orm');
  const { claimPendingMessages, parseDeviceRole } = await import('../server/smsBridge');

  check('parseDeviceRole: missing role → primary (backward compat)', parseDeviceRole(undefined) === 'primary');
  check('parseDeviceRole: junk → primary', parseDeviceRole('weird') === 'primary');
  check("parseDeviceRole: 'backup' → backup", parseDeviceRole('backup') === 'backup');

  const MARKER = '+19998887773'; // gate-only marker number, cleaned up below
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM sms_queue WHERE to_number = ${MARKER}`);
      // Keep gate markers inside one transaction so a live bridge poll cannot
      // claim them between insertion and the assertions below.
      await tx.execute(sql`
        INSERT INTO sms_queue (to_number, body, status, direction, created_at)
        VALUES (${MARKER}, 'gate test 1', 'pending', 'outbound', '1970-01-01'),
               (${MARKER}, 'gate test 2', 'pending', 'outbound', '1970-01-02'),
               (${MARKER}, 'gate test 3', 'pending', 'outbound', '1970-01-03')
      `);

      // Device A claims the 3 oldest (= the markers); device B must then get
      // none of the marker rows (they are leased to A).
      const first = await claimPendingMessages('primary', 3, Date.now(), tx);
      const firstMarkers = first.filter((m) => m.toNumber === MARKER);
      check('first claim picks up all 3 marker rows', firstMarkers.length === 3, `got ${firstMarkers.length}`);
      check('claimed rows stamped claimed_by=primary', firstMarkers.length > 0 && firstMarkers.every((m) => m.claimedBy === 'primary'));

      const second = await claimPendingMessages('backup', 3, Date.now(), tx);
      const secondMarkers = second.filter((m) => m.toNumber === MARKER);
      check('second claim gets ZERO marker rows (no double-send)', secondMarkers.length === 0, `got ${secondMarkers.length}`);

      // Simulate lease expiry: age the claim, then the backup can pick them up.
      await tx.execute(sql`
        UPDATE sms_queue SET claimed_at = NOW() - INTERVAL '10 minutes'
        WHERE to_number = ${MARKER} AND status = 'pending'
      `);
      const third = await claimPendingMessages('backup', 3, Date.now(), tx);
      const thirdMarkers = third.filter((m) => m.toNumber === MARKER);
      check('expired lease rows become claimable by the other device', thirdMarkers.length === 3, `got ${thirdMarkers.length}`);
      check('re-claimed rows stamped claimed_by=backup', thirdMarkers.every((m) => m.claimedBy === 'backup'));

      // Confirmed rows leave the pool entirely.
      await tx.execute(sql`UPDATE sms_queue SET status = 'sent', sent_at = NOW() WHERE to_number = ${MARKER}`);
      await tx.execute(sql`
        UPDATE sms_queue SET claimed_at = NOW() - INTERVAL '10 minutes'
        WHERE to_number = ${MARKER}
      `);
      const fourth = await claimPendingMessages('primary', 3, Date.now(), tx);
      check('sent rows are never re-claimed even after lease expiry',
        fourth.filter((m) => m.toNumber === MARKER).length === 0);

      await tx.execute(sql`DELETE FROM sms_queue WHERE to_number = ${MARKER}`);
    });
  } finally {
    try {
      await db.execute(sql`DELETE FROM sms_queue WHERE to_number = ${MARKER}`);
      console.log('[sms-failover] cleaned up marker rows');
    } catch (err) {
      console.error('[sms-failover] cleanup failed:', err);
    }
  }
}

await part2Db();

if (failures > 0) {
  console.error(`[sms-failover] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('[sms-failover] all checks passed');
process.exit(0);
