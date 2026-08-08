/**
 * Contract test for the read-only "Scoring & Relevance" oversight surface
 * (Task #622), hardened during the comprehensive review that added
 * position-derived band tones.
 *
 * The whole point of this surface is to be LIVE-DERIVED: a republish that
 * changes a threshold, prompt toggle, or band ladder must update the Source
 * Oversight tab automatically, with no second place to edit. These assertions
 * lock that invariant so a future refactor can't let the oversight payload
 * silently drift from the real constants/prompts:
 *
 *   - getScoringRelevanceOverview().priorityBands mirrors ACTIVE_PRIORITY_BANDS
 *     (which itself tracks USE_LEGACY_ANALYZER_PROMPT), and every band carries a
 *     valid severity tone derived by ladder POSITION (not a numeric cutoff — the
 *     new ladder's Critical band starts at 85, not 90).
 *   - activeRubric + relevanceGate.activeRubric agree with each other.
 *   - The numeric gates surfaced by the endpoint keep the documented ordering:
 *     UNSCORED_BOT_PRIORITY < MAIN_FEED_PROMOTION_THRESHOLD < FLASH_PRIORITY_THRESHOLD,
 *     so a missing/unscored item can never auto-promote or hit FLASH on the
 *     default alone; CURATED_SOFT_CAP stays below the promotion bar.
 *   - The maintained changelog is well-formed.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/scoring-relevance-overview.test.ts
 *   USE_LEGACY_ANALYZER_PROMPT=1 npx tsx scripts/scoring-relevance-overview.test.ts
 * Exits non-zero on any failure.
 */
import {
  getScoringRelevanceOverview,
  ACTIVE_PRIORITY_BANDS,
  PRIORITY_BAND_TONES,
  MAIN_FEED_PROMOTION_THRESHOLD,
  UNSCORED_BOT_PRIORITY,
  ANALYZER_SYSTEM_PROMPT,
  CURATED_ANALYZER_SYSTEM_PROMPT,
  LOCAL_CONFLICT_IMPORTANCE_CALIBRATION,
} from "../server/relevanceDefinition";
import {
  getStrategicContextSnapshot,
  getCurrentContextBlock,
  __clearStrategicContextCacheForTest,
} from "../server/strategicContext";
import { FLASH_PRIORITY_THRESHOLD } from "../server/subjectMatcher";
import { CURATED_SOFT_CAP } from "../server/scoreAdjustments";

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

function ok(label: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`PASS [${label}]`);
  } else {
    const msg = `FAIL [${label}] condition was false`;
    failures.push(msg);
    console.log(msg);
  }
}

// ---------------------------------------------------------------------------
const overview = getScoringRelevanceOverview();

// The surfaced band ranges/labels must be byte-identical to the live-active
// ladder (ACTIVE_PRIORITY_BANDS), never a hand-copied duplicate.
check(
  "priorityBands mirror ACTIVE_PRIORITY_BANDS (min/max/label)",
  overview.priorityBands.map((b) => ({ min: b.min, max: b.max, label: b.label })),
  ACTIVE_PRIORITY_BANDS.map((b) => ({ min: b.min, max: b.max, label: b.label })),
);

// Every band carries a valid tone, and tones follow ladder POSITION (most
// severe first) — this is what lets the client color bands without hard-coding
// numeric cutoffs that would drift when a boundary moves.
overview.priorityBands.forEach((b, i) => {
  const expectedTone = PRIORITY_BAND_TONES[Math.min(i, PRIORITY_BAND_TONES.length - 1)];
  check(`band[${i}] tone is position-derived (${b.label})`, b.tone, expectedTone);
});

// Bands must be ordered strictly most-severe -> least-severe (descending min),
// which is the precondition for position-based tone coloring being correct.
ok(
  "priorityBands are ordered descending by min",
  overview.priorityBands.every((b, i) => i === 0 || overview.priorityBands[i - 1].min > b.min),
);

// activeRubric on the overview and inside relevanceGate must agree.
ok(
  "activeRubric agrees between overview and relevanceGate",
  (overview.activeRubric === "legacy") === /legacy/i.test(overview.relevanceGate.activeRubric),
);

// The relevance summary must be non-empty prose.
ok("relevanceGate.summary is non-empty", overview.relevanceGate.summary.trim().length > 20);

