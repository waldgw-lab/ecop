import { createHash } from "crypto";
import type {
  CuratedLiveBroadcastModeration,
  CuratedLiveBroadcastOverrides,
} from "@shared/schema";
import type {
  BroadcastLeader,
  BroadcastState,
  LiveBroadcastStatus,
} from "./liveBroadcastStatus";

export const LIVE_BROADCAST_LEADERS: BroadcastLeader[] = [
  "President",
  "Vice President",
  "Secretary of State",
  "Secretary of War",
  "Chairman of the Joint Chiefs",
];

export const LIVE_BROADCAST_STATES: BroadcastState[] = [
  "upcoming",
  "live",
  "recently_ended",
];

function normalizedEventTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*preview[^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 240);
}

function statusAnchorMs(status: LiveBroadcastStatus, observedAt?: number | null): number {
  const raw = status.startsAt ?? status.since ?? status.endsAt;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : (observedAt ?? 0);
}

function titleTokens(title: string): Set<string> {
  const stop = new Set([
    "a", "an", "and", "at", "by", "delivers", "for", "from", "in", "live",
    "of", "on", "president", "remarks", "secretary", "the", "to", "vice", "with",
  ]);
  return new Set(normalizedEventTitle(title).split(" ").filter((t) => t.length > 2 && !stop.has(t)));
}

function titlesDescribeSameEvent(a: string, b: string): boolean {
  const normalizedA = normalizedEventTitle(a);
  const normalizedB = normalizedEventTitle(b);
  if (normalizedA === normalizedB) return true;
  const aTokens = titleTokens(a);
  const bTokens = titleTokens(b);
  if (aTokens.size === 0 || bTokens.size === 0) return false;
  let shared = 0;
  for (const token of Array.from(aTokens)) if (bTokens.has(token)) shared++;
  return shared >= 2 && shared / Math.min(aTokens.size, bTokens.size) >= 0.6;
}

function validLifecycleTransition(previous: BroadcastState, next: BroadcastState): boolean {
  return (
    previous === next ||
    (previous === "upcoming" && next === "live") ||
    (previous === "live" && next === "recently_ended")
  );
}

/**
 * State-independent event identity. The 30-minute temporal bucket separates
 * repeated same-day broadcasts. A lifecycle transition can reuse this key only
 * through resolveLiveBroadcastEventKey's stricter state/time/content checks.
 */
