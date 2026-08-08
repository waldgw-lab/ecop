/**
 * Non-disruption regression harness for the MCOP relevance refactor.
 *
 * Goal: prove that the Classic ("/api/headline-feed"), Visual / Stream
 * ("/api/stream") and at least one custom MCOP ("/api/custom-mcops/:slug/feed")
 * feeds produce the SAME canonical output before and after the relevance /
 * batching refactor. Nothing in this harness mutates state — it only reads.
 *
 * Several feed fields are TIME-VOLATILE: the priority decay
 * (`depreciatedPriority`, the derived `priorityScore`, `basePriorityScore`) and
 * the ordering that depends on it change purely because time has passed, with no
 * code change at all. The canonicalizer strips those volatile fields and sorts
 * collections by a stable `id` so that two snapshots taken at different moments
 * are comparable. What remains — the SET of stories and their frozen content
 * fields (title, summary, category, tags, source, url, cluster membership, …) —
 * is exactly what must stay byte-identical across the refactor.
 *
 * Usage:
 *   tsx scripts/relevance-harness.ts snapshot [customMcopSlug]
 *   tsx scripts/relevance-harness.ts compare  [customMcopSlug]
 *
 * Env:
 *   HARNESS_BASE_URL   default http://localhost:5000
 *   HARNESS_DIR        default .local/harness
 *
 * EXIT CODE CONVENTION (Task #639, see scripts/harness-reliability.ts):
 *   0 = PASS         — every checked feed is unchanged (byte-identical for
 *                       headline-feed/custom-*; set-membership-equivalent for
 *                       'stream', see below).
 *   1 = FAIL         — a REAL diff: shared content changed, or items vanished
 *                       from 'stream' with no replacement, or a byte-identical
 *                       feed's canonical output changed.
 *   2 = usage error / no baselines found (not a feed-content judgment at all).
 *   3 = INCONCLUSIVE — login or network preconditions failed (server
 *                       unreachable, bad APP_PASSWORD, etc.) — never a signal
 *                       about the feeds themselves.
 *
 * 'stream' IS LIVE-VOLATILE BY DESIGN (Task #639): unlike headline-feed/custom
 * feeds, its topStories/nextUpStories window continuously re-ranks and
 * churns membership as scraping and priority decay run in the background —
 * a byte-identical comparison flakes constantly and is not a real signal. So
 * 'stream' instead compares the SET of story ids (union of
 * topStories+nextUpStories) between baseline and current:
 *   - Content of an id present in BOTH runs must be identical (canonicalized).
 *   - Ids can freely drop out of / enter the window (aging out, reshuffling,
 *     new arrivals) — that alone is TIER_RESHUFFLE_ONLY / ADDITIONS_ONLY and
 *     is NOT a failure.
 *   - It IS a REAL_DIFF if a shared id's content changed, or if ids vanished
 *     from the window with no replacement (net window size shrank), since
 *     that points at a real regression (e.g. the feed silently returning
 *     fewer stories) rather than ordinary churn.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

const BASE_URL = process.env.HARNESS_BASE_URL || 'http://localhost:5000';
const OUT_DIR = process.env.HARNESS_DIR || path.join('.local', 'harness');

// Fields whose values are derived from the current time (priority decay) and so
// will legitimately differ between two runs even with identical code. They are
// removed before comparison to avoid false positives.
const VOLATILE_KEYS = new Set([
  'depreciatedPriority',
  'priorityScore',
  'basePriorityScore',
]);

type Json = any;

// Task #639: login/network failures are PRECONDITIONS, not a judgment about the
// feeds under test — they must exit INCONCLUSIVE (3), never FAIL (1) or the
// generic usage-error code (2), so a down dev server can't be mistaken for a
// real non-disruption regression.
class PreconditionError extends Error {}

// A session cookie captured at login. All three feeds accept a
// password-authenticated user session (`session.authenticated === true`), so a
// single login via /api/auth/login is enough to read every target endpoint.
let sessionCookie: string | null = null;

async function login(): Promise<void> {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    throw new PreconditionError('APP_PASSWORD is not set — cannot authenticate to the feeds');
  }
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The session cookie is `secure: true` behind `trust proxy: 1`, so it is
        // only issued when the request looks like HTTPS. Spoof the proxy header so
        // the cookie is set when hitting the server directly over localhost HTTP.
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ password }),
    });
  } catch (err) {
    throw new PreconditionError(`could not reach app server at ${BASE_URL}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new PreconditionError(`login failed: ${res.status} ${res.statusText}`);
  }
  // Node's fetch (undici) exposes multiple Set-Cookie headers via getSetCookie().
  const cookies = typeof (res.headers as any).getSetCookie === 'function'
    ? (res.headers as any).getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  if (!cookies || cookies.length === 0) {
    throw new PreconditionError('login succeeded but no session cookie was returned');
  }
  // Keep only the cookie name=value pairs (drop attributes like Path/HttpOnly).
  sessionCookie = cookies.map((c: string) => c.split(';')[0]).join('; ');
  console.log('[harness] authenticated');
}

function canonicalize(value: Json): Json {
  if (Array.isArray(value)) {
    const mapped = value.map(canonicalize);
    // Sort collections of objects by a stable id so decay-driven reordering
    // does not register as a difference.
    if (mapped.every(v => v && typeof v === 'object' && !Array.isArray(v) && 'id' in v)) {
      mapped.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }
    return mapped;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

async function fetchJson(url: string): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: sessionCookie ? { Cookie: sessionCookie } : {},
    });
  } catch (err) {
    throw new PreconditionError(`could not reach ${url}: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new PreconditionError(`GET ${url} -> ${res.status} (auth precondition, not a feed regression)`);
  }
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function resolveCustomSlug(provided?: string): Promise<string | null> {
  if (provided) return provided;
  try {
    const list = await fetchJson(`${BASE_URL}/api/custom-mcops`);
    if (Array.isArray(list) && list.length > 0 && list[0]?.slug) {
      return list[0].slug;
    }
  } catch (err) {
    console.warn(`[harness] could not auto-resolve a custom MCOP slug: ${(err as Error).message}`);
  }
  return null;
}

async function collectSnapshots(slug: string | null): Promise<Record<string, Json>> {
  const targets: Array<{ name: string; url: string }> = [
    { name: 'headline-feed', url: `${BASE_URL}/api/headline-feed` },
    { name: 'stream', url: `${BASE_URL}/api/stream` },
  ];
  if (slug) {
    targets.push({ name: `custom-${slug}`, url: `${BASE_URL}/api/custom-mcops/${slug}/feed` });
  } else {
    console.warn('[harness] no custom MCOP slug available — skipping custom feed snapshot');
  }

  const result: Record<string, Json> = {};
  for (const t of targets) {
    const raw = await fetchJson(t.url);
    result[t.name] = canonicalize(raw);
    const count = Array.isArray(raw) ? raw.length : Object.keys(raw).length;
    console.log(`[harness] captured ${t.name} (${count} top-level entries)`);
  }
  return result;
}

function stableStringify(value: Json): string {
  return JSON.stringify(value, null, 2);
}

type StreamVerdict = 'IDENTICAL' | 'TIER_RESHUFFLE_ONLY' | 'ADDITIONS_ONLY' | 'REAL_DIFF';

// Union of the two windowed arrays that make up the 'stream' feed's live-
// ranked surface. Anything else on the payload (truthSocialPosts, xPosts,
// firstAlerts) is a different, less volatile surface and stays on the
// byte-identical path.
function streamNodeMap(canonicalStream: Json): Map<string, Json> {
  const map = new Map<string, Json>();
  const arrays = [canonicalStream?.topStories, canonicalStream?.nextUpStories];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (item && typeof item === 'object' && typeof item.id === 'string') {
        map.set(item.id, item);
      }
    }
  }
  return map;
}

// Task #639: 'stream' churns its window by design (priority decay + live
// scraping), so a byte-identical diff is mostly noise. Judge it instead by:
//   - shared ids must have IDENTICAL content (a real content regression), and
//   - the window must not have NET SHRUNK (ids vanishing with no replacement
//     — a real "the feed silently returned less" regression), tolerating
//     any amount of pure reshuffling or net-positive turnover.
function compareStreamSets(baseline: Json, current: Json): { verdict: StreamVerdict; detail: string } {
  const baseMap = streamNodeMap(baseline);
  const curMap = streamNodeMap(current);

  const changedIds: string[] = [];
  for (const [id, baseItem] of baseMap) {
    if (!curMap.has(id)) continue;
    const curItem = curMap.get(id);
    if (JSON.stringify(baseItem) !== JSON.stringify(curItem)) {
      changedIds.push(id);
    }
  }
  if (changedIds.length > 0) {
    return {
      verdict: 'REAL_DIFF',
      detail: `${changedIds.length} shared id(s) changed content while remaining in the window: ${changedIds.slice(0, 5).join(', ')}`,
    };
  }

  const vanished = [...baseMap.keys()].filter(id => !curMap.has(id));
  const added = [...curMap.keys()].filter(id => !baseMap.has(id));
  if (vanished.length > added.length) {
    return {
      verdict: 'REAL_DIFF',
      detail: `window net-shrank: ${vanished.length} id(s) vanished vs only ${added.length} added ` +
        `(baseline=${baseMap.size} current=${curMap.size}); vanished: ${vanished.slice(0, 5).join(', ')}`,
    };
  }
  if (vanished.length === 0 && added.length === 0) {
    return { verdict: 'IDENTICAL', detail: 'same ids, same content' };
  }
  if (vanished.length === 0) {
    return { verdict: 'ADDITIONS_ONLY', detail: `${added.length} new id(s) entered the window, nothing dropped` };
  }
  return {
    verdict: 'TIER_RESHUFFLE_ONLY',
    detail: `${vanished.length} id(s) aged out / re-ranked, ${added.length} replaced them — shared content unchanged`,
  };
}

async function snapshot(slug: string | null) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const snaps = await collectSnapshots(slug);
  for (const [name, data] of Object.entries(snaps)) {
    const file = path.join(OUT_DIR, `${name}.json`);
    await fs.writeFile(file, stableStringify(data));
    console.log(`[harness] wrote ${file}`);
  }
  console.log('[harness] snapshot complete');
}

async function compare(slug: string | null) {
  const snaps = await collectSnapshots(slug);
  let anyDiff = false;
  let anyChecked = false;
  for (const [name, data] of Object.entries(snaps)) {
    const file = path.join(OUT_DIR, `${name}.json`);
    let baseline: string;
    try {
      baseline = await fs.readFile(file, 'utf8');
    } catch {
      console.warn(`[harness] no baseline for ${name} (${file}) — run snapshot first`);
      continue;
    }
    anyChecked = true;
    const current = stableStringify(data);

    if (name === 'stream') {
      // 'stream' gets the set-membership comparison, not byte-identical — see
      // the file header comment. `data` and the parsed baseline are both
      // already canonicalized JSON.
      const baselineParsed = JSON.parse(baseline);
      const { verdict, detail } = compareStreamSets(baselineParsed, data);
      if (verdict === 'REAL_DIFF') {
        anyDiff = true;
        console.error(`[harness] DIFF ${name}: REAL_DIFF — ${detail}`);
      } else {
        console.log(`[harness] OK  ${name}: ${verdict} — ${detail}`);
      }
      continue;
    }

    if (current === baseline) {
      console.log(`[harness] OK  ${name}: byte-identical`);
    } else {
      anyDiff = true;
      console.error(`[harness] DIFF ${name}: canonical output changed`);
      const a = baseline.split('\n');
      const b = current.split('\n');
      const max = Math.max(a.length, b.length);
      let shown = 0;
      for (let i = 0; i < max && shown < 40; i++) {
        if (a[i] !== b[i]) {
          console.error(`  L${i + 1}\n    - ${a[i] ?? '<missing>'}\n    + ${b[i] ?? '<missing>'}`);
          shown++;
        }
      }
    }
  }
  if (!anyChecked) {
    console.error('[harness] nothing compared — no baselines found');
    process.exit(2);
  }
  if (anyDiff) {
    process.exit(1);
  }
  console.log('[harness] compare complete — all feeds byte-identical');
}

async function main() {
  const mode = process.argv[2];
  const slugArg = process.argv[3];
  if (mode !== 'snapshot' && mode !== 'compare') {
    console.error('Usage: tsx scripts/relevance-harness.ts <snapshot|compare> [customMcopSlug]');
    process.exit(2);
  }
  await login();
  const slug = await resolveCustomSlug(slugArg);
  if (mode === 'snapshot') {
    await snapshot(slug);
  } else {
    await compare(slug);
  }
}

main().catch(err => {
  if (err instanceof PreconditionError) {
    // Login/network problems are a precondition failure, not a signal about
    // the feeds themselves — INCONCLUSIVE (3), retry once the server/creds
    // are sane, never treat as PASS or FAIL.
    console.error('[harness] INCONCLUSIVE (precondition):', err.message);
    process.exit(3);
  }
  console.error('[harness] fatal:', err);
  process.exit(2);
});
