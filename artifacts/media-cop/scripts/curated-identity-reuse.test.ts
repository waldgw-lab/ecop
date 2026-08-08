/**
 * Regression test for the Curated stable-IDENTITY reuse matcher
 * (priorIdentityMatchScore in server/curatedCluster.ts) — Task #301.
 *
 * Background: a FORMED curated story is persisted under a clusterId that is a
 * hash of its full member-URL token set, so the id RE-MINTS the moment a source
 * joins or drops. That left a phantom prior-pass row whose archive copy went
 * "not live" and surfaced as a FALSE "phased out" duplicate while the very same
 * story was still on the feed under the NEW id. The fix gives each story ONE
 * stable identity across churn by reclaiming its prior-pass clusterId when the
 * freshly formed story clearly CONTINUES it. priorIdentityMatchScore is the pure
 * decision at the heart of that reuse:
 *   - returns null  => NOT a continuation (distinct concurrent story; keep its
 *     own natural hash so two stories never collapse onto one id)
 *   - returns a number => a continuation; higher = stronger (the engine takes
 *     the argmax among unused prior identities)
 *
 * It is fully pure + deterministic (no DB), so this locks the veto + overlap
 * thresholds directly. No test framework is configured — run with tsx:
 *   ./node_modules/.bin/tsx scripts/curated-identity-reuse.test.ts
 * Exits non-zero on any failure.
 */
import {
  priorIdentityMatchScore,
  type StoryIdentityMatchInput,
} from '../server/curatedCluster';
import {
  isPriorIdentityReclaimable,
  isWithinEpisodeAge,
  CURATED_EPISODE_HARD_AGE_MS,
} from '../server/curatedEpisode';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS [${name}]`);
  } else {
    console.error(`FAIL [${name}]${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

function inp(
  tokens: string[],
  head: string[],
  category: string | null = null,
  region: string | null = null,
): StoryIdentityMatchInput {
  return { tokens: new Set(tokens), headTokens: new Set(head), category, region };
}

const HEAD = ['gaza', 'ceasefire', 'talks', 'qatar'];

// 1) Identical member set + identical headline => strong continuation.
{
  const s = priorIdentityMatchScore(inp(['a', 'b', 'c'], HEAD), inp(['a', 'b', 'c'], HEAD));
  check('identical member set + headline is a continuation', s !== null && s > 0);
}

// 2) Membership churned (one source swapped) but containment stays high => match.
{
  const s = priorIdentityMatchScore(
    inp(['a', 'b', 'c', 'd'], HEAD),
    inp(['a', 'b', 'c', 'e'], HEAD),
  );
  check('churned membership (one swap) still matches', s !== null);
}

// 3) Big source-count swing: containment over the SMALLER set still recognizes
//    the continuation (a 2-source pass continuing a 6-source story).
{
  const s = priorIdentityMatchScore(
    inp(['a', 'b'], HEAD),
    inp(['a', 'b', 'c', 'd', 'e', 'f'], HEAD),
  );
  check('big source-count swing still matches via smaller-set containment', s !== null);
}

// 4) Low containment (0.25) RESCUED by a closely matching headline (>=0.5).
{
  const s = priorIdentityMatchScore(
    inp(['a', 'b', 'c', 'd'], ['gaza', 'ceasefire', 'talks', 'today']),
    inp(['a', 'x', 'y', 'z'], ['gaza', 'ceasefire', 'talks', 'night']),
  );
  check('low member overlap rescued by matching headline', s !== null);
}

// 5) Very low containment (<0.25) but near-identical headline + >=2 shared
//    members => match via the headline branch.
{
  const s = priorIdentityMatchScore(
    inp(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], HEAD),
    inp(['a', 'b', 'p', 'q', 'r', 's', 't', 'u', 'v'], HEAD),
  );
  check('headline-driven match when member containment is very low', s !== null);
}

// 6) CATEGORY veto: different categories => never the same story, even on a
//    perfect member-set + headline overlap.
{
  const s = priorIdentityMatchScore(
    inp(['a', 'b', 'c'], HEAD, 'Conflict'),
    inp(['a', 'b', 'c'], HEAD, 'Economy'),
  );
  check('different category vetoes even a perfect overlap', s === null);
}

// 7) REGION veto: different subject-regions => not the same story.
{
  const s = priorIdentityMatchScore(
    inp(['a', 'b', 'c'], HEAD, null, 'Middle East'),
    inp(['a', 'b', 'c'], HEAD, null, 'Europe'),
  );
  check('different region vetoes even a perfect overlap', s === null);
}

// 8) Region comparison is case-insensitive (the overlay can vary in casing).
{
  const s = priorIdentityMatchScore(
    inp(['a', 'b', 'c'], HEAD, null, 'Middle East'),
    inp(['a', 'b', 'c'], HEAD, null, 'middle east'),
  );
  check('region match is case-insensitive (no spurious veto)', s !== null);
}

