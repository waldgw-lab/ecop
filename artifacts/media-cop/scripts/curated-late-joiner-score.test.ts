/**
 * Regression gate: late-joiner P-score cap on curated Top Stories.
 *
 * Exercises the pure aggregation logic in server/curatedClusterScore.ts —
 * no DB, no network, no AI required.
 *
 * Scenarios:
 *   (a) Late joiner cap applied — a 20h-old story (cooled to ~P32) receives
 *       a fresh catch-up piece (raw P85, inside its 2h grace); the badge must
 *       not jump to P85; it may rise at most LATE_JOINER_LIFT_CAP above cooled.
 *   (b) Same-cycle story unchanged — all members published within the initial
 *       event window; current max-of-decayed behaviour is preserved exactly.
 *   (c) Provisional member ignored — an unconfirmed bridge-attach member does
 *       not move the badge at all; only confirmed members contribute.
 *   (d) Missing-date fallback — a member with no publishedAt is treated as a
 *       core member, not a late joiner.
 *   (e) Manual override branch untouched — the override path in routes.ts that
 *       calls calculateDepreciatedPriority directly is not affected (this gate
 *       does not test it, just documents the scope boundary).
 *   (f) CORROBORATED fresh burst UNCAPPED — >=2 confirmed members from >=2
 *       distinct publishers published fresh together (a real new development)
 *       roll the event window: the story shows its true fresh priority.
 *   (g) Single-PUBLISHER burst stays capped — two fresh members from the SAME
 *       publisher are one outlet syndicating itself, not corroboration.
 *   (h) Missing publisher keys degrade to DISTINCT — absence of metadata falls
 *       back toward the legacy >=2-members rule (documented contract).
 *   (i) Anchor-based windows — a <12h syndication drip can NOT stretch one
 *       window forever; the drip member lands in a NEW window off the original
 *       anchor and stays capped without corroboration.
 *
 * Exit 0 = PASS, exit 1 = FAIL.
 * Usage: npx tsx scripts/curated-late-joiner-score.test.ts
 */

import { computeClusterPriorityScore, LATE_JOINER_LIFT_CAP, type MemberScoreInput } from '../server/curatedClusterScore';
import { SAME_EVENT_WINDOW_HOURS } from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[late-joiner-score] OK   ${name}`);
  } else {
    console.error(`[late-joiner-score] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3_600_000);
}

// ---------------------------------------------------------------------------
// (a) LATE-JOINER CAP.
//
// Story: "US troops to withdraw from Iraq by September 30"
//   - Published 20h ago with raw P85 → decayed to ~P20 (floor) after 18h of
//     -6/hr depreciation, but let's use a known decay: 20h pub, 2h grace → 18h
//     of decay → 18*6=108, 85-108 = floor 20.
//   - A catch-up piece published 19 minutes ago (inside its 2h grace) with raw
//     P85 joins via the incremental-attach bridge (confirmed).
//
// Expected: badge ≤ cooledBase + LATE_JOINER_LIFT_CAP (i.e. ≤ 20 + 10 = 30).
// ---------------------------------------------------------------------------
{
  const anchor = hoursAgo(20);
  const staleScrapedAt = anchor; // first-seen ≈ published for simplicity
  const freshPub = hoursAgo(19 / 60); // 19 minutes ago

  const members: MemberScoreInput[] = [
    // Core member — original outlet, published at the anchor
    {
      originalPriority: 85,
      scrapedAt: staleScrapedAt,
      articlePublishedAt: anchor,
      confirmed: true,
    },
    // Late joiner — Stars & Stripes catch-up, published 19 min ago
    {
      originalPriority: 85,
      scrapedAt: freshPub,
      articlePublishedAt: freshPub,
      confirmed: true,
    },
  ];

  const score = computeClusterPriorityScore(members, 85, staleScrapedAt);

  // Core member must be decayed on the CURATED tiered curve (Task #1129):
  // P85 = critical band → 3h grace, -4/hr → 20h pub = 17h of decay → max(20, 85-68) = 20 (floor).
  const expectedCooledBase = 20;
  const maxAllowed = expectedCooledBase + LATE_JOINER_LIFT_CAP; // 30

  check(
    `(a) late joiner does not reset a 20h-old story to its raw P score (≤ ${maxAllowed})`,
    score <= maxAllowed,
    `score was ${score}; allowed ≤ ${maxAllowed}`,
  );
  check(
    '(a) late joiner lifts slightly above cooled base (> cooledBase)',
    score > expectedCooledBase,
    `score was ${score}; cooledBase=${expectedCooledBase}`,
  );
  check(
    `(a) score equals exactly cooledBase + LATE_JOINER_LIFT_CAP (${maxAllowed})`,
    score === maxAllowed,
    `got ${score}`,
  );
}

