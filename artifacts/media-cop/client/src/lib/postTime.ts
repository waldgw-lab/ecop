import { resolveZone, getTzAbbrev, DEFAULT_TIMEZONE } from "@/lib/timezone";

// Shared timestamp formatter for the curated view (Truth Social, the three X
// feeds, and DataMinr First Alert). Rules, evaluated in order:
//   < 1 hr ago            -> "X min ago" (sub-minute shows "now")
//   < 4 hr ago            -> "X hr ago" / "X hrs ago"
//   4+ hr ago, same day   -> "H:MM AM/PM"            (today never shows a date)
//   earlier day           -> "H:MM AM/PM · D MMM YY"
// Clock time and the same-day check are computed in the viewer-selected zone
// (defaults to US Eastern).
//
// `reliable` defaults to true because every curated source stores a true UTC
// instant. If a source ever can't be reliably converted, pass reliable=false:
// the time is then shown verbatim with a 3-letter zone abbreviation so the
// viewer knows it was NOT converted to their selected zone.
//
// `dateSep` is the glue between the clock time and the date on an earlier-day
// stamp. It defaults to " · " for the standalone social/alert feeds. Callers
// that embed this string inside an already "·"-delimited metadata line (the
// clustered-story detail header and its source rows) pass a plain space so the
// date doesn't collide with the surrounding field separators.

export function formatCuratedPostTime(
  date: Date | string,
  tzPref: string = DEFAULT_TIMEZONE,
  reliable: boolean = true,
  dateSep: string = " · ",
): string {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);

  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 4) return `${diffHr} hr${diffHr === 1 ? "" : "s"} ago`;

  // Unreliable source: don't pretend to convert. Show the stored clock time with
  // a 3-letter zone marker so the viewer knows it's the source's own time.
  const zone = reliable ? resolveZone(tzPref) : "UTC";

  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: zone,
  });

  const sameDay =
    d.toLocaleDateString("en-US", { timeZone: zone }) ===
    now.toLocaleDateString("en-US", { timeZone: zone });

  const day = d.toLocaleString("en-US", { day: "numeric", timeZone: zone });
  const month = d.toLocaleString("en-US", { month: "short", timeZone: zone });
  const year = d.toLocaleString("en-US", { year: "2-digit", timeZone: zone });

  const stamp = sameDay ? time : `${time}${dateSep}${day} ${month} ${year}`;
  return reliable ? stamp : `${stamp} ${getTzAbbrev("UTC", d)}`;
}

// Absolute, human-readable date-time stamp for clipboard/share payloads, e.g.
// "Jun 13, 2026, 6:42 PM". Unlike formatCuratedPostTime this is NEVER relative —
// a shared item needs a concrete timestamp that still reads correctly hours or
// days later. Computed in the viewer-selected zone so it matches the UI.
export function formatShareDateTime(
  date: Date | string,
  tzPref: string = DEFAULT_TIMEZONE,
): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: resolveZone(tzPref),
  });
}

/**
 * Absolute publication DTG for a Curated article detail header. Unlike social
 * feed timestamps, this never collapses to "2 hrs ago" or omits today's date:
 * a source-provided publication instant needs to remain unambiguous when a
 * story is opened later or shared across time zones.
 */
export function formatCuratedPublicationDTG(
  date: Date | string,
  tzPref: string = DEFAULT_TIMEZONE,
): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const zone = resolveZone(tzPref);
  const stamp = d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: zone,
  });
  return `${stamp} ${getTzAbbrev(tzPref, d)}`;
}
