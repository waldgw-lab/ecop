/**
 * Curated ingest abort-signal regression (Task #715).
 *
 * runCuratedIngest wraps the whole pass in a hard timeout that calls
 * controller.abort() BEFORE rejecting, so every loop boundary inside the pass
 * can stop queuing new AI / DB / network calls the instant the timeout fires
 * (rather than running on in the background and hammering shared resources).
 * The load-bearing function is admitCuratedCandidates: it is the single
 * chokepoint every intake path (RSS gate, team submissions, social/flash,
 * main-feed headlines) funnels through, and it threads the AbortSignal into an
 * entry guard, its (batched) dedup step, and its insert loop.
 *
 * A future refactor could silently drop the signal parameter from one of the
 * intake wrappers (ingestTeamSubmissionsToCurated, ingestSocialFlashToCurated,
 * ingestHeadlinesToCurated) or from admitCuratedCandidates itself, and the
 * "stop after the timeout" behaviour would regress with no other test noticing.
 * This pins the contract:
 *
 *   1. A PRE-aborted signal makes admitCuratedCandidates bail at its entry
 *      guard — it throws an AbortError and makes ZERO DB/AI calls (not even the
 *      registry read that normally runs first). Nothing is ingested.
 *
 *   2. A signal that fires DURING dedup (the single batched existing-URL lookup
 *      that replaced the per-item round trips) stops the pass before the insert
 *      loop: the batched lookup runs once and nothing is ever inserted.
 *
 *   3. The intake wrappers still forward the signal down to
 *      admitCuratedCandidates (a pre-aborted signal short-circuits each of them
 *      to { ingested: 0 } via the same entry guard).
 *
 * Stubbing strategy (no test framework, no live AI/network): `storage` is a
 * mutable DatabaseStorage instance, so we shadow the handful of read/write
 * methods admitCuratedCandidates touches with in-memory spies that count calls.
 * mode:'reuse' is used so no AI relevance gate runs; the point of the test is
 * that the ABORT stops work before ANY of these spies fire.
 *
 * Run directly with tsx (no test framework configured):
 *   npx tsx scripts/curated-ingest-abort.test.ts
 * Exits non-zero on any failure.
 */
import {
  admitCuratedCandidates,
  ingestTeamSubmissionsToCurated,
  ingestSocialFlashToCurated,
  ingestHeadlinesToCurated,
  type CuratedIntakeCandidate,
} from '../server/curatedIngest';
import { storage } from '../server/storage';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[ingest-abort] OK   ${name}`);
  } else {
    console.error(`[ingest-abort] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

function isAbortError(e: unknown): boolean {
  return !!e && (e as Error).name === 'AbortError';
}

// A small candidate list. Each has a valid single http URL + a real source, so
// nothing is dropped by the pre-loop validity screens — the ONLY thing that can
// stop the loop here is the abort signal.
function candidates(): CuratedIntakeCandidate[] {
  return [
    { title: 'First curated candidate about Indo-Pacific carrier deployment', url: 'https://example.com/a', source: 'Reuters' },
    { title: 'Second curated candidate about export-control escalation', url: 'https://example.com/b', source: 'Associated Press' },
    { title: 'Third curated candidate about a Geneva negotiation round', url: 'https://example.com/c', source: 'Defense News' },
  ];
}