// ---------------------------------------------------------------------------
// (b) SAME-CYCLE STORY UNCHANGED.
//
// Three members all published within 2h of each other (inside the event window)
// with different raw scores; the result must equal the max of their decayed scores
// — exactly the pre-fix behaviour.
// ---------------------------------------------------------------------------
{
  const t0 = hoursAgo(3);   // all within 12h of each other
  const t1 = hoursAgo(2.5);
  const t2 = hoursAgo(2);

  const members: MemberScoreInput[] = [
    { originalPriority: 70, scrapedAt: t0, articlePublishedAt: t0, confirmed: true },
    { originalPriority: 85, scrapedAt: t1, articlePublishedAt: t1, confirmed: true },
    { originalPriority: 60, scrapedAt: t2, articlePublishedAt: t2, confirmed: true },
  ];

  const score = computeClusterPriorityScore(members, 85, t0);

  // 3h old → 1h of decay after 2h grace → 85-6 = 79
  // 2.5h old → 0.5h → floor(0.5)=0 → 85 still (no full hour elapsed)
  // 2h old → at the boundary → 0h → 85 (inside grace)
  // Expected max = 85
  check(
    '(b) same-cycle story: score equals max-of-decayed across all members',
    score === 85,
    `got ${score}; expected 85`,
  );
}

// ---------------------------------------------------------------------------
// (c) PROVISIONAL MEMBER EXCLUDED.
//
// One confirmed member (published 10h ago, decayed) + one provisional member
// (published 5 min ago, raw P90). The provisional member must not move the badge.
// ---------------------------------------------------------------------------
{
  const confirmedPub = hoursAgo(10); // 10h old → 8h decay → 85 - 48 = 37
  const provisionalPub = hoursAgo(5 / 60); // 5 min ago, inside grace

  const members: MemberScoreInput[] = [
    {
      originalPriority: 85,
      scrapedAt: confirmedPub,
      articlePublishedAt: confirmedPub,
      confirmed: true,
    },
    {
      originalPriority: 90,
      scrapedAt: provisionalPub,
      articlePublishedAt: provisionalPub,
      confirmed: false, // provisional — must not contribute
    },
  ];

  const score = computeClusterPriorityScore(members, 85, confirmedPub);

  // Confirmed member only (tiered critical band): 10h pub → 7h decay after the
  // 3h grace → 85 - 7*4 = 57.
  const expectedFromConfirmed = Math.max(20, 85 - 7 * 4); // 57
  check(
    '(c) provisional member excluded — badge matches confirmed-only score',
    score === expectedFromConfirmed,
    `got ${score}; expected ${expectedFromConfirmed}`,
  );
}

