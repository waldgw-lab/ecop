/**
 * Live-model contract for the shared local/incremental conflict calibration.
 *
 * Runs the same compact comparison through both visible-Curated scoring
 * provenances: the main analyzer (whose score is retained when mirrored) and
 * the Curated-only gate analyzer. Isolated misses are tolerated; systematic
 * high-band crowding or protected-strategic demotion fails. Missing model rows
 * after bounded retries are INCONCLUSIVE, never mislabeled as scoring drift.
 *
 * Exit codes follow scripts/harness-reliability.ts:
 *   0 PASS, 1 genuine scoring drift, 3 provider/result failure (re-run).
 */
import { analyzeBatchHeadlines, analyzeCuratedBatch } from "../server/aiAnalyzer";
import { isAIConfigured } from "../server/aiClient";
import {
  EXIT_FAIL,
  EXIT_INCONCLUSIVE,
  EXIT_PASS,
  type HarnessOutcome,
  combineOutcomes,
  retryToCleanSignal,
} from "./harness-reliability";

const HIGH_BAND_FLOOR = 70;
const SYSTEMATIC_FRACTION = 0.4;
const MIN_MEDIAN_GAP = 10;

type Lane = "local/incremental" | "protected strategic";
type Sample = { signal: string; lane: Lane; title: string };
type Scored = Sample & { score: number | null };

