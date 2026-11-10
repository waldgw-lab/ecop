import type { FinanceStory } from "@shared/finance";
import { ApiRequestError } from "@/lib/queryClient";

export function parseTime(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function fmtDateTime(v: string | null | undefined): string {
  const t = parseTime(v);
  if (t === null) return "—";
  return new Date(t).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function fmtDate(v: string | null | undefined | number): string {
  const t = typeof v === "number" ? v : parseTime(v);
  if (t === null || !Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function relTime(v: string | null | undefined, now = Date.now()): string {
  const t = parseTime(v);
  if (t === null) return "—";
  const d = Math.round((now - t) / 60000);
  if (Math.abs(d) < 1) return "just now";
  const abs = Math.abs(d);
  const s = abs < 60 ? `${abs}m` : abs < 1440 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`;
  return d >= 0 ? `${s} ago` : `in ${s}`;
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function isAuthError(e: unknown): boolean {
  return e instanceof ApiRequestError && e.status === 401;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiRequestError) return `HTTP ${e.status}`;
  if (e instanceof Error) return e.message;
  return "Unknown error";
}

export const KIND_LABEL: Record<FinanceStory["kind"], string> = {
  reporting: "Reporting", official: "Official", dataminr: "Dataminr", social: "Social",
};

export function impactTone(n: number): string {
  if (n >= 70) return "hsl(var(--fsw-coral))";
  if (n >= 45) return "hsl(var(--fsw-brass))";
  return "hsl(var(--fsw-dim))";
}
