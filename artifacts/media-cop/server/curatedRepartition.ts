// =============================================================================
// Curated lane (Task — "smart process re-partition") — DETERMINISTIC APPLICATION
// + GATED CLAUDE PARTITION of a developing-process MEGA-cluster.
//
// A long-running developing-process story ("Iran nuclear deal", "Ukraine peace
// talks") accretes EVERY sub-thread under one ever-growing cluster: general
// progress, a VPOTUS angle, IAEA inspections, a Rubio statement, etc. Past a
// size/age threshold this single card stops being a "Top Story" and becomes an
// unreadable dumping ground. This module lets a GATED Claude pass split that one
// mega-cluster into several coexisting CURRENT sub-stories, each of which then
// flows through the UNCHANGED formation gate, phase-out, representative
// selection, id assignment, synthesis and archive — per child, for free.
//
// Two halves:
//   1. applySplitOverlays  — PURE + deterministic. Given the current grouping and
//      the persisted split decisions (overlays), it partitions any group the
//      overlay covers into its children. Token-keyed so the decision survives the
//      per-pass cluster-id churn (the cluster table is rebuilt every pass). No
//      member is ever dropped: the union of a split group's children (plus the
//      residual "parent") is exactly the input group.
//   2. evaluateProcessRepartition — the GATED, fail-closed Claude trigger that
//      PRODUCES an overlay. On ANY failure it leaves the cluster intact and loses
//      no members.
//
// Curated-lane ONLY. Never imported by a shared feed / public API path. The
// overlay table and the archive `splitLineageKey` it keys are curated-only.
// =============================================================================
import { significantTitleTokens, type ClusterGroup, type LaneNode } from './curatedCluster';
import { memberSignatureToken, synthesisSignature } from './curatedSynthesis';
import type {
  CuratedProcessSplitOverlay,
  CuratedSplitChild,
  InsertCuratedProcessSplitOverlay,
} from '@shared/schema';

// A grouping result that additionally carries the split-lineage key of the child
// it represents. Extends ClusterGroup so every existing consumer (the orderedGroups
// sort, the Phase A formation loop) keeps working unchanged; the clustering pass
// reads `splitLineageKey` only when threading lineage into the archive. A residual
// "parent" group (the un-routed remainder of a split mega-cluster) carries NO
// lineage (null) so it CONTINUES the pre-split story's archive history, while each
// child carries `${overlayId}:${childKey}` so it gets its OWN archive row that can
// never carry-forward-merge into a sibling. Untouched groups pass through as-is.
export interface SplitAppliedGroup extends ClusterGroup {
  splitLineageKey?: string | null;
}

// --- matching thresholds (deterministic) -------------------------------------
// How strongly an overlay must align with a group before we apply its split.
// coverageOfOverlay = (group ∩ overlay known member tokens) / overlay known tokens.
// Both a minimum shared-token count AND a coverage fraction are required so an
// overlay only ever splits the SAME mega-cluster it was built for, never a small
// unrelated group that merely shares a wire-service URL or two.
const MIN_OVERLAY_TOKEN_OVERLAP = 4;
const MIN_OVERLAY_COVERAGE = 0.4;

// Lineage key for a child of an overlay. STABLE across re-evaluations because the
// overlay keeps its id and each child keeps its childKey.
export function childLineageKey(overlayId: string, childKey: string): string {
  return `${overlayId}:${childKey}`;
}

interface PreparedChild {
  child: CuratedSplitChild;
  memberTokens: Set<string>;
  anchorTokens: Set<string>;
}

interface PreparedOverlay {
  overlay: CuratedProcessSplitOverlay;
  children: PreparedChild[];
  // Union of every child's known member tokens — the overlay's "fingerprint".
  knownTokens: Set<string>;
  // token -> childKey (first child wins if a token were ever duplicated).
  tokenToChild: Map<string, string>;
}

function prepareOverlay(overlay: CuratedProcessSplitOverlay): PreparedOverlay | null {
  const children = Array.isArray(overlay.children) ? (overlay.children as CuratedSplitChild[]) : [];
  if (children.length < 2) return null; // an overlay with < 2 children is not a split
  const prepared: PreparedChild[] = [];
  const knownTokens = new Set<string>();
  const tokenToChild = new Map<string, string>();
  for (const child of children) {
    const memberTokens = new Set(
      (child.memberTokens ?? []).map((t) => (t ?? '').trim().toLowerCase()).filter(Boolean),
    );
    const anchorTokens = new Set(
      (child.anchorTokens ?? []).map((t) => (t ?? '').trim().toLowerCase()).filter(Boolean),
    );
    for (const t of Array.from(memberTokens)) {
      knownTokens.add(t);
      if (!tokenToChild.has(t)) tokenToChild.set(t, child.childKey);
    }
    prepared.push({ child, memberTokens, anchorTokens });
  }
  if (knownTokens.size === 0) return null;
  return { overlay, children: prepared, knownTokens, tokenToChild };
}

// Member-signature token for a node — the STABLE per-article identity (normalized
// URL, falling back to the key). MUST match how curatedCluster builds p.tokens, so
// an overlay's persisted member tokens line up with the live grouping.
function nodeToken(node: LaneNode): string {
  return memberSignatureToken(node.url, node.key);
}

// Pick the best ACTIVE overlay for a group: the one whose known member tokens most
// overlap the group, subject to the minimum overlap + coverage thresholds. Returns
// null when no overlay qualifies (the common case — most groups are not splits).
function bestOverlayForGroup(
  groupTokens: Set<string>,
  prepared: PreparedOverlay[],
): { ov: PreparedOverlay; overlap: number } | null {
  let best: { ov: PreparedOverlay; overlap: number } | null = null;
  for (const ov of prepared) {
    let overlap = 0;
    for (const t of Array.from(groupTokens)) if (ov.knownTokens.has(t)) overlap++;
    if (overlap < MIN_OVERLAY_TOKEN_OVERLAP) continue;
    const coverage = overlap / ov.knownTokens.size;
    if (coverage < MIN_OVERLAY_COVERAGE) continue;
    if (
      !best ||
      overlap > best.overlap ||
      // Deterministic tie-break: same overlap → smaller overlay id wins.
      (overlap === best.overlap && ov.overlay.id < best.ov.overlay.id)
    ) {
      best = { ov, overlap };
    }
  }
  return best;
}

