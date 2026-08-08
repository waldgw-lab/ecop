/**
 * scripts/curated-classify-lag.test.ts
 *
 * Deterministic gate — no LLM, no network, no DB.  Stubs storage + the
 * analyzer seam so `backfillCuratedClassifications` runs entirely in-memory.
 *
 * Verifies:
 *   1. Fresh unclassified on-screen batch → lag drops to 0 after one pass;
 *      the diagnostic console.warn is NOT emitted.
 *   2. On-screen items freshly stuck on "Other / Emerging" (classifiedAt < 30 min
 *      ago, still within the on-screen reclassify cooldown) → the classify pass
 *      cannot touch them; the diagnostic console.warn IS emitted with the correct
 *      lag count.
 *
 * Exit 0 = PASS.  Exit 1 = FAIL.  No exit 3 (purely deterministic).
 */

import { storage } from '../server/storage';
import {
  backfillCuratedClassifications,
  __setClassifyAnalyzeForTest,
} from '../server/curatedClassify';
import type { CuratedAnalysisResult } from '../server/aiAnalyzer';

const OTHER_EMERGING = 'Other / Emerging';
// Must match the RECLASSIFY_ONSCREEN_COOLDOWN_MS constant in curatedClassify.ts.
const RECLASSIFY_ONSCREEN_COOLDOWN_MS = 30 * 60 * 1000;

let failures = 0;
function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures++;
  }
}

// Minimal CuratedItem shape that buildCuratedCandidateWindow() accesses.
function makeCuratedStoreItem(
  i: number,
  now: number,
): Record<string, unknown> {
  return {
    id: i,
    url: `https://reuters.com/lag-test-article-${i}`,
    title: `Lag test article ${i} about military operations and defense`,
    source: 'Reuters',
    category: 'world',
    priorityScore: 100 - i, // high scores, all on-screen (well within DISPLAY_LIMIT=40)
    scrapedAt: new Date(now - 5 * 60 * 1000), // 5 min ago
    articlePublishedAt: null,
    summaryBullets: null,
    summary: null,
    contentKind: null,
    linkDeadAt: null,
    image: null,
    media_scraped_at: null,
    media_scrape_attempts: 0,
    mediaRescueAt: null,
  };
}

// Save and restore storage method bindings around each scenario.
function saveStorageMethods(): Record<string, unknown> {
  const keys = [
    'getPrimaryFeed',
    'getCuratedStoreItems',
    'getCuratedClusterMembers',
    'getCuratedClassificationsByUrls',
    'upsertCuratedClassifications',
    'recordClassificationProposal',
    'setCuratedRecheckDisagreeCounts',
    'clearCuratedAiClassifications',
  ];
  const saved: Record<string, unknown> = {};
  for (const k of keys) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (storage as any)[k];
    if (typeof fn === 'function') saved[k] = fn.bind(storage);
  }
  return saved;
}

