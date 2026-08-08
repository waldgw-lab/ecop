import * as cron from 'node-cron';
import { execSync } from 'child_process';
import { storage } from './storage';
import { scrapeAllTruthSocial, updateRelayHeartbeat, isRelayHealthy, filterTruthSocialPostImage } from './truthSocialService';
import { sendPOTUSAlert } from './twilioService';
import { processPostImages } from './imageTextExtractor';
import { updateXPosts, updateInfluencerXPosts } from './xScraper';
import { updateRapidResponsePosts } from './rapidResponseScraper';
import { updateDOWResponsePosts } from './dowResponseScraper';
import { updateSentDefenderPosts } from './sentDefenderScraper';
import { updateOsintPosts, updateJournalistPosts } from './osintScraper';
import { getXRelayHeartbeat, isXRelayHealthy } from './xRelayService';
import { updateFirstAlerts } from './firstAlertScraper';
import { clusterTopStories } from './headlineCluster';
import { clusterAllActiveTopics } from './teamSubmissionCluster';
import { matchSubmissionsToJoePriorities } from './joePriorityMatcher';
import { isBotEnabled } from './scraperConfig';
import { runDrudgeBot } from './drudgeBot';
import { runBBCBot } from './bbcBot';
import { runSocialBot } from './socialBot';
import { runFoxNewsBot } from './foxNewsBot';
import { runAPNewsBot } from './apNewsBot';
import { runReutersBot } from './reutersBot';
import { runCnnCuratedBot, runNprCuratedBot, runCuratedWebScraper, STATE_MEDIA_CURATED_SOURCES } from './curatedWebScraper';
import { runMeltwaterCuratedBot, runMeltwaterIntUsBot } from './meltwaterBot';
import { runCuratedOffHostBot, CURATED_OFFHOST_SOURCES } from './curatedOffHostBot';
import { runABCNewsBot } from './abcNewsBot';
import { runCBSNewsBot } from './cbsNewsBot';
import { runNBCNewsBot } from './nbcNewsBot';
import { scoreNewItemsForAllCustomMcops } from './customMcopScorer';
import { logFdSample } from './fdMonitor';
import { requestCuratedReshape } from './curatedAutoReshape';
import { runScoreRetry } from './scoreRetry';
import { checkSmsAlertHealth } from './smsAlertMonitor';

// Re-entrancy guard to prevent overlapping scrape cycles
let isScrapingInProgress = false;
let consecutiveSkips = 0;
let lastRunStartedAt: Date | null = null;
let lastRunEndedAt: Date | null = null;
// Tracks the last time the watchdog force-cleared the guard so runFullScrape
// can log a recovery notice before it stamps scrapeStatus:'running'.
let lastWatchdogClearAt: Date | null = null;

// Self-healing watchdog state
let lastAutoHealTime: Date | null = null;
let autoHealCount = 0;
const AUTO_HEAL_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes between auto-heals
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes = stale


// Maximum time a scrape can run before the guard is force-cleared (15 minutes).
// Raised from 8min: with the process-wide browser mutex (server/browserLock.ts)
// every main scrape chain legitimately runs well past 8min (X scraper alone is
// ~7min incl. anti-detection inter-account sleeps, plus DOW/sentDefender/OSINT
// and any time spent waiting behind an offset cron's lock). At 8min the watchdog
// would routinely force-clear a HEALTHY run and could fire forceKillAllBrowsers
// mid-scrape (the one residual cross-kill of a live lock-holder). 15min reflects
// post-lock reality while still recovering a genuinely wedged run twice as fast
// as the 30min staleness path.
const MAX_SCRAPE_DURATION_MS = 15 * 60 * 1000;

// Hard bound on a single full-scrape run. Set BELOW MAX_SCRAPE_DURATION_MS so the
// run always settles (success or clean failure) and stamps its status BEFORE the
// external watchdog would force-clear the guard WITHOUT stamping. This is what
// guarantees last_scrape_time advances and scrape_status leaves "running" every
// cycle, even when a sub-step hangs (an AI rate-limit storm, a stalled scraper,
// or shared-AI-client contention with the concurrent curated-ingest cron). Prod
// symptom this fixes: the chain hung on an unbounded await, so neither the
// success stamp nor the catch ever ran — scrape_status stuck on "running" and
// last_scrape_time frozen for hours while the watchdog force-killed it each cycle.
const SCRAPE_BODY_TIMEOUT_MS = MAX_SCRAPE_DURATION_MS - 60 * 1000; // 14 min

// Soft time budget for the OPTIONAL backfill browser scrapers (the X handle lanes
// + the 19-account OSINT list), measured from the body start. Left unbounded these
// loops alone run ~15-25 min every cycle — mostly fixed anti-rate-limit delays
// (9 X accounts x 35s + 19 OSINT accounts x 15s + 4 x 45s inter-scraper cooldowns)
// plus per-account scrape time — so the body never reaches its completion stamp and
// the SCRAPE_BODY_TIMEOUT_MS hard bound fires instead, EVERY cycle. When the X relay
// is healthy (the normal state) these scrapers are backfill-only (dedup-by-postId),
// so capping how long they may run is safe: any account not reached this cycle is
// delivered by the relay or picked up next cycle. Absolute deadline so slow upstream
// steps (Truth Social) shrink this window automatically, always leaving headroom for
// clustering + the completion stamp under the hard bound.
const BACKFILL_SOFT_BUDGET_MS = 10 * 60 * 1000; // 10 min

// Track influencer X auto-heal cooldown separately from main scrape auto-heal
let lastInfluencerXAutoHealTime: Date | null = null;
const INFLUENCER_X_AUTO_HEAL_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between influencer auto-heals

// Persist influencer X scrape outcome (timestamp + consecutive-empty count) so the
// watchdog can detect staleness/blocking, mirroring how the main scrape records
// xPostsConsecutiveEmpty for @SecWar/@PeteHegseth etc.
async function recordInfluencerXScrapeMetadata(result: { scrapedCount: number; addedCount: number }): Promise<void> {
  try {
    const current = await storage.getScrapeMetadata();
    const consecutiveEmpty = result.scrapedCount === 0
      ? (current?.influencerXConsecutiveEmpty || 0) + 1
      : 0;
    if (consecutiveEmpty >= 2) {
      console.warn(`⚠️ Influencer X: ${consecutiveEmpty} consecutive scrapes with 0 posts found - possible blocking`);
    }
    await storage.updateScrapeMetadata({
      influencerXLastScrapeTime: new Date(),
      influencerXLastCount: result.addedCount,
      influencerXConsecutiveEmpty: consecutiveEmpty,
    });
  } catch (error) {
    console.error('[Scheduler] Failed to record InfluencerX scrape metadata:', error);
  }
}

// Force kill ALL Chromium/Playwright processes system-wide
function forceKillAllBrowsers(): void {
  console.log('🔧 AUTO-HEAL: Force-killing all Chromium browser processes...');
  try {
    execSync('pkill -9 -f "chromium.*--headless" 2>/dev/null || true', { encoding: 'utf-8' });
    execSync('pkill -9 -f "chrome.*--headless" 2>/dev/null || true', { encoding: 'utf-8' });
  } catch (e) {
    // Ignore errors - processes may not exist
  }
}