// Numeric-gate ordering the /api/team/scoring-relevance endpoint surfaces. These
// relationships are the actual safety invariants of the promotion funnel.
ok(
  "UNSCORED_BOT_PRIORITY is below the main-feed promotion bar",
  UNSCORED_BOT_PRIORITY < MAIN_FEED_PROMOTION_THRESHOLD,
);
ok(
  "UNSCORED_BOT_PRIORITY is below the FLASH bar",
  UNSCORED_BOT_PRIORITY < FLASH_PRIORITY_THRESHOLD,
);
ok(
  "main-feed promotion bar is at or below the FLASH bar",
  MAIN_FEED_PROMOTION_THRESHOLD <= FLASH_PRIORITY_THRESHOLD,
);
ok(
  "curated soft-politics cap is below the main-feed promotion bar",
  CURATED_SOFT_CAP < MAIN_FEED_PROMOTION_THRESHOLD,
);

// The maintained changelog must be present and well-formed.
ok("changelog has at least one entry", overview.changelog.length > 0);
overview.changelog.forEach((entry, i) => {
  ok(
    `changelog[${i}] has date/rule/change/reason`,
    /^\d{4}-\d{2}-\d{2}$/.test(entry.date) &&
      entry.rule.trim().length > 0 &&
      entry.change.trim().length > 0 &&
      entry.reason.trim().length > 0,
  );
});

// ---------------------------------------------------------------------------
// Task #1093 — band/prompt DRIFT CHECK: ACTIVE_PRIORITY_BANDS is a hand-kept
// mirror of the band ladder inside the live analyzer prompt. When the new
// rubric is active, every band's "min-max (" range header must literally
// appear in ANALYZER_SYSTEM_PROMPT, so a prompt edit that moves a boundary
// without updating the mirror (or vice versa) fails loudly here.
if (overview.activeRubric === "new") {
  for (const b of ACTIVE_PRIORITY_BANDS) {
    ok(
      `prompt contains band range ${b.min}-${b.max} (${b.label})`,
      ANALYZER_SYSTEM_PROMPT.includes(`${b.min}-${b.max} (`),
    );
  }
}

// Prompt-only local/incremental conflict calibration must stay byte-identical
// across intake provenance AND survive the supported main-rubric toggle. Run
// this file in both default and USE_LEGACY_ANALYZER_PROMPT=1 modes. This is
// intentionally a wording contract: no deterministic cap, threshold, quota,
// classifier, ranking rule, or override path is introduced here.
check(
  "main analyzer carries the shared local-conflict calibration once",
  ANALYZER_SYSTEM_PROMPT.split(LOCAL_CONFLICT_IMPORTANCE_CALIBRATION).length - 1,
  1,
);
check(
  "Curated analyzer carries the shared local-conflict calibration once",
  CURATED_ANALYZER_SYSTEM_PROMPT.split(LOCAL_CONFLICT_IMPORTANCE_CALIBRATION).length - 1,
  1,
);
ok(
  "shared calibration protects consequence/novelty and forbids source/geography penalties",
  [
    "direct U.S. or allied consequence",
    "cross-border escalation",
    "force-posture change",
    "concrete diplomatic or sanctions action",
    "strategic-infrastructure impact",
    "major civilian harm",
    "genuinely new conflict phase",
    "never by country, publisher, outlet geography, or outlet role",
  ].every((phrase) => LOCAL_CONFLICT_IMPORTANCE_CALIBRATION.includes(phrase)),
);

// Task #1093 — CURRENT CONTEXT block invariants (dynamic prompt suffix).
async function checkStrategicContext(): Promise<void> {
  const savedDisabled = process.env.ANALYZER_CONTEXT_DISABLED;
  const savedNote = process.env.ANALYZER_CONTEXT_NOTE;
  try {
    // Kill switch: block must be '' so the analyzer prompt reverts byte-identical.
    process.env.ANALYZER_CONTEXT_DISABLED = "1";
    __clearStrategicContextCacheForTest();
    const disabledBlock = await getCurrentContextBlock();
    check("kill switch yields empty context block", disabledBlock, "");

    // Enabled: snapshot never throws, always carries today's date; manual note
    // (safety valve) must appear in the block when set.
    delete process.env.ANALYZER_CONTEXT_DISABLED;
    process.env.ANALYZER_CONTEXT_NOTE = "GATE-CHECK NOTE";
    __clearStrategicContextCacheForTest();
    const snap = await getStrategicContextSnapshot();
    ok("context snapshot has TODAY'S DATE line", snap.dateLine.startsWith("TODAY'S DATE:"));
    ok(
      "context block includes the date line",
      snap.block.includes("TODAY'S DATE:") && snap.block.includes("CURRENT CONTEXT"),
    );
    ok("context source is auto or date-only when enabled", snap.source === "auto" || snap.source === "date-only");
    ok("manual admin note appears in the block", snap.block.includes("GATE-CHECK NOTE"));
    if (snap.source === "auto") {
      ok("auto context derived at least one theme or headline", snap.themes.length > 0 || snap.topHeadlines.length > 0);
    }
  } finally {
    if (savedDisabled === undefined) delete process.env.ANALYZER_CONTEXT_DISABLED;
    else process.env.ANALYZER_CONTEXT_DISABLED = savedDisabled;
    if (savedNote === undefined) delete process.env.ANALYZER_CONTEXT_NOTE;
    else process.env.ANALYZER_CONTEXT_NOTE = savedNote;
    __clearStrategicContextCacheForTest();
  }
}

