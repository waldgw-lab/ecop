/**
 * Curated smart process re-partition regression (Task #391).
 *
 * A developing-process MEGA-cluster (a long-running negotiation/ceasefire that
 * keeps accreting distinct sub-threads) is SPLIT by a gated Claude pass into its
 * distinct CURRENT sub-stories. The AI verdict is PERSISTED as a member-token
 * overlay so the decision is STABLE across passes (the cluster table is rebuilt
 * every pass). This pins the pure, deterministic core of that feature WITHOUT the
 * LLM / DB / network (the model `complete` and the overlay `persist` are injected
 * as deps), so it runs as a fast regression gate:
 *
 *   (1) applySplitOverlays is DETERMINISTIC — identical partition across reordered
 *       inputs, and NEVER loses a member (children ∪ residual parent === input).
 *   (2) New-member routing — a known token lands in its child; an UNKNOWN token
 *       with strong title/anchor overlap routes to the best child; an ambiguous
 *       unknown token falls to the residual parent (lineage null).
 *   (3) Size/age gate — below-gate clusters are never sent to the model.
 *   (4) Cooldown + material-change — an overlay within cooldown, or whose
 *       membership did not change enough, is NOT re-asked.
 *   (5) AI-failure is fail-closed — a null/throwing/unparseable model reply leaves
 *       the cluster INTACT and persists NOTHING (ret* next eligible pass), losing
 *       no members.
 *   (6) Balance caps — a verdict with < 2 children that each have >= 2
 *       corroborating distinct publishers is treated as LEAVE-INTACT.
 *   (7) Sibling archive non-merge — each surviving child gets a DISTINCT lineage
 *       key (`<overlayId>:<childKey>`), the guard that keeps siblings from
 *       carry-forward-merging in the archive.
 *
 * Exits non-zero on any violation.
 *
 * Usage:  tsx scripts/curated-process-repartition.test.ts
 */

import {
  applySplitOverlays,
  evaluateProcessRepartition,
  findOverlayForEval,
  childLineageKey,
  passesRepartitionGate,
  clusterSpanHours,
  SPLIT_SPAN_H,
  SPLIT_SPAN_SIZE_FLOOR,
  hasMaterialChange,
  buildSplitChildren,
  shouldEvaluateRepartitionCandidate,
  repartitionBudgetExhausted,
  type RepartitionBudget,
  type RepartitionOverlayWrite,
  type SplitAppliedGroup,
} from '../server/curatedRepartition';
import type { LaneNode, ClusterGroup } from '../server/curatedCluster';
import { memberSignatureToken } from '../server/curatedSynthesis';
import type {
  CuratedProcessSplitOverlay,
  CuratedSplitChild,
} from '@shared/schema';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[repartition] OK   ${name}`);
  } else {
    console.error(`[repartition] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Fixture builder. A node's stable token is memberSignatureToken(url, key) — the
// SAME helper the overlay's persisted memberTokens use — so we compute tokens
// here exactly as the production grouping/overlay matching does.
// ---------------------------------------------------------------------------
let seq = 0;
function makeNode(opts: {
  title: string;
  source: string;
  host: string;
  corroborating?: boolean;
  ageH?: number;
}): LaneNode {
  const id = `n${seq++}`;
  const url = `https://${opts.host}/article/${id}`;
  const publishedAt =
    opts.ageH != null ? new Date(Date.now() - opts.ageH * 3_600_000) : new Date();
  return {
    key: `curated:${id}`,
    itemType: 'curated',
    itemId: id,
    title: opts.title,
    source: opts.source,
    url,
    category: null,
    cls: opts.corroborating === false ? 'anchor' : 'corroborating',
    label: 'corroborating',
    role: 'corroborating',
    blocked: false,
    priority: 80,
    ogImageUrl: null,
    publishedAt,
    sourceIdentifier: opts.source,
    factuality: 'high',
    ownership: [opts.source],
    summary: null,
    bullets: null,
  } as LaneNode;
}
const tok = (n: LaneNode): string => memberSignatureToken(n.url, n.key);

// Build an overlay (active by default) from explicit child member-node sets.
function makeOverlay(opts: {
  id: string;
  status?: string;
  children: Array<{ childKey: string; label: string; members: LaneNode[]; anchors?: string[] }>;
  lastEvaluatedAt?: Date;
  evaluatedMemberHash?: string;
  evaluatedMemberCount?: number;
}): CuratedProcessSplitOverlay {
  const children: CuratedSplitChild[] = opts.children.map((c) => ({
    childKey: c.childKey,
    label: c.label,
    anchorTokens: c.anchors ?? [],
    memberTokens: c.members.map(tok),
  }));
  return {
    id: opts.id,
    children,
    verdictHash: 'vh',
    evaluatedMemberHash: opts.evaluatedMemberHash ?? 'mh',
    evaluatedMemberCount: opts.evaluatedMemberCount ?? 0,
    triggerReason: 'size',
    status: opts.status ?? 'active',
    lastEvaluatedAt: opts.lastEvaluatedAt ?? new Date(),
    createdAt: new Date(),
  } as CuratedProcessSplitOverlay;
}

function nodeByKeyOf(nodes: LaneNode[]): Map<string, LaneNode> {
  return new Map(nodes.map((n) => [n.key, n]));
}
const sortedKeys = (g: { keys: string[] }): string[] => [...g.keys].sort();
const groupSig = (groups: SplitAppliedGroup[]): string =>
  groups
    .map((g) => `${g.splitLineageKey ?? '∅'}=[${sortedKeys(g).join(',')}]`)
    .sort()
    .join('|');

