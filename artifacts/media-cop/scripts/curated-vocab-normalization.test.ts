/**
 * Curated same-event vocabulary normalization regression (Task #598).
 *
 * Two outlets describing the SAME curated event sometimes use completely
 * different vocabulary for the same thing — a British/American spelling
 * variant ("data centre" vs. "data center"), or a different nickname/acronym
 * for the same recurring bill/policy (the "NDAA" vs. the "Pentagon bill" vs.
 * the "defense bill"). significantTitleTokens canonicalizes both BEFORE
 * tokenizing, so every consumer (looksSameEvent, looksRelatedToStory,
 * buildSameEventBuckets, the curatedIncrementalAttach bridge) sees the real
 * overlap instead of two disjoint token sets.
 *
 * This is a PURE, deterministic check (no DB / no LLM / no network). It also
 * pins the Task #598 precision guardrail: normalization must never invent an
 * overlap between genuinely unrelated headlines that just happen to share an
 * unrelated common word, and the existing single-shared-token gate in
 * looksSameEvent must remain untouched (see curated-nodecap-repro.ts's
 * "anthropic" transitive-precision case).
 *
 * Usage:  tsx scripts/curated-vocab-normalization.test.ts
 */
import { significantTitleTokens, looksSameEvent, titlesHighlySimilar } from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[vocab-norm] OK   ${name}`);
  } else {
    console.error(`[vocab-norm] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// (1) SPELLING — "data centre" vs. "data center" now overlap fully.
// ---------------------------------------------------------------------------
{
  const a = significantTitleTokens('Microsoft halts new data centre construction amid power crunch');
  const b = significantTitleTokens('Microsoft pauses data center buildout over power constraints');
  check(
    '(1) "data centre" / "data center" share the canonical "center" token',
    a.has('center') && b.has('center') && !a.has('centre') && !b.has('centre'),
  );
  check('(1) the two spelling-variant headlines now looksSameEvent', looksSameEvent(a, b) === true);
}

// ---------------------------------------------------------------------------
// (2) NDAA DOMAIN SYNONYM — "NDAA", "Pentagon bill", and "defense bill" all
// canonicalize onto the same pseudo-token.
// ---------------------------------------------------------------------------
{
  const ndaa = significantTitleTokens('House GOP blocks the NDAA over voter ID demands');
  const pentagonBill = significantTitleTokens('Republicans hold up the Pentagon bill in a procedural vote');
  const defenseBill = significantTitleTokens('GOP ties defense spending bill to voter ID law');
  check(
    '(2) "NDAA" canonicalizes to the shared pseudo-token',
    ndaa.has('ndaadefensebill'),
  );
  check(
    '(2) "Pentagon bill" canonicalizes to the SAME shared pseudo-token',
    pentagonBill.has('ndaadefensebill'),
  );
  check(
    '(2) "defense spending bill" canonicalizes to the SAME shared pseudo-token',
    defenseBill.has('ndaadefensebill'),
  );
}

// ---------------------------------------------------------------------------
// (3) PRECISION GUARDRAIL — normalization must not create a false same-event
// match between two headlines that are NOT about the same event, even when
// each independently contains a normalized spelling word.
// ---------------------------------------------------------------------------
{
  const a = significantTitleTokens('London council opens new arts centre for local youth');
  const b = significantTitleTokens('Berlin unveils refugee processing center near border');
  check(
    '(3) two unrelated "centre"/"center" stories still do NOT looksSameEvent',
    looksSameEvent(a, b) === false,
  );
}

// ---------------------------------------------------------------------------
// (4) Unrelated headlines with no shared vocabulary at all stay unrelated —
// the normalization change must not regress the base no-overlap case.
// ---------------------------------------------------------------------------
{
  const a = significantTitleTokens('Tornado damages homes across rural Oklahoma county');
  const b = significantTitleTokens('Central bank raises interest rates a quarter point');
  check('(4) genuinely unrelated headlines do not looksSameEvent', looksSameEvent(a, b) === false);
}

