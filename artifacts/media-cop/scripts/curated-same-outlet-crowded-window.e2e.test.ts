/**
 * End-to-end regression (Task #717): a same-outlet re-emit is BLOCKED at ingest
 * even when 5+ OTHER outlets have already filled the cross-outlet similarity
 * window for a breaking event.
 *
 * The same-article fuzzy de-dupe (Task #602, isSameArticleDuplicate) is already
 * unit-tested in curated-ingest-dedup.test.ts, and Task #708 added an UNBOUNDED
 * same-outlet similarity query (getSimilarCuratedItemsForOutlet) so a re-emit at
 * a different URL is never crowded out of the top-5 cross-outlet window by a busy
 * event. But nothing exercised the two queries WIRED TOGETHER through the real
 * admitCuratedCandidates ingest loop — the merge/union call site (curatedIngest
 * lines ~657-673). A regression there (e.g. dropping the outlet-specific query,
 * or breaking the union) would be SILENT until a duplicate surfaced in prod.
 *
 * This test drives the REAL admitCuratedCandidates against an in-memory curated
 * store. The two similarity storage methods are backed by the store using the
 * REAL DatabaseStorage.calculateSimilarity (reused off the singleton, so no math
 * drift) with the exact same semantics as production (>0.85 threshold, top-5
 * slice for the cross-outlet pass, unbounded for the same-outlet pass).
 *
 * Scenario:
 *   - Seed 5 near-identical rows for ONE breaking event from 5 DIFFERENT outlets
 *     (they fill the top-5 cross-outlet window at similarity 1.0).
 *   - Seed a 6th row: the SAME outlet (Reuters) re-emitting the story at a
 *     slightly different wording + URL, whose similarity ranks it #6 — CROWDED
 *     OUT of the top-5 cross-outlet window.
 *   - Precondition checks prove the crowding: the cross-outlet top-5 EXCLUDES the
 *     Reuters re-emit, while the unbounded same-outlet pass INCLUDES it.
 *   - Admit a NEW Reuters candidate (same outlet as the crowded-out row, new
 *     URL): it must be REJECTED as a fuzzy-dup — the union rescued the same-outlet
 *     row so isSameArticleDuplicate can see it.
 *   - Admit a candidate from a BRAND-NEW outlet: it must be ADMITTED as a
 *     separate corroboration node.
 *
 * No test framework configured — run directly with tsx:
 *   npx tsx scripts/curated-same-outlet-crowded-window.e2e.test.ts
 * Exits non-zero on any failure.
 */
import { storage } from '../server/storage';
import { admitCuratedCandidates } from '../server/curatedIngest';
import { normalizeTitle } from '../server/titleNormalizer';
import type { CuratedItem, InsertCuratedItem } from '@shared/schema';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[same-outlet-crowded-e2e] OK   ${name}`);
  } else {
    console.error(`[same-outlet-crowded-e2e] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// The real Levenshtein similarity used by DatabaseStorage — reused off the
// singleton (it is a private instance method at TS level, present at runtime) so
// the in-memory store's similarity ranking can NEVER drift from production.
const realSim: (a: string, b: string) => number =
  (storage as any).calculateSimilarity.bind(storage);

const CURATED_WINDOW_HOURS = 48;
// Anchor the fixture to the REAL current time. Both the similarity stubs below
// and the production admit path derive their recency cutoff from Date.now(), so a
// hardcoded calendar date silently ages every seeded row out of the window once
// wall-clock time passes it — a time-bomb that flips this gate red days later with
// no code change. Seeding at "now" keeps the rows inside the window on every run.
const NOW = new Date();

// ---------------------------------------------------------------------------
// In-memory curated store + faithful storage stubs.
// ---------------------------------------------------------------------------
const memStore: CuratedItem[] = [];
let idSeq = 0;

function makeCuratedRow(source: string, title: string, url: string): CuratedItem {
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
    scrapedAt: NOW,
    articlePublishedAt: NOW,
    tags: [],
    linkDeadAt: null,
    linkCheckedAt: null,
  } as CuratedItem;
}

