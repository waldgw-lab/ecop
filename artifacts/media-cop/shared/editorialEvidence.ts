// =============================================================================
// Curated editorial-evidence contract (Task #1180, Step 1 + Step 8).
//
// This is the SINGLE PURE source of truth for turning manual Curated editor
// actions into trustworthy training EVIDENCE (never standing rules, never an
// auto-enforced model). Everything here is a pure, total, deterministic
// function over plain data — no DB, no clock, no I/O, no randomness — so it can
// be unit-tested exhaustively and reproduced byte-for-byte by the development
// agent that consumes the copied packet.
//
// It defines, per the task's "Done looks like":
//   - action families (priority / grouping-positive / grouping-negative /
//     supersede / undo / metadata),
//   - the EXACT priority + cluster reason vocabularies from the task,
//   - reason validation keyed to the action's family,
//   - normalization of URL / outlet / story / member identity,
//   - episode key + collapse semantics (rapid retries and follow-up score edits
//     collapse into ONE episode WHILE a contradictory-direction edit forces a
//     NEW episode),
//   - grouping-label semantics (positive labels ONLY from link/merge; negative
//     labels ONLY from evict/move/unlink/undo AND ONLY when the editor
//     explicitly flags an incorrect grouping — evolution / cleanup / union /
//     mechanical supersede are recorded but NEVER a rejection),
//   - lifecycle outcome types,
//   - deterministic filtering + a redacted Markdown packet + a compact
//     machine-readable JSON packet, with schema version, filters, raw-vs-episode
//     counts, action/reason breakdowns, before/requested/actual, lineage,
//     provenance, source URLs/headlines, and conservative exclusions.
//
// Redaction contract (task): the packet MUST exclude editor identity,
// credentials / session / private keys, and ambiguous/unverified episodes by
// default — and report the excluded counts separately.
//
// Identity re-use: URL identity delegates to the ONE canonical curated URL
// identity token (server/urlIdentity) via a caller-supplied normalizer so the
// packet can never drift from the clustering lane; a safe built-in fallback is
// provided for pure use / tests.
// =============================================================================

// ---------------------------------------------------------------------------
// Schema version — bump when the JSON packet shape changes so a consuming
// agent can detect and adapt to format drift.
// ---------------------------------------------------------------------------
export const EDITORIAL_EVIDENCE_SCHEMA_VERSION = "1.0.0";

// ===========================================================================
// 1. Action families
// ===========================================================================
// The manual Curated actions an editor can take. Each maps to exactly one
// family, and the family decides which reason vocabulary is valid and whether
// the action can ever produce a positive/negative grouping label.

export type EditorialActionKind =
  | "priority-adjust" // change a story's P-score / ranking intent (incl. pins)
  | "hide" // hide / suppress a story from the curated surface
  | "classify" // change topic / focus classification
  | "content-kind" // change content-kind (article/video/opinion/...)
  | "headline" // override headline text
  | "image" // override lead image
  | "link" // manually link two standalone items (positive same-event)
  | "merge" // manually merge two+ stories (positive grouping)
  | "move" // move a member from one story to another
  | "evict" // remove a member from a story
  | "unlink" // undo a link/merge grouping
  | "undo"; // undo a prior editorial episode

// The five behavioral families a kind can belong to.
export type EditorialActionFamily =
  | "priority" // ranking / preference evidence
  | "grouping-positive" // explicit same-event / correct-grouping evidence
  | "grouping-negative" // POTENTIAL incorrect-grouping evidence (see labels)
  | "metadata" // classification / content-kind / headline / image
  | "lineage"; // undo / supersede — never itself a positive/negative label

export const ACTION_FAMILY: Record<EditorialActionKind, EditorialActionFamily> = {
  "priority-adjust": "priority",
  hide: "priority",
  classify: "metadata",
  "content-kind": "metadata",
  headline: "metadata",
  image: "metadata",
  link: "grouping-positive",
  merge: "grouping-positive",
  move: "grouping-negative",
  evict: "grouping-negative",
  unlink: "grouping-negative",
  undo: "lineage",
};

export function actionFamily(kind: EditorialActionKind): EditorialActionFamily {
  return ACTION_FAMILY[kind];
}

// A "priority direction" is used for episode-collapse: two priority edits in
// the SAME direction (both up, both down, both hide) collapse into one episode;
// opposite directions are CONTRADICTORY and force a new episode.
export type PriorityDirection = "up" | "down" | "hide" | "unhide" | "none";

// ===========================================================================
// 2. Reason vocabularies (EXACT wording from the task)
// ===========================================================================

export interface ReasonOption {
  key: string;
  label: string;
}

