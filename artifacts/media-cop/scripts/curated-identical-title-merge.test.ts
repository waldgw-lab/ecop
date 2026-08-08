/**
 * Curated identical-title syndication merge regression (deterministic must-link).
 *
 * The defect: one syndicated wire article (e.g. a China air-to-air missile story)
 * picked up under the SAME byte-identical headline by two independently-owned
 * outlets (Defense News and Military Times / Sightline Media) rendered as TWO
 * separate standalone "Top Stories" cards instead of ONE clustered story. The
 * clustering LLM split the byte-identical twins across passes, and the priority
 * cap could leave one twin below the top-MAX_NODES cutoff so the pair never even
 * co-entered the payload — so the >=2-corroborating formation gate never saw them
 * together.
 *
 * The fix is a PURE, deterministic must-link with two halves:
 *   - CANDIDACY: selectCandidateNodes admits any identical-title twin not already
 *     selected (lane c0) so BOTH copies always co-enter the clustering payload.
 *   - FORMATION: buildIdenticalTitleMustLinkGroups + reconcileMustLinkGroups force
 *     every byte-identical-title pair (>= 2 corroborating, >= 2 distinct publishers,
 *     within the same-event window, non-trivial headline) into ONE group regardless
 *     of how the LLM split them — while the UNCHANGED formation gate still decides
 *     what actually forms, so it only collapses genuine duplicates.
 *
 * This pins the contract WITHOUT the LLM (no network / DB / live AI) so it runs as
 * a regression gate. The node() fixture intentionally omits normalizedTitle so the
 * normalizeTitle(title) fallback in deterministicTitleKey is exercised. Exits
 * non-zero on any violation.
 *
 * Usage:  tsx scripts/curated-identical-title-merge.test.ts
 */

import {
  buildIdenticalTitleMustLinkGroups,
  reconcileMustLinkGroups,
  deterministicTitleKey,
  selectCandidateNodes,
  type LaneNode,
  type ClusterGroup,
} from '../server/curatedCluster';

// Keep in lockstep with server/curatedCluster.ts (intentionally re-stated so this
// test also pins the constants' INTENT). Starvation fix: HARD_NODE_CEILING =
// MAX_NODES + continuity RESCUE_BUDGET (60) + heuristic TOTAL_RESCUE_CEILING (100)
// + MANUAL_LINK_HEADROOM (100).
const MAX_NODES = 140;
const HARD_NODE_CEILING = 140 + 60 + 100 + 100;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[identical-title] OK   ${name}`);
  } else {
    console.error(`[identical-title] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// Mirrors scripts/curated-nodecap-repro.ts. Deliberately omits normalizedTitle so
// the normalizeTitle(title) fallback path in deterministicTitleKey is what runs.
function node(
  partial: Partial<LaneNode> & { key: string; title: string; priority: number; cls: LaneNode['cls'] },
): LaneNode {
  return {
    itemType: 'curated',
    itemId: partial.key.split(':')[1] ?? partial.key,
    source: partial.source ?? 'Test Wire',
    url: partial.url ?? `https://example.com/${partial.key}`,
    category: 'general',
    label: null,
    role:
      partial.cls === 'corroborating'
        ? 'contributing'
        : partial.cls === 'anchor-only'
          ? 'anchor-only'
          : 'attach-only',
    blocked: false,
    ogImageUrl: null,
    publishedAt: new Date(),
    sourceIdentifier: null,
    factuality: null,
    ownership: [],
    summary: null,
    bullets: null,
    ...partial,
  } as LaneNode;
}

// The real-world headline from the report. Byte-identical across both outlets.
const CHINA_MISSILE_TITLE =
  'China unveils new long-range air-to-air missile in Pacific drill';
const NOW = new Date('2026-06-22T12:00:00Z');

