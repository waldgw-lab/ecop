/**
 * Curated false-merge corroboration backstop regression (Task #362).
 *
 * Two genuinely unrelated diplomatic meetings (e.g. a Xi-Kim China/NK meeting vs.
 * Turkey/US/Egypt/Saudi Cairo talks) were being merged into one Curated "Top
 * Story". The structural tell of such a false merge is that the merged card's
 * Corroborated Facts each trace to only ONE source — nothing is genuinely shared
 * across >= 2 independently-owned contributors.
 *
 * `isLikelyFalseMerge` is the pure, deterministic core of that backstop: given
 * each corroborated fact's supporting source keys plus per-key ownership/source,
 * it returns true ONLY for the clear single-sourced-everywhere tell. The
 * clustering pass DISSOLVES such a cluster (members released to stand-alone)
 * instead of presenting a bogus single corroborated Top Story.
 *
 * This pins the contract WITHOUT the LLM (no network / DB / live AI), so it can
 * run as a regression gate. It covers the task's three scenarios:
 *   (a) two different-party/different-agenda diplomatic items single-sourced
 *       per fact  -> flagged as a false merge (would be dissolved, NOT merged);
 *   (b) a same-parties/same-agreement multi-day negotiation whose facts ARE
 *       corroborated across >= 2 independent owners -> NOT flagged (still grouped);
 *   (c) a merged story whose facts are ALL single-sourced -> flagged.
 *
 * Exits non-zero on any violation.
 *
 * Usage:  tsx scripts/curated-corroboration.test.ts
 */

import { isLikelyFalseMerge, type FactSupport } from '../server/curatedSynthesis';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[corroboration] OK   ${name}`);
  } else {
    console.error(`[corroboration] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// (a) DIFFERENT-PARTY / DIFFERENT-AGENDA DIPLOMATIC FALSE MERGE.
// The Xi-Kim opinion piece (The Hill) and the Cairo talks (Jerusalem Post) were
// merged. Each "corroborated fact" really comes from just ONE outlet, so no fact
// is shared across >= 2 owners -> the structural tell of a false merge.
// ---------------------------------------------------------------------------
{
  const ownerByKey = new Map<string, string[]>([
    ['main:hill', ['Nexstar Media Group']],
    ['main:jpost', ['Jpost Inc']],
  ]);
  const sourceByKey = new Map<string, string>([
    ['main:hill', 'The Hill'],
    ['main:jpost', 'Jerusalem Post'],
  ]);
  const facts: FactSupport[] = [
    { fact: 'Xi and Kim discussed deepening nuclear cooperation', sourceKeys: ['main:hill'] },
    { fact: 'Officials met in Cairo to discuss Iran, Libya and Gaza', sourceKeys: ['main:jpost'] },
  ];
  check(
    '(a) two different-party diplomatic items, each fact single-sourced -> false merge',
    isLikelyFalseMerge(facts, ownerByKey, sourceByKey) === true,
    'expected true (dissolve), got false',
  );
}

// ---------------------------------------------------------------------------
// (b) LEGITIMATE SAME-PARTIES / SAME-AGREEMENT MULTI-DAY NEGOTIATION.
// One ongoing ceasefire negotiation reported across days by independently-owned
// outlets. At least one fact is genuinely corroborated across >= 2 distinct
// owners -> NOT a false merge; it must still group.
// ---------------------------------------------------------------------------
{
  const ownerByKey = new Map<string, string[]>([
    ['main:reuters', ['Thomson Reuters']],
    ['main:ap', ['Associated Press']],
    ['main:bbc', ['BBC']],
  ]);
  const sourceByKey = new Map<string, string>([
    ['main:reuters', 'Reuters'],
    ['main:ap', 'AP'],
    ['main:bbc', 'BBC'],
  ]);
  const facts: FactSupport[] = [
    {
      fact: 'The two sides agreed a phased ceasefire framework',
      sourceKeys: ['main:reuters', 'main:ap', 'main:bbc'],
    },
    { fact: 'Signing is expected within 48 hours', sourceKeys: ['main:reuters'] },
  ];
  check(
    '(b) same-parties multi-day negotiation with a fact across >= 2 owners -> NOT a false merge',
    isLikelyFalseMerge(facts, ownerByKey, sourceByKey) === false,
    'expected false (keep grouped), got true',
  );
}

