// =============================================================================
// CI gate: Priority/BOLO watch-topic keyword gate + curated-only steering scope
// (Task #884).
//
// WHAT THIS LOCKS
//  1. The deterministic keyword gate (server/watchTopicMatchCore.ts) accepts /
//     rejects the ground-truth headlines from the "Defense Spending Bill"
//     incident (63/63 junk tags): related coverage matches, adjacent-domain
//     noise does not.
//  2. Priority boost math: floor-66 nudge bounded by +15/cap-85, NEVER lowers.
//  3. Rescue budget bounds (max 5 total / 2 per topic per pass).
//  4. Heal symmetry/idempotency: the boot heal's clear decision is the exact
//     same matchesTopic(gate, HEADLINE) the tagger pre-gates with, so a healed
//     row can never be re-tagged (no flip-flop loop).
//  5. CURATED-ONLY SCOPE (user directive 2026-07-15): static source checks
//     that main-feed call sites gate on the hard-false
//     isMainFeedWatchSteeringEnabled(), the curated ingest is the only lane
//     wired to the live flag, and the warfighter scraper carries no steering.
//     (Static because the runtime flag default hides mis-wiring — same
//     rationale as the curated poll-endpoint auth-tier guard.)
//
// Pure + offline: imports ONLY the dependency-free core and reads source files.
// Exit 0 = pass, 1 = fail (deterministic; no exit-3 inconclusive path needed).
// =============================================================================
import { readFileSync } from 'node:fs';
import {
  compileWatchTopic,
  hasKeywordGate,
  matchesTopic,
  matchWatchTopics,
  createRescueBudget,
  applyPriorityBoost,
  normalize,
} from '../server/watchTopicMatchCore';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Keyword gate vectors (prod-shaped "Defense Spending Bill" topic).
// ---------------------------------------------------------------------------
console.log('[1] keyword gate — ground-truth accept/reject vectors');
const topic = compileWatchTopic({
  id: 'topic-dsb',
  name: 'Defense Spending Bill',
  isPriorityWatch: true,
  isBoloWatch: false,
  watchKeywords: [
    'defense spending',
    'pentagon budget',
    'budget reconciliation',
    'defense priorities',
    'FY27',
    'appropriations',
    'trillion',
  ],
});
check('topic compiles to a usable gate', hasKeywordGate(topic));
check(
  'phrase-part words are never promoted to solo tokens',
  !topic.soloTokens.includes('defense') && !topic.soloTokens.includes('pentagon') && !topic.soloTokens.includes('bill'),
  `soloTokens=${JSON.stringify(topic.soloTokens)}`,
);

const ACCEPT = [
  'Senate passes $1.2 trillion defense package',           // solo: trillion
  'Congress unveils FY27 appropriations package',          // solo: appropriations
  'Senate Dems block defense bill over shutdown fight',    // 2-of-N: defense+bill
  'Must-pass Pentagon bill stalls in House',                // 2-of-N: pentagon+bill
  'UK defence bill clears committee hurdle',                // spelling fold defence->defense + bill
  'White House pushes Pentagon budget increase',            // phrase: pentagon budget
];
const REJECT = [
  'Pentagon issues drone handbook',                 // single stray hit (pentagon)
  'Russia sanctions bill advances in Senate',       // single stray hit (bill)
  'Supreme Court to review budget case',            // single stray hit (budget)
  'Defense companies post record profits',          // single stray hit (defense)
  'Army updates fitness standards',                 // zero hits
];
for (const t of ACCEPT) check(`accepts: "${t}"`, matchesTopic(topic, t));
for (const t of REJECT) check(`rejects: "${t}"`, !matchesTopic(topic, t));

// Gate-less topic (no keywords, uninformative name) must be unmatchable and
// reported as such, so the tagger/heal skip it rather than guessing.
const gateless = compileWatchTopic({ id: 'x', name: 'Iran', watchKeywords: [] });
check('gate-less topic reports no usable gate', !hasKeywordGate(gateless));
check('gate-less topic never matches', !matchesTopic(gateless, 'Iran strikes back at Israel'));

// normalize folds UK spellings both ways of the comparison.
check('normalize folds defence->defense', normalize('Defence Bill') === 'defense bill');

// ---------------------------------------------------------------------------
// 2. Priority boost math — floor 66, bounded +15, cap 85, never lowers.
// ---------------------------------------------------------------------------
console.log('[2] priority boost math');
const BOOST_CASES: Array<[number, number]> = [
  [50, 65],  // +15 bound reached before the 66 floor
  [55, 66],  // floor 66
  [66, 66],  // already at floor — unchanged
  [70, 70],  // above floor — a nudge, not a pin
  [80, 80],
  [90, 90],  // never demoted toward the 85 cap
];
for (const [input, expected] of BOOST_CASES) {
  const got = applyPriorityBoost(input);
  check(`boost ${input} -> ${expected}`, got === expected, `got ${got}`);
}
check('boost never lowers any score 0..100', Array.from({ length: 101 }, (_, s) => applyPriorityBoost(s) >= s).every(Boolean));

