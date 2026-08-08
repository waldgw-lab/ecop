/**
 * Regression test for the main-feed score-spreading helpers (Task #444, locked
 * by Task #526).
 *
 * Two pure helpers shape every main-feed priority score and were previously
 * exercised only indirectly:
 *
 *   - resolveAiScore (server/scoreAdjustments.ts) replaced the old `score || 50`
 *     collapse. `|| 50` folded BOTH a real 0 AND a missing/non-number into 50,
 *     inflating the 50 bucket. The new helper distinguishes the two: a finite
 *     number is clamped into [1,100] (so a genuine 0 floors to 1, NOT treated as
 *     missing), while only a truly absent/non-numeric value falls back to the
 *     explicit default.
 *
 *   - declumpScores (server/aiAnalyzer.ts) spreads a tie of equal scores evenly
 *     downward across a bounded window so the priority cut isn't arbitrary. It
 *     only ever LOWERS the lower-ranked members (the top keeps the shared score),
 *     stays floored at 1, is deterministic (stable title hash), and only touches
 *     relevant rows.
 *
 * Also covers evalMainScoreCaps (the NOAA main-lane downgrade): cap-only, capped
 * at 40, and only when "noaa" is present.
 *
 * These assertions lock the behavior so a future tweak can't silently
 * re-introduce `|| 50`, break the tie-spread window/floor, or flatten the
 * ranking again.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/score-spread.test.ts
 * Exits non-zero on any failure.
 */
import { resolveAiScore, evalMainScoreCaps, NOAA_MAIN_CAP } from "../server/scoreAdjustments";
import { declumpScores } from "../server/aiAnalyzer";

let pass = 0;
const failures: string[] = [];

function check(label: string, got: unknown, expected: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`PASS [${label}]`);
  } else {
    const msg = `FAIL [${label}] got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`;
    failures.push(msg);
    console.log(msg);
  }
}

// ---------------------------------------------------------------------------
// resolveAiScore
// ---------------------------------------------------------------------------

// A genuine 0 must floor to 1 — NOT be treated as missing (the old `|| 50` bug).
check("resolveAiScore: real 0 floors to 1 (not the default)", resolveAiScore(0, 50), 1);

// A negative number is a real number — clamp up to the floor of 1.
check("resolveAiScore: negative clamps to 1", resolveAiScore(-25, 50), 1);

// A missing value (undefined) passes through to the explicit default.
check("resolveAiScore: undefined falls back to default", resolveAiScore(undefined, 50), 50);

// A null value is non-numeric — falls back to the default.
check("resolveAiScore: null falls back to default", resolveAiScore(null, 50), 50);

// A non-number (string) falls back to the default, never coerced.
check('resolveAiScore: numeric string "0" falls back to default', resolveAiScore("0", 50), 50);

// NaN is not finite — falls back to the default.
check("resolveAiScore: NaN falls back to default", resolveAiScore(NaN, 50), 50);

// Infinity is not finite — falls back to the default.
check("resolveAiScore: Infinity falls back to default", resolveAiScore(Infinity, 50), 50);

// A value above 100 clamps down to 100.
check("resolveAiScore: clamps above 100 down to 100", resolveAiScore(140, 50), 100);

// A normal in-range value passes through, rounded.
check("resolveAiScore: rounds an in-range float", resolveAiScore(72.6, 50), 73);

// The fallback itself is honored (different default is respected).
check("resolveAiScore: honors a non-50 fallback", resolveAiScore(undefined, 1), 1);

// ---------------------------------------------------------------------------
// declumpScores
// ---------------------------------------------------------------------------

type Row = { title: string; is_relevant: boolean; priority_score: number };

