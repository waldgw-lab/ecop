/**
 * scripts/score-retry.test.ts
 *
 * Gate: confirm the buried-story safety net (server/scoreRetry.ts, Task #811)
 * actually resurfaces a high-priority story after a one-time scorer outage.
 *
 * Runs against the real dev DB with the AI stubbed at the mutable
 * `openai.chat.completions.create` seam (same pattern as cluster-json-format).
 * The storage.getUnscoredFallbackSubmissions method (mutable class method) is
 * WRAPPED — the real SQL (window / cap / deleted filters) still runs, but the
 * result is filtered to this run's marker fixtures so live rows are never
 * touched by the stubbed scorer.
 *
 * Asserts:
 *   1. Window/cap SQL: a fresh under-cap row IS returned; a row at the retry
 *      cap and a row older than the recency window are NOT.
 *   2. Happy path: an 'unscored_fallback' row whose title the stubbed scorer
 *      scores 85 is finalized to scoreSource='ai' with the new score AND
 *      promoted via the normal path (a manual_submissions row with its URL).
 *   3. Scorer-still-fails: a row the scorer returns nothing for gets its
 *      score_retry_count bumped and stays 'unscored_fallback' (score untouched).
 *   4. Cap stop: once a row reaches MAX retries it is not retried again even
 *      when the scorer would now succeed.
 *   5. Out-of-window row is left completely alone.
 *
 * Exit codes: 0 = PASS, 1 = FAIL. No live network/AI (scorer stubbed), so no
 * inconclusive path.
 */

import { openai } from '../server/aiClient';
import { storage } from '../server/storage';
import { runScoreRetry } from '../server/scoreRetry';
import { db } from '../server/db';
import { teamSubmissions, teamSubjects, manualSubmissions } from '../shared/schema';
import { eq, like, sql } from 'drizzle-orm';

const RUN = `scoreretry-${Date.now()}`;
const MARKER = `https://gate.invalid/score-retry/${RUN}`;
// Mirrors the constants in server/scoreRetry.ts (not exported; asserted here so
// a silent change to the cap/window shows up as a gate failure, not a drift).
const MAX_SCORE_RETRIES = 4;
// The development database may contain more than the production cycle limit of
// older eligible rows. Query a wide window in this gate, then apply `limit`
// after isolating this run's fixtures so unrelated backlog cannot crowd the
// fixtures out before the assertions exercise the real eligibility predicates.
const FIXTURE_QUERY_LIMIT = 10_000;

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
function stubScorer(scoresByTitle: Record<string, number>) {
  (openai.chat.completions as any).create = async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            results: Object.entries(scoresByTitle).map(([title, priority_score]) => ({
              title,
              priority_score,
              is_relevant: true,
            })),
          }),
        },
      },
    ],
  });
}
function restoreAI() {
  (openai.chat.completions as any).create = realCreate;
}

// ---- storage wrap: real SQL, results confined to this run's fixtures ------
const realGetUnscored = storage.getUnscoredFallbackSubmissions.bind(storage);
function confinePendingToFixtures() {
  (storage as any).getUnscoredFallbackSubmissions = async (
    maxRetries: number,
    windowHours: number,
    limit: number,
  ) => {
    const rows = await realGetUnscored(maxRetries, windowHours, FIXTURE_QUERY_LIMIT);
    return rows
      .filter((r: any) => typeof r.sourceUrl === 'string' && r.sourceUrl.startsWith(MARKER))
      .slice(0, limit);
  };
}
function restoreStorage() {
  (storage as any).getUnscoredFallbackSubmissions = realGetUnscored;
}

type Fixture = { id: string; title: string; url: string };

async function seedRow(opts: {
  tag: string;
  retryCount: number;
  ageHours?: number;
  subjectId: string;
}): Promise<Fixture> {
  const title = `Gate fixture score-retry ${opts.tag} ${RUN}`;
  const url = `${MARKER}/${opts.tag}`;
  const [row] = await db
    .insert(teamSubmissions)
    .values({
      submittedBy: 'gate-fixture',
      submittedByName: 'Gate Fixture',
      sourceType: 'news',
      sourceUrl: url,
      sourceName: 'GateFixtureOutlet',
      headline: title,
      summary: 'gate fixture summary',
      subjectId: opts.subjectId,
      priorityScore: 30,
      scoreSource: 'unscored_fallback',
      scoreRetryCount: opts.retryCount,
      status: 'pending',
    })
    .returning({ id: teamSubmissions.id });
  if (opts.ageHours) {
    await db
      .update(teamSubmissions)
      .set({ createdAt: sql`now() - interval '${sql.raw(String(opts.ageHours))} hours'` })
      .where(eq(teamSubmissions.id, row.id));
  }
  return { id: row.id, title, url };
}

async function fetchRow(id: string) {
  const [r] = await db.select().from(teamSubmissions).where(eq(teamSubmissions.id, id));
  return r;
}

async function cleanup(subjectId: string | null) {
  restoreAI();
  restoreStorage();
  try {
    await db.delete(teamSubmissions).where(like(teamSubmissions.sourceUrl, `${MARKER}%`));
    await db.delete(manualSubmissions).where(like(manualSubmissions.url, `${MARKER}%`));
    if (subjectId) await db.delete(teamSubjects).where(eq(teamSubjects.id, subjectId));
  } catch (e) {
    console.error('[gate] cleanup error (non-fatal):', e);
  }
}

