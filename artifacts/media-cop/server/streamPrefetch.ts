import { extractArchiveData } from "./scraper";
import { fetchViaPaywallBypass, fetchViaJinaReader, fetchViaJinaHtml, fetchViaCpc } from "./paywallBypass";
import { db } from "./db";
import { headlines, manualSubmissions, curatedItems, xPosts } from "@shared/schema";
import { and, eq, gt, gte, isNull, isNotNull, or, sql, inArray, desc } from "drizzle-orm";
import { ObjectStorageService } from "./objectStorage";
import { openai, isAIConfigured } from "./aiClient";
import { withAiTimeout, AI_CALL_BACKSTOP_MS } from "./aiTimeout";
import { buildOutletIndex, findOutlet, isSocialFlashOutlet } from "@shared/outletRegistry";
import { isPlaceholderImageUrl, isOutletLogoByContent } from "@shared/placeholderImage";
import { getBloombergFeedImage } from "./bloombergFeedIndex";
import { getWsjFeedImage } from "./wsjFeedIndex";
import { getReutersFeedImage } from "./reutersFeedIndex";
import { storage } from "./storage";
import { CURATED_TITLE_TRANSLATE_SOURCES } from "./curatedFeeds";
import { CURATED_ANALYSIS_OPINION_CAP } from "./scoreAdjustments";
import { evaluateAutoHeadline } from "./curatedAutoHeadline";
import { parseTimestampsFromHtmlString, isPlausiblePublishedDate } from "./timestampExtractor";
import {
  isMetaFillerLine,
  deduplicateLines,
  filterExplicitlyAttributedClaims,
} from "./metaFiller";
import { isJunkPageContent } from "./textScraper";
import { stripBriefingPreamble } from "./summarySanitizer";
import { parseTimestampsFromHtml } from "./timestampExtractor";
import { detectTitleLeadingLabel, detectTitleTrailingKicker, detectWHLeadDualSignal } from "../shared/contentKind";
import dns from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";
import * as cheerio from "cheerio";

/**
 * SSRF guard for arbitrary admin-supplied URLs that the server will fetch.
 * Rejects non-http(s) schemes, well-known internal hostnames, and URLs whose
 * DNS resolves to a private/loopback/link-local IP.
 */
export async function isPublicFetchableUrl(urlStr: string): Promise<boolean> {
  let parsed: URL;
  try { parsed = new URL(urlStr); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
      host === 'metadata.google.internal' || host === 'metadata') return false;

  // Resolve and check every returned IP. If DNS fails, refuse.
  let addrs: string[];
  try {
    if (net.isIP(host)) {
      addrs = [host];
    } else {
      const records = await dns.lookup(host, { all: true });
      addrs = records.map(r => r.address);
    }
  } catch {
    return false;
  }
  for (const ip of addrs) {
    if (isPrivateIp(ip)) return false;
  }
  return true;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;       // link-local incl AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                       // multicast/reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;  // ULA
    if (lower.startsWith('fe80')) return true;                          // link-local
    if (lower.startsWith('::ffff:')) {                                  // IPv4-mapped
      return isPrivateIp(lower.slice(7));
    }
    return false;
  }
  return true;
}

/**
 * Transport-level SSRF pin (Task #226 hardening). isPublicFetchableUrl validates
 * a host's DNS *before* the fetch, but undici resolves the host AGAIN for the
 * real socket — a DNS-rebinding window in which the second answer can be a
 * private/metadata IP. This connector performs the resolution INSIDE undici: it
 * rejects when ANY returned address is private and hands undici exactly the
 * addresses it validated, so a safeFetch socket can only reach an approved IP.
 */
const ssrfPinnedLookup = (
  hostname: string,
  options: any,
  cb: (err: Error | null, address?: any, family?: number) => void,
): void => {
  dns.lookup(hostname, { all: true }).then((records) => {
    if (!records.length) { cb(new Error(`SSRF guard: ${hostname} did not resolve`)); return; }
    for (const r of records) {
      if (isPrivateIp(r.address)) {
        cb(new Error(`SSRF guard: ${hostname} resolved to non-public ${r.address}`));
        return;
      }
    }
    if (options && options.all) {
      cb(null, records.map((r) => ({ address: r.address, family: r.family })));
    } else {
      cb(null, records[0].address, records[0].family);
    }
  }).catch((err) => cb(err instanceof Error ? err : new Error(String(err))));
};

// One shared, keep-alive dispatcher for every safeFetch hop. Each socket is
// gated by ssrfPinnedLookup, which closes the validate-then-re-resolve TOCTOU.
const ssrfAgent = new Agent({ connect: { lookup: ssrfPinnedLookup } });

/**
 * SSRF-hardened fetch (Task #226 hardening). Some server-side fetch targets are
 * attacker-influenced — most notably an allowlisted curated user's dead-link
 * REPLACEMENT url, which the enrichment + liveness paths later re-fetch. A
 * write-time host check is NOT enough: DNS can rebind between the check and the
 * fetch, and a 30x redirect can bounce a public URL onto an internal/metadata
 * address. safeFetch re-resolves and validates the host (isPublicFetchableUrl)
 * immediately before EVERY hop, and follows redirects MANUALLY so each Location
 * is validated too. Throws when any hop resolves to a non-public address or the
 * redirect chain is too long; every caller already treats a throw as "fetch
 * failed" (falls back to a bypass / returns null / records 'unknown').
 */
async function safeFetch(urlStr: string, init: RequestInit, maxRedirects = 4): Promise<Response> {
  let current = urlStr;
  for (let hop = 0; ; hop++) {
    if (!(await isPublicFetchableUrl(current))) {
      throw new Error(`SSRF guard blocked non-public target: ${current.slice(0, 120)}`);
    }
    const res = await fetch(current, { ...init, redirect: 'manual', dispatcher: ssrfAgent } as RequestInit & { dispatcher: Agent });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      try { await res.body?.cancel(); } catch { /* body may be null/locked */ }
      if (hop >= maxRedirects) {
        throw new Error(`SSRF guard: too many redirects from ${urlStr.slice(0, 120)}`);
      }
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
}

/**
 * Hostname-based archive detection (Task #226 hardening). The old test
 * (item.url.includes('archive.is')) was substring-based, so an attacker-
 * influenced replacement url such as https://evil.example/?x=archive.is entered
 * the archive branch, where extractArchiveData performs a plain redirect-
 * following fetch on it — an SSRF bypass of safeFetch. Matching on the parsed
 * hostname ensures only genuine public archive services (which fetch the wrapped
 * target from their OWN infra) ever take that path.
 */
function isArchiveHost(urlStr: string): boolean {
  let host: string;
  try { host = new URL(urlStr).hostname.toLowerCase(); } catch { return false; }
  return host === 'archive.is' || host === 'archive.ph' || host === 'archive.today' ||
         host === 'archive.org' || host.endsWith('.archive.org');
}

// Shared mutex for any stream-media work (prefetch OR backfill). Prevents
// overlap, stacking of long backfill runs on the 5-min cron, and races on
// row writes when both might touch the same item.
let streamMediaWorkerStartedAt: number | null = null;
let streamMediaWorkerLabel: string | null = null;
const MAX_PREFETCH_RUN_MS = 5 * 60 * 1000;
const PER_ITEM_TIMEOUT_MS = 60 * 1000;
const OPENAI_TIMEOUT_MS = 20 * 1000;
// Curated lane: short per-provider fast-fail timeout so a stalled provider
// (Jina or CPC) hands off to the next link quickly instead of pinning a row.
// Tightened 13s -> 9s: dead/slow adversary sites (Press TV, Dataminr via Jina)
// were holding the serial enrichment worker for tens of seconds per item.
// A healthy provider still answers well within 9s; failures fall through to the
// next link and are bounded by the existing back-off, so coverage is unaffected.
const CURATED_PROVIDER_TIMEOUT_MS = 9 * 1000;

// CPC ("Copy Paste Connoisseur") is the paid last-resort paywall breaker, run
// only after the free providers (direct fetch, Jina) fail. Cracking a hard
// paywall (Reuters, Bloomberg, WSJ, FT) genuinely takes longer than the 9s
// free-provider fast-fail — at 9s CPC was being aborted mid-extraction, so
// real paywalled outlets came back with no image and no body ("degraded").
// Give CPC its own, longer timeout. 15s is a practical tradeoff, not a hard
// guarantee: a pathological item that runs EVERY upstream provider to its full
// timeout first (direct 5s + 12ft 8s + strengthened 10s + Jina HTML 9s + Jina
// reader 9s, plus Jina 429 retries) can still hit the PER_ITEM_TIMEOUT_MS (60s)
// wrapper — in which case the row simply ends without bullets and stays
// retryable via the media back-off. The Dataminr CPC-skip below removes the
// dominant source of wasted full-timeout calls. Curated lane only.
const CURATED_CPC_TIMEOUT_MS = 15 * 1000;

// The main feed's paywall2 breaker (fetchViaPaywallBypass) cracks hard-blocked
// outlets (Bloomberg/Reuters) reliably, but it genuinely needs ~10–13s to
// extract them. It was previously sharing the 15s CPC fast-fail bound, which
// under production load aborted it mid-extraction — so curated failed on the
// exact URLs the main feed (which gives the same breaker its full 60s default)
// succeeds on. Give the curated paywall2 step its own longer bound: enough to
// cover the real ~13s extraction with headroom under load. Bumped 25s -> 40s
// (Task #644): hard-blocked rows now run through their OWN dedicated
// enrichment passes (immediate post-ingest + priority-first recurring
// prefetch/backfill) instead of competing for a shared top-14/18 slot budget,
// so they can afford a more generous breaker timeout closer to the main feed's
// 60s default. Paired with the longer HARD_BLOCKED_PER_ITEM_TIMEOUT_MS below so
// the whole chain (Jina ~9s + paywall2 40s + CPC 15s) still has headroom to
// finish. Jina stays on the short 9s fast-fail and the main feed caller (no
// timeout arg) keeps its 60s default — both untouched. Curated lane only.
const CURATED_PAYWALL2_TIMEOUT_MS = 40 * 1000;

// Dedicated per-item timeout for hard-blocked curated rows (Task #644). The
// hard-blocked chain (Jina 9s + paywall2 40s + CPC 15s = up to ~64s serial)
// can exceed the shared PER_ITEM_TIMEOUT_MS (60s), so passes that enrich
// hard-blocked rows specifically (the post-ingest fast-path and the
// priority-sorted recurring prefetch/backfill) use this longer wrapper
// instead. General/non-hard-blocked items are unaffected — they keep using
// PER_ITEM_TIMEOUT_MS.
const HARD_BLOCKED_PER_ITEM_TIMEOUT_MS = 75 * 1000;

// Dataminr First Alert items are r.dataminr.com redirect links, not article
// pages — CPC can never extract them, so every CPC call on a Dataminr URL just
// times out and burns paid-call volume + the per-run budget that real paywalled
// outlets (Bloomberg/Reuters) need. Jina already recovers their alert text, so
// skip ONLY the CPC step for these. Curated lane only.
function isDataminrRedirectUrl(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return host === 'dataminr.com' || host.endsWith('.dataminr.com');
  } catch {
    return false;
  }
}

// Bloomberg NON-ARTICLE content (Task #1022): newsletters (/news/newsletters/…)
// and interactive features (/features/…) are not regular article pages. Prod
// evidence (7-day sample): the full doomed chain runs on every attempt and
// fails identically each time — Jina returns the same ~905-char paywall stub
// for every such URL (boilerplate, not story text), paywall2 answers 422, and
// CPC ends "story=none, image=false". The ONLY path that ever recovered one was
// the free Bloomberg RSS feed index (media:content) on the first attempt. So
// these URLs short-circuit: keep the RSS feed-index check (free, in-memory) on
// every attempt plus a SINGLE bounded CPC attempt on the first pass only —
// capability retained, the rest of the doomed chain skipped. Curated lane only.
export function isBloombergNonArticleUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    if (!(host === 'bloomberg.com' || host.endsWith('.bloomberg.com'))) return false;
    const path = u.pathname.toLowerCase();
    return path.startsWith('/news/newsletters/') || path.startsWith('/features/');
  } catch {
    return false;
  }
}

// Hosts where CPC has NEVER recovered an image in production (Task #1022):
// chinaview.cn and kcnawatch.org. 7-day prod sample: 69 curated rows, ZERO
// images recovered, avg ~4.9 attempts/row — every image-seeking CPC call times
// out (15s each) and burns paid volume. Jina/direct fetch already recover their
// story text (rows carry bullets), so the recurring CPC calls are image-only
// waste. Skip CPC for these hosts when the row only needs an image; a row that
// still needs TEXT may call CPC (it does sometimes return story text there) —
// pull capability retained. Curated lane only.
export function isCpcImageDoomedHost(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return (
      host === 'chinaview.cn' || host.endsWith('.chinaview.cn') ||
      host === 'kcnawatch.org' || host.endsWith('.kcnawatch.org')
    );
  } catch {
    return false;
  }
}

/**
 * Pure decision for whether the curated chain may spend a paid CPC call on this
 * item (Task #1022). Single source of truth for every CPC skip rule so the
 * routing is testable without live network (same pattern as
 * deriveHardBlockEnrichmentPlan):
 *  - nothing needed → no call;
 *  - Dataminr redirect links are not article pages — CPC can never crack them;
 *  - Bloomberg newsletters/features get exactly ONE bounded CPC attempt (on the
 *    row's first enrichment attempt); after that only the free RSS feed index
 *    keeps running via the normal retry cap;
 *  - CPC-image-doomed hosts (chinaview/kcnawatch) never get an image-only CPC
 *    call; a genuine text need still may call.
 * Fail-open: any URL not matching a skip rule calls CPC exactly as before.
 */
export type CuratedCpcSkipReason =
  | 'no-need'
  | 'dataminr-redirect'
  | 'bloomberg-non-article-cpc-spent'
  | 'cpc-image-doomed-host';

export function deriveCuratedCpcDecision(
  item: { url: string; mediaAttemptCount?: number | null },
  stillNeedsImage: boolean,
  stillNeedsText: boolean,
): { call: boolean; skipReason: CuratedCpcSkipReason | null } {
  if (!stillNeedsImage && !stillNeedsText) return { call: false, skipReason: 'no-need' };
  if (isDataminrRedirectUrl(item.url)) return { call: false, skipReason: 'dataminr-redirect' };
  if (isBloombergNonArticleUrl(item.url) && (item.mediaAttemptCount ?? 0) > 0) {
    return { call: false, skipReason: 'bloomberg-non-article-cpc-spent' };
  }
  if (isCpcImageDoomedHost(item.url) && !stillNeedsText) {
    return { call: false, skipReason: 'cpc-image-doomed-host' };
  }
  return { call: true, skipReason: null };
}

// Outlets that hard-block our direct + strengthened fetches no matter the
// headers. For these the direct/12ft/strengthened attempts only burn ~23s of the
// per-item budget before failing, so CPC often never runs inside PER_ITEM_TIMEOUT
// and the row sticks on a favicon. The SAME URLs crack reliably via the main
// feed's paywall2 breaker (fetchViaPaywallBypass). For hard-blocked outlets the
// curated chain therefore SKIPS the doomed direct/strengthened fetches and adds
// the proven paywall2 breaker (curated lane only — the main feed path is
// untouched). Keep the set small and evidence-based. Curated lane only.
//  - bloomberg.com: every curated Bloomberg row logs "No HTML from shared fetch"
//    then "Strengthened fetch HTTP 403" (a body-level paywall/bot wall).
//  - reuters.com: returns a host-level 401 bot wall to this datacenter, so the
//    direct/12ft/strengthened fetches always fail and curated Reuters rows never
//    invoke the paywall2 breaker that cracks them — they fall to Jina + CPC only,
//    which frequently return no image. Route Reuters through the same plan.
//  - wsj.com: same class as bloomberg/reuters — the article page is hard-paywalled
//    and direct/12ft/strengthened fetches all 403/redirect to a login wall, so the
//    row runs the doomed chain and exhausts MAX_MEDIA_ATTEMPTS without reaching the
//    paywall2 breaker. Routing through the same hard-blocked plan recovers it.
export function isHardBlockedOutlet(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return (
      host === 'bloomberg.com' || host.endsWith('.bloomberg.com') ||
      host === 'reuters.com' || host.endsWith('.reuters.com') ||
      host === 'wsj.com' || host.endsWith('.wsj.com')
    );
  } catch {
    return false;
  }
}

/**
 * Pure derivation of the hard-blocked enrichment routing for one item. It is the
 * SINGLE source of truth for `isHardBlocked` inside enrichOneItem, so the routing
 * intent is testable without any live network (Task #339 / #549):
 *  - hard-blocked applies to the curated lane ONLY (main feed kind !== 'curated'
 *    is never affected);
 *  - for a hard-blocked curated item the doomed direct / 12ft / strengthened
 *    fetches are SKIPPED (they reliably 403 and only burn the per-item budget);
 *  - the main feed's paywall2 breaker (fetchViaPaywallBypass) runs BEFORE the
 *    paid CPC last resort.
 * Keep enrichOneItem deriving `isHardBlocked` from this helper so a regression
 * that re-enables the dead fetches or drops paywall2 is caught deterministically.
 */
export interface HardBlockEnrichmentPlan {
  isHardBlocked: boolean;
  skipDirectFetch: boolean;
  skip12ftFetch: boolean;
  skipStrengthenedFetch: boolean;
  paywall2BeforeCpc: boolean;
}

export function deriveHardBlockEnrichmentPlan(item: {
  kind?: string;
  url: string;
}): HardBlockEnrichmentPlan {
  const isHardBlocked = item.kind === 'curated' && isHardBlockedOutlet(item.url);
  return {
    isHardBlocked,
    skipDirectFetch: isHardBlocked,
    skip12ftFetch: isHardBlocked,
    skipStrengthenedFetch: isHardBlocked,
    paywall2BeforeCpc: isHardBlocked,
  };
}

// Curated enrichment back-off (Task #132). Adversary outlets (Press TV, China
// Daily, Daily Wire, …) routinely fail bullet generation on paywall-bypass
// timeouts. Before this, a failed row was never stamped, so the prefetch +
// backfill re-attempted the SAME rows every cycle — burning paywall budget and
// keeping coverage low. Now each failed attempt stamps last_media_attempt_at and
// increments media_attempt_count; we skip a row until attemptCount * 30 min has
// elapsed, and stop retrying entirely after MAX_MEDIA_ATTEMPTS.
export const MAX_MEDIA_ATTEMPTS = 6;
const MEDIA_BACKOFF_BASE_MS = 30 * 60 * 1000;
// Postgres interval expression mirroring MEDIA_BACKOFF_BASE_MS for the backfill
// SQL filter. Keep in lock-step with MEDIA_BACKOFF_BASE_MS.
const MEDIA_BACKOFF_BASE_SQL_INTERVAL = `interval '30 minutes'`;

