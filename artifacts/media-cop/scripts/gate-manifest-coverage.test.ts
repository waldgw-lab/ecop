/**
 * scripts/gate-manifest-coverage.test.ts — meta-gate that prevents the
 * "written-but-unwired safety check" gap from ever recurring.
 *
 * WHY THIS EXISTS
 * ---------------
 * The gate manifest (`GATES` in scripts/run-gates.ts) is the single source of
 * truth for which safety checks actually run in CI. It is trivially easy to
 * write a new `scripts/<name>.test.ts`, verify it locally, and then forget to
 * add it to the manifest — at which point it silently protects nothing. A whole
 * batch of 41 such orphaned checks accumulated once already.
 *
 * This gate closes that hole: it fails (exit 1) if any `scripts/*.test.ts` file
 * on disk is neither referenced by a gate command in run-gates.ts NOR listed on
 * the explicit EXCLUSIONS allow-list below (each with a one-line reason).
 *
 * HOW WIRING IS DETECTED
 * ----------------------
 * A test file counts as "wired" if its path (`scripts/<file>.test.ts`) appears
 * anywhere in a gate's `cmd` string. This is intentionally text-based so it
 * catches every form (direct `npx tsx scripts/x.test.ts`, wrapped in a shell
 * conditional, chained with `&&`, etc.) without importing run-gates.ts (which
 * would execute the whole runner on import).
 *
 * TO INTENTIONALLY EXCLUDE A TEST FILE
 * ------------------------------------
 * Add it to EXCLUSIONS with a concrete one-line reason. Do NOT exclude a check
 * just because it is inconvenient — the whole point is that skipped safety
 * checks must be a deliberate, reviewed decision.
 *
 * Exit 0 = every test file is wired or explicitly excluded. Exit 1 = at least
 * one orphaned test file. Run: npx tsx scripts/gate-manifest-coverage.test.ts
 *
 * It also checks the scheduling allowlist: every approved parallel name must
 * exist exactly once in the manifest, and resource-sensitive markers may not
 * be approved. Gates absent from the allowlist are safely isolated by default.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

/**
 * Test files intentionally NOT wired into the manifest. Key = filename (as it
 * appears in scripts/), value = one-line reason. Keep this empty unless there
 * is a genuine reason a check must not run in CI.
 */
const EXCLUSIONS: Record<string, string> = {
  // (none currently — all scripts/*.test.ts are wired)
};

