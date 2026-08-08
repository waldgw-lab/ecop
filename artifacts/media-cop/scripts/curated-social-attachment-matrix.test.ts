/**
 * Regression gate for the complete Curated social-attachment lane matrix.
 * Pure/static checks keep approval catalog-driven and prevent a visible feed or
 * Outlet Registry row from becoming an accidental admission path.
 */
import { readFileSync } from 'node:fs';
import {
  CATALOG_CURATED_ATTACHMENT_ACCOUNTS,
  isApprovedCuratedAttachmentAccount,
} from '../shared/socialAccountCatalog';

const failures: string[] = [];
function check(name: string, ok: boolean): void {
  console.log(`[curated-social-matrix] ${ok ? 'OK  ' : 'FAIL'} ${name}`);
  if (!ok) failures.push(name);
}

const approvedLanes = new Set(CATALOG_CURATED_ATTACHMENT_ACCOUNTS.map(a => a.lane));
for (const lane of ['x-default', 'osint', 'journalist', 'rapidresponse', 'dowresponse', 'sentdefender']) {
  check(`approved catalog covers ${lane}`, approvedLanes.has(lane as any));
}
check('influencer lane is never attachment-approved', !approvedLanes.has('x-influencer'));
check('unknown handle fails closed', !isApprovedCuratedAttachmentAccount('not-in-the-catalog'));
check('known influencer fails closed', !isApprovedCuratedAttachmentAccount('IntelCrab'));

for (const account of CATALOG_CURATED_ATTACHMENT_ACCOUNTS) {
  check(
    `enabled catalog identity approves ${account.lane}:${account.handle}`,
    isApprovedCuratedAttachmentAccount(account.handle, account.lane),
  );
}

const ingest = readFileSync('server/curatedIngest.ts', 'utf8');
const routes = readFileSync('server/routes.ts', 'utf8');
const schema = readFileSync('shared/schema.ts', 'utf8');
const migrate = readFileSync('server/migrate.ts', 'utf8');

for (const getter of [
  'getRecentXPostsForCurated',
  'getRecentTruthSocialPostsForCurated',
  'getRecentFirstAlertsForCurated',
  'getCuratedOsintPosts',
  'getCuratedJournalistPosts',
  'getCuratedRapidResponsePosts',
  'getCuratedDOWResponsePosts',
  'getCuratedSentDefenderPosts',
]) {
  check(`social admission loads ${getter}`, ingest.includes(getter));
}
check('catalog approval gates social admission', ingest.includes('isApprovedCuratedAttachmentAccount(handle, lane)'));
check('social admission suppresses still images', ingest.includes('candidates.push({ ...candidate, ogImageUrl: null })'));
check('supported social video is persisted', ingest.includes('videoUrl: c.videoUrl ?? null'));
check('Curated schema owns isolated video field', schema.includes('videoUrl: text("video_url")'));
check('boot migration creates isolated video field', migrate.includes('curated_items ADD COLUMN IF NOT EXISTS video_url'));

for (const getter of [
  'getCuratedRapidResponsePosts',
  'getCuratedDOWResponsePosts',
  'getCuratedSentDefenderPosts',
]) {
  check(`editor picker loads ${getter}`, routes.includes(getter));
}
check('editor picker requires a Curated identity', routes.includes('curatedIdentityUrls.has(identityUrl)'));
check('editor picker deduplicates normalized URL variants', routes.includes('seenUrls.has(identityUrl)'));
check('editor picker excludes unapproved X identities', routes.includes("isApprovedCuratedAttachmentAccount(p.sourceAccount, 'x-default')"));

if (failures.length) {
  console.error(`\n[curated-social-matrix] ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\n[curated-social-matrix] PASS');