// =============================================================================
// Meltwater API health verdict (Task #543) — curated-lane only.
//
// Reads the persisted Meltwater telemetry snapshots and derives status verdicts
// per search: Healthy / Throttled / Stale / Error (plus a distinct "not run
// here" state when the bot doesn't execute in this environment). Strictly
// read-only.
//
// This module is intentionally SEPARATE from pipelineHealth.ts: Meltwater is a
// curated-only data pipe and must never appear in the main-feed subsystem panel.
// =============================================================================

import type { MeltwaterTelemetry } from "@shared/schema";
import { MELTWATER_SEARCHES } from "./meltwaterBot";

export type MeltwaterStatus = "healthy" | "throttled" | "stale" | "error" | "not-run" | "disabled";

export interface MeltwaterHealth {
  status: MeltwaterStatus;
  summary: string;
  lastRunAt: string | null;
  lastRunAgeMs: number | null;
  outcome: string | null;
  ingested: number;
  skipped: number;
  dayRemaining: number | null;
  dayLimit: number | null;
  dayResetAt: string | null;
  minuteRemaining: number | null;
  isDegraded: boolean;
  quotaWarning: boolean;
  overflow: boolean;
}

// Per-search verdict item returned by computeMeltwaterHealthMulti.
export interface MeltwaterSearchVerdictItem {
  label: string;
  displayName: string;
  cadenceLabel: string;
  staleThresholdMs: number;
  health: MeltwaterHealth;
}

// Combined daily-quota view across all searches sharing the same API quota.
export interface MeltwaterCombinedQuota {
  // Most-recent known dayRemaining reading from whichever search ran latest.
  // Both searches draw from ONE shared pool, so the most-recently-run search's
  // reading is the authoritative remaining count. A sum would double-count.
  totalDayRemaining: number | null;
  // Shared daily limit (both searches report the same quota); max of known limits.
  dayLimit: number | null;
  // How many searches contributed a dayRemaining reading.
  searchesWithTelemetry: number;
  // Total registered searches.
  searchCount: number;
  // True when at least one search has no quota reading yet (view is partial).
  partial: boolean;
  // Warning floor the combined remaining is compared against.
  warningFloor: number;
  // True when totalDayRemaining is known and below warningFloor.
  belowFloor: boolean;
}

// Aggregate multi-search health returned by computeMeltwaterHealthMulti.
export interface MeltwaterMultiHealth {
  searches: MeltwaterSearchVerdictItem[];
  aggregate: {
    isDegraded: boolean;
    degradedCount: number;
    worstStatus: MeltwaterStatus;
  };
  combinedQuota: MeltwaterCombinedQuota;
}

const HOUR = 60 * 60 * 1000;

// Cadence-aware stale thresholds keyed by search label.
// Allow ~3 missed cycles before calling stale.
const STALE_THRESHOLD_BY_LABEL: Record<string, number> = {
  'meltwater-cpc': 3 * HOUR,    // hourly cadence → stale after 3h
  'meltwater-intus': 6 * HOUR,  // 2-hourly cadence → stale after 6h
};
const DEFAULT_STALE_THRESHOLD_MS = 3 * HOUR;

// Proactive warning threshold: flag when the daily quota drops below this
// fraction of its limit while the bot is otherwise healthy, so admins are
// alerted BEFORE the bot goes silent. Informational only — never sets
// isDegraded.
const QUOTA_WARNING_FRACTION = 0.1;

// Combined-quota warning floor: when the most-recent search's dayRemaining
// drops below this absolute number of calls, the Coverage tab shows a warning
// banner. The default is 10 — a meaningful fraction of the real shared limit
// (50 calls/day). Configurable via env; informational only — never sets isDegraded.
const DEFAULT_COMBINED_QUOTA_WARNING_FLOOR = 10;

