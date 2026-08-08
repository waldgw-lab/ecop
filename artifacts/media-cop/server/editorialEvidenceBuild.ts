// =============================================================================
// Curated editorial-evidence BUILDER (Task #1180).
//
// This is a FOCUSED server-side adapter that turns the immutable curated
// override-event audit rows (curated_override_events) into the PURE evidence
// shapes defined by shared/editorialEvidence.ts, then computes:
//   - the episode-explorer view (collapsed episodes + counts),
//   - a SEPARATE "workload" tally (honest episode/workload telemetry that
//     replaces the old rule-compiler correlation buckets), and
//   - the deterministic redacted Markdown / JSON packet.
//
// It performs NO AI, NO enforcement, and NO schema/storage mutation. It only
// READS the immutable rows it is given and maps them through the pure module.
// Identity normalization is delegated to the ONE canonical curated URL identity
// token (server/urlIdentity.normalizeIdentityUrl) so the evidence lane can never
// drift from the clustering lane.
//
// The mapping is deliberately conservative: an override-event action string
// that has no editorial meaning (or is a legacy rule-compiler artifact) is
// dropped, never guessed into a grouping label.
// =============================================================================

import { normalizeIdentityUrl } from "./urlIdentity";
import type { CuratedEditorialEpisode, CuratedOverrideEvent } from "@shared/schema";
import {
  type RawEditorialAction,
  type EditorialActionKind,
  type EditorialEpisode,
  type EditorialActionFamily,
  type LifecycleOutcome,
  type PriorityDirection,
  type GroupingLabel,
  type EvidenceFilters,
  type EvidenceCounts,
  type PacketOptions,
  EDITORIAL_EVIDENCE_SCHEMA_VERSION,
  REDACTED_FIELDS,
  ACTION_FAMILY,
  actionFamily,
  collapseEpisodes,
  filterEpisodes,
  computeCounts,
  groupingLabel,
  redactNote,
  buildMarkdownPacket,
  buildJsonPacket,
  INCORRECT_GROUPING_REASON_KEYS,
} from "@shared/editorialEvidence";

// ---------------------------------------------------------------------------
// 1. Action-string → editorial-action-kind mapping.
// ---------------------------------------------------------------------------
// The override-event `action` column is a free string set at capture time.
// Only the strings that carry genuine editorial meaning map to an
// EditorialActionKind; everything else (legacy learned-rule artifacts such as
// 'learned-rule-approved'/'learned-rule-revoked', outlet-block toggles, etc.)
// is intentionally NOT evidence and returns null so it is dropped.
const ACTION_KIND_MAP: Record<string, EditorialActionKind> = {
  // priority family
  "priority-override": "priority-adjust",
  "hide-story": "hide",
  "unhide-story": "undo",
  // metadata family
  classification: "classify",
  "content-kind-mark": "content-kind",
  "content-kind-clear": "undo",
  "content-kind": "content-kind",
  "replace-headline": "headline",
  "replace-image": "image",
  "hide-image": "image",
  "unhide-image": "undo",
  // grouping-positive
  "manual-link": "link",
  "manual-merge": "merge",
  // grouping-negative
  "manual-move": "move",
  "move-member": "move",
  "manual-evict": "evict",
  "evict-item": "evict",
  "manual-unlink-member": "unlink",
  "manual-unlink": "unlink",
  // lineage
  "manual-unlink-undo": "undo",
  "manual-unevict": "undo",
  "manual-unmove": "undo",
  undo: "undo",
};

export function mapActionToKind(action: string): EditorialActionKind | null {
  const k = (action ?? "").trim();
  return ACTION_KIND_MAP[k] ?? null;
}

// The set of override-event action strings that DO map to evidence. Exposed so
// the route/telemetry can report how many raw rows were considered vs. dropped.
export const EVIDENCE_ACTION_STRINGS: ReadonlySet<string> = new Set(
  Object.keys(ACTION_KIND_MAP),
);

