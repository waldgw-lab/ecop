/**
 * scripts/cluster-json-format.test.ts
 *
 * Gate: confirm main-feed topic clustering (headlineCluster.ts) and team
 * submission clustering (teamSubmissionCluster.ts) still work after the JSON
 * format change to `{"clusters": [...]}` with response_format json_object.
 *
 * Verifies, against the real dev DB with the AI call stubbed at the mutable
 * `openai.chat.completions.create` seam:
 *   1. Object-wrapped `{"clusters":[...]}` response → fixture rows are grouped
 *      into one cluster with exactly one representative (both lanes).
 *   2. Legacy bare-array response still parses (compat fallback `parsed.clusters ?? parsed`).
 *   3. Markdown-fenced / garbage responses log the distinct
 *      "Malformed AI response" line and apply NO grouping (rows stay unclustered).
 *   4. Empty response applies no grouping and does not crash.
 *
 * Exit codes: 0 = PASS, 1 = FAIL (harness-reliability convention; no live
 * network/AI is used so there is no inconclusive path).
 */

import { openai } from '../server/aiClient';
import { clusterTopStories } from '../server/headlineCluster';
import { clusterSubmissionsForTopic } from '../server/teamSubmissionCluster';
import { db } from '../server/db';
import { headlines, headlineClusters, teamSubjects, teamSubmissions, teamSubmissionClusters } from '../shared/schema';
import { eq, inArray, sql } from 'drizzle-orm';

