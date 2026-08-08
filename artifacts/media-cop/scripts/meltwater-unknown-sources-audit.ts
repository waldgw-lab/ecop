// Read-only audit: which live Meltwater saved-search sources currently fall to
// the country-less CPC/SWL/EPC catch-all (i.e. are NOT kept with their real
// adversary identity) and therefore need registering in the Outlet Registry.
//
// It mirrors server/meltwaterBot.ts exactly:
//   - builds the outlet index from the REAL OUTLET_SEED (identity refreshes from
//     the seed on every boot, so the seed === live registry identity),
//   - applies the same keepReal rule (resolves to a `-cpc` row),
//   - reports every source where keepReal is FALSE, split into:
//       A. UNRESOLVED      — findOutlet found nothing (truly unknown; top to register)
//       B. RESOLVED-NON-CPC — known to the registry but not as adversary (review)
//
// It NEVER writes: it only fetches the saved search and groups in memory. It is
// quota-aware (the /v3/search key is ~50/day shared dev+prod) — it caps pages and
// bails early if the daily remaining is low.
//
// Run: npx tsx scripts/meltwater-unknown-sources-audit.ts

import {
  buildOutletIndex,
  findOutlet,
  extractOutletDomain,
} from '@shared/outletRegistry';
import { OUTLET_SEED } from '../server/outletRegistrySeed';

const BASE = 'https://api.meltwater.com';
const SEARCH_ID = 28809721;
const WINDOW_DAYS = 8;
const MAX_PAGES = 8; // hard cap on API requests (quota safety)
const MIN_DAY_REMAINING = 12; // bail before eating into prod's quota
const FETCH_TIMEOUT_MS = 30_000;

function localIso(d: Date): string {
  return d.toISOString().slice(0, 19);
}

function num(res: Response, h: string): number | null {
  const v = res.headers.get(h);
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function performSearch(
  apiKey: string,
  body: unknown,
): Promise<{ status: number; ok: boolean; json: any; dayRemaining: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/v3/search/${SEARCH_ID}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        apikey: apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, dayRemaining: num(res, 'ratelimit-day-remaining') };
  } finally {
    clearTimeout(timer);
  }
}

type Faller = {
  name: string;
  domain: string | null;
  count: number;
  social: number;
  resolvedTo: string | null; // canonicalName of a non-cpc match, if any
  sampleUrls: string[];
};

