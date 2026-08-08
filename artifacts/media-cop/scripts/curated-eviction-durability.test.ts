/**
 * Curated manual-eviction DURABILITY regression (unlink must stick on an
 * ACTIVE, churning cluster).
 *
 * An editor eviction is saved as (evictedUrl, snapshot of sibling anchor URLs
 * at click time). An active cluster churns membership every pass, so the
 * snapshot anchors age out and a URL-frozen eviction silently no-ops — the
 * clustering LLM then re-absorbs the exact item the editor just removed. The
 * fix is STORY-STICKY anchor expansion (expandManualEvictionAnchors), the
 * mirror of the manual-link expansion: per pass, each eviction's effective
 * anchor set is widened with the CURRENT members of any surviving prior
 * cluster its RAW snapshot still anchors (prior clusters come from the
 * persisted member table, so the hand-over-hand chain survives restarts).
 *
 * This gate pins the pure, deterministic core WITHOUT DB/LLM/network:
 *
 *   (1) DURABILITY — after full membership churn (zero snapshot anchors left
 *       in the live group), the expanded anchor set still fires the eviction;
 *       the raw (unexpanded) set demonstrably no-ops on the same input (the
 *       exact pre-fix bug shape).
 *   (2) FAIL-CLOSED on unrelated groups — an EXPANDED eviction's guard scales
 *       off the effective set size, so a couple of adopted URLs that churned
 *       into an unrelated group can never fire the eviction there.
 *   (3) Expansion anchoring guards — a prior cluster is adopted only when the
 *       RAW snapshot still anchors it (>= max(2, 10% of size), or >= 1 for a
 *       small <= 5-member cluster); the evicted URL itself never counts as an
 *       anchor and is never adopted; single hop (adopted URLs never recruit
 *       further clusters); MANUAL_LINK_MAX_ANCHORED_CLUSTERS and
 *       MANUAL_LINK_EFFECTIVE_URL_CAP caps hold.
 *   (4) applyManualEvictions invariants — manual-link precedence (link beats
 *       eviction), < 2 resolvable anchors no-ops, evicted key is ALWAYS
 *       re-seeded as a standalone singleton (never lost), unrelated groups
 *       and other members are untouched.
 *   (5) Determinism — identical output across reordered priorClusters input.
 *
 * Exit 0 = PASS, exit 1 = FAIL.
 * Usage: npx tsx scripts/curated-eviction-durability.test.ts
 */

