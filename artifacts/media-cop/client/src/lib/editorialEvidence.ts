// =============================================================================
// Client helper for the Curated editorial-evidence explorer (Task #1180).
//
// This is a THIN client-side mirror of the server-side contract in
// shared/editorialEvidence.ts — it declares the response shapes returned by
//   GET  /api/curated/editorial-evidence
//   GET  /api/curated/editorial-evidence/packet
//   GET  /api/curated/legacy-learning
//   POST /api/curated/legacy-learning/:id/disposition
// and the small, human-readable label lookups + query-string builder the
// explorer UI needs. It carries NO learning/enforcement logic and NEVER treats
// a raw workload count as a learning-confidence signal — the explorer only
// surfaces evidence for a human/development agent to reason about.
// =============================================================================

// --- Action families / kinds / outcomes (mirror of the server contract) -----

export type EditorialActionFamily =
  | "priority"
  | "grouping-positive"
  | "grouping-negative"
  | "metadata"
  | "lineage";

export type EditorialActionKind =
  | "priority-adjust"
  | "hide"
  | "classify"
  | "content-kind"
  | "headline"
  | "image"
  | "link"
  | "merge"
  | "move"
  | "evict"
  | "unlink"
  | "undo";

export type LifecycleOutcome =
  | "requested"
  | "persisted"
  | "applied"
  | "deferred"
  | "conflicted"
  | "dormant"
  | "superseded"
  | "undone"
  | "failed";

export type GroupingLabel = "positive" | "negative" | "lineage" | "none";

export type PriorityDirection = "up" | "down" | "hide" | "unhide" | "none";

// --- Human-readable labels ---------------------------------------------------

export const ACTION_FAMILY_LABELS: Record<EditorialActionFamily, string> = {
  priority: "Priority / ranking",
  "grouping-positive": "Grouping — same-event",
  "grouping-negative": "Grouping — incorrect",
  metadata: "Metadata",
  lineage: "Supersede / undo",
};

export const ALL_ACTION_FAMILIES: EditorialActionFamily[] = [
  "priority",
  "grouping-positive",
  "grouping-negative",
  "metadata",
  "lineage",
];

export const ACTION_KIND_LABELS: Record<EditorialActionKind, string> = {
  "priority-adjust": "Priority adjust",
  hide: "Hide",
  classify: "Re-classify",
  "content-kind": "Content-kind",
  headline: "Headline override",
  image: "Image override",
  link: "Link stories",
  merge: "Merge stories",
  move: "Move member",
  evict: "Evict member",
  unlink: "Unlink stories",
  undo: "Undo",
};

export const OUTCOME_LABELS: Record<LifecycleOutcome, string> = {
  requested: "Requested",
  persisted: "Persisted",
  applied: "Applied",
  deferred: "Deferred",
  conflicted: "Conflicted",
  dormant: "Dormant / no-op",
  superseded: "Superseded",
  undone: "Undone",
  failed: "Failed",
};

export const GROUPING_LABEL_LABELS: Record<GroupingLabel, string> = {
  positive: "Same-event (positive)",
  negative: "Incorrect grouping (negative)",
  lineage: "Evolution / supersede / undo",
  none: "—",
};

// Priority reasons + cluster reasons — key→label so the explorer can show the
// editor's semantic reason. Kept in sync with shared/editorialEvidence.ts.
export const EVIDENCE_REASON_LABELS: Record<string, string> = {
  // Priority reasons
  "us-allied-consequence": "Direct U.S./allied consequence",
  "leadership-watch-interest": "Leadership / watch interest",
  "operational-readiness-impact": "Operational / readiness impact",
  "imminence-freshness": "Imminence / freshness",
  novelty: "Novelty",
  "comparative-ranking": "Comparative ranking",
  "aftermath-downstream": "Aftermath / downstream effects",
  "decay-error": "Decay error",
  other: "Other",
  // Cluster reasons
  "same-event-process": "Same event / process",
  "different-incident": "Different incident / action",
  "different-phase-time-location": "Different phase / time / location",
  "downstream-consequence": "Downstream consequence",
  "story-evolution": "Story evolution",
  "mistaken-prior-edit": "Mistaken prior edit",
  "mechanical-supersede": "Mechanical supersede",
};

export function reasonLabel(key: string | null | undefined): string {
  const k = (key ?? "").trim();
  if (!k) return "(no reason)";
  return EVIDENCE_REASON_LABELS[k] ?? k;
}

// --- Response shapes ---------------------------------------------------------

export interface EvidenceProvenance {
  model: string | null;
  promptVersion: string | null;
  clusterRevision: string | null;
  surface: string | null;
}

