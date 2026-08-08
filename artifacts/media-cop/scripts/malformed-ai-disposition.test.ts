/**
 * Regression test for Task #720's malformed-AI-reply hardening in the MAIN
 * scorer (server/aiAnalyzer.ts): a genuinely-malformed / unsalvageable AI reply
 * must be LOGGED with a distinct "malformed" marker and must produce the
 * documented disposition at each parse site — never a silent drop and never a
 * fabricated zero score.
 *
 * Sites + documented dispositions:
 *   1. analyzeHeadlineRelevance      — fail-CLOSED: is_relevant=false,
 *      reason "Malformed AI response" (never floods the main feed).
 *   2. analyzeBatchHeadlines (chunk) — caller policy: failOpenUnscored=true →
 *      one unscored placeholder PER TITLE (nothing dropped); default →
 *      fail-closed [] (caller keeps its unscored default).
 *   3. analyzeLinkPriorityWithBody   — fail-OPEN: returns null so the caller
 *      keeps the already-streamed headline-based score.
 *   4. scoreHeadlineChunk (via scoreHeadlinePrioritiesBatch) — fail-OPEN:
 *      the titles are simply MISSING from the score map (never scored 0).
 *
 * The AI transport is stubbed by replacing the mutable method
 * openai.chat.completions.create (the exported `openai` object is a plain
 * object, so the property is assignable) — no network calls are made.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/malformed-ai-disposition.test.ts
 * Exits 0 on pass, 1 on failure.
 */
import { openai } from "../server/aiClient";
import {
  analyzeHeadlineRelevance,
  analyzeBatchHeadlines,
  analyzeLinkPriorityWithBody,
  scoreHeadlinePrioritiesBatch,
  translateCuratedTitlesToEnglish,
} from "../server/aiAnalyzer";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// A reply that is unsalvageable by BOTH parseAiJson and salvageJsonObjectArray:
// no braces, no fenced JSON, nothing to brace-scan.
const GARBAGE = "Sorry, I am unable to comply with that request at this time.";
// Parseable JSON but the WRONG SHAPE for the single-relevance site (missing
// the required boolean is_relevant).
const WRONG_SHAPE = '{"unexpected":"shape","score":"high"}';

function stubReply(content: string) {
  (openai.chat.completions as any).create = async () => ({
    choices: [{ message: { content } }],
  });
}

// Capture console output so we can assert the distinct malformed markers are
// actually emitted (logged, not silently swallowed).
let captured: string[] = [];
const realLog = console.log;
const realErr = console.error;
const realWarn = console.warn;
function startCapture() {
  captured = [];
  const push = (real: (...a: any[]) => void) => (...args: any[]) => {
    captured.push(args.map(String).join(" "));
    real(...args);
  };
  console.log = push(realLog);
  console.error = push(realErr);
  console.warn = push(realWarn);
}
function stopCapture() {
  console.log = realLog;
  console.error = realErr;
  console.warn = realWarn;
}
const logged = (needle: string) => captured.some((l) => l.includes(needle));