export function deriveLiveBroadcastEventKey(
  status: LiveBroadcastStatus,
  observedAt?: number | null,
): string {
  const anchorMs = statusAnchorMs(status, observedAt);
  const bucket30m = Math.floor(anchorMs / (30 * 60_000));
  const material = `${status.leader}|${normalizedEventTitle(status.title)}|${bucket30m}`;
  return `live-alert:${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

export function resolveLiveBroadcastEventKey(
  status: LiveBroadcastStatus,
  observedAt: number | null | undefined,
  recentFirings: Array<{
    eventKey: string;
    state: string;
    leader: string;
    title: string;
    watchUrl: string;
    startsAt?: Date | string | null;
    firstObservedAt: Date | string;
    endedAt?: Date | string | null;
  }>,
): string {
  const prior = recentFirings.find((f) => {
    if (f.leader !== status.leader) return false;
    if (!LIVE_BROADCAST_STATES.includes(f.state as BroadcastState)) return false;
    if (!validLifecycleTransition(f.state as BroadcastState, status.state)) return false;

    const currentAnchor = statusAnchorMs(status, observedAt);
    const previousRaw =
      f.state === "upcoming" ? f.startsAt :
      f.state === "recently_ended" ? f.endedAt :
      f.firstObservedAt;
    const previousAnchor = previousRaw ? new Date(previousRaw).getTime() : NaN;
    if (!currentAnchor || !Number.isFinite(previousAnchor)) return false;
    const distanceMs = Math.abs(currentAnchor - previousAnchor);
    const maxDistanceMs = f.state === status.state ? 45 * 60_000 : 3 * 60 * 60_000;
    if (distanceMs > maxDistanceMs) return false;

    // Same-state restart recovery requires content agreement. A canonical Watch
    // URL is intentionally insufficient because leaders reuse those pages.
    if (f.state === status.state) return titlesDescribeSameEvent(f.title, status.title);
    if (titlesDescribeSameEvent(f.title, status.title)) return true;
    try {
      // URL may bridge an upcoming→live title rewrite, but only inside the valid
      // adjacent lifecycle transition and narrow temporal window above.
      return new URL(f.watchUrl).toString() === new URL(status.watchUrl).toString();
    } catch {
      return false;
    }
  });
  return prior?.eventKey ?? deriveLiveBroadcastEventKey(status, observedAt);
}

/**
 * Corrections are deliberately bound to the immutable firing's exact event key.
 * Similar titles, leaders, and canonical Watch URLs are never sufficient to
 * retarget a saved correction to the event currently powering the banner.
 */
export function isCurrentLiveBroadcastEvent(
  selectedEventKey: string,
  activeEventKey: string | null | undefined,
): boolean {
  return Boolean(activeEventKey) && selectedEventKey === activeEventKey;
}

export function applyLiveBroadcastModeration(
  detectorStatus: LiveBroadcastStatus,
  moderation: Pick<CuratedLiveBroadcastModeration, "suppressed" | "overrides"> | null | undefined,
): LiveBroadcastStatus | null {
  if (moderation?.suppressed) return null;
  const o = moderation?.overrides ?? {};
  const state = (o.state ?? detectorStatus.state) as BroadcastState;
  const resolved: LiveBroadcastStatus = {
    state,
    leader: (o.leader ?? detectorStatus.leader) as BroadcastLeader,
    title: o.title ?? detectorStatus.title,
    watchUrl: o.watchUrl ?? detectorStatus.watchUrl,
  };
  const startsAt = o.startsAt !== undefined ? o.startsAt : detectorStatus.startsAt;
  const since = o.since !== undefined ? o.since : detectorStatus.since;
  const endsAt = o.endsAt !== undefined ? o.endsAt : detectorStatus.endsAt;
  if (state === "upcoming" && startsAt) resolved.startsAt = startsAt;
  if (state === "live" && since) resolved.since = since;
  if (state === "recently_ended" && endsAt) resolved.endsAt = endsAt;
  return resolved;
}

function safeEditorWatchUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 2048 || /\s|[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password || !url.hostname) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function optionalIso(raw: unknown, field: string): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") throw new Error(`${field} must be an ISO date-time or null`);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid date-time`);
  return date.toISOString();
}

export function validateLiveBroadcastOverrides(raw: unknown): CuratedLiveBroadcastOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("fields must be an object");
  }
  const input = raw as Record<string, unknown>;
  const state = String(input.state ?? "") as BroadcastState;
  const leader = String(input.leader ?? "") as BroadcastLeader;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const watchUrl = safeEditorWatchUrl(input.watchUrl);
  if (!LIVE_BROADCAST_STATES.includes(state)) throw new Error("Invalid live-alert state");
  if (!LIVE_BROADCAST_LEADERS.includes(leader)) throw new Error("Invalid live-alert leader");
  if (title.length < 3 || title.length > 240) throw new Error("Title must be 3–240 characters");
  if (!watchUrl) throw new Error("Watch URL must be a safe absolute http(s) URL");

  const startsAt = optionalIso(input.startsAt, "startsAt");
  const since = optionalIso(input.since, "since");
  const endsAt = optionalIso(input.endsAt, "endsAt");
  if (state === "upcoming" && !startsAt) {
    throw new Error("A scheduled start must be set for Starting soon alerts");
  }
  if (state !== "upcoming" && startsAt) throw new Error("startsAt is only valid for upcoming alerts");
  if (state !== "live" && since) throw new Error("since is only valid for live alerts");
  if (state !== "recently_ended" && endsAt) throw new Error("endsAt is only valid for recently-ended alerts");

  return {
    state,
    leader,
    title,
    watchUrl,
    startsAt: state === "upcoming" ? startsAt : null,
    since: state === "live" ? since : null,
    endsAt: state === "recently_ended" ? endsAt : null,
  };
}