import {
  expandManualEvictionAnchors,
  applyManualEvictions,
  MANUAL_LINK_MAX_ANCHORED_CLUSTERS,
  MANUAL_LINK_EFFECTIVE_URL_CAP,
  type PriorClusterUrls,
  type ManualEvictionResolved,
} from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[eviction-durability] OK   ${name}`);
  } else {
    console.error(`[eviction-durability] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers. URLs are already-normalized identity URLs (the production
// call site normalizes before calling both helpers). key(u) mirrors the
// urlToKey resolution: one present node key per URL.
// ---------------------------------------------------------------------------
const url = (host: string, id: string) => `https://${host}/article/${id}`;
const keyOf = (u: string) => `curated:${u.split('/').pop()}`;
const prior = (urls: string[]): PriorClusterUrls => ({ urls: new Set(urls), size: urls.length });

// Resolve an expansion to the ManualEvictionResolved shape the way the
// production call site does (urls -> present keys; expanded flag from addedUrls).
function resolve(
  evictedUrl: string,
  exp: { urls: Set<string>; addedUrls: number },
  presentUrls: Set<string>,
  storedAnchorCount: number,
): ManualEvictionResolved {
  const anchorKeys = new Set<string>();
  for (const u of Array.from(exp.urls)) if (presentUrls.has(u)) anchorKeys.add(keyOf(u));
  return {
    evictedKey: presentUrls.has(evictedUrl) ? keyOf(evictedUrl) : '',
    anchorKeys,
    storedAnchorCount,
    expanded: exp.addedUrls > 0,
  };
}

// ===========================================================================
// (1) DURABILITY — the pre-fix bug shape. Snapshot anchors fully churned out
// of the live group; the persisted prior cluster still holds them, so the
// expansion adopts its CURRENT members and the eviction still fires.
// ===========================================================================
{
  const evictedU = url('badmerge.com', 'evicted');
  // Snapshot at click time: 4 sibling anchors.
  const snapA = [url('ap.com', 'a1'), url('reuters.com', 'a2'), url('bbc.com', 'a3'), url('dw.com', 'a4')];
  // The prior pass's persisted cluster: snapshot anchors + newer members.
  const churn = [url('cnn.com', 'c1'), url('fox.com', 'c2'), url('npr.com', 'c3'), url('wsj.com', 'c4')];
  const priorCluster = prior([...snapA, evictedU, ...churn]);

  const [exp] = expandManualEvictionAnchors(
    [{ evictedUrl: evictedU, anchorUrls: new Set(snapA) }],
    [priorCluster],
  );
  check('(1) expansion adopts the prior cluster\'s current members', exp.addedUrls === churn.length, `added ${exp.addedUrls}`);
  check('(1) evicted URL is never adopted as an anchor', !exp.urls.has(evictedU));
  check('(1) expansion reports one anchored cluster', exp.anchoredClusters === 1);

  // THIS pass's live world: every snapshot anchor churned out; the group is
  // now evicted item + the churned members only.
  const liveUrls = new Set([evictedU, ...churn]);
  const liveGroup = { keys: Array.from(liveUrls).map(keyOf) };
  const resolved = resolve(evictedU, exp, liveUrls, snapA.length);
  check('(1) resolved eviction is marked expanded', resolved.expanded === true);

  const res = applyManualEvictions([liveGroup], [resolved], []);
  check('(1) DURABILITY: eviction fires after full snapshot churn', res.applied === 1);
  check('(1) evicted key removed from the cluster',
    !res.groups.some(g => g.keys.length > 1 && g.keys.includes(keyOf(evictedU))));
  check('(1) evicted key re-seeded as standalone singleton (never lost)',
    res.groups.some(g => g.keys.length === 1 && g.keys[0] === keyOf(evictedU)));
  check('(1) remaining members intact',
    res.groups.some(g => g.keys.length === churn.length && churn.every(u => g.keys.includes(keyOf(u)))));

  // CONTRAST — the legacy raw-snapshot path on the SAME live world no-ops
  // (anchors resolve to zero present keys). This is the bug the fix removes.
  const rawResolved: ManualEvictionResolved = {
    evictedKey: keyOf(evictedU),
    anchorKeys: new Set<string>(), // no snapshot anchor still present
    storedAnchorCount: snapA.length,
    expanded: false,
  };
  const rawRes = applyManualEvictions([liveGroup], [rawResolved], []);
  check('(1) contrast: raw (unexpanded) snapshot no-ops on the same churned group', rawRes.applied === 0);
}

// ===========================================================================
// (2) FAIL-CLOSED — an EXPANDED anchor set that leaks a couple of URLs into an
// UNRELATED group must never fire the eviction there: the guard requires
// >= max(2, ceil(10% of the EFFECTIVE set size)) anchors in the group.
// ===========================================================================
{
  const evictedU = url('badmerge.com', 'e2');
  // Expanded effective set of 30 anchors (guard requires ceil(3) = 3 in-group).
  const expandedAnchors = Array.from({ length: 30 }, (_, i) => url('adopted.com', `x${i}`));
  // Unrelated group holds the evicted item + only TWO of the adopted URLs.
  const unrelated = [url('other.com', 'u1'), url('other.com', 'u2'), url('other.com', 'u3'),
    expandedAnchors[0], expandedAnchors[1], evictedU];
  const liveUrls = new Set(unrelated);
  const group = { keys: unrelated.map(keyOf) };
  const resolved: ManualEvictionResolved = {
    evictedKey: keyOf(evictedU),
    anchorKeys: new Set(expandedAnchors.map(keyOf)), // all 30 resolve somewhere this pass
    storedAnchorCount: 4,
    expanded: true,
  };
  const res = applyManualEvictions([group], [resolved], []);
  check('(2) expanded eviction does NOT fire on an unrelated group (2 < required 3)', res.applied === 0);
  check('(2) unrelated group untouched', res.groups.length === 1 && res.groups[0].keys.length === unrelated.length);
  // Same shape UNEXPANDED with a small stored snapshot would have fired off a
  // single anchor (<= 5 rule) — proving the expanded guard is what protects.
  const resolvedRaw: ManualEvictionResolved = { ...resolved, anchorKeys: new Set([keyOf(expandedAnchors[0])]), expanded: false };
  void resolvedRaw; // (< 2 anchors no-ops anyway — asserted in (4b))
  void liveUrls;
}

// ===========================================================================
// (3) Expansion anchoring guards.
// ===========================================================================
{
  const evictedU = url('badmerge.com', 'e3');
  const snap = [url('ap.com', 's1'), url('reuters.com', 's2'), url('bbc.com', 's3')];

  // (3a) Large prior cluster with only ONE snapshot anchor -> NOT adopted.
  const bigOneAnchor = prior([snap[0], ...Array.from({ length: 20 }, (_, i) => url('big.com', `b${i}`))]);
  const [expA] = expandManualEvictionAnchors(
    [{ evictedUrl: evictedU, anchorUrls: new Set(snap) }],
    [bigOneAnchor],
  );
  check('(3a) big cluster with 1 snapshot anchor is NOT adopted', expA.addedUrls === 0 && expA.anchoredClusters === 0);

  // (3b) Small (<= 5) prior cluster with 1 anchor IS adopted.
  const smallOneAnchor = prior([snap[0], url('small.com', 'm1'), url('small.com', 'm2')]);
  const [expB] = expandManualEvictionAnchors(
    [{ evictedUrl: evictedU, anchorUrls: new Set(snap) }],
    [smallOneAnchor],
  );
  check('(3b) small cluster with 1 snapshot anchor IS adopted', expB.addedUrls === 2 && expB.anchoredClusters === 1);

  // (3c) Single hop, no transitivity: cluster B overlaps ADOPTED urls only
  // (no raw snapshot URL) -> never recruited.
  const adoptedUrl = url('small.com', 'm1');
  const clusterB = prior([adoptedUrl, url('faraway.com', 'f1'), url('faraway.com', 'f2')]);
  const [expC] = expandManualEvictionAnchors(
    [{ evictedUrl: evictedU, anchorUrls: new Set(snap) }],
    [smallOneAnchor, clusterB],
  );
  check('(3c) adopted URLs never recruit further clusters (single hop)',
    !expC.urls.has(url('faraway.com', 'f1')) && !expC.urls.has(url('faraway.com', 'f2')));

  // (3d) Cap on adopted clusters: build MAX+2 small anchored clusters, each
  // anchored by one distinct snapshot URL — only MAX may contribute.
  const wideSnap = Array.from({ length: MANUAL_LINK_MAX_ANCHORED_CLUSTERS + 2 }, (_, i) => url('ap.com', `w${i}`));
  const clusters = wideSnap.map((s, i) => prior([s, url(`extra${i}.com`, `p${i}`)]));
  const [expD] = expandManualEvictionAnchors(
    [{ evictedUrl: evictedU, anchorUrls: new Set(wideSnap) }],
    clusters,
  );
  check('(3d) at most MANUAL_LINK_MAX_ANCHORED_CLUSTERS clusters contribute',
    expD.anchoredClusters === MANUAL_LINK_MAX_ANCHORED_CLUSTERS, `got ${expD.anchoredClusters}`);

  // (3e) Effective-set cap: a huge anchored cluster can never push the
  // effective set past MANUAL_LINK_EFFECTIVE_URL_CAP.
  const hugeMembers = Array.from({ length: MANUAL_LINK_EFFECTIVE_URL_CAP + 50 }, (_, i) => url('huge.com', `h${i}`));
  const huge = prior([snap[0], snap[1], ...hugeMembers]);
  const [expE] = expandManualEvictionAnchors(
    [{ evictedUrl: evictedU, anchorUrls: new Set(snap) }],
    [huge],
  );
  check('(3e) effective set respects MANUAL_LINK_EFFECTIVE_URL_CAP',
    expE.urls.size <= MANUAL_LINK_EFFECTIVE_URL_CAP, `got ${expE.urls.size}`);

  // (3f) Empty raw snapshot -> no expansion at all.
  const [expF] = expandManualEvictionAnchors(
    [{ evictedUrl: evictedU, anchorUrls: new Set<string>() }],
    [smallOneAnchor],
  );
  check('(3f) empty snapshot never expands', expF.urls.size === 0 && expF.addedUrls === 0);
}

// ===========================================================================
// (4) applyManualEvictions invariants.
// ===========================================================================
{
  const evictedU = url('badmerge.com', 'e4');
  const anchors = [url('ap.com', 'q1'), url('reuters.com', 'q2'), url('bbc.com', 'q3')];
  const group = { keys: [keyOf(evictedU), ...anchors.map(keyOf)] };

  // (4a) Manual-link precedence: an active link containing the evicted key +
  // one group member shields the eviction.
  const resolved: ManualEvictionResolved = {
    evictedKey: keyOf(evictedU),
    anchorKeys: new Set(anchors.map(keyOf)),
    storedAnchorCount: anchors.length,
    expanded: false,
  };
  const link = [keyOf(evictedU), keyOf(anchors[0])];
  const shielded = applyManualEvictions([{ keys: group.keys.slice() }], [resolved], [link]);
  check('(4a) manual-link precedence: link beats eviction', shielded.applied === 0);
  // A link NOT touching this group does not shield.
  const elsewhereLink = [keyOf(evictedU), keyOf(url('elsewhere.com', 'z1'))];
  const notShielded = applyManualEvictions([{ keys: group.keys.slice() }], [resolved], [elsewhereLink]);
  check('(4a) a link not touching the group does NOT shield', notShielded.applied === 1);

  // (4b) < 2 resolvable anchors -> fail-closed no-op.
  const weak: ManualEvictionResolved = { ...resolved, anchorKeys: new Set([keyOf(anchors[0])]) };
  const weakRes = applyManualEvictions([{ keys: group.keys.slice() }], [weak], []);
  check('(4b) a lone resolvable anchor never fires (fail-closed)', weakRes.applied === 0);

  // (4c) Evicted key absent from every group (aged out) -> no-op, nothing added.
  const gone = applyManualEvictions([{ keys: anchors.map(keyOf) }], [resolved], []);
  check('(4c) absent evicted key no-ops', gone.applied === 0 && gone.groups.length === 1);

  // (4d) Small snapshot (<= 5) legacy rule: ONE in-group anchor suffices when
  // NOT expanded (raw path unchanged by the fix).
  const smallSnap: ManualEvictionResolved = {
    evictedKey: keyOf(evictedU),
    anchorKeys: new Set([keyOf(anchors[0]), keyOf(url('aged.com', 'out1'))]), // 2 resolvable, 1 in group
    storedAnchorCount: 3,
    expanded: false,
  };
  const smallRes = applyManualEvictions([{ keys: group.keys.slice() }], [smallSnap], []);
  check('(4d) legacy small-snapshot rule unchanged (1 in-group anchor fires)', smallRes.applied === 1);
}

// ===========================================================================
// (5) Determinism — reordering priorClusters never changes the outcome.
// ===========================================================================
{
  const evictedU = url('badmerge.com', 'e5');
  const snap = [url('ap.com', 'd1'), url('reuters.com', 'd2'), url('bbc.com', 'd3'), url('dw.com', 'd4')];
  const c1 = prior([snap[0], snap[1], url('one.com', 'o1'), url('one.com', 'o2')]);
  const c2 = prior([snap[2], snap[3], url('two.com', 't1'), url('two.com', 't2')]);
  const c3 = prior([snap[0], url('three.com', 'r1')]);
  const input = { evictedUrl: evictedU, anchorUrls: new Set(snap) };
  const [fwd] = expandManualEvictionAnchors([input], [c1, c2, c3]);
  const [rev] = expandManualEvictionAnchors([input], [c3, c2, c1]);
  const sortedFwd = Array.from(fwd.urls).sort().join('|');
  const sortedRev = Array.from(rev.urls).sort().join('|');
  check('(5) expansion is deterministic across priorClusters order',
    sortedFwd === sortedRev && fwd.addedUrls === rev.addedUrls && fwd.anchoredClusters === rev.anchoredClusters);
}

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? '[eviction-durability] ALL PASS'
    : `[eviction-durability] ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
