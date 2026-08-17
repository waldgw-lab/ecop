import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { withBrowserLock } from './browserLock';
import type { InsertSentDefenderPost } from "@shared/schema";
import { execSync } from 'child_process';

const SCRAPE_TIMEOUT_MS = 60 * 1000;

let activeBrowser: Browser | null = null;

async function forceKillBrowser(): Promise<void> {
  console.log('Force-killing SentDefender browser instance...');
  
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

export async function scrapeSentDefenderPosts(): Promise<InsertSentDefenderPost[]> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  
  try {
    console.log('Starting X/Twitter scraper for @sentdefender...');
    
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
        console.log('🔑 Injected X auth cookies for @sentdefender (authenticated mode)');
      } catch (cookieError) {
        console.error('⚠️ Failed to inject X auth cookies:', cookieError instanceof Error ? cookieError.message : cookieError);
      }
    } else {
      console.log('⚠️ X_AUTH_TOKEN or X_CT0 not set — scraping @sentdefender in unauthenticated mode (may not get chronological posts)');
    }
    
    page = await context.newPage();
    
    if (authToken && ct0) {
      await page.setExtraHTTPHeaders({
        'x-csrf-token': ct0,
      });
    }
    
    await page.goto('https://x.com/sentdefender', {
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
      console.log(`⚠️ Browser interaction failed for @sentdefender (${interactionError.message}), attempting to extract available content...`);
      await page.waitForTimeout(3000);
    }
    
    const currentUrl = await page.url();
    const pageTitle = await page.title();
    console.log(`Current URL: ${currentUrl}`);
    console.log(`Page title: ${pageTitle}`);
    
    const visibleText = await page.locator('body').first().innerText().catch(() => '');
    if (visibleText.includes('Something went wrong') || 
        visibleText.includes('Try again') || visibleText.includes('rate limit')) {
      console.log('⚠️ Possible login wall or rate limit detected for @sentdefender');
      console.log('Visible text preview:', visibleText.substring(0, 500));
    }
    
    const posts: InsertSentDefenderPost[] = [];
    
    const tweetElements = await page.locator('article[data-testid="tweet"]').all();
    
    console.log(`Found ${tweetElements.length} tweet elements`);
    
    for (let i = 0; i < Math.min(tweetElements.length, 10); i++) {
      try {
        const tweet = tweetElements[i];
        
        const statusLink = tweet.locator('a[href*="/status/"]').first();
        const hasLink = await statusLink.count().catch(() => 0);
        if (hasLink === 0) continue;
        
        const tweetLink = await statusLink.getAttribute('href', { timeout: 5000 }).catch(() => null);
        if (!tweetLink) continue;
        
        const postIdMatch = tweetLink.match(/\/status\/(\d+)/);
        if (!postIdMatch) continue;
        
        const postId = postIdMatch[1];
        
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
                console.log(`  Found video URL: ${videoUrl.substring(0, 80)}...`);
              }
              
              const posterSrc = await videoEl.first().getAttribute('poster', { timeout: 3000 }).catch(() => null);
              if (posterSrc && !posterSrc.startsWith('blob:')) {
                imageUrl = posterSrc;
                console.log(`  Found video poster: ${imageUrl.substring(0, 80)}...`);
              }
            }
            
            if (!imageUrl) {
              const thumbImg = videoComponent.first().locator('img');
              const thumbCount = await thumbImg.count().catch(() => 0);
              if (thumbCount > 0) {
                const thumbSrc = await thumbImg.first().getAttribute('src', { timeout: 3000 }).catch(() => null);
                if (thumbSrc && !thumbSrc.startsWith('blob:')) {
                  imageUrl = thumbSrc.replace(/&name=\w+/, '&name=large');
                  console.log(`  Found video thumbnail: ${imageUrl.substring(0, 80)}...`);
                }
              }
            }
            
            if (!videoUrl) {
              videoUrl = `https://x.com${tweetLink}`;
              console.log(`  Video detected (blob URL) — using X post link as fallback`);
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
                console.log(`  Found image: ${imageUrl.substring(0, 80)}...`);
              }
            }
          } catch (e) {
          }
        }
        
        posts.push({
          postId,
          content: fullContent,
          postedAt,
          xUrl,
          imageUrl,
          videoUrl,
        });
        
        console.log(`Extracted post ${postId}: ${fullContent.substring(0, 50)}...`);
        
      } catch (error) {
        if (error instanceof Error && !error.message.includes('Timeout')) {
          console.error('Error extracting tweet:', error.message);
        }
        continue;
      }
    }
    
    console.log(`Successfully scraped ${posts.length} X posts from @sentdefender`);
    return posts;
    
  } catch (error) {
    console.error('Error scraping X/Twitter (@sentdefender):', error);
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

export async function updateSentDefenderPosts(storage: any, onLockAcquire?: () => void): Promise<ScrapeResult> {
  return withBrowserLock('updateSentDefenderPosts', () => updateSentDefenderPostsInner(storage), { onAcquire: onLockAcquire });
}
async function updateSentDefenderPostsInner(storage: any): Promise<ScrapeResult> {
  let posts: InsertSentDefenderPost[] = [];
  
  try {
    posts = await withTimeoutAndCleanup(
      scrapeSentDefenderPosts(),
      SCRAPE_TIMEOUT_MS,
      '@sentdefender scrape timed out after 60 seconds'
    );
  } catch (error) {
    console.error(`@sentdefender scrape failed: ${error instanceof Error ? error.message : error}`);
    return { scrapedCount: 0, addedCount: 0 };
  }
  
  let addedCount = 0;
  
  for (const post of posts) {
    try {
      const existing = await storage.getSentDefenderPostByPostId(post.postId);
      if (!existing) {
        await storage.addSentDefenderPost(post);
        addedCount++;
      }
    } catch (error) {
      console.error(`Error adding SentDefender post ${post.postId}:`, error);
    }
  }
  
  console.log(`Added ${addedCount} new SentDefender posts`);
  return { scrapedCount: posts.length, addedCount };
}