// Publish-date backfill back-off (Task #1088). Same escalating-back-off shape
// as the media back-off above (attemptCount * 30 min, capped), tracked in its
// own pair of columns so the two recovery paths never interfere. Hosts that a
// plain unauthenticated fetch can NEVER recover from — hard-blocked outlets
// plus hosts observed to consistently reject/time out from this infrastructure
// (Global Times WAF, teleSUR, Press TV's .ir origin) — are stamped straight to
// the cap instead of burning one fetch per pass.
export const MAX_PUBDATE_ATTEMPTS = 6;
const PUBDATE_BLOCKED_HOSTS = ['globaltimes.cn', 'telesurenglish.net', 'telesurtv.net', 'presstv.ir'];
function isPubdateBlockedHost(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return PUBDATE_BLOCKED_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Whether a curated row is currently backed off from re-enrichment because its
 * recent attempts failed to recover substantive media. attemptCount of 0 (never
 * failed) is never backed off; >= MAX_MEDIA_ATTEMPTS is permanently backed off.
 */
export function isCuratedMediaBackedOff(
  attemptCount: number | null | undefined,
  lastAttemptAt: Date | null | undefined,
): boolean {
  const count = attemptCount ?? 0;
  if (count <= 0 || !lastAttemptAt) return false;
  if (count >= MAX_MEDIA_ATTEMPTS) return true;
  const elapsed = Date.now() - new Date(lastAttemptAt).getTime();
  return elapsed < count * MEDIA_BACKOFF_BASE_MS;
}

function decodeHtmlEntities(url: string): string {
  return url
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Curated lane (Task #161): realistic browser headers + a longer timeout for a
// strengthened article fetch. The shared lightweight fetch (plain UA, 5s) is
// frequently blocked or times out on bot-sensitive, JS-heavy outlets such as
// Axios and France 24, so curated rows land on a favicon placeholder. These
// headers mimic a real Chrome navigation closely enough to get the article HTML
// (with its og:image / JSON-LD) back. Curated lane ONLY — never the main feed.
const CURATED_DIRECT_FETCH_TIMEOUT_MS = 10 * 1000;
const CURATED_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Unwrap a Google AMP-cache image URL back to its origin URL (Task #161).
 * AMP image proxy form: `https://<pub>.cdn.ampproject.org/i/s/<host>/<path>`
 * maps to `https://<host>/<path>` (`/i/s/` = https origin, `/i/` = http origin).
 * Returns the input unchanged when it is not an AMP-cache image URL.
 */
function unwrapAmpImageUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (!u.hostname.toLowerCase().endsWith('cdn.ampproject.org')) return rawUrl;
    const m = u.pathname.match(/^\/i\/(s\/)?(.+)$/);
    if (!m) return rawUrl;
    const scheme = m[1] ? 'https' : 'http';
    return `${scheme}://${m[2]}${u.search || ''}`;
  } catch {
    return rawUrl;
  }
}

/**
 * Resolve a JSON-LD `image` (or `thumbnailUrl`) value to an absolute http(s)
 * URL. Follows the order: image.url → image.contentUrl → string → first array
 * element → image.thumbnailUrl. (Task #161)
 */
function resolveJsonLdImageValue(image: any): string | null {
  if (!image) return null;
  if (typeof image === 'string') return image.startsWith('http') ? image : null;
  if (Array.isArray(image)) {
    for (const el of image) {
      const r = resolveJsonLdImageValue(el);
      if (r) return r;
    }
    return null;
  }
  if (typeof image === 'object') {
    if (typeof image.url === 'string' && image.url.startsWith('http')) return image.url;
    if (typeof image.contentUrl === 'string' && image.contentUrl.startsWith('http')) return image.contentUrl;
    if (typeof image.thumbnailUrl === 'string' && image.thumbnailUrl.startsWith('http')) return image.thumbnailUrl;
  }
  return null;
}

function collectJsonLdNodes(node: any, out: any[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectJsonLdNodes(n, out);
    return;
  }
  out.push(node);
  if (node['@graph']) collectJsonLdNodes(node['@graph'], out);
}

/**
 * Mine `<script type="application/ld+json">` blocks for an article image
 * (Task #161). Prefers NewsArticle/Article-typed nodes, then falls back to any
 * node that carries an image. Returns null when nothing usable is found.
 */
function extractJsonLdImage(html: string): string | null {
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const nodes: any[] = [];
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try { collectJsonLdNodes(JSON.parse(raw), nodes); } catch { /* skip malformed block */ }
  }
  const isArticle = (t: any) => t === 'NewsArticle' || t === 'Article' ||
    (Array.isArray(t) && t.some((x: any) => x === 'NewsArticle' || x === 'Article'));
  for (const n of nodes) {
    if (isArticle(n['@type'])) {
      const img = resolveJsonLdImageValue(n.image) ?? resolveJsonLdImageValue(n.thumbnailUrl);
      if (img) return img;
    }
  }
  for (const n of nodes) {
    const img = resolveJsonLdImageValue(n.image) ?? resolveJsonLdImageValue(n.thumbnailUrl);
    if (img) return img;
  }
  return null;
}

/**
 * Best-effort article image extraction from raw page HTML for the CURATED lane
 * (Task #161). Reads, in order: og:image, twitter:image, JSON-LD
 * NewsArticle/Article image, then article:image. Decodes HTML entities and
 * unwraps AMP-cache image URLs. Returns null when nothing usable is found.
 */
function extractCuratedImageFromHtml(html: string): string | null {
  let m = html.match(/<meta[^>]*property=["']og:image(?::url)?["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image(?::url)?["']/i);
  if (m?.[1]) return unwrapAmpImageUrl(decodeHtmlEntities(m[1]));

  m = html.match(/<meta[^>]*name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image(?::src)?["']/i)
    || html.match(/<meta[^>]*property=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']twitter:image(?::src)?["']/i);
  if (m?.[1]) return unwrapAmpImageUrl(decodeHtmlEntities(m[1]));

  const jsonLd = extractJsonLdImage(html);
  if (jsonLd) return unwrapAmpImageUrl(decodeHtmlEntities(jsonLd));

  m = html.match(/<meta[^>]*property=["']article:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']article:image["']/i);
  if (m?.[1]) return unwrapAmpImageUrl(decodeHtmlEntities(m[1]));

  return null;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function isAllowedImageUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' ||
        host === '::1' || host === '[::1]' || host.endsWith('.local') ||
        host.startsWith('10.') || host.startsWith('192.168.') ||
        host.startsWith('169.254.') || host.startsWith('172.') ||
        host === 'metadata.google.internal') return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Given a web.archive.org (wayback) snapshot URL, return the ORIGINAL resource
 * URL it wraps, or null if it isn't a wayback URL / can't be parsed. Wayback
 * image URLs look like
 *   https://web.archive.org/web/<timestamp>[<modifier>_]/<originalUrl>
 * where <modifier> is e.g. `im` (raw image, `im_`). We prefer re-hosting the
 * wrapped original CDN image because the snapshot itself is fragile — it depends
 * on archive.org staying up/fast and a specific `…im_/…` snapshot can 404 later
 * — whereas the underlying CDN URL (images.wsj.net, static01.nyt.com, …) is
 * durable and is usually served without a paywall.
 */
export function extractArchiveOriginalUrl(urlStr: string): string | null {
  let host: string;
  try { host = new URL(urlStr).hostname.toLowerCase(); } catch { return null; }
  if (host !== 'web.archive.org' && !host.endsWith('.archive.org')) return null;
  const m = urlStr.match(/\/web\/[^/]+\/(https?:\/\/.+)$/i);
  return m ? m[1] : null;
}

/**
 * Fetch a single remote image URL through the SSRF-hardened path and upload it
 * to object storage, returning the `/objects/…` path or null on any failure /
 * non-image / oversized payload. Split out of persistImageToStorage so the
 * latter can try more than one candidate (archive original, then snapshot).
 */
async function fetchAndPersistImage(imageUrl: string): Promise<string | null> {
  if (isPlaceholderImageUrl(imageUrl)) return null;
  if (!isAllowedImageUrl(imageUrl) || !(await isPublicFetchableUrl(imageUrl))) {
    console.log(`[StreamPrefetch] Blocked disallowed image URL: ${imageUrl.substring(0, 80)}`);
    return null;
  }

  const response = await safeFetch(imageUrl, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  });
  if (!response.ok) return null;

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) return null;

  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_IMAGE_BYTES) return null;

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length < 1000 || buffer.length > MAX_IMAGE_BYTES) return null;

  // Content-based outlet brand-logo detector (Task #761). Some outlets (e.g.
  // The Straits Times) serve both their brand logo and real article photos from
  // the same opaque CDN URL shape — URL-pattern detection is impossible. Detect
  // the logo by file size: the ST "ST" masthead logo is ~6 KB; real article
  // photos from the same CDN are 50 KB+. Returns null (same as a favicon) so
  // the row stays retryable until ST attaches a real photo. Curated lane and
  // main feed both benefit; this call is cheap (no extra network request).
  if (isOutletLogoByContent(buffer, imageUrl)) {
    console.log(`[StreamPrefetch] Rejected outlet brand logo by content (${buffer.length} bytes): ${imageUrl.substring(0, 80)}`);
    return null;
  }

  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : contentType.includes('gif') ? 'gif' : 'jpg';
  const filename = `auto-${Date.now()}.${ext}`;

  const storageService = new ObjectStorageService();
  const objectPath = await storageService.uploadStreamImage(buffer, filename, contentType);
  console.log(`[StreamPrefetch] Persisted image to storage: ${objectPath} (${buffer.length} bytes)`);
  return objectPath;
}

export async function persistImageToStorage(imageUrl: string): Promise<string | null> {
  try {
    if (isPlaceholderImageUrl(imageUrl)) {
      return null;
    }
    if (imageUrl.startsWith('/objects/')) {
      return imageUrl;
    }

    // web.archive.org snapshot images (e.g. WSJ cracked via the paywall2 branch)
    // must be re-hosted locally so the card never depends on archive.org staying
    // up/fast. Try the UNDERLYING original CDN image first (durable, usually not
    // paywalled), then fall back to the archive snapshot itself. Whichever lands
    // an object-storage path first wins. For non-archive URLs this is just the
    // single URL.
    const candidates: string[] = [];
    const original = extractArchiveOriginalUrl(imageUrl);
    if (original) candidates.push(original);
    candidates.push(imageUrl);

    for (const candidate of candidates) {
      const objectPath = await fetchAndPersistImage(candidate);
      if (objectPath) return objectPath;
    }
    return null;
  } catch (e: any) {
    console.log(`[StreamPrefetch] Image persist failed: ${e?.message || e}`);
    return null;
  }
}

/**
 * Fetch a remote image through the SSRF-hardened path and return it as a
 * base64 `data:` URL (Task #424). Vision OCR providers (OpenRouter primary and
 * the Anthropic fallback) reject a remote image URL ("URL sources are not
 * supported"), so the image bytes must be inlined. Reuses the same SSRF guards
 * (isAllowedImageUrl + isPublicFetchableUrl + safeFetch transport pin) the
 * stream media pre-fetch uses — never a bare outbound fetch of a remote URL.
 * Returns null (caller skips gracefully) on any failure, non-image content, or
 * an oversized payload.
 */
export async function fetchImageAsDataUrl(imageUrl: string): Promise<string | null> {
  try {
    if (imageUrl.startsWith('data:')) {
      return imageUrl;
    }
    if (!isAllowedImageUrl(imageUrl) || !(await isPublicFetchableUrl(imageUrl))) {
      return null;
    }

    const response = await safeFetch(imageUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    if (!response.ok) return null;

    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) return null;

    const declaredLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (declaredLength > MAX_IMAGE_BYTES) return null;

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length < 100 || buffer.length > MAX_IMAGE_BYTES) return null;

    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

interface EnrichableItem {
  id: string;
  url: string;
  title: string;
  ogImageUrl?: string | null;
  videoUrl?: string | null;
  summaryBullets?: string[] | null;
  mediaScrapedAt?: Date | null;
  manuallyEdited?: boolean | null;
  // Curated-lane enrichment back-off state (Task #132). Used only when
  // kind === 'curated' to skip rows whose recent attempts failed.
  mediaAttemptCount?: number | null;
  lastMediaAttemptAt?: Date | null;
  // Which store this row lives in. 'main' (default) → headlines/manual_submissions
  // via cacheHeadlineMedia; 'curated' → the isolated curated_items store via
  // cacheCuratedItemMedia. Curated writes NEVER touch the main feed (fail-closed).
  kind?: 'main' | 'curated';
  // The row's raw outlet source string, used by the curated batch to resolve the
  // outlet via the registry and flag social posts.
  source?: string | null;
  // Resolved once per curated batch (Task #354). Social posts (X / Truth Social /
  // DataMinr) show the post itself — enrichment skips the forced 3-bullet summary
  // and attributed-claims generation for them and just keeps any real image.
  isSocial?: boolean;
}

// Recognizes any image URL that is NOT a real article photo: favicons, brand
// logos, AND outlet generic "default / share" placeholders (e.g. ABC's
// abc_news_default_*). Delegates to the single shared detector so the curated
// gate, carry-over, seeding gate, and main-feed image resolution all agree on
// what counts as a placeholder. (Name kept for back-compat across many callers.)
export function isFaviconUrl(u: string | null | undefined): boolean {
  return isPlaceholderImageUrl(u);
}

/**
 * Curated-lane content-kind detection (podcast/audio). Audio stories cannot be
 * told apart from text articles by URL (NPR audio URLs are byte-identical in
 * shape to text URLs), so we sniff the already-fetched page HTML. Conservative,
 * low-false-positive signals only:
 *   - a generic Open Graph audio object (<meta property="og:audio" ...>), or
 *   - NPR's audio fingerprint: an ondemand.npr.org .mp3 PLUS an "audioUrl" field
 *     in the embedded page JSON (a pure text NPR story has neither). Scoped to
 *     npr.org hosts so an unrelated mp3 mention elsewhere can never trip it.
 * Returns 'audio' / 'article' when HTML was available, or null when it wasn't
 * (so the caller leaves the stored flag untouched rather than guessing).
 */
export function detectPageContentKind(html: string | null, url: string): 'audio' | 'article' | 'opinion' | 'explainer' | null {
  if (!html) return null;
  if (/<meta[^>]*property=["']og:audio["']/i.test(html)) return 'audio';
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* not a fully-qualified URL */ }
  const isNpr = host === 'npr.org' || host.endsWith('.npr.org');
  if (isNpr) {
    const lower = html.toLowerCase();
    if (lower.includes('ondemand.npr.org') && lower.includes('.mp3') && lower.includes('audiourl')) {
      return 'audio';
    }
    // Freshly-posted broadcast segments don't have the .mp3 posted yet — the
    // page instead carries the "HEARD ON <program>" broadcast marker and/or
    // an "Audio will be available later today" pending placeholder. Both are
    // NPR-scoped, high-precision signals of a radio/podcast segment (not a
    // plain text article), so demote to attach-only the same as published
    // audio. Keep this conservative: only these two specific phrasings, only
    // on npr.org, so a plain text NPR article never trips it.
    // Anchor the program name to the "heard on" phrase (allowing a short run of
    // intervening markup, e.g. `Heard on <a href="...">Morning Edition</a>`) so a
    // program name that appears incidentally elsewhere on the page can't trip it.
    // The old form matched the program token ANYWHERE on the page, and "1a" in
    // particular substring-matched hex ids / asset hashes present in virtually any
    // HTML — which degenerated the whole check to "/heard on/ appears somewhere".
    const hasHeardOnMarker =
      /heard on[\s\S]{0,60}?(?:morning edition|all things considered|weekend edition|fresh air|here\s*(?:&(?:amp;)?)\s*now|up first|1a\b)/i.test(
        lower,
      );
    const hasAudioPendingMarker = lower.includes('audio will be available later today');
    if (hasHeardOnMarker || hasAudioPendingMarker) {
      return 'audio';
    }
  }
  const nonNewsKind = detectPageNonNewsKind(html, url);
  if (nonNewsKind) return nonNewsKind;
  return 'article';
}

// Section labels that JSON-LD `articleSection` / og:article:section can carry
// to identify an ANALYSIS/OPINION piece. Lowercased comparison.
const OPINION_ANALYSIS_SECTION_LABELS = new Set(['opinion', 'analysis', 'commentary', 'editorial']);
// Section labels that identify an EXPLAINER piece (schema.org vocabulary).
const EXPLAINER_SECTION_LABELS = new Set(['explainer', 'explainers']);

// JSON-LD @type values that explicitly mark an opinion/analysis article.
const OPINION_ANALYSIS_JSONLD_TYPES = new Set(['analysisnewsarticle', 'opinionnewsarticle']);
// JSON-LD @type values that explicitly mark an explainer article.
// BackgroundNewsArticle is the schema.org type for explanatory/context pieces.
const EXPLAINER_JSONLD_TYPES = new Set(['backgroundnewsarticle']);

// A standalone element whose ENTIRE trimmed text is one of these words is a
// page-rendered "kicker" label (e.g. Al Jazeera's <span>Analysis</span> above
// a headline) — never matched against a substring of a longer sentence.
const OPINION_ANALYSIS_KICKER_WORDS = new Set(['analysis', 'opinion', 'commentary', 'editorial']);
// Kicker words that mark an explainer.
const EXPLAINER_KICKER_WORDS = new Set(['explainer']);

/**
 * Task #650 / Task #854 — page-labeled non-news kind detection for trusted
 * outlets whose analysis/opinion/explainer pieces don't carry a telltale URL
 * segment (e.g. Al Jazeera publishes "Analysis" pieces under /features/).
 * Reuses the page HTML already fetched during normal enrichment — zero extra
 * network calls. Deliberately high-precision / structured signals ONLY:
 *   1. JSON-LD `@type`: AnalysisNewsArticle / OpinionNewsArticle → opinion;
 *      BackgroundNewsArticle → explainer.
 *   2. A section meta tag (article:section / og:article:section /
 *      JSON-LD articleSection) whose value is opinion/analysis/commentary/
 *      editorial → opinion; explainer/explainers → explainer.
 *   3. A short standalone HTML element (kicker) whose ENTIRE trimmed text is
 *      exactly one of analysis/opinion/commentary/editorial → opinion; or
 *      "explainer" → explainer. (cheerio; whole-element text, never a
 *      substring of a longer sentence, so a headline like "In-depth analysis
 *      of the ceasefire" never trips it.)
 *   4. CNN-style "Analysis by <Name>" kicker-byline: a leaf element whose
 *      entire trimmed text matches "Analysis by <non-space>…" — the exact
 *      pattern CNN uses for its analysis byline kicker. Host-scoped so a
 *      real news outlet's "Analysis by our team" standalone label on an
 *      unrelated page never trips it. Always maps to opinion.
 * A "?" in the headline or any other weak/ambiguous signal is intentionally
 * NOT used — false positives here misroute a real report into the attach-only
 * area, which is worse than missing an occasional analysis piece.
 *
 * Returns 'opinion', 'explainer', or null (not a detected non-news kind).
 */
export function detectPageNonNewsKind(html: string | null, url?: string): 'opinion' | 'explainer' | null {
  if (!html) return null;

  let host = '';
  try { host = url ? new URL(url).hostname.toLowerCase() : ''; } catch { /* ignore */ }

  // Signal 1 + section-label-in-JSON-LD: scan every JSON-LD block.
  const jsonLdBlocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    let parsed: any;
    try {
      parsed = JSON.parse(inner);
    } catch {
      continue;
    }
    const nodes: any[] = [];
    const collect = (v: any) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(collect); return; }
      nodes.push(v);
      if (Array.isArray(v['@graph'])) v['@graph'].forEach(collect);
    };
    collect(parsed);
    for (const node of nodes) {
      const type = node['@type'];
      const types: string[] = Array.isArray(type) ? type : (type ? [type] : []);
      if (types.some(t => typeof t === 'string' && EXPLAINER_JSONLD_TYPES.has(t.toLowerCase()))) {
        return 'explainer';
      }
      if (types.some(t => typeof t === 'string' && OPINION_ANALYSIS_JSONLD_TYPES.has(t.toLowerCase()))) {
        return 'opinion';
      }
      const section = node.articleSection;
      const sections: string[] = Array.isArray(section) ? section : (section ? [section] : []);
      for (const s of sections) {
        if (typeof s !== 'string') continue;
        const sl = s.trim().toLowerCase();
        if (EXPLAINER_SECTION_LABELS.has(sl)) return 'explainer';
        if (OPINION_ANALYSIS_SECTION_LABELS.has(sl)) return 'opinion';
      }
    }
  }

  // Signal 2: meta-tag section labels outside JSON-LD.
  const checkMetaSection = (val: string): 'opinion' | 'explainer' | null => {
    const v = val.trim().toLowerCase();
    if (EXPLAINER_SECTION_LABELS.has(v)) return 'explainer';
    if (OPINION_ANALYSIS_SECTION_LABELS.has(v)) return 'opinion';
    return null;
  };
  const metaMatches = html.matchAll(/<meta[^>]*(?:property|name)=["'](?:article:section|og:article:section)["'][^>]*content=["']([^"']+)["']/gi);
  for (const m of metaMatches) {
    const r = checkMetaSection(m[1]);
    if (r) return r;
  }
  const metaMatchesReversed = html.matchAll(/<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:article:section|og:article:section)["']/gi);
  for (const m of metaMatchesReversed) {
    const r = checkMetaSection(m[1]);
    if (r) return r;
  }

  // Signal 3 + 4: standalone kicker elements (short tag, exact whole-text
  // match). Scoped to article-header context ONLY — never the raw DOM. A
  // generic nav link like <a>Opinion</a> in a header/footer/sidebar section
  // link list is NOT a kicker and must never trip this; kickers are
  // non-interactive labels (span/div/p/h1-h4) placed directly above a
  // headline, never <a> tags, and never inside nav/header/footer/aside or
  // nav-styled containers.
  // Signal 4 extends this to CNN-style "Analysis by <Name>" byline kickers
  // (a leaf element whose entire text matches "Analysis by <non-space>…").
  const isCnn = /(?:^|\.)cnn\.com$/.test(host);
  try {
    const $ = cheerio.load(html);
    let found: 'opinion' | 'explainer' | null = null;
    const isOutsideArticleContext = (el: any): boolean => {
      let node = $(el);
      while (node.length > 0) {
        const tag = (node.prop('tagName') || '').toLowerCase();
        if (tag === 'nav' || tag === 'header' || tag === 'footer' || tag === 'aside') return true;
        const attrs = `${node.attr('class') || ''} ${node.attr('id') || ''}`.toLowerCase();
        if (/nav|menu|breadcrumb|toolbar|masthead|sidebar|footer/.test(attrs)) return true;
        node = node.parent();
      }
      return false;
    };
    $('span, div, p, h1, h2, h3, h4').each((_, el) => {
      if (found) return;
      const $el = $(el);
      if ($el.children().length > 0) return; // only leaf elements — a whole sentence wrapper never matches
      const text = $el.text().trim();
      const lower = text.toLowerCase();
      if ($el.closest('a').length > 0) return; // never a link (rules out nav/section links entirely)
      if (isOutsideArticleContext(el)) return;
      if (EXPLAINER_KICKER_WORDS.has(lower)) { found = 'explainer'; return; }
      if (OPINION_ANALYSIS_KICKER_WORDS.has(lower)) { found = 'opinion'; return; }
      // Signal 4: CNN "Analysis by <Name>" kicker-byline. The pattern is a
      // standalone byline kicker like "Analysis by Brett H. McGurk" — the
      // entire leaf text starts with "Analysis by " and is followed by at
      // least one non-space character (the author's name). Scoped to cnn.com
      // so this narrow byline pattern can't mis-fire on other outlets.
      if (isCnn && /^analysis by \S/i.test(text)) { found = 'opinion'; return; }
    });
    if (found) return found;
  } catch {
    // Malformed HTML — fall through to null rather than risk a false positive.
  }

  return null;
}

/**
 * Backward-compatible boolean wrapper: returns true if the page carries any
 * structured opinion/analysis or explainer signal. Used by existing callers
 * and tests that only care about "is this non-news content?" without needing
 * the specific sub-kind. New callers should use detectPageNonNewsKind directly.
 */
export function detectPageOpinionAnalysis(html: string | null): boolean {
  return detectPageNonNewsKind(html) !== null;
}

/**
 * Detect an AI refusal / meta reply (Task #354). When the summarizer is handed
 * too little usable text (a short social post, a blocked/empty article body) it
 * sometimes answers with a refusal or a "please provide the article" meta reply
 * instead of bullets — e.g. "I cannot generate the requested analysis because the
 * provided source material does not contain…" or "To complete this task, please
 * provide the full article text". That text must NEVER be stored as a bullet or
 * an attributed claim; it should be discarded so the row stays empty (and, for
 * article rows, retryable under the existing back-off). Real 15-25 word bullets
 * about news rarely match these patterns (they key on first-person AI refusals
 * and explicit "no source text" meta language), so false positives are minimal.
 */
export function isAIRefusalText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  if (t.length === 0) return false;
  const patterns: RegExp[] = [
    /\bi\s+(?:cannot|can'?t|can\s?not|am\s+unable\s+to|am\s+not\s+able\s+to|won'?t|will\s+not)\b/,
    // NB: `provide` is deliberately NOT in this verb list — a bare "cannot
    // provide" (e.g. "the Pentagon said it cannot provide details") is common,
    // legitimate news. A first-person "I cannot provide" is still caught above.
    /\b(?:cannot|can'?t|unable\s+to)\s+(?:generate|create|produce|complete|summari[sz]e|analy[sz]e|fulfil{1,2}|comply|assist)\b/,
    /\bas\s+an\s+ai\b/,
    /\bi('?m|\s+am)\s+(?:sorry|unable|an\s+ai)\b/,
    /\b(?:the\s+)?(?:provided|given|supplied|source)\s+(?:source\s+)?(?:material|article(?:\s+text)?|text|content)\s+(?:does\s+not|doesn'?t|did\s+not|didn'?t)\s+(?:contain|include|provide|have)\b/,
    /\b(?:please|kindly)\s+(?:provide|share|supply|paste)\b[^.]*\b(?:article|source|text|content|material|url|link)\b/,
    /\b(?:provide|share|supply|paste)\s+(?:the\s+)?(?:full\s+)?(?:article(?:\s+text)?|source\s+material|legitimate\s+(?:news\s+)?source)\b/,
    /\bno\s+(?:article|source|usable)\s+(?:text|material|content|information)\b/,
    // "insufficient/no/not-enough X" only counts as a refusal when X is the
    // SOURCE MATERIAL itself, or when it's followed by an AI-task verb (produce
    // a summary / generate analysis). Bare "insufficient information to confirm
    // [a news fact]" is legitimate reporting and must NOT be flagged.
    /\b(?:no|not\s+enough|insufficient)\s+(?:usable\s+)?(?:source\s+material|article\s+text)\b/,
    /\b(?:no|not\s+enough|insufficient)\s+(?:information|content|text|context|source\s+material)\s+to\s+(?:produce|generate|create|write|summari[sz]e|complete|fulfil{1,2})\b/,
    /\bto\s+complete\s+this\s+task\b/,
    // First-person "I would need / I'd need the (actual) article text" — the AI
    // asking for the source material in order to do the task (e.g. "To generate
    // the three bullet points you've requested, I would need the actual article
    // text"). Anchored tightly: first-person subject + a modal + need/require +
    // a SOURCE-MATERIAL object that is either a two-word "article/source text"
    // phrase or bare "text/content". Bare "material", "source", "article" are
    // deliberately EXCLUDED so real quotes like "I will need material support"
    // or "I would need Article 5 assurances" / "source protection" never trip
    // it; "I would need to verify…" (no source-material object) is also safe.
    // Handles straight and curly apostrophes in "I'd"/"I'll".
    /\bi(?:['’]d|['’]ll|\s+(?:would|will|['’]?d|['’]?ll))\s+(?:need|require)\s+(?:the\s+|an?\s+)?(?:actual\s+|full\s+|original\s+|complete\s+|real\s+)?(?:(?:article|source)\s+(?:text|content|material)|text|content)\b/,
  ];
  return patterns.some((re) => re.test(t));
}

/**
 * Generate exactly 3 concise summary bullets from article text using GPT-4o-mini.
 * Shared by the stream-media enrichment path and the article-preview endpoint.
 * Returns [] when there is insufficient text, no API key, or the call fails.
 */
export function buildSummaryBulletsSystemPrompt(
  today: string,
  mode: 'default' | 'curated-evidence' = 'default',
): string {
  const shared = `You are a military intelligence analyst. Today's date is ${today}. The article text provided is the SOLE authority for every person's current title and office — refer to each person using EXACTLY the name and title the article uses; NEVER add status qualifiers (former, ex-, then-, late, incumbent, current) from background knowledge. If the article calls someone "President X", write "President X". Generate up to 3 concise bullet points summarizing this article. Each bullet must be 15 words or fewer.`;
  const ending = `If the excerpt does not support 3 substantive bullets, return fewer — do NOT pad. NEVER add a bullet about what the article does not provide, specify, or mention. NEVER restate the same proposition in different wording across bullets. NEVER split a multi-subject sentence into several bullets. If the article is a placeholder, stub, or does not contain substantive news content, return NOTHING AT ALL. Every bullet must state distinct news content. Always spell out publication, outlet, and organization names in full. Return only the bullets, one per line, without bullet markers.`;

  if (mode === 'curated-evidence') {
    return `${shared} Lead with concrete, source-supported news: observable events or actions, measurements or quantities, locations, timing, and scope. Bullets state what happened, not what a participant or unnamed source says it means. An announcement, commitment, intention, policy position, denial, stated cause or motive, forecast, prediction, concern, readiness assessment, estimate attributed to sources, or subjective characterization is NOT a generic fact; leave its substantive assertion for the separate attributed-claims section. For example, do NOT write "The U.S. has depleted nearly all long-range missiles" when that quantity comes from unnamed officials, and do NOT write "The depletion raises concerns about readiness"; those belong in claims with the officials, analysts, or reporting source explicitly named. You may state the observable act that someone spoke, announced, or denied something only when that act itself is the news, without presenting the assertion's content as settled truth. Avoid vague background/context filler and unsupported generalization. ${ending}`;
  }

  return `${shared} Bullet 1: What is the big change or announcement in this story. Bullet 2: What is the background context. Bullet 3: Any supplemental information. ${ending}`;
}

export async function generateSummaryBullets(
  title: string | null | undefined,
  articleText: string,
  meta?: { refused?: boolean },
  options?: { mode?: 'default' | 'curated-evidence' },
): Promise<string[]> {
  if (!(articleText.length > 200 && isAIConfigured() && title)) return [];
  // Skip enrichment for junk/stub pages — they produce only meta-filler output.
  // Returning [] keeps the row retryable under the normal back-off machinery.
  if (isJunkPageContent(articleText)) {
    console.log(`[StreamPrefetch] Skipping summary bullets for junk/stub page content (title: "${title.substring(0, 50)}")`);
    return [];
  }
  try {
    const completion = await withAiTimeout(openai.chat.completions.create(
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: buildSummaryBulletsSystemPrompt(
              new Date().toISOString().slice(0, 10),
              options?.mode ?? 'default',
            ),
          },
          { role: 'user', content: `Headline: ${title}\n\nArticle excerpt: ${articleText}` },
        ],
        max_tokens: 200,
        temperature: 0.3,
      },
      { signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS), timeout: OPENAI_TIMEOUT_MS, maxRetries: 0 }
    ), AI_CALL_BACKSTOP_MS, 'streamPrefetch:summaryBullets', { trackStorm: false });
    const responseText = completion.choices[0]?.message?.content || '';
    // Discard AI refusal / meta replies wholesale (Task #354) — never store them
    // as bullets. Flag the refusal so the caller keeps the row retryable (empty
    // bullets here are a transient refusal, NOT a finished "no summary" state).
    if (isAIRefusalText(responseText)) {
      console.warn(`[StreamPrefetch] Discarded AI refusal/meta summary reply for "${title.substring(0, 50)}"`);
      if (meta) meta.refused = true;
      return [];
    }
    // Keep at most 3 bullets, but do NOT hard-slice each line to a fixed word
    // count — that silently chopped complete sentences mid-word in the detail
    // view (e.g. "…increasing collision risks for"). The prompt already asks the
    // model to be concise (~15 words) and max_tokens bounds the total, so the
    // model's own complete sentences are what we store and render.
    // Meta-filler padding ("The article does not provide further details…") is
    // dropped PER LINE — the surviving real bullets are kept and the row stays
    // enriched (unlike a refusal, which clears the reply wholesale + retries).
    // Near-duplicate deduplication removes same-assertion rewordings and
    // same-predicate subject-splits AFTER filler filtering.
    // Stale-status sanitization runs after filtering — strips AI-injected
    // "Former/Ex-" descriptors absent from the source material.
    const filtered = responseText.split('\n').map(l => l.replace(/^[-•*\d.)\s]+/, '').trim()).filter(l => l.length > 0 && !isAIRefusalText(l) && !isMetaFillerLine(l));
    const rawBullets = deduplicateLines(filtered).slice(0, 3);
    const { groundGeneratedLinesInSources } = await import('./staleStatusSanitizer');
    const srcTexts = [title, articleText];
    return groundGeneratedLinesInSources(rawBullets, srcTexts);
  } catch (e: any) {
    console.error(`[StreamPrefetch] AI summary error for "${title.substring(0, 50)}":`, e?.message || e);
    return [];
  }
}

/**
 * Per-article angle/framing characterization for standalone single-source curated items
 * (Task #937). Produces ONE sentence describing how THIS source frames the story —
 * what it emphasizes, minimizes, or implies — derived ONLY from the article's own text.
 * No background knowledge, no outlet reputation. Returns null when no discernible angle
 * exists (neutral/straight-news), for junk pages, or on AI failure.
 * Follows the same social-post skip, refusal, and meta-filler discipline as bullets/claims.
 */
export async function generateSourceSpin(title: string | null | undefined, articleText: string): Promise<string | null> {
  if (!(articleText.length > 200 && isAIConfigured() && title)) return null;
  if (isJunkPageContent(articleText)) {
    return null;
  }
  try {
    const completion = await withAiTimeout(openai.chat.completions.create(
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a military intelligence analyst. Write EXACTLY one sentence (15–35 words) characterizing how THIS specific source frames or angles the story — what it emphasizes, minimizes, implies, or selectively attributes that could shape the reader's interpretation. Use ONLY what the article itself says; do NOT draw on background knowledge or outlet reputation. Mirror all person names and official titles exactly as the article uses them. If the framing is neutral straight-news reporting with no discernible angle, output NOTHING AT ALL — not a single word or punctuation mark. Do NOT start with "The article" or "This article". Output only the single characterization sentence, nothing else.`,
          },
          { role: 'user', content: `Headline: ${title}\n\nArticle excerpt: ${articleText}` },
        ],
        max_tokens: 80,
        temperature: 0.3,
      },
      { signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS), timeout: OPENAI_TIMEOUT_MS, maxRetries: 0 }
    ), AI_CALL_BACKSTOP_MS, 'streamPrefetch:sourceSpin', { trackStorm: false });
    const responseText = (completion.choices[0]?.message?.content || '').trim();
    if (!responseText || isAIRefusalText(responseText) || isMetaFillerLine(responseText)) return null;
    const cleaned = (stripBriefingPreamble(responseText) || '').trim();
    if (!cleaned || cleaned.length <= 10) return null;
    const { groundGeneratedTextInSources } = await import('./staleStatusSanitizer');
    const sanitized = groundGeneratedTextInSources(cleaned, [title, articleText.slice(0, 2000)]);
    return sanitized && sanitized.length > 10 ? sanitized : null;
  } catch (e: any) {
    console.error(`[StreamPrefetch] Source spin error for "${title?.substring(0, 50)}":`, e?.message || e);
    return null;
  }
}

