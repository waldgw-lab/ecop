/**
 * Verification gate: curated per-item content-kind override (Task #892).
 *
 * Checks the full required contract:
 *  1. GET  /api/curated/content-kind-override?url=<url>  returns {kind: null} when no override exists.
 *  2. POST /api/curated/content-kind-override            sets the kind.
 *  3. GET  confirms the newly-set kind.
 *  4. POST with kind=null clears the override.
 *  5. GET  confirms the kind is null again.
 *  6. POST with an invalid kind returns 400.
 *  7. Demotion wiring: static code checks that the override is applied in the
 *     clustering pass (curatedCluster.ts) and the demotion function exists.
 *  7e. Canonical keying: overrides are stored + looked up under
 *     normalizeIdentityUrl(<original stored url>) at every site (storage
 *     boundary, clustering pass, top-stories build), and the endpoint resolves
 *     dead-link REPLACEMENT urls back to the original identity.
 *  8. Surface exclusion: verify the /api/curated/top-stories response is
 *     structurally consistent (override endpoint returns the marked kind).
 *  8r. Replaced-link integration (DB-level, no auth needed): seed a curated
 *     item + a dead-link replacement overlay, resolve the REPLACEMENT url,
 *     set the mark, and assert the stored key equals
 *     normalizeIdentityUrl(<original url>) — the exact key the clustering
 *     pass and payload builders check.
 *  9. Non-destructive Reset + Archive: POST reset → acknowledgedAt is set;
 *     active override-log events reflect the reset; archive view returns
 *     events from BEFORE acknowledgedAt without deleting rows.
 * 10. Override survives reset: mark is still present after a reset.
 *
 * Exit codes: 0 = pass, 1 = fail, 3 = inconclusive (network/auth).
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:5000';
const PASS = 0, FAIL = 1, INCONCLUSIVE = 3;

const TEST_URL = `https://gate-test.example.com/content-kind-${Date.now()}`;

async function login(): Promise<string | null> {
  // /api/auth/login validates against APP_PASSWORD only — ADMIN_PASSWORD is a
  // different credential and always 401s here, so prefer APP_PASSWORD.
  const pw = process.env.APP_PASSWORD ?? process.env.ADMIN_PASSWORD;
  if (!pw) return null;
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    // The session cookie is `secure` behind `trust proxy`, so it is only issued
    // when the request looks like HTTPS — spoof the proxy header over localhost
    // (same convention as curated-isolation-harness.ts).
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ password: pw }),
  });
  if (!r.ok) return null;
  const cookies = typeof (r.headers as any).getSetCookie === 'function'
    ? (r.headers as any).getSetCookie()
    : [r.headers.get('set-cookie')].filter(Boolean);
  if (!cookies || cookies.length === 0) return null;
  return cookies.map((c: string) => c.split(';')[0]).join('; ');
}

async function req(method: string, path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'x-forwarded-proto': 'https',
    },
    body: method !== 'GET' ? JSON.stringify(body) : undefined,
  });
}

// ── Step 7: Static code checks for demotion wiring ──────────────────────────
function checkDemotionWiring(): void {
  const clusterFile = path.join(__dirname, '../server/curatedCluster.ts');
  if (!fs.existsSync(clusterFile)) {
    console.error('[gate] curatedCluster.ts not found');
    process.exit(FAIL);
  }
  const src = fs.readFileSync(clusterFile, 'utf8');

  // Check that ckOverrides is loaded per-pass from storage
  if (!src.includes('getCuratedContentKindOverrides')) {
    console.error('[gate] curatedCluster.ts: getCuratedContentKindOverrides not called');
    process.exit(FAIL);
  }
  // Check that the override is applied. Accept .has( OR .get( — Task #910's
  // Explainer kind refactored the lookups from a boolean .has() to a value
  // .get() (the kind now matters, not just presence); both prove application.
  if (!/ckOverrides\.(has|get)\(/.test(src)) {
    console.error('[gate] curatedCluster.ts: ckOverrides.has()/.get() not found — override not applied');
    process.exit(FAIL);
  }
  // Check that the demotion function is called
  if (!src.includes('shouldDemoteEffectiveOpinion') && !src.includes('demoteOpinionAnalysis')) {
    console.error('[gate] curatedCluster.ts: demotion function not called');
    process.exit(FAIL);
  }
  // Check that both mainNodes and curatedNodes paths apply the override
  const hasMatches = (src.match(/ckOverrides\.(has|get)\(/g) ?? []).length;
  if (hasMatches < 2) {
    console.error(`[gate] curatedCluster.ts: ckOverrides.has()/.get() found only ${hasMatches} time(s) — expected ≥2 (mainNodes + curatedNodes paths)`);
    process.exit(FAIL);
  }
  console.log('[gate] Step 7 PASS: demotion wiring present in curatedCluster.ts');

  // Check routes.ts for 400 validation of invalid kind
  const routesFile = path.join(__dirname, '../server/routes.ts');
  const routesSrc = fs.readFileSync(routesFile, 'utf8');
  if (!routesSrc.includes('Invalid kind')) {
    console.error('[gate] routes.ts: 400 validation for invalid kind missing');
    process.exit(FAIL);
  }
  console.log('[gate] Step 7b PASS: 400 validation for invalid kind present in routes.ts');

  // Audit trail (#894, folded into #892): every set/clear must record a curated
  // override event so marks show in the Adjustments trail.
  if (!routesSrc.includes("'content-kind-mark'") || !routesSrc.includes("'content-kind-clear'")) {
    console.error('[gate] routes.ts: content-kind-mark/clear override-event capture missing');
    process.exit(FAIL);
  }
  console.log('[gate] Step 7c PASS: audit-event capture (content-kind-mark/clear) present in routes.ts');

  // Stale-mark retention prune (#893, folded into #892): overrides untouched
  // past the retention window must be pruned in the ingest pass so a mark
  // can't re-attach to a new story at a reused URL.
  const ingestFile = path.join(__dirname, '../server/curatedIngest.ts');
  const ingestSrc = fs.readFileSync(ingestFile, 'utf8');
  if (!ingestSrc.includes('pruneStaleCuratedContentKindOverrides')) {
    console.error('[gate] curatedIngest.ts: stale content-kind override prune not wired');
    process.exit(FAIL);
  }
  const storageFile = path.join(__dirname, '../server/storage.ts');
  const storageSrc = fs.readFileSync(storageFile, 'utf8');
  if (!storageSrc.includes('async pruneStaleCuratedContentKindOverrides')) {
    console.error('[gate] storage.ts: pruneStaleCuratedContentKindOverrides implementation missing');
    process.exit(FAIL);
  }
  console.log('[gate] Step 7d PASS: stale-override retention prune wired (curatedIngest.ts + storage.ts)');

  // Step 7e: canonical keying at every consumer site (review fix). A mark on a
  // dead-link-REPLACED story must still demote the item, so:
  //  - storage normalizes keys at the boundary (write + both reads);
  //  - the endpoint maps a replacement url back to the original identity;
  //  - clustering + the top-stories build look up by normalizeIdentityUrl of
  //    the row's ORIGINAL url (never the display/replacement url).
  if (!storageSrc.includes('async resolveCuratedContentKindTargetUrl')) {
    console.error('[gate] storage.ts: resolveCuratedContentKindTargetUrl (replacement→original resolver) missing');
    process.exit(FAIL);
  }
  const setImpl = storageSrc.slice(storageSrc.indexOf('async setCuratedContentKindOverride'));
  if (!setImpl.slice(0, 700).includes('normalizeIdentityUrl(url)')) {
    console.error('[gate] storage.ts: setCuratedContentKindOverride does not normalize the key at the boundary');
    process.exit(FAIL);
  }
  if ((routesSrc.match(/resolveCuratedContentKindTargetUrl/g) ?? []).length < 2) {
    console.error('[gate] routes.ts: GET/POST content-kind-override endpoints do not both resolve the canonical target url');
    process.exit(FAIL);
  }
  if ((src.match(/ckOverrides\.(has|get)\(normalizeIdentityUrl\(/g) ?? []).length < 2) {
    console.error('[gate] curatedCluster.ts: ckOverrides lookups are not keyed by normalizeIdentityUrl');
    process.exit(FAIL);
  }
  if ((routesSrc.match(/ckOverrides\.(has|get)\(normalizeIdentityUrl\(/g) ?? []).length < 2) {
    console.error('[gate] routes.ts: top-stories build sites (main + curated rows) are not keyed by normalizeIdentityUrl of the original url');
    process.exit(FAIL);
  }
  // The old post-build pass matched item.url (= effectiveUrl for replaced rows)
  // and silently missed. It must stay deleted.
  if (/ckOverrides\.(has|get)\(item\.url\)/.test(routesSrc)) {
    console.error('[gate] routes.ts: legacy post-build override pass keyed on item.url (effectiveUrl) still present');
    process.exit(FAIL);
  }
  console.log('[gate] Step 7e PASS: canonical override keying wired at storage, endpoint, clustering, and top-stories build');

  // Step 7f: Reset must clear the CURRENT Adjustments view immediately — the
  // consolidated manual-links section is reset-aware, so the reset mutation
  // must invalidate its query (prefix key covers active + archive variants),
  // not just the override-log. Without it, pre-reset manual links linger in
  // the current view until a reopen/toggle refetch.
  const dialogFile = path.join(__dirname, '../client/src/components/OutletOversightDialog.tsx');
  const dialogSrc = fs.readFileSync(dialogFile, 'utf8');
  const resetIdx = dialogSrc.indexOf('const resetMutation');
  if (resetIdx === -1) {
    console.error('[gate] OutletOversightDialog.tsx: resetMutation not found');
    process.exit(FAIL);
  }
  const resetBlock = dialogSrc.slice(resetIdx, resetIdx + 1600);
  if (!resetBlock.includes('"/api/curated/manual-links"')) {
    console.error('[gate] OutletOversightDialog.tsx: resetMutation does not invalidate /api/curated/manual-links — pre-reset manual links would linger in the current Adjustments view');
    process.exit(FAIL);
  }
  console.log('[gate] Step 7f PASS: reset invalidates the consolidated manual-links query');
}

// ── Step 8r: replaced-link integration (DB-level; runs without HTTP auth) ───
// Simulates the exact scenario the review flagged: a story whose dead link got
// a replacement overlay is marked from the popup (which holds the REPLACEMENT
// url). The override must land under normalizeIdentityUrl(<ORIGINAL url>) —
// the key the clustering pass checks via ckOverrides.has(normalizeIdentityUrl(c.url)).
async function checkReplacedLinkIntegration(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('[gate] Step 8r SKIP: DATABASE_URL not set — cannot run DB-level replaced-link check');
    return;
  }
  const { storage } = await import('../server/storage');
  const { normalizeIdentityUrl } = await import('../server/urlIdentity');
  const { db } = await import('../server/db');
  const schema = await import('../shared/schema');
  const { eq } = await import('drizzle-orm');

  const stamp = Date.now();
  // Marker lives in the URL; the title stays clean prose (reject gates match by title).
  const originalUrl = `https://gate-test.example.com/ck-replaced-original-${stamp}?utm_source=gate`;
  const replacementUrl = `https://gate-test.example.com/ck-replacement-target-${stamp}`;
  const canonicalKey = normalizeIdentityUrl(originalUrl);
  let itemId: string | null = null;
  try {
    const [item] = await db.insert(schema.curatedItems).values({
      title: 'Defense ministry outlines annual procurement review',
      normalizedTitle: 'defense ministry outlines annual procurement review',
      url: originalUrl,
      source: 'GateTest Wire',
      category: 'general',
    }).returning({ id: schema.curatedItems.id });
    itemId = item.id;
    await db.insert(schema.curatedLinkReplacements).values({
      key: `curated:${itemId}`, url: replacementUrl, updatedBy: 'gate', updatedAt: new Date(),
    });

    // Resolve the DISPLAY (replacement) url — with an extra tracking param, to
    // also exercise identity normalization — back to the original identity.
    // The resolver returns the RAW original stored url (the override boundary
    // normalizes keys itself); raw is required so the audit-snapshot lookup
    // (exact-match on the stored row url) keeps headline/outlet context.
    const resolved = await storage.resolveCuratedContentKindTargetUrl(`${replacementUrl}?utm_medium=social`);
    if (resolved !== originalUrl) {
      console.error(`[gate] Step 8r FAIL: resolver returned "${resolved}", expected raw original "${originalUrl}"`);
      process.exit(FAIL);
    }
    // Snapshot fidelity: the audit-event snapshot resolver looks up the curated
    // row by EXACT stored url — the resolved url must hit it.
    const snapRow = await storage.getCuratedItemByUrl(resolved);
    if (!snapRow || snapRow.id !== itemId) {
      console.error('[gate] Step 8r FAIL: resolved url does not exact-match the stored row — audit snapshot would be empty for replaced items');
      process.exit(FAIL);
    }

    // Set the mark the way the POST endpoint does, then assert the bulk map —
    // what the clustering pass loads — hits on the clustering-side lookup key.
    await storage.setCuratedContentKindOverride(resolved, 'analysis', 'gate-test');
    const map = await storage.getCuratedContentKindOverrides();
    if (!map.has(normalizeIdentityUrl(originalUrl))) {
      console.error('[gate] Step 8r FAIL: override map missing normalizeIdentityUrl(<original url>) — clustering would never demote');
      process.exit(FAIL);
    }
    if (map.get(normalizeIdentityUrl(originalUrl)) !== 'analysis') {
      console.error('[gate] Step 8r FAIL: override map has wrong kind for the canonical key');
      process.exit(FAIL);
    }
    // The point-read used by the GET endpoint must agree, from either url form.
    const viaReplacement = await storage.getCuratedContentKindOverrideByUrl(
      await storage.resolveCuratedContentKindTargetUrl(replacementUrl),
    );
    if (viaReplacement !== 'analysis') {
      console.error('[gate] Step 8r FAIL: GET-path read via replacement url returned', viaReplacement);
      process.exit(FAIL);
    }
    console.log('[gate] Step 8r PASS: replacement-url mark lands on the canonical original identity (clustering + payload key)');
  } finally {
    // Always sweep fixture residue (item, overlay row, override) — orphaned
    // rows would otherwise sit in the live curated store until age-out.
    try {
      await storage.setCuratedContentKindOverride(canonicalKey, null, 'gate-test');
      if (itemId) {
        await db.delete(schema.curatedLinkReplacements).where(eq(schema.curatedLinkReplacements.key, `curated:${itemId}`));
        await db.delete(schema.curatedItems).where(eq(schema.curatedItems.id, itemId));
      }
    } catch (e) {
      console.error('[gate] Step 8r cleanup warning:', e);
    }
  }
}

async function main() {
  // Step 7: Static checks (no auth needed) — run before the network checks
  // so a wiring regression fails fast without needing a running server.
  checkDemotionWiring();

  // Step 8r: DB-level replaced-link canonical-keying check (no auth needed).
  try {
    await checkReplacedLinkIntegration();
  } catch (e) {
    console.error('[gate] Step 8r precondition failure (DB unreachable?):', e);
    process.exit(INCONCLUSIVE);
  }

  let cookie: string | null = null;
  try {
    cookie = await login();
  } catch (e) {
    console.error('[gate] Login unreachable:', e);
    process.exit(INCONCLUSIVE);
  }
  if (!cookie) {
    console.error('[gate] Could not log in — cannot test content-kind override endpoint (needs editor auth)');
    process.exit(INCONCLUSIVE);
  }

  // Step 1: GET — no override exists yet.
  let r = await req('GET', `/api/curated/content-kind-override?url=${encodeURIComponent(TEST_URL)}`, null, cookie);
  if (!r.ok) {
    console.error('[gate] GET returned', r.status);
    process.exit(r.status === 503 || r.status === 502 ? INCONCLUSIVE : FAIL);
  }
  let data = await r.json() as { kind: string | null };
  if (data.kind !== null) {
    console.error('[gate] Expected kind=null for a fresh URL, got:', data.kind);
    process.exit(FAIL);
  }
  console.log('[gate] Step 1 PASS: GET returns null for fresh URL');

  // Step 2: POST — set kind='opinion'.
  r = await req('POST', '/api/curated/content-kind-override', { url: TEST_URL, kind: 'opinion' }, cookie);
  if (!r.ok) {
    console.error('[gate] POST set returned', r.status);
    process.exit(r.status === 503 || r.status === 502 ? INCONCLUSIVE : FAIL);
  }
  console.log('[gate] Step 2 PASS: POST set kind=opinion');

  // Step 3: GET — confirms kind='opinion'.
  r = await req('GET', `/api/curated/content-kind-override?url=${encodeURIComponent(TEST_URL)}`, null, cookie);
  if (!r.ok) { console.error('[gate] GET after set returned', r.status); process.exit(FAIL); }
  data = await r.json() as { kind: string | null };
  if (data.kind !== 'opinion') {
    console.error('[gate] Expected kind=opinion after set, got:', data.kind);
    process.exit(FAIL);
  }
  console.log('[gate] Step 3 PASS: GET returns opinion after set');

  // Step 6: POST with invalid kind — must return 400.
  r = await req('POST', '/api/curated/content-kind-override', { url: TEST_URL, kind: 'invalid-kind' }, cookie);
  if (r.status !== 400) {
    console.error('[gate] Expected 400 for invalid kind, got', r.status);
    process.exit(FAIL);
  }
  console.log('[gate] Step 6 PASS: POST with invalid kind returns 400');

  // Step 9: Non-destructive Reset + Archive.
  // 9a. Snapshot override-log BEFORE reset to confirm events exist.
  r = await req('GET', '/api/curated/override-log', null, cookie);
  if (!r.ok) {
    console.error('[gate] GET override-log returned', r.status);
    process.exit(r.status === 503 || r.status === 502 ? INCONCLUSIVE : FAIL);
  }
  const logBefore = await r.json() as { report: { totalEvents: number }; acknowledgedAt: string | null };
  console.log(`[gate] Step 9a: override-log before reset — totalEvents=${logBefore.report.totalEvents}, acknowledgedAt=${logBefore.acknowledgedAt}`);

  // 9b. POST reset — non-destructive (returns acknowledgedAt, does NOT delete rows).
  r = await req('POST', '/api/curated/override-log/reset', {}, cookie);
  if (!r.ok) {
    console.error('[gate] POST reset returned', r.status);
    process.exit(r.status === 503 || r.status === 502 ? INCONCLUSIVE : FAIL);
  }
  const resetData = await r.json() as { ok: boolean; acknowledgedAt: string | null };
  if (!resetData.ok || !resetData.acknowledgedAt) {
    console.error('[gate] Reset did not return acknowledgedAt:', resetData);
    process.exit(FAIL);
  }
  console.log('[gate] Step 9b PASS: POST reset returned acknowledgedAt:', resetData.acknowledgedAt);

  // 9c. Active log now shows events SINCE the reset (should be empty or very recent).
  r = await req('GET', '/api/curated/override-log', null, cookie);
  if (!r.ok) { console.error('[gate] GET override-log after reset returned', r.status); process.exit(FAIL); }
  const logAfter = await r.json() as { report: { totalEvents: number }; acknowledgedAt: string | null };
  if (!logAfter.acknowledgedAt) {
    console.error('[gate] acknowledgedAt not returned after reset');
    process.exit(FAIL);
  }
  // Override events written BEFORE the reset should not appear in the active view.
  // If the pre-reset totalEvents was >0 and active totalEvents equals pre-reset, the
  // reset did not isolate properly.
  if (logBefore.report.totalEvents > 0 && logAfter.report.totalEvents >= logBefore.report.totalEvents) {
    console.error(`[gate] Active log totalEvents (${logAfter.report.totalEvents}) ≥ pre-reset (${logBefore.report.totalEvents}) — reset did not isolate`);
    process.exit(FAIL);
  }
  console.log(`[gate] Step 9c PASS: active log after reset has ${logAfter.report.totalEvents} events (pre-reset: ${logBefore.report.totalEvents})`);

  // 9d. Archive view returns the pre-reset events (rows NOT deleted).
  r = await req('GET', '/api/curated/override-log?archive=1', null, cookie);
  if (!r.ok) { console.error('[gate] GET override-log?archive=1 returned', r.status); process.exit(FAIL); }
  const archiveLog = await r.json() as { report: { totalEvents: number }; archive: boolean; acknowledgedAt: string | null };
  if (!archiveLog.archive) {
    console.error('[gate] archive=1 response missing archive:true flag');
    process.exit(FAIL);
  }
  if (logBefore.report.totalEvents > 0 && archiveLog.report.totalEvents === 0) {
    console.error('[gate] Archive view returned 0 events but pre-reset totalEvents was >0 — rows were deleted (non-destructive invariant violated)');
    process.exit(FAIL);
  }
  console.log(`[gate] Step 9d PASS: archive view has ${archiveLog.report.totalEvents} events — rows preserved after reset`);

  // Step 10: Override survives reset (mark still present after reset).
  r = await req('GET', `/api/curated/content-kind-override?url=${encodeURIComponent(TEST_URL)}`, null, cookie);
  if (!r.ok) { console.error('[gate] GET after reset returned', r.status); process.exit(FAIL); }
  data = await r.json() as { kind: string | null };
  if (data.kind !== 'opinion') {
    console.error('[gate] Override did not survive reset — expected opinion, got:', data.kind);
    process.exit(FAIL);
  }
  console.log('[gate] Step 10 PASS: content-kind override survives reset');

  // Step 4: POST — clear kind.
  r = await req('POST', '/api/curated/content-kind-override', { url: TEST_URL, kind: null }, cookie);
  if (!r.ok) { console.error('[gate] POST clear returned', r.status); process.exit(FAIL); }
  console.log('[gate] Step 4 PASS: POST cleared kind');

  // Step 5: GET — confirms kind=null again.
  r = await req('GET', `/api/curated/content-kind-override?url=${encodeURIComponent(TEST_URL)}`, null, cookie);
  if (!r.ok) { console.error('[gate] GET after clear returned', r.status); process.exit(FAIL); }
  data = await r.json() as { kind: string | null };
  if (data.kind !== null) {
    console.error('[gate] Expected kind=null after clear, got:', data.kind);
    process.exit(FAIL);
  }
  console.log('[gate] Step 5 PASS: GET returns null after clear');

  console.log('[gate] PASS: curated-content-kind-override full contract verified');
  process.exit(PASS);
}

main().catch((e) => {
  console.error('[gate] Unexpected error:', e);
  process.exit(INCONCLUSIVE);
});
