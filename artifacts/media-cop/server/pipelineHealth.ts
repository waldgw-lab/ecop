import { sql } from "drizzle-orm";
import { db } from "./db";
import {
  headlines,
  truthSocialPosts,
  xPosts,
  osintPosts,
  journalistPosts,
  rapidResponsePosts,
  dowResponsePosts,
  sentDefenderPosts,
  rssBotPosts,
  feedHealthState,
  type ScrapeMetadata,
} from "@shared/schema";
import { getRelayHeartbeat, isRelayHealthy } from "./truthSocialService";
import { getXRelayHeartbeat, isXRelayHealthy, getXRelayStaleThresholdMs, getXRelayFallbackPrimarySinceMs } from "./xRelayService";
import { computeXLaneStallReport, isStallAlert } from "./xLaneStallWatchdog";
import { getXCookieExpiredFlag } from "./xScraper";

// ============================================================================
// MAIN-FEED pipeline health (Task #400) — read-only.
//
// The curated lane already has a subsystem-health audit (the
// `review-curated-coverage` skill's Section D). This module is the MAIN-feed
// equivalent: it derives a healthy / degraded / broken / indeterminate verdict
// for each main-feed subsystem (general scrapers, Truth Social relay, X/Twitter
// relay, RSS monitor, stream media pre-fetch, priority/clustering) that powers
// Classic / Visual / custom-MCOP.
//
// Discipline mirrors Section D: every verdict corroborates BOTH a RUNTIME signal
// (persisted scrape metadata — last-run timestamps, consecutive-empty counters,
// scrape status / last error — and the in-memory relay heartbeats) AND a
// PRODUCTION TABLE / FRESHNESS signal (recent rows + newest timestamp in the
// subsystem's own output table). Missing evidence => `indeterminate`, never a
// guessed "healthy". A single cron miss is noise; thresholds are ~2 cadence
// cycles before a subsystem is called broken.
//
// STRICTLY READ-ONLY: this module only runs SELECT/aggregate queries and reads
// in-memory heartbeats. It never restarts, triggers, or repairs any job, relay,
// schema, or data.
// ============================================================================

export type PipelineStatus = "healthy" | "degraded" | "broken" | "indeterminate";

