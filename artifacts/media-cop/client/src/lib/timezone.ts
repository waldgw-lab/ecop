import { useSyncExternalStore } from "react";

// User-selectable display timezone for the curated view. The choice is persisted
// to localStorage and shared across every curated feed via a tiny external store
// (so any component can read/update it without a context provider wrapper).

export interface TimezoneOption {
  value: string; // "local" or an IANA zone id
  label: string;
}

// "local" resolves to the viewer's own device zone at render time. Everything
// else is a fixed IANA zone. Grouped roughly: device, US/ops zones, then major
// global zones.
export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { value: "local", label: "Local (your device)" },
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
  { value: "UTC", label: "Zulu / UTC" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Central Europe" },
  { value: "Europe/Moscow", label: "Moscow" },
  { value: "Asia/Jerusalem", label: "Jerusalem" },
  { value: "Asia/Tehran", label: "Tehran" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Kolkata", label: "India" },
  { value: "Asia/Shanghai", label: "Beijing" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Australia/Sydney", label: "Sydney" },
];

export const DEFAULT_TIMEZONE = "America/New_York";
const STORAGE_KEY = "mcop.curated.timezone";

function readInitial(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

let current = readInitial();
const listeners = new Set<() => void>();

export function setSelectedTimezone(tz: string): void {
  current = tz;
  try {
    localStorage.setItem(STORAGE_KEY, tz);
  } catch {
    /* ignore persistence failures (private mode, etc.) */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTimezone(): string {
  return useSyncExternalStore(subscribe, () => current, () => DEFAULT_TIMEZONE);
}

// Resolve the stored preference to a concrete IANA zone ("local" -> device zone).
export function resolveZone(tz: string): string {
  if (tz === "local") {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
    } catch {
      return DEFAULT_TIMEZONE;
    }
  }
  return tz;
}

// Short timezone abbreviation (e.g. "EDT", "PST", "UTC", "JST") for a zone at a
// given moment. Used in the selector label and as the fallback marker when a
// source's time can't be reliably converted.
export function getTzAbbrev(tz: string, date: Date = new Date()): string {
  const zone = resolveZone(tz);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "short",
    }).formatToParts(date);
    return parts.find((p) => p.type === "timeZoneName")?.value || zone;
  } catch {
    return zone;
  }
}