// ---------------------------------------------------------------------------
// (1) THE BUG: identical-title twins from two DISTINCT publishers, same window
//     -> ONE must-link group (would clear formation, render as one story).
// ---------------------------------------------------------------------------
{
  const dn = node({
    key: 'curated:dn',
    title: CHINA_MISSILE_TITLE,
    priority: 72,
    cls: 'corroborating',
    source: 'Defense News',
    url: 'https://www.defensenews.com/air/2026/06/22/china-aam',
    publishedAt: NOW,
  });
  const mt = node({
    key: 'curated:mt',
    title: CHINA_MISSILE_TITLE,
    priority: 72,
    cls: 'corroborating',
    source: 'Military Times',
    url: 'https://www.militarytimes.com/news/2026/06/22/china-aam',
    publishedAt: NOW,
  });
  const groups = buildIdenticalTitleMustLinkGroups([dn, mt]);
  check(
    '(1) byte-identical twins from 2 distinct publishers form ONE must-link group',
    groups.length === 1 && groups[0].length === 2,
    `got ${groups.length} group(s) sizes=[${groups.map(g => g.length).join(',')}]`,
  );
  check(
    '(1) the group contains BOTH the Defense News and Military Times copies',
    groups.length === 1 &&
      new Set(groups[0].map(n => n.key)).size === 2 &&
      groups[0].some(n => n.key === 'curated:dn') &&
      groups[0].some(n => n.key === 'curated:mt'),
  );
}

// ---------------------------------------------------------------------------
// (2) SAME-PUBLISHER clones (two URLs on one outlet, identical title) must NOT
//     must-link: distinct-publisher gate (>= 2) is the whole point.
// ---------------------------------------------------------------------------
{
  const a = node({
    key: 'curated:dn-a',
    title: CHINA_MISSILE_TITLE,
    priority: 72,
    cls: 'corroborating',
    source: 'Defense News',
    url: 'https://www.defensenews.com/air/2026/06/22/china-aam',
    publishedAt: NOW,
  });
  const b = node({
    key: 'curated:dn-b',
    title: CHINA_MISSILE_TITLE,
    priority: 72,
    cls: 'corroborating',
    source: 'Defense News',
    url: 'https://www.defensenews.com/air/2026/06/22/china-aam-amp',
    publishedAt: NOW,
  });
  const groups = buildIdenticalTitleMustLinkGroups([a, b]);
  check(
    '(2) identical title from ONE publisher (2 URLs) does NOT must-link',
    groups.length === 0,
    `expected 0 groups, got ${groups.length}`,
  );
}

// ---------------------------------------------------------------------------
// (3) Identical title but OUTSIDE the same-event window (re-used headline a
//     different news cycle) must NOT must-link.
// ---------------------------------------------------------------------------
{
  const dn = node({
    key: 'curated:dn-old',
    title: CHINA_MISSILE_TITLE,
    priority: 72,
    cls: 'corroborating',
    source: 'Defense News',
    url: 'https://www.defensenews.com/air/2026/06/22/china-aam',
    publishedAt: NOW,
  });
  const mt = node({
    key: 'curated:mt-old',
    title: CHINA_MISSILE_TITLE,
    priority: 72,
    cls: 'corroborating',
    source: 'Military Times',
    url: 'https://www.militarytimes.com/news/2026/06/20/china-aam',
    // ~36h earlier — well outside SAME_EVENT_WINDOW_HOURS (12h).
    publishedAt: new Date(NOW.getTime() - 36 * 3_600_000),
  });
  const groups = buildIdenticalTitleMustLinkGroups([dn, mt]);
  check(
    '(3) identical title >12h apart does NOT must-link (different news cycle)',
    groups.length === 0,
    `expected 0 groups, got ${groups.length}`,
  );
}

// ---------------------------------------------------------------------------
// (4) Trivially SHORT shared headline (< IDENTICAL_TITLE_MIN_TOKENS significant
//     tokens) must NOT must-link, even from 2 distinct publishers.
// ---------------------------------------------------------------------------
{
  const a = node({
    key: 'curated:short-a',
    title: 'China Missile', // only 2 significant tokens
    priority: 72,
    cls: 'corroborating',
    source: 'Defense News',
    url: 'https://www.defensenews.com/x',
    publishedAt: NOW,
  });
  const b = node({
    key: 'curated:short-b',
    title: 'China Missile',
    priority: 72,
    cls: 'corroborating',
    source: 'Military Times',
    url: 'https://www.militarytimes.com/x',
    publishedAt: NOW,
  });
  const groups = buildIdenticalTitleMustLinkGroups([a, b]);
  check(
    '(4) trivially short shared headline does NOT must-link',
    groups.length === 0,
    `expected 0 groups, got ${groups.length}`,
  );
}

