// =============================================================================
// Gate: dominant-angle fallback headline picker (Task #1141)
// -----------------------------------------------------------------------------
// Pure, deterministic unit test of server/curatedDominantAngle.ts — the
// no-AI token-overlap heuristic that, when a formed multi-source story has NO
// synthesized headline yet, picks the corroborating member whose title best
// overlaps the other corroborating members' titles (the shared underlying
// development) instead of the rep/newest member's own reaction angle.
//
// No DB / no network. Exit 0 = all pass, 1 = a failure (per scripts/run-gates.ts).
// =============================================================================
import { pickDominantAngleMember, titleTokens } from '../server/curatedDominantAngle';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- The motivating case: one senator-reaction angle among event reports -----
const saudi = [
  { key: 'curated:react', behaviorClass: 'corroborating', publishedAt: '2026-07-26T14:00:00Z',
    title: "Republican Senator Says He's Not Comfortable With Trump Saudi Deal" },
  { key: 'curated:ap', behaviorClass: 'corroborating', publishedAt: '2026-07-26T10:00:00Z',
    title: 'US and Saudi Arabia Sign Civil Nuclear Cooperation Deal' },
  { key: 'curated:reuters', behaviorClass: 'corroborating', publishedAt: '2026-07-26T10:30:00Z',
    title: 'Saudi Arabia, US Reach Landmark Nuclear Cooperation Agreement' },
  { key: 'curated:bbc', behaviorClass: 'corroborating', publishedAt: '2026-07-26T11:00:00Z',
    title: 'US Signs Nuclear Deal With Saudi Arabia' },
];
{
  const pick = pickDominantAngleMember(saudi);
  check('picks an event-report member over the lone reaction angle',
    !!pick && pick.key !== 'curated:react', `picked ${pick?.key}`);
}

// --- Determinism -------------------------------------------------------------
{
  const a = pickDominantAngleMember(saudi);
  const b = pickDominantAngleMember([...saudi].reverse());
  check('deterministic under input reordering', a?.key === b?.key, `${a?.key} vs ${b?.key}`);
}

// --- Fail-open: no meaningful overlap ----------------------------------------
{
  const pick = pickDominantAngleMember([
    { key: 'a', behaviorClass: 'corroborating', title: 'Pentagon Budget Vote Delayed Again Tonight' },
    { key: 'b', behaviorClass: 'corroborating', title: 'Typhoon Slams Philippine Coastal Villages' },
    { key: 'c', behaviorClass: 'corroborating', title: 'Argentina Wins Copa America Final Match' },
  ]);
  check('fail-open (null) when titles share no vocabulary', pick === null, `picked ${pick?.key}`);
}

// --- Fail-open: fewer than 2 scorable corroborating members ------------------
{
  check('null with a single corroborating member',
    pickDominantAngleMember([
      { key: 'a', behaviorClass: 'corroborating', title: 'US Signs Nuclear Deal With Saudi Arabia' },
      { key: 'b', behaviorClass: 'attach', title: 'US Saudi Nuclear Deal Signed In Riyadh Today' },
    ]) === null);
  check('null on empty input', pickDominantAngleMember([]) === null);
}

// --- Only corroborating members can win --------------------------------------
{
  const pick = pickDominantAngleMember([
    { key: 'attach1', behaviorClass: 'attach', title: 'US Saudi Nuclear Cooperation Deal Signed' },
    { key: 'c1', behaviorClass: 'corroborating', title: 'US Signs Nuclear Cooperation Deal With Saudi Arabia' },
    { key: 'c2', behaviorClass: 'corroborating', title: 'Saudi Arabia and US Sign Nuclear Cooperation Agreement' },
    { key: 'contrast1', behaviorClass: 'anchor-only', title: 'Saudi US Nuclear Deal Cooperation Agreement Signed' },
  ]);
  check('winner is always a corroborating member',
    !!pick && (pick.key === 'c1' || pick.key === 'c2'), `picked ${pick?.key}`);
}

// --- Tie-break: older publishedAt wins (event precedes reaction) -------------
{
  const pick = pickDominantAngleMember([
    { key: 'newer', behaviorClass: 'corroborating', publishedAt: '2026-07-26T12:00:00Z',
      title: 'US Signs Nuclear Cooperation Deal With Saudi Arabia' },
    { key: 'older', behaviorClass: 'corroborating', publishedAt: '2026-07-26T09:00:00Z',
      title: 'Saudi Arabia With US Signs Nuclear Cooperation Deal' },
  ]);
  check('symmetric two-member overlap tie-breaks to the OLDER member',
    pick?.key === 'older', `picked ${pick?.key}`);
}

// --- Token hygiene -----------------------------------------------------------
{
  const t = titleTokens('The US Says It Will Not Be At War');
  check('stopwords and short tokens stripped', !t.has('the') && !t.has('us') && !t.has('says') && t.has('war'));
  check('null/empty titles yield empty token sets', titleTokens(null).size === 0 && titleTokens('').size === 0);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll dominant-angle fallback checks passed');