// --- Priority reasons -------------------------------------------------------
// Task: "Priority reasons distinguish direct U.S./allied consequence,
// leadership/watch interest, operational/readiness impact, imminence/freshness,
// novelty, comparative ranking, aftermath/downstream effects, decay error, and
// other."
export const PRIORITY_REASONS: ReasonOption[] = [
  { key: "us-allied-consequence", label: "Direct U.S./allied consequence" },
  { key: "leadership-watch-interest", label: "Leadership / watch interest" },
  { key: "operational-readiness-impact", label: "Operational / readiness impact" },
  { key: "imminence-freshness", label: "Imminence / freshness" },
  { key: "novelty", label: "Novelty" },
  { key: "comparative-ranking", label: "Comparative ranking" },
  { key: "aftermath-downstream", label: "Aftermath / downstream effects" },
  { key: "decay-error", label: "Decay error" },
  { key: "other", label: "Other" },
];

export const PRIORITY_REASON_KEYS: ReadonlySet<string> = new Set(
  PRIORITY_REASONS.map((r) => r.key),
);

// --- Cluster (grouping) reasons --------------------------------------------
// Task: "Cluster reasons distinguish same event/process, different
// incident/action/phase/time/location, downstream consequence, story
// evolution, mistaken prior edit, and mechanical supersede."
export const CLUSTER_REASONS: ReasonOption[] = [
  { key: "same-event-process", label: "Same event / process" },
  { key: "different-incident", label: "Different incident / action" },
  { key: "different-phase-time-location", label: "Different phase / time / location" },
  { key: "downstream-consequence", label: "Downstream consequence" },
  { key: "story-evolution", label: "Story evolution" },
  { key: "mistaken-prior-edit", label: "Mistaken prior edit" },
  { key: "mechanical-supersede", label: "Mechanical supersede" },
];

export const CLUSTER_REASON_KEYS: ReadonlySet<string> = new Set(
  CLUSTER_REASONS.map((r) => r.key),
);

// The cluster reasons that count as the editor EXPLICITLY flagging an INCORRECT
// grouping. Only these turn a negative-family action (evict/move/unlink/undo)
// into a negative grouping label. "same-event-process" is positive; the rest
// (story evolution, downstream consequence, mechanical supersede, mistaken
// prior edit) are lineage/evolution — recorded, never a rejection label.
export const INCORRECT_GROUPING_REASON_KEYS: ReadonlySet<string> = new Set([
  "different-incident",
  "different-phase-time-location",
]);

// The single positive same-event reason.
export const SAME_EVENT_REASON_KEY = "same-event-process";

// ===========================================================================
// 3. Reason validation
// ===========================================================================
// Which vocabulary applies to an action kind. Metadata/hide actions do not
// require a taxonomy reason (they carry an optional free note only); priority
// actions use PRIORITY_REASONS; grouping/lineage actions use CLUSTER_REASONS.

export function reasonVocabularyForKind(
  kind: EditorialActionKind,
): ReadonlySet<string> | null {
  const fam = actionFamily(kind);
  if (fam === "priority") {
    // priority-adjust uses the priority vocab; hide carries a free note only.
    return kind === "priority-adjust" ? PRIORITY_REASON_KEYS : null;
  }
  if (
    fam === "grouping-positive" ||
    fam === "grouping-negative" ||
    fam === "lineage"
  ) {
    return CLUSTER_REASON_KEYS;
  }
  return null; // metadata: no controlled reason required
}

export interface ReasonValidation {
  valid: boolean;
  /** Present when invalid. */
  error?: string;
  /** Whether a reason is required for this action kind at all. */
  required: boolean;
}

// Validate a reason key against the vocabulary an action kind requires.
// A null/empty reason is valid ONLY for kinds that do not require one.
export function validateReason(
  kind: EditorialActionKind,
  reasonKey: string | null | undefined,
): ReasonValidation {
  const vocab = reasonVocabularyForKind(kind);
  const raw = (reasonKey ?? "").trim();
  if (!vocab) {
    // No controlled vocabulary — any/none is acceptable.
    return { valid: true, required: false };
  }
  if (!raw) {
    return {
      valid: false,
      required: true,
      error: `Action "${kind}" requires a reason from its vocabulary`,
    };
  }
  if (!vocab.has(raw)) {
    return {
      valid: false,
      required: true,
      error: `Reason "${raw}" is not valid for action "${kind}"`,
    };
  }
  return { valid: true, required: true };
}

// ===========================================================================
// 4. Identity normalization (URL / outlet / story / member)
// ===========================================================================
// URL identity delegates to the ONE canonical curated token. Callers pass the
// canonical server/urlIdentity.normalizeIdentityUrl so the packet can never
// drift from the clustering lane; the built-in fallback is a safe subset used
// in pure/test contexts.

