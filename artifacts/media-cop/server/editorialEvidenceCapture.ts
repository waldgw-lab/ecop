// =============================================================================
// Curated editorial-evidence DURABLE CAPTURE (Task #1180).
//
// Every immutable raw editorial action (the same actions the override-log
// already records) ALSO gets a durable EPISODE capture so the evidence lane has
// a normalized, self-describing record — independent of the free-text
// override-event row — carrying:
//   - normalized identities (url/outlet/story/member via the canonical token),
//   - reason key + free note,
//   - before / requested / actual scores,
//   - alternatives considered (when the surface provides them),
//   - provenance (model/prompt/clusterRevision/editor surface),
//   - editor surface + lifecycle outcome.
//
// Persistence now uses the REAL storage methods that landed with #1180:
//   storage.upsertCuratedEditorialEpisode(row, { collapse })  — collapse onto a
//     stable signature; and
//   storage.attachCuratedEditorialEpisodeEvents(episodeId, events) — attach the
//     immutable override-event row BY REFERENCE (never mutating raw events).
// Reason re-attachment updates the durable episode via
//   storage.updateCuratedEditorialOutcome(episodeId, {...}) and records the
//   change as an observation via storage.appendCuratedEditorialObservation.
//
// CRITICAL: this remains FAIL-SOFT. It never throws and never blocks the edit —
// if a storage method is missing (older build) the call is a logged no-op.
// =============================================================================

import { normalizeIdentityUrl } from "./urlIdentity";
import type { InsertCuratedEditorialEpisode } from "@shared/schema";
import {
  type EditorialActionKind,
  type LifecycleOutcome,
  type EditorialProvenance,
  actionFamily,
  normalizeOutletIdentity,
  normalizeStoryIdentity,
  normalizeMemberIdentity,
  validateReason,
  INCORRECT_GROUPING_REASON_KEYS,
} from "@shared/editorialEvidence";

// The storage methods this module consumes. Reported by the route surface so
// the wiring stays discoverable/legible.
export const EXPECTED_STORAGE_METHODS = [
  "upsertCuratedEditorialEpisode",
  "attachCuratedEditorialEpisodeEvents",
  "updateCuratedEditorialOutcome",
  "appendCuratedEditorialObservation",
] as const;

// The explicit, NON-ENFORCING dispositions an editor may record on a FROZEN
// legacy inventory row. These never enable enforcement or mutate a rule.
export const LEGACY_DISPOSITIONS = ["acknowledge", "archive", "discard"] as const;
export type LegacyDisposition = (typeof LEGACY_DISPOSITIONS)[number];

// Normalized, self-describing durable-capture input. All identities are already
// canonicalized; editor identity is carried for grouping/audit but consumers of
// the evidence packet must redact it.
export interface EditorialEpisodeCaptureInput {
  // Source audit-row id this capture mirrors (when known) for lineage back to
  // the immutable override-event row.
  sourceEventId: string | null;
  kind: EditorialActionKind;
  family: string;
  editor: string | null;
  // Normalized identities.
  storyIdentity: string;
  memberIdentities: string[];
  outletIdentities: string[];
  headlines: string[];
  clusterId: string | null;
  primaryUrl: string | null;
  canonicalUrl: string | null;
  // Reason + note.
  reasonKey: string | null;
  reasonNote: string | null;
  // Scores.
  beforeScore: number | null;
  requestedScore: number | null;
  actualScore: number | null;
  beforeContext: Record<string, unknown> | null;
  requestedContext: Record<string, unknown> | null;
  actualContext: Record<string, unknown> | null;
  // Alternatives the editor could have chosen but didn't (e.g. other candidate
  // clusters/scores), captured verbatim when the surface provides them.
  alternatives: unknown[] | null;
  // Provenance visible at decision time + the editor surface.
  provenance: EditorialProvenance;
  surface: string | null;
  // Observed lifecycle outcome.
  outcome: LifecycleOutcome;
  // Editor explicitly flagged an incorrect grouping (drives negative labels).
  explicitIncorrectGrouping: boolean;
  // When epoch-millis of the action is known (else the store stamps its own).
  atMs: number | null;
}