// Route a NEW member (a node whose token the overlay never saw at eval time) to the
// child whose ANCHOR tokens its title overlaps most. Deterministic: argmax by
// (overlap desc, childKey asc); zero overlap → null (falls to the residual parent).
function routeNewMember(node: LaneNode, children: PreparedChild[]): string | null {
  const titleTokens = significantTitleTokens(node.title);
  let bestKey: string | null = null;
  let bestOverlap = 0;
  let tiedAtBest = false; // two DISTINCT children share the top overlap → ambiguous
  for (const c of children) {
    let overlap = 0;
    for (const t of Array.from(titleTokens)) if (c.anchorTokens.has(t)) overlap++;
    if (overlap === 0) continue;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestKey = c.child.childKey;
      tiedAtBest = false;
    } else if (overlap === bestOverlap && c.child.childKey !== bestKey) {
      tiedAtBest = true;
    }
  }
  // A clear single best child wins. An AMBIGUOUS new member (no overlap with any
  // child, OR a tie for the best overlap across distinct children) routes to the
  // residual PARENT (null) rather than being arbitrarily assigned — we never guess
  // a sub-thread for a member the model never saw and whose title doesn't clearly
  // favor one child.
  return tiedAtBest ? null : bestKey;
}

// Match a candidate group's nodes to the overlay (ANY status) that was built for
// it — used by the EVAL path for cooldown / material-change / id+childKey reuse.
// Unlike applySplitOverlays (which APPLIES active overlays only), this also matches
// an INTACT overlay so its 2h cooldown actually suppresses an immediate re-ask.
// Both statuses persist their evaluated member tokens (active: across real
// children; intact: one synthetic "(intact)" child), so the same token-overlap +
// coverage match works for both. Returns null when nothing qualifies. Deterministic
// (smaller overlay id wins a tie).
export function findOverlayForEval(
  nodes: LaneNode[],
  overlays: CuratedProcessSplitOverlay[],
): CuratedProcessSplitOverlay | null {
  if (nodes.length < 2) return null;
  const groupTokens = new Set(nodes.map(nodeToken));
  let best: { ov: CuratedProcessSplitOverlay; overlap: number } | null = null;
  for (const ov of overlays) {
    const children = Array.isArray(ov.children) ? (ov.children as CuratedSplitChild[]) : [];
    const known = new Set<string>();
    for (const c of children) {
      for (const t of c.memberTokens ?? []) {
        const tk = (t ?? '').trim().toLowerCase();
        if (tk) known.add(tk);
      }
    }
    if (known.size === 0) continue;
    let overlap = 0;
    for (const t of Array.from(groupTokens)) if (known.has(t)) overlap++;
    if (overlap < MIN_OVERLAY_TOKEN_OVERLAP) continue;
    if (overlap / known.size < MIN_OVERLAY_COVERAGE) continue;
    if (!best || overlap > best.overlap || (overlap === best.overlap && ov.id < best.ov.id)) {
      best = { ov, overlap };
    }
  }
  return best ? best.ov : null;
}

