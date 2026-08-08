// Lightweight, in-memory RSS feed-health detector (Task #542).
//
// The main RSS Monitor (server/rssFeeds.ts → rssFeedBot) and the Warfighter RSS
// list (server/warfighterRssScraper.ts) can quietly degrade two ways:
//   - hard-erroring every cycle (parse/HTTP failure), or
//   - silently returning ZERO feed items every cycle (the outlet retired its RSS
//     and now serves HTML, so parsing "succeeds" but yields nothing).
// Either way the feed contributes no headlines while spamming the deployment
// logs, and nobody notices until logs are manually inspected. This module tracks
// per-feed-URL outcomes across scrape cycles so feeds that stay unhealthy for N
// consecutive cycles can be surfaced on the Coverage tab next to the existing
// "Silent sources" readout.
//
// Design notes:
//   - Observability ONLY. Recording an outcome never changes scraping behavior.
//   - Fail-open: every recorder is wrapped so a tracker bug can never break a
//     scrape cycle.
//   - In-memory (per-process) as the fast read path, consistent with the
//     existing rssFeedBot circuit breaker and the live pipeline-health
//     computation. The deploy is a single VM instance, so a process-local Map is
//     correct here.
//
// Durable persistence (Task #553):
//   The in-memory Map used to reset on every restart/redeploy, so a feed that
//   had been dead for days briefly showed "healthy" again until 3 fresh cycles
//   re-detected it — the Coverage tab went blind right after a deploy. We now
//   persist each per-feed streak/outcome (one row per URL) and restore it into
//   the Map on boot, mirroring the relay-heartbeat persist-and-restore pattern.
//   Writes are fire-and-forget; restore is bounded, fail-open, and awaited
//   before the scheduler starts so the first Coverage read reflects pre-restart
//   state.

import type { IStorage } from './storage';

export type FeedOutcome = 'healthy' | 'empty' | 'error';
export type FeedScope = 'rss-monitor' | 'warfighter';

// Consecutive unhealthy cycles before a feed is flagged stale/broken. Matches
// the rssFeedBot circuit-breaker threshold so the two notions stay aligned.
export const FEED_STALE_THRESHOLD = 3;

// How many recent outcomes to retain per feed (for the trailing-streak readout).
const RECENT_LIMIT = 12;

interface FeedHealthState {
  url: string;
  sourceName: string;
  scope: FeedScope;
  lastOutcome: FeedOutcome;
  lastDetail: string | null;
  consecutiveUnhealthy: number;
  recent: FeedOutcome[];
  lastHealthyAt: number | null;
  lastSeenAt: number;
  totalCycles: number;
}

const state = new Map<string, FeedHealthState>();

// Storage handle wired at boot via restoreFeedHealthState(). When set, each
// recorded outcome is persisted fire-and-forget so the streak survives a
// restart. Left null in contexts without a DB (the recorder simply stays
// in-memory-only, exactly as before).
let healthStorage: IStorage | null = null;

function isFeedOutcome(v: unknown): v is FeedOutcome {
  return v === 'healthy' || v === 'empty' || v === 'error';
}

// Restore the persisted per-feed health state into the in-memory Map on boot and
// wire up the storage handle used by the fire-and-forget writes. Bounded (a
// single indexed read), fail-open, and intended to be AWAITED before the
// scheduler starts so the first Coverage read reflects pre-restart state. Mirrors
// the relay-heartbeat restore pattern (server/truthSocialService.ts).
export async function restoreFeedHealthState(storage: IStorage): Promise<void> {
  healthStorage = storage;
  try {
    const rows = await storage.getAllFeedHealthState();
    let restored = 0;
    for (const row of rows) {
      if (!row.url) continue;
      // Only restore rows we have not already observed in this process so a
      // fresh scrape that beat the restore is never clobbered by older data.
      if (state.has(row.url)) continue;
      const recent = Array.isArray(row.recent)
        ? row.recent.filter(isFeedOutcome)
        : [];
      state.set(row.url, {
        url: row.url,
        sourceName: row.sourceName,
        scope: (row.scope as FeedScope),
        lastOutcome: isFeedOutcome(row.lastOutcome) ? row.lastOutcome : 'error',
        lastDetail: row.lastDetail ?? null,
        consecutiveUnhealthy: row.consecutiveUnhealthy ?? 0,
        recent: recent.slice(-RECENT_LIMIT),
        lastHealthyAt: row.lastHealthyAt ? row.lastHealthyAt.getTime() : null,
        lastSeenAt: row.lastSeenAt ? row.lastSeenAt.getTime() : Date.now(),
        totalCycles: row.totalCycles ?? 0,
      });
      restored++;
    }
    console.log(`[FeedHealth] Restored ${restored} persisted feed-health row(s)`);
  } catch (err) {
    // fail-open: a restore failure must never block startup.
    console.error('[FeedHealth] Failed to restore persisted feed-health state:', err);
  }
}

