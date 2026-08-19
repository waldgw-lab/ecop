/**
 * Focused regression gate for local-conflict Top Stories calibration.
 * Pure/offline: no DB, network, or AI calls.
 */
import { readFileSync } from 'node:fs';
import {
  LOCAL_CONFLICT_MAX_PRIORITY,
  calibrateCuratedTopStoryPriority,
  computeCuratedTopStoryBlendScore,
} from '../server/curatedTopStoryRanking';
import {
  evalCuratedDirectUsImplicationTieBreak,
  hasDirectUsConflictImplication,
} from '../server/scoreAdjustments';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  PASS ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const gazaLocal = {
  title: 'Israeli military opens criminal probes into killings of Hind Rajab and Gaza paramedics',
  summary: 'The Israeli military ordered investigations into troop conduct and deaths of Palestinian paramedics in Gaza.',
  conflictTrack: 'Israel-Hamas / Gaza',
  priorityScore: 82,
  corroboratingSourceCount: 5,
};
check(
  'Gaza conduct investigation machine P-score stays Moderate',
  calibrateCuratedTopStoryPriority(gazaLocal) === LOCAL_CONFLICT_MAX_PRIORITY,
);
check(
  'five-source Gaza coverage cannot corroborate itself into High',
  computeCuratedTopStoryBlendScore(gazaLocal) === LOCAL_CONFLICT_MAX_PRIORITY,
);

const ukraineLocal = {
  title: 'Drone strike on minibus in Kherson kills at least four',
  summary: 'A drone strike hit a civilian minibus in Kherson, killing four people.',
  conflictTrack: 'Russia-Ukraine War',
  priorityScore: 64,
  corroboratingSourceCount: 3,
};
check(
  'Kherson local strike remains below High after corroboration',
  computeCuratedTopStoryBlendScore(ukraineLocal) === LOCAL_CONFLICT_MAX_PRIORITY,
);

const directUsUkraine = {
  title: 'Pentagon announces new U.S. air-defense deployment for Ukraine',
  summary: 'The deployment changes U.S. force posture after Russian missile strikes.',
  conflictTrack: 'Russia-Ukraine War',
  priorityScore: 74,
  corroboratingSourceCount: 4,
};
check(
  'direct U.S. Ukraine consequence retains normal corroboration',
  computeCuratedTopStoryBlendScore(directUsUkraine) === 95,
);

const directUsGaza = {
  title: 'Congress blocks U.S. weapons transfer to Israel over Gaza campaign',
  summary: 'The vote changes American military aid policy.',
  conflictTrack: 'Israel-Hamas / Gaza',
  priorityScore: 72,
  corroboratingSourceCount: 3,
};
check(
  'direct U.S. Gaza policy consequence retains normal corroboration',
  hasDirectUsConflictImplication(
    directUsGaza.title,
    directUsGaza.summary,
    directUsGaza.conflictTrack,
  ) && computeCuratedTopStoryBlendScore(directUsGaza) === 86,
);
const gazaTieBreak = evalCuratedDirectUsImplicationTieBreak(
  directUsGaza.title,
  directUsGaza.summary,
  70,
);
check(
  'existing direct-U.S. tie-break now recognizes Israel-Gaza policy',
  gazaTieBreak.applied && gazaTieBreak.score === 73,
);

const pinnedDown = {
  ...gazaLocal,
  priorityScore: 43, // already decayed from the raw editor pin
  priorityOverride: 50,
  corroboratingSourceCount: 8,
};
check(
  'editor downscore is final rank even after seven additional sources',
  computeCuratedTopStoryBlendScore(pinnedDown) === 43,
);

const pinnedUp = {
  ...ukraineLocal,
  priorityScore: 78,
  priorityOverride: 85,
  corroboratingSourceCount: 5,
};
check(
  'human-set score is never machine-capped or corroboration-inflated',
  calibrateCuratedTopStoryPriority(pinnedUp) === 78 &&
    computeCuratedTopStoryBlendScore(pinnedUp) === 78,
);

const unrelated = {
  title: 'China announces major new nuclear force deployment',
  summary: 'The deployment changes regional force posture.',
  conflictTrack: null,
  priorityScore: 80,
  corroboratingSourceCount: 3,
};
check(
  'unrelated high-consequence story keeps the existing blend',
  computeCuratedTopStoryBlendScore(unrelated) === 94,
);