// PURE + deterministic. Partition every group an ACTIVE overlay covers into its
// children; pass every other group through unchanged. Guarantees NO member loss:
// for a split group the union of the emitted child groups plus the residual parent
// group is exactly the input group's keys. Stable across reordered inputs (every
// emitted group's keys are sorted, and routing is order-independent).
//
// manualLinkKeyGroups (optional): each inner array is a set of node keys that an
// editor explicitly linked together. A split overlay must never scatter such a set
// across different child buckets. When a link group's members would end up in
// different children, they are ALL consolidated into the child that already has the
// most of them (tie-break: overlay declaration order). This is the "human override
// beats machine re-partition" guarantee (fail-closed: any error leaves routing as-is).
export function applySplitOverlays(
  groups: ClusterGroup[],
  nodeByKey: Map<string, LaneNode>,
  overlays: CuratedProcessSplitOverlay[],
  manualLinkKeyGroups?: string[][],
): SplitAppliedGroup[] {
  const prepared = overlays
    .filter((o) => o.status === 'active')
    .map(prepareOverlay)
    .filter((p): p is PreparedOverlay => !!p);

  if (prepared.length === 0) {
    // Nothing to apply — return identity (still typed as SplitAppliedGroup).
    return groups.map((g) => ({ keys: [...g.keys] }));
  }

  const out: SplitAppliedGroup[] = [];
  for (const group of groups) {
    const nodes = group.keys
      .map((k) => nodeByKey.get(k))
      .filter((n): n is LaneNode => !!n);
    // Keys with no node (carried/stale) still must not be lost — keep them on the
    // residual parent group so the union invariant holds.
    const orphanKeys = group.keys.filter((k) => !nodeByKey.has(k));

    const groupTokens = new Set(nodes.map(nodeToken));
    const match = nodes.length >= 2 ? bestOverlayForGroup(groupTokens, prepared) : null;
    if (!match) {
      out.push({ keys: [...group.keys] });
      continue;
    }

    const { ov } = match;
    // Bucket every node into a child (known token, else routed by title) or the
    // residual parent. Buckets keyed by childKey; parent keys collected separately.
    const childBuckets = new Map<string, string[]>();
    const parentKeys: string[] = [...orphanKeys];
    for (const node of nodes) {
      const tok = nodeToken(node);
      let childKey = ov.tokenToChild.get(tok) ?? null;
      if (!childKey) childKey = routeNewMember(node, ov.children);
      if (!childKey) {
        parentKeys.push(node.key);
        continue;
      }
      const arr = childBuckets.get(childKey) ?? [];
      arr.push(node.key);
      childBuckets.set(childKey, arr);
    }

    // EDITOR MANUAL-LINK PROTECTION — "human override beats machine re-partition"
    // -------------------------------------------------------------------------
    // After initial routing, enforce that any manually-linked key set stays in ONE
    // child bucket. Without this, a persisted split overlay silently redistributes
    // the editor-linked items back into separate sub-stories the very next pass.
    //
    // Strategy: for each manual-link group, find which child buckets (or the
    // residual parent) received members of that group. If they ended up in more
    // than one place, pick the "winner" child (most linked members; tie-break:
    // overlay declaration order) and move every other linked member to it. Members
    // pulled from the residual parent are removed from parentKeys accordingly.
    // The union of all keys is NEVER changed — this is a re-routing, not a drop.
    // Fail-closed: wrapped in try/catch so any unexpected error leaves the initial
    // routing intact (no member loss, no crash).
    if (manualLinkKeyGroups && manualLinkKeyGroups.length > 0) {
      try {
        const groupKeySet = new Set(group.keys);
        // Build a reverse index: key → childKey currently assigned (null = parent).
        const keyToChild = new Map<string, string | null>();
        for (const [ck, ks] of childBuckets) for (const k of ks) keyToChild.set(k, ck);
        for (const k of parentKeys) keyToChild.set(k, null);

        for (const linkGroup of manualLinkKeyGroups) {
          // Only consider keys that actually belong to this group.
          const present = linkGroup.filter(k => groupKeySet.has(k));
          if (present.length < 2) continue;

          // Tally how many linked keys are in each destination.
          const destCount = new Map<string, number>(); // childKey → count
          let inParent = 0;
          for (const k of present) {
            const dest = keyToChild.get(k);
            if (dest == null) { inParent++; continue; }
            destCount.set(dest, (destCount.get(dest) ?? 0) + 1);
          }
          const childDestsHit = destCount.size;
          if (childDestsHit <= 1 && inParent === 0) continue; // all in one child
          if (childDestsHit === 0) continue; // all in parent already — no child to pull into

          // Pick winner: the child with the most linked members; tie-break by
          // overlay declaration order (first child in ov.children wins a tie).
          let winnerKey: string | null = null;
          let winnerCount = 0;
          for (const c of ov.children) {
            const ck = c.child.childKey;
            const count = destCount.get(ck) ?? 0;
            if (count > winnerCount) {
              winnerCount = count;
              winnerKey = ck;
            }
          }
          if (winnerKey === null) continue; // defensive: no child has any member

          const winnerBucket = childBuckets.get(winnerKey) ?? [];
          childBuckets.set(winnerKey, winnerBucket);

          let moved = 0;
          for (const k of present) {
            const curDest = keyToChild.get(k) ?? null;
            if (curDest === winnerKey) continue; // already correct

            // Remove from current location.
            if (curDest !== null) {
              const losers = childBuckets.get(curDest);
              if (losers) {
                const idx = losers.indexOf(k);
                if (idx >= 0) losers.splice(idx, 1);
              }
            } else {
              const idx = parentKeys.indexOf(k);
              if (idx >= 0) parentKeys.splice(idx, 1);
            }

            winnerBucket.push(k);
            keyToChild.set(k, winnerKey);
            moved++;
          }

          if (moved > 0) {
            console.log(
              `[CuratedRepartition] Manual-link override: consolidated ${present.length} linked member(s)` +
              ` into child "${winnerKey}" (moved ${moved} from ${childDestsHit + (inParent > 0 ? 1 : 0) - 1} other bucket(s))`,
            );
          }
        }
      } catch (linkErr) {
        // Fail-closed: initial routing already populated childBuckets correctly;
        // any consolidation error leaves that routing intact (no member loss).
        console.warn(
          '[CuratedRepartition] Manual-link consolidation errored (non-fatal, initial routing kept):',
          linkErr instanceof Error ? linkErr.message : linkErr,
        );
      }
    }

    // Emit children in the overlay's declared child order (deterministic), each
    // with a sorted key list and its stable lineage key.
    let emittedAnyChild = false;
    for (const c of ov.children) {
      const keys = childBuckets.get(c.child.childKey);
      if (!keys || keys.length === 0) continue;
      out.push({
        keys: keys.slice().sort(),
        splitLineageKey: childLineageKey(ov.overlay.id, c.child.childKey),
      });
      emittedAnyChild = true;
    }

    if (!emittedAnyChild) {
      // Overlay matched on shared tokens but routed nothing into a child this pass
      // (its known members all aged out). Leave the group intact — null lineage so
      // it continues normally.
      out.push({ keys: [...group.keys] });
      continue;
    }

    // Residual parent: the un-routed remainder CONTINUES the pre-split story's
    // archive history (null lineage). Only emit when it has members.
    if (parentKeys.length > 0) {
      out.push({ keys: parentKeys.slice().sort() });
    }
  }
  return out;
}

// =============================================================================
// T004 — Trigger + Claude partition (gated, fail-closed)
//
// evaluateProcessRepartition decides WHETHER to ask the model to split a
// developing-process mega-cluster, asks it (via an INJECTED completion fn so this
// module stays free of aiClient/storage imports and is unit-testable), enforces
// the balance caps deterministically, and persists the verdict overlay (via an
// INJECTED persist fn). It is fail-closed end to end: a gate miss, cooldown, AI
// error, unparseable reply, or a verdict that fails the caps all leave the cluster
// INTACT and never drop a member. The caller (clusterCuratedLane) wires `complete`
// to createCuratedClusterCompletion + parseJsonObjectLoose and `persist` to
// storage.upsertCuratedSplitOverlay.
// =============================================================================