export function getCombinedQuotaWarningFloor(): number {
  const raw = process.env.MELTWATER_COMBINED_QUOTA_FLOOR;
  if (raw != null && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_COMBINED_QUOTA_WARNING_FLOOR;
}

function isQuotaLow(dayRemaining: number | null, dayLimit: number | null): boolean {
  if (dayRemaining == null || dayLimit == null || dayLimit <= 0) return false;
  return dayRemaining / dayLimit < QUOTA_WARNING_FRACTION;
}

function ageMs(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  if (Number.isNaN(t)) return null;
  return Date.now() - t;
}

function fmtAge(ms: number | null): string {
  if (ms === null) return "never";
  const MINUTE = 60 * 1000;
  if (ms < MINUTE) return `${Math.round(ms / 1000)}s ago`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m ago`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)}h ago`;
  return `${Math.round(ms / (24 * HOUR))}d ago`;
}

// Status priority for worst-of aggregation (higher index = worse).
const STATUS_RANK: Record<MeltwaterStatus, number> = {
  "healthy": 0,
  "disabled": 1,
  "not-run": 2,
  "throttled": 3,
  "stale": 4,
  "error": 5,
};

// ---------------------------------------------------------------------------
// Single-search verdict (exported for tests and backward compat)
// ---------------------------------------------------------------------------

export function computeMeltwaterHealth(
  telemetry: MeltwaterTelemetry | null,
  hasApiKey: boolean,
  staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
  disabled: boolean = false,
): MeltwaterHealth {
  if (disabled) {
    return {
      status: "disabled",
      summary: "Meltwater pulling is disabled by operator configuration.",
      lastRunAt: telemetry?.lastRunAt?.toISOString() ?? null,
      lastRunAgeMs: ageMs(telemetry?.lastRunAt),
      outcome: telemetry?.outcome ?? null,
      ingested: telemetry?.ingested ?? 0,
      skipped: telemetry?.skipped ?? 0,
      dayRemaining: telemetry?.dayRemaining ?? null,
      dayLimit: telemetry?.dayLimit ?? null,
      dayResetAt: telemetry?.dayResetAt?.toISOString() ?? null,
      minuteRemaining: telemetry?.minuteRemaining ?? null,
      isDegraded: false,
      quotaWarning: false,
      overflow: telemetry?.overflow ?? false,
    };
  }
  if (!telemetry) {
    if (!hasApiKey) {
      return {
        status: "not-run",
        summary: "MELTWATER_API_KEY not configured — bot is disabled in this environment.",
        lastRunAt: null,
        lastRunAgeMs: null,
        outcome: null,
        ingested: 0,
        skipped: 0,
        dayRemaining: null,
        dayLimit: null,
        dayResetAt: null,
        minuteRemaining: null,
        isDegraded: false,
        quotaWarning: false,
        overflow: false,
      };
    }
    return {
      status: "not-run",
      summary: "Meltwater bot has not run in this environment yet — it only runs in the deployed app.",
      lastRunAt: null,
      lastRunAgeMs: null,
      outcome: null,
      ingested: 0,
      skipped: 0,
      dayRemaining: null,
      dayLimit: null,
      dayResetAt: null,
      minuteRemaining: null,
      isDegraded: false,
      quotaWarning: false,
      overflow: false,
    };
  }

  const runAge = ageMs(telemetry.lastRunAt);
  const isStale = runAge !== null && runAge > staleThresholdMs;
  const dayResetAt = telemetry.dayResetAt ? telemetry.dayResetAt.toISOString() : null;

  if (telemetry.outcome === "success") {
    const status: MeltwaterStatus = isStale ? "stale" : "healthy";
    const overflowNote = telemetry.overflow
      ? " Busy window — hit the page/quota ceiling, more docs remain (next run continues)."
      : "";
    const summary = isStale
      ? `Last successful run was ${fmtAge(runAge)} — overdue for cadence.`
      : `Running on cadence — last run ${fmtAge(runAge)}, ${telemetry.ingested} item(s) admitted.${overflowNote}`;
    return {
      status,
      summary,
      lastRunAt: telemetry.lastRunAt.toISOString(),
      lastRunAgeMs: runAge,
      outcome: "success",
      ingested: telemetry.ingested,
      skipped: telemetry.skipped,
      dayRemaining: telemetry.dayRemaining,
      dayLimit: telemetry.dayLimit,
      dayResetAt,
      minuteRemaining: telemetry.minuteRemaining,
      isDegraded: isStale,
      quotaWarning: !isStale && isQuotaLow(telemetry.dayRemaining, telemetry.dayLimit),
      overflow: telemetry.overflow,
    };
  }

  if (telemetry.outcome === "rate-limited") {
    const status: MeltwaterStatus = isStale ? "stale" : "throttled";
    const quotaLine = telemetry.dayRemaining != null
      ? ` Daily quota: ${telemetry.dayRemaining}${telemetry.dayLimit != null ? `/${telemetry.dayLimit}` : ''} remaining.`
      : "";
    const summary = isStale
      ? `Last run was ${fmtAge(runAge)} and returned a quota limit — overdue for cadence.`
      : `Rate-limited by Meltwater API ${fmtAge(runAge)} — quota pause, not an error.${quotaLine}`;
    return {
      status,
      summary,
      lastRunAt: telemetry.lastRunAt.toISOString(),
      lastRunAgeMs: runAge,
      outcome: "rate-limited",
      ingested: 0,
      skipped: 0,
      dayRemaining: telemetry.dayRemaining,
      dayLimit: telemetry.dayLimit,
      dayResetAt,
      minuteRemaining: telemetry.minuteRemaining,
      isDegraded: isStale,
      quotaWarning: false,
      overflow: telemetry.overflow,
    };
  }

  // outcome === 'error' (or any unrecognized value)
  const httpInfo = telemetry.httpStatus ? ` (HTTP ${telemetry.httpStatus})` : "";
  const summary = `Meltwater API error${httpInfo} — last run ${fmtAge(runAge)}.`;
  return {
    status: "error",
    summary,
    lastRunAt: telemetry.lastRunAt.toISOString(),
    lastRunAgeMs: runAge,
    outcome: telemetry.outcome,
    ingested: 0,
    skipped: 0,
    dayRemaining: telemetry.dayRemaining,
    dayLimit: telemetry.dayLimit,
    dayResetAt,
    minuteRemaining: telemetry.minuteRemaining,
    isDegraded: true,
    quotaWarning: false,
    overflow: telemetry.overflow,
  };
}

// ---------------------------------------------------------------------------
// Multi-search health — per-search verdicts + worst-of aggregate
// ---------------------------------------------------------------------------

// Human-readable display name / cadence description keyed by search label.
const SEARCH_META: Record<string, { displayName: string; cadenceLabel: string }> = {
  'meltwater-cpc': { displayName: 'CPC/SWL/EPC (adversary media)', cadenceLabel: 'hourly' },
  'meltwater-intus': { displayName: 'Int/US (international & US press)', cadenceLabel: 'every 2 hours' },
};

export function computeMeltwaterHealthMulti(
  telemetryRows: MeltwaterTelemetry[],
  hasApiKey: boolean,
  disabled: boolean = false,
): MeltwaterMultiHealth {
  // Build a lookup from search label → row.
  const byLabel = new Map<string, MeltwaterTelemetry>();
  for (const row of telemetryRows) {
    byLabel.set(row.id, row);
  }

  // Compute a verdict for each registered search.
  const searches: MeltwaterSearchVerdictItem[] = MELTWATER_SEARCHES.map((cfg) => {
    const staleThresholdMs = STALE_THRESHOLD_BY_LABEL[cfg.label] ?? DEFAULT_STALE_THRESHOLD_MS;
    const telemetry = byLabel.get(cfg.label) ?? null;
    const meta = SEARCH_META[cfg.label] ?? { displayName: cfg.label, cadenceLabel: 'unknown cadence' };
    return {
      label: cfg.label,
      displayName: meta.displayName,
      cadenceLabel: meta.cadenceLabel,
      staleThresholdMs,
      health: computeMeltwaterHealth(telemetry, hasApiKey, staleThresholdMs, disabled),
    };
  });

  // Combined shared-quota view: use the most-recent search's dayRemaining.
  // Both searches draw from ONE shared pool, so summing double-counts. The
  // authoritative remaining count is the reading from whichever search ran
  // most recently (its post-run snapshot reflects the current pool state).
  // Tie-break on lowest remaining (most conservative) when timestamps are equal.
  let totalDayRemaining: number | null = null;
  let sharedDayLimit: number | null = null;
  let searchesWithTelemetry = 0;
  let mostRecentRunAt: number | null = null;
  for (const s of searches) {
    if (s.health.dayRemaining != null) {
      searchesWithTelemetry++;
      const runAt = s.health.lastRunAt ? new Date(s.health.lastRunAt).getTime() : null;
      const isMoreRecent =
        runAt !== null &&
        (mostRecentRunAt === null ||
          runAt > mostRecentRunAt ||
          (runAt === mostRecentRunAt && s.health.dayRemaining < (totalDayRemaining ?? Infinity)));
      if (isMoreRecent) {
        mostRecentRunAt = runAt;
        totalDayRemaining = s.health.dayRemaining;
      } else if (totalDayRemaining === null) {
        // No runAt available — still capture a reading so the view is non-null.
        totalDayRemaining = s.health.dayRemaining;
      }
    }
    if (s.health.dayLimit != null) {
      sharedDayLimit = sharedDayLimit == null ? s.health.dayLimit : Math.max(sharedDayLimit, s.health.dayLimit);
    }
  }
  const warningFloor = getCombinedQuotaWarningFloor();
  const combinedQuota: MeltwaterCombinedQuota = {
    totalDayRemaining,
    dayLimit: sharedDayLimit,
    searchesWithTelemetry,
    searchCount: searches.length,
    partial: searchesWithTelemetry > 0 && searchesWithTelemetry < searches.length,
    warningFloor,
    belowFloor: totalDayRemaining != null && totalDayRemaining < warningFloor,
  };

  // Aggregate: worst-of status + degraded count.
  let worstStatus: MeltwaterStatus = "healthy";
  let degradedCount = 0;
  for (const s of searches) {
    if (s.health.isDegraded) degradedCount++;
    if (STATUS_RANK[s.health.status] > STATUS_RANK[worstStatus]) {
      worstStatus = s.health.status;
    }
  }

  return {
    searches,
    aggregate: {
      isDegraded: degradedCount > 0,
      degradedCount,
      worstStatus,
    },
    combinedQuota,
  };
}
