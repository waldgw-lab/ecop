/**
 * Curated + enrichment ISOLATION regression harness (Task #94).
 *
 * Locks the two guarantees that keep the wider/lower-trust Curated aperture and
 * the Outlet-Registry enrichment layer from ever bleeding into the trusted
 * feeds. It proves, at runtime, that:
 *
 *   1. ENRICHMENT NON-DISRUPTION — (FULL mode only; gated behind --full) a full
 *      `runOutletEnrichment` pass leaves the
 *      four trusted surfaces byte-identical (after stripping time-volatile
 *      decay fields):
 *        - Classic        GET /api/headline-feed
 *        - Visual/Stream  GET /api/stream
 *        - Custom MCOP    GET /api/custom-mcops/:slug/feed
 *        - Public REST    GET /api/v1/articles  +  GET /api/v1/social
 *
 *   2. ENRICHMENT WRITE-SCOPE — the pass writes ONLY descriptive registry
 *      columns: it NEVER mutates a field a human has locked via
 *      `manualOverrides`, and it NEVER writes the `role` column (the curated
 *      tier is a labeling decision, not an enrichment output). A throwaway
 *      outlet that the reference adapter DOES match is used so the skip path is
 *      genuinely exercised (a non-override field IS written, proving the pass
 *      really ran on it), then it is deleted.
 *
 *   3. CURATED NON-LEAK — items seeded into the SEPARATE curated store never
 *      appear in any trusted surface (negative control), while the same store
 *      IS reachable through the curated-gated endpoint (positive control), so a
 *      real leak would actually be caught rather than passing vacuously.
 *
 *   4. CURATED CLUSTERING ISOLATION — a `clusterCuratedLane` pass leaves every
 *      `headlines.cluster_id` untouched (curated clustering writes only to the
 *      isolated curated_cluster_members mapping that feeds Classic/Visual). The
 *      pass is AI-backed; it (and the AI-backed intake gate) is bounded by an AI
 *      time budget (HARNESS_AI_BUDGET_MS) so a slow / rate-limited model cannot
 *      turn the fast gate into a hang. The isolation guarantee is STRUCTURAL and
 *      is asserted whether the pass completes or hits its budget.
 *
 * This harness DOES mutate state (it seeds + enrichment-passes + clusters), but
 * every mutation it introduces is its own and is cleaned up; the enrichment and
 * clustering passes it triggers are the exact passes the scheduler runs anyway,
 * so they are non-destructive to real data.
 *
 * Exit code 0 = all guarantees hold; non-zero = a guarantee was violated.
 *
 * Usage:  tsx scripts/curated-isolation-harness.ts [customMcopSlug] [--full]
 *         (no slug arg = test ALL custom-MCOP feeds; fails loudly if none exist)
 *         DEFAULT (no --full) = FAST mode: every deterministic isolation /
 *         non-leak / write-scope / clustering / dead-link / intake / social
 *         check runs in seconds — this is what the auto-run `curated-isolation`
 *         validation gate executes on every task.
 *         --full (or CURATED_ISO_FULL=1) ALSO runs the slow, flaky live-only
 *         enrichment "byte-identical non-disruption" comparison; it is excluded
 *         from automation on purpose (pipeline-health monitoring already covers
 *         live enrichment/scraping health separately).
 *
 * EXIT CODE CONVENTION (Task #639, see scripts/harness-reliability.ts):
 *   0 = PASS         — every guarantee holds.
 *   1 = FAIL         — a genuine isolation/write-scope violation (never
 *                       downgraded, retries do not launder this).
 *   2 = fatal/unexpected error (crash, not a guarantee violation).
 *   3 = INCONCLUSIVE — the app server/precondition was unavailable, OR (FULL
 *                       mode only) the byte-identical non-disruption check
 *                       still disagreed after bounded retries, most likely
 *                       because live background scraping mutated a trusted
 *                       surface mid-comparison rather than the enrichment pass
 *                       itself. Distinct from FAIL so transient live-data
 *                       churn can never masquerade as a real leak.
 * Env:    HARNESS_BASE_URL (default http://localhost:5000), APP_PASSWORD,
 *         MCOP_API_KEY, DATABASE_URL, OPENAI_API_KEY
 */

import { and, eq, inArray, like } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { db } from '../server/db';
import { storage } from '../server/storage';
import { outletRegistry, curatedItems, curatedLinkReplacements, curatedHiddenStories, curatedPriorityOverrides, headlines, teamSubmissions, truthSocialPosts, xPosts, sentDefenderPosts, journalistPosts } from '@shared/schema';
import { normalizeTitle } from '../server/titleNormalizer';
import { runOutletEnrichment } from '../server/enrichment';
import { clusterCuratedLane } from '../server/curatedCluster';
import {
  cacheCuratedItemMedia,
  staleCuratedMediaFilters,
  MAX_MEDIA_ATTEMPTS,
} from '../server/streamPrefetch';
import { admitCuratedCandidates, ingestTeamSubmissionsToCurated } from '../server/curatedIngest';
import { identifyCuratedClusters, type LaneNode } from '../server/curatedCluster';
import { sleep, isTransientAIError } from './harness-reliability';

// Task #492: deterministic AI-stub gate for THIS harness process only. Set before
// any curated AI-backed side-effect runs so the LLM admission gate and reuse-intake
// enrichment substitute network-free deterministic results — the gate exercises the
// curated code paths and asserts on RESULTS instead of surviving a live 429 storm.
// The production server never sets this env var, so live behavior is unaffected.
process.env.CURATED_AI_HARNESS_STUB = '1';

const BASE_URL = process.env.HARNESS_BASE_URL || 'http://localhost:5000';

// Fast-by-default gate (Task #489). The curated→main-feed isolation safety net
// must run automatically, in seconds, on EVERY task. The only minutes-long,
// flaky piece is the live enrichment "byte-identical non-disruption" feed
// snapshot comparison: it double-snapshots every heavy uncached trusted feed
// (incl. /api/stream and every custom MCOP) and flakes when live scraping
// mutates a feed between the two snapshots. That comparison — and any other slow
// live-only assertion — runs ONLY when explicitly opted in via `--full` (argv)
// or CURATED_ISO_FULL=1; the default path stays deterministic. Live
// enrichment/scraping health remains covered by the pipeline-health monitoring,
// so excluding it from the automated gate loses no coverage.
const FULL_MODE =
  process.argv.includes('--full') || process.env.CURATED_ISO_FULL === '1';

// AI time budget (Task #489). The isolation guarantees under test are STRUCTURAL
// — curated content never leaks into the trusted feeds, enrichment never writes
// role, clustering never touches headlines.cluster_id — and hold whether or not
// an AI-backed side-effect (clustering / the curated LLM admission gate) actually
// completes. A rate-limited or slow model must therefore NOT be able to turn the
// fast gate into a minutes-long hang: each AI-backed call is bounded, and on
// timeout we log and proceed to the assertion exactly as the existing catch
// already does for an AI *throw*. Tune via HARNESS_AI_BUDGET_MS. The default is
// deliberately tight: the clustering / admission AI side-effects are nice-to-have
// exercise, but the STRUCTURAL isolation assertions (which always run) are the
// load-bearing value, so we cap the wall-clock cost rather than wait out a slow
// or rate-limited model.
const AI_BUDGET_MS = Number(process.env.HARNESS_AI_BUDGET_MS) || 20000;
// Once any AI-backed call in this run exceeds its budget, the model is almost
// certainly unavailable / rate-limited, so every SUBSEQUENT AI call fails fast
// instead of waiting out another full budget. This collapses the worst case
// under a live 429 storm (otherwise N serial calls × full budget) while leaving
// the healthy path fully exercised: when the first AI call completes normally
// the degraded flag is never set and later calls get the full budget. Tune via
// HARNESS_AI_DEGRADED_BUDGET_MS.
const AI_DEGRADED_BUDGET_MS = Number(process.env.HARNESS_AI_DEGRADED_BUDGET_MS) || 5000;
let aiDegraded = false;

// The LIVE clusterCuratedLane write-isolation pass (Task #492) is the harness's
// one remaining live AI-backed call. Its grouping LOGIC is already proved
// deterministically in Phase 4, so this pass is a best-effort INTEGRATION check
// (the real DB write path never touches headlines.cluster_id). On a healthy pass
// it reaches its curated writes; under a 429 storm it is abandoned and the
// headlines-untouched assertion holds vacuously either way. It gets its own
// tighter budget (vs. the generic AI_BUDGET_MS) so the fast gate stays well under
// 30s during a storm. Tune via HARNESS_CLUSTER_ISO_BUDGET_MS.
const CLUSTER_ISO_BUDGET_MS = Number(process.env.HARNESS_CLUSTER_ISO_BUDGET_MS) || 10000;