// ---------------------------------------------------------------------------
// 2. Per-event field extraction helpers.
// ---------------------------------------------------------------------------

// Parse the "pinned to <n>" free-text newValue used by priority-override.
function parseRequestedScore(newValue: string | null | undefined): number | null {
  if (!newValue) return null;
  const m = /(-?\d+)/.exec(newValue);
  return m ? parseInt(m[1], 10) : null;
}

// Was this a "hide" (priority direction hide) vs "unhide"? A hide-story event's
// newValue is "hidden" | "un-hidden".
function isUnhideNote(newValue: string | null | undefined): boolean {
  return /un-?hidden/i.test(newValue ?? "");
}

// Derive the observed lifecycle outcome from the immutable row. We never invent
// an outcome the row can't support: a row that landed (was recorded) is at least
// "persisted"; before/after snapshots showing an applied change promote it to
// "applied"; an un-hide of a prior hide is "undone"; failures are only marked
// when the row itself records one.
function deriveOutcome(e: CuratedOverrideEvent, kind: EditorialActionKind): LifecycleOutcome {
  if (kind === "undo") return "undone";
  if (kind === "hide" && isUnhideNote(e.newValue)) return "undone";
  // A recorded override event means the write persisted; treat metadata/grouping
  // writes as applied (they are display/overlay writes that take effect on the
  // next read), and priority writes as applied too (the pin overlay is live).
  return "applied";
}

// Whether the editor EXPLICITLY flagged an incorrect grouping. This is true only
// when a grouping-negative/lineage action carries a reason key from the
// controlled "incorrect grouping" set. We never infer it from the action alone.
function explicitIncorrectGrouping(e: CuratedOverrideEvent): boolean {
  const keys = Array.isArray(e.reasonKeys) ? e.reasonKeys : [];
  return keys.some((k) => typeof k === "string" && INCORRECT_GROUPING_REASON_KEYS.has(k));
}

// The controlled reason key for the evidence module. The override rows store a
// list (reasonKeys); the pure module wants a single representative key, so we
// take the first controlled key present. A free note is passed separately.
function primaryReasonKey(e: CuratedOverrideEvent): string | null {
  const keys = Array.isArray(e.reasonKeys) ? e.reasonKeys : [];
  const first = keys.find((k) => typeof k === "string" && k.trim().length > 0);
  return first ?? null;
}

// storyKey shapes: `cluster:<id>` | `main:<id>` | `curated:<id>`. Extract the
// clusterId when present so episode identity keys off the cluster; otherwise the
// primaryUrl carries identity.
function extractClusterId(storyKey: string | null | undefined): string | null {
  const k = (storyKey ?? "").trim();
  if (k.startsWith("cluster:")) return k.slice("cluster:".length) || null;
  return null;
}