// The caller-facing convenience shape. Raw, un-normalized — this helper
// canonicalizes everything before persisting.
export interface EditorialCaptureParams {
  sourceEventId?: string | null;
  kind: EditorialActionKind;
  editor?: string | null;
  clusterId?: string | null;
  primaryUrl?: string | null;
  memberUrls?: string[] | null;
  memberOutlets?: string[] | null;
  headlines?: string[] | null;
  reasonKey?: string | null;
  reasonNote?: string | null;
  beforeScore?: number | null;
  requestedScore?: number | null;
  actualScore?: number | null;
  beforeContext?: Record<string, unknown> | null;
  requestedContext?: Record<string, unknown> | null;
  actualContext?: Record<string, unknown> | null;
  alternatives?: unknown[] | null;
  provenance?: Partial<EditorialProvenance> | null;
  surface?: string | null;
  outcome?: LifecycleOutcome | null;
  explicitIncorrectGrouping?: boolean | null;
  atMs?: number | null;
}

let missingCaptureLogged = false;
let missingReasonLogged = false;

// Normalize + persist a durable episode capture for one raw action. Fail-soft:
// never throws, never blocks the edit. Returns the durable id when the storage
// method exists and succeeds, else null.
export async function captureEditorialEpisode(
  storage: unknown,
  params: EditorialCaptureParams,
  options: { strict?: boolean } = {},
): Promise<string | null> {
  try {
    const primaryUrl = params.primaryUrl ?? null;
    const canonicalUrl = primaryUrl ? normalizeIdentityUrl(primaryUrl) : null;
    const storyIdentity = normalizeStoryIdentity(
      { clusterId: params.clusterId ?? null, primaryUrl },
      normalizeIdentityUrl,
    );
    const memberIdentities = Array.from(
      new Set(
        (params.memberUrls ?? [])
          .map((u) => normalizeMemberIdentity(u, normalizeIdentityUrl))
          .filter((u): u is string => !!u),
      ),
    );
    const outletIdentities = Array.from(
      new Set(
        (params.memberOutlets ?? [])
          .map((o) => normalizeOutletIdentity(o))
          .filter((o): o is string => !!o),
      ),
    );
    const headlines = Array.from(
      new Set(
        (params.headlines ?? [])
          .map((h) => (h ?? "").trim())
          .filter((h) => h.length > 0),
      ),
    );

    // Validate the reason against the action's vocabulary but NEVER reject the
    // capture on an invalid/absent reason — the immutable action already
    // happened; we record whatever reason context we have.
    const reasonKey = (params.reasonKey ?? "").trim() || null;
    validateReason(params.kind, reasonKey);

    const family = actionFamily(params.kind);
    const surface = params.surface ?? params.provenance?.surface ?? null;
    const outcome: LifecycleOutcome = params.outcome ?? "applied";

    const input: EditorialEpisodeCaptureInput = {
      sourceEventId: params.sourceEventId ?? null,
      kind: params.kind,
      family,
      editor: params.editor ?? null,
      storyIdentity,
      memberIdentities,
      outletIdentities,
      headlines,
      clusterId: params.clusterId ?? null,
      primaryUrl,
      canonicalUrl,
      reasonKey,
      reasonNote: (params.reasonNote ?? "").trim() || null,
      beforeScore: params.beforeScore ?? null,
      requestedScore: params.requestedScore ?? null,
      actualScore: params.actualScore ?? null,
      beforeContext: params.beforeContext ?? null,
      requestedContext: params.requestedContext ?? null,
      actualContext: params.actualContext ?? null,
      alternatives:
        Array.isArray(params.alternatives) && params.alternatives.length
          ? params.alternatives
          : null,
      provenance: {
        model: params.provenance?.model ?? null,
        promptVersion: params.provenance?.promptVersion ?? null,
        clusterRevision: params.provenance?.clusterRevision ?? null,
        surface: params.provenance?.surface ?? surface,
      },
      surface,
      outcome,
      explicitIncorrectGrouping: !!params.explicitIncorrectGrouping,
      atMs: params.atMs ?? null,
    };

    const upsert = (storage as Record<string, unknown>)?.upsertCuratedEditorialEpisode;
    if (typeof upsert !== "function") {
      if (options.strict) {
        throw new Error("storage.upsertCuratedEditorialEpisode not available");
      }
      if (!missingCaptureLogged) {
        missingCaptureLogged = true;
        console.debug(
          "[editorial-evidence] storage.upsertCuratedEditorialEpisode not available — durable capture skipped (fail-soft)",
        );
      }
      return null;
    }

    // Build the durable row from the normalized input. The `action` column
    // stores the pure EditorialActionKind verb (the adapter reads it back).
    const signature = await resolveEpisodeSignature(storage, input);
    const row: InsertCuratedEditorialEpisode = {
      signature,
      actionFamily: family,
      action: input.kind,
      reasonKeys: input.reasonKey ? [input.reasonKey] : [],
      reasonNote: input.reasonNote,
      canonicalUrl: input.canonicalUrl,
      storyKey: input.clusterId ? `cluster:${input.clusterId}` : (input.storyIdentity || null),
      outletId: input.outletIdentities[0] ?? null,
      beforeJson: mergeContext(input.beforeContext, input.beforeScore != null ? { score: input.beforeScore } : null),
      requestedJson: buildRequestedJson(input),
      actualJson: mergeContext(input.actualContext, input.actualScore != null ? { score: input.actualScore } : null),
      alternativesJson: (input.alternatives as Record<string, unknown>[] | null) ?? null,
      provenanceJson: {
        model: input.provenance.model ?? null,
        promptVersion: input.provenance.promptVersion ?? null,
        clusterRevision: input.provenance.clusterRevision ?? null,
        surface: input.provenance.surface ?? null,
      },
      editorSurface: input.surface,
      direction: deriveDirection(input),
      lifecycle: deriveLifecycle(outcome),
      outcome: outcome,
      eventCount: 0,
      editorCount: 0,
      createdBy: input.editor ?? "",
    };

    const episode = await (
      upsert as (r: InsertCuratedEditorialEpisode, o?: { collapse?: boolean }) => Promise<{ id: string }>
    ).call(storage, row, { collapse: true });
    const episodeId = episode?.id ?? null;

    // Explicit lineage: reversals/clears point back to the latest prior episode
    // for the same normalized identity; opposite-direction edits contradict and
    // supersede the prior episode rather than silently collapsing into it.
    const findPrior = (storage as Record<string, unknown>)?.findLatestCuratedEditorialEpisodeForIdentity;
    const updateOutcome = (storage as Record<string, unknown>)?.updateCuratedEditorialOutcome;
    // Pre-apply coordinated captures describe only what the editor REQUESTED.
    // They must not rewrite prior authoritative lineage before the overlay write
    // succeeds; a failed/retryable apply would otherwise falsely undo/supersede
    // the prior episode. Later outcome/final-state observation owns that change.
    if (
      outcome !== "requested"
      && episodeId
      && typeof findPrior === "function"
      && typeof updateOutcome === "function"
    ) {
      const storyKey = input.clusterId ? `cluster:${input.clusterId}` : (input.storyIdentity || null);
      const prior = await (
        findPrior as (q: {
          storyKey: string | null;
          canonicalUrl: string | null;
          excludeEpisodeId: string;
          actionFamily?: string | null;
          differentDirection?: string | null;
          excludeActionFamily?: string | null;
        }) => Promise<{ id: string } | undefined>
      ).call(storage, input.kind === "undo"
        ? {
            storyKey,
            canonicalUrl: input.canonicalUrl,
            excludeEpisodeId: episodeId,
            excludeActionFamily: "lineage",
          }
        : {
            storyKey,
            canonicalUrl: input.canonicalUrl,
            excludeEpisodeId: episodeId,
            actionFamily: input.family,
            differentDirection: deriveDirection(input),
          });
      if (prior?.id) {
        if (input.kind === "undo") {
          await (updateOutcome as Function).call(storage, prior.id, {
            lifecycle: "undone",
            outcome: "undone",
            undoneByEventId: input.sourceEventId ?? episodeId,
          });
          await (updateOutcome as Function).call(storage, episodeId, {
            outcome: "undone",
            outcomeNote: `undoes episode ${prior.id}`,
            lifecycle: "undone",
            verified: true,
            contradictsEpisodeId: prior.id,
          });
        } else {
          await (updateOutcome as Function).call(storage, prior.id, {
            lifecycle: "superseded",
            outcome: "superseded",
            supersededById: episodeId,
          });
          await (updateOutcome as Function).call(storage, episodeId, {
            contradictsEpisodeId: prior.id,
          });
        }
      }
    }

    // Attach the immutable override-event row BY REFERENCE (idempotent). This
    // recomputes the persistence counters (eventCount/editorCount/first/last).
    const attach = (storage as Record<string, unknown>)?.attachCuratedEditorialEpisodeEvents;
    if (episodeId && input.sourceEventId && typeof attach === "function") {
      await (
        attach as (
          id: string,
          events: Array<{ eventId: string; eventAction?: string | null; eventEditor?: string | null; eventAt?: Date | null }>,
        ) => Promise<unknown>
      ).call(storage, episodeId, [
        {
          eventId: input.sourceEventId,
          eventAction: input.kind,
          eventEditor: input.editor ?? null,
          eventAt: input.atMs != null ? new Date(input.atMs) : null,
        },
      ]);
    }

    return episodeId;
  } catch (e: any) {
    if (options.strict) throw e;
    console.warn("[editorial-evidence] durable episode capture failed (fail-soft):", e?.message || e);
    return null;
  }
}