// ===========================================================================
// (1) DETERMINISTIC APPLICATION + NO MEMBER LOSS.
// One mega-cluster split into two children; a couple of unrelated small groups
// pass through untouched. Re-run with reversed inputs → identical partition.
// ===========================================================================
{
  // Child A: IAEA inspections (3 distinct publishers).
  const a1 = makeNode({ title: 'IAEA inspectors return to Natanz enrichment site', source: 'Reuters', host: 'reuters.com' });
  const a2 = makeNode({ title: 'IAEA inspection team granted access under deal', source: 'AP', host: 'apnews.com' });
  const a3 = makeNode({ title: 'Inspectors verify Natanz centrifuge cascade', source: 'BBC', host: 'bbc.com' });
  // Child B: Rubio statement (3 distinct publishers).
  const b1 = makeNode({ title: 'Rubio says talks must include verification', source: 'Fox', host: 'foxnews.com' });
  const b2 = makeNode({ title: 'Rubio warns of consequences without inspections deal', source: 'CNN', host: 'cnn.com' });
  const b3 = makeNode({ title: 'Secretary Rubio briefs Senate on negotiations', source: 'NBC', host: 'nbcnews.com' });
  const mega = [a1, a2, a3, b1, b2, b3];

  // Unrelated small groups (no overlay covers them).
  const u1 = makeNode({ title: 'Carrier transits Strait', source: 'USNI', host: 'news.usni.org' });
  const u2 = makeNode({ title: 'Carrier strike group underway', source: 'Stripes', host: 'stripes.com' });

  const overlay = makeOverlay({
    id: 'ov1',
    children: [
      { childKey: 'iaea', label: 'IAEA inspections', members: [a1, a2, a3], anchors: ['iaea', 'inspectors', 'natanz'] },
      { childKey: 'rubio', label: 'Rubio statement', members: [b1, b2, b3], anchors: ['rubio'] },
    ],
  });

  const groups: ClusterGroup[] = [
    { keys: mega.map((n) => n.key) },
    { keys: [u1.key, u2.key] },
  ];
  const nbk = nodeByKeyOf([...mega, u1, u2]);

  const out1 = applySplitOverlays(groups, nbk, [overlay]);
  // Reverse group order AND member order within each group → must be identical.
  const groupsRev: ClusterGroup[] = [
    { keys: [u2.key, u1.key] },
    { keys: [...mega].reverse().map((n) => n.key) },
  ];
  const out2 = applySplitOverlays(groupsRev, nbk, [overlay]);

  check('(1) application is deterministic across reordered inputs', groupSig(out1) === groupSig(out2), groupSig(out1) + ' !== ' + groupSig(out2));

  // The mega split into exactly two lineage-bearing children + (no residual since
  // every member routed) and the unrelated group passes through with null lineage.
  const childGroups = out1.filter((g) => g.splitLineageKey);
  check('(1) mega-cluster split into 2 children', childGroups.length === 2, `got ${childGroups.length}`);
  const lineageKeys = new Set(childGroups.map((g) => g.splitLineageKey));
  check('(1) children carry distinct lineage keys', lineageKeys.size === 2);
  check(
    '(1) child lineage keys are <overlayId>:<childKey>',
    lineageKeys.has(childLineageKey('ov1', 'iaea')) && lineageKeys.has(childLineageKey('ov1', 'rubio')),
  );

  // NO MEMBER LOSS: union of every emitted group's keys === union of inputs.
  const inAll = new Set([...mega, u1, u2].map((n) => n.key));
  const outAll = new Set(out1.flatMap((g) => g.keys));
  check('(1) no member lost (input set === output set)', inAll.size === outAll.size && [...inAll].every((k) => outAll.has(k)));

  // The unrelated group is untouched and carries no lineage.
  const passthrough = out1.find((g) => g.keys.includes(u1.key));
  check('(1) unrelated group passes through with null lineage', !!passthrough && !passthrough.splitLineageKey && passthrough.keys.length === 2);
}

// ===========================================================================
// (2) NEW-MEMBER ROUTING. A node that arrives AFTER the overlay was built (its
// token is unknown) routes to the child it best matches by TITLE/anchor overlap;
// an unknown node matching NO child falls to the residual parent (lineage null).
// ===========================================================================
{
  const a1 = makeNode({ title: 'IAEA inspectors return to Natanz site', source: 'Reuters', host: 'reuters.com' });
  const a2 = makeNode({ title: 'IAEA inspection access granted under deal', source: 'AP', host: 'apnews.com' });
  const b1 = makeNode({ title: 'Rubio says verification is essential', source: 'Fox', host: 'foxnews.com' });
  const b2 = makeNode({ title: 'Rubio briefs Senate on the negotiations', source: 'CNN', host: 'cnn.com' });
  // NEW members (unknown tokens) — one clearly IAEA, one clearly Rubio, one off-topic.
  const aNew = makeNode({ title: 'IAEA inspectors expand Natanz inspection rounds', source: 'BBC', host: 'bbc.com' });
  const bNew = makeNode({ title: 'Rubio doubles down on verification demand', source: 'NBC', host: 'nbcnews.com' });
  const orphan = makeNode({ title: 'Stock markets rally on tech earnings', source: 'CNBC', host: 'cnbc.com' });

  const overlay = makeOverlay({
    id: 'ov2',
    children: [
      { childKey: 'iaea', label: 'IAEA inspections', members: [a1, a2], anchors: ['iaea', 'inspectors', 'natanz', 'inspection'] },
      { childKey: 'rubio', label: 'Rubio statement', members: [b1, b2], anchors: ['rubio', 'verification', 'senate'] },
    ],
  });

  const all = [a1, a2, b1, b2, aNew, bNew, orphan];
  const nbk = nodeByKeyOf(all);
  const out = applySplitOverlays([{ keys: all.map((n) => n.key) }], nbk, [overlay]);

  const iaeaGroup = out.find((g) => g.splitLineageKey === childLineageKey('ov2', 'iaea'));
  const rubioGroup = out.find((g) => g.splitLineageKey === childLineageKey('ov2', 'rubio'));
  const parent = out.find((g) => !g.splitLineageKey);

  check('(2) new IAEA member routed to IAEA child', !!iaeaGroup && iaeaGroup.keys.includes(aNew.key), 'aNew misrouted');
  check('(2) new Rubio member routed to Rubio child', !!rubioGroup && rubioGroup.keys.includes(bNew.key), 'bNew misrouted');
  check('(2) off-topic new member falls to residual parent (null lineage)', !!parent && parent.keys.includes(orphan.key));
  // Still no member loss.
  const outAll = new Set(out.flatMap((g) => g.keys));
  check('(2) routing loses no member', all.every((n) => outAll.has(n.key)) && outAll.size === all.length);
}

