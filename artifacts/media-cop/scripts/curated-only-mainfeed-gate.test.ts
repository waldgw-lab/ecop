/**
 * Regression test for the main-feed auto-promotion skip (Task #533).
 *
 * `isCuratedOnlyForMainFeed(index, ids, name, url)` is the PURE decision behind
 * the storage.finalizeSubmissionAnalysis promotion gate. It is FAIL-OPEN and
 * POSITIVE-ONLY: it returns true (= keep the submission OFF the main feed) ONLY
 * when the outlet POSITIVELY resolves — by source name first, then URL domain —
 * to a registry row in buildCuratedOnlyOutletIds(). An unknown source, an
 * unresolved URL, or an empty set all return false (allow promotion), so a
 * legitimate main outlet can never be silently blocked.
 *
 * This locks the routing intent: AP / Reuters / BBC / Fox / NBC / CBS / ABC keep
 * auto-promoting onto the main feed, while off-roster curated-only outlets
 * (NYT / WSJ / MSNBC / Xinhua / RT / Tehran Times) are skipped to the curated
 * lane only.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-only-mainfeed-gate.test.ts
 * Exits non-zero on any failure.
 */
import {
  buildCuratedOnlyOutletIds,
  isCuratedOnlyForMainFeed,
} from "../server/curatedOnlyOutlets";
import { buildOutletIndex, type OutletRegistry } from "@shared/outletRegistry";

function mockRow(
  id: string,
  canonicalName: string,
  sourceIdentifier: string | null,
  domains: string[] = [],
  aliases: string[] = [],
): OutletRegistry {
  return {
    id,
    key: id,
    canonicalName,
    aliases,
    domains,
    sourceIdentifier,
  } as unknown as OutletRegistry;
}

// A representative slice of the registry: main-reaching bots/roster outlets, and
// off-roster curated-only outlets. Domains let us exercise URL-based resolution.
const rows: OutletRegistry[] = [
  // ---- Reaches the main feed (NOT curated-only) ----
  mockRow("ap", "AP News", "news-us-domestic", ["apnews.com"], ["Associated Press"]),
  mockRow("reuters", "Reuters", "news-international", ["reuters.com"]),
  mockRow("bbc", "BBC News", "news-international", ["bbc.com", "bbc.co.uk"]),
  mockRow("fox", "Fox News", "news-international", ["foxnews.com"]),
  mockRow("nbc", "NBC News", "news-us-domestic", ["nbcnews.com"]),
  mockRow("cbs", "CBS News", "news-us-domestic", ["cbsnews.com"]),
  mockRow("abc", "ABC News", "news-us-domestic", ["abcnews.go.com"]),

  // ---- Curated-only (off-roster; only reaches the curated lane) ----
  mockRow("nyt", "New York Times", "news-us-domestic", ["nytimes.com"]),
  mockRow("wsj", "The Wall Street Journal", "news-us-domestic", ["wsj.com"]),
  mockRow("msnbc", "MSNBC", "other", ["msnbc.com"]),
  mockRow("xinhua", "Xinhua", "news-cpc", ["xinhuanet.com"]),
  mockRow("rt", "RT", "news-cpc", ["rt.com"]),
  mockRow("tehran", "Tehran Times", "news-cpc", ["tehrantimes.com"]),
];

const ids = buildCuratedOnlyOutletIds(rows);
const index = buildOutletIndex(rows);

interface Case {
  name: string | null;
  url: string | null;
  expected: boolean; // true = blocked from main (curated-only)
  why: string;
}

const cases: Case[] = [
  // ---- By source name: main outlets ALLOWED ----
  { name: "AP News", url: null, expected: false, why: "AP bot auto-promotes onto the main feed" },
  { name: "Associated Press", url: null, expected: false, why: "AP alias resolves to the same main outlet" },
  { name: "Reuters", url: null, expected: false, why: "Reuters bot reaches the main feed" },
  { name: "BBC News", url: null, expected: false, why: "BBC bot reaches the main feed" },
  { name: "Fox News", url: null, expected: false, why: "on the RSS roster + bot" },
  { name: "NBC News", url: null, expected: false, why: "NBC bot reaches the main feed" },
  { name: "CBS News", url: null, expected: false, why: "CBS bot reaches the main feed" },
  { name: "ABC News", url: null, expected: false, why: "ABC bot reaches the main feed" },

  // ---- By source name: off-roster curated-only BLOCKED ----
  { name: "New York Times", url: null, expected: true, why: "off-roster, curated-only" },
  { name: "The Wall Street Journal", url: null, expected: true, why: "off-roster, curated-only" },
  { name: "MSNBC", url: null, expected: true, why: "off-roster `other`, curated-only" },
  { name: "Xinhua", url: null, expected: true, why: "Meltwater adversary press, curated-only" },
  { name: "RT", url: null, expected: true, why: "adversary press, curated-only" },
  { name: "Tehran Times", url: null, expected: true, why: "adversary press, curated-only" },

  // ---- FAIL-OPEN: unknown / unresolved outlet ALLOWED ----
  { name: "Some Random Blog", url: null, expected: false, why: "unknown source => fail-open allow" },
  { name: null, url: null, expected: false, why: "no name + no url => fail-open allow" },
  { name: "", url: "not-a-url", expected: false, why: "unresolvable inputs => fail-open allow" },

  // ---- By URL domain (no usable name): same routing ----
  { name: null, url: "https://apnews.com/article/foo-123", expected: false, why: "apnews.com resolves to a main outlet" },
  { name: null, url: "https://www.wsj.com/articles/foo", expected: true, why: "wsj.com resolves to a curated-only outlet" },
  { name: null, url: "https://feeds.bbci.co.uk/news/x", expected: false, why: "bbc.co.uk subdomain strips to a main outlet" },
  { name: null, url: "https://www.rt.com/news/foo", expected: true, why: "rt.com resolves to a curated-only outlet" },
  { name: null, url: "https://example.com/some-story", expected: false, why: "unknown domain => fail-open allow" },

  // ---- Name wins over URL: a known main name on a curated-only URL still promotes ----
  { name: "AP News", url: "https://www.rt.com/news/foo", expected: false, why: "name resolves first to a main outlet" },
];

let failures = 0;
for (const c of cases) {
  const got = isCuratedOnlyForMainFeed(index, ids, c.name, c.url);
  const ok = got === c.expected;
  if (!ok) failures++;
  const label = c.name !== null ? `name="${c.name}"` : `url="${c.url}"`;
  console.log(`  ${ok ? "OK " : "XX "} ${label}: got=${got} want=${c.expected} — ${c.why}`);
}

// Empty curated-only set => never blocks (defensive: a build that yields no ids
// must not start blocking everything).
{
  const empty = new Set<string>();
  const got = isCuratedOnlyForMainFeed(index, empty, "RT", "https://www.rt.com/news/foo");
  const ok = got === false;
  if (!ok) failures++;
  console.log(`  ${ok ? "OK " : "XX "} empty id set: got=${got} want=false — empty set never blocks (fail-open)`);
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} case(s) did not match the expected main-feed gate decision.`);
  process.exit(1);
}
console.log(`\nPASSED: all ${cases.length + 1} main-feed promotion-gate cases.`);
process.exit(0);
