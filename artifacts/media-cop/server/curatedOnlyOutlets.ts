// =============================================================================
// "Curated only" derivation (Task #530) — DISPLAY / LABELING ONLY.
//
// An outlet is "Curated only" when its content can only ever reach the isolated
// Curated view and NEVER the other MCOPs / main feeds (Classic / Visual /
// custom-MCOP) / public API — outside of a manual submission. This is a function
// of FEED WIRING, not factuality/trust.
//
// The rule is an INVERSION: an outlet is curated-only UNLESS it has an automatic
// ingestion path to a NON-curated surface. The non-curated surfaces and their
// wiring are:
//   - Classic / main headlines: the relevance-gated RSS roster
//     (server/rssFeeds.ts) plus a few direct main-feed scrapers (AP, Reuters,
//     Drudge Report).
//   - Visual / Stream + War + alert sections: the social relays (X / Truth
//     Social — every `social-*` outlet), the official-release / OSINT lanes
//     (`release-*`), and DataMinr / sentdefender alert feeds.
//
// Everything else in the registry only reaches the curated lane (via the curated
// RSS/web scrapers, Meltwater, or a main-feed bot's reject hook) — so it is
// "Curated only". That deliberately includes outlets that are NOT in the curated
// feed lists at all (e.g. Meltwater-fed adversary press like Xinhua / Tehran
// Times, or off-roster Western press like WSJ): they are still barred from the
// main feeds, which is exactly what the label communicates.
//
// The single exception inside the social/release lanes: the combatant-command +
// White House X handles in CURATED_ONLY_OSINT_HANDLES. They live in the shared
// osint_posts table but are read-time-excluded from every non-curated reader, so
// they ARE curated-only despite their `social-*` / `release-*` identifier.
// CENTCOM / SOUTHCOM / Pentagon are intentionally NOT in that set — they remain
// shared (reach the main OSINT feed), so they are NOT curated-only.
//
// This derivation has two consumers, and BOTH only ever add breadth to the
// curated lane / Source Oversight — neither is an ingestion gate:
//   1. Source Oversight: the "Curated only" label shown to operators.
//   2. The main-feed auto-promotion gate (storage.finalizeSubmissionAnalysis):
//      a FAIL-OPEN, POSITIVE-ONLY skip. A Team submission whose outlet
//      POSITIVELY resolves into this set is not auto-promoted onto the main /
//      Classic / Visual / custom-MCOP feeds (it still flows to the curated lane
//      like everything else). Unknown / unresolved outlets always promote, so it
//      can never silently drop a legitimate main source.
// =============================================================================

import { RSS_FEEDS } from "./rssFeeds";
import { CURATED_ONLY_OSINT_HANDLE_SET } from "./curatedOnlyOsint";
import {
  normalizeOutletName,
  findOutlet,
  type OutletIndex,
} from "@shared/outletRegistry";
import type { OutletRegistry } from "@shared/schema";

// Outlets reachable by the MAIN / Classic pipeline via a dedicated direct
// scraper/bot rather than the RSS roster (server/rssFeeds.ts). AP and Reuters
// retired their public RSS, so they are scraped directly into the main pipeline
// (e.g. server/apNewsBot.ts); Drudge Report is the classic main scraper.
//
// The dedicated news bots (server/{ap,reuters,bbc,fox,abc,cbs,nbc}NewsBot.ts)
// post under their own sourceName and auto-promote onto the main feed via the
// promotion gate (storage.finalizeSubmissionAnalysis). Their EXACT sourceName
// strings are listed here so this derivation never mis-labels them "curated
// only" (and so the promotion-gate exclusion that now reads this set never
// wrongly blocks them). Fox/ABC/CBS/NBC also appear on the RSS roster; AP News
// and BBC News are the strings that only the bots emit.
const MAIN_FEED_BOT_SOURCE_NAMES = [
  "Associated Press",
  "AP News",
  "Reuters",
  "Drudge Report",
  "BBC News",
  "Fox News",
  "ABC News",
  "CBS News",
  "NBC News",
];

