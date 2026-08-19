/**
 * Regression gate: attached Curated coverage stays visible without gaining
 * ranking or freshness authority.
 *
 * Pure score/date checks plus narrow static wiring assertions; no DB/network/AI.
 */
import { readFileSync } from 'node:fs';
import {
  computeClusterPriorityScore,
  freshestRankingMemberAt,
  type MemberScoreInput,
} from '../server/curatedClusterScore';
import { computeCuratedTopStoryBlendScore } from '../server/curatedTopStoryRanking';
import { deriveBehavior } from '../shared/outletRegistry';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`[attach-ranking-isolation] OK   ${label}`);
  } else {
    failures++;
    console.error(
      `[attach-ranking-isolation] FAIL ${label}${detail ? ` — ${detail}` : ''}`,
    );
  }
}

const oldA = new Date('2026-08-03T10:00:00.000Z');
const oldB = new Date('2026-08-03T10:05:00.000Z');
const freshSocial = new Date('2026-08-04T09:55:00.000Z');

const corroboratingOnly: MemberScoreInput[] = [
  {
    originalPriority: 60,
    scrapedAt: oldA,
    articlePublishedAt: oldA,
    confirmed: true,
    contributesToRanking: true,
    publisherKey: 'apnews.com',
  },
  {
    originalPriority: 55,
    scrapedAt: oldB,
    articlePublishedAt: oldB,
    confirmed: true,
    contributesToRanking: true,
    publisherKey: 'reuters.com',
  },
];
const withFreshAttachedSocial: MemberScoreInput[] = [
  ...corroboratingOnly,
  {
    originalPriority: 99,
    scrapedAt: freshSocial,
    articlePublishedAt: freshSocial,
    confirmed: true,
    contributesToRanking: false,
    publisherKey: 'truthsocial.com',
  },
];

const coreScore = computeClusterPriorityScore(
  corroboratingOnly,
  60,
  oldA,
);
const socialScore = computeClusterPriorityScore(
  withFreshAttachedSocial,
  60,
  oldA,
);
check(
  'fresh high-priority attached social cannot raise the cluster P-score',
  socialScore === coreScore,
  `core=${coreScore} withSocial=${socialScore}`,
);

const freshest = freshestRankingMemberAt(withFreshAttachedSocial);
check(
  'attached social cannot refresh the cluster effective date',
  freshest?.toISOString() === oldB.toISOString(),
  `got=${freshest?.toISOString() ?? 'null'}`,
);

const attachedOnly: MemberScoreInput[] = withFreshAttachedSocial.slice(2);
check(
  'all-attached force-merge has no effective freshness',
  freshestRankingMemberAt(attachedOnly) === null,
);

const routes = readFileSync(
  new URL('../server/routes.ts', import.meta.url),
  'utf8',
);
check(
  'route grants ranking authority only to corroborating members',
  routes.includes("m.behaviorClass === 'corroborating'") &&
    routes.includes("behaviorFor(m.source, m.url).cls === 'corroborating'"),
);
check(
  'visible source count still includes every confirmed attached member',
  routes.includes('sourceCount: confirmedMembers.length'),
);
check(
  'ranking boost uses corroborating count instead of visible total',
  computeCuratedTopStoryBlendScore({
    priorityScore: 50,
    sourceCount: 10,
    corroboratingSourceCount: 2,
    title: 'Pentagon budget bill advances in Congress',
  }) === 57 &&
    routes.includes('computeCuratedTopStoryBlendScore(s)'),
);
check(
  'all-non-corroborating force-merge cannot use an attached timestamp or priority pin',
  routes.includes('clusterOverride != null && overrideAnchor') &&
    routes.includes('scrapedAt: hasRankingMember ?') &&
    routes.includes('articlePublishedAt: hasRankingMember') &&
    routes.includes('priorityOverride: hasRankingMember ?'),
);
check(
  'official social taxonomy remains attach-only pending a narrower anchor role',
  deriveBehavior({
    sourceIdentifier: 'social-us-official',
    factuality: 'high',
  }).cls === 'attach',
);

if (failures > 0) {
  console.error(
    `\n[attach-ranking-isolation] ${failures} check(s) FAILED`,
  );
  process.exit(1);
}
console.log('\n[attach-ranking-isolation] all checks passed');