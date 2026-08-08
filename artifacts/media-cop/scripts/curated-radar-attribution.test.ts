/**
 * Gate: curated-radar-attribution (Task #834 follow-through)
 *
 * Proves the Scoring Radar's per-item "why is this not surfacing" reason
 * attribution matches the REAL display gates. Regression guards:
 *   - `deriveOutletBehavior(outlet)` (a BehaviorResult OBJECT) compared
 *     directly to the string 'contributing' — always unequal — so every item
 *     from a KNOWN outlet was misclassified as attach-only, the pass-gate
 *     collected nothing, and the cut line collapsed to 0.
 *   - Cluster membership keyed off `m.source` (the OUTLET name column) instead
 *     of `m.itemType` — the in-cluster set was always empty, so clustered
 *     items leaked into the radar list.
 *   - MAIN-feed lane coverage: Top Stories standalone candidates are the UNION
 *     of getPrimaryFeed + the curated store; the radar must include main rows
 *     (deduped by identity URL against their curated twins) or it lies by
 *     omission. Main rows are exempt from the curated-only seeding gate.
 *   - Priority-override telemetry: an ORGANIC pin (no client-sent scoring
 *     context) must get rawScore/decayedScore/itemAgeHours/surfacingState
 *     derived SERVER-SIDE before the override event is recorded.
 *   - DECAY PARITY (Task #834 third review): the radar's decayedScore must be
 *     computed by the SAME `calculateDepreciatedPriority` the live standalone
 *     display path uses — 2h grace window (fresh item decayed == raw), floor
 *     20 (never 1), and an active override DECAYS on the same curve (pins are
 *     NOT decay-exempt). Main-lane rows stay pre-decayed (never re-decayed).
 *   - SINGLE-FLIGHT: concurrent cold-cache radar GETs (no x-mcop-no-cache)
 *     coalesce onto ONE compute (one getOutletRegistry read for N requests).
 *
 * Drives the REAL Express handlers in-process (registerRoutes +
 * server.listen(0), storage singleton shadowed with an in-memory fixture,
 * NODE_ENV unset under tsx so curated auth dev-bypasses, x-mcop-no-cache
 * header skips the radar cache). No DB writes, no network, no AI.
 *
 * Curated fixtures → expected surfacingState:
 *   - Reuters (registry: news-international/high → role 'contributing'),
 *     enriched, fresh .......................... surfacing (NOT in radar items)
 *   - AP (contributing), enriched, fresh ....... surfacing (NOT in radar items)
 *   - Unknown outlet (no registry row, no stored role) ........... attach-only
 *   - RT (registry: news-international-cpc → anchor-only) ........ attach-only
 *   - Reuters video item (contentKind 'video') ................. opinion-video
 *   - Reuters stale item (older than the window) ....................  age-out
 *   - Reuters un-enriched item (no bullets, favicon image) ...... not-enriched
 *   - Reuters clustered item (cluster member row, itemType 'curated')
 *     ......................................... surfacing (NOT in radar items)
 * Main-feed fixtures:
 *   - Unknown-outlet main row .......................... attach-only, type main
 *   - Reuters stale main row ............................... age-out, type main
 *   - Main row sharing rad-7's URL ......... collapsed into the curated row
 *   - Reuters fresh un-enriched main row ... surfacing (seeding gate is
 *     curated-lane only — must NEVER be labeled 'not-enriched')
 *
 * Exit 0 = pass, 1 = fail. (Fully deterministic — no exit-3 path needed.)
 */
import express from 'express';
import type { AddressInfo } from 'net';
import { registerRoutes } from '../server/routes';
import { storage, calculateCuratedDepreciatedPriority } from '../server/storage';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[radar-attribution] OK   ${name}`);
  } else {
    console.error(`[radar-attribution] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// Anchor all ages to the live clock (never a hardcoded absolute date — stale
// fixtures go red days later as the window slides).
const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const hoursAhead = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