const RUN = `cljson-${Date.now()}`;
const MARKER = `https://gate.invalid/cluster-json-format/${RUN}`;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS: ${name}`);
  } else {
    failures++;
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---- AI stub seam (mutable method on the exported client object) ----------
const realCreate = openai.chat.completions.create;
let nextContent: string | null = null;
function stubNextResponse(content: string) {
  nextContent = content;
  (openai.chat.completions as any).create = async () => ({
    choices: [{ message: { content: nextContent } }],
  });
}
function restoreAI() {
  (openai.chat.completions as any).create = realCreate;
}

// ---- console.error capture for the malformed-log assertion ---------------
const errLines: string[] = [];
const realError = console.error;
console.error = (...args: any[]) => {
  errLines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  realError(...args);
};

async function seedHeadlines(n: number, tag: string): Promise<string[]> {
  const rows = await db
    .insert(headlines)
    .values(
      Array.from({ length: n }, (_, i) => ({
        title: `Gate fixture ${tag} story variant ${i + 1} ${RUN}`,
        normalizedTitle: `gate fixture ${tag} story variant ${i + 1} ${RUN}`,
        url: `${MARKER}/${tag}/${i + 1}`,
        category: 'test',
        source: `GateFixture`,
        summary: 'gate fixture',
        priorityScore: 50 + i,
      })),
    )
    .returning({ id: headlines.id });
  return rows.map((r) => r.id);
}

async function main() {
  const cleanupHeadlineIds: string[] = [];
  let subjectId: string | null = null;
  const subIds: string[] = [];

  try {
    // ============ 1. Headline lane: object-wrapped success shape ============
    console.log('[case 1] headline lane — {"clusters":[...]} groups fixture rows');
    const ids1 = await seedHeadlines(2, 'objwrap');
    cleanupHeadlineIds.push(...ids1);
    stubNextResponse(JSON.stringify({
      clusters: [{ clusterName: `Gate Objwrap Event ${RUN}`.slice(0, 50), headlineIds: ids1 }],
    }));
    await clusterTopStories(false);
    let rows = await db.select().from(headlines).where(inArray(headlines.id, ids1));
    const cids1 = new Set(rows.map((r) => r.clusterId));
    check('both fixture rows got a clusterId', rows.every((r) => !!r.clusterId));
    check('both rows share ONE cluster', cids1.size === 1);
    check('exactly one representative', rows.filter((r) => r.isClusterRepresentative).length === 1);
    const clusterId1 = rows[0]?.clusterId;
    if (clusterId1) {
      const [cl] = await db.select().from(headlineClusters).where(eq(headlineClusters.id, clusterId1));
      check('cluster row created with AI name', !!cl && cl.name.includes('Gate Objwrap Event'));
    }

    // ============ 2. Headline lane: legacy bare-array compat ============
    console.log('[case 2] headline lane — legacy bare array still parses');
    const ids2 = await seedHeadlines(2, 'barearr');
    cleanupHeadlineIds.push(...ids2);
    stubNextResponse(JSON.stringify([
      { clusterName: `Gate Barearr Event ${RUN}`.slice(0, 50), headlineIds: ids2 },
    ]));
    await clusterTopStories(false);
    rows = await db.select().from(headlines).where(inArray(headlines.id, ids2));
    check('bare-array response still groups rows', rows.every((r) => !!r.clusterId) && new Set(rows.map((r) => r.clusterId)).size === 1);

    // ============ 3. Headline lane: markdown-fenced JSON → malformed log, no grouping ============
    console.log('[case 3] headline lane — fenced JSON logs "Malformed AI response", no grouping');
    const ids3 = await seedHeadlines(2, 'fenced');
    cleanupHeadlineIds.push(...ids3);
    errLines.length = 0;
    stubNextResponse('```json\n{"clusters": [{"clusterName": "x", "headlineIds": []}]}\n```');
    await clusterTopStories(false);
    rows = await db.select().from(headlines).where(inArray(headlines.id, ids3));
    check('fenced response logs Malformed AI response', errLines.some((l) => l.includes('[Clustering] Malformed AI response')));
    check('fenced response applies NO grouping', rows.every((r) => !r.clusterId));

    // ============ 4. Headline lane: empty string → no grouping, no crash ============
    console.log('[case 4] headline lane — empty response is a safe no-op');
    stubNextResponse('');
    await clusterTopStories(false);
    rows = await db.select().from(headlines).where(inArray(headlines.id, ids3));
    check('empty response leaves rows unclustered', rows.every((r) => !r.clusterId));

    // ============ 4b. Headline lane: user-created cluster name → reuse (topic matching) ============
    console.log('[case 4b] headline lane — AI echoing a user-created cluster name reuses that cluster');
    const [userCluster] = await db
      .insert(headlineClusters)
      .values({ name: `Gate User Topic ${RUN}`.slice(0, 50), isUserCreated: true })
      .returning({ id: headlineClusters.id, name: headlineClusters.name });
    const idsU = await seedHeadlines(2, 'usertopic');
    cleanupHeadlineIds.push(...idsU);
    stubNextResponse(JSON.stringify({
      clusters: [{ clusterName: userCluster.name, headlineIds: idsU }],
    }));
    await clusterTopStories(false);
    rows = await db.select().from(headlines).where(inArray(headlines.id, idsU));
    check('user-topic rows attached to the EXISTING user cluster', rows.every((r) => r.clusterId === userCluster.id));
    const [stillThere] = await db.select().from(headlineClusters).where(eq(headlineClusters.id, userCluster.id));
    check('user-created cluster preserved (no duplicate created)', !!stillThere && stillThere.isUserCreated === true);

    // ============ 4c. Headline lane: anti-merge safeguard across two existing clusters ============
    console.log('[case 4c] headline lane — a cluster spanning two existing clusters is SKIPPED');
    const idsM = await seedHeadlines(2, 'antimerge');
    cleanupHeadlineIds.push(...idsM);
    // Make each fixture row the representative of its own pre-existing cluster.
    const preClusters: string[] = [];
    for (const hid of idsM) {
      const [pc] = await db
        .insert(headlineClusters)
        .values({ name: `Gate Premerge ${hid.slice(0, 8)} ${RUN}`.slice(0, 50) })
        .returning({ id: headlineClusters.id });
      preClusters.push(pc.id);
      await db.update(headlines).set({ clusterId: pc.id, isClusterRepresentative: true }).where(eq(headlines.id, hid));
    }
    stubNextResponse(JSON.stringify({
      clusters: [{ clusterName: `Gate Illegal Merge ${RUN}`.slice(0, 50), headlineIds: idsM }],
    }));
    await clusterTopStories(false);
    rows = await db.select().from(headlines).where(inArray(headlines.id, idsM));
    check(
      'anti-merge safeguard keeps the two existing clusters distinct',
      rows.length === 2 && new Set(rows.map((r) => r.clusterId)).size === 2 &&
        rows.every((r) => preClusters.includes(r.clusterId as string)),
    );

    // ============ 5. Team lane: object-wrapped success shape ============
    console.log('[case 5] team lane — {"clusters":[...]} groups fixture submissions');
    const [subject] = await db
      .insert(teamSubjects)
      .values({ name: `Gate cluster-json subject ${RUN}` })
      .returning({ id: teamSubjects.id });
    subjectId = subject.id;
    const subRows = await db
      .insert(teamSubmissions)
      .values(
        Array.from({ length: 2 }, (_, i) => ({
          submittedBy: 'gate',
          submittedByName: 'Gate Fixture',
          sourceType: 'article',
          sourceUrl: `${MARKER}/team/${i + 1}`,
          headline: `Gate team fixture submission variant ${i + 1} ${RUN}`,
          summary: 'gate fixture',
          subjectId: subject.id,
          priorityScore: 40 + i,
        })),
      )
      .returning({ id: teamSubmissions.id });
    subIds.push(...subRows.map((r) => r.id));
    stubNextResponse(JSON.stringify({
      clusters: [{ clusterName: `Gate Team Event ${RUN}`.slice(0, 50), submissionIds: subIds }],
    }));
    await clusterSubmissionsForTopic(subject.id);
    let tRows = await db.select().from(teamSubmissions).where(inArray(teamSubmissions.id, subIds));
    check('team submissions grouped into one cluster', tRows.every((r) => !!r.clusterId) && new Set(tRows.map((r) => r.clusterId)).size === 1);
    check('team lane has exactly one representative', tRows.filter((r) => r.isClusterRepresentative).length === 1);

    // ============ 6. Team lane: garbage response → malformed log, grouping unchanged ============
    console.log('[case 6] team lane — garbage response logs "Malformed AI response"');
    // Un-cluster first so we can prove no re-grouping happens on garbage.
    await db.update(teamSubmissions).set({ clusterId: null, isClusterRepresentative: false }).where(inArray(teamSubmissions.id, subIds));
    errLines.length = 0;
    stubNextResponse('I cannot produce JSON for that request.');
    await clusterSubmissionsForTopic(subjectId);
    tRows = await db.select().from(teamSubmissions).where(inArray(teamSubmissions.id, subIds));
    check('team garbage logs Malformed AI response', errLines.some((l) => l.includes('[TeamClustering] Malformed AI response')));
    check('team garbage applies NO grouping', tRows.every((r) => !r.clusterId));
  } finally {
    restoreAI();
    console.error = realError;
    // ---- fixture cleanup (fail-safe, marker-scoped) ----
    try {
      if (cleanupHeadlineIds.length) {
        const rows = await db
          .select({ clusterId: headlines.clusterId })
          .from(headlines)
          .where(inArray(headlines.id, cleanupHeadlineIds));
        const clusterIds = Array.from(new Set(rows.map((r) => r.clusterId).filter((c): c is string => !!c)));
        await db.delete(headlines).where(inArray(headlines.id, cleanupHeadlineIds));
        // Only delete clusters that are now empty (they were fixture-created).
        for (const cid of clusterIds) {
          await db.execute(sql`
            DELETE FROM headline_clusters WHERE id = ${cid} AND id NOT IN (
              SELECT DISTINCT cluster_id FROM headlines WHERE cluster_id IS NOT NULL
              UNION
              SELECT DISTINCT cluster_id FROM manual_submissions WHERE cluster_id IS NOT NULL
            )
          `);
        }
      }
      if (subIds.length) await db.delete(teamSubmissions).where(inArray(teamSubmissions.id, subIds));
      if (subjectId) {
        await db.delete(teamSubmissionClusters).where(eq(teamSubmissionClusters.subjectId, subjectId));
        await db.delete(teamSubjects).where(eq(teamSubjects.id, subjectId));
      }
    } catch (cleanupErr) {
      console.log('[cleanup] warning:', cleanupErr);
    }
  }

  if (failures > 0) {
    console.error(`[cluster-json-format] FAIL — ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('[cluster-json-format] all checks passed — JSON format change verified for both cluster lanes');
  process.exit(0);
}

main().catch((err) => {
  console.error('[cluster-json-format] harness crashed:', err);
  process.exit(1);
});
