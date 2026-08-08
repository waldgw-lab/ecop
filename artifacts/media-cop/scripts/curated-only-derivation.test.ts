/**
 * Regression test for the "Curated only" outlet derivation (Task #530 / #532).
 *
 * buildCuratedOnlyOutletIds() marks an outlet "Curated only" when it has NO
 * automatic path to a non-curated surface. The rule is an INVERSION of feed
 * wiring (NOT factuality):
 *   - reaches Classic/main  => RSS roster (server/rssFeeds.ts) + AP/Reuters/Drudge
 *   - reaches Visual/War     => social-* relays (X/Truth) + release-* OSINT lanes
 *                               + DataMinr/sentdefender alert feeds
 *   ...with ONE exception: the combatant-command + White House X handles in
 *   CURATED_ONLY_OSINT_HANDLES are quarantined to the curated X feed, so they
 *   ARE curated-only despite a social-/release- identifier. CENTCOM/SOUTHCOM/
 *   Pentagon are NOT in that set and remain shared (NOT curated-only).
 *
 * Everything else — news off the main roster (incl. Meltwater-fed adversary
 * press and off-roster Western press not in any curated list), and off-roster
 * `other` sources — only reaches the curated lane, so it is curated-only.
 *
 * This locks the contract so a future feed-list / identifier edit can't silently
 * flip an outlet's label.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-only-derivation.test.ts
 * Exits non-zero on any failure.
 */
import { buildCuratedOnlyOutletIds } from "../server/curatedOnlyOutlets";
import type { OutletRegistry } from "@shared/outletRegistry";

// Minimal registry rows — buildCuratedOnlyOutletIds resolves a row by its
// key / canonicalName / aliases against feed source names and the OSINT handle
// set, and reads sourceIdentifier for the social/release lane rule.
function mockRow(
  id: string,
  canonicalName: string,
  sourceIdentifier: string | null,
  aliases: string[] = [],
): OutletRegistry {
  return {
    id,
    key: id,
    canonicalName,
    aliases,
    domains: [],
    sourceIdentifier,
  } as unknown as OutletRegistry;
}

interface Case {
  id: string;
  canonicalName: string;
  sid: string | null;
  aliases?: string[];
  expected: boolean;
  why: string;
}

const cases: Case[] = [
  // ---- Curated only: NO non-curated path ----
  { id: "rt", canonicalName: "RT", sid: "news-cpc", expected: true, why: "adversary news, not on the main RSS roster" },
  { id: "nyt", canonicalName: "New York Times", sid: "news-us-domestic", expected: true, why: "trusted news, not wired into the main RSS roster" },
  { id: "global-times", canonicalName: "Global Times", sid: "news-cpc", expected: true, why: "curated-only web scraper, not on the main roster" },
  { id: "xinhua", canonicalName: "Xinhua", sid: "news-cpc", expected: true, why: "Meltwater-fed adversary press — in NO feed list, still barred from main" },
  { id: "tehran", canonicalName: "Tehran Times", sid: "news-cpc", expected: true, why: "Meltwater-fed adversary press, off-roster" },
  { id: "wsj", canonicalName: "The Wall Street Journal", sid: "news-us-domestic", expected: true, why: "off-roster Western press, not in any curated list either" },
  { id: "msnbc", canonicalName: "MSNBC", sid: "other", expected: true, why: "off-roster `other` source — only reaches the curated lane" },

  // ---- OSINT handle exception: curated-only despite social-/release- id ----
  { id: "wh", canonicalName: "The White House (X)", sid: "social-us-official", aliases: ["WhiteHouse", "White House"], expected: true, why: "White House X handle is a CURATED_ONLY_OSINT handle" },
  { id: "africom", canonicalName: "U.S. Africa Command (AFRICOM)", sid: "release-us-official", aliases: ["USAfricaCommand", "AFRICOM"], expected: true, why: "combatant-command X handle is curated-only OSINT" },

  // ---- NOT curated only: reaches the main / Classic feed ----
  { id: "fox", canonicalName: "Fox News", sid: "news-international", expected: false, why: "on the main RSS roster" },
  { id: "aljazeera", canonicalName: "Al Jazeera", sid: "news-international", expected: false, why: "on the main RSS roster" },
  { id: "drudge", canonicalName: "Drudge Report", sid: "other", expected: false, why: "the classic main scraper" },

  // ---- NOT curated only: reaches Visual/War via social/release/alert lanes ----
  { id: "potus", canonicalName: "POTUS (Truth Social)", sid: "social-us-official", aliases: ["POTUS"], expected: false, why: "Truth Social relay surfaces it in Visual" },
  { id: "centcom", canonicalName: "CENTCOM", sid: "release-us-official", aliases: ["U.S. Central Command"], expected: false, why: "shared OSINT account (NOT in the curated-only handle set)" },
  { id: "southcom", canonicalName: "SOUTHCOM", sid: "release-us-official", aliases: ["U.S. Southern Command"], expected: false, why: "shared OSINT account, reaches the main OSINT feed" },
  { id: "dataminr", canonicalName: "Dataminr", sid: "other", expected: false, why: "feeds the Visual/War alert sections" },
  { id: "sentdefender", canonicalName: "sentdefender", sid: "other", expected: false, why: "OSINT account surfaced in the non-curated OSINT feed" },
];

const rows = cases.map((c) => mockRow(c.id, c.canonicalName, c.sid, c.aliases ?? []));
const curatedOnlyIds = buildCuratedOnlyOutletIds(rows);

let failures = 0;
for (const c of cases) {
  const got = curatedOnlyIds.has(c.id);
  const ok = got === c.expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "OK " : "XX "} ${c.canonicalName}: got=${got} want=${c.expected} — ${c.why}`);
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} case(s) did not match the expected Curated-only derivation.`);
  process.exit(1);
}
console.log(`\nPASSED: all ${cases.length} Curated-only derivation cases.`);
process.exit(0);
