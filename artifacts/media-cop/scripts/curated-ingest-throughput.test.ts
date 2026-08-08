/**
 * Tests for the curated ingest throughput / resilience changes (Task #383):
 *   1. analyzeCuratedBatchChunked — splits a backlog into bounded chunks, runs
 *      them with bounded concurrency, merges results in input order, and is
 *      fail-soft per chunk (one chunk failing never drops the others).
 *   2. fetchWithResilience — rotates the User-Agent and retries transient
 *      failures (thrown errors + retriable HTTP statuses), returns the final
 *      Response, and throws only when every attempt threw.
 *
 * No test framework is configured — run directly with tsx:
 *   npx tsx scripts/curated-ingest-throughput.test.ts
 * Exits non-zero on any failure.
 */
import {
  analyzeCuratedBatchChunked,
  CURATED_GATE_CHUNK_SIZE,
  type CuratedAnalysisResult,
} from '../server/aiAnalyzer';
import { fetchWithResilience } from '../server/resilientFetch';
import { spreadMachineCuratedPriority } from '../server/curatedIngest';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function fakeResult(title: string): CuratedAnalysisResult {
  return {
    title,
    is_relevant: true,
    reason: 'test',
    tags: [],
    priority_score: 50,
    category: 'general',
    region: null,
    country: null,
    primaryTopic: 'Other / Emerging' as CuratedAnalysisResult['primaryTopic'],
    scope: null,
    conflictTrack: null,
    countryPair: null,
    proposedTopic: null,
  };
}

async function testChunking() {
  console.log('analyzeCuratedBatchChunked:');

  // --- single small batch: one call, identical pass-through ---
  {
    const calls: string[][] = [];
    const titles = ['a', 'b', 'c'];
    const res = await analyzeCuratedBatchChunked(titles, {
      _analyze: async (t) => {
        calls.push(t);
        return t.map(fakeResult);
      },
    });
    check('single batch makes exactly one call', calls.length === 1, `calls=${calls.length}`);
    check('single batch returns all results', res.length === 3);
  }

  // --- large backlog: chunks at the chunk size, merged in input order ---
  {
    const calls: string[][] = [];
    const n = CURATED_GATE_CHUNK_SIZE * 2 + 7; // 57 with default 25
    const titles = Array.from({ length: n }, (_, i) => `t${i}`);
    const res = await analyzeCuratedBatchChunked(titles, {
      _analyze: async (t) => {
        calls.push(t);
        return t.map(fakeResult);
      },
    });
    const expectedChunks = Math.ceil(n / CURATED_GATE_CHUNK_SIZE);
    check(`splits into ${expectedChunks} chunks`, calls.length === expectedChunks, `calls=${calls.length}`);
    check('no chunk exceeds chunk size', calls.every((c) => c.length <= CURATED_GATE_CHUNK_SIZE));
    check('merges every result', res.length === n, `got ${res.length}`);
    check(
      'preserves input order',
      res.map((r) => r.title).join(',') === titles.join(','),
    );
  }

  // --- cross-chunk score plateaus are de-clumped after merge ---
  {
    const titles = Array.from({ length: 12 }, (_, i) => `plateau-${i}`);
    const res = await analyzeCuratedBatchChunked(titles, {
      chunkSize: 3,
      concurrency: 2,
      _analyze: async (t) => t.map((title) => ({
        ...fakeResult(title),
        priority_score: 66,
      })),
    });
    const scores = res.map((r) => r.priority_score);
    check('cross-chunk score plateau is spread after merge', new Set(scores).size > 1);
    check('cross-chunk de-clump never raises machine scores', Math.max(...scores) === 66);
  }

  // --- bounded concurrency: never exceeds the requested concurrency ---
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const titles = Array.from({ length: 50 }, (_, i) => `c${i}`);
    await analyzeCuratedBatchChunked(titles, {
      chunkSize: 5,
      concurrency: 2,
      _analyze: async (t) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return t.map(fakeResult);
      },
    });
    check('respects bounded concurrency', maxInFlight <= 2, `maxInFlight=${maxInFlight}`);
  }

  // --- fail-soft: one chunk throwing doesn't drop the others ---
  {
    const titles = Array.from({ length: 30 }, (_, i) => `f${i}`);
    let call = 0;
    const res = await analyzeCuratedBatchChunked(titles, {
      chunkSize: 10,
      concurrency: 3,
      _analyze: async (t) => {
        const idx = call++;
        if (idx === 1) throw new Error('simulated transient chunk failure');
        return t.map(fakeResult);
      },
    });
    // 3 chunks of 10; one fails → 20 results survive.
    check('fail-soft keeps surviving chunks', res.length === 20, `got ${res.length}`);
  }

  // --- empty / whitespace input ---
  {
    const res = await analyzeCuratedBatchChunked(['', '   '], {
      _analyze: async () => {
        throw new Error('should not be called for empty input');
      },
    });
    check('empty input returns []', res.length === 0);
  }
}