function main(): void {
  const runGatesSrc = readFileSync(join(scriptsDir, 'run-gates.ts'), 'utf8');

  const testFiles = readdirSync(scriptsDir)
    .filter((f) => f.endsWith('.test.ts'))
    .sort();

  const orphans: string[] = [];
  for (const file of testFiles) {
    if (file in EXCLUSIONS) continue;
    // "wired" = the file's scripts/ path is referenced by some gate cmd.
    const wired = runGatesSrc.includes(`scripts/${file}`);
    if (!wired) orphans.push(file);
  }

  // Guard the allow-list itself: an EXCLUSIONS entry for a file that no longer
  // exists is stale and should be removed so the list stays honest.
  const onDisk = new Set(testFiles);
  const staleExclusions = Object.keys(EXCLUSIONS).filter((f) => !onDisk.has(f));
  const manifestBlock = runGatesSrc.slice(
    runGatesSrc.indexOf('const GATES:'),
    runGatesSrc.indexOf('const PARALLEL_SAFE_GATE_NAMES'),
  );
  const manifestNames = [...manifestBlock.matchAll(/\bname:\s*'([^']+)'/g)].map((m) => m[1]);
  const duplicateNames = [...new Set(manifestNames.filter((name, i) => manifestNames.indexOf(name) !== i))];
  const allowlistMatch = runGatesSrc.match(
    /const PARALLEL_SAFE_GATE_NAMES = new Set<string>\(\[([\s\S]*?)\]\);/,
  );
  const parallelNames = allowlistMatch
    ? [...allowlistMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    : [];
  const manifestSet = new Set(manifestNames);
  const staleParallelNames = parallelNames.filter((name) => !manifestSet.has(name));
  const duplicateParallelNames = [
    ...new Set(parallelNames.filter((name, i) => parallelNames.indexOf(name) !== i)),
  ];
  const gateBlocks = [...manifestBlock.matchAll(/\{\s*name:\s*'([^']+)'([\s\S]*?)\},/g)];
  const resourceSensitiveApproved = gateBlocks
    .filter(([, name, body]) => {
      if (!parallelNames.includes(name)) return false;
      return (
        /slow:\s*true/.test(body) ||
        (/inconclusive3:\s*true/.test(body) &&
          !['curated-megacluster-freshness'].includes(name))
      );
    })
    .map(([, name]) => name);
  const requiredIsolatedInconclusive = [
    'curated-editorial-episode-persistence',
    'curated-editorial-outcome-observation',
    'curated-editorial-evidence-atomicity',
    'curated-manual-link-consolidation-transaction',
  ];
  const badEvidenceGateConfig = requiredIsolatedInconclusive.filter((name) => {
    const block = gateBlocks.find(([, gateName]) => gateName === name);
    return !block || !/inconclusive3:\s*true/.test(block[2]) || parallelNames.includes(name);
  });

  console.log(
    `[gate-manifest-coverage] ${testFiles.length} scripts/*.test.ts files; ` +
      `${Object.keys(EXCLUSIONS).length} excluded; ${orphans.length} orphaned.`,
  );

  if (staleExclusions.length > 0) {
    console.error(
      `\n[FAIL] EXCLUSIONS references file(s) that no longer exist: ${staleExclusions.join(', ')}`,
    );
  }

  if (orphans.length > 0) {
    console.error(
      `\n[FAIL] ${orphans.length} test file(s) are written but NOT wired into the GATES ` +
        `manifest in scripts/run-gates.ts (and not on the EXCLUSIONS allow-list):`,
    );
    for (const o of orphans) console.error(`  - scripts/${o}`);
    console.error(
      `\nFix: add one { name, cmd } entry per file to the GATES array, or add the ` +
        `file to EXCLUSIONS in this test with a one-line reason.`,
    );
  }

  if (orphans.length > 0 || staleExclusions.length > 0) {
    process.exit(1);
  }

  if (!allowlistMatch) console.error('[FAIL] parallel-safe scheduling allowlist was not found.');
  if (duplicateNames.length > 0) console.error(`[FAIL] duplicate gate names: ${duplicateNames.join(', ')}`);
  if (staleParallelNames.length > 0) {
    console.error(`[FAIL] parallel allowlist names missing from manifest: ${staleParallelNames.join(', ')}`);
  }
  if (duplicateParallelNames.length > 0) {
    console.error(`[FAIL] duplicate parallel allowlist names: ${duplicateParallelNames.join(', ')}`);
  }
  if (resourceSensitiveApproved.length > 0) {
    console.error(
      `[FAIL] slow or transient/live gates may not be parallel-approved: ${resourceSensitiveApproved.join(', ')}`,
    );
  }
  if (badEvidenceGateConfig.length > 0) {
    console.error(
      `[FAIL] DB-backed evidence gates must be isolated and inconclusive3-enabled: ${badEvidenceGateConfig.join(', ')}`,
    );
  }
  if (
    !allowlistMatch ||
    duplicateNames.length > 0 ||
    staleParallelNames.length > 0 ||
    duplicateParallelNames.length > 0 ||
    resourceSensitiveApproved.length > 0 ||
    badEvidenceGateConfig.length > 0
  ) {
    process.exit(1);
  }

  console.log(
    `[PASS] every test is wired/excluded; ${manifestNames.length} unique gates classified ` +
      `(${parallelNames.length} parallel-offline, ${manifestNames.length - parallelNames.length} isolated).`,
  );
  process.exit(0);
}

main();
