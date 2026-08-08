/**
 * Curated same-event duplicate reconciliation regression (Task #1085).
 *
 * `chooseMissedMergeReconciliation` is the pure, deterministic core of the
 * one-merge-per-pass backstop for the MISSED-merge symptom: two SIBLING formed
 * Top-Story cards that actually describe the SAME event but were formed
 * separately (the clustering LLM split them). Given the pass's formed stories it
 * returns AT MOST ONE high-confidence pair to merge (larger = winner), or null.
 *
 * Precision-first + fail-closed contract pinned here WITHOUT the LLM / DB / live
 * AI so it runs as a regression gate. Scenarios:
 *   (a) two same-event war cards, each formation-strong -> merge (larger wins);
 *   (b) different-day same-worded events (outside the time window) -> no merge;
 *   (c) a formation-WEAK card (single publisher) -> never fused;
 *   (d) a re-partition split CHILD (excluded) -> never re-merged;
 *   (e) combined size over the megacluster cap -> no merge (bounded);
 *   (f) genuinely distinct stories -> no merge;
 *   (g) determinism: same input always yields the same decision;
 *   (h) empty / single-story input -> null.
 *
 * Exits non-zero on any violation.
 *
 * Usage:  tsx scripts/curated-missed-merge-reconcile.test.ts
 */

import {
  chooseMissedMergeReconciliation,
  MISSED_MERGE_RECONCILE_MAX_COMBINED,
  type ReconcileFormedStory,
} from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[missed-merge] OK   ${name}`);
  } else {
    console.error(`[missed-merge] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);

type M = ReconcileFormedStory['synthMembers'][number];
function corr(url: string, source: string, title: string, ageH: number): M {
  return { key: `k:${url}`, url, source, title, cls: 'corroborating', publishedAt: hoursAgo(ageH) };
}

// ---------------------------------------------------------------------------
// (a) TWO SAME-EVENT WAR CARDS. Both formation-strong (>=2 corroborating from
// >=2 distinct publishers), highly-similar titles within the same-event window.
// Larger story (A, 3 members) must WIN; smaller (B, 2 members) is the loser.
// ---------------------------------------------------------------------------
{
  const A: ReconcileFormedStory = {
    signature: 'A',
    synthMembers: [
      corr('https://reuters.com/1', 'Reuters', 'Israel strikes Iran nuclear site in major escalation', 2),
      corr('https://apnews.com/1', 'AP', 'Israel strikes Iran nuclear facility overnight', 3),
      corr('https://bbc.com/1', 'BBC', 'Israeli jets hit Iran nuclear site', 4),
    ],
  };
  const B: ReconcileFormedStory = {
    signature: 'B',
    synthMembers: [
      corr('https://cnn.com/1', 'CNN', 'Israel strikes Iran nuclear site, Tehran vows response', 3),
      corr('https://foxnews.com/1', 'Fox', 'Israel strikes Iran nuclear facility in escalation', 4),
    ],
  };
  const d = chooseMissedMergeReconciliation([A, B]);
  check('(a) same-event pair merges', d !== null, 'expected a decision');
  check('(a) larger story wins', d?.winnerSignature === 'A', `winner=${d?.winnerSignature}`);
  check('(a) smaller story loses', d?.loserSignature === 'B', `loser=${d?.loserSignature}`);
}

// ---------------------------------------------------------------------------
// (b) DIFFERENT-DAY same-worded events. Titles overlap heavily but the members
// are ~30h apart — outside SAME_EVENT_WINDOW_HOURS -> must NOT merge.
// ---------------------------------------------------------------------------
{
  const A: ReconcileFormedStory = {
    signature: 'A',
    synthMembers: [
      corr('https://reuters.com/2', 'Reuters', 'Iran targets US base with missile barrage', 2),
      corr('https://apnews.com/2', 'AP', 'Iran launches missiles at US base', 3),
    ],
  };
  const B: ReconcileFormedStory = {
    signature: 'B',
    synthMembers: [
      corr('https://cnn.com/2', 'CNN', 'Iran targets US base with missile barrage', 34),
      corr('https://bbc.com/2', 'BBC', 'Iran launches missiles at US base', 35),
    ],
  };
  const d = chooseMissedMergeReconciliation([A, B]);
  check('(b) different-day events do NOT merge', d === null, `got ${JSON.stringify(d)}`);
}

// ---------------------------------------------------------------------------
// (c) FORMATION-WEAK card: B has only a single distinct publisher among its
// corroborating members -> it never qualifies, so no merge.
// ---------------------------------------------------------------------------
{
  const A: ReconcileFormedStory = {
    signature: 'A',
    synthMembers: [
      corr('https://reuters.com/3', 'Reuters', 'Russia launches drone strikes on Kyiv', 2),
      corr('https://apnews.com/3', 'AP', 'Russia strikes Kyiv with drones', 3),
    ],
  };
  const B: ReconcileFormedStory = {
    signature: 'B',
    synthMembers: [
      corr('https://cnn.com/3a', 'CNN', 'Russia launches drone strikes on Kyiv overnight', 3),
      corr('https://cnn.com/3b', 'CNN', 'Russia strikes Kyiv with drones again', 4),
    ],
  };
  const d = chooseMissedMergeReconciliation([A, B]);
  check('(c) formation-weak (single-publisher) card never fused', d === null, `got ${JSON.stringify(d)}`);
}

