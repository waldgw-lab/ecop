// =============================================================================
// Meltwater curated-only bot (CURATED LANE ONLY).
//
// Pulls two Meltwater saved Listening searches and funnels recent slices
// into the isolated curated aperture via admitCuratedCandidates. It writes
// ONLY to curated_items / curated_classifications — it NEVER touches the
// main / Classic / Visual / custom-MCOP feeds or the public API.
//
// Admission mode is PER SEARCH:
//   Search 1 — "Curated (CPC/SWL/EPC)" (ID 28809721): adversary / state-
//               controlled media outlets. Runs hourly at :23. Label:
//               meltwater-cpc. Mode 'reuse' (UNGATED) BY USER DIRECTIVE —
//               the downstream adversary-media handling owns any further
//               filtering; do NOT re-add the gate here.
//   Search 2 — "Curated (Int/US)"       (ID 28872986): international & US press
//               (Israeli, Gulf/Arab, WSJ/WaPo/Politico, defense trade, think
//               tanks, AFP, Der Spiegel, The Atlantic, etc.). Runs every 2 hours
//               at :53. Label: meltwater-intus. Mode 'gate' — general-press
//               feeds carry mostly OFF-TOPIC content (domestic politics,
//               business, culture, sports), so every item runs through the
//               curated relevance analyzer, which drops off-topic items and
//               assigns a REAL AI priority score + inline classification.
//               Running this search ungated flooded curated with irrelevant
//               items at machine-baseline scores of ~60-71 (2026-07-15).
//
// Attribution: Meltwater is a DATA PIPE, not an outlet. Each document is ingested
// as an individual article attributed to its REAL publisher (the document's own
// source name / domain), exactly like every other curated intake (RSS, website
// scraper, team submissions). The curated lane then sorts each item by its real
// outlet via the Outlet Registry.
//
// Quota facts (per API key, shared dev+prod):
//   - 50 analytics (/v3/search) calls per day.
//   - Combined base load: ~36 calls/day (24 CPC + 12 Int/US), leaving ~14
//     headroom for extra pagination pages.
//   - The existing quota-floor self-throttle applies to both searches.
//   - NEVER touch /v3/export* endpoints — that budget is reserved for manual
//     dashboard exports.
//
// Never logs MELTWATER_API_KEY, request headers, or raw API response bodies.
// =============================================================================
import type { CuratedIntakeCandidate } from './curatedIngest';
import { storage } from './storage';
import { buildOutletIndex, findOutlet, normalizeOutletName, type OutletIndex } from '@shared/outletRegistry';

const MELTWATER_BASE = 'https://api.meltwater.com';

// ---------------------------------------------------------------------------
// Per-search configuration
// ---------------------------------------------------------------------------

export interface MeltwaterSearchConfig {
  searchId: number;
  label: string;
  // Max pages to pull per run. Keeps combined calls well within the ~50/day cap.
  maxPages: number;
  // Lookback window in minutes. Slightly exceeds the cadence to bridge adjacent
  // runs; URL/fuzzy dedup in admitCuratedCandidates collapses any re-seen items.
  windowMinutes: number;
  // Curated admission mode. 'reuse' = ungated (adversary CPC search only, by
  // user directive — downstream adversary handling owns filtering). 'gate' =
  // every item runs the curated relevance analyzer (drops off-topic items,
  // assigns real AI priority scores + inline classification). General-press
  // searches MUST be 'gate' or irrelevant items enter at machine baselines.
  mode: 'reuse' | 'gate';
}

// The two registered searches. Export for tests and scheduler wiring.
export const MELTWATER_SEARCHES: MeltwaterSearchConfig[] = [
  {
    // "Curated (CPC/SWL/EPC)" — adversary / state-controlled media.
    // Hourly at :23 → base load 24 calls/day.
    searchId: 28809721,
    label: 'meltwater-cpc',
    maxPages: 3,
    windowMinutes: 75,
    mode: 'reuse',
  },
  {
    // "Curated (Int/US)" — international & US press not in the CPC search.
    // Every 2h at :53 → base load 12 calls/day. Lower volume outlets →
    // lower MAX_PAGES keeps the per-run cost tight. GATED: general press
    // needs the defense-relevance screen + real AI scoring (see header).
    searchId: 28872986,
    label: 'meltwater-intus',
    maxPages: 2,
    windowMinutes: 135,
    mode: 'gate',
  },
];