// `other`-identifier sources that nonetheless reach a NON-curated surface:
// DataMinr feeds the Visual/War alert sections; sentdefender is an OSINT account
// surfaced in the (non-curated) OSINT feed.
const NON_CURATED_OTHER_SOURCE_NAMES = ["Dataminr", "sentdefender"];

function feedKeySet(names: Iterable<string>): Set<string> {
  const s = new Set<string>();
  for (const n of names) {
    const k = normalizeOutletName(n);
    if (k) s.add(k);
  }
  return s;
}

function rowKeys(row: OutletRegistry): string[] {
  return [
    row.key,
    normalizeOutletName(row.canonicalName),
    ...((row.aliases ?? []).map(normalizeOutletName)),
  ].filter(Boolean) as string[];
}

// Raw (un-normalized) name/alias tokens for a row, lowercased — used to match the
// OSINT X handles (e.g. "US_CYBERCOM", "WhiteHouse"), which don't survive
// normalizeOutletName cleanly.
function rawTokens(row: OutletRegistry): string[] {
  return [row.key, row.canonicalName, ...(row.aliases ?? [])]
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

const CURATED_ONLY_OSINT_HANDLES_LC = new Set(
  [...CURATED_ONLY_OSINT_HANDLE_SET].map((h) => h.toLowerCase()),
);

/**
 * Returns the set of registry row IDs that are "Curated only": the outlet has NO
 * automatic path to any non-curated surface. Used for the Source Oversight label
 * and (positive-only) the main-feed promotion skip — never an INGESTION gate.
 */
export function buildCuratedOnlyOutletIds(rows: OutletRegistry[]): Set<string> {
  const nonCuratedNameKeys = feedKeySet([
    ...RSS_FEEDS.map((f) => f.sourceName),
    ...MAIN_FEED_BOT_SOURCE_NAMES,
    ...NON_CURATED_OTHER_SOURCE_NAMES,
  ]);

  const ids = new Set<string>();
  for (const row of rows) {
    if (!reachesNonCuratedSurface(row, nonCuratedNameKeys)) ids.add(row.id);
  }
  return ids;
}

function reachesNonCuratedSurface(
  row: OutletRegistry,
  nonCuratedNameKeys: Set<string>,
): boolean {
  // Curated-only OSINT handles (combatant commands + White House X) are
  // quarantined to the curated X feed even though they carry a social-/release-
  // identifier. Check this FIRST so the family rule below can't override it.
  if (rawTokens(row).some((t) => CURATED_ONLY_OSINT_HANDLES_LC.has(t))) {
    return false;
  }

  // Wired into the main / alert pipelines by name (RSS roster, AP/Reuters/Drudge,
  // DataMinr/sentdefender).
  if (rowKeys(row).some((k) => nonCuratedNameKeys.has(k))) return true;

  // The social relays (X / Truth Social) surface every `social-*` outlet in
  // Visual/Stream; the official-release / OSINT lanes (`release-*`) surface in
  // Visual/War. Either way: reaches a non-curated surface.
  const sid = (row as any).sourceIdentifier as string | null | undefined;
  if (typeof sid === "string" && (sid.startsWith("social-") || sid.startsWith("release-"))) {
    return true;
  }

  // Everything else (news outlets off the main roster, off-roster `other`
  // sources) only ever reaches the curated lane.
  return false;
}

/**
 * Pure decision for the main-feed auto-promotion skip. FAIL-OPEN + POSITIVE-ONLY:
 * returns true (= keep off the main feed) ONLY when the outlet POSITIVELY
 * resolves — by source name first, then URL domain — to a registry row whose id
 * is in `curatedOnlyIds`. An empty set, an unknown source, or an unresolved URL
 * all return false (allow promotion), so a legitimate main outlet can never be
 * blocked. Feed it the prebuilt index + id set (both derived from the registry).
 */
export function isCuratedOnlyForMainFeed(
  index: OutletIndex,
  curatedOnlyIds: Set<string>,
  sourceName?: string | null,
  sourceUrl?: string | null,
): boolean {
  if (curatedOnlyIds.size === 0) return false;
  const row = findOutlet(index, sourceName ?? null, sourceUrl ?? null);
  if (!row) return false;
  return curatedOnlyIds.has(row.id);
}
