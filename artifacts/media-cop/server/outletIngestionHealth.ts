// Read-only per-outlet ingestion-health builder (Registry tab, Source Oversight).
//
// This module answers ONE question for every Outlet Registry row: "HOW is this
// outlet's content ingested, and is that pipeline healthy right now?" It maps
// each registry outlet to the concrete ingestion pipeline(s) that feed it —
// RSS feeds (main-feed RSS Monitor + Warfighter list + curated feeds), the X/EV
// relay + Playwright scraper, the Truth Social relay + fallback scraper, the
// Meltwater API, and the OSINT scraper — then derives a primary/secondary
// health verdict from data that ALREADY exists:
//
//   - feedHealthTracker (server/feedHealthTracker.ts) — per-feed-URL outcome +
//     lastSeenAt / lastHealthyAt for RSS/scraper feeds.
//   - relay heartbeats (server/xRelayService.ts, server/truthSocialService.ts)
//     for the X and Truth Social relays.
//   - relayOutageMonitor (Truth Social fallback freshness).
//   - MELTWATER_API_KEY presence for the Meltwater API.
//
// STRICTLY READ-ONLY: this module runs no scrapes, mutates no registry row, and
// creates no table or tracker. It is a single-pass derivation over already-
// collected signals, cheap enough to compute on every request.

import type { OutletRegistry, MeltwaterTelemetry, ScrapeMetadata } from "@shared/schema";
import { normalizeOutletName, extractOutletDomain } from "@shared/outletRegistry";
import { findApprovedSocialAccountsForRegistryIdentity } from "@shared/socialAccountCatalog";
import { getFeedHealthReport, type FeedHealthRow } from "./feedHealthTracker";
import { getXRelayHeartbeat } from "./xRelayService";
import { getRelayHeartbeat } from "./truthSocialService";
import { RSS_FEEDS } from "./rssFeeds";
import { WARFIGHTER_ONLY_RSS_FEEDS } from "./warfighterRssScraper";
import { CURATED_FEEDS } from "./curatedFeeds";
import type { IStorage } from "./storage";

// 'unknown' is used when a source is wired/configured but we have NO real
// run/freshness telemetry to attest health — we must never invent 'healthy'.
// 'unused' is reserved for genuinely-not-wired (no pipeline) OR a live fallback
// that is idle because the primary is confirmed healthy.
export type IngestionHealth = "healthy" | "degraded" | "broken" | "unknown" | "unused";

export interface IngestionSource {
  // What kind of pipeline this is (rss/scraper/relay/api/none).
  kind: "rss" | "scraper" | "relay" | "api" | "none";
  // Human label, e.g. "RSS feed", "EV relay API", "Playwright scraper".
  label: string;
  // The concrete feed/section URL when applicable (RSS feeds only).
  url?: string;
  health: IngestionHealth;
  // ISO timestamp of the most recent signal we have for this source.
  lastCheckedAt?: string | null;
  // Optional one-line note (e.g. "not connected", "fallback covering").
  note?: string;
}

export interface OutletIngestion {
  key: string;
  canonicalName: string;
  // "news" | "social" — mirrors the Registry tab's grouping.
  kind: "news" | "social";
  primary: IngestionSource;
  secondary?: IngestionSource;
  overall: IngestionHealth;
}

// Relay heartbeat staleness bars, mirroring each relay service's own threshold.
const RELAY_STALE_MS = 15 * 60 * 1000;
const RELAY_BROKEN_MS = 45 * 60 * 1000;

// ---------------------------------------------------------------------------
// Feed-health lookup helpers.
// ---------------------------------------------------------------------------

// Index the in-memory feed-health rows by URL for O(1) lookups.
function indexFeedHealth(rows: FeedHealthRow[]): Map<string, FeedHealthRow> {
  const m = new Map<string, FeedHealthRow>();
  for (const r of rows) m.set(r.url, r);
  return m;
}

