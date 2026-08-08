/**
 * Suspected MISSED-corroboration diagnostic regression (Task #626 / #747).
 *
 * The #604 test proves the corroboration path is CORRECT for byte-identical
 * twins deterministically, and the genuinely-FUZZY near-dupe case can only
 * SIMULATE the (non-deterministic) LLM grouping decision — so a real-world
 * regression where the live clustering LLM STOPS grouping obvious near-dupes
 * would silently show two near-dupe standalone cards again with NO automated
 * catch. This test pins the READ-ONLY diagnostic that flags exactly that: a
 * group of STANDALONE Curated Top Stories whose titles are highly similar
 * (same-event window, >= 2 distinct publishers) that did NOT merge.
 *
 * Task #747 adds body-aware matching (significantCandidateTokens /
 * findBodyAwareMissedMerges). The new tests confirm:
 *   G — a thin-headline item (few distinctive title tokens) is correctly
 *       flagged as a missed merge ONLY via body-aware matching, not title-only.
 *   H — same-company / different-event (Anthropic negative): body-aware
 *       matching does NOT false-alarm on two unrelated Anthropic stories.
 *   I — same-subject / different-event across news cycles (time-window gate
 *       blocks body-aware merge, same as the title-only version).
 *
 * Pure + deterministic — no live AI, DB, or network. Exercises the real
 * exported functions, which are the same code the clustering pass calls.
 *
 * Run directly with tsx (no test framework configured):
 *   npx tsx scripts/curated-missed-merge-diagnostic.test.ts
 * Exits non-zero on any failure.
 */
import {
  findSuspectedMissedMerges,
  findBodyAwareMissedMerges,
  titlesHighlySimilar,
  significantTitleTokens,
  significantCandidateTokens,
  type LaneNode,
} from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[missed-merge] OK   ${name}`);
  } else {
    console.error(`[missed-merge] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const NOW = new Date('2026-06-30T12:00:00Z');

function node(
  partial: Partial<LaneNode> & { key: string; title: string; cls?: LaneNode['cls'] },
): LaneNode {
  const cls: LaneNode['cls'] = partial.cls ?? 'corroborating';
  return {
    itemType: 'curated',
    itemId: partial.key.split(':')[1] ?? partial.key,
    source: partial.source ?? 'Test Wire',
    url: partial.url ?? `https://example.com/${partial.key}`,
    category: 'general',
    label: null,
    cls,
    role:
      cls === 'corroborating'
        ? 'contributing'
        : cls === 'anchor-only'
          ? 'anchor-only'
          : 'attach-only',
    blocked: false,
    priority: 70,
    ogImageUrl: null,
    publishedAt: NOW,
    sourceIdentifier: null,
    factuality: null,
    ownership: [],
    summary: null,
    bullets: null,
    ...partial,
  } as LaneNode;
}

// ===========================================================================
// A — two INDEPENDENT trusted outlets, fuzzy near-dupe titles, same window.
// The exact silent-regression symptom: they SHOULD have merged into one story
// but ended up as two standalone cards. Must be flagged.
// ===========================================================================
{
  const reuters = node({
    key: 'curated:reuters-iran',
    title: 'Iran and US nuclear talks collapse after final round in Geneva',
    source: 'Reuters',
    url: 'https://www.reuters.com/world/iran-us-nuclear-talks-collapse',
  });
  const ap = node({
    key: 'curated:ap-iran',
    title: 'US and Iran nuclear talks collapse in final Geneva round',
    source: 'Associated Press',
    url: 'https://apnews.com/article/iran-us-nuclear-talks-collapse',
  });
  const flagged = findSuspectedMissedMerges([reuters, ap]);
  check(
    'A1 fuzzy near-dupe from 2 distinct publishers IS flagged as missed merge',
    flagged.length === 1 && new Set(flagged[0].publishers).size === 2,
    JSON.stringify(flagged),
  );
}

// ===========================================================================
// B — same near-dupe wording but SAME outlet (two URLs). Not a missed MULTI-
// source merge (that's same-outlet dedup's job), so it must NOT be flagged.
// ===========================================================================
{
  const a = node({
    key: 'curated:reuters-iran-a',
    title: 'Iran and US nuclear talks collapse after final round in Geneva',
    source: 'Reuters',
    url: 'https://www.reuters.com/world/iran-us-nuclear-talks-collapse?a=1',
  });
  const b = node({
    key: 'curated:reuters-iran-b',
    title: 'US and Iran nuclear talks collapse in final Geneva round',
    source: 'Reuters',
    url: 'https://www.reuters.com/world/iran-us-nuclear-talks-collapse?a=2',
  });
  const flagged = findSuspectedMissedMerges([a, b]);
  check(
    'B1 same-outlet near-dupe is NOT flagged (needs >= 2 distinct publishers)',
    flagged.length === 0,
    JSON.stringify(flagged),
  );
}