/**
 * Attributed claims / key statements (Task #256). Distinct from generateSummaryBullets:
 * instead of a generic what-changed/background/extra summary, this pulls the specific
 * ATTRIBUTED claims and on-the-record statements from the article body, each kept with
 * its source attribution (e.g. "Israeli security sources were cited saying…",
 * "The Pentagon said…"). Returns 0-3 claims; an empty array is normal (many articles
 * have no clearly attributed claims worth surfacing). Additive — never replaces bullets.
 */
export function buildAttributedClaimsSystemPrompt(today: string): string {
  return `You are a military intelligence analyst extracting ATTRIBUTED claims and key on-the-record statements from a news article. Today's date is ${today}. The article text provided is the SOLE authority for every person's current title and office — refer to each person using EXACTLY the name and title the article uses; NEVER add status qualifiers (former, ex-, then-, late, incumbent, current) from background knowledge. If the article calls someone "President X", write "President X". Output ONLY decision-relevant announcements, commitments, intentions, policy positions, denials, stated causes or motives, forecasts, predictions, causal explanations, concerns, readiness assessments, source-based estimates, and subjective characterizations that the article explicitly attributes to a named or described source. EVERY LINE MUST BE SELF-CONTAINED AND VISIBLY ATTRIBUTED: name the underlying speaker, agency, document, or unnamed-source class and use a clear attribution verb such as "said", "reported", "estimated", "assessed", "warned", "claimed", or "according to". Prefer direct constructions such as "Three U.S. officials told Reuters that..." or "Pentagon analysts warned that...". NEVER output a bare assertion such as "The U.S. has depleted nearly all long-range missiles" or "The depletion raises concerns about readiness"; the claim-section label is not a substitute for attribution inside the sentence. PRESERVE the MOST SPECIFIC attribution the article actually provides: if the article names a person, use that person's full name plus title/affiliation when given. Only fall back to a generic descriptor ("an expert said", "officials said") or "sources said" when the article genuinely does not name the source. Never downgrade a named source to a vague descriptor. Attribute a claim to the publication only when the publication itself originated the reporting, investigation, analysis, or editorial judgment — never when it merely carries another actor's words. Claims must add information beyond the concrete event/measurement/location/scope bullets; do not repeat a bullet merely with "said" attached. Each line must be 25 words or fewer. Do NOT include generic background or your own analysis. Spell out outlet and organization names in full. Return at most 3 lines, one claim per line, without bullet markers or numbering. If the article contains NO clearly attributed claims, output NOTHING AT ALL. NEVER announce the absence of claims or describe the provided source text itself. An empty response IS the correct output when there are no claims.`;
}

export async function generateAttributedClaims(title: string | null | undefined, articleText: string, meta?: { refused?: boolean }): Promise<string[]> {
  if (!(articleText.length > 200 && isAIConfigured() && title)) return [];
  // Skip enrichment for junk/stub pages — they produce only meta-filler output.
  if (isJunkPageContent(articleText)) {
    console.log(`[StreamPrefetch] Skipping attributed claims for junk/stub page content (title: "${title.substring(0, 50)}")`);
    return [];
  }
  try {
    const completion = await withAiTimeout(openai.chat.completions.create(
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: buildAttributedClaimsSystemPrompt(new Date().toISOString().slice(0, 10)) },
          { role: 'user', content: `Headline: ${title}\n\nArticle excerpt: ${articleText}` },
        ],
        max_tokens: 220,
        temperature: 0.2,
      },
      { signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS), timeout: OPENAI_TIMEOUT_MS, maxRetries: 0 }
    ), AI_CALL_BACKSTOP_MS, 'streamPrefetch:attributedClaims', { trackStorm: false });
    const responseText = completion.choices[0]?.message?.content || '';
    // Discard AI refusal / meta replies wholesale (Task #354) — never store them
    // as attributed claims. Flag the refusal so the caller keeps the row retryable.
    if (isAIRefusalText(responseText)) {
      console.warn(`[StreamPrefetch] Discarded AI refusal/meta attributed-claims reply for "${title.substring(0, 50)}"`);
      if (meta) meta.refused = true;
      return [];
    }
    // Cap at 3 claims but never hard-slice a claim to a fixed word count — that
    // truncated attributed statements mid-sentence in the detail view. The prompt
    // already constrains each claim (~25 words) and max_tokens bounds the reply.
    // Near-duplicate deduplication removes same-assertion rewordings and
    // same-predicate subject-splits AFTER filler filtering.
    // Stale-status sanitization strips AI-injected descriptors absent from source.
    const filtered = responseText
      .split('\n')
      .map(l => l.replace(/^[-•*\d.)\s]+/, '').trim())
      .filter(l => l.length > 0 && !isAIRefusalText(l) && !isMetaFillerLine(l));
    const rawClaims = deduplicateLines(filterExplicitlyAttributedClaims(filtered)).slice(0, 3);
    const { groundGeneratedLinesInSources } = await import('./staleStatusSanitizer');
    return filterExplicitlyAttributedClaims(
      groundGeneratedLinesInSources(rawClaims, [title, articleText]),
    );
  } catch (e: any) {
    console.error(`[StreamPrefetch] AI attributed-claims error for "${title.substring(0, 50)}":`, e?.message || e);
    return [];
  }
}

