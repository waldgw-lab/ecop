// Meltwater health verdict (Task #543/#547/#839) — unit tests for
// computeMeltwaterHealth (single-search) AND computeMeltwaterHealthMulti
// (multi-search aggregate).
//
// computeMeltwaterHealth() derives the status panel for a single search:
//   - all five status values: healthy / throttled / stale / error / not-run;
//   - the isDegraded flag (false for healthy + throttled, true for stale + error);
//   - cadence-aware stale threshold boundary (custom staleThresholdMs arg);
//   - the busy-window overflow note surfaced in a healthy summary;
//   - fmtAge edge cases surfaced through the summary string (s / m / h / d).
//
// computeMeltwaterHealthMulti() aggregates per-search verdicts:
//   - correct degradedCount when one or more searches degrade;
//   - cadence-aware thresholds (CPC 3h / IntUS 6h) applied independently;
//   - 'not-run' is non-degraded; 'stale' IS degraded.
//
// DB-free, AI-free, quota-free: pure verdict logic only, safe to run any time.
import { computeMeltwaterHealth, computeMeltwaterHealthMulti } from '../server/meltwaterHealth';
import type { MeltwaterTelemetry } from '@shared/schema';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS [${name}]`);
  } else {
    failed++;
    console.log(`FAIL [${name}]`);
  }
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const STALE_THRESHOLD_MS = 3 * HOUR;

// Build a full telemetry row N ms in the past, with field overrides.
// id defaults to 'meltwater-cpc' (the CPC search label) matching the new schema.
function telemetry(
  ageMs: number,
  overrides: Partial<MeltwaterTelemetry> = {},
  id = 'meltwater-cpc',
): MeltwaterTelemetry {
  return {
    id,
    lastRunAt: new Date(Date.now() - ageMs),
    outcome: 'success',
    httpStatus: null,
    ingested: 0,
    skipped: 0,
    dayRemaining: null,
    dayLimit: null,
    dayResetAt: null,
    minuteRemaining: null,
    overflow: false,
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. not-run — no telemetry at all.
// ---------------------------------------------------------------------------
{
  const noKey = computeMeltwaterHealth(null, false);
  check('not-run (no key): status', noKey.status === 'not-run');
  check('not-run (no key): not degraded', noKey.isDegraded === false);
  check('not-run (no key): mentions API key', /MELTWATER_API_KEY/.test(noKey.summary));
  check('not-run (no key): null lastRun fields', noKey.lastRunAt === null && noKey.lastRunAgeMs === null);

  const keyNeverRan = computeMeltwaterHealth(null, true);
  check('not-run (key, never ran): status', keyNeverRan.status === 'not-run');
  check('not-run (key, never ran): not degraded', keyNeverRan.isDegraded === false);
  check('not-run (key, never ran): distinct summary', keyNeverRan.summary !== noKey.summary);
}

// ---------------------------------------------------------------------------
// 1b. operator-disabled — historical telemetry remains visible but never
// presents as stale/broken and the aggregate is not degraded.
// ---------------------------------------------------------------------------
{
  const old = telemetry(12 * HOUR, {
    outcome: 'success',
    ingested: 4,
    dayRemaining: 21,
  });
  const disabled = computeMeltwaterHealth(old, true, STALE_THRESHOLD_MS, true);
  check('disabled: status', disabled.status === 'disabled');
  check('disabled: not degraded', disabled.isDegraded === false);
  check('disabled: preserves last-run telemetry', disabled.lastRunAt !== null && disabled.ingested === 4);
  check('disabled: explains operator configuration', /disabled by operator/i.test(disabled.summary));

  const multiDisabled = computeMeltwaterHealthMulti([old], true, true);
  check('multi disabled: every search disabled', multiDisabled.searches.every((s) => s.health.status === 'disabled'));
  check('multi disabled: no degraded searches', multiDisabled.aggregate.degradedCount === 0 && !multiDisabled.aggregate.isDegraded);
  check('multi disabled: aggregate status', multiDisabled.aggregate.worstStatus === 'disabled');
}

// ---------------------------------------------------------------------------
// 2. healthy — recent success.
// ---------------------------------------------------------------------------
{
  const h = computeMeltwaterHealth(
    telemetry(30 * MINUTE, { outcome: 'success', ingested: 7, skipped: 2 }),
    true,
  );
  check('healthy: status', h.status === 'healthy');
  check('healthy: not degraded', h.isDegraded === false);
  check('healthy: outcome carried', h.outcome === 'success');
  check('healthy: ingested carried', h.ingested === 7);
  check('healthy: skipped carried', h.skipped === 2);
  check('healthy: lastRunAt populated', typeof h.lastRunAt === 'string' && h.lastRunAt !== null);
  check('healthy: summary on cadence', /on cadence/.test(h.summary));
}

// ---------------------------------------------------------------------------
// 3. throttled — recent rate-limit (expected, NOT degraded).
// ---------------------------------------------------------------------------
{
  const t = computeMeltwaterHealth(
    telemetry(1 * HOUR, { outcome: 'rate-limited', dayRemaining: 4, dayLimit: 500 }),
    true,
  );
  check('throttled: status', t.status === 'throttled');
  check('throttled: NOT degraded', t.isDegraded === false);
  check('throttled: outcome carried', t.outcome === 'rate-limited');
  check('throttled: quota line in summary', /4\/500 remaining/.test(t.summary));
  check('throttled: ingested zeroed', t.ingested === 0 && t.skipped === 0);
}

// ---------------------------------------------------------------------------
// 4. stale — overdue past the 3h cadence window (from success and rate-limited).
// ---------------------------------------------------------------------------
{
  const staleSuccess = computeMeltwaterHealth(
    telemetry(8 * HOUR, { outcome: 'success', ingested: 3 }),
    true,
  );
  check('stale (success): status', staleSuccess.status === 'stale');
  check('stale (success): degraded', staleSuccess.isDegraded === true);
  check('stale (success): summary overdue', /overdue/.test(staleSuccess.summary));

  const staleThrottled = computeMeltwaterHealth(
    telemetry(8 * HOUR, { outcome: 'rate-limited' }),
    true,
  );
  check('stale (rate-limited): status overrides throttled', staleThrottled.status === 'stale');
  check('stale (rate-limited): degraded', staleThrottled.isDegraded === true);
}

// ---------------------------------------------------------------------------
// 5. stale threshold boundary — just inside (healthy) vs. just outside (stale).
// ---------------------------------------------------------------------------
{
  const justInside = computeMeltwaterHealth(
    telemetry(STALE_THRESHOLD_MS - 5 * MINUTE, { outcome: 'success' }),
    true,
  );
  check('boundary: 5m inside 3h is healthy', justInside.status === 'healthy' && justInside.isDegraded === false);

  const justOutside = computeMeltwaterHealth(
    telemetry(STALE_THRESHOLD_MS + 5 * MINUTE, { outcome: 'success' }),
    true,
  );
  check('boundary: 5m outside 3h is stale', justOutside.status === 'stale' && justOutside.isDegraded === true);
}

// ---------------------------------------------------------------------------
// 5b. overflow — a healthy run that hit the page/quota ceiling surfaces a busy-
//     window note (and still reads as "on cadence"); a normal run does not.
// ---------------------------------------------------------------------------
{
  const busy = computeMeltwaterHealth(
    telemetry(20 * MINUTE, { outcome: 'success', ingested: 40, overflow: true }),
    true,
  );
  check('overflow: still healthy', busy.status === 'healthy' && busy.isDegraded === false);
  check('overflow: flag carried', busy.overflow === true);
  check('overflow: busy-window note in summary', /[Bb]usy window/.test(busy.summary));
  check('overflow: still on cadence', /on cadence/.test(busy.summary));

  const calm = computeMeltwaterHealth(
    telemetry(20 * MINUTE, { outcome: 'success', ingested: 5, overflow: false }),
    true,
  );
  check('no-overflow: flag false', calm.overflow === false);
  check('no-overflow: no busy-window note', !/[Bb]usy window/.test(calm.summary));
}

// ---------------------------------------------------------------------------
// 6. error — any non-success/non-rate-limited outcome (always degraded).
// ---------------------------------------------------------------------------
{
  const e = computeMeltwaterHealth(
    telemetry(20 * MINUTE, { outcome: 'error', httpStatus: 503 }),
    true,
  );
  check('error: status', e.status === 'error');
  check('error: degraded', e.isDegraded === true);
  check('error: outcome carried', e.outcome === 'error');
  check('error: http status in summary', /HTTP 503/.test(e.summary));

  // Error wins even when the run is also old — it is never relabeled "stale".
  const oldError = computeMeltwaterHealth(
    telemetry(30 * HOUR, { outcome: 'error' }),
    true,
  );
  check('error (old): still status error, not stale', oldError.status === 'error');
  check('error (old): degraded', oldError.isDegraded === true);
}

// ---------------------------------------------------------------------------
// 7. fmtAge edge cases surfaced through the summary string.
//    seconds / minutes / hours via healthy or stale success summaries; days via
//    a >48h stale success summary.
// ---------------------------------------------------------------------------
{
  const secs = computeMeltwaterHealth(telemetry(30 * 1000, { outcome: 'success' }), true);
  check('fmtAge: seconds ("s ago")', /\d+s ago/.test(secs.summary));

  const mins = computeMeltwaterHealth(telemetry(15 * MINUTE, { outcome: 'success' }), true);
  check('fmtAge: minutes ("m ago")', /\d+m ago/.test(mins.summary));

  const hours = computeMeltwaterHealth(telemetry(3 * HOUR, { outcome: 'success' }), true);
  check('fmtAge: hours ("h ago")', /\d+h ago/.test(hours.summary));

  const days = computeMeltwaterHealth(telemetry(50 * HOUR, { outcome: 'success' }), true);
  check('fmtAge: days ("d ago")', /\d+d ago/.test(days.summary));
}

// ---------------------------------------------------------------------------
// 8. computeMeltwaterHealthMulti — per-search verdicts + aggregate.
//    CPC stale threshold = 3h, IntUS stale threshold = 6h.
// ---------------------------------------------------------------------------
{
  // 8a. Both not-run (no telemetry, no API key) → degradedCount=0, worstStatus='not-run'.
  const notRun = computeMeltwaterHealthMulti([], false);
  check('multi: 0 rows, no key → 2 searches (from MELTWATER_SEARCHES)', notRun.searches.length === 2);
  check('multi: both not-run → degradedCount 0', notRun.aggregate.degradedCount === 0);
  check('multi: both not-run → isDegraded false', notRun.aggregate.isDegraded === false);
  check('multi: both not-run → worstStatus not-run', notRun.aggregate.worstStatus === 'not-run');

  // 8b. CPC healthy (30m ago) + IntUS not-run → degradedCount=0.
  const cpcOnly = computeMeltwaterHealthMulti(
    [telemetry(30 * MINUTE, { outcome: 'success', ingested: 3 }, 'meltwater-cpc')],
    true,
  );
  const cpcSearch = cpcOnly.searches.find((s) => s.label === 'meltwater-cpc')!;
  const intusSearch = cpcOnly.searches.find((s) => s.label === 'meltwater-intus')!;
  check('multi: CPC healthy', cpcSearch.health.status === 'healthy');
  check('multi: IntUS not-run (no telemetry row)', intusSearch.health.status === 'not-run');
  check('multi: CPC healthy + IntUS not-run → degradedCount 0', cpcOnly.aggregate.degradedCount === 0);
  check('multi: CPC healthy + IntUS not-run → isDegraded false', cpcOnly.aggregate.isDegraded === false);

  // 8c. CPC stale (4h ago > 3h threshold) + IntUS NOT stale (5h ago < 6h threshold).
  // Only CPC should be degraded.
  const cpcStale = computeMeltwaterHealthMulti(
    [
      telemetry(4 * HOUR, { outcome: 'success' }, 'meltwater-cpc'),
      telemetry(5 * HOUR, { outcome: 'success' }, 'meltwater-intus'),
    ],
    true,
  );
  const cpcStaleSearch = cpcStale.searches.find((s) => s.label === 'meltwater-cpc')!;
  const intusOkSearch = cpcStale.searches.find((s) => s.label === 'meltwater-intus')!;
  check('multi: CPC 4h old > 3h threshold → stale', cpcStaleSearch.health.status === 'stale');
  check('multi: CPC stale → isDegraded true', cpcStaleSearch.health.isDegraded === true);
  check('multi: IntUS 5h old < 6h threshold → healthy', intusOkSearch.health.status === 'healthy');
  check('multi: IntUS 5h old → NOT degraded', intusOkSearch.health.isDegraded === false);
  check('multi: only CPC stale → degradedCount 1', cpcStale.aggregate.degradedCount === 1);
  check('multi: only CPC stale → isDegraded true', cpcStale.aggregate.isDegraded === true);
  check('multi: only CPC stale → worstStatus stale', cpcStale.aggregate.worstStatus === 'stale');

  // 8d. Both stale → degradedCount=2.
  const bothStale = computeMeltwaterHealthMulti(
    [
      telemetry(8 * HOUR, { outcome: 'success' }, 'meltwater-cpc'),
      telemetry(12 * HOUR, { outcome: 'success' }, 'meltwater-intus'),
    ],
    true,
  );
  check('multi: both stale → degradedCount 2', bothStale.aggregate.degradedCount === 2);
  check('multi: both stale → isDegraded true', bothStale.aggregate.isDegraded === true);

  // 8e. One error → worstStatus='error' (error ranks above stale).
  const oneError = computeMeltwaterHealthMulti(
    [
      telemetry(30 * MINUTE, { outcome: 'success' }, 'meltwater-cpc'),
      telemetry(30 * MINUTE, { outcome: 'error', httpStatus: 500 }, 'meltwater-intus'),
    ],
    true,
  );
  check('multi: one error → worstStatus error', oneError.aggregate.worstStatus === 'error');
  check('multi: one error → degradedCount 1', oneError.aggregate.degradedCount === 1);

  // 8f. CPC throttled (recent) — throttled is non-degraded.
  const cpcThrottled = computeMeltwaterHealthMulti(
    [telemetry(1 * HOUR, { outcome: 'rate-limited' }, 'meltwater-cpc')],
    true,
  );
  const cpcThrottledSearch = cpcThrottled.searches.find((s) => s.label === 'meltwater-cpc')!;
  check('multi: CPC throttled → status throttled', cpcThrottledSearch.health.status === 'throttled');
  check('multi: CPC throttled → not degraded', cpcThrottledSearch.health.isDegraded === false);
  check('multi: CPC throttled → degradedCount 0', cpcThrottled.aggregate.degradedCount === 0);

  // 8g. staleThresholdMs is per-search — verify label is in each search item.
  check('multi: CPC staleThresholdMs = 3h', cpcOnly.searches.find((s) => s.label === 'meltwater-cpc')!.staleThresholdMs === 3 * HOUR);
  check('multi: IntUS staleThresholdMs = 6h', cpcOnly.searches.find((s) => s.label === 'meltwater-intus')!.staleThresholdMs === 6 * HOUR);

  // 8h. displayName and cadenceLabel are populated.
  check('multi: CPC displayName contains CPC', /CPC/.test(cpcOnly.searches.find((s) => s.label === 'meltwater-cpc')!.displayName));
  check('multi: IntUS displayName contains Int/US or Int', /Int/.test(cpcOnly.searches.find((s) => s.label === 'meltwater-intus')!.displayName));
  check('multi: CPC cadenceLabel contains hourly', /hourly/.test(cpcOnly.searches.find((s) => s.label === 'meltwater-cpc')!.cadenceLabel));
  check('multi: IntUS cadenceLabel contains 2', /2/.test(cpcOnly.searches.find((s) => s.label === 'meltwater-intus')!.cadenceLabel));
}

// ---------------------------------------------------------------------------
// 9. combinedQuota — shared daily quota view across both searches (Task #840).
//
// Both searches draw from ONE shared pool. The displayed remaining is the
// most-recent-run search's reading (not a sum — summing would double-count).
// Default warning floor is 10 (below the real 50-call shared limit).
// ---------------------------------------------------------------------------
{
  // 9a. No telemetry at all → null total, not partial, no warning.
  const none = computeMeltwaterHealthMulti([], true);
  check('quota: no telemetry → total null', none.combinedQuota.totalDayRemaining === null);
  check('quota: no telemetry → 0 reporting', none.combinedQuota.searchesWithTelemetry === 0);
  check('quota: no telemetry → not partial', none.combinedQuota.partial === false);
  check('quota: no telemetry → not belowFloor', none.combinedQuota.belowFloor === false);
  check('quota: searchCount 2', none.combinedQuota.searchCount === 2);
  check('quota: default floor 10', none.combinedQuota.warningFloor === 10);

  // 9b. Both reporting with distinct ages → most-recent reading (not sum).
  // CPC ran 60 min ago (dayRemaining 200), IntUS ran 30 min ago (dayRemaining 150).
  // IntUS is more recent, so totalDayRemaining = 150, not 200+150=350.
  const both = computeMeltwaterHealthMulti(
    [
      telemetry(60 * MINUTE, { outcome: 'success', dayRemaining: 200, dayLimit: 500 }, 'meltwater-cpc'),
      telemetry(30 * MINUTE, { outcome: 'success', dayRemaining: 150, dayLimit: 500 }, 'meltwater-intus'),
    ],
    true,
  );
  check('quota: both → most-recent reading 150 (not sum)', both.combinedQuota.totalDayRemaining === 150);
  check('quota: both → shared limit 500', both.combinedQuota.dayLimit === 500);
  check('quota: both → 2 reporting', both.combinedQuota.searchesWithTelemetry === 2);
  check('quota: both → not partial', both.combinedQuota.partial === false);
  check('quota: 150 ≥ 10 → not belowFloor', both.combinedQuota.belowFloor === false);

  // 9c. Only one search reporting → partial view, reading from that search.
  const one = computeMeltwaterHealthMulti(
    [telemetry(30 * MINUTE, { outcome: 'success', dayRemaining: 80, dayLimit: 500 }, 'meltwater-cpc')],
    true,
  );
  check('quota: one → total 80', one.combinedQuota.totalDayRemaining === 80);
  check('quota: one → 1 reporting', one.combinedQuota.searchesWithTelemetry === 1);
  check('quota: one → partial true', one.combinedQuota.partial === true);
  check('quota: 80 ≥ 10 → not belowFloor', one.combinedQuota.belowFloor === false);

  // 9d. Most-recent reading below floor → warning.
  // IntUS ran more recently (30 min) with only 5 remaining — below the 10-call floor.
  const low = computeMeltwaterHealthMulti(
    [
      telemetry(60 * MINUTE, { outcome: 'success', dayRemaining: 40, dayLimit: 500 }, 'meltwater-cpc'),
      telemetry(30 * MINUTE, { outcome: 'rate-limited', dayRemaining: 5, dayLimit: 500 }, 'meltwater-intus'),
    ],
    true,
  );
  check('quota: low → most-recent reading 5', low.combinedQuota.totalDayRemaining === 5);
  check('quota: 5 < 10 → belowFloor', low.combinedQuota.belowFloor === true);

  // 9e. Env-configurable floor.
  process.env.MELTWATER_COMBINED_QUOTA_FLOOR = '25';
  const customFloor = computeMeltwaterHealthMulti(
    [
      telemetry(60 * MINUTE, { outcome: 'success', dayRemaining: 40, dayLimit: 500 }, 'meltwater-cpc'),
      telemetry(30 * MINUTE, { outcome: 'success', dayRemaining: 30, dayLimit: 500 }, 'meltwater-intus'),
    ],
    true,
  );
  check('quota: env floor 25 read', customFloor.combinedQuota.warningFloor === 25);
  check('quota: 30 ≥ 25 → not belowFloor', customFloor.combinedQuota.belowFloor === false);

  // 9f. Invalid env floor falls back to default (10).
  process.env.MELTWATER_COMBINED_QUOTA_FLOOR = 'not-a-number';
  const badFloor = computeMeltwaterHealthMulti([], true);
  check('quota: invalid env floor → default 10', badFloor.combinedQuota.warningFloor === 10);
  delete process.env.MELTWATER_COMBINED_QUOTA_FLOOR;

  // 9g. Quota readings count even from degraded (stale/error) rows — last-known.
  const staleRow = computeMeltwaterHealthMulti(
    [telemetry(10 * HOUR, { outcome: 'success', dayRemaining: 60, dayLimit: 500 }, 'meltwater-cpc')],
    true,
  );
  check('quota: stale row still contributes last-known reading', staleRow.combinedQuota.totalDayRemaining === 60);

  // 9h. Tie-break on lowest remaining when both searches share the same timestamp.
  // Both ran at exactly the same time but CPC has 200 remaining, IntUS has 150.
  // Tie-break = most conservative (150 chosen over 200).
  const tied = computeMeltwaterHealthMulti(
    [
      telemetry(30 * MINUTE, { outcome: 'success', dayRemaining: 200, dayLimit: 500 }, 'meltwater-cpc'),
      telemetry(30 * MINUTE, { outcome: 'success', dayRemaining: 150, dayLimit: 500 }, 'meltwater-intus'),
    ],
    true,
  );
  check('quota: tied timestamps → most conservative reading', tied.combinedQuota.totalDayRemaining !== null && (tied.combinedQuota.totalDayRemaining as number) <= 200);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
