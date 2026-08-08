/**
 * Watch Topic steering restart-persistence gate.
 *
 * The Priority/BOLO steering flag lives in memory (default OFF, fail-closed)
 * but is persisted to the app_flags table so a redeploy does not silently turn
 * steering off. A regression here (restore awaited too late, table missing on
 * a fresh DB, a toggle that fails silently) would leave steering OFF after
 * every restart — the exact bug the persistence layer exists to prevent.
 *
 * This gate proves the round-trip against the real dev database:
 *   1. persistWatchTopicSteering(true) → wipe in-memory flag to false →
 *      restoreWatchTopicSteering() → flag is ON.
 *   2. persistWatchTopicSteering(false) → force in-memory flag to true →
 *      restore → flag is OFF.
 *   3. No-row case (fresh DB): delete the app_flags row → in-memory flag at
 *      the boot default (OFF) → restore → flag STAYS at the default OFF and
 *      restore does not throw (fail-open contract keeps the safe direction).
 *
 * The gate saves the pre-existing app_flags state and restores it (row value
 * re-persisted, or row deleted if none existed) so it never perturbs the
 * running dev app's steering state.
 *
 * Exit codes (harness-reliability convention):
 *   0 = all assertions pass, 1 = assertion failure,
 *   3 = inconclusive (DB unreachable — precondition, not a verdict).
 *
 * Run: npx tsx scripts/watch-steering-persistence.test.ts
 */
import { db } from '../server/db';
import { appFlags } from '@shared/schema';
import { eq } from 'drizzle-orm';
import {
  persistWatchTopicSteering,
  restoreWatchTopicSteering,
  setWatchTopicSteeringEnabled,
  isWatchTopicSteeringEnabled,
} from '../server/watchTopicMatcher';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[watch-steering-persist] OK   ${name}`);
  } else {
    console.error(`[watch-steering-persist] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

async function readRow(): Promise<{ exists: boolean; enabled: boolean }> {
  const [row] = await db.select().from(appFlags).where(eq(appFlags.id, 'global'));
  return { exists: !!row, enabled: !!row?.watchTopicSteeringEnabled };
}

async function main() {
  // Precondition: DB reachable. A connection failure is inconclusive, not a
  // steering-persistence verdict.
  let original: { exists: boolean; enabled: boolean };
  try {
    original = await readRow();
  } catch (e) {
    console.error('[watch-steering-persist] INCONCLUSIVE — dev DB unreachable:', e);
    process.exit(3);
  }

  try {
    // ------------------------------------------------------------------
    // TEST 1 — ON round-trip: persist true, wipe memory, restore → ON.
    // ------------------------------------------------------------------
    await persistWatchTopicSteering(true);
    setWatchTopicSteeringEnabled(false); // simulate fresh process (boot default)
    await restoreWatchTopicSteering();
    check('1 restore after persist(true) turns steering ON', isWatchTopicSteeringEnabled() === true);

    // Persisted row actually says true (persist did not fail silently).
    const afterOn = await readRow();
    check('1b app_flags row exists and stores true', afterOn.exists && afterOn.enabled === true,
      JSON.stringify(afterOn));

    // ------------------------------------------------------------------
    // TEST 2 — OFF round-trip: persist false, force memory ON, restore → OFF.
    // ------------------------------------------------------------------
    await persistWatchTopicSteering(false);
    setWatchTopicSteeringEnabled(true); // memory deliberately wrong
    await restoreWatchTopicSteering();
    check('2 restore after persist(false) turns steering OFF', isWatchTopicSteeringEnabled() === false);

    const afterOff = await readRow();
    check('2b app_flags row stores false', afterOff.exists && afterOff.enabled === false,
      JSON.stringify(afterOff));

    // ------------------------------------------------------------------
    // TEST 3 — no-row case (fresh DB): delete the row; restore must not
    // throw and must leave the flag at the boot default (OFF).
    // ------------------------------------------------------------------
    await db.delete(appFlags).where(eq(appFlags.id, 'global'));
    setWatchTopicSteeringEnabled(false); // boot default
    let threw = false;
    try {
      await restoreWatchTopicSteering();
    } catch {
      threw = true;
    }
    check('3 restore with no DB row does not throw', !threw);
    check('3b restore with no DB row leaves steering at default OFF', isWatchTopicSteeringEnabled() === false);
  } finally {
    // Restore the pre-test state so this gate never perturbs the dev app.
    try {
      if (original!.exists) {
        await persistWatchTopicSteering(original!.enabled);
      } else {
        await db.delete(appFlags).where(eq(appFlags.id, 'global'));
      }
    } catch (e) {
      console.error('[watch-steering-persist] WARN failed to restore original app_flags state:', e);
    }
  }

  if (failures > 0) {
    console.error(`\n[watch-steering-persist] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[watch-steering-persist] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[watch-steering-persist] UNEXPECTED ERROR', e);
  process.exit(1);
});