function seed(source: string, title: string, url: string): CuratedItem {
  const row = makeCuratedRow(source, title, url);
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
  // Empty registry → every outlet resolves to attach-only (fail-closed, never
  // blocked) and the stored source stays the raw provided name (no canonical
  // remap), so the same-outlet match keys on the literal "Reuters".
  (storage as any).getOutletRegistry = async () => [];
  // Fail-closed learned-rules lookups (no DB).
  (storage as any).getCuratedLearnedRules = async () => [];

  (storage as any).getCuratedItemByUrl = async (url: string) =>
    memStore.find(i => i.url === url);

  // Cross-outlet similarity — EXACT production semantics: >0.85, sorted desc,
  // top-5 only. This is where the same-outlet #6 row is CROWDED OUT.
  (storage as any).getSimilarCuratedItems = async (normalizedTitle: string, hours: number) => {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return memStore
      .filter(i => i.scrapedAt.getTime() >= cutoff)
      .map(i => ({ item: i, similarity: realSim(i.normalizedTitle, normalizedTitle) }))
      .filter(x => x.similarity > 0.85)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
      .map(x => x.item);
  };

  // Same-outlet similarity — EXACT production semantics: >0.85, UNBOUNDED (no
  // top-N cap), filtered to the candidate's outlet. This is the rescue lane.
  (storage as any).getSimilarCuratedItemsForOutlet = async (
    source: string,
    normalizedTitle: string,
    hours: number,
  ) => {
    if (!source) return [];
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return memStore.filter(
      i =>
        i.scrapedAt.getTime() >= cutoff &&
        i.source === source &&
        realSim(i.normalizedTitle, normalizedTitle) > 0.85,
    );
  };

  // Task #1105: the admit path now reads the WHOLE store window once (lean
  // identity projection) and runs both similarity passes in memory. Serve it
  // from the same in-memory store so the union/crowd-out behavior under test
  // exercises the production in-memory code path.
  (storage as any).getCuratedDedupCorpus = async (hours: number) => {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return memStore
      .filter(i => i.scrapedAt.getTime() >= cutoff.getTime())
      .map(i => ({ url: i.url, source: i.source, normalizedTitle: i.normalizedTitle, scrapedAt: i.scrapedAt }));
  };

  (storage as any).addCuratedItem = async (insert: InsertCuratedItem, normalizedTitle: string) => {
    const row = makeCuratedRow(insert.source, insert.title, insert.url);
    row.normalizedTitle = normalizedTitle;
    row.role = insert.role ?? 'attach-only';
    row.priorityScore = insert.priorityScore ?? 50;
    memStore.push(row);
    return row;
  };

  // Defensive: reuse-mode intake never populates the overlay, but stub so an
  // accidental DB call can never happen.
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

async function run() {
  installStubs();

  // -------------------------------------------------------------------------
  // Fixture: one breaking event, 5 different outlets fill the top-5 window.
  // -------------------------------------------------------------------------
  const EVENT_TITLE = 'US and Iran nuclear talks collapse after final Geneva round';
  const CROWD_OUTLETS = [
    { source: 'Associated Press', url: 'https://apnews.com/article/iran-us-nuclear-geneva-1' },
    { source: 'BBC News', url: 'https://www.bbc.com/news/world-iran-us-geneva-2' },
    { source: 'Al Jazeera', url: 'https://www.aljazeera.com/news/2026/7/10/iran-us-geneva-3' },
    { source: 'Deutsche Welle', url: 'https://www.dw.com/en/iran-us-geneva/a-4' },
    { source: 'France 24', url: 'https://www.france24.com/en/iran-us-geneva-5' },
  ];
  for (const o of CROWD_OUTLETS) seed(o.source, EVENT_TITLE, o.url);

  // The SAME outlet (Reuters) already re-emitted the story once, at a slightly
  // reworded title + different URL, so its similarity ranks it BELOW the five
  // byte-identical cross-outlet rows → crowded out of the top-5.
  const REUTERS_STORED_TITLE = 'US and Iran nuclear talks collapse in final Geneva round';
  const reutersStored = seed(
    'Reuters',
    REUTERS_STORED_TITLE,
    'https://www.reuters.com/world/middle-east/us-iran-nuclear-talks-collapse-2026-07-10',
  );

  const candNorm = normalizeTitle(EVENT_TITLE);

  // --- PRECONDITION 1: the Reuters re-emit really is a >0.85 near-dupe but
  //     ranks strictly below the five identical cross-outlet rows.
  const reutersSim = realSim(reutersStored.normalizedTitle, candNorm);
  check(
    'P1 the Reuters re-emit is a >0.85 near-dupe of the event (dedup-eligible)',
    reutersSim > 0.85,
    `sim=${reutersSim.toFixed(4)}`,
  );
  check(
    'P1 the Reuters re-emit ranks BELOW the five identical cross-outlet rows',
    reutersSim < 1.0,
    `sim=${reutersSim.toFixed(4)}`,
  );

  // --- PRECONDITION 2: the cross-outlet top-5 CROWDS OUT the Reuters row, while
  //     the unbounded same-outlet pass RESCUES it. This is the exact split the
  //     admit call site must union back together.
  const crossTop5 = await storage.getSimilarCuratedItems(candNorm, CURATED_WINDOW_HOURS);
  check(
    'P2 cross-outlet similarity returns exactly the top-5 window',
    crossTop5.length === 5,
    `len=${crossTop5.length}`,
  );
  check(
    'P2 the Reuters re-emit is CROWDED OUT of the cross-outlet top-5 window',
    !crossTop5.some(i => i.id === reutersStored.id),
  );
  const outletPass = await storage.getSimilarCuratedItemsForOutlet(
    'Reuters',
    candNorm,
    CURATED_WINDOW_HOURS,
  );
  check(
    'P2 the unbounded same-outlet pass RESCUES the crowded-out Reuters re-emit',
    outletPass.some(i => i.id === reutersStored.id),
  );

  const storeSizeBeforeReuters = memStore.length;

  // -------------------------------------------------------------------------
  // ACT 1: a NEW Reuters candidate (same outlet, DIFFERENT URL) arrives during
  // the wave. It must be REJECTED as a fuzzy-dup — the admit loop's union of the
  // two similarity queries surfaced the crowded-out same-outlet row.
  // -------------------------------------------------------------------------
  const reutersResult = await admitCuratedCandidates(
    [
      {
        // Same outlet re-emitting the identical syndicated headline at a NEW URL
        // during the wave. Its normalized title matches the event, so the
        // cross-outlet window (5 identical rows) crowds out the earlier Reuters
        // row — ONLY the unbounded same-outlet pass surfaces it for the dedup.
        title: EVENT_TITLE,
        url: 'https://www.reuters.com/markets/us-iran-nuclear-talks-collapse-2026-07-10-v2',
        source: 'Reuters',
        pubDate: NOW,
        summary: '',
      },
    ],
    { mode: 'reuse', label: 'test-717-reuters' },
  );
  check(
    'A1 same-outlet re-emit at a new URL is REJECTED (ingested 0)',
    reutersResult.ingested === 0,
    JSON.stringify(reutersResult),
  );
  check(
    'A1 same-outlet re-emit is counted as skipped',
    reutersResult.skipped === 1,
    JSON.stringify(reutersResult),
  );
  check(
    'A1 the rejected re-emit was NOT written to the curated store',
    memStore.length === storeSizeBeforeReuters,
    `before=${storeSizeBeforeReuters} after=${memStore.length}`,
  );

  // -------------------------------------------------------------------------
  // ACT 2: a candidate from a BRAND-NEW outlet (not yet in the store) covering
  // the SAME event must be ADMITTED — an independent outlet is a corroboration
  // node, never a duplicate.
  // -------------------------------------------------------------------------
  const kyodoUrl = 'https://english.kyodonews.net/news/2026/07/10/us-iran-nuclear-talks-geneva';
  const kyodoResult = await admitCuratedCandidates(
    [
      {
        title: 'US and Iran nuclear talks break down after final Geneva round',
        url: kyodoUrl,
        source: 'Kyodo News',
        pubDate: NOW,
        summary: '',
      },
    ],
    { mode: 'reuse', label: 'test-717-kyodo' },
  );
  check(
    'A2 a brand-new outlet covering the same event is ADMITTED (ingested 1)',
    kyodoResult.ingested === 1,
    JSON.stringify(kyodoResult),
  );
  check(
    'A2 the admitted corroboration node was written to the curated store',
    memStore.some(i => i.url === kyodoUrl && i.source === 'Kyodo News'),
  );

  restoreStubs();
}

run()
  .then(() => {
    if (failures > 0) {
      console.error(`\n[same-outlet-crowded-e2e] ${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log('\n[same-outlet-crowded-e2e] all checks passed');
    process.exit(0);
  })
  .catch(err => {
    console.error('[same-outlet-crowded-e2e] threw:', err);
    process.exit(1);
  });
