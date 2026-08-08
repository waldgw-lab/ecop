// =============================================================================
// Syndication publisher resolver (Task #1057).
//
// Yahoo News (news.yahoo.com / yahoo.com) is a syndication AGGREGATOR: the items
// it surfaces originate at AP, Reuters, and other real publishers, but the URL
// domain is yahoo.com. Attributing them to "Yahoo News" (an attach-only
// aggregator entry, Task #1052) hides the real corroborating wire service, which
// can affect whether an item contributes to curated story formation.
//
// This module detects the REAL publisher of a Yahoo-hosted article by inspecting
// its page meta / JSON-LD, so the "Yahoo News" registry entry is only the
// fallback of last resort. Curated-lane only — used by curated ingest before the
// outlet is resolved via the registry.
//
// The HTML extraction is a PURE function (extractSyndicatedPublisherFromHtml) so
// it can be exercised by saved fixtures without any network.
// =============================================================================
import * as cheerio from 'cheerio';
import { fetchWithResilience } from './resilientFetch';
import { findOutlet, type OutletIndex } from '@shared/outletRegistry';
import type { OutletRegistry } from '@shared/schema';

// Yahoo host detection. Only the yahoo.com family is treated as syndicated here;
// keep this narrow so we never re-attribute a first-party outlet's own article.
const YAHOO_HOST_RE = /(^|\.)yahoo\.com$/i;

export function isYahooSyndicationUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return YAHOO_HOST_RE.test(host);
  } catch {
    return false;
  }
}

// Names that are Yahoo itself (or too generic to be a real publisher). If the
// extracted "publisher" is one of these we treat the article as unresolved and
// fall back to the Yahoo News registry entry.
const YAHOO_SELF_NAMES = new Set([
  'yahoo',
  'yahoo news',
  'yahoo! news',
  'yahoo entertainment',
  'yahoo finance',
  'yahoo sports',
  'yahoo life',
]);

function isYahooSelfName(name: string): boolean {
  return YAHOO_SELF_NAMES.has(name.trim().toLowerCase());
}

// Walk arbitrarily-nested JSON-LD looking for an Organization name that names the
// syndicated provider. Yahoo's article JSON-LD carries the real publisher under
// `provider`, `publisher`, or `sourceOrganization`; `provider` is the most
// reliable so it is checked first.
function publisherFromJsonLd(node: unknown): string | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = publisherFromJsonLd(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  // @graph is a common JSON-LD wrapper.
  if (obj['@graph']) {
    const found = publisherFromJsonLd(obj['@graph']);
    if (found) return found;
  }

  for (const key of ['provider', 'publisher', 'sourceOrganization']) {
    const val = obj[key];
    const name = orgName(val);
    if (name && !isYahooSelfName(name)) return name;
  }
  return null;
}

// Pull a plausible Organization name out of a JSON-LD value (object, array, or
// bare string).
function orgName(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val.trim() || null;
  if (Array.isArray(val)) {
    for (const item of val) {
      const name = orgName(item);
      if (name) return name;
    }
    return null;
  }
  if (typeof val === 'object') {
    const name = (val as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

// PURE extraction: given an article page's HTML, return the real publisher name
// if one can be detected, else null. Never returns Yahoo's own name.
export function extractSyndicatedPublisherFromHtml(html: string): string | null {
  if (!html) return null;
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return null;
  }

  // 1. JSON-LD provider/publisher/sourceOrganization (most reliable).
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const el of scripts) {
    const raw = $(el).contents().text().trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const name = publisherFromJsonLd(parsed);
      if (name && !isYahooSelfName(name)) return name;
    } catch {
      // Malformed JSON-LD block — skip and try the next one.
    }
  }

  // 2. Yahoo's rendered provider attribution markup. Yahoo stamps the syndicated
  //    source into the article header (class names have shifted over time, so try
  //    the known variants) and, historically, a data-wf-provider attribute.
  const domSelectors = [
    '[data-wf-provider]',
    '.caas-attr-provider',
    '.provider-link',
    '.author .provider',
  ];
  for (const sel of domSelectors) {
    const el = $(sel).first();
    if (el.length === 0) continue;
    const attr = el.attr('data-wf-provider');
    const text = (attr && attr.trim()) || el.text().replace(/\s+/g, ' ').trim();
    if (text && !isYahooSelfName(text)) return text;
  }

  // 3. Meta-tag fallbacks. og:site_name / article:publisher on a Yahoo page are
  //    usually "Yahoo", but some syndicated pages carry the real source here.
  const metaCandidates = [
    $('meta[property="article:publisher"]').attr('content'),
    $('meta[name="provider"]').attr('content'),
    $('meta[property="og:site_name"]').attr('content'),
  ];
  for (const raw of metaCandidates) {
    const name = (raw || '').trim();
    if (name && !isYahooSelfName(name)) return name;
  }

  return null;
}

export interface ResolvedSyndication {
  // The registry outlet the real publisher resolved to (null if the extracted
  // name doesn't match any known outlet — caller keeps the Yahoo fallback then).
  outlet: OutletRegistry | undefined;
  // The raw publisher name extracted from the page (for logging), or null.
  publisherName: string | null;
}

// Fetch a Yahoo-hosted article and resolve its REAL publisher through the same
// registry path curated ingest uses. Returns { outlet: undefined } on any
// failure so the caller cleanly falls back to the Yahoo News registry entry.
// Bounded by a short fetch timeout; curated-lane only.
export async function resolveYahooSyndicatedPublisher(
  url: string,
  outletIndex: OutletIndex,
  opts: { timeoutMs?: number } = {},
): Promise<ResolvedSyndication> {
  try {
    const resp = await fetchWithResilience(url, {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      timeoutMs: opts.timeoutMs ?? 10000,
      retries: 0,
      label: 'YahooSyndication',
    });
    if (!resp.ok) return { outlet: undefined, publisherName: null };
    const html = await resp.text();
    const publisherName = extractSyndicatedPublisherFromHtml(html);
    if (!publisherName) return { outlet: undefined, publisherName: null };
    // Resolve the extracted name through the registry (name-only; the URL is a
    // Yahoo URL and must NOT be used to resolve the real publisher's domain).
    const outlet = findOutlet(outletIndex, publisherName);
    return { outlet, publisherName };
  } catch {
    return { outlet: undefined, publisherName: null };
  }
}