// A STABLE collapse signature for one editorial intent: same normalized story +
// action family collapse onto the same episode. Deterministic, identity-only —
// never carries editor identity or a clock so re-runs are idempotent.
function buildEpisodeSignatureBase(input: EditorialEpisodeCaptureInput): string {
  const story = (input.storyIdentity || input.canonicalUrl || input.clusterId || "unknown").trim();
  return `${input.family}|${story}|${deriveDirection(input)}`;
}

async function resolveEpisodeSignature(
  storage: unknown,
  input: EditorialEpisodeCaptureInput,
): Promise<string> {
  const base = buildEpisodeSignatureBase(input);
  const findRecent = (storage as Record<string, unknown>)?.findRecentCuratedEditorialEpisode;
  if (typeof findRecent === "function") {
    const recent = await (
      findRecent as (q: {
        actionFamily: string;
        storyKey: string | null;
        canonicalUrl: string | null;
        direction: string;
        since: Date;
      }) => Promise<{ signature?: string } | undefined>
    ).call(storage, {
      actionFamily: input.family,
      storyKey: input.clusterId ? `cluster:${input.clusterId}` : (input.storyIdentity || null),
      canonicalUrl: input.canonicalUrl,
      direction: deriveDirection(input),
      since: new Date((input.atMs ?? Date.now()) - 5 * 60 * 1000),
    });
    if (recent?.signature) return recent.signature;
  }
  const bucket = Math.floor((input.atMs ?? Date.now()) / (5 * 60 * 1000));
  return `${base}|${bucket}`;
}