// (2b) AMBIGUOUS new member — a title that overlaps BOTH children's anchors equally
// must route to the residual PARENT (null lineage), never be arbitrarily assigned.
{
  const a1 = makeNode({ title: 'IAEA inspectors at Natanz', source: 'Reuters', host: 'reuters.com' });
  const a2 = makeNode({ title: 'IAEA inspection access granted', source: 'AP', host: 'apnews.com' });
  const b1 = makeNode({ title: 'Rubio demands verification', source: 'Fox', host: 'foxnews.com' });
  const b2 = makeNode({ title: 'Rubio briefs Senate', source: 'CNN', host: 'cnn.com' });
  // New node whose title hits EXACTLY one anchor token from each child (tie).
  const ambiguous = makeNode({ title: 'Rubio comments on IAEA findings', source: 'BBC', host: 'bbc.com' });

  const overlay = makeOverlay({
    id: 'ov2b',
    children: [
      { childKey: 'iaea', label: 'IAEA inspections', members: [a1, a2], anchors: ['iaea'] },
      { childKey: 'rubio', label: 'Rubio statement', members: [b1, b2], anchors: ['rubio'] },
    ],
  });
  const all = [a1, a2, b1, b2, ambiguous];
  const nbk = nodeByKeyOf(all);
  const out = applySplitOverlays([{ keys: all.map((n) => n.key) }], nbk, [overlay]);
  const parent = out.find((g) => !g.splitLineageKey);
  check('(2b) tie-overlap new member routes to residual parent (not arbitrary child)', !!parent && parent.keys.includes(ambiguous.key));
  const inChild = out.some((g) => g.splitLineageKey && g.keys.includes(ambiguous.key));
  check('(2b) tie-overlap new member is NOT placed in any child', !inChild);
}