// ---------------------------------------------------------------------------
// (5) HELICOPTER DOMAIN SYNONYM (Task #480) — "helicopter", "helo" (military),
// "chopper", and "copter" (with plurals) all canonicalize onto one shared token
// so two reports of the SAME rotary-aircraft incident that use different
// vocabulary overlap. As with every synonym group this only WIDENS recall — a
// single shared "helicopter" token can never by itself force a merge, because
// looksSameEvent still requires >= 2 shared distinctive tokens.
// ---------------------------------------------------------------------------
{
  const helicopter = significantTitleTokens('Navy helicopter goes down in the Arabian Sea');
  const helo = significantTitleTokens('US military helo crashes into the Arabian Sea');
  const chopper = significantTitleTokens('Military chopper lost over the Arabian Sea');
  const copter = significantTitleTokens('Rescue copter deployed after Arabian Sea crash');
  check('(5) "helicopter" canonicalizes to the shared token', helicopter.has('helicopter'));
  check('(5) "helo" canonicalizes to the SAME token (and drops "helo")', helo.has('helicopter') && !helo.has('helo'));
  check('(5) "chopper" canonicalizes to the SAME token (and drops "chopper")', chopper.has('helicopter') && !chopper.has('chopper'));
  check('(5) "copter" canonicalizes to the SAME token (and drops "copter")', copter.has('helicopter') && !copter.has('copter'));
  check(
    '(5) helicopter + helo reports of the SAME incident looksSameEvent',
    looksSameEvent(helicopter, helo) === true,
  );
}

// ---------------------------------------------------------------------------
// (6) HELICOPTER PRECISION GUARDRAIL — two DIFFERENT helicopter stories that
// share ONLY the aircraft word must NOT be forced together by the new synonym.
// ---------------------------------------------------------------------------
{
  const a = significantTitleTokens('Police helicopter crashes during Los Angeles traffic pursuit');
  const b = significantTitleTokens('Tourist helicopter makes emergency landing in Hawaii');
  check(
    '(6) two unrelated helicopter stories still do NOT looksSameEvent',
    looksSameEvent(a, b) === false,
  );
}

// ---------------------------------------------------------------------------
// (7) CASUALTY-COUNT TOLERANCE (Task #669) — a wire story's death toll gets
// bumped as it develops ("at least 11" -> "at least 12"); a 3+ digit toll
// used to survive the >= 3-char token filter and make two copies of the SAME
// article look disjoint. The differing counts must now canonicalize onto one
// shared pseudo-token so the escalating number stops being a mismatch.
// ---------------------------------------------------------------------------
{
  const a = significantTitleTokens('Russian strike on Kyiv apartment block kills at least 11');
  const b = significantTitleTokens('Russian strike on Kyiv apartment block kills at least 12');
  check(
    '(7) escalating "at least N" death tolls canonicalize to the shared token',
    a.has('casualtycount') && b.has('casualtycount') && !a.has('11') && !b.has('12'),
  );
  check('(7) same wire story with a bumped toll now looksSameEvent', looksSameEvent(a, b) === true);

  const c = significantTitleTokens('At least 143 killed as building collapses in Mumbai');
  const d = significantTitleTokens('Death toll rises to 156 after Mumbai building collapse');
  check(
    '(7) "<N> killed" and "toll rises to <N>" phrasing both canonicalize',
    c.has('casualtycount') && d.has('casualtycount'),
  );
  check('(7) same collapse story with a bumped toll now looksSameEvent', looksSameEvent(c, d) === true);
}

