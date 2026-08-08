/**
 * Curated manual-MOVE durability + fail-closed regression (editor "move this
 * member to that OTHER story" must re-home atomically without fusing clusters).
 *
 * A move is saved as (itemUrl, snapshot of source-sibling anchor URLs, snapshot
 * of target-member anchor URLs). It is a DEDICATED overlay — NOT an eviction +
 * link composite — because reconcileMustLinkGroups runs BEFORE evictions each
 * pass, so a link naming both sides would FUSE the source and target clusters.
 * applyManualMoves runs AFTER applyManualEvictions on its output.
 *
 * This gate pins the pure, deterministic core WITHOUT DB/LLM/network:
 *
 *   (1) RE-HOME — the item leaves its source group and joins the target group;
 *       both groups otherwise intact (NO fusion); movedKeys reports it and
 *       evictedKeys does NOT (moved items may keep riding their new story).
 *   (2) IDEMPOTENCE — already sitting with enough target anchors -> no-op,
 *       pass after pass (the overlay re-applies every pass).
 *   (3) Manual-link precedence — an active raw link holding the item inside
 *       its CURRENT group beats the move (skip).
 *   (4) Fail-closed guards — a target group below the anchor guard is never
 *       selected; a multi-member source whose source anchors all churned out
 *       is never ripped apart (unrelated-cluster protection); < 2 resolvable
 *       target anchors never re-homes.
 *   (5) DEGRADE — when no valid target survives churn, the move degrades to a
 *       plain eviction ONLY at eviction grade (>= 2 resolvable source anchors
 *       + guard, never from a singleton); the item is re-seeded standalone
 *       (never lost) and reported in evictedKeys.
 *   (6) Determinism — identical outcome across reordered groups input, with
 *       the documented target tie-breaks (most anchors, then smaller group,
 *       then smallest member key).
 *
 * Exit 0 = PASS, exit 1 = FAIL.
 * Usage: npx tsx scripts/curated-move-durability.test.ts
 */

import {
  applyManualMoves,
  type ManualMoveResolved,
} from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[move-durability] OK   ${name}`);
  } else {
    console.error(`[move-durability] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers — mirrors the eviction-durability gate: URLs are already-
// normalized identity URLs; keyOf(u) mirrors urlToKey (one present key/URL).
// ---------------------------------------------------------------------------
const url = (host: string, id: string) => `https://${host}/article/${id}`;
const keyOf = (u: string) => `curated:${u.split('/').pop()}`;

function mv(partial: Partial<ManualMoveResolved> & { itemKey: string }): ManualMoveResolved {
  return {
    sourceAnchorKeys: new Set<string>(),
    sourceStoredCount: 0,
    sourceExpanded: false,
    targetAnchorKeys: new Set<string>(),
    targetStoredCount: 0,
    targetExpanded: false,
    ...partial,
  };
}

// ===========================================================================
// (1) RE-HOME happy path — atomic move, no fusion, movedKeys not evictedKeys.
// ===========================================================================
{
  const item = url('wrongstory.com', 'item1');
  const srcSibs = [url('ap.com', 's1'), url('reuters.com', 's2'), url('bbc.com', 's3')];
  const tgtMembers = [url('cnn.com', 't1'), url('fox.com', 't2'), url('npr.com', 't3')];
  const groups = [
    { keys: [keyOf(item), ...srcSibs.map(keyOf)] },
    { keys: tgtMembers.map(keyOf) },
  ];
  const res = applyManualMoves(groups, [mv({
    itemKey: keyOf(item),
    sourceAnchorKeys: new Set(srcSibs.map(keyOf)),
    sourceStoredCount: srcSibs.length,
    targetAnchorKeys: new Set(tgtMembers.map(keyOf)),
    targetStoredCount: tgtMembers.length,
  })]);
  check('(1) move applies', res.applied === 1);
  check('(1) item joined the target group',
    res.groups.some(g => g.keys.includes(keyOf(item)) && tgtMembers.every(u => g.keys.includes(keyOf(u)))));
  check('(1) source group intact minus the item (NO fusion)',
    res.groups.some(g => g.keys.length === srcSibs.length && srcSibs.every(u => g.keys.includes(keyOf(u))) && !g.keys.includes(keyOf(item))));
  check('(1) still exactly two groups (no fusion, no strays)', res.groups.length === 2);
  check('(1) movedKeys reports the item', res.movedKeys.has(keyOf(item)));
  check('(1) evictedKeys does NOT contain a genuinely moved key', !res.evictedKeys.has(keyOf(item)));
}

