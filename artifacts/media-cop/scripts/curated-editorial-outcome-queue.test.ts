/**
 * Gate: derived editorial outcome observation never blocks Curated reads/passes.
 * Pure/offline: uses a controlled observer promise, no DB or network.
 */
import { CuratedEditorialOutcomeQueue } from '../server/curatedEditorialOutcomeQueue';

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) console.log(`[t1180-queue] OK   ${label}`);
  else {
    failed += 1;
    console.error(`[t1180-queue] FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const summaries = () => ({
  scanned: 0, applied: 0, deferred: 0, conflicted: 0, dormant: 0,
  superseded: 0, undone: 0, failed: 0, latencyMs: 0,
});

const calls: string[] = [];
let releaseFirst!: () => void;
const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
const queue = new CuratedEditorialOutcomeQueue(async (input) => {
  calls.push(input.clusterRevision);
  if (calls.length === 1) await firstBlocked;
  return summaries();
});

const input = (clusterRevision: string) => ({
  clusterRevision,
  keptMembers: [],
  mode: 'immediate' as const,
  actionFamilies: ['priority'],
});

(async () => {
  const started = Date.now();
  queue.enqueue('ranking', input('ranking:1'));
  check('enqueue returns without awaiting observer', Date.now() - started < 50);
  await new Promise<void>((resolve) => setImmediate(resolve));
  check('worker begins asynchronously', calls.join(',') === 'ranking:1', calls.join(','));

  queue.enqueue('ranking', input('ranking:2'));
  queue.enqueue('ranking', input('ranking:3'));
  queue.enqueue('clustering', { ...input('full:1'), mode: 'full' });
  check('one latest pending snapshot retained per lane',
    queue.getStats().pendingLanes.length === 2,
    queue.getStats().pendingLanes.join(','));
  check('same-lane pending work coalesces', queue.getStats().coalesced === 1);

  releaseFirst();
  await queue.waitForIdle();
  check('stale ranking snapshot was replaced', !calls.includes('ranking:2'), calls.join(','));
  check('latest ranking snapshot ran', calls.includes('ranking:3'), calls.join(','));
  check('clustering snapshot ran serially', calls.includes('full:1'), calls.join(','));
  check('only three observations executed', calls.length === 3, calls.join(','));
  check('queue returns to idle', !queue.getStats().running && queue.getStats().pendingLanes.length === 0);

  if (failed === 0) {
    console.log('[t1180-queue] ALL OUTCOME-QUEUE CHECKS PASSED');
    process.exit(0);
  }
  process.exit(1);
})().catch((error) => {
  console.error('[t1180-queue] FAIL unexpected error', error);
  process.exit(1);
});