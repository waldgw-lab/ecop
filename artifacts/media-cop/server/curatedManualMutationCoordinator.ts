// =============================================================================
// Curated manual mutation coordinator (Task #1180).
//
// A single SERIAL, DETERMINISTIC coordinator that every editor manual mutation
// route (link / merge / move / evict / unlink / undo) submits its intent to.
// It exists to give those routes ONE well-behaved place to enforce:
//
//   - per-intent DETERMINISTIC ordering + IDEMPOTENCY (same intent, same result;
//     a duplicate submission collapses to a no-op instead of double-applying),
//   - a STALE-TARGET revalidation hook (the target a route saw at request time
//     may have moved/merged/evicted by the time the intent is actually applied),
//   - FAIL-CLOSED validation (any validation error => `failed`, never a partial
//     or silently-swallowed apply),
//   - a BOUNDED CHEAP reshape after each apply (deterministic, no AI, never a
//     full clustering pass),
//   - a CLUSTERING-BUSY DEFERRED path (when a full pass holds the single lock the
//     intent is applied to storage and the reshape is DEFERRED, not blocked —
//     the route still returns immediately with an honest status),
//   - COALESCED, BOUNDED synthesis that NEVER blocks a later edit (many edits in
//     a burst collapse into ONE bounded background synthesis request),
//   - the SAME path for UNDO (an undo is just another intent), and
//   - an EXACT cache-invalidation hook fired once per applied intent.
//
// It is DEPENDENCY-INJECTED and PURE around effects: every side effect
// (persisting, reshaping, revalidating, checking clustering-busy, invalidating
// the cache, scheduling synthesis, and the clock) is supplied by the caller.
// That is what makes it unit-testable with zero DB / AI / HTTP, and it is why
// this module deliberately does NOT import curatedCluster / curatedCacheBus /
// storage / routes directly — the wiring lives in the caller (routes.ts), which
// this task does not touch. CURATED-LANE ONLY; it has no main-feed behavior.
// =============================================================================

// ---------------------------------------------------------------------------
// Result statuses — the ONLY values a route may surface. Each is TRUTHFUL about
// what actually happened at submit time (nothing is aspirational):
//   requested  — accepted + enqueued but not yet reached the head of the serial
//                queue (only observable if a caller inspects an in-flight intent;
//                a normal await resolves to a terminal status below).
//   persisted  — the intent's storage write landed, but the follow-up reshape was
//                DEFERRED because clustering is busy (applied-to-storage, not yet
//                reshaped).
//   applied    — the storage write landed AND the bounded cheap reshape ran.
//   deferred   — nothing was written yet; the whole apply was deferred behind a
//                busy clustering pass and scheduled to run when the lock frees.
//   conflicted — stale-target revalidation found the world moved under the intent
//                (fail-closed: no write performed).
//   dormant    — the target is not currently live/eligible (e.g. an evict on an
//                already-dormant cluster); accepted as a well-formed no-op.
//   no-op      — idempotent duplicate, or the intent would not change anything.
//   failed     — fail-closed validation error, or the apply effect threw.
// ---------------------------------------------------------------------------
export type ManualMutationStatus =
  | 'requested'
  | 'persisted'
  | 'applied'
  | 'deferred'
  | 'conflicted'
  | 'dormant'
  | 'no-op'
  | 'failed';

export type ManualMutationKind = 'link' | 'merge' | 'move' | 'evict' | 'unlink' | 'undo';

/**
 * A single editor intent. `dedupeKey` drives per-intent idempotency: two intents
 * with the same dedupeKey are considered the SAME logical action. `targets` lists
 * the cluster/member ids the intent touches, each with the revision the route saw
 * at request time so the coordinator can detect a stale target at apply time.
 */