// 9) No shared members => not a continuation.
{
  const s = priorIdentityMatchScore(inp(['a', 'b'], HEAD), inp(['c', 'd'], HEAD));
  check('zero shared members is not a continuation', s === null);
}

// 10) Weak overlap on BOTH axes (containment 0.25, headline barely overlaps)
//     => distinct story, null.
{
  const s = priorIdentityMatchScore(
    inp(['a', 'b', 'c', 'd'], ['gaza', 'ceasefire', 'talks', 'today']),
    inp(['a', 'x', 'y', 'z'], ['tariffs', 'china', 'trade', 'today']),
  );
  check('weak overlap on both axes is a distinct story (null)', s === null);
}

// 11) A one-sided UNKNOWN category never vetoes (only both-known-and-different).
{
  const s = priorIdentityMatchScore(
    inp(['a', 'b', 'c'], HEAD, null),
    inp(['a', 'b', 'c'], HEAD, 'Economy'),
  );
  check('one-sided unknown category does not veto', s !== null);
}

// 12) A one-sided UNKNOWN region never vetoes.
{
  const s = priorIdentityMatchScore(
    inp(['a', 'b', 'c'], HEAD, null, 'Middle East'),
    inp(['a', 'b', 'c'], HEAD, null, null),
  );
  check('one-sided unknown region does not veto', s !== null);
}

// 13) Score ORDERING: a stronger continuation scores higher than a weaker one,
//     so the engine's argmax over unused priors reclaims the RIGHT id.
{
  const strong = priorIdentityMatchScore(inp(['a', 'b', 'c'], HEAD), inp(['a', 'b', 'c'], HEAD));
  const weak = priorIdentityMatchScore(
    inp(['a', 'b', 'c', 'd'], ['gaza', 'ceasefire', 'talks', 'today']),
    inp(['a', 'x', 'y', 'z'], ['gaza', 'ceasefire', 'talks', 'night']),
  );
  check(
    'a stronger continuation scores higher than a weaker one',
    strong !== null && weak !== null && strong > weak,
    `strong=${strong} weak=${weak}`,
  );
}

// ---------------------------------------------------------------------------
// Topical-compatibility relaxation (Task #356). When category AND region are
// BOTH known and equal, a continuing mega-story whose source SET swings hard
// pass-to-pass (containment dips below 0.5, headline reworded below 0.5) should
// STILL reclaim its prior identity instead of minting a fresh small fragment —
// but the relaxed branch stays guarded by >= 2 shared REAL member articles so a
// single wire pickup or an opposite-direction counter-strike can never trip it.
// ---------------------------------------------------------------------------

// 21) Relaxed match FIRES: same category+region, >= 2 shared members, moderate
//     containment (~0.4) + reworded headline (< 0.5) — previously NULL.
{
  const s = priorIdentityMatchScore(
    inp(['a', 'b', 'p', 'q', 'r'], ['strait', 'hormuz', 'tankers', 'today'], 'Conflict', 'Middle East'),
    inp(['a', 'b', 'c', 'd', 'e'], ['hormuz', 'strait', 'shipping', 'tonight'], 'Conflict', 'Middle East'),
  );
  check('relaxed: same category+region + >=2 shared + moderate overlap matches', s !== null);
  // And the STRICT thresholds alone would have rejected it (no cat/region) — proves
  // it is the topical-compatibility branch doing the work, not the existing branches.
  const strict = priorIdentityMatchScore(
    inp(['a', 'b', 'p', 'q', 'r'], ['strait', 'hormuz', 'tankers', 'today']),
    inp(['a', 'b', 'c', 'd', 'e'], ['hormuz', 'strait', 'shipping', 'tonight']),
  );
  check('relaxed branch is what unlocks the match (strict alone is null)', strict === null);
}

// 22) Relaxed match does NOT fire without BOTH category AND region known-equal:
//     same scenario but region unknown on one side => the strict bar applies and
//     this weak overlap stays a distinct story (null). Guards against widening
//     reuse for topically-unconstrained stories.
{
  const s = priorIdentityMatchScore(
    inp(['a', 'b', 'p', 'q', 'r'], ['strait', 'hormuz', 'tankers', 'today'], 'Conflict', null),
    inp(['a', 'b', 'c', 'd', 'e'], ['hormuz', 'strait', 'shipping', 'tonight'], 'Conflict', 'Middle East'),
  );
  check('relaxed branch needs BOTH category AND region (one-sided unknown => null)', s === null);
}