// Race a promise against a hard timeout. Promise.race semantics: the underlying
// work is NOT cancelled (JS can't cancel an in-flight await) — it settles in the
// background; this only releases OUR await so the caller can stamp status and
// move on. Mirrors withAiTimeout (aiTimeout.ts) / withCuratedTimeout
// (curatedIngest.ts) used elsewhere for the same purpose.
function withScrapeTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Timeout (${ms}ms) for ${label}`);
      err.name = 'ScrapeTimeoutError'; // distinguishes a hard-bound timeout (work may still be running) from a genuine sub-step throw (work has stopped)
      reject(err);
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function runFullScrape(source: string): Promise<boolean> {
  // Watchdog: If previous scrape started more than MAX_SCRAPE_DURATION_MS ago, force-clear the guard
  if (isScrapingInProgress && lastRunStartedAt) {
    const elapsedMs = Date.now() - lastRunStartedAt.getTime();
    if (elapsedMs > MAX_SCRAPE_DURATION_MS) {
      console.warn(`⚠️ WATCHDOG: Previous scrape has been running for ${Math.round(elapsedMs / 1000 / 60)} minutes - force-clearing guard`);
      isScrapingInProgress = false;
      consecutiveSkips = 0;
      lastWatchdogClearAt = new Date();
      // Await the idle reset so the write completes before this call proceeds
      // to stamp scrapeStatus:'running' for the new run. Fire-and-forget risks
      // the idle write landing AFTER the 'running' stamp and flipping it back.
      try {
        await storage.updateScrapeMetadata({ scrapeStatus: 'idle' });
      } catch (err) {
        console.error('[Scheduler] Failed to reset scrapeStatus after runFullScrape watchdog force-clear:', err);
      }
    }
  }
  
  // Check re-entrancy guard
  if (isScrapingInProgress) {
    consecutiveSkips++;
    console.log(`⚠️ Skipping ${source} - previous scrape still in progress (skipped ${consecutiveSkips} times consecutively)`);
    return false;
  }

  isScrapingInProgress = true;
  consecutiveSkips = 0;
  lastRunStartedAt = new Date();

  // The entire scrape chain runs inside this inner function so it can be raced
  // against the hard SCRAPE_BODY_TIMEOUT_MS below. A normal pass settles well
  // within budget; a hung await (stalled scraper, AI rate-limit storm, slow DB
  // call) would otherwise leave runFullScrape pending forever — neither the
  // success stamp nor the catch would run, so scrape_status stayed "running" and
  // last_scrape_time never advanced (the chronic prod stall this fixes).
  const doScrape = async (): Promise<void> => {
    console.log(`Running ${source}...`);

    // Absolute deadline after which the OPTIONAL backfill browser scrapers stop
    // starting new accounts, so the body always finishes + stamps under the hard
    // bound instead of tripping SCRAPE_BODY_TIMEOUT_MS every cycle. See
    // BACKFILL_SOFT_BUDGET_MS. Measured from here (body start) so upstream slowness
    // (Truth Social) naturally shrinks the window.
    const backfillDeadline = Date.now() + BACKFILL_SOFT_BUDGET_MS;
    // Inter-scraper cooldown that skips itself once the budget is spent — no point
    // sleeping 45s to "cool down" before a scraper that is about to be budget-skipped.
    const backfillCooldown = async (ms: number): Promise<void> => {
      if (Date.now() >= backfillDeadline) {
        console.log('[Scheduler] Backfill time budget exhausted — skipping inter-scraper cooldown');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, ms));
    };
    
    // Belt-and-suspenders: if the watchdog force-cleared the guard right before
    // this run started, log it so operators can tell a wedge-recovery happened.
    if (lastWatchdogClearAt && (Date.now() - lastWatchdogClearAt.getTime()) < 60_000) {
      console.log('[Scheduler] ℹ️ Starting fresh run after watchdog guard reclaim — previous scrapeStatus was reset to idle');
    }

    // Update status to show scraping in progress
    await storage.updateScrapeMetadata({
      scrapeStatus: 'running',
    });
    
    // Clear old headlines (older than 48 hours)
    await storage.clearOldHeadlines(48);
    
    // NOTE: The direct Drudge scraper path has been retired — it was permanently
    // disabled and DrudgeBot (Team chat) covers Drudge content. Headlines table
    // is still populated by Warfighter RSS via the scheduled bot chain below.
    let newCount = 0;
    
    // Also scrape Truth Social posts
    console.log('Scraping Truth Social posts...');
    const truthSocialCount = await scrapeAllTruthSocial(storage);
    console.log(`Truth Social scrape complete: ${truthSocialCount} new posts added`);
    
    // Scrape X/Twitter posts SEQUENTIALLY with delays to avoid rate limiting.
    // The X relay ("Evangelist Vortex") is the primary source when healthy.
    // Skip the ENTIRE Playwright X chain when the relay heartbeat is fresh —
    // every post is already delivered by the relay and dedup-by-postId protects
    // against any overlap when PRIMARY resumes. The scrapers automatically resume
    // full PRIMARY duty the moment the heartbeat goes stale (>15 min).
    //
    // Declared in outer scope so consecutive-empty counter logic and metadata
    // writes (after this block) can reference them unconditionally.
    // xRelaySkipped = true means scrapers were intentionally skipped this cycle
    // and consecutive-empty counters must NOT be incremented (a healthy relay is
    // not a blocking signal; only actual zero-scrape attempts are).
    let xResult = { addedCount: 0, scrapedCount: 0 };
    let rapidResponseResult = { addedCount: 0, scrapedCount: 0 };
    let dowResponseResult = { addedCount: 0, scrapedCount: 0 };
    let sentDefenderResult = { addedCount: 0, scrapedCount: 0 };
    let osintResult = { addedCount: 0, scrapedCount: 0 };
    let xRelaySkipped = false;
    {
      const xRelayHealthy = isXRelayHealthy();
      const xHeartbeat = getXRelayHeartbeat();
      const xRelayAge = xHeartbeat > 0 ? `${Math.round((Date.now() - xHeartbeat) / 1000)}s ago` : 'NEVER';
      console.log(`[X-Relay] Relay heartbeat: ${xRelayAge} | Relay healthy: ${xRelayHealthy}`);

      if (xRelayHealthy) {
        console.log('[X-Relay] SKIPPING all X Playwright scrapers — relay healthy, posts already delivered via EV');
        xRelaySkipped = true;
      } else {
        console.log('[X-Relay] Relay stale/absent — running X Playwright scrapers in PRIMARY mode');

        // @SecWar/@PeteHegseth
        console.log('Scraping @SecWar...');
        xResult = await updateXPosts(storage, backfillDeadline);
        console.log(`@SecWar scrape complete: ${xResult.addedCount} new posts added (${xResult.scrapedCount} scraped)`);

        console.log('Waiting 45 seconds before next X scraper to allow resource cleanup...');
        await backfillCooldown(45000);

        // @Rapidresponse47
        console.log('Scraping @Rapidresponse47...');
        rapidResponseResult = await updateRapidResponsePosts(storage);
        console.log(`@Rapidresponse47 scrape complete: ${rapidResponseResult.addedCount} new posts added (${rapidResponseResult.scrapedCount} scraped)`);

        console.log('Waiting 45 seconds before next X scraper to allow resource cleanup...');
        await backfillCooldown(45000);

        // @DOWResponse
        console.log('Scraping @DOWResponse...');
        dowResponseResult = await updateDOWResponsePosts(storage);
        console.log(`@DOWResponse scrape complete: ${dowResponseResult.addedCount} new posts added (${dowResponseResult.scrapedCount} scraped)`);

        console.log('Waiting 45 seconds before next X scraper to allow resource cleanup...');
        await backfillCooldown(45000);

        // @sentdefender
        console.log('Scraping @sentdefender...');
        sentDefenderResult = await updateSentDefenderPosts(storage);
        console.log(`@sentdefender scrape complete: ${sentDefenderResult.addedCount} new posts added (${sentDefenderResult.scrapedCount} scraped)`);

        console.log('Waiting 45 seconds before OSINT scrapers to allow resource cleanup...');
        await backfillCooldown(45000);

        // OSINT feeds (@MATA_osint, @CENTCOM, @SOUTHCOM, @Osint613, @Osinttechnical, @FirstSquawk, @AggregateOsint)
        console.log('Scraping OSINT feeds (@MATA_osint, @CENTCOM, @SOUTHCOM, @Osint613, @Osinttechnical, @FirstSquawk, @AggregateOsint)...');
        osintResult = await updateOsintPosts(storage, backfillDeadline);
        console.log(`OSINT scrape complete: ${osintResult.addedCount} new posts added (${osintResult.scrapedCount} scraped)`);
      }
    }
    
    // NOTE: The Journalists X Feed (curated-lane-only) used to run here, at the
    // very tail of this long sequential chain, so it almost never got reached
    // before a restart/rate-limit. It now runs on its own dedicated cron below
    // (see "Journalist X Feed" schedule) and is serialized against OSINT via the
    // shared scrape lock in osintScraper.ts.
    
    // DataMinr First Alert used to run HERE, at the tail of this long sequential
    // scrape chain, so a slow/wedged scrape (X scrapers, paywall fetches, AI 429
    // storms) regularly delayed or skipped it — producing hour-plus gaps between
    // alert batches even though the feed itself had new items. It is a pure,
    // lightweight HTTP API call (no browser, no AI, no scrape lock), so it now
    // runs on its own dedicated every-5-min cron (see "DataMinr First Alert"
    // below), fully decoupled from this chain for fresher, more regular alerts.
    
    // Main-feed headline clustering used to run HERE, at the tail of this long
    // sequential scrape chain. In production the chain regularly ran past the
    // 20-min watchdog (slow X scrapers, paywall fetches, AI 429 storms) and was
    // force-cleared BEFORE reaching this point, so no new cluster IDs were ever
    // written and the main feed showed duplicate same-event stories. It now runs
    // on its own dedicated cron (see "Main-feed headline clustering" below), fully
    // decoupled from the scrape lock so a wedged scrape can no longer starve it.

    const { isTopicClusteringEnabled } = await import('./clusterConfig');
    if (isTopicClusteringEnabled()) {
      console.log('Running team submission clustering...');
      try {
        await clusterAllActiveTopics();
        console.log('Team submission clustering complete');
      } catch (teamClusterError) {
        console.error('Error during team submission clustering:', teamClusterError);
      }
    } else {
      console.log('Team submission clustering skipped (disabled by user)');
    }
    
    // Match submissions to Joe Priority / BOLO topics.
    // Enabled by default but gated to a deliberate cadence (and the matcher itself
    // early-returns instantly when no active topics exist) so it doesn't spend AI
    // calls on every scrape cycle.
    const { isJoePriorityMatchingEnabled, shouldRunJoePriorityMatching, markJoePriorityMatchingRan } = await import('./clusterConfig');
    if (shouldRunJoePriorityMatching()) {
      try {
        const { matched, ranAi } = await matchSubmissionsToJoePriorities();
        // Only advance the cadence window when the matcher actually spent AI work.
        // A transient failure (caught below) or an early-return with nothing to do
        // leaves the window open so the next scrape cycle retries promptly — keeping
        // the matcher responsive right after a new topic is added.
        if (ranAi) {
          markJoePriorityMatchingRan();
        }
        if (matched > 0) {
          console.log(`Joe Priority/BOLO matching complete: ${matched} new matches`);
        }
      } catch (matchError) {
        console.error('Error during Joe Priority/BOLO matching:', matchError);
      }
    } else if (!isJoePriorityMatchingEnabled()) {
      console.log('Joe Priority/BOLO matching skipped (paused)');
    } else {
      console.log('Joe Priority/BOLO matching skipped (cadence interval not elapsed)');
    }
    
    // Update scrape metadata with timestamps and counts
    lastRunEndedAt = new Date();
    const duration = lastRunEndedAt.getTime() - (lastRunStartedAt?.getTime() ?? lastRunEndedAt.getTime());
    console.log(`✅ Full scrape cycle completed in ${Math.round(duration / 1000)} seconds`);

    // Custom-MCOP scoring used to run here, inline at the tail of EVERY main
    // scrape (*/10, the :x0 minute that already holds the scrape lock + main
    // clustering/scoring). Task #484 moved it to its own less-frequent,
    // de-collided cron (see "Custom-MCOP scoring" schedule below) to cut its AI
    // load and keep it off the heaviest AI minute.
    
    // Get current metadata to track consecutive empty results
    const currentMetadata = await storage.getScrapeMetadata();
    
    // Track consecutive empty results for BLOCKING detection.
    // Key insight: Use scrapedCount (posts found on page) NOT addedCount (new
    // posts added) — if scrapedCount is 0, X is likely blocking us; if
    // scrapedCount > 0 but addedCount is 0 the posts are just duplicates.
    //
    // When the relay is healthy and scrapers were intentionally skipped this
    // cycle (xRelaySkipped), preserve the prior counter values unchanged.
    // A relay-healthy skip is NOT a blocking signal and must not increment
    // these counters, or the pipeline health dashboard falsely shows blocking
    // even while posts are flowing in normally through the relay.
    const xPostsConsecutiveEmpty = xRelaySkipped
      ? (currentMetadata?.xPostsConsecutiveEmpty || 0)
      : xResult.scrapedCount === 0
        ? (currentMetadata?.xPostsConsecutiveEmpty || 0) + 1
        : 0;
    const rapidResponseConsecutiveEmpty = xRelaySkipped
      ? (currentMetadata?.rapidResponseConsecutiveEmpty || 0)
      : rapidResponseResult.scrapedCount === 0
        ? (currentMetadata?.rapidResponseConsecutiveEmpty || 0) + 1
        : 0;
    const dowResponseConsecutiveEmpty = xRelaySkipped
      ? (currentMetadata?.dowResponseConsecutiveEmpty || 0)
      : dowResponseResult.scrapedCount === 0
        ? (currentMetadata?.dowResponseConsecutiveEmpty || 0) + 1
        : 0;
    const sentDefenderConsecutiveEmpty = xRelaySkipped
      ? (currentMetadata?.sentDefenderConsecutiveEmpty || 0)
      : sentDefenderResult.scrapedCount === 0
        ? (currentMetadata?.sentDefenderConsecutiveEmpty || 0) + 1
        : 0;
    const osintConsecutiveEmpty = xRelaySkipped
      ? (currentMetadata?.osintConsecutiveEmpty || 0)
      : osintResult.scrapedCount === 0
        ? (currentMetadata?.osintConsecutiveEmpty || 0) + 1
        : 0;
    
    // Log blocking warnings (only meaningful when scrapers actually ran)
    if (!xRelaySkipped) {
      if (xPostsConsecutiveEmpty >= 2) {
        console.warn(`⚠️ @SecWar/@PeteHegseth: ${xPostsConsecutiveEmpty} consecutive scrapes with 0 posts found - possible blocking`);
      }
      if (rapidResponseConsecutiveEmpty >= 2) {
        console.warn(`⚠️ @Rapidresponse47: ${rapidResponseConsecutiveEmpty} consecutive scrapes with 0 posts found - possible blocking`);
      }
      if (dowResponseConsecutiveEmpty >= 2) {
        console.warn(`⚠️ @DOWResponse: ${dowResponseConsecutiveEmpty} consecutive scrapes with 0 posts found - possible blocking`);
      }
      if (sentDefenderConsecutiveEmpty >= 2) {
        console.warn(`⚠️ @sentdefender: ${sentDefenderConsecutiveEmpty} consecutive scrapes with 0 posts found - possible blocking`);
      }
      if (osintConsecutiveEmpty >= 2) {
        console.warn(`⚠️ OSINT feeds: ${osintConsecutiveEmpty} consecutive scrapes with 0 posts found - possible blocking`);
      }
    }
    
    await storage.updateScrapeMetadata({
      lastScrapeTime: lastRunEndedAt,
      headlinesLastScrapeTime: lastRunEndedAt,
      headlinesLastCount: newCount,
      truthSocialLastScrapeTime: lastRunEndedAt,
      truthSocialLastCount: truthSocialCount,
      // When relay was healthy and scrapers were skipped, preserve prior X
      // timestamps/counts rather than overwriting with zeros (which would
      // falsely show the last scrape as "now with 0 posts added").
      ...(xRelaySkipped ? {} : {
        xPostsLastScrapeTime: lastRunEndedAt,
        xPostsLastCount: xResult.addedCount,
        rapidResponseLastScrapeTime: lastRunEndedAt,
        rapidResponseLastCount: rapidResponseResult.addedCount,
        dowResponseLastScrapeTime: lastRunEndedAt,
        dowResponseLastCount: dowResponseResult.addedCount,
        sentDefenderLastScrapeTime: lastRunEndedAt,
        sentDefenderLastCount: sentDefenderResult.addedCount,
        osintLastScrapeTime: lastRunEndedAt,
        osintLastCount: osintResult.addedCount,
      }),
      xPostsConsecutiveEmpty,
      rapidResponseConsecutiveEmpty,
      dowResponseConsecutiveEmpty,
      sentDefenderConsecutiveEmpty,
      osintConsecutiveEmpty,
      scrapeStatus: 'idle',
    });
  };

  // Set true ONLY when the hard bound fires (vs a genuine sub-step throw). On a
  // timeout the inner doScrape() keeps running in the background — Promise.race
  // can't cancel it — so we must NOT report completion to callers (see return).
  let timedOut = false;

  try {
    // Hard overall bound. On timeout the race rejects into the catch below, which
    // stamps a truthful status + advances the timestamps, then the finally
    // releases the guard — so a wedged run can no longer stay stuck on "running"
    // past the watchdog or chronically trigger "another scrape active" skips.
    await withScrapeTimeout(doScrape(), SCRAPE_BODY_TIMEOUT_MS, 'runFullScrape');
  } catch (error) {
    console.error('Error in scrape:', error);
    timedOut = error instanceof Error && error.name === 'ScrapeTimeoutError';
    if (timedOut) {
      // The hung doScrape() is still executing. Force-kill any Chromium it's
      // holding so its background browser work can't keep contending for memory
      // after we release the guard (it can't be cooperatively cancelled).
      console.warn('[Scheduler] runFullScrape exceeded its hard bound — force-killing browsers to contain the background run');
      forceKillAllBrowsers();
    }
    // Resilient stamp: advance last_scrape_time / headlines_last_scrape_time and
    // reset scrape_status even when a sub-step errors OR the whole run times out,
    // so the scheduler health signals (Coverage tab, staleness watchdog) stay
    // truthful instead of freezing on a stale timestamp + perpetual "running".
    try {
      const stampedAt = new Date();
      await storage.updateScrapeMetadata({
        lastScrapeTime: stampedAt,
        headlinesLastScrapeTime: stampedAt,
        lastError: error instanceof Error ? error.message : String(error),
        lastErrorTime: stampedAt,
        scrapeStatus: 'idle',
      });
    } catch (stampError) {
      console.error('Failed to stamp scrape metadata on error path:', stampError);
    }
  } finally {
    // ALWAYS reset the guard in finally block
    isScrapingInProgress = false;
    lastRunEndedAt = new Date();
  }

  // Return semantics: true = this call ran the scrape to a settled end (success,
  // or a genuine sub-step error where the body actually stopped); false = either
  // it skipped (another scrape active) OR it timed out with doScrape() still
  // running in the background. Callers gate their heavy image-buffer media passes
  // on this return, so returning false on timeout keeps them from stacking image
  // buffers onto a still-running scrape (the prod OOM/overlap risk).
  return !timedOut;
}

// Self-healing watchdog - checks for stale scraper runs AND blocking detection
async function runSelfHealingCheck(): Promise<void> {
  // If a scrape is in progress, check if it's been running too long (hung)
  if (isScrapingInProgress) {
    if (lastRunStartedAt) {
      const elapsedMs = Date.now() - lastRunStartedAt.getTime();
      if (elapsedMs > MAX_SCRAPE_DURATION_MS) {
        console.warn(`\n⚠️ WATCHDOG: Scrape has been running for ${Math.round(elapsedMs / 1000 / 60)} minutes - force-clearing guard and killing browsers`);
        forceKillAllBrowsers();
        isScrapingInProgress = false;
        consecutiveSkips = 0;
        lastWatchdogClearAt = new Date();
        // Await the idle reset — if auto-heal triggers runFullScrape shortly
        // after, the 'running' stamp for the new run must not be preceded by
        // a still-in-flight idle write that would then overwrite it.
        try {
          await storage.updateScrapeMetadata({ scrapeStatus: 'idle' });
        } catch (err) {
          console.error('[Scheduler] Failed to reset scrapeStatus after self-heal watchdog force-clear:', err);
        }
        // Continue to staleness check below
      } else {
        // Scrape is legitimately in progress and not stale yet
        return;
      }
    } else {
      // Guard is set but no start time recorded - this is a bug, clear it
      console.warn('⚠️ WATCHDOG: Scraping guard is set but no start time - clearing');
      isScrapingInProgress = false;
      consecutiveSkips = 0;
      lastWatchdogClearAt = new Date();
      // Await the idle reset for the same ordering reason as the elapsed path above.
      try {
        await storage.updateScrapeMetadata({ scrapeStatus: 'idle' });
      } catch (err) {
        console.error('[Scheduler] Failed to reset scrapeStatus after self-heal watchdog no-start-time clear:', err);
      }
    }
  }
  
  // Skip if we just auto-healed recently (cooldown period)
  if (lastAutoHealTime) {
    const timeSinceLastHeal = Date.now() - lastAutoHealTime.getTime();
    if (timeSinceLastHeal < AUTO_HEAL_COOLDOWN_MS) {
      return;
    }
  }
  
  try {
    const metadata = await storage.getScrapeMetadata();
    if (!metadata) {
      return; // No metadata yet, skip check
    }
    
    const now = Date.now();
    const staleFeeds: string[] = [];
    const blockedFeeds: string[] = [];

    // While the EV X relay heartbeat is healthy, the X Playwright scrapers are
    // INTENTIONALLY not running (relay delivers the posts), so their "last
    // scrape" timestamps naturally age past the stale threshold. Treating that
    // as staleness fires the exact browser work the relay replaced. Gate every
    // X-lane staleness/blocking signal on relay health: healthy relay = lane
    // is fresh via relay delivery; stale relay = normal fallback recovery.
    const xRelayHealthyForHeal = isXRelayHealthy();

    // ===== STALENESS DETECTION (scraper hasn't run) =====
    const lastScrapeTime = metadata.lastScrapeTime;
    if (lastScrapeTime && (now - new Date(lastScrapeTime).getTime()) > STALE_THRESHOLD_MS) {
      staleFeeds.push(`Full scrape cycle (${Math.round((now - new Date(lastScrapeTime).getTime()) / 60000)} min stale)`);
    }
    
    if (metadata.xPostsLastScrapeTime) {
      const xAge = now - new Date(metadata.xPostsLastScrapeTime).getTime();
      if (xAge > STALE_THRESHOLD_MS) {
        if (xRelayHealthyForHeal) {
          console.log(`🔧 AUTO-HEAL: X feeds last scraped ${Math.round(xAge / 60000)} min ago but X relay is HEALTHY — treating lane as fresh (relay-delivered), no recovery`);
        } else {
          staleFeeds.push(`X feeds (${Math.round(xAge / 60000)} min since last scrape, relay stale — fallback mode)`);
        }
      }
    }

    // ===== BLOCKING DETECTION (scraper runs but gets no data) =====
    // Trigger recovery if 3+ consecutive scrapes returned 0 posts
    const BLOCKING_THRESHOLD = 3;

    // Influencer X runs on its own cron (:15, :45) so it should report fresh data
    // at most ~30 minutes after the last cycle. Allow extra slack for the slow
    // sequential per-account scrape (16 accounts x ~60s timeout each).
    const INFLUENCER_X_STALE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes
    const influencerXAgeMs = metadata.influencerXLastScrapeTime
      ? now - new Date(metadata.influencerXLastScrapeTime).getTime()
      : 0;
    // Relay-health gate: while the relay is healthy the influencer scraper is
    // intentionally skipped (its cron early-returns), so an aging timestamp or
    // a leftover consecutive-empty count from before the relay recovered must
    // NOT fire a fresh Chromium scrape — the relay is delivering those posts.
    const influencerXStaleRaw = !!metadata.influencerXLastScrapeTime
      && influencerXAgeMs > INFLUENCER_X_STALE_THRESHOLD_MS;
    const influencerXBlockedRaw = (metadata.influencerXConsecutiveEmpty || 0) >= BLOCKING_THRESHOLD;
    if (xRelayHealthyForHeal && (influencerXStaleRaw || influencerXBlockedRaw)) {
      console.log(`🔧 AUTO-HEAL: Influencer X ${influencerXStaleRaw ? `stale (${Math.round(influencerXAgeMs / 60000)} min)` : ''}${influencerXStaleRaw && influencerXBlockedRaw ? ' + ' : ''}${influencerXBlockedRaw ? `${metadata.influencerXConsecutiveEmpty} consecutive empty` : ''} but X relay is HEALTHY — treating lane as fresh (relay-delivered), no recovery`);
    }
    const influencerXStale = influencerXStaleRaw && !xRelayHealthyForHeal;
    const influencerXBlocked = influencerXBlockedRaw && !xRelayHealthyForHeal;
    
    // X blocking counters are frozen while the relay is healthy (scrapers are
    // skipped, not blocked), so any count ≥ threshold here predates the relay
    // recovering. A healthy relay covers these lanes — skip blocking recovery.
    if (xRelayHealthyForHeal) {
      const frozenBlocked: string[] = [];
      if ((metadata.xPostsConsecutiveEmpty || 0) >= BLOCKING_THRESHOLD) frozenBlocked.push('@SecWar/@PeteHegseth');
      if ((metadata.rapidResponseConsecutiveEmpty || 0) >= BLOCKING_THRESHOLD) frozenBlocked.push('@Rapidresponse47');
      if ((metadata.dowResponseConsecutiveEmpty || 0) >= BLOCKING_THRESHOLD) frozenBlocked.push('@DOWResponse');
      if ((metadata.sentDefenderConsecutiveEmpty || 0) >= BLOCKING_THRESHOLD) frozenBlocked.push('@sentdefender');
      if (frozenBlocked.length > 0) {
        console.log(`🔧 AUTO-HEAL: Stale X blocking counters (${frozenBlocked.join(', ')}) ignored — X relay is HEALTHY, lanes covered by relay delivery`);
      }
    } else {
      if ((metadata.xPostsConsecutiveEmpty || 0) >= BLOCKING_THRESHOLD) {
        blockedFeeds.push(`@SecWar/@PeteHegseth (${metadata.xPostsConsecutiveEmpty} empty)`);
      }
      if ((metadata.rapidResponseConsecutiveEmpty || 0) >= BLOCKING_THRESHOLD) {
        blockedFeeds.push(`@Rapidresponse47 (${metadata.rapidResponseConsecutiveEmpty} empty)`);
      }
      if ((metadata.dowResponseConsecutiveEmpty || 0) >= BLOCKING_THRESHOLD) {
        blockedFeeds.push(`@DOWResponse (${metadata.dowResponseConsecutiveEmpty} empty)`);
      }
      if ((metadata.sentDefenderConsecutiveEmpty || 0) >= BLOCKING_THRESHOLD) {
        blockedFeeds.push(`@sentdefender (${metadata.sentDefenderConsecutiveEmpty} empty)`);
      }
    }
    
    // Check if blocking recovery cooldown has passed (1 hour for blocking recovery)
    const BLOCKING_RECOVERY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
    const lastBlockingRecovery = metadata.lastBlockingRecoveryTime;
    const canRecoverFromBlocking = !lastBlockingRecovery || 
      (now - new Date(lastBlockingRecovery).getTime()) > BLOCKING_RECOVERY_COOLDOWN_MS;
    
    // ===== TRIGGER RECOVERY =====
    const needsStalenessRecovery = staleFeeds.length > 0;
    const needsBlockingRecovery = blockedFeeds.length > 0 && canRecoverFromBlocking;
    
    if (needsStalenessRecovery || needsBlockingRecovery) {
      autoHealCount++;
      lastAutoHealTime = new Date();
      
      if (needsStalenessRecovery) {
        console.log(`\n🔧 AUTO-HEAL #${autoHealCount}: Detected stale scraper - ${staleFeeds.join(', ')} [X relay ${xRelayHealthyForHeal ? 'HEALTHY (X lanes exempt)' : 'STALE (fallback mode)'}]`);
      }
      if (needsBlockingRecovery) {
        console.log(`\n🔧 AUTO-HEAL #${autoHealCount}: Detected X blocking - ${blockedFeeds.join(', ')}`);
        // Record blocking recovery attempt
        await storage.updateScrapeMetadata({
          lastBlockingRecoveryTime: new Date(),
          blockingRecoveryCount: (metadata.blockingRecoveryCount || 0) + 1,
        });
      }
      
      console.log('🔧 AUTO-HEAL: Initiating recovery sequence...');
      
      // Step 1: Force kill all browsers (clears any stuck sessions)
      forceKillAllBrowsers();
      
      // Step 2: Reset the scraping guard
      if (!isScrapingInProgress) {
        consecutiveSkips = 0;
      }

      // Best-effort: reset scrapeStatus to idle so the Coverage UI reflects
      // the correct state before the fresh scrape below stamps it 'running'.
      // This covers stale/blocking recoveries where a prior wedged run may
      // have left scrapeStatus stuck on 'running' in the DB.
      try {
        await storage.updateScrapeMetadata({ scrapeStatus: 'idle' });
      } catch (err) {
        console.error('[Scheduler] Failed to reset scrapeStatus in staleness/blocking recovery:', err);
      }
      
      // Step 3: Wait longer for blocking recovery (allows X rate limits to cool down)
      const waitTime = needsBlockingRecovery ? 10000 : 2000; // 10s for blocking, 2s for staleness
      console.log(`🔧 AUTO-HEAL: Waiting ${waitTime / 1000}s for browser processes to clear...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      
      // Step 4: Trigger a fresh full scrape
      if (!isScrapingInProgress) {
        console.log('🔧 AUTO-HEAL: Starting fresh scrape cycle...');
        await runFullScrape('auto-heal recovery scrape');
        console.log(`🔧 AUTO-HEAL #${autoHealCount}: Recovery complete\n`);
      } else {
        console.log('🔧 AUTO-HEAL: Scrape already in progress, skipping recovery scrape');
      }
    }

    // ===== INFLUENCER X RECOVERY (separate path) =====
    // Runs independently of the main scrape recovery so we don't burn the
    // main-scrape cooldown on influencer-only failures, and so we re-run only
    // the influencer scraper (re-running the full scrape wouldn't help it).
    const influencerXCanRecover = !lastInfluencerXAutoHealTime
      || (Date.now() - lastInfluencerXAutoHealTime.getTime()) > INFLUENCER_X_AUTO_HEAL_COOLDOWN_MS;

    if ((influencerXStale || influencerXBlocked) && influencerXCanRecover) {
      autoHealCount++;
      lastInfluencerXAutoHealTime = new Date();

      if (influencerXStale) {
        console.log(`\n🔧 AUTO-HEAL #${autoHealCount}: Influencer X is stale (${Math.round(influencerXAgeMs / 60000)} min since last scrape) [X relay STALE — fallback mode]`);
      }
      if (influencerXBlocked) {
        console.log(`\n🔧 AUTO-HEAL #${autoHealCount}: Influencer X possibly blocked (${metadata.influencerXConsecutiveEmpty} consecutive empty scrapes)`);
      }

      console.log('🔧 AUTO-HEAL: Initiating Influencer X recovery sequence...');

      // Step 1: Force kill all browsers (clears any stuck Playwright sessions)
      forceKillAllBrowsers();

      // Step 2: Wait longer if blocked so X rate limits can cool down
      const influencerWaitMs = influencerXBlocked ? 10000 : 2000;
      console.log(`🔧 AUTO-HEAL: Waiting ${influencerWaitMs / 1000}s for browser processes to clear...`);
      await new Promise(resolve => setTimeout(resolve, influencerWaitMs));

      // Step 3: Re-run only the influencer X scraper. The shared X-scrape lock
      // inside xScraper.ts will serialize this safely against any other X scrape.
      try {
        console.log('🔧 AUTO-HEAL: Starting fresh Influencer X scrape...');
        const { updateInfluencerXPosts } = await import('./xScraper');
        const result = await updateInfluencerXPosts(storage);
        console.log(`🔧 AUTO-HEAL #${autoHealCount}: Influencer X recovery complete - Added: ${result.addedCount} (scraped: ${result.scrapedCount})\n`);
        await recordInfluencerXScrapeMetadata(result);
      } catch (recoveryErr) {
        console.error('🔧 AUTO-HEAL: Influencer X recovery scrape failed:', recoveryErr);
        await recordInfluencerXScrapeMetadata({ scrapedCount: 0, addedCount: 0 });
      }
    }
  } catch (error) {
    console.error('Error in self-healing check:', error);
  }
}

