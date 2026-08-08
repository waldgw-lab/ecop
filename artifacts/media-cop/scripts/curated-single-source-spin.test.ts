/**
 * scripts/curated-single-source-spin.test.ts
 *
 * Regression gate for Task #937: single-source curated items show a bias/lean
 * (spin) line in the detail view.
 *
 * Checks (all deterministic — no live AI, no live server):
 *   1. generateSourceSpin is exported from server/streamPrefetch.ts and returns
 *      null for short/empty text (early guard fires before any AI call).
 *   2. The curatedItems Drizzle schema includes a `sourceSpin` column.
 *   3. cacheCuratedItemMedia accepts a `sourceSpin` parameter (10th positional).
 *   4. The standalone curated item payload in routes.ts includes a `spin` field
 *      mapped from item.sourceSpin.
 *
 * Exit 0 = PASS, exit 1 = FAIL.
 */

import { generateSourceSpin, cacheCuratedItemMedia } from '../server/streamPrefetch';
import { curatedItems } from '../shared/schema';

let passed = 0;
let failed = 0;

function ok(label: string) {
  console.log(`  PASS  ${label}`);
  passed++;
}
function fail(label: string, detail?: string) {
  console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ''}`);
  failed++;
}

// ---------------------------------------------------------------------------
// 1. generateSourceSpin early-guard: short text → null, no AI call needed
// ---------------------------------------------------------------------------
async function checkEarlyGuards() {
  // Empty title → null
  const r1 = await generateSourceSpin(null, 'some article text that is long enough to pass the 200 char threshold but the title is null so it should return null early before any AI call is attempted here');
  if (r1 === null) {
    ok('generateSourceSpin(null title) → null');
  } else {
    fail('generateSourceSpin(null title) should return null', String(r1));
  }

  // Short article text → null
  const r2 = await generateSourceSpin('Some headline', 'Too short.');
  if (r2 === null) {
    ok('generateSourceSpin(short text) → null');
  } else {
    fail('generateSourceSpin(short text) should return null', String(r2));
  }

  // Empty string → null
  const r3 = await generateSourceSpin('Some headline', '');
  if (r3 === null) {
    ok('generateSourceSpin(empty text) → null');
  } else {
    fail('generateSourceSpin(empty text) should return null', String(r3));
  }
}

// ---------------------------------------------------------------------------
// 2. Schema: curatedItems table has sourceSpin column
// ---------------------------------------------------------------------------
function checkSchema() {
  const cols = Object.keys(curatedItems);
  if (cols.includes('sourceSpin')) {
    ok('curatedItems schema includes sourceSpin column');
  } else {
    fail('curatedItems schema missing sourceSpin column', `Columns: ${cols.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// 3. cacheCuratedItemMedia signature accepts sourceSpin as 10th parameter
// ---------------------------------------------------------------------------
function checkCacheSignature() {
  // The function must accept at least 10 parameters; verify via .length.
  // Default parameters reduce .length, so we check the source-code contract
  // by inspecting that the param list includes sourceSpin via toString().
  const src = cacheCuratedItemMedia.toString();
  if (src.includes('sourceSpin')) {
    ok('cacheCuratedItemMedia signature includes sourceSpin parameter');
  } else {
    fail('cacheCuratedItemMedia does not mention sourceSpin in its signature/body');
  }
}

// ---------------------------------------------------------------------------
// 4. routes.ts standalone payload includes spin: item.sourceSpin
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function checkRoutesPayload() {
  const src = readFileSync(join(process.cwd(), 'server/routes.ts'), 'utf8');
  // The standalone payload object must contain spin: item.sourceSpin
  if (/spin\s*:\s*item\.sourceSpin/.test(src)) {
    ok('routes.ts standalone payload maps spin: item.sourceSpin');
  } else {
    fail('routes.ts standalone payload does not map spin from item.sourceSpin');
  }
}

// ---------------------------------------------------------------------------
// 5. Curated.tsx standalone detail view renders a.spin (unchanged existing gate)
// ---------------------------------------------------------------------------
function checkClientRender() {
  const src = readFileSync(join(process.cwd(), 'client/src/pages/Curated.tsx'), 'utf8');
  if (/a\.spin\s*&&/.test(src)) {
    ok('Curated.tsx renders a.spin with existing gate (unchanged)');
  } else {
    fail('Curated.tsx does not gate a.spin — standalone spin rendering may be broken');
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n=== curated-single-source-spin regression gate ===\n');

  await checkEarlyGuards();
  checkSchema();
  checkCacheSignature();
  checkRoutesPayload();
  checkClientRender();

  console.log(`\n${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error('[gate] unexpected error:', err);
  process.exit(1);
});