// ===========================================================================
// (3) SIZE/AGE GATE — below-gate clusters never reach the model.
// ===========================================================================
{
  check('(3) size >= 50 qualifies', passesRepartitionGate(50, 0).qualifies && passesRepartitionGate(50, 0).reason === 'size');
  check('(3) age >= 16h & size >= 25 qualifies', passesRepartitionGate(30, 20).qualifies && passesRepartitionGate(30, 20).reason === 'age');
  check('(3) small recent cluster does NOT qualify', !passesRepartitionGate(30, 5).qualifies);
  check('(3) old but tiny cluster does NOT qualify', !passesRepartitionGate(10, 40).qualifies);
  // Legacy-gate qualifiers are NOT tagged as prevention.
  check('(3) backstop qualifier is not prevention', passesRepartitionGate(50, 0).prevention === false);

  // ---- Early PREVENTION gate (Task #414) — developing-process clusters only ----
  // A 30-member process cluster splits at ANY age (vs 50 generic backstop).
  check(
    '(3) process cluster of 30 qualifies EARLY at any age',
    passesRepartitionGate(30, 1, { developingProcess: true }).qualifies &&
      passesRepartitionGate(30, 1, { developingProcess: true }).prevention === true,
  );
  // ...but a NON-process cluster of 30 at 1h does NOT (no early gate for it).
  check('(3) non-process cluster of 30 at 1h does NOT qualify', !passesRepartitionGate(30, 1).qualifies);
  // Early age path: a process cluster 8h+ old at 18+ members qualifies.
  check(
    '(3) process cluster 18@8h qualifies EARLY via age',
    passesRepartitionGate(18, 8, { developingProcess: true }).qualifies &&
      passesRepartitionGate(18, 8, { developingProcess: true }).reason === 'age' &&
      passesRepartitionGate(18, 8, { developingProcess: true }).prevention === true,
  );
  // ...but the same shape is below-gate for a non-process cluster.
  check('(3) non-process cluster 18@8h does NOT qualify', !passesRepartitionGate(18, 8).qualifies);
  // Too small / too young even for a process cluster → still below gate.
  check(
    '(3) tiny young process cluster does NOT qualify even early',
    !passesRepartitionGate(12, 2, { developingProcess: true }).qualifies,
  );
  // A process cluster that crosses the legacy backstop is tagged backstop, not prevention.
  check(
    '(3) process cluster of 50 is BACKSTOP not prevention',
    passesRepartitionGate(50, 0, { developingProcess: true }).qualifies &&
      passesRepartitionGate(50, 0, { developingProcess: true }).prevention === false,
  );

  // ---- Aged-process recall (Task #440) -------------------------------------
  // An OLDER process cluster qualifies at an even LOWER size (15) than the early
  // age floor (18), so a modest process story that quietly aged past 16h is still
  // evaluated before it balloons into a 50-member dumping ground.
  check(
    '(3) aged process cluster 15@16h qualifies EARLY via age (prevention)',
    passesRepartitionGate(15, 16, { developingProcess: true }).qualifies &&
      passesRepartitionGate(15, 16, { developingProcess: true }).reason === 'age' &&
      passesRepartitionGate(15, 16, { developingProcess: true }).prevention === true,
  );
  // ...but the SAME aged-and-modest shape stays below-gate for a NON-process
  // cluster (the aged-process recall is process-only, fail-closed).
  check('(3) non-process cluster 15@16h does NOT qualify', !passesRepartitionGate(15, 16).qualifies);
  // Just under the aged-process size floor stays below-gate even when old.
  check(
    '(3) process cluster 14@16h is below the aged floor',
    !passesRepartitionGate(14, 16, { developingProcess: true }).qualifies,
  );
  // Right at the floor but not yet old enough stays below-gate (needs both).
  check(
    '(3) process cluster 15@12h (not old enough) does NOT qualify via aged path',
    !passesRepartitionGate(15, 12, { developingProcess: true }).qualifies,
  );

  // ---- Long-SPAN branch — ANY cluster whose member published dates span ----
  // >= SPLIT_SPAN_H while >= SPLIT_SPAN_SIZE_FLOOR members qualifies even when
  // NON-process (kinetic vocabulary never trips the process detector, but a
  // 25h-wide 20+ member cluster is no longer plausibly one time-compact event).
  {
    const spanGate = passesRepartitionGate(SPLIT_SPAN_SIZE_FLOOR, 5, {
      spanH: SPLIT_SPAN_H,
    });
    check(
      '(3s) NON-process cluster at span/size floors qualifies via span (prevention)',
      spanGate.qualifies && spanGate.reason === 'span' && spanGate.prevention === true,
    );
    // Span is checked AFTER the process branches — a process cluster that also
    // qualifies via the early size floor keeps its 'size' reason.
    const processFirst = passesRepartitionGate(30, 1, {
      developingProcess: true,
      spanH: 48,
    });
    check(
      "(3s) process branch wins over span (reason stays 'size')",
      processFirst.qualifies && processFirst.reason === 'size' && processFirst.prevention === true,
    );
    // Legacy backstop still beats span (reason 'size', NOT prevention).
    const backstopFirst = passesRepartitionGate(50, 0, { spanH: 48 });
    check(
      '(3s) legacy backstop wins over span (not prevention)',
      backstopFirst.qualifies && backstopFirst.reason === 'size' && backstopFirst.prevention === false,
    );
    // Either floor unmet → below gate: too small, or too time-compact.
    check(
      '(3s) wide span but below the size floor does NOT qualify',
      !passesRepartitionGate(SPLIT_SPAN_SIZE_FLOOR - 1, 5, { spanH: 48 }).qualifies,
    );
    check(
      '(3s) large but time-compact (span < floor) does NOT qualify via span',
      !passesRepartitionGate(30, 5, { spanH: SPLIT_SPAN_H - 0.1 }).qualifies,
    );
    // No spanH provided (legacy callers) → identical to the pre-span behaviour.
    check(
      '(3s) no spanH opt behaves exactly like the legacy gate',
      !passesRepartitionGate(30, 5).qualifies,
    );
  }

  // ---- clusterSpanHours — member published-date SPAN (not age vs now) -------
  {
    const wide = [
      makeNode({ title: 'strike wave one', source: 'AP', host: 'apnews.com', ageH: 30 }),
      makeNode({ title: 'strike wave two', source: 'Reuters', host: 'reuters.com', ageH: 4 }),
    ];
    const spanH = clusterSpanHours(wide);
    check(
      '(3s) clusterSpanHours = max - min published (26h here)',
      Math.abs(spanH - 26) < 0.01,
      `got ${spanH}`,
    );
    // Old but time-compact: age is high, SPAN is small — span branch stays cold.
    const compact = [
      makeNode({ title: 'compact a', source: 'AP', host: 'apnews.com', ageH: 30 }),
      makeNode({ title: 'compact b', source: 'Reuters', host: 'reuters.com', ageH: 29 }),
    ];
    check('(3s) old-but-compact cluster has a small span', clusterSpanHours(compact) < 2);
    // Fewer than two usable timestamps → 0 (no basis to claim long-running).
    const oneStamp = [
      makeNode({ title: 'only stamp', source: 'AP', host: 'apnews.com', ageH: 10 }),
      { ...makeNode({ title: 'no stamp', source: 'Reuters', host: 'reuters.com' }), publishedAt: null } as LaneNode,
    ];
    check('(3s) < 2 usable timestamps → span 0', clusterSpanHours(oneStamp) === 0);
    check('(3s) empty node list → span 0', clusterSpanHours([]) === 0);
  }

  // ---- Relaxed material-change bar for SPAN-qualified clusters --------------
  {
    const existing = { evaluatedMemberHash: 'oldhash', evaluatedMemberCount: 60 };
    // +8 members on 60: below the normal 15 / 20% bar, but trips the relaxed
    // span bar (>= 8 members or >= 10%).
    check(
      '(3s) +8/60 is immaterial under the NORMAL bar',
      !hasMaterialChange(existing, 68, 'newhash'),
    );
    check(
      '(3s) +8/60 IS material under the SPAN-qualified bar',
      hasMaterialChange(existing, 68, 'newhash', { spanQualified: true }),
    );
    // Identical member hash is never material, span-qualified or not.
    check(
      '(3s) identical hash is never material even span-qualified',
      !hasMaterialChange(existing, 68, 'oldhash', { spanQualified: true }),
    );
    // A tiny drift stays immaterial even under the relaxed bar.
    const big = { evaluatedMemberHash: 'oldhash', evaluatedMemberCount: 100 };
    check(
      '(3s) +7/100 stays immaterial even span-qualified',
      !hasMaterialChange(big, 107, 'newhash', { spanQualified: true }),
    );
  }

  // End-to-end: an early-stage process cluster IS sent to the model only when
  // developingProcess is set; without it the same cluster is below-gate.
  {
    const procNodes = Array.from({ length: 30 }, (_, i) =>
      makeNode({ title: `Iran nuclear talks update ${i}`, source: i % 2 ? 'Reuters' : 'AP', host: i % 2 ? 'reuters.com' : 'apnews.com', ageH: 2 }),
    );
    let earlyCalls = 0;
    const earlyRes = await evaluateProcessRepartition(
      { nodes: procNodes, nowMs: Date.now(), developingProcess: true },
      {
        complete: async () => { earlyCalls++; return JSON.stringify({ leave_intact: true, children: [] }); },
        persist: async () => null,
      },
    );
    check('(3) early-stage process cluster reaches the model with prevention on', earlyCalls === 1, `calls=${earlyCalls}`);
    check('(3) early-stage eval is tagged prevention', earlyRes.prevention === true, String(earlyRes.prevention));

    let offCalls = 0;
    const offRes = await evaluateProcessRepartition(
      { nodes: procNodes, nowMs: Date.now() },
      {
        complete: async () => { offCalls++; return JSON.stringify({ leave_intact: true, children: [] }); },
        persist: async () => null,
      },
    );
    check('(3) same cluster is below-gate without prevention', offCalls === 0 && offRes.outcome === 'below_gate', `calls=${offCalls} outcome=${offRes.outcome}`);
  }

  // ---- Per-pass AI-budget bucket scheduler (Task #414) ----------------------
  // The repartition loop keeps TWO independent budgets; these helpers decide
  // admission BEFORE a model call so neither bucket can ever exceed its cap and
  // one bucket filling up never starves the other.
  {
    const budget: RepartitionBudget = { backstop: 2, prevention: 1 };
    const backstopGate = { qualifies: true, prevention: false };
    const preventionGate = { qualifies: true, prevention: true };
    const belowGate = { qualifies: false, prevention: false };

    // Bounded backstop: spending the cap blocks further backstop evals.
    check('(3b) backstop admitted while under cap', shouldEvaluateRepartitionCandidate(backstopGate, budget, { backstop: 0, prevention: 0 }));
    check('(3b) backstop admitted at cap-1', shouldEvaluateRepartitionCandidate(backstopGate, budget, { backstop: 1, prevention: 0 }));
    check('(3b) backstop BLOCKED at cap', !shouldEvaluateRepartitionCandidate(backstopGate, budget, { backstop: 2, prevention: 0 }));

    // A full backstop bucket must NOT block a prevention candidate (no starvation).
    check('(3b) prevention still admitted when backstop full', shouldEvaluateRepartitionCandidate(preventionGate, budget, { backstop: 2, prevention: 0 }));
    check('(3b) prevention BLOCKED at its own cap', !shouldEvaluateRepartitionCandidate(preventionGate, budget, { backstop: 0, prevention: 1 }));
    // ...and vice versa: a full prevention bucket must not block backstop.
    check('(3b) backstop still admitted when prevention full', shouldEvaluateRepartitionCandidate(backstopGate, budget, { backstop: 0, prevention: 1 }));

    // Below-gate candidates are cheap (eval short-circuits) → always pass through.
    check('(3b) below-gate always admitted (even both full)', shouldEvaluateRepartitionCandidate(belowGate, budget, { backstop: 2, prevention: 1 }));

    // The loop only stops when BOTH budgets are spent.
    check('(3b) not exhausted with backstop room', !repartitionBudgetExhausted(budget, { backstop: 1, prevention: 1 }));
    check('(3b) not exhausted with prevention room', !repartitionBudgetExhausted(budget, { backstop: 2, prevention: 0 }));
    check('(3b) exhausted only when both spent', repartitionBudgetExhausted(budget, { backstop: 2, prevention: 1 }));

    // Prevention disabled (budget.prevention=0): prevention candidates are never
    // admitted, backstop stays bounded — legacy behavior intact.
    const noPrevBudget: RepartitionBudget = { backstop: 2, prevention: 0 };
    check('(3b) prevention disabled → prevention never admitted', !shouldEvaluateRepartitionCandidate(preventionGate, noPrevBudget, { backstop: 0, prevention: 0 }));
    check('(3b) prevention disabled → exhausted once backstop spent', repartitionBudgetExhausted(noPrevBudget, { backstop: 2, prevention: 0 }));

    // Loop simulation: many backstop-qualifying candidates with prevention enabled.
    // Drive the exact admit/stop rule the loop uses and assert NEITHER cap is ever
    // exceeded — the precise regression the reviewer flagged.
    {
      const simBudget: RepartitionBudget = { backstop: 2, prevention: 1 };
      const used = { backstop: 0, prevention: 0 };
      // 8 backstop candidates first (largest-first), then 3 prevention ones.
      const gates = [
        ...Array.from({ length: 8 }, () => ({ qualifies: true, prevention: false })),
        ...Array.from({ length: 3 }, () => ({ qualifies: true, prevention: true })),
      ];
      let modelCalls = 0;
      let backstopCalls = 0;
      let preventionCalls = 0;
      for (const g of gates) {
        if (repartitionBudgetExhausted(simBudget, used)) break;
        if (!shouldEvaluateRepartitionCandidate(g, simBudget, used)) continue;
        // Simulate a consuming outcome (e.g. 'intact'/'split'/'ai_failed').
        modelCalls++;
        if (g.prevention) { used.prevention++; preventionCalls++; }
        else { used.backstop++; backstopCalls++; }
      }
      check('(3b) SIM: backstop calls never exceed cap', backstopCalls <= simBudget.backstop, `backstop=${backstopCalls}`);
      check('(3b) SIM: prevention calls never exceed cap', preventionCalls <= simBudget.prevention, `prevention=${preventionCalls}`);
      check('(3b) SIM: total = both caps (both buckets served)', modelCalls === simBudget.backstop + simBudget.prevention, `total=${modelCalls}`);
    }
  }

  // End-to-end: a below-gate group is never sent to the model.
  let modelCalls = 0;
  const nodes = Array.from({ length: 10 }, (_, i) =>
    makeNode({ title: `Routine update ${i}`, source: 'Reuters', host: 'reuters.com', ageH: 2 }),
  );
  const res = await evaluateProcessRepartition(
    { nodes, nowMs: Date.now() },
    {
      complete: async () => {
        modelCalls++;
        return '{"leave_intact":true,"children":[]}';
      },
      persist: async () => null,
    },
  );
  check('(3) below-gate eval returns below_gate', res.outcome === 'below_gate', res.outcome);
  check('(3) below-gate eval never calls the model', modelCalls === 0, `calls=${modelCalls}`);
}