export type UrlNormalizer = (u: string | null | undefined) => string;

// Safe fallback URL identity — drops fragment, drops utm_*/at_*/ns_* tracking
// prefixes, sorts kept params, strips trailing slash, lowercases. Mirrors the
// canonical token's behavior for the common cases; prefer injecting the real
// normalizer via the packet options.
export function fallbackNormalizeUrl(u: string | null | undefined): string {
  const raw = (u ?? "").trim();
  if (!raw) return "";
  const hashIdx = raw.indexOf("#");
  const noHash = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const qIdx = noHash.indexOf("?");
  let base = (qIdx >= 0 ? noHash.slice(0, qIdx) : noHash).replace(/\/+$/, "");
  if (qIdx >= 0) {
    const kept = noHash
      .slice(qIdx + 1)
      .split("&")
      .filter((pair) => pair.length > 0)
      .filter((pair) => {
        const k = pair.split("=")[0].toLowerCase();
        return !(
          k.startsWith("utm_") ||
          k.startsWith("at_") ||
          k.startsWith("ns_") ||
          k === "fbclid" ||
          k === "gclid"
        );
      });
    if (kept.length) {
      kept.sort();
      base = base + "?" + kept.join("&");
    }
  }
  return base.toLowerCase();
}

// Normalize an outlet/source display name into a stable identity token. Pure
// subset of shared/outletRegistry.normalizeOutletName (kept local so this
// module stays dependency-free and testable in isolation).
export function normalizeOutletIdentity(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).toLowerCase().trim();
  s = s.replace(/\s*\((?:dm|x|twitter|truth social)\)\s*/g, " ");
  s = s.replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  s = s.replace(/\s+/g, " ");
  s = s.replace(/^the\s+/, "");
  return s.trim();
}

// Normalize a story identity. Curated stories are identified primarily by their
// clusterId; a standalone item is identified by its normalized member URL. The
// returned token is stable across the two curated entry paths.
export function normalizeStoryIdentity(
  input: { clusterId?: string | null; primaryUrl?: string | null },
  normalizeUrl: UrlNormalizer = fallbackNormalizeUrl,
): string {
  const cid = (input.clusterId ?? "").trim().toLowerCase();
  if (cid) return `cluster:${cid}`;
  const url = normalizeUrl(input.primaryUrl);
  if (url) return `url:${url}`;
  return "";
}

// Normalize a single member (article) identity from its URL.
export function normalizeMemberIdentity(
  url: string | null | undefined,
  normalizeUrl: UrlNormalizer = fallbackNormalizeUrl,
): string {
  return normalizeUrl(url);
}

// ===========================================================================
// 5. Raw editorial actions + episode collapse semantics
// ===========================================================================
// A RawEditorialAction is the immutable audit-derived shape fed in. Episode
// collapse groups rapid retries and follow-up score edits into ONE episode
// WITHOUT deleting raw rows — WHILE a contradictory-direction edit separates
// into a new episode.

export interface RawEditorialAction {
  /** Stable id of the immutable audit row. */
  id: string;
  kind: EditorialActionKind;
  /** Epoch millis of the action (caller-supplied; module never reads a clock). */
  at: number;
  /** Actor id — used ONLY for episode grouping; NEVER emitted in the packet. */
  editorId?: string | null;
  /** Normalized-or-raw story identity handle. */
  clusterId?: string | null;
  primaryUrl?: string | null;
  /** Controlled reason key (validated against the kind's vocabulary). */
  reasonKey?: string | null;
  /** Optional free-text note (redacted-safe: emitted verbatim, so callers
   *  must not place secrets here; see SENSITIVE_NOTE_PATTERNS scrubbing). */
  note?: string | null;
  /** Before / requested priority snapshot (for priority direction + evidence). */
  beforeScore?: number | null;
  requestedScore?: number | null;
  actualScore?: number | null;
  /** Members involved (URLs) and their outlets, for grouping evidence. */
  memberUrls?: string[];
  memberOutlets?: string[];
  headlines?: string[];
  /** Provenance visible at decision time. */
  provenance?: EditorialProvenance | null;
  /** Observed lifecycle outcome (set by the outcome observer). */
  outcome?: LifecycleOutcome | null;
  /** Whether an outcome observation has verified this action landed+persisted. */
  verified?: boolean | null;
  /** Editor explicitly flagged the grouping as incorrect (drives neg. labels). */
  explicitIncorrectGrouping?: boolean | null;
  /** Id of the earlier episode this action supersedes/undoes (lineage). */
  supersedesEpisodeId?: string | null;
}

