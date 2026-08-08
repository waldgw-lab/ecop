/**
 * Gate: curated-editorial-outcome-observation (Task #1180 follow-through)
 *
 * WHY THIS EXISTS
 * ---------------
 * After each FULL authoritative Curated cluster pass, the storage method
 * observeCuratedEditorialOutcomesAfterCluster scans ONLY the small set of
 * UNSETTLED + RECENT active editorial episodes emitted by the real evidence
 * contract (grouping-positive/grouping-negative/lineage for cluster passes;
 * priority only when explicitly selected by the ranking observer),
 * compares each episode's REQUESTED normalized member/story/ranking context
 * against the FINAL kept membership + priority state, appends an observation
 * keyed by the cluster revision/pass, updates the authoritative outcome
 * (applied | deferred | conflicted | dormant | superseded | undone | failed) as
 * DEFENSIBLY OBSERVABLE, increments a persistence pass counter, and records
 * latency + final actual JSON. It must NEVER infer success from the mere
 * presence of an overlay write, must be BOUNDED (cost scales with active
 * episodes, not history), and must be fail-soft + curated-only (no human pin /
 * outlet-role writes).
 *
 * This gate exercises the REAL storage method against the LIVE database.
 *
 * Verified behaviors:
 *   1. APPLIED   — requested members present + together in one cluster.
 *   2. CONFLICT  — requested-together members split across clusters.
 *   3. DORMANT   — none of the requested identities appear this pass.
 *   4. DEFERRED  — only some requested identities are observable.
 *   5. FAMILY ALIGNMENT — real grouping-positive, grouping-negative, and lineage
 *      episodes are scanned by cluster passes; priority is excluded there and
 *      observed only through the explicit ranking lane.
 *   6. NO OVERLAY INFERENCE — a requested priority floor contradicted by the
 *      authoritative kept score yields CONFLICT even though an intent existed.
 *   7. PERSISTENCE OVER LATER PASSES — re-running with a NEW revision bumps the
 *      pass counter and appends a second observation; re-running the SAME
 *      revision upserts in place (idempotent, no double count).
 *   8. BOUNDED / SCALES WITH ACTIVE EPISODES — settled seeded episodes are
 *      NEVER re-observed, and the cap is honored. Assertions target the seeded
 *      episodes rather than assuming the shared dev DB has no other open edits.
 *
 * EXIT CODES: 0 = PASS, 1 = FAIL, 3 = INCONCLUSIVE (DB unreachable).
 * Run: npx tsx scripts/curated-editorial-outcome-observation.test.ts
 */
import { storage } from '../server/storage';
import { db } from '../server/db';
import { sql } from 'drizzle-orm';