// ===========================================================================
// (2) IDEMPOTENCE — already home (enough target anchors in current group).
// ===========================================================================
{
  const item = url('moved.com', 'item2');
  const tgtMembers = [url('cnn.com', 'i1'), url('fox.com', 'i2'), url('npr.com', 'i3')];
  const groups = [{ keys: [keyOf(item), ...tgtMembers.map(keyOf)] }];
  const move = mv({
    itemKey: keyOf(item),
    sourceAnchorKeys: new Set([keyOf(url('old.com', 'o1')), keyOf(url('old.com', 'o2'))]),
    sourceStoredCount: 2,
    targetAnchorKeys: new Set(tgtMembers.map(keyOf)),
    targetStoredCount: tgtMembers.length,
  });
  const res = applyManualMoves(groups, [move]);
  check('(2) already-home move is a no-op', res.applied === 0);
  check('(2) group untouched', res.groups.length === 1 && res.groups[0].keys.length === 4);
  // Re-applying on the OUTPUT stays a no-op (pass-after-pass stability).
  const res2 = applyManualMoves(res.groups, [move]);
  check('(2) stays a no-op on its own output', res2.applied === 0 && res2.groups.length === 1);
}

// ===========================================================================
// (3) Manual-link precedence — an active raw link holding the item in its
// CURRENT group beats the move.
// ===========================================================================
{
  const item = url('linked.com', 'item3');
  const srcSibs = [url('ap.com', 'l1'), url('reuters.com', 'l2')];
  const tgtMembers = [url('cnn.com', 'l3'), url('fox.com', 'l4')];
  const groups = [
    { keys: [keyOf(item), ...srcSibs.map(keyOf)] },
    { keys: tgtMembers.map(keyOf) },
  ];
  const move = mv({
    itemKey: keyOf(item),
    sourceAnchorKeys: new Set(srcSibs.map(keyOf)),
    sourceStoredCount: srcSibs.length,
    targetAnchorKeys: new Set(tgtMembers.map(keyOf)),
    targetStoredCount: tgtMembers.length,
  });
  const holdingLink = [keyOf(item), keyOf(srcSibs[0])];
  const shielded = applyManualMoves(groups.map(g => ({ keys: g.keys.slice() })), [move], [holdingLink]);
  check('(3) link holding the item in its current group blocks the move', shielded.applied === 0);
  // A link NOT touching the item's current group does not shield.
  const elsewhereLink = [keyOf(item), keyOf(url('elsewhere.com', 'z9'))];
  const notShielded = applyManualMoves(groups.map(g => ({ keys: g.keys.slice() })), [move], [elsewhereLink]);
  check('(3) a link not touching the current group does NOT shield', notShielded.applied === 1);
}