// ===========================================================================
// (4) COOLDOWN + MATERIAL-CHANGE — an overlay within cooldown or whose member set
// did not change enough is NOT re-asked.
// ===========================================================================
{
  const nodes = Array.from({ length: 55 }, (_, i) =>
    makeNode({ title: `Iran nuclear deal progress item ${i}`, source: i % 2 ? 'Reuters' : 'AP', host: i % 2 ? 'reuters.com' : 'apnews.com', ageH: 20 }),
  );

  // (4a) Cooldown: overlay evaluated 30 min ago, membership UNCHANGED since.
  // evaluatedMemberCount is pinned to the current size so the over-backstop
  // cooldown safety-override (4c) does NOT fire — this isolates the pure cooldown
  // path (within cooldown + no material growth → skip, model never asked).
  let calls4a = 0;
  const recentOverlay = makeOverlay({
    id: 'ov4a',
    children: [
      { childKey: 'c1', label: 'A', members: nodes.slice(0, 3) },
      { childKey: 'c2', label: 'B', members: nodes.slice(3, 6) },
    ],
    lastEvaluatedAt: new Date(Date.now() - 30 * 60 * 1000),
    evaluatedMemberCount: nodes.length,
  });
  const r4a = await evaluateProcessRepartition(
    { nodes, existingOverlay: recentOverlay, nowMs: Date.now() },
    { complete: async () => { calls4a++; return '{"leave_intact":true,"children":[]}'; }, persist: async () => null },
  );
  check('(4a) within-cooldown eval returns cooldown', r4a.outcome === 'cooldown', r4a.outcome);
  check('(4a) within-cooldown never calls the model', calls4a === 0);

  // (4b) Material-change gate: cooldown elapsed (3h ago) but membership unchanged.
  const curTokens = nodes.map(tok);
  // Reuse the SAME hashing the production code uses by routing through hasMaterialChange.
  const unchangedOverlay = makeOverlay({
    id: 'ov4b',
    children: [
      { childKey: 'c1', label: 'A', members: nodes.slice(0, 3) },
      { childKey: 'c2', label: 'B', members: nodes.slice(3, 6) },
    ],
    lastEvaluatedAt: new Date(Date.now() - 3 * 3_600_000),
    evaluatedMemberCount: nodes.length,
  });
  // Pin the stored hash to the CURRENT set so hasMaterialChange sees "identical".
  // synthesisSignature isn't exported, so assert the gate via hasMaterialChange on
  // an identical-count/hash overlay (same hash → false).
  const sameHash = unchangedOverlay.evaluatedMemberHash;
  check(
    '(4b) identical member hash is immaterial',
    !hasMaterialChange({ evaluatedMemberHash: sameHash, evaluatedMemberCount: nodes.length }, nodes.length, sameHash),
  );
  check(
    '(4b) +15 members is material',
    hasMaterialChange({ evaluatedMemberHash: 'old', evaluatedMemberCount: nodes.length }, nodes.length + 15, 'new'),
  );
  check(
    '(4b) +20% members is material',
    hasMaterialChange({ evaluatedMemberHash: 'old', evaluatedMemberCount: 50 }, 61, 'new'),
  );
  check(
    '(4b) tiny same-magnitude change is immaterial',
    !hasMaterialChange({ evaluatedMemberHash: 'old', evaluatedMemberCount: 55 }, 56, 'new'),
  );

  // (4c) COOLDOWN SAFETY OVERRIDE (Task #414). The 2h cooldown must NOT let a
  // cluster sit ABOVE the >=50 backstop while it keeps growing. Production showed
  // a cluster re-grow 39 -> 55 DURING cooldown and ship as a mega-cluster because
  // every pass returned 'cooldown'. A cluster that is over the backstop AND grew
  // materially since last eval now bypasses the cooldown and is re-asked.

  // (4c-i) Over-backstop (55) + within cooldown (30m) + grew 39 -> 55 (Δ16,
  // material): bypass cooldown → the model IS called → not a 'cooldown' skip.
  let calls4ci = 0;
  const grewOverlay = makeOverlay({
    id: 'ov4ci',
    children: [
      { childKey: 'c1', label: 'A', members: nodes.slice(0, 3) },
      { childKey: 'c2', label: 'B', members: nodes.slice(3, 6) },
    ],
    lastEvaluatedAt: new Date(Date.now() - 30 * 60 * 1000),
    evaluatedMemberCount: 39,
    evaluatedMemberHash: 'stale-hash',
  });
  const r4ci = await evaluateProcessRepartition(
    { nodes, existingOverlay: grewOverlay, nowMs: Date.now() },
    { complete: async () => { calls4ci++; return '{"leave_intact":true,"children":[]}'; }, persist: async () => null },
  );
  check('(4c-i) over-backstop + grew bypasses cooldown (model called)', calls4ci === 1 && r4ci.outcome !== 'cooldown', `calls=${calls4ci} outcome=${r4ci.outcome}`);

  // (4c-ii) Over-backstop (55) + within cooldown + only +1 member (Δ1, immaterial):
  // NO bypass → still a 'cooldown' skip, model NOT called (no re-ask storm on a
  // big-but-stable cluster the model already judged).
  let calls4cii = 0;
  const stableOverlay = makeOverlay({
    id: 'ov4cii',
    children: [
      { childKey: 'c1', label: 'A', members: nodes.slice(0, 3) },
      { childKey: 'c2', label: 'B', members: nodes.slice(3, 6) },
    ],
    lastEvaluatedAt: new Date(Date.now() - 30 * 60 * 1000),
    evaluatedMemberCount: 54,
    evaluatedMemberHash: 'stale-hash',
  });
  const r4cii = await evaluateProcessRepartition(
    { nodes, existingOverlay: stableOverlay, nowMs: Date.now() },
    { complete: async () => { calls4cii++; return '{"leave_intact":true,"children":[]}'; }, persist: async () => null },
  );
  check('(4c-ii) over-backstop but stable stays cooldown (no model call)', calls4cii === 0 && r4cii.outcome === 'cooldown', `calls=${calls4cii} outcome=${r4cii.outcome}`);

  // (4c-iii) SUB-backstop (40) + within cooldown + grew 20 -> 40 (Δ20, material):
  // the override is scoped to the >=50 backstop ONLY, so an early-prevention-range
  // cluster still respects the normal cooldown → 'cooldown' skip, model NOT called.
  const subNodes = nodes.slice(0, 40);
  let calls4ciii = 0;
  const subGrewOverlay = makeOverlay({
    id: 'ov4ciii',
    children: [
      { childKey: 'c1', label: 'A', members: subNodes.slice(0, 3) },
      { childKey: 'c2', label: 'B', members: subNodes.slice(3, 6) },
    ],
    lastEvaluatedAt: new Date(Date.now() - 30 * 60 * 1000),
    evaluatedMemberCount: 20,
    evaluatedMemberHash: 'stale-hash',
  });
  const r4ciii = await evaluateProcessRepartition(
    { nodes: subNodes, existingOverlay: subGrewOverlay, nowMs: Date.now(), developingProcess: true },
    { complete: async () => { calls4ciii++; return '{"leave_intact":true,"children":[]}'; }, persist: async () => null },
  );
  check('(4c-iii) sub-backstop grew still respects cooldown (no override)', calls4ciii === 0 && r4ciii.outcome === 'cooldown', `calls=${calls4ciii} outcome=${r4ciii.outcome}`);
}

