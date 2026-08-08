/**
 * Gate: joe-priorities-bolo-bounded-query
 *
 * Asserts that the /api/team/joe-priorities-bolo endpoint handler never
 * performs an unbounded full-table scan of team_submissions.  The old code
 * did a bare `.select().from(teamSubmissions).where(status='processed')`
 * without any joe_priority_subject_id filter or time bound, loading ~63k
 * rows on every request.
 *
 * The gate checks the source code statically so it runs instantly and needs
 * no live server.  Exit 0 = PASS, Exit 1 = FAIL.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROUTES_FILE = path.resolve(process.cwd(), 'server/routes.ts');

function main() {
  const src = fs.readFileSync(ROUTES_FILE, 'utf8');

  // Find the handler block by locating the app.get declaration.
  // The handler is: app.get("/api/team/joe-priorities-bolo", requireTeamMember, ...
  const handlerDecl = 'app.get("/api/team/joe-priorities-bolo"';
  const handlerStart = src.indexOf(handlerDecl);
  if (handlerStart === -1) {
    console.error('[gate] Could not find app.get("/api/team/joe-priorities-bolo") in server/routes.ts');
    process.exit(1);
  }

  // Extract enough source to cover the full handler body (~12,000 chars)
  const handlerSnippet = src.slice(handlerStart, handlerStart + 12000);

  // FAIL: the old pattern — a .select() from teamSubmissions filtered only by
  // status='processed' and deletedAt (no joePrioritySubjectId IS NOT NULL guard).
  // The specific old signature was:
  //   .where(and(eq(teamSubmissions.status, 'processed'), isNull(teamSubmissions.deletedAt)))
  // without an isNotNull(joePrioritySubjectId) clause anywhere in the same where().
  const unboundedPattern = /\.select\(\s*\)\s*[\s\S]{0,200}?\.from\(\s*teamSubmissions\s*\)\s*[\s\S]{0,200}?\.where\(\s*and\(\s*eq\(\s*teamSubmissions\.status[^)]*\)\s*,\s*isNull\(\s*teamSubmissions\.deletedAt\s*\)\s*\)\s*\)/;
  if (unboundedPattern.test(handlerSnippet)) {
    console.error('[gate] FAIL: /api/team/joe-priorities-bolo still contains an unbounded');
    console.error('[gate]       full-table scan of teamSubmissions (no joePrioritySubjectId filter).');
    console.error('[gate]       Fix: add isNotNull(teamSubmissions.joePrioritySubjectId) and a time bound.');
    process.exit(1);
  }

  // PASS: verify the required guards ARE present in the handler
  const hasNotNullFilter = handlerSnippet.includes('isNotNull(teamSubmissions.joePrioritySubjectId)');
  const hasTimeBound = handlerSnippet.includes('THIRTY_DAYS_AGO') || handlerSnippet.includes('gte(teamSubmissions.createdAt');
  const hasAggregate = handlerSnippet.includes('count(*)') && handlerSnippet.includes('totalCount');

  if (!hasNotNullFilter) {
    console.error('[gate] FAIL: missing isNotNull(teamSubmissions.joePrioritySubjectId) filter in handler.');
    process.exit(1);
  }
  if (!hasTimeBound) {
    console.error('[gate] FAIL: missing time-bound (createdAt >= window) in handler submissions query.');
    process.exit(1);
  }
  if (!hasAggregate) {
    console.error('[gate] FAIL: missing count aggregate for totalCount — per-topic counts must come from SQL, not full row shipping.');
    process.exit(1);
  }

  console.log('[gate] PASS: /api/team/joe-priorities-bolo uses a bounded query with joePrioritySubjectId filter, time window, and count aggregate.');
  process.exit(0);
}

main();
