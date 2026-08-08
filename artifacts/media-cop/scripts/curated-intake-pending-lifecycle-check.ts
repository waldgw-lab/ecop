// Verification gate for the honest-funnel telemetry lifecycle (Task #1114):
// mergeCuratedIntakeFeedStats sets admission_pending (kept>0) + records fetch
// failures; upsertCuratedIntakeTelemetry clears it, writes deferred, preserves
// feed stats; kept=0 and explicit overrides never mark pending.
// Run: npx tsx scripts/curated-intake-pending-lifecycle-check.ts
import { storage } from '../server/storage';
import { db } from '../server/db';
import { sql } from 'drizzle-orm';

const SRC = '__t1114_lifecycle_check__';
async function row() {
  const r = await db.execute(sql`SELECT fetched, kept, ingested, drop_dup_url, deferred, fetch_failures, last_fetch_error, admission_pending, invalid_only_streak FROM curated_intake_telemetry WHERE source_name = ${SRC}`);
  return (r as any).rows[0];
}
(async () => {
  let fail = 0;
  const check = (name: string, cond: boolean) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fail++; };

  // 1. Feed-stats write with kept>0 → admission_pending true, counters zeroed, fetch failure recorded.
  await storage.mergeCuratedIntakeFeedStats(new Map([[SRC, { fetched: 10, kept: 4, aged: 6, dupInPass: 0, fetchFailures: 1, lastFetchError: 'HTTP 403' }]]));
  let r = await row();
  check('merge sets admission_pending when kept>0', r.admission_pending === true);
  check('merge stores fetch failure + reason', r.fetch_failures === 1 && r.last_fetch_error === 'HTTP 403');
  check('merge zeroes admission counters', r.ingested === 0 && r.deferred === 0);

  // 2. Admission write lands → pending cleared, deferred recorded, feed stats preserved.
  await storage.upsertCuratedIntakeTelemetry([{ sourceName: SRC, lastLabel: 'rss', lastRunAt: new Date(), ingested: 1, dropInvalid: 0, dropDupUrl: 2, dropDupBatch: 0, dropRelevanceRejected: 0, dropRelevanceFinance: 0, dropGateUnscored: 0, dropFuzzyDup: 0, dropBlocked: 0, deferred: 1 }]);
  r = await row();
  check('upsert clears admission_pending', r.admission_pending === false);
  check('upsert writes deferred + admission counters', r.deferred === 1 && r.ingested === 1 && r.drop_dup_url === 2);
  check('upsert preserves feed stats (fetched/kept/fetch_failures)', r.fetched === 10 && r.kept === 4 && r.fetch_failures === 1);

  // 3. Next pass, feed yields nothing kept → not pending.
  await storage.mergeCuratedIntakeFeedStats(new Map([[SRC, { fetched: 5, kept: 0, aged: 5, dupInPass: 0 }]]));
  r = await row();
  check('merge with kept=0 not pending', r.admission_pending === false);
  check('merge resets deferred + clears fetch error', r.deferred === 0 && r.fetch_failures === 0 && r.last_fetch_error === null);

  // 4. Explicit admissionPending:false override (drain-guard style, kept>0).
  await storage.mergeCuratedIntakeFeedStats(new Map([[SRC, { fetched: 100, kept: 3, aged: 0, dupInPass: 0, admissionPending: false }]]));
  r = await row();
  check('explicit admissionPending:false override honored', r.admission_pending === false);

  // 5. One bad payload is informational; only a consecutive invalid-only pass
  // becomes an operational alert in Source Oversight.
  const invalidOnly = {
    sourceName: SRC,
    lastLabel: 'rss',
    lastRunAt: new Date(),
    ingested: 0,
    dropInvalid: 1,
    dropDupUrl: 0,
    dropDupBatch: 0,
    dropRelevanceRejected: 0,
    dropRelevanceFinance: 0,
    dropGateUnscored: 0,
    dropFuzzyDup: 0,
    dropBlocked: 0,
    deferred: 0,
  };
  await storage.upsertCuratedIntakeTelemetry([invalidOnly]);
  r = await row();
  check('first invalid-only pass starts an informational streak', r.invalid_only_streak === 1);
  await storage.upsertCuratedIntakeTelemetry([{ ...invalidOnly, lastRunAt: new Date() }]);
  r = await row();
  check('second invalid-only pass persists the actionable streak', r.invalid_only_streak === 2);
  await storage.upsertCuratedIntakeTelemetry([{ ...invalidOnly, lastRunAt: new Date(), ingested: 1, dropInvalid: 0 }]);
  r = await row();
  check('a normal admitted pass clears the invalid-only streak', r.invalid_only_streak === 0);

  await db.execute(sql`DELETE FROM curated_intake_telemetry WHERE source_name = ${SRC}`);
  console.log(fail === 0 ? 'ALL LIFECYCLE CHECKS PASSED' : `${fail} CHECK(S) FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})();
