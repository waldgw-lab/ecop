/**
 * Public `/api/v1/state-media` LEAK-REGRESSION harness (Task #477).
 *
 * The state-media lane is a deliberate, clearly-labeled door onto the otherwise
 * fully-isolated adversary/contrast Curated content (Iran/Russia/China/Cuba/North
 * Korea state media). This harness locks the two halves of that contract at
 * runtime, against the LIVE public API, so a future change can never quietly
 * either (a) bleed adversary content into the clean lanes or (b) let non-adversary
 * content leak OUT of the quarantine:
 *
 *   1. CLEAN LANES STAY CLEAN — every record returned by /api/v1/articles and
 *      /api/v1/social resolves (via the SAME shared registry helpers the lane
 *      itself uses) to a NON-adversary or NON-contrast outlet. A single adversary
 *      state-media row surfacing on either is a leak and fails the run.
 *
 *   2. THE QUARANTINE IS WHAT IT CLAIMS — every record on /api/v1/state-media is
 *      flagged `stateMedia: true`, carries a valid adversary `country`/
 *      `originCountry` token, and independently re-resolves to an adversary outlet
 *      whose derived behavior is `contrast`. Nothing trusted, nothing non-adversary
 *      ever appears here.
 *
 *   3. CONTRACT SURFACE — auth is enforced (missing key -> 401), the country
 *      filter validates (bad value -> 400) and narrows correctly, pagination
 *      (limit/offset/since) behaves, and /api/v1/status advertises the lane with a
 *      count that matches the built lane.
 *
 * This harness is strictly READ-ONLY: it issues authenticated GETs and reads the
 * outlet registry. It mutates nothing, so it is safe to run anytime (including as
 * a validation step). Every request sends `x-mcop-no-cache` so the short-TTL lane
 * cache can never mask a freshly-introduced leak.
 *
 * Exit code 0 = both guarantees hold; 1 = a leak/contract violation; 3 = the app
 * server or required env (MCOP_API_KEY) was unavailable (a precondition, NOT a
 * leak), kept distinct so green genuinely means the guarantees hold.
 *
 * Usage:  tsx scripts/state-media-api.test.ts
 * Env:    HARNESS_BASE_URL (default http://localhost:5000), MCOP_API_KEY,
 *         DATABASE_URL
 */

import { storage } from '../server/storage';
import {
  buildOutletIndex,
  findOutlet,
  deriveOutletBehavior,
  ADVERSARY_COUNTRIES,
  adversaryCountryToken,
  type OutletIndex,
} from '@shared/outletRegistry';

const BASE_URL = process.env.HARNESS_BASE_URL || 'http://localhost:5000';
const PRECONDITION_EXIT_CODE = 3;

class ServerUnreachableError extends Error {}

const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[sm] OK   ${name}`);
  } else {
    console.error(`[sm] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