async function main() {
  const apiKey = process.env.MELTWATER_API_KEY;
  if (!apiKey) {
    console.error('MELTWATER_API_KEY not set — cannot run audit.');
    process.exit(1);
  }

  const index = buildOutletIndex(OUTLET_SEED as any);

  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Find a working page_size once (the v3 endpoint caps it), then page.
  let pageSize = 0;
  const docs: any[] = [];
  let page = 1;
  let pagesFetched = 0;
  let dayRemaining: number | null = null;

  for (; page <= MAX_PAGES; page++) {
    const candidateSizes = pageSize ? [pageSize] : [500, 200, 50];
    let pageDocs: any[] | null = null;
    for (const size of candidateSizes) {
      const body = {
        start: localIso(start),
        end: localIso(end),
        tz: 'UTC',
        page,
        page_size: size,
        sort_by: 'date',
        sort_order: 'desc',
      };
      const res = await performSearch(apiKey, body);
      dayRemaining = res.dayRemaining ?? dayRemaining;
      if (res.status === 429) {
        console.warn(`Rate limited (HTTP 429) on page ${page}; stopping. Day remaining: ${dayRemaining ?? '?'}`);
        pageDocs = null;
        page = MAX_PAGES + 1;
        break;
      }
      if (!res.ok) {
        // bad page_size etc — try the next smaller size
        if (size === candidateSizes[candidateSizes.length - 1]) {
          console.error(`HTTP ${res.status} on page ${page} at all page sizes; stopping.`);
          page = MAX_PAGES + 1;
        }
        continue;
      }
      pageSize = size;
      pageDocs = res.json?.result?.documents ?? [];
      break;
    }
    if (!pageDocs) break;
    pagesFetched++;
    docs.push(...pageDocs);
    if (pageDocs.length < pageSize) break; // last page
    if (dayRemaining != null && dayRemaining <= MIN_DAY_REMAINING) {
      console.warn(`Daily quota low (${dayRemaining} left) — stopping early to protect prod.`);
      break;
    }
  }

  // Classify each doc exactly as mapMeltwaterDoc would.
  const kept = new Map<string, number>();
  const fallers = new Map<string, Faller>();
  let total = 0;
  let mapped = 0;

  for (const d of docs) {
    total++;
    const title = d?.content?.title?.trim();
    const url = d?.url?.trim();
    if (!title || !url) continue;
    mapped++;
    const realName = (d?.source?.name || '').trim();
    const isSocial = (d?.content_type || '').toLowerCase().includes('social');
    const resolved = findOutlet(index, realName || null, url);
    const keepReal =
      !!resolved &&
      typeof resolved.sourceIdentifier === 'string' &&
      resolved.sourceIdentifier.endsWith('-cpc');

    if (keepReal) {
      const k = resolved!.canonicalName;
      kept.set(k, (kept.get(k) ?? 0) + 1);
      continue;
    }

    const domain = (d?.source?.domain || extractOutletDomain(url) || '').toLowerCase() || null;
    const key = (realName || domain || 'unknown').toLowerCase();
    let f = fallers.get(key);
    if (!f) {
      f = { name: realName || '(no source name)', domain, count: 0, social: 0, resolvedTo: resolved?.canonicalName ?? null, sampleUrls: [] };
      fallers.set(key, f);
    }
    f.count++;
    if (isSocial) f.social++;
    if (resolved && !f.resolvedTo) f.resolvedTo = resolved.canonicalName;
    if (f.sampleUrls.length < 2 && !f.sampleUrls.includes(url)) f.sampleUrls.push(url);
  }

  const fallerList = Array.from(fallers.values()).sort((a, b) => b.count - a.count);
  const unresolved = fallerList.filter((f) => !f.resolvedTo);
  const resolvedNonCpc = fallerList.filter((f) => f.resolvedTo);

  console.log('\n================ MELTWATER UNKNOWN-SOURCE AUDIT ================');
  console.log(`Window: last ${WINDOW_DAYS} days | pages fetched: ${pagesFetched} @ page_size ${pageSize || 'n/a'} | day quota remaining: ${dayRemaining ?? '?'}`);
  if (pagesFetched === 0) {
    console.log('\nNo pages fetched — the /v3/search daily quota is exhausted (shared ~50/day key).');
    console.log('Re-run after the daily quota resets to get the live unknown-source list.\n');
    return;
  }
  const fallerDocs = fallerList.reduce((s, f) => s + f.count, 0);
  console.log(`Docs fetched: ${total} | usable (title+url): ${mapped}`);
  console.log(`Kept REAL adversary identity (already registered -cpc): ${mapped - fallerDocs} docs across ${kept.size} outlets`);
  console.log(`Fell to CATCH-ALL (lose identity + country): ${fallerList.reduce((s, f) => s + f.count, 0)} docs across ${fallerList.length} distinct sources\n`);

  console.log(`--- A. UNRESOLVED (truly unknown to the registry — TOP CANDIDATES TO REGISTER): ${unresolved.length} ---`);
  if (unresolved.length === 0) console.log('   (none — every catch-all doc at least matched a registry row)');
  for (const f of unresolved) {
    console.log(`   ${String(f.count).padStart(5)}  ${f.name}${f.domain ? `  [${f.domain}]` : ''}${f.social ? `  (social: ${f.social})` : ''}`);
    for (const u of f.sampleUrls) console.log(`           e.g. ${u}`);
  }

  console.log(`\n--- B. RESOLVED but NOT -cpc (known to registry, not tagged adversary — REVIEW): ${resolvedNonCpc.length} ---`);
  if (resolvedNonCpc.length === 0) console.log('   (none)');
  for (const f of resolvedNonCpc) {
    console.log(`   ${String(f.count).padStart(5)}  ${f.name}${f.domain ? `  [${f.domain}]` : ''}  →  resolves to "${f.resolvedTo}"${f.social ? `  (social: ${f.social})` : ''}`);
  }

  console.log('\n--- Already-registered adversary outlets seen (kept real identity), by volume ---');
  for (const [k, c] of Array.from(kept.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(c).padStart(5)}  ${k}`);
  }
  console.log('===============================================================\n');
}

main().catch((e) => {
  console.error('Audit failed:', e?.message ?? e);
  process.exit(1);
});
