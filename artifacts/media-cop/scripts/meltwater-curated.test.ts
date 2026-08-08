// Meltwater curated bot — real-outlet attribution unit test.
//
// Meltwater is a DATA PIPE, not an outlet. Each document it yields must be
// ingested as an individual article attributed to its REAL publisher — exactly
// like every other curated intake — NOT collapsed into a generic "Meltwater"
// pseudo-outlet. This test drives the pure mapper (mapMeltwaterDoc) against the
// REAL outlet seed and asserts that:
//   - the "Meltwater" catch-all pseudo-outlets no longer exist in the registry;
//   - a known adversary outlet (RT) keeps its identity and reads as contrast;
//   - a trusted outlet (Reuters) is attributed to ITSELF (no longer forced to a
//     catch-all) and is NOT read as contrast;
//   - an unknown outlet rides in under its real name (unmatched → attach-only,
//     surfaced in Source Oversight → Coverage to be registered);
//   - a blank source name falls back to the domain / URL host so items are never
//     dropped and the registry can still resolve them by domain.
//
// DB-free, AI-free, quota-free: deterministic mapping + registry resolution only,
// so it is safe to run any time.
import {
  buildOutletIndex,
  findOutlet,
  deriveOutletBehavior,
} from '@shared/outletRegistry';
import { OUTLET_SEED } from '../server/outletRegistrySeed';
import {
  mapMeltwaterDoc,
  spreadCandidatesByOutlet,
  reconcileMeltwaterPubDate,
  parseDateFromUrl,
  MELTWATER_SEARCHES,
  type MeltwaterDoc,
} from '../server/meltwaterBot';
import type { CuratedIntakeCandidate } from '../server/curatedIngest';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS [${name}]`);
  } else {
    failed++;
    console.log(`FAIL [${name}]`);
  }
}

const index = buildOutletIndex(OUTLET_SEED as any);

// Resolve a candidate's displayed source the same way the curated lane does at
// read time (name first, url domain second) and derive its behavior.
function behaviorOf(source: string, url?: string | null) {
  const row = findOutlet(index, source, url);
  return { row, behavior: row ? deriveOutletBehavior(row as any) : null };
}

// ---------------------------------------------------------------------------
// 0. The legacy "Meltwater" catch-all pseudo-outlets must NOT exist anymore.
// ---------------------------------------------------------------------------
{
  check('no Meltwater news pseudo-outlet in registry', !findOutlet(index, 'Meltwater CPC/SWL/EPC', null));
  check('no Meltwater social pseudo-outlet in registry', !findOutlet(index, 'Meltwater Social CPC/SWL/EPC', null));
  check('no bare "Meltwater" outlet in registry', !findOutlet(index, 'Meltwater', null));
}

// ---------------------------------------------------------------------------
// 1. A real -cpc outlet (RT) keeps its identity AND reads as contrast.
// ---------------------------------------------------------------------------
{
  const doc: MeltwaterDoc = {
    url: 'https://www.rt.com/news/123456-some-adversary-take/',
    content_type: 'news',
    published_date: new Date().toISOString(),
    content: { title: 'Adversary framing of a strike', body: 'Body text.' },
    source: { name: 'RT', domain: 'rt.com' },
  };
  const c = mapMeltwaterDoc(doc)!;
  check('RT: candidate produced', !!c);
  check('RT: attributed to its real outlet name', c.source === 'RT');
  const b = behaviorOf(c.source, c.url);
  check('RT: resolves to the RT registry row', b.row?.canonicalName === 'RT');
  check('RT: derives to contrast', b.behavior?.label === 'contrast');
}

// ---------------------------------------------------------------------------
// 1b. A blank source.name falls back to the domain and still resolves by it.
// ---------------------------------------------------------------------------
{
  const doc: MeltwaterDoc = {
    url: 'https://www.rt.com/news/777777-no-name-take/',
    content_type: 'news',
    published_date: new Date().toISOString(),
    content: { title: 'Adversary take with no source name' },
    source: { name: '', domain: 'rt.com' },
  };
  const c = mapMeltwaterDoc(doc)!;
  check('RT (no name): candidate produced (not dropped)', !!c);
  check('RT (no name): falls back to a non-empty identity', !!c.source && c.source.length > 0);
  check('RT (no name): still resolves to RT via domain', behaviorOf(c.source, c.url).row?.canonicalName === 'RT');
  check('RT (no name): derives to contrast', behaviorOf(c.source, c.url).behavior?.label === 'contrast');
}

// ---------------------------------------------------------------------------
// 1c. No source object at all → falls back to the article URL host (www stripped).
// ---------------------------------------------------------------------------
{
  const doc: MeltwaterDoc = {
    url: 'https://www.rt.com/news/888888-host-only/',
    content_type: 'news',
    content: { title: 'Adversary take, host-only attribution' },
    source: null,
  };
  const c = mapMeltwaterDoc(doc)!;
  check('host-only: candidate produced', !!c);
  check('host-only: source is the URL host (www stripped)', c.source === 'rt.com');
  check('host-only: resolves to RT via domain → contrast', behaviorOf(c.source, c.url).behavior?.label === 'contrast');
}

// ---------------------------------------------------------------------------
// 2. A TRUSTED outlet (Reuters) is attributed to ITSELF — no longer forced to a
//    catch-all — so it resolves to its own row and is NOT read as contrast.
// ---------------------------------------------------------------------------
{
  const doc: MeltwaterDoc = {
    url: 'https://www.reuters.com/world/some-wire-report-2026/',
    content_type: 'news',
    published_date: new Date().toISOString(),
    content: { title: 'Wire report picked up by the saved search', opening_text: 'Lead.' },
    source: { name: 'Reuters', domain: 'reuters.com' },
  };
  const c = mapMeltwaterDoc(doc)!;
  check('Reuters: attributed to its real outlet name', c.source === 'Reuters');
  check('Reuters: not forced to any "Meltwater" pseudo-outlet', c.source !== 'Meltwater CPC/SWL/EPC');
  const b = behaviorOf(c.source, c.url);
  check('Reuters: resolves to the Reuters registry row', b.row?.canonicalName === 'Reuters');
  check('Reuters: does NOT read as contrast', b.behavior?.label !== 'contrast');
}

// ---------------------------------------------------------------------------
// 3. An UNKNOWN outlet rides in under its real name (unmatched → attach-only,
//    surfaced in Source Oversight → Coverage to be registered).
// ---------------------------------------------------------------------------
{
  const doc: MeltwaterDoc = {
    url: 'https://some-unknown-blog.example/post/abc',
    content_type: 'news',
    published_date: new Date().toISOString(),
    content: { title: 'Unknown outlet take' },
    source: { name: 'Some Unknown Blog', domain: 'some-unknown-blog.example' },
  };
  const c = mapMeltwaterDoc(doc)!;
  check('Unknown: attributed to its real name', c.source === 'Some Unknown Blog');
  check('Unknown: does NOT resolve to any registry row (→ attach-only + Coverage)', !findOutlet(index, c.source, c.url));
}

// ---------------------------------------------------------------------------
// 4. SOCIAL content is attributed to its real handle/outlet, not a catch-all.
// ---------------------------------------------------------------------------
{
  const doc: MeltwaterDoc = {
    url: 'https://x.com/someacct/status/999',
    content_type: 'social media',
    published_date: new Date().toISOString(),
    content: { title: 'A social post surfaced by the saved search' },
    source: { name: 'Some Account', domain: 'x.com' },
  };
  const c = mapMeltwaterDoc(doc)!;
  check('Social: attributed to its real name', c.source === 'Some Account');
  check('Social: not forced to any "Meltwater" pseudo-outlet', c.source !== 'Meltwater Social CPC/SWL/EPC');
}

// ---------------------------------------------------------------------------
// 5. Malformed docs are dropped (null), not admitted.
// ---------------------------------------------------------------------------
{
  check('no title => dropped', mapMeltwaterDoc({ url: 'https://x/y', content: { title: '' } } as any) === null);
  check('no url => dropped', mapMeltwaterDoc({ url: '', content: { title: 'x' } } as any) === null);
}

// ---------------------------------------------------------------------------
// 6. og:image is only carried when it is a real http(s) URL.
// ---------------------------------------------------------------------------
{
  const good = mapMeltwaterDoc({
    url: 'https://www.rt.com/news/img-good/',
    content: { title: 't', image: 'https://img.rt.com/a.jpg' },
    source: { name: 'RT' },
  } as any)!;
  check('image: real http(s) image kept', good.ogImageUrl === 'https://img.rt.com/a.jpg');
  const bad = mapMeltwaterDoc({
    url: 'https://www.rt.com/news/img-bad/',
    content: { title: 't', image: 'data:image/png;base64,zzz' },
    source: { name: 'RT' },
  } as any)!;
  check('image: non-http image dropped to null', bad.ogImageUrl === null);
}

// ---------------------------------------------------------------------------
// 7. De-clumping (Task #607): spreadCandidatesByOutlet caps any single
//    publisher's share of a run and round-robins across outlets so a
//    high-volume state outlet (TASS ~10x RT/Sputnik) can't monopolize a cycle.
// ---------------------------------------------------------------------------
function cand(source: string, n: number, url?: string): CuratedIntakeCandidate {
  return {
    title: `${source} story ${n}`,
    url: url ?? `https://example.test/${source.toLowerCase().replace(/\s+/g, '-')}/${n}`,
    source,
    pubDate: new Date().toISOString(),
    ogImageUrl: null,
  };
}