/**
 * Generate a 1-2 sentence news summary from recovered article text.
 *
 * Used to upgrade bot-posted one-liners that were written from the headline
 * alone (no article text was available at post time — the scrape failed or the
 * outlet was hard-blocked). Returns null on refusal, thin text, or AI failure
 * so the old summary is NEVER overwritten with bad content. The caller must
 * additionally verify the target row is eligible before persisting (see
 * shouldUpgradeSummaryFromText).
 */
export async function generateOneSentenceSummary(title: string | null | undefined, articleText: string): Promise<string | null> {
  if (!(articleText.length > 200 && isAIConfigured() && title)) return null;
  try {
    const todayStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const completion = await withAiTimeout(openai.chat.completions.create(
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a military intelligence analyst. Today is ${todayStr}. Write exactly one sentence (20-40 words) that concisely states the key news development in this article — who did what, where, and when if known. Mirror the title and article text exactly for all names and official titles (e.g. if the article says "President Trump", write "President Trump", not "Former President Trump"). Do NOT start with "The article" or any meta-commentary about the text. Write only the single summary sentence, nothing else.`,
          },
          { role: 'user', content: `Headline: ${title}\n\nArticle excerpt: ${articleText}` },
        ],
        max_tokens: 80,
        temperature: 0.2,
      },
      { signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS), timeout: OPENAI_TIMEOUT_MS, maxRetries: 0 }
    ), AI_CALL_BACKSTOP_MS, 'streamPrefetch:oneSentenceSummary', { trackStorm: false });
    const responseText = (completion.choices[0]?.message?.content || '').trim();
    if (!responseText || isAIRefusalText(responseText) || isMetaFillerLine(responseText)) {
      return null;
    }
    const cleaned = (stripBriefingPreamble(responseText) || '').trim();
    if (!cleaned || cleaned.length <= 10) return null;
    // Write-time stale-status sanitization: strip AI-injected status descriptors
    // (e.g. "Former President Trump") that neither the headline nor the article text
    // use for that person.
    const { groundGeneratedTextInSources } = await import('./staleStatusSanitizer');
    const sanitized = groundGeneratedTextInSources(cleaned, [title, articleText.slice(0, 2000)]);
    return sanitized && sanitized.length > 10 ? sanitized : null;
  } catch (e: any) {
    console.error(`[StreamPrefetch] One-sentence summary error for "${title?.substring(0, 50)}":`, e?.message || e);
    return null;
  }
}

/**
 * Pure predicate: is this row a CANDIDATE for summary upgrade (regardless of
 * whether a regenerated summary is available yet)?
 *
 * Used in two places:
 *   1. Write path: gate mediaScrapedAt stamping when upgrade was attempted but
 *      AI failed — a candidate row must stay retryable (not stamped "done").
 *   2. Composed inside shouldUpgradeSummaryFromText to avoid duplicating logic.
 *
 * Exported for deterministic unit testing in the regression gate.
 */
export function isSummaryUpgradeCandidate(opts: {
  manuallyEdited: boolean;
  storedFullText: string | null | undefined;
}): boolean {
  if (opts.manuallyEdited) return false;
  // Explicit stored-field marker semantics: NULL or empty string means no
  // article text was available at post time → title-derived summary → eligible
  // for upgrade. Any non-empty string (even short) was intentionally stored and
  // must NOT trigger an overwrite — we deliberately avoid a length heuristic
  // to prevent false-positive upgrades on short-but-real article excerpts.
  const hasRealText = typeof opts.storedFullText === 'string' && opts.storedFullText.trim().length > 0;
  return !hasRealText;
}

/**
 * Pure predicate: should we upgrade a stored summary with a freshly
 * generated one from recovered article text?
 *
 * A row is eligible ONLY when:
 *   - It was not manually edited (preserves human-set summaries exactly).
 *   - No article text was available when the row was first created (fullText
 *     is null/empty), meaning the stored summary is a title-derived AI
 *     rephrase rather than one generated from real reporting.
 *   - A substantive regenerated summary was produced (non-null, non-empty).
 *
 * Delegates eligibility to isSummaryUpgradeCandidate so the logic is DRY.
 * Exported for deterministic unit testing in the regression gate.
 */
export function shouldUpgradeSummaryFromText(opts: {
  manuallyEdited: boolean;
  storedFullText: string | null | undefined;
  regeneratedSummary: string | null | undefined;
}): boolean {
  if (!isSummaryUpgradeCandidate({ manuallyEdited: opts.manuallyEdited, storedFullText: opts.storedFullText })) return false;
  return typeof opts.regeneratedSummary === 'string' && opts.regeneratedSummary.trim().length > 10;
}

async function enrichOneItem(item: EnrichableItem): Promise<'enhanced' | 'skipped' | 'failed'> {
  if (item.manuallyEdited) return 'skipped';

  const isFaviconOnly = isPlaceholderImageUrl(item.ogImageUrl);
  const hasCachedMedia = item.mediaScrapedAt &&
    !isFaviconOnly &&
    (item.ogImageUrl || item.videoUrl || (item.summaryBullets && item.summaryBullets.length > 0));

  if (hasCachedMedia) return 'skipped';

  // Curated back-off (Task #132): this row has no cached media but its recent
  // enrichment attempts failed. Skip it (spend no paywall/AI budget) until the
  // escalating back-off window elapses, or permanently after MAX_MEDIA_ATTEMPTS.
  if (item.kind === 'curated' &&
      isCuratedMediaBackedOff(item.mediaAttemptCount, item.lastMediaAttemptAt)) {
    return 'skipped';
  }

  let imageUrl: string | null = null;
  let htmlContent: string | null = null;
  let archiveOriginalDomain: string | null = null;

  // Hard-blocked outlets (e.g. Bloomberg) 403 every direct/strengthened fetch, so
  // skip those doomed attempts and reclaim their ~23s of budget for the breakers
  // that actually crack them. Curated lane only (main feed path is unchanged).
  // Derived from the single-source-of-truth helper so the routing is testable.
  const { isHardBlocked } = deriveHardBlockEnrichmentPlan(item);

  // Bloomberg non-article short-circuit (Task #1022): newsletters/features fail
  // the whole doomed chain identically every attempt (Jina → paywall stub,
  // paywall2 → 422, CPC → story=none/image=false). Route them to the ONLY paths
  // with evidence of working: the free RSS feed index below (every attempt) and
  // a single bounded CPC call on the first attempt (via deriveCuratedCpcDecision).
  // Jina reader/HTML + paywall2 are skipped entirely. Curated lane only.
  const bloombergNonArticle = item.kind === 'curated' && isBloombergNonArticleUrl(item.url);
  if (bloombergNonArticle) {
    console.log(`[StreamPrefetch:Curated] Bloomberg non-article short-circuit (RSS feed index + single bounded CPC) for "${item.title.substring(0, 50)}"`);
  }

  // Bloomberg-specific fix (Task #655): Bloomberg's own public RSS feeds are
  // NOT blocked and carry a real lead photo via media:content, unlike the
  // hard-blocked article page. Check that index FIRST for hard-blocked
  // curated rows — free (in-memory) and immediate — before spending any of
  // the doomed direct/12ft/paywall2/CPC page-fetch budget below. No-op for
  // every other outlet (including Reuters, not yet confirmed to have feed
  // images) since getBloombergFeedImage internally gates on bloomberg.com.
  if (isHardBlocked && item.kind === 'curated') {
    try {
      const feedImage = await getBloombergFeedImage(item.url);
      if (feedImage) {
        imageUrl = feedImage;
        console.log(`[StreamPrefetch:Curated] Image from Bloomberg RSS feed index for "${item.title.substring(0, 50)}"`);
      }
    } catch {
      // Feed index lookup failed; fall through to the existing bypass chain.
    }
  }

  // WSJ-specific fix (Task #692): WSJ's own public section RSS feeds are NOT
  // blocked and carry a real full-size lead photo via media:content, unlike the
  // hard-blocked article page (which paywall2 usually cracks but can miss for
  // geo-restricted/live pages). Check that index for hard-blocked curated WSJ
  // rows that the Bloomberg index didn't resolve — free (in-memory) and
  // immediate — before spending any doomed page-fetch / paywall2 budget below.
  // No-op for every other outlet since getWsjFeedImage internally gates on wsj.com.
  if (!imageUrl && isHardBlocked && item.kind === 'curated') {
    try {
      const feedImage = await getWsjFeedImage(item.url);
      if (feedImage) {
        imageUrl = feedImage;
        console.log(`[StreamPrefetch:Curated] Image from WSJ RSS feed index for "${item.title.substring(0, 50)}"`);
      }
    } catch {
      // Feed index lookup failed; fall through to the existing bypass chain.
    }
  }

  // Reuters-specific fix (Task #696): Reuters' article pages 401 bot-wall this
  // datacenter and Reuters has NO working public RSS feed anymore (all endpoints
  // return the same bot wall / no DNS), so unlike Bloomberg/WSJ there is no
  // media:content feed to model on. But Reuters' PUBLIC Google-News sitemap IS
  // unblocked and every recent article carries a real lead photo via
  // <image:image> pointing at Reuters' own CDN. Check that index for hard-blocked
  // curated Reuters rows the Bloomberg/WSJ indexes didn't resolve — free
  // (in-memory) and immediate — before spending any doomed page-fetch / CPC
  // budget below. No-op for every other outlet since getReutersFeedImage
  // internally gates on reuters.com.
  if (!imageUrl && isHardBlocked && item.kind === 'curated') {
    try {
      const feedImage = await getReutersFeedImage(item.url);
      if (feedImage) {
        imageUrl = feedImage;
        console.log(`[StreamPrefetch:Curated] Image from Reuters sitemap index for "${item.title.substring(0, 50)}"`);
      }
    } catch {
      // Feed index lookup failed; fall through to the existing bypass chain.
    }
  }

  const isArchiveUrl = isArchiveHost(item.url);

  if (isArchiveUrl) {
    try {
      const archiveData = await extractArchiveData(item.url, item.title);
      if (archiveData.ogImage) imageUrl = archiveData.ogImage;
      if (archiveData.originalDomain) archiveOriginalDomain = archiveData.originalDomain;
    } catch {
      console.log(`[StreamPrefetch] Archive extraction failed for ${item.url}`);
    }
  }

  if (!imageUrl && !isHardBlocked) {
    try {
      const response = await safeFetch(item.url, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      });
      if (response.ok) {
        htmlContent = await response.text();
        const ogMatch = htmlContent.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
          || htmlContent.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
        if (ogMatch?.[1]) imageUrl = decodeHtmlEntities(ogMatch[1]);

        if (!imageUrl) {
          const twMatch = htmlContent.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)
            || htmlContent.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);
          if (twMatch?.[1]) imageUrl = decodeHtmlEntities(twMatch[1]);
        }
      }
    } catch {
      // Direct fetch failed, will try bypasses
    }
  }

  if (!imageUrl && !isHardBlocked) {
    try {
      const bypassUrl = `https://12ft.io/${item.url}`;
      const response = await fetch(bypassUrl, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        redirect: 'follow',
      });
      if (response.ok) {
        htmlContent = await response.text();
        const ogMatch = htmlContent.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
          || htmlContent.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
        if (ogMatch?.[1]) imageUrl = decodeHtmlEntities(ogMatch[1]);
        if (!imageUrl) {
          const twMatch = htmlContent.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)
            || htmlContent.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);
          if (twMatch?.[1]) imageUrl = decodeHtmlEntities(twMatch[1]);
        }
      }
    } catch {
      // 12ft.io bypass failed
    }
  }

  // Curated lane ONLY (Task #161): the shared fetches above use a plain 5s
  // request and only read og:image/twitter:image — bot-sensitive, JS-heavy
  // outlets (Axios, France 24) routinely block/time them out, or expose the
  // real image only via JSON-LD, leaving curated rows on a favicon. For curated
  // rows still missing an image, (a) re-mine any HTML we already have for
  // JSON-LD NewsArticle / article:image, then (b) re-fetch with realistic
  // browser headers + a longer timeout and mine that. AMP-cache image URLs are
  // unwrapped. Main feed (classic/visual) is never touched here.
  if (item.kind === 'curated' && !imageUrl) {
    const titleSnip = item.title.substring(0, 50);
    if (htmlContent) {
      const mined = extractCuratedImageFromHtml(htmlContent);
      if (mined) {
        imageUrl = mined;
        console.log(`[StreamPrefetch:Curated] Image from existing HTML (og/twitter/json-ld/article) for "${titleSnip}"`);
      } else {
        console.log(`[StreamPrefetch:Curated] No image meta in existing HTML for "${titleSnip}"`);
      }
    } else if (!isHardBlocked) {
      console.log(`[StreamPrefetch:Curated] No HTML from shared fetch (blocked/timed out) for "${titleSnip}"`);
    }
    if (!imageUrl && !isHardBlocked) {
      try {
        const response = await safeFetch(item.url, {
          signal: AbortSignal.timeout(CURATED_DIRECT_FETCH_TIMEOUT_MS),
          headers: CURATED_BROWSER_HEADERS,
        });
        if (response.ok) {
          htmlContent = await response.text();
          const mined = extractCuratedImageFromHtml(htmlContent);
          if (mined) {
            imageUrl = mined;
            console.log(`[StreamPrefetch:Curated] Image from strengthened fetch for "${titleSnip}"`);
          } else {
            console.log(`[StreamPrefetch:Curated] Strengthened fetch HTML still had no image meta for "${titleSnip}"`);
          }
        } else {
          console.log(`[StreamPrefetch:Curated] Strengthened fetch HTTP ${response.status} for "${titleSnip}"`);
        }
      } catch (e: any) {
        console.log(`[StreamPrefetch:Curated] Strengthened fetch failed for "${titleSnip}": ${e?.message || e}`);
      }
    }
    // Last resort for outlets that hard-block our IP (e.g. Axios returns 403
    // even to the strengthened request): route through the Jina reader in HTML
    // mode, which fetches the page from Jina's own infra, and mine that HTML.
    // Bloomberg non-article URLs skip this (Task #1022): Jina only ever returns
    // the same paywall stub for them — see isBloombergNonArticleUrl.
    if (!imageUrl && !bloombergNonArticle) {
      const jinaHtml = await fetchViaJinaHtml(item.url, CURATED_PROVIDER_TIMEOUT_MS);
      if (jinaHtml) {
        htmlContent = jinaHtml;
        const mined = extractCuratedImageFromHtml(jinaHtml);
        if (mined) {
          imageUrl = mined;
          console.log(`[StreamPrefetch:Curated] Image from Jina HTML reader for "${titleSnip}"`);
        } else {
          console.log(`[StreamPrefetch:Curated] Jina HTML reader had no image meta for "${titleSnip}"`);
        }
      }
    }
  }

  let paywallArticleText: string | null = null;
  // Automated headline repair (Task #176 automated counterpart): capture the
  // real article headline the bypass chain returns (it is otherwise discarded)
  // so we can opportunistically correct a stale/generic ingest-time curated
  // headline. Curated-lane only; consumed after cacheCuratedItemMedia below.
  let recoveredHeadline: string | null = null;
  let recoveredSourceUrl: string | null = null;
  // Quickly check whether we already have enough article text for the AI to
  // generate bullets. If we have an image but the page's <p> tags didn't
  // yield enough text (common for JS-heavy outlets like NPR), we still want
  // to try the paywall bypass to get clean article text.
  let preliminaryText = '';
  if (htmlContent) {
    const paragraphs = htmlContent.match(/<p[^>]*>([\s\S]*?)<\/p>/gi);
    if (paragraphs && paragraphs.length > 0) {
      preliminaryText = paragraphs.slice(0, 10).map(p => p.replace(/<[^>]+>/g, '').trim()).filter(p => p.length > 50).join(' ');
    }
  }
  const needsArticleText = preliminaryText.length < 200;

  if (!imageUrl || needsArticleText) {
    if (item.kind === 'curated') {
      // Curated lane ONLY: a dedicated extraction chain that is independent of
      // the main feed's paywall2 bypasser. Lead with the free provider (Jina),
      // fall back to CPC only for residual articles Jina cannot crack. Each
      // provider has a short fast-fail timeout so one slow provider cannot
      // block the row. NEVER reached for main-feed items (fail-closed gate).
      const titleSnip = item.title.substring(0, 50);

      try {
        // Bloomberg non-article URLs skip Jina (Task #1022): it returns an
        // identical ~905-char paywall stub for every such URL, never real text
        // or an image — the null result below leaves the normal chain state.
        const jinaResult = bloombergNonArticle
          ? null
          : await fetchViaJinaReader(item.url, CURATED_PROVIDER_TIMEOUT_MS);
        if (jinaResult) {
          if (!imageUrl && jinaResult.imageUrl) {
            imageUrl = jinaResult.imageUrl;
            console.log(`[StreamPrefetch:Curated] Jina recovered image for "${titleSnip}"`);
          }
          if (jinaResult.story && jinaResult.story.length > 100) {
            paywallArticleText = jinaResult.story.slice(0, 2000);
            console.log(`[StreamPrefetch:Curated] Jina recovered text for "${titleSnip}"`);
          }
          if (!recoveredHeadline && jinaResult.headline) {
            recoveredHeadline = jinaResult.headline;
            recoveredSourceUrl = jinaResult.sourceUrl;
          }
        }
      } catch {
        console.log(`[StreamPrefetch:Curated] Jina failed for "${titleSnip}"`);
      }

      // Hard-blocked outlets (Bloomberg): the doomed direct/strengthened fetches
      // were skipped above and Jina is flaky for them, but the main feed's
      // paywall2 breaker cracks these URLs reliably. Reuse that SAME breaker here
      // (curated lane only) before falling to the paid CPC last resort. Bounded by
      // the curated paid-breaker timeout so it can never blow the per-item budget
      // (its default 60s applies only to the untouched main feed caller).
      // Bloomberg non-article URLs skip paywall2 (Task #1022): the breaker
      // answers 422 for every newsletter/feature URL in prod.
      if (isHardBlocked && !bloombergNonArticle && (!imageUrl || (needsArticleText && !paywallArticleText))) {
        try {
          const pwResult = await fetchViaPaywallBypass(item.url, CURATED_PAYWALL2_TIMEOUT_MS);
          if (pwResult) {
            if (!imageUrl && pwResult.imageUrl) {
              imageUrl = pwResult.imageUrl;
              console.log(`[StreamPrefetch:Curated] Paywall2 recovered image for "${titleSnip}"`);
            }
            if (!paywallArticleText && pwResult.story && pwResult.story.length > 100) {
              paywallArticleText = pwResult.story.slice(0, 2000);
              console.log(`[StreamPrefetch:Curated] Paywall2 recovered text for "${titleSnip}"`);
            }
            if (!recoveredHeadline && pwResult.headline) {
              recoveredHeadline = pwResult.headline;
              recoveredSourceUrl = pwResult.sourceUrl;
            }
          }
        } catch {
          console.log(`[StreamPrefetch:Curated] Paywall2 failed for "${titleSnip}"`);
        }
      }

      const stillNeedsImage = !imageUrl;
      const stillNeedsText = needsArticleText && !paywallArticleText;
      // Single testable chokepoint for every CPC skip rule (Task #1022):
      // Dataminr redirects (never article pages), Bloomberg non-article URLs
      // past their single allowed CPC attempt, and CPC-image-doomed hosts
      // (chinaview/kcnawatch) seeking only an image. See deriveCuratedCpcDecision.
      const cpcDecision = deriveCuratedCpcDecision(item, stillNeedsImage, stillNeedsText);
      if ((stillNeedsImage || stillNeedsText) && !cpcDecision.call) {
        console.log(`[StreamPrefetch:Curated] Skipping CPC (${cpcDecision.skipReason}) for "${titleSnip}"`);
      } else if (cpcDecision.call) {
        try {
          const cpcResult = await fetchViaCpc(item.url, CURATED_CPC_TIMEOUT_MS);
          if (cpcResult) {
            if (!imageUrl && cpcResult.imageUrl) {
              imageUrl = cpcResult.imageUrl;
              console.log(`[StreamPrefetch:Curated] CPC recovered image for "${titleSnip}"`);
            }
            if (!paywallArticleText && cpcResult.story && cpcResult.story.length > 100) {
              paywallArticleText = cpcResult.story.slice(0, 2000);
              console.log(`[StreamPrefetch:Curated] CPC recovered text for "${titleSnip}"`);
            }
            if (!recoveredHeadline && cpcResult.headline) {
              recoveredHeadline = cpcResult.headline;
              recoveredSourceUrl = cpcResult.sourceUrl;
            }
          } else {
            console.log(`[StreamPrefetch:Curated] CPC returned nothing usable for "${titleSnip}"`);
          }
        } catch {
          console.log(`[StreamPrefetch:Curated] CPC failed for "${titleSnip}"`);
        }
      }
    } else {
      // Main feed (classic/visual): unchanged single paywall2 path.
      try {
        const paywallResult = await fetchViaPaywallBypass(item.url);
        if (paywallResult) {
          if (!imageUrl && paywallResult.imageUrl) {
            imageUrl = paywallResult.imageUrl;
            console.log(`[StreamPrefetch] Paywall bypass recovered image for "${item.title.substring(0, 50)}"`);
          }
          if (paywallResult.story && paywallResult.story.length > 100) {
            paywallArticleText = paywallResult.story.slice(0, 2000);
          }
        }
      } catch {
        console.log(`[StreamPrefetch] Paywall bypass failed for "${item.title.substring(0, 50)}"`);
      }
    }
  }

  if (imageUrl) {
    const persistedPath = await persistImageToStorage(imageUrl);
    if (persistedPath) {
      imageUrl = persistedPath;
    } else if (isArchiveHost(imageUrl)) {
      // Re-hosting the archive image (and its wrapped original) failed. Never
      // keep a raw web.archive.org URL as the stored photo — that would make the
      // card silently depend on archive.org staying up/fast, and the snapshot
      // can 404 later. Drop to no-image so the row falls back to a favicon and
      // stays retryable (media_scraped_at is only stamped on a real image).
      console.log(`[StreamPrefetch] Dropping un-rehostable archive image URL for "${item.title.substring(0, 50)}"`);
      imageUrl = null;
    }
  }

  if (!imageUrl) {
    try {
      const urlObj = new URL(item.url);
      let logoDomain = urlObj.hostname;
      if (isArchiveUrl && archiveOriginalDomain) logoDomain = archiveOriginalDomain;
      imageUrl = `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${logoDomain}&size=128`;
    } catch {
      // Invalid URL
    }
  }

  let articleText = '';
  if (htmlContent) {
    const paragraphs = htmlContent.match(/<p[^>]*>([\s\S]*?)<\/p>/gi);
    if (paragraphs && paragraphs.length > 0) {
      articleText = paragraphs.slice(0, 10).map(p => p.replace(/<[^>]+>/g, '').trim()).filter(p => p.length > 50).join(' ').slice(0, 2000);
    }
  }
  if (articleText.length < 200 && paywallArticleText) articleText = paywallArticleText;

  // Social posts (X / Truth Social / DataMinr) show the post text itself — never
  // a forced 3-bullet AI summary or attributed-claims block (Task #354). Skip
  // both generators for them; any real image found above is still kept.
  let summaryBullets: string[] = [];
  let attributedClaims: string[] = [];
  // Per-article angle/framing characterization for standalone single-source items
  // (Task #937). Null for social posts or neutral straight-news articles.
  let sourceSpin: string | null = null;
  // Track whether the AI outright refused / returned a meta reply (Task #354).
  // A refusal yields empty bullets/claims that must be treated as NO output —
  // the row must stay retryable (never stamped media_scraped_at) so a later,
  // healthy cycle can regenerate the summary, even if a real image landed.
  const summaryMeta: { refused?: boolean } = {};
  const claimsMeta: { refused?: boolean } = {};
  if (!item.isSocial) {
    summaryBullets = await generateSummaryBullets(
      item.title,
      articleText,
      summaryMeta,
      { mode: item.kind === 'curated' ? 'curated-evidence' : 'default' },
    );
    // Attributed claims / key statements (Task #256) — generated from the SAME
    // article text alongside the bullets. Empty array is normal (no attributed
    // claims found); persisted next to summaryBullets and shown additively.
    attributedClaims = await generateAttributedClaims(item.title, articleText, claimsMeta);
    // Source spin (Task #937) — one-sentence angle/framing characterization.
    // Only generated for curated items (main-lane rows don't show this).
    // Null means no discernible angle; rendering hides the section.
    if (item.kind === 'curated') {
      sourceSpin = await generateSourceSpin(item.title, articleText);
    }
  }
  const hadRefusal = !!summaryMeta.refused || !!claimsMeta.refused;

  // Regenerate the one-line summary from recovered article text for rows whose
  // summary was written from the headline alone (no article text at post time).
  // Only attempted when bullets were successfully generated (real text, no
  // refusal) so the AI is making a considered decision. The eligibility check
  // (fullText null → title-derived) is enforced inside the write path so the
  // upgrade is fail-closed: manually edited rows and rows that already had
  // real post-time text are never touched. null = no upgrade (old summary stays).
  // Track whether upgrade was attempted so the write path can keep the row
  // retryable when the AI call fails (see cacheHeadlineMedia / cacheCuratedItemMedia).
  const summaryUpgradeAttempted = !item.isSocial && !hadRefusal && summaryBullets.length > 0 && articleText.length > 200;
  let regeneratedSummary: string | null = null;
  if (summaryUpgradeAttempted) {
    regeneratedSummary = await generateOneSentenceSummary(item.title, articleText);
  }

  // Page-detected content kind (curated-lane gating). Sniff whatever HTML we
  // managed to fetch above; null when every fetch failed (leave the flag as-is).
  let detectedContentKind = detectPageContentKind(htmlContent, item.url);

  // Recovered original-publish date (Task #933). Off-host discovery bots (Bing
  // News RSS) capture only title+url, so those curated rows land with
  // articlePublishedAt=null and the card honestly shows "First seen". We already
  // fetched the article HTML above for the image/bullets — reuse it (no extra
  // network round-trip) and mine ONLY the trusted structured original-publish
  // signals (JSON-LD datePublished, article:published_time, itemprop=
  // datePublished, time[pubdate]); generic/updated tags are excluded by the
  // extractor (Task #653). cacheCuratedItemMedia writes it NULL-guarded so an
  // upstream (RSS/Meltwater/team) or human-set date is never clobbered. Curated
  // lane only, fail-open (no HTML or no trusted signal → stays null).
  let recoveredPublishedAt: Date | null = null;
  if (item.kind === 'curated' && htmlContent) {
    try {
      const { publishedAt } = parseTimestampsFromHtmlString(htmlContent);
      if (isPlausiblePublishedDate(publishedAt)) recoveredPublishedAt = publishedAt;
    } catch {
      // fail-open: never let date recovery break enrichment
    }
  }

  if (item.kind === 'curated') {
    // Title-based content-kind detection (Task #963). Supplements page-HTML
    // signals for trusted outlets whose analysis/explainer pieces lack a
    // telltale URL segment AND no structured page signal (JSON-LD / meta
    // section / standalone kicker) was found. Two deterministic, high-
    // precision rules:
    //
    //   A. Leading label: "Op-ed: Gaza peace plan" — the outlet explicitly
    //      identifies the title as commentary before the headline text.
    //
    //   B. Trailing kicker: "Gaza peace plan - analysis" — the outlet wrote
    //      the type label at the end of the H1, after a separator. Outlet-
    //      authored and position-anchored → very high precision.
    //
    //   C. WH-lead dual-signal: URL slug AND headline both start with the
    //      same WH-lead (why / what / how). A declarative slug corroborates
    //      an interrogative title → France24/Reuters/DW explainer class.
    //
    // Neither rule runs when a stronger page signal already found a kind —
    // page/JSON-LD signals always win. Curated-lane only; fail-closed.
    let resolvedContentKind = detectedContentKind;
    if ((!resolvedContentKind || resolvedContentKind === 'article') && item.title) {
      const titleLeadingLabel = detectTitleLeadingLabel(item.title);
      if (titleLeadingLabel) {
        resolvedContentKind = titleLeadingLabel;
      } else {
        const titleKicker = detectTitleTrailingKicker(item.title);
        if (titleKicker) {
          resolvedContentKind = titleKicker;
        } else {
          const dualKind = detectWHLeadDualSignal(item.url, item.title);
          if (dualKind) resolvedContentKind = dualKind;
        }
      }
    }
    await cacheCuratedItemMedia(item.id, imageUrl, summaryBullets, resolvedContentKind, attributedClaims, hadRefusal, regeneratedSummary, summaryUpgradeAttempted, recoveredPublishedAt, sourceSpin);
    // Automated headline repair (Task #176 automated counterpart). The bypass
    // chain above ALREADY fetched the article's real headline (Reuters and other
    // hard-blocked outlets skip the direct fetch, so needsArticleText is true and
    // the chain always runs). Opportunistically persist it as a DISPLAY-ONLY
    // 'auto' override when it clears the fail-closed guard stack — never mutating
    // the shared title/normalizedTitle (clustering/dedup identity is untouched)
    // and never clobbering a human ('human') editor override. Curated-lane only.
    if (recoveredHeadline) {
      try {
        const decision = evaluateAutoHeadline(
          {
            storedTitle: item.title,
            recoveredHeadline,
            recoveredSourceUrl,
            itemUrl: item.url,
            isSocial: item.isSocial,
            isTranslateSource: !!item.source && CURATED_TITLE_TRANSLATE_SOURCES.has(item.source),
          },
          { isRefusalText: isAIRefusalText },
        );
        if (decision.accept && decision.headline) {
          await storage.setAutoCuratedHeadlineOverride(`curated:${item.id}`, decision.headline);
          console.log(`[StreamPrefetch:Curated] Auto-corrected headline for curated:${item.id}: "${decision.headline.slice(0, 80)}"`);
        }
      } catch (e: any) {
        console.log(`[StreamPrefetch:Curated] Auto-headline repair skipped for curated:${item.id}: ${e?.message || e}`);
      }
    }
  } else {
    await cacheHeadlineMedia(item.id, imageUrl, summaryBullets, detectedContentKind, attributedClaims, regeneratedSummary, summaryUpgradeAttempted);
  }
  return 'enhanced';
}

