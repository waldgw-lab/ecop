/**
 * Regression: canary rows seeded by curated-isolation-harness cannot
 * survive a hard-kill (SIGKILL) of the harness process.
 *
 * The harness covers SIGKILL via startup self-heal sweeps that run at the
 * beginning of each phase on the NEXT run, and via the exported
 * `cleanupAllResidue()` routine that those sweeps are based on. This script
 * proves those sweeps are comprehensive by:
 *
 *   1. Inserting one synthetic canary row of EVERY table the harness seeds,
 *      using the harness's OWN exported prefix constants — any prefix change
 *      in the harness is automatically reflected in the seed, so drift is
 *      caught mechanically rather than by convention.
 *   2. Calling the harness's OWN exported `cleanupAllResidue()` — the exact
 *      function used by the SIGKILL recovery path. If it ever drops a table
 *      or narrows a pattern, this test fails immediately.
 *   3. Asserting zero residue rows survive.
 *
 * SERIALIZATION: this script is designed to run as a pre-flight check
 * BEFORE the main curated-isolation-harness.ts invocation (see the
 * curated-isolation validation command in .replit). Running it concurrently
 * with the harness would cause both processes to race on the same prefix-
 * keyed rows. By running first (before the harness seeds anything), this
 * test proves the SIGKILL self-heal without interfering with the harness.
 *
 * Exit codes (0/1 convention, no 3 needed — purely deterministic DB ops):
 *   0 = PASS  — startup sweeps remove all 8 canary row types.
 *   1 = FAIL  — ≥1 row survived (real regression in cleanupAllResidue).
 */

import { eq } from 'drizzle-orm';
import { db } from '../server/db';
import {
  outletRegistry,
  curatedItems,
  curatedLinkReplacements,
  teamSubmissions,
  truthSocialPosts,
  xPosts,
  sentDefenderPosts,
  journalistPosts,
} from '@shared/schema';
import {
  cleanupAllResidue,
  ISOLATION_URL_PREFIX,
  TS_POST_PREFIX,
  X_POST_PREFIX,
  SD_POST_PREFIX,
  JOUR_POST_PREFIX,
  TEST_OUTLET_KEY_PREFIX_EXPORT,
} from './curated-isolation-harness';
import { EXIT_PASS, EXIT_FAIL } from './harness-reliability';

// Unique run id scopes seeds so concurrent dev processes never collide.
const RUN_ID = `sigkill_reg_${Date.now()}`;

// Deterministic identifiers for each seeded row — used in countResidue() to
// confirm each specific row is gone after cleanupAllResidue() runs.
const SEEDED = {
  curatedItemUrl:      `${ISOLATION_URL_PREFIX}sigkill-ci-${RUN_ID}`,
  linkReplacementKey:  `sigkill-lr-key-${RUN_ID}`,
  linkReplacementUrl:  `${ISOLATION_URL_PREFIX}sigkill-lr-${RUN_ID}`,
  teamSubmissionUrl:   `${ISOLATION_URL_PREFIX}sigkill-ts-${RUN_ID}`,
  truthPostId:         `${TS_POST_PREFIX}sigkill_${RUN_ID}`,
  xPostId:             `${X_POST_PREFIX}sigkill_${RUN_ID}`,
  sdPostId:            `${SD_POST_PREFIX}sigkill_${RUN_ID}`,
  jourPostId:          `${JOUR_POST_PREFIX}sigkill_${RUN_ID}`,
  outletKey:           `${TEST_OUTLET_KEY_PREFIX_EXPORT}sigkill_${RUN_ID}__`,
};