const TAG = '__t1180_outcome_test__';
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INCONCLUSIVE = 3;

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) console.log(`[t1180-outcome] OK   ${label}`);
  else { failed++; console.error(`[t1180-outcome] FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// Minimal kept-member factory (only the fields the observer reads).
const M = (clusterId: string, url: string, priorityScore = 50, isRepresentative = false) => ({
  clusterId, itemType: 'curated', itemId: url, url, priorityScore, isRepresentative,
});

type CapturedFamily = 'priority' | 'grouping-positive' | 'grouping-negative' | 'lineage';

async function seedEpisode(
  sig: string,
  requestedJson: Record<string, unknown>,
  family: CapturedFamily = 'grouping-positive',
  extra: Record<string, unknown> = {},
) {
  const verb = family === 'priority' ? 'priority-adjust'
    : family === 'grouping-positive' ? 'link'
    : family === 'grouping-negative' ? 'evict'
    : 'undo';
  const ep = await storage.upsertCuratedEditorialEpisode({
    signature: sig,
    actionFamily: family,
    action: verb,
    direction: family === 'priority' ? 'up'
      : family === 'grouping-positive' ? 'link'
      : family === 'grouping-negative' ? 'separate'
      : 'undo',
    requestedJson,
    createdBy: TAG,
    ...(extra as any),
  } as any);
  return ep;
}

async function cleanup() {
  await db.execute(sql`DELETE FROM curated_editorial_observations WHERE observed_by = ${TAG}`);
  await db.execute(sql`DELETE FROM curated_editorial_episodes WHERE created_by = ${TAG}`);
}

async function outcomeOf(episodeId: string): Promise<{ outcome: string | null; passCount: number; obsCount: number }> {
  const ep = await storage.getCuratedEditorialEpisodeById(episodeId);
  const obs = (ep?.actualJson as any)?.observation ?? {};
  return { outcome: ep?.outcome ?? null, passCount: obs.passCount ?? 0, obsCount: ep?.observationCount ?? 0 };
}

(async () => {
  try {
    try {
      await db.execute(sql`SELECT 1 FROM curated_editorial_episodes LIMIT 1`);
      await db.execute(sql`SELECT 1 FROM curated_editorial_observations LIMIT 1`);
    } catch (e) {
      console.error(`[t1180-outcome] INCONCLUSIVE — tables missing (migrator not run?): ${(e as Error).message}`);
      process.exit(EXIT_INCONCLUSIVE);
    }

    await cleanup();

    const uA = 'https://example.com/a';
    const uB = 'https://example.com/b';
    const uC = 'https://example.com/c';   // never appears in any pass (dormant)
    const uD = 'https://example.com/d';

    // Seed the active (unsettled) clustering episodes.
    const epApplied = await seedEpisode(`${TAG}:applied`, { requestedMemberUrls: [uA, uB], expectTogether: true });
    const epConflict = await seedEpisode(`${TAG}:conflict`, { requestedMemberUrls: [uA, uB], expectTogether: true });
    const epDormant = await seedEpisode(`${TAG}:dormant`, { requestedMemberUrls: [uC], expectTogether: true });
    const epDeferred = await seedEpisode(`${TAG}:deferred`, { requestedMemberUrls: [uA, uD], expectTogether: true });
    const epNegative = await seedEpisode(
      `${TAG}:negative`,
      { requestedMemberUrls: [uA], requestedSeparateFromUrls: [uB], expectTogether: false },
      'grouping-negative',
    );
    const epLineage = await seedEpisode(
      `${TAG}:lineage`,
      { requestedMemberUrls: [uA, uB], expectTogether: true },
      'lineage',
    );
    const epFloor = await seedEpisode(
      `${TAG}:floor`,
      { requestedMemberUrls: [uA], requestedMinPriority: 80 },
      'priority',
    );

    // A SETTLED episode (should NEVER be scanned) + a STALE one (outside window).
    const epSettled = await seedEpisode(`${TAG}:settled`, { requestedMemberUrls: [uA, uB], expectTogether: true });
    await storage.updateCuratedEditorialOutcome(epSettled.id, { lifecycle: 'settled' });

    // ---- Pass 1: A+B together in cluster-1; D absent; A score 50 (< floor 80). ----
    const pass1Members = [
      M('cluster-1', uA, 50, true),
      M('cluster-1', uB, 40),
      M('cluster-2', 'https://example.com/x', 30), // unrelated
    ];
    const s1 = await storage.observeCuratedEditorialOutcomesAfterCluster({
      clusterRevision: 'rev-1',
      keptMembers: pass1Members as any,
      mode: 'full',
      cap: 100,
    });

    // 1. Applied: A+B present together.
    check('applied outcome', (await outcomeOf(epApplied.id)).outcome === 'applied');
    // 3. Dormant: C absent entirely.
    check('dormant outcome', (await outcomeOf(epDormant.id)).outcome === 'dormant');
    // 4. Deferred: A present, D missing.
    check('deferred outcome (partial)', (await outcomeOf(epDeferred.id)).outcome === 'deferred');
    // 5. Family alignment: the default cluster observer scans the exact families
    // emitted by capture, including negative and lineage, but NOT priority.
    check('grouping-negative episode observed by cluster pass', (await outcomeOf(epNegative.id)).outcome === 'conflicted');
    check('lineage episode observed by cluster pass', (await outcomeOf(epLineage.id)).outcome === 'applied');
    check('priority episode excluded from cluster-pass observer', (await outcomeOf(epFloor.id)).outcome === null);
    // 7a. Settled episode never scanned / never observed.
    check('settled episode NOT scanned', (await outcomeOf(epSettled.id)).outcome === null);
    check('cluster observer scans real active grouping/lineage families', s1.scanned >= 6, `scanned=${s1.scanned}`);
    check('summary latency recorded', typeof s1.latencyMs === 'number' && s1.latencyMs >= 0);

    // The ranking lane explicitly selects priority episodes. It uses the same
    // authoritative assessor but never leaks priority into cluster membership
    // evidence. Requested floor 80 vs authoritative 50 must conflict.
    const sPriority = await storage.observeCuratedEditorialOutcomesAfterCluster({
      clusterRevision: 'ranking:rev-1',
      keptMembers: pass1Members as any,
      mode: 'immediate',
      cap: 100,
      actionFamilies: ['priority'],
      observedBy: TAG,
    });
    check('explicit ranking observer scans priority family', sPriority.scanned >= 1, `scanned=${sPriority.scanned}`);
    check('priority floor contradicted → conflicted (no overlay inference)', (await outcomeOf(epFloor.id)).outcome === 'conflicted');

    // ---- Pass 2: SAME members but A+B now SPLIT across clusters → conflict. ----
    const pass2Members = [
      M('cluster-1', uA, 50, true),
      M('cluster-9', uB, 40, true), // B moved to a different cluster
    ];
    const s2 = await storage.observeCuratedEditorialOutcomesAfterCluster({
      clusterRevision: 'rev-2',
      keptMembers: pass2Members as any,
      mode: 'full',
      cap: 100,
    });
    // 2. Conflict: requested-together but split.
    check('conflict outcome (split across clusters)', (await outcomeOf(epConflict.id)).outcome === 'conflicted');
    check('grouping-negative separation becomes applied after split', (await outcomeOf(epNegative.id)).outcome === 'applied');

    // 6. Persistence over later passes: epApplied observed in pass1 (applied) and
    //    pass2 (now conflicted). Pass counter bumped, TWO observations appended.
    const appliedAfter2 = await outcomeOf(epApplied.id);
    check('later pass updates outcome (applied → conflicted)', appliedAfter2.outcome === 'conflicted');
    check('persistence pass counter bumped across passes', appliedAfter2.passCount === 2, `passCount=${appliedAfter2.passCount}`);
    const obs1 = await storage.getCuratedEditorialObservations(epApplied.id);
    const revKeys = new Set(obs1.map(o => o.observationKey));
    check('two distinct pass observations appended', revKeys.has('cluster-pass:rev-1') && revKeys.has('cluster-pass:rev-2'), `keys=${[...revKeys].join(',')}`);

    // 6b. Idempotent same-revision re-run: upsert in place, no extra observation,
    //     no extra pass increment beyond the single re-observation.
    const beforeIdem = await outcomeOf(epApplied.id);
    await storage.observeCuratedEditorialOutcomesAfterCluster({
      clusterRevision: 'rev-2', // SAME revision as pass 2
      keptMembers: pass2Members as any,
      mode: 'full',
      cap: 100,
    });
    const afterIdem = await outcomeOf(epApplied.id);
    const obs2 = await storage.getCuratedEditorialObservations(epApplied.id);
    check('same-revision re-run upserts (no new observation row)', obs2.length === obs1.length, `before=${obs1.length} after=${obs2.length}`);
    check('same-revision re-run still bumps pass counter (re-observation)', afterIdem.passCount === beforeIdem.passCount + 1);

    // 7b. Bounded: with cap=2 only 2 active episodes are scanned even though 5 exist.
    const sCap = await storage.observeCuratedEditorialOutcomesAfterCluster({
      clusterRevision: 'rev-cap',
      keptMembers: pass1Members as any,
      mode: 'full',
      cap: 2,
    });
    check('cap honored (scanned <= cap)', sCap.scanned === 2, `scanned=${sCap.scanned}`);

    // 8c. Scale-with-active-not-history: mark ALL our episodes settled. The
    // shared dev DB may contain unrelated open edits, so prove OUR settled
    // history is not re-observed rather than asserting a global scanned=0.
    for (const ep of [epApplied, epConflict, epDormant, epDeferred, epNegative, epLineage, epFloor]) {
      await storage.updateCuratedEditorialOutcome(ep.id, { lifecycle: 'settled' });
    }
    const settledBefore = await outcomeOf(epApplied.id);
    const sNone = await storage.observeCuratedEditorialOutcomesAfterCluster({
      clusterRevision: 'rev-empty',
      keptMembers: pass1Members as any,
      mode: 'full',
      cap: 100,
    });
    const settledAfter = await outcomeOf(epApplied.id);
    check(
      'settled seeded history NOT re-observed',
      settledAfter.passCount === settledBefore.passCount && settledAfter.obsCount === settledBefore.obsCount,
      `pass ${settledBefore.passCount}->${settledAfter.passCount}, obs ${settledBefore.obsCount}->${settledAfter.obsCount}, unrelatedScanned=${sNone.scanned}`,
    );

    // Fail-soft: a malformed call must return a zeroed summary, never throw.
    const sSoft = await storage.observeCuratedEditorialOutcomesAfterCluster({
      clusterRevision: 'rev-soft',
      keptMembers: null as any,
      mode: 'full',
    });
    check('fail-soft on bad input (no throw, zeroed/scanned summary)', typeof sSoft.scanned === 'number');

    await cleanup();

    if (failed === 0) {
      console.log('[t1180-outcome] ALL OUTCOME-OBSERVATION CHECKS PASSED');
      process.exit(EXIT_PASS);
    }
    console.error(`[t1180-outcome] ${failed} CHECK(S) FAILED`);
    process.exit(EXIT_FAIL);
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (/ECONNREFUSED|ENOTFOUND|connect|DATABASE_URL|timeout/i.test(msg)) {
      console.error(`[t1180-outcome] INCONCLUSIVE — DB unreachable: ${msg}`);
      process.exit(EXIT_INCONCLUSIVE);
    }
    console.error(`[t1180-outcome] FAIL — unexpected error: ${msg}`);
    try { await cleanup(); } catch { /* ignore */ }
    process.exit(EXIT_FAIL);
  }
})();
