/**
 * Live AI scoring check for statecraft+escalation headlines (Task #592).
 *
 * Background: Task #590 removed the deterministic floor that GUARANTEED
 * statecraft+escalation stories (a deal/negotiation coupled with a credible
 * threat of force, a named adversary striking/threatening a U.S. ally or U.S.
 * forces, or a threat to a strategic chokepoint) scored at least 65. That
 * behavior now rests ENTIRELY on the AI rubric — the NEW_ANALYZER_SYSTEM_PROMPT
 * "70-84 (HIGH) — STATECRAFT WITH ACTIVE ESCALATION" bullet in
 * server/relevanceDefinition.ts.
 *
 * This is a LIVE check (unlike the deterministic scripts/score-spread.test.ts):
 * it feeds representative headlines matching the three escalation patterns
 * through the SAME live scorers the main feed uses — analyzeBatchHeadlines and
 * scoreHeadlinePrioritiesBatch (server/aiAnalyzer.ts) — and reports how the AI
 * actually scored each one. The goal is to catch SYSTEMATIC under-scoring (the
 * AI quietly demoting these to MODERATE/LOW so they land on the auto-promotion
 * floor) after a prompt or model change, instead of letting it go unnoticed.
 *
 * The user accepted that the AI can OCCASIONALLY under-score one of these, so a
 * single miss is reported but is NOT treated as a hard failure. The check only
 * exits non-zero when under-scoring is SYSTEMATIC (more than a small tolerance
 * of the sample falls below the HIGH band), which is the signal that the rubric
 * itself has drifted.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/statecraft-escalation-scoring.test.ts
 *
 * Requires AI to be configured (OpenRouter or Anthropic). When AI is not
 * configured the check SKIPS (exit 0) rather than failing, so it never blocks a
 * key-less environment. Because it hits the live model, scores vary run to run;
 * read the printed per-headline table to spot drift.
 *
 * EXIT CODE CONVENTION (Task #639, see scripts/harness-reliability.ts):
 *   0 = PASS         — clean run, no systematic under-scoring.
 *   1 = FAIL         — GENUINE systematic under-scoring (>40% of the SCORED
 *                       subset landed below the HIGH band) — the rubric has
 *                       drifted. This is never downgraded by retries.
 *   3 = INCONCLUSIVE — after bounded retries the AI still didn't return a
 *                       usable score for one or more samples (transient
 *                       provider failure / truncation / an ambiguous
 *                       clustering bind). The samples that DID score are still
 *                       judged against the systematic-drift threshold; a
 *                       remaining gap only downgrades to INCONCLUSIVE, never
 *                       silently to PASS.
 */
import { analyzeBatchHeadlines, scoreHeadlinePrioritiesBatch } from "../server/aiAnalyzer";
import { isAIConfigured } from "../server/aiClient";
import { EXIT_INCONCLUSIVE, EXIT_PASS, EXIT_FAIL, HarnessOutcome, combineOutcomes, exitCodeFor, retryToCleanSignal } from "./harness-reliability";

// HIGH band floor per the rubric (70-84 HIGH, 85+ CRITICAL/ALERT). A
// statecraft+escalation story should land at or above this.
const HIGH_BAND_FLOOR = 70;
// MODERATE band floor — anything below this is LOW/NOISE, an outright miss.
const MODERATE_FLOOR = 50;

// How many of the sample may fall below the HIGH band before we call it
// SYSTEMATIC drift. The user accepted occasional under-scoring, so we tolerate a
// small fraction; a larger share means the rubric has regressed.
const SYSTEMATIC_FAIL_FRACTION = 0.4; // >40% below HIGH band => fail

// Representative statecraft+escalation headlines, grouped by the three patterns
// the removed floor used to protect. Each is written to be unambiguous about
// the force/escalation link so the AI has a fair signal to score on.
type Sample = { pattern: string; title: string };

