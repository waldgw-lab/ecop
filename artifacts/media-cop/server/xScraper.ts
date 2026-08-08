import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { withBrowserLock } from './browserLock';
import type { InsertXPost } from "@shared/schema";
import { INFLUENCER_X_HANDLES } from "@shared/influencerXAccounts";
import { CATALOG_X_POSTS_ACCOUNTS } from "@shared/socialAccountCatalog";
import { execSync } from 'child_process';
import { injectXAuthCookies, applyXCsrfHeader } from './xAuth';
import { suppressAttachmentOnlySocialImage } from './socialPostText';

// Timeout for individual account scraping (60 seconds)
const SCRAPE_TIMEOUT_MS = 60 * 1000;

// Track active browser instances for force-cleanup
let activeBrowser: Browser | null = null;

// Login-wall detection flag.
// Set when a PRIMARY-mode scrape detects a login wall (0 tweets + page title
// doesn't include the @username token). Cleared when any scrape returns posts.
// Exported so pipelineHealth.ts can surface a "cookies expired" alert.
let xCookieExpiredFlag = false;
export function getXCookieExpiredFlag(): boolean { return xCookieExpiredFlag; }
export function clearXCookieExpiredFlag(): void { xCookieExpiredFlag = false; }

// SHARED X-scrape mutex.
// xScraper.ts uses a module-level Playwright `activeBrowser` and force-kills
// orphan Chromium processes via pkill. If two callers run concurrently
// (e.g. main scheduled scrape + influencer cron), they will close/kill each
// other's browser sessions and cause failed/empty scrapes. All entry points
// that call `scrapeAccount()` MUST acquire this lock so they are serialized.
let xScrapeQueue: Promise<unknown> = Promise.resolve();
function withXScrapeLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const next = xScrapeQueue.then(async () => {
    console.log(`[X-Scrape-Lock] Acquired by ${label}`);
    try {
      return await fn();
    } finally {
      console.log(`[X-Scrape-Lock] Released by ${label}`);
    }
  });
  // Don't propagate failures into the queue chain
  xScrapeQueue = next.catch(() => undefined);
  return next as Promise<T>;
}

// Force kill browser and any orphaned Chromium processes
async function forceKillBrowser(): Promise<void> {
  console.log('Force-killing browser instance...');
  
  // First try graceful close
  if (activeBrowser) {
    try {
      await Promise.race([
        activeBrowser.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Close timeout')), 5000))
      ]);
    } catch (e) {
      console.log('Graceful close failed, forcing kill...');
    }
    activeBrowser = null;
  }
  
  // Kill any orphaned Chromium processes
  try {
    execSync('pkill -9 -f "chromium.*--headless" 2>/dev/null || true', { encoding: 'utf-8' });
  } catch (e) {
    // Ignore errors - process may not exist
  }
}

// Helper to wrap a promise with a timeout that also kills the browser
function withTimeoutAndCleanup<T>(
  promise: Promise<T>, 
  timeoutMs: number, 
  errorMessage: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(async () => {
      await forceKillBrowser();
      reject(new Error(errorMessage));
    }, timeoutMs);
  });
  
  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeoutPromise
  ]);
}

