// Gate: story-sticky editor manual-link expansion (expandManualLinkGroups).
// Pure-function gate — no DB, no LLM, no network. Exit 0 = pass, 1 = fail.
//
// Verifies the over-merge guards that keep the expansion fail-closed:
//   1. A cluster anchored by >= max(2, 10% of size) linked URLs expands.
//   2. A lone stray linked URL inside a BIG cluster does NOT drag it in.
//   3. A single anchor in a small (<= 5 member) cluster DOES expand.
//   4. The 10% rule blocks 2 anchors in a 100-member megacluster.
//   5. The effective URL set is capped and raw snapshot URLs always survive.
//   6. NO transitivity: a cluster that only overlaps machine-added URLs
//      (never a raw snapshot URL) is never recruited.
//   7. At most MANUAL_LINK_MAX_ANCHORED_CLUSTERS clusters expand one link.
//   8. Deterministic output for identical input.
//   9. COHERENCE FILTER (re-glue fix): an adopted URL must be titlesHighlySimilar
//      to >= 1 raw snapshot URL's title AND within the same-event time window;
//      missing metadata (either side) => NOT adopted (fail-closed). Raw snapshot
//      URLs themselves always survive unconditionally.

import {
  expandManualLinkGroups,
  MANUAL_LINK_MAX_ANCHORED_CLUSTERS,
  MANUAL_LINK_EFFECTIVE_URL_CAP,
  type PriorClusterUrls,
  type ManualLinkUrlMeta,
} from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function urls(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://example.com/${prefix}/${i}`);
}
function cluster(members: string[]): PriorClusterUrls {
  return { urls: new Set(members), size: members.length };
}

// Shared same-event token set: >= 4 significant tokens so titlesHighlySimilar
// (needs >= 4 tokens each side, >= 3 shared, >= 0.6 overlap) passes when two
// URLs carry the SAME event tokens. publishedAt null => time window permissive.
const EVENT_TOKENS = new Set(['iran', 'strikes', 'hormuz', 'tanker']);
const OTHER_EVENT_TOKENS = new Set(['house', 'vote', 'war', 'powers']);

// Uniform metadata: every URL involved shares the SAME event tokens, so the
// coherence filter passes everywhere and the structural checks 1-8 exercise
// exactly the anchoring/cap/transitivity logic they always did.
function uniformMeta(...groups: Iterable<string>[]): Map<string, ManualLinkUrlMeta> {
  const m = new Map<string, ManualLinkUrlMeta>();
  for (const g of groups) {
    for (const u of g) m.set(u, { titleTokens: EVENT_TOKENS, publishedAt: null });
  }
  return m;
}

// --- 1. >= 2 anchors in a modest cluster expands -----------------------------
{
  const linked = ['https://a.com/1', 'https://a.com/2', 'https://b.com/x'];
  const clusterMembers = ['https://a.com/1', 'https://a.com/2', ...urls('extra', 8)]; // size 10, 2 anchors, 10% => need max(2,1)=2
  const meta = uniformMeta(linked, clusterMembers);
  const [exp] = expandManualLinkGroups([new Set(linked)], [cluster(clusterMembers)], meta);
  check('anchored cluster (2 of 10) expands', exp.anchoredClusters === 1 && exp.addedUrls === 8,
    `anchored=${exp.anchoredClusters} added=${exp.addedUrls}`);
  check('expansion includes current members', exp.urls.has('https://example.com/extra/0'));
  check('raw urls retained', linked.every(u => exp.urls.has(u)));
}

// --- 2. one stray URL in a big cluster does NOT expand -----------------------
{
  const linked = ['https://a.com/1', 'https://b.com/x'];
  const bigMembers = ['https://a.com/1', ...urls('mega', 99)];
  const big = cluster(bigMembers); // size 100, 1 anchor
  const [exp] = expandManualLinkGroups([new Set(linked)], [big], uniformMeta(linked, bigMembers));
  check('1 stray anchor in 100-member cluster does not expand', exp.anchoredClusters === 0 && exp.addedUrls === 0,
    `anchored=${exp.anchoredClusters} added=${exp.addedUrls}`);
}

// --- 3. single anchor in a small (<=5) cluster expands ------------------------
{
  const linked = ['https://a.com/1', 'https://b.com/x'];
  const smallMembers = ['https://a.com/1', 'https://c.com/1', 'https://c.com/2'];
  const small = cluster(smallMembers); // size 3, 1 anchor
  const [exp] = expandManualLinkGroups([new Set(linked)], [small], uniformMeta(linked, smallMembers));
  check('1 anchor in 3-member cluster expands', exp.anchoredClusters === 1 && exp.addedUrls === 2,
    `anchored=${exp.anchoredClusters} added=${exp.addedUrls}`);
}