// --- gate / cooldown / material-change thresholds ----------------------------
// A cluster is a re-partition CANDIDATE when it is large outright, OR old enough
// that even a moderate-sized cluster has likely accreted distinct sub-threads.
const SPLIT_SIZE_FLOOR = 50;          // size alone qualifies
const SPLIT_AGE_H = 16;               // with...
const SPLIT_AGE_SIZE_FLOOR = 25;      // ...this size, age qualifies
// --- early PREVENTION gate (Task #414) --------------------------------------
// TRUE PREVENTION: shift the split LEFT so a developing-process cluster is broken
// into a handful of coherent sub-stories AS IT FORMS, instead of only after it
// becomes a 50-member dumping ground. These LOWER thresholds apply ONLY to a
// developing-process cluster (caller passes developingProcess:true) — an ordinary
// cluster still uses the legacy SPLIT_* floors above as a pure backstop. The AI
// `leave_intact` verdict + the >=2-corroborating-publishers-per-child cap remain
// the guard against fragmenting a legitimate single multi-day story: asking
// earlier never splits a story the model judges to be one. Named constants so the
// aggressiveness is tunable in one place (and the env kill-switch in the caller
// reverts to backstop-only).
const SPLIT_PROCESS_EARLY_SIZE_FLOOR = 30;      // a process cluster this big splits at ANY age
const SPLIT_PROCESS_EARLY_AGE_H = 8;            // with...
const SPLIT_PROCESS_EARLY_AGE_SIZE_FLOOR = 18;  // ...this size, a process cluster qualifies early
// Aged-process recall branch (Task #440). The early gate above only catches a
// developing-process cluster once it reaches 18+ members. In production a process
// story often ages PAST 16h while still sitting at a modest 15-17 members — too
// small for the 18-member early floor, too small for the 25-member backstop — so
// it never reaches the model and quietly keeps accreting sub-threads. This lower
// floor, gated on an OLDER age, lets a genuinely aged developing-process cluster
// still be evaluated before it balloons. Process-only and still fully guarded by
// the AI `leave_intact` verdict + the >=2-publishers-per-child cap, so a single
// coherent multi-day story is never fragmented; it only widens WHICH process
// clusters get LOOKED AT. Non-process clusters are unaffected (see the caller's
// isDevelopingProcessCluster candidate filter — large non-process single-event
// clusters are intentionally LEFT INTACT as good consolidation).
const SPLIT_PROCESS_OLD_AGE_H = 16;             // an OLD process cluster...
const SPLIT_PROCESS_OLD_AGE_SIZE_FLOOR = 15;    // ...this size still qualifies early
// --- long-SPAN branch (megacluster prevention for ANY cluster) ---------------
// Production evidence (07-19): a 72-member KINETIC cluster spanning 25+ hours of
// published dates accreted un-examined because the caller's candidate filter is
// process-only and the legacy floors assume "one big breaking event" clusters
// stay time-compact. A cluster whose members SPAN >= 2x the same-event window is
// no longer plausibly one time-compact event regardless of vocabulary — so it
// qualifies for an AI LOOK (reason 'span', PREVENTION budget so the >=50
// backstop is never starved). Widening only WHO GETS LOOKED AT is the
// established safe pattern: the AI `leave_intact` verdict + the >=2-
// corroborating-publishers-per-child cap remain the guards against fragmenting
// a legitimate single multi-day story. Exported so the caller's candidate
// filter uses the exact same floors.
export const SPLIT_SPAN_H = 24;                 // member published-date span >= 2x event window...
export const SPLIT_SPAN_SIZE_FLOOR = 20;        // ...with this size, ANY cluster qualifies
// Don't re-ask the model about the same cluster more than once per cooldown.
const COOLDOWN_MS = 2 * 60 * 60 * 1000;
// Once an overlay exists, only re-ask the model when membership changed ENOUGH.
// NOTE: the plan frames this as "≥15 new tokens or ≥20% delta". We only persist a
// member-set HASH + COUNT (not the full prior set), so we approximate "new tokens"
// with the net member-COUNT delta: any change (hash differs) PLUS a magnitude of
// >=15 members or >=20% of the prior count. A developing-process cluster grows by
// accreting members, so a genuinely new sub-thread reliably trips the count delta;
// a pure same-count swap is intentionally treated as immaterial (the existing
// split keeps applying every pass for free via applySplitOverlays).
const MATERIAL_MIN_NEW_MEMBERS = 15;
const MATERIAL_MIN_DELTA = 0.2;
// A SPAN-qualified cluster accretes across days, so waiting for a 15-member /
// 20% swing starves its re-evaluations — a long-span cluster re-asks on a
// smaller (but still non-trivial) membership change. The 2h cooldown still
// applies unchanged (pacing), only the magnitude bar is relaxed.
const MATERIAL_SPAN_MIN_NEW_MEMBERS = 8;
const MATERIAL_SPAN_MIN_DELTA = 0.1;
// Never send the whole mega-cluster to the model — cap the sample (highest
// priority first, deterministic tie-break) so the prompt can't truncate.
const MAX_MEMBERS_TO_AI = 80;
// --- balance caps ------------------------------------------------------------
const MAX_CHILDREN = 5;
const MIN_CORROBORATING_PUBLISHERS_PER_CHILD = 2;
// childKey is reused from a prior overlay child when the new partition shares at
// least this many member tokens with it (keeps lineage stable across re-evals).
const CHILDKEY_REUSE_MIN_SHARED = 2;

// Distinct-publisher key for a node (host, www-stripped; else source; else key).
// Mirrors the formation gate's notion of "distinct publisher" so the per-child
// corroboration cap means the same thing here as it does at formation.
function publisherKeyOf(node: LaneNode): string {
  if (node.url) {
    try {
      return new URL(node.url).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      /* fall through */
    }
  }
  const s = (node.source ?? '').trim().toLowerCase();
  return s || `key:${node.key}`;
}

