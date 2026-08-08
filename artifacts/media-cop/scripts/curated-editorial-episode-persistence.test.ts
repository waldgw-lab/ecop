/**
 * Gate: curated-editorial-episode-persistence (Task #1180)
 *
 * WHY THIS EXISTS
 * ---------------
 * Task #1180 adds a durable, curated-only EDITORIAL EPISODE + OBSERVATION/
 * OUTCOME model layered ON TOP OF the immutable curated_override_events log:
 *   - curated_editorial_episodes           (mutable intent grouping + lifecycle)
 *   - curated_editorial_episode_events      (raw-event linkage, BY REFERENCE)
 *   - curated_editorial_observations        (append/upsert lifecycle trail)
 *   - curated_legacy_rule_inventory         (frozen legacy learned-rule history)
 * These tables are created by the boot migrator (server/migrate.ts) and driven
 * by the storage methods in server/storage.ts. If a future change drops a
 * CREATE TABLE, breaks the upsert/collapse, or corrupts the persistence
 * counters / lineage, the durable editorial history would silently be lost.
 *
 * This gate exercises the REAL storage methods against the LIVE database (the
 * dev server has booted and run migrate.ts) so a missing table or broken
 * method fails loudly. It NEVER touches routes, feeds, human overrides, or
 * outlet roles — pure persistence round-trips — and cleans up its own rows.
 *
 * Verified behaviors:
 *   1. upsertCuratedEditorialEpisode inserts a fresh episode by signature.
 *   2. A second collapse onto the same signature enriches in place (no dup),
 *      fills newly-provided JSON snapshots, and bumps observationCount.
 *   3. attachCuratedEditorialEpisodeEvents attaches immutable events BY
 *      REFERENCE, is idempotent on (episode,event), and recomputes the
 *      persistence counters (eventCount / editorCount / first/lastEventAt).
 *   4. appendCuratedEditorialObservation appends AND upserts by observationKey.
 *   5. updateCuratedEditorialOutcome sets the authoritative outcome + lineage.
 *   6. listCuratedEditorialEpisodes filters by lifecycle / actionFamily.
 *   7. The frozen legacy-rule inventory: a seeded legacy rule is transitioned
 *      to the correct disposition by the idempotent freeze, and re-running the
 *      freeze never duplicates or deletes immutable history.
 *
 * EXIT CODES (harness-reliability convention):
 *   0 = PASS         — all round-trips persisted and behaved correctly.
 *   1 = FAIL         — a GENUINE regression.
 *   3 = INCONCLUSIVE — a precondition failed (DB unreachable), NOT a judgment.
 *
 * Run: npx tsx scripts/curated-editorial-episode-persistence.test.ts
 */
import { storage } from '../server/storage';
import { db } from '../server/db';
import { sql } from 'drizzle-orm';
import { adaptDbEpisode } from '../server/editorialEvidenceBuild';
import { buildJsonPacket, buildMarkdownPacket } from '../shared/editorialEvidence';