// Spy harness over the storage methods admitCuratedCandidates touches.
type Spies = {
  restore: () => void;
  counts: Record<string, number>;
};
function installStorageSpies(opts?: {
  onGetCuratedItemByUrl?: () => void;
  onGetExistingCuratedUrls?: () => void;
}): Spies {
  const orig: Record<string, any> = {};
  const counts: Record<string, number> = {
    getOutletRegistry: 0,
    getCuratedItemByUrl: 0,
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
  spy('getCuratedItemByUrl', async () => {
    opts?.onGetCuratedItemByUrl?.();
    return undefined; // never a dup, so the loop would proceed if not aborted
  });
  // Batched existing-URL dedup (single round trip per pass). Returns an empty
  // set so no candidate is a dup — the ONLY thing that stops the pass here is
  // the abort signal.
  spy('getExistingCuratedUrls', async () => {
    opts?.onGetExistingCuratedUrls?.();
    return new Set<string>();
  });
  spy('getSimilarCuratedItems', async () => []);
  spy('getSimilarCuratedItemsForOutlet', async () => []);
  spy('getCuratedDedupCorpus', async () => []);
  spy('upsertCuratedIntakeTelemetry', async () => {});
  spy('mergeCuratedIntakeFeedStats', async () => {});
  spy('addCuratedItem', async (insert: any) => ({ id: 'stub', ...insert }));

  return {
    counts,
    restore: () => {
      for (const [name, fn] of Object.entries(orig)) (storage as any)[name] = fn;
    },
  };
}

async function main() {
  // =========================================================================
  // TEST 1 — a PRE-aborted signal bails at the entry guard: throws AbortError,
  // makes ZERO DB/AI calls, ingests nothing.
  // =========================================================================
  {
    const spies = installStorageSpies();
    const controller = new AbortController();
    controller.abort(); // pre-abort

    let threw = false;
    let abortShaped = false;
    let result: any = null;
    try {
      result = await admitCuratedCandidates(candidates(), {
        mode: 'reuse',
        label: 'abort-test-pre',
        signal: controller.signal,
      });
    } catch (e) {
      threw = true;
      abortShaped = isAbortError(e);
    } finally {
      spies.restore();
    }

    check('1a pre-aborted admitCuratedCandidates throws (does not silently continue)', threw);
    check('1b it throws an AbortError specifically', abortShaped, `result=${JSON.stringify(result)}`);
    check(
      '1c ZERO DB calls made — not even the registry read',
      spies.counts.getOutletRegistry === 0 &&
        spies.counts.getCuratedItemByUrl === 0 &&
        spies.counts.getExistingCuratedUrls === 0 &&
        spies.counts.getSimilarCuratedItems === 0 &&
        spies.counts.getSimilarCuratedItemsForOutlet === 0,
      JSON.stringify(spies.counts),
    );
    check('1d nothing is ingested (addCuratedItem never called)', spies.counts.addCuratedItem === 0);
  }

  // =========================================================================
  // TEST 2 — a signal that fires DURING dedup (the single batched existing-URL
  // lookup that replaced the per-item getCuratedItemByUrl round trips) stops the
  // pass before the insert loop: the batched lookup runs exactly once and
  // nothing is ever inserted.
  // =========================================================================
  {
    const controller = new AbortController();
    // Abort the moment the batched dedup lookup runs. The throwIfAborted at the
    // top of the insert loop (and the pre-insert guards) then fire before any
    // candidate is written.
    const spies = installStorageSpies({
      onGetExistingCuratedUrls: () => controller.abort(),
    });

    let threw = false;
    let abortShaped = false;
    try {
      await admitCuratedCandidates(candidates(), {
        mode: 'reuse',
        label: 'abort-test-mid',
        signal: controller.signal,
      });
    } catch (e) {
      threw = true;
      abortShaped = isAbortError(e);
    } finally {
      spies.restore();
    }

    check('2a dedup-time abort throws an AbortError', threw && abortShaped);
    check(
      '2b batched dedup ran exactly once (one round trip for the whole pass, not per-item)',
      spies.counts.getExistingCuratedUrls === 1,
      `getExistingCuratedUrls called ${spies.counts.getExistingCuratedUrls} time(s)`,
    );
    check(
      '2c no candidate inserted after the abort (addCuratedItem never called)',
      spies.counts.addCuratedItem === 0,
      `addCuratedItem called ${spies.counts.addCuratedItem} time(s)`,
    );
  }

  // =========================================================================
  // TEST 3 — the intake WRAPPERS forward the signal down. Each is called with a
  // pre-aborted signal; because they fetch their source rows first and then
  // hand off to admitCuratedCandidates with the signal, a pre-abort must yield
  // { ingested: 0 } (either short-circuited to an empty candidate set, or bailed
  // at the entry guard and swallowed by the wrapper). The regression this
  // guards is a wrapper dropping the `signal` argument entirely.
  // =========================================================================
  {
    const wrappers: Array<[string, (s: AbortSignal) => Promise<{ ingested: number }>]> = [
      ['ingestTeamSubmissionsToCurated', ingestTeamSubmissionsToCurated],
      ['ingestSocialFlashToCurated', ingestSocialFlashToCurated],
      ['ingestHeadlinesToCurated', ingestHeadlinesToCurated],
    ];

    for (const [name, fn] of wrappers) {
      // Shadow the source-row reads to return a non-empty list, so the wrapper
      // WOULD reach admitCuratedCandidates if it didn't honour the abort. Also
      // spy the admit-path storage methods to prove none of them run.
      const spies = installStorageSpies();
      const origReads: Record<string, any> = {};
      const stubRead = (m: string, val: any) => {
        origReads[m] = (storage as any)[m];
        (storage as any)[m] = async () => val;
      };
      const sampleRow = { id: 1, title: 'x', url: 'https://example.com/z', source: 'Reuters' };
      // Cover every source-row reader the three wrappers use.
      stubRead('getRecentTeamSubmissionsForCurated', [sampleRow]);
      stubRead('getRecentHeadlinesForCurated', [sampleRow]);
      stubRead('getRecentXPostsForCurated', [sampleRow]);
      stubRead('getRecentTruthSocialPostsForCurated', [sampleRow]);
      stubRead('getRecentFirstAlertsForCurated', [sampleRow]);

      const controller = new AbortController();
      controller.abort();

      let ingested = -1;
      let clean = true;
      try {
        const r = await fn(controller.signal);
        ingested = r.ingested;
      } catch (e) {
        // A thrown AbortError is an acceptable "stopped early" outcome too.
        clean = isAbortError(e);
      } finally {
        for (const [m, f] of Object.entries(origReads)) (storage as any)[m] = f;
        spies.restore();
      }

      check(
        `3.${name} forwards the abort — ingests 0 and never inserts`,
        (ingested === 0 || (ingested === -1 && clean)) && spies.counts.addCuratedItem === 0,
        `ingested=${ingested}, addCuratedItem=${spies.counts.addCuratedItem}, clean=${clean}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  if (failures > 0) {
    console.error(`\n[ingest-abort] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[ingest-abort] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[ingest-abort] UNEXPECTED ERROR', e);
  process.exit(1);
});
