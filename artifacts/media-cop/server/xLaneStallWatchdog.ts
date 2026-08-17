// Per-lane X ingestion stall watchdog (Task #34).
//
// Background: on Aug 17 2026 a 12:44 UTC runFullScrape hard-bound timeout left
// its body running as an uncancellable background "zombie" that kept acquiring
// the process-wide browser lock lane-by-lane (45s cooldowns included). Every
// subsequent cycle's X lanes and the OSINT cron queued behind that lock, burned
// their own budgets while waiting, and timed out before stamping any lane
// metadata — so all X lanes froze for ~50 min while the app looked healthy.
// Nobody noticed until a stale Coverage banner hours later.
//
// This module is a PURE, read-only classifier over the persisted scrape
// metadata. It compares each X lane's last stamp against its expected cadence
// and distinguishes three failure modes that look identical from the outside:
//   - "scheduler-stalled": the whole full-scrape chain isn't ticking at all
//     (lastScrapeTime itself is overdue) — a process/cron problem, not a lane
//     problem.
//   - "lanes-stalled": the chain IS ticking (lastScrapeTime fresh) but one or
//     more X lane stamps are overdue by more than one cron cycle — the exact
//     signature of the wedged-browser-lock incident.
//   - "scrapes-empty": lanes are stamping on cadence but returning nothing
//     (consecutive-empty counters ≥ 2) — rate limiting / login wall, not a
//     scheduling problem.
//
// Relay gating: when the EV relay is healthy the Playwright lanes are
// intentionally skipped and their stamps legitimately freeze — that is
// "relay-covering", never a stall. When the relay goes stale the lanes only
// become expected again from the moment PRIMARY mode began (heartbeat +
// staleness threshold), so a lane is measured against
// max(its stamp, primary-mode start), preventing false alarms right after a
// relay-health transition.

import type { ScrapeMetadata } from "@shared/schema";

const MINUTE = 60 * 1000;

export type LaneKey =
  | "xPosts"
  | "rapidResponse"
  | "dowResponse"
  | "sentDefender"
  | "osint"
  | "influencerX";

export interface LaneStallRow {
  key: LaneKey;
  label: string;
  cadenceMs: number;
  lastStampAt: string | null;
  /** ms since the lane was last stamped, measured from max(stamp, primary-mode start) */
  effectiveAgeMs: number | null;
  overdue: boolean;
  consecutiveEmpty: number;
}

export type StallMode =
  | "relay-covering" // relay healthy — lanes intentionally idle, nothing to assess
  | "ok"
  | "scheduler-stalled" // whole chain not ticking
  | "lanes-stalled" // chain ticking but ≥1 lane stamp overdue >1 cycle
  | "scrapes-empty" // lanes stamping but returning nothing (≥2 consecutive empty)
  | "indeterminate";

export interface LaneStallReport {
  checkedAt: string;
  mode: StallMode;
  summary: string;
  stalledLanes: string[];
  emptyLanes: string[];
  lanes: LaneStallRow[];
}

export interface LaneStallInputs {
  nowMs: number;
  /** current relay health — healthy means Playwright lanes are intentionally skipped */
  relayHealthy: boolean;
  /** last relay heartbeat epoch ms (0 = never) */
  relayHeartbeatMs: number;
  /** heartbeat age beyond which the relay counts as stale and lanes run in PRIMARY mode */
  relayStaleThresholdMs: number;
  /**
   * Baseline for when PRIMARY mode began when the relay has NEVER heartbeated
   * (relayHeartbeatMs = 0) — e.g. the first moment the relay was observed
   * stale in this process (see getXRelayFallbackPrimarySinceMs). Without it a
   * lane that never stamps could never be flagged overdue.
   */
  fallbackPrimarySinceMs?: number | null;
}

// A lane is "overdue" when its effective age exceeds 2× cadence + grace —
// i.e. it missed more than one full cron cycle beyond the expected one.
const GRACE_MS = 5 * MINUTE;
// The full-scrape chain runs every 10 min; ~2.5 cycles = scheduler stalled
// (same threshold pipelineHealth uses for "runtime stale").
const SCHEDULER_STALL_MS = 25 * MINUTE;

interface LaneDef {
  key: LaneKey;
  label: string;
  cadenceMs: number;
  stamp: (m: ScrapeMetadata) => Date | string | null | undefined;
  empty: (m: ScrapeMetadata) => number;
}

const LANES: LaneDef[] = [
  { key: "xPosts", label: "@SecWar/@PeteHegseth", cadenceMs: 10 * MINUTE, stamp: (m) => m.xPostsLastScrapeTime, empty: (m) => m.xPostsConsecutiveEmpty ?? 0 },
  { key: "rapidResponse", label: "@Rapidresponse47", cadenceMs: 10 * MINUTE, stamp: (m) => m.rapidResponseLastScrapeTime, empty: (m) => m.rapidResponseConsecutiveEmpty ?? 0 },
  { key: "dowResponse", label: "@DOWResponse", cadenceMs: 10 * MINUTE, stamp: (m) => m.dowResponseLastScrapeTime, empty: (m) => m.dowResponseConsecutiveEmpty ?? 0 },
  { key: "sentDefender", label: "@sentdefender", cadenceMs: 10 * MINUTE, stamp: (m) => m.sentDefenderLastScrapeTime, empty: (m) => m.sentDefenderConsecutiveEmpty ?? 0 },
  { key: "osint", label: "OSINT feeds", cadenceMs: 30 * MINUTE, stamp: (m) => m.osintLastScrapeTime, empty: (m) => m.osintConsecutiveEmpty ?? 0 },
  { key: "influencerX", label: "Influencer X", cadenceMs: 30 * MINUTE, stamp: (m) => m.influencerXLastScrapeTime, empty: (m) => m.influencerXConsecutiveEmpty ?? 0 },
];