// -----------------------------------------------------------------------
// Seed: insert one synthetic row per table, as if a SIGKILL left them.
// Uses the harness's own exported prefix constants so any constant change
// is reflected automatically in both the seed and the cleanup sweep.
//
// Keyed by the same table-name labels countResidue() reports, so a canary a
// concurrent sweep removes can be re-seeded individually (see
// ensureSeededResidue). Each seeder inserts exactly one row.
// -----------------------------------------------------------------------
const SEEDERS: Record<string, () => Promise<unknown>> = {
  curated_items: () =>
    db.insert(curatedItems).values({
      url: SEEDED.curatedItemUrl,
      title: 'SIGKILL self-heal regression canary — curated item',
      normalizedTitle: 'sigkill selfheal regression canary curated item',
      source: 'Isolation Fixture',
      category: 'general',
      role: 'attach-only',
      summary: '',
    }),

  curated_link_replacements: () =>
    db.insert(curatedLinkReplacements).values({
      key: SEEDED.linkReplacementKey,
      url: SEEDED.linkReplacementUrl,
      updatedBy: 'sigkill-regression-test',
    }),

  team_submissions: () =>
    db.insert(teamSubmissions).values({
      submittedBy: 'sigkill-regression-test',
      submittedByName: 'SIGKILL Regression Test',
      sourceType: 'url',
      sourceUrl: SEEDED.teamSubmissionUrl,
      headline: 'SIGKILL self-heal regression canary — team submission',
      summary: 'regression canary summary',
      status: 'pending',
    }),

  truth_social_posts: () =>
    db.insert(truthSocialPosts).values({
      postId: SEEDED.truthPostId,
      content: 'SIGKILL self-heal regression canary — Truth Social post',
      postedAt: new Date(),
      truthSocialUrl: `${ISOLATION_URL_PREFIX}sigkill-ts-post-${RUN_ID}`,
    }),

  x_posts: () =>
    db.insert(xPosts).values({
      postId: SEEDED.xPostId,
      content: 'SIGKILL self-heal regression canary — X post',
      postedAt: new Date(),
      xUrl: `${ISOLATION_URL_PREFIX}sigkill-x-post-${RUN_ID}`,
    }),

  sentdefender_posts: () =>
    db.insert(sentDefenderPosts).values({
      postId: SEEDED.sdPostId,
      content: 'SIGKILL self-heal regression canary — SentDefender post',
      postedAt: new Date(),
      xUrl: `${ISOLATION_URL_PREFIX}sigkill-sd-post-${RUN_ID}`,
    }),

  journalist_posts: () =>
    db.insert(journalistPosts).values({
      postId: SEEDED.jourPostId,
      content: 'SIGKILL self-heal regression canary — journalist post',
      postedAt: new Date(),
      xUrl: `${ISOLATION_URL_PREFIX}sigkill-jour-post-${RUN_ID}`,
      sourceAccount: 'SigkillRegressionTest',
    }),

  outlet_registry: () =>
    db.insert(outletRegistry).values({
      key: SEEDED.outletKey,
      canonicalName: 'SIGKILL Self-Heal Regression Outlet',
      aliases: [],
      domains: [],
      role: 'attach-only',
    }),
};

async function seedSimulatedResidue(): Promise<void> {
  for (const seed of Object.values(SEEDERS)) {
    await seed();
  }
}

// -----------------------------------------------------------------------
// Count: how many seeded rows are still present. Uses exact-match eq()
// queries so the "before" count confirms each row was seeded and the
// "after" count confirms cleanupAllResidue() deleted that specific row.
// -----------------------------------------------------------------------
interface ResidueCount {
  total: number;
  byTable: Record<string, number>;
}