// ===========================================================================
// (4) Fail-closed guards.
// ===========================================================================
{
  const item = url('guarded.com', 'item4');
  const srcSibs = [url('ap.com', 'g1'), url('reuters.com', 'g2'), url('bbc.com', 'g3')];

  // (4a) EXPANDED target set of 30 anchors -> guard requires ceil(3); a group
  // holding only TWO of them is never selected -> no target; source is fine so
  // the move degrades to eviction instead of mis-homing.
  const expandedTgt = Array.from({ length: 30 }, (_, i) => url('adopted.com', `x${i}`));
  const weakTarget = [expandedTgt[0], expandedTgt[1], url('other.com', 'u1'), url('other.com', 'u2')];
  const groupsA = [
    { keys: [keyOf(item), ...srcSibs.map(keyOf)] },
    { keys: weakTarget.map(keyOf) },
  ];
  const resA = applyManualMoves(groupsA, [mv({
    itemKey: keyOf(item),
    sourceAnchorKeys: new Set(srcSibs.map(keyOf)),
    sourceStoredCount: srcSibs.length,
    targetAnchorKeys: new Set(expandedTgt.map(keyOf)),
    targetStoredCount: 4,
    targetExpanded: true,
  })]);
  check('(4a) under-anchored group never selected as target (2 < required 3)',
    !resA.groups.some(g => g.keys.includes(keyOf(item)) && g.keys.includes(keyOf(weakTarget[2]))));
  check('(4a) degrades to eviction instead (source gate holds)',
    resA.evictedKeys.has(keyOf(item)) && !resA.movedKeys.has(keyOf(item)));

  // (4b) Multi-member SOURCE whose source anchors all churned out (item now in
  // an UNRELATED group) -> never ripped out, even with a perfect target.
  const unrelated = [url('unrelated.com', 'w1'), url('unrelated.com', 'w2'), url('unrelated.com', 'w3')];
  const tgtMembers = [url('cnn.com', 'g4'), url('fox.com', 'g5')];
  const groupsB = [
    { keys: [keyOf(item), ...unrelated.map(keyOf)] },
    { keys: tgtMembers.map(keyOf) },
  ];
  const resB = applyManualMoves(groupsB, [mv({
    itemKey: keyOf(item),
    sourceAnchorKeys: new Set(srcSibs.map(keyOf)), // none present in the unrelated group
    sourceStoredCount: srcSibs.length,
    targetAnchorKeys: new Set(tgtMembers.map(keyOf)),
    targetStoredCount: tgtMembers.length,
  })]);
  check('(4b) source-anchor guard: item never ripped out of an unrelated group', resB.applied === 0);
  check('(4b) unrelated group untouched',
    resB.groups.some(g => g.keys.length === 4 && g.keys.includes(keyOf(item))));

  // (4c) < 2 resolvable target anchors -> no re-home (degrade path only).
  const groupsC = [
    { keys: [keyOf(item), ...srcSibs.map(keyOf)] },
    { keys: [keyOf(url('cnn.com', 'g6')), keyOf(url('fox.com', 'g7'))] },
  ];
  const resC = applyManualMoves(groupsC, [mv({
    itemKey: keyOf(item),
    sourceAnchorKeys: new Set(srcSibs.map(keyOf)),
    sourceStoredCount: srcSibs.length,
    targetAnchorKeys: new Set([keyOf(url('cnn.com', 'g6'))]), // only ONE resolvable
    targetStoredCount: 3,
  })]);
  check('(4c) a lone resolvable target anchor never re-homes', !resC.movedKeys.has(keyOf(item)));

  // (4d) Item aged out this pass -> pure no-op.
  const resD = applyManualMoves([{ keys: srcSibs.map(keyOf) }], [mv({
    itemKey: keyOf(item),
    sourceAnchorKeys: new Set(srcSibs.map(keyOf)),
    sourceStoredCount: srcSibs.length,
    targetAnchorKeys: new Set([keyOf(url('cnn.com', 'g8')), keyOf(url('fox.com', 'g9'))]),
    targetStoredCount: 2,
  })]);
  check('(4d) absent item no-ops', resD.applied === 0 && resD.groups.length === 1);
}