export interface EditorialProvenance {
  model?: string | null;
  promptVersion?: string | null;
  clusterRevision?: string | null;
  /** The editor surface that initiated the action (e.g. "curated-detail"). */
  surface?: string | null;
}

// Lifecycle outcomes (task: requested, persisted, applied, deferred,
// conflicted, dormant/no-op, superseded, undone, failed).
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

export const LIFECYCLE_OUTCOMES: readonly LifecycleOutcome[] = [
  "requested",
  "persisted",
  "applied",
  "deferred",
  "conflicted",
  "dormant",
  "superseded",
  "undone",
  "failed",
];

// Rapid-repeat window: retries/follow-up score edits within this window on the
// same target+editor+direction collapse into one episode.
export const EPISODE_COLLAPSE_WINDOW_MS = 5 * 60 * 1000;

// Compute the priority direction for an action (for collapse contradiction).
export function priorityDirection(a: RawEditorialAction): PriorityDirection {
  if (a.kind === "hide") return "hide";
  if (a.kind !== "priority-adjust") return "none";
  const before = a.beforeScore ?? null;
  const requested = a.requestedScore ?? null;
  if (before == null || requested == null) return "none";
  if (requested > before) return "up";
  if (requested < before) return "down";
  return "none";
}

// The episode-collapse KEY: same editor, same normalized story, same action
// family. Direction is intentionally EXCLUDED from the key so contradictory
// directions land in the same key bucket and can then be SPLIT by the collapse
// pass (see collapseEpisodes) — this is how "rapid retries collapse WHILE
// contradictory direction separates" is realized deterministically.
export function episodeKey(
  a: RawEditorialAction,
  normalizeUrl: UrlNormalizer = fallbackNormalizeUrl,
): string {
  const story = normalizeStoryIdentity(
    { clusterId: a.clusterId, primaryUrl: a.primaryUrl },
    normalizeUrl,
  );
  return `${story}|${actionFamily(a.kind)}`;
}

export interface EditorialEpisode {
  episodeId: string;
  key: string;
  family: EditorialActionFamily;
  /** Representative (latest) action kind driving the episode. */
  kind: EditorialActionKind;
  editorId?: string | null;
  clusterId?: string | null;
  primaryUrl?: string | null;
  storyIdentity: string;
  /** Every raw action id collapsed into this episode (raw rows never deleted). */
  rawActionIds: string[];
  /** The count of raw actions collapsed (>=1). */
  rawCount: number;
  reasonKey?: string | null;
  note?: string | null;
  direction: PriorityDirection;
  firstAt: number;
  lastAt: number;
  beforeScore?: number | null;
  requestedScore?: number | null;
  actualScore?: number | null;
  memberUrls: string[];
  memberOutlets: string[];
  headlines: string[];
  provenance?: EditorialProvenance | null;
  outcome: LifecycleOutcome;
  verified: boolean;
  explicitIncorrectGrouping: boolean;
  supersedesEpisodeId?: string | null;
}

// Collapse raw actions into distinct episodes.
//   - Deterministic: input is sorted by (at, id) before grouping.
//   - Rapid retries / follow-up score edits within EPISODE_COLLAPSE_WINDOW_MS
//     on the same key + same direction collapse into ONE episode.
//   - A CONTRADICTORY direction (up vs down, or hide vs unhide) starts a NEW
//     episode even inside the window.
//   - Crossing the window also starts a new episode.
//   - Raw ids are always retained on the episode (nothing is deleted).
export function collapseEpisodes(
  actions: RawEditorialAction[],
  normalizeUrl: UrlNormalizer = fallbackNormalizeUrl,
): EditorialEpisode[] {
  const sorted = [...actions].sort((x, y) => x.at - y.at || cmp(x.id, y.id));
  // Per-key list of open episodes (we always extend the most recent open one).
  const byKey = new Map<string, EditorialEpisode[]>();
  const order: EditorialEpisode[] = [];

  for (const a of sorted) {
    const key = episodeKey(a, normalizeUrl);
    const dir = priorityDirection(a);
    const list = byKey.get(key) ?? [];
    const open = list.length ? list[list.length - 1] : null;

    const withinWindow = open != null && a.at - open.lastAt <= EPISODE_COLLAPSE_WINDOW_MS;
    const contradictory = open != null && isContradictoryDirection(open.direction, dir);

    if (open && withinWindow && !contradictory) {
      extendEpisode(open, a);
    } else {
      const ep = newEpisode(a, key, dir, normalizeUrl);
      list.push(ep);
      byKey.set(key, list);
      order.push(ep);
    }
  }

  // Emit in first-seen order for determinism.
  return order;
}

