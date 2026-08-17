import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { withBrowserLock } from './browserLock';
import type { InsertDOWResponsePost } from "@shared/schema";
import { execSync } from 'child_process';
import { injectXAuthCookies, applyXCsrfHeader } from './xAuth';

// Timeout for scraping (60 seconds)
const SCRAPE_TIMEOUT_MS = 60 * 1000;

// Track active browser instances for force-cleanup
let activeBrowser: Browser | null = null;

// Force kill browser and any orphaned Chromium processes
async function forceKillBrowser(): Promise<void> {
  console.log('Force-killing DOWResponse browser instance...');
  
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
    // Ignore errors
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
function getChromiumPath(): string {
  try {
    // Try to find chromium using 'which' command
    const path = execSync('which chromium', { encoding: 'utf-8' }).trim();
    if (path) return path;
  } catch (e) {
    // Fall back to known paths
  }
  
  // Fallback paths in order of preference
  const fallbackPaths = [
    '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  
  return fallbackPaths[0]; // Return first fallback as default
}

export async function scrapeDOWResponsePosts(): Promise<InsertDOWResponsePost[]> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  
  try {
    console.log('Starting X/Twitter scraper for @DOWResponse...');
    
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
    
    // X blocks logged-out guests — inject session cookies so the timeline renders.
    await injectXAuthCookies(context, '@DOWResponse');
    
    page = await context.newPage();
    await applyXCsrfHeader(page);
    
    await page.goto('https://x.com/DOWResponse', {
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
      console.log(`⚠️ Browser interaction failed for @DOWResponse (${interactionError.message}), attempting to extract available content...`);
      await page.waitForTimeout(3000);
    }
    
    // Check page state for debugging
    const currentUrl = await page.url();
    const pageTitle = await page.title();
    console.log(`Current URL: ${currentUrl}`);
    console.log(`Page title: ${pageTitle}`);
    
    // Check if we hit a login wall or rate limit
    const bodyContent = await page.locator('body').first().innerHTML();
    if (bodyContent.includes('errorContainer') || bodyContent.includes('Something went wrong') || 
        bodyContent.includes('Try again') || bodyContent.includes('rate limit')) {
      console.log('⚠️ Possible login wall or rate limit detected for @DOWResponse');
      console.log('Body preview:', bodyContent.substring(0, 500));
    }
    
    const posts: InsertDOWResponsePost[] = [];
    
    // Try to extract posts from the page
    // X/Twitter uses article elements with data-testid="tweet"
    const tweetElements = await page.locator('article[data-testid="tweet"]').all();
    
    console.log(`Found ${tweetElements.length} tweet elements`);
    
    for (let i = 0; i < Math.min(tweetElements.length, 10); i++) {
      try {
        const tweet = tweetElements[i];
        
        // Detect reposts ("retweets") so the curated Hide-Reposts toggle can
        // filter them. Mirrors xScraper/osintScraper: (1) the "reposted"
        // social-context label, (2) the tweet URL belonging to a different
        // author than the profile being scraped.
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
        
        // Use shorter timeout for individual element operations
        const statusLink = tweet.locator('a[href*="/status/"]').first();
        const hasLink = await statusLink.count().catch(() => 0);
        if (hasLink === 0) continue;
        
        const tweetLink = await statusLink.getAttribute('href', { timeout: 5000 }).catch(() => null);
        if (!tweetLink) continue;
        
        const postIdMatch = tweetLink.match(/\/status\/(\d+)/);
        if (!postIdMatch) continue;
        
        const postId = postIdMatch[1];
        
        const urlUserMatch = tweetLink.match(/^\/([^\/]+)\/status\/\d+/);
        if (urlUserMatch && urlUserMatch[1].toLowerCase() !== 'dowresponse') {
          isRetweet = true;
          retweetedFrom = urlUserMatch[1];
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
              // Convert thumbnail URL to full-size image URL
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
          imageUrl,
          isRetweet,
          retweetedFrom,
        });
        
        console.log(`Extracted post ${postId}: ${fullContent.substring(0, 50)}...`);
        
      } catch (error) {
        if (error instanceof Error && !error.message.includes('Timeout')) {
          console.error('Error extracting tweet:', error.message);
        }
        continue;
      }
    }
    
    console.log(`Successfully scraped ${posts.length} X posts from @DOWResponse`);
    return posts;
    
  } catch (error) {
    console.error('Error scraping X/Twitter (@DOWResponse):', error);
    return [];
  } finally {
    if (page) { try { await page.close(); } catch {} }
    if (context) { try { await context.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
    activeBrowser = null;
  }
}

export interface ScrapeResult {
  scrapedCount: number;  // Total posts found on page (for blocking detection)
  addedCount: number;    // New posts added to database
}

export async function updateDOWResponsePosts(storage: any, onLockAcquire?: () => void): Promise<ScrapeResult> {
  return withBrowserLock('updateDOWResponsePosts', () => updateDOWResponsePostsInner(storage), { onAcquire: onLockAcquire });
}
async function updateDOWResponsePostsInner(storage: any): Promise<ScrapeResult> {
  let posts: InsertDOWResponsePost[] = [];
  
  try {
    posts = await withTimeoutAndCleanup(
      scrapeDOWResponsePosts(),
      SCRAPE_TIMEOUT_MS,
      '@DOWResponse scrape timed out after 60 seconds'
    );
  } catch (error) {
    console.error(`@DOWResponse scrape failed: ${error instanceof Error ? error.message : error}`);
    return { scrapedCount: 0, addedCount: 0 };
  }
  
  let addedCount = 0;
  
  for (const post of posts) {
    try {
      // Check if post already exists
      const existing = await storage.getDOWResponsePostByPostId(post.postId);
      if (!existing) {
        await storage.addDOWResponsePost(post);
        addedCount++;
      }
    } catch (error) {
      console.error(`Error adding DOWResponse post ${post.postId}:`, error);
    }
  }
  
  console.log(`Added ${addedCount} new DOWResponse posts`);
  return { scrapedCount: posts.length, addedCount };
}