const SAMPLES: Sample[] = [
  {
    lane: "local/incremental",
    signal: "routine continuation",
    title: "Provincial officials reopen two roads after another night of unchanged low-intensity border fighting",
  },
  {
    lane: "local/incremental",
    signal: "domestic reaction",
    title: "City council again debates a symbolic ceasefire resolution as the overseas war continues",
  },
  {
    lane: "local/incremental",
    signal: "local disruption",
    title: "Local schools remain closed for a third day amid routine shelling with no reported change in operations",
  },
  {
    lane: "local/incremental",
    signal: "incremental update",
    title: "Regional officials report minor overnight damage as the same front line remains unchanged",
  },
  {
    lane: "local/incremental",
    signal: "routine politics",
    title: "Municipal lawmakers renew calls for peace during weekly meeting on the long-running conflict",
  },
  {
    lane: "protected strategic",
    signal: "U.S.-Iran diplomacy",
    title: "United States and Iran sign nuclear verification accord paired with immediate sanctions relief",
  },
  {
    lane: "protected strategic",
    signal: "force posture",
    title: "Pentagon deploys additional destroyers and air-defense batteries after threats to allied bases",
  },
  {
    lane: "protected strategic",
    signal: "cross-border escalation",
    title: "Drones cross an international border and strike an allied military base, opening a new front",
  },
  {
    lane: "protected strategic",
    signal: "major civilian harm",
    title: "Airstrike on crowded refugee camp kills 180 civilians and overwhelms regional hospitals",
  },
  {
    lane: "protected strategic",
    signal: "strategic infrastructure",
    title: "Cyberattack disables a national power grid and emergency communications across the country",
  },
  {
    lane: "protected strategic",
    signal: "chokepoint escalation",
    title: "Naval blockade begins at a strategic maritime chokepoint, halting allied oil shipments",
  },
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function scoreRows(rows: Array<{ title: string; priority_score: number }>): Scored[] {
  const byTitle = new Map(
    rows
      .filter((row) => typeof row.priority_score === "number")
      .map((row) => [row.title, row.priority_score]),
  );
  return SAMPLES.map((sample) => ({
    ...sample,
    score: byTitle.get(sample.title) ?? null,
  }));
}

function printRows(label: string, rows: Scored[]): void {
  console.log(`\n=== ${label} ===`);
  for (const row of rows) {
    console.log(
      `${row.lane.padEnd(20)} ${row.signal.padEnd(24)} ${String(row.score ?? "—").padStart(3)}  ${row.title}`,
    );
  }
}

function judge(label: string, rows: Scored[], cleanRunAchieved: boolean): HarnessOutcome {
  const unscored = rows.filter((row) => row.score === null);
  if (!cleanRunAchieved || unscored.length > 0) {
    console.warn(
      `${label}: INCONCLUSIVE — ${unscored.length}/${rows.length} samples remained unscored after retries; ` +
        "provider/truncation failures are not scoring drift.",
    );
    return "INCONCLUSIVE";
  }

  const local = rows.filter((row) => row.lane === "local/incremental") as Array<Scored & { score: number }>;
  const strategic = rows.filter((row) => row.lane === "protected strategic") as Array<Scored & { score: number }>;
  const localHigh = local.filter((row) => row.score >= HIGH_BAND_FLOOR);
  const strategicBelowHigh = strategic.filter((row) => row.score < HIGH_BAND_FLOOR);
  const localHighFraction = localHigh.length / local.length;
  const strategicLowFraction = strategicBelowHigh.length / strategic.length;
  const localMedian = median(local.map((row) => row.score));
  const strategicMedian = median(strategic.map((row) => row.score));
  const medianGap = strategicMedian - localMedian;

  for (const row of localHigh) {
    console.log(`  LOCAL HIGH [${row.signal}] score=${row.score}: ${row.title}`);
  }
  for (const row of strategicBelowHigh) {
    console.log(`  PROTECTED BELOW HIGH [${row.signal}] score=${row.score}: ${row.title}`);
  }
  console.log(
    `${label}: localHigh=${localHigh.length}/${local.length}, ` +
      `protectedBelowHigh=${strategicBelowHigh.length}/${strategic.length}, ` +
      `medians=${localMedian}/${strategicMedian} (gap ${medianGap})`,
  );

  const systematicLocalCrowding = localHighFraction > SYSTEMATIC_FRACTION;
  const systematicStrategicDemotion = strategicLowFraction > SYSTEMATIC_FRACTION;
  const failedSeparation = medianGap < MIN_MEDIAN_GAP;
  if (systematicLocalCrowding || systematicStrategicDemotion || failedSeparation) {
    console.error(
      `${label}: FAIL — systematic scoring drift (` +
        `local crowding=${systematicLocalCrowding}, strategic demotion=${systematicStrategicDemotion}, ` +
        `median separation below ${MIN_MEDIAN_GAP}=${failedSeparation}).`,
    );
    return "FAIL";
  }

  console.log(`${label}: PASS — isolated variance, if any, remains within tolerance.`);
  return "PASS";
}

async function runLane(
  label: string,
  attempt: () => Promise<Scored[]>,
): Promise<HarnessOutcome> {
  try {
    const { result, cleanRunAchieved } = await retryToCleanSignal(attempt, {
      label,
      isClean: (rows) => rows.every((row) => row.score !== null),
      score: (rows) => rows.filter((row) => row.score !== null).length,
    });
    printRows(label, result);
    return judge(label, result, cleanRunAchieved);
  } catch (error) {
    console.warn(`${label}: INCONCLUSIVE — live provider call threw after retries:`, error);
    return "INCONCLUSIVE";
  }
}

async function main(): Promise<void> {
  if (!isAIConfigured()) {
    console.log("SKIP: no AI provider configured; live scoring contract not run.");
    process.exit(EXIT_PASS);
  }

  const titles = SAMPLES.map((sample) => sample.title);
  // Keep live-AI calls sequential: the two production lanes are independent,
  // but overlapping them would manufacture provider pressure and false
  // INCONCLUSIVE results in the very harness meant to distinguish that noise.
  const outcomes: HarnessOutcome[] = [];
  outcomes.push(
    await runLane("main analyzer", async () => scoreRows(await analyzeBatchHeadlines(titles))),
  );
  outcomes.push(
    await runLane("Curated analyzer", async () => scoreRows(await analyzeCuratedBatch(titles))),
  );
  const finalOutcome = combineOutcomes(outcomes);

  if (finalOutcome === "FAIL") {
    console.error("\nFAIL — local/incremental conflict calibration showed systematic scoring drift.");
    process.exit(EXIT_FAIL);
  }
  if (finalOutcome === "INCONCLUSIVE") {
    console.warn("\nINCONCLUSIVE — re-run after provider/result failures clear.");
    process.exit(EXIT_INCONCLUSIVE);
  }
  console.log("\nOK — local/incremental updates remain separated from protected strategic developments.");
  process.exit(EXIT_PASS);
}

main().catch((error) => {
  console.error("Unexpected local-conflict scoring harness error:", error);
  process.exit(EXIT_INCONCLUSIVE);
});