// One distinct episode as returned by the evidence endpoint (already redacted
// server-side — never carries editor identity).
export interface EvidenceEpisode {
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
  // Truthful lifecycle/persistence: whether the change is still in effect.
  persisted?: boolean;
  supersededByEpisodeId?: string | null;
  supersedesEpisodeId: string | null;
  contradictsEpisodeId?: string | null;
  memberUrls: string[];
  memberOutlets: string[];
  headlines: string[];
  provenance: EvidenceProvenance | null;
  firstAt?: number | null;
  lastAt?: number | null;
}

export interface EvidenceCounts {
  rawActionCount: number;
  episodeCount: number;
  includedCount: number;
  excludedAmbiguousCount: number;
  excludedBySamplingCount: number;
  byAction: Record<string, number>;
  byReason: Record<string, number>;
  byOutcome: Record<string, number>;
  byLabel: Record<GroupingLabel, number>;
}

export interface EvidenceExcludedRef {
  episodeId: string;
  reason: string;
}

export interface EditorialEvidenceResponse {
  schemaVersion: string;
  scopeLabel: string | null;
  counts: EvidenceCounts;
  redactedFields: string[];
  episodes: EvidenceEpisode[];
  excludedAmbiguous: EvidenceExcludedRef[];
}

// Frozen legacy learned-rule inventory — the deprecated speculative rules kept
// for audit. NEVER approvable/enforceable; only dispositioned.
export type LegacyLearningStatus =
  | "frozen"
  | "archived"
  | "discarded"
  | "acknowledged";

export interface LegacyLearningItem {
  id: string;
  ruleType: string;
  label: string;
  status: LegacyLearningStatus;
  // Blast radius — what this frozen rule WOULD have affected, for context only.
  blastRadius: {
    affectedCount: number;
    distinctStoryCount: number;
    windowDays: number | null;
    basis: string | null;
  } | null;
  evidenceCount: number;
  createdAt: string | null;
  disposition: LegacyDisposition | null;
  dispositionedBy: string | null;
  dispositionedAt: string | null;
}

export type LegacyDisposition = "archive" | "discard" | "acknowledge";

export interface LegacyLearningResponse {
  items: LegacyLearningItem[];
}

export const LEGACY_RULE_TYPE_LABELS: Record<string, string> = {
  "outlet-behavior-flip": "Outlet behavior",
  "classification-relabel": "Standing relabel",
  "must-link": "Standing must-link",
  "irrelevance-suppression": "Irrelevance suppression",
  "scoring-cap": "Scoring cap",
  "scoring-boost": "Scoring boost",
};

export const LEGACY_DISPOSITION_LABELS: Record<LegacyDisposition, string> = {
  archive: "Archive",
  discard: "Discard",
  acknowledge: "Acknowledge",
};

// --- Explorer filter state + query-string builder ----------------------------

export type EvidenceScopeMode = "representative" | "full";

export interface EvidenceFilterState {
  // Date window (ms epoch), null = unbounded.
  since: number | null;
  until: number | null;
  families: EditorialActionFamily[];
  commentedOnly: boolean;
  // Combined unresolved/contradictory toggle.
  unresolvedOnly: boolean;
  scope: EvidenceScopeMode;
  // Representative sample cap per family when scope === "representative".
  representativeLimitPerFamily: number;
}

export const DEFAULT_EVIDENCE_FILTERS: EvidenceFilterState = {
  since: null,
  until: null,
  families: [],
  commentedOnly: false,
  unresolvedOnly: false,
  scope: "full",
  representativeLimitPerFamily: 5,
};

// Build the query-param object shared by the evidence + packet endpoints so the
// list and the copied Markdown packet describe the SAME filtered scope.
export function evidenceQueryParams(
  f: EvidenceFilterState,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.since != null) params.since = String(f.since);
  if (f.until != null) params.until = String(f.until);
  if (f.families.length) params.families = f.families.join(",");
  if (f.commentedOnly) params.commentedOnly = "true";
  if (f.unresolvedOnly) params.unresolvedOnly = "true";
  if (f.scope === "representative") {
    params.representativeLimitPerFamily = String(
      Math.max(1, f.representativeLimitPerFamily),
    );
  }
  return params;
}

// Serialize the params object into a query string (deterministic key order) for
// the packet fetch, which returns text/markdown rather than JSON.
export function evidenceQueryString(f: EvidenceFilterState): string {
  const params = evidenceQueryParams(f);
  const usp = new URLSearchParams();
  for (const k of Object.keys(params).sort()) usp.append(k, params[k]);
  const s = usp.toString();
  return s ? `?${s}` : "";
}

// Date-window presets (days back from now). null start = all time.
export const DATE_WINDOW_PRESETS: { key: string; label: string; days: number | null }[] = [
  { key: "all", label: "All time", days: null },
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
];
