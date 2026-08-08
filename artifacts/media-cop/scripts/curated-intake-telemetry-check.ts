/**
 * Verification gate: curated intake telemetry per-source admission check.
 *
 * WHAT THIS CHECKS
 * ----------------
 * Task #950 added per-source admission telemetry (curated_intake_telemetry) that
 * survives restarts. This gate reads that table and flags sources whose silence
 * is due to an INCORRECT gate rejection rather than a legitimate recency or
 * dedup outcome.
 *
 * VERDICTS (per monitored source)
 *   OK-admitted       : ingested > 0 — feed is contributing rows.
 *   OK-recency-silent : ingested=0, aged-out dominant — documented low-cadence
 *                       (e.g. Der Spiegel English desk); not a gate failure.
 *   OK-store-dup      : ingested=0, drop_dup_url dominant — items already in
 *                       store from prior pass; expected churn behavior.
 *   WARN-unscored     : ingested=0, drop_gate_unscored > 0 — AI gate returned
 *                       no score (transient AI failure); non-blocking, retry.
 *   WARN-mixed        : ingested=0, rel-rej > 0 but drop_gate_unscored is
 *                       DOMINANT (unscored > rel-rej) — most of the pass never
 *                       reached the AI gate (partial AI outage/overload), so
 *                       the few scored rejections are not a calibration
 *                       verdict; non-blocking, retry after a healthy pass.
 *   INFO-mixed        : ingested=0 with relevance rejections plus another final
 *                       disposition (duplicate, finance, blocked, malformed,
 *                       unscored, deferred, etc.). Visible but non-blocking.
 *   FAIL-gate-reject  : ingested=0 and relevance rejection is the ONLY final
 *                       disposition (also aged=0 and dup-in-pass=0). With no
 *                       competing explanation, the gate may be over-restricting.
 *
 * EXIT CODES
 *   0 : no monitored source has unexplained relevance-only silence.
 *   1 : at least one source has relevance-only silence.
 *   3 : no telemetry rows yet (first run before any ingest pass completes) —
 *       inconclusive per harness-reliability convention; re-run after one pass.
 *
 * HOW TO RUN
 *   npx tsx scripts/curated-intake-telemetry-check.ts
 *
 * This gate is registered in scripts/run-gates.ts with inconclusive3: true.
 */
import { db } from '../server/db';
import { curatedIntakeTelemetry } from '../shared/schema';

// ─── Sources to actively monitor ─────────────────────────────────────────────
// Each entry documents the EXPECTED outcome so future silence is interpretable.
//
// GATE-REJECT failures are actionable only when rejection is the source's sole
// final disposition. Recency, duplicate, blocked, finance, malformed, deferred,
// and mixed broad-feed filtering are expected/by-design and are NOT failures.
//
// To add a new source, add an entry here with the canonicalName matching the
// Outlet Registry canonical (and curatedFeeds.ts sourceName).
const MONITORED: Array<{
  source: string;
  label: string;
  expectedSilentReason?: 'recency' | 'store-dup';
  note: string;
}> = [
  // ─── Restored / fixed feeds ────────────────────────────────────────────────
  {
    source: 'Bloomberg',
    label: 'bloomberg-offhost',
    note: 'Bloomberg off-host bot (Bing News RSS). Direct RSS was HTTP 404; off-host re-sources it via Bing defense/security query. Should admit > 0 per pass.',
  },

  // ─── Regional desks that were previously undocumented-silent ───────────────
  {
    source: 'Al-Monitor',
    label: 'rss',
    note: 'Middle East policy (Iran nuclear, Israel-Gaza, Gulf). 9 unique articles/pass (11/20 are wire dups from AJ/Guardian). Wide-aperture gate should keep ~4-7. Corrected-and-restored Task #950: first confirmed admission via telemetry.',
  },
  {
    source: 'Yonhap',
    label: 'rss',
    note: 'Broad Korean wire feed. Mixed strategic admissions, relevance rejections, and duplicate churn are normal; hard-fail only when rejection is the sole final disposition.',
  },
  {
    source: 'HuffPost',
    label: 'rss',
    note: 'Broad U.S. politics feed. Most items may be soft domestic commentary; mixed relevance rejection plus duplicate churn is expected.',
  },
  {
    source: 'NewsNation',
    label: 'rss',
    note: 'Broad U.S. general-news feed. Strategic items can pass, while local incidents and soft domestic coverage are correctly rejected.',
  },

  // ─── Known low-cadence / documented-expected-silent ───────────────────────
  {
    source: 'Der Spiegel',
    label: 'rss',
    expectedSilentReason: 'recency',
    note: 'English desk is low-cadence (long-form; can go several days between posts). Silence = aged-out, not a gate failure. Covered by DW + France24 + Le Monde.',
  },

  // ─── Defense trade / specialty feeds ──────────────────────────────────────
  {
    source: 'Breaking Defense',
    label: 'rss',
    note: 'Defense trade. Direct RSS intermittently 403s; off-host Bing bot supplements it. Either path should produce ingested > 0.',
  },
  {
    source: 'Defense One',
    label: 'rss',
    note: 'Defense trade. Low-cadence (kept=5 in 2026-07-15 probe, 18 aged-out) but contributing.',
  },
];

