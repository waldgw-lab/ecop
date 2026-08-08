/**
 * Curated anchor-split disjoint-actor hint regression (multi-crisis over-merge,
 * levers B+C).
 *
 * On a busy news day a US-Iran "Military Ops" megacluster silently absorbs
 * genuinely UNRELATED events — a Taiwan chip-fab deal, Black-Sea oil-tanker
 * attacks, Russia drone strikes — whose titles merely share surface vocabulary
 * ("strike", "deal", "$100 billion") with the anchor. The LLM event-identity
 * classifier is biased toward same_event and, seeing only shared keywords,
 * releases ~0. These helpers give it a DETERMINISTIC nudge: extract each title's
 * named geopolitical actors, compute the cluster's DOMINANT actor core, and TAG
 * any member whose actors are ALL outside that core as a strong
 * different_event_split candidate. The LLM stays the sole decider — the tag only
 * counters its bias.
 *
 * Precision-first + fail toward keep is the invariant under test:
 *   - a member with NO recognized actor is NEVER tagged (can't tell -> keep);
 *   - a member sharing ANY actor with the core is NEVER tagged (same region);
 *   - tags fire ONLY for an oversized cluster (normal clusters get no hints);
 *   - so a missed match can only WITHHOLD a nudge, never force a split.
 *
 * PURE, deterministic (no DB / no LLM / no network).
 *
 * Usage:  tsx scripts/curated-classifier-actor-hint.test.ts
 * Exit:   0 = all pass, 1 = a check failed.
 */
import {
  extractActorTokens,
  computeDominantActors,
  memberHasDisjointActors,
  buildAnchorClassifierMemberLines,
} from '../server/curatedCluster';

