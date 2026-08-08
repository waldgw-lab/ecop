/**
 * Gate: AUTO-HEAL respects X relay health (Task: make X auto-heal respect relay health).
 *
 * WHY THIS EXISTS
 * ---------------
 * While the Evangelist Vortex X relay heartbeat is healthy, the Playwright X
 * scrapers (main X chain + Influencer X + Journalist X) are INTENTIONALLY
 * skipped — the relay delivers those posts. That means their "last scrape"
 * timestamps naturally age past the staleness thresholds. Before this fix the
 * self-healing watchdog treated that aging as staleness and launched the exact
 * Chromium browser work the relay replaced ("AUTO-HEAL: Starting fresh
 * Influencer X scrape" while the relay was healthy, seen in prod logs).
 *
 * WHAT IT DOES
 * ------------
 * Drives the REAL runSelfHealingCheck (via __schedulerWatchdogTestHooks) with
 * stubbed scrape metadata simulating stale X lanes + tripped blocking counters:
 *
 *   Case STALE-RELAY (run first, only if the relay is genuinely stale in this
 *   process): stale X-feeds timestamp must still enter the recovery decision
 *   ("fallback mode" in the log) — fallback protection unchanged. The actual
 *   recovery scrape is suppressed by flipping the in-progress guard during the
 *   pre-scrape wait, so no real browser scrape runs.
 *
 *   Case HEALTHY-RELAY: after stamping the relay heartbeat fresh, the SAME
 *   stale metadata must produce NO recovery: X feeds treated as fresh
 *   (relay-delivered), influencer stale/blocked ignored, X blocking counters
 *   ignored, and no "Initiating ... recovery sequence" / "Starting fresh
 *   Influencer X scrape" ever logged.
 *
 * Exit codes: 0 = PASS, 1 = FAIL. If the relay heartbeat is already healthy at
 * start (restored from a persisted heartbeat), the stale-relay case is skipped
 * (cannot be forced stale in-process) — the healthy-relay case, the behavior
 * this gate exists to protect, always runs.
 */

import { storage } from '../server/storage';
import { __schedulerWatchdogTestHooks } from '../server/scheduler';
import { isXRelayHealthy, updateXRelayHeartbeat } from '../server/xRelayService';
import { EXIT_PASS, EXIT_FAIL } from './harness-reliability';

const { setGuardState, runSelfHealingCheck } = __schedulerWatchdogTestHooks;

const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[x-autoheal-relay] OK   ${name}`);
  } else {
    console.error(`[x-autoheal-relay] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

// ---- storage stubs ----------------------------------------------------------
const originalGet = storage.getScrapeMetadata.bind(storage);
const originalUpdate = storage.updateScrapeMetadata.bind(storage);

const HOURS = 60 * 60 * 1000;
function staleXMetadata() {
  const now = Date.now();
  return {
    // Full scrape cycle is FRESH — only the X lanes are stale, so any recovery
    // decision observed is driven purely by the X-lane signals under test.
    lastScrapeTime: new Date(now - 2 * 60 * 1000),
    xPostsLastScrapeTime: new Date(now - 3 * HOURS),
    influencerXLastScrapeTime: new Date(now - 3 * HOURS),
    influencerXConsecutiveEmpty: 5,
    xPostsConsecutiveEmpty: 5,
    rapidResponseConsecutiveEmpty: 0,
    dowResponseConsecutiveEmpty: 0,
    sentDefenderConsecutiveEmpty: 0,
    lastBlockingRecoveryTime: null,
  } as any;
}

// Influencer lanes FRESH — used in the stale-relay case so the influencer
// recovery (which would launch a real 16-account Chromium scrape) never fires.
function staleMainXOnlyMetadata() {
  const m = staleXMetadata();
  m.influencerXLastScrapeTime = new Date(Date.now() - 5 * 60 * 1000);
  m.influencerXConsecutiveEmpty = 0;
  m.xPostsConsecutiveEmpty = 0; // avoid blocking-recovery full scrape too
  return m;
}

