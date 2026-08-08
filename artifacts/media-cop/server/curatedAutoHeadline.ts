// =============================================================================
// Curated auto-headline repair gate (Task #176 automated counterpart)
// -----------------------------------------------------------------------------
// A curated item's headline is captured ONCE at ingestion (off-host Bing RSS
// <title> -> AI translate/refine) and then treated as immutable. When a source
// (e.g. Reuters, hard-blocked from this infra) later re-titles a story, or the
// ingest-time title was generic/stale, nothing corrects it automatically.
//
// The curated enrichment worker (enrichOneItem) already calls the paywall
// bypass / CPC / Jina reader and those calls ALREADY return the article's real
// `headline` — it was simply discarded. This module decides whether a recovered
// headline is safe + worth applying as a DISPLAY-ONLY override (written into the
// curated_headline_overrides overlay with provenance='auto', which NEVER mutates
// the shared curated_items.title / normalizedTitle, so clustering/dedup identity
// is untouched — exactly like the manual #176 editor override).
//
// Bypass output is third-party / attacker-influenceable text, so every accepted
// headline must pass a fail-closed guard stack. Pure functions only (no DB / no
// network) so the gate is unit-testable in scripts/auto-headline-override.test.ts.
// CURATED-LANE ONLY.
// =============================================================================
import { normalizeIdentityUrl } from './urlIdentity';

export interface AutoHeadlineInput {
  /** The headline currently stored/displayed for the curated item. */
  storedTitle: string;
  /** The headline recovered by the paywall bypass / CPC / Jina reader. */
  recoveredHeadline: string | null | undefined;
  /** The canonical URL the bypass says it extracted (identity binding). */
  recoveredSourceUrl: string | null | undefined;
  /** The curated item's own article URL. */
  itemUrl: string;
  /** Social posts (X / Truth Social / DataMinr) are never auto-retitled. */
  isSocial?: boolean;
  /** True when the outlet is in CURATED_TITLE_TRANSLATE_SOURCES (skip: its
   *  stored title is an intentional English translation we must not revert). */
  isTranslateSource?: boolean;
}

export interface AutoHeadlineDeps {
  /** Injected so the pure gate need not import the heavy enrichment module.
   *  Production passes streamPrefetch.isAIRefusalText. */
  isRefusalText?: (t: string | null | undefined) => boolean;
}

export interface AutoHeadlineResult {
  accept: boolean;
  /** The sanitized headline to store (only when accept === true). */
  headline?: string;
  /** Machine-readable reason (for logging + tests). */
  reason:
    | 'ok'
    | 'social'
    | 'translate-source'
    | 'empty'
    | 'identity-mismatch'
    | 'no-source-url'
    | 'refusal'
    | 'too-short'
    | 'too-long'
    | 'too-few-words'
    | 'generic'
    | 'bot-wall'
    | 'no-change';
}

const MIN_HEADLINE_LEN = 25;
const MAX_HEADLINE_LEN = 250;
const MIN_HEADLINE_WORDS = 4;

// Generic / section / nav / site-name-only titles that a bypass can return for
// a homepage, a section index, or a bot-walled page. Compared case-insensitively
// after site-suffix stripping. Never store one of these as a real headline.
const GENERIC_HEADLINE_DENYLIST = new Set<string>([
  'home', 'homepage', 'news', 'breaking news', 'latest news', 'top news',
  'top stories', 'world news', 'world', 'business news', 'business', 'markets',
  'market news', 'politics', 'politics news', 'us news', 'u.s. news',
  'sports', 'sports news', 'video', 'live', 'live news', 'live updates',
  'reuters', 'reuters.com', 'bloomberg', 'bloomberg.com', 'the wall street journal',
  'wsj', 'wsj.com', 'associated press', 'ap news', 'cnn', 'bbc', 'bbc news',
  'npr', 'fox news', 'the new york times', 'access denied', 'just a moment',
  'attention required', 'are you a robot', 'page not found', 'error',
  'subscribe to read', 'sign in',
]);

// Bot-wall / interstitial / error-page phrases. Unlike the denylist above
// (matched against the WHOLE normalized string), these are matched as
// substrings anywhere in the headline: real bot-wall titles usually carry the
// site name too ("Bloomberg - Are you a robot?"), so a whole-string equality
// check never fires (prod incident 2026-07-14 — 23 curated 'auto' overrides
// stored exactly that title). Rejecting here is fail-closed in the safe
// direction: the item simply keeps its stored ingest-time headline.
const BOT_WALL_PHRASES: string[] = [
  'are you a robot', 'robot check', 'just a moment', 'access denied',
  'access to this page has been denied', 'attention required',
  'verify you are human', 'verifying you are human', 'human verification',
  'unusual activity', 'unusual traffic', 'captcha', 'browser check',
  'checking your browser', 'page not found', '404 not found', '403 forbidden',
  'request blocked', 'request denied', 'subscribe to read', 'sign in to read',
  'enable javascript', 'javascript is required', 'javascript is disabled',
  'cookies are required', 'enable cookies',
];

/** True when the (already sanitized) headline contains a bot-wall/interstitial
 *  phrase anywhere — e.g. "Bloomberg - Are you a robot?". */
export function isBotWallHeadline(h: string | null | undefined): boolean {
  if (!h) return false;
  const lower = String(h).toLowerCase().replace(/\s+/g, ' ');
  return BOT_WALL_PHRASES.some((p) => lower.includes(p));
}