// ---------------------------------------------------------------------------
// (8) CASUALTY-COUNT PRECISION GUARDRAIL — a bare number that is NOT in a
// casualty/count context (a vote tally, a percentage, a squadron number) must
// be left completely untouched, and two unrelated stories that each merely
// mention a death toll must not be forced together by the shared pseudo-token
// alone (looksSameEvent still requires >= 2 shared distinctive tokens).
// ---------------------------------------------------------------------------
{
  const vote = significantTitleTokens('Senate confirms nominee by a 529 vote margin');
  check('(8) a non-casualty bare number is left untouched', vote.has('529') && !vote.has('casualtycount'));

  const floodToll = significantTitleTokens('At least 9 killed in flash flooding in Texas');
  const wildfireToll = significantTitleTokens('Wildfire in California kills at least 14 residents');
  check(
    '(8) two unrelated disasters that each report a toll do NOT looksSameEvent',
    looksSameEvent(floodToll, wildfireToll) === false,
  );

  // Regression: the "<N> [people] <casualty word>" rule must collapse the
  // NUMBER AND THE CASUALTY WORD into one shared token. If the word survived
  // untouched (e.g. "casualtycount dead"), two completely unrelated incidents
  // that each happen to use the same casualty word would share 2 tokens
  // {casualtycount, dead} and falsely looksSameEvent — this must never happen.
  const busCrash = significantTitleTokens('3 dead after bus crash in Texas');
  const factoryFire = significantTitleTokens('8 dead after factory fire in India');
  check(
    '(8) "N dead" collapses word+number into ONE token (no leftover "dead")',
    !busCrash.has('dead') && !factoryFire.has('dead'),
  );
  check(
    '(8) two unrelated "N dead ..." incidents do NOT looksSameEvent',
    looksSameEvent(busCrash, factoryFire) === false,
  );
  const boatSinks = significantTitleTokens('5 missing after boat sinks off the coast');
  const ferryCapsizes = significantTitleTokens('12 missing after ferry capsizes near the port');
  check(
    '(8) "N missing" collapses word+number into ONE token (no leftover "missing")',
    !boatSinks.has('missing') && !ferryCapsizes.has('missing'),
  );
  check(
    '(8) two unrelated "N missing ..." incidents do NOT looksSameEvent',
    looksSameEvent(boatSinks, ferryCapsizes) === false,
  );

  // Regression: the "death toll ... N" rule must not leave "toll" (or the
  // preceding "death"/"casualty" trigger word) as a separate surviving token
  // alongside casualtycount.
  const quakeIran = significantTitleTokens('Death toll rises to 156 after Iran earthquake strikes capital');
  const quakeTurkey = significantTitleTokens('Death toll climbs to 200 after Turkey earthquake hits coast');
  check(
    '(8) "death toll ... N" collapses to one token (no leftover "toll" or "death")',
    !quakeIran.has('toll') && !quakeIran.has('death') && !quakeTurkey.has('toll') && !quakeTurkey.has('death'),
  );

  // Escalation recall must still hold: the SAME wire story updating its toll
  // (shared real-content tokens beyond the casualty phrase) still matches.
  const strikeA = significantTitleTokens('Airstrike kills at least 11 in Gaza');
  const strikeB = significantTitleTokens('Airstrike kills at least 19 in Gaza');
  check(
    '(8) escalating same-story toll still looksSameEvent (recall preserved)',
    looksSameEvent(strikeA, strikeB) === true,
  );

  // A non-casualty "at least N" (lawmakers, votes, funding, seats) must never
  // canonicalize just because it matches the bare phrasing — no casualty word
  // appears anywhere nearby.
  const lawmakers = significantTitleTokens('At least 212 lawmakers back the new spending measure');
  check(
    '(8) non-casualty "at least N lawmakers" is left untouched',
    lawmakers.has('212') && !lawmakers.has('casualtycount'),
  );
  const funding = significantTitleTokens('Senate approves at least 500 million in new funding');
  check(
    '(8) non-casualty "at least N million in funding" is left untouched',
    funding.has('500') && !funding.has('casualtycount'),
  );

  // A non-casualty "toll" (economic/financial toll) must never canonicalize
  // just because a number follows within the window — no "death"/"casualty"
  // word precedes "toll".
  // NOTE: "300 billion" is now fused by canonicalizeMoneyFigures (the money
  // de-bridge), so the bare '300' token no longer survives. The invariant this
  // case pins is only that a NON-casualty toll never becomes casualtycount.
  const economicToll = significantTitleTokens('Tariffs economic toll reaches 300 billion dollars');
  check(
    '(8) non-casualty "economic toll ... N" is left untouched',
    economicToll.has('toll') && !economicToll.has('casualtycount'),
  );
  const financialToll = significantTitleTokens('Shutdown financial toll climbs past 2000 per household');
  check(
    '(8) non-casualty "financial toll ... N" is left untouched',
    financialToll.has('2000') && !financialToll.has('casualtycount'),
  );
}