/**
 * Read-only article preview: given a URL, scrape the page (with paywall
 * fallbacks) and return suggested form values for the admin "Submit Article"
 * UI. Does NOT write to the DB and does NOT use the stream-media worker
 * mutex. Image is persisted to object storage so the admin can immediately
 * display it.
 */
export async function extractArticlePreview(url: string): Promise<{
  title: string | null;
  source: string | null;
  ogImageUrl: string | null;
  summaryBullets: string[];
}> {
  // SSRF guard — refuse non-public targets BEFORE any outbound fetch (direct
  // or via paywall bypass). The paywall bypass forwards the URL to a third
  // party that fetches it, but we still don't want to be a redirector to
  // internal hosts, and our own direct fetch must be blocked outright.
  if (!(await isPublicFetchableUrl(url))) {
    throw new Error('URL is not allowed (must be a public http(s) address)');
  }

  let imageUrl: string | null = null;
  let htmlContent: string | null = null;

  // 1) Direct fetch for og:image / og:title / og:site_name
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    if (response.ok) {
      htmlContent = await response.text();
      const ogMatch = htmlContent.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
        || htmlContent.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
      if (ogMatch?.[1]) imageUrl = decodeHtmlEntities(ogMatch[1]);
      if (!imageUrl) {
        const twMatch = htmlContent.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)
          || htmlContent.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);
        if (twMatch?.[1]) imageUrl = decodeHtmlEntities(twMatch[1]);
      }
    }
  } catch {
    // direct fetch failed
  }

  // 2) Paywall bypass for image and/or article text
  let paywallTitle: string | null = null;
  let paywallSource: string | null = null;
  let paywallText: string | null = null;
  try {
    const paywallResult = await fetchViaPaywallBypass(url);
    if (paywallResult) {
      if (!imageUrl && paywallResult.imageUrl) imageUrl = paywallResult.imageUrl;
      if ((paywallResult as any).title) paywallTitle = (paywallResult as any).title;
      if ((paywallResult as any).source) paywallSource = (paywallResult as any).source;
      if (paywallResult.story && paywallResult.story.length > 100) {
        paywallText = paywallResult.story.slice(0, 2000);
      }
    }
  } catch {
    // paywall bypass failed
  }

  // 3) Persist image to object storage so the admin UI can render it. Never
  // keep a raw web.archive.org URL (persist re-hosts the wrapped original when
  // possible); drop to no-image rather than depend on archive.org uptime.
  if (imageUrl) {
    const persistedPath = await persistImageToStorage(imageUrl);
    if (persistedPath) imageUrl = persistedPath;
    else if (isArchiveHost(imageUrl)) imageUrl = null;
  }

  // 4) Title — prefer og:title, then <title>
  let title: string | null = null;
  if (htmlContent) {
    const ogTitleMatch = htmlContent.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
      || htmlContent.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (ogTitleMatch?.[1]) title = decodeHtmlEntities(ogTitleMatch[1]).trim();
    if (!title) {
      const titleMatch = htmlContent.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch?.[1]) title = decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
    }
  }
  if (!title && paywallTitle) title = paywallTitle.trim();

  // 5) Source — prefer og:site_name, fall back to hostname
  let source: string | null = null;
  if (htmlContent) {
    const siteMatch = htmlContent.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)
      || htmlContent.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
    if (siteMatch?.[1]) source = decodeHtmlEntities(siteMatch[1]).trim();
  }
  if (!source && paywallSource) source = paywallSource.trim();
  if (!source) {
    try {
      const u = new URL(url);
      source = u.hostname.replace(/^www\./, '');
    } catch {}
  }

  // 6) Article text → AI bullets
  let articleText = '';
  if (htmlContent) {
    const paragraphs = htmlContent.match(/<p[^>]*>([\s\S]*?)<\/p>/gi);
    if (paragraphs && paragraphs.length > 0) {
      articleText = paragraphs.slice(0, 10).map(p => p.replace(/<[^>]+>/g, '').trim()).filter(p => p.length > 50).join(' ').slice(0, 2000);
    }
  }
  if (articleText.length < 200 && paywallText) articleText = paywallText;

  const summaryBullets = await generateSummaryBullets(title, articleText);

  return { title, source, ogImageUrl: imageUrl, summaryBullets };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout (${ms}ms) for ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function tryAcquireWorker(label: string): boolean {
  const now = Date.now();
  if (streamMediaWorkerStartedAt !== null) {
    const age = now - streamMediaWorkerStartedAt;
    if (age < MAX_PREFETCH_RUN_MS) {
      console.log(`[StreamPrefetch] ${label}: another stream-media worker (${streamMediaWorkerLabel}) running ${Math.round(age / 1000)}s, skipping`);
      return false;
    }
    console.warn(`[StreamPrefetch] ${label}: previous worker (${streamMediaWorkerLabel}) stuck for ${Math.round(age / 1000)}s, force-resetting mutex`);
  }
  streamMediaWorkerStartedAt = now;
  streamMediaWorkerLabel = label;
  return true;
}

function releaseWorker() {
  streamMediaWorkerStartedAt = null;
  streamMediaWorkerLabel = null;
}

export async function prefetchStreamMedia() {
  if (!tryAcquireWorker('prefetch')) return;

  try {
    const { storage } = await import('./storage');
    const allHeadlines = await storage.getPrimaryFeed(18, 20);

    const sorted = allHeadlines.sort((a, b) => {
      if (b.depreciatedPriority !== a.depreciatedPriority) {
        return b.depreciatedPriority - a.depreciatedPriority;
      }
      return new Date(b.articlePublishedAt || b.scrapedAt).getTime() - new Date(a.articlePublishedAt || a.scrapedAt).getTime();
    });
    const topHeadlines = sorted.slice(0, 11);

    let enhanced = 0;
    let skipped = 0;
    let failed = 0;

    for (const headline of topHeadlines) {
      try {
        const result = await withTimeout(
          enrichOneItem({
            id: headline.id,
            url: headline.url,
            title: headline.title,
            ogImageUrl: headline.ogImageUrl,
            videoUrl: headline.videoUrl,
            summaryBullets: headline.summaryBullets,
            mediaScrapedAt: headline.mediaScrapedAt,
            manuallyEdited: (headline as any).manuallyEdited,
          }),
          PER_ITEM_TIMEOUT_MS,
          headline.title?.substring(0, 50) || headline.id
        );
        if (result === 'enhanced') enhanced++;
        else if (result === 'skipped') skipped++;
      } catch (error: any) {
        failed++;
        console.error(`[StreamPrefetch] Error processing "${headline.title?.substring(0, 50)}":`, error?.message || error);
      }
    }

    if (enhanced > 0 || failed > 0) {
      console.log(`[StreamPrefetch] Done — enhanced: ${enhanced}, skipped: ${skipped}, failed: ${failed}`);
    }
  } finally {
    releaseWorker();
  }
}

/**
 * Resolve a SecWar X post's og:image by fetching the post URL once. Kept OUT of
 * the /api/stream request path (Task #680): previously the Visual-feed handler
 * fanned out one x.com fetch per SecWar post on every cache miss and blocked the
 * response on them, so when x.com was slow / rate-limiting / serving a login
 * wall the whole feed stalled or 500'd for every viewer. This runs in the
 * background prefetch instead and persists the result to x_posts.image_url.
 *
 * Text-only-post avatar guard: an X status with no attached media resolves its
 * og:image to the author's profile picture (pbs.twimg.com/profile_images/...),
 * which would render as a fake "attached photo". Those (and header banners) are
 * rejected so only a real media image is stored — mirroring the same guard the
 * Truth Social path already applies.
 */
async function resolveXPostOgImage(xUrl: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(xUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
    });
  } catch {
    return null;
  }
  if (!response.ok) { try { await response.body?.cancel(); } catch {} return null; }
  const html = await response.text();
  const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (!ogMatch?.[1]) return null;
  const url = decodeHtmlEntities(ogMatch[1]);
  if (/\/(profile_images|profile_banners)\//i.test(url)) return null;
  return url;
}

/**
 * Background media prefetch for SecWar X posts (Task #680). Picks the most
 * recent SecWar posts that still have no image AND have never been attempted
 * (media_scraped_at IS NULL), resolves each post's og:image once, and persists
 * it to x_posts.image_url. media_scraped_at is stamped on every attempt — even
 * when no real image is found (text-only post) — so x.com is not re-fetched for
 * the same post on every cycle. Uses the shared stream-media worker mutex so it
 * never overlaps the other prefetch/backfill workers.
 */
export async function prefetchXPostMedia(limit = 20) {
  if (!tryAcquireWorker('x-media-prefetch')) return;
  try {
    const rows = await db
      .select({ id: xPosts.id, xUrl: xPosts.xUrl })
      .from(xPosts)
      .where(and(
        eq(xPosts.isHidden, false),
        eq(xPosts.sourceAccount, 'SecWar'),
        isNull(xPosts.imageUrl),
        isNull(xPosts.mediaScrapedAt),
      ))
      .orderBy(desc(xPosts.postedAt))
      .limit(limit);
    if (rows.length === 0) return;

    let enhanced = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const imageUrl = await resolveXPostOgImage(row.xUrl);
        await db.update(xPosts)
          .set({ imageUrl: imageUrl ?? null, mediaScrapedAt: new Date() })
          .where(eq(xPosts.id, row.id));
        if (imageUrl) enhanced++;
      } catch (error: any) {
        failed++;
        console.error(`[StreamPrefetch:XMedia] Error resolving image for ${row.id}:`, error?.message || error);
      }
    }
    if (enhanced > 0 || failed > 0) {
      console.log(`[StreamPrefetch:XMedia] Done — enhanced: ${enhanced}, failed: ${failed}, scanned: ${rows.length}`);
    }
  } finally {
    releaseWorker();
  }
}

