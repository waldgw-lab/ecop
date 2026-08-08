/**
 * Gate: curated-feedback-persistence
 *
 * WHY THIS EXISTS
 * ---------------
 * Curated View feedback (feature requests / suggestions / questions submitted by
 * viewers) is stored in the `curated_view_feedback` table, which is created by
 * the boot migrator (`server/migrate.ts`). If a future change ever drops that
 * CREATE TABLE from the migrator — or the storage implementation
 * (`server/storage.ts`) breaks silently — every submission would be lost: the
 * POST endpoint would 500 (missing table) or accept the row and never persist
 * it, and no viewer feedback would ever reach the editor inbox.
 *
 * This gate exercises the REAL round-trip against the LIVE dev server (which has
 * booted, run migrate.ts, and is backed by the real database) so a missing
 * table or broken storage method fails loudly:
 *   1. POST /api/curated/feedback            (view-tier) — submit a test item
 *   2. GET  /api/curated/feedback            (editor-tier) — item appears
 *   3. GET  /api/curated/feedback/unreviewed-count — count increments
 *   4. POST /api/curated/feedback/:id/review — reviewed flag flips true
 * Then it cleans up the test row via DELETE /api/curated/feedback/:id.
 *
 * In development the endpoints' auth is dev-bypassed (both view + editor tiers),
 * so no login is required to reach them over localhost.
 *
 * EXIT CODES (harness-reliability convention):
 *   0 = PASS         — the full round-trip persisted and behaved correctly.
 *   1 = FAIL         — a GENUINE regression (missing table / storage broke /
 *                       row not persisted / reviewed flag did not flip).
 *   3 = INCONCLUSIVE — a PRECONDITION failed (dev server unreachable), NOT a
 *                       judgment about persistence. Re-run with the app up.
 */

const BASE_URL = process.env.HARNESS_BASE_URL || 'http://localhost:5000';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INCONCLUSIVE = 3;

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) {
    console.log(`[feedback-persistence] OK   ${label}`);
  } else {
    failed++;
    console.error(`[feedback-persistence] FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

class PreconditionError extends Error {}

async function req(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${BASE_URL}${path}`, init);
  } catch (err) {
    throw new PreconditionError(
      `could not reach app server at ${BASE_URL}${path}: ${(err as Error).message}`,
    );
  }
}

