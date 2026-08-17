/**
 * Gate: X-lane stall watchdog classifier (Task #34).
 *
 * WHY THIS EXISTS
 * ---------------
 * On Aug 17 2026 a runFullScrape hard-bound timeout left a zombie chain
 * holding the browser lock; every X lane froze for ~50 min while the app
 * looked healthy and nobody noticed until a stale Coverage banner. The
 * watchdog (server/xLaneStallWatchdog.ts) must classify, within one cycle:
 *   - "scheduler-stalled"  — whole chain not ticking (process/cron problem)
 *   - "lanes-stalled"      — chain ticking but lane stamps overdue >1 cycle
 *   - "scrapes-empty"      — lanes stamping but returning nothing
 * and stay SILENT when the relay is healthy (lanes intentionally idle) or
 * right after a relay-health transition (stamps legitimately frozen).
 *
 * Deterministic, pure classifier — no DB, no network. Exit 0 = PASS, 1 = FAIL.
 */

import { computeXLaneStallReport, isStallAlert } from '../server/xLaneStallWatchdog';
import { EXIT_PASS, EXIT_FAIL } from './harness-reliability';

const MIN = 60 * 1000;
const NOW = Date.parse('2026-08-17T13:30:00Z');

const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`[x-lane-stall] OK   ${name}`);
  else { console.error(`[x-lane-stall] FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

function meta(overrides: Record<string, unknown> = {}): any {
  const fresh = new Date(NOW - 5 * MIN);
  return {
    lastScrapeTime: fresh,
    xPostsLastScrapeTime: fresh,
    rapidResponseLastScrapeTime: fresh,
    dowResponseLastScrapeTime: fresh,
    sentDefenderLastScrapeTime: fresh,
    osintLastScrapeTime: new Date(NOW - 10 * MIN),
    influencerXLastScrapeTime: new Date(NOW - 10 * MIN),
    xPostsConsecutiveEmpty: 0,
    rapidResponseConsecutiveEmpty: 0,
    dowResponseConsecutiveEmpty: 0,
    sentDefenderConsecutiveEmpty: 0,
    osintConsecutiveEmpty: 0,
    influencerXConsecutiveEmpty: 0,
    ...overrides,
  };
}

// PRIMARY mode began long ago: heartbeat 2h old, 15-min stale threshold.
const primary = {
  nowMs: NOW,
  relayHealthy: false,
  relayHeartbeatMs: NOW - 2 * 60 * MIN,
  relayStaleThresholdMs: 15 * MIN,
};

// 1. Relay healthy → relay-covering, never an alert (even with ancient stamps).
{
  const r = computeXLaneStallReport(meta({ xPostsLastScrapeTime: new Date(NOW - 5 * 60 * MIN) }), { ...primary, relayHealthy: true });
  check('relay healthy → relay-covering, no alert', r.mode === 'relay-covering' && !isStallAlert(r), r.mode);
}

// 2. All fresh in PRIMARY → ok.
{
  const r = computeXLaneStallReport(meta(), primary);
  check('all lanes fresh → ok', r.mode === 'ok' && !isStallAlert(r), `${r.mode}: ${r.summary}`);
}

// 3. Incident signature: chain stamp fresh (error-path stamp advances it) but
//    X lane stamps frozen ~50 min → lanes-stalled, listing the frozen lanes.
{
  const frozen = new Date(NOW - 50 * MIN);
  const r = computeXLaneStallReport(meta({
    xPostsLastScrapeTime: frozen,
    rapidResponseLastScrapeTime: frozen,
    dowResponseLastScrapeTime: frozen,
    sentDefenderLastScrapeTime: frozen,
  }), primary);
  check('frozen lanes + ticking chain → lanes-stalled', r.mode === 'lanes-stalled' && isStallAlert(r), r.mode);
  check('lanes-stalled lists all four frozen lanes', r.stalledLanes.length === 4, r.stalledLanes.join(','));
}

// 4. Whole chain overdue → scheduler-stalled (takes precedence over lanes).
{
  const old = new Date(NOW - 50 * MIN);
  const r = computeXLaneStallReport(meta({ lastScrapeTime: old, xPostsLastScrapeTime: old }), primary);
  check('chain overdue → scheduler-stalled', r.mode === 'scheduler-stalled' && isStallAlert(r), r.mode);
}

// 5. Fresh stamps but ≥2 consecutive empty → scrapes-empty.
{
  const r = computeXLaneStallReport(meta({ xPostsConsecutiveEmpty: 3, sentDefenderConsecutiveEmpty: 2 }), primary);
  check('fresh but empty → scrapes-empty', r.mode === 'scrapes-empty' && isStallAlert(r), r.mode);
  check('scrapes-empty lists the empty lanes', r.emptyLanes.length === 2, r.emptyLanes.join(','));
}

// 6. Relay JUST went stale (PRIMARY began 3 min ago): old stamps must NOT
//    alert — lanes were legitimately frozen while the relay covered.
{
  const r = computeXLaneStallReport(meta({
    xPostsLastScrapeTime: new Date(NOW - 5 * 60 * MIN),
    rapidResponseLastScrapeTime: new Date(NOW - 5 * 60 * MIN),
  }), { ...primary, relayHeartbeatMs: NOW - 18 * MIN });
  check('fresh relay transition → no false lane alarm', r.mode === 'ok', `${r.mode}: ${r.summary}`);
}

// 7. OSINT (30-min cadence) only overdue past 2×cadence+grace: 45 min old is
//    fine, 70 min old (chain fresh) is a stall.
{
  const ok45 = computeXLaneStallReport(meta({ osintLastScrapeTime: new Date(NOW - 45 * MIN) }), primary);
  check('OSINT 45m old → not overdue', ok45.mode === 'ok', ok45.mode);
  const bad70 = computeXLaneStallReport(meta({ osintLastScrapeTime: new Date(NOW - 70 * MIN) }), primary);
  check('OSINT 70m old → lanes-stalled', bad70.mode === 'lanes-stalled' && bad70.stalledLanes.includes('OSINT feeds'), bad70.mode);
}

// 9. Relay NEVER heartbeated (heartbeat=0) + lane never stamped: with an old
//    fallback PRIMARY baseline the missing lane must be flagged — a lane that
//    never starts is a silent stall, not "ok".
{
  const neverHb = { nowMs: NOW, relayHealthy: false, relayHeartbeatMs: 0, relayStaleThresholdMs: 15 * MIN, fallbackPrimarySinceMs: NOW - 60 * MIN };
  const r = computeXLaneStallReport(meta({ sentDefenderLastScrapeTime: null }), neverHb);
  check('never-heartbeat + null lane stamp + old fallback → lanes-stalled', r.mode === 'lanes-stalled' && r.stalledLanes.includes('@sentdefender'), `${r.mode}: ${r.stalledLanes.join(',')}`);
  const lane = r.lanes.find((l) => l.key === 'sentDefender')!;
  check('never-stamped lane reported with null lastStampAt and overdue', lane.lastStampAt === null && lane.overdue);
}

// 10. Same but fallback baseline is RECENT (cold start 3 min ago) → grace, no alarm.
{
  const r = computeXLaneStallReport(meta({ sentDefenderLastScrapeTime: null }), { nowMs: NOW, relayHealthy: false, relayHeartbeatMs: 0, relayStaleThresholdMs: 15 * MIN, fallbackPrimarySinceMs: NOW - 3 * MIN });
  check('never-heartbeat + null lane stamp + recent fallback → no false alarm', r.mode === 'ok', `${r.mode}: ${r.summary}`);
}

// 11. No relay baseline at all (heartbeat=0, no fallback): a never-stamped lane
//     still gets flagged via the chain's own stamp once it's old enough.
{
  const r = computeXLaneStallReport(meta({ lastScrapeTime: new Date(NOW - 40 * MIN), xPostsLastScrapeTime: new Date(NOW - 40 * MIN), sentDefenderLastScrapeTime: null, rapidResponseLastScrapeTime: new Date(NOW - 40 * MIN), dowResponseLastScrapeTime: new Date(NOW - 40 * MIN) }), { nowMs: NOW, relayHealthy: false, relayHeartbeatMs: 0, relayStaleThresholdMs: 15 * MIN });
  check('no baseline: never-stamped lane falls back to chain stamp (scheduler-stalled precedence here)', isStallAlert(r), r.mode);
  const r2 = computeXLaneStallReport(meta({ sentDefenderLastScrapeTime: null, lastScrapeTime: new Date(NOW - 30 * MIN) }), { nowMs: NOW, relayHealthy: false, relayHeartbeatMs: 0, relayStaleThresholdMs: 15 * MIN });
  const lane2 = r2.lanes.find((l) => l.key === 'sentDefender')!;
  check('chain-stamp fallback yields a concrete effective age for null-stamp lane', lane2.effectiveAgeMs !== null, String(lane2.effectiveAgeMs));
}

// 8. No metadata → indeterminate, no alert.
{
  const r = computeXLaneStallReport(undefined, primary);
  check('no metadata → indeterminate', r.mode === 'indeterminate' && !isStallAlert(r), r.mode);
}

if (failures.length) {
  console.error(`[x-lane-stall] ${failures.length} failure(s)`);
  process.exit(EXIT_FAIL);
}
console.log('[x-lane-stall] PASS');
process.exit(EXIT_PASS);
