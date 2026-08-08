// =============================================================================
// CI gate: boolean OR/AND/NOT keyword-box matching + parameterized boost
// (Task #1039 logic — server/watchTopicMatchCore.ts).
//
// WHAT THIS LOCKS
//  1. OR-only topic: matches when ANY OR term hits; a NOT term vetoes it.
//  2. AND topic: matches ONLY when ALL AND terms are present.
//  3. Combined OR+AND+NOT: the contract
//        (orBox satisfied) AND (andBox satisfied) AND NOT(notBox)
//     with NOT as a hard global veto that beats any positive match.
//  4. Exact phrase (parenthesized): matched as a contiguous unit (substring),
//     never as loose individual tokens.
//  5. applyPriorityBoostWithStrength: weak/standard/strong floor + bounded
//     nudge + shared 85 cap, and the "never demotes" guarantee.
//
// Pure + offline: imports ONLY the dependency-free core. Exit 0 = pass,
// 1 = fail (deterministic; no exit-3 inconclusive path needed).
// =============================================================================
import {
  compileWatchTopic,
  matchesTopic,
  applyPriorityBoostWithStrength,
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
// 1. OR-only box: any term hits, and the NOT box vetoes.
// ---------------------------------------------------------------------------
console.log('[1] OR-only box + NOT veto');
// No watchKeywords: force the match through the boolean boxes only so the
// legacy AI keyword gate can't accidentally supply the match.
const orTopic = compileWatchTopic({
  id: 'or',
  name: 'Naval Movements',
  isPriorityWatch: true,
  orKeywords: ['carrier', 'destroyer', 'submarine'],
  notKeywords: ['exercise'],
});
check('OR matches on first term', matchesTopic(orTopic, 'US carrier enters the Gulf'));
check('OR matches on another term', matchesTopic(orTopic, 'Destroyer deployed to Red Sea'));
check('OR rejects when no term present', !matchesTopic(orTopic, 'Air Force jet completes patrol'));
check('NOT box vetoes an otherwise-matching headline',
  !matchesTopic(orTopic, 'Carrier joins naval exercise off Guam'));
check('NOT box does not veto when its term is absent',
  matchesTopic(orTopic, 'Carrier transits the strait'));

// ---------------------------------------------------------------------------
// 2. AND box: ALL terms must be present.
// ---------------------------------------------------------------------------
console.log('[2] AND box — all terms required');
const andTopic = compileWatchTopic({
  id: 'and',
  name: 'Sanctions Package',
  isPriorityWatch: true,
  andKeywords: ['sanctions', 'russia', 'energy'],
});
check('AND matches when all three present',
  matchesTopic(andTopic, 'New sanctions target Russia energy exports'));
check('AND rejects when one term missing',
  !matchesTopic(andTopic, 'New sanctions target Russia banks'));
check('AND rejects when only one term present',
  !matchesTopic(andTopic, 'Russia holds military parade'));
// AND matches on whole tokens, not partial substrings: "sanction" alone must
// not satisfy the "sanctions" term (token-set membership, not substring).
check('AND term matches on whole token, not partial',
  !matchesTopic(andTopic, 'Court sanction hearing on Russia energy deal'));

// ---------------------------------------------------------------------------
// 3. Combined OR + AND + NOT priority.
// ---------------------------------------------------------------------------
console.log('[3] combined OR + AND + NOT');
const combo = compileWatchTopic({
  id: 'combo',
  name: 'Taiwan Escalation',
  isPriorityWatch: true,
  orKeywords: ['taiwan', 'taipei'],
  andKeywords: ['military'],
  notKeywords: ['tourism'],
});
check('combo matches: OR hit + AND hit, no NOT',
  matchesTopic(combo, 'Taiwan reports military incursion near coast'));
check('combo rejects: OR hit but AND term missing',
  !matchesTopic(combo, 'Taiwan reports record chip exports'));
check('combo rejects: AND hit but no OR term',
  !matchesTopic(combo, 'Japan military drills expand in Pacific'));
check('combo NOT veto beats a full OR+AND positive',
  !matchesTopic(combo, 'Taiwan military parade doubles as tourism draw'));

// ---------------------------------------------------------------------------
// 4. Exact phrase (parenthesized) — contiguous unit, not loose tokens.
// ---------------------------------------------------------------------------
console.log('[4] exact-phrase term');
const phraseTopic = compileWatchTopic({
  id: 'phrase',
  name: 'No-Fly Zone',
  isPriorityWatch: true,
  orKeywords: ['(no fly zone)'],
});
check('phrase matches as a contiguous unit',
  matchesTopic(phraseTopic, 'Allies weigh a no fly zone over the region'));
check('phrase does NOT match when words are scattered',
  !matchesTopic(phraseTopic, 'Zone closed after a no-cost fly-past drill'));

// ---------------------------------------------------------------------------
// 5. applyPriorityBoostWithStrength — floor / bounded nudge / cap / never demote.
// ---------------------------------------------------------------------------
console.log('[5] applyPriorityBoostWithStrength');
const BOOST_CASES: Array<['weak' | 'standard' | 'strong', number, number]> = [
  // weak: floor 60, +8 nudge, cap 85 (boost only lifts sub-floor scores)
  ['weak', 40, 48],   // +8 bound reached before the 60 floor
  ['weak', 55, 60],   // floor 60
  ['weak', 80, 80],   // already above floor — unchanged (a floor, not a pin)
  ['weak', 90, 90],   // never demoted
  // standard: floor 66, +15 nudge, cap 85 (matches applyPriorityBoost)
  ['standard', 50, 65],
  ['standard', 55, 66],
  ['standard', 66, 66],
  ['standard', 90, 90],
  // strong: floor 72, +22 nudge, cap 85
  ['strong', 40, 62],  // +22 bound reached before the 72 floor
  ['strong', 60, 72],  // floor 72
  ['strong', 70, 72],  // just below floor — lifted to the 72 floor
  ['strong', 90, 90],  // never demoted
];
for (const [strength, input, expected] of BOOST_CASES) {
  const got = applyPriorityBoostWithStrength(input, strength);
  check(`boost[${strength}] ${input} -> ${expected}`, got === expected, `got ${got}`);
}
for (const strength of ['weak', 'standard', 'strong'] as const) {
  check(`boost[${strength}] never lowers any score 0..100`,
    Array.from({ length: 101 }, (_, s) => applyPriorityBoostWithStrength(s, strength) >= s).every(Boolean));
  check(`boost[${strength}] never exceeds the 85 cap for sub-85 inputs`,
    Array.from({ length: 85 }, (_, s) => applyPriorityBoostWithStrength(s, strength) <= 85).every(Boolean));
}
check('strength defaults to standard', applyPriorityBoostWithStrength(55) === 66);

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n[watch-topic-bool-match] FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n[watch-topic-bool-match] PASS — all checks green');
process.exit(0);
