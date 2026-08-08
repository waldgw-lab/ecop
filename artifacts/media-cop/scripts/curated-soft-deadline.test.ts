/**
 * Curated ingest SOFT-DEADLINE regression.
 *
 * Prod symptom this guards against: the curated ingest pass used to grind the
 * full hard timeout (~8 min) every ~10 min, saturating the single Node process
 * (sync CPU parsing + shared AI/Neon) and starving read endpoints like
 * /api/team/subjects (observed 10s–124s). The fix gives admitCuratedCandidates
 * a SOFT deadline: once past budget it stops STARTING new per-item work and
 * gracefully RETURNS its partial counts (no throw), deferring the rest to the
 * next 5-min cron tick. URL-dedup makes that re-drain idempotent (no double
 * insert).
 *
 * This is DISTINCT from the hard abort (scripts/curated-ingest-abort.test.ts):
 *   - Hard abort  → throws AbortError (a wedge backstop).
 *   - Soft deadline → returns { ingested, skipped } normally (graceful pacing).
 *
 * This pins three properties:
 *   A. A past-due soft deadline makes admitCuratedCandidates defer ALL remaining
 *      items: it inserts nothing, and it RETURNS normally (does NOT throw).
 *   B. With a generous deadline the same candidates are fully admitted (proving
 *      the deadline is the only thing gating work in A).
 *   C. Re-running the pass after a deferral is idempotent: the second pass sees
 *      the already-inserted URLs and inserts ZERO (dup-url), so nothing is
 *      double-counted when the next cron tick drains the deferred work.
 *
 * Stubbing strategy mirrors the abort test: `storage` is a mutable singleton, so
 * we shadow the read/write methods admitCuratedCandidates touches with in-memory
 * spies. mode:'reuse' means no AI relevance gate runs.
 *
 * Run directly (no test framework configured):
 *   npx tsx scripts/curated-soft-deadline.test.ts
 * Exits non-zero on any failure.
 */

// Defensive: keep the intake AI-free even on paths that check it at call time.
process.env.CURATED_AI_HARNESS_STUB = '1';

import { admitCuratedCandidates, type CuratedIntakeCandidate } from '../server/curatedIngest';
import { analyzeCuratedBatchChunked, type CuratedAnalysisResult } from '../server/aiAnalyzer';
import { storage } from '../server/storage';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[soft-deadline] OK   ${name}`);
  } else {
    console.error(`[soft-deadline] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// A handful of candidates, each with a valid single-http URL + real source so
// nothing is dropped by the pre-insert validity screens — the ONLY thing that
// gates admission here is the soft deadline / dup-url check.
function candidates(): CuratedIntakeCandidate[] {
  return [
    { title: 'Curated candidate one about Indo-Pacific carrier movements', url: 'https://example.com/sd-1', source: 'Reuters' },
    { title: 'Curated candidate two about export-control escalation talks', url: 'https://example.com/sd-2', source: 'Associated Press' },
    { title: 'Curated candidate three about a Geneva negotiation round today', url: 'https://example.com/sd-3', source: 'Defense News' },
    { title: 'Curated candidate four about a maritime chokepoint incident', url: 'https://example.com/sd-4', source: 'BBC' },
    { title: 'Curated candidate five about a critical-minerals supply deal', url: 'https://example.com/sd-5', source: 'Financial Times' },
    { title: 'Curated candidate six about a defense-industrial base program', url: 'https://example.com/sd-6', source: 'Defense One' },
  ];
}

// Spy harness. `insertedUrls` grows as addCuratedItem fires, and
// getExistingCuratedUrls returns exactly that set — modelling a real DB where a
// second pass sees the rows the first pass wrote (idempotency).
type Spies = { restore: () => void; counts: Record<string, number>; insertedUrls: Set<string> };
function installStorageSpies(): Spies {
  const orig: Record<string, any> = {};
  const insertedUrls = new Set<string>();
  const counts: Record<string, number> = {
    getOutletRegistry: 0,
    getExistingCuratedUrls: 0,
    getSimilarCuratedItems: 0,
    getSimilarCuratedItemsForOutlet: 0,
    addCuratedItem: 0,
  };
  const spy = (name: string, fn: (...a: any[]) => any) => {
    orig[name] = (storage as any)[name];
    (storage as any)[name] = (...args: any[]) => {
      counts[name]++;
      return fn(...args);
    };
  };
  spy('getOutletRegistry', async () => []);
  // Batched existing-URL dedup: report whatever has already been inserted so a
  // re-run of the same candidates is a no-op (dup-url skip).
  spy('getExistingCuratedUrls', async (urls: string[]) => {
    const present = new Set<string>();
    for (const u of urls) if (insertedUrls.has(u)) present.add(u);
    return present;
  });
  spy('getSimilarCuratedItems', async () => []);
  spy('getSimilarCuratedItemsForOutlet', async () => []);
  spy('getCuratedDedupCorpus', async () => []);
  spy('upsertCuratedIntakeTelemetry', async () => {});
  spy('mergeCuratedIntakeFeedStats', async () => {});
  spy('addCuratedItem', async (insert: any) => {
    if (insert?.url) insertedUrls.add(insert.url);
    return { id: `stub-${insertedUrls.size}`, ...insert };
  });
  return {
    counts,
    insertedUrls,
    restore: () => {
      for (const [name, fn] of Object.entries(orig)) (storage as any)[name] = fn;
    },
  };
}

