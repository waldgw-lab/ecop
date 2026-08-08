/**
 * scripts/curated-staleness-penalty.test.ts
 *
 * Gate: Task #1027 Step 2 — staleness deduction is applied in
 * deriveReuseBaselinePriority for items whose trusted publish date is >48 h or
 * >72 h old at admission time. Deterministic — no DB, no AI, no network.
 *
 * Exit 0 = PASS, exit 1 = FAIL.
 */

import { deriveReuseBaselinePriority } from '../server/curatedIngest';

const JITTER_MAX = 7; // The function adds stableStrHash(url)%8 jitter (0..7).

let passed = 0;
let failed = 0;

function assert(label: string, score: number, minExpected: number, maxExpected: number) {
  if (score >= minExpected && score <= maxExpected) {
    console.log(`  ✓ ${label} — score=${score} ∈ [${minExpected}, ${maxExpected}]`);
    passed++;
  } else {
    console.error(`  ✗ ${label} — score=${score}, expected ∈ [${minExpected}, ${maxExpected}]`);
    failed++;
  }
}

console.log('\n[curated-staleness-penalty] Staleness deduction regression tests\n');

const now = new Date();
// Different URLs give different jitter values. Use deterministic keys.
const KEY_FRESH  = 'https://example.com/article-fresh';
const KEY_S48    = 'https://example.com/article-stale48';
const KEY_S72    = 'https://example.com/article-stale72';
const KEY_NOPUB  = 'https://example.com/article-nopub';

const fresh    = new Date(now.getTime() - 1    * 3_600_000); // 1 h ago → no deduction
const stale48  = new Date(now.getTime() - 50   * 3_600_000); // 50 h → -5
const stale72  = new Date(now.getTime() - 80   * 3_600_000); // 80 h → -10

// Role='contributing' → base=52. With 1h recency bonus=8, no deduction:  [52+8, 52+8+7] = [60, 67]
const scoreFresh  = deriveReuseBaselinePriority('contributing', fresh,  KEY_FRESH);
assert('fresh (1 h, contributing) — no staleness deduction', scoreFresh, 60, 67);

// 50 h old: base=52, recency=0 (>24h), staleness=-5, jitter[0,7]: [52-5, 52-5+7] = [47, 54]
const scoreS48 = deriveReuseBaselinePriority('contributing', stale48, KEY_S48);
assert('50 h old (contributing) — -5 deduction', scoreS48, 47, 54);

// 80 h old: base=52, recency=0, staleness=-10, jitter[0,7]: [52-10, 52-10+7] = [42, 49]
const scoreS72 = deriveReuseBaselinePriority('contributing', stale72, KEY_S72);
assert('80 h old (contributing) — -10 deduction', scoreS72, 42, 49);

// Null pub: base=52, recency=0, staleness=0 (no penalty), jitter[0,7]: [52, 59]
const scoreNoPub = deriveReuseBaselinePriority('contributing', null, KEY_NOPUB);
assert('null pubDate — no penalty (honest unknown)', scoreNoPub, 52, 59);

// -----------------------------------------------------------------------------
// Task #1071: relay/social scrapedAt fallback. When pub is null but the item is
// a relay/social post (deterministic: candidate carries its lane-table
// scrapedAt), the staleness deduction must fire on scrapedAt age.
// -----------------------------------------------------------------------------
const KEY_RELAY_STALE = 'https://x.com/CENTCOM/status/relay-stale80';
const KEY_RELAY_S48   = 'https://x.com/CENTCOM/status/relay-stale50';
const KEY_RELAY_FRESH = 'https://x.com/CENTCOM/status/relay-fresh';

// Relay post, null pub, scrapedAt 80h ago → -10. attach-only base=44:
// [44-10, 44-10+7] = [34, 41]
const scoreRelayStale = deriveReuseBaselinePriority('attach-only', null, KEY_RELAY_STALE, stale72);
assert('null pub + relay scrapedAt 80 h — -10 deduction', scoreRelayStale, 34, 41);

// Relay post, null pub, scrapedAt 50h ago → -5: [44-5, 44-5+7] = [39, 46]
const scoreRelayS48 = deriveReuseBaselinePriority('attach-only', null, KEY_RELAY_S48, stale48);
assert('null pub + relay scrapedAt 50 h — -5 deduction', scoreRelayS48, 39, 46);

// Relay post, null pub, FRESH scrapedAt → no deduction AND no recency bonus
// (scrapedAt is first-seen, never a "published fresh" claim): [44, 51]
const scoreRelayFresh = deriveReuseBaselinePriority('attach-only', null, KEY_RELAY_FRESH, fresh);
assert('null pub + fresh relay scrapedAt — no deduction, no recency bonus', scoreRelayFresh, 44, 51);

// Trusted pub WINS over scrapedAt fallback: fresh pub + stale scrapedAt must
// take the pub path (recency bonus 8, no deduction): [52+8, 52+8+7] = [60, 67]
const scorePubWins = deriveReuseBaselinePriority('contributing', fresh, KEY_FRESH, stale72);
assert('trusted pub beats scrapedAt fallback', scorePubWins, 60, 67);

// Direction check: 50h-stale MUST score below the fresh CEILING
// fresh ceiling = 52+8+7 = 67; stale-48 ceiling = 52-5+7 = 54 < 67 ✓
assert(
  'stale48 ceiling (54) < fresh ceiling (67)',
  Math.max(scoreS48, 0),
  0, 54,
);

// Direction check: 80h-stale MUST score below 50h-stale ceiling
// stale-72 ceiling = 42+7 = 49 < stale-48 ceiling 54 ✓
assert(
  'stale72 ceiling (49) < stale48 ceiling (54)',
  Math.max(scoreS72, 0),
  0, 49,
);

console.log(`\n[curated-staleness-penalty] ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