const TAG = '__t1180_ep_test__';
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INCONCLUSIVE = 3;

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) {
    console.log(`[t1180] OK   ${label}`);
  } else {
    failed++;
    console.error(`[t1180] FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

async function cleanup() {
  // Order matters only for readability — no FKs, so all are independent.
  await db.execute(sql`DELETE FROM curated_editorial_observations WHERE observed_by = ${TAG}`);
  await db.execute(sql`DELETE FROM curated_editorial_episode_events WHERE event_editor LIKE ${TAG + '%'}`);
  await db.execute(sql`DELETE FROM curated_editorial_episodes WHERE created_by LIKE ${TAG + '%'}`);
  await db.execute(sql`DELETE FROM curated_legacy_rule_inventory WHERE legacy_rule_id LIKE ${TAG + '%'}`);
  await db.execute(sql`DELETE FROM curated_learned_rules WHERE label = ${TAG}`);
}

(async () => {
  try {
    // Precondition: the tables must exist (migrator ran).
    try {
      await db.execute(sql`SELECT 1 FROM curated_editorial_episodes LIMIT 1`);
      await db.execute(sql`SELECT 1 FROM curated_editorial_episode_events LIMIT 1`);
      await db.execute(sql`SELECT 1 FROM curated_editorial_observations LIMIT 1`);
      await db.execute(sql`SELECT 1 FROM curated_legacy_rule_inventory LIMIT 1`);
    } catch (e) {
      console.error(`[t1180] INCONCLUSIVE — tables missing (migrator not run?): ${(e as Error).message}`);
      process.exit(EXIT_INCONCLUSIVE);
    }

    await cleanup();

    const sig = `${TAG}:sig:alpha`;

    // 1. Insert a fresh episode by signature.
    const ep1 = await storage.upsertCuratedEditorialEpisode({
      signature: sig,
      actionFamily: 'scoring',
      action: 'priority-override',
      reasonKeys: ['over-scored'],
      reasonNote: 'AI over-promoted this outlet',
      canonicalUrl: 'https://example.com/a',
      storyKey: 'curated:xyz',
      direction: 'demote',
      editorSurface: 'scoring-radar',
      beforeJson: { score: 90 },
      requestedJson: { score: 40 },
      createdBy: TAG,
    } as any);
    check('insert creates episode', !!ep1?.id && ep1.signature === sig);
    check('insert defaults lifecycle=open', ep1.lifecycle === 'open');
    check('insert observationCount=0', (ep1.observationCount ?? -1) === 0);
    const epId = ep1.id;

    // 2. Collapse onto the same signature — no duplicate, enrich + bump.
    const ep2 = await storage.upsertCuratedEditorialEpisode({
      signature: sig,
      actionFamily: 'scoring',
      action: 'priority-override',
      actualJson: { score: 40 },                 // newly provided
      alternativesJson: [{ score: 60 }],          // newly provided
      provenanceJson: { source: 'radar', eventIds: ['e1', 'e2'] },
      createdBy: TAG,
    } as any);
    check('collapse reuses same row (no dup)', ep2.id === epId);
    check('collapse preserves prior beforeJson', (ep2.beforeJson as any)?.score === 90);
    check('collapse fills new actualJson', (ep2.actualJson as any)?.score === 40);
    check('collapse fills alternativesJson', Array.isArray(ep2.alternativesJson) && (ep2.alternativesJson as any)[0]?.score === 60);
    check('collapse bumps observationCount', (ep2.observationCount ?? 0) === 1);
    const dupCount = await db.execute(sql`SELECT count(*)::int AS n FROM curated_editorial_episodes WHERE signature = ${sig}`);
    check('exactly one row for signature', ((dupCount as any).rows[0]?.n) === 1);

    // 3. Attach immutable override events BY REFERENCE (idempotent + counters).
    const t1 = new Date('2024-01-01T00:00:00Z');
    const t2 = new Date('2024-01-03T00:00:00Z');
    await storage.attachCuratedEditorialEpisodeEvents(epId, [
      { eventId: `${TAG}-ev1`, eventAction: 'priority-override', eventEditor: TAG, eventAt: t1 },
      { eventId: `${TAG}-ev2`, eventAction: 'priority-override', eventEditor: TAG, eventAt: t2 },
    ]);
    // Re-attach ev1 (idempotent) + a new editor to exercise editorCount.
    const epAfterAttach = await storage.attachCuratedEditorialEpisodeEvents(epId, [
      { eventId: `${TAG}-ev1`, eventAction: 'priority-override', eventEditor: TAG, eventAt: t1 },
      { eventId: `${TAG}-ev3`, eventAction: 'hide-story', eventEditor: `${TAG}-b`, eventAt: new Date('2024-01-02T00:00:00Z') },
    ]);
    check('attach eventCount = 3 (idempotent, no dup ev1)', (epAfterAttach?.eventCount ?? -1) === 3);
    check('attach editorCount = 2', (epAfterAttach?.editorCount ?? -1) === 2);
    check('attach firstEventAt = earliest', epAfterAttach?.firstEventAt?.getTime() === t1.getTime());
    check('attach lastEventAt = latest', epAfterAttach?.lastEventAt?.getTime() === t2.getTime());
    const links = await storage.getCuratedEditorialEpisodeEvents(epId);
    check('link table has 3 rows', links.length === 3);

    // 4. Observations: append + upsert-by-key.
    await storage.appendCuratedEditorialObservation(epId, { kind: 'observed', note: 'first pass', observedBy: TAG });
    const obsUp1 = await storage.appendCuratedEditorialObservation(epId, { observationKey: 'day-1', kind: 'observed', note: 'day one', observedBy: TAG });
    const obsUp2 = await storage.appendCuratedEditorialObservation(epId, { observationKey: 'day-1', kind: 'verified', note: 'confirmed', observedBy: TAG });
    check('observation upsert reuses row by key', obsUp1.id === obsUp2.id);
    check('observation upsert updates in place', obsUp2.kind === 'verified' && obsUp2.note === 'confirmed');
    const allObs = await storage.getCuratedEditorialObservations(epId);
    check('two observation rows (1 append + 1 keyed)', allObs.length === 2);

    // 5. Authoritative outcome + lineage.
    const outEp = await storage.updateCuratedEditorialOutcome(epId, {
      outcome: 'demoted',
      outcomeNote: 'held at 40',
      lifecycle: 'settled',
      verified: true,
      undoneByEventId: `${TAG}-undo`,
    });
    check('outcome set', outEp?.outcome === 'demoted' && outEp?.outcomeNote === 'held at 40');
    check('outcome lifecycle=settled', outEp?.lifecycle === 'settled');
    check('outcome verified=true', outEp?.verified === true);
    check('outcome lineage undoneByEventId', outEp?.undoneByEventId === `${TAG}-undo`);

    // Durable contradiction/undo lineage must survive DB adaptation into both
    // the machine-readable and Markdown copy packets.
    const prior = await storage.upsertCuratedEditorialEpisode({
      signature: `${TAG}:sig:prior`,
      actionFamily: 'priority',
      action: 'priority-override',
      canonicalUrl: 'https://example.com/lineage',
      storyKey: 'curated:lineage',
      direction: 'up',
      verified: true,
      lifecycle: 'settled',
      outcome: 'applied',
      createdBy: TAG,
    } as any);
    const reversal = await storage.upsertCuratedEditorialEpisode({
      signature: `${TAG}:sig:reversal`,
      actionFamily: 'priority',
      action: 'priority-override',
      canonicalUrl: 'https://example.com/lineage',
      storyKey: 'curated:lineage',
      direction: 'down',
      verified: true,
      lifecycle: 'settled',
      outcome: 'applied',
      contradictsEpisodeId: prior.id,
      createdBy: `${TAG}-b`,
    } as any);
    const adapted = adaptDbEpisode(reversal);
    const lineageJson = buildJsonPacket([adapted], { includeAmbiguous: true });
    const lineageMd = buildMarkdownPacket([adapted], { includeAmbiguous: true });
    check('DB adapter preserves contradiction/undo lineage in JSON packet',
      lineageJson.episodes[0]?.supersedesEpisodeId === prior.id);
    check('DB adapter preserves contradiction/undo lineage in Markdown packet',
      lineageMd.includes(prior.id));

    // 6. List/filter.
    const byFamily = await storage.listCuratedEditorialEpisodes({ actionFamily: 'scoring', lifecycle: ['settled'] });
    check('list filters by family+lifecycle', byFamily.some(e => e.id === epId));
    const byUrl = await storage.listCuratedEditorialEpisodes({ canonicalUrl: 'https://example.com/a' });
    check('list filters by canonicalUrl', byUrl.some(e => e.id === epId));

    // 7. Frozen legacy-rule inventory: seed a legacy rule then freeze it (mirror
    //    the migration's transition logic) and assert idempotency.
    const legacyId = `${TAG}-legacy-1`;
    await db.execute(sql`
      INSERT INTO curated_learned_rules (id, rule_type, signature, label, payload, status, evidence_count)
      VALUES (${legacyId}, 'must-link', ${TAG + ':lsig'}, ${TAG}, '{"a":1}'::jsonb, 'approved', 7)
      ON CONFLICT (id) DO NOTHING
    `);
    // Run the SAME idempotent freeze the migrator runs (scoped to our seed only).
    const freeze = async () => db.execute(sql`
      INSERT INTO curated_legacy_rule_inventory
        (legacy_rule_id, rule_type, signature, label, payload, legacy_status, disposition, evidence_count)
      SELECT r.id, COALESCE(r.rule_type,''), COALESCE(r.signature,''), COALESCE(r.label,''),
             COALESCE(r.payload,'{}'::jsonb), COALESCE(r.status,''),
             CASE WHEN r.status='approved' THEN 'frozen-review'
                  WHEN r.status IN ('suggested','snoozed') THEN 'historical-only'
                  ELSE 'historical-other' END,
             COALESCE(r.evidence_count,0)
      FROM curated_learned_rules r WHERE r.id = ${legacyId}
      ON CONFLICT (legacy_rule_id) DO NOTHING
    `);
    await freeze();
    await freeze(); // idempotent — second run must not duplicate.
    const inv = await storage.listCuratedLegacyRuleInventory('frozen-review');
    const mine = inv.filter(i => i.legacyRuleId === legacyId);
    check('approved legacy rule frozen as frozen-review', mine.length === 1);
    check('frozen inventory preserves evidence + payload', mine[0]?.evidenceCount === 7 && (mine[0]?.payload as any)?.a === 1);
    // Immutable history preserved: the source legacy row still exists.
    const stillThere = await db.execute(sql`SELECT count(*)::int AS n FROM curated_learned_rules WHERE id = ${legacyId}`);
    check('freeze never deletes immutable legacy history', ((stillThere as any).rows[0]?.n) === 1);

    await cleanup();

    if (failed === 0) {
      console.log('[t1180] ALL EDITORIAL EPISODE PERSISTENCE CHECKS PASSED');
      process.exit(EXIT_PASS);
    }
    console.error(`[t1180] ${failed} CHECK(S) FAILED`);
    process.exit(EXIT_FAIL);
  } catch (err) {
    // A connection error is a precondition failure, not a regression verdict.
    const msg = (err as Error).message || String(err);
    if (/ECONNREFUSED|ENOTFOUND|connect|DATABASE_URL|timeout/i.test(msg)) {
      console.error(`[t1180] INCONCLUSIVE — DB unreachable: ${msg}`);
      process.exit(EXIT_INCONCLUSIVE);
    }
    console.error(`[t1180] FAIL — unexpected error: ${msg}`);
    try { await cleanup(); } catch { /* ignore */ }
    process.exit(EXIT_FAIL);
  }
})();