// ---------------------------------------------------------------------------
// (d) RE-PARTITION SPLIT CHILD excluded. B is passed in excludeSignatures (it is
// a deliberate split child) -> must never be re-merged even though it matches A.
// ---------------------------------------------------------------------------
{
  const A: ReconcileFormedStory = {
    signature: 'A',
    synthMembers: [
      corr('https://reuters.com/4', 'Reuters', 'China conducts military drills near Taiwan', 2),
      corr('https://apnews.com/4', 'AP', 'China holds military drills around Taiwan', 3),
    ],
  };
  const B: ReconcileFormedStory = {
    signature: 'B',
    synthMembers: [
      corr('https://cnn.com/4', 'CNN', 'China conducts military drills near Taiwan', 3),
      corr('https://bbc.com/4', 'BBC', 'China holds military drills around Taiwan', 4),
    ],
  };
  const d = chooseMissedMergeReconciliation([A, B], new Set(['B']));
  check('(d) excluded split child never re-merged', d === null, `got ${JSON.stringify(d)}`);
}

// ---------------------------------------------------------------------------
// (e) MEGACLUSTER CAP. Two same-event stories whose combined size exceeds
// MISSED_MERGE_RECONCILE_MAX_COMBINED -> bounded, no merge.
// ---------------------------------------------------------------------------
{
  const big = (sig: string, n: number): ReconcileFormedStory => ({
    signature: sig,
    synthMembers: Array.from({ length: n }, (_, i) =>
      corr(`https://pub${sig}${i}.com/x`, `Pub${sig}${i}`, 'Gaza ceasefire talks collapse in Cairo', 2),
    ),
  });
  const A = big('A', Math.ceil(MISSED_MERGE_RECONCILE_MAX_COMBINED / 2) + 1);
  const B = big('B', Math.ceil(MISSED_MERGE_RECONCILE_MAX_COMBINED / 2) + 1);
  const d = chooseMissedMergeReconciliation([A, B]);
  check('(e) combined over megacluster cap does NOT merge', d === null, `got ${JSON.stringify(d)}`);
}

// ---------------------------------------------------------------------------
// (f) GENUINELY DISTINCT stories -> no merge.
// ---------------------------------------------------------------------------
{
  const A: ReconcileFormedStory = {
    signature: 'A',
    synthMembers: [
      corr('https://reuters.com/5', 'Reuters', 'NATO summit opens in Brussels with defense pledges', 2),
      corr('https://apnews.com/5', 'AP', 'NATO leaders gather in Brussels for summit', 3),
    ],
  };
  const B: ReconcileFormedStory = {
    signature: 'B',
    synthMembers: [
      corr('https://cnn.com/5', 'CNN', 'North Korea test-fires ballistic missile off east coast', 3),
      corr('https://bbc.com/5', 'BBC', 'North Korea launches ballistic missile into sea', 4),
    ],
  };
  const d = chooseMissedMergeReconciliation([A, B]);
  check('(f) distinct stories do NOT merge', d === null, `got ${JSON.stringify(d)}`);
}

// ---------------------------------------------------------------------------
// (g) DETERMINISM. The same input must always yield the same decision.
// ---------------------------------------------------------------------------
{
  const A: ReconcileFormedStory = {
    signature: 'A',
    synthMembers: [
      corr('https://reuters.com/6', 'Reuters', 'Israel strikes Iran nuclear site in major escalation', 2),
      corr('https://apnews.com/6', 'AP', 'Israel strikes Iran nuclear facility overnight', 3),
      corr('https://bbc.com/6', 'BBC', 'Israeli jets hit Iran nuclear site', 4),
    ],
  };
  const B: ReconcileFormedStory = {
    signature: 'B',
    synthMembers: [
      corr('https://cnn.com/6', 'CNN', 'Israel strikes Iran nuclear site, Tehran vows response', 3),
      corr('https://foxnews.com/6', 'Fox', 'Israel strikes Iran nuclear facility in escalation', 4),
    ],
  };
  const d1 = JSON.stringify(chooseMissedMergeReconciliation([A, B]));
  const d2 = JSON.stringify(chooseMissedMergeReconciliation([A, B]));
  const d3 = JSON.stringify(chooseMissedMergeReconciliation([B, A]));
  check('(g) deterministic across repeated calls', d1 === d2, `${d1} vs ${d2}`);
  check('(g) deterministic regardless of input order', d1 === d3, `${d1} vs ${d3}`);
}

// ---------------------------------------------------------------------------
// (h) EMPTY / SINGLE-STORY input -> null.
// ---------------------------------------------------------------------------
{
  check('(h) empty input -> null', chooseMissedMergeReconciliation([]) === null);
  const A: ReconcileFormedStory = {
    signature: 'A',
    synthMembers: [
      corr('https://reuters.com/7', 'Reuters', 'Solo story with no sibling', 2),
      corr('https://apnews.com/7', 'AP', 'Solo story with no sibling here', 3),
    ],
  };
  check('(h) single story -> null', chooseMissedMergeReconciliation([A]) === null);
}

if (failures > 0) {
  console.error(`\n[missed-merge] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[missed-merge] all checks passed');
process.exit(0);
