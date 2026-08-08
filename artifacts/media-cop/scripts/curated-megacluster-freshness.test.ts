/**
 * Regression gate: megacluster synthesis freshness (Task #954).
 *
 * Exercises two pure, deterministic helpers — `buildSynthesisPrompt` and
 * `shouldRefreshStaleSynopsis` — with a synthetic 40-member war/kinetic
 * megacluster whose corroborating block spans >20 hours:
 *
 *   OLD articles (>20h ago): "Trump weighing options on Iran nuclear deal"
 *   RECENT articles (1-4h ago): "US expands strikes / Iran threatens Hormuz"
 *
 * WHAT THIS PROTECTS
 *   Before Task #954, ALL corroborating members were passed to the synthesis
 *   prompt equally. Old "Trump weighing options" articles outnumbered newer
 *   "active strikes / Hormuz threat" articles, so the model's dominant-
 *   development anchor picked the historical majority, not the current
 *   situation. The fix: split the prompt into RECENT CORROBORATING and
 *   BACKGROUND CONTEXT blocks and instruct the model to anchor on the RECENT
 *   block. The kinetic cooldown fix ensures stale-synopsis re-synthesis fires
 *   within 1h (not 2h) for kinetic-dominant clusters.
 *
 * Scenarios:
 *   (a) RECENT block leads — the prompt's RECENT CORROBORATING section
 *       contains only articles published ≤12h ago (the newer "strikes/Hormuz"
 *       articles), and BACKGROUND CONTEXT contains the older ones.
 *   (b) Recency split fires — the cluster spans >RECENCY_SPLIT_H so the
 *       prompt contains both section labels.
 *   (c) No split for narrow clusters — a cluster whose members all fall within
 *       12h of each other does NOT get the RECENT/BACKGROUND split.
 *   (d) shouldRefreshStaleSynopsis returns true for kinetic clusters past the
 *       1h cooldown (not the 2h default).
 *   (e) shouldRefreshStaleSynopsis blocks kinetic refresh within the 1h window.
 *   (f) Non-kinetic clusters still use the 2h cooldown.
 *
 * Exit 0 = PASS, exit 1 = FAIL.
 * Usage: npx tsx scripts/curated-megacluster-freshness.test.ts
 */

import {
  buildSynthesisPrompt,
  RECENCY_SPLIT_H,
  type SynthMember,
} from '../server/curatedSynthesis';
import {
  shouldRefreshStaleSynopsis,
  STALE_SYNOPSIS_TUNING,
} from '../server/curatedStaleness';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[megacluster-freshness] OK   ${name}`);
  } else {
    console.error(`[megacluster-freshness] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const now = Date.now();
const H = 3_600_000;
const { STALE_SYNOPSIS_MARGIN_MS, STALE_SYNOPSIS_COOLDOWN_MS, STALE_SYNOPSIS_COOLDOWN_KINETIC_MS } =
  STALE_SYNOPSIS_TUNING;

// ---------------------------------------------------------------------------
// Build a 40-member synthetic cluster:
//   - 30 OLD corroborating articles (>20h ago): "Trump weighing options"
//   - 10 RECENT corroborating articles (1-4h ago): "US expands strikes" / "Iran threatens Hormuz"
//   -  3 contrast/attach members
// ---------------------------------------------------------------------------
const OLD_ARTICLES_COUNT = 30;
const RECENT_ARTICLES_COUNT = 10;

function makeOldMember(i: number): SynthMember {
  const ageH = 20 + i; // 20h-49h ago
  return {
    key: `main:old${i}`,
    url: `https://example.com/old/${i}`,
    source: `OldSource${i}`,
    sourceIdentifier: 'news-us-domestic',
    factuality: 'high',
    ownership: [`ownerOld${i % 8}`], // 8 distinct owners across 30 items
    title: `Trump weighing options on Iran nuclear deal — day ${i}`,
    summary: 'US considering various diplomatic and military options regarding Iran.',
    cls: 'corroborating',
    label: null,
    publishedAt: new Date(now - ageH * H),
  };
}

