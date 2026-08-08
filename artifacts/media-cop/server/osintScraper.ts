import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { withBrowserLock } from './browserLock';
import type { InsertOsintPost, InsertJournalistPost } from "@shared/schema";
import { execSync } from 'child_process';
import { CATALOG_OSINT_ACCOUNTS, CATALOG_JOURNALIST_ACCOUNTS } from "@shared/socialAccountCatalog";

const SCRAPE_TIMEOUT_MS = 60 * 1000;
// Derived from the canonical social-account catalog (Task #1038): the enabled +
// collected osint lane. Edit the roster in shared/socialAccountCatalog.ts.
export const OSINT_ACCOUNTS: string[] = [...CATALOG_OSINT_ACCOUNTS];
// Journalists X Feed (Task #182) — curated-lane-only. Scraped with the same
// Playwright path as OSINT but persisted to the isolated journalist_posts table.
// Derived from the catalog's journalist lane.
export const JOURNALIST_ACCOUNTS: string[] = [...CATALOG_JOURNALIST_ACCOUNTS];

let activeBrowser: Browser | null = null;

// Serialize every Playwright run in this module (OSINT + Journalist) so two
// runs never share or clobber the module-level `activeBrowser`, and the
// pkill-based forceKillBrowser cleanup never kills the other run's Chromium.
// The Journalist feed now has its own cron (separate from the main scrape
// chain that drives OSINT), so without this lock a Journalist run could fire
// while the main chain is mid-OSINT and the two would destroy each other's
// browsers.
let scrapeLock: Promise<void> = Promise.resolve();

function withScrapeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = scrapeLock.then(fn, fn);
  // Keep the chain alive after either outcome without leaking rejections.
  scrapeLock = run.then(() => {}, () => {});
  return run;
}

async function forceKillBrowser(): Promise<void> {
  console.log('Force-killing OSINT browser instance...');
  
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
  
  try {
    execSync('pkill -9 -f "chromium.*--headless" 2>/dev/null || true', { encoding: 'utf-8' });
  } catch (e) {
  }
}

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

