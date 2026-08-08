// =============================================================================
// Gate: curated-manual-link-repartition
//
// Asserts that a manually-linked editor key set survives a re-partition split
// overlay in a SINGLE deterministic pass — the "human override beats machine
// re-partition" guarantee. No live AI, no DB, no network required.
//
// Exit 0 = PASS, exit 1 = FAIL (per harness convention).
// =============================================================================
import { applySplitOverlays } from '../server/curatedRepartition';
import type { ClusterGroup, LaneNode } from '../server/curatedCluster';
import type { CuratedProcessSplitOverlay } from '../shared/schema';

// ---------------------------------------------------------------------------
// Minimal LaneNode factory — only the fields applySplitOverlays touches.
// ---------------------------------------------------------------------------
function makeNode(id: string, url: string, title: string): LaneNode {
  return {
    key: `curated:${id}`,
    url,
    title,
    priority: 50,
    publishedAt: new Date().toISOString(),
    scrapedAt: new Date().toISOString(),
    source: 'test',
    sourceName: 'Test Outlet',
    cls: 'corroborating' as const,
    label: 'normal' as const,
    category: null,
    contentKind: null,
    imageUrl: null,
    bullets: null,
    claims: null,
    mediaScrapedAt: null,
    isLiveStream: false,
    isDeadLink: false,
  } as unknown as LaneNode;
}