// --- 4. 10% rule blocks 2 anchors in a 100-member megacluster ----------------
{
  const linked = ['https://a.com/1', 'https://a.com/2', 'https://b.com/x'];
  const megaMembers = ['https://a.com/1', 'https://a.com/2', ...urls('mega2', 98)];
  const mega = cluster(megaMembers); // size 100, 2 anchors, need >= 10
  const [exp] = expandManualLinkGroups([new Set(linked)], [mega], uniformMeta(linked, megaMembers));
  check('10% rule blocks 2-of-100 megacluster', exp.anchoredClusters === 0 && exp.addedUrls === 0,
    `anchored=${exp.anchoredClusters} added=${exp.addedUrls}`);
  // …but 10 anchors of 100 passes the bar. Expansion is bounded by
  // MANUAL_LINK_EXPANSION_ADDED_CAP (30) per group (Task #1025 anti-ballooning),
  // so of the 90 non-anchor members only the first 30 are added this pass.
  const linked10 = urls('mega3-a', 10).concat(['https://b.com/x']);
  const mega10Members = [...urls('mega3-a', 10), ...urls('mega3-b', 90)];
  const mega10 = cluster(mega10Members);
  const [exp10] = expandManualLinkGroups([new Set(linked10)], [mega10], uniformMeta(linked10, mega10Members));
  check('10 anchors of 100 expands (capped at 30)', exp10.anchoredClusters === 1 && exp10.addedUrls === 30,
    `anchored=${exp10.anchoredClusters} added=${exp10.addedUrls}`);
}

// --- 5. effective URL cap, raw urls always survive ---------------------------
{
  const linked = urls('raw', 30);
  const hugeMembers = [...linked.slice(0, 10), ...urls('flood', 400)]; // size 410, 10 anchors: not anchored
  const huge = cluster(hugeMembers);
  const anchoredHugeMembers = [...linked.slice(0, 30), ...urls('flood2', 380)]; // 30 of 410: not anchored
  const anchoredHuge = cluster(anchoredHugeMembers);
  const anchoredBigMembers = [...linked.slice(0, 30), ...urls('flood3', 220)]; // 30 of 250 >= ceil(25): anchored
  const anchoredBig = cluster(anchoredBigMembers);
  const meta = uniformMeta(linked, hugeMembers, anchoredHugeMembers, anchoredBigMembers);
  const [exp] = expandManualLinkGroups([new Set(linked)], [huge, anchoredHuge, anchoredBig], meta);
  check('cap enforced', exp.urls.size <= MANUAL_LINK_EFFECTIVE_URL_CAP, `size=${exp.urls.size}`);
  check('raw urls never evicted by cap', linked.every(u => exp.urls.has(u)));
  check('under-anchored huge clusters skipped', exp.anchoredClusters === 1, `anchored=${exp.anchoredClusters}`);
}

// --- 6. no transitivity -------------------------------------------------------
{
  const linked = ['https://a.com/1', 'https://b.com/x'];
  const aMembers = ['https://a.com/1', 'https://bridge.com/1', 'https://bridge.com/2'];
  const bMembers = ['https://bridge.com/1', 'https://bridge.com/2', 'https://faraway.com/1'];
  const clusterA = cluster(aMembers); // anchored (size 3)
  const clusterB = cluster(bMembers); // overlaps A only
  const [exp] = expandManualLinkGroups([new Set(linked)], [clusterA, clusterB], uniformMeta(linked, aMembers, bMembers));
  check('cluster sharing only machine-added urls is NOT recruited', !exp.urls.has('https://faraway.com/1'));
  check('single hop only: one anchored cluster', exp.anchoredClusters === 1, `anchored=${exp.anchoredClusters}`);
}

// --- 7. anchored-cluster cap per link -----------------------------------------
{
  const linked = urls('anchor', 10).concat(['https://b.com/x']);
  const memberLists = Array.from({ length: 6 }, (_, i) =>
    [`https://example.com/anchor/${i}`, `https://c${i}.com/1`, `https://c${i}.com/2`], // each size 3, 1 anchor
  );
  const clusters: PriorClusterUrls[] = memberLists.map(m => cluster(m));
  const [exp] = expandManualLinkGroups([new Set(linked)], clusters, uniformMeta(linked, ...memberLists));
  check(`at most ${MANUAL_LINK_MAX_ANCHORED_CLUSTERS} anchored clusters`, exp.anchoredClusters === MANUAL_LINK_MAX_ANCHORED_CLUSTERS,
    `anchored=${exp.anchoredClusters}`);
}

