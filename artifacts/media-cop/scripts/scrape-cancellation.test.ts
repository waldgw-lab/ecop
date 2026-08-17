/**
 * Gate: watchdog force-clear revokes a zombie scrape run's generation (Task #34).
 *
 * WHY THIS EXISTS
 * ---------------
 * A timed-out runFullScrape body cannot be cancelled by Promise.race — it kept
 * running as a background zombie, re-acquiring the process-wide browser lock
 * lane-by-lane and starving every later cycle's X lanes plus the OSINT cron
 * (the Aug 17 2026 ~50-min X ingestion blackout). The fix is a cooperative
 * cancellation generation: the timeout catch and BOTH watchdog force-clear
 * paths bump `scrapeGeneration`, and the body checks it at every lane boundary
 * so a superseded run stops before taking the lock again.
 *
 * This gate drives the self-healing watchdog force-clear paths through the
 * test seam and asserts the generation is bumped — the exact mechanism that
 * de-zombifies a wedged run. (The timeout-catch path shares the same bump and
 * is exercised in prod on every hard-bound trip; it cannot be driven here
 * without launching real Playwright scrapers.)
 *
 * Deterministic, no live scrape. Exit 0 = PASS, 1 = FAIL.
 */

import { storage } from '../server/storage';
import { __schedulerWatchdogTestHooks } from '../server/scheduler';
import { withBrowserLock } from '../server/browserLock';
import { EXIT_PASS, EXIT_FAIL } from './harness-reliability';

const { setGuardState, runSelfHealingCheck, MAX_SCRAPE_DURATION_MS, getScrapeGeneration, forceKillBrowsersRespectingHolder } = __schedulerWatchdogTestHooks;

const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`[scrape-cancel] OK   ${name}`);
  else { console.error(`[scrape-cancel] FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

const originalUpdate = storage.updateScrapeMetadata.bind(storage);
const originalGet = storage.getScrapeMetadata.bind(storage);
(storage as any).updateScrapeMetadata = async () => undefined;
(storage as any).getScrapeMetadata = async () => null;

async function main() {
  try {
    // Case A: wedged long-running scrape → force-clear must bump the generation.
    setGuardState({
      isScrapingInProgress: true,
      lastRunStartedAt: new Date(Date.now() - MAX_SCRAPE_DURATION_MS - 60_000),
      lastAutoHealTime: new Date(), // recent → auto-heal section early-returns
    });
    const genBefore = getScrapeGeneration();
    await runSelfHealingCheck();
    check('wedged-run force-clear bumps scrapeGeneration', getScrapeGeneration() > genBefore,
      `before=${genBefore} after=${getScrapeGeneration()}`);

    // Negative control: healthy in-progress run (not stale) must NOT bump.
    setGuardState({
      isScrapingInProgress: true,
      lastRunStartedAt: new Date(Date.now() - 60_000),
      lastAutoHealTime: new Date(),
    });
    const genBefore2 = getScrapeGeneration();
    await runSelfHealingCheck();
    check('healthy run does NOT bump scrapeGeneration', getScrapeGeneration() === genBefore2,
      `before=${genBefore2} after=${getScrapeGeneration()}`);

    // Case C: a run cancelled WHILE QUEUED for the browser lock must abandon at
    // acquisition — never execute its lane body after the sibling releases.
    // (The exact window that re-wedged ingestion: check-before-enqueue passed,
    // timeout fired during the queue wait, sibling released, zombie lane ran.)
    let cancelled = false;
    let laneRan = false;
    let releaseSibling!: () => void;
    const siblingDone = new Promise<void>((r) => { releaseSibling = r; });
    const sibling = withBrowserLock('updateOsintPosts', async () => { await siblingDone; });
    const queued = withBrowserLock(
      'updateXPosts',
      async () => { laneRan = true; },
      { onAcquire: () => { if (cancelled) throw new Error('ScrapeCancelledError: queued lane superseded'); } },
    );
    cancelled = true;        // revoke while still queued behind the sibling
    releaseSibling();        // sibling finishes, queue advances to our lane
    let queuedRejected = false;
    await queued.catch(() => { queuedRejected = true; });
    await sibling;
    check('queued cancelled lane abandons at lock acquisition', queuedRejected && !laneRan,
      `rejected=${queuedRejected} laneRan=${laneRan}`);

    // Case D: holder-aware kill policy — a sibling family holding the browser
    // lock must SUPPRESS the system-wide pkill; a chain-own holder (or a free
    // lock) allows it.
    let releaseOsint!: () => void;
    const osintHold = withBrowserLock('updateOsintPosts', () => new Promise<void>((r) => { releaseOsint = r; }));
    await new Promise((r) => setTimeout(r, 10)); // let the holder acquire
    const killedWhileSiblingHeld = forceKillBrowsersRespectingHolder('gate: sibling-held');
    check('sibling-held lock suppresses force-kill', killedWhileSiblingHeld === false);
    releaseOsint();
    await osintHold;
    const killedWhileFree = forceKillBrowsersRespectingHolder('gate: lock free');
    check('free lock allows force-kill', killedWhileFree === true);

    let releaseOwn!: () => void;
    const ownHold = withBrowserLock('updateXPosts', () => new Promise<void>((r) => { releaseOwn = r; }));
    await new Promise((r) => setTimeout(r, 10));
    const killedWhileOwnHeld = forceKillBrowsersRespectingHolder('gate: own-lane-held');
    check('chain-own holder allows force-kill', killedWhileOwnHeld === true);
    releaseOwn();
    await ownHold;
  } finally {
    setGuardState({ isScrapingInProgress: false, lastRunStartedAt: null });
    (storage as any).updateScrapeMetadata = originalUpdate;
    (storage as any).getScrapeMetadata = originalGet;
  }

  if (failures.length) process.exit(EXIT_FAIL);
  console.log('[scrape-cancel] PASS');
  process.exit(EXIT_PASS);
}

main().catch((e) => { console.error('[scrape-cancel] crash:', e); process.exit(EXIT_FAIL); });
