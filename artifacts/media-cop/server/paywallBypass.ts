export interface PaywallResult {
  headline: string | null;
  story: string | null;
  imageUrl: string | null;
  author: string | null;
  source: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
}

export async function fetchViaPaywallBypass(url: string, timeoutMs = 60000): Promise<PaywallResult | null> {
  const apiKey = process.env.PAYWALL_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const encodedUrl = encodeURIComponent(url);
    const response = await fetch(
      `https://paywall2.replit.app/api/article?url=${encodedUrl}`,
      {
        headers: { 'X-API-Key': apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      }
    );

    if (!response.ok) {
      console.log(`[PaywallBypass] API returned ${response.status} for ${url}`);
      return null;
    }

    const data = await response.json() as any;

    const result: PaywallResult = {
      headline: data.headline || null,
      story: data.story || null,
      imageUrl: data.image || null,
      author: data.author || null,
      source: data.source || null,
      sourceUrl: data.sourceUrl || null,
      publishedAt: data.publishedAt || null,
    };

    const hasContent = result.headline || result.story || result.imageUrl;
    if (!hasContent) {
      console.log(`[PaywallBypass] API returned empty result for ${url}`);
      return null;
    }

    console.log(`[PaywallBypass] Recovered content for ${url}: headline=${!!result.headline}, story=${result.story ? result.story.length + ' chars' : 'none'}, image=${!!result.imageUrl}`);
    return result;
  } catch (error) {
    console.error(`[PaywallBypass] Error for ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

// Jina rate-limits the curated extraction chain aggressively (HTTP 429). A bare
// 429 means the row silently gets no image, so on a throttle we retry once after
// a short back-off (honoring Retry-After when the header is present, capped)
// before giving up and letting the caller fall through to the next provider
// (CPC). The retry uses a capped timeout so two Jina calls + CPC still fit
// inside the per-item curated enrichment budget. Curated-lane only.
const JINA_RETRY_BACKOFF_MS = 700;
const JINA_RETRY_TIMEOUT_CAP_MS = 8000;

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 5000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), 5000);
  return null;
}

// Fetch from the Jina reader with a single 429-aware retry. Returns the final
// Response (which may still be a 429 after the retry — the caller handles that
// via its existing !response.ok branch and falls through to CPC).
async function jinaReaderFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  let response = await fetch(`https://r.jina.ai/${url}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 429) {
    const wait = parseRetryAfterMs(response.headers.get('retry-after')) ?? JINA_RETRY_BACKOFF_MS;
    console.log(`[Jina] 429 throttled for ${url}; backing off ${wait}ms then retrying once`);
    await new Promise((resolve) => setTimeout(resolve, wait));
    response = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      signal: AbortSignal.timeout(Math.min(timeoutMs, JINA_RETRY_TIMEOUT_CAP_MS)),
    });
  }
  return response;
}

/**
 * Jina AI Reader extractor (curated lane ONLY).
 *
 * Free, no API key required. Fetches `https://r.jina.ai/<url>` which returns a
 * clean text/markdown rendering of the article — ideal for AI bullet
 * generation. We request JSON so we can also opportunistically pull a title and
 * the first inline image. Uses a short fast-fail timeout so a slow render does
 * not block the curated enrichment chain.
 *
 * NEVER call this for main-feed (classic/visual) items — the main feed must keep
 * its single paywall2 behavior unchanged.
 */