// ===========================================================================
// (5) DEGRADE to eviction — target dispersed; eviction-grade gate only.
// ===========================================================================
{
  const item = url('degrade.com', 'item5');
  const srcSibs = [url('ap.com', 'd1'), url('reuters.com', 'd2'), url('bbc.com', 'd3')];
  const goneTgt = [url('gone.com', 'd4'), url('gone.com', 'd5')]; // target aged out entirely
  const baseMove = mv({
    itemKey: keyOf(item),
    sourceAnchorKeys: new Set(srcSibs.map(keyOf)),
    sourceStoredCount: srcSibs.length,
    targetAnchorKeys: new Set(goneTgt.map(keyOf)),
    targetStoredCount: goneTgt.length,
  });

  // (5a) Eviction-grade source gate holds -> degrade fires; item re-seeded
  // standalone and reported in evictedKeys.
  const resA = applyManualMoves([{ keys: [keyOf(item), ...srcSibs.map(keyOf)] }], [baseMove]);
  check('(5a) degrade fires at eviction grade', resA.applied === 1 && resA.evictedKeys.has(keyOf(item)));
  check('(5a) item re-seeded as standalone singleton (never lost)',
    resA.groups.some(g => g.keys.length === 1 && g.keys[0] === keyOf(item)));
  check('(5a) source members intact',
    resA.groups.some(g => g.keys.length === srcSibs.length && srcSibs.every(u => g.keys.includes(keyOf(u)))));
  check('(5a) degraded key NOT in movedKeys', !resA.movedKeys.has(keyOf(item)));

  // (5b) < 2 resolvable source anchors -> degrade fail-closed no-op.
  const weak = { ...baseMove, sourceAnchorKeys: new Set([keyOf(srcSibs[0])]) };
  const resB = applyManualMoves([{ keys: [keyOf(item), ...srcSibs.map(keyOf)] }], [weak]);
  check('(5b) degrade never fires off a lone source anchor', resB.applied === 0);

  // (5c) Singleton source -> already standalone, degrade is meaningless -> no-op.
  const resC = applyManualMoves([{ keys: [keyOf(item)] }, { keys: srcSibs.map(keyOf) }], [baseMove]);
  check('(5c) singleton source never degrades', resC.applied === 0 && resC.evictedKeys.size === 0);

  // (5d) Singleton source IS always extractable to a VALID target.
  const tgtMembers = [url('cnn.com', 'd6'), url('fox.com', 'd7')];
  const single = mv({
    itemKey: keyOf(item),
    sourceAnchorKeys: new Set<string>(), // singleton — no siblings stored
    sourceStoredCount: 0,
    targetAnchorKeys: new Set(tgtMembers.map(keyOf)),
    targetStoredCount: tgtMembers.length,
  });
  const resD = applyManualMoves([{ keys: [keyOf(item)] }, { keys: tgtMembers.map(keyOf) }], [single]);
  check('(5d) singleton re-homes into a valid target',
    resD.applied === 1 && resD.movedKeys.has(keyOf(item)) &&
    resD.groups.some(g => g.keys.includes(keyOf(item)) && g.keys.length === 3));
}

// ===========================================================================
// (6) Determinism + documented target tie-breaks.
// ===========================================================================
{
  const item = url('tie.com', 'item6');
  const srcSibs = [url('ap.com', 'e1'), url('reuters.com', 'e2')];
  const tgt = [url('cnn.com', 'e3'), url('fox.com', 'e4'), url('npr.com', 'e5'), url('wsj.com', 'e6')];
  // Two candidate targets: A holds 3 anchors, B holds 2 -> A must win.
  const groupA = [tgt[0], tgt[1], tgt[2], url('extraA.com', 'a1')];
  const groupB = [tgt[3], tgt[0], url('extraB.com', 'b1')]; // shares tgt[0]? no — keys are per-URL; use distinct
  // Rebuild B without overlapping URLs (each URL lives in ONE group):
  const groupB2 = [tgt[3], url('extraB.com', 'b1'), url('extraB.com', 'b2')];
  const move = mv({
    itemKey: keyOf(item),
    sourceAnchorKeys: new Set(srcSibs.map(keyOf)),
    sourceStoredCount: srcSibs.length,
    targetAnchorKeys: new Set(tgt.map(keyOf)),
    targetStoredCount: tgt.length,
  });
  const mk = (arr: string[][]) => arr.map(keys => ({ keys: keys.slice() }));
  const fwd = applyManualMoves(mk([
    [keyOf(item), ...srcSibs.map(keyOf)], groupA.map(keyOf), groupB2.map(keyOf),
  ]), [move]);
  const rev = applyManualMoves(mk([
    groupB2.map(keyOf), groupA.map(keyOf), [keyOf(item), ...srcSibs.map(keyOf)],
  ]), [move]);
  const homeOf = (r: { groups: { keys: string[] }[] }) =>
    r.groups.find(g => g.keys.includes(keyOf(item)))!.keys.slice().sort().join('|');
  check('(6) most-anchors target wins', fwd.groups.some(g =>
    g.keys.includes(keyOf(item)) && g.keys.includes(keyOf(groupA[0]))));
  check('(6) deterministic across group order', homeOf(fwd) === homeOf(rev) && fwd.applied === rev.applied);
  void groupB;
}

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? '[move-durability] ALL PASS'
    : `[move-durability] ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