// ---------------------------------------------------------------------------
// (5) Identical title but only ONE corroborating copy (the other is attach-only)
//     must NOT must-link: the >=2-corroborating gate still governs.
// ---------------------------------------------------------------------------
{
  const dn = node({
    key: 'curated:dn-corr',
    title: CHINA_MISSILE_TITLE,
    priority: 72,
    cls: 'corroborating',
    source: 'Defense News',
    url: 'https://www.defensenews.com/air/2026/06/22/china-aam',
    publishedAt: NOW,
  });
  const mt = node({
    key: 'curated:mt-attach',
    title: CHINA_MISSILE_TITLE,
    priority: 72,
    cls: 'attach-only',
    source: 'Military Times',
    url: 'https://www.militarytimes.com/news/2026/06/22/china-aam',
    publishedAt: NOW,
  });
  const groups = buildIdenticalTitleMustLinkGroups([dn, mt]);
  check(
    '(5) only one corroborating copy does NOT must-link (gate still governs)',
    groups.length === 0,
    `expected 0 groups, got ${groups.length}`,
  );
}

// ---------------------------------------------------------------------------
// (6) reconcile MERGES two separate LLM groups that a must-link spans into one.
// ---------------------------------------------------------------------------
{
  const coherent: ClusterGroup[] = [{ keys: ['curated:dn'] }, { keys: ['curated:mt'] }];
  const reconciled = reconcileMustLinkGroups(coherent, [['curated:dn', 'curated:mt']]);
  const merged = reconciled.find(g => g.keys.includes('curated:dn'));
  check(
    '(6) reconcile merges the two split LLM groups into ONE',
    reconciled.length === 1 &&
      !!merged &&
      new Set(merged.keys).size === 2 &&
      merged.keys.includes('curated:mt'),
    `got ${reconciled.length} group(s): ${JSON.stringify(reconciled)}`,
  );
}

// ---------------------------------------------------------------------------
// (7) reconcile CREATES a new group when the LLM didn't group the twins at all.
// ---------------------------------------------------------------------------
{
  const coherent: ClusterGroup[] = [{ keys: ['curated:other1', 'curated:other2'] }];
  const reconciled = reconcileMustLinkGroups(coherent, [['curated:dn', 'curated:mt']]);
  const newGroup = reconciled.find(g => g.keys.includes('curated:dn'));
  check(
    '(7) reconcile creates a standalone group for un-grouped twins',
    reconciled.length === 2 &&
      !!newGroup &&
      new Set(newGroup.keys).size === 2 &&
      newGroup.keys.includes('curated:mt'),
    `got ${reconciled.length} group(s): ${JSON.stringify(reconciled)}`,
  );
  // The untouched LLM group must be preserved verbatim.
  check(
    '(7) reconcile preserves the untouched LLM group',
    reconciled.some(
      g =>
        g.keys.length === 2 &&
        g.keys.includes('curated:other1') &&
        g.keys.includes('curated:other2'),
    ),
  );
}

// ---------------------------------------------------------------------------
// (8) reconcile is a no-op when the twins are already in the SAME LLM group.
// ---------------------------------------------------------------------------
{
  const coherent: ClusterGroup[] = [{ keys: ['curated:dn', 'curated:mt', 'curated:x'] }];
  const reconciled = reconcileMustLinkGroups(coherent, [['curated:dn', 'curated:mt']]);
  check(
    '(8) reconcile leaves an already-grouped pair as one group of 3',
    reconciled.length === 1 && new Set(reconciled[0].keys).size === 3,
    `got ${reconciled.length} group(s): ${JSON.stringify(reconciled)}`,
  );
}