// memberSignatureToken logic mirrors curatedSynthesis (url normalized, else key).
function tok(url: string, key: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString().toLowerCase().replace(/\/$/, '');
  } catch {
    return key;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// 7 URLs that the editor manually linked (the US–Iran/Hormuz scenario).
const LINKED_URLS = [
  'https://www.newsnation.com/world/iran-targets-gulf-arab-nations-amid-new-us-strikes/',
  'https://www.aljazeera.com/news/2025/iran-us-strikes-hormuz',
  'https://www.france24.com/en/middle-east/2025/iran-gulf-hormuz',
  'https://www.theguardian.com/world/2025/iran-closes-strait-hormuz',
  'https://www.cnn.com/2025/middle-east/iran-hormuz-strike',
  'https://sputnikglobe.com/2025/iran-closes-strait',
  'https://www.al-monitor.com/originals/2025/iran-hormuz-us',
];

const nodes: LaneNode[] = LINKED_URLS.map((url, i) => makeNode(`n${i}`, url, `Iran/Hormuz story headline ${i}`));

// Three more "unlinked" nodes that belong to different sub-threads of the same
// developing-process mega-cluster.
const unlinked: LaneNode[] = [
  makeNode('u0', 'https://www.bbc.com/news/uae-missile-warning', 'UAE warns of incoming missile strikes'),
  makeNode('u1', 'https://www.reuters.com/world/uae-warning-missile', 'UAE issues missile warning amid Iran standoff'),
  makeNode('u2', 'https://apnews.com/article/iran-hormuz-closed', 'Iran announces Hormuz closure'),
];

const allNodes = [...nodes, ...unlinked];
const nodeByKey = new Map<string, LaneNode>(allNodes.map(n => [n.key, n]));

// The overlay the AI built when the cluster was last evaluated — it puts
// LINKED items into two DIFFERENT children (child-A and child-B), which is
// exactly what the editor's manual link must override.
const OVERLAY_ID = 'ov-test-001';
const childATokens = LINKED_URLS.slice(0, 4).map(u => tok(u, ''));  // NewsNation, AJ, F24, Guardian
const childBTokens = [
  ...LINKED_URLS.slice(4).map(u => tok(u, '')),  // CNN, Sputnik, Al-Monitor
  tok(unlinked[0].url, unlinked[0].key),
  tok(unlinked[1].url, unlinked[1].key),
];
const childCTokens = [tok(unlinked[2].url, unlinked[2].key)];

const overlay: CuratedProcessSplitOverlay = {
  id: OVERLAY_ID,
  status: 'active',
  createdAt: new Date(),
  lastEvaluatedAt: new Date(),
  memberTokens: [...childATokens, ...childBTokens, ...childCTokens],
  children: [
    {
      childKey: 'child-A',
      label: 'Iran targets Gulf states / new US strikes',
      anchorTokens: ['iran', 'gulf', 'strikes'],
      memberTokens: childATokens,
    },
    {
      childKey: 'child-B',
      label: 'UAE missile warning / Iran CNN Sputnik',
      anchorTokens: ['uae', 'missile', 'warning'],
      memberTokens: childBTokens,
    },
    {
      childKey: 'child-C',
      label: 'Hormuz closure announcement',
      anchorTokens: ['hormuz', 'closed', 'closure'],
      memberTokens: childCTokens,
    },
  ] as any,
} as any;

// The one reconciled group that the editor's manual link produced (all 10 nodes
// together, just as reconcileMustLinkGroups would output them).
const reconciledGroup: ClusterGroup = {
  keys: allNodes.map(n => n.key),
};

// Editor's manual-link groups: all 7 linked keys must stay together.
const manualLinkKeyGroups: string[][] = [
  nodes.map(n => n.key),
];

// ---------------------------------------------------------------------------
// T1: Without protection — the overlay scatters the linked set
// ---------------------------------------------------------------------------
console.log('\nT1: Without manualLinkKeyGroups — verifying that the overlay DOES scatter the linked set');
{
  const result = applySplitOverlays([reconciledGroup], nodeByKey, [overlay]);
  // Linked keys should appear in MORE than one output group (the bug scenario).
  const linkedKeys = new Set(nodes.map(n => n.key));
  const groupsContainingLinkedKeys = result.filter(g => g.keys.some(k => linkedKeys.has(k)));
  assert(
    groupsContainingLinkedKeys.length > 1,
    `Without protection, linked keys are scattered across ${groupsContainingLinkedKeys.length} groups (confirming the bug exists)`,
  );
  // Union invariant: no keys are dropped.
  const allOut = result.flatMap(g => g.keys);
  assert(
    allOut.length === allNodes.length,
    `Union invariant: all ${allNodes.length} keys present in output (got ${allOut.length})`,
  );
}

// ---------------------------------------------------------------------------
// T2: With protection — all linked keys end up in the SAME output group
// ---------------------------------------------------------------------------
console.log('\nT2: With manualLinkKeyGroups — linked set must be consolidated into one group');
{
  const result = applySplitOverlays([reconciledGroup], nodeByKey, [overlay], manualLinkKeyGroups);

  const linkedKeys = new Set(nodes.map(n => n.key));
  const groupsContainingLinkedKeys = result.filter(g => g.keys.some(k => linkedKeys.has(k)));

  assert(
    groupsContainingLinkedKeys.length === 1,
    `All linked keys land in exactly 1 output group (got ${groupsContainingLinkedKeys.length})`,
  );

  if (groupsContainingLinkedKeys.length === 1) {
    const winner = groupsContainingLinkedKeys[0];
    for (const n of nodes) {
      assert(
        winner.keys.includes(n.key),
        `Linked key ${n.key} is present in the consolidated group`,
      );
    }
  }

  // Union invariant: no keys are dropped by the consolidation.
  const allOut = result.flatMap(g => g.keys);
  const allKeys = allNodes.map(n => n.key).sort();
  const outKeys = allOut.slice().sort();
  assert(
    JSON.stringify(outKeys) === JSON.stringify(allKeys),
    `Union invariant: all ${allNodes.length} keys present in output after consolidation`,
  );

  // Non-linked nodes (unlinked[0], unlinked[1], unlinked[2]) may still be in
  // different groups — the re-partition is ONLY suppressed for the linked set.
  const unlinkedKeys = new Set(unlinked.map(n => n.key));
  const unlinkedGroupCount = result.filter(g => g.keys.some(k => unlinkedKeys.has(k))).length;
  console.log(`  INFO: Unlinked nodes appear in ${unlinkedGroupCount} group(s) — re-partition still applies to them`);
}

// ---------------------------------------------------------------------------
// T3: A link group with only 1 member present in the cluster — no-op
// ---------------------------------------------------------------------------
console.log('\nT3: A link group with only 1 member in the cluster — no consolidation needed');
{
  const singletonLink = [nodes[0].key, 'curated:absent-node'];
  const result = applySplitOverlays([reconciledGroup], nodeByKey, [overlay], [singletonLink]);
  const allOut = result.flatMap(g => g.keys);
  assert(
    allOut.length === allNodes.length,
    `Union invariant holds with a partial link group (${allOut.length} keys)`,
  );
}

// ---------------------------------------------------------------------------
// T4: Multiple independent link groups — each is consolidated independently
// ---------------------------------------------------------------------------
console.log('\nT4: Two independent link groups — each consolidated separately');
{
  const link1 = nodes.slice(0, 3).map(n => n.key);  // NewsNation, AJ, F24
  const link2 = nodes.slice(3, 7).map(n => n.key);  // Guardian, CNN, Sputnik, Al-Monitor
  const result = applySplitOverlays([reconciledGroup], nodeByKey, [overlay], [link1, link2]);

  const link1Set = new Set(link1);
  const link2Set = new Set(link2);
  const groupsForLink1 = result.filter(g => g.keys.some(k => link1Set.has(k)));
  const groupsForLink2 = result.filter(g => g.keys.some(k => link2Set.has(k)));

  // Each link group must be in at most 1 group after consolidation.
  assert(
    groupsForLink1.length <= 1,
    `Link group 1 (3 members) is in ≤1 output group (got ${groupsForLink1.length})`,
  );
  assert(
    groupsForLink2.length <= 1,
    `Link group 2 (4 members) is in ≤1 output group (got ${groupsForLink2.length})`,
  );

  const allOut = result.flatMap(g => g.keys);
  assert(
    allOut.length === allNodes.length,
    `Union invariant holds with two independent link groups (${allOut.length} keys)`,
  );
}

// ---------------------------------------------------------------------------
// T5: No overlays — identity pass-through is unaffected
// ---------------------------------------------------------------------------
console.log('\nT5: No active overlays — identity pass-through with manualLinkKeyGroups has no effect');
{
  const result = applySplitOverlays([reconciledGroup], nodeByKey, [], manualLinkKeyGroups);
  assert(result.length === 1, `Returns 1 group unchanged when no overlays are active`);
  assert(result[0].keys.length === allNodes.length, `All ${allNodes.length} keys returned unchanged`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n[curated-manual-link-repartition] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[curated-manual-link-repartition] GATE FAILED');
  process.exit(1);
}
console.log('[curated-manual-link-repartition] all checks passed');
process.exit(0);