async function testResilientFetch() {
  console.log('fetchWithResilience:');
  const realFetch = globalThis.fetch;

  function mkResp(status: number): Response {
    return new Response(status === 200 ? 'OK' : '', { status });
  }

  try {
    // --- retries a thrown error, then succeeds, rotating the UA ---
    {
      const uas: string[] = [];
      let attempt = 0;
      globalThis.fetch = (async (_url: any, init: any) => {
        uas.push(init.headers['User-Agent']);
        attempt++;
        if (attempt < 3) throw new Error('ECONNRESET');
        return mkResp(200);
      }) as typeof fetch;
      const resp = await fetchWithResilience('https://example.com/feed', { retries: 3, label: 'T' });
      check('recovers after transient throws', resp.status === 200, `status=${resp.status}`);
      check('made 3 attempts', attempt === 3, `attempts=${attempt}`);
      check('rotated the User-Agent across attempts', new Set(uas).size > 1, `uas=${new Set(uas).size}`);
    }

    // --- retries a retriable 403 (UA block), then succeeds ---
    {
      let attempt = 0;
      globalThis.fetch = (async () => {
        attempt++;
        return mkResp(attempt < 2 ? 403 : 200);
      }) as typeof fetch;
      const resp = await fetchWithResilience('https://blocked.example/world', { retries: 2, label: 'T' });
      check('retries a 403 then succeeds', resp.status === 200 && attempt === 2, `status=${resp.status} attempts=${attempt}`);
    }

    // --- non-retriable status returned immediately (no retry) ---
    {
      let attempt = 0;
      globalThis.fetch = (async () => {
        attempt++;
        return mkResp(404);
      }) as typeof fetch;
      const resp = await fetchWithResilience('https://example.com/missing', { retries: 3, label: 'T' });
      check('does not retry a 404', resp.status === 404 && attempt === 1, `attempts=${attempt}`);
    }

    // --- exhausts retries on persistent throw → rethrows ---
    {
      let attempt = 0;
      globalThis.fetch = (async () => {
        attempt++;
        throw new Error('ETIMEDOUT');
      }) as typeof fetch;
      let threw = false;
      try {
        await fetchWithResilience('https://dead.example/feed', { retries: 1, label: 'T' });
      } catch {
        threw = true;
      }
      check('throws after exhausting retries on persistent error', threw && attempt === 2, `attempts=${attempt}`);
    }

    // --- last-attempt retriable status is returned (not thrown) ---
    {
      let attempt = 0;
      globalThis.fetch = (async () => {
        attempt++;
        return mkResp(503);
      }) as typeof fetch;
      const resp = await fetchWithResilience('https://flaky.example/feed', { retries: 1, label: 'T' });
      check('returns last retriable response for caller to handle', resp.status === 503 && attempt === 2, `attempts=${attempt}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

function testFinalMachineScoreSpread() {
  console.log('spreadMachineCuratedPriority:');
  const urls = Array.from({ length: 16 }, (_, i) => `https://example.com/story-${i}`);
  const scores = urls.map((url) => spreadMachineCuratedPriority(66, url));
  check('independent-batch machine plateau is spread', new Set(scores).size > 1);
  check('final machine spread never raises', Math.max(...scores) === 66);
  check('final machine spread is bounded to three points', Math.min(...scores) >= 63);
  check(
    'final machine spread is stable by URL',
    JSON.stringify(scores) === JSON.stringify(urls.map((url) => spreadMachineCuratedPriority(66, url))),
  );
  check(
    'editorial watch floor is never undercut by final spread',
    urls.every((url) => spreadMachineCuratedPriority(66, url, 66) >= 66),
  );
}

(async () => {
  await testChunking();
  testFinalMachineScoreSpread();
  await testResilientFetch();
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll curated ingest throughput checks passed');
})();