// ---------------------------------------------------------------------------
// (9) deterministicTitleKey prefers stored normalizedTitle, falls back to
//     normalizeTitle(title) (the same key the ingest pipeline computes).
// ---------------------------------------------------------------------------
{
  check(
    '(9) deterministicTitleKey uses stored normalizedTitle when present',
    deterministicTitleKey({ title: 'Whatever Display Title', normalizedTitle: 'stored key' }) ===
      'stored key',
  );
  check(
    '(9) deterministicTitleKey falls back to normalizeTitle(title) when absent',
    deterministicTitleKey({ title: 'BREAKING: China Missile Test' }) ===
      'china missile test',
    `got "${deterministicTitleKey({ title: 'BREAKING: China Missile Test' })}"`,
  );
  check(
    '(9) byte-identical titles produce the SAME fallback key',
    deterministicTitleKey({ title: CHINA_MISSILE_TITLE }) ===
      deterministicTitleKey({ title: CHINA_MISSILE_TITLE }),
  );
}

// ---------------------------------------------------------------------------
// (10) CANDIDACY: identical-title twins that BOTH fall below the top-MAX_NODES
//      priority cutoff are still rescued together (lane c0) so they co-enter the
//      payload — the half of the fix that lets the formation must-link see them.
// ---------------------------------------------------------------------------
{
  const candidates: LaneNode[] = [];
  // 201 distinct-title, high-priority filler items push the cutoff to ~75 and
  // overflow the top 140 — exactly the production pressure that orphans a twin.
  for (let i = 0; i < 201; i++) {
    candidates.push(
      node({
        key: `curated:fill-${i}`,
        title: `Unrelated high priority defense headline ${i} alpha${i} bravo${i}`,
        priority: 75 + (i % 20),
        cls: 'corroborating',
        source: `Filler Outlet ${i}`,
        url: `https://filler${i}.example.com/story-${i}`,
        publishedAt: NOW,
      }),
    );
  }
  // The two byte-identical twins sit at priority 40 — far below the cutoff, so
  // BEFORE the fix neither would be rescued and the story could never form.
  candidates.push(
    node({
      key: 'curated:twin-dn',
      title: CHINA_MISSILE_TITLE,
      priority: 40,
      cls: 'corroborating',
      source: 'Defense News',
      url: 'https://www.defensenews.com/air/2026/06/22/china-aam',
      publishedAt: NOW,
    }),
    node({
      key: 'curated:twin-mt',
      title: CHINA_MISSILE_TITLE,
      priority: 40,
      cls: 'corroborating',
      source: 'Military Times',
      url: 'https://www.militarytimes.com/news/2026/06/22/china-aam',
      publishedAt: NOW,
    }),
  );

  const selection = selectCandidateNodes(candidates, new Set<string>(), new Set<string>());
  const keys = new Set(selection.allNodes.map(n => n.key));

  check(
    '(10) both below-cutoff identical-title twins co-enter the payload',
    keys.has('curated:twin-dn') && keys.has('curated:twin-mt'),
    `dn=${keys.has('curated:twin-dn')} mt=${keys.has('curated:twin-mt')}`,
  );
  check(
    '(10) the rescue is attributed to the identical-title lane',
    selection.rescuedIdenticalTitle === 2,
    `rescuedIdenticalTitle=${selection.rescuedIdenticalTitle}`,
  );
  check(
    '(10) the primary cut is still exactly MAX_NODES (twins came via rescue)',
    selection.primaryCount === MAX_NODES,
    `primaryCount=${selection.primaryCount}`,
  );
  check(
    '(10) INVARIANT: payload never exceeds HARD_NODE_CEILING',
    selection.allNodes.length <= HARD_NODE_CEILING,
    `payload=${selection.allNodes.length} > ${HARD_NODE_CEILING}`,
  );
  check(
    '(10) INVARIANT: no duplicate keys in the payload',
    keys.size === selection.allNodes.length,
    `${selection.allNodes.length - keys.size} duplicate key(s)`,
  );
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n[identical-title] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[identical-title] all checks passed');
process.exit(0);