function makeRecentMember(i: number): SynthMember {
  const ageH = 1 + i * 0.3; // 1h - ~4h ago
  const isHormuz = i >= 5;
  return {
    key: `main:recent${i}`,
    url: `https://example.com/recent/${i}`,
    source: `RecentSource${i}`,
    sourceIdentifier: i % 2 === 0 ? 'news-us-domestic' : 'news-international',
    factuality: 'high',
    ownership: [`ownerRecent${i}`], // all distinct owners
    title: isHormuz
      ? `Iran threatens to close Hormuz Strait as US strikes expand`
      : `US military expands airstrikes on Iranian nuclear sites`,
    summary: isHormuz
      ? 'Iranian officials threaten Hormuz closure as US operations widen.'
      : 'US forces conducted additional strikes on Iranian facilities.',
    cls: 'corroborating',
    label: null,
    publishedAt: new Date(now - Math.round(ageH * H)),
  };
}

const oldMembers = Array.from({ length: OLD_ARTICLES_COUNT }, (_, i) => makeOldMember(i));
const recentMembers = Array.from({ length: RECENT_ARTICLES_COUNT }, (_, i) => makeRecentMember(i));
const contrastMembers: SynthMember[] = [
  {
    key: 'curated:contrast1',
    url: 'https://presstv.ir/s1',
    source: 'PressTV',
    sourceIdentifier: 'state-adversary',
    factuality: 'low',
    ownership: ['IRIB'],
    title: 'Iran repels US aggression, strikes are propaganda',
    cls: 'attach',
    label: 'contrast',
    publishedAt: new Date(now - 2 * H),
  },
];

const allMembers = [...recentMembers, ...oldMembers, ...contrastMembers];

// ---------------------------------------------------------------------------
// (a) RECENT block leads — after buildSynthesisPrompt, the RECENT CORROBORATING
//     section must contain keywords from the newer articles, not just old ones.
// ---------------------------------------------------------------------------
const prompt = buildSynthesisPrompt(allMembers);

// The RECENT block should contain "expands" or "Hormuz" (from recent articles)
const recentSectionStart = prompt.indexOf(`RECENT CORROBORATING (≤${RECENCY_SPLIT_H}h`);
const backgroundSectionStart = prompt.indexOf(`BACKGROUND CONTEXT (>${RECENCY_SPLIT_H}h`);

check(
  '(a1) RECENT CORROBORATING section is present in the prompt',
  recentSectionStart !== -1,
  recentSectionStart === -1 ? 'section label not found in prompt' : '',
);
check(
  '(a2) BACKGROUND CONTEXT section is present in the prompt',
  backgroundSectionStart !== -1,
  backgroundSectionStart === -1 ? 'background section label not found in prompt' : '',
);

if (recentSectionStart !== -1 && backgroundSectionStart !== -1) {
  // The RECENT block is between recentSectionStart and backgroundSectionStart.
  const recentBlock = prompt.slice(recentSectionStart, backgroundSectionStart);
  // The recent block must contain at least one of the recent-article keywords.
  const recentKeywords = ['expands', 'Hormuz', 'expands airstrikes', 'Iranian nuclear'];
  const recentBlockHasRecent = recentKeywords.some((kw) => recentBlock.includes(kw));
  check(
    '(a3) RECENT block contains recent-article content (strikes/Hormuz)',
    recentBlockHasRecent,
    `recent block excerpt: "${recentBlock.slice(0, 200).replace(/\n/g, ' ')}"`,
  );

  // The RECENT block must NOT contain the old "weighing options" framing
  // (those should only appear in BACKGROUND).
  const recentBlockHasOld = recentBlock.includes('weighing options');
  check(
    '(a4) RECENT block does NOT contain old "weighing options" framing',
    !recentBlockHasOld,
    recentBlockHasOld ? 'old framing leaked into RECENT block' : '',
  );

  // The BACKGROUND section should contain the old framing.
  const backgroundBlock = prompt.slice(backgroundSectionStart);
  check(
    '(a5) BACKGROUND block contains old "weighing options" framing',
    backgroundBlock.includes('weighing options'),
    'old framing not found in background block',
  );
}

// ---------------------------------------------------------------------------
// (b) Recency split fires for clusters spanning >RECENCY_SPLIT_H hours.
//     Already covered by (a1)/(a2) — this is the explicit check.
// ---------------------------------------------------------------------------
check(
  '(b) recency split fires when cluster spans >12h',
  recentSectionStart !== -1 && backgroundSectionStart !== -1,
);