export interface ManualMutationIntent {
  kind: ManualMutationKind;
  /** Stable per-intent identity used for ordering + idempotency. */
  dedupeKey: string;
  /** Targets this intent reads/writes, with the revision seen at request time. */
  targets: ManualMutationTarget[];
  /** Whether this apply should trigger bounded background synthesis after landing. */
  wantsSynthesis?: boolean;
  /**
   * Whether the inline/deferred reshape should regenerate AI synthesis (headline +
   * key facts). A merge/evict/move wants synthesis; a plain unlink does not. Flows
   * to the injected reshape/defer effects. Bounded — never a full pass.
   */
  forceSynthesis?: boolean;
  /**
   * Bounded budget (ms) for the follow-up synthesis reshape so it releases the
   * shared clustering lock promptly (e.g. MANUAL_MERGE_SYNTHESIS_MAX_MS).
   */
  synthesisMaxMs?: number;
  /**
   * When set, a busy-path apply also requests the in-flight clustering pass to
   * yield early (requestCuratedClusteringYield) using this reason so the deferred
   * reshape lands in seconds. Undo/unevict/unmove routes intentionally omit it.
   */
  yieldReason?: string;
  /** Opaque per-intent payload handed back to the injected apply/revalidate fns. */
  payload?: unknown;
  /**
   * For an undo: the dedupeKey of the intent being reversed. Undo takes the SAME
   * path as any other intent (validated, revalidated, applied, reshaped) — this
   * only lets the injected apply function locate what to reverse.
   */
  undoOf?: string;
}

export interface ManualMutationTarget {
  /** e.g. `cluster:abc` or `member:123` — opaque to the coordinator. */
  id: string;
  /**
   * Revision the route observed for this target. Compared against the injected
   * revalidate hook's current revision to fail closed on a stale target.
   */
  seenRevision: number;
}

export interface ManualMutationResult {
  status: ManualMutationStatus;
  kind: ManualMutationKind;
  dedupeKey: string;
  /** Human-readable reason (for logs / editor toast); never load-bearing. */
  reason: string;
  /** True when this result was served from the idempotency cache. */
  idempotentHit: boolean;
  /** True when a bounded synthesis request was (or will be) coalesced in. */
  synthesisCoalesced: boolean;
  /** Monotonic sequence number this intent was assigned in the serial queue. */
  seq: number;
  /** True when the inline cheap reshape actually ran (not skipped/deferred). */
  reshaped: boolean;
  /** Route-produced data from applyIntent (e.g. { id }). Empty on non-applies. */
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Injected effects. Every one is supplied by the caller so the coordinator core
// stays pure and fully testable. All are allowed to be async; the coordinator
// awaits them serially so ordering is deterministic.
// ---------------------------------------------------------------------------

export interface RevalidateResult {
  /** Current revision the store holds for the target right now. */
  currentRevision: number;
  /** True if the target still exists and is a live/eligible mutation target. */
  live: boolean;
  /** True if the target is present but dormant (e.g. already-evicted cluster). */
  dormant?: boolean;
}

export interface ApplyOutcome {
  /** Whether the storage write actually changed anything. */
  changed: boolean;
  /** Optional reason surfaced to the route / logs. */
  reason?: string;
  /**
   * Arbitrary route-produced data (e.g. the created overlay row id) surfaced on
   * the result so the route can build its exact response shape. Opaque to the
   * coordinator.
   */
  data?: Record<string, unknown>;
}

export interface ManualMutationDeps {
  /** Monotonic clock in ms (injected so tests are deterministic). */
  now: () => number;
  /**
   * True iff a FULL clustering pass currently holds the single lock. When true,
   * the coordinator takes the deferred path (persist-then-defer, or fully defer)
   * instead of running the bounded reshape inline.
   */
  isClusteringBusy: () => boolean;
  /**
   * Re-read a target's current state at APPLY time. Fail-closed: if the returned
   * currentRevision differs from the intent's seenRevision the intent conflicts.
   */
  revalidateTarget: (target: ManualMutationTarget, intent: ManualMutationIntent) => Promise<RevalidateResult> | RevalidateResult;
  /**
   * Validate the fully-formed intent. Return an error string to FAIL CLOSED, or
   * null/undefined to proceed. Pure w.r.t. the coordinator (no side effects).
   */
  validateIntent: (intent: ManualMutationIntent) => string | null | undefined;
  /**
   * Persist the immutable raw action and its durable editorial episode BEFORE
   * any authoritative overlay write. Throwing fails the intent closed and the
   * mutation remains retryable. This is intentionally separate from applyIntent:
   * evidence describes the editor's request, while later outcome observation
   * records whether the requested state actually landed.
   */
  beforeApply: (intent: ManualMutationIntent) => Promise<string> | string;
  /**
   * Persist the coordinator's terminal storage outcome against the captured
   * episode. This does NOT claim authoritative cluster success: a landed overlay
   * is `persisted` until the later final-state observer can prove `applied`.
   */
  finalizeEvidence: (
    episodeId: string,
    status: 'persisted' | 'dormant' | 'failed',
    note: string,
    intent: ManualMutationIntent,
  ) => Promise<void> | void;
  /**
   * Perform the storage write for the intent. The ONLY effect that mutates
   * persistent state. Throwing => `failed` (fail-closed). Returning changed=false
   * => `no-op`.
   */
  applyIntent: (intent: ManualMutationIntent) => Promise<ApplyOutcome> | ApplyOutcome;
  /**
   * Run the bounded, deterministic, AI-free cheap reshape for the applied intent.
   * Called ONLY on the inline (not-busy) path. Must be cheap + never a full pass.
   * May return false to signal the reshape was skipped (e.g. clustering-disabled)
   * — the result then reports reshaped=false but still `applied` (write landed).
   */
  runCheapReshape: (intent: ManualMutationIntent) => Promise<boolean | void> | boolean | void;
  /**
   * Defer the reshape to run when the clustering lock next frees. Called on the
   * busy path (this is the injected wrapper around schedulePendingManualReshape).
   */
  deferReshape: (intent: ManualMutationIntent) => void;
  /**
   * Exact cache-invalidation hook. Fired EXACTLY ONCE per intent that changed
   * persistent state (applied OR persisted-deferred), never on conflict/no-op.
   */
  invalidateCache: (intent: ManualMutationIntent) => void;
  /**
   * Schedule bounded, coalesced synthesis. Called at most once per drained burst
   * regardless of how many synthesis-wanting intents landed — the coordinator
   * coalesces, so this fn receives the set of dedupeKeys it should cover.
   */
  scheduleBoundedSynthesis: (dedupeKeys: string[]) => void;
  /** Optional structured logger; defaults to a no-op. */
  log?: (event: string, detail: Record<string, unknown>) => void;
}

// How long an idempotency result is remembered. A duplicate submission within
// this window collapses to the SAME result (no double-apply). Bounded so the
// cache never grows without limit. Curated-lane only; in-process.
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 512;

interface IdempotencyEntry {
  result: ManualMutationResult;
  expiresAt: number;
}

/**
 * The coordinator. Construct ONE per process with the injected effects; every
 * route submits its intent via `submit()`. All applies are serialized through a
 * single promise chain so ordering is deterministic and no two applies interleave.
 */
export class CuratedManualMutationCoordinator {
  private readonly deps: ManualMutationDeps;
  private tail: Promise<unknown> = Promise.resolve();
  private seqCounter = 0;
  private readonly idempotency = new Map<string, IdempotencyEntry>();