// ---------------------------------------------------------------------------
// (d) MISSING-DATE FALLBACK — treat as core, not a late joiner.
//
// One confirmed core member (published 15h ago, cooled) + one confirmed member
// with no published date. The no-date member must be treated as core (current
// behaviour) and can freely contribute its decayed score.
// ---------------------------------------------------------------------------
{
  const corePub = hoursAgo(15); // 15h old → 13h decay → 85 - 78 = floor 20
  const noDateScrapedAt = hoursAgo(0.1); // scraped very recently; scrapedAt is anchor

  const members: MemberScoreInput[] = [
    { originalPriority: 85, scrapedAt: corePub, articlePublishedAt: corePub, confirmed: true },
    // No articlePublishedAt — must be treated as core, decayed by scrapedAt (0.1h old → inside grace → 80 raw)
    { originalPriority: 80, scrapedAt: noDateScrapedAt, articlePublishedAt: null, confirmed: true },
  ];

  const score = computeClusterPriorityScore(members, 85, corePub);

  // No-date member: inside 2h grace by scrapedAt → decayedScore = 80
  // Core member: 15h old → 13h decay → 85-78=floor 20
  // Both are "core" (no-date fallback applies) → score = max(20, 80) = 80
  check(
    '(d) missing-date member treated as core — contributes its own decayed score freely',
    score === 80,
    `got ${score}; expected 80`,
  );
}

// ---------------------------------------------------------------------------
// (e) ALL PROVISIONAL — fall back to stored rep.
// ---------------------------------------------------------------------------
{
  const repCreatedAt = hoursAgo(5); // 5h → 3h decay → 50 - 18 = 32

  const members: MemberScoreInput[] = [
    { originalPriority: 85, scrapedAt: hoursAgo(1), articlePublishedAt: hoursAgo(1), confirmed: false },
    { originalPriority: 90, scrapedAt: hoursAgo(0.5), articlePublishedAt: hoursAgo(0.5), confirmed: false },
  ];

  const score = computeClusterPriorityScore(members, 50, repCreatedAt);
  const expectedFallback = Math.max(20, 50 - 3 * 6); // 32

  check(
    '(e) all provisional members → falls back to stored rep decayed score',
    score === expectedFallback,
    `got ${score}; expected ${expectedFallback}`,
  );
}

// ---------------------------------------------------------------------------
// (f) CORROBORATED FRESH BURST — uncapped.
//
// A 30h-old story (cooled to floor 20) gets a REAL new development: two fresh
// members (~30 min old, raw P85) from two DISTINCT publishers. The late window
// holds >= 2 members from >= 2 publishers → corroborated → the badge shows the
// true fresh priority (85), NOT the old cap (cooled + 10 = 30).
// ---------------------------------------------------------------------------
{
  const anchor = hoursAgo(30);
  const fresh1 = hoursAgo(0.5);
  const fresh2 = hoursAgo(0.4);

  const members: MemberScoreInput[] = [
    { originalPriority: 85, scrapedAt: anchor, articlePublishedAt: anchor, confirmed: true, publisherKey: 'apnews.com' },
    { originalPriority: 85, scrapedAt: fresh1, articlePublishedAt: fresh1, confirmed: true, publisherKey: 'reuters.com' },
    { originalPriority: 85, scrapedAt: fresh2, articlePublishedAt: fresh2, confirmed: true, publisherKey: 'bbc.com' },
  ];

  const score = computeClusterPriorityScore(members, 85, anchor);
  check(
    '(f) corroborated fresh burst (2 members, 2 publishers) scores UNCAPPED',
    score === 85,
    `got ${score}; expected 85`,
  );
}

// ---------------------------------------------------------------------------
// (g) SINGLE-PUBLISHER BURST — still capped.
//
// Same shape as (f) but both fresh members share ONE publisher key (an outlet
// re-running its own piece). One distinct publisher ≠ corroboration → the
// window stays capped at cooledBase + LATE_JOINER_LIFT_CAP.
// ---------------------------------------------------------------------------
{
  const anchor = hoursAgo(30); // cooled to floor 20
  const fresh1 = hoursAgo(0.5);
  const fresh2 = hoursAgo(0.4);

  const members: MemberScoreInput[] = [
    { originalPriority: 85, scrapedAt: anchor, articlePublishedAt: anchor, confirmed: true, publisherKey: 'apnews.com' },
    { originalPriority: 85, scrapedAt: fresh1, articlePublishedAt: fresh1, confirmed: true, publisherKey: 'reuters.com' },
    { originalPriority: 85, scrapedAt: fresh2, articlePublishedAt: fresh2, confirmed: true, publisherKey: 'reuters.com' },
  ];

  const score = computeClusterPriorityScore(members, 85, anchor);
  // Tiered critical band: 30h anchor → 27h decay → max(20, 85-108) = 20 cooled base (floor).
  const expected = 20 + LATE_JOINER_LIFT_CAP; // cooledBase(20) + 10
  check(
    '(g) single-publisher fresh burst stays capped at cooledBase + cap',
    score === expected,
    `got ${score}; expected ${expected}`,
  );
}

