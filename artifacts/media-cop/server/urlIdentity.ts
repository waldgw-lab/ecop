// =============================================================================
// Curated URL identity normalization.
//
// The SINGLE source of truth for reducing an article URL to a stable identity
// token used by the curated lane to decide "is this the same article?". It is
// shared by every place that computes that token so they can NEVER drift apart:
//   - curatedSynthesis.normalizeMemberUrl  (clusterId + synthesis signature)
//   - curatedCluster                       (pre-cluster collapse-by-URL)
//   - routes (curated read endpoint)       (standalone-vs-cluster dedup)
//   - storage.normalizeArchiveUrl          (archive carry-forward identity)
//
// Why this exists: the same article routinely enters the curated lane through
// two paths that store its URL slightly differently — the main-feed path stores
// a CLEANED URL (RSS bots strip the query), while a direct curated RSS/website
// path keeps the RAW feed link with its tracking query (e.g. BBC's
// `?at_medium=RSS&at_campaign=rss`, DW's `?maca=...`, generic `?utm_*`). If the
// identity token keeps those tracking params, the two forms look like two
// different articles, the collapse-by-URL step misses, and ONE article shows up
// TWICE as two "sources" in a Top Story.
//
// The normalization therefore:
//   1. drops the #fragment (client-side anchor, never part of article identity),
//   2. drops TRACKING query params (utm_*/at_*/ns_* prefixes + a known set),
//      while KEEPING identifying params (e.g. ABC's `?id=12345`, `?p=` post ids)
//      so two genuinely different articles that share a path are never merged,
//   3. sorts any kept params for determinism,
//   4. strips a trailing slash and lowercases.
//
// Erring toward NOT collapsing: when a param's role is ambiguous it is kept, so
// the worst case is a rare un-deduped variant — never two distinct articles
// merged into one.
// =============================================================================

// Tracking-param key PREFIXES (matched case-insensitively). Anything beginning
// with one of these is advertising/analytics/RSS attribution, never identity.
const TRACKING_PARAM_PREFIXES = ['utm_', 'at_', 'ns_'];

// Exact tracking-param keys (matched case-insensitively) that don't share a
// common prefix. Seen in the live curated feed (maca, traffic_source) plus the
// usual cross-web set.
const TRACKING_PARAM_KEYS = new Set([
  'maca', // Deutsche Welle RSS attribution
  'traffic_source',
  'srnd', // Bloomberg
  'cmp',
  'cmpid',
  'ito', // The Guardian
  'igshid', // Instagram
  'icid',
  'fbclid', // Facebook click id
  'gclid', // Google click id
  'dclid',
  'gclsrc',
  'msclkid', // Microsoft click id
  'yclid', // Yandex click id
  'mc_cid', // Mailchimp
  'mc_eid',
  'ocid', // MSN
  'spm', // Alibaba/CN sites
  'ref_src',
  'ref_url',
  'guccounter',
  '__twitter_impression',
]);

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  if (TRACKING_PARAM_PREFIXES.some((p) => k.startsWith(p))) return true;
  return TRACKING_PARAM_KEYS.has(k);
}

// Reduce a URL to its stable curated identity token. Pure, total, never throws —
// operates on the raw string (no `new URL()`) so malformed inputs degrade
// gracefully rather than throwing inside a clustering pass.
export function normalizeIdentityUrl(u: string | null | undefined): string {
  const raw = (u ?? '').trim();
  if (!raw) return '';

  // Drop the fragment (#...).
  const hashIdx = raw.indexOf('#');
  const noHash = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;

  // Split base path from the query string.
  const qIdx = noHash.indexOf('?');
  let base = (qIdx >= 0 ? noHash.slice(0, qIdx) : noHash).replace(/\/+$/, '');

  if (qIdx >= 0) {
    const kept = noHash
      .slice(qIdx + 1)
      .split('&')
      .filter((pair) => pair.length > 0)
      .filter((pair) => !isTrackingParam(pair.split('=')[0]));
    if (kept.length) {
      kept.sort();
      base = base + '?' + kept.join('&');
    }
  }

  return base.toLowerCase();
}
