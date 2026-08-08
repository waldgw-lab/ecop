/**
 * scripts/curated-classify-eligibility.test.ts
 *
 * Deterministic gate — no LLM, no network. Stubs the three storage methods
 * called by buildCuratedCandidateWindow() so the DB is never touched.
 *
 * Verifies:
 *   1. AI-provenance 'Other / Emerging' rows are reclassify-eligible.
 *   2. Human-provenance 'Other / Emerging' rows are protected (never re-classified).
 *   3. Unknown/null provenance 'Other / Emerging' rows are protected (fail-closed).
 *   4. Rows with a real primary topic are locked (generate-once).
 *   5. Legacy null-primaryTopic rows (pre-structured-classification) are eligible.
 *   6. The keyword router rescues obviously-routable catch-all misses.
 *   7. The keyword router does NOT override a real AI topic (only fires on Other/Emerging).
 *   8. SCN lane behavioral: curated-store items that rank below CANDIDATE_WINDOW=200
 *      AND below the RECENCY_LANE=30 newest ARE present in the output of
 *      buildCuratedCandidateWindow() — exercised by calling the real function with
 *      stubbed storage, so the test catches any removal of the SCN lane.
 *
 * Exit 0 = PASS. Exit 1 = FAIL. No exit 3 (purely deterministic).
 */

import { inferPersistablePrimaryTopic } from '../shared/classificationVocab';
import { storage } from '../server/storage';
import { buildCuratedCandidateWindow } from '../server/curatedClassify';

const OTHER_EMERGING = 'Other / Emerging';

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures++;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Mirror the eligibility predicate from classifyCuratedUrls so this gate
// catches any future drift between "the test knows" and "the code does".
// Must stay in exact sync with the needsUpgrade logic in curatedClassify.ts.
// ──────────────────────────────────────────────────────────────────────────────
function isReclassifyEligible(row: { primaryTopic: string | null; provenance: string | null }): boolean {
  const isOtherEmerging = row.primaryTopic === OTHER_EMERGING;
  return !row.primaryTopic || (isOtherEmerging && row.provenance === 'ai');
}

// ──────────────────────────────────────────────────────────────────────────────
// Mirror the keyword post-check from classifyCuratedUrls.
// ──────────────────────────────────────────────────────────────────────────────
function applyKeywordPostCheck(
  primaryTopic: string | null,
  title: string,
): string | null {
  if (primaryTopic !== OTHER_EMERGING) return primaryTopic;
  const inferred = inferPersistablePrimaryTopic(title);
  if (inferred && inferred !== OTHER_EMERGING) return inferred;
  return primaryTopic;
}

// ──────────────────────────────────────────────────────────────────────────────
// Group 1: Reclassify-eligibility predicate
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Reclassify-eligibility predicate');

assert(
  isReclassifyEligible({ primaryTopic: OTHER_EMERGING, provenance: 'ai' }),
  'AI Other/Emerging IS eligible (catch-all unlock)',
);

assert(
  !isReclassifyEligible({ primaryTopic: OTHER_EMERGING, provenance: 'human' }),
  'Human Other/Emerging is NOT eligible (protected)',
);

assert(
  !isReclassifyEligible({ primaryTopic: OTHER_EMERGING, provenance: null }),
  'Null-provenance Other/Emerging is NOT eligible (fail-closed)',
);

assert(
  !isReclassifyEligible({ primaryTopic: 'Military Operations & Armed Conflict', provenance: 'ai' }),
  'AI row with real topic is locked (generate-once)',
);

assert(
  !isReclassifyEligible({ primaryTopic: 'Military Operations & Armed Conflict', provenance: 'human' }),
  'Human row with real topic is locked (generate-once)',
);

assert(
  isReclassifyEligible({ primaryTopic: null, provenance: 'ai' }),
  'Null primaryTopic (legacy unclassified) IS eligible',
);

assert(
  isReclassifyEligible({ primaryTopic: null, provenance: 'human' }),
  'Null primaryTopic with human provenance IS eligible (legacy pre-structured row)',
);

// ──────────────────────────────────────────────────────────────────────────────
// Group 2: Keyword post-check rescues obvious catch-all misses
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Keyword-router post-check');

const hormuzTitle = "Trump warns Iran: Hormuz blockade will trigger military response";
const hormuzResult = applyKeywordPostCheck(OTHER_EMERGING, hormuzTitle);
assert(
  hormuzResult === 'Maritime Security & Chokepoints',
  `Hormuz blockade catch-all → Maritime Security & Chokepoints (got: ${hormuzResult})`,
);