// Derive an IngestionHealth verdict for a single configured RSS/scraper feed
// URL from its tracked outcome. A feed we have never observed reports 'unknown'
// (it IS wired, but we have no run telemetry yet) — never 'healthy'.
function feedHealthFor(
  url: string,
  byUrl: Map<string, FeedHealthRow>,
): { health: IngestionHealth; lastCheckedAt: string | null } {
  const row = byUrl.get(url);
  if (!row) return { health: "unknown", lastCheckedAt: null };
  const lastCheckedAt = row.lastSeenAt ?? null;
  if (row.stale) return { health: "broken", lastCheckedAt };
  if (row.consecutiveUnhealthy > 0 || row.lastOutcome !== "healthy") {
    return { health: "degraded", lastCheckedAt };
  }
  return { health: "healthy", lastCheckedAt };
}

// Worst of a set of feed verdicts (broken > degraded > unknown > healthy >
// unused), used when an outlet is fed by several feed URLs (e.g. Washington
// Post has 3). 'unknown' ranks above 'healthy' so a mixed set never rounds up.
function worstHealth(healths: IngestionHealth[]): IngestionHealth {
  const order: IngestionHealth[] = ["broken", "degraded", "unknown", "healthy", "unused"];
  for (const h of order) if (healths.includes(h)) return h;
  return "unused";
}

// ---------------------------------------------------------------------------
// Registry outlet → RSS/curated feed matching (heuristic, name + domain).
// ---------------------------------------------------------------------------

interface FeedRef {
  url: string;
  sourceName: string;
  kind: "rss" | "scraper";
  label: string;
}

// Flatten every configured feed we can health-check into one list. Main-feed
// RSS Monitor + Warfighter list are tracked by feedHealthTracker; curated feeds
// are matched by name/domain but only health-checked if the tracker knows the
// URL (many curated feeds share URLs with the RSS Monitor).
function allConfiguredFeeds(): FeedRef[] {
  const out: FeedRef[] = [];
  for (const f of RSS_FEEDS) {
    out.push({ url: f.url, sourceName: f.sourceName, kind: "rss", label: "RSS feed (RSS Monitor)" });
  }
  for (const f of WARFIGHTER_ONLY_RSS_FEEDS) {
    out.push({ url: f.url, sourceName: f.sourceName, kind: "rss", label: "RSS feed (Warfighter)" });
  }
  for (const f of CURATED_FEEDS) {
    out.push({ url: f.url, sourceName: f.sourceName, kind: "rss", label: "RSS feed (Curated lane)" });
  }
  return out;
}

