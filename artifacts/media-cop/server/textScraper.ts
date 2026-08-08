import * as cheerio from 'cheerio';
import { execSync } from 'child_process';
import { fetchViaPaywallBypass } from './paywallBypass';
import { isPlaceholderImageUrl } from '@shared/placeholderImage';

interface ScrapedContent {
  fullText: string;
  imageUrl?: string | null;
  success: boolean;
  error?: string;
}

// Result of a single page fetch that can be reused across metadata extraction
// (analyzeSubmittedLink) and full-text extraction (scrapeArticleText) so the
// review flow only hits the network once per article.
export interface PrefetchedPage {
  html: string | null;
  ok: boolean;
  status: number;
}

// Fetch a page's HTML once. Mirrors the request headers/timeout used by
// scrapeArticleText so a reused fetch behaves identically to the inline one.
// Never throws — a network error returns { html: null, ok: false, status: 0 }.
export async function fetchPageHtml(url: string): Promise<PrefetchedPage> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return { html: null, ok: false, status: response.status };
    }
    const html = await response.text();
    return { html, ok: true, status: response.status };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.log(`[Scraper] fetchPageHtml failed for ${url}: ${errorMessage}`);
    return { html: null, ok: false, status: 0 };
  }
}

export interface XPostScrapedContent {
  text: string;
  imageUrl: string | null;
  videoUrl: string | null;
  author: string;
  postedAt: string | null;
  success: boolean;
}

function getChromiumPath(): string {
  try {
    const path = execSync('which chromium', { encoding: 'utf-8' }).trim();
    if (path) return path;
  } catch (e) {}
  return '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium';
}

