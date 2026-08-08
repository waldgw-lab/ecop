// Tests for buildClusteringBodySnippet (Task #617) and the clustering-prompt
// guardrail that keeps the new body snippet a SUBORDINATE signal.
//
// Task #617 appends a short body snippet (" -- <snippet>") to each numbered
// clustering-prompt line so the grouping LLM can recognize two divergently-
// worded headlines that describe the SAME underlying event (the headline often
// omits the distinctive subject — a ship/operation/person — that the body
// names). The follow-up regression guard (#620) that would have fed live AI
// fixtures was cancelled; live-AI fixtures are flaky and costly, so instead we
// cover the three things that CAN be checked deterministically:
//   1. buildClusteringBodySnippet's contract: bullet-preferred, summary
//      fallback, null when un-enriched, whitespace collapse, bounded length.
//   2. formatClusteringPromptLine's runtime behavior: it appends the snippet
//      after " -- " for enriched nodes and stays title-only for un-enriched
//      ones (a behavior assertion on the emitted line, not a source grep).
//   3. The clustering prompt still carries the separation-rule guardrail
//      language that subordinates the snippet — so a future edit can't silently
//      drop the "supporting context only / never overrides" contract.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { buildClusteringBodySnippet, formatClusteringPromptLine } from "../server/curatedCluster";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}

function eq(name: string, got: unknown, want: unknown) {
  check(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, got === want);
}

// --- bullet preferred over summary -------------------------------------------
eq(
  "first bullet preferred over summary",
  buildClusteringBodySnippet({ bullets: ["USS Juneau sank during Valiant Shield"], summary: "A summary line" }),
  "USS Juneau sank during Valiant Shield",
);

// --- first NON-EMPTY bullet chosen (skips blank/whitespace bullets) -----------
eq(
  "skips empty/whitespace bullets to first real one",
  buildClusteringBodySnippet({ bullets: ["", "   ", "Real distinctive fact"], summary: "ignored" }),
  "Real distinctive fact",
);

// --- summary fallback when bullets is null -----------------------------------
eq(
  "summary fallback when bullets null",
  buildClusteringBodySnippet({ bullets: null, summary: "Body names the operation" }),
  "Body names the operation",
);

// --- summary fallback when every bullet is blank -----------------------------
eq(
  "summary fallback when all bullets blank",
  buildClusteringBodySnippet({ bullets: ["", "  "], summary: "Fallback summary" }),
  "Fallback summary",
);

// --- null when un-enriched (preserves prior title-only behavior) -------------
eq("null when both null", buildClusteringBodySnippet({ bullets: null, summary: null }), null);
eq("null when bullets empty array + null summary", buildClusteringBodySnippet({ bullets: [], summary: null }), null);
eq(
  "null when everything blank/whitespace",
  buildClusteringBodySnippet({ bullets: ["", "   "], summary: "   " }),
  null,
);

// --- whitespace collapse (newlines / tabs / runs -> single space) ------------
eq(
  "collapses internal whitespace",
  buildClusteringBodySnippet({ bullets: ["Line one\n\tindented   spaced\nLine two"], summary: null }),
  "Line one indented spaced Line two",
);

// --- length cap: <=140 untouched, >140 truncated with ellipsis ---------------
const at140 = "x".repeat(140);
eq("exactly 140 chars not truncated", buildClusteringBodySnippet({ bullets: [at140], summary: null }), at140);

const over = "y".repeat(200);
const snip = buildClusteringBodySnippet({ bullets: [over], summary: null });
check("over-140 truncated to <=143 chars (140 + '...')", !!snip && snip.length <= 143);
check("over-140 ends with ellipsis", !!snip && snip.endsWith("..."));
check("over-140 keeps a bounded prefix of the source", !!snip && snip.startsWith("y".repeat(140)));

// --- a realistic long bullet: truncated, ellipsized, bounded -----------------
const longBullet =
  "The destroyer USS Juneau was reported sunk during the Valiant Shield exercise in the western Pacific, prompting an immediate Navy review of the incident and its causes amid heightened tensions.";
const longSnip = buildClusteringBodySnippet({ bullets: [longBullet], summary: null });
check("realistic long bullet is bounded", !!longSnip && longSnip.length <= 143);
check("realistic long bullet ellipsized", !!longSnip && longSnip.endsWith("..."));
check(
  "realistic long bullet preserves the distinctive subject near the front",
  !!longSnip && longSnip.includes("USS Juneau"),
);

// --- RUNTIME: formatClusteringPromptLine appends the snippet behaviorally -----
const NOW = Date.UTC(2026, 5, 30, 12, 0, 0); // fixed clock for deterministic age
const baseNode = {
  title: "Mystery vessel goes down in Pacific drill",
  source: "Defense News",
  publishedAt: new Date(NOW - 4 * 3_600_000), // 4h ago
  bullets: ["USS Juneau sank during the Valiant Shield exercise"],
  summary: null,
};
const enrichedLine = formatClusteringPromptLine(baseNode, 0, NOW);
check("enriched line is numbered and quotes the title", enrichedLine.startsWith('1. "Mystery vessel goes down in Pacific drill"'));
check("enriched line carries source + relative age", enrichedLine.includes("(Defense News, 4h ago)"));
check("enriched line appends the snippet after ' -- '", enrichedLine.includes(" -- USS Juneau sank during the Valiant Shield exercise"));

// Un-enriched node stays title-only (no trailing ' -- '), preserving prior behavior.
const bareLine = formatClusteringPromptLine(
  { title: "Quiet attach-only item", source: "Wire", publishedAt: new Date(NOW - 3_600_000), bullets: null, summary: null },
  4,
  NOW,
);
check("un-enriched line is title-only (no ' -- ' separator)", !bareLine.includes(" -- "));
check("un-enriched line still numbered + timed", bareLine === '5. "Quiet attach-only item" (Wire, 1h ago)');

// Missing timestamp degrades to 'time unknown', still no crash.
const noTimeLine = formatClusteringPromptLine(
  { title: "No date", source: "X", publishedAt: null, bullets: ["fact"], summary: null },
  0,
  NOW,
);
check("missing publishedAt -> 'time unknown'", noTimeLine === '1. "No date" (X, time unknown) -- fact');

// --- GUARDRAIL: the clustering prompt still subordinates the snippet ----------
// Read the source so a future edit that deletes the guardrail paragraph or the
// separation-rule references fails this deterministic check (no LLM needed).
const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../server/curatedCluster.ts"), "utf8");

check(
  "prompt declares the snippet is supporting context only",
  src.includes("supporting context only"),
);
check(
  "prompt states the snippet never overrides the separation rules",
  src.includes("never overrides the separation rules"),
);
// The separation rules the snippet must not override must still exist above it.
check("separation rule: counter-strike still present", /counter-strike/i.test(src));
check("separation rule: scheduled-event phases still present", /scheduled-event/i.test(src) || /SCHEDULED EVENT PHASES/.test(src));
check("separation rule: large time gap still present", /large time gap/i.test(src));
check(
  "prompt still tells the LLM some items are title-only",
  src.includes("title only") || src.includes("no snippet"),
);

console.log(`\nbuild-clustering-body-snippet: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