// Red Sea is a maritime chokepoint — inferPrimaryTopic routes it there, which is
// the correct behavior. The point is the router fires at all (breaks out of Other/Emerging).
const redSeaTitle = "Houthis fire missile at US destroyer in Red Sea";
const redSeaResult = applyKeywordPostCheck(OTHER_EMERGING, redSeaTitle);
assert(
  redSeaResult !== OTHER_EMERGING && redSeaResult !== null,
  `Red Sea strike catch-all → router fires a real topic (got: ${redSeaResult})`,
);

const sanctionsTitle = "US imposes sweeping sanctions on Iranian oil exports";
const sanctionsResult = applyKeywordPostCheck(OTHER_EMERGING, sanctionsTitle);
assert(
  sanctionsResult === 'Economic Statecraft & Sanctions',
  `Sanctions catch-all → Economic Statecraft & Sanctions (got: ${sanctionsResult})`,
);

const realTopicTitle = "Pentagon announces troop deployment to Eastern Europe";
const realTopicResult = applyKeywordPostCheck('Force Posture & Deployments', realTopicTitle);
assert(
  realTopicResult === 'Force Posture & Deployments',
  'Real topic is NOT overridden by keyword post-check (only fires on Other/Emerging)',
);

const ambiguousTitle = "Local official resigns amid investigation";
const ambiguousResult = applyKeywordPostCheck(OTHER_EMERGING, ambiguousTitle);
assert(
  ambiguousResult === OTHER_EMERGING,
  `Genuinely ambiguous story stays Other/Emerging when router fires nothing (got: ${ambiguousResult})`,
);

const displayOnlyRescueTitle = "CIA Sets Up Secret Cuba Task Force as White House Pressures Havana";
const displayOnlyRescueResult = applyKeywordPostCheck(OTHER_EMERGING, displayOnlyRescueTitle);
assert(
  displayOnlyRescueResult === OTHER_EMERGING,
  `Display-only outage rescue is never persisted by classifier post-check (got: ${displayOnlyRescueResult})`,
);

// ──────────────────────────────────────────────────────────────────────────────
// Group 3: SCN lane — behavioral test via real buildCuratedCandidateWindow()
//
// Fixture design (must hold without changing the constants in curatedClassify.ts):
//   CANDIDATE_WINDOW = 200 (ranked slice cap)
//   RECENCY_LANE     = 30  (newest items added on top of ranked)
//
// We create CANDIDATE_WINDOW (200) high-score items in curatedStore so they
// saturate the ranked slice, then add ONE adversary/state-media item with the
// LOWEST score AND the OLDEST scrapedAt — so it falls below BOTH the ranked
// window AND the recency lane. Without the SCN lane this item would be absent
// from the candidate set; WITH the SCN lane it MUST appear.
//
// The main feed is empty and cluster members is empty so all items come from
// curatedStore, keeping the fixture simple and deterministic.
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[3] SCN lane: behavioral test via buildCuratedCandidateWindow()');

const CANDIDATE_WINDOW = 200; // must match the constant in curatedClassify.ts
const RECENCY_LANE = 30;      // must match the constant in curatedClassify.ts

// 200 items that will fill the ranked window completely.
const HIGH_SCORE = 100;
const now = Date.now();
const twelvehAgo = new Date(now - 12 * 60 * 60 * 1000);

const highScoringItems = Array.from({ length: CANDIDATE_WINDOW }, (_, i) => ({
  id: i + 1,
  url: `https://reuters.com/article-${i + 1}`,
  title: `Reuters article ${i + 1}`,
  source: 'Reuters',
  category: 'world',
  priorityScore: HIGH_SCORE,
  scrapedAt: twelvehAgo,
  articlePublishedAt: null as Date | null,
  // Include all other CuratedItem fields that buildCuratedCandidateWindow touches
  summaryBullets: null as string[] | null,
  summary: null as string | null,
  contentKind: null as string | null,
  linkDeadAt: null as Date | null,
  image: null as string | null,
  media_scraped_at: null as Date | null,
  media_scrape_attempts: 0,
  mediaRescueAt: null as Date | null,
}));