// Shared constants that apply to every search.
const PAGE_SIZE = 50;
// Stop paginating when the daily search quota nears exhaustion to preserve
// headroom for other searches and the next cadence cycles.
const QUOTA_PAGINATION_FLOOR = 10;
// Per-run cap on how many documents any single publisher contributes, applied
// AFTER mapping and BEFORE admission. Stops one high-volume state outlet (e.g.
// TASS) from monopolizing a cycle and crowding out rarer outlets.
const PER_OUTLET_CAP = 5;
const FETCH_TIMEOUT_MS = 30_000;

// Per-search in-flight guard: keyed by search label.
const inFlightSearches = new Set<string>();

// ISO 8601 LOCAL timestamp (no trailing 'Z'); the API rejects zoned timestamps
// here and takes the zone from the separate `tz` field instead.
function localIso(d: Date): string {
  return d.toISOString().slice(0, 19);
}

// The /v3/search endpoint is hard-capped per API key (~50 calls/day + 100/min,
// shared across dev AND prod since the key is one credential).
interface RateLimitInfo {
  dayLimit: number | null;
  dayRemaining: number | null;
  dayResetSec: number | null;
  minuteRemaining: number | null;
  minuteResetSec: number | null;
}

function parseRateLimit(res: Response): RateLimitInfo {
  const num = (h: string): number | null => {
    const v = res.headers.get(h);
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    dayLimit: num('ratelimit-day-limit'),
    dayRemaining: num('ratelimit-day-remaining'),
    dayResetSec: num('ratelimit-day-reset'),
    minuteRemaining: num('ratelimit-minute-remaining'),
    minuteResetSec: num('ratelimit-minute-reset'),
  };
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return 'unknown';
  if (sec < 120) return `${Math.max(0, Math.round(sec))}s`;
  if (sec < 7200) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

interface SearchAttempt {
  status: number;
  ok: boolean;
  json: any | null;
  rateLimit: RateLimitInfo;
}

// One POST to a saved Listening search. Returns the status, parsed body, and
// rate-limit counters. Never logs the key, headers, or raw body.
async function performSearch(apiKey: string, searchId: number, body: unknown): Promise<SearchAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${MELTWATER_BASE}/v3/search/${searchId}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        apikey: apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rateLimit = parseRateLimit(res);
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, rateLimit };
  } finally {
    clearTimeout(timer);
  }
}

export interface MeltwaterDoc {
  url?: string | null;
  content_type?: string | null;
  published_date?: string | null;
  content?: {
    title?: string | null;
    image?: string | null;
    opening_text?: string | null;
    body?: string | null;
  } | null;
  source?: { name?: string | null; domain?: string | null } | null;
}

// Extract the outlet's OWN canonical publish date from the article URL path.
// Most publishers embed the true publication day as /YYYY/MM/DD/ or
// /YYYY-MM-DD/ in the path (Reuters, CNN, AP-ish, USA Today, Foreign Policy,
// Stripes, Breaking Defense, etc.). Returns a UTC-midnight Date for that day,
// or null when the URL carries no such date. Pure + defensive: any malformed
// or implausible value collapses to null.
export function parseDateFromUrl(url: string | null | undefined): Date | null {
  if (!url) return null;
  // /2026/07/13/ or /2026-07-13/ or /2026/07/13- (slug-joined). Require the
  // year to lead a path segment so we don't match story IDs.
  const m = url.match(/\/(20\d{2})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])(?:[/-]|$)/);
  if (!m) return null;
  const [, y, mo, da] = m;
  const dt = new Date(`${y}-${mo}-${da}T00:00:00Z`);
  if (isNaN(dt.getTime())) return null;
  // Guard against absurd values (typos / IDs that happen to parse).
  if (dt.getUTCFullYear() < 2015) return null;
  if (dt.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null;
  return dt;
}

// How much newer Meltwater's stamp may be than the URL date before we distrust
// it. Meltwater's `published_date` is its own index/crawl date, which for a
// RE-SURFACED older article can be days-to-weeks newer than the true publish
// date — that made stale articles appear "recently published" on Top Stories.
// A small window absorbs timezone / same-day-update jitter without letting a
// genuinely old article masquerade as fresh.
const MELTWATER_STALE_STAMP_TOLERANCE_MS = 2 * 24 * 60 * 60 * 1000;