check(
  'incidental U.S. media mention is not a direct U.S. implication',
  !hasDirectUsConflictImplication(
    'U.S. media cover Russian drone strike on Kherson minibus',
    '',
    'Russia-Ukraine War',
  ),
);
const journalistFalsePositive = {
  title: 'American journalist reports Hamas weapons cache after local Gaza raid kills two',
  summary: 'The locally discovered weapons cache was described by a visiting reporter after the isolated raid.',
  conflictTrack: 'Israel-Hamas / Gaza',
  priorityScore: 81,
  corroboratingSourceCount: 4,
};
check(
  'American journalist plus weapons is not a direct U.S. consequence',
  !hasDirectUsConflictImplication(
    journalistFalsePositive.title,
    journalistFalsePositive.summary,
    journalistFalsePositive.conflictTrack,
  ) &&
    computeCuratedTopStoryBlendScore(journalistFalsePositive) ===
      LOCAL_CONFLICT_MAX_PRIORITY,
);

check(
  'unclassified Russia-Ukraine strike wording is still calibrated',
  computeCuratedTopStoryBlendScore({
    title: 'Russian drone strike kills Ukrainian civilians in overnight attack',
    priorityScore: 78,
    corroboratingSourceCount: 3,
  }) === LOCAL_CONFLICT_MAX_PRIORITY,
);
check(
  'unclassified Israel-Palestinian local incident wording is still calibrated',
  computeCuratedTopStoryBlendScore({
    title: 'Israeli forces open probe after Palestinian paramedics killed in raid',
    priorityScore: 76,
    corroboratingSourceCount: 3,
  }) === LOCAL_CONFLICT_MAX_PRIORITY,
);
check(
  'unclassified IDF strike in Lebanon is not mistaken for Gaza coverage',
  computeCuratedTopStoryBlendScore({
    title: 'IDF strike kills civilians in southern Lebanon',
    priorityScore: 78,
    corroboratingSourceCount: 3,
  }) === 92,
);
check(
  'Russian domestic attack in Moscow is not mistaken for Ukraine coverage',
  computeCuratedTopStoryBlendScore({
    title: 'Russian authorities investigate deadly attack in Moscow',
    priorityScore: 76,
    corroboratingSourceCount: 3,
  }) === 90,
);
check(
  'Russian strategic force deployment is not mistaken for a local incident',
  computeCuratedTopStoryBlendScore({
    title: 'Russia announces major new nuclear force deployment',
    priorityScore: 82,
    corroboratingSourceCount: 2,
  }) === 89,
);
check(
  'major Ukraine theater change keeps normal ranking without U.S. wording',
  computeCuratedTopStoryBlendScore({
    title: 'Ukraine opens new front as major offensive captures regional capital',
    conflictTrack: 'Russia-Ukraine War',
    priorityScore: 82,
    corroboratingSourceCount: 3,
  }) === 96,
);
check(
  'Gaza leadership decapitation keeps normal ranking without U.S. wording',
  computeCuratedTopStoryBlendScore({
    title: 'Hamas leadership decapitation reshapes Gaza war command',
    conflictTrack: 'Israel-Hamas / Gaza',
    priorityScore: 84,
    corroboratingSourceCount: 2,
  }) === 91,
);

const prompt = readFileSync(
  new URL('../server/relevanceDefinition.ts', import.meta.url),
  'utf8',
);
const routes = readFileSync(
  new URL('../server/routes.ts', import.meta.url),
  'utf8',
);
check(
  'shared analyzer calibration names local investigations and vehicle attacks',
  prompt.includes('transport-vehicle attack') &&
    prompt.includes('investigation into troop conduct') &&
    prompt.includes('coverage volume is not consequence'),
);
check(
  'Top Stories uses the shared pure priority and blend helpers',
  routes.includes('priorityScore: calibrateCuratedTopStoryPriority(s)') &&
    routes.includes('computeCuratedTopStoryBlendScore(s)') &&
    !routes.includes('story.priorityScore = calibrateCuratedTopStoryPriority(story)'),
);

if (failures > 0) {
  console.error(`\n[curated-local-conflict-ranking] ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n[curated-local-conflict-ranking] all checks passed');