function slugifyChildKey(label: string): string {
  return (label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Age (hours) of the OLDEST member by publishedAt; 0 when no usable timestamps
// (no basis to claim it is old — falls to the size-only gate).
// Exported so the per-pass AI-budget scheduler in curatedCluster can compute a
// candidate's gate bucket (backstop vs prevention) BEFORE spending a model call,
// using the exact same age basis the eval uses internally.
export function clusterAgeHours(nodes: LaneNode[], nowMs: number): number {
  const times = nodes
    .map((n) => (n.publishedAt ? new Date(n.publishedAt).getTime() : NaN))
    .filter((t) => Number.isFinite(t)) as number[];
  if (times.length === 0) return 0;
  return (nowMs - Math.min(...times)) / 3_600_000;
}

// SPAN (hours) between the oldest and newest member by publishedAt; 0 when
// fewer than two usable timestamps (no basis to claim the cluster is
// long-running). Distinct from clusterAgeHours (oldest vs NOW): a cluster can
// be old but time-compact (one event, still consolidating) — only a wide
// MEMBER span says it has accreted across multiple event windows. Exported for
// the caller's candidate filter and the regression test.
export function clusterSpanHours(nodes: LaneNode[]): number {
  const times = nodes
    .map((n) => (n.publishedAt ? new Date(n.publishedAt).getTime() : NaN))
    .filter((t) => Number.isFinite(t)) as number[];
  if (times.length < 2) return 0;
  return (Math.max(...times) - Math.min(...times)) / 3_600_000;
}

// PURE. Size/age admission gate. Exported for the regression test.
// `prevention` is true ONLY when the cluster qualified via the lower process-early
// thresholds (Task #414) and NOT the legacy backstop floors — the caller uses it
// to split the per-pass AI budget so prevention never starves the >=50 backstop
// (and vice versa). The legacy 2-arg behavior is unchanged: an ordinary cluster
// (no opts / developingProcess:false) still qualifies only on the SPLIT_* floors.
export function passesRepartitionGate(
  size: number,
  ageH: number,
  opts?: { developingProcess?: boolean; spanH?: number },
): { qualifies: boolean; reason: 'size' | 'age' | 'span' | null; prevention: boolean } {
  // Legacy backstop gate first — large outright, or old + moderately large.
  if (size >= SPLIT_SIZE_FLOOR) return { qualifies: true, reason: 'size', prevention: false };
  if (ageH >= SPLIT_AGE_H && size >= SPLIT_AGE_SIZE_FLOOR)
    return { qualifies: true, reason: 'age', prevention: false };
  // Early PREVENTION gate — developing-process clusters only. Splits the cluster
  // before it grows into a 50-member dumping ground.
  if (opts?.developingProcess) {
    if (size >= SPLIT_PROCESS_EARLY_SIZE_FLOOR) return { qualifies: true, reason: 'size', prevention: true };
    if (ageH >= SPLIT_PROCESS_EARLY_AGE_H && size >= SPLIT_PROCESS_EARLY_AGE_SIZE_FLOOR)
      return { qualifies: true, reason: 'age', prevention: true };
    // Aged-process recall (Task #440): an OLDER process cluster qualifies at an
    // even lower size, so a process story that aged past 16h while still modest
    // (15-17 members) is still evaluated before it balloons into a dumping ground.
    if (ageH >= SPLIT_PROCESS_OLD_AGE_H && size >= SPLIT_PROCESS_OLD_AGE_SIZE_FLOOR)
      return { qualifies: true, reason: 'age', prevention: true };
  }
  // Long-SPAN branch — ANY cluster (process or not) whose member published
  // dates span >= 2x the same-event window while moderately large is no longer
  // plausibly one time-compact event; give the model a LOOK (prevention budget;
  // leave_intact + per-child corroboration caps still guard fragmentation).
  if ((opts?.spanH ?? 0) >= SPLIT_SPAN_H && size >= SPLIT_SPAN_SIZE_FLOOR)
    return { qualifies: true, reason: 'span', prevention: true };
  return { qualifies: false, reason: null, prevention: false };
}

// PURE. Per-pass AI-budget scheduler primitives (Task #414). The repartition loop
// keeps TWO independent budgets — a legacy `backstop` budget for clusters that
// crossed the >=50 / old-and-large floors, and a small dedicated `prevention`
// budget for early developing-process splits. Bucket attribution comes from the
// gate, so the loop can decide admission BEFORE spending a model call.
export interface RepartitionBudget {
  backstop: number;
  prevention: number;
}

// Whether to even ask the model for a candidate, given its gate verdict and the
// budget already spent. A qualifying candidate is admitted only while ITS bucket
// has room — so neither bucket can exceed its cap, and one bucket filling up never
// blocks a candidate that would draw from the other. Below-gate candidates are
// cheap (the eval short-circuits without a model call) so they always pass through.
export function shouldEvaluateRepartitionCandidate(
  gate: { qualifies: boolean; prevention: boolean },
  budget: RepartitionBudget,
  used: RepartitionBudget,
): boolean {
  if (!gate.qualifies) return true;
  return gate.prevention
    ? used.prevention < budget.prevention
    : used.backstop < budget.backstop;
}

// Whether BOTH budgets are spent — the loop can stop entirely.
export function repartitionBudgetExhausted(
  budget: RepartitionBudget,
  used: RepartitionBudget,
): boolean {
  return used.backstop >= budget.backstop && used.prevention >= budget.prevention;
}

// PURE. Whether membership changed enough since the last evaluation to re-ask the
// model. See MATERIAL_MIN_* notes above for the count-delta approximation.
export function hasMaterialChange(
  existing: Pick<CuratedProcessSplitOverlay, 'evaluatedMemberHash' | 'evaluatedMemberCount'>,
  currentSize: number,
  currentHash: string,
  opts?: { spanQualified?: boolean },
): boolean {
  if (existing.evaluatedMemberHash === currentHash) return false; // identical set
  const old = existing.evaluatedMemberCount ?? 0;
  const delta = Math.abs(currentSize - old);
  // Span-qualified clusters accrete slowly across days — use the relaxed bar so
  // their re-evaluations are not starved (cooldown still paces them).
  const minNew = opts?.spanQualified ? MATERIAL_SPAN_MIN_NEW_MEMBERS : MATERIAL_MIN_NEW_MEMBERS;
  const minDelta = opts?.spanQualified ? MATERIAL_SPAN_MIN_DELTA : MATERIAL_MIN_DELTA;
  if (delta >= minNew) return true;
  if (old > 0 && delta / old >= minDelta) return true;
  return false;
}

// Deterministic, capped sample of members to show the model.
function sampleMembersForAi(nodes: LaneNode[], cap: number): LaneNode[] {
  if (nodes.length <= cap) return nodes.slice();
  return nodes
    .slice()
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (nodeToken(a) < nodeToken(b) ? -1 : 1))
    .slice(0, cap);
}

interface BuiltChild {
  label: string;
  memberNodes: LaneNode[];
  memberTokens: string[];
  anchorTokens: string[];
  corroboratingPublishers: number;
}

// Strongest identity tokens for a child: title tokens across its members, ranked
// by frequency (desc), tie-broken alphabetically, capped. Deterministic.
function deriveAnchorTokens(memberNodes: LaneNode[], cap = 12): string[] {
  const freq = new Map<string, number>();
  for (const n of memberNodes) {
    for (const t of Array.from(significantTitleTokens(n.title))) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, cap)
    .map(([t]) => t);
}

// The model's raw partition (index lists into the SAMPLE) → BuiltChild[]. A sample
// index is assigned to at most ONE child (first child wins) so children never
// overlap. Empty/out-of-range index lists are dropped.
function buildChildrenFromAi(
  sample: LaneNode[],
  rawChildren: Array<{ label: string; indices: number[] }>,
): BuiltChild[] {
  const assigned = new Set<number>();
  const built: BuiltChild[] = [];
  for (const rc of rawChildren) {
    const idxs = rc.indices
      .filter((i) => Number.isInteger(i) && i >= 1 && i <= sample.length)
      .map((i) => i - 1)
      .filter((i) => !assigned.has(i));
    if (idxs.length === 0) continue;
    for (const i of idxs) assigned.add(i);
    const memberNodes = idxs.map((i) => sample[i]);
    const corrobPubs = new Set(
      memberNodes.filter((n) => n.cls === 'corroborating').map(publisherKeyOf),
    );
    built.push({
      label: (rc.label ?? '').trim() || 'Sub-story',
      memberNodes,
      memberTokens: memberNodes.map(nodeToken),
      anchorTokens: deriveAnchorTokens(memberNodes),
      corroboratingPublishers: corrobPubs.size,
    });
  }
  return built;
}

// PURE. Enforce the balance caps: drop any child with < 2 corroborating distinct
// publishers, then keep at most MAX_CHILDREN (largest first). Returns null = LEAVE
// INTACT (fewer than 2 valid children survive — not a balanced split).
export function enforceSplitCaps(built: BuiltChild[]): BuiltChild[] | null {
  const valid = built.filter(
    (b) => b.corroboratingPublishers >= MIN_CORROBORATING_PUBLISHERS_PER_CHILD,
  );
  if (valid.length < 2) return null;
  const capped = valid
    .slice()
    .sort((a, b) => b.memberNodes.length - a.memberNodes.length || (a.label < b.label ? -1 : 1))
    .slice(0, MAX_CHILDREN);
  if (capped.length < 2) return null;
  return capped;
}

// PURE. Assign each surviving child a STABLE childKey: reuse a prior overlay
// child's key when the new partition shares >= CHILDKEY_REUSE_MIN_SHARED member
// tokens with it (so a continuing sub-thread keeps its lineage across re-evals);
// otherwise slugify the label, made unique within the set. Deterministic.
export function assignStableChildKeys(
  capped: BuiltChild[],
  existingChildren?: CuratedSplitChild[],
): CuratedSplitChild[] {
  const existing = existingChildren ?? [];
  const usedKeys = new Set<string>();
  const result: CuratedSplitChild[] = [];
  for (const b of capped) {
    const bTokens = new Set(b.memberTokens);
    let bestShared = 0;
    let bestKey: string | null = null;
    for (const ec of existing) {
      if (usedKeys.has(ec.childKey)) continue;
      let shared = 0;
      for (const t of Array.from(new Set(ec.memberTokens))) if (bTokens.has(t)) shared++;
      if (shared > bestShared || (shared === bestShared && bestKey !== null && ec.childKey < bestKey)) {
        bestShared = shared;
        bestKey = ec.childKey;
      }
    }
    let key: string;
    if (bestKey && bestShared >= CHILDKEY_REUSE_MIN_SHARED) {
      key = bestKey;
    } else {
      const base = slugifyChildKey(b.label) || 'child';
      let cand = base;
      let n = 2;
      while (usedKeys.has(cand)) cand = `${base}-${n++}`;
      key = cand;
    }
    usedKeys.add(key);
    result.push({
      childKey: key,
      label: b.label,
      anchorTokens: b.anchorTokens,
      memberTokens: b.memberTokens,
    });
  }
  return result;
}

// PURE. Full AI-verdict → CuratedSplitChild[] pipeline (build → caps → stable
// keys). Returns null = LEAVE INTACT. Exported for the regression test.
export function buildSplitChildren(
  sample: LaneNode[],
  rawChildren: Array<{ label: string; indices: number[] }>,
  existingChildren?: CuratedSplitChild[],
): CuratedSplitChild[] | null {
  const built = buildChildrenFromAi(sample, rawChildren);
  const capped = enforceSplitCaps(built);
  if (!capped) return null;
  return assignStableChildKeys(capped, existingChildren);
}

// Tolerant JSON-object parse: direct, then markdown-fence-stripped, then the
// outermost brace slice. Mirrors curatedCluster.parseJsonObjectLoose's intent so
// the Claude fallback's fenced JSON parses. Kept local so this module imports no
// AI helper.
function parseRepartitionJson(raw: string): unknown {
  const tryParse = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let v = tryParse(raw.trim());
  if (v !== undefined) return v;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    v = tryParse(fence[1].trim());
    if (v !== undefined) return v;
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    v = tryParse(raw.slice(first, last + 1));
    if (v !== undefined) return v;
  }
  return null;
}