function restoreStorageMethods(saved: Record<string, unknown>): void {
  for (const [k, fn] of Object.entries(saved)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (storage as any)[k] = fn;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: Fresh unclassified batch → lag reaches 0, no warn emitted
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Fresh unclassified batch → lag reaches 0, no warn emitted');

{
  const N = 5; // all within DISPLAY_LIMIT=40, so all are on-screen
  const now = Date.now();
  const storeItems = Array.from({ length: N }, (_, i) => makeCuratedStoreItem(i + 1, now));

  // In-memory overlay: starts empty; populated by upsertCuratedClassifications.
  const overlayMap = new Map<
    string,
    { primaryTopic: string; provenance: string; classifiedAt: Date; recheckDisagreeCount?: number; recheckLastAt?: Date | null }
  >();

  const saved = saveStorageMethods();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).getCuratedStoreItems = async () => storeItems;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).getPrimaryFeed = async () => [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).getCuratedClusterMembers = async () => [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).getCuratedClassificationsByUrls = async (urls: string[]) => {
    const result = new Map<string, unknown>();
    for (const url of urls) {
      const row = overlayMap.get(url);
      if (row) result.set(url, row);
    }
    return result;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).upsertCuratedClassifications = async (rows: Array<{ url: string; primaryTopic: string; provenance: string }>) => {
    for (const row of rows) {
      overlayMap.set(row.url, {
        primaryTopic: row.primaryTopic,
        provenance: row.provenance,
        classifiedAt: new Date(),
      });
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).recordClassificationProposal = async () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).setCuratedRecheckDisagreeCounts = async () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).clearCuratedAiClassifications = async () => [];

  // Stub analyzer: return a real controlled-vocab topic for every title.
  __setClassifyAnalyzeForTest(async (titles: string[]): Promise<CuratedAnalysisResult[]> =>
    titles.map((title) => ({
      title,
      is_relevant: true,
      priority_score: 80,
      category: 'Defense',
      region: 'Global' as const,
      country: null,
      primaryTopic: 'Military Operations & Armed Conflict' as const,
      scope: 'strategic' as const,
      conflictTrack: null,
      countryPair: null,
      proposedTopic: null,
    })),
  );

  // Intercept console.warn to assert the lag line is NOT emitted.
  let lagWarnCalled = false;
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const msg = args.join(' ');
    if (msg.includes('[CuratedClassify] Lag:')) {
      lagWarnCalled = true;
    } else {
      origWarn(...args);
    }
  };

  try {
    const result = await backfillCuratedClassifications();

    assert(
      result.classified === N,
      `All ${N} fresh items were classified (got: ${result.classified})`,
    );
    assert(
      !lagWarnCalled,
      'Diagnostic warn NOT emitted (lag count reached 0 after the pass)',
    );

    // Confirm every on-screen URL has a real primary_topic in the overlay.
    let allLabeled = true;
    for (const item of storeItems) {
      const row = overlayMap.get(item.url as string);
      if (!row?.primaryTopic || row.primaryTopic === OTHER_EMERGING) {
        allLabeled = false;
        break;
      }
    }
    assert(allLabeled, 'Every on-screen item has a real primary_topic in the overlay');
  } finally {
    __setClassifyAnalyzeForTest(null);
    console.warn = origWarn;
    restoreStorageMethods(saved);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: Freshly stuck Other/Emerging (< 30 min cooldown) → lag IS logged
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Freshly stuck Other/Emerging (within cooldown) → lag IS logged');

{
  const N = 3;
  const now = Date.now();
  const storeItems = Array.from({ length: N }, (_, i) => makeCuratedStoreItem(i + 10, now));

  // classifiedAt = 10 min ago — inside the 30-min RECLASSIFY_ONSCREEN_COOLDOWN_MS.
  const recentlyClassifiedAt = new Date(now - 10 * 60 * 1000);

  // Overlay already has Other/Emerging rows with recent classifiedAt.
  const overlayMap = new Map<string, { primaryTopic: string; provenance: string; classifiedAt: Date }>(
    storeItems.map((item) => [
      item.url as string,
      {
        primaryTopic: OTHER_EMERGING,
        provenance: 'ai',
        classifiedAt: recentlyClassifiedAt,
      },
    ]),
  );

  const saved = saveStorageMethods();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).getCuratedStoreItems = async () => storeItems;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).getPrimaryFeed = async () => [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).getCuratedClusterMembers = async () => [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).getCuratedClassificationsByUrls = async (urls: string[]) => {
    const result = new Map<string, unknown>();
    for (const url of urls) {
      const row = overlayMap.get(url);
      if (row) result.set(url, row);
    }
    return result;
  };
  // upsertCuratedClassifications must NOT be called (cooldown blocks reclassify).
  let upsertCalled = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).upsertCuratedClassifications = async () => { upsertCalled = true; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).recordClassificationProposal = async () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).setCuratedRecheckDisagreeCounts = async () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).clearCuratedAiClassifications = async () => [];

  // Stub analyzer — should NOT be reached because cooldown blocks reclassify.
  let analyzerCalled = false;
  __setClassifyAnalyzeForTest(async (): Promise<CuratedAnalysisResult[]> => {
    analyzerCalled = true;
    return [];
  });

  let lagWarnMsg = '';
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const msg = args.join(' ');
    if (msg.includes('[CuratedClassify] Lag:')) {
      lagWarnMsg = msg;
    } else {
      origWarn(...args);
    }
  };

  try {
    const result = await backfillCuratedClassifications();

    assert(
      result.classified === 0,
      `No new classifications (cooldown active, got: ${result.classified})`,
    );
    assert(!upsertCalled, 'upsertCuratedClassifications NOT called (cooldown blocks reclassify)');
    assert(!analyzerCalled, 'Analyzer NOT called (cooldown blocks reclassify)');
    assert(
      lagWarnMsg.length > 0,
      `Diagnostic warn IS emitted (got: ${JSON.stringify(lagWarnMsg)})`,
    );
    // The warn message must report all N on-screen items as lagging.
    assert(
      lagWarnMsg.includes(`${N}/${N}`),
      `Lag count in warn is ${N}/${N} (full on-screen window stuck; got: ${lagWarnMsg})`,
    );
    // Verify cooldown math: 10 min < 30 min means these items are genuinely blocked.
    assert(
      10 * 60 * 1000 < RECLASSIFY_ONSCREEN_COOLDOWN_MS,
      'Fixture sanity: 10-min classifiedAt is inside the 30-min on-screen cooldown',
    );
  } finally {
    __setClassifyAnalyzeForTest(null);
    console.warn = origWarn;
    restoreStorageMethods(saved);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: one analyzer batch throws; later visible batches still classify
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Failed analyzer batch is isolated; later visible batches continue');

{
  const N = 30; // two BATCH=25 calls
  const now = Date.now();
  const storeItems = Array.from({ length: N }, (_, i) => makeCuratedStoreItem(i + 100, now));
  const overlayMap = new Map<string, { primaryTopic: string; provenance: string; classifiedAt: Date }>();
  const saved = saveStorageMethods();
  (storage as any).getCuratedStoreItems = async () => storeItems;
  (storage as any).getPrimaryFeed = async () => [];
  (storage as any).getCuratedClusterMembers = async () => [];
  (storage as any).getCuratedClassificationsByUrls = async (urls: string[]) => {
    const result = new Map<string, unknown>();
    for (const url of urls) {
      const row = overlayMap.get(url);
      if (row) result.set(url, row);
    }
    return result;
  };
  (storage as any).upsertCuratedClassifications = async (rows: Array<{ url: string; primaryTopic: string; provenance: string }>) => {
    for (const row of rows) {
      overlayMap.set(row.url, { primaryTopic: row.primaryTopic, provenance: row.provenance, classifiedAt: new Date() });
    }
  };
  (storage as any).recordClassificationProposal = async () => {};
  (storage as any).setCuratedRecheckDisagreeCounts = async () => {};
  (storage as any).clearCuratedAiClassifications = async () => [];

  let calls = 0;
  __setClassifyAnalyzeForTest(async (titles: string[]): Promise<CuratedAnalysisResult[]> => {
    calls++;
    if (calls === 1) throw new Error('simulated provider timeout');
    return titles.map((title) => ({
      title,
      is_relevant: true,
      priority_score: 80,
      category: 'Defense',
      region: 'Global' as const,
      country: null,
      primaryTopic: 'Military Operations & Armed Conflict' as const,
      scope: 'strategic' as const,
      conflictTrack: null,
      countryPair: null,
      proposedTopic: null,
    }));
  });

  try {
    const result = await backfillCuratedClassifications();
    assert(calls === 2, `Both batches were attempted (got ${calls})`);
    assert(result.classified === 5, `Later 5-item batch survived first-batch failure (got ${result.classified})`);
  } finally {
    __setClassifyAnalyzeForTest(null);
    restoreStorageMethods(saved);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`[curated-classify-lag] FAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('[curated-classify-lag] PASS — all checks passed.');
process.exit(0);