// ===========================================================================
// C — two UNRELATED stories that merely share a couple of generic/proper-noun
// words. High precision must NOT false-alarm on these.
// ===========================================================================
{
  const a = node({
    key: 'curated:iran-strike',
    title: 'Israel strikes Iran nuclear facility near Natanz overnight',
    source: 'Reuters',
    url: 'https://www.reuters.com/world/israel-strikes-iran-natanz',
  });
  const b = node({
    key: 'curated:iran-economy',
    title: 'Iran currency plunges to record low as sanctions bite',
    source: 'Associated Press',
    url: 'https://apnews.com/article/iran-currency-record-low',
  });
  const flagged = findSuspectedMissedMerges([a, b]);
  check(
    'C1 unrelated stories sharing only a proper noun are NOT flagged',
    flagged.length === 0,
    JSON.stringify(flagged),
  );
  check(
    'C2 titlesHighlySimilar rejects the weak-overlap pair',
    titlesHighlySimilar(significantTitleTokens(a.title), significantTitleTokens(b.title)) === false,
  );
}

// ===========================================================================
// D — near-dupe from 2 distinct publishers but in DIFFERENT news cycles (well
// outside the same-event window). A re-used/evergreen headline across cycles is
// a distinct event and must NOT be flagged.
// ===========================================================================
{
  const a = node({
    key: 'curated:reuters-cycle1',
    title: 'US and Iran nuclear talks collapse in final Geneva round',
    source: 'Reuters',
    url: 'https://www.reuters.com/world/iran-talks-1',
    publishedAt: new Date('2026-06-25T12:00:00Z'),
  });
  const b = node({
    key: 'curated:ap-cycle2',
    title: 'US and Iran nuclear talks collapse in final Geneva round',
    source: 'Associated Press',
    url: 'https://apnews.com/article/iran-talks-2',
    publishedAt: new Date('2026-06-30T12:00:00Z'),
  });
  const flagged = findSuspectedMissedMerges([a, b]);
  check(
    'D1 identical wording across DIFFERENT news cycles is NOT flagged',
    flagged.length === 0,
    JSON.stringify(flagged),
  );
}

// ===========================================================================
// E — a near-dupe pair where the 2nd item is ATTACH-only (a social/low-weight
// copy). Attach items carry no formation weight, so a standalone attach next to
// a standalone corroborating item is NOT a missed multi-source merge.
// ===========================================================================
{
  const corr = node({
    key: 'curated:reuters-corr',
    title: 'US and Iran nuclear talks collapse in final Geneva round',
    source: 'Reuters',
    url: 'https://www.reuters.com/world/iran-talks-corr',
  });
  const attach = node({
    key: 'curated:blog-attach',
    title: 'US and Iran nuclear talks collapse after final Geneva round',
    cls: 'attach-only',
    source: 'Some Blog',
    url: 'https://blog.example.com/iran-talks',
  });
  const flagged = findSuspectedMissedMerges([corr, attach]);
  check(
    'E1 corroborating + attach-only near-dupe is NOT flagged (attach has no weight)',
    flagged.length === 0,
    JSON.stringify(flagged),
  );
}

// ===========================================================================
// F — THREE independent outlets covering one event as three standalone cards.
// Flagged once as a single group spanning all three publishers.
// ===========================================================================
{
  const r = node({
    key: 'curated:r3',
    title: 'US and Iran nuclear talks collapse in final Geneva round',
    source: 'Reuters',
    url: 'https://www.reuters.com/world/iran-talks-r3',
  });
  const a = node({
    key: 'curated:a3',
    title: 'Iran and US nuclear talks collapse after final round in Geneva',
    source: 'Associated Press',
    url: 'https://apnews.com/article/iran-talks-a3',
  });
  const b = node({
    key: 'curated:b3',
    title: 'Nuclear talks between US and Iran collapse in final Geneva round',
    source: 'BBC',
    url: 'https://www.bbc.com/news/iran-talks-b3',
  });
  const flagged = findSuspectedMissedMerges([r, a, b]);
  check(
    'F1 three-outlet standalone near-dupe flagged as ONE group of 3 publishers',
    flagged.length === 1 && new Set(flagged[0].publishers).size === 3 && flagged[0].keys.length === 3,
    JSON.stringify(flagged),
  );
}