// Reconcile Meltwater's published_date against the URL's own date. The outlet's
// URL date is the canonical publish day; when Meltwater's stamp is materially
// NEWER (its crawl date on a re-surfaced old article), trust the URL date so a
// stale story can't read as fresh. Same-day / within-tolerance stamps keep
// Meltwater's value (it carries a real clock time the URL date lacks). When
// Meltwater gives no date, fall back to the URL date if present.
export function reconcileMeltwaterPubDate(
  publishedDate: string | null | undefined,
  url: string | null | undefined,
): string | null {
  const urlDate = parseDateFromUrl(url);
  const mw = publishedDate ? new Date(publishedDate) : null;
  const mwValid = mw && !isNaN(mw.getTime());
  if (mwValid && urlDate) {
    if (mw!.getTime() - urlDate.getTime() > MELTWATER_STALE_STAMP_TOLERANCE_MS) {
      return urlDate.toISOString();
    }
    return publishedDate ?? null;
  }
  if (!mwValid && urlDate) return urlDate.toISOString();
  return publishedDate ?? null;
}

// Pure mapper: turn one Meltwater document into a curated candidate attributed
// to its REAL publisher. Meltwater is a data pipe, not an outlet.
export function mapMeltwaterDoc(d: MeltwaterDoc): CuratedIntakeCandidate | null {
  const title = d.content?.title?.trim();
  const url = d.url?.trim();
  if (!title || !url) return null;

  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    host = '';
  }
  const source = (d.source?.name?.trim() || d.source?.domain?.trim() || host).trim();
  if (!source) return null;

  const image = d.content?.image?.trim();
  const summary = (d.content?.opening_text || d.content?.body || '').trim();

  return {
    title,
    url,
    source,
    // Meltwater's published_date is its crawl/index date, which for a
    // re-surfaced older article can be much newer than the true publish date
    // (made stale items read as "recently published"). Prefer the outlet's own
    // URL date when Meltwater's stamp is materially newer.
    pubDate: reconcileMeltwaterPubDate(d.published_date, url),
    ogImageUrl: image && /^https?:\/\//i.test(image) ? image : null,
    ...(summary ? { summary } : {}),
  };
}

// De-clump a batch so no single publisher monopolizes the run.
// Round-robins the candidates by outlet identity, taking at most `perOutletCap`
// from each. Input order is treated as freshest-first.
export function spreadCandidatesByOutlet(
  candidates: CuratedIntakeCandidate[],
  opts: {
    perOutletCap: number;
    identityOf?: (c: CuratedIntakeCandidate) => string;
  },
): CuratedIntakeCandidate[] {
  const perOutletCap = Math.max(1, opts.perOutletCap);
  const identityOf =
    opts.identityOf ?? ((c) => `name:${normalizeOutletName(c.source) || c.source.trim().toLowerCase()}`);

  const buckets = new Map<string, CuratedIntakeCandidate[]>();
  const order: string[] = [];
  for (const c of candidates) {
    const key = identityOf(c);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    if (bucket.length < perOutletCap) bucket.push(c);
  }

  const result: CuratedIntakeCandidate[] = [];
  for (let i = 0; i < perOutletCap; i++) {
    for (const key of order) {
      const bucket = buckets.get(key)!;
      if (i < bucket.length) result.push(bucket[i]);
    }
  }
  return result;
}

function candidateIdentity(c: CuratedIntakeCandidate, index: OutletIndex | null): string {
  if (index) {
    const row = findOutlet(index, c.source, c.url);
    if (row) return `row:${row.id}`;
  }
  return `name:${normalizeOutletName(c.source) || c.source.trim().toLowerCase()}`;
}

async function loadOutletIndex(): Promise<OutletIndex | null> {
  try {
    const rows = await storage.getOutletRegistry();
    return buildOutletIndex(rows);
  } catch (e) {
    console.warn(
      '[MeltwaterCuratedBot] Could not load Outlet Registry for de-clumping; using name-based identity:',
      (e as Error)?.message ?? e,
    );
    return null;
  }
}