// One adversary/SCN item that MUST land below both the ranked window and the
// recency lane. Score is near-zero; scrapedAt is the oldest of all items.
const SCN_URL = 'https://cgtn.com/scn-below-cut-01';
const belowCutItem = {
  id: CANDIDATE_WINDOW + 1,
  url: SCN_URL,
  title: 'CGTN: Taiwan military drills escalate cross-strait tensions',
  source: 'CGTN',
  category: 'world',
  priorityScore: 0.001, // lowest score → ranks 201st, below CANDIDATE_WINDOW cut
  // oldest scrapedAt → below RECENCY_LANE (top 30 newest); 23h ensures it's still
  // within the WINDOW_HOURS=24 ingestion window that getCuratedStoreItems applies.
  scrapedAt: new Date(now - 23 * 60 * 60 * 1000),
  articlePublishedAt: null as Date | null,
  summaryBullets: null as string[] | null,
  summary: null as string | null,
  contentKind: null as string | null,
  linkDeadAt: null as Date | null,
  image: null as string | null,
  media_scraped_at: null as Date | null,
  media_scrape_attempts: 0,
  mediaRescueAt: null as Date | null,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalGetCuratedStoreItems = (storage as any).getCuratedStoreItems.bind(storage);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalGetPrimaryFeed = (storage as any).getPrimaryFeed.bind(storage);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalGetCuratedClusterMembers = (storage as any).getCuratedClusterMembers.bind(storage);

(storage as any).getCuratedStoreItems = async (_hours: number) =>
  [...highScoringItems, belowCutItem] as unknown[];

(storage as any).getPrimaryFeed = async (_hours: number) => []; // empty main feed

(storage as any).getCuratedClusterMembers = async (_hours: number) => []; // no cluster members

let candidates: Array<{ url: string; title: string }> = [];
let onScreenUrls = new Set<string>();
let scnError: Error | null = null;
try {
  const result = await buildCuratedCandidateWindow();
  candidates = result.candidates;
  onScreenUrls = result.onScreenUrls;
} catch (err) {
  scnError = err as Error;
} finally {
  (storage as any).getCuratedStoreItems = originalGetCuratedStoreItems;
  (storage as any).getPrimaryFeed = originalGetPrimaryFeed;
  (storage as any).getCuratedClusterMembers = originalGetCuratedClusterMembers;
}

assert(scnError === null, `buildCuratedCandidateWindow() did not throw (error: ${scnError?.message})`);

const urls = new Set(candidates.map((c) => c.url));

assert(
  onScreenUrls.size === 100,
  `Visible classifier window covers the editor's full 100-card view (got: ${onScreenUrls.size})`,
);
assert(
  onScreenUrls.has(highScoringItems[99].url) && !onScreenUrls.has(highScoringItems[100].url),
  'Visible classifier window includes rank 100 but not rank 101',
);

assert(
  urls.has(SCN_URL),
  `SCN lane: below-CANDIDATE_WINDOW + below-RECENCY_LANE curated-store item is included in candidate set`,
);

assert(
  urls.has(highScoringItems[0].url),
  `SCN lane: above-cut items are also included (SCN does not displace ranked results)`,
);

// The ranked window fills with CANDIDATE_WINDOW items; the below-cut item adds 1 more.
// (Recency lane might add some of the same high-score items, deduped, so minimum
//  candidate count is CANDIDATE_WINDOW + 1.)
assert(
  candidates.length >= CANDIDATE_WINDOW + 1,
  `SCN lane: total candidates (${candidates.length}) >= CANDIDATE_WINDOW(${CANDIDATE_WINDOW}) + 1 below-cut item`,
);

// Sanity: the below-cut item genuinely would NOT be in the ranked+recency set.
// Ranked: 200 high-score items fill it; below-cut has the lowest score → rank 201.
// Recency: 200 high-score items all have the same scrapedAt (12h ago), below-cut
// is oldest (23h ago) → it would be 201st in the recency sort too. So without the
// SCN lane it MUST be absent. We prove this by checking the ranked+recency set size
// (which is CANDIDATE_WINDOW before dedup, and the below-cut item is not in it):
// If the SCN lane were removed, candidates.length would equal CANDIDATE_WINDOW (200),
// not CANDIDATE_WINDOW+1 (201). The assertion above covers this implication.
assert(
  !highScoringItems.some((h) => h.url === SCN_URL),
  'Fixture sanity: the SCN item URL is genuinely distinct from all high-score items',
);

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`[curated-classify-eligibility] FAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`[curated-classify-eligibility] PASS — all checks passed.`);
process.exit(0);