async function main() {
  // ---- 1. analyzeHeadlineRelevance: fail-CLOSED -------------------------
  realLog("[malformed-ai] analyzeHeadlineRelevance (fail-closed)");
  {
    stubReply(GARBAGE);
    startCapture();
    const r = await analyzeHeadlineRelevance("Test headline about a strike");
    stopCapture();
    check(
      "unsalvageable reply → is_relevant=false (fail-closed, not thrown)",
      r.is_relevant === false && r.reason === "Malformed AI response",
      JSON.stringify(r),
    );
    check(
      "does not fabricate a promotable score",
      r.priority_score === 1,
      `score=${r.priority_score}`,
    );
    check(
      "distinct malformed marker logged",
      logged("[FUNNEL:AI-MALFORMED]"),
    );

    // Wrong-shape (parseable JSON, missing is_relevant boolean) gets the same
    // disposition — a bad shape must not slip through as "relevant".
    stubReply(WRONG_SHAPE);
    startCapture();
    const r2 = await analyzeHeadlineRelevance("Another test headline");
    stopCapture();
    check(
      "wrong-shape reply → same fail-closed disposition",
      r2.is_relevant === false && r2.reason === "Malformed AI response",
      JSON.stringify(r2),
    );
    check(
      "wrong-shape also logs the malformed marker",
      logged("[FUNNEL:AI-MALFORMED]"),
    );
  }

  // ---- 2. analyzeBatchHeadlines chunk: caller fail-open / fail-closed ----
  realLog("[malformed-ai] analyzeBatchHeadlines chunk");
  const batchTitles = [
    "Carrier group transits strait amid rising tensions",
    "Parliament debates annual agricultural subsidy bill",
    "New missile test reported by state media overnight",
  ];
  {
    // fail-OPEN (scraper path): every title must come back as an unscored
    // placeholder — NOTHING silently dropped.
    stubReply(GARBAGE);
    startCapture();
    const open = await analyzeBatchHeadlines(batchTitles, {
      failOpenUnscored: true,
    });
    stopCapture();
    check(
      "fail-open: one placeholder per title (no silent drop)",
      open.length === batchTitles.length &&
        batchTitles.every((t) => open.some((r) => r.title === t)),
      `got ${open.length}/${batchTitles.length}`,
    );
    check(
      "fail-open placeholders are unscored-style (tagless, 'AI unavailable')",
      open.every(
        (r) =>
          r.is_relevant === true &&
          r.tags.length === 0 &&
          r.reason === "AI unavailable",
      ),
      JSON.stringify(open[0]),
    );
    check(
      "chunk-level malformed marker logged",
      logged("MALFORMED AI response (nothing parseable) in analyzeBatchHeadlines"),
    );

    // fail-CLOSED (default): returns [] so score-reading callers keep their
    // unscored defaults — a malformed payload never fabricates scores.
    stubReply(GARBAGE);
    startCapture();
    const closed = await analyzeBatchHeadlines(batchTitles);
    stopCapture();
    check(
      "fail-closed (default): returns [] (caller keeps unscored default)",
      Array.isArray(closed) && closed.length === 0,
      `got ${closed.length}`,
    );
    check(
      "fail-closed run logs the malformed marker too",
      logged("MALFORMED AI response (nothing parseable) in analyzeBatchHeadlines"),
    );
  }

  // ---- 3. analyzeLinkPriorityWithBody: fail-OPEN (keep headline score) ---
  realLog("[malformed-ai] analyzeLinkPriorityWithBody (fail-open)");
  {
    stubReply(GARBAGE);
    startCapture();
    const r = await analyzeLinkPriorityWithBody(
      "Fleet exercises begin in contested waters",
      "A long-enough article body describing the naval exercise in detail, well past the fifty character minimum required by the helper.",
    );
    stopCapture();
    check(
      "unsalvageable reply → null (caller keeps headline score)",
      r === null,
      JSON.stringify(r),
    );
    check(
      "distinct malformed marker logged (not the API/network path)",
      logged("Malformed AI response (unparseable)"),
    );
    check(
      "API/network error path NOT logged for a parse failure",
      !logged("Error scoring link priority with body (API/network)"),
    );
  }

  // ---- 4. scoreHeadlinePrioritiesBatch: fail-OPEN (missing, never zero) --
  realLog("[malformed-ai] scoreHeadlinePrioritiesBatch (fail-open, missing score)");
  {
    stubReply(GARBAGE);
    startCapture();
    const scores = await scoreHeadlinePrioritiesBatch(batchTitles);
    stopCapture();
    check(
      "malformed reply → NO scores written (titles missing from map)",
      scores.size === 0,
      `size=${scores.size} values=${JSON.stringify([...scores.entries()])}`,
    );
    check(
      "no fabricated zero score",
      batchTitles.every((t) => scores.get(t) === undefined),
    );
    check(
      "chunk-level malformed marker logged",
      logged("MALFORMED AI response (nothing parseable) in scoreHeadlinePrioritiesBatch"),
    );
  }

  // ---- 5. translateCuratedTitlesToEnglish: fail-SAFE (keep originals) -----
  // The curated title-translation site (Task #656) must, on an unsalvageable /
  // empty reply, keep EVERY original source-language title (never blank, never
  // drop, never smear a translation) AND log the distinct malformed marker.
  realLog("[malformed-ai] translateCuratedTitlesToEnglish (fail-safe, keep originals)");
  const foreignTitles = [
    "Cuba denuncia nuevas sanciones de Estados Unidos",
    "Irán advierte sobre escalada en el estrecho de Ormuz",
    "China refuerza su presencia naval en el Pacífico",
  ];
  {
    // Unsalvageable prose reply → nothing parseable → keep all originals.
    stubReply(GARBAGE);
    startCapture();
    const map = await translateCuratedTitlesToEnglish(foreignTitles);
    stopCapture();
    check(
      "unsalvageable reply → empty map (every original preserved)",
      map instanceof Map && map.size === 0,
      `size=${map instanceof Map ? map.size : "not-a-map"}`,
    );
    // Caller contract: effective title = map.get(original) ?? original.
    const effective = foreignTitles.map((t) => map.get(t) ?? t);
    check(
      "every input title comes back unchanged (none blanked, none dropped)",
      effective.length === foreignTitles.length &&
        effective.every((t, i) => t === foreignTitles[i]),
      JSON.stringify(effective),
    );
    check(
      "distinct malformed marker logged (nothing parseable)",
      logged("[CuratedTitleTranslate] MALFORMED AI response (nothing parseable)"),
    );
    check(
      "API/network error path NOT logged for a parse failure",
      !logged("[CuratedTitleTranslate] API/network error during translation"),
    );

    // Empty content → distinct (empty content) marker, same preservation.
    stubReply("");
    startCapture();
    const mapEmpty = await translateCuratedTitlesToEnglish(foreignTitles);
    stopCapture();
    check(
      "empty content → empty map (originals preserved)",
      mapEmpty instanceof Map && mapEmpty.size === 0,
      `size=${mapEmpty instanceof Map ? mapEmpty.size : "not-a-map"}`,
    );
    check(
      "empty content logs the distinct empty-content marker",
      logged("[CuratedTitleTranslate] MALFORMED AI response (empty content)"),
    );
  }

  if (failures > 0) {
    realErr(`\n[malformed-ai] FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  realLog("\n[malformed-ai] All checks passed");
  process.exit(0);
}

main().catch((err) => {
  stopCapture();
  console.error("[malformed-ai] Unexpected error:", err);
  process.exit(1);
});
