// =============================================================================
// CI gate: admin toggle persistence round-trip (Task #889).
//
// WHAT THIS LOCKS
//  Four admin switches persist in the single-row app_flags table so a restart
//  or redeploy can't silently reset an admin's saved state:
//    - Watch Topic steering        (server/watchTopicMatcher.ts)
//    - Main-feed clustering        (server/clusterConfig.ts)
//    - Topic clustering            (server/clusterConfig.ts)
//    - Joe Priority/BOLO matching  (server/clusterConfig.ts)
//
//  NOTE: The `drudge_scraper_enabled` column still exists in app_flags but the
//  direct Drudge scraper path was retired (permanently disabled; DrudgeBot in
//  Team chat covers Drudge content). It is listed in RETIRED_COLUMNS so the
//  completeness check does not require a round-trip entry for it.
//
//  1. ROUND-TRIP: for every flag — persist(non-default) → flip the in-memory
//     state away from it → restore() → getter reflects the persisted value.
//     Proves the persist writer and boot restore actually agree column-for-
//     column (a typo'd column or a restore that forgets to read a field fails).
//  2. COMPLETENESS: every boolean column on app_flags in shared/schema.ts must
//     be covered by this gate OR listed in RETIRED_COLUMNS. A future switch
//     added to app_flags without a round-trip entry here fails loudly, forcing
//     the author to wire (and test) persistence instead of regressing silently.
//  3. BOOT WIRING (static): server/index.ts must call each restore function
//     inside the awaited pre-scheduler startup block. Dropping a restore call
//     from the Promise.all would make the flag persist but never load.
//
//  All original values (both DB row and in-memory state) are restored in a
//  finally block, so the gate leaves the live flags exactly as it found them.
//
// Exit codes (harness-reliability convention):
//   0 = pass, 1 = fail (content verdict),
//   3 = inconclusive (DB unreachable — precondition, not a verdict).
// =============================================================================
import { readFileSync } from 'node:fs';
import { db } from '../server/db';
import { appFlags } from '../shared/schema';
import { eq } from 'drizzle-orm';
import {
  isWatchTopicSteeringEnabled,
  setWatchTopicSteeringEnabled,
  persistWatchTopicSteering,
  restoreWatchTopicSteering,
} from '../server/watchTopicMatcher';
import {
  isClusteringEnabled,
  setClusteringEnabled,
  persistClusteringEnabled,
  isTopicClusteringEnabled,
  setTopicClusteringEnabled,
  persistTopicClusteringEnabled,
  isJoePriorityMatchingEnabled,
  setJoePriorityMatchingEnabled,
  persistJoePriorityMatchingEnabled,
  isCuratedMissedMergeReconcileEnabled,
  setCuratedMissedMergeReconcileEnabled,
  persistCuratedMissedMergeReconcileEnabled,
  restoreClusteringFlags,
} from '../server/clusterConfig';
import {
  restoreScraperFlags,
} from '../server/scraperConfig';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

interface FlagSpec {
  /** app_flags column name (snake_case, as written in shared/schema.ts). */
  column: string;
  label: string;
  get: () => boolean;
  /** In-memory setter (no DB write). */
  set: (v: boolean) => void;
  /** DB persist writer. */
  persist: (v: boolean) => Promise<void>;
  /** Boot restore that should reload this flag from app_flags. */
  restore: () => Promise<void>;
}

// Columns that intentionally have no in-memory toggle because the feature was
// retired. They stay in the DB schema to avoid a migration but no code reads or
// writes them. The completeness check will acknowledge them as exempted.
const RETIRED_COLUMNS = new Set([
  'drudge_scraper_enabled', // direct Drudge scraper retired; DrudgeBot (Team chat) covers it
]);

const FLAGS: FlagSpec[] = [
  {
    column: 'watch_topic_steering_enabled',
    label: 'Watch Topic steering',
    get: isWatchTopicSteeringEnabled,
    set: setWatchTopicSteeringEnabled,
    persist: persistWatchTopicSteering,
    restore: restoreWatchTopicSteering,
  },
  {
    column: 'clustering_enabled',
    label: 'Main-feed clustering',
    get: isClusteringEnabled,
    set: setClusteringEnabled,
    persist: persistClusteringEnabled,
    restore: restoreClusteringFlags,
  },
  {
    column: 'topic_clustering_enabled',
    label: 'Topic clustering',
    get: isTopicClusteringEnabled,
    set: setTopicClusteringEnabled,
    persist: persistTopicClusteringEnabled,
    restore: restoreClusteringFlags,
  },
  {
    column: 'joe_priority_matching_enabled',
    label: 'Joe Priority/BOLO matching',
    get: isJoePriorityMatchingEnabled,
    set: setJoePriorityMatchingEnabled,
    persist: persistJoePriorityMatchingEnabled,
    restore: restoreClusteringFlags,
  },
  {
    column: 'curated_missed_merge_reconcile_enabled',
    label: 'Curated missed-merge reconciliation',
    get: isCuratedMissedMergeReconcileEnabled,
    set: setCuratedMissedMergeReconcileEnabled,
    persist: persistCuratedMissedMergeReconcileEnabled,
    restore: restoreClusteringFlags,
  },
];

