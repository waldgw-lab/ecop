/**
 * Gate: curated-revision-auth
 *
 * Guards the auth TIER of the curated change-signal endpoint.
 *
 * The `/api/curated/revision` poll (Task #816) is what lets EVERY authenticated
 * curated viewer — not just the editor/tester allowlist — pick up edits within
 * ~15s. Its data twin, `/api/curated/top-stories`, is view-tier
 * (`requireCuratedView`). If the revision endpoint is ever narrowed to the
 * editor-only tier (`requireCuratedAccess`), standard viewers silently get
 * 401/403 on every poll and fall back to the slow 120s auto-refresh — a
 * regression that is invisible in dev (CURATED_DEV_BYPASS passes both tiers) and
 * only shows up for real non-editor viewers in production.
 *
 * This is a STATIC source assertion (not a runtime call) precisely because the
 * dev bypass makes both tiers pass at runtime, so only reading the registration
 * can catch the regression.
 *
 * Exit 0 = pass, 1 = fail (harness-reliability convention).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const routesPath = join(__dirname, '..', 'server', 'routes.ts');
const src = readFileSync(routesPath, 'utf8');

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) {
    console.log(`[revision-auth] OK   ${label}`);
  } else {
    failed++;
    console.error(`[revision-auth] FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// Capture the middleware the revision endpoint is registered with.
const revMatch = src.match(
  /app\.get\(\s*["']\/api\/curated\/revision["']\s*,\s*([A-Za-z0-9_]+)\s*,/,
);
check(
  '1 /api/curated/revision is registered with a named middleware',
  !!revMatch,
  'could not find the app.get("/api/curated/revision", <middleware>, ...) registration',
);

const revMw = revMatch?.[1];
check(
  '2 revision endpoint is VIEW-tier (requireCuratedView), so every authenticated viewer can poll it',
  revMw === 'requireCuratedView',
  `middleware=${revMw ?? '<none>'}`,
);
check(
  '3 revision endpoint is NOT editor-only (requireCuratedAccess) — that would strand standard viewers on the 120s fallback',
  revMw !== 'requireCuratedAccess',
  `middleware=${revMw ?? '<none>'}`,
);

// Its data twin (top-stories) defines the tier the poll must match.
const topMatch = src.match(
  /app\.get\(\s*["']\/api\/curated\/top-stories["']\s*,\s*([A-Za-z0-9_]+)\s*,/,
);
const topMw = topMatch?.[1];
check(
  '4 /api/curated/top-stories is view-tier (the reference tier for the poll)',
  topMw === 'requireCuratedView',
  `middleware=${topMw ?? '<none>'}`,
);
check(
  '5 revision endpoint tier MATCHES its top-stories data twin (poll can always reach what it refetches)',
  !!revMw && revMw === topMw,
  `revision=${revMw ?? '<none>'} top-stories=${topMw ?? '<none>'}`,
);

if (failed === 0) {
  console.log('[revision-auth] all checks passed');
  process.exit(0);
} else {
  console.error(`[revision-auth] ${failed} check(s) failed`);
  process.exit(1);
}