// ---------------------------------------------------------------------------
// 3. Match plumbing + rescue budget bounds.
// ---------------------------------------------------------------------------
console.log('[3] match plumbing + rescue budget');
const empty = matchWatchTopics([], 'Senate passes trillion dollar defense bill');
check('no topics -> no matches', empty.priorityTopicIds.length === 0 && empty.boloTopicIds.length === 0);

const boloTopic = compileWatchTopic({
  id: 'topic-bolo',
  name: 'Defense Spending Bill',
  isPriorityWatch: false,
  isBoloWatch: true,
  watchKeywords: ['defense spending', 'trillion'],
});
const wm = matchWatchTopics([topic, boloTopic], 'Senate passes $1.2 trillion defense package');
check('priority + bolo topics credited separately', wm.priorityTopicIds.includes('topic-dsb') && wm.boloTopicIds.includes('topic-bolo'));

const budget = createRescueBudget(); // defaults: max 5, 2 per topic
check('budget: 2 rescues per topic', budget.consume(['a']) && budget.consume(['a']) && !budget.consume(['a']));
check('budget: max 5 total across topics',
  budget.consume(['b']) && budget.consume(['b']) && budget.consume(['c']) && !budget.consume(['d']),
  `used=${budget.used}`);

// ---------------------------------------------------------------------------
// 4. Heal symmetry + idempotency (tagger pre-gate == heal clear decision).
// ---------------------------------------------------------------------------
console.log('[4] heal symmetry + idempotency');
const taggedHeadlines = [...ACCEPT, ...REJECT];
// Simulated heal pass: keep only rows whose HEADLINE passes the gate.
const afterFirstHeal = taggedHeadlines.filter(h => matchesTopic(topic, h));
const afterSecondHeal = afterFirstHeal.filter(h => matchesTopic(topic, h));
check('heal clears exactly the reject set', afterFirstHeal.length === ACCEPT.length);
check('heal is idempotent (second pass clears nothing)', afterSecondHeal.length === afterFirstHeal.length);
// And the tagger's pre-gate would never re-offer a healed row for this topic:
check('healed rows cannot be re-tagged (symmetry)', REJECT.every(h => !matchesTopic(topic, h)));

// ---------------------------------------------------------------------------
// 5. CURATED-ONLY steering scope — static source wiring checks.
// ---------------------------------------------------------------------------
console.log('[5] curated-only steering scope (static wiring)');
const src = (p: string) => readFileSync(p, 'utf8');
const matcherSrc = src('server/watchTopicMatcher.ts');
const scraperSrc = src('server/scraper.ts');
const rssBotSrc = src('server/rssFeedBot.ts');
const warfighterSrc = src('server/warfighterRssScraper.ts');
const curatedSrc = src('server/curatedIngest.ts');
const taggerSrc = src('server/joePriorityMatcher.ts');
const migrateSrc = src('server/migrate.ts');

check('main-feed steering constant is hard-false',
  /const MAIN_FEED_STEERING_ENABLED = false/.test(matcherSrc));
check('main scraper gates on isMainFeedWatchSteeringEnabled',
  scraperSrc.includes('isMainFeedWatchSteeringEnabled()') && !scraperSrc.includes('isWatchTopicSteeringEnabled()'));
check('RSS bot gates on isMainFeedWatchSteeringEnabled',
  rssBotSrc.includes('isMainFeedWatchSteeringEnabled()') && !rssBotSrc.includes('isWatchTopicSteeringEnabled()'));
check('warfighter scraper carries NO steering wiring',
  !warfighterSrc.includes('watchTopicMatcher') && !warfighterSrc.includes('applyPriorityBoost'));
check('curated ingest is wired to the live steering flag',
  curatedSrc.includes('isWatchTopicSteeringEnabled()') && curatedSrc.includes('applyPriorityBoost') && curatedSrc.includes('watchRescueBudget.consume'));
check('curated boost keeps the human-score guard',
  /const isMachineAuthoredPriority = c\.priorityScore == null/.test(curatedSrc) &&
    /watchTopics\.length > 0 && isMachineAuthoredPriority/.test(curatedSrc));
check('tagger pre-gates via shared matchesTopic (symmetry source)',
  taggerSrc.includes("from './watchTopicMatchCore'") && taggerSrc.includes('matchesTopic('));
check('boot heal uses the same shared matchesTopic',
  migrateSrc.includes("from './watchTopicMatchCore'") && migrateSrc.includes('matchesTopic('));
check('boot heal loads boolean keyword fields too (same contract as Joe)',
  migrateSrc.includes('or_keywords, and_keywords, not_keywords') &&
  migrateSrc.includes('orKeywords: t.or_keywords') &&
  migrateSrc.includes('andKeywords: t.and_keywords') &&
  migrateSrc.includes('notKeywords: t.not_keywords'));
check('Joe matcher prompt shows every boolean keyword clause',
  taggerSrc.includes('OR: ${subject.orKeywords.join') &&
  taggerSrc.includes('AND: ${subject.andKeywords.join') &&
  taggerSrc.includes('NOT: ${subject.notKeywords.join'));

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n[watch-topic-priority] FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n[watch-topic-priority] PASS — all checks green');
process.exit(0);