export function startScheduledScraping() {
  // Run scraper every 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    // Sample + log file-descriptor usage once per scrape cycle so a slow FD
    // leak (the cause of the prior EMFILE crash) is visible before it crashes.
    logFdSample();

    const scraped = await runFullScrape('scheduled scrape');

    // Only run the image-buffer media passes if THIS call actually ran the
    // scrape. If it skipped (another scrape — e.g. the boot warm-up — is still
    // active), running media now would stack image buffers onto that scrape's
    // Chromium memory, recreating the spike that OOM'd prod. The next */10 cycle
    // (and the recurring backfills) will cover media once the scrape is idle.
    if (!scraped) {
      console.log('[Scheduler] Scheduled scrape skipped (another scrape active) — skipping media pre-fetch to avoid overlap');
    } else {
      try {
        const { prefetchStreamMedia } = await import('./streamPrefetch');
        console.log('[Scheduler] Running Stream media pre-fetch...');
        await prefetchStreamMedia();
        console.log('[Scheduler] Stream media pre-fetch complete');
      } catch (error) {
        console.error('[Scheduler] Stream media pre-fetch error:', error);
      }

      // Curated lane (Task #124) — enrich the visible curated window (photos + AI
      // bullets) right after the main prefetch. Runs sequentially so it never
      // contends with the main-feed worker for the shared stream-media mutex.
      // Writes ONLY to curated_items; never touches the main feed.
      try {
        const { prefetchCuratedMedia } = await import('./streamPrefetch');
        await prefetchCuratedMedia();
      } catch (error) {
        console.error('[Scheduler] Curated media pre-fetch error:', error);
      }

      // SecWar X post images (Task #680) — resolve og:image in the background and
      // persist to x_posts.image_url so /api/stream serves stored images instead
      // of scraping x.com inline in the request path. Runs sequentially after
      // the other media workers (shared stream-media mutex).
      try {
        const { prefetchXPostMedia } = await import('./streamPrefetch');
        await prefetchXPostMedia();
      } catch (error) {
        console.error('[Scheduler] X post media pre-fetch error:', error);
      }
    }
  });
  
  // Run self-healing watchdog every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    await runSelfHealingCheck();
  });

  // Backfill stale stream media every 5 minutes (offset from the */10 scrape).
  // The per-cycle prefetchStreamMedia only enriches the top 11 items, so anything
  // that was bumped out of the top window (especially auto-MCOP'd bot submissions)
  // would otherwise stay stuck with no image / no bullets indefinitely.
  cron.schedule('2,7,12,17,22,27,32,37,42,47,52,57 * * * *', async () => {
    try {
      const { backfillStaleStreamMedia } = await import('./streamPrefetch');
      const result = await backfillStaleStreamMedia(6, 30);
      if (result.enhanced > 0 || result.failed > 0) {
        console.log(`[Scheduler] Stream backfill: ${result.enhanced} enhanced, ${result.skipped} skipped, ${result.failed} failed (scanned ${result.scanned})`);
      }
    } catch (error) {
      console.error('[Scheduler] Stream backfill error:', error);
    }
  });

  // Curated lane (Task #124) — backfill curated_items that scrolled out of the
  // live prefetch window before they were enriched. Offset to :06/:16/... so it
  // doesn't collide with the main backfill (:02/:07/...) or curated ingest/cluster.
  // Writes ONLY to curated_items.
  cron.schedule('6,16,26,36,46,56 * * * *', async () => {
    try {
      const { backfillStaleCuratedMedia } = await import('./streamPrefetch');
      const result = await backfillStaleCuratedMedia(6, 30);
      if (result.enhanced > 0 || result.carried > 0 || result.failed > 0) {
        console.log(`[Scheduler] Curated backfill: ${result.carried} carried, ${result.enhanced} enhanced, ${result.skipped} skipped, ${result.failed} failed (scanned ${result.scanned})`);
      }
    } catch (error) {
      console.error('[Scheduler] Curated backfill error:', error);
    }
  });

  // Curated lane (Task #226) — dead-link liveness probe. Round-robins recent
  // curated_items (oldest-checked first), flags genuinely dead article URLs
  // (confirmed HTTP 404/410), and revives any that come back 2xx. Offset to
  // :08/:18/... so it doesn't collide with curated prefetch (:00) / backfill
  // (:06) / ingest / cluster. Writes ONLY to curated_items (lane isolation).
  cron.schedule('8,18,28,38,48,58 * * * *', async () => {
    try {
      const { checkCuratedLinkLiveness } = await import('./streamPrefetch');
      const result = await checkCuratedLinkLiveness(36, 30);
      if (result.dead > 0 || result.revived > 0) {
        console.log(`[Scheduler] Curated liveness: ${result.dead} newly dead, ${result.revived} revived (checked ${result.checked})`);
      }
    } catch (error) {
      console.error('[Scheduler] Curated liveness error:', error);
    }
  });

  // Curated lane (Task #650) — one-time-ish backfill flagging page-labeled
  // ANALYSIS/OPINION pieces that were enriched BEFORE this detector existed
  // (stamped content_kind='article' by the old code path). Re-fetches each
  // page (bounded, low volume) and only ever upgrades article -> opinion.
  // Offset to :24/:54 so it doesn't collide with any other curated cron.
  // Writes ONLY to curated_items.contentKind.
  cron.schedule('24,54 * * * *', async () => {
    try {
      const { backfillCuratedOpinionAnalysis } = await import('./streamPrefetch');
      const result = await backfillCuratedOpinionAnalysis();
      if (result.flagged > 0 || result.failed > 0) {
        console.log(`[Scheduler] Curated opinion/analysis backfill: ${result.flagged} flagged, ${result.failed} failed (scanned ${result.scanned})`);
      }
    } catch (error) {
      console.error('[Scheduler] Curated opinion/analysis backfill error:', error);
    }
  });

  // Curated lane (Task #677) — one-time-ish backfill flagging NPR broadcast
  // (podcast) segments that were enriched BEFORE the "HEARD ON <program>" /
  // "Audio will be available later today" signals existed (stamped
  // content_kind='article' by the old code path). Re-fetches each page
  // (bounded <= 25, NPR-only, low volume) and only ever upgrades article -> audio.
  // Runs at :09/:39. NOTE: the grid is fully saturated (see de-collision policy
  // below), so the :x9 slot also carries the curated-clustering job — but this
  // backfill is non-AI, bounded, and holds its own worker-mutex label, so it never
  // contends with clustering's AI budget or browser lock.
  // Writes ONLY to curated_items.contentKind.
  cron.schedule('9,39 * * * *', async () => {
    try {
      const { backfillCuratedNprAudioSegments } = await import('./streamPrefetch');
      const result = await backfillCuratedNprAudioSegments();
      if (result.flagged > 0 || result.failed > 0) {
        console.log(`[Scheduler] Curated NPR audio backfill: ${result.flagged} flagged, ${result.failed} failed (scanned ${result.scanned})`);
      }
    } catch (error) {
      console.error('[Scheduler] Curated NPR audio backfill error:', error);
    }
  });

  // Curated lane (Task #933) — recovers the real original-publish date for
  // ALREADY-enriched curated rows still showing "First seen" (article_published_at
  // IS NULL AND media_scraped_at IS NOT NULL). New/un-enriched rows get their date
  // recovered for free during normal media enrichment, so this pass only mops up
  // rows that won't be re-enriched (chiefly off-host Bing-discovered items whose
  // discovery bot captured title+url only). It re-fetches each page (bounded <= 40,
  // last 48h) and NULL-guards every write. Runs at :19/:49 — the clustering minute
  // class (:x4/:x9), like the opinion/NPR-audio backfills above: non-AI and bounded,
  // and it takes the SHARED stream-media worker slot (tryAcquireWorker is one global
  // mutex; the label is only for logging). So if a media prefetch/backfill/liveness
  // job (:x6/:x8) is still running it simply skips this cycle (and vice versa) and
  // self-heals next slot — single-flighting the stream-media fetchers, never a hang.
  // It carries no AI, so it never touches clustering's AI budget or browser lock.
  // Writes ONLY to curated_items.articlePublishedAt (lane isolation).
  cron.schedule('19,49 * * * *', async () => {
    try {
      const { backfillCuratedPublishedDates } = await import('./streamPrefetch');
      const result = await backfillCuratedPublishedDates(48, 40);
      if (result.recovered > 0 || result.failed > 0) {
        console.log(`[Scheduler] Curated published-date backfill: ${result.recovered} recovered, ${result.skipped} skipped, ${result.failed} failed (scanned ${result.scanned})`);
      }
    } catch (error) {
      console.error('[Scheduler] Curated published-date backfill error:', error);
    }
  });

  // ── News-bot AI de-collision ────────────────────────────────────────────
  // The cron grid is fully saturated: every minute already carries a recurring
  // every-5/every-10 job, so "zero collision" is impossible. Instead each news
  // bot's relevance/summary cron is placed so it only ever shares its minute
  // with NON-AI recurring work, and never with another news bot:
  //   - The 30-min bots (Drudge/BBC/Social) sit on the :x8 class, which only
  //     carries the curated link-liveness check (HTTP HEAD, no AI) and the
  //     curated off-host discovery bots (bounded, light AI).
  //   - Fox/ABC/CBS/NBC bots sit on the :x6 class (6,16,26,36), which carries
  //     ONLY curated media backfill (non-AI), curated incremental-attach (non-AI),
  //     and the dormant curated-reshape request (non-AI) — no other AI job fires
  //     on these minutes.  NOTE: they were previously on the :x7 class, which
  //     was incorrectly described as "non-AI" — curated ingest IS AI-heavy and
  //     runs every 5 min on the :x2/:x7 class, creating a direct AI-on-AI
  //     collision with every hourly bot.  The :x6 shift removes that collision.
  //   - AP/Reuters bots sit on :33/:03 (the :x3 non-score-retry sub-class):
  //     AI neighbours are Warfighter RSS (every 5 min, lightweight score-only)
  //     and headline clustering (every 10 min, gpt-4o-mini-pinned, bounded) —
  //     both much lighter than curated ingest (AI, every 5 min).  The :x6
  //     minutes :46/:56 were ruled out because STATE_MEDIA_CRON_MINUTES places
  //     curated scrapers there (admitCuratedCandidates → AI scoring).
  // This keeps every AI news bot OFF the heaviest AI jobs — main scrape (:x0,
  // holds the scrape lock + clustering/scoring), curated classify (:x5), curated
  // clustering (:x4/:x9), RSS + incremental-attach (:x1, double AI 12×/hr),
  // curated ingest (:x2/:x7, AI 12×/hr), the warfighter scraper (:x3), and the
  // CNN/NPR curated bots (:42/:44).
  // aiClient still serializes/spaces every call, so this just flattens the peak
  // burst instead of letting AI jobs pile onto the same wake-up.
  //
  // Run DrudgeBot every 30 minutes (at :08 and :38)
  cron.schedule('8,38 * * * *', async () => {
    if (!isBotEnabled('drudgeBot')) { console.log('[Scheduler] DrudgeBot is paused, skipping'); return; }
    console.log('[Scheduler] Running DrudgeBot...');
    try {
      const result = await runDrudgeBot();
      console.log(`[Scheduler] DrudgeBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    } catch (error) {
      console.error('[Scheduler] DrudgeBot error:', error);
    }
  });
  
  // Run BBCBot every 30 minutes (at :18 and :48)
  cron.schedule('18,48 * * * *', async () => {
    if (!isBotEnabled('bbcBot')) { console.log('[Scheduler] BBCBot is paused, skipping'); return; }
    console.log('[Scheduler] Running BBCBot...');
    try {
      const result = await runBBCBot();
      console.log(`[Scheduler] BBCBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    } catch (error) {
      console.error('[Scheduler] BBCBot error:', error);
    }
  });
  
  // Run SocialBot every 30 minutes (at :28 and :58)
  cron.schedule('28,58 * * * *', async () => {
    if (!isBotEnabled('socialBot')) { console.log('[Scheduler] SocialBot is paused, skipping'); return; }
    console.log('[Scheduler] Running SocialBot...');
    try {
      const result = await runSocialBot();
      console.log(`[Scheduler] SocialBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    } catch (error) {
      console.error('[Scheduler] SocialBot error:', error);
    }
  });
  
  // Run FoxNewsBot every hour (at :06 — :x6 class, non-AI neighbours only)
  cron.schedule('6 * * * *', async () => {
    if (!isBotEnabled('foxNewsBot')) { console.log('[Scheduler] FoxNewsBot is paused, skipping'); return; }
    console.log('[Scheduler] Running FoxNewsBot...');
    try {
      const result = await runFoxNewsBot();
      console.log(`[Scheduler] FoxNewsBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    } catch (error) {
      console.error('[Scheduler] FoxNewsBot error:', error);
    }
  });
  
  // Run ABCNewsBot every hour (at :16 — :x6 class, non-AI neighbours only)
  cron.schedule('16 * * * *', async () => {
    if (!isBotEnabled('abcNewsBot')) { console.log('[Scheduler] ABCNewsBot is paused, skipping'); return; }
    console.log('[Scheduler] Running ABCNewsBot...');
    try {
      const result = await runABCNewsBot();
      console.log(`[Scheduler] ABCNewsBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    } catch (error) {
      console.error('[Scheduler] ABCNewsBot error:', error);
    }
  });
  
  // Run CBSNewsBot every hour (at :26 — :x6 class, non-AI neighbours only)
  cron.schedule('26 * * * *', async () => {
    if (!isBotEnabled('cbsNewsBot')) { console.log('[Scheduler] CBSNewsBot is paused, skipping'); return; }
    console.log('[Scheduler] Running CBSNewsBot...');
    try {
      const result = await runCBSNewsBot();
      console.log(`[Scheduler] CBSNewsBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    } catch (error) {
      console.error('[Scheduler] CBSNewsBot error:', error);
    }
  });
  
  // Run NBCNewsBot every hour (at :36 — :x6 class, non-AI neighbours only)
  cron.schedule('36 * * * *', async () => {
    if (!isBotEnabled('nbcNewsBot')) { console.log('[Scheduler] NBCNewsBot is paused, skipping'); return; }
    console.log('[Scheduler] Running NBCNewsBot...');
    try {
      const result = await runNBCNewsBot();
      console.log(`[Scheduler] NBCNewsBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    } catch (error) {
      console.error('[Scheduler] NBCNewsBot error:', error);
    }
  });
  
  // Run APNewsBot every hour (at :33 — headline clustering is the only AI
  // neighbour at :x3 non-score-retry minutes, and it fires every 10 min not
  // every 5; was :47→:46, but :46 overlaps STATE_MEDIA_CRON_MINUTES[46])
  cron.schedule('33 * * * *', async () => {
    if (!isBotEnabled('apNewsBot')) { console.log('[Scheduler] APNewsBot is paused, skipping'); return; }
    console.log('[Scheduler] Running APNewsBot...');
    try {
      const result = await runAPNewsBot();
      console.log(`[Scheduler] APNewsBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    } catch (error) {
      console.error('[Scheduler] APNewsBot error:', error);
    }
  });
  
  // Run ReutersBot every hour (at :03 — headline clustering is the only AI
  // neighbour at :x3 non-score-retry minutes, and it fires every 10 min not
  // every 5; was :52→:56, but :56 overlaps STATE_MEDIA_CRON_MINUTES[56])
  cron.schedule('3 * * * *', async () => {
    if (!isBotEnabled('reutersBot')) { console.log('[Scheduler] ReutersBot is paused, skipping'); return; }
    console.log('[Scheduler] Running ReutersBot...');
    try {
      const result = await runReutersBot();
      console.log(`[Scheduler] ReutersBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    } catch (error) {
      console.error('[Scheduler] ReutersBot error:', error);
    }
  });

  // Run CNN curated-only scraper every hour (at :42). CURATED-ONLY (Task #321):
  // CNN has no main-feed bot and its RSS is dead, so this funnels cnn.com
  // headlines straight into the isolated curated aperture (admitCuratedCandidates
  // gate mode) and NEVER touches any shared feed.
  cron.schedule('42 * * * *', async () => {
    if (!isBotEnabled('cnnCuratedBot')) { console.log('[Scheduler] CnnCuratedBot is paused, skipping'); return; }
    console.log('[Scheduler] Running CnnCuratedBot...');
    try {
      const result = await runCnnCuratedBot();
      console.log(`[Scheduler] CnnCuratedBot completed - Admitted: ${result.ingested}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    } catch (error) {
      console.error('[Scheduler] CnnCuratedBot error:', error);
    }
  });

  // Poll HASC/SASC hearing calendars every hour (at :41). Task #1077: pure
  // HTML fetch + parse (non-AI) — the only AI it can trigger is the rare
  // curated gate call when NEW testimony PDFs appear on a tracked hearing day.
  // :41 keeps clear of the curated ingest (:x2/:x7) and clustering (:x4/:x9)
  // AI minutes; its neighbours (:41 incremental attach / re-shape) are cheap
  // DB work.
  cron.schedule('41 * * * *', async () => {
    console.log('[Scheduler] Running committee hearing tracker poll...');
    try {
      const { runHearingTrackerPoll } = await import('./hearingTracker');
      await runHearingTrackerPoll();
    } catch (error) {
      console.error('[Scheduler] Hearing tracker poll error:', error);
    }
  });

  // Run NPR curated-only scraper every hour (at :44). CURATED-ONLY (Task #321):
  // NPR's RSS returns 403 from this infra, so this funnels npr.org section
  // headlines straight into the isolated curated aperture and NEVER touches any
  // shared feed.
  cron.schedule('44 * * * *', async () => {
    if (!isBotEnabled('nprCuratedBot')) { console.log('[Scheduler] NprCuratedBot is paused, skipping'); return; }
    console.log('[Scheduler] Running NprCuratedBot...');
    try {
      const result = await runNprCuratedBot();
      console.log(`[Scheduler] NprCuratedBot completed - Admitted: ${result.ingested}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    } catch (error) {
      console.error('[Scheduler] NprCuratedBot error:', error);
    }
  });

  // Run the adversary/state-media curated-only website scrapers every hour,
  // staggered at :46/:48/:50/:56/:58/:53. These minutes are deliberately chosen
  // to be clear of CNN :42 / NPR :44 AND of every curated AI cron (ingest at
  // …,:47,:52,:57; classify at …,:42,:52; clustering at …,:49,:54,:59; dedup at
  // …,:51) so admission/scoring triggered by these scrapers doesn't pile onto an
  // OpenRouter burst already in flight. Their RSS is dead/stale (Chinese state
  // media) or has no public feed at all (KCNA — see curatedFeeds.ts), so each
  // scrapes its website straight into the isolated curated aperture
  // (admitCuratedCandidates gate mode) and NEVER touches any shared feed. Each
  // run is independently toggleable + in-flight guarded.
  const STATE_MEDIA_CRON_MINUTES = [46, 48, 50, 56, 58, 53];
  STATE_MEDIA_CURATED_SOURCES.forEach((src, i) => {
    const minute = STATE_MEDIA_CRON_MINUTES[i] ?? (46 + i * 2);
    cron.schedule(`${minute} * * * *`, async () => {
      if (!isBotEnabled(src.id)) { console.log(`[Scheduler] ${src.logTag} is paused, skipping`); return; }
      console.log(`[Scheduler] Running ${src.logTag}...`);
      try {
        const result = await runCuratedWebScraper(src);
        console.log(`[Scheduler] ${src.logTag} completed - Admitted: ${result.ingested}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
      } catch (error) {
        console.error(`[Scheduler] ${src.logTag} error:`, error);
      }
    });
  });

  // Meltwater curated-only bots (Task #350). CURATED-ONLY: pulls two Meltwater
  // saved Listening searches into the isolated curated aperture and NEVER
  // touches any shared feed. Meltwater is a data pipe: each item is attributed
  // to its REAL publisher and the registry sorts it. Admission mode is PER
  // SEARCH (see MELTWATER_SEARCHES): the adversary CPC search runs UNGATED
  // ('reuse', by user directive); the general-press Int/US search runs GATED
  // ('gate' — relevance screen + real AI priority scores).
  //
  // DEPLOYMENT-ONLY: the Meltwater /v3/search quota (~50 calls/day) is billed
  // PER API KEY and SHARED across dev and prod (same credential). Workspace
  // copies skip these crons and leave the full quota for production.
  //
  // Combined base load: ~36 calls/day (24 CPC + 12 Int/US), ~14 headroom for
  // extra pagination pages.
  //
  // Minutes stay clear of every curated AI burst (ingest :x2/:x7, classify :x5,
  // clustering :x4/:x9, incremental-attach :x1/:x6, off-host bots :x8,
  // main scrape :x0). Minutes ending in 3 keep the existing convention.

  // Search 1 — "Curated (CPC/SWL/EPC)" ID 28809721. Hourly at :23.
  // ~24 calls/day base. In-flight guarded per-search inside the bot.
  cron.schedule('23 * * * *', async () => {
    const isDeployment = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';
    if (!isDeployment) { console.log('[Scheduler] MeltwaterCuratedBot (CPC) skipped (not the deployed app — preserving the shared Meltwater daily quota for production)'); return; }
    if (!isBotEnabled('meltwaterCuratedBot')) { console.log('[Scheduler] MeltwaterCuratedBot (CPC) is paused, skipping'); return; }
    console.log('[Scheduler] Running MeltwaterCuratedBot (CPC)...');
    try {
      const result = await runMeltwaterCuratedBot();
      console.log(`[Scheduler] MeltwaterCuratedBot (CPC) completed - Admitted: ${result.ingested}, Skipped: ${result.skipped}, Errors: ${result.errors}${result.rateLimited ? ', RateLimited: yes (quota exhausted, will retry next cycle)' : ''}`);
    } catch (error) {
      console.error('[Scheduler] MeltwaterCuratedBot (CPC) error:', error);
    }
  });

  // Search 2 — "Curated (Int/US)" ID 28872986. Every 2h at :53.
  // ~12 calls/day base. Lower MAX_PAGES (2) for lower-volume outlets.
  // :53 stays clear of AI burst minutes and keeps the :x3 convention.
  cron.schedule('53 */2 * * *', async () => {
    const isDeployment = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';
    if (!isDeployment) { console.log('[Scheduler] MeltwaterIntUsBot skipped (not the deployed app — preserving the shared Meltwater daily quota for production)'); return; }
    if (!isBotEnabled('meltwaterCuratedBot')) { console.log('[Scheduler] MeltwaterIntUsBot is paused, skipping'); return; }
    console.log('[Scheduler] Running MeltwaterIntUsBot (Int/US)...');
    try {
      const result = await runMeltwaterIntUsBot();
      console.log(`[Scheduler] MeltwaterIntUsBot (Int/US) completed - Admitted: ${result.ingested}, Skipped: ${result.skipped}, Errors: ${result.errors}${result.rateLimited ? ', RateLimited: yes (quota exhausted, will retry next cycle)' : ''}`);
    } catch (error) {
      console.error('[Scheduler] MeltwaterIntUsBot (Int/US) error:', error);
    }
  });

  // Curated-only OFF-HOST discovery bots (Task #661). CURATED-ONLY: each discovers
  // its outlet's articles via Bing News RSS (site-scoped) because the outlet's own
  // feed is dead/blocked from this egress (Breaking Defense /feed/ intermittently
  // 403s; Stars and Stripes publishes no working RSS; USA Today retired its RSS).
  // Bing exposes the REAL article URL in its `url=` param, so there is no bespoke
  // site DOM to maintain. Each run goes through admitCuratedCandidates (gate mode)
  // straight into the isolated curated aperture and NEVER touches any shared feed;
  // it dedups by URL against the direct feeds. Independently toggleable + in-flight
  // guarded inside the bot. Minutes end in :x8 to stay clear of the curated AI
  // bursts (ingest :x2/:x7, classify :x5, cluster :x4/:x9, attach :x1/:x6), the
  // main */10 scrape (:x0), Meltwater (:23), and the state-media web scrapers.
  const OFFHOST_CRON_MINUTES = [8, 28, 38, 48];
  CURATED_OFFHOST_SOURCES.forEach((src, i) => {
    const minute = OFFHOST_CRON_MINUTES[i] ?? (8 + i * 10);
    cron.schedule(`${minute} * * * *`, async () => {
      if (!isBotEnabled(src.id)) { console.log(`[Scheduler] ${src.logTag} is paused, skipping`); return; }
      console.log(`[Scheduler] Running ${src.logTag}...`);
      try {
        const result = await runCuratedOffHostBot(src);
        console.log(`[Scheduler] ${src.logTag} completed - Admitted: ${result.ingested}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
      } catch (error) {
        console.error(`[Scheduler] ${src.logTag} error:`, error);
      }
    });
  });

  // Run Influencer X Posts scraper at :15 and :45 of each hour.
  // Cron is offset from the main `*/10` scrape (which fires at :00, :10, :20,
  // :30, :40, :50) so the two paths don't fire simultaneously. Correctness
  // is also guaranteed by the shared X-scrape lock inside xScraper.ts which
  // serializes any concurrent calls into the shared Playwright browser
  // (so even if a cron fires while another X scrape is mid-flight, this run
  // will simply queue and wait its turn).
  // Like all X Playwright scrapers, this is skipped when the EV relay is
  // healthy — the relay delivers influencer posts and Chromium is unnecessary.
  let influencerXRunning = false;
  cron.schedule('15,45 * * * *', async () => {
    if (influencerXRunning) {
      console.log('[Scheduler] InfluencerX scrape already in progress, skipping');
      return;
    }
    if (isXRelayHealthy()) {
      console.log('[Scheduler] InfluencerX scrape SKIPPED — X relay healthy, posts already delivered via EV');
      return;
    }
    influencerXRunning = true;
    console.log('[Scheduler] Running InfluencerX scrape...');
    try {
      const result = await updateInfluencerXPosts(storage);
      console.log(`[Scheduler] InfluencerX scrape complete - Added: ${result.addedCount} (scraped: ${result.scrapedCount})`);
      await recordInfluencerXScrapeMetadata(result);
    } catch (error) {
      console.error('[Scheduler] InfluencerX scrape error:', error);
      await recordInfluencerXScrapeMetadata({ scrapedCount: 0, addedCount: 0 });
    } finally {
      influencerXRunning = false;
    }
  });

  // Run initial Influencer X scrape ~10 minutes after startup so the initial
  // main scrape (which fires ~5s after startup and runs for several minutes)
  // has time to complete. The shared X-scrape lock would also serialize them
  // safely, but the delay avoids unnecessary waiting on the influencer side.
  // Relay-health gated same as the recurring cron above.
  setTimeout(async () => {
    if (influencerXRunning) return;
    if (isXRelayHealthy()) {
      console.log('[Scheduler] Initial InfluencerX scrape SKIPPED — X relay healthy');
      return;
    }
    influencerXRunning = true;
    console.log('[Scheduler] Running initial InfluencerX scrape...');
    try {
      const result = await updateInfluencerXPosts(storage);
      console.log(`[Scheduler] Initial InfluencerX scrape complete - Added: ${result.addedCount} (scraped: ${result.scrapedCount})`);
      await recordInfluencerXScrapeMetadata(result);
    } catch (error) {
      console.error('[Scheduler] Initial InfluencerX scrape error:', error);
      await recordInfluencerXScrapeMetadata({ scrapedCount: 0, addedCount: 0 });
    } finally {
      influencerXRunning = false;
    }
  }, 10 * 60 * 1000);

  // Journalist X Feed (curated-lane-only) — runs on its own schedule at :05 and
  // :35 (offset from the main */10 scrape and from InfluencerX at :15/:45) so it
  // is no longer buried at the tail of the long main scrape chain (where it
  // almost never got reached). updateJournalistPosts writes ONLY to the isolated
  // journalist_posts table — it never touches headlines or the main feed, so the
  // journalists stay strictly in the curated lane. The shared scrape lock inside
  // osintScraper.ts serializes this against the main chain's OSINT step so their
  // Playwright browsers never collide.
  // Like the main X chain, this is skipped when the EV relay is healthy — the
  // relay delivers journalist posts and the Playwright scraper is only needed as
  // a PRIMARY fallback when the relay heartbeat goes stale.
  let journalistRunning = false;
  const runJournalistScrape = async (label: string) => {
    if (journalistRunning) {
      console.log(`[Scheduler] ${label} already in progress, skipping`);
      return;
    }
    if (isXRelayHealthy()) {
      console.log(`[Scheduler] ${label} SKIPPED — X relay healthy, journalist posts already delivered via EV`);
      return;
    }
    journalistRunning = true;
    console.log(`[Scheduler] Running ${label} (@BarakRavid, @jeremybob1, @phildstewart, @EricSchmittNYT, @alexbward)...`);
    try {
      const result = await updateJournalistPosts(storage);
      console.log(`[Scheduler] ${label} complete - Added: ${result.addedCount} (scraped: ${result.scrapedCount})`);
    } catch (error) {
      console.error(`[Scheduler] ${label} error:`, error);
    } finally {
      journalistRunning = false;
    }
  };
  cron.schedule('5,35 * * * *', () => runJournalistScrape('Journalist X scrape'));

  // Run an initial Journalist scrape a few minutes after startup so the Press
  // column fills quickly. The shared scrape lock will make it wait its turn if
  // the initial main scrape is still mid-OSINT.
  setTimeout(() => runJournalistScrape('Initial Journalist X scrape'), 3 * 60 * 1000);

  // Task #811 — Score-retry sweep. Bot items whose AI score failed at post time
  // are flagged score_source='unscored_fallback' and pinned at the UNSCORED
  // floor (below the promotion bar). This job re-runs the scorer on those rows
  // (bounded attempts, recent window) and, on a real score, writes it through
  // the normal finalize/promotion path so a genuinely high-priority story is no
  // longer permanently buried by a one-time scoring failure. Runs on the :13/:43
  // minute class (unused by other crons) to stay off the main scrape/bot ticks.
  // runScoreRetry has its own in-flight guard and is fully non-fatal.
  cron.schedule('13,43 * * * *', async () => {
    try {
      await runScoreRetry();
    } catch (error) {
      console.error('[Scheduler] Score-retry sweep error:', error);
    }
  });

  // Run RSS Feed Bot every 5 minutes, offset to the mod-5 :01 series (T002).
  // Previously '*/5' fired on :00,:10,... — the SAME tick as the heavy main
  // scrape (*/10) — so two memory+network-heavy jobs started together every 10
  // min. Shifting to :01,:06,:11,... moves it off the main-scrape ticks (it now
  // overlaps only the light curated media backfill at :06,:16,...). Same 5-min
  // cadence and coverage — minute offset only.
  cron.schedule('1,6,11,16,21,26,31,36,41,46,51,56 * * * *', async () => {
    if (!isBotEnabled('rssFeedBot')) { console.log('[Scheduler] RSSFeedBot is paused, skipping'); return; }
    console.log('[Scheduler] Running RSSFeedBot...');
    try {
      const { runRSSFeedBot } = await import('./rssFeedBot');
      const result = await runRSSFeedBot();
      console.log(`[Scheduler] RSSFeedBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    } catch (error) {
      console.error('[Scheduler] RSSFeedBot error:', error);
    }
  });

  // Curated lane (Task #89; cadence tightened in Task #202) — wide-aperture
  // ingest into the SEPARATE curated store every 5 min (offset to :02 — the only
  // free mod-5 slot, clear of the main scrape :00, WarfighterRSS
  // :03, CuratedClassify :04). Halving the gap (was every 10 min at :07) lets a
  // qualifying team submission reach Curated within ~3–5 min instead of waiting a
  // full ingest cycle. The isIngestRunning guard skips overlapping passes, and
  // inline pre-enrichment is bounded so a pass finishes well within 5 min.
  // Writes ONLY to curated_items; never touches headlines.
  cron.schedule('2,7,12,17,22,27,32,37,42,47,52,57 * * * *', async () => {
    try {
      const { runCuratedIngest } = await import('./curatedIngest');
      const result = await runCuratedIngest();
      if (result.ingested > 0) {
        console.log(`[Scheduler] CuratedIngest — ingested: ${result.ingested}, skipped: ${result.skipped}`);
      }
    } catch (error) {
      console.error('[Scheduler] CuratedIngest error:', error);
    }
  });

  // Curated lane (Task #89; cadence tightened in Task #202) — recompute the
  // ISOLATED two-tier clustering every 5 min (offset to :04, 2 min after the
  // ingest at :02) so freshly ingested rows get grouped in the SAME window
  // rather than appearing as single-source cards that reshuffle on the next
  // tick. Running ~2x more often roughly doubles this pass's LLM spend (accepted
  // for the faster, less-jittery curated UX). The isClusteringRunning guard
  // skips overlapping passes. Writes ONLY to curated_cluster_members; never
  // mutates headlines.cluster_id.
  cron.schedule('4,9,14,19,24,29,34,39,44,49,54,59 * * * *', async () => {
    try {
      const { clusterCuratedLane } = await import('./curatedCluster');
      // Outer hard-bound backstop (Task #741). clusterCuratedLane already self-
      // cancels at phase boundaries via its own AbortController after
      // CLUSTER_MAX_DURATION_MS (10 min). This race gives the cron caller its OWN
      // ceiling so the slot frees even if a future non-abortable path is ever
      // added inside the pass and the internal abort fails to fire. The ceiling
      // sits ABOVE the internal 10-min timeout (+2 min drain buffer) so on a
      // healthy run the internal abort always wins and this never trips. On a
      // trip the inner pass keeps draining in the background (Promise.race can't
      // cancel it) and resets its own isClusteringRunning guard when it settles;
      // we do NOTHING destructive here, so existing clusters are preserved (no
      // wipe) — the wipe/rebuild only happens on the inner pass's own success path.
      const CLUSTER_CRON_TIMEOUT_MS = 12 * 60 * 1000;
      const result = await withScrapeTimeout(
        clusterCuratedLane(),
        CLUSTER_CRON_TIMEOUT_MS,
        'clusterCuratedLane',
      );
      if (result.stories > 0) {
        console.log(`[Scheduler] CuratedCluster — stories: ${result.stories}, members: ${result.members}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'ScrapeTimeoutError') {
        console.warn('[Scheduler] CuratedCluster exceeded its outer hard bound — releasing the cron slot; the pass drains in the background and preserves existing clusters (no wipe)');
      } else {
        console.error('[Scheduler] CuratedCluster error:', error);
      }
    }
  });

  // Curated lane (Task #430 follow-up) — SHELVED auto-reshape backstop. DORMANT
  // unless CURATED_AUTO_RESHAPE is enabled (requestCuratedReshape is a pure no-op
  // when the flag is off). When ON, this requests a cheap DETERMINISTIC re-shape
  // on the off-beat between the full clustering passes above so the visible lane
  // keeps healing (newly-enriched faces, decay/age-out, syndication merges)
  // WITHOUT paying for another grouping LLM and without an editor clicking
  // "Re-cluster". The request is debounced/coalesced and routes through the SAME
  // single in-flight guard, so it can never overlap a full pass. Minute :6 keeps
  // it OFF the crowded :02 ingest / :04 cluster / :05 classify ticks. Curated-only.
  cron.schedule('6,16,26,36,46,56 * * * *', () => {
    requestCuratedReshape('periodic');
  });

  // Curated lane — CONTENT-BASED classification backfill every 10 min (offset to
  // :05). Classifies any curated-view URL (main feed UNION curated store) missing
  // from the curated_classifications overlay, so the "Category · Country/Region"
  // label reflects article content for EVERY row — including main-feed union rows
  // and legacy curated rows. Writes ONLY to curated_classifications.
  // De-collision (T002): minutes are :05,:15,... — OFF the crowded :02 tick where
  // curated ingest (gpt-4o-mini) AND the image-heavy stream-prefetch backfill both
  // run, and still NOT on the same minute as the gpt-4o curated-clustering cron
  // (:04/:09 series). It now only brushes light single-handle bots (:15/:45),
  // never a heavy AI or image job. Same cadence/model — minute offset only.
  cron.schedule('5,15,25,35,45,55 * * * *', async () => {
    try {
      const { backfillCuratedClassifications } = await import('./curatedClassify');
      const result = await backfillCuratedClassifications();
      if (result.classified > 0 || result.cleared > 0) {
        console.log(`[Scheduler] CuratedClassify — classified: ${result.classified}, re-check cleared: ${result.cleared}`);
      }
    } catch (error) {
      console.error('[Scheduler] CuratedClassify error:', error);
    }
  });

  // Curated lane — incremental-attach bridge (Task #439). The full clustering
  // pass above is a wipe-and-rebuild that runs every ~5 min; between passes a
  // freshly-scraped article that clearly belongs to a formed Top Story shows as
  // a lonely single-source card until the next rebuild folds it in. This cheap,
  // NO-AI pass folds a small bounded set of such standalone items into the
  // cluster they obviously belong to so the read path reflects them right away.
  // Runs at minute ≡1 mod 5 — roughly the midpoint between clustering ticks
  // (≡4 mod 5) and OFF the ingest (≡2) and classification (:05/:15/…) minutes.
  // Writes ONLY curated_cluster_members; never headlines.cluster_id.
  cron.schedule('1,6,11,16,21,26,31,36,41,46,51,56 * * * *', async () => {
    try {
      const { runCuratedIncrementalAttach } = await import('./curatedIncrementalAttach');
      const result = await runCuratedIncrementalAttach();
      if (result.attached > 0) {
        console.log(`[Scheduler] CuratedIncrementalAttach — attached: ${result.attached} (candidates: ${result.candidates}, clusters: ${result.clusters})`);
      }
    } catch (error) {
      console.error('[Scheduler] CuratedIncrementalAttach error:', error);
    }
  });

  // Curated lane (Task #370) — automatic Curated Story Archive maintenance so the
  // archive stays tidy without an admin running the manual endpoints by hand. The
  // live curated clustering cron continuously writes within-episode churn to
  // curated_story_archive every 5-10 min, so over-age "blob" rows and duplicate
  // "phased out" versions slowly re-accumulate. Every 2 hours at :38 (a minute no
  // other curated/scraper cron uses) this runs the SAME maintenance the manual
  // /api/admin/curated/archive/{bound-episodes,normalize-duplicates} endpoints do.
  //
  // Order matters (see memory curated-archive-dedup-sweep.md): bound-episodes and
  // normalize-duplicates COUNTER-BALANCE each other — bound trims to the 60h
  // episode cap, normalize's merge re-widens within-episode churn back up to ~2x
  // the cap. So we bound ONCE, then loop normalize to convergence (0 groups / 0
  // absorbed), then STOP for the cycle. Looping bound→normalize→bound oscillates.
  //
  // These ops are pure DB reads/writes (no AI), so they don't add to OpenRouter
  // 429 pressure, but the :38 minute still keeps the table write off the curated
  // clustering pass's minutes. Curated-lane only — writes ONLY curated_story_archive,
  // never the main/Classic/Visual/custom-MCOP feeds or the public API. The
  // archiveMaintenanceRunning guard prevents overlapping runs from stacking.
  let archiveMaintenanceRunning = false;
  cron.schedule('38 */2 * * *', async () => {
    if (archiveMaintenanceRunning) {
      console.log('[Scheduler] CuratedArchiveMaintenance already in progress, skipping');
      return;
    }
    archiveMaintenanceRunning = true;
    try {
      // Wide window (90d) so the sweep covers the full backlog age, matching the
      // manual cleanup procedure.
      const windowHours = 24 * 90;

      // 1) Bound over-age not-live episodes ONCE.
      const bound = await storage.boundOverAgeCuratedArchiveEpisodes({ dryRun: false, windowHours });

      // 2) Normalize duplicates to convergence (the survivor's display anchors
      // change after each collapse, so the greedy matcher finds NEW groups on the
      // next pass — re-run until 0 groups / 0 absorbed). Cap the loop so a moving
      // live target can never spin forever.
      let normalizePasses = 0;
      let totalGroups = 0;
      let totalAbsorbed = 0;
      let converged = false;
      const MAX_NORMALIZE_PASSES = 12;
      for (let i = 0; i < MAX_NORMALIZE_PASSES; i++) {
        const norm = await storage.normalizeCuratedArchiveDuplicates({ dryRun: false, windowHours });
        normalizePasses++;
        totalGroups += norm.duplicateGroups;
        totalAbsorbed += norm.rowsAbsorbed;
        if (norm.duplicateGroups === 0 && norm.rowsAbsorbed === 0) { converged = true; break; }
      }
      if (!converged) {
        console.warn(
          `[Scheduler] CuratedArchiveMaintenance — normalize did NOT converge within ${MAX_NORMALIZE_PASSES} pass(es); ` +
          `residual duplicates remain and will be retried next cycle`,
        );
      }

      if (bound.boundedRows > 0 || totalAbsorbed > 0) {
        console.log(
          `[Scheduler] CuratedArchiveMaintenance — bounded ${bound.boundedRows} row(s) (-${bound.sourcesRemoved} sources), ` +
          `normalized ${totalAbsorbed} dup(s) across ${totalGroups} group(s) in ${normalizePasses} pass(es)`,
        );
      }
    } catch (error) {
      console.error('[Scheduler] CuratedArchiveMaintenance error:', error);
    } finally {
      archiveMaintenanceRunning = false;
    }
  });

  // Warfighter-only RSS scraper (Blaze, Epoch Times, Daily Wire) every 10 min,
  // offset to :03/:13/... so it doesn't collide with the main scrape at :00/:10.
  cron.schedule('3,13,23,33,43,53 * * * *', async () => {
    try {
      const { runWarfighterRssScraper } = await import('./warfighterRssScraper');
      const result = await runWarfighterRssScraper();
      if (result.added > 0 || result.errors > 0) {
        console.log(`[Scheduler] WarfighterRSS — added: ${result.added}, skipped: ${result.skipped}, errors: ${result.errors}`);
      }
    } catch (error) {
      console.error('[Scheduler] WarfighterRSS error:', error);
    }
  });

  // Main-feed headline clustering — MOVED here off the tail of the */10 scrape
  // chain (see the note in that scrape). Groups same-event stories across
  // headlines + manual submissions for the Classic/Visual feeds by writing
  // headlines.cluster_id / manual_submissions.cluster_id (incremental:
  // resetExisting=false, so user-created topics and existing clusters survive).
  //
  // Running on its OWN cron means a wedged/force-cleared scrape can no longer
  // starve it. It is scheduled on the :x3 class — one of the LIGHTER AI minutes
  // on this saturated grid: it shares its wake only with the Warfighter RSS
  // scraper above, whose AI use is a small, bounded number of per-article summary
  // calls (only when new articles arrive). It deliberately stays OFF the heaviest
  // AI bursts — main scrape (:x0), RSS bot (:x1/:x6, double-AI), curated
  // clustering (:x4/:x9, gpt-4o), curated classify (:x5) — so its single
  // gpt-4o-mini call is less likely to land inside another job's AI 429 burst
  // (aiClient still globally serializes/spaces + retries every call). That AI
  // call is already hang-protected by withAiTimeout (60s SDK timeout + 75s race
  // backstop), so a stalled provider can never wedge this pass. The re-entrancy
  // guard skips an overlapping pass; the user's clustering toggle still gates it.
  // The feed read cache (~25s TTL) naturally refreshes to show the new grouping —
  // matching the prior inline behavior, which never explicitly invalidated either.
  let headlineClusteringRunning = false;
  cron.schedule('3,13,23,33,43,53 * * * *', async () => {
    const { isClusteringEnabled } = await import('./clusterConfig');
    if (!isClusteringEnabled()) return;
    if (headlineClusteringRunning) {
      console.log('[Scheduler] Headline clustering already in progress, skipping');
      return;
    }
    headlineClusteringRunning = true;
    try {
      console.log('[Scheduler] Running main-feed headline clustering...');
      await clusterTopStories(false);
      console.log('[Scheduler] Main-feed headline clustering complete');
    } catch (error) {
      console.error('[Scheduler] Headline clustering error:', error);
    } finally {
      headlineClusteringRunning = false;
    }
  });

  // DataMinr First Alert — MOVED here off the tail of the */10 scrape chain (see
  // the note in that scrape). A wedged/slow scrape no longer delays or skips it,
  // and it now runs every 5 minutes instead of (at best) every 10 — fresher, more
  // regular alerts. It is a pure HTTP API call against DataMinr (cursor-based, so
  // it pulls only NEW alerts each run), with NO browser, NO AI, and NO scrape
  // lock, so it is cheap and safe to run on its own frequent cadence and minute
  // collisions on the (AI-/browser-saturated) grid do not affect it. The
  // re-entrancy guard skips an overlapping pass so two runs can never race the
  // module-level cursor. It owns the firstAlerts* freshness metadata now that the
  // main chain no longer scrapes it.
  let firstAlertScrapeRunning = false;
  cron.schedule('*/5 * * * *', async () => {
    if (firstAlertScrapeRunning) {
      console.log('[Scheduler] DataMinr First Alert scrape already in progress, skipping');
      return;
    }
    firstAlertScrapeRunning = true;
    try {
      const firstAlertCount = await updateFirstAlerts(storage);
      if (firstAlertCount > 0) {
        console.log(`[Scheduler] DataMinr First Alert — ${firstAlertCount} new alerts added`);
      }
      await storage.updateScrapeMetadata({
        firstAlertsLastScrapeTime: new Date(),
        firstAlertsLastCount: firstAlertCount,
      });
    } catch (error) {
      console.error('[Scheduler] DataMinr First Alert scrape error:', error);
    } finally {
      firstAlertScrapeRunning = false;
    }
  });

  // Custom-MCOP scoring (Task #484) — AI-scores newly-ingested headlines for each
  // custom MCOP. It previously ran inline at the tail of EVERY main scrape (*/10,
  // 6×/hr, on the heaviest AI minute :x0, sharing the scrape lock + main
  // clustering/scoring). It now runs on its own 30-min cron (2×/hr — a 3×
  // reduction in runs): because each run consolidates a cycle's new headlines
  // into fuller 30-item batches, a low-volume MCOP that used to burn a whole AI
  // call on a handful of titles every 10 min now spends one every 30. Each
  // headline is still scored exactly once (dedup by already-scored set), so this
  // never drops coverage — it just batches the same work into fewer, fuller runs.
  //
  // Minutes :02/:32 sit on the :x2 class — the lightest AI tenancy on this
  // saturated grid: only the curated ingest's BOUNDED inline enrichment (capped
  // below the global AI concurrency) and the NON-AI stream-media backfill, with
  // NO news bot. This deliberately keeps it OFF every heavy AI burst — main
  // scrape (:x0), RSS bot (:x1/:x6), curated clustering (:x4/:x9), curated
  // classify (:x5) — and off all 30-min/hourly news bots. The scorer self-skips
  // when there are no custom MCOPs and MCOP-by-MCOP when nothing is new, so an
  // empty grid is nearly free; aiClient still globally serializes/spaces calls.
  let customMcopScoringRunning = false;
  cron.schedule('2,32 * * * *', async () => {
    if (customMcopScoringRunning) {
      console.log('[Scheduler] Custom-MCOP scoring already in progress, skipping');
      return;
    }
    customMcopScoringRunning = true;
    try {
      await scoreNewItemsForAllCustomMcops();
    } catch (customMcopErr) {
      console.error('Error during custom-MCOP scoring (non-fatal):', customMcopErr);
    } finally {
      customMcopScoringRunning = false;
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Serialized boot warm-up (prod OOM mitigation — Task #442).
  //
  // Previously every "initial" job below fired as its own independent setTimeout
  // inside the first ~90–150s of boot: the full Chromium scrape (+5s), seven AI
  // news bots (+15s…+95s), the Stream media pre-fetch (+30s), a 100-item stale
  // Stream-media backfill (+60s), the curated media pass (+90s), the curated web
  // scrapers (+105…150s), the RSS bot (+120s) and outlet enrichment (+90s) all
  // overlapped each other AND the still-running scrape. On the 1 GB-capped V8
  // heap (with Chromium's native memory on top) that concurrent post-boot spike
  // OOM'd the process at ~86s uptime — and because every restart re-fired the
  // same fan-out, a single OOM became a crash loop.
  //
  // They now run through ONE sequential queue: the heavy Chromium scrape first
  // (awaited, so its browser work never overlaps the image-buffer media passes),
  // then the media passes, then the news bots one at a time, then the curated
  // web scrapers, then RSS, then outlet enrichment. The stale-media backfills
  // are the heaviest, least-urgent jobs, so they stay deferred well past boot
  // and skipped while a scrape is in flight. Their one-time sweep depth was
  // restored to the original 100/60 (stream/curated) after the VM RAM was
  // upsized — the SERIALIZED queue, not the batch size, is what prevents the
  // boot heap spike, so the larger sweep is safe given the RAM headroom. The
  // recurring crons above keep everything fresh on the normal cadence, so
  // nothing here is load-bearing for steady state.
  const bootSleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const bootStep = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (error) {
      console.error(`[Scheduler] Initial ${label} error:`, error);
      return undefined;
    }
  };

  void (async () => {
    // Let the server finish booting/serving before any heavy work begins.
    await bootSleep(15000);

    // 1) Heaviest phase first — full scrape (own re-entrancy lock + watchdog).
    //    Awaited so the Chromium browser work completes before any image-buffer
    //    media pass runs.
    console.log('[Scheduler] Boot warm-up: starting initial full scrape...');
    const bootScraped = await bootStep('full scrape (delayed start)', () => runFullScrape('initial scrape (delayed start)'));

    // 2) Media passes — only AFTER the scrape actually ran, mirroring the */10
    //    cron order so image buffers never stack on the scrape's browser memory.
    //    If the boot scrape was SKIPPED because a recurring */10 scrape was
    //    already active (boot landed on a cron boundary), skip the media passes
    //    too — running them now would overlap that still-running scrape and
    //    recreate the very memory spike this sequence exists to prevent. The
    //    recurring */10 cron covers media once the scrape goes idle.
    if (bootScraped === false) {
      console.log('[Scheduler] Boot warm-up: initial scrape skipped (another scrape already active) — skipping initial media passes to avoid overlap; recurring crons will cover media.');
    } else {
      await bootSleep(5000);
      await bootStep('Stream media pre-fetch', async () => {
        console.log('[Scheduler] Running initial Stream media pre-fetch...');
        const { prefetchStreamMedia } = await import('./streamPrefetch');
        await prefetchStreamMedia();
        console.log('[Scheduler] Initial Stream media pre-fetch complete');
      });
      await bootSleep(5000);
      await bootStep('curated media pass', async () => {
        const { prefetchCuratedMedia } = await import('./streamPrefetch');
        await prefetchCuratedMedia();
        console.log('[Scheduler] Initial curated media pass complete');
      });
      await bootSleep(5000);
      await bootStep('X post media pre-fetch', async () => {
        const { prefetchXPostMedia } = await import('./streamPrefetch');
        await prefetchXPostMedia();
        console.log('[Scheduler] Initial X post media pre-fetch complete');
      });
    }

    // 3) AI news bots — one at a time so their fetch + summarize buffers don't
    //    stack. (isBotEnabled checks preserved exactly as in the prior code.)
    await bootSleep(5000);
    await bootStep('DrudgeBot', async () => {
      if (!isBotEnabled('drudgeBot')) { console.log('[Scheduler] Initial DrudgeBot skipped - bot is paused'); return; }
      console.log('[Scheduler] Running initial DrudgeBot...');
      const result = await runDrudgeBot();
      console.log(`[Scheduler] Initial DrudgeBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    });
    await bootStep('BBCBot', async () => {
      console.log('[Scheduler] Running initial BBCBot...');
      const result = await runBBCBot();
      console.log(`[Scheduler] Initial BBCBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    });
    await bootStep('SocialBot', async () => {
      console.log('[Scheduler] Running initial SocialBot...');
      const result = await runSocialBot();
      console.log(`[Scheduler] Initial SocialBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    });
    await bootStep('FoxNewsBot', async () => {
      console.log('[Scheduler] Running initial FoxNewsBot...');
      const result = await runFoxNewsBot();
      console.log(`[Scheduler] Initial FoxNewsBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    });
    await bootStep('ABCNewsBot', async () => {
      console.log('[Scheduler] Running initial ABCNewsBot...');
      const result = await runABCNewsBot();
      console.log(`[Scheduler] Initial ABCNewsBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    });
    await bootStep('CBSNewsBot', async () => {
      console.log('[Scheduler] Running initial CBSNewsBot...');
      const result = await runCBSNewsBot();
      console.log(`[Scheduler] Initial CBSNewsBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    });
    await bootStep('NBCNewsBot', async () => {
      console.log('[Scheduler] Running initial NBCNewsBot...');
      const result = await runNBCNewsBot();
      console.log(`[Scheduler] Initial NBCNewsBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    });
    await bootStep('APNewsBot', async () => {
      console.log('[Scheduler] Running initial APNewsBot...');
      const result = await runAPNewsBot();
      console.log(`[Scheduler] Initial APNewsBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    });
    await bootStep('ReutersBot', async () => {
      console.log('[Scheduler] Running initial ReutersBot...');
      const result = await runReutersBot();
      console.log(`[Scheduler] Initial ReutersBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    });

    // 4) Curated-only web scrapers — one at a time. Curated-lane isolation is
    //    unchanged; these only feed the isolated curated aperture.
    await bootStep('CnnCuratedBot', async () => {
      if (!isBotEnabled('cnnCuratedBot')) { console.log('[Scheduler] CnnCuratedBot is paused, skipping initial run'); return; }
      console.log('[Scheduler] Running initial CnnCuratedBot...');
      const result = await runCnnCuratedBot();
      console.log(`[Scheduler] Initial CnnCuratedBot completed - Admitted: ${result.ingested}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    });
    await bootStep('NprCuratedBot', async () => {
      if (!isBotEnabled('nprCuratedBot')) { console.log('[Scheduler] NprCuratedBot is paused, skipping initial run'); return; }
      console.log('[Scheduler] Running initial NprCuratedBot...');
      const result = await runNprCuratedBot();
      console.log(`[Scheduler] Initial NprCuratedBot completed - Admitted: ${result.ingested}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    });
    for (const src of STATE_MEDIA_CURATED_SOURCES) {
      await bootStep(src.logTag, async () => {
        if (!isBotEnabled(src.id)) { console.log(`[Scheduler] ${src.logTag} is paused, skipping initial run`); return; }
        console.log(`[Scheduler] Running initial ${src.logTag}...`);
        const result = await runCuratedWebScraper(src);
        console.log(`[Scheduler] Initial ${src.logTag} completed - Admitted: ${result.ingested}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
      });
    }

    // 4b) Curated-only OFF-HOST discovery bots (Task #661) — Bing News RSS, no
    //     browser, curated-lane isolation unchanged (admitCuratedCandidates gate).
    for (const src of CURATED_OFFHOST_SOURCES) {
      await bootStep(src.logTag, async () => {
        if (!isBotEnabled(src.id)) { console.log(`[Scheduler] ${src.logTag} is paused, skipping initial run`); return; }
        console.log(`[Scheduler] Running initial ${src.logTag}...`);
        const result = await runCuratedOffHostBot(src);
        console.log(`[Scheduler] Initial ${src.logTag} completed - Admitted: ${result.ingested}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
      });
    }

    // 5) RSS bot last (largest fetch + parse footprint).
    await bootStep('RSSFeedBot', async () => {
      if (!isBotEnabled('rssFeedBot')) { console.log('[Scheduler] RSSFeedBot is paused, skipping'); return; }
      console.log('[Scheduler] Running initial RSSFeedBot...');
      const { runRSSFeedBot } = await import('./rssFeedBot');
      const result = await runRSSFeedBot();
      console.log(`[Scheduler] Initial RSSFeedBot completed - Posted: ${result.posted}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    });

    // 6) Outlet enrichment (Task #84) — OFF the ingest hot path; own concurrency
    //    guard + bounded batching; descriptive cols only, never role.
    await bootStep('outlet enrichment', async () => {
      const { runOutletEnrichment } = await import('./enrichment');
      await runOutletEnrichment('initial-pass');
    });

    // 7) Heavy, least-urgent stale-media BACKFILLS: deferred well past boot,
    //    size-reduced, and skipped while a scrape is running so they never stack
    //    image buffers onto Chromium. The recurring backfill crons (:02/:06…)
    //    cover anything skipped here.
    await bootSleep(12 * 60 * 1000);
    if (isScrapingInProgress) {
      console.log('[Scheduler] Initial stale-media backfill skipped - scrape in progress (recurring crons will catch up)');
    } else {
      await bootStep('stream-media backfill', async () => {
        console.log('[Scheduler] Running initial stream-media backfill...');
        const { backfillStaleStreamMedia } = await import('./streamPrefetch');
        const result = await backfillStaleStreamMedia(24, 100);
        console.log(`[Scheduler] Initial backfill complete — enhanced ${result.enhanced}, skipped ${result.skipped}, failed ${result.failed} (scanned ${result.scanned})`);
      });
      await bootSleep(5000);
      await bootStep('curated-media backfill', async () => {
        const { backfillStaleCuratedMedia } = await import('./streamPrefetch');
        const result = await backfillStaleCuratedMedia(24, 60);
        console.log(`[Scheduler] Initial curated media backfill — carried ${result.carried}, enhanced ${result.enhanced}, skipped ${result.skipped}, failed ${result.failed} (scanned ${result.scanned})`);
      });
    }

    console.log('[Scheduler] Boot warm-up sequence complete.');
  })();

  cron.schedule('*/2 * * * *', async () => {
    // NOTE: the Truth Social relay-outage SMS watchdog (Task #1020) formerly
    // ran here; the SMS escalation was removed at the user's request. The
    // Coverage-tab banner remains and is derived live at read time.
    // SMS pipeline health monitor (Task #1040): runs every 2 minutes alongside
    // the relay sync cron. One-shot incident email on red; recovery email on
    // clear. Deployment-gated — dev workspaces log but never email.
    try {
      await checkSmsAlertHealth(storage);
    } catch (err) {
      console.error('[SmsAlertMonitor] Check error:', err);
    }
    try {
      const recentRelay = await storage.getRecentRelayTruthSocialPosts(20);
      if (recentRelay.length === 0) return;

      const newestRelay = recentRelay[0];
      const relayAge = Date.now() - new Date(newestRelay.receivedAt).getTime();

      if (relayAge < 15 * 60 * 1000) {
        updateRelayHeartbeat();
      }

      let promoted = 0;
      const postsForOCR: Array<{ postId: string; imageUrl: string; content: string }> = [];

      for (const rp of recentRelay) {
        const existingMain =
          (await storage.getTruthSocialPostByPostId(rp.postId)) ||
          (rp.truthSocialUrl
            ? await storage.getTruthSocialPostByTruthSocialUrl(rp.truthSocialUrl)
            : undefined);
        if (existingMain) {
          if (!existingMain.imageUrl && rp.imageUrl) {
            const filtered = filterTruthSocialPostImage(rp.content, rp.imageUrl);
            if (filtered) {
              await storage.updateTruthSocialPostImage(existingMain.id, filtered);
              console.log(`[RelaySync] Enriched image for post ${rp.postId}`);
            }
          }
          continue;
        }

        const filteredImg = filterTruthSocialPostImage(rp.content, rp.imageUrl);
        try {
          await storage.addTruthSocialPost({
            postId: rp.postId,
            content: rp.content,
            postedAt: rp.postedAt,
            truthSocialUrl: rp.truthSocialUrl,
            imageUrl: filteredImg,
            videoUrl: rp.videoUrl || null,
            videoThumbnailUrl: rp.videoThumbnailUrl || null,
            isReblog: rp.isReblog || false,
            rebloggedFrom: rp.rebloggedFrom || null,
          });
          promoted++;

          if (filteredImg) {
            postsForOCR.push({ postId: rp.postId, imageUrl: filteredImg, content: rp.content });
          }

          const postAge = Date.now() - new Date(rp.postedAt).getTime();
          if (postAge < 60 * 60 * 1000) {
            sendPOTUSAlert({
              content: rp.content,
              postedAt: rp.postedAt,
              truthSocialUrl: rp.truthSocialUrl,
              imageUrl: filteredImg,
              extractedImageText: null,
              isReblog: rp.isReblog,
              rebloggedFrom: rp.rebloggedFrom,
            }).catch(err => console.error('[RelaySync] POTUS alert error:', err));
          }
        } catch (err: any) {
          if (err?.code !== '23505') {
            console.error(`[RelaySync] Error promoting post ${rp.postId}:`, err);
          }
        }
      }

      if (promoted > 0) {
        console.log(`[RelaySync] Promoted ${promoted} relay post(s) to main table`);
      }

      if (postsForOCR.length > 0) {
        processPostImages(postsForOCR.map(p => ({ postId: p.postId, imageUrl: p.imageUrl, content: p.content })))
          .then(async (texts) => {
            for (const [postId, text] of texts.entries()) {
              const post = await storage.getTruthSocialPostByPostId(postId);
              if (post) await storage.updateTruthSocialPostExtractedText(post.id, text);
            }
          }).catch(err => console.error('[RelaySync] OCR error:', err));
      }
    } catch (error) {
      console.error('[RelaySync] Error:', error);
    }
  });
  console.log('Relay sync started (every 2 minutes) - syncs relay posts from shared DB to dev environment');

  console.log('Scheduled scraping started (every 10 minutes) for headlines, Truth Social, X posts, RapidResponse posts, DOWResponse posts, and SentDefender posts');
  console.log('DataMinr First Alert started (every 5 minutes on its own dedicated cron, decoupled from the main scrape chain)');
  console.log('DrudgeBot started (every 30 minutes at :08 and :38) - posts military-relevant Drudge articles to Team chat');
  console.log('BBCBot started (every 30 minutes at :18 and :48) - posts military-relevant BBC articles to Team chat');
  console.log('SocialBot started (every 30 minutes at :28 and :58) - reposts POTUS and SecWar social posts to Team chat');
  console.log('FoxNewsBot started (hourly at :06) - posts military-relevant Fox News articles to Team chat');
  console.log('ABCNewsBot started (hourly at :16) - posts military-relevant ABC News articles to Team chat');
  console.log('CBSNewsBot started (hourly at :26) - posts military-relevant CBS News articles to Team chat');
  console.log('NBCNewsBot started (hourly at :36) - posts military-relevant NBC News articles to Team chat');
  console.log('APNewsBot started (hourly at :33) - posts military-relevant AP News articles to Team chat');
  console.log('ReutersBot started (hourly at :03) - posts military-relevant Reuters articles to Team chat');
  console.log('RSSFeedBot started (every 5 minutes) - monitors 25+ defense/geopolitical RSS feeds');
  console.log('Custom-MCOP scoring started (every 30 minutes at :02 and :32) - AI-scores new headlines per custom MCOP, off the main scrape cycle');
  console.log('Self-healing watchdog started (every 30 minutes) - monitors staleness AND blocking detection');

  // Outlet enrichment (Task #84) — runs OFF the ingest hot path. The delayed
  // initial pass now runs inside the serialized boot warm-up sequence above (so
  // it never competes with startup scrapes); here we keep only the batched
  // overnight refresh. The service has its own concurrency guard, bounded
  // batching, and never auto-promotes role.

  // Overnight refresh every day at 03:00.
  cron.schedule('0 3 * * *', async () => {
    try {
      const { runOutletEnrichment } = await import('./enrichment');
      await runOutletEnrichment('overnight-cron');
    } catch (error) {
      console.error('[Scheduler] Overnight outlet enrichment error:', error);
    }
  });
  console.log('Outlet enrichment scheduled (initial pass via boot warm-up sequence, overnight refresh 03:00)');

  // Curated editor-feedback learning-loop compiler (Task #659) RETIRED (Task
  // #1180). Legacy aggregate learned-rule GENERATION is retired: the daily
  // compiler cron that mined curated_override_events + curated_manual_links
  // into approvable 'suggested' rows has been removed so no new standing
  // outlet/category/pair rules are ever generated. curatedRuleCompiler.ts is
  // intentionally left on disk (old tests may still import it) but is now
  // unreachable from any hot path. Direct human overlays are unaffected.

  // Daily auto-archive of watch topics whose AI-estimated active window elapsed.
  // Non-AI, idempotent DB update; runs at 04:15 to avoid the 03:00 enrichment.
  // Respects lifecycleMode: 'hold' topics are exempt from auto-archive.
  // Smart-decay topics with recent match volume are auto-extended first.
  cron.schedule('15 4 * * *', async () => {
    try {
      // Prune telemetry older than 30 days before the extension check.
      const pruned = await storage.pruneWatchTopicTelemetry(30);
      if (pruned > 0) console.log(`[Scheduler] Pruned ${pruned} stale watch-topic telemetry row(s)`);

      // Auto-extend smart-decay topics that are nearing expiry but still active.
      // Targeted query (active + estimatedActiveUntil set + not 'hold') avoids
      // loading the full subject list every night.
      const candidates = await storage.getSmartDecayExpiryCandidates();
      const smartDecayNearExpiry = candidates.filter((s: any) => {
        const daysLeft = (new Date(s.estimatedActiveUntil).getTime() - Date.now()) / 86400_000;
        return daysLeft <= 7; // within 7 days of expiry
      });
      let extended = 0;
      for (const s of smartDecayNearExpiry) {
        const wasExtended = await storage.smartDecayExtendIfActive(s.id);
        if (wasExtended) extended++;
      }
      if (extended > 0) console.log(`[Scheduler] Auto-extended ${extended} smart-decay watch topic(s)`);

      const archived = await storage.archiveExpiredWatchTopics();
      if (archived > 0) {
        console.log(`[Scheduler] Auto-archived ${archived} expired watch topic(s)`);
      }
    } catch (error) {
      console.error('[Scheduler] Watch-topic auto-archive error:', error);
    }
  });
  console.log('Watch-topic auto-archive scheduled (daily 04:15)');

  // Orphaned object-storage image sweep (Task #765). Once per day, off-peak,
  // delete `/objects/stream-images/` files no longer referenced by ANY table
  // (curated media resets, re-enrichment, and row deletions orphan the old
  // file). DELETION IS DEPLOYMENT-GATED: the stream-images bucket is SHARED
  // between the dev and deployed apps but each has its own database, so only the
  // deployed app (whose DB is authoritative for what's live) may delete. In dev
  // the job still runs as a scan-only dry-run for visibility. Age-floored
  // (7 days), bounded, and rate-limited inside runOrphanImageSweep.
  cron.schedule('30 4 * * *', async () => {
    try {
      const isDeployment = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';
      const { runOrphanImageSweep } = await import('./orphanImageSweep');
      await runOrphanImageSweep({
        allowDelete: isDeployment,
        reason: isDeployment ? 'daily-cron' : 'daily-cron-dev-scan-only',
      });
    } catch (error) {
      console.error('[Scheduler] Orphan image sweep error:', error);
    }
  });
  console.log('Orphaned object-storage image sweep scheduled (daily at 04:30, deletion in deployment only)');
}

// Export status for debugging/monitoring
export function getScraperStatus() {
  return {
    isRunning: isScrapingInProgress,
    consecutiveSkips,
    lastRunStartedAt,
    lastRunEndedAt,
    lastAutoHealTime,
    autoHealCount,
  };
}

// Test-only seam: the watchdog force-clear paths (runFullScrape ~148-161 and
// runSelfHealingCheck ~515-545) reset scrapeStatus to 'idle' when they fire.
// These paths depend on the module-private `isScrapingInProgress` /
// `lastRunStartedAt` guard state, which cannot be driven from outside the
// module. This hook lets the watchdog-idle-reset gate (scripts/watchdog-idle-reset.test.ts)
// simulate a wedged run and invoke the real runSelfHealingCheck so a regression
// (wrong storage signature, catch swallowing the write, removed reset) fails
// the gate. It is never referenced by any production path.
export const __schedulerWatchdogTestHooks = {
  setGuardState(state: { isScrapingInProgress?: boolean; lastRunStartedAt?: Date | null; lastAutoHealTime?: Date | null }): void {
    if (state.isScrapingInProgress !== undefined) isScrapingInProgress = state.isScrapingInProgress;
    if (state.lastRunStartedAt !== undefined) lastRunStartedAt = state.lastRunStartedAt;
    if (state.lastAutoHealTime !== undefined) lastAutoHealTime = state.lastAutoHealTime;
  },
  runSelfHealingCheck,
  MAX_SCRAPE_DURATION_MS,
};
