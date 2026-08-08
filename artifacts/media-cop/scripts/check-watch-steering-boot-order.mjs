#!/usr/bin/env node
// =============================================================================
// Boot-order guard for Watch Topic steering restore.
//
// restoreWatchTopicSteering() rehydrates the persisted Priority/BOLO steering
// flag from the DB into memory. For steering to resume on the VERY FIRST scrape
// cycle after a redeploy, that restore MUST be AWAITED before the cron scheduler
// (startScheduledScraping) kicks off. If a refactor drops the await or moves the
// restore call after the scheduler start, the first ingest passes would silently
// run with steering OFF even though the DB says ON — the exact class of bug the
// relay-heartbeat restore ordering had (.agents/memory/relay-heartbeat-persistence.md).
//
// The watch-steering-persistence gate proves the persist/restore round-trip, but
// NOT this boot-sequence ordering. This static check does.
//
// It asserts, structurally, that in server/index.ts:
//   1. restoreWatchTopicSteering is referenced (still wired into boot at all),
//   2. it sits inside an `await Promise.all([ ... ])` block, AND
//   3. that awaited block closes BEFORE the startScheduledScraping() call.
//
// Exit 0 = ordering safe. Exit 1 = regression (restore not awaited before scheduler).
// =============================================================================

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const bootFile = resolve(projectRoot, "server/index.ts");

function fail(msg) {
  console.error(`\n✖ Watch Topic steering boot-order regression:\n  ${msg}\n`);
  console.error(
    "  restoreWatchTopicSteering() must be AWAITED before startScheduledScraping(),\n" +
    "  or the first scrape cycle after every redeploy runs with steering silently OFF.\n" +
    "  See .agents/memory/watch-topic-steering.md and relay-heartbeat-persistence.md.",
  );
  process.exit(1);
}

let src;
try {
  src = readFileSync(bootFile, "utf8");
} catch (err) {
  fail(`could not read server/index.ts (${err.message})`);
}

const restoreIdx = src.indexOf("restoreWatchTopicSteering(");
if (restoreIdx === -1) {
  fail(
    "restoreWatchTopicSteering(...) is no longer called in server/index.ts — " +
    "the persisted steering flag will never be restored at boot.",
  );
}

const schedulerIdx = src.indexOf("startScheduledScraping(");
if (schedulerIdx === -1) {
  fail(
    "startScheduledScraping(...) not found in server/index.ts — cannot verify " +
    "the restore happens before the scheduler starts (boot structure changed).",
  );
}

// Locate every `await Promise.all([` block and find its matching `]` by bracket
// depth. The restore must live inside one whose closing bracket precedes the
// scheduler start — that is precisely "awaited before the scheduler".
const awaitAllRe = /await\s+Promise\.all\s*\(\s*\[/g;
let enclosingBlockClosesBeforeScheduler = false;
let restoreIsInsideAnAwaitedAllBlock = false;

let m;
while ((m = awaitAllRe.exec(src)) !== null) {
  const openBracketIdx = src.indexOf("[", m.index);
  if (openBracketIdx === -1) continue;

  // Walk forward to find the matching close bracket for this array literal.
  let depth = 0;
  let closeIdx = -1;
  for (let i = openBracketIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) continue;

  if (restoreIdx > openBracketIdx && restoreIdx < closeIdx) {
    restoreIsInsideAnAwaitedAllBlock = true;
    if (closeIdx < schedulerIdx) {
      enclosingBlockClosesBeforeScheduler = true;
    }
  }
}

if (!restoreIsInsideAnAwaitedAllBlock) {
  // Fall back to a simpler ordering assertion: even outside a Promise.all, the
  // restore must at least be textually before the scheduler AND preceded by an
  // `await` on its own statement. If it's fire-and-forget, that's the bug.
  fail(
    "restoreWatchTopicSteering() is not inside an `await Promise.all([...])` boot " +
    "block. If it was moved out, ensure it is still explicitly awaited before " +
    "startScheduledScraping() (a bare fire-and-forget call reintroduces the bug).",
  );
}

if (!enclosingBlockClosesBeforeScheduler) {
  fail(
    "the `await Promise.all([...])` block containing restoreWatchTopicSteering() " +
    "does NOT close before startScheduledScraping() — the scheduler can start " +
    "before steering is restored.",
  );
}

console.log(
  "✓ restoreWatchTopicSteering() is awaited (inside await Promise.all[...]) before " +
  "startScheduledScraping() — steering is restored before the first scrape cycle.",
);
process.exit(0);