/**
 * Backfill enrichment for any headlines/manual_submissions in the last N hours
 * that have no media_scraped_at timestamp. Useful after the prefetch mutex was
 * stuck or when widening the scope beyond the top 11.
 */
export async function backfillStaleStreamMedia(hoursBack = 48, maxItems = 50): Promise<{
  scanned: number;
  enhanced: number;
  skipped: number;
  failed: number;
}> {
  if (!tryAcquireWorker('backfill')) {
    return { scanned: 0, enhanced: 0, skipped: 0, failed: 0 };
  }
  try {
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

  const staleHeadlines = await db.select({
    id: headlines.id,
    url: headlines.url,
    title: headlines.title,
    ogImageUrl: headlines.ogImageUrl,
    videoUrl: headlines.videoUrl,
    summaryBullets: headlines.summaryBullets,
    mediaScrapedAt: headlines.mediaScrapedAt,
    manuallyEdited: headlines.manuallyEdited,
  })
    .from(headlines)
    .where(and(
      gte(headlines.scrapedAt, cutoff),
      isNull(headlines.mediaScrapedAt),
      or(isNull(headlines.manuallyEdited), eq(headlines.manuallyEdited, false))
    ))
    .limit(maxItems);

  const staleSubs = await db.select({
    id: manualSubmissions.id,
    url: manualSubmissions.url,
    title: manualSubmissions.title,
    ogImageUrl: manualSubmissions.ogImageUrl,
    videoUrl: manualSubmissions.videoUrl,
    summaryBullets: manualSubmissions.summaryBullets,
    mediaScrapedAt: manualSubmissions.mediaScrapedAt,
    manuallyEdited: manualSubmissions.manuallyEdited,
  })
    .from(manualSubmissions)
    .where(and(
      gte(manualSubmissions.submittedAt, cutoff),
      isNull(manualSubmissions.mediaScrapedAt),
      or(isNull(manualSubmissions.manuallyEdited), eq(manualSubmissions.manuallyEdited, false))
    ))
    .limit(maxItems);

  const items: EnrichableItem[] = [
    ...staleHeadlines.map(h => ({ ...h, summaryBullets: h.summaryBullets ?? null })),
    ...staleSubs.map(s => ({ ...s, summaryBullets: s.summaryBullets ?? null })),
  ];

  console.log(`[StreamPrefetch:Backfill] Scanning ${items.length} stale items (last ${hoursBack}h)`);

  let enhanced = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of items) {
    try {
      const result = await withTimeout(enrichOneItem(item), PER_ITEM_TIMEOUT_MS, item.title?.substring(0, 50) || item.id);
      if (result === 'enhanced') enhanced++;
      else if (result === 'skipped') skipped++;
    } catch (error: any) {
      failed++;
      console.error(`[StreamPrefetch:Backfill] Error processing "${item.title?.substring(0, 50)}":`, error?.message || error);
    }
  }

  console.log(`[StreamPrefetch:Backfill] Done — scanned: ${items.length}, enhanced: ${enhanced}, skipped: ${skipped}, failed: ${failed}`);
  return { scanned: items.length, enhanced, skipped, failed };
  } finally {
    releaseWorker();
  }
}

async function cacheHeadlineMedia(headlineId: string, ogImageUrl: string | null, summaryBullets: string[], contentKind?: 'audio' | 'article' | 'opinion' | 'explainer' | null, attributedClaims: string[] = [], regeneratedSummary: string | null = null, summaryUpgradeAttempted = false) {
  // Claims-only successes (no image, no bullets, but attributed claims were
  // generated — Task #256) must still persist, so include them in the gate.
  const hasData = ogImageUrl || summaryBullets.length > 0 || attributedClaims.length > 0;
  if (!hasData) return;
  // Curated-lane content-kind flag (see schema). Persisted on the SAME row as the
  // media; read ONLY by curated-gated surfaces, never by the main feed. Omitted
  // (no-op) when detection produced nothing.
  const kindSet = contentKind ? { contentKind } : {};
  // Attributed claims (Task #256). Persisted next to summaryBullets; null when
  // none were found so the additive detail section simply hides.
  const claimsSet = attributedClaims.length > 0 ? { attributedClaims } : { attributedClaims: null };

  try {
    const [existing] = await db.select({
      ogImageUrl: headlines.ogImageUrl,
      summaryBullets: headlines.summaryBullets,
      mediaScrapedAt: headlines.mediaScrapedAt,
      manuallyEdited: headlines.manuallyEdited,
      fullText: headlines.fullText,
    }).from(headlines).where(eq(headlines.id, headlineId));

    if (existing) {
      if (existing.manuallyEdited) return;
      const existingHasManualBullets = existing.summaryBullets && existing.summaryBullets.length > 0 && existing.mediaScrapedAt;
      const isManualUpload = existing.ogImageUrl && existing.ogImageUrl.startsWith('/objects/') && !existing.ogImageUrl.includes('/auto-');
      const finalOgImage = isManualUpload ? existing.ogImageUrl : ogImageUrl;
      const finalBullets = existingHasManualBullets ? existing.summaryBullets : (summaryBullets.length > 0 ? summaryBullets : null);
      // Summary upgrade: if no article text was available at post time (fullText
      // null/empty), the stored summary is a title-derived fallback. Upgrade it
      // when enrichment has now recovered substantive text. Retryability: if the
      // row is a candidate but regeneration failed (AI error), withhold
      // mediaScrapedAt so the row stays retryable for the next healthy cycle.
      const upgradeSummary = shouldUpgradeSummaryFromText({
        manuallyEdited: false, // already guarded above
        storedFullText: existing.fullText,
        regeneratedSummary,
      });
      const summarySet = upgradeSummary && regeneratedSummary ? { summary: regeneratedSummary } : {};
      if (upgradeSummary) {
        console.log(`[StreamPrefetch] Upgrading title-only summary for headline ${headlineId}`);
      }
      // Do not stamp mediaScrapedAt ONLY when upgrade was actually attempted
      // but AI failed — keeps the row retryable. When upgrade was not attempted
      // this pass (e.g., no bullets were generated), stamp normally to avoid
      // a permanent retry loop on rows that simply didn't qualify yet.
      const shouldStamp = !summaryUpgradeAttempted || !!regeneratedSummary;
      const stampSet = shouldStamp ? { mediaScrapedAt: new Date() } : {};
      await db.update(headlines).set({ ogImageUrl: finalOgImage, summaryBullets: finalBullets, ...stampSet, ...kindSet, ...claimsSet, ...summarySet }).where(eq(headlines.id, headlineId));
      return;
    }

    const [existingManual] = await db.select({
      ogImageUrl: manualSubmissions.ogImageUrl,
      summaryBullets: manualSubmissions.summaryBullets,
      mediaScrapedAt: manualSubmissions.mediaScrapedAt,
      manuallyEdited: manualSubmissions.manuallyEdited,
      fullText: manualSubmissions.fullText,
    }).from(manualSubmissions).where(eq(manualSubmissions.id, headlineId));

    if (existingManual) {
      if (existingManual.manuallyEdited) return;
      const existingHasManualBullets = existingManual.summaryBullets && existingManual.summaryBullets.length > 0 && existingManual.mediaScrapedAt;
      const isManualUpload = existingManual.ogImageUrl && existingManual.ogImageUrl.startsWith('/objects/') && !existingManual.ogImageUrl.includes('/auto-');
      const finalOgImage = isManualUpload ? existingManual.ogImageUrl : ogImageUrl;
      const finalBullets = existingHasManualBullets ? existingManual.summaryBullets : (summaryBullets.length > 0 ? summaryBullets : null);
      // Summary upgrade: if the row had no article text at post time (fullText
      // null) the stored summary is a title-derived AI rephrase. Now that we
      // have recovered real text, replace it with a properly sourced one-liner.
      const upgradeSummary = shouldUpgradeSummaryFromText({
        manuallyEdited: false, // already guarded above
        storedFullText: existingManual.fullText,
        regeneratedSummary,
      });
      const summarySet = upgradeSummary && regeneratedSummary
        ? { summary: regeneratedSummary }
        : {};
      if (upgradeSummary) {
        console.log(`[StreamPrefetch] Upgrading title-only summary for ${headlineId}`);
      }
      // Do not stamp mediaScrapedAt ONLY when upgrade was actually attempted
      // but AI failed — keeps the row retryable. When upgrade was not attempted
      // this pass (e.g., no bullets were generated), stamp normally to avoid
      // a permanent retry loop on rows that simply didn't qualify yet.
      const shouldStamp = !summaryUpgradeAttempted || !!regeneratedSummary;
      const stampSet = shouldStamp ? { mediaScrapedAt: new Date() } : {};
      await db.update(manualSubmissions).set({ ogImageUrl: finalOgImage, summaryBullets: finalBullets, ...stampSet, ...kindSet, ...claimsSet, ...summarySet }).where(eq(manualSubmissions.id, headlineId));
    }
  } catch (error) {
    console.error(`[StreamPrefetch] Cache write failed for ${headlineId}:`, error);
  }
}

/**
 * Curated-lane write path (Task #124). Mirrors cacheHeadlineMedia but targets
 * the ISOLATED curated_items store and NEVER touches headlines/manual_submissions.
 * Stamps media_scraped_at so the skip/backfill logic can tell enriched rows from
 * untouched ones. Curated rows are never manually edited, so there are no manual
 * upload/manual-bullet preservation branches.
 */
/**
 * Whether a curated row may be stamped fully "media-scraped/done" (Task #354).
 * Pure predicate so the retryability invariant is unit-testable: a row is done
 * ONLY when it has a real (non-favicon) image AND the summary was NOT an AI
 * refusal AND a pending summary upgrade did not fail. A refusal or failed
 * upgrade is treated as no output, so the row must stay retryable even when
 * an image landed. Exported for deterministic unit testing.
 */
export function shouldStampCuratedMediaDone(
  hasRealImage: boolean,
  hadRefusal: boolean,
  summaryUpgradeFailed = false,
): boolean {
  return hasRealImage && !hadRefusal && !summaryUpgradeFailed;
}

export type CuratedEnrichmentLifecycle =
  | 'ready'
  | 'pending'
  | 'backed-off'
  | 'retry-capped';

/**
 * Explains an incomplete curated row without changing its retry policy. This is
 * used only for editor telemetry: the scheduler remains the sole authority for
 * retry timing, the capped state, and paid-call limits.
 */
export function getCuratedEnrichmentLifecycle(
  item: {
    summaryBullets?: string[] | null;
    ogImageUrl?: string | null;
    mediaAttemptCount?: number | null;
    lastMediaAttemptAt?: Date | null;
  },
): CuratedEnrichmentLifecycle {
  const hasBullets = Array.isArray(item.summaryBullets) && item.summaryBullets.length > 0;
  const hasRealImage = !!item.ogImageUrl && !isFaviconUrl(item.ogImageUrl);
  if (hasBullets && hasRealImage) return 'ready';
  const attempts = item.mediaAttemptCount ?? 0;
  if (attempts >= MAX_MEDIA_ATTEMPTS) return 'retry-capped';
  if (isCuratedMediaBackedOff(attempts, item.lastMediaAttemptAt ?? null)) return 'backed-off';
  return 'pending';
}

export async function cacheCuratedItemMedia(curatedItemId: string, ogImageUrl: string | null, summaryBullets: string[], contentKind?: 'audio' | 'article' | 'opinion' | 'explainer' | null, attributedClaims: string[] = [], hadRefusal: boolean = false, regeneratedSummary: string | null = null, summaryUpgradeAttempted: boolean = false, recoveredPublishedAt: Date | null = null, sourceSpin: string | null = null) {
  // Recovered original-publish date (Task #933). Written in its OWN atomic,
  // NULL-guarded statement (WHERE article_published_at IS NULL) so it can never
  // clobber an upstream (RSS/Meltwater/team) or human-set date, and so the two
  // media write branches below stay unchanged. Independent of image/bullet
  // success — a favicon-only row still gets its real date. Plausibility already
  // vetted by the caller. Curated-lane only; fail-open (a write error is logged,
  // never thrown, so it can't break media caching).
  if (recoveredPublishedAt) {
    try {
      await db.update(curatedItems)
        .set({ articlePublishedAt: recoveredPublishedAt })
        .where(and(eq(curatedItems.id, curatedItemId), isNull(curatedItems.articlePublishedAt)));
    } catch (e) {
      console.error(`[StreamPrefetch:Curated] published-date write failed for ${curatedItemId}:`, e);
    }
  }
  const hasBullets = summaryBullets.length > 0;
  // Attributed claims (Task #256). Persisted on every write path next to the
  // bullets; null when none were found so the additive detail section hides.
  const claimsSet = attributedClaims.length > 0 ? { attributedClaims } : { attributedClaims: null };
  // Curated-lane content-kind flag (see schema). Stored on EVERY write path
  // (real-image OR favicon-only) so an audio row is flagged even before a real
  // image lands; null/undefined leaves the existing stored value untouched.
  const kindSet = contentKind ? { contentKind } : {};
  // Analysis/opinion/explainer score re-cap (2026-07-14). When enrichment
  // writes contentKind='opinion' or 'explainer' (page-labeled via JSON-LD /
  // article:section / og:type — e.g. JPost analysis, Bloomberg opinion) the
  // machine score may already be above CURATED_ANALYSIS_OPINION_CAP (69) from
  // the gate-time analyzer. Pull it back using SQL LEAST() so a single DB write
  // handles both the cap and the existing value atomically — no read round-trip
  // needed. Human-score protections (mirrors the ingest-time cap invariant —
  // caps apply to machine scores only, never a human-set one):
  //   - Curated pins live in a SEPARATE table (curated_priority_overrides),
  //     applied at read time — never touched by this path.
  //   - A main-feed ADMIN OVERRIDE that was passed through to the curated copy
  //     at reuse-intake (headlines.priority_override → curated priorityScore)
  //     is skipped via the NOT EXISTS guard below: if any main-lane row with
  //     the same URL carries an explicit admin override, the stored curated
  //     score is left untouched.
  //   - Team-submission upstream scores have no origin marker (AI-then-maybe-
  //     edited), so they cannot be distinguished here; they are near-always
  //     enriched inline at ingest (mediaScrapedAt stamped) and so rarely reach
  //     this path, and the residual worst case is a cap to 69 that a curated
  //     pin can restore at read time.
  const analysisCapSet = (contentKind === 'opinion' || contentKind === 'explainer')
    ? {
        priorityScore: sql`CASE
          WHEN EXISTS (
            SELECT 1 FROM ${headlines}
            WHERE ${headlines.url} = ${curatedItems.url}
              AND ${headlines.priorityOverride} IS NOT NULL
          ) THEN ${curatedItems.priorityScore}
          ELSE LEAST(${curatedItems.priorityScore}, ${CURATED_ANALYSIS_OPINION_CAP})
        END`,
      }
    : {};
  // Summary upgrade for curated rows: curated_items.summary defaults to '' and
  // is populated at ingest from the same AI one-liner as the main lane. If a
  // regenerated summary was produced from recovered article text, write it now.
  // Curated rows have no manuallyEdited flag and no fullText column, so the
  // eligibility check is simpler: write whenever we have a clean regenerated
  // summary and the current summary is short/empty (title-derived or blank).
  // Guarded by isAIRefusalText in generateOneSentenceSummary already; never
  // overwrites with bad content.
  const summarySet = regeneratedSummary && regeneratedSummary.length > 10
    ? { summary: regeneratedSummary }
    : {};
  // Only mark a row fully "scraped" when we recovered a REAL article image
  // (Task #161). Bullets alone are NOT enough to consider a row done: outlets
  // like Axios/France 24 expose a real image, but a transient fetch failure
  // (e.g. the Jina reader throttling to a partial page) can leave us with only
  // a favicon. If we stamped media_scraped_at on favicon+bullets, that row would
  // be permanently un-retryable and stuck on the placeholder. Instead we keep it
  // retryable (bounded by MAX_MEDIA_ATTEMPTS) so a later, healthy cycle upgrades
  // the image, while still persisting the bullets + favicon fallback so the row
  // displays useful content in the meantime.
  const hasRealImage = !!ogImageUrl && !isFaviconUrl(ogImageUrl);
  // A failed one-sentence summary regeneration is treated as incomplete output:
  // even with a real image we must NOT stamp media_scraped_at, or the row would
  // be considered done and the summary upgrade would never be retried.
  const summaryUpgradeFailed = summaryUpgradeAttempted && !regeneratedSummary;
  try {
    // An AI refusal / meta reply (Task #354) is treated as NO summary output:
    // even with a real image, we must NOT stamp media_scraped_at, or stale
    // selection (which keys off its nullability) would consider the row done
    // and never regenerate the summary. Fall through to the retryable branch
    // below — the real image is still persisted there, bounded by the existing
    // MAX_MEDIA_ATTEMPTS back-off so it can't loop forever.
    // Source spin (Task #937): persist whenever a spin was generated. A null spin
    // clears any previously stored value so outdated framing is not shown.
    const spinSet = sourceSpin !== null ? { sourceSpin } : { sourceSpin: null };
    if (shouldStampCuratedMediaDone(hasRealImage, hadRefusal, summaryUpgradeFailed)) {
      // Success: stamp media_scraped_at and clear the back-off counter so this
      // row is treated as fully enriched going forward.
      await db.update(curatedItems).set({
        ogImageUrl,
        summaryBullets: hasBullets ? summaryBullets : null,
        mediaScrapedAt: new Date(),
        lastMediaAttemptAt: new Date(),
        mediaAttemptCount: 0,
        ...kindSet,
        ...claimsSet,
        ...spinSet,
        ...summarySet,
        ...analysisCapSet,
      }).where(eq(curatedItems.id, curatedItemId));
      return;
    }
    // No real image yet (favicon-only, with or without bullets). Stamp a failed-
    // attempt marker (last_media_attempt_at + bump media_attempt_count) so the
    // prefetch/backfill back off this row instead of re-trying every cycle, and
    // FORCE media_scraped_at back to NULL (Task #166): a favicon-only result must
    // never count as enriched, so the row stays retryable on later cycles until
    // it gets a real image or hits MAX_MEDIA_ATTEMPTS. Explicitly clearing the
    // stamp also self-heals any legacy row that an older path wrongly stamped
    // done-with-favicon. Persist any bullets we did recover (so we don't
    // recompute them and the row still shows content) and the favicon fallback
    // image when present.
    await db.update(curatedItems).set({
      ...(ogImageUrl ? { ogImageUrl } : {}),
      ...(hasBullets ? { summaryBullets } : {}),
      ...(attributedClaims.length > 0 ? { attributedClaims } : {}),
      ...spinSet,
      mediaScrapedAt: null,
      lastMediaAttemptAt: new Date(),
      mediaAttemptCount: sql`${curatedItems.mediaAttemptCount} + 1`,
      ...kindSet,
      ...summarySet,
      ...analysisCapSet,
    }).where(eq(curatedItems.id, curatedItemId));
  } catch (error) {
    console.error(`[StreamPrefetch] Curated cache write failed for ${curatedItemId}:`, error);
  }
}

/**
 * Carry-over (Task #124): before spending any paywall/AI budget, look up each
 * curated item's article URL in the already-enriched main stores (headlines +
 * manual_submissions). When a REAL (non-favicon) ogImageUrl exists there, copy
 * it — plus summary bullets when present — into curated_items and stamp
 * media_scraped_at. This is a READ of the main stores only; the only writes go
 * to curated_items, preserving lane isolation. Returns the set of curated item
 * ids that were satisfied, so callers can skip the breaker for those.
 */