// --- 8. deterministic ----------------------------------------------------------
{
  const linked = new Set(['https://a.com/1', 'https://a.com/2', 'https://b.com/x']);
  const c1Members = ['https://a.com/1', 'https://a.com/2', ...urls('d1', 6)];
  const c2Members = ['https://a.com/1', 'https://z.com/1', 'https://z.com/2'];
  const clusters = [cluster(c1Members), cluster(c2Members)];
  const meta = uniformMeta(linked, c1Members, c2Members);
  const one = expandManualLinkGroups([new Set(linked)], clusters, meta)[0];
  const two = expandManualLinkGroups([new Set(linked)], clusters, meta)[0];
  const sig = (e: { urls: Set<string> }) => Array.from(e.urls).sort().join('|');
  check('deterministic for identical input', sig(one) === sig(two));
}

// --- 9. coherence filter (re-glue fix) ------------------------------------------
{
  // 9a. Off-event members of an anchored cluster are NOT adopted; same-event
  // members ARE. Prod shape: a strikes link anchors a contaminated megacluster
  // that also contains house-vote coverage — the house-vote members must not
  // be re-adopted (that re-glued what the anchor-split had just separated).
  const linked = ['https://a.com/1', 'https://a.com/2', 'https://b.com/x'];
  const sameEvent = ['https://s.com/1', 'https://s.com/2'];
  const offEvent = ['https://o.com/1', 'https://o.com/2'];
  const members = [...linked.slice(0, 2), ...sameEvent, ...offEvent, ...urls('pad', 4)]; // size 10, 2 anchors
  const meta = new Map<string, ManualLinkUrlMeta>();
  for (const u of [...linked, ...sameEvent]) meta.set(u, { titleTokens: EVENT_TOKENS, publishedAt: null });
  for (const u of offEvent) meta.set(u, { titleTokens: OTHER_EVENT_TOKENS, publishedAt: null });
  // pad urls: NO metadata at all (churned out) => fail-closed, not adopted.
  const [exp] = expandManualLinkGroups([new Set(linked)], [cluster(members)], meta);
  check('same-event members adopted', sameEvent.every(u => exp.urls.has(u)),
    `urls=${Array.from(exp.urls).join(',')}`);
  check('off-event members NOT adopted', offEvent.every(u => !exp.urls.has(u)));
  check('metadata-less members NOT adopted (fail-closed)', !exp.urls.has('https://example.com/pad/0'));
  check('cluster still counts as anchored via its coherent contribution', exp.anchoredClusters === 1 && exp.addedUrls === 2,
    `anchored=${exp.anchoredClusters} added=${exp.addedUrls}`);

  // 9b. Same tokens but OUTSIDE the same-event time window => not adopted
  // (different-cycle event with overlapping wording, e.g. "second night of
  // strikes" a day later).
  const now = Date.now();
  const meta2 = new Map<string, ManualLinkUrlMeta>();
  for (const u of linked) meta2.set(u, { titleTokens: EVENT_TOKENS, publishedAt: new Date(now) });
  meta2.set('https://late.com/1', { titleTokens: EVENT_TOKENS, publishedAt: new Date(now - 20 * 3_600_000) });
  meta2.set('https://ontime.com/1', { titleTokens: EVENT_TOKENS, publishedAt: new Date(now - 4 * 3_600_000) });
  const members2 = [...linked.slice(0, 2), 'https://late.com/1', 'https://ontime.com/1'];
  const [exp2] = expandManualLinkGroups([new Set(linked)], [cluster(members2)], meta2);
  check('same tokens but 20h apart NOT adopted', !exp2.urls.has('https://late.com/1'));
  check('same tokens within 12h window adopted', exp2.urls.has('https://ontime.com/1'));

  // 9c. Raw snapshot URLs with NO metadata anywhere => no adoption at all
  // (fail-closed), but the raw snapshot itself always survives.
  const [exp3] = expandManualLinkGroups(
    [new Set(linked)],
    [cluster([...linked.slice(0, 2), ...urls('nm', 8)])],
    new Map(),
  );
  check('no metadata at all => zero adoption', exp3.addedUrls === 0, `added=${exp3.addedUrls}`);
  check('raw snapshot still survives without metadata', linked.every(u => exp3.urls.has(u)));
}

// --- edge: empty link ----------------------------------------------------------
{
  const [exp] = expandManualLinkGroups([new Set<string>()], [cluster(urls('x', 3))], new Map());
  check('empty link no-ops', exp.urls.size === 0 && exp.anchoredClusters === 0 && exp.addedUrls === 0);
}

if (failures > 0) {
  console.error(`\n[curated-manual-link-sticky] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[curated-manual-link-sticky] all checks passed');
process.exit(0);