// The REQUESTED-state JSON snapshot: the pinned/requested score plus the member
// / outlet / headline context the evidence packet surfaces per episode.
function buildRequestedJson(input: EditorialEpisodeCaptureInput): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...(input.requestedContext ?? {}) };
  if (input.requestedScore != null) out.score = input.requestedScore;
  if (input.memberIdentities.length) {
    out.memberUrls = input.memberIdentities;
    if (!Array.isArray(out.requestedMemberUrls)) out.requestedMemberUrls = input.memberIdentities;
  }
  if (input.outletIdentities.length) out.memberOutlets = input.outletIdentities;
  if (input.headlines.length) out.headlines = input.headlines;
  return Object.keys(out).length ? out : null;
}

function mergeContext(
  context: Record<string, unknown> | null,
  values: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const out = { ...(context ?? {}), ...(values ?? {}) };
  return Object.keys(out).length ? out : null;
}

// Map the observed lifecycle outcome to the durable episode LIFECYCLE state.
function deriveLifecycle(outcome: LifecycleOutcome): string {
  if (outcome === "undone") return "undone";
  if (outcome === "superseded") return "superseded";
  if (outcome === "conflicted") return "contradicted";
  if (outcome === "applied") return "settled";
  if (outcome === "persisted") return "open";
  return "open";
}

// Map the action + scores to the durable DIRECTION vocab (promote/demote/etc.).
function deriveDirection(input: EditorialEpisodeCaptureInput): string {
  if (input.kind === "hide") return "suppress";
  if (input.kind === "link" || input.kind === "merge") return "link";
  if (input.kind === "unlink" || input.kind === "evict" || input.kind === "move") return "unlink";
  if (input.kind === "classify" || input.kind === "content-kind" || input.kind === "headline" || input.kind === "image") {
    return "relabel";
  }
  if (input.kind === "priority-adjust") {
    const b = input.beforeScore;
    const r = input.requestedScore;
    if (b != null && r != null) {
      if (r > b) return "promote";
      if (r < b) return "demote";
    }
  }
  return "neutral";
}

// A reason-attachment on an EXISTING episode UPDATES that episode's semantics:
// it can turn a previously-neutral grouping-negative/lineage episode into an
// explicit-incorrect-grouping (negative label) one, and refresh its note. This
// mirrors the pure module's grouping-label rules. Fail-soft duck-typed call.
export interface EditorialEpisodeReasonUpdate {
  // Either the durable episode id OR the source override-event id it mirrors.
  episodeId?: string | null;
  sourceEventId?: string | null;
  reasonKey: string | null;
  reasonNote: string | null;
  // Recomputed from the reason key against the incorrect-grouping vocabulary.
  explicitIncorrectGrouping: boolean;
}