async function carryOverCuratedMedia(items: EnrichableItem[]): Promise<Set<string>> {
  const handled = new Set<string>();
  const urls = Array.from(new Set(items.map(i => i.url).filter(Boolean)));
  if (urls.length === 0) return handled;

  const media = new Map<string, { ogImageUrl: string; summaryBullets: string[] | null; contentKind: string | null; attributedClaims: string[] | null; summary: string | null }>();
  const absorb = (rows: { url: string; ogImageUrl: string | null; summaryBullets: string[] | null; contentKind: string | null; attributedClaims: string[] | null; summary?: string | null }[]) => {
    for (const r of rows) {
      if (!r.url || media.has(r.url)) continue;
      if (!r.ogImageUrl || isFaviconUrl(r.ogImageUrl)) continue;
      media.set(r.url, { ogImageUrl: r.ogImageUrl, summaryBullets: r.summaryBullets ?? null, contentKind: r.contentKind ?? null, attributedClaims: r.attributedClaims ?? null, summary: r.summary ?? null });
    }
  };

  try {
    absorb(await db.select({
      url: headlines.url,
      ogImageUrl: headlines.ogImageUrl,
      summaryBullets: headlines.summaryBullets,
      contentKind: headlines.contentKind,
      attributedClaims: headlines.attributedClaims,
      summary: headlines.summary,
    }).from(headlines).where(inArray(headlines.url, urls)));

    const missing = urls.filter(u => !media.has(u));
    if (missing.length > 0) {
      absorb(await db.select({
        url: manualSubmissions.url,
        ogImageUrl: manualSubmissions.ogImageUrl,
        summaryBullets: manualSubmissions.summaryBullets,
        contentKind: manualSubmissions.contentKind,
        attributedClaims: manualSubmissions.attributedClaims,
        summary: manualSubmissions.summary,
      }).from(manualSubmissions).where(inArray(manualSubmissions.url, missing)));
    }
  } catch (error) {
    console.error(`[StreamPrefetch:Curated] Carry-over lookup failed:`, error);
    return handled;
  }

  for (const item of items) {
    const found = media.get(item.url);
    if (!found) continue;
    // Carry the content-kind flag too so an audio story cloned from the main
    // stores keeps its 'audio' marking (otherwise it could slip back into the
    // curated standalone feed unflagged). Also carry summary so an upgraded
    // main-lane summary reaches the curated copy in the same pass.
    const carriedSummary = found.summary && found.summary.trim().length > 10 ? found.summary : null;
    await cacheCuratedItemMedia(item.id, found.ogImageUrl, found.summaryBullets ?? [], (found.contentKind as 'audio' | 'article' | 'opinion' | 'explainer' | null) ?? null, found.attributedClaims ?? [], false, carriedSummary);
    handled.add(item.id);
  }

  if (handled.size > 0) {
    console.log(`[StreamPrefetch:Curated] Carried over media for ${handled.size} item(s) from main stores`);
  }
  return handled;
}

function curatedItemToEnrichable(c: {
  id: string; url: string; title: string; source?: string | null;
  ogImageUrl: string | null; summaryBullets: string[] | null; mediaScrapedAt: Date | null;
  mediaAttemptCount?: number | null; lastMediaAttemptAt?: Date | null;
}): EnrichableItem {
  return {
    id: c.id,
    url: c.url,
    title: c.title,
    source: c.source ?? null,
    ogImageUrl: c.ogImageUrl,
    summaryBullets: c.summaryBullets ?? null,
    mediaScrapedAt: c.mediaScrapedAt,
    mediaAttemptCount: c.mediaAttemptCount ?? 0,
    lastMediaAttemptAt: c.lastMediaAttemptAt ?? null,
    kind: 'curated',
  };
}

/**
 * Dead-link replacement overlay (Task #226). Redirect each curated enrichable's
 * URL to its allowlist-supplied replacement (keyed `curated:<id>`) so carry-over,
 * the paywall breaker, and AI bullets all re-fetch from the WORKING URL — without
 * mutating curated_items.url (clustering identity stays stable). No-op when no
 * replacement exists. Mutates in place and returns the same array for chaining.
 */
async function applyCuratedLinkReplacements(items: EnrichableItem[]): Promise<EnrichableItem[]> {
  if (items.length === 0) return items;
  try {
    const { storage } = await import('./storage');
    const replacements = await storage.getCuratedLinkReplacements();
    if (replacements.size === 0) return items;
    for (const it of items) {
      const repl = replacements.get(`curated:${it.id}`);
      if (repl) it.url = repl;
    }
  } catch (error) {
    console.error('[StreamPrefetch:Curated] Link-replacement overlay lookup failed:', error);
  }
  return items;
}

async function enrichCuratedBatch(items: EnrichableItem[], label: string, perItemTimeoutMs: number = PER_ITEM_TIMEOUT_MS): Promise<{
  enhanced: number; skipped: number; failed: number; carried: number;
}> {
  let enhanced = 0;
  let skipped = 0;
  let failed = 0;

  // Flag social posts once per batch (Task #354) so enrichOneItem skips the
  // forced 3-bullet summary + attributed-claims for them. Resolved via the
  // Outlet Registry (same path the cluster engine uses). Best-effort: if the
  // registry can't be read, items stay non-social and behave as before.
  try {
    const { storage } = await import('./storage');
    const registry = await storage.getOutletRegistry();
    const idx = buildOutletIndex(registry);
    for (const it of items) {
      const outlet = findOutlet(idx, it.source ?? '', it.url);
      it.isSocial = isSocialFlashOutlet(outlet);
    }
  } catch (error) {
    console.error(`[StreamPrefetch:${label}] social-flag resolution failed:`, (error as Error).message);
  }

  const carried = await carryOverCuratedMedia(items);
  const remaining = items.filter(i => !carried.has(i.id));

  for (const item of remaining) {
    try {
      const itemTimeoutMs = isHardBlockedOutlet(item.url) ? HARD_BLOCKED_PER_ITEM_TIMEOUT_MS : perItemTimeoutMs;
      const result = await withTimeout(enrichOneItem(item), itemTimeoutMs, item.title?.substring(0, 50) || item.id);
      if (result === 'enhanced') enhanced++;
      else if (result === 'skipped') skipped++;
    } catch (error: any) {
      failed++;
      console.error(`[StreamPrefetch:${label}] Error processing "${item.title?.substring(0, 50)}":`, error?.message || error);
      // Back-off stamp on the EXCEPTION path (Task #1088). enrichOneItem stamps
      // failed attempts internally, but a throw/timeout (withTimeout expiring on
      // a hard-blocked host, a breaker exception mid-chain) used to leave the
      // row completely unstamped — attempt_count stayed 0 forever, so the same
      // permanently-failing rows re-entered every prefetch/backfill scan and
      // burned the paywall budget indefinitely. Best-effort: a failed stamp
      // never masks the original error. Curated rows only (main-feed rows keep
      // their existing semantics untouched).
      if (item.kind === 'curated') {
        try {
          await db.update(curatedItems)
            .set({
              lastMediaAttemptAt: new Date(),
              mediaAttemptCount: sql`LEAST(${curatedItems.mediaAttemptCount} + 1, ${MAX_MEDIA_ATTEMPTS})`,
            })
            .where(and(eq(curatedItems.id, item.id), isNull(curatedItems.mediaScrapedAt)));
        } catch (stampError: any) {
          console.error(`[StreamPrefetch:${label}] Back-off stamp failed for "${item.title?.substring(0, 50)}":`, stampError?.message || stampError);
        }
      }
    }
  }
  return { enhanced, skipped, failed, carried: carried.size };
}

/**
 * Event-driven fast-path for freshly-admitted hard-blocked curated rows (Task
 * #644). Bloomberg/Reuters gate-mode rows previously had to wait for the next
 * recurring prefetch/backfill cron (~10 min) before their first enrichment
 * attempt. Called right after admitCuratedCandidates inserts new hard-blocked
 * rows so they get a real photo + AI summary within ~1-2 min instead. Shares
 * the stream-media worker mutex (never runs concurrently with the main feed or
 * other curated passes) and is a best-effort fire-and-forget call — if the
 * mutex is busy this simply no-ops and the row is picked up by the next
 * priority-sorted recurring pass (which now sorts hard-blocked rows first), so
 * nothing is lost, only delayed. Curated lane only; writes only to
 * curated_items via the same cacheCuratedItemMedia path as every other pass.
 */
export async function enrichFreshHardBlockedCurated(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (!tryAcquireWorker('curated-fresh-hardblocked')) return;
  try {
    const { storage } = await import('./storage');
    const rows = await storage.getCuratedItemsByIds(ids);
    const candidates = Array.from(rows.values()).filter(c => {
      if (!isHardBlockedOutlet(c.url)) return false;
      const hasCachedMedia = !!c.mediaScrapedAt &&
        !isFaviconUrl(c.ogImageUrl) &&
        (!!c.ogImageUrl || (!!c.summaryBullets && c.summaryBullets.length > 0));
      return !hasCachedMedia;
    });
    if (candidates.length === 0) return;
    const items = await applyCuratedLinkReplacements(candidates.map(curatedItemToEnrichable));
    const { enhanced, skipped, failed, carried } = await enrichCuratedBatch(items, 'CuratedFreshHardBlocked', HARD_BLOCKED_PER_ITEM_TIMEOUT_MS);
    console.log(`[StreamPrefetch:CuratedFreshHardBlocked] Done — candidates: ${items.length}, carried: ${carried}, enhanced: ${enhanced}, skipped: ${skipped}, failed: ${failed}`);
  } catch (error) {
    console.error('[StreamPrefetch:CuratedFreshHardBlocked] failed (non-fatal):', error);
  } finally {
    releaseWorker();
  }
}

/**
 * Curated-lane prefetch (Task #124). Enriches the most-visible curated_items
 * (the highest-priority rows that surface as left-column Top Narratives and the
 * ranked curated cards). Carry-over runs first; only the leftover rows hit the
 * paywall breaker. Shares the stream-media worker mutex so curated and main-feed
 * enrichment never run concurrently.
 */
export async function prefetchCuratedMedia(topN = 14) {
  if (!tryAcquireWorker('curated-prefetch')) return;
  try {
    const { storage } = await import('./storage');
    // getCuratedStoreItems returns rows already sorted by priority desc, so the
    // top slice is exactly the curated window the reader surfaces first.
    const curated = await storage.getCuratedStoreItems(18);
    // Skip born-complete rows (Task #202): rows already carrying a REAL
    // (non-favicon) image + a media_scraped_at stamp (with an image or bullets)
    // are fully enriched — many now arrive that way from inline ingest
    // pre-enrichment. Excluding them BEFORE taking the top slice means the
    // worker's budget goes to rows that genuinely still need a fetch instead of
    // being spent re-confirming complete rows. Mirrors enrichOneItem's
    // hasCachedMedia skip. Curated-only; the main-feed prefetch is untouched.
    const needsEnrichment = curated.filter(c => {
      const hasCachedMedia = c.mediaScrapedAt &&
        !isFaviconUrl(c.ogImageUrl) &&
        (c.ogImageUrl || (c.summaryBullets && c.summaryBullets.length > 0));
      if (hasCachedMedia) return false;
      // Back-off exclusion (Task #1022): rows currently inside their escalating
      // back-off window (or at the hard attempt cap) would only be skipped by
      // enrichOneItem anyway — excluding them BEFORE the top-N slice stops them
      // from consuming slots that recoverable rows could use. Mirrors the SQL
      // back-off filter the backfill already applies (staleCuratedMediaFilters).
      return !isCuratedMediaBackedOff(c.mediaAttemptCount, c.lastMediaAttemptAt);
    });
    // Priority-first hard-blocked ordering (Task #644): hard-blocked outlets
    // (Bloomberg/Reuters) need the paywall2 breaker, which now runs on a longer
    // budget (see HARD_BLOCKED_PER_ITEM_TIMEOUT_MS/CURATED_PAYWALL2_TIMEOUT_MS).
    // If they were left in plain priority-score order, a burst of fresh
    // hard-blocked rows could still be crowded out of this bounded topN slice
    // by higher-scored non-hard-blocked rows. A stable sort that promotes
    // hard-blocked rows to the front (while preserving their relative priority
    // order, and the priority order of everything else) guarantees they always
    // get a slot in this pass before it falls back to age-out via backfill.
    needsEnrichment.sort((a, b) => {
      const aHard = isHardBlockedOutlet(a.url) ? 0 : 1;
      const bHard = isHardBlockedOutlet(b.url) ? 0 : 1;
      return aHard - bHard;
    });
    const top = needsEnrichment.slice(0, topN);
    const items = await applyCuratedLinkReplacements(top.map(curatedItemToEnrichable));
    if (items.length === 0) return;

    const { enhanced, skipped, failed, carried } = await enrichCuratedBatch(items, 'CuratedPrefetch');
    if (enhanced > 0 || carried > 0 || failed > 0) {
      console.log(`[StreamPrefetch:CuratedPrefetch] Done — carried: ${carried}, enhanced: ${enhanced}, skipped: ${skipped}, failed: ${failed}`);
    }
  } finally {
    releaseWorker();
  }
}

/**
 * The exact set of WHERE conditions the curated backfill uses to pick rows that
 * still need media (back-off). Extracted so the isolation harness can
 * assert the back-off filter excludes/includes a row WITHOUT having to run the
 * network-bound enrichment that follows — and so the harness can never drift
 * from the real query (it imports these conditions, it does not re-implement
 * them). The `cutoff` recency window is OWNED here (first condition below),
 * with a rescue-marker exemption baked in; callers pass the cutoff and combine
 * with `and(...)`, adding only any extra constraints of their own.
 */
export function staleCuratedMediaFilters(cutoff: Date) {
  return [
    // Recency window — a row is normally only re-scanned while it is young
    // enough to still be in the live window. EXCEPTION (Task #339 rescue heal):
    // a row stamped with media_rescue_at is a frozen-at-the-cap row that the
    // one-time boot rescue unfroze (counters reset to 0). Those rows are
    // typically ~25h old by the time the rescue lands, so the plain scrapedAt
    // window can never reach them and they'd age out un-rescued. Exempt them
    // from the window so the recurring backfill drives the single fresh
    // enrichment pass the rescue intends. Cap-preservation still holds: a
    // rescued row that re-fails climbs back to MAX_MEDIA_ATTEMPTS via the
    // back-off filter below and then drops out for good (it is rescued once).
    or(
      gte(curatedItems.scrapedAt, cutoff),
      isNotNull(curatedItems.mediaRescueAt),
    ),
    // Re-attempt rows that were never enriched (NULL media_scraped_at) AND
    // rows that an older path wrongly stamped done-with-favicon (Task #166):
    // a favicon is a placeholder, not a real photo, so those rows must keep
    // being retried (bounded by the back-off + MAX_MEDIA_ATTEMPTS below)
    // until they get a real image. Mirrors the favicon detection in
    // isFaviconUrl / enrichOneItem's hasCachedMedia check.
    //
    // Also re-attempts rows stuck on a raw sphdigital.com.sg CDN URL: prior to
    // the dimension-based logo detector the 20 KB byte threshold wrongly rejected
    // small real WebP photos (~14.9 KB), leaving those rows stamped media_scraped_at
    // with the un-persisted CDN URL instead of an /objects/… path. Those rows
    // are now retryable so the corrected detector can re-enrich them.
    or(
      isNull(curatedItems.mediaScrapedAt),
      // Mirror of shared/placeholderImage.ts PLACEHOLDER_IMAGE_PATTERNS (Postgres
      // cannot import the JS regexes). Favicons + brand logos + outlet generic
      // "default / share" placeholders (ABC's abc_news_default_*, and the generic
      // _default_<W>x<H> square brand default) all count as "no real photo" and
      // must keep being retried. Keep in sync with that file.
      // The sphdigital.com.sg check heals rows whose real photo was previously
      // wrongly rejected by the old byte-size gate and left pointing at the raw CDN URL.
      sql`(${curatedItems.ogImageUrl} LIKE '%gstatic.com/faviconV2%' OR ${curatedItems.ogImageUrl} LIKE '%logo.clearbit.com%' OR ${curatedItems.ogImageUrl} LIKE '%abc_news_default%' OR ${curatedItems.ogImageUrl} ~* '[-_/]default[-_][0-9]+x[0-9]+' OR ${curatedItems.ogImageUrl} LIKE '%media.npr.org/include/images/facebook-default%' OR ${curatedItems.ogImageUrl} LIKE '%sphdigital.com.sg%')`,
    ),
    // Back-off (Task #132): skip rows that have failed too many times, and
    // rows whose last failed attempt is still inside the escalating
    // back-off window (attemptCount * 30 min). Rows never attempted
    // (attemptCount = 0, last_media_attempt_at NULL) always pass.
    sql`${curatedItems.mediaAttemptCount} < ${MAX_MEDIA_ATTEMPTS}`,
    sql`(${curatedItems.lastMediaAttemptAt} IS NULL OR ${curatedItems.lastMediaAttemptAt} < now() - (${curatedItems.mediaAttemptCount} * ${sql.raw(MEDIA_BACKOFF_BASE_SQL_INTERVAL)}))`,
  ];
}

/**
 * Curated-lane backfill (Task #124). Repairs curated_items that scrolled out of
 * the live prefetch window before they were enriched — any recent row with a
 * NULL media_scraped_at, plus rows wrongly stamped done-with-favicon (Task #166)
 * so a placeholder favicon keeps getting upgraded to a real photo. Writes ONLY
 * to curated_items.
 */
export async function backfillStaleCuratedMedia(hoursBack = 48, maxItems = 40): Promise<{
  scanned: number; enhanced: number; skipped: number; failed: number; carried: number;
}> {
  if (!tryAcquireWorker('curated-backfill')) {
    return { scanned: 0, enhanced: 0, skipped: 0, failed: 0, carried: 0 };
  }
  try {
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const stale = await db.select({
      id: curatedItems.id,
      url: curatedItems.url,
      title: curatedItems.title,
      source: curatedItems.source,
      ogImageUrl: curatedItems.ogImageUrl,
      summaryBullets: curatedItems.summaryBullets,
      mediaScrapedAt: curatedItems.mediaScrapedAt,
      mediaAttemptCount: curatedItems.mediaAttemptCount,
      lastMediaAttemptAt: curatedItems.lastMediaAttemptAt,
    })
      .from(curatedItems)
      .where(and(...staleCuratedMediaFilters(cutoff)))
      // Priority-first hard-blocked ordering (Task #644): mirrors
      // prefetchCuratedMedia — a rescued/aged Bloomberg/Reuters row should not
      // sit behind maxItems worth of other stale rows every 10-min tick, since
      // it's exactly the backlog this backfill is relied on to clear.
      .orderBy(sql`CASE WHEN ${curatedItems.url} ~* 'bloomberg\\.com|reuters\\.com' THEN 0 ELSE 1 END`, desc(curatedItems.scrapedAt))
      .limit(maxItems);

    const items = await applyCuratedLinkReplacements(stale.map(curatedItemToEnrichable));
    if (items.length === 0) {
      return { scanned: 0, enhanced: 0, skipped: 0, failed: 0, carried: 0 };
    }

    console.log(`[StreamPrefetch:CuratedBackfill] Scanning ${items.length} stale curated items (last ${hoursBack}h)`);
    const { enhanced, skipped, failed, carried } = await enrichCuratedBatch(items, 'CuratedBackfill');
    console.log(`[StreamPrefetch:CuratedBackfill] Done — scanned: ${items.length}, carried: ${carried}, enhanced: ${enhanced}, skipped: ${skipped}, failed: ${failed}`);
    return { scanned: items.length, enhanced, skipped, failed, carried };
  } finally {
    releaseWorker();
  }
}