// ---------------------------------------------------------------------------
// (9) PERSON/ROLE ALIAS (Task #669) — outlets refer to the same public figure
// by given name vs. by title/description ("Khamenei" / "Ayatollah Ali
// Khamenei" / "supreme leader" / "slain leader"). This splintered a
// ~40-source funeral story into an 11-member cluster plus ~30 standalone
// orphans. All variants must canonicalize onto one shared pseudo-token.
// ---------------------------------------------------------------------------
{
  const givenName = significantTitleTokens('Millions mourn Khamenei at Tehran funeral procession');
  const fullTitle = significantTitleTokens('Huge crowds gather for Ayatollah Ali Khamenei funeral in Tehran');
  const roleOnly = significantTitleTokens('Iran holds state funeral for slain leader in Tehran');
  const supremeLeader = significantTitleTokens('Massive funeral crowds in Tehran farewell the supreme leader');
  check('(9) "Khamenei" canonicalizes to the shared alias token', givenName.has('khameneileader'));
  check('(9) "Ayatollah Ali Khamenei" canonicalizes to the SAME token', fullTitle.has('khameneileader'));
  check('(9) "slain leader" canonicalizes to the SAME token', roleOnly.has('khameneileader'));
  check('(9) "supreme leader" canonicalizes to the SAME token', supremeLeader.has('khameneileader'));
  check('(9) given-name vs. full-title funeral coverage now looksSameEvent', looksSameEvent(givenName, fullTitle) === true);
  check('(9) given-name vs. role-only funeral coverage now looksSameEvent', looksSameEvent(givenName, roleOnly) === true);
  check('(9) role-only vs. "supreme leader" funeral coverage now looksSameEvent', looksSameEvent(roleOnly, supremeLeader) === true);
}

// ---------------------------------------------------------------------------
// (10) PERSON/ROLE ALIAS PRECISION GUARDRAIL — a single shared "supreme
// leader"/"slain leader" alias token must NEVER by itself force two otherwise
// unrelated headlines together (looksSameEvent still requires >= 2 shared
// distinctive tokens, same guarantee as every other synonym group).
// ---------------------------------------------------------------------------
{
  const funeralStory = significantTitleTokens('Tehran holds massive funeral procession for slain leader');
  const unrelatedMention = significantTitleTokens('Analysts debate who could succeed the supreme leader');
  check(
    '(10) a funeral story and an unrelated succession-analysis story do NOT looksSameEvent',
    looksSameEvent(funeralStory, unrelatedMention) === false,
  );
}

// ---------------------------------------------------------------------------
// (11) DISPLACEMENT/EVACUATION TOLERANCE (Task #671) — the OTHER human-impact
// count a disaster/conflict wire routinely bumps as a story develops: the
// number of people evacuated/displaced/left homeless/stranded. A 3+ digit
// count used to survive the >= 3-char token filter and make two copies of the
// SAME story look disjoint on that number alone. All the phrasings must
// canonicalize onto ONE shared "displacecount" pseudo-token.
// ---------------------------------------------------------------------------
{
  const a = significantTitleTokens('Over 500 evacuated after Russian strike near Kyiv');
  const b = significantTitleTokens('Up to 1,200 people evacuated in Kyiv Oblast after Russian strike');
  check(
    '(11) "<N> evacuated" and "<N> people evacuated" both canonicalize',
    a.has('displacecount') && b.has('displacecount') && !a.has('500') && !b.has('200'),
  );
  check('(11) same evacuation story with a bumped count now looksSameEvent', looksSameEvent(a, b) === true);

  const c = significantTitleTokens('At least 5,000 displaced by flooding in Pakistan');
  const d = significantTitleTokens('Pakistan floods leave at least 8,000 displaced');
  check(
    '(11) "at least <N> displaced" canonicalizes (both orders)',
    c.has('displacecount') && d.has('displacecount'),
  );
  check('(11) same flood story with a bumped displaced count now looksSameEvent', looksSameEvent(c, d) === true);

  const e = significantTitleTokens('Authorities evacuate 3,596 residents after Fushun rainstorm');
  check(
    '(11) verb-before-number "evacuate <N>" canonicalizes',
    e.has('displacecount') && !e.has('596'),
  );

  // The count word must be fused INTO the token (no leftover "evacuated"/"displaced"),
  // exactly like the casualty single-token-fusion invariant.
  check('(11) "<N> evacuated" leaves no leftover "evacuated" token', !a.has('evacuated'));
  check('(11) "<N> displaced" leaves no leftover "displaced" token', !c.has('displaced'));
}

// ---------------------------------------------------------------------------
// (12) DISPLACEMENT PRECISION GUARDRAIL — a bare number NOT in a displacement
// context must be untouched, and two unrelated disasters that each merely
// report an evacuation count must not be forced together by the shared token
// alone (looksSameEvent still requires >= 2 shared distinctive tokens).
// ---------------------------------------------------------------------------
{
  const relocate = significantTitleTokens('Company relocates 500 employees to a new office');
  check('(12) a non-displacement bare number is left untouched', relocate.has('500') && !relocate.has('displacecount'));

  const greece = significantTitleTokens('5,000 evacuated as wildfire hits Greece');
  const vietnam = significantTitleTokens('3,000 evacuated as floods hit Vietnam');
  check(
    '(12) two unrelated evacuations do NOT looksSameEvent on the shared token alone',
    looksSameEvent(greece, vietnam) === false,
  );

  // A casualty story and a displacement story that share only a broad location
  // ("France") must NOT false-merge — this is why displacecount is a SEPARATE
  // token from casualtycount.
  const casualtyFrance = significantTitleTokens('Bus crash kills 5 in France');
  const displaceFrance = significantTitleTokens('Wildfire forces 5,000 evacuated in France');
  check(
    '(12) casualty + displacement sharing only a location do NOT looksSameEvent',
    looksSameEvent(casualtyFrance, displaceFrance) === false,
  );
}