let failures = 0;
let ran = 0;
function check(name: string, ok: boolean, detail = '') {
  ran++;
  if (ok) {
    console.log(`[actor-hint] OK   ${name}`);
  } else {
    console.error(`[actor-hint] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

type M = { title: string; source: string; cls: 'corroborating' | 'anchor-only' | 'attach'; label: 'primary' | 'contrast' | null };
const m = (title: string, source = 'Reuters'): M => ({ title, source, cls: 'corroborating', label: null });

// ---------------------------------------------------------------------------
// (1) EXTRACTOR — canonical actors are recognized via their aliases; a title
// with no geopolitical actor yields an empty set.
// ---------------------------------------------------------------------------
{
  const usIran = extractActorTokens('US and Iran trade strikes over nuclear sites near Tehran');
  check('(1) US+Iran title extracts both actors', usIran.has('us') && usIran.has('iran'), [...usIran].join(','));
  const tsmc = extractActorTokens('TSMC to invest $100 billion in Arizona chip plants');
  check('(1) TSMC headline maps to the taiwan actor', tsmc.has('taiwan'), [...tsmc].join(','));
  const generic = extractActorTokens('Markets rally as inflation cools for a third straight month');
  check('(1) a title naming no actor yields an empty set', generic.size === 0, [...generic].join(','));
  const idf = extractActorTokens('IDF says it struck Hezbollah positions in southern Lebanon');
  check('(1) alias tokens resolve (idf->israel, hezbollah/lebanon->hezbollah)', idf.has('israel') && idf.has('hezbollah'), [...idf].join(','));
}

// ---------------------------------------------------------------------------
// (2) DOMINANT CORE — actors named across a modest fraction of members form the
// core; a one-off foreign actor does NOT. Uses a realistic US-Iran cluster with
// a couple of stray foreign titles mixed in.
// ---------------------------------------------------------------------------
{
  const titles = [
    'US strikes Iran nuclear facility',
    'Iran vows retaliation against US forces',
    'Israel backs US action against Iran',
    'Pentagon confirms US strikes on Iranian sites',
    'Iran summons envoys after US attack',
    'US and Iran clash at the UN over strikes',
    'TSMC to invest $100 billion in Arizona chip plants', // taiwan — one-off
    'Russia launches drone barrage on Kyiv', // russia/ukraine — one-off
  ];
  const dominant = computeDominantActors(titles);
  check('(2) US is in the dominant core', dominant.has('us'), [...dominant].join(','));
  check('(2) Iran is in the dominant core', dominant.has('iran'));
  check('(2) one-off Taiwan is NOT in the dominant core', !dominant.has('taiwan'), [...dominant].join(','));
  check('(2) one-off Russia/Ukraine is NOT in the dominant core', !dominant.has('russia') && !dominant.has('ukraine'), [...dominant].join(','));
}

// ---------------------------------------------------------------------------
// (3) DISJOINT-ACTOR PREDICATE — a member whose actors are ALL outside the core
// is flagged; a same-core member and a no-actor member are NOT.
// ---------------------------------------------------------------------------
{
  const core = new Set(['us', 'iran', 'israel']);
  check('(3) foreign-actor member (taiwan) is disjoint', memberHasDisjointActors('TSMC to build $100 billion Taiwan fab', core) === true);
  check('(3) same-core member (iran) is NOT disjoint', memberHasDisjointActors('Iran threatens to close Strait of Hormuz', core) === false);
  check('(3) mixed member sharing one core actor is NOT disjoint', memberHasDisjointActors('US and China discuss Taiwan chips', core) === false);
  check('(3) no-actor member is NOT disjoint (fail toward keep)', memberHasDisjointActors('Oil prices spike on supply fears', core) === false);
  check('(3) empty core never flags anything', memberHasDisjointActors('Russia strikes Ukraine power grid', new Set()) === false);
}

// ---------------------------------------------------------------------------
// (4) PROMPT ASSEMBLY, OVERSIZED — the megacluster case: unrelated foreign
// members get the [DIFFERENT CORE ACTORS: ...] tag; genuine US-Iran members do
// not. The dominant core and hint count are reported for the prompt override.
// ---------------------------------------------------------------------------
{
  const members: M[] = [
    m('US strikes Iran nuclear facility'),
    m('Iran vows retaliation against US forces'),
    m('Israel backs US action against Iran'),
    m('Pentagon confirms US strikes on Iranian sites'),
    m('Iran summons envoys after US attack'),
    m('US and Iran clash at the UN over strikes'),
    m('TSMC to invest $100 billion in Arizona chip plants'), // foreign
    m('Russia launches drone barrage on Kyiv'), // foreign
  ];
  const built = buildAnchorClassifierMemberLines(members, true);
  check('(4) TSMC (Taiwan) member is tagged DIFFERENT CORE ACTORS', /TSMC to invest.*\[DIFFERENT CORE ACTORS: [^\]]*taiwan/.test(built.list), built.list);
  check('(4) Russia/Ukraine drone member is tagged DIFFERENT CORE ACTORS', /Russia launches drone.*\[DIFFERENT CORE ACTORS:/.test(built.list), built.list);
  check('(4) genuine US-Iran member is NOT tagged', !/US strikes Iran nuclear facility" \(Reuters\) \[DIFFERENT/.test(built.list), built.list);
  check('(4) exactly 2 foreign members were hinted', built.hintedCount === 2, `hintedCount=${built.hintedCount}`);
  check('(4) dominant core includes us and iran', built.dominant.includes('us') && built.dominant.includes('iran'), built.dominant.join(','));
}

// ---------------------------------------------------------------------------
// (5) NORMAL CLUSTER — with oversized=false NO member is ever tagged and the
// dominant core is empty (the hint is an oversized-only lever).
// ---------------------------------------------------------------------------
{
  const members: M[] = [
    m('US strikes Iran nuclear facility'),
    m('TSMC to invest $100 billion in Arizona chip plants'),
    m('Russia launches drone barrage on Kyiv'),
  ];
  const built = buildAnchorClassifierMemberLines(members, false);
  check('(5) normal (non-oversized) cluster tags NOTHING', !built.list.includes('[DIFFERENT CORE ACTORS'), built.list);
  check('(5) normal cluster reports zero hints and empty core', built.hintedCount === 0 && built.dominant.length === 0);
}

// ---------------------------------------------------------------------------
// (6) SAME-DEAL DEVELOPING PROCESS — a member that is a facet of the SAME
// US-Iran story (a mediator, a sanctions angle) shares the core actors and so is
// NEVER tagged, even in oversized mode. Precision guardrail: the hint must not
// nudge a genuine same-event angle toward a split.
// ---------------------------------------------------------------------------
{
  const members: M[] = [
    m('US and Iran open nuclear talks in Geneva'),
    m('Iran demands US sanctions relief in nuclear talks'),
    m('US offers Iran phased sanctions relief'),
    m('Qatar mediates between US and Iran on nuclear deal'), // Qatar mediator — but names US+Iran too
    m('Iran nuclear talks resume after US concession'),
    m('US envoy briefs Congress on Iran nuclear deal'),
  ];
  const built = buildAnchorClassifierMemberLines(members, true);
  check('(6) the Qatar mediator (also names US+Iran) is NOT tagged', !/Qatar mediates.*\[DIFFERENT CORE ACTORS/.test(built.list), built.list);
  check('(6) no same-deal member is tagged (0 hints)', built.hintedCount === 0, `hintedCount=${built.hintedCount} list=${built.list}`);
}

// ---------------------------------------------------------------------------
// Completion sentinel — guard against a vacuous exit-0 if the file threw or an
// import silently no-op'd before the checks ran.
// ---------------------------------------------------------------------------
const EXPECTED_MIN_CHECKS = 21;
if (ran < EXPECTED_MIN_CHECKS) {
  console.error(`\n[actor-hint] INCOMPLETE — only ${ran}/${EXPECTED_MIN_CHECKS} checks ran (vacuous pass guard)`);
  process.exit(1);
}

if (failures > 0) {
  console.error(`\n[actor-hint] ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n[actor-hint] ALL PASS (${ran} checks)`);
}