// ---------------------------------------------------------------------------
// (h) MISSING PUBLISHER KEYS — degrade to DISTINCT (documented contract).
//
// Two fresh members with no publisherKey at all: absence of metadata must
// degrade toward the legacy >=2-members rule (each unknown counts as its own
// publisher), NOT silently never-corroborate.
// ---------------------------------------------------------------------------
{
  const anchor = hoursAgo(30);
  const fresh1 = hoursAgo(0.5);
  const fresh2 = hoursAgo(0.4);

  const members: MemberScoreInput[] = [
    { originalPriority: 85, scrapedAt: anchor, articlePublishedAt: anchor, confirmed: true },
    { originalPriority: 85, scrapedAt: fresh1, articlePublishedAt: fresh1, confirmed: true },
    { originalPriority: 85, scrapedAt: fresh2, articlePublishedAt: fresh2, confirmed: true },
  ];

  const score = computeClusterPriorityScore(members, 85, anchor);
  check(
    '(h) missing publisher keys count as distinct — burst corroborates',
    score === 85,
    `got ${score}; expected 85`,
  );
}

// ---------------------------------------------------------------------------
// (i) ANCHOR-BASED WINDOWS — a syndication drip cannot stretch one window.
//
// Anchor at 20h; drip members at 10h (inside the anchor window) and 6h
// (> 12h would be needed... the 6h member is 14h AFTER the anchor → NEW
// window, even though it is only 4h after the previous member). The drip
// member is alone in its window (single publisher) → capped.
// ---------------------------------------------------------------------------
{
  const anchor = hoursAgo(20);      // window 1 anchor
  const drip1 = hoursAgo(10);       // 10h after anchor → inside window 1 (12h)
  const drip2 = hoursAgo(6);        // 14h after anchor → NEW window (anchor-based)

  const members: MemberScoreInput[] = [
    { originalPriority: 85, scrapedAt: anchor, articlePublishedAt: anchor, confirmed: true, publisherKey: 'apnews.com' },
    // drip1 kept LOW-band (P60, unchanged flat -6/hr curve) so the cooled base
    // stays well below drip2's fresh score and the cap has teeth under the
    // Task #1129 tiered curve.
    { originalPriority: 60, scrapedAt: drip1, articlePublishedAt: drip1, confirmed: true, publisherKey: 'reuters.com' },
    { originalPriority: 85, scrapedAt: drip2, articlePublishedAt: drip2, confirmed: true, publisherKey: 'bbc.com' },
  ];

  const score = computeClusterPriorityScore(members, 85, anchor);
  // Core window (tiered): anchor P85 @20h → max(20, 85-17*4) = 20 (floor); drip1 P60 @10h
  // (low band, flat) → 60 - 8*6 → floor 20. Cooled base 20.
  // drip2 window: alone → capped at 20 + 10 = 30 (its own score is 85 —
  // inside the critical-band grace — which must NOT show through).
  const expected = 20 + LATE_JOINER_LIFT_CAP;
  check(
    '(i) anchor-based window: drip member stays capped (no chained-gap core)',
    score === expected,
    `got ${score}; expected ${expected}`,
  );
}

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? '[late-joiner-score] ALL PASS'
    : `[late-joiner-score] ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