{
  // TASS-heavy synthetic batch: 12 TASS + 2 RT + 1 Sputnik (freshest-first).
  const batch: CuratedIntakeCandidate[] = [];
  for (let i = 1; i <= 12; i++) batch.push(cand('TASS', i));
  batch.push(cand('RT', 1));
  batch.push(cand('RT', 2));
  batch.push(cand('Sputnik', 1));

  const cap = 5;
  const spread = spreadCandidatesByOutlet(batch, { perOutletCap: cap });

  const tassKept = spread.filter((c) => c.source === 'TASS');
  const rtKept = spread.filter((c) => c.source === 'RT');
  const sputnikKept = spread.filter((c) => c.source === 'Sputnik');

  check('declump: TASS capped to perOutletCap', tassKept.length === cap);
  check('declump: TASS kept its FRESHEST items', tassKept.every((c) => /story ([1-5])$/.test(c.title)));
  check('declump: rarer RT fully survives', rtKept.length === 2);
  check('declump: rarest Sputnik survives', sputnikKept.length === 1);
  check('declump: total = capped TASS + RT + Sputnik', spread.length === cap + 2 + 1);
  check('declump: real-publisher attribution preserved', spread.every((c) => ['TASS', 'RT', 'Sputnik'].includes(c.source)));
  // Round-robin interleaves outlets — the first 3 must be one of each, not 3 TASS.
  const firstThree = new Set(spread.slice(0, 3).map((c) => c.source));
  check('declump: round-robin interleaves (first 3 are distinct outlets)', firstThree.size === 3);
}