  // Coalesced-synthesis accumulator. dedupeKeys of intents that landed and want
  // synthesis are collected here; a single bounded synthesis is scheduled when
  // the serial queue drains. This is what guarantees a synthesis request NEVER
  // blocks a later edit — later edits keep draining while synthesis is only ever
  // *scheduled*, never awaited, and only once per burst.
  private pendingSynthesisKeys: string[] = [];
  private synthesisScheduled = false;

  constructor(deps: ManualMutationDeps) {
    this.deps = deps;
  }

  /**
   * Submit an intent. Returns a terminal result. Applies are serialized: this
   * intent's apply only begins after all previously-submitted intents' applies
   * have settled, giving deterministic per-intent ordering. Idempotent: a repeat
   * submission of the same dedupeKey inside the TTL returns the cached result and
   * performs NO new effect.
   */
  submit(intent: ManualMutationIntent): Promise<ManualMutationResult> {
    const seq = ++this.seqCounter;
    // Chain onto the serial tail. We deliberately swallow the prior tail's result
    // so one failed intent never rejects the chain for the next intent.
    const run = this.tail.then(
      () => this.process(intent, seq),
      () => this.process(intent, seq),
    );
    // Advance the tail. Swallow rejection here too so the chain never dies.
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Number of intents processed so far (for tests / telemetry). */
  get processedCount(): number {
    return this.seqCounter;
  }

  private logEvent(event: string, detail: Record<string, unknown>): void {
    try {
      (this.deps.log ?? (() => undefined))(event, detail);
    } catch {
      /* logging must never affect coordination */
    }
  }

  private async finalizeEvidenceSafely(
    episodeId: string,
    status: 'persisted' | 'dormant',
    note: string,
    intent: ManualMutationIntent,
  ): Promise<void> {
    try {
      await this.deps.finalizeEvidence(episodeId, status, note, intent);
    } catch (err) {
      this.logEvent('failed-evidence-finalize', {
        kind: intent.kind,
        dedupeKey: intent.dedupeKey,
        status,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  private cacheResult(intent: ManualMutationIntent, result: ManualMutationResult): void {
    const now = this.deps.now();
    this.idempotency.set(intent.dedupeKey, { result, expiresAt: now + IDEMPOTENCY_TTL_MS });
    // Bound the cache: drop the oldest entries if we exceed the cap.
    if (this.idempotency.size > IDEMPOTENCY_MAX_ENTRIES) {
      const overflow = this.idempotency.size - IDEMPOTENCY_MAX_ENTRIES;
      let dropped = 0;
      for (const key of this.idempotency.keys()) {
        if (dropped >= overflow) break;
        this.idempotency.delete(key);
        dropped++;
      }
    }
  }

  private idempotentLookup(intent: ManualMutationIntent): ManualMutationResult | null {
    const entry = this.idempotency.get(intent.dedupeKey);
    if (!entry) return null;
    if (entry.expiresAt <= this.deps.now()) {
      this.idempotency.delete(intent.dedupeKey);
      return null;
    }
    return entry.result;
  }

  private make(
    intent: ManualMutationIntent,
    seq: number,
    status: ManualMutationStatus,
    reason: string,
    extra?: Partial<Pick<ManualMutationResult, 'idempotentHit' | 'synthesisCoalesced' | 'reshaped' | 'data'>>,
  ): ManualMutationResult {
    return {
      status,
      kind: intent.kind,
      dedupeKey: intent.dedupeKey,
      reason,
      idempotentHit: extra?.idempotentHit ?? false,
      synthesisCoalesced: extra?.synthesisCoalesced ?? false,
      reshaped: extra?.reshaped ?? false,
      data: extra?.data ?? {},
      seq,
    };
  }

  private async process(intent: ManualMutationIntent, seq: number): Promise<ManualMutationResult> {
    // --- Idempotency: a duplicate submission returns the prior terminal result
    //     and performs NO new effect. This is what makes a repeated intent safe.
    const cached = this.idempotentLookup(intent);
    if (cached) {
      this.logEvent('idempotent-hit', { kind: intent.kind, dedupeKey: intent.dedupeKey, seq });
      return { ...cached, idempotentHit: true, seq };
    }

    // --- Fail-closed validation. Any error => failed, no effect performed.
    let validationError: string | null | undefined;
    try {
      validationError = this.deps.validateIntent(intent);
    } catch (err) {
      validationError = err instanceof Error ? err.message : 'validation threw';
    }
    if (validationError) {
      const result = this.make(intent, seq, 'failed', `validation: ${validationError}`);
      this.cacheResult(intent, result);
      this.logEvent('failed-validation', { kind: intent.kind, dedupeKey: intent.dedupeKey, reason: validationError });
      return result;
    }

    // --- Stale-target revalidation. Re-read every target at APPLY time; if any
    //     target's revision moved, or a live target is gone, fail closed with
    //     `conflicted`. A present-but-dormant target yields `dormant` (a
    //     well-formed no-op) rather than a conflict.
    let sawDormant = false;
    for (const target of intent.targets) {
      let rv: RevalidateResult;
      try {
        rv = await this.deps.revalidateTarget(target, intent);
      } catch (err) {
        const result = this.make(
          intent,
          seq,
          'failed',
          `revalidate threw for ${target.id}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
        this.cacheResult(intent, result);
        this.logEvent('failed-revalidate', { kind: intent.kind, dedupeKey: intent.dedupeKey, target: target.id });
        return result;
      }
      if (rv.currentRevision !== target.seenRevision) {
        const result = this.make(
          intent,
          seq,
          'conflicted',
          `stale target ${target.id}: seen ${target.seenRevision}, now ${rv.currentRevision}`,
        );
        // A conflict is a legitimate terminal outcome and is idempotent for the
        // life of the (now-stale) intent — cache it so a blind retry of the SAME
        // stale intent doesn't repeatedly probe storage.
        this.cacheResult(intent, result);
        this.logEvent('conflicted', {
          kind: intent.kind,
          dedupeKey: intent.dedupeKey,
          target: target.id,
          seen: target.seenRevision,
          now: rv.currentRevision,
        });
        return result;
      }
      if (rv.dormant) sawDormant = true;
      else if (!rv.live) {
        const result = this.make(intent, seq, 'conflicted', `target ${target.id} no longer live`);
        this.cacheResult(intent, result);
        this.logEvent('conflicted-gone', { kind: intent.kind, dedupeKey: intent.dedupeKey, target: target.id });
        return result;
      }
    }

    if (sawDormant) {
      // Target present but dormant — accepted well-formed no-op. No write, no
      // cache invalidation, no reshape. Cached so a repeat is stable.
      const result = this.make(intent, seq, 'dormant', 'target dormant — nothing to change');
      this.cacheResult(intent, result);
      this.logEvent('dormant', { kind: intent.kind, dedupeKey: intent.dedupeKey });
      return result;
    }

    // --- Required evidence persistence. The editor request must be durable
    //     before an authoritative overlay can change. A transient evidence-store
    //     failure is NOT cached so the exact intent can be retried safely.
    let episodeId: string;
    try {
      episodeId = await this.deps.beforeApply(intent);
    } catch (err) {
      const result = this.make(
        intent,
        seq,
        'failed',
        `evidence threw: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      this.logEvent('failed-evidence', { kind: intent.kind, dedupeKey: intent.dedupeKey });
      return result;
    }

    // --- Clustering-busy DEFERRED path. When a full pass holds the single lock
    //     we still land the storage write (so the editor's action is durable and
    //     visible via its representative) but DEFER the reshape rather than block
    //     on the lock. If the caller cannot even write safely while busy, the
    //     applyIntent can throw and we fail closed. We check busy ONCE, up front,
    //     so the decision is deterministic for this intent.
    const busy = safeBool(() => this.deps.isClusteringBusy());

    // --- Apply the storage write. Fail-closed on throw; no-op on !changed.
    let outcome: ApplyOutcome;
    try {
      outcome = await this.deps.applyIntent(intent);
    } catch (err) {
      const note = `apply threw: ${err instanceof Error ? err.message : 'unknown'}`;
      try {
        await this.deps.finalizeEvidence(episodeId, 'failed', note, intent);
      } catch (evidenceErr) {
        this.logEvent('failed-evidence-finalize', {
          kind: intent.kind,
          dedupeKey: intent.dedupeKey,
          error: evidenceErr instanceof Error ? evidenceErr.message : 'unknown',
        });
      }
      const result = this.make(
        intent,
        seq,
        'failed',
        note,
      );
      // A thrown apply is NOT cached — the failure may be transient (storage
      // hiccup) and the editor should be able to retry the same intent.
      this.logEvent('failed-apply', { kind: intent.kind, dedupeKey: intent.dedupeKey });
      return result;
    }

    const applyData = outcome.data ?? {};

    if (!outcome.changed) {
      const note = outcome.reason ?? 'apply changed nothing';
      await this.finalizeEvidenceSafely(episodeId, 'dormant', note, intent);
      const result = this.make(intent, seq, 'no-op', note, { data: applyData });
      this.cacheResult(intent, result);
      this.logEvent('no-op', { kind: intent.kind, dedupeKey: intent.dedupeKey });
      return result;
    }

    // The write changed persistent state — fire the EXACT cache-invalidation hook
    // exactly once, regardless of which follow-up path (inline vs deferred) runs.
    safeVoid(() => this.deps.invalidateCache(intent));

    // Accumulate coalesced synthesis (scheduled once when the queue drains).
    let synthesisCoalesced = false;
    if (intent.wantsSynthesis) {
      this.pendingSynthesisKeys.push(intent.dedupeKey);
      synthesisCoalesced = true;
    }

    if (busy) {
      // Persisted, but reshape deferred behind the busy clustering pass.
      safeVoid(() => this.deps.deferReshape(intent));
      this.maybeScheduleSynthesis();
      const result = this.make(intent, seq, 'persisted', 'written; reshape deferred (clustering busy)', {
        synthesisCoalesced,
        reshaped: false,
        data: applyData,
      });
      await this.finalizeEvidenceSafely(episodeId, 'persisted', result.reason, intent);
      this.cacheResult(intent, result);
      this.logEvent('persisted-deferred', { kind: intent.kind, dedupeKey: intent.dedupeKey });
      return result;
    }

    // --- Inline bounded cheap reshape. Deterministic, AI-free, never a full pass.
    //     A throw here does NOT lose the durable write (already committed +
    //     invalidated) — we fall back to the deferred reshape and report
    //     `persisted` so the route is truthful that the reshape hasn't run yet.
    let didReshape = false;
    try {
      const rr = await this.deps.runCheapReshape(intent);
      // A reshape that explicitly returns false ran but did nothing (skipped);
      // any other (void/true) return means it applied the overlay.
      didReshape = rr !== false;
    } catch (err) {
      safeVoid(() => this.deps.deferReshape(intent));
      this.maybeScheduleSynthesis();
      const result = this.make(
        intent,
        seq,
        'persisted',
        `written; cheap reshape failed (${err instanceof Error ? err.message : 'unknown'}) — deferred`,
        { synthesisCoalesced, reshaped: false, data: applyData },
      );
      await this.finalizeEvidenceSafely(episodeId, 'persisted', result.reason, intent);
      this.cacheResult(intent, result);
      this.logEvent('reshape-failed-deferred', { kind: intent.kind, dedupeKey: intent.dedupeKey });
      return result;
    }

    this.maybeScheduleSynthesis();
    if (!didReshape) {
      const result = this.make(intent, seq, 'persisted', 'written; reshape deferred/scheduled', {
        synthesisCoalesced,
        reshaped: false,
        data: applyData,
      });
      await this.finalizeEvidenceSafely(episodeId, 'persisted', result.reason, intent);
      this.cacheResult(intent, result);
      this.logEvent('persisted-deferred', { kind: intent.kind, dedupeKey: intent.dedupeKey });
      return result;
    }
    const result = this.make(intent, seq, 'applied', didReshape ? 'written + reshaped' : 'written; reshape scheduled/skipped', {
      synthesisCoalesced,
      reshaped: didReshape,
      data: applyData,
    });
    await this.finalizeEvidenceSafely(
      episodeId,
      'persisted',
      didReshape ? 'overlay written + bounded reshape completed; awaiting authoritative observation' : 'overlay written; bounded reshape skipped',
      intent,
    );
    this.cacheResult(intent, result);
    this.logEvent('applied', { kind: intent.kind, dedupeKey: intent.dedupeKey });
    return result;
  }

  /**
   * Schedule bounded synthesis for the accumulated burst — at most ONCE per
   * burst. The key property: synthesis is only ever *scheduled*, never awaited
   * between edits, so it can NEVER block a later edit.
   *
   * Coalescing works by arming a single deferred flush. Every synthesis-wanting
   * intent that lands while the flush is still armed just appends its dedupeKey
   * to `pendingSynthesisKeys` — no second flush is armed. When the serial queue
   * has quiesced (the current tail settles with no newer apply having re-armed a
   * fresh apply behind it), the flush fires once with ALL accumulated keys.
   *
   * We anchor the flush to the CURRENT serial tail: when that tail settles, if
   * no further synthesis-wanting intent is still queued behind it we flush; if
   * more arrived, the flag was left armed by them and the final drain flushes.
   */
  private maybeScheduleSynthesis(): void {
    if (this.pendingSynthesisKeys.length === 0) return;
    if (this.synthesisScheduled) return;
    this.synthesisScheduled = true;
    // Snapshot the tail at arm time. When it (and everything queued ahead of the
    // flush) has settled, drain. Any intents submitted in the SAME burst chain
    // onto a later tail and will have appended their keys before this resolves.
    const tailAtArm = this.tail;
    Promise.resolve(tailAtArm).then(() => {
      // If a newer intent extended the queue past the tail we snapshotted, defer
      // to the next drain so we still emit exactly one call per burst.
      if (this.tail !== tailAtArm) {
        this.synthesisScheduled = false;
        this.maybeScheduleSynthesis();
        return;
      }
      this.synthesisScheduled = false;
      if (this.pendingSynthesisKeys.length === 0) return;
      const keys = this.pendingSynthesisKeys.slice();
      this.pendingSynthesisKeys = [];
      this.logEvent('synthesis-coalesced', { count: keys.length, keys });
      safeVoid(() => this.deps.scheduleBoundedSynthesis(keys));
    });
  }
}

// ---------------------------------------------------------------------------
// Tiny effect guards — a side-effecting injected fn must never crash the
// coordinator's serial chain. These swallow throws (the coordinator's own
// status reporting already reflects the load-bearing outcomes).
// ---------------------------------------------------------------------------
function safeVoid(fn: () => void): void {
  try {
    fn();
  } catch {
    /* swallow — non-load-bearing effect */
  }
}

function safeBool(fn: () => boolean): boolean {
  try {
    return !!fn();
  } catch {
    return false;
  }
}