const SAMPLES: Sample[] = [
  // (a) negotiations/deal/talks COMBINED with military action/threat/strikes.
  {
    pattern: "deal+force",
    title: "Iran threatens to close Strait of Hormuz as nuclear talks collapse",
  },
  {
    pattern: "deal+force",
    title: "Trump threatens military strikes if Iran rejects nuclear deal amid Iranian attacks on Gulf bases",
  },
  {
    pattern: "deal+force",
    title: "North Korea fires ballistic missile hours after walking out of denuclearization talks",
  },
  {
    pattern: "deal+force",
    title: "Russia launches fresh strikes on Kyiv as ceasefire negotiations break down",
  },

  // (b) a named adversary attacking/threatening a U.S. ally or U.S. forces.
  {
    pattern: "adversary-vs-ally",
    title: "Iran-backed Houthis strike Israeli port city with ballistic missiles",
  },
  {
    pattern: "adversary-vs-ally",
    title: "China warns it will use force against Taiwan if independence moves continue",
  },
  {
    pattern: "adversary-vs-ally",
    title: "Russian drones strike NATO-member Poland near Ukrainian border",
  },
  {
    pattern: "adversary-vs-ally",
    title: "North Korea threatens nuclear strike on South Korea over joint U.S. drills",
  },

  // (c) a threat or attack against a strategic chokepoint or waterway.
  {
    pattern: "chokepoint",
    title: "Houthis attack oil tanker in the Bab el-Mandeb strait, disrupting Red Sea shipping",
  },
  {
    pattern: "chokepoint",
    title: "Iran seizes commercial vessel near the Strait of Hormuz",
  },
  {
    pattern: "chokepoint",
    title: "China deploys naval flotilla to blockade approaches to the Strait of Malacca",
  },
];

type Scored = Sample & { score: number | null };

// --- Local mirror of the analyzer's headline clustering ---------------------
// analyzeBatchHeadlines (server/aiAnalyzer.ts) clusters near-duplicate headlines
// by keyword Jaccard similarity (threshold 0.25) and only sends the cluster
// REPRESENTATIVE to the model. Task #593 closed the silent-demotion hole this
// created: a statecraft+escalation headline is now NEVER folded into another
// cluster — it is always its own representative and is scored DIRECTLY, so it can
// no longer inherit a weaker neighbor's score. That means each sample below
// should come back scored by its own (exact) title. We still keep a
// similarity fallback as a guard against the model echoing a slightly drifted
// title, but a sample that matches nothing returns null (a real miss).
const CLUSTER_SIMILARITY_THRESHOLD = 0.25;
// The best fuzzy match must beat the runner-up by at least this margin to be
// accepted. If two returned representatives are near-equally similar to an input
// title, we can't trust which one it actually folded into, so we mark it
// UNSCORED (a miss) rather than risk binding the WRONG score and masking drift.
const CLUSTER_AMBIGUITY_MARGIN = 0.05;
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "as", "is", "was", "are", "be", "has", "have", "had",
  "will", "would", "could", "should", "may", "might", "can", "must", "new",
  "says", "say", "after", "over", "more", "than", "into", "through", "up",
  "out", "it", "its",
]);

function keywords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const arrA = Array.from(a);
  const inter = arrA.filter((k) => b.has(k)).length;
  const union = new Set([...arrA, ...Array.from(b)]).size;
  return union === 0 ? 0 : inter / union;
}

// Bind an input title to a score from a returned-title->score map: exact match
// first, then the most-similar returned title above the clustering threshold
// (the representative it would have folded into). To avoid binding the WRONG
// score, the best match must also beat the runner-up by CLUSTER_AMBIGUITY_MARGIN;
// when two representatives are near-equally similar the binding is ambiguous and
// we return null (a real miss) rather than over-credit. Returns null on no match.
function bindScore(inputTitle: string, byTitle: Map<string, number>): number | null {
  if (byTitle.has(inputTitle)) return byTitle.get(inputTitle)!;
  const inKw = keywords(inputTitle);
  let bestScore: number | null = null;
  let bestSim = -1;
  let secondSim = -1;
  for (const [retTitle, score] of byTitle) {
    const sim = jaccard(inKw, keywords(retTitle));
    if (sim > bestSim) {
      secondSim = bestSim;
      bestSim = sim;
      bestScore = score;
    } else if (sim > secondSim) {
      secondSim = sim;
    }
  }
  // Must clear the clustering threshold to be a candidate at all.
  if (bestSim < CLUSTER_SIMILARITY_THRESHOLD) return null;
  // Ambiguous: a runner-up is also above the threshold and within the margin, so
  // we can't tell which representative it folded into. Treat as unscored.
  if (
    secondSim >= CLUSTER_SIMILARITY_THRESHOLD &&
    bestSim - secondSim < CLUSTER_AMBIGUITY_MARGIN
  ) {
    return null;
  }
  return bestScore;
}