function toMs(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
}

export function computeXLaneStallReport(
  meta: ScrapeMetadata | undefined,
  inputs: LaneStallInputs,
): LaneStallReport {
  const { nowMs, relayHealthy, relayHeartbeatMs, relayStaleThresholdMs } = inputs;
  const checkedAt = new Date(nowMs).toISOString();

  if (relayHealthy) {
    return {
      checkedAt,
      mode: "relay-covering",
      summary: "EV relay healthy — Playwright X lanes intentionally idle (relay delivering posts).",
      stalledLanes: [],
      emptyLanes: [],
      lanes: [],
    };
  }

  if (!meta) {
    return {
      checkedAt,
      mode: "indeterminate",
      summary: "No scrape metadata available to assess X lane freshness.",
      stalledLanes: [],
      emptyLanes: [],
      lanes: [],
    };
  }

  // The moment PRIMARY mode began: lanes were legitimately frozen while the
  // relay was healthy, so measure lane age from whichever is newer — the lane's
  // own stamp or the primary-mode start.
  const primarySinceMs =
    relayHeartbeatMs > 0
      ? relayHeartbeatMs + relayStaleThresholdMs
      : inputs.fallbackPrimarySinceMs ?? null;
  // Last-resort baseline for a lane that has NEVER stamped when no relay-based
  // baseline exists either: the chain's own stamp proves the scheduler has been
  // ticking, so a never-stamping lane is overdue relative to it. A lane that
  // never starts is precisely a silent stall and must not read as "ok".
  const chainStampMs = toMs(meta.lastScrapeTime);

  const lanes: LaneStallRow[] = LANES.map((lane) => {
    const stampMs = toMs(lane.stamp(meta));
    const baseline =
      stampMs !== null && primarySinceMs !== null
        ? Math.max(stampMs, primarySinceMs)
        : stampMs ?? primarySinceMs ?? chainStampMs;
    const effectiveAgeMs = baseline !== null ? nowMs - baseline : null;
    const overdue =
      effectiveAgeMs !== null && effectiveAgeMs > 2 * lane.cadenceMs + GRACE_MS;
    return {
      key: lane.key,
      label: lane.label,
      cadenceMs: lane.cadenceMs,
      lastStampAt: stampMs !== null ? new Date(stampMs).toISOString() : null,
      effectiveAgeMs,
      overdue,
      consecutiveEmpty: lane.empty(meta),
    };
  });

  const chainAgeMs = (() => {
    const t = toMs(meta.lastScrapeTime);
    return t !== null ? nowMs - t : null;
  })();

  const stalled = lanes.filter((l) => l.overdue);
  const stalledLanes = stalled.map((l) => l.label);
  const emptyLanes = lanes.filter((l) => !l.overdue && l.consecutiveEmpty >= 2).map((l) => l.label);

  let mode: StallMode;
  let summary: string;
  if (chainAgeMs === null && lanes.every((l) => l.effectiveAgeMs === null)) {
    mode = "indeterminate";
    summary = "No scrape stamps recorded yet — nothing to assess.";
  } else if (chainAgeMs !== null && chainAgeMs > SCHEDULER_STALL_MS) {
    mode = "scheduler-stalled";
    summary = `Full-scrape chain itself is not ticking — last cycle stamped ${Math.round(chainAgeMs / MINUTE)}m ago (expected ~10m). This is a scheduler/process problem, not a lane problem.`;
  } else if (stalled.length > 0) {
    mode = "lanes-stalled";
    summary = `Scheduler is ticking (last cycle ${chainAgeMs !== null ? Math.round(chainAgeMs / MINUTE) : "?"}m ago) but ${stalled.length} X lane(s) overdue >1 cron cycle: ${stalledLanes.join(", ")}. Signature of a wedged browser lock / starved lanes.`;
  } else if (emptyLanes.length > 0) {
    mode = "scrapes-empty";
    summary = `X lanes are running on cadence but returning nothing (${emptyLanes.join(", ")} at ≥2 consecutive empty scrapes) — likely rate limiting or a login wall, not a scheduling problem.`;
  } else {
    mode = "ok";
    summary = "All X lanes stamping on cadence in PRIMARY mode.";
  }

  return { checkedAt, mode, summary, stalledLanes, emptyLanes, lanes };
}

export function isStallAlert(report: LaneStallReport): boolean {
  return (
    report.mode === "scheduler-stalled" ||
    report.mode === "lanes-stalled" ||
    report.mode === "scrapes-empty"
  );
}