// ---------------------------------------------------------------------------
// (13) HOSPITALIZATION (Task #671) — a medical-casualty count added to the
// casualty word set. "at least 100 hospitalized" / "<N> hospitalized" collapse
// onto the shared casualtycount token (never a bare, differing number).
// ---------------------------------------------------------------------------
{
  const a = significantTitleTokens('At least 100 hospitalized after chemical leak at Negombo Prison');
  const b = significantTitleTokens('Negombo Prison chemical leak sends 250 hospitalised');
  check(
    '(13) "at least <N> hospitalized" and "<N> hospitalised" canonicalize',
    a.has('casualtycount') && b.has('casualtycount') && !a.has('100') && !b.has('250'),
  );
  check('(13) "<N> hospitalized" leaves no leftover word token', !a.has('hospitalized') && !b.has('hospitalised'));
  check('(13) same hospitalization story with a bumped count now looksSameEvent', looksSameEvent(a, b) === true);
}

// ---------------------------------------------------------------------------
// (14) MAGNITUDE-WORD IMPACT COUNTS (Task #672) — outlets express the SAME wire
// count as a magnitude WORD instead of digits: "thousands displaced", "hundreds
// evacuated", "dozens killed", "scores hospitalized". A word-count copy and a
// numeric-count copy of one story must now share the SAME impact pseudo-token
// (casualtycount / displacecount) so they stop fragmenting into standalone
// cards. All from real curated production examples (Typhoon Bavi flooding,
// factory fires, Ebola/wildfire death tolls).
// ---------------------------------------------------------------------------
{
  // Displacement: word form vs. numeric form of the SAME evacuation story.
  const bavuWord = significantTitleTokens('Thousands evacuated as Typhoon Bavi hits Mindanao Philippines');
  const bavuNum = significantTitleTokens('Up to 5,000 evacuated in Mindanao as Typhoon Bavi lashes Philippines');
  check(
    '(14) "thousands evacuated" and "<N> evacuated" share the displacecount token',
    bavuWord.has('displacecount') && bavuNum.has('displacecount') && !bavuWord.has('thousands'),
  );
  check('(14) word-count vs. numeric-count evacuation story now looksSameEvent', looksSameEvent(bavuWord, bavuNum) === true);

  // "hundreds of families evacuated" / "hundreds of residents evacuated" — the
  // "of <group noun>" connector form, both real Typhoon Bavi headlines.
  const families = significantTitleTokens('Hundreds of families evacuated due to Typhoon Bavi flooding in Mindanao');
  const residents = significantTitleTokens('Hundreds of residents evacuated after Typhoon Bavi floods Malaybalay City');
  check(
    '(14) "hundreds of families/residents evacuated" canonicalizes (of-connector)',
    families.has('displacecount') && residents.has('displacecount') && !families.has('hundreds') && !residents.has('hundreds'),
  );

  // Casualty: "dozens killed" / "hundreds dead" word forms fuse to casualtycount
  // with NO leftover casualty word (single-token-fusion invariant).
  const dozens = significantTitleTokens('Dozens killed in shoe factory fire in China');
  const hundreds = significantTitleTokens('Ebola outbreak in DR Congo leaves hundreds dead');
  const scores = significantTitleTokens('Scores of people wounded in market blast');
  check(
    '(14) "dozens killed" fuses to casualtycount (no leftover "dozens"/"killed")',
    dozens.has('casualtycount') && !dozens.has('dozens') && !dozens.has('killed'),
  );
  check(
    '(14) "hundreds dead" fuses to casualtycount (no leftover "hundreds"/"dead")',
    hundreds.has('casualtycount') && !hundreds.has('hundreds') && !hundreds.has('dead'),
  );
  check(
    '(14) "scores of people wounded" fuses to casualtycount (of-connector)',
    scores.has('casualtycount') && !scores.has('scores') && !scores.has('wounded'),
  );

  // Verb-before-word: "kills dozens" / "evacuate thousands".
  const killsDozens = significantTitleTokens('Airstrike kills dozens in northern Gaza');
  const numGaza = significantTitleTokens('Airstrike kills at least 30 in northern Gaza');
  check('(14) "kills dozens" canonicalizes to casualtycount', killsDozens.has('casualtycount') && !killsDozens.has('dozens'));
  check('(14) "kills dozens" vs. "kills at least <N>" same story now looksSameEvent', looksSameEvent(killsDozens, numGaza) === true);
  const evacThousands = significantTitleTokens('Authorities evacuate thousands as wildfire spreads in Greece');
  check('(14) "evacuate thousands" canonicalizes to displacecount', evacThousands.has('displacecount') && !evacThousands.has('thousands'));
}