// 23) FALSE-MERGE GUARD: same category+region but only ONE shared member (a single
//     shared wire pickup) => never a continuation, even with a similar headline.
{
  const s = priorIdentityMatchScore(
    inp(['a', 'p', 'q', 'r', 's'], ['strait', 'hormuz', 'tankers', 'today'], 'Conflict', 'Middle East'),
    inp(['a', 'c', 'd', 'e', 'f'], ['hormuz', 'strait', 'shipping', 'tonight'], 'Conflict', 'Middle East'),
  );
  check('false-merge guard: 1 shared member never matches (relaxed needs >=2)', s === null);
}

// 24) COUNTER-STRIKE GUARD: same category+region, headline words overlap heavily,
//     but the counter-strike shares NO article URLs with the strike it answers =>
//     distinct event, null (shared === 0 short-circuits before any branch).
{
  const s = priorIdentityMatchScore(
    inp(['x', 'y', 'z'], ['iran', 'strikes', 'us', 'base'], 'Conflict', 'Middle East'),
    inp(['a', 'b', 'c'], ['us', 'strikes', 'iran', 'site'], 'Conflict', 'Middle East'),
  );
  check('counter-strike guard: no shared articles => distinct event (null)', s === null);
}

// 25) Topical-compatibility BONUS biases the argmax: a same-category/region prior
//     scores higher than an identical-overlap prior whose category/region is
//     unknown, so the engine reclaims the topically-aligned identity.
{
  const withTopic = priorIdentityMatchScore(
    inp(['a', 'b', 'c'], HEAD, 'Conflict', 'Middle East'),
    inp(['a', 'b', 'c'], HEAD, 'Conflict', 'Middle East'),
  );
  const noTopic = priorIdentityMatchScore(inp(['a', 'b', 'c'], HEAD), inp(['a', 'b', 'c'], HEAD));
  check(
    'topical-compatibility bonus makes a same-category/region prior win the argmax',
    withTopic !== null && noTopic !== null && withTopic > noTopic,
    `withTopic=${withTopic} noTopic=${noTopic}`,
  );
}

// ---------------------------------------------------------------------------
// Episode-lifespan eligibility (Task #334). isPriorIdentityReclaimable bounds
// how long ONE identity may be reclaimed: a continuously-covered story's live
// cluster is a sliding window that never goes stale, so without an absolute
// origination-based cap a clusterId is reclaimed forever (the 5-day / 1,855-
// source zombie archive row). The gate also requires the prior cluster to have
// SURVIVED phase-out, so a phased-out story surrenders its id and a re-formed
// story later starts a fresh episode.
// ---------------------------------------------------------------------------
const NOW = Date.UTC(2026, 5, 18, 12, 0, 0);

// 14) A phased-out prior (keep=false) is NEVER reclaimable, regardless of age.
{
  const ok = isPriorIdentityReclaimable({ keep: false, originationMs: NOW - 60_000, nowMs: NOW });
  check('phased-out identity (keep=false) is not reclaimable', ok === false);
}

// 15) A surviving, fresh episode (well within the cap) is reclaimable.
{
  const ok = isPriorIdentityReclaimable({
    keep: true,
    originationMs: NOW - 10 * 60 * 60 * 1000, // 10h old
    nowMs: NOW,
  });
  check('surviving in-window identity is reclaimable', ok === true);
}

// 16) A surviving but OVER-AGE episode (past the hard cap) is NOT reclaimable —
//     the continuing story rolls over to a fresh episode (kills the zombie).
{
  const ok = isPriorIdentityReclaimable({
    keep: true,
    originationMs: NOW - (CURATED_EPISODE_HARD_AGE_MS + 60 * 60 * 1000), // cap + 1h
    nowMs: NOW,
  });
  check('surviving but over-age identity is NOT reclaimable (rolls over)', ok === false);
}

// 17) Exactly AT the cap boundary is still reclaimable (inclusive bound).
{
  const ok = isPriorIdentityReclaimable({
    keep: true,
    originationMs: NOW - CURATED_EPISODE_HARD_AGE_MS,
    nowMs: NOW,
  });
  check('identity exactly at the cap boundary is reclaimable', ok === true);
}

// 18) A surviving identity with NO archive row yet (origination unknown/null) is
//     reclaimable — a brand-new story on its first/second formation is never
//     churned just because its archive row hasn't been written yet.
{
  const ok = isPriorIdentityReclaimable({ keep: true, originationMs: null, nowMs: NOW });
  check('missing origination (no archive row yet) is reclaimable', ok === true);
}

// 19) isWithinEpisodeAge: null origination is treated as in-window.
{
  check('isWithinEpisodeAge(null) is in-window', isWithinEpisodeAge(null, NOW) === true);
}

// 20) isWithinEpisodeAge: over-cap origination is out of window.
{
  check(
    'isWithinEpisodeAge over-cap is out of window',
    isWithinEpisodeAge(NOW - (CURATED_EPISODE_HARD_AGE_MS + 1), NOW) === false,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall identity-reuse checks passed');
