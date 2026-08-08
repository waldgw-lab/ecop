/**
 * Direct DEV-database regression for atomic manual-link consolidation.
 *
 * Proves:
 *  1. create/refresh + supersede runs in one transaction: a forced revoke
 *     failure rolls the candidate union insert back and leaves the prior row active.
 *  2. an identical retry may refresh the existing row without revoking that same
 *     surviving row when its id appears in the overlap snapshot.
 *
 * Marker rows and the marker-scoped trigger/function are removed in finally.
 * Exit 3 means the database/schema prerequisite is unavailable.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../server/db';
import { curatedManualLinks } from '../shared/schema';
import { storage } from '../server/storage';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INCONCLUSIVE = 3;
const run = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-z0-9_]/gi, '');
const triggerName = `gate_link_consolidate_${run}`;
const functionName = `gate_link_consolidate_fail_${run}`;
const marker = `https://gate.isolation.invalid/link-consolidation/${run}`;
const urlA = `${marker}/a`;
const urlB = `${marker}/b`;
const urlC = `${marker}/c`;
const urlD = `${marker}/d`;
const urlE = `${marker}/e`;
const concurrentA = `${marker}/concurrent-a`;
const concurrentB = `${marker}/concurrent-b`;
const concurrentC = `${marker}/concurrent-c`;

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`[link-consolidation-tx] OK   ${label}`);
  else {
    failures++;
    console.error(`[link-consolidation-tx] FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function markerRows() {
  return db
    .select()
    .from(curatedManualLinks)
    .where(sql`${curatedManualLinks.memberUrls} && ARRAY[
      ${urlA}, ${urlB}, ${urlC}, ${urlD}, ${urlE},
      ${concurrentA}, ${concurrentB}, ${concurrentC}
    ]::text[]`);
}

async function cleanup() {
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON curated_manual_links`));
  await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
  const rows = await markerRows();
  for (const row of rows) {
    await db.delete(curatedManualLinks).where(eq(curatedManualLinks.id, row.id));
  }
}

async function main() {
  try {
    try {
      await db.execute(sql`SELECT 1 FROM curated_manual_links LIMIT 1`);
    } catch (error) {
      console.error(`[link-consolidation-tx] INCONCLUSIVE — database/schema unavailable: ${(error as Error).message}`);
      process.exit(EXIT_INCONCLUSIVE);
    }

    await cleanup();

    const prior = await storage.createCuratedManualLink({
      memberUrls: [urlA, urlB],
      kind: 'link',
      label: 'transaction rollback prior',
      createdBy: 'gate-link-consolidation',
      aiVerdict: 'skipped',
      aiReasoning: '',
      overrodeAi: false,
      status: 'active',
    });

    // The trigger raises only when this marker row is revoked. The consolidated
    // method first inserts [A,B,C], then attempts this update; PostgreSQL must
    // roll the insert back with the update failure.
    await db.execute(sql.raw(`
      CREATE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced marker supersede failure';
      END;
      $$
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE ON curated_manual_links
      FOR EACH ROW
      WHEN (OLD.id = '${prior.id}'::varchar)
      EXECUTE FUNCTION ${functionName}()
    `));

    let threw = false;
    let thrownMessage = '';
    try {
      await storage.createCuratedManualLinkConsolidated({
        memberUrls: [urlA, urlB, urlC],
        kind: 'link',
        label: 'candidate union must roll back',
        createdBy: 'gate-link-consolidation',
        aiVerdict: 'concur',
        aiReasoning: 'forced rollback test',
        overrodeAi: false,
        status: 'active',
      }, { absorbOverlaps: true, effectiveUrlCap: 20 });
    } catch (error) {
      threw = true;
      thrownMessage = String((error as Error).message);
    }
    check('forced supersede failure propagates', threw, thrownMessage);

    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON curated_manual_links`));
    await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));

    const afterRollback = await markerRows();
    const priorAfter = afterRollback.find((row) => row.id === prior.id);
    const escapedUnion = afterRollback.find(
      (row) => row.memberUrls.includes(urlA) && row.memberUrls.includes(urlB) && row.memberUrls.includes(urlC),
    );
    check('prior row remains active after rollback', priorAfter?.status === 'active', priorAfter?.status ?? 'missing');
    check('candidate union insert did not escape transaction', !escapedUnion, escapedUnion?.id ?? '');

    const exact = await storage.createCuratedManualLink({
      memberUrls: [urlD, urlE],
      kind: 'merge',
      label: 'exact retry original',
      createdBy: 'gate-link-consolidation',
      aiVerdict: 'skipped',
      aiReasoning: '',
      overrodeAi: false,
      status: 'active',
    });
    const refreshed = await storage.createCuratedManualLinkConsolidated({
      memberUrls: [urlE, urlD],
      kind: 'merge',
      label: 'exact retry refreshed',
      createdBy: 'gate-link-consolidation-retry',
      aiVerdict: 'concur',
      aiReasoning: 'refresh',
      overrodeAi: false,
      status: 'active',
    }, { absorbOverlaps: true, effectiveUrlCap: 20 });
    const persistedRetry = (await markerRows()).find((row) => row.id === exact.id);
    check('identical retry refreshes the existing survivor', refreshed.row.id === exact.id, `${exact.id}/${refreshed.row.id}`);
    check('identical retry does not self-revoke', persistedRetry?.status === 'active', persistedRetry?.status ?? 'missing');
    check('identical retry refresh fields persist', persistedRetry?.label === 'exact retry refreshed', persistedRetry?.label ?? 'missing');

    const [first, second] = await Promise.all([
      storage.createCuratedManualLinkConsolidated({
        memberUrls: [concurrentA, concurrentB],
        kind: 'link',
        label: 'concurrent first',
        createdBy: 'gate-link-consolidation',
        aiVerdict: 'skipped',
        aiReasoning: '',
        overrodeAi: false,
        status: 'active',
      }, { absorbOverlaps: true, effectiveUrlCap: 20 }),
      storage.createCuratedManualLinkConsolidated({
        memberUrls: [concurrentB, concurrentC],
        kind: 'merge',
        label: 'concurrent second',
        createdBy: 'gate-link-consolidation',
        aiVerdict: 'skipped',
        aiReasoning: '',
        overrodeAi: false,
        status: 'active',
      }, { absorbOverlaps: true, effectiveUrlCap: 20 }),
    ]);
    const concurrentActive = (await markerRows()).filter(
      (row) => row.status === 'active' && row.memberUrls.some((url) => url.startsWith(`${marker}/concurrent-`)),
    );
    check(
      'concurrent overlapping writes serialize to one active effective union',
      concurrentActive.length === 1
        && [concurrentA, concurrentB, concurrentC].every((url) => concurrentActive[0].memberUrls.includes(url)),
      JSON.stringify({ first: first.row.id, second: second.row.id, active: concurrentActive }),
    );
  } catch (error) {
    failures++;
    console.error('[link-consolidation-tx] FAIL unexpected error:', error);
  } finally {
    try {
      await cleanup();
      check('cleanup removed every marker row', (await markerRows()).length === 0);
    } catch (error) {
      failures++;
      console.error('[link-consolidation-tx] FAIL cleanup:', error);
    }
  }

  console.log(`[link-consolidation-tx] ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? EXIT_PASS : EXIT_FAIL);
}

void main();