// Coerce the model reply into a normalized verdict. Accepts leave_intact /
// leaveIntact and children / sub_stories, indices / members. Returns null only
// when the reply is structurally unusable.
function coerceAiVerdict(
  parsed: unknown,
): { leaveIntact: boolean; children: Array<{ label: string; indices: number[] }> } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const leaveIntact = o.leave_intact === true || o.leaveIntact === true;
  if (leaveIntact) return { leaveIntact: true, children: [] };
  const rawArr = Array.isArray(o.children)
    ? (o.children as unknown[])
    : Array.isArray(o.sub_stories)
      ? (o.sub_stories as unknown[])
      : [];
  const children = rawArr
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => {
      const idxRaw = Array.isArray(c.indices)
        ? (c.indices as unknown[])
        : Array.isArray(c.members)
          ? (c.members as unknown[])
          : [];
      const indices = idxRaw
        .map((i) => (typeof i === 'number' ? i : typeof i === 'string' ? Number(i) : NaN))
        .filter((n) => Number.isInteger(n)) as number[];
      const label =
        typeof c.label === 'string' ? c.label : typeof c.name === 'string' ? c.name : '';
      return { label, indices };
    });
  return { leaveIntact: false, children };
}

function buildRepartitionPrompt(sample: LaneNode[], nowMs: number): string {
  const lines = sample.map((n, i) => {
    const ageH = n.publishedAt
      ? Math.max(0, Math.round((nowMs - new Date(n.publishedAt).getTime()) / 3_600_000))
      : null;
    const src = (n.source ?? 'unknown').replace(/\s+/g, ' ').trim();
    const title = (n.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return `${i + 1}. "${title}" (${src}${ageH != null ? `, ${ageH}h ago` : ''})`;
  });
  return `You are partitioning a large, long-running news cluster about a developing process (e.g. a negotiation, ceasefire, or diplomatic effort) into the DISTINCT current sub-stories inside it.

Each numbered item below is one article currently in the cluster:

${lines.join('\n')}

Decide whether this cluster is really ONE story, or whether it has split into several distinct sub-stories that each deserve their own headline RIGHT NOW (for example: "general progress", a specific official's involvement, a specific inspections/verification thread, a specific summit or meeting).

Rules:
- Only create a sub-story that is independently newsworthy and covered by at least TWO different outlets.
- Create at MOST 5 sub-stories. Prefer fewer, larger, clearly-distinct sub-stories over many tiny ones.
- If the cluster is genuinely one story, set "leave_intact": true and return no children.
- Every sub-story needs a short human label and the list of item NUMBERS (the indices above) that belong to it. An item may appear in at most one sub-story; items that fit none can be omitted.

Return ONLY a JSON object of the form:
{"leave_intact": false, "children": [{"label": "IAEA inspections", "indices": [2, 5, 9]}]}
or {"leave_intact": true, "children": []}`;
}

export type RepartitionOverlayWrite = InsertCuratedProcessSplitOverlay & { id?: string };

export interface RepartitionEvalInput {
  // The candidate mega-cluster's live nodes (resolved from the group's keys).
  nodes: LaneNode[];
  // The overlay currently covering this group, if any (for cooldown / material-
  // change gating and stable id+childKey reuse). The caller matches it the same
  // way applySplitOverlays does.
  existingOverlay?: CuratedProcessSplitOverlay | null;
  nowMs?: number;
  // Whether this candidate is a developing-process cluster (Task #414). When true,
  // the LOWER early-prevention thresholds are eligible so the cluster can be split
  // before it reaches the 50-member backstop. Default false → legacy backstop-only
  // gate (keeps the pure function and existing callers/tests unchanged).
  developingProcess?: boolean;
}

export interface RepartitionEvalDeps {
  // Run the partition prompt; return the model's raw text, or null on a transient/
  // unavailable AI failure. Throwing is also treated as failure (fail-closed).
  complete: (prompt: string) => Promise<string | null>;
  // Insert (no id) or update (with id) the overlay; return the saved row or null.
  persist: (row: RepartitionOverlayWrite) => Promise<CuratedProcessSplitOverlay | null>;
}

export type RepartitionOutcome =
  | 'split' // overlay written, status active, >= 2 children
  | 'intact' // overlay written, status intact, [] children
  | 'cooldown' // skipped — within cooldown
  | 'unchanged' // skipped — no material change since last eval
  | 'below_gate' // skipped — size/age gate not met
  | 'ai_failed'; // AI call/parse failed → left intact, NOTHING persisted, NOTHING lost

export interface RepartitionEvalResult {
  outcome: RepartitionOutcome;
  reason: string;
  childrenCreated: number;
  membersConsidered: number;
  overlay: CuratedProcessSplitOverlay | null;
  // True when this candidate qualified via the early-prevention gate (Task #414)
  // rather than the legacy backstop floors — lets the caller charge it against the
  // dedicated prevention AI budget. Only meaningful on outcomes that hit the model.
  prevention: boolean;
}

// An INTACT verdict still records the evaluated member tokens (as a SINGLE
// synthetic "(intact)" child) so the overlay stays matchable to its cluster next
// pass — that match is what makes the 2h cooldown actually suppress a re-ask. It
// can NEVER cause a split: applySplitOverlays filters status==='active', and its
// prepareOverlay also requires >= 2 children, so a 1-child intact row is doubly
// excluded from application. findOverlayForEval (status-agnostic) still matches it.
function intactWrite(
  existing: CuratedProcessSplitOverlay | null | undefined,
  currentHash: string,
  size: number,
  triggerReason: 'size' | 'age' | 'span' | null,
  when: Date,
  currentTokens: string[],
): RepartitionOverlayWrite {
  return {
    ...(existing?.id ? { id: existing.id } : {}),
    children: [{ childKey: '__evaluated__', label: '(intact)', anchorTokens: [], memberTokens: currentTokens }],
    verdictHash: '',
    evaluatedMemberHash: currentHash,
    evaluatedMemberCount: size,
    triggerReason: triggerReason ?? null,
    status: 'intact',
    lastEvaluatedAt: when,
  };
}

// Orchestrates one re-partition evaluation for a single candidate group. See the
// section header for the full fail-closed contract.
export async function evaluateProcessRepartition(
  input: RepartitionEvalInput,
  deps: RepartitionEvalDeps,
): Promise<RepartitionEvalResult> {
  const nowMs = input.nowMs ?? Date.now();
  const when = new Date(nowMs);
  const nodes = input.nodes;
  const size = nodes.length;
  const existing = input.existingOverlay ?? null;

  // 1) Size/age gate. Developing-process clusters are eligible for the LOWER early-
  // prevention thresholds (Task #414); ordinary clusters use the legacy backstop
  // floors only. `gate.prevention` flows onto every result so the caller can charge
  // the correct AI budget bucket.
  const ageH = clusterAgeHours(nodes, nowMs);
  const gate = passesRepartitionGate(size, ageH, {
    developingProcess: input.developingProcess === true,
    spanH: clusterSpanHours(nodes),
  });
  const base = { childrenCreated: 0, membersConsidered: size, prevention: gate.prevention };
  if (!gate.qualifies) {
    return { outcome: 'below_gate', reason: 'gate', overlay: existing, ...base };
  }

  // Current member signature — computed UP FRONT because both the cooldown
  // safety-override and the material-change gate below need it.
  const currentTokens = nodes.map(nodeToken);
  const currentHash = synthesisSignature(currentTokens);
  const grewMaterially =
    !!existing &&
    hasMaterialChange(existing, size, currentHash, { spanQualified: gate.reason === 'span' });

  // 2) Cooldown — never re-ask the model about the same cluster too often.
  //    SAFETY OVERRIDE (Task #414): the 2h cooldown must NEVER let a cluster sit
  //    ABOVE the hard >=50 backstop floor un-re-evaluated. Production showed a
  //    cluster that was evaluated once and then re-grew 39 -> 55 members DURING
  //    its cooldown window, silently skipped every pass — so the backstop could
  //    not re-fire and a mega-cluster shipped. When a cluster is over the backstop
  //    AND its membership has materially changed since the last eval, bypass the
  //    cooldown and re-ask. Gating the bypass on a MATERIAL change keeps it
  //    loop-safe: a big-but-STABLE cluster the model chose to keep intact is not
  //    re-hammered (no AI-budget waste, no re-ask storm) — only a cluster still
  //    GROWING past the cap jumps the queue. The early-prevention size range
  //    (<50) is intentionally NOT given this override: the normal cooldown is the
  //    right pace there, and the hard safety guarantee only concerns the backstop.
  if (existing && nowMs - existing.lastEvaluatedAt.getTime() < COOLDOWN_MS) {
    const overBackstopAndGrowing = size >= SPLIT_SIZE_FLOOR && grewMaterially;
    if (!overBackstopAndGrowing) {
      return { outcome: 'cooldown', reason: 'cooldown', overlay: existing, ...base };
    }
  }

  // 3) Material-change gate — once an overlay exists, only re-ask when membership
  // changed enough. An unchanged set keeps the existing overlay applying as-is.
  if (existing && !grewMaterially) {
    return { outcome: 'unchanged', reason: 'immaterial', overlay: existing, ...base };
  }

  // 4) Ask the model (fail-closed — any error/empty/unparseable → leave intact,
  // persist NOTHING so a transient failure is retried next eligible pass).
  const sample = sampleMembersForAi(nodes, MAX_MEMBERS_TO_AI);
  let raw: string | null = null;
  try {
    raw = await deps.complete(buildRepartitionPrompt(sample, nowMs));
  } catch {
    raw = null;
  }
  if (!raw) {
    return { outcome: 'ai_failed', reason: 'ai_error', overlay: existing, ...base };
  }
  const verdict = coerceAiVerdict(parseRepartitionJson(raw));
  if (!verdict) {
    return { outcome: 'ai_failed', reason: 'ai_unparseable', overlay: existing, ...base };
  }

  // 5) Persist the verdict. The model has ALREADY been called (consuming an AI
  // budget slot), so every path from here is wrapped fail-closed: if persistence
  // throws (DB blip), we DO NOT re-throw — we return 'ai_failed'. That keeps the
  // attempt counted against the per-pass AI budget (the caller only counts
  // split/intact/ai_failed), persists nothing partial, and leaves the cluster
  // INTACT (no overlay added → applySplitOverlays falls back to the reconciled
  // identity → no member moved/lost). A re-throw would let the caller `continue`
  // WITHOUT counting the spent AI call, allowing the budget to be exceeded.
  try {
    // 5a) Model says keep as one — persist an intact verdict (cooldown suppression).
    if (verdict.leaveIntact) {
      const saved = await deps.persist(
        intactWrite(existing, currentHash, size, gate.reason, when, currentTokens),
      );
      return { outcome: 'intact', reason: 'model_intact', overlay: saved, ...base };
    }

    // 5b) Build + enforce caps. A verdict that fails the balance caps is treated as
    // intact (persisted so the cooldown suppresses an immediate re-ask).
    const existingChildren = Array.isArray(existing?.children)
      ? (existing!.children as CuratedSplitChild[])
      : undefined;
    const children = buildSplitChildren(sample, verdict.children, existingChildren);
    if (!children || children.length < 2) {
      const saved = await deps.persist(
        intactWrite(existing, currentHash, size, gate.reason, when, currentTokens),
      );
      return { outcome: 'intact', reason: 'caps_intact', overlay: saved, ...base };
    }

    // 5c) Persist the active split. Reuse the overlay id (stable lineage) when one
    // exists; otherwise the DB generates it.
    const verdictHash = synthesisSignature(
      children.flatMap((c) => [`k:${c.childKey}`, ...c.memberTokens]),
    );
    const saved = await deps.persist({
      ...(existing?.id ? { id: existing.id } : {}),
      children,
      verdictHash,
      evaluatedMemberHash: currentHash,
      evaluatedMemberCount: size,
      triggerReason: gate.reason,
      status: 'active',
      lastEvaluatedAt: when,
    });
    return {
      outcome: 'split',
      reason: 'split',
      overlay: saved,
      childrenCreated: children.length,
      membersConsidered: size,
      prevention: gate.prevention,
    };
  } catch {
    // Persist failed AFTER the AI call. Count the spent call (fail-closed), persist
    // nothing, leave the cluster intact.
    return { outcome: 'ai_failed', reason: 'persist_failed', overlay: existing, ...base };
  }
}