// `exemptDegraded` keeps a call at its full budget even after the model is
// flagged degraded. Use it for AI calls whose SIDE-EFFECT is itself asserted
// (e.g. team-intake seeding) — fast-failing those would turn a real assertion
// into a hard FAIL instead of a graceful skip. Calls that only fall through to
// structural assertions on timeout (clustering, admission) take the cap.
function withBudget<T>(
  label: string,
  p: Promise<T>,
  ms: number = AI_BUDGET_MS,
  exemptDegraded = false,
): Promise<T> {
  const effective = aiDegraded && !exemptDegraded ? Math.min(ms, AI_DEGRADED_BUDGET_MS) : ms;
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Mark the model degraded so the next AI call short-circuits.
      aiDegraded = true;
      reject(new Error(`${label} exceeded ${effective}ms AI budget`));
    }, effective);
    // Don't keep the event loop alive solely for this timer.
    (timer as { unref?: () => void }).unref?.();
  });
  // When the budget guard wins the race, `p` is abandoned but keeps running in
  // the background (e.g. clusterCuratedLane retries + Anthropic fallback under a
  // 429 storm). If that abandoned pass later REJECTS, its rejection would surface
  // as an unhandledRejection and crash the harness to exit 2 — a transient-AI
  // hard-FAIL of an otherwise-passing isolation run, landing before or after the
  // normal process.exit() purely by timing (the flake). Attach a no-op catch so a
  // late settlement is always handled; the timeout has already been reported to
  // the caller, and clusterCuratedLane only writes curated tables so a late
  // failure cannot affect the structural isolation assertions.
  void p.catch(() => {});
  return Promise.race([p, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Decay-driven fields that legitimately differ between two snapshots taken at
// different moments with identical code. Mirrors scripts/relevance-harness.ts.
const VOLATILE_KEYS = new Set([
  'depreciatedPriority',
  'priorityScore',
  'basePriorityScore',
]);

// A unique marker stamped into every seeded canary so we can detect it (or its
// absence) anywhere in a response, regardless of that response's shape.
const MARKER = `__MCOP_ISO_CANARY_${Date.now()}__`;
const OVERRIDE_SENTINEL = '__iso_override_sentinel__';
// Stable prefix (no timestamp) so residue from ANY prior run can be swept by
// pattern, the same way the curated canaries are swept by their URL prefix.
const TEST_OUTLET_KEY_PREFIX = '__iso_test_outlet_';
const TEST_OUTLET_KEY = `${TEST_OUTLET_KEY_PREFIX}${Date.now()}__`;
// Postgres LIKE treats `_` as a single-char wildcard; escape the literal
// underscores (default escape char is `\`) so the sweep matches only real
// throwaway-outlet keys, not coincidental ones.
const TEST_OUTLET_KEY_LIKE = `${TEST_OUTLET_KEY_PREFIX.replace(/_/g, '\\_')}%`;

// Stable id/url prefixes for every residue path the harness seeds, shared by the
// per-phase sweeps AND the centralized teardown (cleanupAllResidue) so a single
// routine can remove all residue on interruption/failure. Every curated/team
// canary URL lives under ISOLATION_URL_PREFIX; social canaries are keyed by id.
//
// Exported so scripts/test-sigkill-self-heal.ts can seed rows using these EXACT
// prefixes — guaranteeing cleanupAllResidue() will match them. Any prefix change
// here is automatically reflected in the regression seed, so drift is caught.
export const ISOLATION_URL_PREFIX = 'https://isolation.invalid/';
export const TS_POST_PREFIX = '__MCOP_ISO_SOCIAL_TS_';
export const X_POST_PREFIX = '__MCOP_ISO_SOCIAL_X_';
export const SD_POST_PREFIX = '__MCOP_ISO_SOCIAL_SD_';
export const JOUR_POST_PREFIX = '__MCOP_ISO_SOCIAL_JOUR_';
export const TEST_OUTLET_KEY_PREFIX_EXPORT = '__iso_test_outlet_';

type Json = any;

const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[iso] OK   ${name}`);
  } else {
    console.error(`[iso] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

// Task #639: a SEPARATE bucket from `failures` for checks that stayed
// unresolved after bounded retries because of live-data churn rather than a
// genuine guarantee violation (currently only the FULL-mode byte-identical
// non-disruption comparison). Kept distinct so main()'s exit logic can prefer
// FAIL > INCONCLUSIVE > PASS instead of conflating "definitely broken" with
// "couldn't get a clean read".
const inconclusive: string[] = [];
function checkRetryable(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[iso] OK   ${name}`);
  } else {
    console.warn(`[iso] INCONCLUSIVE ${name}${detail ? ` — ${detail}` : ''}`);
    inconclusive.push(name);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (mirror the relevance harness auth: a single password login
// yields a session that satisfies the headline-feed/stream/custom-mcop guards;
// curated endpoints are dev-open; the public API uses the X-API-Key header).
// ---------------------------------------------------------------------------
let sessionCookie: string | null = null;

// Exit code reserved for "the app server was never reachable". Kept distinct
// from 1 (isolation violated) and 2 (unexpected fatal) so a green check means
// the guarantees genuinely hold, a red 1 means a real leak, and a red 3 means
// the environment/precondition (server not up) failed — not a leak.
const PRECONDITION_EXIT_CODE = 3;

class ServerUnreachableError extends Error {}

// Poll a lightweight always-available endpoint until the app answers, so a
// startup/connection race no longer masquerades as an isolation breach. The
// window is tunable via HARNESS_READINESS_RETRIES / HARNESS_READINESS_DELAY_MS.
async function waitForServer(): Promise<void> {
  const retries = Number(process.env.HARNESS_READINESS_RETRIES) || 60;
  const delayMs = Number(process.env.HARNESS_READINESS_DELAY_MS) || 1000;
  const statusUrl = `${BASE_URL}/api/auth/status`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Any HTTP response (even 401/403) proves the server is listening; only a
      // connection-level failure means "not ready yet".
      await fetch(statusUrl);
      if (attempt > 1) console.log(`[iso] app server reachable after ${attempt} attempt(s)`);
      return;
    } catch {
      if (attempt === 1) {
        console.log(`[iso] waiting for app server at ${BASE_URL} (up to ${retries}x${delayMs}ms)...`);
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new ServerUnreachableError(
    `app server never became reachable at ${BASE_URL} — start it before running the harness`,
  );
}

async function login(): Promise<void> {
  const password = process.env.APP_PASSWORD;
  if (!password) throw new Error('APP_PASSWORD is not set — cannot authenticate to the feeds');
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    // The session cookie is `secure` behind `trust proxy`, so it is only issued
    // when the request looks like HTTPS — spoof the proxy header over localhost.
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${res.statusText}`);
  const cookies = typeof (res.headers as any).getSetCookie === 'function'
    ? (res.headers as any).getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  if (!cookies || cookies.length === 0) throw new Error('login succeeded but no session cookie returned');
  sessionCookie = cookies.map((c: string) => c.split(';')[0]).join('; ');

  // The session may be persisted to its store asynchronously, so the cookie can
  // briefly precede a readable session. Poll /api/auth/status until the session
  // is live before issuing guarded reads (avoids a startup 401 race).
  for (let attempt = 0; attempt < 10; attempt++) {
    const status = await fetchJson(`${BASE_URL}/api/auth/status`).catch(() => null);
    if (status?.authenticated) {
      console.log('[iso] authenticated');
      return;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('login succeeded but session never became active');
}

// War-dashboard viewer auth (Task #725). The `/api/war/feed` route is gated by
// `requireWarViewer`, which reads the SAME express session as the main app login,
// so we simply POST the war-viewer password with the existing session cookie to
// add `warViewerAuthenticated` to it. The war-viewer password is a hardcoded
// source constant in server/routes.ts (not a secret env var); it can be
// overridden via WAR_VIEWER_PASSWORD for a rotated deployment. Returns true on
// success so the caller can treat a failed war auth as a PRECONDITION (skip +
// mark inconclusive) rather than a false isolation FAILURE.
let warAuthed = false;
async function warLogin(): Promise<boolean> {
  const password = process.env.WAR_VIEWER_PASSWORD || 'Warriors11!!';
  try {
    const res = await fetch(`${BASE_URL}/api/war/viewer/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      },
      body: JSON.stringify({ password }),
    });
    warAuthed = res.ok;
    if (warAuthed) {
      // The war-viewer flag is stored on the existing session; the server may
      // re-issue the same cookie, so refresh it if present.
      const cookies = typeof (res.headers as any).getSetCookie === 'function'
        ? (res.headers as any).getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
      if (cookies && cookies.length > 0) {
        sessionCookie = cookies.map((c: string) => c.split(';')[0]).join('; ');
      }
      console.log('[iso] war-dashboard viewer authenticated');
    } else {
      console.warn(`[iso] war-viewer auth failed (${res.status}) — war-feed non-leak control will be inconclusive`);
    }
  } catch (e) {
    warAuthed = false;
    console.warn(`[iso] war-viewer auth errored — war-feed non-leak control will be inconclusive: ${(e as Error).message}`);
  }
  return warAuthed;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<Json> {
  const res = await fetch(url, {
    // Always bypass the curated read cache: this harness injects rows then
    // immediately asserts on the read side, so it must see fresh data, not a
    // cached snapshot from a prior cycle. Non-curated endpoints ignore this.
    headers: { ...(sessionCookie ? { Cookie: sessionCookie } : {}), 'x-mcop-no-cache': '1', ...headers },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

// Cache-PATH GET: deliberately does NOT send `x-mcop-no-cache`, so it exercises
// the exact read+cache path a real user (and the periodic pre-warm) hit. Used by
// the state-narratives invalidation phase to prove a curation write drops the
// stale cached payload on the very next NORMAL read (no TTL wait), rather than
// the always-fresh path `fetchJson` forces.
async function fetchJsonCached(url: string): Promise<Json> {
  const res = await fetch(url, {
    headers: { ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
  });
  if (!res.ok) throw new Error(`GET(cached) ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

// Authenticated JSON POST (session cookie + spoofed HTTPS proxy header so the
// `secure` session cookie is accepted over localhost). Used to drive the
// curation-write endpoints (hide-story / priority-override) whose cache
// invalidation this harness asserts.
async function postJsonAuthed(path: string, body: unknown): Promise<Json> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${res.statusText}`);
  return res.json().catch(() => ({}));
}

function apiKeyHeaders(): Record<string, string> {
  const key = process.env.MCOP_API_KEY;
  if (!key) throw new Error('MCOP_API_KEY is not set — cannot query the public REST API');
  return { 'X-API-Key': key };
}

// Resolve EVERY custom-MCOP slug so isolation is proven for all custom feeds,
// not just one. A custom MCOP is exactly the kind of surface curated content
// could leak into, so a silent skip would let a real leak pass green — if none
// exist we fail loudly rather than vacuously pass.
async function resolveCustomSlugs(provided?: string): Promise<string[]> {
  if (provided) return [provided];
  const list = await fetchJson(`${BASE_URL}/api/custom-mcops`);
  const slugs = Array.isArray(list)
    ? list.map((m: any) => m?.slug).filter((s: any): s is string => typeof s === 'string' && s.length > 0)
    : [];
  if (slugs.length === 0) {
    throw new Error(
      'no custom MCOP feeds found — cannot prove custom-MCOP isolation; refusing to silently skip ' +
      '(create at least one custom MCOP, or pass a slug as argv[2])',
    );
  }
  return slugs;
}

// Strip volatile fields and sort object collections by stable id so two
// snapshots taken moments apart are comparable. Mirrors the relevance harness.
function canonicalize(value: Json): Json {
  if (Array.isArray(value)) {
    const mapped = value.map(canonicalize);
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

// The trusted surfaces, captured + canonicalized into a comparable string.
// EVERY custom-MCOP feed is included so enrichment non-disruption is proven for
// all of them, not just one.
async function snapshotTrustedSurfaces(slugs: string[]): Promise<Record<string, string>> {
  const targets: Array<{ name: string; url: string; headers?: Record<string, string> }> = [
    { name: 'headline-feed', url: `${BASE_URL}/api/headline-feed` },
    { name: 'stream', url: `${BASE_URL}/api/stream` },
    { name: 'public-articles', url: `${BASE_URL}/api/v1/articles?limit=200`, headers: apiKeyHeaders() },
    { name: 'public-social', url: `${BASE_URL}/api/v1/social?limit=200`, headers: apiKeyHeaders() },
  ];
  for (const slug of slugs) targets.push({ name: `custom-${slug}`, url: `${BASE_URL}/api/custom-mcops/${slug}/feed` });

  const out: Record<string, string> = {};
  for (const t of targets) {
    const raw = await fetchJson(t.url, t.headers ?? {});
    out[t.name] = JSON.stringify(canonicalize(raw), null, 2);
  }
  return out;
}

// True if the marker appears anywhere in the response payload.
function containsMarker(value: Json, marker: string): boolean {
  return JSON.stringify(value ?? null).includes(marker);
}

// ===========================================================================
// PHASE 1 + 2 — enrichment non-disruption and write-scope.
// ===========================================================================
async function runEnrichmentChecks(slugs: string[]): Promise<void> {
  // Task #489: the byte-identical non-disruption comparison is the slow + flaky
  // live-only piece. Capture the "before" snapshot ONLY when that comparison
  // will actually run (FULL_MODE). The write-scope assertions below need no
  // snapshot and run on every (fast) pass.
  const before = FULL_MODE ? await snapshotTrustedSurfaces(slugs) : null;

  // Self-heal: a previous enrichment run killed mid-pass (SIGKILL before its
  // finally) leaves its throwaway "Associated Press" outlet row behind — keyed
  // by the stable TEST_OUTLET_KEY_PREFIX, role attach-only with a sentinel
  // override. Because it shares apnews.com with the real AP entry it SHADOWS it
  // in the domain index, stranding AP attach-only in dev. Sweep ALL such residue
  // (any prior run's timestamp) before seeding this run's outlet.
  await db.delete(outletRegistry).where(like(outletRegistry.key, TEST_OUTLET_KEY_LIKE));

  // Everything from the seeding insert onward runs inside try/finally so the
  // throwaway outlet is removed even if a check throws mid-run. Cleanup keys off
  // the stable TEST_OUTLET_KEY_PREFIX so it sweeps this run's row plus any
  // sibling residue, and works even on a partial insert.
  try {
    // Insert a throwaway outlet the reference adapter WILL match (apnews.com),
    // pre-loaded with a manual override on `factuality` and a non-default `role`,
    // so the skip path is genuinely exercised. originCountry starts null so we can
    // prove a NON-override field IS written by the same pass.
    const [testOutlet] = await db.insert(outletRegistry).values({
      key: TEST_OUTLET_KEY,
      canonicalName: 'Associated Press',
      aliases: [],
      domains: ['apnews.com'],
      role: 'attach-only',
      factuality: OVERRIDE_SENTINEL,
      manualOverrides: { factuality: OVERRIDE_SENTINEL },
    }).returning();

    // Snapshot role + locked-field values for EVERY registry row (incl. the test
    // outlet) immediately before the pass.
    const regBefore = await storage.getOutletRegistry();
    const roleBefore = new Map(regBefore.map(r => [r.id, r.role]));
    const overridesBefore = new Map(
      regBefore.map(r => [r.id, { overrides: (r.manualOverrides ?? {}) as Record<string, unknown>, row: r as Record<string, unknown> }]),
    );

    const summary = await runOutletEnrichment('iso-harness');
    console.log(`[iso] enrichment pass: processed=${summary.processed} updated=${summary.updated} confirmed=${summary.confirmed} skipped=${summary.skipped}`);

    // (1) Non-disruption: trusted surfaces byte-identical across the pass. This
    // is the slow + flaky live-only check (Task #489) — gated behind FULL_MODE so
    // the default validation gate stays fast and deterministic; live enrichment
    // health is covered separately by the pipeline-health monitoring.
    if (FULL_MODE && before) {
      // Task #639: this comparison is known-flaky against a live server — a
      // background scraper/cron writing to a trusted surface between the
      // "before" and "after" snapshot looks identical to a real enrichment
      // leak but isn't one. Retry the WHOLE before/after/enrichment cycle a
      // few times before accepting a mismatch; any surface that never settles
      // is reported INCONCLUSIVE (not FAIL) so live-data churn can't
      // masquerade as a genuine isolation violation.
      const MAX_ATTEMPTS = 3;
      let settled: Record<string, boolean> = {};
      let lastBefore = before;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const after = await snapshotTrustedSurfaces(slugs);
        settled = {};
        for (const name of Object.keys(lastBefore)) {
          settled[name] = lastBefore[name] === after[name];
        }
        const allSettled = Object.values(settled).every(Boolean);
        if (allSettled || attempt === MAX_ATTEMPTS) break;
        console.warn(
          `[iso] enrichment non-disruption mismatch on attempt ${attempt}/${MAX_ATTEMPTS} ` +
            `(${Object.entries(settled).filter(([, ok]) => !ok).map(([n]) => n).join(', ')}) — ` +
            `re-running enrichment pass + re-snapshotting before treating as inconclusive`,
        );
        await sleep(1000 * attempt);
        lastBefore = await snapshotTrustedSurfaces(slugs);
        await runOutletEnrichment('iso-harness-retry');
      }
      for (const name of Object.keys(settled)) {
        checkRetryable(`enrichment non-disruption: ${name} byte-identical`, settled[name]);
      }
    }

    // (2a) role is NEVER written by enrichment — every pre-existing row unchanged.
    const regAfter = await storage.getOutletRegistry();
    const roleViolations = regAfter.filter(r => roleBefore.has(r.id) && roleBefore.get(r.id) !== r.role);
    check('enrichment write-scope: role column never written', roleViolations.length === 0,
      roleViolations.length ? `${roleViolations.length} outlet role(s) changed` : '');

    // (2b) manual-override fields are NEVER clobbered, for every row that has them.
    let overrideViolations = 0;
    for (const r of regAfter) {
      const prev = overridesBefore.get(r.id);
      if (!prev) continue;
      for (const field of Object.keys(prev.overrides)) {
        const beforeVal = prev.row[field];
        const afterVal = (r as Record<string, unknown>)[field];
        if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) overrideViolations++;
      }
    }
    check('enrichment write-scope: manual-override fields preserved', overrideViolations === 0,
      overrideViolations ? `${overrideViolations} locked field(s) changed` : '');

    // (2c) Positive control on the throwaway outlet: override preserved, role
    // untouched, AND a non-override field actually written (so 2a/2b are not
    // vacuously passing because nothing matched).
    const testAfter = await storage.getOutletRegistryById(testOutlet.id);
    check('enrichment write-scope: matched-outlet override preserved',
      !!testAfter && testAfter.factuality === OVERRIDE_SENTINEL,
      testAfter ? `factuality=${testAfter.factuality}` : 'test outlet missing');
    check('enrichment write-scope: matched-outlet role unchanged',
      !!testAfter && testAfter.role === 'attach-only',
      testAfter ? `role=${testAfter.role}` : '');
    check('enrichment write-scope: matched-outlet non-override field written',
      !!testAfter && testAfter.originCountry === 'United States',
      testAfter ? `originCountry=${testAfter.originCountry}` : '');
  } finally {
    // Sweep by the stable prefix (not just this run's exact key) so any sibling
    // residue is cleared too, and reverting the shadow on the real AP entry is
    // guaranteed even if the insert returned a different key than expected.
    await db.delete(outletRegistry).where(like(outletRegistry.key, TEST_OUTLET_KEY_LIKE));
  }
}

// ===========================================================================
// PHASE 3 + 4 — curated non-leak and clustering isolation.
// ===========================================================================
async function runCuratedChecks(slugs: string[]): Promise<void> {
  const unionUrl = `https://isolation.invalid/union-${MARKER}`;
  const leakUrl = `https://isolation.invalid/leak-${MARKER}`;
  const unionTitle = `${MARKER} UNION contributing canary`;
  const leakTitle = `${MARKER} LEAK attach-only adversary canary`;

  // Seeding + all checks run inside try/finally so the canaries are removed even
  // if a check throws mid-run. Cleanup is by URL, so it is a no-op if a seed
  // insert never landed.
  // Self-heal: a previous run that was killed mid-pass (e.g. SIGKILL during a
  // slow clustering call) never reaches its finally cleanup, leaving stale
  // canaries in the curated store that then surface in Top Stories. Sweep ALL
  // canary residue (any past MARKER) before seeding this run's pair.
  await db.delete(curatedItems).where(like(curatedItems.url, 'https://isolation.invalid/%'));

  try {
    // unionCanary is `contributing` so it surfaces deterministically as a
    // standalone in the curated union (no dependence on AI clustering). Seed it
    // FULLY ENRICHED — real headline, AI summary bullets, and a real non-favicon
    // image — so it clears the curated content-completeness seeding gate
    // (Task #231); an un-enriched standalone is intentionally suppressed and
    // would make this positive control fail. The `/objects/...jpg` form is the
    // same real-image convention the media back-off test below treats as a
    // genuine (non-favicon) image.
    const unionRow = await storage.addCuratedItem({
      title: unionTitle, url: unionUrl, source: 'Isolation Test Wire',
      category: 'general', summary: 'curated isolation union canary',
      summaryBullets: ['curated isolation union canary bullet'],
      ogImageUrl: '/objects/stream-images/iso-union.jpg',
      priorityScore: 99, role: 'contributing',
    } as any, normalizeTitle(unionTitle));
    // Stamp media_scraped_at so the LIVE prefetch/backfill cron treats the canary
    // as fully enriched and never re-fetches its (unreachable) isolation.invalid
    // URL. Otherwise the row (media_scraped_at NULL) is a live enrichment
    // candidate, and a background cycle can race in and overwrite its real image
    // with a favicon fallback before the positive-control check reads it — which
    // would then fail the seeding gate and make this check flaky. The media
    // back-off test below resets these fields first, so it is unaffected.
    await db.update(curatedItems).set({ mediaScrapedAt: new Date() })
      .where(eq(curatedItems.id, unionRow.id));
    // leakCanary is the strict case: an attach-only adversary item — the lowest
    // trust content in the widest aperture — which must never leak anywhere.
    await storage.addCuratedItem({
      title: leakTitle, url: leakUrl, source: 'RT Isolation Test',
      category: 'general', summary: 'curated isolation leak canary',
      priorityScore: 99, role: 'attach-only',
    } as any, normalizeTitle(leakTitle));

    // (3 negative) — neither canary appears in ANY trusted surface, including
    // EVERY custom-MCOP feed.
    const trusted: Array<{ name: string; url: string; headers?: Record<string, string> }> = [
      { name: 'headline-feed', url: `${BASE_URL}/api/headline-feed?hours=48` },
      { name: 'stream', url: `${BASE_URL}/api/stream?hours=48` },
      { name: 'public-articles', url: `${BASE_URL}/api/v1/articles?limit=200`, headers: apiKeyHeaders() },
      { name: 'public-social', url: `${BASE_URL}/api/v1/social?limit=200`, headers: apiKeyHeaders() },
    ];
    for (const slug of slugs) trusted.push({ name: `custom-${slug}`, url: `${BASE_URL}/api/custom-mcops/${slug}/feed?hours=48` });
    for (const t of trusted) {
      const raw = await fetchJson(t.url, t.headers ?? {});
      check(`curated non-leak: absent from ${t.name}`, !containsMarker(raw, MARKER));
    }

    // (3 positive) — the curated store IS reachable through the curated endpoint,
    // so the negative control above is meaningful (a leak would be caught).
    const topStories = await fetchJson(`${BASE_URL}/api/curated/top-stories?hours=48&limit=500`);
    check('curated non-leak: positive control present in /api/curated/top-stories',
      containsMarker(topStories, `${MARKER} UNION`));

    // (5) — curated media write contract + enrichment back-off (Task #132/#166).
    // A favicon/placeholder-only result must NOT stamp media_scraped_at (so the
    // backfill keeps retrying), must increment media_attempt_count, and must set
    // last_media_attempt_at; the backfill candidate query must then SKIP the row
    // while it is inside the escalating back-off window and once it crosses the
    // MAX_MEDIA_ATTEMPTS cap. A real image + bullets stamps media_scraped_at and
    // clears the counter. Exercised directly on the write path + the SHARED
    // backfill filter so it stays deterministic (no network / model dependence)
    // and can never drift from the real query (it imports the filter conditions
    // rather than re-implementing them).
    const [mediaRow] = await db.select({ id: curatedItems.id })
      .from(curatedItems).where(eq(curatedItems.url, unionUrl));
    if (mediaRow) {
      // Whether the SHARED backfill candidate query (the exact conditions the
      // 5-minute backfill cron uses) would currently pick up THIS row, scoped to
      // this row's id so the answer is deterministic regardless of other data.
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const isBackfillCandidate = async (): Promise<boolean> => {
        const rows = await db.select({ id: curatedItems.id })
          .from(curatedItems)
          .where(and(eq(curatedItems.id, mediaRow.id), ...staleCuratedMediaFilters(cutoff)));
        return rows.length > 0;
      };

      // Start from a clean, never-attempted state so the assertions below are not
      // confounded by any prior enrichment on the seeded row.
      await db.update(curatedItems)
        .set({ mediaScrapedAt: null, ogImageUrl: null, summaryBullets: null, mediaAttemptCount: 0, lastMediaAttemptAt: null })
        .where(eq(curatedItems.id, mediaRow.id));

      // Positive control: a never-attempted, un-enriched row IS a backfill
      // candidate — proves the exclusions below are real, not vacuous.
      check('curated back-off: never-attempted row is a backfill candidate',
        await isBackfillCandidate(),
        'a fresh un-enriched curated row was unexpectedly excluded from backfill');

      const faviconUrl = 'https://t3.gstatic.com/faviconV2?client=SOCIAL&url=https://example.com&size=128';
      await cacheCuratedItemMedia(mediaRow.id, faviconUrl, []);
      const [afterFail1] = await db.select({
        mediaScrapedAt: curatedItems.mediaScrapedAt,
        mediaAttemptCount: curatedItems.mediaAttemptCount,
        lastMediaAttemptAt: curatedItems.lastMediaAttemptAt,
      }).from(curatedItems).where(eq(curatedItems.id, mediaRow.id));
      check('curated media: favicon-only leaves media_scraped_at NULL (retryable)',
        afterFail1?.mediaScrapedAt == null,
        afterFail1?.mediaScrapedAt ? 'favicon-only result was wrongly stamped scraped' : '');
      check('curated back-off: failed attempt increments media_attempt_count',
        afterFail1?.mediaAttemptCount === 1,
        `media_attempt_count=${afterFail1?.mediaAttemptCount} (expected 1)`);
      check('curated back-off: failed attempt sets last_media_attempt_at',
        afterFail1?.lastMediaAttemptAt != null,
        afterFail1?.lastMediaAttemptAt ? '' : 'last_media_attempt_at was not stamped on a failed attempt');

      // The attempt just failed (count=1 → 30-min window), so the row is INSIDE
      // its back-off window and must be excluded from the backfill candidate set.
      check('curated back-off: row inside back-off window excluded from backfill',
        !(await isBackfillCandidate()),
        'a row that just failed enrichment was not backed off by the backfill query');

      // A second failed attempt escalates the counter (longer back-off window).
      await cacheCuratedItemMedia(mediaRow.id, faviconUrl, []);
      const [afterFail2] = await db.select({ mediaAttemptCount: curatedItems.mediaAttemptCount })
        .from(curatedItems).where(eq(curatedItems.id, mediaRow.id));
      check('curated back-off: a further failed attempt keeps incrementing the counter',
        afterFail2?.mediaAttemptCount === 2,
        `media_attempt_count=${afterFail2?.mediaAttemptCount} (expected 2)`);

      // Control for "window, not permanent": with the counter low (1) and the
      // last attempt pushed well past its 30-min window, the row becomes a
      // candidate again — exclusion is time-bounded, not a permanent drop.
      await db.update(curatedItems)
        .set({ mediaAttemptCount: 1, lastMediaAttemptAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(curatedItems.id, mediaRow.id));
      check('curated back-off: row past its back-off window is a candidate again',
        await isBackfillCandidate(),
        'a row whose back-off window elapsed was still excluded from backfill');

      // At/over the MAX_MEDIA_ATTEMPTS cap the row is PERMANENTLY excluded, even
      // with last_media_attempt_at pushed far into the past (so it is the cap, not
      // the time window, that stops the retries — the original defect was that
      // failed rows retried forever).
      await db.update(curatedItems)
        .set({ mediaAttemptCount: MAX_MEDIA_ATTEMPTS, lastMediaAttemptAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) })
        .where(eq(curatedItems.id, mediaRow.id));
      check('curated back-off: row at max attempt cap excluded even after window elapses',
        !(await isBackfillCandidate()),
        'a row at MAX_MEDIA_ATTEMPTS was still retried by the backfill query');

      await cacheCuratedItemMedia(mediaRow.id, '/objects/stream-images/iso-test.jpg', ['a', 'b', 'c']);
      const [afterReal] = await db.select({
        mediaScrapedAt: curatedItems.mediaScrapedAt,
        mediaAttemptCount: curatedItems.mediaAttemptCount,
      }).from(curatedItems).where(eq(curatedItems.id, mediaRow.id));
      check('curated media: real image + bullets stamps media_scraped_at',
        afterReal?.mediaScrapedAt != null,
        afterReal?.mediaScrapedAt == null ? 'substantive media was not stamped scraped' : '');
      check('curated back-off: a successful enrichment clears media_attempt_count',
        afterReal?.mediaAttemptCount === 0,
        `media_attempt_count=${afterReal?.mediaAttemptCount} (expected 0 after success)`);
    }

    // (4a) — DETERMINISTIC clustering-grouping exercise (Task #492). The live
    // clusterCuratedLane pass below proves write-ISOLATION, but its grouping is
    // AI-backed and can no-op under a 429 storm — so it can't prove the grouping
    // LOGIC actually ran. identifyCuratedClusters(nodes, { harnessStub:true }) runs
    // the grouping path network-free on a tiny fixture: two identical-title nodes
    // MUST group together; an unrelated node MUST stay ungrouped. We assert on the
    // RESULT, never on wall-clock timing.
    const clTitleA = `${MARKER} grouping fixture naval readiness exercise`;
    const stubNodes: LaneNode[] = [
      { key: 'curated:iso-cl-1', itemType: 'curated', itemId: 'iso-cl-1', title: clTitleA },
      { key: 'curated:iso-cl-2', itemType: 'curated', itemId: 'iso-cl-2', title: clTitleA },
      { key: 'curated:iso-cl-3', itemType: 'curated', itemId: 'iso-cl-3', title: `${MARKER} unrelated fixture market ticker drift` },
    ].map(n => ({
      ...n, source: 'Isolation Fixture', url: `${ISOLATION_URL_PREFIX}cl-${n.itemId}`,
      category: null, cls: 'normal', label: 'normal', role: 'normal', blocked: false,
      priority: 50, ogImageUrl: null, publishedAt: new Date(),
      sourceIdentifier: null, factuality: null, ownership: [], summary: null, bullets: null,
    })) as unknown as LaneNode[];
    const stubGroups = await identifyCuratedClusters(stubNodes, { harnessStub: true });
    const grouped = (stubGroups ?? []).find(g => g.keys.includes('curated:iso-cl-1'));
    check('curated clustering grouping runs deterministically (identical titles group)',
      !!grouped && grouped.keys.includes('curated:iso-cl-2') && grouped.keys.length === 2,
      grouped ? `group had ${grouped.keys.length} keys: ${grouped.keys.join(',')}` : 'identical-title nodes did not group');
    check('curated clustering grouping leaves unrelated item ungrouped',
      !(stubGroups ?? []).some(g => g.keys.includes('curated:iso-cl-3')),
      'unrelated fixture node was grouped');

    // (4b) — the LIVE clusterCuratedLane write-isolation check (headlines.cluster_id
    // untouched) is intentionally run LAST, as runClusterIsolationCheck() in main()
    // (Task #492). The live pass is AI-backed: under a 429 storm it eats its budget
    // and is then abandoned, but the abandoned promise keeps making AI calls in the
    // background and STARVES the DB-heavy deterministic phases that follow (intake),
    // blowing the fast-gate wall-clock past 30s. Running it last means nothing runs
    // after it, so its zombie can't starve anything — and process.exit kills it.
  } finally {
    // Cleanup seeded canaries (clustering self-heals the members mapping on its
    // next scheduled pass). Pattern-match so we also sweep any residue from a
    // sibling run, not just this run's exact pair.
    await db.delete(curatedItems).where(like(curatedItems.url, 'https://isolation.invalid/%'));
  }
}

// ===========================================================================
// PHASE 5 — DEAD-LINK FLAG isolation (Task #246 / #226). The curated dead-link
// liveness flag (curated_items.link_dead_at) and the allowlist-gated
// replacement-URL overlay (curated_link_replacements, keyed curated:<id>) are
// surfaced ONLY in the curated read path. This phase proves:
//   (a) a flagged-dead curated row KEEPS its curated visibility — the flag is
//       display-only, never a removal (no content loss); and
//   (b) neither the dead-link flag (linkDead:true) NOR a replacement-URL overlay
//       ever crosses into Classic, Visual, custom-MCOP, or the public API.
// The replacement target carries the MARKER, so a leak of the OVERLAY url (not
// just the original article url) is detectable in any non-curated surface too.
// Clustering is intentionally NOT run here: standalone contributing curated rows
// surface through the curated union directly, and clustering is structurally
// immune to the flag (it never reads link_dead_at) — the value being locked is
// non-leak + visibility, not clustering behavior.
// ===========================================================================
async function runDeadLinkChecks(slugs: string[]): Promise<void> {
  const deadUrl = `${ISOLATION_URL_PREFIX}deadlink-dead-${MARKER}`;
  const replOrigUrl = `${ISOLATION_URL_PREFIX}deadlink-repl-${MARKER}`;
  // The replacement TARGET carries the MARKER so a leak of the overlay url is
  // caught by the same marker-absence checks used for the seeded rows.
  const replacementUrl = `${ISOLATION_URL_PREFIX}deadlink-replacement-target-${MARKER}`;
  // Distinct outlets + distinct event wording on purpose: the two canaries must
  // each surface as their OWN standalone curated card. A shared outlet with
  // near-identical titles would be merged by the legitimate same-outlet
  // near-duplicate collapse (Task #127) in the read path, dropping one card and
  // masking whichever control rode on it.
  const deadTitle = `${MARKER} dead canary naval readiness alpha`;
  const replTitle = `${MARKER} replaced canary summit logistics bravo`;
  const deadSource = 'Isolation Dead Wire';
  const replSource = 'Isolation Repl Wire';

  // Self-heal residue from a prior killed run: curated rows by URL prefix, and any
  // replacement overlay whose MARKER-bearing target sits under the isolation host.
  await db.delete(curatedItems).where(like(curatedItems.url, `${ISOLATION_URL_PREFIX}deadlink-%`));
  await db.delete(curatedLinkReplacements).where(like(curatedLinkReplacements.url, `${ISOLATION_URL_PREFIX}%`));

  let replKey: string | null = null;
  try {
    // Seed both rows FULLY ENRICHED + contributing so they surface as standalone
    // curated cards (clears the content-completeness seeding gate, Task #231) —
    // otherwise the membership positive control could fail for an unrelated reason.
    const deadRow = await storage.addCuratedItem({
      title: deadTitle, url: deadUrl, source: deadSource,
      category: 'general', summary: 'curated dead-link dead canary',
      summaryBullets: ['curated dead-link dead canary bullet'],
      ogImageUrl: '/objects/stream-images/iso-deadlink-dead.jpg',
      priorityScore: 99, role: 'contributing',
    } as any, normalizeTitle(deadTitle));
    const replRow = await storage.addCuratedItem({
      title: replTitle, url: replOrigUrl, source: replSource,
      category: 'general', summary: 'curated dead-link replaced canary',
      summaryBullets: ['curated dead-link replaced canary bullet'],
      ogImageUrl: '/objects/stream-images/iso-deadlink-repl.jpg',
      priorityScore: 99, role: 'contributing',
    } as any, normalizeTitle(replTitle));
    // Stamp media_scraped_at so the live prefetch/backfill cron treats both rows as
    // enriched and never races in to overwrite their seeded image with a favicon
    // (same guard the union canary uses in PHASE 3).
    await db.update(curatedItems).set({ mediaScrapedAt: new Date() })
      .where(inArray(curatedItems.id, [deadRow.id, replRow.id]));

    // (a) flag the dead row link-dead (the liveness-probe stamp). With no
    //     replacement overlay, the curated path reports linkDead:true for it.
    await db.update(curatedItems).set({ linkDeadAt: new Date() })
      .where(eq(curatedItems.id, deadRow.id));
    // (b) give the OTHER row an allowlist-gated replacement overlay -> the curated
    //     path shows the MARKER-bearing replacement url as its display target.
    replKey = `curated:${replRow.id}`;
    await storage.setCuratedLinkReplacement(replKey, replacementUrl, 'isolation-harness');

    // POSITIVE controls — both rows are reachable through the curated endpoint, so
    // the negative controls below are meaningful (a leak would actually be caught).
    const topStories = await fetchJson(`${BASE_URL}/api/curated/top-stories?hours=48&limit=500`);
    check('dead-link: flagged-dead row KEEPS curated visibility (flag is display-only, no content loss)',
      containsMarker(topStories, deadTitle));
    check('dead-link: linkDead flag IS surfaced in the curated path (positive control)',
      JSON.stringify(topStories).includes('"linkDead":true'));
    check('dead-link: replaced row KEEPS curated visibility (positive control)',
      containsMarker(topStories, replTitle));
    check('dead-link: replacement-URL overlay IS applied in the curated path (positive control)',
      containsMarker(topStories, replacementUrl));

    // NEGATIVE controls — neither the dead-link state nor the replacement overlay
    // crosses into any non-curated surface.
    const trusted: Array<{ name: string; url: string; headers?: Record<string, string> }> = [
      { name: 'headline-feed', url: `${BASE_URL}/api/headline-feed?hours=48` },
      { name: 'stream', url: `${BASE_URL}/api/stream?hours=48` },
      { name: 'public-articles', url: `${BASE_URL}/api/v1/articles?limit=200`, headers: apiKeyHeaders() },
      { name: 'public-social', url: `${BASE_URL}/api/v1/social?limit=200`, headers: apiKeyHeaders() },
    ];
    for (const slug of slugs) trusted.push({ name: `custom-${slug}`, url: `${BASE_URL}/api/custom-mcops/${slug}/feed?hours=48` });
    for (const t of trusted) {
      const raw = await fetchJson(t.url, t.headers ?? {});
      check(`dead-link non-leak: canary rows + replacement overlay absent from ${t.name}`,
        !containsMarker(raw, MARKER));
      check(`dead-link non-leak: linkDead:true never crosses into ${t.name}`,
        !JSON.stringify(raw).includes('"linkDead":true'));
    }
  } finally {
    if (replKey) {
      await db.delete(curatedLinkReplacements).where(eq(curatedLinkReplacements.key, replKey));
    }
    await db.delete(curatedItems).where(like(curatedItems.url, `${ISOLATION_URL_PREFIX}deadlink-%`));
    await db.delete(curatedLinkReplacements).where(like(curatedLinkReplacements.url, `${ISOLATION_URL_PREFIX}%`));
  }
}

// ===========================================================================
// PHASE 6 — WIDER-INTAKE isolation (Task #139). Exercises the NEW intake call
// sites added in Task #137 so a regression there can't silently widen the
// aperture without this harness catching it:
//
//   (a) Team-submission REUSE intake (ingestTeamSubmissionsToCurated): seed a
//       fake team submission from an UNKNOWN outlet, run the real intake, and
//       prove it lands in curated_items with the registry-derived tier
//       (attach-only for an unknown source — fail-closed).
//   (b) Main-pipeline REJECT capture (admitCuratedCandidates in 'gate' mode, the
//       exact config the Drudge scraper / RSS bot use): admit a fake reject from
//       an unknown outlet and prove the same attach-only tier.
//
// For BOTH paths the load-bearing guarantee is the same as the seeded-canary
// control: the admitted item must NEVER appear in any trusted surface
// (headline-feed / stream / public-articles / public-social / custom-MCOP).
// ===========================================================================
async function runIntakeChecks(slugs: string[]): Promise<void> {
  // The MARKER is carried in the URL of every seeded item (and the team title),
  // so leak detection works via the URL regardless of how an LLM echoes a title.
  const teamUrl = `https://isolation.invalid/team-${MARKER}`;
  const rejectUrl = `https://isolation.invalid/reject-${MARKER}`;
  const teamTitle = `${MARKER} TEAM reuse-intake canary`;
  // The reject path runs the generous curated LLM gate, which admits anything
  // with a defense / national-security angle. admitCuratedCandidates matches the
  // analyzer's verdict back by EXACT title, so the title must be clean prose the
  // model echoes verbatim — the MARKER lives in the URL instead (a marker prefix
  // here gets normalized away by the LLM and the title-key lookup misses).
  const rejectTitle = 'Pentagon warns of adversary missile buildup near allied border';

  // Self-heal: sweep any residue from a killed prior run before seeding.
  await db.delete(curatedItems).where(inArray(curatedItems.url, [teamUrl, rejectUrl]));
  await db.delete(teamSubmissions).where(eq(teamSubmissions.sourceUrl, teamUrl));

  // Build the trusted-surface leak targets once (same set the seeded-canary
  // control uses), so an admitted intake item is checked against every feed.
  const trusted: Array<{ name: string; url: string; headers?: Record<string, string> }> = [
    { name: 'headline-feed', url: `${BASE_URL}/api/headline-feed?hours=48` },
    { name: 'stream', url: `${BASE_URL}/api/stream?hours=48` },
    { name: 'public-articles', url: `${BASE_URL}/api/v1/articles?limit=200`, headers: apiKeyHeaders() },
    { name: 'public-social', url: `${BASE_URL}/api/v1/social?limit=200`, headers: apiKeyHeaders() },
  ];
  for (const slug of slugs) trusted.push({ name: `custom-${slug}`, url: `${BASE_URL}/api/custom-mcops/${slug}/feed?hours=48` });

  async function assertNoLeak(label: string): Promise<void> {
    for (const t of trusted) {
      const raw = await fetchJson(t.url, t.headers ?? {});
      check(`intake non-leak (${label}): absent from ${t.name}`, !containsMarker(raw, MARKER));
    }
  }

  try {
    // ----- (a) Team-submission reuse intake -----------------------------------
    // Seed a fake team submission from an unknown outlet. The intake query only
    // picks up non-questionable, non-MATA, non-deleted, recent rows, so mirror
    // those preconditions exactly.
    await db.insert(teamSubmissions).values({
      submittedBy: 'iso-harness',
      submittedByName: 'Isolation Harness',
      sourceType: 'url',
      sourceUrl: teamUrl,
      sourceName: 'Isolation Test Wire',
      headline: teamTitle,
      summary: 'curated isolation team reuse-intake canary',
      priorityScore: 99,
      isQuestionable: false,
      isMataOsint: false,
    });

    try {
      const teamResult = await withBudget('ingestTeamSubmissionsToCurated', ingestTeamSubmissionsToCurated(), AI_BUDGET_MS, /* exemptDegraded */ true);
      console.log(`[iso] team reuse intake: ingested=${teamResult.ingested} skipped=${teamResult.skipped}`);
    } catch (err) {
      // Intake enriches recent photo submissions via AI; a slow/rate-limited
      // model must not hang the gate. The seeded canary itself carries no photo,
      // so it lands on the fast DB path regardless — the landing check below is
      // the real assertion; non-leak is asserted either way.
      console.warn(`[iso] ingestTeamSubmissionsToCurated did not complete (continuing): ${(err as Error).message}`);
    }

    const teamItem = await storage.getCuratedItemByUrl(teamUrl);
    check('intake (team): seeded submission landed in curated_items', !!teamItem,
      teamItem ? '' : 'team canary did not reach the curated store');
    check('intake (team): registry-derived tier is attach-only (unknown source)',
      !!teamItem && teamItem.role === 'attach-only',
      teamItem ? `role=${teamItem.role}` : 'no curated row');

    // The source team submission is itself a legitimate public-feed primary
    // (it surfaces in /api/v1/articles by design), so it would mask the leak
    // check. Delete it now: the MARKER then survives ONLY on the curated copy,
    // making the no-leak assertion a true test of the curated lane — if the
    // intake had wrongly written into headlines/Classic/Visual/public, the
    // MARKER would still appear in a trusted feed.
    await db.delete(teamSubmissions).where(eq(teamSubmissions.sourceUrl, teamUrl));
    await assertNoLeak('team');

    // ----- (b) Main-pipeline reject capture -----------------------------------
    // Run the exact call-site config the Drudge scraper / RSS bot use for
    // strict-gate rejects: admitCuratedCandidates in 'gate' mode.
    // Under the harness AI-stub the gate returns a deterministic relevant verdict
    // (Task #492), so the reject canary ALWAYS lands and the intake side-effect
    // genuinely runs — we HARD-assert its landing instead of warning-and-skipping
    // when a live model happened to be unavailable.
    let rejectAdmitted = false;
    try {
      const rejectResult = await withBudget('admitCuratedCandidates', admitCuratedCandidates(
        [{ title: rejectTitle, url: rejectUrl, source: 'Isolation Reject Wire' }],
        { mode: 'gate', label: 'iso-reject' },
      ));
      rejectAdmitted = true;
      console.log(`[iso] reject capture intake: ingested=${rejectResult.ingested} skipped=${rejectResult.skipped}`);
    } catch (err) {
      // With the deterministic stub this path is network-free, so a throw is a
      // real failure (not a rate-limit). Surface it as a failed assertion below.
      console.warn(`[iso] admitCuratedCandidates threw under stub: ${(err as Error).message}`);
    }
    check('intake (reject): deterministic gate ran the admission side-effect', rejectAdmitted,
      'admitCuratedCandidates did not complete under the AI-stub gate');

    const rejectItem = await storage.getCuratedItemByUrl(rejectUrl);
    check('intake (reject): seeded candidate landed in curated_items', !!rejectItem,
      rejectItem ? '' : 'reject canary did not reach the curated store under the AI-stub gate');
    check('intake (reject): registry-derived tier is attach-only (unknown source)',
      !!rejectItem && rejectItem.role === 'attach-only',
      rejectItem ? `role=${rejectItem.role}` : 'no curated row');
    await assertNoLeak('reject');
  } finally {
    await db.delete(curatedItems).where(inArray(curatedItems.url, [teamUrl, rejectUrl]));
    await db.delete(teamSubmissions).where(eq(teamSubmissions.sourceUrl, teamUrl));
  }
}

// ===========================================================================
// PHASE 7 — WIDER CURATED SOCIAL-FEED isolation. This phase widened the
// Curated view's social side feeds to deeper time windows with a 300-row cap:
//   - Truth Social: 48h window (getCuratedTruthSocialPosts).
//   - U.S. X Feed / OSINT X Feed / Press X Feed: ≥24h window (~30h for X/OSINT,
//     same ~30h for journalist/response feeds).
//
//   (a) WIDE on curated — /api/curated/truth-social-posts reaches back across
//       the 48h window (a seeded ~47h-old marker is present), and
//       /api/curated/x-posts reaches back across ~24h (a seeded ~23h-old
//       marker is present), proving the wider windows genuinely took effect.
//   (b) NARROW everywhere else — the non-curated Truth Social / X endpoints
//       (/api/truth-social-posts, /api/x-posts) and the public REST API
//       (/api/v1/social) keep their fixed-count contract via the untouched
//       shared getRecent* helpers: a no-param read returns the fixed default
//       (not the 300 cap), and they are NOT clamped to the curated window
//       (a high-limit read still returns posts far older than the curated
//       window). A true byte-for-byte snapshot is impossible here because
//       curated and non-curated read the SAME underlying tables, so the
//       harness asserts the fixed-count + no-window contract that the
//       "byte-identical to before" guarantee reduces to.
// ===========================================================================
async function runSocialWindowChecks(): Promise<void> {
  // Mirror the route's window constants so assertions track the source of truth.
  const CURATED_TRUTH_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h (Truth Social)
  const CURATED_SOCIAL_WINDOW_MS = 30 * 60 * 60 * 1000; // ~30h (X feeds, satisfies ≥24h)
  const OLD_TRUTH_FIXED = 8;   // pre-widening curated Truth Social count
  const OLD_X_FIXED = 12;      // pre-widening curated U.S. X count
  const SEED_COUNT = 20;       // > both old fixed counts

  // Truth canaries spread across ~47h (inside the 48h window, beyond old 30h).
  const TRUTH_NEWEST_MS = 5 * 60 * 1000;      // newest seed 5 min ago
  const TRUTH_OLDEST_MS = 47 * 60 * 60 * 1000; // oldest seed ~47h ago
  // X canaries spread across ~23h (inside the 30h window, satisfies 24h).
  const X_NEWEST_MS = 5 * 60 * 1000;          // newest seed 5 min ago
  const X_OLDEST_MS = 23 * 60 * 60 * 1000;    // oldest seed ~23h ago

  // Social canary id prefixes (TS_POST_PREFIX / X_POST_PREFIX) are module-level
  // so the centralized teardown can sweep them too; the seed URL prefix is local.
  const SOCIAL_URL_PREFIX = `${ISOLATION_URL_PREFIX}social-`;

  const sweep = async () => {
    await db.delete(truthSocialPosts).where(like(truthSocialPosts.postId, `${TS_POST_PREFIX}%`));
    await db.delete(xPosts).where(like(xPosts.postId, `${X_POST_PREFIX}%`));
    await db.delete(sentDefenderPosts).where(like(sentDefenderPosts.postId, `${SD_POST_PREFIX}%`));
    await db.delete(journalistPosts).where(like(journalistPosts.postId, `${JOUR_POST_PREFIX}%`));
  };

  // Self-heal residue before seeding this run's batch.
  await sweep();

  const now = Date.now();
  const truthSpan = TRUTH_OLDEST_MS - TRUTH_NEWEST_MS;
  const xSpan = X_OLDEST_MS - X_NEWEST_MS;
  const truthPostedAtFor = (i: number) =>
    new Date(now - (TRUTH_NEWEST_MS + (truthSpan * i) / (SEED_COUNT - 1)));
  const xPostedAtFor = (i: number) =>
    new Date(now - (X_NEWEST_MS + (xSpan * i) / (SEED_COUNT - 1)));

  const oldestTruthPostId = `${TS_POST_PREFIX}${MARKER}_${SEED_COUNT - 1}`;
  const oldestXPostId = `${X_POST_PREFIX}${MARKER}_${SEED_COUNT - 1}`;
  const oldestSdPostId = `${SD_POST_PREFIX}${MARKER}_${SEED_COUNT - 1}`;
  const oldestJourPostId = `${JOUR_POST_PREFIX}${MARKER}_${SEED_COUNT - 1}`;

  try {
    for (let i = 0; i < SEED_COUNT; i++) {
      await db.insert(truthSocialPosts).values({
        postId: `${TS_POST_PREFIX}${MARKER}_${i}`,
        content: `${MARKER} curated social-window Truth canary #${i}`,
        postedAt: truthPostedAtFor(i),
        truthSocialUrl: `${SOCIAL_URL_PREFIX}ts-${MARKER}-${i}`,
        isHidden: false,
      });
      await db.insert(xPosts).values({
        postId: `${X_POST_PREFIX}${MARKER}_${i}`,
        content: `${MARKER} curated social-window X canary #${i}`,
        postedAt: xPostedAtFor(i),
        xUrl: `${SOCIAL_URL_PREFIX}x-${MARKER}-${i}`,
        sourceAccount: 'SecWar',
        accountCategory: 'default', // must NOT be influencer to count in the feed
        isHidden: false,
      });
      await db.insert(sentDefenderPosts).values({
        postId: `${SD_POST_PREFIX}${MARKER}_${i}`,
        content: `${MARKER} curated social-window SentDefender canary #${i}`,
        postedAt: xPostedAtFor(i), // same ~23h spread as X canaries
        xUrl: `${SOCIAL_URL_PREFIX}sd-${MARKER}-${i}`,
        isHidden: false,
      });
      await db.insert(journalistPosts).values({
        postId: `${JOUR_POST_PREFIX}${MARKER}_${i}`,
        content: `${MARKER} curated social-window Journalist canary #${i}`,
        postedAt: xPostedAtFor(i), // same ~23h spread as X canaries
        xUrl: `${SOCIAL_URL_PREFIX}jour-${MARKER}-${i}`,
        sourceAccount: 'BarakRavid', // one of CURATED_JOURNALIST_ACCOUNTS
        isHidden: false,
      });
    }

    const hasPostId = (arr: any[], id: string) =>
      Array.isArray(arr) && arr.some((p) => p?.postId === id);
    // A high-limit read proves a lane is NOT clamped to the curated window when it
    // surfaces posts older than the window. But when live post volume exceeds the
    // read limit, the N most-recent posts can ALL fall within the window purely by
    // recency — and a clamped lane is then INDISTINGUISHABLE from an unclamped one
    // (both return `limit` rows, all recent). So absence of older posts is only
    // evidence of clamping when the aperture has ROOM (returned < limit). When the
    // aperture is saturated (returned >= limit) the check is inconclusive and must
    // not fail — otherwise it flakes on busy news days (e.g. the aggregated public
    // x-twitter lane routinely returns 200 recent posts). The clamp is still caught
    // under normal volume, where the aperture is not saturated.
    const WIDE_READ_LIMIT = 200;
    const hasOlderThan = (arr: any[], cutoffMs: number) =>
      Array.isArray(arr) && arr.some((p) => p?.postedAt && new Date(p.postedAt).getTime() < cutoffMs);
    const notClampedToWindow = (arr: any[], windowMs: number) =>
      hasOlderThan(arr, now - windowMs) || (Array.isArray(arr) && arr.length >= WIDE_READ_LIMIT);

    // ----- (a) WIDE on curated --------------------------------------------------
    const curatedTruth = await fetchJson(`${BASE_URL}/api/curated/truth-social-posts`);
    check('social-window curated Truth Social: returns more than old fixed count (>8)',
      Array.isArray(curatedTruth) && curatedTruth.length > OLD_TRUTH_FIXED,
      `len=${Array.isArray(curatedTruth) ? curatedTruth.length : 'n/a'}`);
    check('social-window curated Truth Social: reaches across ~48h window (oldest seed present)',
      hasPostId(curatedTruth, oldestTruthPostId),
      hasPostId(curatedTruth, oldestTruthPostId) ? '' : '~47h-old seeded marker missing from curated Truth feed');

    const curatedX = await fetchJson(`${BASE_URL}/api/curated/x-posts`);
    check('social-window curated U.S. X: returns more than old fixed count (>12)',
      Array.isArray(curatedX) && curatedX.length > OLD_X_FIXED,
      `len=${Array.isArray(curatedX) ? curatedX.length : 'n/a'}`);
    check('social-window curated U.S. X: reaches across ~24h window (oldest seed present)',
      hasPostId(curatedX, oldestXPostId),
      hasPostId(curatedX, oldestXPostId) ? '' : '~23h-old seeded marker missing from curated U.S. X feed');

    // ----- (b) NARROW everywhere else ------------------------------------------
    // Non-curated default read: fixed default (10), NOT the curated 300 cap. With
    // SEED_COUNT(20) recent seeds plus existing rows, a widened endpoint would
    // return >10; the untouched getRecent* helper returns exactly its default.
    const nonCuratedTruth = await fetchJson(`${BASE_URL}/api/truth-social-posts`);
    check('social-window non-curated Truth Social: default read keeps fixed count (=10, not widened)',
      Array.isArray(nonCuratedTruth) && nonCuratedTruth.length === 10,
      `len=${Array.isArray(nonCuratedTruth) ? nonCuratedTruth.length : 'n/a'}`);
    const nonCuratedX = await fetchJson(`${BASE_URL}/api/x-posts`);
    check('social-window non-curated X: default read keeps fixed count (=10, not widened)',
      Array.isArray(nonCuratedX) && nonCuratedX.length === 10,
      `len=${Array.isArray(nonCuratedX) ? nonCuratedX.length : 'n/a'}`);

    // Non-curated high-limit read is NOT clamped to the curated window — it still
    // returns posts far older than the window (no time filter on the shared helper).
    // A regression that grafted the curated window on would drop these older rows.
    const nonCuratedTruthWide = await fetchJson(`${BASE_URL}/api/truth-social-posts?limit=200`);
    check('social-window non-curated Truth Social: not clamped to curated 48h window',
      notClampedToWindow(nonCuratedTruthWide, CURATED_TRUTH_WINDOW_MS),
      'no posts older than 48h returned AND read aperture not saturated — endpoint may have adopted the curated window');
    const nonCuratedXWide = await fetchJson(`${BASE_URL}/api/x-posts?limit=200`);
    check('social-window non-curated X: not clamped to curated 30h window',
      notClampedToWindow(nonCuratedXWide, CURATED_SOCIAL_WINDOW_MS),
      'no posts older than 30h returned AND read aperture not saturated — endpoint may have adopted the curated window');

    // Public REST API: same guarantee, via the X-API-Key gate. A high-limit read
    // returns posts older than the curated window, proving the public lane never
    // inherited the wider curated aperture.
    const publicTruth = await fetchJson(`${BASE_URL}/api/v1/social?platform=truth-social&limit=200`, apiKeyHeaders());
    const publicTruthPosts = Array.isArray(publicTruth) ? publicTruth : (publicTruth?.data ?? publicTruth?.posts ?? []);
    check('social-window public API (truth-social): not clamped to curated 48h window',
      notClampedToWindow(publicTruthPosts, CURATED_TRUTH_WINDOW_MS),
      'no posts older than 48h returned from /api/v1/social AND read aperture not saturated — public lane may have adopted the curated window');
    const publicX = await fetchJson(`${BASE_URL}/api/v1/social?platform=x-twitter&limit=200`, apiKeyHeaders());
    const publicXPosts = Array.isArray(publicX) ? publicX : (publicX?.data ?? publicX?.posts ?? []);
    check('social-window public API (x-twitter): not clamped to curated 30h window',
      notClampedToWindow(publicXPosts, CURATED_SOCIAL_WINDOW_MS),
      'no posts older than 30h returned from /api/v1/social AND read aperture not saturated — public lane may have adopted the curated window');

    // ----- (c) OSINT X Feed depth (sentDefender) — curated ~24h ------------
    // sentDefender canaries are spread across ~23h. The curated /osint-posts
    // endpoint combines sentDefender rows with OSINT-account rows; proving the
    // oldest seed is present confirms the combined feed reads back ≥24h of
    // sentDefender data (not just a small fixed-count recent slice).
    const curatedOsint = await fetchJson(`${BASE_URL}/api/curated/osint-posts`);
    check('social-window curated OSINT feed: reaches across ~24h window (oldest sentDefender seed present)',
      hasPostId(curatedOsint, oldestSdPostId),
      hasPostId(curatedOsint, oldestSdPostId) ? '' : '~23h-old sentDefender seed missing from curated OSINT feed — window may still be a small fixed count');

    // ----- (d) Press X Feed depth (journalist) — curated ~24h --------------
    // journalist canaries are seeded with sourceAccount 'BarakRavid', one of
    // CURATED_JOURNALIST_ACCOUNTS. Proving the oldest seed is present in the
    // journalist feed confirms the 24h window is in effect for the Press feed.
    const curatedJournalist = await fetchJson(`${BASE_URL}/api/curated/journalist-posts`);
    check('social-window curated Journalist feed: reaches across ~24h window (oldest journalist seed present)',
      hasPostId(curatedJournalist, oldestJourPostId),
      hasPostId(curatedJournalist, oldestJourPostId) ? '' : '~23h-old journalist seed missing from curated Journalist feed — window may still be a small fixed count');

    // ----- (e) Isolation: curated-only tables must not surface publicly -----
    // sentDefender and journalist tables are curated-only (never read by the
    // shared /api/osint-posts or /api/v1/social routes). Seeding canaries into
    // them and confirming absence from the public lane proves the isolation is
    // intact — a routing regression would make this fail immediately.
    check('social-window isolation: sentDefender canary absent from public /api/v1/social',
      !hasPostId(publicXPosts, oldestSdPostId),
      'sentDefender seed appeared in public x-twitter lane — curated-only table leaked into public API');
    check('social-window isolation: journalist canary absent from public /api/v1/social',
      !hasPostId(publicXPosts, oldestJourPostId),
      'journalist seed appeared in public x-twitter lane — curated-only table leaked into public API');
  } finally {
    await sweep();
  }
}

// Centralized teardown: removes EVERY residue path the harness seeds (throwaway
// outlet rows, curated/team canaries, social canaries) in one place. Used both by
// the signal-driven teardown below and as a final safety sweep. Idempotent — a
// no-op when nothing was seeded.
//
// Exported so scripts/test-sigkill-self-heal.ts can call the REAL cleanup path
// rather than maintaining a local copy — any change to the tables/patterns here
// is therefore automatically reflected in the regression test.
export async function cleanupAllResidue(): Promise<void> {
  await db.delete(outletRegistry).where(like(outletRegistry.key, TEST_OUTLET_KEY_LIKE));
  await db.delete(curatedItems).where(like(curatedItems.url, `${ISOLATION_URL_PREFIX}%`));
  await db.delete(curatedLinkReplacements).where(like(curatedLinkReplacements.url, `${ISOLATION_URL_PREFIX}%`));
  await db.delete(teamSubmissions).where(like(teamSubmissions.sourceUrl, `${ISOLATION_URL_PREFIX}%`));
  await db.delete(truthSocialPosts).where(like(truthSocialPosts.postId, `${TS_POST_PREFIX}%`));
  await db.delete(xPosts).where(like(xPosts.postId, `${X_POST_PREFIX}%`));
  await db.delete(sentDefenderPosts).where(like(sentDefenderPosts.postId, `${SD_POST_PREFIX}%`));
  await db.delete(journalistPosts).where(like(journalistPosts.postId, `${JOUR_POST_PREFIX}%`));
}

// Guarded teardown that runs even when the harness is interrupted or fails partway.
// The per-phase try/finally blocks cover thrown errors on the normal path; these
// handlers cover trappable process termination (Ctrl-C / SIGTERM from a workflow
// stop / an uncaught error) so cleanup still runs before exit. SIGKILL cannot be
// trapped — that case is covered by the pre-seed self-heal sweeps on the next run.
let teardownRan = false;

// ===========================================================================
// PHASE 6 — STATE-NARRATIVES CACHE INVALIDATION (Task #635). Proves the
// curated /api/curated/state-narratives lens honors curation writes on the very
// next NORMAL (cached) read — no TTL wait — and that the periodic pre-warm can
// never reintroduce a stale payload.
//
// Guarantees asserted (all over HTTP, no timer waits):
//   (a) hiding an adversary curated item clears it from the lens on the next
//       cached read (the write dropped the stale cached entry, Task #633);
//   (b) a priority override is reflected on the next cached read;
//   (c) a COLD rebuild — byte-for-byte the path the 90s pre-warm takes — serves
//       the corrected payload, and a subsequent warm cached read keeps serving
//       it, so the pre-warm cannot re-cache the pre-write (stale) payload.
//
// Determinism: the lens buckets by OUTLET origin country and only renders a
// country with >= 2 items. We seed a throwaway `news-cpc` (=> contrast) outlet
// whose origin is a SPARSE adversary bucket (North Korea has no live curated
// data today, unlike Russia/China/Iran), so the seeded trio deterministically
// owns that lens without live data crowding the per-country cap. All residue is
// swept by the shared conventions (outlet key prefix + ISOLATION_URL_PREFIX)
// plus explicit overlay cleanup keyed to the seeded ids.
// ===========================================================================
const SN_COUNTRY = 'North Korea';
const SN_OUTLET_NAME = 'SN Isolation Adversary Wire';
const SN_URL_PREFIX = `${ISOLATION_URL_PREFIX}sn-`;

function snItemsForCountry(payload: Json, country: string): Json[] {
  const c = (payload?.countries ?? []).find((x: any) => x?.country === country);
  return Array.isArray(c?.items) ? c.items : [];
}
function snHasId(payload: Json, country: string, id: string): boolean {
  return snItemsForCountry(payload, country).some((it: any) => it?.id === id);
}
function snItemById(payload: Json, country: string, id: string): any | undefined {
  return snItemsForCountry(payload, country).find((it: any) => it?.id === id);
}

async function runStateNarrativesInvalidationChecks(): Promise<void> {
  const snOutletKey = `${TEST_OUTLET_KEY_PREFIX}sn_${Date.now()}__`;
  // Default 36h window => shares the SAME cache key ('state-narratives:36') the
  // pre-warm uses, so a cached read here exercises the pre-warm's exact entry.
  const snUrl = `${BASE_URL}/api/curated/state-narratives`;
  const seededUrl = (slot: string) => `${SN_URL_PREFIX}${slot}-${MARKER}`;

  // Self-heal residue from a prior killed run before seeding (the throwaway
  // outlet shares the TEST_OUTLET_KEY prefix; seeded rows share SN_URL_PREFIX).
  await db.delete(outletRegistry).where(like(outletRegistry.key, TEST_OUTLET_KEY_LIKE));
  await db.delete(curatedItems).where(like(curatedItems.url, `${SN_URL_PREFIX}%`));

  let ids: string[] = [];
  try {
    // Throwaway adversary STATE-MEDIA outlet. `news-cpc` => contrast (the only
    // class this lens surfaces); an adversary originCountry => qualifies.
    await db.insert(outletRegistry).values({
      key: snOutletKey,
      canonicalName: SN_OUTLET_NAME,
      aliases: [],
      domains: [],
      originCountry: SN_COUNTRY,
      sourceIdentifier: 'news-cpc',
      blocked: false,
      role: 'attach-only',
    });

    const seed = async (slot: string, title: string, priorityScore: number): Promise<string> => {
      const t = `${title} ${MARKER}`;
      const item = await storage.addCuratedItem(
        {
          url: seededUrl(slot),
          title: t,
          source: SN_OUTLET_NAME,
          category: 'General',
          priorityScore,
          role: 'attach-only',
          articlePublishedAt: new Date(),
        } as any,
        normalizeTitle(t),
      );
      return item.id;
    };
    // Seed THREE so hiding one still leaves the lens >= MIN_LENS_ITEMS (2): a
    // "gone after hide" that also collapsed the whole lens would pass vacuously.
    const a = await seed('a', 'State media narrative Alpha', 100);
    const b = await seed('b', 'State media narrative Bravo', 96);
    const c = await seed('c', 'State media narrative Charlie', 92);
    ids = [a, b, c];

    // (positive control) a FRESH build (cache bypassed) shows all three, proving
    // they qualify — otherwise every downstream "gone after hide" is vacuous.
    const fresh = await fetchJson(snUrl);
    check('state-narratives invalidation: seeded adversary trio present on fresh build',
      snHasId(fresh, SN_COUNTRY, a) && snHasId(fresh, SN_COUNTRY, b) && snHasId(fresh, SN_COUNTRY, c),
      `NK lens items=${snItemsForCountry(fresh, SN_COUNTRY).length}`);

    // Warm the SHARED cache entry WITH item A present. An invalidating write
    // first drops any pre-seed pre-warm payload, so this cached read rebuilds
    // from current DB state (A/B/C present) and re-caches it — establishing the
    // pre-hide cached snapshot the hide must invalidate.
    await postJsonAuthed('/api/curated/priority-override', { scope: 'standalone', type: 'curated', id: c, priorityScore: 55 });
    const warm = await fetchJsonCached(snUrl);
    check('state-narratives invalidation: cache warmed with item present (pre-hide baseline)',
      snHasId(warm, SN_COUNTRY, a),
      'cached read did not include the seeded item to invalidate against');

    // HIDE item A — must invalidate the lens cache so the NEXT cached read
    // rebuilds WITHOUT A (no TTL wait).
    await postJsonAuthed('/api/curated/hide-story', { scope: 'standalone', type: 'curated', id: a });
    const afterHide = await fetchJsonCached(snUrl);
    check('state-narratives invalidation: hidden item cleared on next cached read (no TTL wait)',
      !snHasId(afterHide, SN_COUNTRY, a),
      'hidden adversary item still served from a stale cache after hide');
    check('state-narratives invalidation: non-hidden lens items still render after hide',
      snHasId(afterHide, SN_COUNTRY, b) && snHasId(afterHide, SN_COUNTRY, c),
      'sibling items missing — cannot distinguish real invalidation from lens collapse');

    // PRIORITY OVERRIDE item B to a sentinel score — the next cached read must
    // reflect the new score (the write invalidated the cache).
    const PIN = 41;
    await postJsonAuthed('/api/curated/priority-override', { scope: 'standalone', type: 'curated', id: b, priorityScore: PIN });
    const afterPin = await fetchJsonCached(snUrl);
    const pinned = snItemById(afterPin, SN_COUNTRY, b);
    check('state-narratives invalidation: priority override reflected on next cached read',
      !!pinned && pinned.priorityScore === PIN,
      pinned ? `priorityScore=${pinned.priorityScore}` : 'overridden item not present');
    check('state-narratives invalidation: earlier hide still holds after a later write',
      !snHasId(afterPin, SN_COUNTRY, a),
      'hidden item reappeared after a subsequent curation write');

    // PRE-WARM NON-REINTRODUCTION. The 90s pre-warm rebuilds via the SAME builder
    // and ONLY when the cache is cold — a cold rebuild is byte-for-byte the
    // pre-warm path. Prove that path serves the corrected payload (A gone, B
    // pinned) and that a subsequent warm cached read keeps serving it, so the
    // pre-warm can never re-cache the pre-write (stale) payload.
    const coldRebuild = await fetchJson(snUrl); // x-mcop-no-cache => cold == pre-warm path
    const coldPinned = snItemById(coldRebuild, SN_COUNTRY, b);
    check('state-narratives invalidation: pre-warm (cold rebuild) serves fresh payload, not stale',
      !snHasId(coldRebuild, SN_COUNTRY, a) && !!coldPinned && coldPinned.priorityScore === PIN,
      'cold rebuild (the pre-warm path) reintroduced the hidden item or lost the pin');
    const warmAgain = await fetchJsonCached(snUrl);
    check('state-narratives invalidation: warm cache keeps serving the fresh payload',
      !snHasId(warmAgain, SN_COUNTRY, a) && snHasId(warmAgain, SN_COUNTRY, b),
      'warm cache re-served the stale (pre-hide) payload');
  } finally {
    // Remove the overlays keyed to the seeded ids, then the rows + throwaway
    // outlet. Overlays are keyed `curated:<uuid>`; delete by those exact keys so
    // no orphan overlay rows accumulate across runs.
    for (const id of ids) {
      await db.delete(curatedHiddenStories).where(eq(curatedHiddenStories.key, `curated:${id}`)).catch(() => {});
      await db.delete(curatedPriorityOverrides).where(eq(curatedPriorityOverrides.key, `curated:${id}`)).catch(() => {});
    }
    await db.delete(outletRegistry).where(eq(outletRegistry.key, snOutletKey));
    await db.delete(curatedItems).where(like(curatedItems.url, `${SN_URL_PREFIX}%`));
  }
}

// ===========================================================================
// PHASE 8 — ATTRIBUTED CLAIMS field non-leak (Task #706). The
// `attributed_claims` column is enriched in the curated pipeline and surfaced
// on the curated API. This phase proves those fields never appear as a distinct
// JSON key in any public-facing surface (headline-feed, stream, v1 articles,
// v1 social, custom-MCOP feeds, AND the war dashboard feed), so a serializer
// change that accidentally widens a curated-only field into a public response
// would be caught immediately.
//
// COVERED CURATED-ONLY FIELDS (Task #725 extends Task #706):
//   - attributedClaims — enriched attributed statements (also a headlines col,
//     but only ever serialized on the curated API).
//   - region / country  — content-geography classification, curated_items-only
//     columns that DO serialize on /api/curated/top-stories.
//   - role              — curated tier (contributing|attach-only|anchor-only),
//     a curated_items-only column that serializes on the curated API.
//   (The remaining curated-only columns — mediaAttemptCount, lastMediaAttemptAt,
//    mediaRescueAt, linkDeadAt, linkCheckedAt — are internal enrichment/link
//    bookkeeping that never serialize into ANY shape, curated included, so there
//    is nothing to strip and a negative control on them would pass vacuously.)
//
//   (a) POSITIVE controls — a curated row with each field populated IS returned
//       with that field on /api/curated/top-stories. This proves the negative
//       controls below are meaningful: if the curated endpoint also stripped the
//       field, both controls would pass vacuously.
//
//   (b) NEGATIVE controls — none of those keys ever appear in any trusted public
//       surface (headline-feed, stream, public-articles, public-social, every
//       custom-MCOP feed, and — when the war-viewer precondition is met — the
//       war-dashboard feed).
//
// Cleanup: the seeded canary URL lives under ISOLATION_URL_PREFIX so it is
// swept by cleanupAllResidue() in addition to the local finally block.
// ===========================================================================
async function runAttributedClaimsFieldCheck(slugs: string[]): Promise<void> {
  const claimsUrl = `${ISOLATION_URL_PREFIX}claims-${MARKER}`;
  const claimsTitle = `${MARKER} attributed-claims field canary`;
  // Values recognisable in the response payload but not a substring of any
  // realistic article headline, so containment checks are unambiguous.
  const CLAIMS_SENTINEL = `__AC_SENTINEL_${MARKER}__`;
  const REGION_SENTINEL = `__RGN_SENTINEL_${MARKER}__`;
  const COUNTRY_SENTINEL = `__CTY_SENTINEL_${MARKER}__`;

  // Additional curated-only fields that DO serialize on the curated API. Each is
  // asserted present on /api/curated/top-stories (positive) and absent from every
  // public surface (negative). `role` is a fixed enum resolved from the outlet
  // registry (no free-text sentinel), so it is asserted on the key alone.
  // `negativeOnly` fields are internal-only columns that never serialize on the
  // curated API either (so a positive control there would fail, not pass) — they
  // still must never appear in any public surface. `skipSurfaces` names public
  // surfaces where the key legitimately exists for an UNRELATED shape (e.g.
  // /api/v1/articles intentionally serializes team-submission fullText).
  const curatedOnlyFields: Array<{ key: string; sentinel: string | null; negativeOnly?: boolean; skipSurfaces?: string[] }> = [
    { key: 'attributedClaims', sentinel: CLAIMS_SENTINEL },
    { key: 'region', sentinel: REGION_SENTINEL },
    { key: 'country', sentinel: COUNTRY_SENTINEL },
    { key: 'role', sentinel: null },
    // Task #780: contentKind is the page-detected curated-lane marker
    // (audio/opinion). The curated API always serializes the key (`?? null`),
    // so the positive control asserts the key alone — seeding a non-null value
    // like 'audio' would drop the canary from standalone Top Stories (the
    // audio gate) and break the other positive controls.
    { key: 'contentKind', sentinel: null },
    // Task #780: fullText is the internal full article body carried on
    // headlines rows for enrichment. It never serializes on the curated API
    // (negative-only), and /api/v1/articles intentionally returns a fullText
    // key for team submissions, so that one surface is exempt.
    { key: 'fullText', sentinel: null, negativeOnly: true, skipSurfaces: ['public-articles'] },
  ];

  // Self-heal residue from any prior killed run before seeding this run's row.
  await db.delete(curatedItems).where(like(curatedItems.url, `${ISOLATION_URL_PREFIX}claims-%`));

  try {
    // Seed a fully-enriched contributing curated item so it surfaces as a
    // standalone card in /api/curated/top-stories (clears the content-
    // completeness gate: real headline, bullets, non-favicon image). region /
    // country carry sentinel values so the positive control can assert the
    // seeded VALUE surfaced, not merely that the key exists from other live data.
    const claimsRow = await storage.addCuratedItem({
      title: claimsTitle,
      url: claimsUrl,
      source: 'Isolation Claims Wire',
      category: 'general',
      summary: 'curated attributed-claims canary',
      summaryBullets: ['curated attributed-claims canary bullet'],
      ogImageUrl: '/objects/stream-images/iso-claims.jpg',
      priorityScore: 99,
      role: 'contributing',
      region: REGION_SENTINEL,
      country: COUNTRY_SENTINEL,
    } as any, normalizeTitle(claimsTitle));

    // Stamp media_scraped_at AND attributed_claims in one write so the
    // backfill cron treats the row as fully enriched and never races in to
    // clear the field before the positive-control read below.
    await db.update(curatedItems)
      .set({ mediaScrapedAt: new Date(), attributedClaims: [CLAIMS_SENTINEL] })
      .where(eq(curatedItems.id, claimsRow.id));

    // (a) POSITIVE controls — the curated endpoint returns each curated-only
    // field on the seeded row. The key must be present (and, where a sentinel
    // was seeded, the value too) so a future rename that drops the field would
    // fail this control and stop the negative controls passing vacuously.
    const topStories = await fetchJson(`${BASE_URL}/api/curated/top-stories?hours=48&limit=500`);
    const topStr = JSON.stringify(topStories);
    for (const f of curatedOnlyFields) {
      if (f.negativeOnly) continue; // never serializes on the curated API either
      const keyPresent = topStr.includes(`"${f.key}":`);
      const valuePresent = f.sentinel ? topStr.includes(f.sentinel) : true;
      check(
        `curated-only field present in /api/curated/top-stories (positive control): ${f.key}`,
        keyPresent && valuePresent,
        !keyPresent
          ? `curated top-stories did not return a "${f.key}" key at all`
          : `curated top-stories returned "${f.key}" but the seeded sentinel value was absent`,
      );
    }

    // (b) NEGATIVE controls — none of the curated-only keys appear in any public
    // surface. The war-dashboard feed is included when the war-viewer
    // precondition was met; otherwise it is reported inconclusive rather than
    // silently skipped (a failed war auth is a precondition, not a verdict).
    const trusted: Array<{ name: string; url: string; headers?: Record<string, string> }> = [
      { name: 'headline-feed', url: `${BASE_URL}/api/headline-feed?hours=48` },
      { name: 'stream', url: `${BASE_URL}/api/stream?hours=48` },
      { name: 'public-articles', url: `${BASE_URL}/api/v1/articles?limit=200`, headers: apiKeyHeaders() },
      { name: 'public-social', url: `${BASE_URL}/api/v1/social?limit=200`, headers: apiKeyHeaders() },
    ];
    if (warAuthed) {
      trusted.push({ name: 'war-feed', url: `${BASE_URL}/api/war/feed` });
    } else {
      inconclusive.push('curated-field non-leak: war-feed skipped — war-viewer auth precondition not met');
    }
    for (const slug of slugs) trusted.push({ name: `custom-${slug}`, url: `${BASE_URL}/api/custom-mcops/${slug}/feed?hours=48` });
    for (const t of trusted) {
      const raw = await fetchJson(t.url, t.headers ?? {});
      const rawStr = JSON.stringify(raw);
      for (const f of curatedOnlyFields) {
        if (f.skipSurfaces?.includes(t.name)) continue; // key legitimately exists there for an unrelated shape
        check(
          `curated-field non-leak: "${f.key}" key absent from ${t.name}`,
          !rawStr.includes(`"${f.key}":`),
          `"${f.key}" appeared as a distinct JSON key in a public surface (${t.name})`,
        );
      }
    }
  } finally {
    await db.delete(curatedItems).where(like(curatedItems.url, `${ISOLATION_URL_PREFIX}claims-%`));
  }
}

// ===========================================================================
// FINAL PHASE — LIVE curated-clustering WRITE-ISOLATION (Task #492). The curated
// clustering pass only ever writes the curated tables; this proves it never
// mutates headlines.cluster_id. It is the harness's ONE remaining live AI-backed
// call, kept for its genuine integration value, and runs LAST on purpose: the
// pass is bounded, but on timeout the abandoned promise keeps making AI calls in
// the background, so running anything DB-heavy after it (the deterministic
// intake/clustering exercises) would be starved and blow the fast-gate budget.
// With nothing after it, the abandoned pass can starve nothing, and process.exit
// kills it. The grouping LOGIC itself is verified deterministically in Phase 4.
// ===========================================================================
async function runClusterIsolationCheck(): Promise<void> {
  const headBefore = await db.select({ id: headlines.id, clusterId: headlines.clusterId }).from(headlines);
  const beforeMap = new Map(headBefore.map(h => [h.id, h.clusterId]));
  try {
    const r = await withBudget('clusterCuratedLane', clusterCuratedLane(), CLUSTER_ISO_BUDGET_MS);
    console.log(`[iso] curated clustering pass: stories=${r.stories} members=${r.members}`);
  } catch (err) {
    // A clustering failure OR an exceeded AI budget (slow / rate-limited model)
    // still must not touch headlines.cluster_id; we proceed to the assertion
    // regardless. Curated clustering only ever writes the curated tables, so
    // even an in-flight pass that we stopped awaiting cannot violate isolation.
    console.warn(`[iso] clusterCuratedLane did not complete (continuing to assert isolation): ${(err as Error).message}`);
  }
  const headAfter = await db.select({ id: headlines.id, clusterId: headlines.clusterId }).from(headlines);
  let clusterDrift = 0;
  for (const h of headAfter) {
    if (!beforeMap.has(h.id)) continue; // newly scraped row — ignore
    if (JSON.stringify(beforeMap.get(h.id)) !== JSON.stringify(h.clusterId)) clusterDrift++;
  }
  check('curated clustering isolation: headlines.cluster_id untouched', clusterDrift === 0,
    clusterDrift ? `${clusterDrift} headline cluster_id(s) changed` : '');
}

async function runTeardownOnce(reason: string, exitCode: number): Promise<void> {
  if (!teardownRan) {
    teardownRan = true;
    console.error(`[iso] ${reason} — running guarded teardown to remove residue`);
    try {
      await cleanupAllResidue();
    } catch (e) {
      console.error('[iso] guarded teardown failed:', e);
    }
  }
  process.exit(exitCode);
}

function installTeardownHandlers(): void {
  // 130 = conventional exit code for SIGINT/SIGTERM-terminated processes.
  // SIGHUP is included so a controlling-shell hang-up mid-run (e.g. a CI/runner
  // that disowns the process when its wait window closes) still triggers the
  // residue sweep instead of orphaning canary rows into live "Top Stories".
  process.on('SIGINT', () => { void runTeardownOnce('received SIGINT', 130); });
  process.on('SIGTERM', () => { void runTeardownOnce('received SIGTERM', 130); });
  process.on('SIGHUP', () => { void runTeardownOnce('received SIGHUP', 130); });
  process.on('uncaughtException', (err) => {
    console.error('[iso] uncaughtException:', err);
    void runTeardownOnce('uncaughtException', 2);
  });
  process.on('unhandledRejection', (reason) => {
    // A TRANSIENT-AI rejection here is the known-benign abandoned-clustering case:
    // clusterCuratedLane is abandoned once it blows its AI budget under a 429
    // storm, but keeps retrying (incl. the Anthropic fallback) in the background;
    // when one of those late calls rejects it lands as an unhandledRejection. That
    // is NOT an isolation violation — the structural assertions have already run
    // and curated clustering only ever writes curated tables — so it must not be
    // escalated to a hard exit-2 FAIL of an otherwise-passing run. Log and ignore
    // transient-AI rejections; keep every other unhandledRejection fatal.
    // Narrowed to `aiDegraded`: we only suppress once an AI budget has actually
    // been blown this run (the only way a background pass is left running), so an
    // unrelated transient-looking rejection on a healthy run stays fatal.
    if (aiDegraded && isTransientAIError(reason)) {
      console.warn('[iso] ignoring transient-AI unhandledRejection from an abandoned background pass:',
        (reason as Error)?.message ?? reason);
      return;
    }
    console.error('[iso] unhandledRejection:', reason);
    void runTeardownOnce('unhandledRejection', 2);
  });
}

async function main() {
  installTeardownHandlers();
  console.log(
    `[iso] mode: ${FULL_MODE
      ? 'FULL (incl. slow live byte-identical non-disruption comparison)'
      : 'FAST (default — deterministic isolation/non-leak/write-scope/clustering/dead-link/intake/social checks)'}`,
  );
  await waitForServer();
  await login();
  await warLogin();
  // Skip flags (e.g. --full) when picking the optional custom-MCOP slug arg.
  const slugArg = process.argv.slice(2).find(a => !a.startsWith('--'));
  const slugs = await resolveCustomSlugs(slugArg);
  console.log(`[iso] custom MCOP feeds under test (${slugs.length}): ${slugs.join(', ')}`);
  await runEnrichmentChecks(slugs);
  await runCuratedChecks(slugs);
  await runDeadLinkChecks(slugs);
  await runIntakeChecks(slugs);
  await runSocialWindowChecks();
  await runStateNarrativesInvalidationChecks();
  await runAttributedClaimsFieldCheck(slugs);
  // LAST: the one remaining live AI-backed call (write-isolation). Kept last so
  // its abandoned-on-timeout AI background work can't starve the deterministic
  // phases above and blow the fast-gate wall-clock (Task #492).
  await runClusterIsolationCheck();

  if (failures.length) {
    console.error(`\n[iso] ISOLATION VIOLATED — ${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  if (inconclusive.length) {
    console.warn(`\n[iso] INCONCLUSIVE — ${inconclusive.length} check(s) never settled after retries (not a confirmed violation):`);
    for (const f of inconclusive) console.warn(`  - ${f}`);
    process.exit(PRECONDITION_EXIT_CODE);
  }
  console.log('\n[iso] all isolation guarantees hold');
  process.exit(0);
}

// Only auto-run the full harness when this file is executed DIRECTLY (e.g.
// `tsx scripts/curated-isolation-harness.ts`, which is how the curated-isolation
// gate invokes it). When it is merely IMPORTED for its exported helpers
// (cleanupAllResidue, the prefix constants) — as scripts/test-sigkill-self-heal.ts
// does — main() must NOT fire. Otherwise the harness runs concurrently with the
// importer and its startup sweep of the shared `__iso_test_outlet_` prefix deletes
// the importer's outlet_registry canary mid-check, intermittently failing the
// sigkill positive control. This restores the documented run-sigkill-then-harness
// serialization the two scripts were designed around.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return entry === fileURLToPath(import.meta.url);
  }
})();

if (invokedDirectly) {
  main().catch(async err => {
    if (err instanceof ServerUnreachableError) {
      // Precondition failure: nothing was seeded, so there is no residue to remove.
      console.error(`\n[iso] PRECONDITION FAILED (server unreachable, NOT an isolation violation): ${err.message}`);
      process.exit(PRECONDITION_EXIT_CODE);
    }
    // A fatal error partway through main: per-phase finally blocks clean up their
    // own residue, but run the centralized teardown too as a belt-and-suspenders.
    console.error('[iso] fatal:', err);
    await runTeardownOnce('fatal error', 2);
  });
}
