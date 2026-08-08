/**
 * Regression gate: long-lived-story SYNOPSIS refresh (Task #920).
 *
 * Exercises the pure decision helpers in server/curatedStaleness.ts —
 * `shouldRefreshStaleSynopsis` and `freshestContributingContentMs` — plus the
 * "Updated" honesty invariant. No DB, no network, no AI required.
 *
 * WHAT THIS PROTECTS
 *   A clustered story that legitimately outlives the 22h kinetic cap (the 48h
 *   developing-process lane / 36h general active-extension) whose member SET has
 *   settled kept a FROZEN synopsis, because re-synthesis only fired on a
 *   member-presence fingerprint change. The refresh trigger below re-synthesizes
 *   ONCE per genuinely-newer development, bounded so it can never loop.
 *
 * Scenarios:
 *   (a) Refresh FIRES — a >22h-old story whose freshest contributing content
 *       leads the stored synthesized-through marker by > the margin, past the
 *       cooldown.
 *   (b) No newer content → NO refresh (no loop) — freshest contributing content
 *       equals the synthesized-through marker (the self-terminating state right
 *       after a synthesis).
 *   (c) Within cooldown → NO refresh — genuinely newer content, but the last
 *       synthesis was too recent; refreshing again would be a per-pass loop.
 *   (d) Below the age cap → NO refresh — a young story still re-synthesizes on
 *       ordinary member-presence changes; the stale-synopsis rescue is scoped to
 *       long-lived stories only.
 *   (e) Null synthesized-through marker → NO refresh (legacy rows are handled by
 *       the one-time backfill path, not this rule).
 *   (f) Only attach/adversary content is fresh → NO refresh — attach-only and
 *       contrast members can't move the reported facts, so they never count as
 *       "newer contributing content".
 *   (g) "Updated" never leads synthesized-through — the displayed timestamp is
 *       derived FROM the synthesized-through marker, so it can never advertise a
 *       freshness the text lacks.
 *
 * Exit 0 = PASS, exit 1 = FAIL.
 * Usage: npx tsx scripts/curated-stale-synopsis-refresh.test.ts
 */

import {
  shouldRefreshStaleSynopsis,
  freshestContributingContentMs,
  STALE_SYNOPSIS_TUNING,
} from '../server/curatedStaleness';

// Pull out both cooldowns for the kinetic-path tests added in Task #954.
const { STALE_SYNOPSIS_COOLDOWN_KINETIC_MS } = STALE_SYNOPSIS_TUNING;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[stale-synopsis] OK   ${name}`);
  } else {
    console.error(`[stale-synopsis] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const now = Date.now();
const H = 3_600_000;
const { STALE_SYNOPSIS_MARGIN_MS, STALE_SYNOPSIS_COOLDOWN_MS } = STALE_SYNOPSIS_TUNING;

// ---------------------------------------------------------------------------
// (a) Refresh FIRES for a long-lived story with genuinely newer contributing
//     content, past the cooldown.
const synthedThrough = now - 6 * H; // synopsis last built from 6h-old content
const freshContrib = synthedThrough + STALE_SYNOPSIS_MARGIN_MS + 5 * 60_000; // clearly past margin
check(
  '(a) newer contributing content → refresh fires',
  shouldRefreshStaleSynopsis({
    ageH: 30, // > 22h cap (a 36h/48h-lane story)
    freshestContribMs: freshContrib,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_MS + 5 * 60_000,
  }) === true,
);

// ---------------------------------------------------------------------------
// (b) Self-terminating: freshest contributing == synthesized-through → no refresh.
check(
  '(b) no newer content (delta 0) → no refresh (no loop)',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: synthedThrough,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_MS + 5 * 60_000,
  }) === false,
);

// Also: a sub-margin jitter must not trigger a refresh.
check(
  '(b2) sub-margin jitter → no refresh',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: synthedThrough + STALE_SYNOPSIS_MARGIN_MS - 60_000,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_MS + 5 * 60_000,
  }) === false,
);

// ---------------------------------------------------------------------------
// (c) Within cooldown → no refresh even with genuinely newer content.
check(
  '(c) within cooldown → no refresh',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: freshContrib,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_MS - 60_000,
  }) === false,
);

// ---------------------------------------------------------------------------
// (d) Below the age cap → no refresh (young stories use ordinary re-synthesis).
check(
  '(d) below age cap → no refresh',
  shouldRefreshStaleSynopsis({
    ageH: 10,
    freshestContribMs: freshContrib,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_MS + 5 * 60_000,
  }) === false,
);