export function recordFeedOutcome(input: {
  url: string;
  sourceName: string;
  scope: FeedScope;
  outcome: FeedOutcome;
  detail?: string | null;
}): void {
  try {
    const { url, sourceName, scope, outcome } = input;
    if (!url) return;
    const now = Date.now();
    const prev = state.get(url);
    const recent = prev ? prev.recent.slice(-(RECENT_LIMIT - 1)) : [];
    recent.push(outcome);
    const next: FeedHealthState = {
      url,
      sourceName,
      scope,
      lastOutcome: outcome,
      lastDetail: input.detail ?? null,
      consecutiveUnhealthy: outcome === 'healthy' ? 0 : (prev?.consecutiveUnhealthy ?? 0) + 1,
      recent,
      lastHealthyAt: outcome === 'healthy' ? now : (prev?.lastHealthyAt ?? null),
      lastSeenAt: now,
      totalCycles: (prev?.totalCycles ?? 0) + 1,
    };
    state.set(url, next);
    persistFeedHealthState(next);
  } catch {
    // fail-open: feed-health tracking must never break a scrape cycle.
  }
}

// Per-URL write chain so two writes for the SAME feed can never land out of
// order (a later in-memory snapshot must never be overwritten by an earlier
// one). In production a feed records once per cycle so writes are minutes apart,
// but chaining keeps ordering provably correct regardless of caller cadence.
// Different URLs write concurrently (separate chains / separate rows).
const writeChains = new Map<string, Promise<void>>();

// Fire-and-forget durable write of a single feed's state. Never awaited and
// never throws into the caller — a DB hiccup must not affect a scrape cycle.
function persistFeedHealthState(s: FeedHealthState): void {
  const storage = healthStorage;
  if (!storage) return;
  const prev = writeChains.get(s.url) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // a prior failure must not break the chain
    .then(() =>
      storage.upsertFeedHealthState({
        url: s.url,
        sourceName: s.sourceName,
        scope: s.scope,
        lastOutcome: s.lastOutcome,
        lastDetail: s.lastDetail,
        consecutiveUnhealthy: s.consecutiveUnhealthy,
        recent: s.recent,
        lastHealthyAt: s.lastHealthyAt ? new Date(s.lastHealthyAt) : null,
        lastSeenAt: new Date(s.lastSeenAt),
        totalCycles: s.totalCycles,
      }),
    )
    .catch((err) => console.error('[FeedHealth] Failed to persist feed-health state:', err))
    .finally(() => {
      // Drop the chain entry once it is the tail so the Map cannot grow
      // unbounded across the full feed roster.
      if (writeChains.get(s.url) === next) writeChains.delete(s.url);
    });
  writeChains.set(s.url, next);
}

// Kind of the current unhealthy streak: all errors, all zero-item, or a mix.
function streakKind(recent: FeedOutcome[], consecutiveUnhealthy: number): 'empty' | 'error' | 'mixed' | null {
  if (consecutiveUnhealthy <= 0) return null;
  const tail = recent.slice(-consecutiveUnhealthy);
  const hasError = tail.includes('error');
  const hasEmpty = tail.includes('empty');
  if (hasError && hasEmpty) return 'mixed';
  return hasError ? 'error' : 'empty';
}

export interface FeedHealthRow {
  url: string;
  sourceName: string;
  scope: FeedScope;
  lastOutcome: FeedOutcome;
  lastDetail: string | null;
  consecutiveUnhealthy: number;
  streakKind: 'empty' | 'error' | 'mixed' | null;
  recent: FeedOutcome[];
  lastHealthyAt: string | null;
  lastSeenAt: string;
  totalCycles: number;
  stale: boolean;
}

export interface FeedHealthReport {
  feeds: FeedHealthRow[];
  total: number;
  stale: number;
}

export function getFeedHealthReport(): FeedHealthReport {
  const rows: FeedHealthRow[] = [];
  for (const s of Array.from(state.values())) {
    rows.push({
      url: s.url,
      sourceName: s.sourceName,
      scope: s.scope,
      lastOutcome: s.lastOutcome,
      lastDetail: s.lastDetail,
      consecutiveUnhealthy: s.consecutiveUnhealthy,
      streakKind: streakKind(s.recent, s.consecutiveUnhealthy),
      recent: s.recent,
      lastHealthyAt: s.lastHealthyAt ? new Date(s.lastHealthyAt).toISOString() : null,
      lastSeenAt: new Date(s.lastSeenAt).toISOString(),
      totalCycles: s.totalCycles,
      stale: s.consecutiveUnhealthy >= FEED_STALE_THRESHOLD,
    });
  }
  rows.sort((a, b) => {
    // Stale (problem) rows first, then by the length of the unhealthy streak,
    // then alphabetically so the roster is stable.
    if (a.stale !== b.stale) return a.stale ? -1 : 1;
    if (b.consecutiveUnhealthy !== a.consecutiveUnhealthy) return b.consecutiveUnhealthy - a.consecutiveUnhealthy;
    return a.sourceName.localeCompare(b.sourceName);
  });
  return { feeds: rows, total: rows.length, stale: rows.filter((r) => r.stale).length };
}