function isContradictoryDirection(a: PriorityDirection, b: PriorityDirection): boolean {
  if (a === "none" || b === "none") return false;
  if (a === b) return false;
  const pair = new Set([a, b]);
  if (pair.has("up") && pair.has("down")) return true;
  if (pair.has("hide") && pair.has("unhide")) return true;
  // up-vs-hide / down-vs-hide etc. are also contradictory (different intent).
  return true;
}

function newEpisode(
  a: RawEditorialAction,
  key: string,
  dir: PriorityDirection,
  normalizeUrl: UrlNormalizer,
): EditorialEpisode {
  const storyIdentity = normalizeStoryIdentity(
    { clusterId: a.clusterId, primaryUrl: a.primaryUrl },
    normalizeUrl,
  );
  return {
    episodeId: `ep:${a.id}`,
    key,
    family: actionFamily(a.kind),
    kind: a.kind,
    editorId: a.editorId ?? null,
    clusterId: a.clusterId ?? null,
    primaryUrl: a.primaryUrl ?? null,
    storyIdentity,
    rawActionIds: [a.id],
    rawCount: 1,
    reasonKey: a.reasonKey ?? null,
    note: a.note ?? null,
    direction: dir,
    firstAt: a.at,
    lastAt: a.at,
    beforeScore: a.beforeScore ?? null,
    requestedScore: a.requestedScore ?? null,
    actualScore: a.actualScore ?? null,
    memberUrls: dedupe((a.memberUrls ?? []).map((u) => normalizeUrl(u)).filter(Boolean)),
    memberOutlets: dedupe(
      (a.memberOutlets ?? []).map((o) => normalizeOutletIdentity(o)).filter(Boolean),
    ),
    headlines: dedupe((a.headlines ?? []).map((h) => (h ?? "").trim()).filter(Boolean)),
    provenance: a.provenance ?? null,
    outcome: a.outcome ?? "requested",
    verified: !!a.verified,
    explicitIncorrectGrouping: !!a.explicitIncorrectGrouping,
    supersedesEpisodeId: a.supersedesEpisodeId ?? null,
  };
}

function extendEpisode(ep: EditorialEpisode, a: RawEditorialAction): void {
  ep.rawActionIds.push(a.id);
  ep.rawCount = ep.rawActionIds.length;
  ep.lastAt = a.at;
  // Later action wins for the requested/representative fields (it's the intent
  // the editor ultimately settled on within the burst).
  ep.kind = a.kind;
  if (a.reasonKey != null) ep.reasonKey = a.reasonKey;
  if (a.note != null && a.note.trim()) ep.note = a.note;
  if (a.requestedScore != null) ep.requestedScore = a.requestedScore;
  if (a.actualScore != null) ep.actualScore = a.actualScore;
  // beforeScore stays the FIRST observed before-state of the burst.
  if (a.provenance) ep.provenance = a.provenance;
  if (a.outcome) ep.outcome = a.outcome;
  ep.verified = ep.verified || !!a.verified;
  ep.explicitIncorrectGrouping =
    ep.explicitIncorrectGrouping || !!a.explicitIncorrectGrouping;
  if (a.supersedesEpisodeId) ep.supersedesEpisodeId = a.supersedesEpisodeId;
  const nu = (u: string) => u; // already-normalized values are re-merged as-is
  ep.memberUrls = dedupe([...ep.memberUrls, ...(a.memberUrls ?? []).map(fallbackNormalizeUrl)].map(nu).filter(Boolean));
  ep.memberOutlets = dedupe([
    ...ep.memberOutlets,
    ...(a.memberOutlets ?? []).map(normalizeOutletIdentity),
  ].filter(Boolean));
  ep.headlines = dedupe([...ep.headlines, ...((a.headlines ?? []).map((h) => (h ?? "").trim()))].filter(Boolean));
}

// ===========================================================================
// 6. Grouping label semantics
// ===========================================================================
// Positive labels come ONLY from grouping-positive actions (link/merge).
// Negative labels come ONLY from grouping-negative actions (evict/move/unlink/
// undo) AND ONLY when the editor explicitly flagged an incorrect grouping
// (explicitIncorrectGrouping true, OR an INCORRECT_GROUPING_REASON_KEYS reason).
// Story evolution / downstream consequence / mechanical supersede / mistaken
// prior edit / cleanup are recorded as "lineage" — never a rejection.

export type GroupingLabel = "positive" | "negative" | "lineage" | "none";