export interface PipelineVerdict {
  key: string;
  name: string;
  status: PipelineStatus;
  // One-line plain-language summary of the verdict.
  summary: string;
  // The persisted/in-memory runtime signal (scrape metadata / relay heartbeat).
  runtimeSignal: string;
  // The production table / freshness signal.
  tableSignal: string;
  // Supporting evidence lines (shown expanded in the UI / audit report).
  evidence: string[];
  // Optional operator-facing alert that must remain visible even while the
  // supporting evidence is collapsed.
  operatorAlert?: {
    kind: "warning";
    // Short badge label shown next to the status badge (falls back to a
    // generic label in older clients).
    label?: string;
    message: string;
  };
  // Best-known last success time across the corroborating signals (ISO).
  lastSuccessAt: string | null;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function ageMs(d: Date | null | undefined): number | null {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  if (Number.isNaN(t)) return null;
  return Date.now() - t;
}

function fmtAge(ms: number | null): string {
  if (ms === null) return "never";
  if (ms < MINUTE) return `${Math.round(ms / 1000)}s ago`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m ago`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)}h ago`;
  return `${Math.round(ms / (24 * HOUR))}d ago`;
}

function maxDate(...dates: (Date | null | undefined)[]): Date | null {
  let best: number | null = null;
  for (const d of dates) {
    if (!d) continue;
    const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
    if (Number.isNaN(t)) continue;
    if (best === null || t > best) best = t;
  }
  return best === null ? null : new Date(best);
}

// Aggregate freshness for one table: count of rows inside `windowMs` plus the
// newest timestamp overall (unfiltered), in a single read-only aggregate query.
async function tableFreshness(
  table: any,
  tsCol: any,
  windowMs: number,
): Promise<{ recent: number; maxTs: Date | null }> {
  const cutoff = new Date(Date.now() - windowMs);
  try {
    const [r] = await db
      .select({
        recent: sql<number>`count(*) filter (where ${tsCol} >= ${cutoff})`,
        maxTs: sql<string | null>`max(${tsCol})`,
      })
      .from(table);
    return {
      recent: Number(r?.recent ?? 0),
      maxTs: r?.maxTs ? new Date(r.maxTs) : null,
    };
  } catch {
    return { recent: 0, maxTs: null };
  }
}

// ---------------------------------------------------------------------------
// Individual subsystem verdicts. Each returns a fully-populated PipelineVerdict.
// ---------------------------------------------------------------------------

// 1) General scrapers — the ~10-min full-scrape cron that writes `headlines`.
async function generalScrapersVerdict(meta?: ScrapeMetadata): Promise<PipelineVerdict> {
  const fresh = await tableFreshness(headlines, headlines.scrapedAt, HOUR);
  // Broader window to distinguish a genuine stall from a quiet window. With
  // Drudge dormant, the active roster (Warfighter RSS + manual) is sparse and
  // quiet gaps of several hours are normal and expected.
  const broadFresh = await tableFreshness(headlines, headlines.scrapedAt, 8 * HOUR);
  const lastRun = meta?.headlinesLastScrapeTime ?? meta?.lastScrapeTime ?? null;
  const runAge = ageMs(lastRun ?? null);
  const tableAge = ageMs(fresh.maxTs);

  // ~10 min cadence — allow ~2.5 cycles before calling the runtime stale.
  const runtimeFresh = runAge !== null && runAge < 25 * MINUTE;
  const runtimeStale = runAge !== null && runAge >= 25 * MINUTE;
  const tableFresh = tableAge !== null && tableAge < 30 * MINUTE;
  const tableStale = tableAge !== null && tableAge >= 30 * MINUTE;

  const evidence: string[] = [];
  evidence.push(`Last full-scrape run: ${fmtAge(runAge)}${meta?.scrapeStatus ? ` (status: ${meta.scrapeStatus})` : ""}.`);
  evidence.push(`Newest headline row: ${fmtAge(tableAge)}; ${fresh.recent} headline(s) in the last hour, ${broadFresh.recent} in the last 8h.`);
  if (meta?.lastError && ageMs(meta.lastErrorTime ?? null) !== null && (ageMs(meta.lastErrorTime ?? null) as number) < 6 * HOUR) {
    evidence.push(`Recent scrape error (${fmtAge(ageMs(meta.lastErrorTime ?? null))}): ${String(meta.lastError).slice(0, 200)}`);
  }

  let status: PipelineStatus;
  let summary: string;
  if (runAge === null && tableAge === null) {
    status = "indeterminate";
    summary = "No scrape metadata or headline rows available to assess.";
  } else if (runtimeFresh && tableFresh) {
    status = "healthy";
    summary = `Scraping on cadence — ${fresh.recent} new headline(s) in the last hour.`;
  } else if (runtimeStale && tableStale) {
    status = "broken";
    summary = `Scraper stalled — last run ${fmtAge(runAge)}, newest headline ${fmtAge(tableAge)}.`;
  } else if (runtimeFresh && !tableFresh) {
    // Cron on cadence but no headlines in the 30-min window. With Drudge dormant,
    // the active roster (Warfighter RSS + manual) is sparse; quiet gaps are normal.
    // Mirror the stream pre-fetch's honest "idle, not broken" wording when there
    // is evidence of recent activity in a broader window.
    const quietRoster = broadFresh.recent > 0;
    status = "degraded";
    summary = quietRoster
      ? `Scraper on cadence (ran ${fmtAge(runAge)}) — no new headlines in 30 min but ${broadFresh.recent} item(s) in the last 8h; likely a quiet window with the sparse roster, not a stall.`
      : `Scraper ran ${fmtAge(runAge)} but no fresh headlines in 8h (newest ${fmtAge(tableAge)}).`;
  } else {
    status = "degraded";
    summary = `Scrape cron overdue (${fmtAge(runAge)}) though headlines still recent.`;
  }

  return {
    key: "general-scrapers",
    name: "General scrapers",
    status,
    summary,
    runtimeSignal: `last full-scrape ${fmtAge(runAge)}`,
    tableSignal: `newest headline ${fmtAge(tableAge)}, ${fresh.recent}/h`,
    evidence,
    lastSuccessAt: maxDate(lastRun ?? null, fresh.maxTs)?.toISOString() ?? null,
  };
}

// 2) Truth Social relay — heartbeat is the primary runtime signal; the scrapers
// are the PRIMARY fallback when it goes stale (dedup makes them backfill-only
// while it is healthy).
async function truthRelayVerdict(meta?: ScrapeMetadata): Promise<PipelineVerdict> {
  const fresh = await tableFreshness(truthSocialPosts, truthSocialPosts.scrapedAt, 3 * HOUR);
  const heartbeat = getRelayHeartbeat();
  const relayHealthy = isRelayHealthy();
  const hbAge = heartbeat > 0 ? Date.now() - heartbeat : null;
  const scraperRun = meta?.truthSocialLastScrapeTime ?? null;
  const scraperAge = ageMs(scraperRun);
  const tableAge = ageMs(fresh.maxTs);

  const evidence: string[] = [];
  evidence.push(`Relay heartbeat: ${fmtAge(hbAge)} (${relayHealthy ? "WATCHDOG mode — relay healthy" : "PRIMARY mode — relay stale/absent, scrapers covering"}).`);
  evidence.push(`Scraper fallback last run: ${fmtAge(scraperAge)}.`);
  evidence.push(`Newest Truth Social post ingested: ${fmtAge(tableAge)}; ${fresh.recent} in the last 3h.`);

  // Scrapers should run on the ~10-min cron whether or not the relay is healthy.
  const scraperFresh = scraperAge !== null && scraperAge < 25 * MINUTE;
  // Posts demonstrably arriving is ground truth — it caps the verdict at
  // `degraded` even when both runtime signals look stale (an ingestion path we
  // can't see is clearly working), so a heartbeat/cron reporting gap never
  // false-alarms as broken.
  const dataFlowing = tableAge !== null && tableAge < 3 * HOUR && fresh.recent > 0;
  let status: PipelineStatus;
  let summary: string;
  if (hbAge === null && scraperAge === null && tableAge === null) {
    status = "indeterminate";
    summary = "No relay heartbeat, scraper run, or ingested posts to assess.";
  } else if (relayHealthy && dataFlowing) {
    // Both signals corroborate: heartbeat live AND posts landing in the table.
    status = "healthy";
    summary = `Relay live (heartbeat ${fmtAge(hbAge)}); ${fresh.recent} post(s) ingested in the last 3h.`;
  } else if (relayHealthy) {
    // Heartbeat live but the table shows no fresh posts — never call this healthy
    // (could be a silent write failure, not just a quiet window).
    status = "degraded";
    summary = `Relay heartbeat healthy (${fmtAge(hbAge)}) but no posts ingested in the last 3h — possible write failure or a quiet window.`;
  } else if (scraperFresh && dataFlowing) {
    status = "degraded";
    summary = `Relay stale (${fmtAge(hbAge)}) — scraper fallback covering, last post ${fmtAge(tableAge)}.`;
  } else if (scraperFresh) {
    status = "degraded";
    summary = `Relay stale (${fmtAge(hbAge)}); scrapers running but no posts in 3h (may be a quiet window).`;
  } else if (dataFlowing) {
    status = "degraded";
    summary = `Relay stale (${fmtAge(hbAge)}) and scraper cron overdue (${fmtAge(scraperAge)}), but posts are still arriving (newest ${fmtAge(tableAge)}, ${fresh.recent} in 3h).`;
  } else {
    status = "broken";
    summary = `Relay stale (${fmtAge(hbAge)}) and scraper fallback overdue (${fmtAge(scraperAge)}); no posts in 3h.`;
  }

  return {
    key: "truth-social-relay",
    name: "Truth Social relay",
    status,
    summary,
    runtimeSignal: `heartbeat ${fmtAge(hbAge)}${relayHealthy ? " (healthy)" : " (stale)"}, scraper ${fmtAge(scraperAge)}`,
    tableSignal: `newest post ${fmtAge(tableAge)}, ${fresh.recent}/3h`,
    evidence,
    lastSuccessAt: maxDate(heartbeat > 0 ? new Date(heartbeat) : null, scraperRun, fresh.maxTs)?.toISOString() ?? null,
  };
}

// 3) X / Twitter relay ("Evangelist Vortex") — heartbeat + the per-lane scrapers
// (with consecutive-empty blocking counters) corroborated by the lane tables.
async function xRelayVerdict(meta?: ScrapeMetadata): Promise<PipelineVerdict> {
  const laneTables: { table: any; col: any }[] = [
    { table: xPosts, col: xPosts.scrapedAt },
    { table: osintPosts, col: osintPosts.scrapedAt },
    { table: journalistPosts, col: journalistPosts.scrapedAt },
    { table: rapidResponsePosts, col: rapidResponsePosts.scrapedAt },
    { table: dowResponsePosts, col: dowResponsePosts.scrapedAt },
    { table: sentDefenderPosts, col: sentDefenderPosts.scrapedAt },
  ];
  const laneResults = await Promise.all(laneTables.map((l) => tableFreshness(l.table, l.col, 3 * HOUR)));
  const recentTotal = laneResults.reduce((s, r) => s + r.recent, 0);
  const newest = maxDate(...laneResults.map((r) => r.maxTs));
  const tableAge = ageMs(newest);

  const heartbeat = getXRelayHeartbeat();
  const relayHealthy = isXRelayHealthy();
  const hbAge = heartbeat > 0 ? Date.now() - heartbeat : null;
  const scraperRun = meta?.xPostsLastScrapeTime ?? null;
  const scraperAge = ageMs(scraperRun);

  // Consecutive-empty counters flag suspected blocking even when the cron runs.
  const emptyCounters = [
    ["@SecWar/@PeteHegseth", meta?.xPostsConsecutiveEmpty ?? 0],
    ["OSINT feeds", meta?.osintConsecutiveEmpty ?? 0],
    ["@Rapidresponse47", meta?.rapidResponseConsecutiveEmpty ?? 0],
    ["@DOWResponse", meta?.dowResponseConsecutiveEmpty ?? 0],
    ["@sentdefender", meta?.sentDefenderConsecutiveEmpty ?? 0],
    ["Influencer X", meta?.influencerXConsecutiveEmpty ?? 0],
  ] as const;
  const blocking = emptyCounters.filter(([, n]) => (n as number) >= 2);

  // Per-lane stall watchdog (Task #34) — classifies "scheduler not ticking" vs
  // "X lanes stalled behind a wedged lock" vs "scrapes running but empty",
  // gated on relay health (lanes intentionally idle in WATCHDOG mode).
  const stallReport = computeXLaneStallReport(meta, {
    nowMs: Date.now(),
    relayHealthy,
    relayHeartbeatMs: heartbeat,
    relayStaleThresholdMs: getXRelayStaleThresholdMs(),
    fallbackPrimarySinceMs: getXRelayFallbackPrimarySinceMs(),
  });
  const stallAlert = isStallAlert(stallReport);

  const xCookiesExpired = getXCookieExpiredFlag();
  const evidence: string[] = [];
  evidence.push(`Relay heartbeat: ${fmtAge(hbAge)} (${relayHealthy ? "WATCHDOG mode — relay healthy, X Playwright scrapers skipped" : "PRIMARY mode — relay stale/absent, scrapers covering"}).`);
  evidence.push(`Scraper fallback last run: ${fmtAge(scraperAge)}.`);
  evidence.push(`Newest X post ingested across all lanes: ${fmtAge(tableAge)}; ${recentTotal} in the last 3h.`);
  if (xCookiesExpired) {
    evidence.push(`⚠️ X auth cookies appear EXPIRED — scrapers detected a login wall (0 tweets, no @username in title). Refresh X_AUTH_TOKEN and X_CT0 env vars.`);
  }
  if (blocking.length > 0) {
    evidence.push(`Suspected blocking (≥2 consecutive empty scrapes): ${blocking.map(([n, c]) => `${n} (${c})`).join(", ")}.`);
  }
  if (stallAlert) {
    evidence.push(`🚨 X-lane stall watchdog [${stallReport.mode}]: ${stallReport.summary}`);
    for (const lane of stallReport.lanes.filter((l) => l.overdue)) {
      evidence.push(`  ↳ ${lane.label}: last stamp ${lane.lastStampAt ?? "never"} (cadence ${Math.round(lane.cadenceMs / MINUTE)}m).`);
    }
  }

  const scraperFresh = scraperAge !== null && scraperAge < 25 * MINUTE;
  // Posts demonstrably arriving across the lanes is ground truth — caps the
  // verdict at `degraded` even when both runtime signals look stale, so a
  // heartbeat/cron reporting gap never false-alarms as broken.
  const dataFlowing = tableAge !== null && tableAge < 3 * HOUR && recentTotal > 0;
  let status: PipelineStatus;
  let summary: string;
  if (hbAge === null && scraperAge === null && tableAge === null) {
    status = "indeterminate";
    summary = "No relay heartbeat, scraper run, or ingested posts to assess.";
  } else if (relayHealthy && dataFlowing) {
    // Both signals corroborate: heartbeat live AND posts landing across lanes.
    // In WATCHDOG mode the Playwright scrapers are skipped entirely, so the
    // consecutive-empty counters are frozen at their pre-relay values and do NOT
    // reflect active blocking. Only flag suspected blocking when scrapers are
    // actually running (PRIMARY mode = !relayHealthy). Evidence is still shown
    // below for informational purposes.
    status = "healthy";
    summary = `Relay live (heartbeat ${fmtAge(hbAge)}); ${recentTotal} post(s) ingested across lanes in the last 3h.`;
  } else if (relayHealthy) {
    // Heartbeat live but no fresh posts in any lane — never call this healthy
    // (could be a silent write failure, not just a quiet window).
    status = "degraded";
    summary = `Relay heartbeat healthy (${fmtAge(hbAge)}) but no posts ingested across lanes in the last 3h — possible write failure or a quiet window.`;
  } else if (scraperFresh && dataFlowing) {
    status = "degraded";
    summary = `Relay stale (${fmtAge(hbAge)}) — scraper fallback covering, last post ${fmtAge(tableAge)}.`;
  } else if (scraperFresh) {
    status = blocking.length > 0 ? "broken" : "degraded";
    summary = blocking.length > 0
      ? `Relay stale and scrapers returning empty (suspected blocking on ${blocking.length} lane(s)).`
      : `Relay stale (${fmtAge(hbAge)}); scrapers running but no posts in 3h (may be a quiet window).`;
  } else if (dataFlowing) {
    status = "degraded";
    summary = `Relay stale (${fmtAge(hbAge)}) and scraper cron overdue (${fmtAge(scraperAge)}), but posts are still arriving (newest ${fmtAge(tableAge)}, ${recentTotal} in 3h).`;
  } else {
    status = "broken";
    summary = `Relay stale (${fmtAge(hbAge)}) and scraper fallback overdue (${fmtAge(scraperAge)}); no posts in 3h.`;
  }

  // Lane-stall escalation (Task #34): a positive stall classification overrides
  // the softer heuristics above — operators must see it within one cycle.
  if (stallAlert) {
    status = dataFlowing && stallReport.mode === "scrapes-empty" ? "degraded" : "broken";
    summary = stallReport.summary;
  }

  return {
    key: "x-twitter-relay",
    name: "X / Twitter relay",
    status,
    summary,
    // Only surface blocking in the runtimeSignal when scrapers are actually
    // running (PRIMARY mode). In WATCHDOG mode the counters are frozen, so
    // showing "blocking" would be misleading.
    runtimeSignal: `heartbeat ${fmtAge(hbAge)}${relayHealthy ? " (healthy)" : " (stale)"}, scraper ${fmtAge(scraperAge)}${!relayHealthy && blocking.length ? `, ${blocking.length} lane(s) blocking` : ""}`,
    tableSignal: `newest post ${fmtAge(tableAge)}, ${recentTotal}/3h`,
    evidence,
    operatorAlert: stallAlert
      ? {
          kind: "warning",
          label:
            stallReport.mode === "scheduler-stalled" ? "Scheduler not ticking"
            : stallReport.mode === "lanes-stalled" ? "X lanes stalled"
            : "Scrapes returning nothing",
          message: stallReport.summary,
        }
      : xCookiesExpired
      ? {
          kind: "warning",
          label: "Auth cookies expired",
          message: "X auth cookies expired. Refresh X_AUTH_TOKEN and X_CT0 to restore scraper fallback coverage.",
        }
      : undefined,
    lastSuccessAt: maxDate(heartbeat > 0 ? new Date(heartbeat) : null, scraperRun, newest)?.toISOString() ?? null,
  };
}

// 4) RSS Feed Monitor — writes `rss_bot_posts` only for CJCS-relevant articles,
// so it is legitimately sparse. It runs on its OWN ~5-min cron (rssFeedBot),
// independent of the main full-scrape chain. Runtime corroboration is the RSS
// monitor's own heartbeat (it stamps `feed_health_state` rows scoped
// 'rss-monitor' every cycle) — NOT the shared full-scrape timestamp, which can
// freeze while the RSS bot keeps posting normally. Fresh RSS-bot output is
// ground truth: posts demonstrably arriving caps the verdict at healthy
// regardless of any scheduler timestamp.
async function rssMonitorVerdict(_meta?: ScrapeMetadata): Promise<PipelineVerdict> {
  const fresh = await tableFreshness(rssBotPosts, rssBotPosts.postedAt, 6 * HOUR);
  // RSS monitor's own runtime heartbeat: newest feed-health row it stamped on its
  // own cycle (decoupled from the full-scrape cron).
  let monitorRun: Date | null = null;
  try {
    const [r] = await db
      .select({ maxSeen: sql<string | null>`max(${feedHealthState.lastSeenAt})` })
      .from(feedHealthState)
      .where(sql`${feedHealthState.scope} = 'rss-monitor'`);
    monitorRun = r?.maxSeen ? new Date(r.maxSeen) : null;
  } catch {
    /* fall through — table signal still drives the verdict */
  }
  const monitorAge = ageMs(monitorRun);
  const tableAge = ageMs(fresh.maxTs);
  // ~5-min cadence — allow several cycles before calling the monitor's own cron stale.
  const monitorAlive = monitorAge !== null && monitorAge < 25 * MINUTE;
  // Fresh RSS-bot output = ground truth: recent posts mean the monitor is healthy
  // regardless of the shared full-scrape timestamp.
  const dataFlowing = tableAge !== null && tableAge < 6 * HOUR;

  const evidence: string[] = [];
  evidence.push(`RSS monitor heartbeat (its own ~5-min cron): ${fmtAge(monitorAge)}.`);
  evidence.push(`Newest RSS-bot post: ${fmtAge(tableAge)}; ${fresh.recent} in the last 6h. (RSS bot only posts CJCS-relevant items, so quiet windows are normal.)`);

  let status: PipelineStatus;
  let summary: string;
  if (monitorAge === null && tableAge === null) {
    status = "indeterminate";
    summary = "No RSS monitor heartbeat or RSS-bot rows available to assess.";
  } else if (dataFlowing) {
    // Fresh output = healthy, independent of the full-scrape timestamp.
    status = "healthy";
    summary = `RSS monitor producing — ${fresh.recent} relevant post(s) in the last 6h.`;
  } else if (tableAge !== null && tableAge < 24 * HOUR) {
    status = "degraded";
    summary = `No RSS-bot posts in 6h (newest ${fmtAge(tableAge)}) — likely low yield or some feeds breaking.`;
  } else if (tableAge !== null) {
    status = "broken";
    summary = `No RSS-bot posts in over 24h (newest ${fmtAge(tableAge)}).`;
  } else {
    // No RSS-bot rows at all. Corroborate with the monitor's own heartbeat: an
    // alive cron with no output yet is a reporting gap (degraded); a stale cron
    // with no output gives no way to isolate the monitor (indeterminate).
    status = monitorAlive ? "degraded" : "indeterminate";
    summary = monitorAlive
      ? `RSS monitor cron alive (${fmtAge(monitorAge)}) but no RSS-bot posts recorded yet.`
      : `No RSS-bot posts and RSS monitor heartbeat stale (${fmtAge(monitorAge)}) — cannot isolate RSS monitor health.`;
  }

  return {
    key: "rss-monitor",
    name: "RSS Feed Monitor",
    status,
    summary,
    runtimeSignal: `RSS monitor cron ${fmtAge(monitorAge)}`,
    tableSignal: `newest RSS post ${fmtAge(tableAge)}, ${fresh.recent}/6h`,
    evidence,
    lastSuccessAt: maxDate(monitorRun, fresh.maxTs)?.toISOString() ?? null,
  };
}

// 5) Stream media pre-fetch — caches images + AI summary bullets onto top
// headlines (stamps `media_scraped_at`). Runs continuously, so the newest
// `media_scraped_at` should be very recent when healthy.
async function streamPrefetchVerdict(meta?: ScrapeMetadata): Promise<PipelineVerdict> {
  const fresh = await tableFreshness(headlines, headlines.mediaScrapedAt, 2 * HOUR);
  const headlineFresh = await tableFreshness(headlines, headlines.scrapedAt, 2 * HOUR);
  const schedulerRun = meta?.lastScrapeTime ?? null;
  const schedulerAge = ageMs(schedulerRun);
  const tableAge = ageMs(fresh.maxTs);
  const schedulerAlive = schedulerAge !== null && schedulerAge < 25 * MINUTE;
  const haveFreshHeadlines = headlineFresh.recent > 0;

  const evidence: string[] = [];
  evidence.push(`Scheduler heartbeat: ${fmtAge(schedulerAge)}.`);
  evidence.push(`Newest media enrichment stamp: ${fmtAge(tableAge)}; ${fresh.recent} headline(s) enriched in the last 2h.`);
  evidence.push(`Fresh headlines available to enrich (last 2h): ${headlineFresh.recent}.`);

  let status: PipelineStatus;
  let summary: string;
  if (schedulerAge === null && tableAge === null) {
    status = "indeterminate";
    summary = "No scheduler metadata or media-enrichment stamps available to assess.";
  } else if (!schedulerAlive && tableAge === null) {
    status = "indeterminate";
    summary = `Scheduler heartbeat stale (${fmtAge(schedulerAge)}) and no enrichment stamps — cannot assess.`;
  } else if (tableAge !== null && tableAge < 30 * MINUTE) {
    status = "healthy";
    summary = `Media pre-fetch running — ${fresh.recent} headline(s) enriched in the last 2h.`;
  } else if (!haveFreshHeadlines) {
    status = "degraded";
    summary = `No recent enrichment (newest ${fmtAge(tableAge)}) but also no fresh headlines to enrich — likely idle, not broken.`;
  } else if (tableAge !== null && tableAge < 2 * HOUR) {
    status = "degraded";
    summary = `Media enrichment lagging (newest ${fmtAge(tableAge)}) with fresh headlines waiting.`;
  } else {
    status = "broken";
    summary = `No media enrichment in 2h+ (newest ${fmtAge(tableAge)}) despite ${headlineFresh.recent} fresh headline(s) to enrich.`;
  }

  return {
    key: "stream-media-prefetch",
    name: "Stream media pre-fetch",
    status,
    summary,
    runtimeSignal: `scheduler ${fmtAge(schedulerAge)}`,
    tableSignal: `newest enrichment ${fmtAge(tableAge)}, ${fresh.recent}/2h`,
    evidence,
    lastSuccessAt: maxDate(schedulerRun, fresh.maxTs)?.toISOString() ?? null,
  };
}

// 6) Priority scoring / headline clustering. Judged on its OWN output — the
// share of recent headlines that carry a priority score, and clustering
// activity — NOT the shared full-scrape timestamp (which can freeze while
// warfighter-RSS / manual headlines keep arriving and being scored normally).
// The scorer's own runtime heartbeat is the newest *scored* headline (proof the
// scorer executed). Fresh output = ground truth: recent headlines being scored
// at a healthy rate reads healthy regardless of the full-scrape timestamp, and a
// 0-cluster count in a low-volume window is never treated as a fault.
async function priorityClusteringVerdict(_meta?: ScrapeMetadata): Promise<PipelineVerdict> {
  const cutoff = new Date(Date.now() - 6 * HOUR);
  let recent = 0;
  let scored = 0;
  let clustered = 0;
  let maxTs: Date | null = null;
  let maxScoredTs: Date | null = null;
  try {
    const [r] = await db
      .select({
        recent: sql<number>`count(*)`,
        scored: sql<number>`count(*) filter (where ${headlines.priorityScore} > 0)`,
        clustered: sql<number>`count(*) filter (where ${headlines.clusterId} is not null)`,
        maxTs: sql<string | null>`max(${headlines.scrapedAt})`,
        maxScoredTs: sql<string | null>`max(${headlines.scrapedAt}) filter (where ${headlines.priorityScore} > 0)`,
      })
      .from(headlines)
      .where(sql`${headlines.scrapedAt} >= ${cutoff}`);
    recent = Number(r?.recent ?? 0);
    scored = Number(r?.scored ?? 0);
    clustered = Number(r?.clustered ?? 0);
    maxTs = r?.maxTs ? new Date(r.maxTs) : null;
    maxScoredTs = r?.maxScoredTs ? new Date(r.maxScoredTs) : null;
  } catch {
    /* fall through to indeterminate */
  }
  // The scorer's own runtime heartbeat: newest scored headline (proof scoring
  // actually executed), decoupled from the full-scrape timestamp.
  const scoringAge = ageMs(maxScoredTs);
  const scoredPct = recent > 0 ? Math.round((scored / recent) * 100) : 0;
  // Fresh output = ground truth: recent headlines scored at a healthy rate means
  // scoring is working regardless of the full-scrape timestamp.
  const scoringHealthy = recent > 0 && scoredPct >= 50;

  const evidence: string[] = [];
  evidence.push(`Scoring heartbeat (newest scored headline, its own output): ${fmtAge(scoringAge)}.`);
  evidence.push(`Last 6h headlines: ${recent} total, ${scored} scored (${scoredPct}%), ${clustered} assigned to a cluster. (0 clusters in a low-volume window is normal, not a fault.)`);

  let status: PipelineStatus;
  let summary: string;
  if (recent === 0) {
    // Nothing arrived to score/cluster — low-volume window, not a fault.
    status = "indeterminate";
    summary = "No headlines in the last 6h to evaluate priority/clustering against.";
  } else if (scoringHealthy) {
    status = "healthy";
    summary = `Priority scoring active (${scoredPct}% of recent headlines scored, newest scored ${fmtAge(scoringAge)}); ${clustered} clustered headline(s) in the last 6h.`;
  } else {
    status = "degraded";
    summary = `Only ${scoredPct}% of recent headlines are scored (newest scored ${fmtAge(scoringAge)}) — scoring may be lagging.`;
  }

  return {
    key: "priority-clustering",
    name: "Priority scoring / clustering",
    status,
    summary,
    runtimeSignal: `newest scored ${fmtAge(scoringAge)}`,
    tableSignal: `${scoredPct}% scored, ${clustered} clustered (6h)`,
    evidence,
    lastSuccessAt: maxDate(maxScoredTs, maxTs)?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public entry point — compute every main-feed subsystem verdict in parallel.
// `meta` is passed in so the caller can reuse a single scrape-metadata read.
// ---------------------------------------------------------------------------
export async function computePipelineHealth(meta?: ScrapeMetadata): Promise<PipelineVerdict[]> {
  return Promise.all([
    generalScrapersVerdict(meta),
    truthRelayVerdict(meta),
    xRelayVerdict(meta),
    rssMonitorVerdict(meta),
    streamPrefetchVerdict(meta),
    priorityClusteringVerdict(meta),
  ]);
}

// The six subsystems this module audits, in display order. Single source of
// truth so the failure-path placeholder always lists every subsystem.
const PIPELINE_SUBSYSTEMS: { key: string; name: string }[] = [
  { key: "general-scrapers", name: "General scrapers" },
  { key: "truth-social-relay", name: "Truth Social relay" },
  { key: "x-twitter-relay", name: "X / Twitter relay" },
  { key: "rss-monitor", name: "RSS Feed Monitor" },
  { key: "stream-media-prefetch", name: "Stream media pre-fetch" },
  { key: "priority-clustering", name: "Priority scoring / clustering" },
];

// Failure-path fallback: when the metadata read or a verdict computation throws,
// still return all six subsystems as `indeterminate` (never an empty array) so
// the UI keeps listing every subsystem with an honest "couldn't assess" reason.
export function indeterminatePipeline(reason: string): PipelineVerdict[] {
  return PIPELINE_SUBSYSTEMS.map(({ key, name }) => ({
    key,
    name,
    status: "indeterminate" as PipelineStatus,
    summary: `Could not assess: ${reason}`,
    runtimeSignal: "unavailable",
    tableSignal: "unavailable",
    evidence: [`Health computation failed before signals could be read: ${reason}`],
    lastSuccessAt: null,
  }));
}

export function summarizePipeline(verdicts: PipelineVerdict[]): Record<PipelineStatus, number> {
  const out: Record<PipelineStatus, number> = { healthy: 0, degraded: 0, broken: 0, indeterminate: 0 };
  for (const v of verdicts) out[v.status]++;
  return out;
}