async function main() {
  // A unique marker so we can positively identify OUR row in the listing and
  // never confuse it with any real feedback that happens to exist.
  const marker = `__GATE_FEEDBACK_PERSIST__ ${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Baseline unreviewed count BEFORE we submit anything.
  const beforeRes = await req('/api/curated/feedback/unreviewed-count');
  if (beforeRes.status === 401 || beforeRes.status === 403) {
    throw new PreconditionError(
      `unreviewed-count is auth-gated (status=${beforeRes.status}); dev bypass not active — cannot judge persistence`,
    );
  }
  check('0 unreviewed-count endpoint responds 200', beforeRes.status === 200, `status=${beforeRes.status}`);
  const beforeBody: any = await beforeRes.json().catch(() => ({}));
  const beforeCount = Number(beforeBody?.count ?? NaN);
  check('0b unreviewed-count returns a numeric count', Number.isFinite(beforeCount), JSON.stringify(beforeBody));

  // 1) POST feedback via the view-tier endpoint.
  const postRes = await req('/api/curated/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feedbackType: 'suggestion', message: marker, anonymous: true }),
  });
  if (postRes.status === 401 || postRes.status === 403) {
    throw new PreconditionError(
      `POST /api/curated/feedback is auth-gated (status=${postRes.status}); dev bypass not active`,
    );
  }
  const postBody: any = await postRes.json().catch(() => ({}));
  check('1 POST /api/curated/feedback returns 200', postRes.status === 200, `status=${postRes.status} body=${JSON.stringify(postBody)}`);
  check('1b POST response is ok:true with a persisted id (storage.createCuratedViewFeedback ran)', postBody?.ok === true && !!postBody?.id, JSON.stringify(postBody));

  const createdId: string | undefined = postBody?.id;

  try {
    // 2) The submitted item appears in the editor listing.
    const listRes = await req('/api/curated/feedback');
    const listBody: any = await listRes.json().catch(() => ({}));
    check('2 GET /api/curated/feedback returns 200', listRes.status === 200, `status=${listRes.status}`);
    const items: any[] = Array.isArray(listBody?.items) ? listBody.items : [];
    const mine = items.find((it) => it?.id === createdId || it?.message === marker);
    check('2b the submitted item persisted and appears in the editor listing', !!mine, `id=${createdId} listSize=${items.length}`);
    check('2c persisted row round-tripped its content (message + type intact)', !!mine && mine.message === marker && mine.feedbackType === 'suggestion', JSON.stringify(mine ?? null));
    check('2d newly-submitted row is unreviewed by default', !!mine && mine.reviewed === false, `reviewed=${mine?.reviewed}`);

    // 3) The unreviewed count incremented after our submission.
    const afterRes = await req('/api/curated/feedback/unreviewed-count');
    const afterBody: any = await afterRes.json().catch(() => ({}));
    const afterCount = Number(afterBody?.count ?? NaN);
    check(
      '3 unreviewed count incremented after submission',
      Number.isFinite(beforeCount) && Number.isFinite(afterCount) && afterCount > beforeCount,
      `before=${beforeCount} after=${afterCount}`,
    );

    // 4) Marking reviewed flips the reviewed flag.
    if (createdId) {
      const reviewRes = await req(`/api/curated/feedback/${encodeURIComponent(createdId)}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const reviewBody: any = await reviewRes.json().catch(() => ({}));
      check('4 POST /:id/review returns 200 ok:true', reviewRes.status === 200 && reviewBody?.ok === true, `status=${reviewRes.status} body=${JSON.stringify(reviewBody)}`);

      const listRes2 = await req('/api/curated/feedback');
      const listBody2: any = await listRes2.json().catch(() => ({}));
      const items2: any[] = Array.isArray(listBody2?.items) ? listBody2.items : [];
      const mine2 = items2.find((it) => it?.id === createdId);
      check('4b the reviewed flag flipped to true in storage', !!mine2 && mine2.reviewed === true, JSON.stringify(mine2 ?? null));

      const afterReviewRes = await req('/api/curated/feedback/unreviewed-count');
      const afterReviewBody: any = await afterReviewRes.json().catch(() => ({}));
      const afterReviewCount = Number(afterReviewBody?.count ?? NaN);
      check(
        '4c unreviewed count dropped back after marking reviewed',
        Number.isFinite(afterReviewCount) && Number.isFinite(afterCount) && afterReviewCount < afterCount,
        `afterSubmit=${afterCount} afterReview=${afterReviewCount}`,
      );
    } else {
      check('4 could not mark reviewed — no id returned from POST', false);
    }
  } finally {
    // Clean up the test row so the gate never pollutes the real editor inbox.
    if (createdId) {
      try {
        const delRes = await req(`/api/curated/feedback/${encodeURIComponent(createdId)}`, { method: 'DELETE' });
        if (delRes.status === 200) {
          console.log(`[feedback-persistence] cleaned up test row ${createdId}`);
        } else {
          console.warn(`[feedback-persistence] WARN cleanup returned status=${delRes.status} for ${createdId}`);
        }
      } catch (err) {
        console.warn(`[feedback-persistence] WARN cleanup failed for ${createdId}: ${(err as Error).message}`);
      }
    }
  }

  if (failed === 0) {
    console.log('[feedback-persistence] all checks passed — feedback persists end-to-end');
    process.exit(EXIT_PASS);
  } else {
    console.error(`[feedback-persistence] ${failed} check(s) failed — feedback persistence is broken`);
    process.exit(EXIT_FAIL);
  }
}

main().catch((err) => {
  if (err instanceof PreconditionError) {
    console.error(`[feedback-persistence] INCONCLUSIVE (precondition): ${err.message}`);
    process.exit(EXIT_INCONCLUSIVE);
  }
  console.error(`[feedback-persistence] crashed: ${err?.stack ?? err}`);
  process.exit(EXIT_FAIL);
});