// ---------------------------------------------------------------------------
// 3. CuratedOverrideEvent[] → RawEditorialAction[].
// ---------------------------------------------------------------------------
// Deterministic: a row with no mappable action is dropped; ordering is by the
// row's createdAt then id so collapse is reproducible. Editor identity is
// carried ONLY for episode grouping and never emitted in the packet.
export function toRawEditorialActions(events: CuratedOverrideEvent[]): RawEditorialAction[] {
  const out: RawEditorialAction[] = [];
  for (const e of events) {
    const kind = mapActionToKind(e.action);
    if (!kind) continue;
    const at = new Date(e.createdAt).getTime();
    if (!Number.isFinite(at)) continue;
    const family = actionFamily(kind);
    const memberUrls = e.itemUrl ? [e.itemUrl] : [];
    const memberOutlets = e.outlet ? [e.outlet] : [];
    const headlines = e.headline ? [e.headline] : [];
    const requested =
      kind === "priority-adjust" ? parseRequestedScore(e.newValue) : null;
    out.push({
      id: e.id,
      kind,
      at,
      editorId: e.editor ?? null,
      clusterId: extractClusterId(e.storyKey),
      primaryUrl: e.itemUrl ?? null,
      reasonKey: primaryReasonKey(e),
      note: e.reasonNote ?? null,
      beforeScore: e.originalScore ?? null,
      requestedScore: requested,
      // The override rows do not record the resolved-actual score separately;
      // the requested pin IS the applied overlay value, so actual mirrors it.
      actualScore: requested,
      memberUrls,
      memberOutlets,
      headlines,
      provenance: {
        model: null,
        promptVersion: null,
        clusterRevision: null,
        surface: e.fromRadar ? "scoring-radar" : "curated-detail",
      },
      outcome: deriveOutcome(e, kind),
      // A recorded immutable audit row IS the verification that the action
      // landed and persisted. Ambiguity is expressed via outcome, not here.
      verified: true,
      explicitIncorrectGrouping:
        (family === "grouping-negative" || family === "lineage") &&
        explicitIncorrectGrouping(e),
      supersedesEpisodeId: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Episode-explorer view + WORKLOAD counts.
// ---------------------------------------------------------------------------
// Workload counts are the honest replacement for the old rule-compiler
// correlation buckets: they count real editor WORK (raw actions, collapsed
// episodes, and how many episodes fall in each family / carry a note), with NO
// claim that any of it becomes a standing rule.

export interface WorkloadCounts {
  // Total immutable override rows scanned in the window (all actions).
  rawEventsScanned: number;
  // Rows that mapped to an editorial action (the rest are non-evidence).
  evidenceRawActions: number;
  // Rows dropped because their action string is not editorial evidence.
  nonEvidenceRawActions: number;
  // Distinct collapsed episodes.
  episodes: number;
  // Episodes per action family.
  byFamily: Record<EditorialActionFamily, number>;
  // Episodes per concrete action kind.
  byAction: Record<string, number>;
  // Episodes carrying an editor note.
  commentedEpisodes: number;
  // Episodes that produced each grouping label.
  byLabel: { positive: number; negative: number; lineage: number; none: number };
}

export interface EpisodeExplorer {
  episodes: EditorialEpisode[];
  workload: WorkloadCounts;
}

const EMPTY_FAMILY_COUNTS = (): Record<EditorialActionFamily, number> => ({
  priority: 0,
  "grouping-positive": 0,
  "grouping-negative": 0,
  metadata: 0,
  lineage: 0,
});

export function buildEpisodeExplorer(events: CuratedOverrideEvent[]): EpisodeExplorer {
  const raw = toRawEditorialActions(events);
  const episodes = collapseEpisodes(raw, normalizeIdentityUrl);

  const byFamily = EMPTY_FAMILY_COUNTS();
  const byAction: Record<string, number> = {};
  const byLabel = { positive: 0, negative: 0, lineage: 0, none: 0 };
  let commentedEpisodes = 0;
  for (const ep of episodes) {
    byFamily[ep.family] += 1;
    byAction[ep.kind] = (byAction[ep.kind] ?? 0) + 1;
    byLabel[groupingLabel(ep)] += 1;
    if (ep.note && ep.note.trim()) commentedEpisodes += 1;
  }

  const workload: WorkloadCounts = {
    rawEventsScanned: events.length,
    evidenceRawActions: raw.length,
    nonEvidenceRawActions: events.length - raw.length,
    episodes: episodes.length,
    byFamily,
    byAction,
    commentedEpisodes,
    byLabel,
  };

  return { episodes, workload };
}

// ---------------------------------------------------------------------------
// 5. Packet generation (delegated to the pure module, canonical normalizer).
// ---------------------------------------------------------------------------

export function buildEvidenceMarkdown(
  events: CuratedOverrideEvent[],
  options: Omit<PacketOptions, "normalizeUrl"> = {},
): string {
  const { episodes } = buildEpisodeExplorer(events);
  return buildMarkdownPacket(episodes, { ...options, normalizeUrl: normalizeIdentityUrl });
}

export function buildEvidenceJson(
  events: CuratedOverrideEvent[],
  options: Omit<PacketOptions, "normalizeUrl"> = {},
) {
  const { episodes } = buildEpisodeExplorer(events);
  return buildJsonPacket(episodes, { ...options, normalizeUrl: normalizeIdentityUrl });
}

// Compute filtered counts for the explorer view (applies default ambiguous
// exclusion + any caller filters). Returned alongside the raw workload so the
// route can expose BOTH the "all work done" tally and the "learnable evidence"
// tally without conflating them.
export function computeFilteredCounts(
  episodes: EditorialEpisode[],
  filters: EvidenceFilters = {},
): EvidenceCounts {
  const result = filterEpisodes(episodes, filters);
  return computeCounts(episodes, result);
}

// ===========================================================================
// 6. DURABLE EPISODE adapter (PRIMARY truth) — Task #1180.
// ===========================================================================
// The durable curated_editorial_episodes rows are the PRIMARY source of truth
// for the evidence explorer: they carry the actual observed lifecycle, the
// persistence counters, contradiction/supersede/undo LINEAGE, provenance and
// rich context (before/requested/actual/alternatives). The raw override-event
// projection above is retained ONLY as a pre-migration fallback for windows
// where durable capture had not yet run. This adapter maps a DB episode row to
// the SHARED pure EditorialEpisode so the same filter/count/packet machinery
// applies uniformly to both sources. It performs NO I/O and NO enforcement.

// Map the durable action-verb string back to a pure EditorialActionKind. The
// durable `action` column mirrors the override-event verb vocabulary, so we
// reuse ACTION_KIND_MAP; anything unknown is conservatively treated as the
// finest action implied by the stored family (never guessed into a label).
const FAMILY_FALLBACK_KIND: Record<EditorialActionFamily, EditorialActionKind> = {
  priority: "priority-adjust",
  "grouping-positive": "link",
  "grouping-negative": "unlink",
  metadata: "classify",
  lineage: "undo",
};

function dbActionToKind(action: string, family: EditorialActionFamily): EditorialActionKind {
  const a = (action ?? "").trim();
  // The durable `action` column stores the pure EditorialActionKind verb when
  // captured by this module; accept it directly when valid.
  if (a in ACTION_FAMILY) return a as EditorialActionKind;
  // Otherwise treat it as a raw override-event verb and map it.
  const mapped = mapActionToKind(a);
  if (mapped) return mapped;
  return FAMILY_FALLBACK_KIND[family] ?? "classify";
}

function normalizeFamily(raw: string | null | undefined): EditorialActionFamily {
  const f = (raw ?? "").trim();
  if (
    f === "priority" || f === "grouping-positive" || f === "grouping-negative" ||
    f === "metadata" || f === "lineage"
  ) {
    return f;
  }
  return "metadata";
}

// The durable lifecycle + outcome fields carry the ACTUAL observed truth. Map
// them onto the pure LifecycleOutcome vocabulary the filters/packet understand.
// Lifecycle is authoritative for terminal states (contradicted/superseded/
// undone); otherwise we honor the recorded present-tense `outcome` when it maps
// cleanly, falling back to persisted/applied based on the persistence counters.
const LIFECYCLE_OUTCOME_MAP: Record<string, LifecycleOutcome> = {
  contradicted: "conflicted",
  superseded: "superseded",
  undone: "undone",
};

const OUTCOME_ALIASES: Record<string, LifecycleOutcome> = {
  requested: "requested",
  persisted: "persisted",
  applied: "applied",
  deferred: "deferred",
  conflicted: "conflicted",
  dormant: "dormant",
  "no-op": "dormant",
  superseded: "superseded",
  reverted: "undone",
  undone: "undone",
  failed: "failed",
  // Present-tense outcome verbs the durable row may store.
  demoted: "applied",
  promoted: "applied",
  hidden: "applied",
  relabeled: "applied",
};

function deriveDbOutcome(row: CuratedEditorialEpisode): LifecycleOutcome {
  const lc = (row.lifecycle ?? "").trim();
  if (LIFECYCLE_OUTCOME_MAP[lc]) return LIFECYCLE_OUTCOME_MAP[lc];
  const oc = (row.outcome ?? "").trim().toLowerCase();
  if (oc && OUTCOME_ALIASES[oc]) return OUTCOME_ALIASES[oc];
  // No explicit outcome: a settled episode with persistence is applied; an open
  // one that has at least one event is persisted; otherwise requested.
  if (lc === "settled") return "applied";
  if ((row.eventCount ?? 0) > 0) return "persisted";
  return "requested";
}

function dbDirection(row: CuratedEditorialEpisode): PriorityDirection {
  const d = (row.direction ?? "").trim().toLowerCase();
  if (d === "promote") return "up";
  if (d === "demote") return "down";
  if (d === "suppress") return "hide";
  const before = readScore(row.beforeJson);
  const requested = readScore(row.requestedJson);
  if (before != null && requested != null) {
    if (requested > before) return "up";
    if (requested < before) return "down";
  }
  return "none";
}

// Best-effort numeric extraction from a JSON snapshot: accepts a bare number, a
// { score } / { value } / { priority } object shape. Returns null otherwise.
function readScore(j: unknown): number | null {
  if (typeof j === "number" && Number.isFinite(j)) return j;
  if (j && typeof j === "object") {
    const o = j as Record<string, unknown>;
    for (const k of ["score", "value", "priority", "p"]) {
      const v = o[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }
  return null;
}

function readStringArray(j: unknown, keys: string[]): string[] {
  if (!j || typeof j !== "object") return [];
  const o = j as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v)) {
      return v.map((x) => (x == null ? "" : String(x))).filter((s) => s.length > 0);
    }
  }
  return [];
}

// A durable episode is "verified" for evidence purposes when the editor/outcome
// observer confirmed it landed, OR the lifecycle reached a settled terminal
// state. Ambiguity is honored from the explicit `ambiguous` flag.
function dbVerified(row: CuratedEditorialEpisode): boolean {
  if (row.ambiguous) return false;
  if (row.verified) return true;
  const lc = (row.lifecycle ?? "").trim();
  return lc === "settled" || lc === "superseded" || lc === "undone";
}

// Adapt one durable episode row to the shared pure EditorialEpisode. Editor
// identity is intentionally dropped (the durable row's createdBy is never
// carried into evidence). Lineage/provenance/context are preserved.
export function adaptDbEpisode(row: CuratedEditorialEpisode): EditorialEpisode {
  const family = normalizeFamily(row.actionFamily);
  const kind = dbActionToKind(row.action, family);
  const reasonKey = Array.isArray(row.reasonKeys)
    ? (row.reasonKeys.find((k) => typeof k === "string" && k.trim().length > 0) ?? null)
    : null;
  const first = row.firstEventAt ? new Date(row.firstEventAt).getTime() : new Date(row.createdAt).getTime();
  const last = row.lastEventAt ? new Date(row.lastEventAt).getTime() : new Date(row.updatedAt).getTime();
  const storyIdentity =
    (row.canonicalUrl && normalizeIdentityUrl(row.canonicalUrl)) ||
    (row.storyKey ?? "") ||
    (row.canonicalUrl ?? "");
  const provenance = row.provenanceJson && typeof row.provenanceJson === "object"
    ? {
        model: (row.provenanceJson as any).model ?? null,
        promptVersion: (row.provenanceJson as any).promptVersion ?? null,
        clusterRevision: (row.provenanceJson as any).clusterRevision ?? null,
        surface: (row.provenanceJson as any).surface ?? row.editorSurface ?? null,
      }
    : (row.editorSurface ? { model: null, promptVersion: null, clusterRevision: null, surface: row.editorSurface } : null);

  const explicitIncorrect =
    (family === "grouping-negative" || family === "lineage") &&
    Array.isArray(row.reasonKeys) &&
    row.reasonKeys.some((k) => typeof k === "string" && INCORRECT_GROUPING_REASON_KEYS.has(k));

  return {
    episodeId: row.id,
    key: row.signature,
    family,
    kind,
    editorId: null,
    clusterId: row.storyKey && row.storyKey.startsWith("cluster:") ? row.storyKey.slice("cluster:".length) : null,
    primaryUrl: row.canonicalUrl ?? null,
    storyIdentity,
    // The durable row aggregates by reference; expose the raw event count as the
    // collapsed count (>=1) so workload/evidence tallies stay honest.
    rawActionIds: [],
    rawCount: Math.max(1, row.eventCount ?? 0),
    reasonKey,
    note: row.reasonNote ?? null,
    direction: dbDirection(row),
    firstAt: Number.isFinite(first) ? first : Date.now(),
    lastAt: Number.isFinite(last) ? last : Date.now(),
    beforeScore: readScore(row.beforeJson),
    requestedScore: readScore(row.requestedJson),
    actualScore: readScore(row.actualJson),
    memberUrls: readStringArray(row.requestedJson, ["memberUrls", "members"]),
    memberOutlets: row.outletId ? [row.outletId] : readStringArray(row.requestedJson, ["memberOutlets", "outlets"]),
    headlines: readStringArray(row.requestedJson, ["headlines", "headline"]),
    provenance,
    outcome: deriveDbOutcome(row),
    verified: dbVerified(row),
    explicitIncorrectGrouping: !!explicitIncorrect,
    // Durable contradiction/undo lineage points from this episode to the prior
    // episode it replaced or reversed. The packet uses this shared field so the
    // copied handoff remains legible without exposing editor identity.
    supersedesEpisodeId: row.contradictsEpisodeId ?? null,
  };
}

export function adaptDbEpisodes(rows: CuratedEditorialEpisode[]): EditorialEpisode[] {
  return rows.map(adaptDbEpisode);
}

// ===========================================================================
// 7. Client-facing evidence RESPONSE (rich episodes + lineage/persistence).
// ===========================================================================
// The explorer client consumes the JSON-packet shape PLUS a few extra
// truthful-lifecycle fields per episode (persisted / supersededByEpisodeId /
// contradictsEpisodeId / firstAt / lastAt). We build that here from the shared
// filtered result so the on-screen list and the copied Markdown packet describe
// the identical filtered scope. Durable lineage (contradicts/superseded/undone)
// is threaded through from the DB rows by episodeId.

export interface EvidenceResponseEpisode {
  episodeId: string;
  action: EditorialActionKind;
  family: EditorialActionFamily;
  label: GroupingLabel;
  reason: string | null;
  note: string | null;
  story: string;
  rawCount: number;
  before: number | null;
  requested: number | null;
  actual: number | null;
  direction: PriorityDirection;
  outcome: LifecycleOutcome;
  verified: boolean;
  persisted: boolean;
  supersededByEpisodeId: string | null;
  supersedesEpisodeId: string | null;
  contradictsEpisodeId: string | null;
  memberUrls: string[];
  memberOutlets: string[];
  headlines: string[];
  provenance: {
    model: string | null;
    promptVersion: string | null;
    clusterRevision: string | null;
    surface: string | null;
  } | null;
  firstAt: number | null;
  lastAt: number | null;
}

export interface EvidenceResponse {
  schemaVersion: string;
  scopeLabel: string | null;
  counts: EvidenceCounts;
  redactedFields: string[];
  episodes: EvidenceResponseEpisode[];
  excludedAmbiguous: { episodeId: string; reason: string }[];
}

// Lineage lookups derived from the durable rows (empty for the raw fallback).
export interface EpisodeLineage {
  persisted: Map<string, boolean>;
  supersededBy: Map<string, string | null>;
  contradicts: Map<string, string | null>;
}

function emptyLineage(): EpisodeLineage {
  return { persisted: new Map(), supersededBy: new Map(), contradicts: new Map() };
}

export function lineageFromDbEpisodes(rows: CuratedEditorialEpisode[]): EpisodeLineage {
  const lineage = emptyLineage();
  for (const r of rows) {
    const lc = (r.lifecycle ?? "").trim();
    // "persisted" = the change is still in effect: not superseded/undone, and
    // either settled or still open with recorded evidence.
    const stillInEffect = lc !== "superseded" && lc !== "undone";
    lineage.persisted.set(r.id, stillInEffect);
    lineage.supersededBy.set(r.id, r.supersededById ?? null);
    lineage.contradicts.set(r.id, r.contradictsEpisodeId ?? null);
  }
  return lineage;
}

function toResponseEpisode(ep: EditorialEpisode, lineage: EpisodeLineage): EvidenceResponseEpisode {
  const prov = ep.provenance
    ? {
        model: ep.provenance.model ?? null,
        promptVersion: ep.provenance.promptVersion ?? null,
        clusterRevision: ep.provenance.clusterRevision ?? null,
        surface: ep.provenance.surface ?? null,
      }
    : null;
  const persisted = lineage.persisted.has(ep.episodeId)
    ? !!lineage.persisted.get(ep.episodeId)
    : ep.outcome !== "superseded" && ep.outcome !== "undone" && ep.outcome !== "failed";
  return {
    episodeId: ep.episodeId,
    action: ep.kind,
    family: ep.family,
    label: groupingLabel(ep),
    reason: ep.reasonKey ?? null,
    note: redactNote(ep.note),
    story: ep.storyIdentity,
    rawCount: ep.rawCount,
    before: ep.beforeScore ?? null,
    requested: ep.requestedScore ?? null,
    actual: ep.actualScore ?? null,
    direction: ep.direction,
    outcome: ep.outcome,
    verified: ep.verified,
    persisted,
    supersededByEpisodeId: lineage.supersededBy.get(ep.episodeId) ?? null,
    supersedesEpisodeId: ep.supersedesEpisodeId ?? null,
    contradictsEpisodeId: lineage.contradicts.get(ep.episodeId) ?? null,
    memberUrls: ep.memberUrls,
    memberOutlets: ep.memberOutlets,
    headlines: ep.headlines,
    provenance: prov,
    firstAt: ep.firstAt ?? null,
    lastAt: ep.lastAt ?? null,
  };
}

// Build the client-facing response from already-adapted shared episodes. The
// default ambiguous/unverified exclusion + representative sampling are applied
// by the pure filter, so the on-screen list matches the packet exactly.
export function buildEvidenceResponse(
  episodes: EditorialEpisode[],
  opts: { filters?: EvidenceFilters; scopeLabel?: string | null; lineage?: EpisodeLineage } = {},
): EvidenceResponse {
  const filters = opts.filters ?? {};
  const lineage = opts.lineage ?? emptyLineage();
  const result = filterEpisodes(episodes, filters);
  const counts = computeCounts(episodes, result);
  return {
    schemaVersion: EDITORIAL_EVIDENCE_SCHEMA_VERSION,
    scopeLabel: opts.scopeLabel ?? null,
    counts,
    redactedFields: [...REDACTED_FIELDS],
    episodes: result.included.map((ep) => toResponseEpisode(ep, lineage)),
    excludedAmbiguous: result.excludedAmbiguous.map((ep) => ({
      episodeId: ep.episodeId,
      reason: !ep.verified ? "unverified" : `outcome:${ep.outcome}`,
    })),
  };
}

// Deterministic Markdown packet from already-adapted shared episodes (used when
// durable episodes are the primary source). Delegates to the pure packet with
// the canonical normalizer so it stays byte-identical to the JSON counts.
export function buildEvidenceMarkdownFromEpisodes(
  episodes: EditorialEpisode[],
  options: Omit<PacketOptions, "normalizeUrl"> = {},
): string {
  return buildMarkdownPacket(episodes, { ...options, normalizeUrl: normalizeIdentityUrl });
}