async function countResidue(): Promise<ResidueCount> {
  const [ci, lr, ts_, tp, xp, sd, jp, or_] = await Promise.all([
    db.select({ id: curatedItems.id })
      .from(curatedItems)
      .where(eq(curatedItems.url, SEEDED.curatedItemUrl)),
    db.select({ key: curatedLinkReplacements.key })
      .from(curatedLinkReplacements)
      .where(eq(curatedLinkReplacements.key, SEEDED.linkReplacementKey)),
    db.select({ id: teamSubmissions.id })
      .from(teamSubmissions)
      .where(eq(teamSubmissions.sourceUrl, SEEDED.teamSubmissionUrl)),
    db.select({ id: truthSocialPosts.id })
      .from(truthSocialPosts)
      .where(eq(truthSocialPosts.postId, SEEDED.truthPostId)),
    db.select({ id: xPosts.id })
      .from(xPosts)
      .where(eq(xPosts.postId, SEEDED.xPostId)),
    db.select({ id: sentDefenderPosts.id })
      .from(sentDefenderPosts)
      .where(eq(sentDefenderPosts.postId, SEEDED.sdPostId)),
    db.select({ id: journalistPosts.id })
      .from(journalistPosts)
      .where(eq(journalistPosts.postId, SEEDED.jourPostId)),
    db.select({ key: outletRegistry.key })
      .from(outletRegistry)
      .where(eq(outletRegistry.key, SEEDED.outletKey)),
  ]);

  const byTable: Record<string, number> = {
    curated_items:             ci.length,
    curated_link_replacements: lr.length,
    team_submissions:          ts_.length,
    truth_social_posts:        tp.length,
    x_posts:                   xp.length,
    sentdefender_posts:        sd.length,
    journalist_posts:          jp.length,
    outlet_registry:           or_.length,
  };
  return { total: Object.values(byTable).reduce((a, b) => a + b, 0), byTable };
}