// Adversary outlet display names used as a human-readable BACKSTOP to the
// registry-resolution leak check below. The registry check is canonical; this
// list catches the obvious case even if a row failed to resolve for some reason.
// Scoped to the ADVERSARY_COUNTRIES set ONLY (Russia/China/Iran/Cuba/North Korea).
// teleSUR (Venezuela) is intentionally NOT here: Venezuela is excluded from the
// adversary lane, so teleSUR is allowed on the clean lanes and must not be flagged.
const ADVERSARY_NAME_RE =
  /\b(RT|Russia Today|TASS|Sputnik|Press TV|Tehran Times|PressTV|Global Times|China Daily|People'?s Daily|CGTN|Xinhua|KCNA|Rodong|Granma|Prensa Latina)\b/i;

function apiKeyHeaders(): Record<string, string> {
  const key = process.env.MCOP_API_KEY;
  if (!key) throw new ServerUnreachableError('MCOP_API_KEY is not set — cannot query the public REST API');
  // Always bypass the lane cache so a just-introduced leak can never be masked
  // by a stale pre-change snapshot.
  return { 'X-API-Key': key, 'x-mcop-no-cache': '1' };
}

async function waitForServer(): Promise<void> {
  const retries = Number(process.env.HARNESS_READINESS_RETRIES) || 60;
  const delayMs = Number(process.env.HARNESS_READINESS_DELAY_MS) || 1000;
  const url = `${BASE_URL}/api/v1/status`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await fetch(url); // any HTTP response (even 401) proves it is listening
      if (attempt > 1) console.log(`[sm] app server reachable after ${attempt} attempt(s)`);
      return;
    } catch {
      if (attempt === 1) console.log(`[sm] waiting for app server at ${BASE_URL}...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new ServerUnreachableError(`app server never became reachable at ${BASE_URL}`);
}

interface ApiResult {
  status: number;
  body: any;
}

async function get(path: string, withKey = true): Promise<ApiResult> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: withKey ? apiKeyHeaders() : { 'x-mcop-no-cache': '1' },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body — leave null, the caller's status assertion will catch it */
  }
  return { status: res.status, body };
}

// /api/v1/state-media caps a single page at PAGE_SIZE (mirrors the route's own
// `parseQueryInt(req.query.limit, 50, 500)` ceiling). /api/v1/status reports the
// FULL, uncapped lane length. Task #639: the status-count comparison used to
// compare that full count against a single limit=500 page, which silently
// under-counted (falsely looked "off") the moment the lane grew past 500 rows.
// Page through the whole lane here so the comparison is like-for-like.
const PAGE_SIZE = 500;
async function fetchAllStateMedia(): Promise<any[]> {
  // Dedup by id: each page is a fresh no-cache rebuild, so a curated ingest
  // landing BETWEEN two page fetches can shift the window and make one row
  // straddle a page boundary (appearing twice) — which would otherwise inflate
  // the count and either falsely trip the status-count check or mask a real
  // shrink. Keying by id keeps the paginated total a true DISTINCT lane size
  // regardless of cross-page churn, so the check stays reliable as the lane grows.
  const byId = new Map<any, any>();
  let offset = 0;
  for (;;) {
    const page = await get(`/api/v1/state-media?limit=${PAGE_SIZE}&offset=${offset}`);
    const rows: any[] = Array.isArray(page.body?.data) ? page.body.data : [];
    for (const r of rows) byId.set(r?.id ?? Symbol(), r);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    // Safety valve so a pagination bug (e.g. offset not advancing) can never spin forever.
    if (offset > 100000) {
      throw new Error(`fetchAllStateMedia: offset exceeded safety limit (100000) — possible pagination bug`);
    }
  }
  return [...byId.values()];
}

// Mirrors EXACTLY the inclusion predicate buildStateMediaRecords() uses, so the
// leak check on the clean lanes asks the same question the lane asks: "is this an
// adversary outlet whose behavior is contrast?" Returns the country token if so.
function adversaryContrastToken(
  index: OutletIndex,
  source: string | null | undefined,
  url: string | null | undefined,
): string | null {
  const outlet = findOutlet(index, source, url);
  if (!outlet) return null;
  const origin = outlet.originCountry;
  if (!origin || !ADVERSARY_COUNTRIES.includes(origin)) return null;
  const behavior = deriveOutletBehavior(outlet);
  if (behavior.blocked) return null;
  if (behavior.label !== 'contrast') return null;
  return adversaryCountryToken(origin);
}

async function run() {
  await waitForServer();

  const registry = await storage.getOutletRegistry();
  const index = buildOutletIndex(registry);
  const validTokens = ADVERSARY_COUNTRIES.map(adversaryCountryToken);

  // -- AUTH -----------------------------------------------------------------
  const noKey = await get('/api/v1/state-media', false);
  check('missing API key -> 401', noKey.status === 401, `got ${noKey.status}`);

  // -- QUARANTINE IS WHAT IT CLAIMS ----------------------------------------
  const lane = await get('/api/v1/state-media?limit=500');
  check('state-media 200 + envelope', lane.status === 200 && lane.body?.success === true && Array.isArray(lane.body?.data), `status ${lane.status}`);
  const records: any[] = Array.isArray(lane.body?.data) ? lane.body.data : [];
  check('state-media count matches data length', lane.body?.count === records.length, `count=${lane.body?.count} len=${records.length}`);

  let badRecord: string | null = null;
  for (const r of records) {
    if (r.stateMedia !== true) { badRecord = `id=${r.id} missing stateMedia:true`; break; }
    if (!validTokens.includes(r.country)) { badRecord = `id=${r.id} country='${r.country}' not adversary`; break; }
    if (!validTokens.includes(r.originCountry)) { badRecord = `id=${r.id} originCountry='${r.originCountry}' not adversary`; break; }
    if (!r.url || !r.title) { badRecord = `id=${r.id} missing url/title`; break; }
    const tok = adversaryContrastToken(index, r.source, r.url);
    if (!tok) { badRecord = `id=${r.id} source='${r.source}' does not re-resolve to adversary+contrast`; break; }
  }
  check('every state-media record is flagged adversary+contrast', badRecord === null, badRecord || '');

  // -- CLEAN LANES STAY CLEAN (the core leak guard) ------------------------
  const articles = await get('/api/v1/articles?limit=500');
  check('articles 200', articles.status === 200, `status ${articles.status}`);
  const articleRows: any[] = Array.isArray(articles.body?.data) ? articles.body.data : [];
  let articleLeak: string | null = null;
  for (const a of articleRows) {
    const tok = adversaryContrastToken(index, a.source, a.url);
    if (tok) { articleLeak = `adversary outlet '${a.source}' (${tok}) on /articles: ${a.title}`; break; }
    if (typeof a.source === 'string' && ADVERSARY_NAME_RE.test(a.source)) { articleLeak = `adversary name '${a.source}' on /articles (backstop)`; break; }
  }
  check(`articles adversary-free (${articleRows.length} scanned)`, articleLeak === null, articleLeak || '');

  const social = await get('/api/v1/social?limit=500');
  check('social 200', social.status === 200, `status ${social.status}`);
  const socialRows: any[] = Array.isArray(social.body?.data) ? social.body.data : [];
  let socialLeak: string | null = null;
  for (const s of socialRows) {
    const tok = adversaryContrastToken(index, s.sourceAccount, s.url);
    if (tok) { socialLeak = `adversary outlet '${s.sourceAccount}' (${tok}) on /social`; break; }
    if (typeof s.sourceAccount === 'string' && ADVERSARY_NAME_RE.test(s.sourceAccount)) { socialLeak = `adversary name '${s.sourceAccount}' on /social (backstop)`; break; }
  }
  check(`social adversary-free (${socialRows.length} scanned)`, socialLeak === null, socialLeak || '');

  // -- COUNTRY FILTER -------------------------------------------------------
  const invalid = await get('/api/v1/state-media?country=france');
  check('invalid country -> 400', invalid.status === 400, `got ${invalid.status}`);

  // Pick the adversary country with the most records (if any) and prove the
  // filter returns ONLY that country. Avoids cross-call count equality (which
  // could flake against concurrent ingest) — the per-record token check is exact.
  const byCountry = new Map<string, number>();
  for (const r of records) byCountry.set(r.country, (byCountry.get(r.country) || 0) + 1);
  const top = [...byCountry.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) {
    const [tokenWanted] = top;
    const filtered = await get(`/api/v1/state-media?country=${tokenWanted}&limit=500`);
    const frows: any[] = Array.isArray(filtered.body?.data) ? filtered.body.data : [];
    const allMatch = frows.length > 0 && frows.every((r) => r.country === tokenWanted);
    check(`country=${tokenWanted} filter returns only that country (${frows.length})`, allMatch, frows.length === 0 ? 'no rows returned' : 'mixed countries');
  } else {
    console.log('[sm] note: lane currently empty — country-filter content check skipped (structural checks still ran)');
  }

  // -- PAGINATION -----------------------------------------------------------
  const limited = await get('/api/v1/state-media?limit=3');
  const lrows: any[] = Array.isArray(limited.body?.data) ? limited.body.data : [];
  check('limit=3 caps page size', limited.status === 200 && lrows.length <= 3, `len=${lrows.length}`);

  const farOffset = await get('/api/v1/state-media?offset=1000000');
  check('huge offset -> empty page', farOffset.status === 200 && Array.isArray(farOffset.body?.data) && farOffset.body.data.length === 0, `len=${farOffset.body?.data?.length}`);

  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const sinceFuture = await get(`/api/v1/state-media?since=${future}`);
  check('since=future -> empty page', sinceFuture.status === 200 && Array.isArray(sinceFuture.body?.data) && sinceFuture.body.data.length === 0, `len=${sinceFuture.body?.data?.length}`);

  // -- STATUS ADVERTISEMENT -------------------------------------------------
  const status = await get('/api/v1/status');
  const endpoints: any[] = status.body?.data?.endpoints || [];
  check('status advertises /api/v1/state-media', endpoints.some((e) => e.path === '/api/v1/state-media'), 'endpoint not advertised');
  const statusCount = status.body?.data?.counts?.stateMedia;
  // /api/v1/status reports the FULL, uncapped lane length. `records` above is a
  // single limit=500 page and is the wrong comparison once the lane exceeds 500
  // rows (Task #639: was comparing a capped fetch against an uncapped count).
  // Page through the whole lane so this is like-for-like; tolerate a tiny drift
  // between the two live calls in case a curated ingest write lands between them.
  const fullLane = await fetchAllStateMedia();
  check(
    'status stateMedia count tracks the FULL lane (paginated, not a single capped page)',
    typeof statusCount === 'number' && Math.abs(statusCount - fullLane.length) <= 5,
    `status=${statusCount} fullLane=${fullLane.length} (single-page=${records.length})`,
  );

  console.log(`\n[sm] scanned: state-media=${records.length} (page) / ${fullLane.length} (full), articles=${articleRows.length}, social=${socialRows.length}`);
}

run()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n[sm] ${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`);
      process.exit(1);
    }
    console.log('\n[sm] ALL CHECKS PASSED — state-media lane isolated both ways.');
    process.exit(0);
  })
  .catch((err) => {
    if (err instanceof ServerUnreachableError) {
      console.error(`[sm] PRECONDITION: ${err.message}`);
      process.exit(PRECONDITION_EXIT_CODE);
    }
    console.error('[sm] FATAL', err);
    process.exit(2);
  });