const REAL_IMG = 'https://www.reuters.com/img/story-photo.jpg';
const FAVICON_IMG = 'https://www.example.com/favicon.ico';
const BULLETS = ['First corroborated fact.', 'Second corroborated fact.'];

function registryRows(): any[] {
  return [
    {
      key: 'reuters', canonicalName: 'Reuters', aliases: [], domains: ['reuters.com'],
      sourceIdentifier: 'news-international', factuality: 'high',
      ownership: [], manualOverrides: {}, otherSourceType: null,
    },
    {
      key: 'associated-press', canonicalName: 'Associated Press', aliases: ['AP'], domains: ['apnews.com'],
      sourceIdentifier: 'news-international', factuality: 'high',
      ownership: [], manualOverrides: {}, otherSourceType: null,
    },
    {
      key: 'rt', canonicalName: 'RT', aliases: [], domains: ['rt.com'],
      sourceIdentifier: 'news-international-cpc', factuality: 'low',
      ownership: [], manualOverrides: {}, otherSourceType: null,
    },
  ];
}

type Fixture = { expect: 'surfacing' | 'attach-only' | 'opinion-video' | 'age-out' | 'not-enriched'; item: any };

const FIXTURES: Fixture[] = [
  {
    expect: 'surfacing',
    item: {
      id: 'rad-1', title: 'Iran and US resume nuclear talks in Geneva', source: 'Reuters',
      url: 'https://www.reuters.com/world/rad-1', priorityScore: 90,
      scrapedAt: hoursAgo(2), articlePublishedAt: hoursAgo(2),
      summaryBullets: BULLETS, ogImageUrl: REAL_IMG, contentKind: null, category: 'General', role: 'contributing',
    },
  },
  {
    expect: 'surfacing',
    item: {
      id: 'rad-2', title: 'US-Iran negotiations restart in final Geneva round', source: 'Associated Press',
      url: 'https://apnews.com/article/rad-2', priorityScore: 80,
      scrapedAt: hoursAgo(3), articlePublishedAt: hoursAgo(3),
      summaryBullets: BULLETS, ogImageUrl: REAL_IMG, contentKind: null, category: 'General', role: 'contributing',
    },
  },
  {
    expect: 'attach-only',
    item: {
      id: 'rad-3', title: 'Unregistered blog covers the Geneva talks', source: 'Random Defense Blog',
      url: 'https://random-defense-blog.example.com/rad-3', priorityScore: 85,
      scrapedAt: hoursAgo(2), articlePublishedAt: hoursAgo(2),
      summaryBullets: BULLETS, ogImageUrl: REAL_IMG, contentKind: null, category: 'General', role: null,
    },
  },
  {
    expect: 'attach-only',
    item: {
      id: 'rad-4', title: 'RT frames the Geneva talks as Western capitulation', source: 'RT',
      url: 'https://www.rt.com/news/rad-4', priorityScore: 85,
      scrapedAt: hoursAgo(2), articlePublishedAt: hoursAgo(2),
      summaryBullets: BULLETS, ogImageUrl: REAL_IMG, contentKind: null, category: 'General', role: 'anchor-only',
    },
  },
  {
    expect: 'opinion-video',
    item: {
      id: 'rad-5', title: 'WATCH: Geneva talks explained in 3 minutes', source: 'Reuters',
      url: 'https://www.reuters.com/video/rad-5', priorityScore: 85,
      scrapedAt: hoursAgo(2), articlePublishedAt: hoursAgo(2),
      summaryBullets: BULLETS, ogImageUrl: REAL_IMG, contentKind: 'video', category: 'General', role: 'contributing',
    },
  },
  {
    expect: 'age-out',
    item: {
      id: 'rad-6', title: 'Last week: Geneva talks preparation underway', source: 'Reuters',
      url: 'https://www.reuters.com/world/rad-6', priorityScore: 85,
      scrapedAt: hoursAgo(60), articlePublishedAt: hoursAgo(60),
      summaryBullets: BULLETS, ogImageUrl: REAL_IMG, contentKind: null, category: 'General', role: 'contributing',
    },
  },
  {
    expect: 'not-enriched',
    item: {
      id: 'rad-7', title: 'Breaking: new Geneva session announced', source: 'Reuters',
      url: 'https://www.reuters.com/world/rad-7', priorityScore: 85,
      scrapedAt: hoursAgo(1), articlePublishedAt: hoursAgo(1),
      summaryBullets: null, ogImageUrl: FAVICON_IMG, contentKind: null, category: 'General', role: 'contributing',
      // Rescue-lifecycle metadata the radar must surface for not-enriched rows.
      mediaAttemptCount: 2, lastMediaAttemptAt: hoursAgo(0.5),
    },
  },
  {
    // In an active cluster (member row below, keyed by itemType) → surfacing.
    // Regression guard: the old code keyed off m.source (the OUTLET name), so
    // the in-cluster set was ALWAYS empty and this row leaked into the radar.
    expect: 'surfacing',
    item: {
      id: 'rad-8', title: 'Geneva talks: allied statement issued', source: 'Reuters',
      url: 'https://www.reuters.com/world/rad-8', priorityScore: 88,
      scrapedAt: hoursAgo(2), articlePublishedAt: hoursAgo(2),
      summaryBullets: BULLETS, ogImageUrl: REAL_IMG, contentKind: null, category: 'General', role: 'contributing',
    },
  },
  {
    // DECAY-PARITY fixture: 6h old, un-enriched, with an ACTIVE priority
    // override (curated:rad-9 → 95, seeded in the overrides stub below). The
    // display path decays overrides on the same article-age curve — the radar
    // must show decayedScore == calculateDepreciatedPriority(95, …6h) (71),
    // NOT the undecayed pin (95). State stays not-enriched (seeding gate).
    expect: 'not-enriched',
    item: {
      id: 'rad-9', title: 'Pinned: Geneva side meeting on sanctions relief', source: 'Reuters',
      url: 'https://www.reuters.com/world/rad-9', priorityScore: 40,
      scrapedAt: hoursAgo(6), articlePublishedAt: hoursAgo(6),
      summaryBullets: null, ogImageUrl: FAVICON_IMG, contentKind: null, category: 'General', role: 'contributing',
    },
  },
  {
    // A trusted upstream timestamp can still be ahead of this server due to
    // clock/timezone skew. The Radar must use first-seen consistently for the
    // displayed age, recent-window gate, age-out state, and decay curve.
    expect: 'not-enriched',
    item: {
      id: 'rad-10', title: 'Jerusalem Post reports new regional security talks', source: 'Reuters',
      url: 'https://www.reuters.com/world/rad-10', priorityScore: 90,
      scrapedAt: hoursAgo(4), articlePublishedAt: hoursAhead(2),
      summaryBullets: null, ogImageUrl: FAVICON_IMG, contentKind: null, category: 'General', role: 'contributing',
    },
  },
];