// A tie of relevant rows: the top member keeps the shared score, the rest are
// spread strictly downward, deterministically, never below the floor.
{
  const rows: Row[] = [
    { title: "alpha story", is_relevant: true, priority_score: 80 },
    { title: "bravo story", is_relevant: true, priority_score: 80 },
    { title: "charlie story", is_relevant: true, priority_score: 80 },
    { title: "delta story", is_relevant: true, priority_score: 80 },
  ];
  declumpScores(rows);
  const scores = rows.map((r) => r.priority_score);

  // Exactly one member keeps the original top score, never raised above it.
  const top = Math.max(...scores);
  check("declumpScores: never raises above the tie score", top, 80);
  check("declumpScores: exactly one member keeps the top score", scores.filter((s) => s === 80).length, 1);

  // The tie is now spread (more than one distinct value).
  check("declumpScores: tie is spread into distinct scores", new Set(scores).size > 1, true);

  // Nothing dips below the floor (score - window, window = min(n-1, 12)).
  const floor = 80 - Math.min(rows.length - 1, 12);
  check("declumpScores: never crosses below the floor", Math.min(...scores) >= floor, true);
  check("declumpScores: lowest member sits exactly on the floor", Math.min(...scores), floor);
}

// Determinism: same input ordering produces the same spread every time.
{
  const make = (): Row[] => [
    { title: "one", is_relevant: true, priority_score: 60 },
    { title: "two", is_relevant: true, priority_score: 60 },
    { title: "three", is_relevant: true, priority_score: 60 },
  ];
  const a = make();
  const b = make();
  declumpScores(a);
  declumpScores(b);
  check(
    "declumpScores: deterministic across runs",
    a.map((r) => r.priority_score),
    b.map((r) => r.priority_score),
  );
}

// Irrelevant rows are ignored entirely (never touched, never counted in a tie).
{
  const rows: Row[] = [
    { title: "kept-a", is_relevant: true, priority_score: 70 },
    { title: "dropped", is_relevant: false, priority_score: 70 },
    { title: "kept-b", is_relevant: true, priority_score: 70 },
  ];
  declumpScores(rows);
  const irrelevant = rows.find((r) => !r.is_relevant)!;
  check("declumpScores: leaves irrelevant rows untouched", irrelevant.priority_score, 70);
  // The two relevant rows form the tie: one keeps 70, the other drops.
  const relevantScores = rows.filter((r) => r.is_relevant).map((r) => r.priority_score);
  check("declumpScores: relevant tie still spreads with an irrelevant row present", new Set(relevantScores).size, 2);
}

// A lone score (no tie) is left exactly as-is.
{
  const rows: Row[] = [
    { title: "solo", is_relevant: true, priority_score: 55 },
    { title: "other", is_relevant: true, priority_score: 90 },
  ];
  declumpScores(rows);
  check("declumpScores: a non-tied score is untouched", rows.map((r) => r.priority_score).sort((a, b) => a - b), [55, 90]);
}

// A large tie never re-clumps at the floor: the window caps at 12, and the
// spread floors at 1, so even 30 tied rows keep more than one distinct value
// and never go below 1.
{
  const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
    title: `bulk-${i}`,
    is_relevant: true,
    priority_score: 8,
  }));
  declumpScores(rows);
  const scores = rows.map((r) => r.priority_score);
  check("declumpScores: large tie never drops below 1", Math.min(...scores) >= 1, true);
  check("declumpScores: large tie keeps the top score", Math.max(...scores), 8);
  check("declumpScores: large tie still spreads (not all identical)", new Set(scores).size > 1, true);
}

// ---------------------------------------------------------------------------
// evalMainScoreCaps (NOAA main-lane downgrade)
// ---------------------------------------------------------------------------

// An over-cap NOAA item is capped to 40 with the reason recorded.
check(
  "evalMainScoreCaps: NOAA over-cap is capped to 40",
  evalMainScoreCaps("NOAA issues hurricane warning", 88),
  { score: NOAA_MAIN_CAP, reason: "noaa" },
);

// Cap-only: a NOAA item already at/below the cap is untouched (never raised).
check(
  "evalMainScoreCaps: NOAA already below cap is untouched",
  evalMainScoreCaps("NOAA weather update", 25),
  { score: 25, reason: null },
);

// A non-NOAA headline is never capped, even at a high score.
check(
  "evalMainScoreCaps: non-NOAA headline is never capped",
  evalMainScoreCaps("Russia launches missile strike on Kyiv", 88),
  { score: 88, reason: null },
);

// Case-insensitive match on "noaa".
check(
  "evalMainScoreCaps: matches NOAA case-insensitively",
  evalMainScoreCaps("noaa satellite goes dark", 95),
  { score: NOAA_MAIN_CAP, reason: "noaa" },
);

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
