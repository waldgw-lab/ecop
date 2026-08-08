/**
 * Curated manual-link DEDUP gate — exercises the REAL
 * DatabaseStorage.createCuratedManualLink upsert against the dev database
 * (the sibling gate scripts/curated-manual-link.test.ts stubs this method, so
 * without this gate a refactor could silently reintroduce duplicate active
 * rows for the same member-URL set + kind).
 *
 * Pins:
 *   - Creating the SAME member-URL set + kind twice (second call with the
 *     URLs in REVERSED order) upserts: one active row survives, with the
 *     ORIGINAL id/createdBy/createdAt, and the refreshable fields (label,
 *     ai verdict/reasoning, reasons) updated from the second call.
 *   - A DIFFERENT kind over the same URL set creates a SEPARATE row.
 *   - Direct DB count: exactly one ACTIVE row exists per (set, kind).
 *
 * Test rows use unique per-run marker URLs (isolation.invalid host) and are
 * hard-deleted in a finally block — no residue in curated_manual_links.
 *
 * Run: npx tsx scripts/curated-manual-link-dedup.test.ts
 * Exit 0 = pass, 1 = fail (deterministic — dev DB only, no AI/network).
 */
import { eq, or } from 'drizzle-orm';
import { db } from '../server/db';
import { curatedManualLinks } from '../shared/schema';
import { storage } from '../server/storage';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[link-dedup] OK   ${name}`);
  } else {
    console.error(`[link-dedup] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const URL_A = `https://gate.isolation.invalid/link-dedup/${RUN}/story-a`;
const URL_B = `https://gate.isolation.invalid/link-dedup/${RUN}/story-b`;

async function fetchMarkerRows() {
  return db
    .select()
    .from(curatedManualLinks)
    .where(
      or(
        eq(curatedManualLinks.memberUrls, [URL_A, URL_B]),
        eq(curatedManualLinks.memberUrls, [URL_B, URL_A]),
      ),
    );
}

async function main() {
  let sentinel = false;
  try {
    // 1) First create — the "original" row whose who/when must survive.
    const first = await storage.createCuratedManualLink({
      memberUrls: [URL_A, URL_B],
      kind: 'link',
      label: 'gate: original label',
      createdBy: 'gate-dedup-original',
      aiVerdict: 'skipped',
      aiReasoning: '',
      overrodeAi: false,
    });
    check('first create returns an active row', first.status === 'active' && !!first.id);

    // 2) Same set, REVERSED URL order, same kind — must upsert, not duplicate.
    const second = await storage.createCuratedManualLink({
      memberUrls: [URL_B, URL_A],
      kind: 'link',
      label: 'gate: refreshed label',
      createdBy: 'gate-dedup-second-caller',
      aiVerdict: 'concur',
      aiReasoning: 'gate refresh',
      overrodeAi: false,
      reasonKeys: ['same-event'],
      reasonNote: 'gate refresh note',
    });
    check('reversed-order re-link upserts onto the SAME row', second.id === first.id,
      `first=${first.id} second=${second.id}`);
    check('original createdBy preserved', second.createdBy === 'gate-dedup-original',
      `got ${second.createdBy}`);
    check('original createdAt preserved',
      new Date(second.createdAt as unknown as string).getTime() ===
        new Date(first.createdAt as unknown as string).getTime());
    check('refreshable fields updated (label)', second.label === 'gate: refreshed label');
    check('refreshable fields updated (aiVerdict)', second.aiVerdict === 'concur');
    check('refreshable fields updated (aiReasoning)', second.aiReasoning === 'gate refresh');
    check('refreshable fields updated (reasonKeys)',
      Array.isArray(second.reasonKeys) && second.reasonKeys.join(',') === 'same-event');
    check('refreshable fields updated (reasonNote)', second.reasonNote === 'gate refresh note');
    check('row still active', second.status === 'active');

    // 3) Same set, DIFFERENT kind — must be a separate row.
    const merged = await storage.createCuratedManualLink({
      memberUrls: [URL_A, URL_B],
      kind: 'merge',
      label: 'gate: merge kind',
      createdBy: 'gate-dedup-merge',
      aiVerdict: 'skipped',
      aiReasoning: '',
      overrodeAi: false,
    });
    check('different kind creates a SEPARATE row', merged.id !== first.id);

    // 4) Direct DB truth: exactly one ACTIVE row per (set, kind).
    const rows = await fetchMarkerRows();
    const activeLink = rows.filter((r) => r.status === 'active' && r.kind === 'link');
    const activeMerge = rows.filter((r) => r.status === 'active' && r.kind === 'merge');
    check('exactly ONE active row for set+kind=link', activeLink.length === 1,
      `found ${activeLink.length}`);
    check('exactly ONE active row for set+kind=merge', activeMerge.length === 1,
      `found ${activeMerge.length}`);
    check('no unexpected extra marker rows', rows.length === 2, `found ${rows.length}`);

    sentinel = true;
  } catch (err) {
    console.error('[link-dedup] FAIL unexpected error:', err);
    failures++;
  } finally {
    // Cleanup: hard-delete every row carrying this run's marker URLs.
    try {
      const leftovers = await fetchMarkerRows();
      for (const r of leftovers) {
        await db.delete(curatedManualLinks).where(eq(curatedManualLinks.id, r.id));
      }
      const after = await fetchMarkerRows();
      if (after.length !== 0) {
        console.error(`[link-dedup] FAIL cleanup left ${after.length} rows behind`);
        failures++;
      } else {
        console.log('[link-dedup] cleanup complete (0 marker rows remain)');
      }
    } catch (err) {
      console.error('[link-dedup] FAIL cleanup error:', err);
      failures++;
    }
  }

  if (!sentinel) failures++;
  console.log(`[link-dedup] ${failures === 0 ? 'PASS' : `FAIL (${failures} failure(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