export function groupingLabel(ep: EditorialEpisode): GroupingLabel {
  const fam = ep.family;
  if (fam === "grouping-positive") return "positive";
  if (fam === "grouping-negative" || fam === "lineage") {
    const reasonIsIncorrect =
      ep.reasonKey != null && INCORRECT_GROUPING_REASON_KEYS.has(ep.reasonKey);
    if (ep.explicitIncorrectGrouping || reasonIsIncorrect) return "negative";
    return "lineage";
  }
  return "none";
}

// ===========================================================================
// 7. Redaction
// ===========================================================================
// Fields that must NEVER appear in the packet, plus a note scrubber that strips
// anything resembling a credential / session token / private key.

export const REDACTED_FIELDS: readonly string[] = [
  "editorId",
  "editor",
  "editorEmail",
  "sessionId",
  "session",
  "cookie",
  "authorization",
  "apiKey",
  "privateKey",
  "password",
  "token",
];

// Patterns that mark a note as containing a secret; the whole note is redacted
// (replaced) when any matches. Conservative: err toward redacting.
const SENSITIVE_NOTE_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/, // API-key style tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/i, // bearer tokens
  /\b[A-Za-z0-9]{32,}\b/, // long opaque secrets/hashes
  /\bpassword\b\s*[:=]/i,
  /\bsession[_-]?id\b\s*[:=]/i,
];

export function redactNote(note: string | null | undefined): string | null {
  const n = (note ?? "").trim();
  if (!n) return null;
  for (const re of SENSITIVE_NOTE_PATTERNS) {
    if (re.test(n)) return "[redacted]";
  }
  return n;
}

// ===========================================================================
// 8. Filtering
// ===========================================================================

export interface EvidenceFilters {
  /** Inclusive epoch-millis window start (scope reset time). */
  since?: number | null;
  /** Inclusive epoch-millis window end. */
  until?: number | null;
  /** Restrict to these action families. */
  families?: EditorialActionFamily[] | null;
  /** Only episodes carrying an editor note. */
  commentedOnly?: boolean;
  /** Only unresolved/contradictory (conflicted/deferred/failed/dormant). */
  unresolvedOnly?: boolean;
  /** Representative sampling cap per family (0/undefined = full evidence). */
  representativeLimitPerFamily?: number | null;
}

const UNRESOLVED_OUTCOMES: ReadonlySet<LifecycleOutcome> = new Set<LifecycleOutcome>([
  "conflicted",
  "deferred",
  "failed",
  "dormant",
]);

// Determine whether an episode is included by the non-verification filters.
function passesFilters(ep: EditorialEpisode, f: EvidenceFilters): boolean {
  if (f.since != null && ep.lastAt < f.since) return false;
  if (f.until != null && ep.firstAt > f.until) return false;
  if (f.families && f.families.length && !f.families.includes(ep.family)) return false;
  if (f.commentedOnly && !(ep.note && ep.note.trim())) return false;
  if (f.unresolvedOnly && !UNRESOLVED_OUTCOMES.has(ep.outcome)) return false;
  return true;
}

// An episode is "ambiguous/unverified" (excluded by default) when it has not
// been outcome-verified, or landed in a non-committal lifecycle state.
export function isAmbiguousOrUnverified(ep: EditorialEpisode): boolean {
  if (!ep.verified) return true;
  if (ep.outcome === "conflicted" || ep.outcome === "dormant" || ep.outcome === "failed") {
    return true;
  }
  return false;
}

export interface FilterResult {
  included: EditorialEpisode[];
  /** Episodes excluded because ambiguous/unverified (reported, not dropped). */
  excludedAmbiguous: EditorialEpisode[];
  /** Episodes excluded by representative sampling (still counted). */
  excludedBySampling: EditorialEpisode[];
}

// Apply filters + the default ambiguous/unverified exclusion + representative
// sampling. Deterministic ordering throughout.
export function filterEpisodes(
  episodes: EditorialEpisode[],
  filters: EvidenceFilters = {},
): FilterResult {
  const inWindow = episodes
    .filter((ep) => passesFilters(ep, filters))
    .sort((a, b) => a.firstAt - b.firstAt || cmp(a.episodeId, b.episodeId));

  const verified: EditorialEpisode[] = [];
  const excludedAmbiguous: EditorialEpisode[] = [];
  for (const ep of inWindow) {
    if (isAmbiguousOrUnverified(ep)) excludedAmbiguous.push(ep);
    else verified.push(ep);
  }

  // Representative sampling: keep the first N per family (deterministic order).
  const limit = filters.representativeLimitPerFamily ?? 0;
  if (!limit || limit <= 0) {
    return { included: verified, excludedAmbiguous, excludedBySampling: [] };
  }
  const perFamily = new Map<EditorialActionFamily, number>();
  const included: EditorialEpisode[] = [];
  const excludedBySampling: EditorialEpisode[] = [];
  for (const ep of verified) {
    const n = perFamily.get(ep.family) ?? 0;
    if (n < limit) {
      included.push(ep);
      perFamily.set(ep.family, n + 1);
    } else {
      excludedBySampling.push(ep);
    }
  }
  return { included, excludedAmbiguous, excludedBySampling };
}