// ---------------------------------------------------------------------------
// Task #1093 follow-through — live score-spread aggregate invariants. The
// Scoring tab's histogram is the automated replacement for the manual
// post-publish band audit, so it must never lie: exactly the 10 tens-bands,
// non-negative counts that sum to totalScored, bounded/sorted topValues, and
// the surface wired fail-soft into the endpoint + rendered by the client
// (source contract, same spirit as the LIVE-DERIVED ladder checks above).
async function checkScoreSpread(): Promise<void> {
  const { storage } = await import("../server/storage");
  const spread = await storage.getMainScoreSpread(7);
  check(
    "score spread has exactly the 10 tens-bands",
    spread.bands.map((b) => b.min),
    [0, 10, 20, 30, 40, 50, 60, 70, 80, 90],
  );
  ok("score spread last band tops out at 100 (90–100 folded)", spread.bands[9].max === 100);
  ok("score spread counts are non-negative", spread.bands.every((b) => b.count >= 0));
  ok(
    "score spread band counts sum to totalScored",
    spread.bands.reduce((s, b) => s + b.count, 0) === spread.totalScored,
  );
  ok(
    "score spread topValues sorted desc by count and bounded to 6",
    spread.topValues.length <= 6 &&
      spread.topValues.every((v, i, a) => i === 0 || a[i - 1].count >= v.count),
  );
  ok(
    "score spread topValues shares are sane percentages",
    spread.topValues.every((v) => v.sharePct >= 0 && v.sharePct <= 100),
  );
  ok("score spread generatedAt parses as a date", Number.isFinite(Date.parse(spread.generatedAt)));

  // Semantic scope check (architect finding): the spread must count ONLY the
  // news funnel's AI-assigned rows — sourceType='news', scoreSource 'ai' (or
  // legacy null). Recompute the population independently and compare with a
  // small tolerance (live bots insert/age-out rows between the two queries;
  // anything beyond ±5 means the impl's filters drifted — e.g. the 65
  // social_media AI rows observed when this check was written).
  const { db } = await import("../server/db");
  const { sql: rawSql } = await import("drizzle-orm");
  const indepRes: any = await db.execute(rawSql`
    SELECT count(*)::int AS n FROM team_submissions
    WHERE created_at >= now() - interval '7 days'
      AND priority_score IS NOT NULL
      AND source_type = 'news'
      AND (score_source = 'ai' OR score_source IS NULL)
  `);
  const indepN = Number((indepRes.rows ?? indepRes)[0]?.n ?? NaN);
  ok(
    `score spread totalScored matches independent news/ai population (spread=${spread.totalScored} sql=${indepN})`,
    Number.isFinite(indepN) && Math.abs(spread.totalScored - indepN) <= 5,
  );
  const storageSrc = (await import("node:fs")).readFileSync("server/storage.ts", "utf8");
  ok(
    "storage: score spread scoped to the news funnel",
    storageSrc.includes("eq(teamSubmissions.sourceType, 'news')"),
  );

  // Source contract: the endpoint must surface the spread FAIL-SOFT (an
  // aggregate error may omit the section, never break the tab), and the
  // client must actually render it.
  const fs = await import("node:fs");
  const routesSrc = fs.readFileSync("server/routes.ts", "utf8");
  ok(
    "routes: scoring-relevance surfaces scoreDistribution fail-soft",
    routesSrc.includes("scoreDistribution = await storage.getMainScoreSpread") &&
      routesSrc.includes("score-spread lookup failed (omitting)"),
  );
  const clientSrc = fs.readFileSync("client/src/components/OutletOversightDialog.tsx", "utf8");
  ok(
    "client: Scoring tab renders the score-spread section",
    clientSrc.includes("section-score-distribution") &&
      clientSrc.includes("scoreDistribution"),
  );
}

checkStrategicContext()
  .catch((e) => {
    failures.push(`FAIL [strategic context checks threw] ${e?.message || e}`);
  })
  .then(() => checkScoreSpread())
  .catch((e) => {
    failures.push(`FAIL [score-spread checks threw] ${e?.message || e}`);
  })
  .finally(() => {
    console.log(`\n${pass} passed`);
    if (failures.length) {
      console.error(`\n${failures.length} failure(s).`);
      process.exit(1);
    }
    process.exit(0);
  });