// One page fetch with the 429 per-minute-burst retry.
async function fetchPageWithRetry(apiKey: string, searchId: number, body: unknown, label: string): Promise<SearchAttempt> {
  let attempt = await performSearch(apiKey, searchId, body);
  if (attempt.status === 429) {
    const rl = attempt.rateLimit;
    const dayExhausted = rl.dayRemaining != null && rl.dayRemaining <= 0;
    console.warn(
      `[MeltwaterCuratedBot:${label}] Rate limited (HTTP 429): day ${rl.dayRemaining ?? '?'}/${rl.dayLimit ?? '?'} left (resets in ${fmtDuration(rl.dayResetSec)}), minute ${rl.minuteRemaining ?? '?'} left (resets in ${fmtDuration(rl.minuteResetSec)})`,
    );
    const canRetryMinute =
      !dayExhausted && rl.minuteResetSec != null && rl.minuteResetSec > 0 && rl.minuteResetSec <= 65;
    if (canRetryMinute) {
      const waitMs = (rl.minuteResetSec! + 1) * 1000;
      console.log(
        `[MeltwaterCuratedBot:${label}] Per-minute burst limit; retrying once in ${Math.round(waitMs / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      attempt = await performSearch(apiKey, searchId, body);
    }
  }
  return attempt;
}

// ---------------------------------------------------------------------------
// Generic search runner — shared logic for both searches
// ---------------------------------------------------------------------------

async function runMeltwaterSearchBot(config: MeltwaterSearchConfig): Promise<{
  ingested: number;
  skipped: number;
  errors: number;
  rateLimited: boolean;
}> {
  const { searchId, label, maxPages, windowMinutes, mode } = config;
  const LOG = `[MeltwaterCuratedBot:${label}]`;

  if (inFlightSearches.has(label)) {
    console.log(`${LOG} Previous run still in flight, skipping this cycle`);
    return { ingested: 0, skipped: 0, errors: 0, rateLimited: false };
  }

  const apiKey = process.env.MELTWATER_API_KEY;
  if (!apiKey) {
    console.warn(`${LOG} MELTWATER_API_KEY not set — bot disabled, skipping`);
    return { ingested: 0, skipped: 0, errors: 0, rateLimited: false };
  }

  inFlightSearches.add(label);
  const started = Date.now();
  try {
    const end = new Date();
    const start = new Date(end.getTime() - windowMinutes * 60 * 1000);
    const baseBody = {
      start: localIso(start),
      end: localIso(end),
      tz: 'UTC',
      page_size: PAGE_SIZE,
      sort_by: 'date',
      sort_order: 'desc',
    };

    const allDocs: MeltwaterDoc[] = [];
    let lastAttempt: SearchAttempt | null = null;
    let overflow = false;
    let pagesFetched = 0;

    for (let page = 1; page <= maxPages; page++) {
      const attempt = await fetchPageWithRetry(apiKey, searchId, { ...baseBody, page }, label);
      lastAttempt = attempt;

      if (attempt.status === 429) {
        if (allDocs.length === 0) {
          const rl = attempt.rateLimit;
          const dayResetAt = rl.dayResetSec != null ? new Date(Date.now() + rl.dayResetSec * 1000) : null;
          storage.setMeltwaterTelemetry(label, {
            lastRunAt: new Date(),
            outcome: 'rate-limited',
            httpStatus: 429,
            ingested: 0,
            skipped: 0,
            dayRemaining: rl.dayRemaining,
            dayLimit: rl.dayLimit,
            dayResetAt,
            minuteRemaining: rl.minuteRemaining,
            overflow: false,
          }).catch((e) => console.warn(`${LOG} Failed to persist telemetry:`, e?.message));
          return { ingested: 0, skipped: 0, errors: 0, rateLimited: true };
        }
        overflow = true;
        break;
      }

      if (!attempt.ok) {
        if (allDocs.length === 0) {
          console.error(`${LOG} Meltwater API error: HTTP ${attempt.status}`);
          storage.setMeltwaterTelemetry(label, {
            lastRunAt: new Date(),
            outcome: 'error',
            httpStatus: attempt.status,
            ingested: 0,
            skipped: 0,
            dayRemaining: attempt.rateLimit.dayRemaining,
            dayLimit: attempt.rateLimit.dayLimit,
            dayResetAt: null,
            minuteRemaining: attempt.rateLimit.minuteRemaining,
            overflow: false,
          }).catch((e) => console.warn(`${LOG} Failed to persist telemetry:`, e?.message));
          return { ingested: 0, skipped: 0, errors: 1, rateLimited: false };
        }
        console.warn(`${LOG} Page ${page} returned HTTP ${attempt.status}; admitting ${allDocs.length} doc(s) from earlier pages`);
        break;
      }

      pagesFetched++;
      const pageDocs: MeltwaterDoc[] = Array.isArray(attempt.json?.result?.documents)
        ? attempt.json.result.documents
        : [];
      allDocs.push(...pageDocs);

      if (pageDocs.length < PAGE_SIZE) break;
      if (page === maxPages) {
        overflow = true;
        break;
      }
      const rem = attempt.rateLimit.dayRemaining;
      if (rem != null && rem <= QUOTA_PAGINATION_FLOOR) {
        overflow = true;
        console.warn(`${LOG} Daily quota low (${rem} left); stopping pagination at page ${page}`);
        break;
      }
    }

    const attempt = lastAttempt!;
    const rl = attempt.rateLimit;
    const dayResetAt = rl.dayResetSec != null ? new Date(Date.now() + rl.dayResetSec * 1000) : null;

    if (allDocs.length === 0) {
      console.log(`${LOG} No documents returned for window`);
      storage.setMeltwaterTelemetry(label, {
        lastRunAt: new Date(),
        outcome: 'success',
        httpStatus: attempt.status,
        ingested: 0,
        skipped: 0,
        dayRemaining: rl.dayRemaining,
        dayLimit: rl.dayLimit,
        dayResetAt,
        minuteRemaining: rl.minuteRemaining,
        overflow,
      }).catch((e) => console.warn(`${LOG} Failed to persist telemetry:`, e?.message));
      return { ingested: 0, skipped: 0, errors: 0, rateLimited: false };
    }

    const candidates: CuratedIntakeCandidate[] = [];
    for (const d of allDocs) {
      const c = mapMeltwaterDoc(d);
      if (c) candidates.push(c);
    }

    if (candidates.length === 0) {
      console.log(`${LOG} No usable candidates after mapping`);
      storage.setMeltwaterTelemetry(label, {
        lastRunAt: new Date(),
        outcome: 'success',
        httpStatus: attempt.status,
        ingested: 0,
        skipped: allDocs.length,
        dayRemaining: rl.dayRemaining,
        dayLimit: rl.dayLimit,
        dayResetAt,
        minuteRemaining: rl.minuteRemaining,
        overflow,
      }).catch((e) => console.warn(`${LOG} Failed to persist telemetry:`, e?.message));
      return { ingested: 0, skipped: allDocs.length, errors: 0, rateLimited: false };
    }

    const outletIndex = await loadOutletIndex();
    const spread = spreadCandidatesByOutlet(candidates, {
      perOutletCap: PER_OUTLET_CAP,
      identityOf: (c) => candidateIdentity(c, outletIndex),
    });
    const cappedOut = candidates.length - spread.length;

    const { admitCuratedCandidates } = await import('./curatedIngest');
    const r = await admitCuratedCandidates(spread, {
      mode,
      label,
    });

    const duration = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `${LOG} Completed in ${duration}s — pages ${pagesFetched}, fetched ${allDocs.length}, mapped ${candidates.length}, de-clumped to ${spread.length} (capped ${cappedOut}), admitted ${r.ingested}, skipped ${r.skipped}${overflow ? ', window OVERFLOW (more docs than pulled)' : ''}; search quota ${rl.dayRemaining ?? '?'}/${rl.dayLimit ?? '?'} left today`,
    );

    storage.setMeltwaterTelemetry(label, {
      lastRunAt: new Date(),
      outcome: 'success',
      httpStatus: attempt.status,
      ingested: r.ingested,
      skipped: r.skipped + cappedOut,
      dayRemaining: rl.dayRemaining,
      dayLimit: rl.dayLimit,
      dayResetAt,
      minuteRemaining: rl.minuteRemaining,
      overflow,
    }).catch((e) => console.warn(`${LOG} Failed to persist telemetry:`, e?.message));

    return { ingested: r.ingested, skipped: r.skipped + cappedOut, errors: 0, rateLimited: false };
  } catch (error) {
    console.error(`${LOG} Fatal error:`, (error as Error)?.message ?? error);
    storage.setMeltwaterTelemetry(label, {
      lastRunAt: new Date(),
      outcome: 'error',
      httpStatus: null,
      ingested: 0,
      skipped: 0,
      dayRemaining: null,
      dayLimit: null,
      dayResetAt: null,
      minuteRemaining: null,
      overflow: false,
    }).catch((e) => console.warn(`${LOG} Failed to persist telemetry:`, e?.message));
    return { ingested: 0, skipped: 0, errors: 1, rateLimited: false };
  } finally {
    inFlightSearches.delete(label);
  }
}

// ---------------------------------------------------------------------------
// Named exports — one per search, called by the scheduler
// ---------------------------------------------------------------------------

// Search 1: "Curated (CPC/SWL/EPC)" — hourly at :23.
export async function runMeltwaterCuratedBot(): Promise<{
  ingested: number;
  skipped: number;
  errors: number;
  rateLimited: boolean;
}> {
  return runMeltwaterSearchBot(MELTWATER_SEARCHES[0]);
}

// Search 2: "Curated (Int/US)" — every 2h at :53.
export async function runMeltwaterIntUsBot(): Promise<{
  ingested: number;
  skipped: number;
  errors: number;
  rateLimited: boolean;
}> {
  return runMeltwaterSearchBot(MELTWATER_SEARCHES[1]);
}