// Regex fallbacks for "<Section> News" / short nav labels not enumerated above.
const GENERIC_HEADLINE_PATTERNS: RegExp[] = [
  /^[a-z .&'-]{1,24}\s+news$/,        // "Middle East News", "Tech News"
  /^(breaking|latest|top|live|world|business|markets?|politics|sports?)\b/,
  /^(please enable javascript|enable javascript|javascript is required)\b/,
];

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&#039;': "'", '&apos;': "'", '&nbsp;': ' ',
  '&rsquo;': '\u2019', '&lsquo;': '\u2018', '&ldquo;': '\u201C',
  '&rdquo;': '\u201D', '&mdash;': '\u2014', '&ndash;': '\u2013', '&hellip;': '\u2026',
};

/** Strip HTML tags/entities/control chars, collapse whitespace, hard-cap length. */
export function sanitizeRecoveredHeadline(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw)
    .replace(/<[^>]+>/g, ' ')                 // strip any HTML tags
    .replace(/[\x00-\x1F\x7F]/g, ' ');        // strip control chars
  for (const [ent, ch] of Object.entries(HTML_ENTITIES)) s = s.split(ent).join(ch);
  s = s.replace(/&#(\d+);/g, (_m, d) => {
    const code = parseInt(d, 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
  });
  s = s.replace(/\s+/g, ' ').trim();
  // Safety bound only (guards against a paragraph-length blob). This does NOT
  // truncate into an accepted headline: evaluateAutoHeadline rejects anything
  // over MAX_HEADLINE_LEN, so an accepted headline is always the untouched text.
  if (s.length > 1000) s = s.slice(0, 1000);
  return s;
}

/** Remove a trailing " | Reuters" / " - The New York Times" style site suffix. */
export function stripSiteSuffix(h: string): string {
  // A single trailing separator (with whitespace on BOTH sides — real site
  // suffixes are formatted " | Site" / " - Site", never "Trump-Biden") followed
  // by a short (<=40 char) non-sentence fragment that looks like a site name.
  const m = h.match(/^(.*\S)\s+[|\u2013\u2014\-]\s+([^|\u2013\u2014]{1,40})$/);
  if (m) {
    const suffix = m[2].trim();
    // Only strip when the suffix has no sentence punctuation (real headlines
    // rarely end in a short punctuation-free clause after a pipe/dash).
    if (!/[.!?]/.test(suffix) && suffix.split(/\s+/).length <= 6) {
      return m[1].trim();
    }
  }
  return h;
}

/** Normalized form for equality checks: lowercase, suffix-stripped, no trailing
 *  punctuation, collapsed whitespace. */
export function normalizeForCompare(h: string): string {
  return stripSiteSuffix(h)
    .toLowerCase()
    .replace(/[\s\u2026]+$/g, '')      // trailing whitespace / ellipsis char
    .replace(/[.!?,:;\u2013\u2014-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the (already sanitized) headline is a generic/section/nav title. */
export function isGenericHeadline(h: string): boolean {
  const core = normalizeForCompare(h);
  if (!core) return true;
  if (GENERIC_HEADLINE_DENYLIST.has(core)) return true;
  return GENERIC_HEADLINE_PATTERNS.some((re) => re.test(core));
}

/**
 * Decide whether a bypass-recovered headline should replace the stored one as a
 * display-only 'auto' override. Fail-closed: any doubt → reject (accept:false).
 */
export function evaluateAutoHeadline(
  input: AutoHeadlineInput,
  deps: AutoHeadlineDeps = {},
): AutoHeadlineResult {
  const isRefusalText = deps.isRefusalText ?? (() => false);

  if (input.isSocial) return { accept: false, reason: 'social' };
  if (input.isTranslateSource) return { accept: false, reason: 'translate-source' };

  const candidate = sanitizeRecoveredHeadline(input.recoveredHeadline);
  if (!candidate) return { accept: false, reason: 'empty' };

  // Identity binding (anti-smear): the bypass must report the SAME article, or
  // we could paste article B's headline onto article A. No source URL → reject.
  const srcId = normalizeIdentityUrl(input.recoveredSourceUrl);
  if (!srcId) return { accept: false, reason: 'no-source-url' };
  if (srcId !== normalizeIdentityUrl(input.itemUrl)) {
    return { accept: false, reason: 'identity-mismatch' };
  }

  if (isRefusalText(candidate)) return { accept: false, reason: 'refusal' };

  if (candidate.length < MIN_HEADLINE_LEN) return { accept: false, reason: 'too-short' };
  if (candidate.length > MAX_HEADLINE_LEN) return { accept: false, reason: 'too-long' };
  if (candidate.split(/\s+/).filter(Boolean).length < MIN_HEADLINE_WORDS) {
    return { accept: false, reason: 'too-few-words' };
  }
  if (isBotWallHeadline(candidate)) return { accept: false, reason: 'bot-wall' };
  if (isGenericHeadline(candidate)) return { accept: false, reason: 'generic' };

  // Only override when it actually changes the displayed headline.
  if (normalizeForCompare(input.storedTitle) === normalizeForCompare(candidate)) {
    return { accept: false, reason: 'no-change' };
  }

  return { accept: true, headline: candidate, reason: 'ok' };
}