// Does a configured feed belong to this outlet? Matched by normalized
// sourceName == canonicalName/alias, OR by the feed URL's registrable domain
// appearing in the outlet's domains[]. Heuristic and deliberately loose.
function feedMatchesOutlet(
  feed: FeedRef,
  outletNameKeys: Set<string>,
  outletDomains: Set<string>,
): boolean {
  const nk = normalizeOutletName(feed.sourceName);
  if (nk && outletNameKeys.has(nk)) return true;
  const dom = extractOutletDomain(feed.url);
  if (dom && outletDomains.has(dom)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Social outlet → relay/scraper mapping.
// ---------------------------------------------------------------------------

// Relay verdict from an in-memory heartbeat timestamp (ms epoch, 0 = never).
function relayHealth(heartbeatMs: number): { health: IngestionHealth; lastCheckedAt: string | null } {
  if (!heartbeatMs || heartbeatMs <= 0) return { health: "broken", lastCheckedAt: null };
  const age = Date.now() - heartbeatMs;
  const lastCheckedAt = new Date(heartbeatMs).toISOString();
  if (age >= RELAY_BROKEN_MS) return { health: "broken", lastCheckedAt };
  if (age >= RELAY_STALE_MS) return { health: "degraded", lastCheckedAt };
  return { health: "healthy", lastCheckedAt };
}

// Freshness bar for a fallback SCRAPER's last-run timestamp (scrape metadata).
// The scrape cron runs ~10 min; broken past ~30 min, degraded past ~15 min.
const SCRAPER_STALE_MS = 15 * 60 * 1000;
const SCRAPER_BROKEN_MS = 30 * 60 * 1000;

// Health of a fallback scraper from its persisted last-run timestamp. Never
// invents 'healthy': a null timestamp (no evidence it ever ran) is 'unknown'.
function scraperHealthFromRun(lastRunAt: Date | null | undefined): {
  health: IngestionHealth;
  lastCheckedAt: string | null;
} {
  if (!lastRunAt) return { health: "unknown", lastCheckedAt: null };
  const t = lastRunAt instanceof Date ? lastRunAt.getTime() : new Date(lastRunAt).getTime();
  if (Number.isNaN(t)) return { health: "unknown", lastCheckedAt: null };
  const age = Date.now() - t;
  const lastCheckedAt = new Date(t).toISOString();
  if (age >= SCRAPER_BROKEN_MS) return { health: "broken", lastCheckedAt };
  if (age >= SCRAPER_STALE_MS) return { health: "degraded", lastCheckedAt };
  return { health: "healthy", lastCheckedAt };
}

// Meltwater API health from real run telemetry (never from key presence alone).
//   - key absent            → 'broken' / "not connected"
//   - key present, no row    → 'unknown' / "configured — no recent run telemetry"
//   - last run errored/stale → 'broken' / 'degraded'
//   - last run succeeded     → 'healthy'
// Success telemetry older than the stale bar is degraded (the run stopped).
const MELTWATER_STALE_MS = 6 * 60 * 60 * 1000; // cadence-aware, matches Coverage Int/US bar
const MELTWATER_BROKEN_MS = 24 * 60 * 60 * 1000;
function meltwaterHealthFrom(
  hasKey: boolean,
  telemetry: MeltwaterTelemetry | null,
): { health: IngestionHealth; lastCheckedAt: string | null; note: string } {
  if (!hasKey) {
    return { health: "broken", lastCheckedAt: null, note: "Meltwater not connected (no credentials configured)" };
  }
  if (!telemetry || !telemetry.lastRunAt) {
    return { health: "unknown", lastCheckedAt: null, note: "Configured — no recent run telemetry" };
  }
  const t = new Date(telemetry.lastRunAt).getTime();
  const lastCheckedAt = Number.isNaN(t) ? null : new Date(t).toISOString();
  if (Number.isNaN(t)) {
    return { health: "unknown", lastCheckedAt: null, note: "Configured — no recent run telemetry" };
  }
  const age = Date.now() - t;
  if (telemetry.outcome === "error") {
    return { health: "broken", lastCheckedAt, note: "Last Meltwater run errored" };
  }
  if (age >= MELTWATER_BROKEN_MS) {
    return { health: "broken", lastCheckedAt, note: "No successful Meltwater run in >24h" };
  }
  if (telemetry.outcome === "rate-limited" || age >= MELTWATER_STALE_MS) {
    return { health: "degraded", lastCheckedAt, note: telemetry.outcome === "rate-limited" ? "Meltwater rate-limited" : "Meltwater run stale" };
  }
  return { health: "healthy", lastCheckedAt, note: "Last Meltwater run succeeded" };
}

// A registry row is a Truth Social outlet if its identity is the Truth Social
// account. Everything else with an approved social account is treated as X.
function isTruthSocialOutlet(row: OutletRegistry): boolean {
  const hay = [
    row.canonicalName,
    row.displayName ?? "",
    ...((row.aliases ?? []) as string[]),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes("truth social") || hay.includes("realdonaldtrump") || hay.includes("@realdonald");
}

// ---------------------------------------------------------------------------
// Main builder.
// ---------------------------------------------------------------------------

export async function buildOutletIngestionHealth(
  registry: OutletRegistry[],
  storage: IStorage,
): Promise<OutletIngestion[]> {
  const feedHealth = getFeedHealthReport();
  const byUrl = indexFeedHealth(feedHealth.feeds);
  const configured = allConfiguredFeeds();
  const hasMeltwaterKey = !!process.env.MELTWATER_API_KEY;
  const xRelay = getXRelayHeartbeat();
  const truthRelay = getRelayHeartbeat();

  // Real telemetry reads (cheap: two indexed selects, both fail-open to null).
  // Meltwater telemetry is per-search; collapse to the single most-recent run so
  // the API's health reflects the freshest attempt across all searches.
  let meltwaterTelemetry: MeltwaterTelemetry | null = null;
  let scrapeMeta: ScrapeMetadata | null = null;
  try {
    const rows = await storage.getMeltwaterTelemetries();
    for (const r of rows) {
      if (!r.lastRunAt) continue;
      if (!meltwaterTelemetry || new Date(r.lastRunAt).getTime() > new Date(meltwaterTelemetry.lastRunAt).getTime()) {
        meltwaterTelemetry = r;
      }
    }
  } catch {
    meltwaterTelemetry = null;
  }
  try {
    scrapeMeta = (await storage.getScrapeMetadata()) ?? null;
  } catch {
    scrapeMeta = null;
  }
  const xScraperRun = scrapeMeta?.xPostsLastScrapeTime ?? null;
  const truthScraperRun = scrapeMeta?.truthSocialLastScrapeTime ?? null;

  const out: OutletIngestion[] = [];

  for (const row of registry) {
    const socialAccounts = findApprovedSocialAccountsForRegistryIdentity(
      row.canonicalName,
      (row.aliases ?? []) as string[],
    );
    const isSocial = socialAccounts.length > 0;

    if (isSocial) {
      out.push(buildSocialIngestion(row, xRelay, truthRelay, xScraperRun, truthScraperRun));
      continue;
    }

    out.push(buildNewsIngestion(row, configured, byUrl, hasMeltwaterKey, meltwaterTelemetry));
  }

  return out;
}

// News outlet: primary = its matched RSS feed(s); secondary = Meltwater API
// (the wire/scraper fallback that also carries most outlets). Outlets with no
// matched feed AND no Meltwater designation are 'unused'/grey.
function buildNewsIngestion(
  row: OutletRegistry,
  configured: FeedRef[],
  byUrl: Map<string, FeedHealthRow>,
  hasMeltwaterKey: boolean,
  meltwaterTelemetry: MeltwaterTelemetry | null,
): OutletIngestion {
  const nameKeys = new Set<string>();
  const nk = normalizeOutletName(row.canonicalName);
  if (nk) nameKeys.add(nk);
  for (const a of (row.aliases ?? []) as string[]) {
    const k = normalizeOutletName(a);
    if (k) nameKeys.add(k);
  }
  const domains = new Set<string>((row.domains ?? []).map((d) => d.toLowerCase()));

  const matched = configured.filter((f) => feedMatchesOutlet(f, nameKeys, domains));

  let primary: IngestionSource;
  if (matched.length > 0) {
    // De-dup by URL; compute worst health across all of this outlet's feeds.
    const seen = new Set<string>();
    const verdicts: { url: string; health: IngestionHealth; lastCheckedAt: string | null; label: string }[] = [];
    for (const f of matched) {
      if (seen.has(f.url)) continue;
      seen.add(f.url);
      const v = feedHealthFor(f.url, byUrl);
      verdicts.push({ url: f.url, ...v, label: f.label });
    }
    const overall = worstHealth(verdicts.map((v) => v.health));
    // Surface the URL/lastChecked of the verdict that set the overall status.
    const lead = verdicts.find((v) => v.health === overall) ?? verdicts[0];
    primary = {
      kind: "rss",
      label: verdicts.length > 1 ? `RSS feed (${verdicts.length} feeds)` : lead.label,
      url: lead.url,
      health: overall,
      lastCheckedAt: lead.lastCheckedAt,
      note: overall === "unknown" ? "Feed configured — no run telemetry yet" : undefined,
    };
  } else {
    primary = {
      kind: "none",
      label: "No automated ingestion",
      health: "unused",
      note: "No RSS feed or scraper is wired to this outlet",
    };
  }

  // Meltwater is the designated fallback wire/scraper. Its health comes STRICTLY
  // from run telemetry (never key-presence alone): connected+recent-success →
  // healthy; key present but no run telemetry → unknown; errored/stale → broken/
  // degraded; key absent → broken/not-connected. When the primary RSS feed is
  // confirmed healthy, the fallback is genuinely idle → 'unused' (greyed).
  const mw = meltwaterHealthFrom(hasMeltwaterKey, meltwaterTelemetry);
  const meltwaterIdle = primary.health === "healthy";
  const meltwaterHealth: IngestionHealth = meltwaterIdle ? "unused" : mw.health;
  const secondary: IngestionSource = {
    kind: "api",
    label: "Meltwater API",
    health: meltwaterHealth,
    lastCheckedAt: mw.lastCheckedAt,
    note: meltwaterIdle ? "Fallback — idle while RSS is healthy" : mw.note,
  };

  // Overall: never 'healthy' unless a source has REAL positive telemetry.
  //   - primary healthy                    → healthy
  //   - primary broken/degraded, Meltwater healthy → degraded (fallback covering)
  //   - primary unknown, no positive fallback      → unknown (no telemetry)
  //   - genuinely unwired (no feed) + Meltwater unhealthy/unknown → its verdict
  let overall: IngestionHealth;
  if (primary.kind === "none") {
    // No RSS feed at all — the outlet rests entirely on Meltwater's real verdict.
    overall = hasMeltwaterKey ? mw.health : "unused";
  } else if (primary.health === "healthy") {
    overall = "healthy";
  } else if (mw.health === "healthy") {
    // primary degraded/broken/unknown but the fallback has positive telemetry.
    overall = "degraded";
  } else {
    // No positive telemetry anywhere: surface the more-severe of the two, but
    // never round an unknown up to healthy.
    overall = worstHealth([primary.health, mw.health]);
  }

  return {
    key: row.key,
    canonicalName: row.canonicalName,
    kind: "news",
    primary,
    secondary,
    overall,
  };
}

// Social outlet: X → primary EV relay API, secondary Playwright scraper.
// Truth Social → primary EV relay, secondary fallback scraper.
function buildSocialIngestion(
  row: OutletRegistry,
  xRelayMs: number,
  truthRelayMs: number,
  xScraperRun: Date | null,
  truthScraperRun: Date | null,
): OutletIngestion {
  const truth = isTruthSocialOutlet(row);
  const relayMs = truth ? truthRelayMs : xRelayMs;
  const relayVerdict = relayHealth(relayMs);

  const primary: IngestionSource = {
    kind: "relay",
    label: truth ? "Truth Social relay (EV)" : "EV relay API (X)",
    health: relayVerdict.health,
    lastCheckedAt: relayVerdict.lastCheckedAt,
    note: relayVerdict.health === "broken" ? "Relay heartbeat stale/absent" : undefined,
  };

  // Secondary Playwright/fallback scraper. When the relay is healthy the scraper
  // is genuinely idle ('unused'/greyed). When the relay is down its health comes
  // STRICTLY from the persisted last-run timestamp (scrape metadata) — never an
  // invented 'healthy'. No timestamp → 'unknown' with a note.
  const scraperRun = truth ? truthScraperRun : xScraperRun;
  const scraperVerdict = scraperHealthFromRun(scraperRun);
  const relayHealthy = relayVerdict.health === "healthy";
  const secondary: IngestionSource = {
    kind: "scraper",
    label: truth ? "Truth Social fallback scraper" : "Playwright scraper (X)",
    health: relayHealthy ? "unused" : scraperVerdict.health,
    lastCheckedAt: scraperVerdict.lastCheckedAt,
    note: relayHealthy
      ? "Fallback — idle while relay is healthy"
      : scraperVerdict.health === "unknown"
        ? "Fallback scraper — no recent run telemetry"
        : scraperVerdict.health === "healthy"
          ? "Fallback scraper active (recent run) while relay is down"
          : "Fallback scraper stale/broken while relay is down",
  };

  // Overall: never 'healthy' without positive telemetry.
  //   - relay healthy                         → healthy
  //   - relay down + scraper has recent run   → degraded (fallback covering)
  //   - relay down + scraper stale/broken     → broken
  //   - relay down + no scraper telemetry     → unknown
  let overall: IngestionHealth;
  if (relayHealthy) {
    overall = "healthy";
  } else if (scraperVerdict.health === "healthy") {
    overall = "degraded";
  } else if (scraperVerdict.health === "unknown") {
    overall = "unknown";
  } else {
    overall = "broken";
  }

  return {
    key: row.key,
    canonicalName: row.canonicalName,
    kind: "social",
    primary,
    secondary,
    overall,
  };
}