// ===========================================================================
// (5) AI-FAILURE IS FAIL-CLOSED — a null / throwing / unparseable model reply
// leaves the cluster INTACT and persists NOTHING.
// ===========================================================================
{
  const nodes = Array.from({ length: 55 }, (_, i) =>
    makeNode({ title: `Ceasefire talks item ${i}`, source: i % 2 ? 'Reuters' : 'AP', host: i % 2 ? 'reuters.com' : 'apnews.com', ageH: 20 }),
  );

  for (const [name, complete] of [
    ['null reply', async () => null as string | null],
    ['throwing reply', async () => { throw new Error('429 rate limited'); }],
    ['unparseable reply', async () => 'I cannot help with that request.'],
  ] as Array<[string, () => Promise<string | null>]>) {
    let persisted = 0;
    const res = await evaluateProcessRepartition(
      { nodes, nowMs: Date.now() },
      { complete, persist: async () => { persisted++; return null; } },
    );
    check(`(5) ${name} → ai_failed`, res.outcome === 'ai_failed', res.outcome);
    check(`(5) ${name} persists nothing`, persisted === 0, `persisted=${persisted}`);
    check(`(5) ${name} loses no member`, res.membersConsidered === nodes.length);
  }
}

// ===========================================================================
// (5b) PERSIST FAILURE AFTER THE AI CALL IS FAIL-CLOSED + BUDGET-COUNTED. If the
// model returned a verdict (AI slot already spent) but the overlay write throws,
// the eval must NOT re-throw — it must return 'ai_failed' so the caller still
// counts the spent AI call against MAX_REPARTITION_AI_EVALS_PER_PASS. A re-throw
// would let the caller `continue` without counting, letting the budget be exceeded.
// ===========================================================================
{
  const nodes = Array.from({ length: 55 }, (_, i) =>
    makeNode({ title: `Sanctions package item ${i}`, source: i % 2 ? 'Reuters' : 'AP', host: i % 2 ? 'reuters.com' : 'apnews.com', ageH: 20 }),
  );
  // A genuine split verdict (so we reach the active-split persist at 5c).
  const splitReply = JSON.stringify({
    leave_intact: false,
    children: [
      { label: 'Reuters thread', indices: Array.from({ length: 27 }, (_, i) => i * 2 + 1) },
      { label: 'AP thread', indices: Array.from({ length: 27 }, (_, i) => i * 2 + 2) },
    ],
  });

  // 5b-i: persist throws on the ACTIVE-split write.
  {
    let modelCalls = 0;
    const res = await evaluateProcessRepartition(
      { nodes, nowMs: Date.now() },
      {
        complete: async () => { modelCalls++; return splitReply; },
        persist: async () => { throw new Error('DB write failed'); },
      },
    );
    check('(5b) split-persist throw → ai_failed (not re-thrown)', res.outcome === 'ai_failed', res.outcome);
    check('(5b) split-persist throw → reason persist_failed', res.reason === 'persist_failed', res.reason);
    check('(5b) split-persist throw still counted one model call', modelCalls === 1, `modelCalls=${modelCalls}`);
    check('(5b) split-persist throw loses no member', res.membersConsidered === nodes.length);
    check('(5b) split-persist throw creates no children', res.childrenCreated === 0, `children=${res.childrenCreated}`);
  }

  // 5b-ii: persist throws on the INTACT (cooldown) write — same fail-closed contract.
  {
    const res = await evaluateProcessRepartition(
      { nodes, nowMs: Date.now() },
      {
        complete: async () => '{"leave_intact":true,"children":[]}',
        persist: async () => { throw new Error('DB write failed'); },
      },
    );
    check('(5b) intact-persist throw → ai_failed (not re-thrown)', res.outcome === 'ai_failed', res.outcome);
    check('(5b) intact-persist throw → reason persist_failed', res.reason === 'persist_failed', res.reason);
  }
}