// ---------------------------------------------------------------------------
// [1] COMPLETENESS — every boolean column on app_flags must be covered here
//     or listed in RETIRED_COLUMNS.
// ---------------------------------------------------------------------------
function checkCompleteness() {
  console.log('[1] completeness — every app_flags boolean column has a round-trip entry (or is listed as retired)');
  const schemaSrc = readFileSync('shared/schema.ts', 'utf8');
  const blockMatch = schemaSrc.match(
    /export const appFlags = pgTable\("app_flags",\s*\{([\s\S]*?)\}\);/,
  );
  check('app_flags table block found in shared/schema.ts', !!blockMatch);
  if (!blockMatch) return;
  const boolCols = [...blockMatch[1].matchAll(/boolean\("([a-z0-9_]+)"\)/g)].map((m) => m[1]);
  check('app_flags declares at least the 4 known boolean flags', boolCols.length >= 4,
    `found: ${boolCols.join(', ')}`);
  const covered = new Set(FLAGS.map((f) => f.column));
  for (const col of boolCols) {
    if (RETIRED_COLUMNS.has(col)) {
      console.log(`  PASS column "${col}" — RETIRED (no code reads it; kept in schema to avoid migration)`);
      continue;
    }
    check(
      `column "${col}" covered by this gate`,
      covered.has(col),
      'a new app_flags switch was added without a persist/restore round-trip entry in scripts/admin-flag-persistence.test.ts — wire persistence and add it to FLAGS',
    );
  }
  for (const f of FLAGS) {
    check(`covered column "${f.column}" still exists in schema`, boolCols.includes(f.column));
  }
}

// ---------------------------------------------------------------------------
// [2] BOOT WIRING (static) — server/index.ts calls each restore function.
// ---------------------------------------------------------------------------
function checkBootWiring() {
  console.log('[2] boot wiring — server/index.ts awaits each restore at startup');
  const indexSrc = readFileSync('server/index.ts', 'utf8');
  for (const fn of ['restoreWatchTopicSteering', 'restoreClusteringFlags', 'restoreScraperFlags']) {
    check(`server/index.ts imports ${fn}`, new RegExp(`import \\{[^}]*\\b${fn}\\b`).test(indexSrc));
    check(`server/index.ts calls ${fn}()`, indexSrc.includes(`${fn}().catch`),
      'restore call dropped from the boot Promise.all — the flag would persist but never load');
  }
}

// ---------------------------------------------------------------------------
// [3] ROUND-TRIP — persist(non-default) → flip memory → restore() → getter.
// ---------------------------------------------------------------------------
async function checkRoundTrips() {
  console.log('[3] round-trip — persist → restore → getter reflects persisted value');

  // Snapshot the live row (may not exist on a fresh DB).
  const [originalRow] = await db.select().from(appFlags).where(eq(appFlags.id, 'global'));
  // Snapshot in-memory state before we touch anything.
  const originalMem = FLAGS.map((f) => f.get());

  try {
    for (const f of FLAGS) {
      const target = !f.get(); // a value different from the current live state
      await f.persist(target);
      f.set(!target); // deliberately desync memory so restore() must do the work
      await f.restore();
      check(
        `${f.label}: persisted ${target} survives restore()`,
        f.get() === target,
        `getter returned ${f.get()} after restore; persist column "${f.column}" and restore() disagree`,
      );
      // Also verify the persisted column actually holds the value (catches a
      // restore that "passes" because persist silently wrote nothing and
      // restore left the flipped... — belt and suspenders on the DB side).
      const [row] = await db.select().from(appFlags).where(eq(appFlags.id, 'global'));
      const dbVal = (row as Record<string, unknown> | undefined)?.[snakeToCamel(f.column)];
      check(`${f.label}: DB column reflects persisted value`, dbVal === target,
        `db has ${String(dbVal)}`);
    }
  } finally {
    // Restore the original DB values and in-memory state exactly.
    for (let i = 0; i < FLAGS.length; i++) {
      const f = FLAGS[i];
      const originalDbVal = originalRow
        ? Boolean((originalRow as Record<string, unknown>)[snakeToCamel(f.column)])
        : originalMem[i]; // fresh DB: fall back to the pre-test in-memory state
      try {
        await f.persist(originalDbVal);
      } catch (err) {
        console.error(`  [cleanup] failed to restore ${f.column}:`, err);
      }
      f.set(originalMem[i]);
    }
    // Re-run the restores so memory matches the (restored) DB row, mirroring boot.
    try {
      await restoreWatchTopicSteering();
      await restoreClusteringFlags();
      await restoreScraperFlags();
    } catch (err) {
      console.error('  [cleanup] post-restore reload failed:', err);
    }
  }
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

async function main() {
  checkCompleteness();
  checkBootWiring();

  // DB reachability is a precondition, not a verdict → exit 3 inconclusive.
  try {
    await db.select().from(appFlags).where(eq(appFlags.id, 'global'));
  } catch (err) {
    console.error('[gate] INCONCLUSIVE: app_flags unreachable (DB precondition failure):', err);
    process.exit(3);
  }

  await checkRoundTrips();

  if (failures > 0) {
    console.error(`\n[admin-flag-persistence] FAIL — ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\n[admin-flag-persistence] all admin-flag persistence guarantees hold');
  process.exit(0);
}

main().catch((err) => {
  console.error('[admin-flag-persistence] unexpected error:', err);
  process.exit(1);
});
