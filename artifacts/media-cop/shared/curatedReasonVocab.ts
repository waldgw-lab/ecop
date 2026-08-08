// =============================================================================
// Curated lane — shared reason vocabulary for editor override annotations.
//
// Two small, controlled sets of pretyped reasons — one for cluster/grouping
// actions, one for P-score adjustments. These aliases intentionally mirror the
// editorial-evidence contract so capture, display, and copied packets cannot
// drift onto different semantic vocabularies.
//
// Rules:
//  - Keys are short lowercase-hyphenated strings (stable DB values).
//  - Labels are human-readable for display.
//  - Adding a new key is always safe; removing one makes existing DB rows
//    display an unknown key (fall back to raw key text on the client).
// =============================================================================

export interface ReasonOption {
  key: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Reasons for manual link / merge actions
// ---------------------------------------------------------------------------
export const LINK_MERGE_REASONS: ReasonOption[] = [
  { key: "same-event-process", label: "Same event / process" },
  { key: "different-incident", label: "Different incident / action" },
  { key: "different-phase-time-location", label: "Different phase / time / location" },
  { key: "downstream-consequence", label: "Downstream consequence" },
  { key: "story-evolution", label: "Story evolution" },
  { key: "mistaken-prior-edit", label: "Mistaken prior edit" },
  { key: "mechanical-supersede", label: "Mechanical supersede" },
];

export const LINK_MERGE_REASON_KEYS = new Set(LINK_MERGE_REASONS.map((r) => r.key));

// ---------------------------------------------------------------------------
// Reasons for P-score (priority) adjustments
// ---------------------------------------------------------------------------
export const SCORE_ADJUST_REASONS: ReasonOption[] = [
  { key: "us-allied-consequence", label: "Direct U.S. / allied consequence" },
  { key: "leadership-watch-interest", label: "Leadership / watch interest" },
  { key: "operational-readiness-impact", label: "Operational / readiness impact" },
  { key: "imminence-freshness", label: "Imminence / freshness" },
  { key: "novelty", label: "Novelty" },
  { key: "comparative-ranking", label: "Comparative ranking" },
  { key: "aftermath-downstream", label: "Aftermath / downstream effects" },
  { key: "decay-error", label: "Decay error" },
  { key: "other", label: "Other" },
];

export const SCORE_ADJUST_REASON_KEYS = new Set(SCORE_ADJUST_REASONS.map((r) => r.key));

// ---------------------------------------------------------------------------
// Reasons for Live Watch alert moderation
// ---------------------------------------------------------------------------
export const LIVE_ALERT_REASONS: ReasonOption[] = [
  { key: "irrelevant-alert", label: "Irrelevant / false alert" },
  { key: "wrong-leader", label: "Wrong leader" },
  { key: "wrong-status", label: "Wrong live status" },
  { key: "wrong-title", label: "Inaccurate title" },
  { key: "bad-watch-link", label: "Bad Watch link" },
  { key: "wrong-timing", label: "Wrong event timing" },
  { key: "other-live-alert", label: "Other Live Watch issue" },
];

export const LIVE_ALERT_REASON_KEYS = new Set(LIVE_ALERT_REASONS.map((r) => r.key));