// -----------------------------------------------------------------------
// Ensure every canary is present for the positive control, tolerating both a
// concurrent harness self-heal sweep AND read-after-write visibility lag.
//
// The curated-isolation-harness's per-phase self-heal deletes residue by BARE
// prefix (e.g. `outlet_registry.key LIKE '__iso_test_outlet_%'`, curated_items
// `url LIKE 'https://isolation.invalid/%'`). Those are the exact prefixes this
// test seeds under, by design, so any prefix drift is caught. But if a harness
// run OVERLAPS this test (e.g. two `gates` runs, since each isolation run is
// only serialized WITHIN its own gate — `test-sigkill && harness`), that sweep
// can delete a freshly-seeded canary as collateral. The outlet_registry canary
// is hit first and most often: its self-heal sweep runs at the very start of
// the enrichment phase — the harness's earliest and longest phase — so the
// classic symptom is `7/8, outlet_registry: 0`.
//
// A second, subtler cause is read-after-write visibility lag under connection
// pooling: the inserts are awaited sequentially, but a read issued immediately
// afterward can occasionally miss a just-committed row. Re-seeding + re-count
// absorbs that too — a re-insert of a merely-invisible row hits the unique
// constraint and is swallowed, and the next count sees the now-visible row.
//
// Both are environmental races, NOT a `cleanupAllResidue()` regression (the
// negative control below still asserts cleanup strictly, with no retry). So we
// re-seed any canary a concurrent sweep removed and re-count until we capture a
// snapshot where all rows coexist, bounded by a window comfortably longer than
// the harness's per-pass budget. Returns as soon as all TABLES are present.
async function ensureSeededResidue(): Promise<ResidueCount> {
  const MAX_ATTEMPTS = Number(process.env.SIGKILL_SEED_ATTEMPTS) || 60;
  const DELAY_MS = Number(process.env.SIGKILL_SEED_DELAY_MS) || 500;
  const startedAt = Date.now();
  let count = await countResidue();
  for (let attempt = 1; count.total < TABLES && attempt <= MAX_ATTEMPTS; attempt++) {
    const missing = Object.entries(count.byTable)
      .filter(([, n]) => n === 0)
      .map(([table]) => table);
    console.log(
      `[sigkill-reg] positive control: ${count.total}/${TABLES} present ` +
      `(re-seeding after a concurrent self-heal sweep of: ${missing.join(', ')}; ` +
      `attempt ${attempt}/${MAX_ATTEMPTS})`,
    );
    for (const table of missing) {
      // A concurrent re-create can race our insert; ignore and re-count. Log at
      // debug level so genuine schema/constraint drift stays diagnosable rather
      // than silently swallowed.
      await SEEDERS[table]().catch(e =>
        console.log(`[sigkill-reg] re-seed of ${table} failed (retrying): ${(e as Error).message}`),
      );
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
    count = await countResidue();
  }
  if (count.total < TABLES) {
    const missing = Object.entries(count.byTable)
      .filter(([, n]) => n === 0)
      .map(([table]) => table);
    console.error(
      `[sigkill-reg] positive control exhausted ${MAX_ATTEMPTS} attempts over ` +
      `${((Date.now() - startedAt) / 1000).toFixed(1)}s — still missing: ${missing.join(', ')} ` +
      `(raise SIGKILL_SEED_ATTEMPTS / SIGKILL_SEED_DELAY_MS if a concurrent harness run is longer-lived)`,
    );
  }
  return count;
}

// -----------------------------------------------------------------------
// Assertions.
// -----------------------------------------------------------------------
const TABLES = 8;

const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[sigkill-reg] OK   ${name}`);
  } else {
    console.error(`[sigkill-reg] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

async function main() {
  // Pre-sweep with the REAL cleanup function: guard against residue from a prior
  // aborted test run (same guarantee we're asserting — belt-and-suspenders boot).
  await cleanupAllResidue();

  try {
    // ---- Phase 1: Seed simulated SIGKILL residue (one row per canary table) --
    console.log(`[sigkill-reg] seeding ${TABLES} simulated SIGKILL-residue rows (one per canary table)...`);
    await seedSimulatedResidue();

    // ---- Phase 2: Positive control — all rows present before any sweep -------
    // Resilient to a concurrent harness self-heal sweep clipping a bare-prefix
    // canary and to read-after-write visibility lag (see ensureSeededResidue);
    // the negative control below stays strict.
    const before = await ensureSeededResidue();
    check(
      `positive control: all ${TABLES} canary rows present before sweep`,
      before.total === TABLES,
      before.total !== TABLES
        ? `found ${before.total}/${TABLES} — by table: ${JSON.stringify(before.byTable)}`
        : '',
    );

    // ---- Phase 3: Call the REAL cleanupAllResidue() from the harness ---------
    // This is the exact function invoked by the SIGKILL recovery path.
    // If it ever drops a table or narrows a pattern, the after-count below ≠ 0.
    console.log('[sigkill-reg] calling cleanupAllResidue() — the real SIGKILL recovery path...');
    await cleanupAllResidue();

    // ---- Phase 4: Negative control — zero rows survive -----------------------
    const after = await countResidue();
    check(
      'cleanupAllResidue() removes all 8 canary row types — SIGKILL residue cannot survive',
      after.total === 0,
      after.total !== 0
        ? `${after.total} row(s) survived — by table: ${JSON.stringify(after.byTable)}` +
          ' (cleanupAllResidue() is missing a sweep for these table(s))'
        : '',
    );

    // Per-table breakdown on failure so the missing sweep is immediately obvious.
    if (after.total !== 0) {
      for (const [table, count] of Object.entries(after.byTable)) {
        if (count > 0) {
          check(
            `  ${table}: swept clean by cleanupAllResidue()`,
            false,
            `${count} row(s) survived — add this table to cleanupAllResidue() in curated-isolation-harness.ts`,
          );
        }
      }
    }
  } finally {
    // Belt-and-suspenders: always clean up even if the test fails mid-way.
    await cleanupAllResidue().catch(e =>
      console.error('[sigkill-reg] final cleanup error (non-fatal):', e),
    );
  }

  if (failures.length === 0) {
    console.log('\n[sigkill-reg] PASS — cleanupAllResidue() sweeps all canary row types; SIGKILL is safe');
    process.exit(EXIT_PASS);
  } else {
    console.error(`\n[sigkill-reg] FAIL — ${failures.length} assertion(s) failed`);
    process.exit(EXIT_FAIL);
  }
}

main().catch(err => {
  console.error('[sigkill-reg] fatal:', err);
  process.exit(EXIT_FAIL);
});