// ---------------------------------------------------------------------------
// (c) ALL FACTS SINGLE-SOURCED across the whole story -> false merge, even with
// three would-be contributors. No fact reaches a second owner.
// ---------------------------------------------------------------------------
{
  const ownerByKey = new Map<string, string[]>([
    ['main:a', ['Owner A']],
    ['main:b', ['Owner B']],
    ['main:c', ['Owner C']],
  ]);
  const sourceByKey = new Map<string, string>([
    ['main:a', 'Outlet A'],
    ['main:b', 'Outlet B'],
    ['main:c', 'Outlet C'],
  ]);
  const facts: FactSupport[] = [
    { fact: 'Fact one', sourceKeys: ['main:a'] },
    { fact: 'Fact two', sourceKeys: ['main:b'] },
    { fact: 'Fact three', sourceKeys: ['main:c'] },
  ];
  check(
    '(c) every fact single-sourced -> false merge',
    isLikelyFalseMerge(facts, ownerByKey, sourceByKey) === true,
    'expected true (dissolve), got false',
  );
}

// ---------------------------------------------------------------------------
// (d) FAIL-OPEN — NO FACTS. A freshly-formed story whose members aren't enriched
// yet has nothing to judge; it must NOT be dissolved on absence of evidence.
// ---------------------------------------------------------------------------
{
  const r = isLikelyFalseMerge([], new Map(), new Map());
  check('(d) no facts -> not a false merge (fail-open)', r === false, `got ${r}`);
}

// ---------------------------------------------------------------------------
// (e) FAIL-OPEN — UNATTRIBUTED FACT. If any fact carries no supporting source,
// the merge is unprovable, so do NOT dissolve (never guess corroboration away).
// ---------------------------------------------------------------------------
{
  const ownerByKey = new Map<string, string[]>([['main:a', ['Owner A']]]);
  const sourceByKey = new Map<string, string>([['main:a', 'Outlet A']]);
  const facts: FactSupport[] = [
    { fact: 'Attributed', sourceKeys: ['main:a'] },
    { fact: 'Unattributed', sourceKeys: [] },
  ];
  check(
    '(e) a fact with no attribution -> fail-open, not a false merge',
    isLikelyFalseMerge(facts, ownerByKey, sourceByKey) === false,
    'expected false, got true',
  );
}

// ---------------------------------------------------------------------------
// (f) SAME-OWNER REPETITION IS NOT CORROBORATION. Two keys that share an owner
// (e.g. two outlets owned by the same group, or the same article twice) do NOT
// manufacture corroboration -> still a false merge when every fact is same-owner.
// ---------------------------------------------------------------------------
{
  const ownerByKey = new Map<string, string[]>([
    ['main:x1', ['Same Group']],
    ['main:x2', ['Same Group']],
  ]);
  const sourceByKey = new Map<string, string>([
    ['main:x1', 'Sister Site One'],
    ['main:x2', 'Sister Site Two'],
  ]);
  const facts: FactSupport[] = [
    { fact: 'Shared by two co-owned sites', sourceKeys: ['main:x1', 'main:x2'] },
  ];
  check(
    '(f) two co-owned sources for one fact -> still a false merge (one distinct owner)',
    isLikelyFalseMerge(facts, ownerByKey, sourceByKey) === true,
    'expected true, got false',
  );
}

// ---------------------------------------------------------------------------
// (g) UNKNOWN OWNERSHIP FALLS BACK TO SOURCE NAME. Two distinctly-named outlets
// with no ownership data still count as independent contributors -> NOT a false
// merge (the source name is the owner fallback).
// ---------------------------------------------------------------------------
{
  const ownerByKey = new Map<string, string[]>(); // no ownership data
  const sourceByKey = new Map<string, string>([
    ['main:p', 'Outlet P'],
    ['main:q', 'Outlet Q'],
  ]);
  const facts: FactSupport[] = [
    { fact: 'Reported by two distinct outlets', sourceKeys: ['main:p', 'main:q'] },
  ];
  check(
    '(g) two distinct outlets, ownership unknown -> independent, not a false merge',
    isLikelyFalseMerge(facts, ownerByKey, sourceByKey) === false,
    'expected false, got true',
  );
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '[corroboration] ALL PASS' : `[corroboration] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