function getChromiumPath(): string {
  try {
    const path = execSync('which chromium', { encoding: 'utf-8' }).trim();
    if (path) return path;
  } catch (e) {
  }
  
  const fallbackPaths = [
    '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  
  return fallbackPaths[0];
}

async function scrapeAccount(account: string): Promise<InsertOsintPost[]> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  
  try {
    console.log(`Starting X/Twitter scraper for @${account}...`);
    
    const chromiumPath = getChromiumPath();
    
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
    
    const authToken = process.env.X_AUTH_TOKEN;
    const ct0 = process.env.X_CT0;
    
    if (authToken && ct0) {
      try {
        await context.addCookies([
          {
            name: 'auth_token',
            value: authToken,
            domain: '.x.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None',
          },
          {
            name: 'ct0',
            value: ct0,
            domain: '.x.com',
            path: '/',
            secure: true,
            sameSite: 'Lax',
          },
          {
            name: 'auth_token',
            value: authToken,
            domain: '.twitter.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None',
          },
          {
            name: 'ct0',
            value: ct0,
            domain: '.twitter.com',
            path: '/',
            secure: true,
            sameSite: 'Lax',
          },
        ]);
        console.log(`Injected X auth cookies for @${account} (authenticated mode)`);
      } catch (cookieError) {
        console.error(`Failed to inject X auth cookies for @${account}:`, cookieError instanceof Error ? cookieError.message : cookieError);
      }
    } else {
      console.log(`X_AUTH_TOKEN or X_CT0 not set — scraping @${account} in unauthenticated mode`);
    }
    
    page = await context.newPage();
    
    if (authToken && ct0) {
      await page.setExtraHTTPHeaders({
        'x-csrf-token': ct0,
      });
    }
    
    await page.goto(`https://x.com/${account}`, {
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
      console.log(`Browser interaction failed for @${account} (${interactionError.message}), attempting to extract available content...`);
      await page.waitForTimeout(3000);
    }
    
    const currentUrl = await page.url();
    const pageTitle = await page.title();
    console.log(`Current URL: ${currentUrl}`);
    console.log(`Page title: ${pageTitle}`);
    
    const visibleText = await page.locator('body').first().innerText().catch(() => '');
    if (visibleText.includes('Something went wrong') || 
        visibleText.includes('Try again') || visibleText.includes('rate limit')) {
      console.log(`Possible login wall or rate limit detected for @${account}`);
      console.log('Visible text preview:', visibleText.substring(0, 500));
    }
    
    const posts: InsertOsintPost[] = [];
    
    const tweetElements = await page.locator('article[data-testid="tweet"]').all();
    
    console.log(`Found ${tweetElements.length} tweet elements for @${account}`);
    
    for (let i = 0; i < Math.min(tweetElements.length, 10); i++) {
      try {
        const tweet = tweetElements[i];
        
        // Detect reposts ("retweets") so the curated Hide-Reposts toggle can
        // filter them. Mirrors xScraper: (1) the "reposted" social-context label,
        // (2) the tweet URL belonging to a different author than the profile.
        let isRetweet = false;
        let retweetedFrom: string | null = null;
        try {
          const socialContext = tweet.locator('[data-testid="socialContext"]');
          const socialContextCount = await socialContext.count().catch(() => 0);
          if (socialContextCount > 0) {
            const socialContextText = await socialContext.textContent({ timeout: 2000 }).catch(() => '');
            if (socialContextText && socialContextText.toLowerCase().includes('repost')) {
              isRetweet = true;
            }
          }
        } catch (e) {
        }

        const statusLink = tweet.locator('a[href*="/status/"]').first();
        const hasLink = await statusLink.count().catch(() => 0);
        if (hasLink === 0) continue;
        
        const tweetLink = await statusLink.getAttribute('href', { timeout: 5000 }).catch(() => null);
        if (!tweetLink) continue;
        
        const postIdMatch = tweetLink.match(/\/status\/(\d+)/);
        if (!postIdMatch) continue;
        
        const postId = postIdMatch[1];

        const urlUserMatch = tweetLink.match(/^\/([^\/]+)\/status\/\d+/);
        if (urlUserMatch) {
          const tweetAuthor = urlUserMatch[1].toLowerCase();
          if (tweetAuthor !== account.toLowerCase()) {
            isRetweet = true;
            retweetedFrom = urlUserMatch[1];
          }
        }
        
        try {
          const showMoreButton = tweet.locator('[data-testid="tweet-text-show-more-link"]');
          const count = await showMoreButton.count();
          if (count > 0) {
            await showMoreButton.first().click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(300);
          }
        } catch (e) {
        }
        
        const tweetTextElement = tweet.locator('[data-testid="tweetText"]');
        const textCount = await tweetTextElement.count().catch(() => 0);
        let fullContent = '';
        if (textCount > 0) {
          const content = await tweetTextElement.allTextContents().catch(() => []);
          fullContent = content.join(' ').trim();
        }
        
        const timeElement = tweet.locator('time').first();
        const timeCount = await timeElement.count().catch(() => 0);
        if (timeCount === 0) continue;
        
        const datetime = await timeElement.getAttribute('datetime', { timeout: 5000 }).catch(() => null);
        
        if (!datetime) continue;
        
        const postedAt = new Date(datetime);
        const xUrl = `https://x.com${tweetLink}`;
        
        let imageUrl: string | null = null;
        let videoUrl: string | null = null;
        let hasVideo = false;
        
        try {
          const videoComponent = tweet.locator('[data-testid="videoComponent"], [data-testid="videoPlayer"]');
          const videoCount = await videoComponent.count().catch(() => 0);
          if (videoCount > 0) {
            hasVideo = true;
            
            const videoEl = videoComponent.first().locator('video');
            const vidElCount = await videoEl.count().catch(() => 0);
            if (vidElCount > 0) {
              const vidSrc = await videoEl.first().getAttribute('src', { timeout: 3000 }).catch(() => null);
              if (vidSrc && !vidSrc.startsWith('blob:')) {
                videoUrl = vidSrc;
              }
              
              const posterSrc = await videoEl.first().getAttribute('poster', { timeout: 3000 }).catch(() => null);
              if (posterSrc && !posterSrc.startsWith('blob:')) {
                imageUrl = posterSrc;
              }
            }
            
            if (!imageUrl) {
              const thumbImg = videoComponent.first().locator('img');
              const thumbCount = await thumbImg.count().catch(() => 0);
              if (thumbCount > 0) {
                const thumbSrc = await thumbImg.first().getAttribute('src', { timeout: 3000 }).catch(() => null);
                if (thumbSrc && !thumbSrc.startsWith('blob:')) {
                  imageUrl = thumbSrc.replace(/&name=\w+/, '&name=large');
                }
              }
            }
            
            if (!videoUrl) {
              videoUrl = `https://x.com${tweetLink}`;
            }
          }
        } catch (e) {
        }
        
        if (!imageUrl) {
          try {
            const tweetPhoto = tweet.locator('[data-testid="tweetPhoto"] img');
            const photoCount = await tweetPhoto.count().catch(() => 0);
            if (photoCount > 0) {
              const imgSrc = await tweetPhoto.first().getAttribute('src', { timeout: 3000 }).catch(() => null);
              if (imgSrc) {
                imageUrl = imgSrc.replace(/&name=\w+/, '&name=large');
              }
            }
          } catch (e) {
          }
        }
        
        posts.push({
          postId,
          content: fullContent || `[Post from @${account}]`,
          postedAt,
          xUrl,
          sourceAccount: account,
          imageUrl,
          videoUrl,
          isRetweet,
          retweetedFrom,
        });
        
        console.log(`Extracted post ${postId} from @${account}: ${(fullContent || '[media post]').substring(0, 50)}...`);
        
      } catch (error) {
        if (error instanceof Error && !error.message.includes('Timeout')) {
          console.error(`Error extracting tweet from @${account}:`, error.message);
        }
        continue;
      }
    }
    
    console.log(`Successfully scraped ${posts.length} X posts from @${account}`);
    return posts;
    
  } catch (error) {
    console.error(`Error scraping X/Twitter (@${account}):`, error);
    return [];
  } finally {
    if (page) { try { await page.close(); } catch {} }
    if (context) { try { await context.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
    activeBrowser = null;
  }
}

export interface ScrapeResult {
  scrapedCount: number;
  addedCount: number;
}

async function scrapeAccountList(accounts: string[], label: string, deadlineMs?: number): Promise<InsertOsintPost[]> {
  return withScrapeLock(() => scrapeAccountListInner(accounts, label, deadlineMs));
}

async function scrapeAccountListInner(accounts: string[], label: string, deadlineMs?: number): Promise<InsertOsintPost[]> {
  const allPosts: InsertOsintPost[] = [];
  
  for (let i = 0; i < accounts.length; i++) {
    // Optional soft time budget (absolute epoch ms). The main full-scrape body
    // passes this so the large OSINT backfill (19 accounts) can't consume the
    // whole body budget and trip the hard timeout. Stopping early is safe: while
    // the X relay is healthy these scrapes are backfill-only (dedup-by-postId),
    // so any account not reached this cycle is delivered by the relay or picked
    // up next cycle. Callers that omit the deadline (e.g. Journalist) are
    // unaffected.
    if (deadlineMs && Date.now() >= deadlineMs) {
      console.log(`[${label}] Time budget reached — stopping after ${i}/${accounts.length} accounts this cycle (backfill; relay/next cycle covers the rest)`);
      break;
    }
    const account = accounts[i];
    
    try {
      const posts = await withTimeoutAndCleanup(
        scrapeAccount(account),
        SCRAPE_TIMEOUT_MS,
        `@${account} scrape timed out after 60 seconds`
      );
      allPosts.push(...posts);
    } catch (error) {
      console.error(`@${account} scrape failed: ${error instanceof Error ? error.message : error}`);
    }
    
    if (i < accounts.length - 1) {
      console.log(`Waiting 15 seconds before next ${label} account scrape...`);
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
  }
  
  return allPosts;
}

export async function scrapeOsintPosts(deadlineMs?: number): Promise<InsertOsintPost[]> {
  return scrapeAccountList(OSINT_ACCOUNTS, 'OSINT', deadlineMs);
}

export async function updateOsintPosts(storage: any, deadlineMs?: number): Promise<ScrapeResult> {
  return withBrowserLock('updateOsintPosts', () => updateOsintPostsInner(storage, deadlineMs));
}
async function updateOsintPostsInner(storage: any, deadlineMs?: number): Promise<ScrapeResult> {
  let posts: InsertOsintPost[] = [];
  
  try {
    posts = await scrapeOsintPosts(deadlineMs);
  } catch (error) {
    console.error(`OSINT scrape failed: ${error instanceof Error ? error.message : error}`);
    return { scrapedCount: 0, addedCount: 0 };
  }
  
  let addedCount = 0;
  
  for (const post of posts) {
    try {
      const existing = await storage.getOsintPostByPostId(post.postId);
      if (!existing) {
        await storage.addOsintPost(post);
        addedCount++;
      }
    } catch (error) {
      console.error(`Error adding OSINT post ${post.postId}:`, error);
    }
  }
  
  console.log(`Added ${addedCount} new OSINT posts (${posts.length} scraped total)`);
  return { scrapedCount: posts.length, addedCount };
}

export async function scrapeJournalistPosts(): Promise<InsertJournalistPost[]> {
  return scrapeAccountList(JOURNALIST_ACCOUNTS, 'Journalist') as Promise<InsertJournalistPost[]>;
}

export async function updateJournalistPosts(storage: any): Promise<ScrapeResult> {
  return withBrowserLock('updateJournalistPosts', () => updateJournalistPostsInner(storage));
}
async function updateJournalistPostsInner(storage: any): Promise<ScrapeResult> {
  let posts: InsertJournalistPost[] = [];
  
  try {
    posts = await scrapeJournalistPosts();
  } catch (error) {
    console.error(`Journalist scrape failed: ${error instanceof Error ? error.message : error}`);
    return { scrapedCount: 0, addedCount: 0 };
  }
  
  let addedCount = 0;
  
  for (const post of posts) {
    try {
      const existing = await storage.getJournalistPostByPostId(post.postId);
      if (!existing) {
        await storage.addJournalistPost(post);
        addedCount++;
      }
    } catch (error) {
      console.error(`Error adding Journalist post ${post.postId}:`, error);
    }
  }
  
  console.log(`Added ${addedCount} new Journalist posts (${posts.length} scraped total)`);
  return { scrapedCount: posts.length, addedCount };
}