// ---------------------------------------------------------------------------
// (e) Null synthesized-through marker → no refresh (handled by backfill path).
check(
  '(e) null synthesized-through → no refresh',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: freshContrib,
    synthesizedThroughMs: null,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_MS + 5 * 60_000,
  }) === false,
);

// ---------------------------------------------------------------------------
// (f) Only attach/adversary content is fresh → freshestContributingContentMs
//     ignores it, so there is no "newer contributing content".
const oldContribMs = now - 6 * H;
const freshAttachMs = now - 10 * 60_000; // 10 min ago, but attach-only
const members = [
  { cls: 'corroborating' as const, publishedAt: new Date(oldContribMs) },
  { cls: 'corroborating' as const, publishedAt: new Date(oldContribMs - H) },
  { cls: 'attach' as const, publishedAt: new Date(freshAttachMs) },
  { cls: 'anchor-only' as const, label: 'contrast', publishedAt: new Date(freshAttachMs) },
];
const freshest = freshestContributingContentMs(members);
check(
  '(f) attach/adversary freshness ignored by freshestContributingContentMs',
  freshest === oldContribMs,
  `got ${freshest}, expected ${oldContribMs}`,
);
check(
  '(f2) attach-only newer content → no refresh (facts cannot move)',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: freshest,
    synthesizedThroughMs: oldContribMs, // synopsis already through the freshest CONTRIBUTING
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_MS + 5 * 60_000,
  }) === false,
);

// behaviorClass alias is honored too (stored-member shape).
check(
  '(f3) behaviorClass alias honored',
  freshestContributingContentMs([
    { behaviorClass: 'corroborating', publishedAt: new Date(oldContribMs) },
    { behaviorClass: 'attach', publishedAt: new Date(freshAttachMs) },
  ]) === oldContribMs,
);

// ---------------------------------------------------------------------------
// (g) "Updated" honesty invariant: the displayed "Updated" is derived FROM the
//     synthesized-through marker, so it can never lead the synopsis content even
//     when a fresher (not-yet-synthesized) member exists.
//     Mirrors the read-path derivation in routes.ts.
function displayedUpdatedMs(o: {
  synthesizedThroughMs: number | null;
  synthUpdatedAtMs: number | null;
  freshestMemberMs: number | null;
}): number | null {
  return o.synthesizedThroughMs ?? o.synthUpdatedAtMs ?? o.freshestMemberMs;
}
const synthesizedThroughG = now - 3 * H;
const freshestMemberG = now - 20 * 60_000; // a fresh attach member, not yet in synopsis
const displayed = displayedUpdatedMs({
  synthesizedThroughMs: synthesizedThroughG,
  synthUpdatedAtMs: now,
  freshestMemberMs: freshestMemberG,
});
check(
  '(g) displayed "Updated" never leads synthesized-through',
  displayed === synthesizedThroughG && displayed <= synthesizedThroughG,
  `displayed=${displayed} synthesizedThrough=${synthesizedThroughG}`,
);

// ---------------------------------------------------------------------------
// (h) Kinetic cooldown path (Task #954): kinetic-dominant clusters use the
//     shorter 1h cooldown so active war stories re-synthesize up to once per
//     hour rather than the default 2h.
//
//     (h1) kinetic=true + past 1h + newer content → refresh fires.
//     (h2) kinetic=true + within 1h → NO refresh (cooldown enforced).
//     (h3) kinetic=false + between 1h and 2h → NO refresh (default 2h applies).
//     (h4) kinetic=false + past 2h → refresh fires (same as existing (a)).
// ---------------------------------------------------------------------------
const { STALE_SYNOPSIS_COOLDOWN_MS: DEFAULT_COOLDOWN_MS } = STALE_SYNOPSIS_TUNING;

check(
  '(h1) kinetic=true past 1h cooldown → refresh fires',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: freshContrib,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_KINETIC_MS + 5 * 60_000,
    isKineticDominant: true,
  }) === true,
);
check(
  '(h2) kinetic=true within 1h cooldown → NO refresh',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: freshContrib,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_KINETIC_MS - 60_000,
    isKineticDominant: true,
  }) === false,
);
check(
  '(h3) kinetic=false between 1h and 2h → NO refresh (default 2h cooldown)',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: freshContrib,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_KINETIC_MS + 5 * 60_000, // ~1h5m: past kinetic but under default
    isKineticDominant: false,
  }) === false,
  `1h5m < 2h default: should block`,
);
check(
  '(h4) kinetic=false past 2h default cooldown → refresh fires',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: freshContrib,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: DEFAULT_COOLDOWN_MS + 5 * 60_000,
    isKineticDominant: false,
  }) === true,
);

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n[stale-synopsis] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log(`\n[stale-synopsis] all checks passed`);
process.exit(0);
