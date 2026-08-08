#!/usr/bin/env node
// =============================================================================
// Unresolved-reference scan for server/ code.
//
// The server runs via `tsx` with NO compile-time typecheck, so a symbol that is
// USED but never IMPORTED/DEFINED does not fail at boot — it only throws a
// runtime `ReferenceError` the moment that specific code path executes. When the
// line sits inside a try/catch (as most endpoint handlers do), the failure is
// swallowed and the feature just looks vaguely "broken" to users while the boot
// logs stay clean. (This is exactly how the AI tuning brief endpoint silently
// failed: withAiTimeout / createPreferOpenRouter / AI_CALL_TIMEOUT_MS /
// AI_CALL_BACKSTOP_MS were referenced but never imported.)
//
// This scan runs the TypeScript compiler and reports ONLY the error codes that
// correspond to that real ReferenceError class, restricted to server/ files:
//   TS2304  "Cannot find name 'X'"        -> undefined / unimported symbol
//   TS2552  "Cannot find name 'X'. Did    -> typo'd / unimported symbol
//            you mean 'Y'?"
//
// Per the repo's "tsc triage on tsx server" note, all other TS codes (TS2802,
// TS2322, TS2339, TS2345, ...) are type-only noise that tsx/esbuild strip and
// run fine, so they are intentionally NOT treated as failures here.
//
// INCREMENTAL CACHE
// -----------------
// Uses tsconfig.server-refs.json (extends the main tsconfig) which writes its
// own tsBuildInfoFile to node_modules/.cache/server-refs.tsbuildinfo — a
// dedicated path that won't collide with the Vite build or other tsc invocations.
// This means a warm second run is markedly faster than the cold ~43s first run.
// =============================================================================

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// Ensure the cache directory exists before tsc tries to write into it.
mkdirSync(resolve(projectRoot, "node_modules/.cache"), { recursive: true });

const REAL_REF_CODES = ["TS2304", "TS2552"];
const codeAlternation = REAL_REF_CODES.join("|");
// Matches lines like: server/routes.ts(3766,12): error TS2304: Cannot find name 'withAiTimeout'.
const lineRe = new RegExp(`^server/.*error (?:${codeAlternation}):`);

const result = spawnSync(
  "npx",
  ["tsc", "--project", "tsconfig.server-refs.json"],
  {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: projectRoot,
  },
);

const output = `${result.stdout || ""}${result.stderr || ""}`;
const offenders = output
  .split("\n")
  .filter((line) => lineRe.test(line));

if (offenders.length > 0) {
  console.error(
    `\n✖ Unresolved reference(s) found in server/ (${offenders.length}).`,
  );
  console.error(
    "These symbols are USED but never imported/defined. Under tsx they throw a",
  );
  console.error(
    "runtime ReferenceError only when the code path runs, so fix them now:\n",
  );
  for (const line of offenders) console.error(`  ${line}`);
  console.error(
    "\nIf a name is legitimately global, add its type; otherwise import or define it.",
  );
  process.exit(1);
}

console.log(
  "✓ No unresolved references (TS2304/TS2552) in server/ — no silent-ReferenceError wiring bugs.",
);
process.exit(0);
