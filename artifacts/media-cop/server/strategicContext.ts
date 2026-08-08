// =============================================================================
// CURRENT STRATEGIC CONTEXT for the main-feed analyzer (Task #1093)
// =============================================================================
// The analyzer rubric (ANALYZER_SYSTEM_PROMPT) is a frozen string with no sense
// of "now": the model doesn't know today's date or which conflicts are actually
// active, so during a live war it keeps scoring active-strike headlines with
// peacetime caution (the production audit found strikes on U.S. bases clumped
// at 88 while the 95-100 Strategic Alert band sat empty). This module builds a
// small, dynamic CURRENT CONTEXT block that aiAnalyzer appends to the system
// prompt at call time:
//
//   1. TODAY'S DATE — always present (pure computation, can never fail).
//   2. CURRENT STRATEGIC PICTURE — auto-derived from the live feed itself
//      (dominant strategic tags + top-scored headlines over the last 48h of
//      already-scored reporting). No AI call: deterministic aggregation only.
//   3. COMMANDER'S NOTE — optional manual safety valve via the
//      ANALYZER_CONTEXT_NOTE env var; absent = silently omitted.
//
// Failure policy: FAIL-OPEN TO DATE-ONLY. A DB error, empty feed, or cold
// start degrades to the date line alone — scoring never blocks or throws
// because of this block. Kill switch: ANALYZER_CONTEXT_DISABLED=1 returns ''
// so callers append nothing and behavior reverts to the pre-Task-#1093 prompt.
//
// The block is CALIBRATION context, not steering: it explicitly tells the
// model that ongoing themes are the baseline (routine continuation of a known
// conflict must NOT drift upward merely for being about the conflict) while
// genuinely NEW escalation against U.S. forces belongs in the top bands. This
// keeps it consistent with the rubric's ACTIVE-CONFLICT RULE rather than
// fighting it. Curated-lane scoring (CURATED_ANALYZER_SYSTEM_PROMPT) is
// deliberately untouched — out of scope per the task.
// =============================================================================

import { sql } from "drizzle-orm";
import { db } from "./db";

const CONTEXT_TTL_MS = 30 * 60 * 1000; // refresh at most every 30 minutes
const LOOKBACK_HOURS = 48;
const HIGH_SCORE_FLOOR = 70; // themes are derived from already-vetted HIGH+ items
const MAX_THEMES = 5;
const MAX_TOP_TITLES = 3;

export interface StrategicContextSnapshot {
  enabled: boolean;
  dateLine: string;
  // 'auto' = full auto-derived picture; 'date-only' = degraded (empty feed or
  // DB error); 'disabled' = kill switch active (block is '').
  source: "auto" | "date-only" | "disabled";
  themes: Array<{ tag: string; count: number }>;
  topHeadlines: Array<{ title: string; score: number }>;
  adminNote: string | null;
  block: string;
  generatedAt: string;
}

let cache: { snapshot: StrategicContextSnapshot; expiresAt: number } | null = null;
let inFlight: Promise<StrategicContextSnapshot> | null = null;

function contextDisabled(): boolean {
  const v = process.env.ANALYZER_CONTEXT_DISABLED;
  return v === "1" || v === "true";
}

function adminNote(): string | null {
  const note = (process.env.ANALYZER_CONTEXT_NOTE || "").trim();
  return note.length > 0 ? note : null;
}

function todayLine(now: Date): string {
  const formatted = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
  return `TODAY'S DATE: ${formatted}. Treat the headlines below as CURRENT, real events happening now — do not assume the strategic situation matches your training data. Any example scenarios in the rubric above are ILLUSTRATIVE PATTERNS, not descriptions of the present situation; this context block reflects what is actually happening.`;
}

function assembleBlock(
  dateLine: string,
  themes: Array<{ tag: string; count: number }>,
  topHeadlines: Array<{ title: string; score: number }>,
  note: string | null,
): string {
  const parts: string[] = ["=== CURRENT CONTEXT (auto-generated at analysis time) ===", dateLine];
  if (themes.length > 0) {
    const themeList = themes.map((t) => `${t.tag} (${t.count} recent high-priority items)`).join("; ");
    parts.push(
      `CURRENT STRATEGIC PICTURE — dominant themes in vetted high-priority reporting over the last ${LOOKBACK_HOURS} hours: ${themeList}.`,
    );
  }
  if (topHeadlines.length > 0) {
    parts.push(
      `Highest-priority recent reporting: ${topHeadlines.map((h) => `"${h.title}"`).join(" · ")}.`,
    );
  }
  if (themes.length > 0 || topHeadlines.length > 0) {
    parts.push(
      `HOW TO USE THIS: these ongoing themes are the current BASELINE. Routine continuation coverage of an already-active conflict theme (day-N wrap-ups, background fighting with no new development) stays MODERATE per the ACTIVE-CONFLICT RULE. But when a headline reports a genuinely NEW development inside an ACTIVE conflict involving U.S. forces or allies — new strikes, new fronts, attacks on U.S. bases or interceptor/stockpile strain — score it with WARTIME consequence: such items belong at 85+, and truly major new combat developments belong in 95-100. Do not apply peacetime caution to an active war shown above.`,
    );
  }
  if (note) {
    parts.push(`COMMANDER'S NOTE (manually set by an administrator; treat as authoritative current context): ${note}`);
  }
  return parts.join("\n");
}