{
  // Registry-backed identity: the same publisher under a name AND a bare domain
  // must collapse to ONE outlet so the cap can't be bypassed by spelling.
  const batch: CuratedIntakeCandidate[] = [];
  for (let i = 1; i <= 4; i++) batch.push(cand('RT', i, `https://www.rt.com/news/name-${i}/`));
  for (let i = 1; i <= 4; i++) batch.push(cand('rt.com', i, `https://www.rt.com/news/dom-${i}/`));

  const identityOf = (c: CuratedIntakeCandidate) => {
    const row = findOutlet(index, c.source, c.url);
    return row ? `row:${row.id}` : `name:${c.source.toLowerCase()}`;
  };
  const spread = spreadCandidatesByOutlet(batch, { perOutletCap: 3, identityOf });
  check('declump (registry id): name + domain collapse to one capped outlet', spread.length === 3);
}

{
  // Below-cap batch is returned intact (order preserved per outlet).
  const batch = [cand('RT', 1), cand('TASS', 1), cand('RT', 2)];
  const spread = spreadCandidatesByOutlet(batch, { perOutletCap: 5 });
  check('declump: below-cap batch keeps every item', spread.length === 3);
}

// ---------------------------------------------------------------------------
// 8. MELTWATER_SEARCHES config — both searches present with correct IDs/labels.
// ---------------------------------------------------------------------------
{
  check('MELTWATER_SEARCHES has exactly 2 entries', MELTWATER_SEARCHES.length === 2);

  const cpc = MELTWATER_SEARCHES.find((s) => s.label === 'meltwater-cpc');
  check('CPC search exists', !!cpc);
  check('CPC search ID is 28809721', cpc?.searchId === 28809721);
  check('CPC search has windowMinutes', (cpc?.windowMinutes ?? 0) > 0);
  check('CPC search has maxPages >= 1', (cpc?.maxPages ?? 0) >= 1);
  // Adversary CPC search stays UNGATED ('reuse') by user directive — the
  // downstream adversary-media handling owns filtering. Do NOT gate it.
  check('CPC search mode is reuse (ungated, user directive)', cpc?.mode === 'reuse');

  const intus = MELTWATER_SEARCHES.find((s) => s.label === 'meltwater-intus');
  check('IntUS search exists', !!intus);
  check('IntUS search ID is 28872986', intus?.searchId === 28872986);
  check('IntUS search has windowMinutes', (intus?.windowMinutes ?? 0) > 0);
  check('IntUS search has maxPages >= 1', (intus?.maxPages ?? 0) >= 1);
  // General-press Int/US search MUST run the relevance gate: ungated it floods
  // curated with off-topic items at machine-baseline scores (~60-71), bypassing
  // the analyzer's relevance screen and real AI priority scoring (2026-07-15).
  check('IntUS search mode is gate (relevance screen + AI scoring)', intus?.mode === 'gate');

  // The two searches must have different labels and different IDs.
  check('searches have distinct labels', cpc?.label !== intus?.label);
  check('searches have distinct searchIds', cpc?.searchId !== intus?.searchId);

  // CPC runs every hour (~75min window); IntUS runs every 2h (~135min window).
  // Assert that IntUS has a wider window than CPC (more headroom for the slower cadence).
  check('IntUS windowMinutes > CPC windowMinutes', (intus?.windowMinutes ?? 0) > (cpc?.windowMinutes ?? 0));
}