async function main() {
  let subjectId: string | null = null;
  try {
    // Fixture subject (FK target for teamSubmissions.subjectId).
    const [subject] = await db
      .insert(teamSubjects)
      .values({ name: `GATE SCORE RETRY ${RUN}`, createdBy: 'gate-fixture' } as any)
      .returning({ id: teamSubjects.id });
    subjectId = subject.id;

    const fresh = await seedRow({ tag: 'fresh', retryCount: 0, subjectId });
    const failing = await seedRow({ tag: 'failing', retryCount: MAX_SCORE_RETRIES - 1, subjectId });
    const atCap = await seedRow({ tag: 'atcap', retryCount: MAX_SCORE_RETRIES, subjectId });
    const stale = await seedRow({ tag: 'stale', retryCount: 0, ageHours: 72, subjectId });

    // ---- 1. The real window/cap SQL --------------------------------------
    console.log('Check 1: getUnscoredFallbackSubmissions window & cap filters');
    const pending = (await realGetUnscored(MAX_SCORE_RETRIES, 48, FIXTURE_QUERY_LIMIT)).filter(
      (r: any) => typeof r.sourceUrl === 'string' && r.sourceUrl.startsWith(MARKER),
    );
    const ids = new Set(pending.map((r: any) => r.id));
    check('fresh under-cap row is selected', ids.has(fresh.id));
    check('under-cap failing row is selected', ids.has(failing.id));
    check('row at the retry cap is NOT selected', !ids.has(atCap.id));
    check('row outside the 48h window is NOT selected', !ids.has(stale.id));

    // ---- 2/3. Run: scorer succeeds for `fresh`, fails for `failing` -------
    console.log('Check 2/3: runScoreRetry — rescore + promote, and failure bump');
    confinePendingToFixtures();
    stubScorer({ [fresh.title]: 85 }); // nothing for `failing`
    const res1 = await runScoreRetry();
    console.log(`  runScoreRetry #1 → ${JSON.stringify(res1)}`);
    check('run #1 retried both eligible rows', res1.retried === 2, JSON.stringify(res1));
    check('run #1 rescored exactly one row', res1.rescored === 1, JSON.stringify(res1));

    const freshAfter = await fetchRow(fresh.id);
    check('rescored row has scoreSource=ai', freshAfter?.scoreSource === 'ai', String(freshAfter?.scoreSource));
    check('rescored row carries the new score (85)', freshAfter?.priorityScore === 85, String(freshAfter?.priorityScore));
    check('rescored row marked processed', freshAfter?.status === 'processed', String(freshAfter?.status));
    const promo = await db.select().from(manualSubmissions).where(eq(manualSubmissions.url, fresh.url));
    check('rescored row promoted via normal path (manual_submissions row exists)', promo.length === 1, `found ${promo.length}`);
    check('promoted row carries the real score', promo[0]?.priorityScore === 85, String(promo[0]?.priorityScore));
    check('auto-MCOP stamp recorded on the team submission', !!freshAfter?.mcopSubmittedAt);

    const failingAfter = await fetchRow(failing.id);
    check('still-failing row stays unscored_fallback', failingAfter?.scoreSource === 'unscored_fallback', String(failingAfter?.scoreSource));
    check('still-failing row score untouched (30)', failingAfter?.priorityScore === 30, String(failingAfter?.priorityScore));
    check(
      `still-failing row retry count bumped to the cap (${MAX_SCORE_RETRIES})`,
      failingAfter?.scoreRetryCount === MAX_SCORE_RETRIES,
      String(failingAfter?.scoreRetryCount),
    );

    // ---- 4. Cap stop: scorer would now succeed, but the row is capped -----
    console.log('Check 4: capped row is never retried again');
    stubScorer({ [failing.title]: 90, [atCap.title]: 90, [stale.title]: 90 });
    const res2 = await runScoreRetry();
    console.log(`  runScoreRetry #2 → ${JSON.stringify(res2)}`);
    check('run #2 retried nothing (all fixtures capped/stale/done)', res2.retried === 0, JSON.stringify(res2));
    const failingAfter2 = await fetchRow(failing.id);
    check('capped row still unscored_fallback after run #2', failingAfter2?.scoreSource === 'unscored_fallback', String(failingAfter2?.scoreSource));
    check('capped row score still 30 after run #2', failingAfter2?.priorityScore === 30, String(failingAfter2?.priorityScore));

    // ---- 5. Out-of-window row completely untouched ------------------------
    console.log('Check 5: out-of-window row untouched');
    const staleAfter = await fetchRow(stale.id);
    check('stale row scoreSource unchanged', staleAfter?.scoreSource === 'unscored_fallback', String(staleAfter?.scoreSource));
    check('stale row score unchanged (30)', staleAfter?.priorityScore === 30, String(staleAfter?.priorityScore));
    check('stale row retry count unchanged (0)', staleAfter?.scoreRetryCount === 0, String(staleAfter?.scoreRetryCount));
    const atCapAfter = await fetchRow(atCap.id);
    check('at-cap row retry count unchanged', atCapAfter?.scoreRetryCount === MAX_SCORE_RETRIES, String(atCapAfter?.scoreRetryCount));
  } finally {
    await cleanup(subjectId);
  }

  if (failures > 0) {
    console.error(`\nscore-retry gate: ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('\nscore-retry gate: all checks passed');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('score-retry gate: fatal error:', err);
  restoreAI();
  restoreStorage();
  process.exit(1);
});