// Main-feed lane fixtures (shape: Headline & { type, originalPriority,
// depreciatedPriority } — main scores arrive PRE-decayed from the pipeline).
type MainFixture = {
  expect: 'surfacing' | 'attach-only' | 'age-out' | 'url-deduped';
  item: any;
};
const MAIN_FIXTURES: MainFixture[] = [
  {
    expect: 'attach-only',
    item: {
      id: 'main-1', title: 'Unregistered wire recaps the Geneva talks', source: 'Random Wire Service',
      url: 'https://random-wire.example.com/main-1', priority: 82,
      type: 'scraped', originalPriority: 82, depreciatedPriority: 70,
      scrapedAt: hoursAgo(2), articlePublishedAt: hoursAgo(2),
      summaryBullets: BULLETS, ogImageUrl: REAL_IMG, category: 'General',
    },
  },
  {
    expect: 'age-out',
    item: {
      id: 'main-2', title: 'Reuters main-feed recap from last week', source: 'Reuters',
      url: 'https://www.reuters.com/world/main-2', priority: 84,
      type: 'scraped', originalPriority: 84, depreciatedPriority: 25,
      scrapedAt: hoursAgo(60), articlePublishedAt: hoursAgo(60),
      summaryBullets: BULLETS, ogImageUrl: REAL_IMG, category: 'General',
    },
  },
  {
    // Same article as curated rad-7 — must collapse into the curated row
    // (which carries enrichment state), never appear twice.
    expect: 'url-deduped',
    item: {
      id: 'main-3', title: 'Breaking: new Geneva session announced', source: 'Reuters',
      url: 'https://www.reuters.com/world/rad-7', priority: 85,
      type: 'scraped', originalPriority: 85, depreciatedPriority: 75,
      scrapedAt: hoursAgo(1), articlePublishedAt: hoursAgo(1),
      summaryBullets: null, ogImageUrl: FAVICON_IMG, category: 'General',
    },
  },
  {
    // Fresh, contributing, but NOT enriched (favicon image, no bullets). The
    // content-completeness seeding gate is CURATED-LANE ONLY — this main row
    // must surface, and must NEVER be labeled 'not-enriched'.
    expect: 'surfacing',
    item: {
      id: 'main-4', title: 'Reuters main-feed: Geneva talks continue', source: 'Reuters',
      url: 'https://www.reuters.com/world/main-4', priority: 85,
      type: 'scraped', originalPriority: 85, depreciatedPriority: 75,
      scrapedAt: hoursAgo(1), articlePublishedAt: hoursAgo(1),
      summaryBullets: null, ogImageUrl: FAVICON_IMG, category: 'General',
    },
  },
];