// ===========================================================================
// G — BODY-AWARE matching: the Iran revenge event where Axios ran a thin quote
// headline ("Revenge will most certainly be carried out") while DW ran a full
// headline ("Iran vows revenge for Khamenei's killing"). Title-only tokens from
// the Axios headline are too few/unshared to trip titlesHighlySimilar, but the
// body names Khamenei and revenge in context — body-aware matching SHOULD flag
// this pair. Confirms the body-aware path catches what title-only misses, and
// that the title-only detector correctly stays silent on a thin headline.
// ===========================================================================
{
  const dw = node({
    key: 'curated:dw-iran',
    title: 'Iran vows revenge for killing of Supreme Leader Khamenei',
    source: 'Deutsche Welle',
    url: 'https://www.dw.com/en/iran-vows-revenge-khamenei/a-1234',
    summary: 'Iran has declared it will avenge the killing of Ayatollah Khamenei, with senior officials warning of a severe military response.',
  });
  const axios = node({
    key: 'curated:axios-iran',
    // Thin headline — only 3 significant title tokens: {revenge, certainly, carried}
    title: 'Revenge will most certainly be carried out',
    source: 'Axios',
    url: 'https://www.axios.com/2026/07/iran-khamenei-revenge',
    // Body supplies the missing context: Khamenei + killing + Iran + vow
    summary: 'Iran\'s new supreme leader Mojtaba Khamenei vowed that revenge for his father\'s killing will most certainly be carried out against those responsible.',
  });

  // G1: title-only must NOT flag this — the thin Axios title has too few tokens.
  const titleOnly = findSuspectedMissedMerges([dw, axios]);
  check(
    'G1 thin-headline pair NOT flagged by title-only detector (too few tokens)',
    titleOnly.length === 0,
    JSON.stringify(titleOnly),
  );

  // G2: body-aware MUST flag this — the combined tokens share revenge + killing +
  // khameneileader from both bodies and are within the same event window.
  const bodyAware = findBodyAwareMissedMerges([dw, axios]);
  check(
    'G2 thin-headline pair IS flagged by body-aware detector',
    bodyAware.length === 1 && new Set(bodyAware[0].publishers).size === 2,
    JSON.stringify(bodyAware),
  );

  // G3: significantCandidateTokens on the Axios node MUST include khameneileader
  // (via canonicalization of "supreme leader" + nearby "Khamenei"), confirming
  // the body tokens widen the thin title set.
  const axiosCombined = significantCandidateTokens(axios);
  const axisTitleOnly = significantTitleTokens(axios.title);
  check(
    'G3 body widens Axios token set beyond title-only',
    axiosCombined.size > axisTitleOnly.size,
    `title=${axisTitleOnly.size} combined=${axiosCombined.size}`,
  );
}

// ===========================================================================
// H — NEGATIVE: same company / different event (precision guard). Two Anthropic
// stories on the same day that share "anthropic" (and plausibly other tokens
// in the body) but describe genuinely UNRELATED events. Neither title-only nor
// body-aware should flag these as a missed merge.
// ===========================================================================
{
  const funding = node({
    key: 'curated:anthropic-funding',
    title: 'Anthropic closes $3 billion funding round led by Google',
    source: 'Reuters',
    url: 'https://www.reuters.com/technology/anthropic-funding-google-2026',
    summary: 'AI safety company Anthropic has closed a major $3 billion investment round with Google as the lead investor, valuing the firm at $45 billion.',
  });
  const safety = node({
    key: 'curated:anthropic-safety',
    title: 'Anthropic publishes new AI safety policy amid EU regulatory pressure',
    source: 'Associated Press',
    url: 'https://apnews.com/article/anthropic-safety-eu-regulations-2026',
    summary: 'Anthropic has released a new AI safety framework and responsible-use policy following pressure from European Union regulators and civil society groups.',
  });

  const titleOnly = findSuspectedMissedMerges([funding, safety]);
  check(
    'H1 same-company / different-event NOT flagged by title-only detector',
    titleOnly.length === 0,
    JSON.stringify(titleOnly),
  );
  const bodyAware = findBodyAwareMissedMerges([funding, safety]);
  check(
    'H2 same-company / different-event NOT flagged by body-aware detector',
    bodyAware.length === 0,
    JSON.stringify(bodyAware),
  );
}

// ===========================================================================
// I — NEGATIVE: same body content, DIFFERENT news cycles (time-window gate).
// Demonstrates that even when title+body tokens would match, the same-event
// time window correctly blocks a body-aware merge across separate cycles.
// ===========================================================================
{
  const early = node({
    key: 'curated:iran-nuke-early',
    title: 'Iran and US nuclear talks collapse after final round in Geneva',
    source: 'Reuters',
    url: 'https://www.reuters.com/world/iran-us-talks-early',
    summary: 'Negotiations between the United States and Iran over Tehran\'s nuclear program have ended without agreement after the final round of talks in Geneva.',
    publishedAt: new Date('2026-06-25T12:00:00Z'),
  });
  const later = node({
    key: 'curated:iran-nuke-later',
    title: 'US and Iran nuclear talks end without deal in Geneva',
    source: 'Associated Press',
    url: 'https://apnews.com/article/iran-us-talks-later',
    summary: 'A new round of nuclear talks between the United States and Iran concluded in Geneva without reaching any agreement, diplomats said.',
    publishedAt: new Date('2026-06-30T12:00:00Z'), // 5 days later — different cycle
  });

  const bodyAware = findBodyAwareMissedMerges([early, later]);
  check(
    'I1 same-event body content across DIFFERENT cycles NOT flagged (time-window gate)',
    bodyAware.length === 0,
    JSON.stringify(bodyAware),
  );
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n[missed-merge] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[missed-merge] all checks passed');
process.exit(0);