export async function updateEditorialEpisodeReason(
  storage: unknown,
  update: EditorialEpisodeReasonUpdate,
): Promise<void> {
  try {
    const s = storage as Record<string, any>;
    const findByEventFn = s?.findCuratedEditorialEpisodeIdByEventId;
    const outcomeFn = s?.updateCuratedEditorialOutcome;
    if (typeof outcomeFn !== "function") {
      if (!missingReasonLogged) {
        missingReasonLogged = true;
        console.debug(
          "[editorial-evidence] durable episode reason-update methods not available — skipped (fail-soft)",
        );
      }
      return;
    }

    // Locate the durable episode this reason attaches to. Prefer a direct id;
    // otherwise use the indexed raw-event linkage. Never perform the former
    // recent-episode + per-episode N+1 scan on an editor request.
    let episodeId = update.episodeId ?? null;
    if (!episodeId && update.sourceEventId && typeof findByEventFn === "function") {
      episodeId = await findByEventFn.call(storage, update.sourceEventId);
    }
    if (!episodeId) return;

    // A reason attachment can promote a grouping-negative/lineage episode to an
    // explicit incorrect-grouping one and refresh its note/outcome. We refresh
    // reasonKeys/note via a targeted outcome update and record the change as an
    // observation trail (never enforcement, never a raw-event mutation).
    const explicit =
      update.explicitIncorrectGrouping ||
      (update.reasonKey != null && INCORRECT_GROUPING_REASON_KEYS.has(update.reasonKey));

    const getById = s?.getCuratedEditorialEpisodeById;
    const upsert = s?.upsertCuratedEditorialEpisode;
    if (typeof getById === "function" && typeof upsert === "function") {
      const existing = await getById.call(storage, episodeId);
      if (existing) {
        // Re-upsert on the SAME signature so the collapse path refreshes the
        // reason keys + note in place (COALESCE-merge; never wipes identity).
        await upsert.call(
          storage,
          {
            signature: existing.signature,
            actionFamily: existing.actionFamily,
            action: existing.action,
            reasonKeys: update.reasonKey ? [update.reasonKey] : existing.reasonKeys ?? [],
            reasonNote: update.reasonNote ?? existing.reasonNote ?? null,
          },
          { collapse: true },
        );
      }
    }

    // Record the semantic change in the observation trail.
    const obsFn = s?.appendCuratedEditorialObservation;
    if (typeof obsFn === "function") {
      await obsFn.call(storage, episodeId, {
        observationKey: update.sourceEventId ? `reason:${update.sourceEventId}` : undefined,
        kind: "note",
        note: update.reasonNote ?? null,
        detailJson: {
          reasonKey: update.reasonKey ?? null,
          explicitIncorrectGrouping: explicit,
        },
        observedBy: "",
      });
    }
  } catch (e: any) {
    console.warn("[editorial-evidence] episode reason update failed (fail-soft):", e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// FROZEN legacy-rule inventory DISPOSITION (fail-soft, NON-ENFORCING).
// ---------------------------------------------------------------------------
// Records an editor's explicit disposition on an inert frozen inventory row.
// This NEVER enables enforcement, NEVER mutates curated_learned_rules, and
// NEVER writes an overlay/outlet role. If a dedicated storage method is present
// (duck-typed) it is used; otherwise the call is a logged no-op so the route
// still succeeds and the client can reflect the reviewer's choice for the
// session. Returns whether the disposition was durably persisted.
export interface LegacyRuleDispositionInput {
  inventoryId: string;
  legacyRuleId: string;
  disposition: LegacyDisposition;
  dispositionedBy: string;
}

let missingLegacyDispositionLogged = false;

export async function recordLegacyRuleDisposition(
  storage: unknown,
  input: LegacyRuleDispositionInput,
): Promise<boolean> {
  try {
    if (!LEGACY_DISPOSITIONS.includes(input.disposition)) return false;
    const s = storage as Record<string, any>;
    // Preferred: a dedicated NON-ENFORCING inventory-disposition storage method.
    const fn = s?.setCuratedLegacyRuleDisposition ?? s?.recordCuratedLegacyRuleDisposition;
    if (typeof fn === "function") {
      await fn.call(storage, input.inventoryId, {
        disposition: input.disposition,
        dispositionedBy: input.dispositionedBy,
        dispositionedAt: new Date(),
      });
      return true;
    }
    if (!missingLegacyDispositionLogged) {
      missingLegacyDispositionLogged = true;
      console.debug(
        "[editorial-evidence] storage.setCuratedLegacyRuleDisposition not available — disposition not durably persisted (fail-soft, non-enforcing)",
      );
    }
    return false;
  } catch (e: any) {
    console.warn("[editorial-evidence] legacy-rule disposition record failed (fail-soft):", e?.message || e);
    return false;
  }
}