// ===========================================================================
// (6) BALANCE CAPS — a verdict whose children don't each have >= 2 corroborating
// distinct publishers cannot form a split (buildSplitChildren → null → intact).
// ===========================================================================
{
  // Sample of 5: child X has 2 distinct publishers (valid), child Y has only 1.
  const x1 = makeNode({ title: 'Summit opens in Geneva', source: 'Reuters', host: 'reuters.com' });
  const x2 = makeNode({ title: 'Summit delegates arrive Geneva', source: 'AP', host: 'apnews.com' });
  const y1 = makeNode({ title: 'Aide comments to one outlet', source: 'Reuters', host: 'reuters.com' });
  const y2 = makeNode({ title: 'Same outlet follow-up', source: 'Reuters', host: 'reuters.com' });
  const z1 = makeNode({ title: 'Unrelated filler', source: 'BBC', host: 'bbc.com' });
  const sample = [x1, x2, y1, y2, z1];

  // Only ONE valid child (X) survives the corroboration cap → < 2 children → null.
  const oneValid = buildSplitChildren(sample, [
    { label: 'Geneva summit', indices: [1, 2] },
    { label: 'Single-source aide', indices: [3, 4] },
  ]);
  check('(6) verdict with < 2 valid children → leave intact (null)', oneValid === null, `got ${oneValid?.length}`);

  // TWO valid children (each 2 distinct publishers) → a real split.
  const x3 = makeNode({ title: 'Talks resume in Doha', source: 'Fox', host: 'foxnews.com' });
  const x4 = makeNode({ title: 'Doha talks second day', source: 'CNN', host: 'cnn.com' });
  const sample2 = [x1, x2, x3, x4];
  const twoValid = buildSplitChildren(sample2, [
    { label: 'Geneva summit', indices: [1, 2] },
    { label: 'Doha talks', indices: [3, 4] },
  ]);
  check('(6) two corroborated children → valid split', !!twoValid && twoValid.length === 2, `got ${twoValid?.length}`);

  // End-to-end: a leave-intact verdict persists an INTACT overlay (cooldown), and
  // the outcome is 'intact' (not 'split').
  const nodes = Array.from({ length: 55 }, (_, i) =>
    makeNode({ title: `Deal item ${i}`, source: i % 2 ? 'Reuters' : 'AP', host: i % 2 ? 'reuters.com' : 'apnews.com', ageH: 20 }),
  );
  let intactSaved: RepartitionOverlayWrite | null = null;
  const res = await evaluateProcessRepartition(
    { nodes, nowMs: Date.now() },
    {
      complete: async () => '{"leave_intact":true,"children":[]}',
      persist: async (row) => { intactSaved = row; return makeOverlay({ id: 'saved', status: row.status ?? 'intact', children: [] }); },
    },
  );
  check('(6) model leave_intact → intact outcome', res.outcome === 'intact', res.outcome);
  check('(6) intact verdict persists status=intact', !!intactSaved && (intactSaved as RepartitionOverlayWrite).status === 'intact');
}

