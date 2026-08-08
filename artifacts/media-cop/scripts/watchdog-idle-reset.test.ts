/**
 * Gate: scraper status resets to 'idle' when a watchdog force-clear fires.
 *
 * WHY THIS EXISTS
 * ---------------
 * The chronic prod stall this guards against: a wedged full-scrape left
 * scrape_status stuck on "running" in the DB. The self-healing watchdog
 * (runSelfHealingCheck in server/scheduler.ts) force-clears the in-process
 * guard when a run exceeds MAX_SCRAPE_DURATION_MS (or when the guard is set
 * with no start time), and each of those force-clear paths now performs a
 * best-effort `storage.updateScrapeMetadata({ scrapeStatus: 'idle' })` so the
 * DB status leaves "running" too. There was no gate proving that write still
 * fires — a regression (wrong method signature, a catch swallowing the write,
 * or the reset simply removed) would silently re-introduce the stuck status.
 *
 * WHAT IT DOES
 * ------------
 * Using the module's test-only seam (__schedulerWatchdogTestHooks) it drives
 * the private guard state into the two watchdog conditions and invokes the REAL
 * runSelfHealingCheck, capturing every storage.updateScrapeMetadata write:
 *   Case A — elapsed > MAX_SCRAPE_DURATION_MS  (a wedged, long-running scrape)
 *   Case B — guard set but lastRunStartedAt == null  (the no-start-time bug)
 * Each case must produce a write of { scrapeStatus: 'idle' }. A negative
 * control confirms that when NO watchdog condition holds (guard already clear)
 * the reset does NOT fire, so the gate can't vacuous-pass.
 *
 * The staleness/blocking recovery section (which could otherwise trigger a real
 * runFullScrape) is short-circuited by seeding a recent lastAutoHealTime — the
 * force-clear + idle reset happen BEFORE the cooldown early-return, so the exact
 * production reset path is exercised without kicking off a live scrape.
 *
 * Exit codes (0/1 convention — deterministic, no live AI/network):
 *   0 = PASS  — both watchdog paths reset scrapeStatus to 'idle'; control clean.
 *   1 = FAIL  — a watchdog path did not reset the status (real regression).
 */

import { storage } from '../server/storage';
import { __schedulerWatchdogTestHooks } from '../server/scheduler';
import { EXIT_PASS, EXIT_FAIL } from './harness-reliability';

const { setGuardState, runSelfHealingCheck, MAX_SCRAPE_DURATION_MS } = __schedulerWatchdogTestHooks;

const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[watchdog-idle] OK   ${name}`);
  } else {
    console.error(`[watchdog-idle] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

// Capture every updateScrapeMetadata write so we can assert the idle reset.
let writes: Array<Record<string, unknown>> = [];
const originalUpdate = storage.updateScrapeMetadata.bind(storage);
const originalGet = storage.getScrapeMetadata.bind(storage);

function installStubs() {
  (storage as any).updateScrapeMetadata = async (patch: Record<string, unknown>) => {
    writes.push(patch);
    // Return a benign shape; callers ignore the return in the watchdog path.
    return undefined as any;
  };
  // Not reached in these cases (recent lastAutoHealTime returns early), but
  // stub defensively so a null result forces an early return if it ever is.
  (storage as any).getScrapeMetadata = async () => null;
}

function restoreStubs() {
  (storage as any).updateScrapeMetadata = originalUpdate;
  (storage as any).getScrapeMetadata = originalGet;
}

function sawIdleReset(): boolean {
  return writes.some((w) => w.scrapeStatus === 'idle');
}

async function main() {
  installStubs();
  try {
    // Seed a recent auto-heal time so runSelfHealingCheck returns at its cooldown
    // gate AFTER the force-clear+idle reset, never reaching the recovery scrape.
    // ---- Case A: elapsed > MAX_SCRAPE_DURATION_MS (a wedged run) --------------
    writes = [];
    setGuardState({
      isScrapingInProgress: true,
      lastRunStartedAt: new Date(Date.now() - (MAX_SCRAPE_DURATION_MS + 60_000)),
      lastAutoHealTime: new Date(), // recent → early return after the reset
    });
    await runSelfHealingCheck();
    check(
      'Case A (elapsed > MAX): watchdog force-clear resets scrapeStatus to idle',
      sawIdleReset(),
      `writes seen: ${JSON.stringify(writes)}`,
    );

    // ---- Case B: guard set but no start time recorded ------------------------
    writes = [];
    setGuardState({
      isScrapingInProgress: true,
      lastRunStartedAt: null,
      lastAutoHealTime: new Date(),
    });
    await runSelfHealingCheck();
    check(
      'Case B (no start time): watchdog force-clear resets scrapeStatus to idle',
      sawIdleReset(),
      `writes seen: ${JSON.stringify(writes)}`,
    );

    // ---- Negative control: no watchdog condition → no idle reset -------------
    // Guard already clear, so the whole `if (isScrapingInProgress)` block is
    // skipped. With a recent lastAutoHealTime the cooldown returns early too, so
    // NO updateScrapeMetadata write should occur. This proves the assertions
    // above are actually driven by the watchdog paths, not a vacuous pass.
    writes = [];
    setGuardState({
      isScrapingInProgress: false,
      lastRunStartedAt: null,
      lastAutoHealTime: new Date(),
    });
    await runSelfHealingCheck();
    check(
      'Negative control: no watchdog condition means no idle reset fires',
      !sawIdleReset(),
      `unexpected writes: ${JSON.stringify(writes)}`,
    );
  } finally {
    restoreStubs();
    // Leave the guard cleared so we don't perturb any concurrent process state.
    setGuardState({ isScrapingInProgress: false, lastRunStartedAt: null });
  }

  if (failures.length === 0) {
    console.log('\n[watchdog-idle] PASS — both watchdog force-clear paths reset scrapeStatus to idle');
    process.exit(EXIT_PASS);
  } else {
    console.error(`\n[watchdog-idle] FAIL — ${failures.length} assertion(s) failed`);
    process.exit(EXIT_FAIL);
  }
}

main().catch((err) => {
  console.error('[watchdog-idle] fatal:', err);
  process.exit(EXIT_FAIL);
});