// ===========================================================================
// 9. Breakdowns / counts
// ===========================================================================

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

export function computeCounts(
  allEpisodes: EditorialEpisode[],
  result: FilterResult,
): EvidenceCounts {
  const byAction: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  const byLabel: Record<GroupingLabel, number> = {
    positive: 0,
    negative: 0,
    lineage: 0,
    none: 0,
  };
  let rawActionCount = 0;
  for (const ep of result.included) {
    rawActionCount += ep.rawCount;
    byAction[ep.kind] = (byAction[ep.kind] ?? 0) + 1;
    const rk = ep.reasonKey ?? "(none)";
    byReason[rk] = (byReason[rk] ?? 0) + 1;
    byOutcome[ep.outcome] = (byOutcome[ep.outcome] ?? 0) + 1;
    byLabel[groupingLabel(ep)] += 1;
  }
  return {
    rawActionCount,
    episodeCount: allEpisodes.length,
    includedCount: result.included.length,
    excludedAmbiguousCount: result.excludedAmbiguous.length,
    excludedBySamplingCount: result.excludedBySampling.length,
    byAction,
    byReason,
    byOutcome,
    byLabel,
  };
}

// ===========================================================================
// 10. Packet generation (redacted Markdown + compact JSON)
// ===========================================================================

export interface PacketOptions {
  filters?: EvidenceFilters;
  /** Human-readable reset/scope description (e.g. an ISO time string). */
  scopeLabel?: string;
  /** Canonical URL normalizer (inject server/urlIdentity to avoid drift). */
  normalizeUrl?: UrlNormalizer;
}

// A single episode as it appears in the JSON packet — already redacted.
export interface PacketEpisode {
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
  memberUrls: string[];
  memberOutlets: string[];
  headlines: string[];
  provenance: EditorialProvenance | null;
  supersedesEpisodeId: string | null;
}

export interface EvidenceJsonPacket {
  schemaVersion: string;
  scopeLabel: string | null;
  filters: EvidenceFilters;
  counts: EvidenceCounts;
  redactedFields: string[];
  episodes: PacketEpisode[];
  /** Excluded ambiguous/unverified — ids + reason only, never full data. */
  excludedAmbiguous: { episodeId: string; reason: string }[];
}

// Strip all redacted fields from a provenance object (defensive — provenance
// should never carry them, but we enforce it).
function safeProvenance(p: EditorialProvenance | null | undefined): EditorialProvenance | null {
  if (!p) return null;
  return {
    model: p.model ?? null,
    promptVersion: p.promptVersion ?? null,
    clusterRevision: p.clusterRevision ?? null,
    surface: p.surface ?? null,
  };
}

function toPacketEpisode(ep: EditorialEpisode): PacketEpisode {
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
    memberUrls: ep.memberUrls,
    memberOutlets: ep.memberOutlets,
    headlines: ep.headlines,
    provenance: safeProvenance(ep.provenance),
    supersedesEpisodeId: ep.supersedesEpisodeId ?? null,
  };
}

// Build the machine-readable JSON packet. NEVER emits editor identity or any
// redacted field. Ambiguous/unverified episodes are reported as counts + ids
// only. Deterministic given identical input.
export function buildJsonPacket(
  episodes: EditorialEpisode[],
  options: PacketOptions = {},
): EvidenceJsonPacket {
  const filters = options.filters ?? {};
  const result = filterEpisodes(episodes, filters);
  const counts = computeCounts(episodes, result);
  return {
    schemaVersion: EDITORIAL_EVIDENCE_SCHEMA_VERSION,
    scopeLabel: options.scopeLabel ?? null,
    filters,
    counts,
    redactedFields: [...REDACTED_FIELDS],
    episodes: result.included.map(toPacketEpisode),
    excludedAmbiguous: result.excludedAmbiguous.map((ep) => ({
      episodeId: ep.episodeId,
      reason: !ep.verified ? "unverified" : `outcome:${ep.outcome}`,
    })),
  };
}