// ---------------------------------------------------------------------------
// 9. Publish-date reconciliation (2026-07-15): Meltwater's published_date is its
//    own crawl/index date. For a RE-SURFACED older article that stamp can be
//    days-to-weeks newer than the true publish date, which made stale items read
//    as "recently published" on Top Stories. When the outlet's URL carries its
//    own date and Meltwater's stamp is materially newer, trust the URL date.
// ---------------------------------------------------------------------------
{
  // parseDateFromUrl covers the common /YYYY/MM/DD/ and /YYYY-MM-DD/ shapes.
  check('urlDate: /YYYY/MM/DD/ parses',
    parseDateFromUrl('https://foreignpolicy.com/2026/06/12/some-slug/')?.toISOString().slice(0, 10) === '2026-06-12');
  check('urlDate: /YYYY-MM-DD/ parses',
    parseDateFromUrl('https://www.stripes.com/theaters/2026-07-13/last-us-troops-22271468.html')?.toISOString().slice(0, 10) === '2026-07-13');
  check('urlDate: no date in path => null',
    parseDateFromUrl('https://www.cnn.com/politics/johnson-defense-spending') === null);
  check('urlDate: bare id-like path not misread as a date',
    parseDateFromUrl('https://www.globaltimes.cn/page/202607/1366040.shtml') === null);

  // The bug case: a month-old Foreign Policy article Meltwater surfaces "today".
  const staleUrl = 'https://foreignpolicy.com/2026/06/12/netanyahu-reelection/';
  const mwFresh = '2026-07-14T20:46:00Z';
  const rec = reconcileMeltwaterPubDate(mwFresh, staleUrl);
  check('reconcile: stale URL date beats a much-newer Meltwater stamp',
    rec === '2026-06-12T00:00:00.000Z');

  // Same-day (within tolerance): keep Meltwater's stamp (it has a real clock time).
  const sameDay = reconcileMeltwaterPubDate('2026-07-15T14:00:00Z', 'https://www.reuters.com/world/x-2026-07-15/');
  check('reconcile: same-day keeps Meltwater stamp (has clock time)',
    sameDay === '2026-07-15T14:00:00Z');

  // No URL date: Meltwater's stamp is passed through unchanged.
  check('reconcile: no URL date keeps Meltwater stamp',
    reconcileMeltwaterPubDate('2026-07-15T14:00:00Z', 'https://www.cnn.com/politics/no-date') === '2026-07-15T14:00:00Z');

  // No Meltwater date but a URL date: fall back to the URL date, not null.
  check('reconcile: null Meltwater date falls back to URL date',
    reconcileMeltwaterPubDate(null, 'https://foreignpolicy.com/2026/06/12/x/') === '2026-06-12T00:00:00.000Z');

  // Neither present: null (curated view honestly renders "First seen").
  check('reconcile: nothing to trust => null',
    reconcileMeltwaterPubDate(null, 'https://www.cnn.com/politics/no-date') === null);

  // End-to-end through the mapper: the stale article maps to its URL date.
  const staleDoc: MeltwaterDoc = {
    url: staleUrl,
    content_type: 'news',
    published_date: mwFresh,
    content: { title: 'Netanyahu reelection analysis' },
    source: { name: 'Foreign Policy', domain: 'foreignpolicy.com' },
  };
  check('mapper: stale re-surfaced article carries the URL date, not the fresh crawl stamp',
    mapMeltwaterDoc(staleDoc)!.pubDate === '2026-06-12T00:00:00.000Z');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