/**
 * Task #933 backfill — recovers the real original-publish date for ALREADY
 * ENRICHED curated rows that still carry a null article_published_at (the card
 * shows "First seen"). New/un-enriched rows get their date recovered for free
 * during normal media enrichment (enrichOneItem reuses the article HTML it
 * already fetched), so this pass deliberately targets only rows that will NOT be
 * re-enriched — media_scraped_at IS NOT NULL AND article_published_at IS NULL —
 * to avoid double-fetching. It DOES re-fetch each page (the enrichment HTML
 * wasn't kept), bounded by window + maxItems, and mines ONLY the trusted
 * structured original-publish signals (same extractor as ingest/enrichment;
 * generic/updated tags excluded per Task #653). Writes are NULL-guarded
 * (WHERE article_published_at IS NULL) so an upstream/human date is never
 * clobbered. Social rows are skipped (their post timestamp already fills the
 * field and their URLs carry no article JSON-LD). Curated-lane only; fail-open.
 */
export async function backfillCuratedPublishedDates(hoursBack = 48, maxItems = 40): Promise<{
  scanned: number; recovered: number; skipped: number; failed: number;
}> {
  if (!tryAcquireWorker('curated-pubdate-backfill')) {
    return { scanned: 0, recovered: 0, skipped: 0, failed: 0 };
  }
  try {
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    // Heal already-persisted clock/timezone mistakes before selecting the normal
    // null-date backlog. Ranking already falls back to first-seen for these rows,
    // but enrichment and other workers must not keep observing the raw future
    // instant. The row remains eligible below for a trustworthy page-date
    // recovery; if the page repeats the bad future value it honestly stays null.
    await db.update(curatedItems)
      .set({
        articlePublishedAt: null,
        pubdateAttemptCount: 0,
        lastPubdateAttemptAt: null,
      })
      // Deliberately NOT scoped by scrapedAt: an old row with an absurd
      // far-future publication value would otherwise survive forever and remain
      // visible to any raw-date worker. Only the subsequent network recovery
      // scan is bounded to the recent live window.
      .where(gt(curatedItems.articlePublishedAt, new Date()));
    // Back-off filter (Task #1088): mirror the media-enrichment back-off so the
    // same unrecoverable rows (blocked hosts, pages with no trusted structured
    // date signal) stop being re-fetched every 15-min cron pass. A row is
    // eligible when it has never been attempted, or its escalating back-off
    // window (attemptCount * 30 min) has elapsed — and it drops out permanently
    // at MAX_PUBDATE_ATTEMPTS. Never-attempted rows are scanned first.
    const rows = await db.select({
      id: curatedItems.id,
      url: curatedItems.url,
      source: curatedItems.source,
      pubdateAttemptCount: curatedItems.pubdateAttemptCount,
    })
      .from(curatedItems)
      .where(and(
        isNull(curatedItems.articlePublishedAt),
        isNotNull(curatedItems.mediaScrapedAt),
        gte(curatedItems.scrapedAt, cutoff),
        sql`${curatedItems.pubdateAttemptCount} < ${MAX_PUBDATE_ATTEMPTS}`,
        sql`(${curatedItems.lastPubdateAttemptAt} IS NULL OR ${curatedItems.lastPubdateAttemptAt} < NOW() - (${curatedItems.pubdateAttemptCount} * ${sql.raw(MEDIA_BACKOFF_BASE_SQL_INTERVAL)}))`,
      ))
      .orderBy(sql`${curatedItems.lastPubdateAttemptAt} ASC NULLS FIRST`, desc(curatedItems.scrapedAt))
      .limit(maxItems);

    if (rows.length === 0) {
      return { scanned: 0, recovered: 0, skipped: 0, failed: 0 };
    }

    // Skip social rows (X / Truth Social / DataMinr): their post timestamp
    // already populates article_published_at, and their URLs carry no article
    // JSON-LD, so a fetch would only waste budget. Best-effort registry lookup;
    // if the registry can't be read, fall through and treat every row as an
    // article (fail-open — the trusted-signal extractor simply finds nothing).
    let isSocialUrl: (source: string | null | undefined, url: string) => boolean = () => false;
    try {
      const registry = await storage.getOutletRegistry();
      const idx = buildOutletIndex(registry);
      isSocialUrl = (source, url) => isSocialFlashOutlet(findOutlet(idx, source ?? '', url));
    } catch (error) {
      console.error(`[StreamPrefetch:CuratedPubDate] social-flag resolution failed:`, (error as Error).message);
    }

    let recovered = 0;
    let skipped = 0;
    let failed = 0;
    let scanned = 0;
    // Failure stamp: bump the attempt counter + timestamp so the back-off filter
    // above skips this row for attemptCount * 30 min (permanently at the cap).
    // `toCap` short-circuits hosts that a plain fetch can NEVER recover from
    // (hard-blocked outlets + hosts observed to reject/timeout from this infra)
    // straight to the cap. Best-effort — a failed stamp only costs one extra
    // future scan.
    const stampAttempt = async (id: string, toCap = false) => {
      try {
        await db.update(curatedItems)
          .set({
            lastPubdateAttemptAt: new Date(),
            pubdateAttemptCount: toCap
              ? MAX_PUBDATE_ATTEMPTS
              : sql`LEAST(${curatedItems.pubdateAttemptCount} + 1, ${MAX_PUBDATE_ATTEMPTS})`,
          })
          .where(eq(curatedItems.id, id));
      } catch {
        // best-effort
      }
    };
    for (const row of rows) {
      if (isSocialUrl(row.source, row.url)) {
        // Social rows never carry article JSON-LD — cap immediately so they
        // stop re-entering the candidate scan every pass.
        skipped++;
        await stampAttempt(row.id, true);
        continue;
      }
      // Known-blocked hosts: hard-blocked outlets (same chokepoint media
      // enrichment uses) plus hosts observed to consistently reject or time out
      // plain fetches from this infrastructure. A plain 8s fetch can never
      // succeed — cap immediately instead of burning a fetch per pass.
      if (isHardBlockedOutlet(row.url) || isPubdateBlockedHost(row.url)) {
        skipped++;
        await stampAttempt(row.id, true);
        continue;
      }
      scanned++;
      try {
        const response = await safeFetch(row.url, {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        });
        if (!response.ok) { failed++; await stampAttempt(row.id); continue; }
        const html = await response.text();
        const { publishedAt } = parseTimestampsFromHtmlString(html);
        // Page fetched fine but carries no trusted/plausible structured date —
        // a permanent property of the page, not a transient failure. Stamp it
        // so it backs off exactly like a fetch failure.
        if (!isPlausiblePublishedDate(publishedAt)) { skipped++; await stampAttempt(row.id); continue; }
        const res = await db.update(curatedItems)
          .set({ articlePublishedAt: publishedAt })
          .where(and(eq(curatedItems.id, row.id), isNull(curatedItems.articlePublishedAt)));
        // rowCount is populated by the pg driver; count a recovery only on a
        // strictly positive value (the NULL-guard makes a concurrent set a
        // harmless no-op; an absent rowCount stays uncounted rather than
        // over-reporting). Telemetry only — the write itself is authoritative.
        if (((res as unknown as { rowCount?: number }).rowCount ?? 0) > 0) recovered++;
      } catch {
        failed++;
        await stampAttempt(row.id);
      }
    }
    if (recovered > 0 || failed > 0) {
      console.log(`[StreamPrefetch:CuratedPubDate] Done — scanned: ${scanned}, recovered: ${recovered}, skipped: ${skipped}, failed: ${failed} (candidates ${rows.length}, last ${hoursBack}h)`);
    }
    return { scanned, recovered, skipped, failed };
  } finally {
    releaseWorker();
  }
}

/**
 * Task #650 backfill — heals curated rows that were enriched BEFORE the
 * page-labeled opinion/analysis signal existed. Those rows already passed
 * through `detectPageOpinionAnalysis` returning false (the old code path),
 * so they are stamped `content_kind = 'article'` even though the page may
 * carry an ANALYSIS/OPINION structured signal. Unlike normal enrichment,
 * this DOES re-fetch the page (the original HTML wasn't kept) — a bounded,
 * curated-lane-only, one-time-ish re-scan, never touching the main feed.
 * Only ever upgrades 'article' -> 'opinion'; never downgrades or touches any
 * other field (image/bullets/media_scraped_at untouched), so it can't regress
 * a previously-enriched row or race the normal prefetch/backfill cycle.
 */
export async function backfillCuratedOpinionAnalysis(hoursBack = 24 * 14, maxItems = 25): Promise<{
  scanned: number; flagged: number; failed: number;
}> {
  if (!tryAcquireWorker('curated-opinion-backfill')) {
    return { scanned: 0, flagged: 0, failed: 0 };
  }
  try {
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const candidates = await db.select({
      id: curatedItems.id,
      url: curatedItems.url,
    })
      .from(curatedItems)
      .where(and(
        eq(curatedItems.contentKind, 'article'),
        isNotNull(curatedItems.mediaScrapedAt),
        gte(curatedItems.scrapedAt, cutoff),
      ))
      .orderBy(desc(curatedItems.scrapedAt))
      .limit(maxItems);

    if (candidates.length === 0) {
      return { scanned: 0, flagged: 0, failed: 0 };
    }

    let flagged = 0;
    let failed = 0;
    for (const c of candidates) {
      try {
        const response = await safeFetch(c.url, {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        });
        if (!response.ok) continue;
        const html = await response.text();
        if (detectPageOpinionAnalysis(html)) {
          await db.update(curatedItems)
            .set({ contentKind: 'opinion' })
            .where(and(eq(curatedItems.id, c.id), eq(curatedItems.contentKind, 'article')));
          flagged++;
        }
      } catch {
        failed++;
      }
    }
    console.log(`[StreamPrefetch:CuratedOpinionBackfill] Scanned ${candidates.length} — flagged: ${flagged}, failed: ${failed}`);
    return { scanned: candidates.length, flagged, failed };
  } finally {
    releaseWorker();
  }
}

/**
 * Task #677 backfill — heals curated NPR rows that were enriched BEFORE the
 * "HEARD ON <program>" / "Audio will be available later today" broadcast
 * signals existed. Those rows already passed through `detectPageContentKind`
 * returning 'article' (the old code path), so a freshly-posted radio segment
 * whose .mp3 wasn't live yet got stamped `content_kind = 'article'` and
 * seeded as a standalone Top Story. Re-fetches the page (the original HTML
 * wasn't kept) — a bounded, curated-lane-only, one-time-ish re-scan, never
 * touching the main feed. Only ever upgrades 'article' -> 'audio'; never
 * downgrades or touches any other field (image/bullets/media_scraped_at
 * untouched), so it can't regress a previously-enriched row.
 */
export async function backfillCuratedNprAudioSegments(hoursBack = 24 * 14, maxItems = 25): Promise<{
  scanned: number; flagged: number; failed: number;
}> {
  if (!tryAcquireWorker('curated-npr-audio-backfill')) {
    return { scanned: 0, flagged: 0, failed: 0 };
  }
  try {
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const candidates = await db.select({
      id: curatedItems.id,
      url: curatedItems.url,
    })
      .from(curatedItems)
      .where(and(
        eq(curatedItems.contentKind, 'article'),
        isNotNull(curatedItems.mediaScrapedAt),
        gte(curatedItems.scrapedAt, cutoff),
        sql`lower(${curatedItems.url}) LIKE '%npr.org%'`,
      ))
      .orderBy(desc(curatedItems.scrapedAt))
      .limit(maxItems);

    if (candidates.length === 0) {
      return { scanned: 0, flagged: 0, failed: 0 };
    }

    let flagged = 0;
    let failed = 0;
    for (const c of candidates) {
      try {
        const response = await safeFetch(c.url, {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        });
        if (!response.ok) continue;
        const html = await response.text();
        if (detectPageContentKind(html, c.url) === 'audio') {
          await db.update(curatedItems)
            .set({ contentKind: 'audio' })
            .where(and(eq(curatedItems.id, c.id), eq(curatedItems.contentKind, 'article')));
          flagged++;
        }
      } catch {
        failed++;
      }
    }
    console.log(`[StreamPrefetch:CuratedNprAudioBackfill] Scanned ${candidates.length} — flagged: ${flagged}, failed: ${failed}`);
    return { scanned: candidates.length, flagged, failed };
  } finally {
    releaseWorker();
  }
}

// A redundant second implementation of backfillCuratedPublishedDates (both from
// Task #933) was removed during the rebase onto main — the earlier variant above
// (media_scraped_at-targeted, social-skipping) is the one scheduler.ts calls.

// Dead-link liveness (Task #226). Only these HTTP statuses count as a GENUINELY
// dead article — the resource is gone. Everything else (5xx, 403, 429, 408,
// timeouts, network errors) is transient/inconclusive and must NEVER flag a row.
const DEAD_LINK_STATUSES = new Set([404, 410]);
const LINK_LIVENESS_TIMEOUT_MS = 12 * 1000;
// Realistic browser headers so well-behaved outlets don't bot-block the probe
// with a 403 (which we'd treat as inconclusive and never resolve). A real 404/410
// is still returned with these headers.
const LIVENESS_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Probe ONE URL for liveness. Follows redirects, uses a bounded timeout, and
 * cancels the body immediately (FD hygiene — we only need the final status).
 * Returns 'dead' ONLY on a confirmed HTTP 404/410; 'alive' on any 2xx; and
 * 'unknown' for every transient/inconclusive outcome (other 4xx like 403/429,
 * all 5xx, timeouts, network errors). A paywall that returns 200 is 'alive' —
 * the article still exists, so it must never be flagged.
 */
async function probeLinkLiveness(url: string): Promise<'dead' | 'alive' | 'unknown'> {
  try {
    const res = await safeFetch(url, {
      method: 'GET',
      headers: LIVENESS_HEADERS,
      signal: AbortSignal.timeout(LINK_LIVENESS_TIMEOUT_MS),
    });
    // Free the connection right away; we never read the body.
    try { await res.body?.cancel(); } catch { /* body may be null/locked */ }
    if (DEAD_LINK_STATUSES.has(res.status)) return 'dead';
    if (res.status >= 200 && res.status < 300) return 'alive';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Curated-lane dead-link liveness cron (Task #226). Round-robins recent
 * curated_items (oldest-checked first), probes each row's EFFECTIVE URL
 * (allowlist replacement ?? stored url), and records the result:
 *   - confirmed HTTP 404/410 → stamp link_dead_at (the Curated view then shows a
 *     "link unavailable" state + an allowlisted Replace control); the row KEEPS
 *     all metadata and cluster membership, and the flag is IGNORED by clustering.
 *   - 2xx → clear link_dead_at (revival).
 *   - transient (5xx/403/429/timeout/network) → leave the flag untouched.
 * Archive snapshots (archive.is/.ph/.org) and SSRF-unsafe / non-public URLs are
 * never probed — they're just marked checked so the round-robin advances.
 * Writes ONLY to curated_items (lane isolation). Bounded per tick.
 */
export async function checkCuratedLinkLiveness(hoursBack = 36, maxItems = 30): Promise<{
  checked: number; dead: number; revived: number;
}> {
  const { storage } = await import('./storage');
  const [items, replacements] = await Promise.all([
    storage.getCuratedItemsForLinkCheck(hoursBack, maxItems),
    storage.getCuratedLinkReplacements(),
  ]);
  let checked = 0, dead = 0, revived = 0;
  for (const it of items) {
    const url = replacements.get(`curated:${it.id}`) ?? it.url;
    const isArchiveUrl = url.includes('archive.is') || url.includes('archive.ph') || url.includes('archive.org/');
    if (isArchiveUrl || !(await isPublicFetchableUrl(url))) {
      await storage.recordCuratedLinkCheck(it.id, 'unknown');
      checked++;
      continue;
    }
    const result = await probeLinkLiveness(url);
    if (result === 'dead' && !it.linkDeadAt) dead++;
    else if (result === 'alive' && it.linkDeadAt) revived++;
    await storage.recordCuratedLinkCheck(it.id, result);
    checked++;
  }
  if (dead > 0 || revived > 0) {
    console.log(`[StreamPrefetch:CuratedLiveness] Checked ${checked} curated link(s) — ${dead} newly dead, ${revived} revived`);
  }
  return { checked, dead, revived };
}

/**
 * Scoring Radar (Task #834) — editor-initiated one-shot enrichment for a
 * single curated item that failed the content-completeness seeding gate.
 * Called when an editor promotes a 'not-enriched' item from the Scoring Radar
 * panel, so the item has a chance to clear the gate on the next clustering pass.
 * Fail-soft: enrichment errors are swallowed so the promote action always
 * succeeds. Intended to run fire-and-forget (caller does not await).
 *
 * Lifecycle status: the fire-and-forget run records an in-memory
 * pending → succeeded/failed status per item so the radar panel can show an
 * HONEST rescue state instead of an optimistic toast. Per-process is correct
 * here — the deploy is a single-instance VM (see curated-cache-deploy-topology)
 * and the status is a short-lived UI hint, not durable state; the durable
 * back-off signal stays in curated_items.media_attempt_count /
 * last_media_attempt_at. Bounded map (TTL + max size) so it can never grow
 * unbounded.
 */
type RadarRescueState = { status: 'pending' | 'succeeded' | 'failed'; at: number };
const radarRescueStatus = new Map<string, RadarRescueState>();
const RADAR_RESCUE_TTL_MS = 30 * 60 * 1000; // 30 min — a rescue verdict is stale after that
const RADAR_RESCUE_MAX = 300;

function pruneRadarRescueStatus(): void {
  const cutoff = Date.now() - RADAR_RESCUE_TTL_MS;
  for (const [k, v] of Array.from(radarRescueStatus)) {
    if (v.at < cutoff) radarRescueStatus.delete(k);
  }
  // Map preserves insertion order — evict oldest entries beyond the cap.
  while (radarRescueStatus.size > RADAR_RESCUE_MAX) {
    const oldest = radarRescueStatus.keys().next().value;
    if (oldest == null) break;
    radarRescueStatus.delete(oldest);
  }
}

/** Read the one-shot rescue lifecycle status for a curated item (or null). */
export function getRadarRescueStatus(itemId: string): 'pending' | 'succeeded' | 'failed' | null {
  const v = radarRescueStatus.get(itemId);
  if (!v || Date.now() - v.at > RADAR_RESCUE_TTL_MS) return null;
  return v.status;
}

export async function triggerCuratedRadarEnrichment(itemId: string): Promise<void> {
  pruneRadarRescueStatus();
  radarRescueStatus.set(itemId, { status: 'pending', at: Date.now() });
  try {
    const items = await storage.getCuratedItemsByIds([itemId]);
    const row = items.get(itemId);
    if (!row) {
      radarRescueStatus.set(itemId, { status: 'failed', at: Date.now() });
      return;
    }
    const enrichable = curatedItemToEnrichable(row);
    const result = await enrichOneItem(enrichable);
    // 'enhanced' means the enrichment wrote SOMETHING, but the seeding gate only
    // clears when media_scraped_at was stamped (real non-favicon image + bullets)
    // — re-read the row so "succeeded" means "will actually pass the gate".
    let cleared = result === 'enhanced';
    if (cleared) {
      try {
        const after = await storage.getCuratedItemsByIds([itemId]);
        cleared = !!after.get(itemId)?.mediaScrapedAt;
      } catch {
        /* keep the result-based verdict when the re-read fails */
      }
    }
    radarRescueStatus.set(itemId, { status: cleared ? 'succeeded' : 'failed', at: Date.now() });
    console.log(`[StreamPrefetch:Radar] one-shot enrichment ${cleared ? 'complete' : 'did not clear the seeding gate'} for ${itemId}`);
  } catch (e: any) {
    radarRescueStatus.set(itemId, { status: 'failed', at: Date.now() });
    console.warn(`[StreamPrefetch:Radar] one-shot enrichment failed for ${itemId}:`, e?.message || e);
  }
}
