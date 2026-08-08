import { db } from './db';
import { appFlags } from '@shared/schema';
import { eq } from 'drizzle-orm';

// Main-feed headline clustering defaults ON in memory. It used to be in-memory
// only (reset to default on every restart/redeploy) which meant an admin's
// saved state was silently lost on boot. The toggles are now persisted to the
// single-row app_flags table and restored at boot via restoreClusteringFlags(),
// mirroring the Watch Topic steering pattern in watchTopicMatcher.ts.
let clusteringEnabled = true;
let topicClusteringEnabled = true;
let joePriorityMatchingEnabled = true;
// Same-event consolidation cross-group merging (unified union-find lane, see
// buildSameEventMergeComponents in server/curatedCluster.ts). This REPLACED two
// formerly-UNCONDITIONAL lanes (body-aware fuzzy missed-merge + cross-cluster
// same-event reconcile), so it is a KILL SWITCH defaulting ON — flag OFF
// degrades the lane to legacy standalone-only fuzzy merging (no group-involving
// merges). Persisted in app_flags so an admin OFF survives restarts.
let curatedMissedMergeReconcileEnabled = true;

// Joe Priority/BOLO matching runs inside the ~10-min full-scrape cycle. Gate it
// to a deliberate cadence so it doesn't spend AI calls on every single cycle.
const JOE_PRIORITY_MIN_INTERVAL_MS = 30 * 60 * 1000; // at most once per 30 min
let joePriorityLastRunAt = 0;

export function isClusteringEnabled(): boolean {
  return clusteringEnabled;
}

export function setClusteringEnabled(enabled: boolean): void {
  clusteringEnabled = enabled;
  console.log(`[ClusterConfig] Auto-clustering ${enabled ? 'enabled' : 'disabled'}`);
}

export function isTopicClusteringEnabled(): boolean {
  return topicClusteringEnabled;
}

export function setTopicClusteringEnabled(enabled: boolean): void {
  topicClusteringEnabled = enabled;
  console.log(`[ClusterConfig] Topic clustering ${enabled ? 'enabled' : 'disabled'}`);
}

// Restore the persisted clustering toggles from the database at boot,
// mirroring restoreWatchTopicSteering. Must be awaited before the scheduler
// starts so the first scrape cycle sees the saved state instead of the
// defaults. Fail-open: on error the in-memory defaults (both ON) are kept.
export async function restoreClusteringFlags(): Promise<void> {
  try {
    const [row] = await db.select().from(appFlags).where(eq(appFlags.id, 'global'));
    if (row) {
      clusteringEnabled = row.clusteringEnabled;
      topicClusteringEnabled = row.topicClusteringEnabled;
      joePriorityMatchingEnabled = row.joePriorityMatchingEnabled;
      curatedMissedMergeReconcileEnabled = row.curatedMissedMergeReconcileEnabled;
      console.log(`[ClusterConfig] Restored persisted flags: clustering=${clusteringEnabled ? 'ENABLED' : 'disabled'}, topicClustering=${topicClusteringEnabled ? 'ENABLED' : 'disabled'}, joePriorityMatching=${joePriorityMatchingEnabled ? 'ENABLED' : 'disabled'}, curatedMissedMergeReconcile=${curatedMissedMergeReconcileEnabled ? 'ENABLED' : 'disabled'}`);
    }
  } catch (err) {
    console.error('[ClusterConfig] Failed to restore clustering flags (continuing with defaults ON):', err);
  }
}

// Write the current clustering state to the database so it survives restarts.
export async function persistClusteringEnabled(enabled: boolean): Promise<void> {
  await db.insert(appFlags)
    .values({ id: 'global', clusteringEnabled: enabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appFlags.id,
      set: { clusteringEnabled: enabled, updatedAt: new Date() },
    });
}

// Write the current topic-clustering state to the database so it survives restarts.
export async function persistTopicClusteringEnabled(enabled: boolean): Promise<void> {
  await db.insert(appFlags)
    .values({ id: 'global', topicClusteringEnabled: enabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appFlags.id,
      set: { topicClusteringEnabled: enabled, updatedAt: new Date() },
    });
}

// Write the current Joe Priority/BOLO matching state to the database so it
// survives restarts.
export async function persistJoePriorityMatchingEnabled(enabled: boolean): Promise<void> {
  await db.insert(appFlags)
    .values({ id: 'global', joePriorityMatchingEnabled: enabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appFlags.id,
      set: { joePriorityMatchingEnabled: enabled, updatedAt: new Date() },
    });
}

export function isJoePriorityMatchingEnabled(): boolean {
  return joePriorityMatchingEnabled;
}

// --- Same-event duplicate reconciliation (curated one-merge-per-pass) ---------
export function isCuratedMissedMergeReconcileEnabled(): boolean {
  return curatedMissedMergeReconcileEnabled;
}

export function setCuratedMissedMergeReconcileEnabled(enabled: boolean): void {
  curatedMissedMergeReconcileEnabled = enabled;
  console.log(`[ClusterConfig] Curated missed-merge reconciliation ${enabled ? 'enabled' : 'disabled'}`);
}

// Write the current reconciliation state so it survives restarts.
export async function persistCuratedMissedMergeReconcileEnabled(enabled: boolean): Promise<void> {
  await db.insert(appFlags)
    .values({ id: 'global', curatedMissedMergeReconcileEnabled: enabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appFlags.id,
      set: { curatedMissedMergeReconcileEnabled: enabled, updatedAt: new Date() },
    });
}

export function setJoePriorityMatchingEnabled(enabled: boolean): void {
  joePriorityMatchingEnabled = enabled;
  console.log(`[ClusterConfig] Joe Priority/BOLO auto-matching ${enabled ? 'enabled' : 'disabled'}`);
}

// True only when matching is enabled AND the minimum cadence interval has elapsed
// since the last run. Lets the scheduler call this every scrape cycle while the
// matcher itself only does AI work on a deliberate cadence.
export function shouldRunJoePriorityMatching(): boolean {
  if (!joePriorityMatchingEnabled) return false;
  return Date.now() - joePriorityLastRunAt >= JOE_PRIORITY_MIN_INTERVAL_MS;
}

export function markJoePriorityMatchingRan(): void {
  joePriorityLastRunAt = Date.now();
}