const CONTRIBUTING_SOURCES = new Set(['Reuters', 'Associated Press']);

async function main() {
  // Short-circuit the fire-and-forget Cyber-MCOP boot seed BEFORE registerRoutes
  // so it makes no DB write.
  (storage as any).getCustomMcopBySlug = async () => ({ id: 'stub', slug: 'stub' });

  const app = express();
  app.use(express.json());
  const server = await registerRoutes(app);

  // Shadow every read the radar handler touches (request-time reads, so
  // setting them after registerRoutes is fine).
  (storage as any).getCuratedStoreItems = async () => FIXTURES.map((f) => ({ ...f.item }));
  (storage as any).getPrimaryFeed = async () => MAIN_FIXTURES.map((f) => ({ ...f.item }));
  (storage as any).getCuratedClusterMembers = async () => [
    // Outlet name in `source` (the real column semantics) — the radar must key
    // off itemType, never source.
    {
      clusterId: 'cl-1', itemType: 'curated', itemId: 'rad-8', source: 'Reuters',
      url: 'https://www.reuters.com/world/rad-8', title: 'Geneva talks: allied statement issued',
      isRepresentative: true, createdAt: hoursAgo(1),
    },
  ];
  // rad-9 carries an ACTIVE pin — the decay-parity checks below prove the
  // radar decays it on the display curve instead of passing it through raw.
  (storage as any).getCuratedPriorityOverrides = async () =>
    new Map<string, number>([['curated:rad-9', 95]]);
  let registryReads = 0;
  (storage as any).getOutletRegistry = async () => {
    registryReads++;
    return registryRows();
  };

  // Priority-override fallback-derivation stubs: capture the recorded event,
  // no real writes.
  (storage as any).getCuratedItemsByIds = async (ids: string[]) => {
    const m = new Map<string, any>();
    for (const f of FIXTURES) if (ids.includes(f.item.id)) m.set(f.item.id, { ...f.item });
    return m;
  };
  (storage as any).setCuratedPriorityOverride = async () => {};
  (storage as any).getCuratedFeedbackSettings = async () => ({ capturePaused: false });
  let recordedEvent: any = null;
  (storage as any).recordCuratedOverrideEvent = async (e: any) => {
    recordedEvent = e;
    return 'evt-1';
  };

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const port = (server.address() as AddressInfo).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/curated/scoring-radar`, {
      headers: { 'x-mcop-no-cache': '1' },
    });
    check('endpoint responds 200', res.status === 200, `got ${res.status}`);
    const payload: any = await res.json();

    const items: any[] = Array.isArray(payload?.items) ? payload.items : [];
    const byId = new Map<string, any>(items.map((i) => [i.id, i]));

    // 1. The bug symptom: known contributing outlets misread as attach-only.
    const misattributed = items.filter(
      (i) => CONTRIBUTING_SOURCES.has(i.source) && i.surfacingState === 'attach-only',
    );
    check(
      'no known-contributing outlet item is labeled attach-only',
      misattributed.length === 0,
      misattributed.map((i) => `${i.id}:${i.source}`).join(', '),
    );

    // 2. Pass-gate actually collected the contributing items.
    check('cutLineScore > 0 (pass-gate non-empty)', (payload?.cutLineScore ?? 0) > 0, `got ${payload?.cutLineScore}`);
    check('surfacingCount >= 2 (both contributing items surface)', (payload?.surfacingCount ?? 0) >= 2, `got ${payload?.surfacingCount}`);

    // 3. Per-fixture reason attribution (curated lane).
    for (const f of FIXTURES) {
      const got = byId.get(f.item.id);
      if (f.expect === 'surfacing') {
        check(`${f.item.id} (${f.item.source}) surfaces — absent from radar list`, !got, got ? `present as ${got.surfacingState}` : '');
      } else {
        check(
          `${f.item.id} → ${f.expect}`,
          !!got && got.surfacingState === f.expect,
          got ? `got ${got.surfacingState}` : 'missing from radar items',
        );
      }
    }

    // 4. Main-feed lane coverage (Task #834 review finding 1).
    for (const f of MAIN_FIXTURES) {
      const got = byId.get(f.item.id);
      if (f.expect === 'surfacing' || f.expect === 'url-deduped') {
        check(`${f.item.id} (main) — absent from radar list (${f.expect})`, !got, got ? `present as ${got.surfacingState}` : '');
      } else {
        check(
          `${f.item.id} (main) → ${f.expect} with type 'main'`,
          !!got && got.surfacingState === f.expect && got.type === 'main',
          got ? `got ${got.surfacingState} / type ${got.type}` : 'missing from radar items',
        );
      }
    }
    // The URL-duplicate must have collapsed into the CURATED twin, which stays.
    const rad7 = byId.get('rad-7');
    check("url-dedup keeps the curated twin (rad-7, type 'curated')", !!rad7 && rad7.type === 'curated', rad7 ? `type ${rad7.type}` : 'rad-7 missing');
    // Seeding gate is curated-only: no MAIN row may ever read 'not-enriched'.
    const mainNotEnriched = items.filter((i) => i.type === 'main' && i.surfacingState === 'not-enriched');
    check('no main-lane item is labeled not-enriched', mainNotEnriched.length === 0, mainNotEnriched.map((i) => i.id).join(', '));

    // 5. Rescue-lifecycle metadata on not-enriched curated rows (finding 3).
    check(
      'rad-7 carries enrichmentAttempts from persisted back-off metadata',
      !!rad7 && rad7.enrichmentAttempts === 2,
      rad7 ? `got ${rad7.enrichmentAttempts}` : 'rad-7 missing',
    );
    check(
      'rad-7 carries lastEnrichmentAt',
      !!rad7 && !!rad7.lastEnrichmentAt,
      rad7 ? `got ${rad7.lastEnrichmentAt}` : 'rad-7 missing',
    );
    check(
      "rad-7 rescueStatus is null (no one-shot rescue ran) — field present",
      !!rad7 && 'rescueStatus' in rad7 && rad7.rescueStatus === null,
      rad7 ? `got ${JSON.stringify(rad7.rescueStatus)}` : 'rad-7 missing',
    );

    // 6. DECAY PARITY vs the LIVE scoring path (Task #834 third review): the
    //    radar's decayedScore must equal what `calculateDepreciatedPriority`
    //    (the display path's own helper) returns for the same inputs.
    const fixItem = (id: string) => FIXTURES.find((f) => f.item.id === id)!.item;
    const liveCurve = (score: number, it: any) =>
      calculateCuratedDepreciatedPriority(score, null, it.scrapedAt, null, it.articlePublishedAt).depreciatedPriority;
    // (a) 2h grace window: rad-7 is 1h old — decayed == raw. The old radar
    //     curve (10 pts/hr from hour 0) wrongly showed 75 here.
    check(
      'decay parity: rad-7 (1h) sits in the 2h grace — decayedScore == raw 85',
      !!rad7 && rad7.decayedScore === 85 && rad7.decayedScore === liveCurve(85, fixItem('rad-7')),
      rad7 ? `got ${rad7.decayedScore}` : 'rad-7 missing',
    );
    // (b) floor: rad-6 is 60h old — the live curve floors at 20, never 1.
    const rad6 = byId.get('rad-6');
    check(
      'decay parity: rad-6 (60h) hits the live-path floor 20 (not 1)',
      !!rad6 && rad6.decayedScore === 20 && rad6.decayedScore === liveCurve(85, fixItem('rad-6')),
      rad6 ? `got ${rad6.decayedScore}` : 'rad-6 missing',
    );
    // (c) override decay: rad-9 carries an ACTIVE pin (95) at 6h age. The
    //     display path decays pins on the CURATED tiered curve (Task #1129):
    //     P95 = critical band, 6h grace → at 6h the pin sits exactly at the
    //     grace boundary (still 95). Parity with the live helper is the
    //     contract; the pin-still-decays proof is the simulated 20h check below.
    const rad9 = byId.get('rad-9');
    const expected9 = liveCurve(95, fixItem('rad-9'));
    check(
      'decay parity: rad-9 pin 95 @6h matches the live curated curve',
      !!rad9 && rad9.decayedScore === expected9,
      rad9 ? `got ${rad9.decayedScore}, expected ${expected9}` : 'rad-9 missing',
    );
    // Pin decay is NOT exempt past the tiered grace: simulate a 20h-old pin.
    const simPin20h = calculateCuratedDepreciatedPriority(
      95, null, new Date(Date.now() - 20 * 3_600_000), null, new Date(Date.now() - 20 * 3_600_000),
    ).depreciatedPriority;
    check(
      'pin decay past tiered grace: 95 @20h cools below raw (critical band -4/hr)',
      simPin20h < 95 && simPin20h === 95 - 17 * 4,
      `got ${simPin20h}`,
    );
    check(
      'rad-9 priorityScore stays the RAW stored score (40)',
      !!rad9 && rad9.priorityScore === 40,
      rad9 ? `got ${rad9.priorityScore}` : 'rad-9 missing',
    );
    // (e) Future publication timestamp: fall back to first-seen rather than
    // reporting a negative age, treating it as perpetually recent, or skipping
    // its normal Curated decay. The item remains inside the 24h window.
    const rad10 = byId.get('rad-10');
    const expected10 = liveCurve(90, fixItem('rad-10'));
    check(
      'future publication timestamp never emits a negative Radar age',
      !!rad10 && rad10.itemAgeHours >= 0,
      rad10 ? `got ${rad10.itemAgeHours}h` : 'rad-10 missing',
    );
    check(
      'future publication timestamp falls back to its approximately 4h first-seen age',
      !!rad10 && rad10.itemAgeHours >= 3.8 && rad10.itemAgeHours <= 4.2,
      rad10 ? `got ${rad10.itemAgeHours}h` : 'rad-10 missing',
    );
    check(
      'future publication timestamp stays recent instead of age-out',
      !!rad10 && rad10.surfacingState === 'not-enriched',
      rad10 ? `got ${rad10.surfacingState}` : 'rad-10 missing',
    );
    check(
      'future publication timestamp uses first-seen for Curated decay parity',
      !!rad10 && rad10.decayedScore === expected10 && rad10.decayedScore < 90,
      rad10 ? `got ${rad10.decayedScore}, expected ${expected10}` : 'rad-10 missing',
    );
    // (d) main lane: pre-decayed pipeline score passes through UNCHANGED
    //     (re-decaying it here would double-decay).
    const main2 = byId.get('main-2');
    check(
      'main-2 decayedScore is the pre-decayed pipeline value (25) — never re-decayed',
      !!main2 && main2.decayedScore === 25,
      main2 ? `got ${main2.decayedScore}` : 'main-2 missing',
    );

    // 7. SINGLE-FLIGHT coalescing: every GET so far used x-mcop-no-cache,
    //    which neither reads NOR writes the cache — so the cache is COLD here.
    //    Three concurrent plain GETs must coalesce onto ONE compute: exactly
    //    one additional getOutletRegistry read, identical payloads.
    const readsBefore = registryReads;
    const [c1, c2, c3] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/curated/scoring-radar`),
      fetch(`http://127.0.0.1:${port}/api/curated/scoring-radar`),
      fetch(`http://127.0.0.1:${port}/api/curated/scoring-radar`),
    ]);
    check(
      'coalesced GETs all respond 200',
      c1.status === 200 && c2.status === 200 && c3.status === 200,
      `got ${c1.status}/${c2.status}/${c3.status}`,
    );
    const [p1, p2, p3] = await Promise.all([c1.json(), c2.json(), c3.json()]);
    check(
      'single-flight: 3 concurrent cold-cache GETs → exactly 1 compute',
      registryReads - readsBefore === 1,
      `registry reads delta ${registryReads - readsBefore}`,
    );
    check(
      'coalesced payloads are identical',
      JSON.stringify(p1) === JSON.stringify(p2) && JSON.stringify(p2) === JSON.stringify(p3),
    );

    // 8. ORGANIC priority-override (no client telemetry) gets scoring context
    //    derived SERVER-SIDE (finding 2). rad-7 is a live radar candidate, so
    //    the derived values must match the radar's own view of it.
    const pinRes = await fetch(`http://127.0.0.1:${port}/api/curated/priority-override`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'standalone', type: 'curated', id: 'rad-7', priorityScore: 90 }),
    });
    check('organic priority-override responds 200', pinRes.status === 200, `got ${pinRes.status}`);
    await pinRes.json().catch(() => null);
    check('override event recorded', !!recordedEvent, 'recordCuratedOverrideEvent never called');
    if (recordedEvent) {
      check('derived rawScore matches the item', recordedEvent.rawScore === 85, `got ${recordedEvent.rawScore}`);
      check('derived decayedScore is a number', typeof recordedEvent.decayedScore === 'number', `got ${JSON.stringify(recordedEvent.decayedScore)}`);
      check('derived itemAgeHours is a number', typeof recordedEvent.itemAgeHours === 'number', `got ${JSON.stringify(recordedEvent.itemAgeHours)}`);
      check("derived surfacingState is 'not-enriched'", recordedEvent.surfacingState === 'not-enriched', `got ${recordedEvent.surfacingState}`);
      check('organic pin is NOT flagged fromRadar', recordedEvent.fromRadar !== true, `got ${recordedEvent.fromRadar}`);
    }
  } finally {
    server.close();
  }

  if (failures > 0) {
    console.error(`\n[radar-attribution] ${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('\n[radar-attribution] All reason-attribution checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[radar-attribution] gate crashed:', err?.stack ?? err);
  process.exit(1);
});
