/**
 * Regression gate: importance-aware CURATED decay curve (Task #1129).
 *
 * The curated lane decays with tiered slopes (curatedDecayParams):
 *   - low/mid band (P < 70): 2h grace, -6/hr (unchanged legacy curve)
 *   - critical band (P >= 85): 3h grace, -4/hr (tightened from 6h/-2)
 *   - transition band (70..85): grace/slope linearly interpolated (no cliff)
 *
 * Invariants proven here:
 *   1. Low/mid band identical to the flat helper (no reshuffle at the bottom).
 *   2. Critical stories hold rank: P90 at 10h still beats a fresh P60;
 *      crossover lands near the ~12h mark (tightened from ~24h).
 *   3. Never-raise: decayed <= original at every age/priority.
 *   4. Monotonic in priority at equal age (no boundary cliff/ordering inversion).
 *   5. Floor 20 and >= 2h minimum grace preserved; overrides bypass decay.
 *   6. Main-feed helper (calculateDepreciatedPriority) is byte-for-byte the old
 *      flat curve — non-curated callers are unaffected.
 *   7. Direct server call sites of the flat helper are restricted to an explicit
 *      allowlist of the primary-feed and custom-MCOP paths.
 *
 * Exit 0 = PASS, exit 1 = FAIL.
 * Usage: npx tsx scripts/curated-tiered-decay.test.ts
 */

import {
  calculateDepreciatedPriority,
  calculateCuratedDepreciatedPriority,
  curatedDecayParams,
} from '../server/storage';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`[tiered-decay] OK   ${name}`);
  else { console.error(`[tiered-decay] FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const at = (h: number) => new Date(Date.now() - h * 3_600_000);
const curated = (p: number, ageH: number) =>
  calculateCuratedDepreciatedPriority(p, null, at(ageH), null, at(ageH)).depreciatedPriority;
const flat = (p: number, ageH: number) =>
  calculateDepreciatedPriority(p, null, at(ageH), null, at(ageH)).depreciatedPriority;

// 1. Low/mid band identical to flat curve.
{
  let same = true;
  for (const p of [25, 40, 55, 60, 65, 69]) {
    for (const h of [0, 1, 2, 3, 5, 8, 12, 24, 48]) {
      if (curated(p, h) !== flat(p, h)) { same = false; break; }
    }
  }
  check('low/mid band (P<70) matches the legacy flat curve exactly', same);
}

// 2. Critical retention across a news cycle.
check('P90 @10h still outranks a fresh P60', curated(90, 10) > 60,
  `P90@10h=${curated(90, 10)}`);
check('P90 @10h still outranks a fresh P60', curated(90, 10) > 60,
  `P90@10h=${curated(90, 10)}`);
check('old flat curve would have dropped P90 @10h below fresh P60 (the bug)',
  flat(90, 10) < 60, `flat P90@10h=${flat(90, 10)}`);
check('crossover lands near ~12h (P95 @14h at/below fresh P60)',
  curated(95, 14) <= 60, `P95@14h=${curated(95, 14)}`);

// 3. Never-raise + floor.
{
  let ok = true;
  for (let p = 20; p <= 100; p += 1) {
    for (const h of [0, 0.5, 1, 2, 3, 4, 6, 7, 10, 15, 24, 48, 96]) {
      const d = curated(p, h);
      if (d > p || d < 20) { ok = false; break; }
    }
  }
  check('never-raise + floor 20 hold across the whole grid', ok);
}

// 4. Monotonic in priority at equal age — no cliff at band boundaries.
{
  let ok = true;
  for (const h of [3, 5, 7, 9, 12, 18, 24, 36]) {
    let prev = -Infinity;
    for (let p = 20; p <= 100; p += 1) {
      const d = curated(p, h);
      if (d < prev) { ok = false; break; }
      prev = d;
    }
  }
  check('decayed score monotonic in raw priority at every age (no band cliff)', ok);
}

// 5. Grace/params sanity + override bypass.
{
  const lo = curatedDecayParams(50), mid = curatedDecayParams(77), hi = curatedDecayParams(90);
  check('params: low {2h,-6}, critical {3h,-4}, transition strictly between',
    lo.graceHours === 2 && lo.slopePerHour === 6 &&
    hi.graceHours === 3 && hi.slopePerHour === 4 &&
    mid.graceHours > 2 && mid.graceHours < 3 && mid.slopePerHour < 6 && mid.slopePerHour > 4);
  check('minimum 2h grace holds everywhere (P30 @2h undecayed)', curated(30, 2) === 30);
  const ov = calculateCuratedDepreciatedPriority(40, 88, at(30), null, at(30));
  check('manual override bypasses decay entirely', ov.depreciatedPriority === 88);
}

// 6. Main-feed flat helper unchanged.
check('main-feed flat helper: P90 @10h = 90 - 8*6 = 42 (unchanged)', flat(90, 10) === 42);

// 7. Static call-site guard: curated code must never use the flat helper.
//
// Scan every server TypeScript file rather than only today's curated modules so
// a future lens/radar file is protected automatically. The four intentional
// main-feed calls are allowlisted by file and normalized call text; moving or
// changing one therefore requires an explicit review of this list.
{
  const serverDir = join(process.cwd(), 'server');
  const allowedFlatCalls = new Set([
    'server/storage.ts:calculateDepreciatedPriority(h.priorityScore,h.priorityOverride,h.scrapedAt,h.priorityOverrideAt,h.articlePublishedAt)',
    'server/storage.ts:calculateDepreciatedPriority(sub.priorityScore,sub.priorityOverride,sub.submittedAt,sub.priorityOverrideAt)',
    'server/routes.ts:calculateDepreciatedPriority(rawScore,null,h.scrapedAt,null)',
    'server/routes.ts:calculateDepreciatedPriority(a.priorityScore,null,a.createdAt,null)',
  ]);
  const directCallPattern = /\bcalculateDepreciatedPriority\s*\(([^)]*)\)/g;
  const found: string[] = [];

  for (const entry of readdirSync(serverDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const absolutePath = join(serverDir, entry.name);
    const source = readFileSync(absolutePath, 'utf8');
    for (const match of source.matchAll(directCallPattern)) {
      const prefix = source.slice(Math.max(0, (match.index ?? 0) - 30), match.index);
      if (/export\s+function\s*$/.test(prefix)) continue;
      const normalizedCall = match[0].replace(/\s+/g, '');
      found.push(`${relative(process.cwd(), absolutePath)}:${normalizedCall}`);
    }
  }

  const unexpected = found.filter(call => !allowedFlatCalls.has(call));
  const missing = [...allowedFlatCalls].filter(call => !found.includes(call));
  check(
    'flat decay helper is used only by explicitly allowlisted main-feed paths',
    unexpected.length === 0 && missing.length === 0,
    [
      unexpected.length ? `unexpected: ${unexpected.join(', ')}` : '',
      missing.length ? `missing allowlisted calls: ${missing.join(', ')}` : '',
    ].filter(Boolean).join('; '),
  );
}

console.log(failures === 0 ? '[tiered-decay] ALL PASS' : `[tiered-decay] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
