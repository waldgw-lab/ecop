/**
 * End-to-end regression (Task #776): lock in the TWO-SIDED behavior of the
 * same-outlet re-emit window at curated ingest.
 *
 * The curated dedup uses two different lookback windows (Task #718):
 *   - cross-outlet similarity: 48h (CURATED_WINDOW_HOURS), top-5 ranked
 *   - same-outlet re-emit rescue: 12h (CURATED_OUTLET_REEMIT_WINDOW_HOURS),
 *     unbounded
 *
 * The existing gate (curated-same-outlet-crowded-window.e2e.test.ts) only
 * exercises the everything-inside-12h case. This test guards the BOUNDARY:
 *
 *   OUTSIDE: a same-outlet, different-URL, near-identical headline arriving
 *   ~13.5h after the stored copy must be ADMITTED — the 12h rescue window
 *   intentionally excludes the old row, so a legitimate day-later follow-up
 *   is a new node. If a future change widens the window (or the call site
 *   silently starts passing 48h), this check goes red.
 *
 *   INSIDE: the same scenario with the stored copy only ~6h old must stay
 *   REJECTED — if a future change narrows the window (or drops the
 *   same-outlet query from the union), THIS check goes red.
 *
 * In both scenarios, 5 OTHER outlets have byte-identical rows at "now" so the
 * cross-outlet top-5 window is fully crowded — the stored same-outlet row can
 * ONLY be seen through the same-outlet rescue query. That isolates the window
 * as the single deciding variable.
 *
 * All timestamps are new Date()-anchored offsets — NEVER hardcoded calendar
 * dates (see fixture-wall-clock-timebombs memory).
 *
 * No test framework configured — run directly with tsx:
 *   npx tsx scripts/curated-same-outlet-reemit-window.e2e.test.ts
 * Exits non-zero on any failure.
 */
import { storage } from '../server/storage';
import { admitCuratedCandidates } from '../server/curatedIngest';
import { normalizeTitle } from '../server/titleNormalizer';
import type { CuratedItem, InsertCuratedItem } from '@shared/schema';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[reemit-window-e2e] OK   ${name}`);
  } else {
    console.error(`[reemit-window-e2e] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// The real Levenshtein similarity used by DatabaseStorage — reused off the
// singleton so the in-memory ranking can never drift from production.
const realSim: (a: string, b: string) => number =
  (storage as any).calculateSimilarity.bind(storage);

// Anchor everything to the REAL current time; ages are relative offsets.
const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// In-memory curated store + faithful storage stubs (same semantics as the
// sibling crowded-window e2e: >0.85 threshold, top-5 cross-outlet slice,
// unbounded same-outlet pass, both cutoff-filtered by the hours they are
// CALLED with — so the production window constants drive the outcome).
// ---------------------------------------------------------------------------
let memStore: CuratedItem[] = [];
let idSeq = 0;
// Captured from the admit path so we can prove which window it actually used.
let lastOutletQueryHours: number | null = null;
// Captured from the batched-corpus read (Task #1105) — proves the in-memory
// dedup pass was fed the full 48h store window.
let lastCorpusQueryHours: number | null = null;

function makeCuratedRow(source: string, title: string, url: string, scrapedAt: Date): CuratedItem {
  return {
    id: `seed-${++idSeq}`,
    title,
    normalizedTitle: normalizeTitle(title),
    url,
    category: 'general',
    region: null,
    country: null,
    source,
    summary: '',
    summaryBullets: null,
    attributedClaims: null,
    ogImageUrl: null,
    contentKind: null,
    mediaScrapedAt: null,
    mediaAttemptCount: 0,
    lastMediaAttemptAt: null,
    mediaRescueAt: null,
    priorityScore: 60,
    role: 'contributing',
    clusterId: null,
    scrapedAt,
    articlePublishedAt: scrapedAt,
    tags: [],
    linkDeadAt: null,
    linkCheckedAt: null,
  } as CuratedItem;
}

function seed(source: string, title: string, url: string, scrapedAt: Date): CuratedItem {
  const row = makeCuratedRow(source, title, url, scrapedAt);
  memStore.push(row);
  return row;
}

const orig = {
  getOutletRegistry: storage.getOutletRegistry,
  getCuratedLearnedRules: storage.getCuratedLearnedRules,
  getCuratedItemByUrl: storage.getCuratedItemByUrl,
  getSimilarCuratedItems: storage.getSimilarCuratedItems,
  getSimilarCuratedItemsForOutlet: storage.getSimilarCuratedItemsForOutlet,
  getCuratedDedupCorpus: (storage as any).getCuratedDedupCorpus,
  addCuratedItem: storage.addCuratedItem,
  getCuratedClassificationsByUrls: storage.getCuratedClassificationsByUrls,
  upsertCuratedClassifications: storage.upsertCuratedClassifications,
  recordClassificationProposal: storage.recordClassificationProposal,
};

