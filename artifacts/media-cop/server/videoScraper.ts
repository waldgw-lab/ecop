import { chromium, Browser, Page } from 'playwright';

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
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
      ],
    });
  }
  return browser;
}

export interface VideoScrapeResult {
  videoUrl: string | null;
  ogImageUrl: string | null;
}

// Hard timeout wrapper to prevent hung scrapes
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, cleanup?: () => Promise<void>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(async () => {
      if (cleanup) {
        try { await cleanup(); } catch (e) { /* ignore cleanup errors */ }
      }
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

async function scrapeVideoUrlInternal(articleUrl: string): Promise<VideoScrapeResult> {
  let page: Page | null = null;
  
  try {
    console.log(`[VideoScraper] Scraping video from: ${articleUrl}`);
    
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();
    
    // Set up network interception to capture video requests
    const videoUrls: string[] = [];
    
    page.on('response', async (response) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';
      
      // Look for video content
      if (
        url.includes('.mp4') ||
        url.includes('.m3u8') ||
        url.includes('/video/') ||
        contentType.includes('video/') ||
        contentType.includes('application/x-mpegURL')
      ) {
        // Prefer MP4 over HLS
        if (url.includes('.mp4') && !url.includes('manifest')) {
          videoUrls.unshift(url); // Prioritize MP4
        } else if (!videoUrls.some(v => v.includes('.mp4'))) {
          videoUrls.push(url);
        }
      }
    });
    
    // Navigate to the page
    await page.goto(articleUrl, { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    
    // Wait a bit for video to start loading
    await page.waitForTimeout(3000);
    
    // Try to find and click play button if video hasn't started
    try {
      const playButton = await page.$('button[aria-label*="play" i], button[class*="play" i], [class*="PlayButton"], video');
      if (playButton) {
        await playButton.click().catch(() => {});
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      // Ignore click errors
    }
    
    // Also check for video elements in the DOM. Raw JSON-LD script text is
    // returned to Node so parse failures can be logged in the server context
    // (a console.warn inside page.evaluate runs in the browser and never reaches
    // our server logs).
    const { sources: videoSources, jsonLdScripts } = await page.evaluate(() => {
      const sources: string[] = [];
      
      // Check video elements
      document.querySelectorAll('video').forEach(video => {
        if (video.src) sources.push(video.src);
        video.querySelectorAll('source').forEach(source => {
          if (source.src) sources.push(source.src);
        });
      });
      
      // Collect raw JSON-LD text for Node-side parsing
      const jsonLdScripts: string[] = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
        if (script.textContent) jsonLdScripts.push(script.textContent);
      });
      
      return { sources, jsonLdScripts };
    });
    
    // Parse JSON-LD for video URLs in Node context so failures are logged
    for (const scriptText of jsonLdScripts) {
      try {
        const data = JSON.parse(scriptText);
        if (data.contentUrl) videoSources.push(data.contentUrl);
        if (data.embedUrl) videoSources.push(data.embedUrl);
        if (data['@type'] === 'VideoObject') {
          if (data.contentUrl) videoSources.push(data.contentUrl);
        }
      } catch (e) {
        console.warn(`[videoScraper] Failed to parse JSON-LD for video metadata on ${articleUrl}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    
    videoUrls.push(...videoSources.filter(url => url && !videoUrls.includes(url)));
    
    // Get og:image as fallback
    const ogImageUrl = await page.evaluate(() => {
      const ogImage = document.querySelector('meta[property="og:image"]');
      return ogImage?.getAttribute('content') || null;
    });
    
    // Find the best video URL (prefer MP4)
    let bestVideoUrl: string | null = null;
    for (const url of videoUrls) {
      if (url.includes('.mp4') && !url.includes('manifest') && !url.includes('playlist')) {
        bestVideoUrl = url;
        break;
      }
    }
    
    // If no MP4 found, try m3u8 (HLS) as some browsers support it
    if (!bestVideoUrl) {
      for (const url of videoUrls) {
        if (url.includes('.m3u8')) {
          bestVideoUrl = url;
          break;
        }
      }
    }
    
    console.log(`[VideoScraper] Found video: ${bestVideoUrl || 'none'}, image: ${ogImageUrl || 'none'}`);
    
    return {
      videoUrl: bestVideoUrl,
      ogImageUrl,
    };
    
  } catch (error) {
    console.error(`[VideoScraper] Error scraping ${articleUrl}:`, error);
    return { videoUrl: null, ogImageUrl: null };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

// Public function with hard 45-second timeout
export async function scrapeVideoUrl(articleUrl: string): Promise<VideoScrapeResult> {
  try {
    return await withTimeout(
      scrapeVideoUrlInternal(articleUrl),
      45000,
      async () => {
        console.log(`[VideoScraper] Timeout reached for ${articleUrl}, cleaning up...`);
      }
    );
  } catch (error) {
    console.error(`[VideoScraper] Scrape failed for ${articleUrl}:`, error);
    return { videoUrl: null, ogImageUrl: null };
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