function bandOf(score: number | null): string {
  if (score === null) return "UNSCORED";
  if (score >= 85) return "CRITICAL";
  if (score >= HIGH_BAND_FLOOR) return "HIGH";
  if (score >= MODERATE_FLOOR) return "MODERATE";
  return "LOW";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printTable(label: string, rows: Scored[]): void {
  console.log(`\n=== ${label} ===`);
  console.log(`${pad("PATTERN", 18)} ${pad("SCORE", 6)} ${pad("BAND", 9)} TITLE`);
  for (const r of rows) {
    const scoreStr = r.score === null ? "—" : String(r.score);
    console.log(`${pad(r.pattern, 18)} ${pad(scoreStr, 6)} ${pad(bandOf(r.score), 9)} ${r.title}`);
  }
}

// cleanRunAchieved is true when retryToCleanSignal found an attempt where
// EVERY sample scored (no unscored rows). When false, some rows stayed
// unscored despite bounded retries — the systematic-drift signal is still
// judged off the SCORED subset (never silently dropped), but the presence of
// still-unscored rows caps the outcome at INCONCLUSIVE rather than PASS/FAIL,
// since we genuinely don't know which band those rows belong in.
function summarize(label: string, rows: Scored[], cleanRunAchieved: boolean): { outcome: HarnessOutcome } {
  const scored = rows.filter((r) => r.score !== null) as (Scored & { score: number })[];
  const high = scored.filter((r) => r.score >= HIGH_BAND_FLOOR);
  const moderate = scored.filter((r) => r.score >= MODERATE_FLOOR && r.score < HIGH_BAND_FLOOR);
  const low = scored.filter((r) => r.score < MODERATE_FLOOR);
  const unscored = rows.filter((r) => r.score === null);

  // The genuine systematic-drift signal is computed over the SCORED subset
  // only. Unscored rows (after retries) are a separate INCONCLUSIVE signal —
  // mixing them into the denominator would let a transient AI hiccup on 2
  // samples out of 11 masquerade as "40% under-scored" and fail the run for
  // the wrong reason.
  const belowHigh = moderate.length + low.length;
  const denom = scored.length;
  const belowFraction = denom === 0 ? 0 : belowHigh / denom;

  console.log(`\n--- ${label} summary ---`);
  console.log(
    `scored=${scored.length}/${rows.length}  HIGH(70+)=${high.length}  ` +
      `MODERATE(50-69)=${moderate.length}  LOW(<50)=${low.length}  unscored=${unscored.length}` +
      (cleanRunAchieved ? "" : "  (best-of-retries attempt — did not reach a fully-scored run)"),
  );

  // Per-headline flags so a reviewer can see exactly which story drifted.
  for (const r of moderate) {
    console.log(`  UNDER-SCORED (MODERATE) [${r.pattern}] score=${r.score}: ${r.title}`);
  }
  for (const r of low) {
    console.log(`  UNDER-SCORED (LOW) [${r.pattern}] score=${r.score}: ${r.title}`);
  }
  for (const r of unscored) {
    console.log(`  NOT SCORED after retries (transient AI failure / truncation / ambiguous bind) [${r.pattern}]: ${r.title}`);
  }

  // INCONCLUSIVE: nothing came back scored at all even after bounded retries.
  // This used to be a hard FAIL, but an AI outage/rate-limit storm across every
  // retry is transient noise, not proof the rubric regressed.
  if (scored.length === 0) {
    console.log(
      `  RESULT: INCONCLUSIVE — no usable scores returned for any of ${denom || rows.length} samples ` +
        `after retries (AI outage, parser miss, or empty batch). Cannot confirm HIGH-band ranking either way.`,
    );
    return { outcome: "INCONCLUSIVE" };
  }

  // A run that never came fully clean can't support a hard FAIL verdict: the
  // scored subset may be small/skewed by whichever rows happened to survive
  // the transient AI trouble, so a "systematic drift" reading off it isn't
  // trustworthy either way. Cap at INCONCLUSIVE and ask for a re-run instead
  // of laundering AI flakiness into a false rubric-regression FAIL.
  if (!cleanRunAchieved || unscored.length > 0) {
    console.log(
      `  RESULT: INCONCLUSIVE — ${unscored.length}/${rows.length} samples still didn't return a usable ` +
        `score after retries, so the scored subset (${denom}/${rows.length}) isn't a reliable basis for a ` +
        `PASS/FAIL verdict. Re-run to confirm.`,
    );
    return { outcome: "INCONCLUSIVE" };
  }

  // Genuine systematic drift is still a hard FAIL — but only once we know
  // every sample scored (cleanRunAchieved === true), so this signal isn't
  // computed off a partial/skewed subset.
  const systematic = belowFraction > SYSTEMATIC_FAIL_FRACTION;
  if (systematic) {
    console.log(
      `  RESULT: FAIL — ${belowHigh}/${denom} (${Math.round(belowFraction * 100)}%) of ` +
        `SCORED statecraft+escalation samples were NOT confirmed in the HIGH band, ` +
        `exceeding the ${Math.round(SYSTEMATIC_FAIL_FRACTION * 100)}% systematic-drift tolerance.`,
    );
    return { outcome: "FAIL" };
  }

  if (belowHigh > 0) {
    console.log(
      `  RESULT: PASS (with notes) — ${belowHigh}/${denom} not confirmed in the HIGH band, ` +
        `within the accepted occasional-miss tolerance.`,
    );
  } else {
    console.log(`  RESULT: PASS — all ${denom} samples landed in the HIGH band (70+).`);
  }
  return { outcome: "PASS" };
}

async function main(): Promise<void> {
  if (!isAIConfigured()) {
    console.log(
      "SKIP: no AI provider configured (OpenRouter/Anthropic). " +
        "This live check requires AI access; skipping without failure.",
    );
    return;
  }

  const titles = SAMPLES.map((s) => s.title);
  const outcomes: HarnessOutcome[] = [];

  // "Clean" for retry purposes means every sample in the sample set came back
  // with a usable score — that is the signal a transient AI hiccup (429,
  // truncated batch, empty reply) is gone and the run is worth judging as-is.
  const allScored = (rows: Scored[]) => rows.every((r) => r.score !== null);
  // When no attempt is fully clean, keep the BEST one (most rows scored) so a
  // partial-success retry isn't thrown away in favor of a total-failure one.
  const scoreOf = (rows: Scored[]) => rows.filter((r) => r.score !== null).length;

  // Path 1: analyzeBatchHeadlines — the main scraper's analyzer. It clusters
  // near-duplicate headlines and only scores the representative, BUT since
  // Task #593 a statecraft+escalation headline is never folded — each is its own
  // representative and is scored DIRECTLY. So every sample below should come back
  // with its own score; the similarity fallback in bindScore only covers a
  // drifted title echo. Retries absorb transient AI failures/truncation before
  // judging — genuine under-scoring on a clean run is never masked.
  try {
    const { result: rows, cleanRunAchieved } = await retryToCleanSignal<Scored[]>(
      async () => {
        const results = await analyzeBatchHeadlines(titles);
        const byTitle = new Map<string, number>();
        for (const r of results) {
          if (typeof r.priority_score === "number") byTitle.set(r.title, r.priority_score);
        }
        return SAMPLES.map((s) => ({ ...s, score: bindScore(s.title, byTitle) }));
      },
      { label: "analyzeBatchHeadlines", isClean: allScored, score: scoreOf },
    );
    printTable("analyzeBatchHeadlines (main scraper analyzer)", rows);
    const { outcome } = summarize("analyzeBatchHeadlines", rows, cleanRunAchieved);
    outcomes.push(outcome);
  } catch (err) {
    console.error("analyzeBatchHeadlines threw:", err);
    outcomes.push("FAIL");
  }

  // Path 2: scoreHeadlinePrioritiesBatch — the news-bot / RSS-bot scoring path
  // that drives the main-feed promotion gate. This one returns a per-title
  // score map directly.
  try {
    const { result: rows, cleanRunAchieved } = await retryToCleanSignal<Scored[]>(
      async () => {
        const scoreMap = await scoreHeadlinePrioritiesBatch(titles);
        return SAMPLES.map((s) => ({ ...s, score: scoreMap.has(s.title) ? scoreMap.get(s.title)! : null }));
      },
      { label: "scoreHeadlinePrioritiesBatch", isClean: allScored, score: scoreOf },
    );
    printTable("scoreHeadlinePrioritiesBatch (bot/RSS scoring path)", rows);
    const { outcome } = summarize("scoreHeadlinePrioritiesBatch", rows, cleanRunAchieved);
    outcomes.push(outcome);
  } catch (err) {
    console.error("scoreHeadlinePrioritiesBatch threw:", err);
    outcomes.push("FAIL");
  }

  const finalOutcome = combineOutcomes(outcomes);

  if (finalOutcome === "INCONCLUSIVE") {
    console.warn(
      "\nINCONCLUSIVE — could not reach a fully clean AI run after retries, and the " +
        "samples that DID score are within the systematic-drift tolerance. Re-run to confirm.",
    );
    process.exit(EXIT_INCONCLUSIVE);
  }

  if (finalOutcome === "FAIL") {
    console.error(
      "\nSYSTEMATIC under-scoring detected — the AI rubric no longer reliably " +
        "ranks statecraft+escalation stories in the HIGH band. Review the " +
        "NEW_ANALYZER_SYSTEM_PROMPT HIGH (70-84) statecraft bullet in " +
        "server/relevanceDefinition.ts.",
    );
    process.exit(EXIT_FAIL);
  }
  console.log("\nOK — statecraft+escalation scoring is within tolerance.");
  process.exit(EXIT_PASS);
}

main().catch((err) => {
  console.error("Unexpected error running the statecraft+escalation check:", err);
  process.exit(EXIT_FAIL);
});