function installStubs() {
  (storage as any).getOutletRegistry = async () => [];
  (storage as any).getCuratedLearnedRules = async () => [];
  (storage as any).getCuratedItemByUrl = async (url: string) =>
    memStore.find(i => i.url === url);

  // Cross-outlet: >0.85, sorted desc, top-5 — cutoff from the CALLER's hours.
  (storage as any).getSimilarCuratedItems = async (normalizedTitle: string, hours: number) => {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return memStore
      .filter(i => i.scrapedAt.getTime() >= cutoff.getTime())
      .map(i => ({ item: i, similarity: realSim(i.normalizedTitle, normalizedTitle) }))
      .filter(x => x.similarity > 0.85)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
      .map(x => x.item);
  };

  // Same-outlet: >0.85, UNBOUNDED, outlet-filtered — cutoff from the CALLER's
  // hours. This is where the production 12h re-emit window bites.
  (storage as any).getSimilarCuratedItemsForOutlet = async (
    source: string,
    normalizedTitle: string,
    hours: number,
  ) => {
    lastOutletQueryHours = hours;
    if (!source) return [];
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return memStore.filter(
      i =>
        i.scrapedAt.getTime() >= cutoff.getTime() &&
        i.source === source &&
        realSim(i.normalizedTitle, normalizedTitle) > 0.85,
    );
  };

  // Task #1105: the admit path now reads the WHOLE store window once (lean
  // identity projection) and runs both similarity passes in memory. Serve it
  // from the same in-memory store; record the hours it was called with so the
  // test can prove the corpus covers the full 48h window (the 12h same-outlet
  // re-emit cut is applied INSIDE the ingest loop and is proven behaviorally
  // by scenarios A/B below).
  (storage as any).getCuratedDedupCorpus = async (hours: number) => {
    lastCorpusQueryHours = hours;
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return memStore
      .filter(i => i.scrapedAt.getTime() >= cutoff.getTime())
      .map(i => ({ url: i.url, source: i.source, normalizedTitle: i.normalizedTitle, scrapedAt: i.scrapedAt }));
  };

  (storage as any).addCuratedItem = async (insert: InsertCuratedItem, normalizedTitle: string) => {
    const row = makeCuratedRow(insert.source, insert.title, insert.url, NOW);
    row.normalizedTitle = normalizedTitle;
    row.role = insert.role ?? 'attach-only';
    row.priorityScore = insert.priorityScore ?? 50;
    memStore.push(row);
    return row;
  };

  (storage as any).getCuratedClassificationsByUrls = async () => new Map();
  (storage as any).upsertCuratedClassifications = async () => {};
  (storage as any).recordClassificationProposal = async () => {};
  // Admission telemetry is a fire-and-forget write-through — stub it or every
  // run leaks synthetic per-source rows into the real curated_intake_telemetry
  // table (which the telemetry gate then reads). Stub EVERY persistence seam.
  (storage as any).upsertCuratedIntakeTelemetry = async () => {};
  (storage as any).mergeCuratedIntakeFeedStats = async () => {};
}

function restoreStubs() {
  Object.assign(storage as any, orig);
}

// ---------------------------------------------------------------------------
// Shared scenario builder: one breaking event, 5 different outlets crowd the
// top-5 cross-outlet window at "now", plus ONE stored Reuters near-dupe row
// aged `storedAgeHours` into the past. Returns the stored Reuters row.
// ---------------------------------------------------------------------------
const EVENT_TITLE = 'US and Iran nuclear talks collapse after final Geneva round';
const REUTERS_STORED_TITLE = 'US and Iran nuclear talks collapse in final Geneva round';

function buildScenario(storedAgeHours: number, urlTag: string): CuratedItem {
  memStore = [];
  const crowd = [
    { source: 'Associated Press', url: `https://apnews.com/article/iran-us-geneva-${urlTag}-1` },
    { source: 'BBC News', url: `https://www.bbc.com/news/world-iran-us-geneva-${urlTag}-2` },
    { source: 'Al Jazeera', url: `https://www.aljazeera.com/news/iran-us-geneva-${urlTag}-3` },
    { source: 'Deutsche Welle', url: `https://www.dw.com/en/iran-us-geneva-${urlTag}/a-4` },
    { source: 'France 24', url: `https://www.france24.com/en/iran-us-geneva-${urlTag}-5` },
  ];
  for (const o of crowd) seed(o.source, EVENT_TITLE, o.url, NOW);
  return seed(
    'Reuters',
    REUTERS_STORED_TITLE,
    `https://www.reuters.com/world/middle-east/us-iran-geneva-${urlTag}-stored`,
    hoursAgo(storedAgeHours),
  );
}