let currentMetadata: any = null;
function installStubs() {
  (storage as any).getScrapeMetadata = async () => currentMetadata;
  (storage as any).updateScrapeMetadata = async () => undefined as any;
}
function restoreStubs() {
  (storage as any).getScrapeMetadata = originalGet;
  (storage as any).updateScrapeMetadata = originalUpdate;
}

// ---- console capture ----------------------------------------------------------
let captured: string[] = [];
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
function startCapture() {
  captured = [];
  console.log = (...a: any[]) => { captured.push(a.join(' ')); origLog(...a); };
  console.warn = (...a: any[]) => { captured.push(a.join(' ')); origWarn(...a); };
  console.error = (...a: any[]) => { captured.push(a.join(' ')); origError(...a); };
}
function stopCapture() {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
}
const logged = (needle: string) => captured.some((l) => l.includes(needle));

async function main() {
  installStubs();
  try {
    const initiallyHealthy = isXRelayHealthy();

    // ---- Case STALE-RELAY: fallback protection must be unchanged --------------
    if (!initiallyHealthy) {
      currentMetadata = staleMainXOnlyMetadata();
      setGuardState({ isScrapingInProgress: false, lastRunStartedAt: null, lastAutoHealTime: null });
      startCapture();
      const run = runSelfHealingCheck();
      // Flip the guard during the recovery pre-scrape wait (2s) so the REAL
      // runFullScrape is skipped — the decision path up to it is what we test.
      setTimeout(() => setGuardState({ isScrapingInProgress: true }), 300);
      await run;
      stopCapture();
      setGuardState({ isScrapingInProgress: false, lastRunStartedAt: null });

      check(
        'stale relay: stale X feeds still trigger recovery (fallback mode)',
        logged('Detected stale scraper') && logged('fallback mode'),
        `captured: ${JSON.stringify(captured.filter((l) => l.includes('AUTO-HEAL')))}`,
      );
      check(
        'stale relay: recovery scrape suppressed by in-progress guard (harness safety)',
        logged('Scrape already in progress, skipping recovery scrape'),
      );
    } else {
      console.log('[x-autoheal-relay] SKIP stale-relay case — relay heartbeat already healthy in this process (cannot force stale)');
    }

    // ---- Case HEALTHY-RELAY: no recovery may fire ------------------------------
    updateXRelayHeartbeat();
    check('healthy relay precondition: heartbeat stamped fresh', isXRelayHealthy());

    currentMetadata = staleXMetadata();
    setGuardState({ isScrapingInProgress: false, lastRunStartedAt: null, lastAutoHealTime: null });
    startCapture();
    await runSelfHealingCheck();
    stopCapture();

    check(
      'healthy relay: stale X feeds treated as fresh (no staleness recovery)',
      logged('treating lane as fresh') && !logged('Detected stale scraper'),
      `captured: ${JSON.stringify(captured)}`,
    );
    check(
      'healthy relay: influencer stale+blocked ignored (no Influencer X recovery)',
      logged('Influencer X') && !logged('Starting fresh Influencer X scrape') && !logged('Initiating Influencer X recovery'),
      `captured: ${JSON.stringify(captured)}`,
    );
    check(
      'healthy relay: frozen X blocking counters ignored (no blocking recovery)',
      logged('blocking counters') && !logged('Detected X blocking'),
      `captured: ${JSON.stringify(captured)}`,
    );
    check(
      'healthy relay: no recovery sequence of any kind initiated',
      !logged('Initiating recovery sequence') && !logged('Starting fresh scrape cycle'),
      `captured: ${JSON.stringify(captured)}`,
    );
  } finally {
    stopCapture();
    restoreStubs();
    setGuardState({ isScrapingInProgress: false, lastRunStartedAt: null });
  }

  if (failures.length === 0) {
    console.log('\n[x-autoheal-relay] PASS — AUTO-HEAL respects X relay health (healthy = no browser recovery; stale = fallback unchanged)');
    process.exit(EXIT_PASS);
  } else {
    console.error(`\n[x-autoheal-relay] FAIL — ${failures.length} assertion(s) failed`);
    process.exit(EXIT_FAIL);
  }
}

main().catch((err) => {
  console.error('[x-autoheal-relay] fatal:', err);
  process.exit(EXIT_FAIL);
});