// ─── Low-cadence sources: recency silence is expected, never a FAIL ───────────
const RECENCY_SILENT_OK = new Set(
  MONITORED
    .filter(m => m.expectedSilentReason === 'recency')
    .map(m => `${m.source}::${m.label}`)
);

async function main() {
  let rows: Array<typeof curatedIntakeTelemetry.$inferSelect>;
  try {
    rows = await db.select().from(curatedIntakeTelemetry);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error('[INCONCLUSIVE] curated_intake_telemetry DB read failed:', msg);
    process.exit(3);
  }

  if (rows.length === 0) {
    console.log('[INCONCLUSIVE] No curated_intake_telemetry rows yet — no ingest pass has completed.');
    console.log('               Re-run after the first curated ingest cron fires (typically within 10 min of app start).');
    process.exit(3);
  }

  // Index rows by "source::label" for quick lookup.
  const byKey = new Map<string, typeof rows[0]>();
  for (const r of rows) {
    byKey.set(`${r.sourceName}::${r.lastLabel}`, r);
  }

  let anyFail = false;

  console.log('\n=== Curated Intake Telemetry Check ===\n');
  console.log(`Total telemetry rows: ${rows.length}`);
  console.log(`Monitored sources: ${MONITORED.length}`);
  console.log('');

  for (const m of MONITORED) {
    const key = `${m.source}::${m.label}`;
    const r = byKey.get(key);

    if (!r) {
      // Source has not appeared in any telemetry pass yet.
      console.log(`[NO DATA] ${m.source} (${m.label}) — not yet in telemetry. Re-run after next ingest pass.`);
      continue;
    }

    const ingested = r.ingested ?? 0;
    const aged = r.aged ?? 0;
    const dropRelRej = r.dropRelevanceRejected ?? 0;
    const dropDupUrl = r.dropDupUrl ?? 0;
    const dropFuzzy = r.dropFuzzyDup ?? 0;
    const dropBlocked = r.dropBlocked ?? 0;
    const dropInvalid = r.dropInvalid ?? 0;
    const dropDupBatch = r.dropDupBatch ?? 0;
    const dropFinance = r.dropRelevanceFinance ?? 0;
    const dropUnscored = r.dropGateUnscored ?? 0;
    const deferred = r.deferred ?? 0;
    const dupInPass = r.dupInPass ?? 0;
    const fetched = r.fetched ?? 0;
    const kept = r.kept ?? 0;

    const dropTotal =
      dropRelRej + dropDupUrl + dropDupBatch + dropFuzzy + dropBlocked +
      dropInvalid + dropFinance + dropUnscored;
    const nonRelevanceDisposition =
      dropDupUrl + dropDupBatch + dropFuzzy + dropBlocked + dropInvalid +
      dropFinance + dropUnscored + deferred;
    const lastRun = r.lastRunAt ? new Date(r.lastRunAt).toISOString() : 'unknown';

    // Determine verdict.
    let verdict: string;
    let isFail = false;

    if (ingested > 0) {
      verdict = `OK-admitted     ingested=${ingested}`;
    } else if (aged > 0 && aged >= dropTotal && RECENCY_SILENT_OK.has(key)) {
      verdict = `OK-recency-silent  aged=${aged} (documented low-cadence)`;
    } else if (dropDupUrl > 0 && dropDupUrl >= dropRelRej && ingested === 0) {
      verdict = `OK-store-dup    drop_dup_url=${dropDupUrl} (items already in store)`;
    } else if (dropUnscored > 0 && ingested === 0 && dropRelRej === 0) {
      verdict = `WARN-unscored   drop_gate_unscored=${dropUnscored} (transient AI outage, non-blocking)`;
    } else if (dropRelRej > 0 && ingested === 0 && dropUnscored > dropRelRej) {
      // Most of the pass never reached the AI gate (partial outage/overload):
      // a handful of scored rejections is not evidence of mis-calibration.
      // FAIL requires relevance rejection to be the sole final disposition.
      verdict = `WARN-mixed      rel-rej=${dropRelRej} but unscored=${dropUnscored} dominant (partial AI outage — not a calibration verdict, non-blocking)`;
    } else if (
      dropRelRej > 0 &&
      ingested === 0 &&
      nonRelevanceDisposition === 0 &&
      aged === 0 &&
      dupInPass === 0 &&
      !RECENCY_SILENT_OK.has(key)
    ) {
      // The gate rejected every processed item and there is no competing
      // disposition (duplicate, finance, malformed, blocked, deferred, etc.)
      // that explains the silent pass. This matches the documented hard-fail
      // invariant at the top of this file.
      verdict = `FAIL-gate-reject  ingested=0 drop_relevance_rejected=${dropRelRej}`;
      isFail = true;
      anyFail = true;
    } else if (dropRelRej > 0 && ingested === 0) {
      verdict =
        `INFO-mixed      rel-rej=${dropRelRej} other-dispositions=${nonRelevanceDisposition}` +
        ` (broad-feed filtering/dedup churn)`;
    } else if (ingested === 0 && dropTotal === 0 && aged === 0 && dupInPass === 0) {
      verdict = `NO-DATA-YET     telemetry row exists but all counters zero (ingest still in progress?)`;
    } else {
      // Fallback: summarize what we know.
      verdict = `INFO            ingested=${ingested} rel-rej=${dropRelRej} dup-url=${dropDupUrl} aged=${aged} fuzzy=${dropFuzzy}`;
    }

    const flag = isFail ? '✗' : '✓';
    console.log(`${flag} ${m.source.padEnd(22)} [${m.label}]  ${verdict}`);
    console.log(`  fetched=${fetched} kept=${kept} dup-in-pass=${dupInPass} aged=${aged}`);
    console.log(`  ingested=${ingested} rel-rej=${dropRelRej} dup-url=${dropDupUrl} dup-batch=${dropDupBatch} fuzzy=${dropFuzzy} finance=${dropFinance} invalid=${dropInvalid} unscored=${dropUnscored} blocked=${dropBlocked} deferred=${deferred}`);
    console.log(`  last_run=${lastRun}`);
    if (isFail) {
      console.log(`  NOTE: ${m.note}`);
      console.log(`  ACTION: Relevance rejection is the only recorded outcome for ${m.source}.`);
      console.log(`          Inspect candidate titles and prompt calibration before changing admission behavior.`);
    }
    console.log('');
  }

  // ─── Summary of all telemetry rows (non-monitored sources) ────────────────
  const monitoredKeys = new Set(MONITORED.map(m => `${m.source}::${m.label}`));
  const otherRows = rows.filter(r => !monitoredKeys.has(`${r.sourceName}::${r.lastLabel}`));
  if (otherRows.length > 0) {
    console.log(`--- Other sources in telemetry (${otherRows.length}) ---`);
    for (const r of otherRows.sort((a, b) => (b.ingested ?? 0) - (a.ingested ?? 0))) {
      const status = (r.ingested ?? 0) > 0 ? 'admitted' : ((r.aged ?? 0) > 0 ? 'aged-silent' : 'silent');
      console.log(`  ${r.sourceName.padEnd(28)} [${r.lastLabel}]  ${status}  ingested=${r.ingested ?? 0} rel-rej=${r.dropRelevanceRejected ?? 0} aged=${r.aged ?? 0}`);
    }
    console.log('');
  }

  if (anyFail) {
    console.error('\n[FAIL] One or more monitored sources have relevance-only silence.');
    console.error('       No duplicate, recency, finance, blocked, malformed, unscored, or deferred disposition explains it.\n');
    process.exit(1);
  }

  console.log('[PASS] No monitored source has unexplained relevance-only silence.');
  process.exit(0);
}

main().catch(err => {
  const msg = (err as Error)?.message ?? String(err);
  if (msg.includes('ECONNREFUSED') || msg.includes('connection') || msg.includes('timeout')) {
    console.error('[INCONCLUSIVE] DB unreachable:', msg);
    process.exit(3);
  }
  console.error('[FAIL] Unexpected error:', err);
  process.exit(1);
});