export async function scrapeXPostContent(url: string): Promise<XPostScrapedContent> {
  const fail = { text: '', imageUrl: null, videoUrl: null, author: '', postedAt: null as string | null, success: false };
  let browser: any = null;
  let context: any = null;
  let page: any = null;

  try {
    const authorMatch = url.match(/(?:x\.com|twitter\.com)\/([^/]+)\/status/i);
    const author = authorMatch ? authorMatch[1] : '';

    const { chromium } = await import('playwright');
    const chromiumPath = getChromiumPath();
    console.log(`[XPostScraper] Scraping single post: ${url}`);

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

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    const authToken = process.env.X_AUTH_TOKEN;
    const ct0 = process.env.X_CT0;

    if (authToken && ct0) {
      await context.addCookies([
        { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' as const },
        { name: 'ct0', value: ct0, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' as const },
        { name: 'auth_token', value: authToken, domain: '.twitter.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' as const },
        { name: 'ct0', value: ct0, domain: '.twitter.com', path: '/', secure: true, sameSite: 'Lax' as const },
      ]);
    }

    page = await context.newPage();
    if (authToken && ct0) {
      await page.setExtraHTTPHeaders({ 'x-csrf-token': ct0 });
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    let tweetText = '';
    try {
      await page.waitForSelector('article[data-testid="tweet"] [data-testid="tweetText"]', { timeout: 15000 });
      const tweetTextEl = await page.$('article[data-testid="tweet"] [data-testid="tweetText"]');
      if (tweetTextEl) {
        tweetText = (await tweetTextEl.textContent()) || '';
      }
    } catch (e) {
      console.log('[XPostScraper] Could not find tweetText selector, trying fallback');
      try {
        await page.waitForSelector('article [lang]', { timeout: 5000 });
        const fallbackEl = await page.$('article [lang]');
        if (fallbackEl) {
          tweetText = (await fallbackEl.textContent()) || '';
        }
      } catch {
        console.log('[XPostScraper] Fallback selector also failed');
      }
    }

    let imageUrl: string | null = null;
    let videoUrl: string | null = null;

    try {
      const videoComponent = await page.$('article[data-testid="tweet"] [data-testid="videoComponent"], article[data-testid="tweet"] [data-testid="videoPlayer"]');
      if (videoComponent) {
        console.log('[XPostScraper] Video detected in post');
        const videoEl = await videoComponent.$('video');
        if (videoEl) {
          const vidSrc = await videoEl.getAttribute('src').catch(() => null);
          if (vidSrc && !vidSrc.startsWith('blob:')) {
            videoUrl = vidSrc;
          }
          const posterSrc = await videoEl.getAttribute('poster').catch(() => null);
          if (posterSrc && !posterSrc.startsWith('blob:')) {
            imageUrl = posterSrc;
          }
        }
        if (!imageUrl) {
          const thumbImg = await videoComponent.$('img');
          if (thumbImg) {
            const thumbSrc = await thumbImg.getAttribute('src').catch(() => null);
            if (thumbSrc && !thumbSrc.startsWith('blob:')) {
              imageUrl = thumbSrc.replace(/&name=\w+/, '&name=large');
            }
          }
        }
        if (!videoUrl) {
          videoUrl = url;
        }
      }
    } catch (e) {
      console.log('[XPostScraper] Could not extract video');
    }

    let postedAt: string | null = null;
    try {
      const timeEl = await page.$('article[data-testid="tweet"] time');
      if (timeEl) {
        postedAt = await timeEl.getAttribute('datetime');
      }
    } catch (e) {
      console.log('[XPostScraper] Could not extract timestamp');
    }

    if (!imageUrl) {
      try {
        const imgEl = await page.$('article[data-testid="tweet"] [data-testid="tweetPhoto"] img');
        if (imgEl) {
          let src = await imgEl.getAttribute('src');
          if (src && src.includes('pbs.twimg.com')) {
            src = src.replace(/&name=\w+/, '&name=large');
            imageUrl = src;
          }
        }
      } catch (e) {
        console.log('[XPostScraper] Could not extract image');
      }
    }

    await browser.close();
    browser = null;

    if (tweetText.trim()) {
      console.log(`[XPostScraper] Extracted ${tweetText.length} chars from @${author}${videoUrl ? ' (with video)' : ''}${imageUrl ? ' (with image)' : ''}`);
      return { text: tweetText.trim(), imageUrl, videoUrl, author, postedAt, success: true };
    }

    console.log('[XPostScraper] No tweet text found');
    return { ...fail, author };
  } catch (error) {
    console.error('[XPostScraper] Error:', error instanceof Error ? error.message : error);
    return fail;
  } finally {
    if (page) { try { await page.close(); } catch {} }
    if (context) { try { await context.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
  }
}

function extractImageFromHtml($: cheerio.CheerioAPI): string | null {
  let imageUrl: string | null = null;

  // og:image / twitter:image is normally the article's lead photo, BUT some
  // outlets (ABC's wire stories are the canonical case) serve their generic
  // brand "default" share image here when an article has no dedicated photo.
  // A placeholder must NOT win over a real photo found elsewhere on the page,
  // so when og:image is a known placeholder we fall through to ld+json /
  // link[rel=image_src] / the first real article body image, and only return
  // the placeholder as a last resort if nothing better turns up.
  let placeholderFallback: string | null = null;
  const ogImageEl = $('meta[property="og:image"]').attr('content')
    || $('meta[name="og:image"]').attr('content')
    || $('meta[name="twitter:image"]').attr('content')
    || $('meta[property="twitter:image"]').attr('content')
    || $('meta[property="twitter:image:src"]').attr('content');
  if (ogImageEl && ogImageEl.startsWith('http')) {
    if (!isPlaceholderImageUrl(ogImageEl)) {
      return ogImageEl;
    }
    placeholderFallback = ogImageEl;
  }

  $('script[type="application/ld+json"]').each((_, el) => {
    if (imageUrl) return;
    try {
      const json = JSON.parse($(el).text());
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        const img = item.image || item.thumbnailUrl;
        if (img) {
          const candidate = typeof img === 'string' ? img : (img.url || (Array.isArray(img) ? img[0] : null));
          if (candidate && typeof candidate === 'string' && candidate.startsWith('http') && !isPlaceholderImageUrl(candidate)) {
            imageUrl = candidate;
            break;
          }
        }
      }
    } catch {}
  });
  if (imageUrl) return imageUrl;

  const linkImage = $('link[rel="image_src"]').attr('href');
  if (linkImage && linkImage.startsWith('http') && !isPlaceholderImageUrl(linkImage)) {
    return linkImage;
  }

  // Last resort: the first real-looking image inside the article body. Skips
  // tiny tracking pixels, icons/logos, and known placeholders. This is what
  // recovers the lead photo on pages (like ABC wire stories) whose only
  // metadata image is the brand default.
  const bodyImage = extractFirstArticleBodyImage($);
  if (bodyImage) return bodyImage;

  // Nothing real anywhere — return the placeholder only if that's all we had,
  // so callers that explicitly tolerate it still get something; the curated /
  // main-feed placeholder detection will treat it as "needs a real photo".
  return placeholderFallback;
}

// Find the first plausible LEAD photo inside the article content. Only accepts
// images that look like real photography (article/figure context, http(s) src,
// not an obvious icon/logo/placeholder). Conservative by design — a miss just
// leaves the row retryable, a false positive would show a logo as a photo.
function extractFirstArticleBodyImage($: cheerio.CheerioAPI): string | null {
  const scopes = ['article', '[role="main"]', 'main', '.article-body', '.story-body'];
  for (const scope of scopes) {
    const root = $(scope).first();
    if (root.length === 0) continue;
    let found: string | null = null;
    root.find('figure img, picture img, img').each((_, el) => {
      if (found) return;
      const $img = $(el);
      const raw = (
        $img.attr('src') ||
        $img.attr('data-src') ||
        $img.attr('data-lazy-src') ||
        ''
      ).trim();
      if (!raw || !raw.startsWith('http')) return;
      if (isPlaceholderImageUrl(raw)) return;
      const lower = raw.toLowerCase();
      if (/(sprite|icon|logo|avatar|placeholder|1x1|pixel|spacer|blank)\b/.test(lower)) return;
      // Skip obvious thumbnails by width hint when present.
      const w = parseInt($img.attr('width') || '0', 10);
      if (w && w < 200) return;
      found = raw;
    });
    if (found) return found;
  }
  return null;
}

/**
 * Detect whether extracted "article text" is actually junk that should never
 * be fed to AI summarization: browser-compatibility notices, captcha gates,
 * or pages whose content is predominantly a non-Latin script (Persian, CJK,
 * Arabic) with no English article body.
 *
 * Conservative — only high-signal patterns so genuine articles that quote
 * foreign-language names or include occasional non-ASCII characters pass
 * through unaffected.
 *
 * When true, the caller should fall through to the paywall-bypass path (never
 * feed the junk to AI, and keep the row retryable via the back-off machinery).
 */
export function isJunkPageContent(text: string): boolean {
  if (!text || text.trim().length < 30) return false;
  const t = text.trim();

  // 1. Browser-compatibility / enable-JavaScript notices — the page cannot be
  //    rendered by a plain HTTP fetch and the Cheerio pass picked up the compat
  //    notice instead of any article text (CBS, some CNBC pages).
  if (
    /\b(?:javascript\s+is\s+(?:required|disabled)|enable\s+javascript|this\s+(?:site|page|app(?:lication)?)\s+requires?\s+javascript|your\s+browser\s+(?:is\s+not\s+supported|does\s+not\s+support\s+javascript)|javascript\s+must\s+be\s+(?:enabled|turned\s+on)|browser\s+compatibility\s+(?:mode|notice|message|alert))\b/i.test(t)
  ) {
    return true;
  }

  // 2. Captcha / bot-check / Cloudflare DDoS gate pages.
  if (
    /\b(?:verify\s+(?:you\s+are\s+a\s+human|you['']?re\s+not\s+a\s+robot)|prove\s+you\s+are\s+not\s+a\s+robot|complete\s+the\s+captcha|captcha\s+verification|checking\s+your\s+browser|ddos\s+protection\s+by\s+cloudflare|enable\s+cookies\s+and\s+reload|you\s+have\s+been\s+blocked|access\s+to\s+this\s+page\s+has\s+been\s+denied\b.*cloudflare)\b/i.test(t)
  ) {
    return true;
  }

  // 3. Predominantly non-Latin-script content: CJK, Arabic/Persian, Cyrillic.
  //    When non-Latin characters make up >45% of total characters the page is
  //    almost certainly a non-English homepage shell (Fars, Xinhua Chinese,
  //    Russian TASS mirror) rather than an English article worth summarizing.
  //    Threshold is 45% to avoid false-positives on English articles that
  //    quote foreign names (typically <5% of the character count).
  //    Minimum text length 50 so empty / very-short extracts don't trip this.
  if (t.length > 50) {
    const nonLatinCount = (
      t.match(/[\u0400-\u04FF\u0600-\u06FF\u0750-\u077F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []
    ).length;
    if (nonLatinCount / t.length > 0.45) {
      return true;
    }
  }

  // 4. Navigation-menu / link-list detection (Latin-script).
  //    When the Cheerio extractors survive nav menus (unusual class names,
  //    `.menu` missed, CNBC section bars, Xinhua English nav, etc.) the
  //    resulting text is a stream of very short fragments — mostly single
  //    words or two-word phrases — separated by pipes, bullets, or newlines.
  //    Real article prose has very few such short segments.
  //    Conservative threshold: ≥8 segments, ≥75% of them ≤3 words long.
  //    Minimum text length 80 so short excerpts don't trip this; the ≥8-segment
  //    guard adds further precision above the length floor.
  if (t.length > 80) {
    const segments = t.split(/[\n\r|•·\/]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    if (segments.length >= 8) {
      const shortCount = segments.filter((s) => (s.match(/\b\w{2,}\b/g) || []).length <= 3).length;
      if (shortCount / segments.length > 0.75) {
        return true;
      }
    }
  }

  // 5. Footer-boilerplate detection (Latin-script).
  //    Cookie consent pages, legal/nav footers that survive selector removal:
  //    detected by co-occurrence of ≥3 footer-specific legal/nav phrases.
  //    Each phrase is high-specificity enough that finding 3 together is a
  //    near-certain signal, even if any one might appear in real reporting.
  if (t.length > 100) {
    const footerPatterns = [
      /\bprivacy\s+policy\b/i,
      /\bterms\s+(?:of\s+)?(?:service|use)\b/i,
      /\bcookie\s+(?:policy|settings?|notice|consent|preferences?|banner)\b/i,
      /\ball\s+rights\s+reserved\b/i,
      /\bdo\s+not\s+sell\s+(?:my\s+)?(?:personal\s+)?(?:data|information)\b/i,
      /\badvertise\s+(?:with\s+us)?\b/i,
      /\baccessibility\s+statement\b/i,
      /\bnewsletter\s+sign[- ]?up\b/i,
    ];
    const footerMatchCount = footerPatterns.filter((re) => re.test(t)).length;
    if (footerMatchCount >= 3) {
      return true;
    }
  }

  // 6. Stub / placeholder pages — the scraped text is itself a "coming soon"
  //    or "this article is a placeholder" notice. Short stubs are already gated
  //    by the 200-char minimum in the enrichment functions; this catches
  //    longer stubs that pass the length test but carry no real content.
  //    Subject-anchored patterns to avoid false-positives on real news stories
  //    that mention placeholder content in legislation, budgets, etc. contexts.
  //    "no substantive news content" is only matched when bound to an article/page
  //    subject (e.g. "this page contains no substantive news content"), NOT in
  //    free-standing political/legislative sentences.
  if (
    /\b(?:this\s+(?:article|page|story|content|post)\s+is\s+a\s+placeholder|placeholder\s+(?:article|page|content|post|story)\b|this\s+page\s+is\s+coming\s+soon|this\s+(?:article|story|content)\s+(?:will\s+be\s+)?(?:updated|available)\s+soon|content\s+coming\s+soon|(?:this|the)\s+(?:article|page|story|content)\s+(?:has|contains?|provides?)\s+no\s+substantive\s+news\s+content)\b/i.test(t)
  ) {
    return true;
  }

  return false;
}

function extractArticleText($: cheerio.CheerioAPI): string {
  $('script, style, nav, header, footer, aside, iframe, noscript, svg, form, button, input, .ad, .advertisement, .social-share, .comments, .related-posts, .sidebar, .menu, .navigation').remove();

  const contentSelectors = [
    'article',
    '[role="main"]',
    '.article-content',
    '.article-body',
    '.post-content',
    '.entry-content',
    '.story-body',
    '.content-body',
    '.main-content',
    '#article-body',
    '#content',
    '.article',
    'main',
  ];

  let articleText = '';
  for (const selector of contentSelectors) {
    const element = $(selector);
    if (element.length > 0) {
      articleText = element.text();
      break;
    }
  }

  if (!articleText || articleText.trim().length < 100) {
    articleText = $('body').text();
  }

  return articleText
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim()
    .slice(0, 50000);
}

async function scrapeWithPlaywright(url: string): Promise<ScrapedContent> {
  let browser: any = null;
  let context: any = null;
  let page: any = null;
  try {
    const { chromium } = await import('playwright');
    const chromiumPath = getChromiumPath();
    console.log(`[PlaywrightScraper] Fallback scraping: ${url}`);

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

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });

    page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const html = await page.content();
    await browser.close();
    browser = null;

    const $ = cheerio.load(html);
    const imageUrl = extractImageFromHtml($);
    const cleanedText = extractArticleText($);

    if (cleanedText.length < 50) {
      console.log(`[PlaywrightScraper] Content still too short (${cleanedText.length} chars) for ${url}`);
      return { fullText: '', imageUrl, success: false, error: 'Content too short even with Playwright' };
    }

    // Even with JS rendered, Playwright may return a junk page (captcha gate,
    // bot-wall, non-English shell). Treat it like short content — fail so the
    // caller can fall through to the paywall-bypass path.
    if (isJunkPageContent(cleanedText)) {
      console.log(`[PlaywrightScraper] Junk page content detected (${cleanedText.length} chars) for ${url}`);
      return { fullText: '', imageUrl, success: false, error: 'Junk page content (Playwright)' };
    }

    console.log(`[PlaywrightScraper] Extracted ${cleanedText.length} chars, image=${!!imageUrl} from ${url}`);
    return { fullText: cleanedText, imageUrl, success: true };
  } catch (error) {
    console.error(`[PlaywrightScraper] Error scraping ${url}:`, error instanceof Error ? error.message : error);
    return { fullText: '', success: false, error: `Playwright fallback failed: ${error instanceof Error ? error.message : 'Unknown'}` };
  } finally {
    if (page) { try { await page.close(); } catch {} }
    if (context) { try { await context.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
  }
}

export async function scrapeArticleText(url: string, prefetched?: PrefetchedPage): Promise<ScrapedContent> {
  try {
    let html: string;
    if (prefetched !== undefined) {
      // Reuse a single page fetch (review flow). A non-ok prefetch is treated
      // identically to the inline !response.ok branch below.
      if (!prefetched.ok || prefetched.html === null) {
        console.log(`[Scraper] prefetch not ok (status ${prefetched.status}) for ${url} — trying paywall bypass`);
        const pwBypass = await fetchViaPaywallBypass(url);
        if (pwBypass && (pwBypass.story || pwBypass.imageUrl)) {
          return {
            fullText: pwBypass.story || '',
            imageUrl: pwBypass.imageUrl,
            success: !!(pwBypass.story && pwBypass.story.length >= 50),
          };
        }
        return { fullText: '', success: false, error: `HTTP ${prefetched.status}` };
      }
      html = prefetched.html;
    } else {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        console.log(`[Scraper] HTTP ${response.status} for ${url} — trying paywall bypass`);
        const pwBypass = await fetchViaPaywallBypass(url);
        if (pwBypass && (pwBypass.story || pwBypass.imageUrl)) {
          return {
            fullText: pwBypass.story || '',
            imageUrl: pwBypass.imageUrl,
            success: !!(pwBypass.story && pwBypass.story.length >= 50),
          };
        }
        return { fullText: '', success: false, error: `HTTP ${response.status}` };
      }

      html = await response.text();
    }
    const $ = cheerio.load(html);
    const imageUrl = extractImageFromHtml($);
    const cleanedText = extractArticleText($);

    // Junk-page detection: if the extracted text is a browser-compat notice,
    // captcha gate, or predominantly non-Latin script, skip Playwright (it won't
    // help) and fall through directly to the paywall-bypass path. Never feed
    // junk content to AI; keep the row retryable via existing back-off machinery.
    if (isJunkPageContent(cleanedText)) {
      console.log(`[Scraper] Junk page content detected (${cleanedText.length} chars) for ${url} — skipping to paywall bypass`);
      const pwBypassJunk = await fetchViaPaywallBypass(url);
      if (pwBypassJunk && (pwBypassJunk.story || pwBypassJunk.imageUrl)) {
        return {
          fullText: pwBypassJunk.story || '',
          imageUrl: pwBypassJunk.imageUrl || imageUrl,
          success: !!(pwBypassJunk.story && pwBypassJunk.story.length >= 50),
        };
      }
      return { fullText: '', imageUrl, success: false, error: 'Junk page content detected' };
    }

    const needsPlaywrightFallback = cleanedText.length < 50 || (!imageUrl && cleanedText.length < 200);

    if (needsPlaywrightFallback) {
      console.log(`[Scraper] Cheerio got thin content (${cleanedText.length} chars, image=${!!imageUrl}) for ${url} — trying Playwright`);
      const pwResult = await scrapeWithPlaywright(url);
      if (pwResult.success || pwResult.imageUrl) {
        return {
          fullText: pwResult.fullText || cleanedText,
          imageUrl: pwResult.imageUrl || imageUrl,
          success: pwResult.success || cleanedText.length >= 50,
        };
      }
    }

    let finalText = cleanedText;
    let finalImage = imageUrl;

    const needsPaywallFallback = finalText.length < 50 || !finalImage;
    if (needsPaywallFallback) {
      const pwBypass = await fetchViaPaywallBypass(url);
      if (pwBypass) {
        if (finalText.length < 50 && pwBypass.story && pwBypass.story.length >= 50) {
          finalText = pwBypass.story;
        }
        if (!finalImage && pwBypass.imageUrl) {
          finalImage = pwBypass.imageUrl;
        }
      }
    }

    if (finalText.length < 50) {
      return { fullText: '', imageUrl: finalImage, success: false, error: 'Content too short' };
    }

    return { fullText: finalText, imageUrl: finalImage, success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to scrape article text from ${url}:`, errorMessage);
    const pwBypass = await fetchViaPaywallBypass(url).catch(() => null);
    if (pwBypass && (pwBypass.story || pwBypass.imageUrl)) {
      return {
        fullText: pwBypass.story || '',
        imageUrl: pwBypass.imageUrl,
        success: !!(pwBypass.story && pwBypass.story.length >= 50),
      };
    }
    return { fullText: '', success: false, error: errorMessage };
  }
}

export async function scrapeSocialMediaText(url: string): Promise<ScrapedContent> {
  // For social media posts, we typically already have the content from the submission
  // But we can try to get more context if available
  try {
    // X/Twitter URLs - content is usually in the message already
    if (url.includes('twitter.com') || url.includes('x.com')) {
      return { fullText: '', success: true, error: 'Twitter/X content is in the submission' };
    }

    // For other social media, try a basic scrape
    return await scrapeArticleText(url);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { fullText: '', success: false, error: errorMessage };
  }
}

export async function scrapeContent(url: string, sourceType: string, prefetched?: PrefetchedPage): Promise<ScrapedContent> {
  console.log(`Scraping full text from ${url} (type: ${sourceType})...`);
  
  if (sourceType === 'social_media') {
    return await scrapeSocialMediaText(url);
  }
  
  return await scrapeArticleText(url, prefetched);
}