async function main() {
  // =========================================================================
  // TEST A — a past-due soft deadline defers ALL items and RETURNS normally.
  // =========================================================================
  {
    const spies = installStorageSpies();
    let result: any = null;
    let threw = false;
    try {
      result = await admitCuratedCandidates(candidates(), {
        mode: 'reuse',
        label: 'soft-deadline-past',
        deadlineMs: Date.now() - 1, // already past → defer at the first loop check
      });
    } catch (e) {
      threw = true;
    } finally {
      spies.restore();
    }

    check('A1 past-deadline does NOT throw (soft ≠ hard abort)', !threw, `result=${JSON.stringify(result)}`);
    check(
      'A2 it returns a normal { ingested, skipped } shape',
      !!result && typeof result.ingested === 'number' && typeof result.skipped === 'number',
      JSON.stringify(result),
    );
    check('A3 nothing was inserted (all items deferred to the next pass)', spies.counts.addCuratedItem === 0);
    check('A4 nothing was ingested', !!result && result.ingested === 0, JSON.stringify(result));
  }

  // =========================================================================
  // TEST B — a generous deadline admits the full batch (the deadline is the
  // only thing that gated work in A).
  // =========================================================================
  const firstPassSpies = installStorageSpies();
  {
    let result: any = null;
    try {
      result = await admitCuratedCandidates(candidates(), {
        mode: 'reuse',
        label: 'soft-deadline-generous',
        deadlineMs: Date.now() + 5 * 60 * 1000, // far future → no deferral
      });
    } finally {
      // keep firstPassSpies installed for TEST C's idempotency check below
    }

    check(
      'B1 all candidates admitted with a generous deadline',
      firstPassSpies.counts.addCuratedItem === 6,
      `addCuratedItem called ${firstPassSpies.counts.addCuratedItem} time(s)`,
    );
    check('B2 ingested count matches inserts', !!result && result.ingested === 6, JSON.stringify(result));
  }

  // =========================================================================
  // TEST C — re-running the SAME candidates is idempotent: the second pass sees
  // the already-inserted URLs and inserts ZERO (models the next cron tick
  // draining previously-deferred work without double-counting). Reuses the
  // first pass's in-memory "DB" (insertedUrls) so the dup-url path is exercised.
  // =========================================================================
  {
    let result: any = null;
    try {
      result = await admitCuratedCandidates(candidates(), {
        mode: 'reuse',
        label: 'soft-deadline-idempotent',
        deadlineMs: Date.now() + 5 * 60 * 1000,
      });
    } finally {
      firstPassSpies.restore();
    }

    check(
      'C1 second pass inserts nothing (dup-url dedup makes re-drain idempotent)',
      firstPassSpies.counts.addCuratedItem === 6, // still 6 total — no NEW inserts on pass 2
      `addCuratedItem total after 2nd pass = ${firstPassSpies.counts.addCuratedItem}`,
    );
    check('C2 second pass ingests 0 and skips the whole batch', !!result && result.ingested === 0 && result.skipped === 6, JSON.stringify(result));
  }

  // =========================================================================
  // TEST D — the gate-mode AI batch (analyzeCuratedBatchChunked) stops issuing
  // NEW chunk calls once past the soft deadline. Without this a large fresh
  // batch could grind the full gate cost past budget before the insert loop's
  // first deadline check. Uses the `_analyze` injection seam so no real AI runs.
  // =========================================================================
  {
    // 100 titles / chunkSize 10 = 10 chunks. Each fake chunk call is counted.
    const titles = Array.from({ length: 100 }, (_, i) => `Gate title number ${i} about a distinct defense development`);
    const stubAnalyze = (calls: { n: number }) => async (chunk: string[]): Promise<CuratedAnalysisResult[]> => {
      calls.n++;
      // small await so the event loop can interleave workers between chunks
      await new Promise((r) => setImmediate(r));
      return chunk.map((title) => ({ title, isRelevant: true } as unknown as CuratedAnalysisResult));
    };

    // D-past: already past deadline → workers return before dequeuing any chunk.
    const pastCalls = { n: 0 };
    const pastOut = await analyzeCuratedBatchChunked(titles, {
      chunkSize: 10,
      concurrency: 3,
      deadlineMs: Date.now() - 1,
      _analyze: stubAnalyze(pastCalls),
    });
    check('D1 past-deadline issues ZERO new gate chunk calls', pastCalls.n === 0, `called ${pastCalls.n}`);
    check('D2 past-deadline returns an empty (partial) result, no throw', Array.isArray(pastOut) && pastOut.length === 0, `len=${pastOut.length}`);

    // D-generous: far-future deadline → every chunk is analyzed normally.
    const okCalls = { n: 0 };
    const okOut = await analyzeCuratedBatchChunked(titles, {
      chunkSize: 10,
      concurrency: 3,
      deadlineMs: Date.now() + 5 * 60 * 1000,
      _analyze: stubAnalyze(okCalls),
    });
    check('D3 generous deadline analyzes all 10 chunks', okCalls.n === 10, `called ${okCalls.n}`);
    check('D4 generous deadline returns all 100 analyses', okOut.length === 100, `len=${okOut.length}`);
  }

  // -------------------------------------------------------------------------
  if (failures > 0) {
    console.error(`\n[soft-deadline] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[soft-deadline] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[soft-deadline] UNEXPECTED ERROR', e);
  process.exit(1);
});