// ---------------------------------------------------------------------------
// (15) MAGNITUDE-WORD PRECISION GUARDRAIL — a magnitude word NOT in a casualty/
// displacement context must be left completely untouched, and two UNRELATED
// impact stories that each use a magnitude word must not be forced together by
// the shared token alone (looksSameEvent still requires >= 2 shared tokens).
// ---------------------------------------------------------------------------
{
  // Non-impact magnitude words are left as ordinary tokens (no impact token).
  const protest = significantTitleTokens('Thousands protest in Paris over pension reform');
  check('(15) "thousands protest" is left untouched (no displacecount/casualtycount)',
    (protest.has('thousands') || protest.has('thousand')) && !protest.has('displacecount') && !protest.has('casualtycount'));
  const lawmakers = significantTitleTokens('Dozens of lawmakers back the new spending measure');
  check('(15) "dozens of lawmakers" is left untouched', (lawmakers.has('dozens') || lawmakers.has('dozen')) && !lawmakers.has('casualtycount'));
  const goals = significantTitleTokens('Striker scores twice as United beat rivals');
  check('(15) sports "scores" is left untouched (no casualtycount)', !goals.has('casualtycount'));

  // Two UNRELATED word-count casualty incidents share only casualtycount → must
  // NOT looksSameEvent (single-token-fusion invariant, same as the numeric case).
  const factoryFire = significantTitleTokens('Dozens killed in shoe factory fire in China');
  const busCrash = significantTitleTokens('Dozens killed in bus crash in Peru');
  check('(15) two unrelated "dozens killed" incidents do NOT looksSameEvent', looksSameEvent(factoryFire, busCrash) === false);

  // Two UNRELATED word-count displacement incidents likewise do not merge.
  const greeceFire = significantTitleTokens('Thousands evacuated as wildfire hits Greece');
  const vietnamFlood = significantTitleTokens('Thousands evacuated as floods hit Vietnam');
  check('(15) two unrelated "thousands evacuated" incidents do NOT looksSameEvent', looksSameEvent(greeceFire, vietnamFlood) === false);

  // A casualty word-count and a displacement word-count that share only a broad
  // location must NOT merge — casualtycount and displacecount stay separate.
  const casualtyFrance = significantTitleTokens('Dozens killed in France');
  const displaceFrance = significantTitleTokens('Thousands evacuated in France');
  check('(15) word-count casualty + displacement sharing only a location do NOT looksSameEvent',
    looksSameEvent(casualtyFrance, displaceFrance) === false);
}

// ---------------------------------------------------------------------------
// (16) Singular/plural fold — morphology must not block titlesHighlySimilar.
// Pins the foldPluralToken behavior directly: plural/singular variants of the
// same distinctive tokens count as shared, while pseudo-tokens survive intact.
// ---------------------------------------------------------------------------
{
  const a = significantTitleTokens('Ukrainian drones strike Moscow region overnight');
  const b = significantTitleTokens('Ukrainian drone strikes hit Moscow region');
  check('(16) plural/singular variants cross titlesHighlySimilar', titlesHighlySimilar(a, b));
  const c = significantTitleTokens('Dozens killed as strikes hit the capital');
  check('(16) casualtycount pseudo-token survives the plural fold', c.has('casualtycount'));
  const d = significantTitleTokens('Mass crisis talks over status of news outlets');
  check('(16) ss/us/is endings and short words are never folded',
    d.has('mass') && d.has('crisis') && d.has('status') && d.has('talk'));
}

if (failures > 0) {
  console.error(`\n[vocab-norm] ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\n[vocab-norm] ALL PASS');
}