function dateOnlySnapshot(now: Date, note: string | null): StrategicContextSnapshot {
  const dateLine = todayLine(now);
  return {
    enabled: true,
    dateLine,
    source: "date-only",
    themes: [],
    topHeadlines: [],
    adminNote: note,
    block: assembleBlock(dateLine, [], [], note),
    generatedAt: now.toISOString(),
  };
}

async function buildSnapshot(): Promise<StrategicContextSnapshot> {
  const now = new Date();
  const note = adminNote();
  if (contextDisabled()) {
    return {
      enabled: false,
      dateLine: todayLine(now),
      source: "disabled",
      themes: [],
      topHeadlines: [],
      adminNote: note,
      block: "",
      generatedAt: now.toISOString(),
    };
  }
  try {
    // Deterministic aggregation over ALREADY-SCORED main-feed reporting (both
    // main scoring paths): dominant tags + top titles among HIGH+ items in the
    // lookback window. Human overrides are respected via COALESCE so an editor
    // down-pin removes an item from the picture.
    const themesRes = await db.execute(sql`
      SELECT tag, count(*)::int AS count FROM (
        SELECT unnest(tags) AS tag FROM headlines
          WHERE scraped_at > now() - interval '${sql.raw(String(LOOKBACK_HOURS))} hours'
            AND COALESCE(priority_override, priority_score) >= ${HIGH_SCORE_FLOOR}
        UNION ALL
        SELECT unnest(tags) AS tag FROM manual_submissions
          WHERE submitted_at > now() - interval '${sql.raw(String(LOOKBACK_HOURS))} hours'
            AND COALESCE(priority_override, priority_score) >= ${HIGH_SCORE_FLOOR}
      ) t
      WHERE tag IS NOT NULL AND length(trim(tag)) > 0
      GROUP BY tag ORDER BY count DESC, tag ASC LIMIT ${MAX_THEMES}
    `);
    const topRes = await db.execute(sql`
      SELECT title, score FROM (
        SELECT title, COALESCE(priority_override, priority_score) AS score, scraped_at AS ts
          FROM headlines
          WHERE scraped_at > now() - interval '${sql.raw(String(LOOKBACK_HOURS))} hours'
            AND COALESCE(priority_override, priority_score) >= ${HIGH_SCORE_FLOOR}
        UNION ALL
        SELECT title, COALESCE(priority_override, priority_score) AS score, submitted_at AS ts
          FROM manual_submissions
          WHERE submitted_at > now() - interval '${sql.raw(String(LOOKBACK_HOURS))} hours'
            AND COALESCE(priority_override, priority_score) >= ${HIGH_SCORE_FLOOR}
      ) t ORDER BY score DESC, ts DESC LIMIT ${MAX_TOP_TITLES}
    `);
    const themes = (themesRes.rows as Array<{ tag: string; count: number }>).map((r) => ({
      tag: String(r.tag),
      count: Number(r.count),
    }));
    const topHeadlines = (topRes.rows as Array<{ title: string; score: number }>).map((r) => ({
      title: String(r.title).slice(0, 160),
      score: Number(r.score),
    }));
    if (themes.length === 0 && topHeadlines.length === 0) {
      return dateOnlySnapshot(now, note);
    }
    const dateLine = todayLine(now);
    return {
      enabled: true,
      dateLine,
      source: "auto",
      themes,
      topHeadlines,
      adminNote: note,
      block: assembleBlock(dateLine, themes, topHeadlines, note),
      generatedAt: now.toISOString(),
    };
  } catch (e: any) {
    console.warn("[StrategicContext] auto-derivation failed — degrading to date-only:", e?.message || e);
    return dateOnlySnapshot(now, note);
  }
}

/**
 * The current-context snapshot (cached ~30 min, single-flight). Never throws.
 */
export async function getStrategicContextSnapshot(): Promise<StrategicContextSnapshot> {
  const nowMs = Date.now();
  if (cache && cache.expiresAt > nowMs) return cache.snapshot;
  if (inFlight) return inFlight;
  inFlight = buildSnapshot()
    .then((snapshot) => {
      cache = { snapshot, expiresAt: Date.now() + CONTEXT_TTL_MS };
      return snapshot;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * The prompt-ready CURRENT CONTEXT block. '' when the kill switch is active
 * (callers append nothing). Never throws — worst case is a date-only block.
 */
export async function getCurrentContextBlock(): Promise<string> {
  const snap = await getStrategicContextSnapshot();
  return snap.block;
}

/** Test hook: clear the cache so gates can exercise fresh builds. */
export function __clearStrategicContextCacheForTest(): void {
  cache = null;
  inFlight = null;
}