async function admitReutersReemit(urlTag: string) {
  return admitCuratedCandidates(
    [
      {
        title: EVENT_TITLE,
        url: `https://www.reuters.com/markets/us-iran-geneva-${urlTag}-reemit`,
        source: 'Reuters',
        pubDate: NOW,
        summary: '',
      },
    ],
    { mode: 'reuse', label: `test-776-${urlTag}` },
  );
}

async function run() {
  installStubs();
  const candNorm = normalizeTitle(EVENT_TITLE);

  // ==========================================================================
  // SCENARIO A — OUTSIDE the re-emit window: stored Reuters row is ~13.5h old.
  // ==========================================================================
  const storedOld = buildScenario(13.5, 'outside');

  // Preconditions: the crowding is real, and the stored row is visible only
  // through the same-outlet query — and only when the window reaches it.
  const simOld = realSim(storedOld.normalizedTitle, candNorm);
  check('A-P near-dupe but ranks below the 5 identical crowd rows',
    simOld > 0.85 && simOld < 1.0, `sim=${simOld.toFixed(4)}`);
  const crossTop5 = await storage.getSimilarCuratedItems(candNorm, 48);
  check('A-P stored Reuters row is CROWDED OUT of the cross-outlet top-5',
    crossTop5.length === 5 && !crossTop5.some(i => i.id === storedOld.id));
  const in12h = await storage.getSimilarCuratedItemsForOutlet('Reuters', candNorm, 12);
  const in48h = await storage.getSimilarCuratedItemsForOutlet('Reuters', candNorm, 48);
  check('A-P a 12h same-outlet window EXCLUDES the 13.5h-old row',
    !in12h.some(i => i.id === storedOld.id), `len=${in12h.length}`);
  check('A-P a 48h same-outlet window WOULD include it (window is the only gate)',
    in48h.some(i => i.id === storedOld.id));

  // ACT: a fresh Reuters re-emit at a new URL, 13.5h after the stored copy,
  // must be ADMITTED as a new node — a legitimate day-later follow-up.
  lastCorpusQueryHours = null;
  const sizeBefore = memStore.length;
  const outsideResult = await admitReutersReemit('outside');
  check('A1 day-later same-outlet re-emit is ADMITTED (ingested 1)',
    outsideResult.ingested === 1, JSON.stringify(outsideResult));
  check('A1 admitted row was written to the curated store',
    memStore.length === sizeBefore + 1);
  // Task #1105: the same-outlet 12h re-emit cut now happens IN MEMORY inside
  // the admit loop — the corpus read itself must span the full 48h window (so
  // the cross-outlet pass still sees everything), and the 13.5h-old Reuters
  // row being ADMITTED above proves the internal cut excludes it.
  check('A1 dedup corpus was read over the full 48h store window',
    lastCorpusQueryHours === 48, `hours=${lastCorpusQueryHours}`);

  // ==========================================================================
  // SCENARIO B — INSIDE the re-emit window: stored Reuters row is ~6h old.
  // ==========================================================================
  const storedRecent = buildScenario(6, 'inside');

  const crossTop5B = await storage.getSimilarCuratedItems(candNorm, 48);
  check('B-P stored Reuters row is CROWDED OUT of the cross-outlet top-5',
    crossTop5B.length === 5 && !crossTop5B.some(i => i.id === storedRecent.id));
  const in12hB = await storage.getSimilarCuratedItemsForOutlet('Reuters', candNorm, 12);
  check('B-P a 12h same-outlet window INCLUDES the 6h-old row',
    in12hB.some(i => i.id === storedRecent.id));

  // ACT: a fresh Reuters re-emit 6h after the stored copy must stay REJECTED —
  // the rescue window surfaces the stored row for the same-outlet fuzzy-dup.
  lastCorpusQueryHours = null;
  const sizeBeforeB = memStore.length;
  const insideResult = await admitReutersReemit('inside');
  check('B1 inside-window same-outlet re-emit is REJECTED (ingested 0)',
    insideResult.ingested === 0, JSON.stringify(insideResult));
  check('B1 rejected re-emit is counted as skipped',
    insideResult.skipped === 1, JSON.stringify(insideResult));
  check('B1 rejected re-emit was NOT written to the curated store',
    memStore.length === sizeBeforeB, `before=${sizeBeforeB} after=${memStore.length}`);
  // The 6h-old row being REJECTED proves the in-memory same-outlet window
  // reaches it (Task #1105 moved the 12h cut inside the admit loop).
  check('B1 dedup corpus was read over the full 48h store window',
    lastCorpusQueryHours === 48, `hours=${lastCorpusQueryHours}`);

  restoreStubs();
}

run()
  .then(() => {
    if (failures > 0) {
      console.error(`\n[reemit-window-e2e] ${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log('\n[reemit-window-e2e] all checks passed');
    process.exit(0);
  })
  .catch(err => {
    console.error('[reemit-window-e2e] threw:', err);
    process.exit(1);
  });