// ---------------------------------------------------------------------------
// (c) No split for narrow clusters — members all within 12h of each other.
// ---------------------------------------------------------------------------
const narrowMembers: SynthMember[] = Array.from({ length: 6 }, (_, i) => ({
  key: `main:narrow${i}`,
  url: `https://example.com/narrow/${i}`,
  source: `NarrowSource${i}`,
  sourceIdentifier: 'news-us-domestic',
  factuality: 'high',
  ownership: [`ownerNarrow${i}`],
  title: `Iran nuclear talks update — hour ${i}`,
  cls: 'corroborating' as const,
  label: null,
  publishedAt: new Date(now - i * 2 * H), // 0h - 10h spread, all within 12h
}));
const narrowPrompt = buildSynthesisPrompt(narrowMembers);
check(
  '(c) narrow cluster (≤12h span) does NOT get RECENT/BACKGROUND split',
  !narrowPrompt.includes(`RECENT CORROBORATING (≤${RECENCY_SPLIT_H}h`) &&
    !narrowPrompt.includes(`BACKGROUND CONTEXT (>${RECENCY_SPLIT_H}h`),
  'unexpected RECENT/BACKGROUND split found in narrow-cluster prompt',
);
// Narrow cluster still gets the standard CORROBORATING SOURCES header.
check(
  '(c2) narrow cluster retains CORROBORATING SOURCES header',
  narrowPrompt.includes('CORROBORATING SOURCES'),
);

// ---------------------------------------------------------------------------
// (d) shouldRefreshStaleSynopsis returns TRUE for kinetic clusters past 1h cooldown.
// ---------------------------------------------------------------------------
const synthedThrough = now - 3 * H;
const freshContrib = synthedThrough + STALE_SYNOPSIS_MARGIN_MS + 5 * 60_000;
check(
  '(d) kinetic cluster past 1h cooldown → refresh fires',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: freshContrib,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_KINETIC_MS + 5 * 60_000, // past 1h
    isKineticDominant: true,
  }) === true,
);

// ---------------------------------------------------------------------------
// (e) shouldRefreshStaleSynopsis blocks kinetic refresh WITHIN the 1h window.
// ---------------------------------------------------------------------------
check(
  '(e) kinetic cluster within 1h cooldown → NO refresh',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: freshContrib,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_KINETIC_MS - 60_000, // within 1h
    isKineticDominant: true,
  }) === false,
);

// ---------------------------------------------------------------------------
// (f) Non-kinetic clusters still use the 2h cooldown.
//     Same story as (d) but isKineticDominant=false — should block when between
//     1h and 2h since last synthesis (past kinetic window but inside normal window).
// ---------------------------------------------------------------------------
check(
  '(f) non-kinetic cluster between 1h-2h since synthesis → NO refresh (2h cooldown)',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: freshContrib,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_KINETIC_MS + 5 * 60_000, // past 1h, under 2h
    isKineticDominant: false,
  }) === false,
  `msSinceLastSynthesis=${STALE_SYNOPSIS_COOLDOWN_KINETIC_MS + 5 * 60_000}, COOLDOWN_MS=${STALE_SYNOPSIS_COOLDOWN_MS}`,
);
check(
  '(f2) non-kinetic cluster past 2h cooldown → refresh fires',
  shouldRefreshStaleSynopsis({
    ageH: 30,
    freshestContribMs: freshContrib,
    synthesizedThroughMs: synthedThrough,
    msSinceLastSynthesis: STALE_SYNOPSIS_COOLDOWN_MS + 5 * 60_000, // past 2h
    isKineticDominant: false,
  }) === true,
);

// ---------------------------------------------------------------------------
// (g) RECENCY_SPLIT_H export is 12 (contract relied on by (a)/(b)/(c) above).
// ---------------------------------------------------------------------------
check(
  '(g) RECENCY_SPLIT_H is 12 hours',
  RECENCY_SPLIT_H === 12,
  `got ${RECENCY_SPLIT_H}`,
);

// ---------------------------------------------------------------------------
// (h) Kinetic cooldown is shorter than the default cooldown.
// ---------------------------------------------------------------------------
check(
  '(h) kinetic cooldown < default cooldown',
  STALE_SYNOPSIS_COOLDOWN_KINETIC_MS < STALE_SYNOPSIS_COOLDOWN_MS,
  `kinetic=${STALE_SYNOPSIS_COOLDOWN_KINETIC_MS}, default=${STALE_SYNOPSIS_COOLDOWN_MS}`,
);

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n[megacluster-freshness] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log(`\n[megacluster-freshness] all checks passed`);
process.exit(0);
