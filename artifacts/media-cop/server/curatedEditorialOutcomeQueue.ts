import type {
  CuratedEditorialOutcomeObservationSummary,
  IStorage,
} from "./storage";
import { storage } from "./storage";

export type CuratedEditorialOutcomeObservationInput =
  Parameters<IStorage["observeCuratedEditorialOutcomesAfterCluster"]>[0];

type ObservationLane = "ranking" | "clustering";

interface PendingObservation {
  input: CuratedEditorialOutcomeObservationInput;
  onComplete?: (summary: CuratedEditorialOutcomeObservationSummary) => void;
}

export interface CuratedEditorialOutcomeQueueStats {
  running: boolean;
  pendingLanes: ObservationLane[];
  enqueued: number;
  coalesced: number;
  completed: number;
  failed: number;
}

/**
 * One bounded, process-local worker for derived editorial-outcome observation.
 *
 * Outcome evidence is important, but it must not extend a Curated response or
 * clustering pass. Each lane retains only its newest pending authoritative
 * snapshot; repeated refreshes therefore replace stale queued work instead of
 * building an unbounded backlog. The durable episode remains open if the process
 * exits before a queued observation runs, so the next authoritative snapshot
 * can observe it without losing the editor's original action/evidence.
 */
export class CuratedEditorialOutcomeQueue {
  private readonly pending = new Map<ObservationLane, PendingObservation>();
  private running = false;
  private scheduled = false;
  private idleWaiters: Array<() => void> = [];
  private stats = {
    enqueued: 0,
    coalesced: 0,
    completed: 0,
    failed: 0,
  };

  constructor(
    private readonly observe: (
      input: CuratedEditorialOutcomeObservationInput,
    ) => Promise<CuratedEditorialOutcomeObservationSummary>,
  ) {}

  enqueue(
    lane: ObservationLane,
    input: CuratedEditorialOutcomeObservationInput,
    onComplete?: (summary: CuratedEditorialOutcomeObservationSummary) => void,
  ): void {
    this.stats.enqueued += 1;
    if (this.pending.has(lane)) this.stats.coalesced += 1;
    this.pending.set(lane, { input, onComplete });
    this.schedule();
  }

  getStats(): CuratedEditorialOutcomeQueueStats {
    return {
      running: this.running,
      pendingLanes: [...this.pending.keys()],
      ...this.stats,
    };
  }

  async waitForIdle(): Promise<void> {
    if (!this.running && !this.scheduled && this.pending.size === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private schedule(): void {
    if (this.running || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.size > 0) {
        const next = this.pending.entries().next().value as
          | [ObservationLane, PendingObservation]
          | undefined;
        if (!next) break;
        const [lane, job] = next;
        this.pending.delete(lane);
        try {
          const summary = await this.observe(job.input);
          this.stats.completed += 1;
          job.onComplete?.(summary);
        } catch (error) {
          this.stats.failed += 1;
          console.warn(
            `[CuratedEditorialOutcomeQueue] ${lane} observation failed (non-fatal):`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    } finally {
      this.running = false;
      if (this.pending.size > 0) {
        this.schedule();
      } else {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }
}

// One process-wide worker shared by ranking reads and authoritative clustering
// passes. A single worker prevents the two lanes from issuing concurrent
// evidence-write batches against the shared database.
export const curatedEditorialOutcomeQueue = new CuratedEditorialOutcomeQueue(
  (input) => storage.observeCuratedEditorialOutcomesAfterCluster(input),
);