export async function fetchViaJinaReader(url: string, timeoutMs = 13000): Promise<PaywallResult | null> {
  try {
    const response = await jinaReaderFetch(url, {
      'Accept': 'application/json',
      'X-Return-Format': 'markdown',
    }, timeoutMs);

    if (!response.ok) {
      console.log(`[Jina] Reader returned ${response.status} for ${url}`);
      return null;
    }

    const data = await response.json() as any;
    const d = data?.data ?? data;

    const story: string | null = typeof d?.content === 'string' && d.content.trim().length > 0
      ? d.content.trim()
      : null;

    let imageUrl: string | null = null;
    if (d?.images && typeof d.images === 'object') {
      const firstImage = Object.values(d.images).find(
        (v) => typeof v === 'string' && /^https?:\/\//i.test(v as string)
      );
      if (typeof firstImage === 'string') imageUrl = firstImage;
    }

    const result: PaywallResult = {
      headline: typeof d?.title === 'string' && d.title.trim() ? d.title.trim() : null,
      story,
      imageUrl,
      author: null,
      source: null,
      sourceUrl: typeof d?.url === 'string' ? d.url : null,
      publishedAt: null,
    };

    const hasContent = result.story || result.imageUrl;
    if (!hasContent) {
      console.log(`[Jina] Reader returned empty result for ${url}`);
      return null;
    }

    console.log(`[Jina] Recovered content for ${url}: story=${result.story ? result.story.length + ' chars' : 'none'}, image=${!!result.imageUrl}`);
    return result;
  } catch (error) {
    console.error(`[Jina] Error for ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Jina AI Reader in HTML mode (curated lane ONLY) — Task #161.
 *
 * Returns the page's RAW HTML (meta tags + JSON-LD intact) by asking the Jina
 * reader for `X-Return-Format: html`. Jina fetches the page from its own infra,
 * so this recovers article meta tags for outlets that hard-block our datacenter
 * IP with a 403 (e.g. Axios) — cases where even a strengthened direct fetch
 * fails. The caller mines the returned HTML for og:image / twitter:image /
 * JSON-LD. Returns null on any failure.
 *
 * NEVER call this for main-feed (classic/visual) items.
 */
export async function fetchViaJinaHtml(url: string, timeoutMs = 13000): Promise<string | null> {
  try {
    const response = await jinaReaderFetch(url, { 'X-Return-Format': 'html' }, timeoutMs);
    if (!response.ok) {
      console.log(`[Jina:HTML] Reader returned ${response.status} for ${url}`);
      return null;
    }
    const html = await response.text();
    if (!html || html.length < 200) {
      console.log(`[Jina:HTML] Reader returned too little HTML for ${url}`);
      return null;
    }
    return html;
  } catch (error) {
    console.error(`[Jina:HTML] Error for ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

const CPC_API_BASE_URL = process.env.MCOP_CPC_API_URL || 'https://copy-paste-connoisseur.replit.app';

/**
 * CPC ("Copy Paste Connoisseur") extractor (curated lane ONLY).
 *
 * A second hosted bypass provider, used only as a fallback for the residual
 * curated articles that Jina cannot crack — keeping paid call volume low.
 * Mirrors the paywall2 contract (GET /api/article?url=<encoded>, X-API-Key
 * header, JSON with headline/story/image). The base URL is overridable via
 * MCOP_CPC_API_URL.
 *
 * NEVER call this for main-feed (classic/visual) items.
 */
export async function fetchViaCpc(url: string, timeoutMs = 13000): Promise<PaywallResult | null> {
  const apiKey = process.env.MCOP_CPC_API_KEY;
  if (!apiKey) {
    console.log(`[CPC] MCOP_CPC_API_KEY not set; skipping CPC for ${url}`);
    return null;
  }

  try {
    const encodedUrl = encodeURIComponent(url);
    const response = await fetch(
      `${CPC_API_BASE_URL}/api/article?url=${encodedUrl}`,
      {
        headers: { 'X-API-Key': apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      }
    );

    if (!response.ok) {
      console.log(`[CPC] API returned ${response.status} for ${url}`);
      return null;
    }

    const data = await response.json() as any;

    const result: PaywallResult = {
      headline: data.headline || null,
      story: data.story || null,
      imageUrl: data.image || null,
      author: data.author || null,
      source: data.source || null,
      sourceUrl: data.sourceUrl || null,
      publishedAt: data.publishedAt || null,
    };

    const hasContent = result.headline || result.story || result.imageUrl;
    if (!hasContent) {
      console.log(`[CPC] API returned empty result for ${url}`);
      return null;
    }

    console.log(`[CPC] Recovered content for ${url}: headline=${!!result.headline}, story=${result.story ? result.story.length + ' chars' : 'none'}, image=${!!result.imageUrl}`);
    return result;
  } catch (error) {
    console.error(`[CPC] Error for ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }
}