// Find Chromium executable path dynamically
export function getChromiumPath(): string {
  // Try to find chromium using 'which' command
  try {
    const path = execSync('which chromium', { encoding: 'utf-8' }).trim();
    if (path) {
      console.log(`Found Chromium via 'which': ${path}`);
      return path;
    }
  } catch (e) {
    console.log('Could not find Chromium via which command, trying fallback paths...');
  }
  
  // Try to find any chromium in Nix store
  try {
    const nixStorePath = execSync('find /nix/store -maxdepth 2 -name chromium -type f -executable 2>/dev/null | head -1', { encoding: 'utf-8' }).trim();
    if (nixStorePath) {
      console.log(`Found Chromium in Nix store: ${nixStorePath}`);
      return nixStorePath;
    }
  } catch (e) {
    console.log('Could not find Chromium in Nix store');
  }
  
  // Fallback paths in order of preference
  const fallbackPaths = [
    '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  
  const fallbackPath = fallbackPaths[0];
  console.log(`Using fallback Chromium path: ${fallbackPath}`);
  return fallbackPath;
}

// Helper function to scrape a single X account
async function scrapeAccount(username: string): Promise<(InsertXPost & { sourceAccount: string })[]> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  
  try {
    console.log(`Starting X/Twitter scraper for @${username}...`);
    
    const chromiumPath = getChromiumPath();
    console.log(`Using Chromium at: ${chromiumPath}`);
    
    if (activeBrowser) {
      try { await activeBrowser.close(); } catch {}
      activeBrowser = null;
    }
    
    browser = await chromium.launch({
      headless: true,
      executablePath: chromiumPath,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-software-rasterizer',
        '--disable-extensions', '--no-zygote',
        '--js-flags=--max-old-space-size=256',
        '--disable-features=site-per-process',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-translate',
        '--disable-sync'
      ]
    });
    
    activeBrowser = browser;
    
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    
    // X blocks logged-out guests from viewing timelines — inject session cookies
    // so this scrape runs authenticated (otherwise: "Found 0 tweet elements").
    await injectXAuthCookies(context, `@${username}`);
    
    page = await context.newPage();
    await applyXCsrfHeader(page);
    
    console.log(`Navigating to https://x.com/${username}...`);
    await page.goto(`https://x.com/${username}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });
    
    await page.waitForTimeout(5000);
    
    try {
      await page.mouse.move(500, 500);
      await page.waitForTimeout(500);
      
      await page.mouse.wheel(0, -500);
      await page.waitForTimeout(1500);
      
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(2000);
      
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(1500);
    } catch (interactionError: any) {
      console.log(`⚠️ Browser interaction failed for @${username} (${interactionError.message}), attempting to extract available content...`);
      await page.waitForTimeout(3000);
    }
    
    const currentUrl = page.url();
    const pageTitle = await page.title();
    console.log(`Current URL: ${currentUrl}`);
    console.log(`Page title: ${pageTitle}`);

    const posts: (InsertXPost & { sourceAccount: string })[] = [];

    const tweetElements = await page.locator('article[data-testid="tweet"]').all();
    console.log(`@${username}: Found ${tweetElements.length} tweet elements`);

    // Login-wall detection: fire when we found NO tweets AND the page title
    // doesn't include the @username token (real profile pages always include
    // "(@username)" in the title; login/error pages don't). Set the module-
    // level flag so pipelineHealth can surface a "cookies expired" alert.
    if (tweetElements.length === 0 && !pageTitle.toLowerCase().includes(`@${username.toLowerCase()}`)) {
      console.warn(`⚠️ Login wall detected for @${username} — X auth cookies may be expired. title="${pageTitle}", url=${currentUrl}`);
      xCookieExpiredFlag = true;
    }
    
    for (let i = 0; i < Math.min(tweetElements.length, 10); i++) {
      try {
        const tweet = tweetElements[i];
        
        // Check if this is a retweet by looking for the repost indicator
        // Retweets have a "reposted" social context label or the tweet URL doesn't match the profile
        let isRetweet = false;
        let retweetedFrom: string | null = null;
        
        // Method 1: Check for "reposted" social context (appears above the tweet)
        try {
          const socialContext = tweet.locator('[data-testid="socialContext"]');
          const socialContextCount = await socialContext.count();
          if (socialContextCount > 0) {
            const socialContextText = await socialContext.textContent({ timeout: 2000 }).catch(() => '');
            if (socialContextText && socialContextText.toLowerCase().includes('repost')) {
              isRetweet = true;
              console.log(`  Found repost indicator: "${socialContextText}"`);
            }
          }
        } catch (e) {
          // No social context or error checking
        }
        
        // Use shorter timeout for individual element operations
        const statusLink = tweet.locator('a[href*="/status/"]').first();
        const hasLink = await statusLink.count().catch(() => 0);
        if (hasLink === 0) continue;
        
        const tweetLink = await statusLink.getAttribute('href', { timeout: 5000 }).catch(() => null);
        if (!tweetLink) continue;
        
        const postIdMatch = tweetLink.match(/\/status\/(\d+)/);
        if (!postIdMatch) continue;
        
        const postId = postIdMatch[1];
        
        // Method 2: Check if the tweet URL is from a different user (indicates retweet)
        // Extract the username from the tweet URL (format: /username/status/id)
        const urlUserMatch = tweetLink.match(/^\/([^\/]+)\/status\/\d+/);
        if (urlUserMatch) {
          const tweetAuthor = urlUserMatch[1].toLowerCase();
          if (tweetAuthor !== username.toLowerCase()) {
            isRetweet = true;
            retweetedFrom = urlUserMatch[1]; // Original case
            console.log(`  Detected retweet from @${retweetedFrom}`);
          }
        }
        
        // Check for "Show more" button with short timeout
        try {
          const showMoreButton = tweet.locator('[data-testid="tweet-text-show-more-link"]');
          const count = await showMoreButton.count();
          if (count > 0) {
            await showMoreButton.first().click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(300);
          }
        } catch (e) {
          // No show more button or click failed
        }
        
        const tweetTextElement = tweet.locator('[data-testid="tweetText"]');
        const textCount = await tweetTextElement.count().catch(() => 0);
        if (textCount === 0) continue;
        
        const content = await tweetTextElement.allTextContents().catch(() => []);
        const fullContent = content.join(' ').trim();
        
        if (!fullContent) continue;
        
        const timeElement = tweet.locator('time').first();
        const timeCount = await timeElement.count().catch(() => 0);
        if (timeCount === 0) continue;
        
        const datetime = await timeElement.getAttribute('datetime', { timeout: 5000 }).catch(() => null);
        
        if (!datetime) continue;
        
        const postedAt = new Date(datetime);
        const xUrl = `https://x.com${tweetLink}`;
        
        // Extract image from tweet if present
        let imageUrl: string | null = null;
        try {
          const tweetPhoto = tweet.locator('[data-testid="tweetPhoto"] img');
          const photoCount = await tweetPhoto.count().catch(() => 0);
          if (photoCount > 0) {
            const imgSrc = await tweetPhoto.first().getAttribute('src', { timeout: 3000 }).catch(() => null);
            if (imgSrc) {
              // Convert thumbnail URL to full-size image URL (remove size params)
              imageUrl = imgSrc.replace(/&name=\w+/, '&name=large');
              console.log(`  Found image: ${imageUrl.substring(0, 80)}...`);
            }
          }
        } catch (e) {
          // No image or error extracting
        }
        
        posts.push({
          postId,
          content: fullContent,
          postedAt,
          xUrl,
          sourceAccount: username,
          isRetweet,
          retweetedFrom,
          imageUrl: suppressAttachmentOnlySocialImage(fullContent, imageUrl),
        });
        
        const rtLabel = isRetweet ? ` [RT from @${retweetedFrom}]` : '';
        console.log(`Extracted post ${postId}${rtLabel}: ${fullContent.substring(0, 50)}...`);
        
      } catch (error) {
        // Only log detailed errors for debugging, not expected timeouts
        if (error instanceof Error && !error.message.includes('Timeout')) {
          console.error('Error extracting tweet:', error.message);
        }
        continue;
      }
    }
    
    console.log(`Successfully scraped ${posts.length} X posts from @${username}`);
    if (posts.length > 0) xCookieExpiredFlag = false;
    return posts;
    
  } catch (error) {
    console.error(`Error scraping X/Twitter @${username}:`, error);
    return [];
  } finally {
    if (page) { try { await page.close(); } catch {} }
    if (context) { try { await context.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
    activeBrowser = null;
  }
}

// X accounts scraped into the shared x_posts table (sourceAccount column distinguishes them).
// NOTE: @DOWResponse, @Rapidresponse47, @sentdefender continue to use their own dedicated
// scrapers/tables and are NOT included here.
// Derived from the canonical social-account catalog (Task #1038): the enabled +
// collected x-default lane. Editing the roster happens in
// shared/socialAccountCatalog.ts; a drift test locks this projection.
export const X_POSTS_ACCOUNTS: string[] = [...CATALOG_X_POSTS_ACCOUNTS];

// Delay between consecutive account scrapes. Longer than the original 15s
// because back-to-back guest sessions on x.com get aggressively rate-limited;
// 35s lets x.com's guest-token bucket recover and reduces "0 tweets" results.
const INTER_ACCOUNT_DELAY_MS = 35 * 1000;
// Extra cool-down before a single retry after a 0-tweet result.
const RETRY_COOLDOWN_MS = 60 * 1000;

// Scrape all X accounts that share the x_posts table.
export async function scrapeXPosts(deadlineMs?: number): Promise<InsertXPost[]> {
  const allPosts: InsertXPost[] = [];

  for (let i = 0; i < X_POSTS_ACCOUNTS.length; i++) {
    // Optional soft time budget (absolute epoch ms). The main full-scrape body
    // passes this so a large X backfill can't consume the whole body budget and
    // trip the hard timeout. Stopping early is safe: while the X relay is healthy
    // these scrapes are backfill-only (dedup-by-postId), so any account not
    // reached this cycle is delivered by the relay or picked up next cycle.
    if (deadlineMs && Date.now() >= deadlineMs) {
      console.log(`[X-Scrape] Time budget reached — stopping after ${i}/${X_POSTS_ACCOUNTS.length} accounts this cycle (backfill; relay/next cycle covers the rest)`);
      break;
    }
    const username = X_POSTS_ACCOUNTS[i];

    if (i > 0) {
      console.log(`Waiting ${INTER_ACCOUNT_DELAY_MS / 1000}s before scraping @${username}...`);
      await new Promise(resolve => setTimeout(resolve, INTER_ACCOUNT_DELAY_MS));
    }

    let posts: (InsertXPost & { sourceAccount: string })[] = [];
    try {
      posts = await withTimeoutAndCleanup(
        scrapeAccount(username),
        SCRAPE_TIMEOUT_MS,
        `@${username} scrape timed out after 60 seconds`
      );
    } catch (error) {
      console.error(`@${username} scrape failed: ${error instanceof Error ? error.message : error}`);
    }

    // One-shot retry when the first attempt returned nothing — usually a
    // transient guest-token throttle that clears after a longer wait.
    if (posts.length === 0) {
      if (deadlineMs && Date.now() >= deadlineMs) {
        console.log(`@${username} first try empty and time budget reached — skipping retry this cycle`);
      } else {
        console.log(`@${username} returned 0 posts on first try, cooling down ${RETRY_COOLDOWN_MS / 1000}s and retrying once...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_COOLDOWN_MS));
        try {
          posts = await withTimeoutAndCleanup(
            scrapeAccount(username),
            SCRAPE_TIMEOUT_MS,
            `@${username} retry timed out after 60 seconds`
          );
          if (posts.length > 0) {
            console.log(`@${username} retry succeeded: ${posts.length} posts.`);
          } else {
            console.log(`@${username} retry also returned 0 posts — skipping this cycle.`);
          }
        } catch (error) {
          console.error(`@${username} retry failed: ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    allPosts.push(...posts);
  }

  console.log(`Total: ${allPosts.length} posts from ${X_POSTS_ACCOUNTS.length} X accounts combined`);
  return allPosts;
}

export interface ScrapeResult {
  scrapedCount: number;  // Total posts found on page (for blocking detection)
  addedCount: number;    // New posts added to database
}

export async function updateXPosts(storage: any, deadlineMs?: number): Promise<ScrapeResult> {
  return withBrowserLock('updateXPosts', () => updateXPostsInner(storage, deadlineMs));
}
async function updateXPostsInner(storage: any, deadlineMs?: number): Promise<ScrapeResult> {
  return withXScrapeLock('updateXPosts', async () => {
    const posts = await scrapeXPosts(deadlineMs);
    let addedCount = 0;

    for (const post of posts) {
      try {
        // Check if post already exists
        const existing = await storage.getXPostByPostId(post.postId);
        if (!existing) {
          await storage.addXPost(post);
          addedCount++;
        }
      } catch (error) {
        console.error(`Error adding X post ${post.postId}:`, error);
      }
    }

    console.log(`Added ${addedCount} new X posts`);
    return { scrapedCount: posts.length, addedCount };
  });
}

// Influencer X accounts (separate "Influencer X Posts" column on Warfighter page).
// All saved into the same x_posts table with accountCategory = 'influencer'
// so they can be filtered/separated from the default feed.
// Influencer X handles are sourced from shared/influencerXAccounts.ts so the
// server, /war, and Custom MCOP page all stay in sync.
export const INFLUENCER_X_ACCOUNTS = INFLUENCER_X_HANDLES;

// Scrape all Influencer X accounts, returning posts tagged as 'influencer'.
async function scrapeInfluencerXPosts(): Promise<InsertXPost[]> {
  const allPosts: InsertXPost[] = [];

  for (let i = 0; i < INFLUENCER_X_ACCOUNTS.length; i++) {
    const username = INFLUENCER_X_ACCOUNTS[i];

    if (i > 0) {
      console.log(`[InfluencerX] Waiting ${INTER_ACCOUNT_DELAY_MS / 1000}s before scraping @${username}...`);
      await new Promise(resolve => setTimeout(resolve, INTER_ACCOUNT_DELAY_MS));
    }

    let posts: (InsertXPost & { sourceAccount: string })[] = [];
    try {
      posts = await withTimeoutAndCleanup(
        scrapeAccount(username),
        SCRAPE_TIMEOUT_MS,
        `[InfluencerX] @${username} scrape timed out after 60 seconds`
      );
    } catch (error) {
      console.error(`[InfluencerX] @${username} scrape failed: ${error instanceof Error ? error.message : error}`);
    }

    if (posts.length === 0) {
      console.log(`[InfluencerX] @${username} returned 0 posts on first try, cooling down ${RETRY_COOLDOWN_MS / 1000}s and retrying once...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_COOLDOWN_MS));
      try {
        posts = await withTimeoutAndCleanup(
          scrapeAccount(username),
          SCRAPE_TIMEOUT_MS,
          `[InfluencerX] @${username} retry timed out after 60 seconds`
        );
        if (posts.length > 0) {
          console.log(`[InfluencerX] @${username} retry succeeded: ${posts.length} posts.`);
        } else {
          console.log(`[InfluencerX] @${username} retry also returned 0 posts — skipping this cycle.`);
        }
      } catch (error) {
        console.error(`[InfluencerX] @${username} retry failed: ${error instanceof Error ? error.message : error}`);
      }
    }

    for (const p of posts) {
      allPosts.push({ ...p, accountCategory: 'influencer' });
    }
  }

  console.log(`[InfluencerX] Total: ${allPosts.length} posts from ${INFLUENCER_X_ACCOUNTS.length} influencer accounts combined`);
  return allPosts;
}

export async function updateInfluencerXPosts(storage: any): Promise<ScrapeResult> {
  return withBrowserLock('updateInfluencerXPosts', () => updateInfluencerXPostsInner(storage));
}
async function updateInfluencerXPostsInner(storage: any): Promise<ScrapeResult> {
  return withXScrapeLock('updateInfluencerXPosts', async () => {
    const posts = await scrapeInfluencerXPosts();
    let addedCount = 0;

    for (const post of posts) {
      try {
        const existing = await storage.getXPostByPostId(post.postId);
        if (!existing) {
          await storage.addXPost(post);
          addedCount++;
        }
      } catch (error) {
        console.error(`[InfluencerX] Error adding X post ${post.postId}:`, error);
      }
    }

    console.log(`[InfluencerX] Added ${addedCount} new influencer X posts`);
    return { scrapedCount: posts.length, addedCount };
  });
}