// ===========================================================================
// (7) SPLIT END-TO-END + SIBLING ARCHIVE NON-MERGE. A real model split persists an
// ACTIVE overlay with >= 2 children whose lineage keys are DISTINCT — the property
// that keeps siblings from carry-forward-merging in the archive.
// ===========================================================================
{
  // 6 members: 3 IAEA (2+ publishers) + 3 Rubio (2+ publishers), > gate size via age.
  const a1 = makeNode({ title: 'IAEA inspectors at Natanz', source: 'Reuters', host: 'reuters.com', ageH: 20 });
  const a2 = makeNode({ title: 'IAEA inspection access granted', source: 'AP', host: 'apnews.com', ageH: 20 });
  const a3 = makeNode({ title: 'IAEA verifies centrifuges', source: 'BBC', host: 'bbc.com', ageH: 20 });
  const b1 = makeNode({ title: 'Rubio demands verification', source: 'Fox', host: 'foxnews.com', ageH: 20 });
  const b2 = makeNode({ title: 'Rubio briefs Senate', source: 'CNN', host: 'cnn.com', ageH: 20 });
  const b3 = makeNode({ title: 'Rubio statement on talks', source: 'NBC', host: 'nbcnews.com', ageH: 20 });
  // Pad to clear the age-size floor (>= 25 with age >= 16h).
  const pad = Array.from({ length: 24 }, (_, i) =>
    makeNode({ title: `Iran deal background ${i}`, source: i % 2 ? 'Reuters' : 'AP', host: i % 2 ? 'reuters.com' : 'apnews.com', ageH: 20 }),
  );
  const nodes = [a1, a2, a3, b1, b2, b3, ...pad];
  const sampleIdx = (members: LaneNode[]): number[] => members.map((m) => nodes.indexOf(m) + 1);

  let savedRow: RepartitionOverlayWrite | null = null;
  const res = await evaluateProcessRepartition(
    { nodes, nowMs: Date.now() },
    {
      complete: async () =>
        JSON.stringify({
          leave_intact: false,
          children: [
            { label: 'IAEA inspections', indices: sampleIdx([a1, a2, a3]) },
            { label: 'Rubio statement', indices: sampleIdx([b1, b2, b3]) },
          ],
        }),
      persist: async (row) => {
        savedRow = row;
        return {
          id: 'ovsplit',
          children: (row.children as CuratedSplitChild[]).map((c) => ({ ...c })),
          verdictHash: row.verdictHash ?? 'vh',
          evaluatedMemberHash: row.evaluatedMemberHash ?? 'mh',
          evaluatedMemberCount: row.evaluatedMemberCount ?? nodes.length,
          triggerReason: row.triggerReason ?? 'age',
          status: row.status ?? 'active',
          lastEvaluatedAt: new Date(),
          createdAt: new Date(),
        } as CuratedProcessSplitOverlay;
      },
    },
  );
  check('(7) genuine multi-thread verdict → split', res.outcome === 'split', res.outcome);
  check('(7) split creates 2 children', res.childrenCreated === 2, `got ${res.childrenCreated}`);
  check('(7) persisted overlay is active', !!savedRow && (savedRow as RepartitionOverlayWrite).status === 'active');
  const savedChildren = (savedRow ? (savedRow as RepartitionOverlayWrite).children : []) as CuratedSplitChild[];
  const childKeys = savedChildren.map((c) => c.childKey);
  check('(7) sibling childKeys are distinct', new Set(childKeys).size === childKeys.length && childKeys.length === 2);
  const lineageKeys = childKeys.map((k) => childLineageKey('ovsplit', k));
  check('(7) sibling lineage keys are distinct (archive non-merge guard)', new Set(lineageKeys).size === 2);
  // Each child must have >= 2 corroborating distinct publishers' worth of tokens.
  check('(7) each child carries member tokens', savedChildren.every((c) => (c.memberTokens?.length ?? 0) >= 2));

  // findOverlayForEval re-matches the just-saved overlay to its cluster next pass
  // (status-agnostic token-overlap), so cooldown/material-change gating works.
  const savedOverlay = makeOverlay({
    id: 'ovsplit',
    status: 'active',
    children: savedChildren.map((c) => ({ childKey: c.childKey, label: c.label, members: [], anchors: c.anchorTokens })),
  });
  // Rebuild its memberTokens from the saved row (members:[] above would be empty).
  (savedOverlay.children as CuratedSplitChild[]).forEach((c, i) => { c.memberTokens = savedChildren[i].memberTokens; });
  const matched = findOverlayForEval([a1, a2, a3, b1, b2, b3], [savedOverlay]);
  check('(7) findOverlayForEval re-matches the saved overlay', matched?.id === 'ovsplit', matched ? matched.id : 'none');
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n[repartition] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[repartition] all smart re-partition guarantees hold');
