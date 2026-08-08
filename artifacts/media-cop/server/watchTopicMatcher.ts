import { db } from './db';
import { teamSubjects, appFlags } from '@shared/schema';
import { and, eq, or, isNull, gt } from 'drizzle-orm';
import { compileWatchTopic, hasKeywordGate, type CompiledWatchTopic } from './watchTopicMatchCore';

// ---------------------------------------------------------------------------
// Deterministic "watch topic" steering for the scrape hot path.
//
// A watch topic (team_subjects with isPriorityWatch / isBoloWatch flags + AI-
// extracted watchKeywords) can:
//   • Priority: nudge a matched headline's base priority score upward.
//   • BOLO:     rescue a matched headline that the relevance filter would drop.
//
// This module is intentionally AI-free (it runs synchronously inside the scrape
// filter loops), performs NO writes, and imports NOTHING from the curated lane.
//
// The pure matching logic (compile/match/boost/budget) lives in
// ./watchTopicMatchCore — dependency-free so migrate.ts and the CI gate can use
// the EXACT same gate without importing the shared db. This module re-exports
// it, so consumers keep importing everything from here.
// ---------------------------------------------------------------------------

export {
  compileWatchTopic,
  hasKeywordGate,
  matchesTopic,
  matchWatchTopics,
  createRescueBudget,
  applyPriorityBoost,
  applyPriorityBoostWithStrength,
  normalize,
} from './watchTopicMatchCore';
export type { CompiledWatchTopic, WatchTopicSource, WatchMatch, RescueBudget, CompiledBoolTerm } from './watchTopicMatchCore';

// Dark-launch flag. In-memory + default OFF => fail-closed: a redeploy leaves
// steering off until an admin re-enables it, so the sensitive ingest/scoring
// changes never fire in production until the owner opts in. (The separate AI
// tagging matcher is gated independently by isJoePriorityMatchingEnabled.)
let steeringEnabled = false;

export function isWatchTopicSteeringEnabled(): boolean {
  return steeringEnabled;
}

// CURATED-ONLY SCOPE (user directive, 2026-07-15): watch-topic steering may
// only impact the CURATED view for now. Main-feed paths (Drudge scraper,
// RSS bots) must gate on THIS check instead of isWatchTopicSteeringEnabled,
// so even with the admin flag ON, steering never changes main-feed scores or
// rescues items into main-feed surfaces. Flip the constant to true to
// re-enable main-feed steering later (one line, no rewiring).
const MAIN_FEED_STEERING_ENABLED = false;

export function isMainFeedWatchSteeringEnabled(): boolean {
  return MAIN_FEED_STEERING_ENABLED && steeringEnabled;
}

export function setWatchTopicSteeringEnabled(enabled: boolean): void {
  steeringEnabled = !!enabled;
  console.log(`[WatchTopicMatcher] Priority/BOLO steering ${steeringEnabled ? 'ENABLED' : 'disabled'}`);
}

// Restore the persisted steering flag from the database at boot. Must be
// awaited before the scheduler starts so the first scrape cycle sees the
// correct state instead of the default OFF. Fail-open: errors are logged
// and the in-memory default (OFF) is kept, which is the safe direction.
export async function restoreWatchTopicSteering(): Promise<void> {
  try {
    const [row] = await db.select().from(appFlags).where(eq(appFlags.id, 'global'));
    if (row) {
      steeringEnabled = row.watchTopicSteeringEnabled;
      console.log(`[WatchTopicMatcher] Restored steering state: ${steeringEnabled ? 'ENABLED' : 'disabled'}`);
    }
  } catch (err) {
    console.error('[WatchTopicMatcher] Failed to restore steering state (continuing with default OFF):', err);
  }
}

// Write the current steering state to the database so it survives restarts.
export async function persistWatchTopicSteering(enabled: boolean): Promise<void> {
  await db.insert(appFlags)
    .values({ id: 'global', watchTopicSteeringEnabled: enabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appFlags.id,
      set: { watchTopicSteeringEnabled: enabled, updatedAt: new Date() },
    });
}

// Load active Priority/BOLO watch topics, compiled for matching. Excludes
// archived and expired topics, and topics without a usable keyword gate.
export async function loadActiveWatchTopics(): Promise<CompiledWatchTopic[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(teamSubjects)
    .where(and(
      eq(teamSubjects.isActive, true),
      or(eq(teamSubjects.isPriorityWatch, true), eq(teamSubjects.isBoloWatch, true)),
      or(isNull(teamSubjects.estimatedActiveUntil), gt(teamSubjects.estimatedActiveUntil, now)),
    ));
  return rows.map(compileWatchTopic).filter(hasKeywordGate);
}
