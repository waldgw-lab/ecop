/**
 * Regression test for the Curated "Configure Layout" board guardrails
 * (follow-ups #505 / #506).
 *
 * The image-heavy social feeds (POTUS Truth Social, U.S. X, OSINT X, Press X)
 * are barred from the NARROW three-column LEFT column (l1/l2) — they'd be
 * unreadable there. But in 2-section page mode l1/l2 roll into the WIDE left
 * pane, so an editor SHOULD be able to place those feeds in l1/l2 there.
 *
 * This locks both halves of that mode-aware rule so a future tweak can't:
 *   - let a social feed leak into the cramped 3-column left column, or
 *   - re-block editors from using the wide 2-section left pane for them.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-layout-guardrail.test.ts
 * Exits non-zero on any failure.
 */
import {
  normalizeBoard,
  allowedSlotsFor,
  clampLanesToMode,
  type BoardLayout,
  type BoardSlotId,
  type BoardSectionKey,
  type PageMode,
} from "../client/src/components/curatedBoardLayout";

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ok  - ${label}`);
  } else {
    failures++;
    console.error(`FAIL  - ${label}`);
  }
}

// Does any lane of `slot` contain `key`?
function slotHas(
  layout: BoardLayout,
  slot: BoardSlotId,
  key: BoardSectionKey,
): boolean {
  return (layout.lanes[slot] ?? []).some((lane) => lane.includes(key));
}

// A saved board that (illegally for 3-col) parks social feeds in l1/l2 — the
// exact shape produced if an editor arranged them in 2-section mode. `truth`
// sits in l1, `osint` in l2; both are removed from their r1 home so we can
// prove the clamp re-homes them rather than just leaving the duplicates.
function seededRaw(pageMode: PageMode) {
  return {
    pageMode,
    leftCols: 2,
    cols: {},
    lanes: {
      header: [["ticker", "searchBar", "mcopBot"]],
      l1: [["mcopHighlights", "ieHighlights", "truth"]],
      l2: [["aerial", "firstAlert", "osint"]],
      m1: [["topStories"]],
      r1: [["secwar"], ["press"]],
      r2: [["customFeed", "stateNarratives"]],
      tray: [[]],
    },
  };
}

// -- allowedSlotsFor: the mode-aware rule itself ------------------------------
console.log("allowedSlotsFor (mode-aware allowed slots):");
for (const key of ["truth", "secwar", "osint", "press"] as BoardSectionKey[]) {
  const three = allowedSlotsFor(key, "three");
  const two = allowedSlotsFor(key, "two");
  check(`${key}: barred from l1/l2 in three-col`, !three.includes("l1") && !three.includes("l2"));
  check(`${key}: allowed in l1/l2 in two-col`, two.includes("l1") && two.includes("l2"));
  check(`${key}: r1/r2 stay legal in both modes`, three.includes("r1") && two.includes("r1") && three.includes("r2"));
}
// Non-social sections are unaffected by page mode.
check(
  "aerial: l1/l2 allowed in BOTH modes (unchanged)",
  allowedSlotsFor("aerial", "three").includes("l1") &&
    allowedSlotsFor("aerial", "two").includes("l1"),
);
check(
  "topStories: locked to m1 in both modes",
  JSON.stringify(allowedSlotsFor("topStories", "three")) === JSON.stringify(["m1"]) &&
    JSON.stringify(allowedSlotsFor("topStories", "two")) === JSON.stringify(["m1"]),
);

// -- normalizeBoard: three-col clamps social feeds OUT of l1/l2 ---------------
console.log("normalizeBoard (three-column page mode):");
{
  const layout = normalizeBoard(seededRaw("three"));
  check("truth clamped out of l1", !slotHas(layout, "l1", "truth"));
  check("osint clamped out of l2", !slotHas(layout, "l2", "osint"));
  check("truth re-homed to r1", slotHas(layout, "r1", "truth"));
  check("osint re-homed to r1", slotHas(layout, "r1", "osint"));
  // Non-social l1/l2 panels are untouched by the clamp.
  check("aerial stays in l2", slotHas(layout, "l2", "aerial"));
  check("mcopHighlights stays in l1", slotHas(layout, "l1", "mcopHighlights"));
}

// -- normalizeBoard: two-col KEEPS social feeds in l1/l2 ----------------------
console.log("normalizeBoard (two-section page mode):");
{
  const layout = normalizeBoard(seededRaw("two"));
  check("truth allowed to stay in l1", slotHas(layout, "l1", "truth"));
  check("osint allowed to stay in l2", slotHas(layout, "l2", "osint"));
  // It must NOT also be duplicated into r1 (seen-dedup keeps the l1/l2 copy).
  check("truth not duplicated into r1", !slotHas(layout, "r1", "truth"));
  check("osint not duplicated into r1", !slotHas(layout, "r1", "osint"));
}

// -- clampLanesToMode: a two-col layout re-clamps when switching to three -----
// Mirrors what setPageMode does on a mode switch: a feed legally placed in
// l1/l2 in two-col mode must be pulled back to its home when going to three.
console.log("clampLanesToMode (two-col -> three-col mode switch):");
{
  const two = normalizeBoard(seededRaw("two"));
  // sanity: it really is in l1/l2 first
  check("precondition: truth in l1 (two-col)", slotHas(two, "l1", "truth"));
  clampLanesToMode(two.lanes, "three");
  check("after switch: truth pulled out of l1", !slotHas(two, "l1", "truth"));
  check("after switch: osint pulled out of l2", !slotHas(two, "l2", "osint"));
  check("after switch: truth re-homed to r1", slotHas(two, "r1", "truth"));
  check("after switch: osint re-homed to r1", slotHas(two, "r1", "osint"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll curated layout guardrail checks passed.");