// Build the redacted human-readable Markdown packet. Wraps the compact JSON in
// a fenced block at the end so the development agent can parse it directly.
export function buildMarkdownPacket(
  episodes: EditorialEpisode[],
  options: PacketOptions = {},
): string {
  const packet = buildJsonPacket(episodes, options);
  const c = packet.counts;
  const lines: string[] = [];

  lines.push(`# Curated Adjustments — evidence packet`);
  lines.push("");
  lines.push(`- Schema version: \`${packet.schemaVersion}\``);
  lines.push(`- Scope: ${packet.scopeLabel ?? "(all captured evidence)"}`);
  lines.push(`- Raw actions (in included episodes): **${c.rawActionCount}**`);
  lines.push(`- Distinct episodes: **${c.episodeCount}**`);
  lines.push(`- Included (verified) episodes: **${c.includedCount}**`);
  lines.push(
    `- Excluded ambiguous/unverified: **${c.excludedAmbiguousCount}** (reported, not learned)`,
  );
  if (c.excludedBySamplingCount > 0) {
    lines.push(`- Excluded by representative sampling: **${c.excludedBySamplingCount}**`);
  }
  lines.push("");
  lines.push(`> Editor identity, credentials, session and private keys are excluded by contract.`);
  lines.push("");

  lines.push(`## Action breakdown`);
  for (const k of Object.keys(c.byAction).sort()) {
    lines.push(`- \`${k}\`: ${c.byAction[k]}`);
  }
  lines.push("");
  lines.push(`## Reason breakdown`);
  for (const k of Object.keys(c.byReason).sort()) {
    lines.push(`- \`${k}\`: ${c.byReason[k]}`);
  }
  lines.push("");
  lines.push(`## Grouping labels`);
  lines.push(`- positive: ${c.byLabel.positive}`);
  lines.push(`- negative (explicit incorrect grouping): ${c.byLabel.negative}`);
  lines.push(`- lineage (evolution/supersede/undo, NOT a rejection): ${c.byLabel.lineage}`);
  lines.push("");
  lines.push(`## Outcome breakdown`);
  for (const k of Object.keys(c.byOutcome).sort()) {
    lines.push(`- \`${k}\`: ${c.byOutcome[k]}`);
  }
  lines.push("");

  lines.push(`## Episodes`);
  for (const ep of packet.episodes) {
    lines.push(`### ${ep.episodeId} — \`${ep.action}\` (${ep.label})`);
    lines.push(`- Story: \`${ep.story}\``);
    lines.push(`- Reason: ${ep.reason ? `\`${ep.reason}\`` : "(none)"}`);
    if (ep.note) lines.push(`- Note: ${ep.note}`);
    if (ep.family === "priority") {
      lines.push(
        `- Score before/requested/actual: ${fmtNum(ep.before)} → ${fmtNum(ep.requested)} → ${fmtNum(ep.actual)} (${ep.direction})`,
      );
    }
    lines.push(`- Outcome: \`${ep.outcome}\` (verified: ${ep.verified})`);
    lines.push(`- Collapsed raw actions: ${ep.rawCount}`);
    if (ep.supersedesEpisodeId) {
      lines.push(`- Supersedes/undoes: \`${ep.supersedesEpisodeId}\``);
    }
    if (ep.memberOutlets.length) {
      lines.push(`- Outlets: ${ep.memberOutlets.map((o) => `\`${o}\``).join(", ")}`);
    }
    if (ep.headlines.length) {
      lines.push(`- Headlines:`);
      for (const h of ep.headlines) lines.push(`  - ${h}`);
    }
    if (ep.memberUrls.length) {
      lines.push(`- URLs:`);
      for (const u of ep.memberUrls) lines.push(`  - ${u}`);
    }
    if (ep.provenance) {
      const p = ep.provenance;
      lines.push(
        `- Provenance: model=${p.model ?? "-"} prompt=${p.promptVersion ?? "-"} clusterRev=${p.clusterRevision ?? "-"} surface=${p.surface ?? "-"}`,
      );
    }
    lines.push("");
  }

  if (packet.excludedAmbiguous.length) {
    lines.push(`## Excluded ambiguous/unverified (reported only)`);
    for (const e of packet.excludedAmbiguous) {
      lines.push(`- \`${e.episodeId}\`: ${e.reason}`);
    }
    lines.push("");
  }

  lines.push(`## Machine-readable packet`);
  lines.push("```json");
  lines.push(stableStringify(packet));
  lines.push("```");

  return lines.join("\n");
}

// ===========================================================================
// Helpers
// ===========================================================================

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function fmtNum(n: number | null): string {
  return n == null ? "-" : String(n);
}

// Deterministic JSON stringify with sorted object keys so the emitted packet is
// byte-for-byte reproducible regardless of input insertion order.
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = sortKeysDeep(obj[k]);
    }
    return out;
  }
  return value;
}
