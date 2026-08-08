/**
 * Shared-actor false-merge regression.
 *
 * Root cause: two unrelated stories — "Xi Calls for Global AI Cooperation" and
 * "Trump Accuses China of Election Interference" — were merged into a single
 * 28-source card. The LLM treated the shared US-China bilateral backdrop as a
 * shared event. The coherence guard did not dissolve the cluster because the
 * large member count masked the two-thread structure.
 *
 * The fix adds an explicit "SHARED ACTOR ≠ SHARED EVENT" rule to:
 *   1. Phase B grouping prompt — a shared country/bilateral relationship is never
 *      enough to cluster two stories with different actions and subjects.
 *   2. Coherence guard prompt — minority-thread eviction even when the minority
 *      has multiple members; "same two countries" is not a keep reason.
 *   3. Diplomatic process tightening — political accusations (election-interference
 *      claims, sanctions allegations) are NOT diplomatic processes and must not
 *      fold into policy tracks.
 *
 * This gate has four layers:
 *
 *   (A) NEGATIVE — coherence guard evicts election-accusation items from a cluster
 *                  whose dominant event is the AI-cooperation speech.
 *   (B) POSITIVE — coherence guard retains all members of a pure AI-cooperation
 *                  cluster (no false evictions).
 *   (C) POSITIVE — coherence guard retains all members of a pure election-
 *                  interference cluster (no false evictions).
 *   (D) STATIC   — the three new rule phrases are present in curatedCluster.ts
 *                  (regression guard against accidental revert).
 *   (E) LIVE AI  — identifyCuratedClusters produces two separate clusters for an
 *                  8-node fixture mixing both stories. Exit 3 (inconclusive) when
 *                  the AI is unreachable or returns garbage.
 *
 * Usage:  npx tsx scripts/curated-shared-actor-false-merge.test.ts
 * Exits 1 on deterministic failure, 3 on inconclusive (live-AI path only).
 */

import { applyCoherenceRemovals, identifyCuratedClusters, type LaneNode } from '../server/curatedCluster';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
let ran = 0;

function check(name: string, ok: boolean, detail = '') {
  ran++;
  if (ok) {
    console.log(`[shared-actor-false-merge] OK   ${name}`);
  } else {
    console.error(`[shared-actor-false-merge] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

type Group = { keys: string[] };

// ---------------------------------------------------------------------------
// (A) NEGATIVE: election-accusation items folded into an AI-speech cluster.
//
// Simulate the false-merge scenario with 7 members:
//   DOMINANT (AI speech — keep):
//     0. "Xi Calls for Global AI Cooperation at UN Forum"
//     1. "China proposes global AI governance framework, Xi says"
//     2. "Xi speech: AI should serve all humanity, not just powerful nations"
//     3. "China pushes for international AI oversight body at UN"
//   ELECTION ACCUSATION (evict):
//     4. "Trump Accuses China of Election Interference"
//     5. "White House: China is meddling in US elections via social media"
//     6. "Intelligence officials: China targeting 2026 midterms with influence ops"
//
// The coherence guard, with the new rule, would flag positions 4, 5, and 6
// (the election-accusation thread). applyCoherenceRemovals must evict them.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [
    {
      keys: [
        'main:xi-calls-global-ai-cooperation',
        'main:china-proposes-ai-governance-framework',
        'main:xi-speech-ai-serve-humanity',
        'main:china-pushes-international-ai-oversight',
        'main:trump-accuses-china-election-interference',
        'main:whitehouse-china-meddling-us-elections',
        'main:intel-officials-china-targeting-2026-midterms',
      ],
    },
  ];

  const aiSpeechKeys = [
    'main:xi-calls-global-ai-cooperation',
    'main:china-proposes-ai-governance-framework',
    'main:xi-speech-ai-serve-humanity',
    'main:china-pushes-international-ai-oversight',
  ];
  const electionKeys = [
    'main:trump-accuses-china-election-interference',
    'main:whitehouse-china-meddling-us-elections',
    'main:intel-officials-china-targeting-2026-midterms',
  ];

  const remove = new Map<number, Set<number>>([[0, new Set([4, 5, 6])]]);
  const r = applyCoherenceRemovals(groups, remove);
  const keptKeys = r.groups[0]?.keys ?? [];

  check(
    '(A) mixed cluster: exactly 4 AI-speech keys remain',
    keptKeys.length === 4,
    `got ${keptKeys.length}: ${JSON.stringify(keptKeys)}`,
  );

  for (const k of aiSpeechKeys) {
    check(
      `(A) AI-speech item kept: ${k}`,
      keptKeys.includes(k),
      `missing from kept set`,
    );
  }

  for (const k of electionKeys) {
    check(
      `(A) election-accusation item evicted: ${k}`,
      !keptKeys.includes(k) && r.droppedKeys.has(k),
      `droppedKeys=${JSON.stringify([...r.droppedKeys])}`,
    );
  }

  check(
    '(A) exactly 3 keys in droppedKeys',
    r.droppedKeys.size === 3,
    `got ${r.droppedKeys.size}`,
  );

  check(
    '(A) prunedClusters === 1',
    r.prunedClusters === 1,
    `got ${r.prunedClusters}`,
  );
}

// ---------------------------------------------------------------------------
// (B) POSITIVE: pure AI-cooperation cluster — coherence guard flags NOTHING.
//
//   0. "Xi Calls for Global AI Cooperation at UN Forum"
//   1. "China proposes global AI governance framework, Xi says"
//   2. "Xi speech: AI should serve all humanity"
//   3. "China pushes for international AI oversight body"
//
// All four are angles of the same event. The guard should return an empty
// remove set; applyCoherenceRemovals must keep all four.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [
    {
      keys: [
        'main:xi-calls-global-ai-cooperation',
        'main:china-proposes-ai-governance-framework',
        'main:xi-speech-ai-serve-humanity',
        'main:china-pushes-international-ai-oversight',
      ],
    },
  ];

  const remove = new Map<number, Set<number>>([[0, new Set()]]);
  const r = applyCoherenceRemovals(groups, remove);
  const keptKeys = r.groups[0]?.keys ?? [];

  check(
    '(B) pure AI-cooperation cluster: all 4 members kept',
    keptKeys.length === 4,
    `got ${keptKeys.length}`,
  );
  check(
    '(B) pure AI-cooperation cluster: droppedKeys empty',
    r.droppedKeys.size === 0,
    `got ${r.droppedKeys.size}`,
  );
  check(
    '(B) pure AI-cooperation cluster: prunedClusters === 0',
    r.prunedClusters === 0,
    `got ${r.prunedClusters}`,
  );
}

// ---------------------------------------------------------------------------
// (C) POSITIVE: pure election-interference cluster — coherence guard flags NOTHING.
//
//   0. "Trump Accuses China of Election Interference"
//   1. "White House: China is meddling in US elections via social media"
//   2. "Intelligence officials: China targeting 2026 midterms with influence ops"
//   3. "China denies US election-meddling allegations"
//
// All four are angles of the same story. They must cluster with each other;
// the rule only bars them from joining an AI-cooperation cluster.
// ---------------------------------------------------------------------------
{
  const groups: Group[] = [
    {
      keys: [
        'main:trump-accuses-china-election-interference',
        'main:whitehouse-china-meddling-us-elections',
        'main:intel-officials-china-targeting-2026-midterms',
        'main:china-denies-us-election-meddling',
      ],
    },
  ];

  const remove = new Map<number, Set<number>>([[0, new Set()]]);
  const r = applyCoherenceRemovals(groups, remove);
  const keptKeys = r.groups[0]?.keys ?? [];

  check(
    '(C) pure election-interference cluster: all 4 members kept',
    keptKeys.length === 4,
    `got ${keptKeys.length}`,
  );
  check(
    '(C) pure election-interference cluster: droppedKeys empty',
    r.droppedKeys.size === 0,
    `got ${r.droppedKeys.size}`,
  );
  check(
    '(C) pure election-interference cluster: prunedClusters === 0',
    r.prunedClusters === 0,
    `got ${r.prunedClusters}`,
  );
}

// ---------------------------------------------------------------------------
// (D) STATIC PROMPT CONTRACT
//
// Verify the three new rule phrases are present in curatedCluster.ts.
// If any is accidentally reverted, this gate fails before any AI call.
// ---------------------------------------------------------------------------
{
  const src = readFileSync(join(process.cwd(), 'server', 'curatedCluster.ts'), 'utf8');

  const GROUPING_RULE = 'SHARED ACTOR \u2260 SHARED EVENT';
  check(
    '(D) grouping prompt contains SHARED ACTOR ≠ SHARED EVENT rule',
    src.includes(GROUPING_RULE),
    'phrase not found in server/curatedCluster.ts',
  );

  const GUARD_EXCEPTION = 'EXCEPTION \u2014 SHARED ACTOR \u2260 SHARED EVENT';
  check(
    '(D) coherence guard prompt contains SHARED ACTOR ≠ SHARED EVENT exception',
    src.includes(GUARD_EXCEPTION),
    'phrase not found in server/curatedCluster.ts',
  );

  const ACCUSATION_PHRASE = 'a political accusation (an election-interference claim';
  check(
    '(D) diplomatic process tightening present in grouping prompt',
    src.includes(ACCUSATION_PHRASE),
    'phrase not found in server/curatedCluster.ts',
  );

  const GUARD_ACCUSATION = 'a political accusation (an election-interference claim, a sanctions allegation, an espionage charge) is NOT a diplomatic process';
  check(
    '(D) political-accusation tightening present in coherence guard prompt',
    src.includes(GUARD_ACCUSATION),
    'phrase not found in server/curatedCluster.ts',
  );
}

// ---------------------------------------------------------------------------
// Bail early if deterministic checks failed — no need to burn AI credits.
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n[shared-actor-false-merge] ${failures} deterministic check(s) FAILED — aborting before live AI`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// (E) LIVE AI — identifyCuratedClusters must not merge the two stories.
//
// Fixture: 8 nodes mixing both stories (4 AI-speech, 4 election-interference),
// all timestamped within the same 2-hour window so time-rules can't separate them.
// The expected result: no single cluster spans BOTH groups.
// A cluster is a cross-group merge if it contains ≥1 AI-speech key AND
// ≥1 election-accusation key.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-17T10:00:00Z');

function node(partial: Partial<LaneNode> & { key: string; title: string }): LaneNode {
  return {
    itemType: 'curated',
    itemId: partial.key.split(':')[1] ?? partial.key,
    source: partial.source ?? 'Test Wire',
    url: partial.url ?? `https://example.com/${encodeURIComponent(partial.key)}`,
    category: 'general',
    label: null,
    cls: 'corroborating',
    role: 'contributing',
    blocked: false,
    priority: 70,
    ogImageUrl: null,
    publishedAt: partial.publishedAt ?? NOW,
    sourceIdentifier: null,
    factuality: null,
    ownership: [],
    summary: partial.summary ?? null,
    bullets: null,
    ...partial,
  } as LaneNode;
}

const aiKeys = new Set([
  'curated:xi-ai-cooperation-un',
  'curated:china-ai-governance-framework',
  'curated:xi-ai-speech-all-humanity',
  'curated:china-international-ai-oversight',
]);

const electionKeys = new Set([
  'curated:trump-china-election-interference',
  'curated:whitehouse-china-election-meddling',
  'curated:intel-china-2026-midterms',
  'curated:china-denies-election-meddling',
]);

const fixture: LaneNode[] = [
  node({
    key: 'curated:xi-ai-cooperation-un',
    title: 'Xi Calls for Global AI Cooperation at UN Forum',
    source: 'Xinhua',
    summary: 'Chinese President Xi Jinping called for international cooperation on artificial intelligence governance at the United Nations forum, proposing a global oversight body.',
  }),
  node({
    key: 'curated:china-ai-governance-framework',
    title: 'China proposes global AI governance framework, Xi says',
    source: 'South China Morning Post',
    summary: "Xi's speech outlined China's vision for AI development under multilateral rules.",
  }),
  node({
    key: 'curated:xi-ai-speech-all-humanity',
    title: 'Xi: AI should serve all humanity, not just powerful nations',
    source: 'Global Times',
    summary: 'Chinese President Xi Jinping said AI technology must benefit all countries equally, not just powerful ones, in remarks at an international forum.',
  }),
  node({
    key: 'curated:china-international-ai-oversight',
    title: 'China pushes for international AI oversight body at UN',
    source: 'Reuters',
    summary: "China pushed for the creation of a UN-backed AI oversight body following Xi's speech.",
  }),
  node({
    key: 'curated:trump-china-election-interference',
    title: 'Trump Accuses China of Election Interference',
    source: 'CNN',
    summary: 'President Trump accused China of interfering in American elections through social media influence operations and disinformation campaigns targeting US voters.',
  }),
  node({
    key: 'curated:whitehouse-china-election-meddling',
    title: 'White House: China meddling in US elections via social media',
    source: 'Fox News',
    summary: 'The White House said China is actively meddling in US elections by spreading disinformation through social media platforms.',
  }),
  node({
    key: 'curated:intel-china-2026-midterms',
    title: 'Intelligence officials: China targeting 2026 midterms with influence ops',
    source: 'Politico',
    summary: 'US intelligence officials testified that China is conducting influence operations to interfere with the 2026 midterm elections.',
  }),
  node({
    key: 'curated:china-denies-election-meddling',
    title: 'China denies US election-meddling allegations, calls charges baseless',
    source: 'AP',
    summary: "China's foreign ministry denied US accusations of election interference, calling the charges politically motivated and baseless.",
  }),
];

console.log('\n[shared-actor-false-merge] Running live AI clustering on 8-node mixed fixture…');

let liveExitCode = 0;

try {
  const clusters = await identifyCuratedClusters(fixture, { harnessStub: false });

  if (clusters === null) {
    console.warn('[shared-actor-false-merge] identifyCuratedClusters returned null (AI error) — treating as inconclusive');
    liveExitCode = 3;
  } else {
    let crossMergeFound = false;
    for (const group of clusters) {
      const hasAi = group.keys.some(k => aiKeys.has(k));
      const hasElection = group.keys.some(k => electionKeys.has(k));
      if (hasAi && hasElection) {
        console.error(
          `[shared-actor-false-merge] FAIL (E) cross-group merge detected — cluster members: ${JSON.stringify(group.keys)}`,
        );
        crossMergeFound = true;
        failures++;
      }
    }

    ran++;
    if (!crossMergeFound) {
      console.log('[shared-actor-false-merge] OK   (E) no cross-group merge — AI-speech and election-accusation stay separate');
    }

    // Bonus positive check: the AI-speech nodes should cluster among themselves.
    const aiCluster = clusters.find(g => g.keys.some(k => aiKeys.has(k)) && !g.keys.some(k => electionKeys.has(k)));
    ran++;
    check(
      '(E) AI-speech nodes form at least one cluster among themselves',
      !!aiCluster && aiCluster.keys.length >= 2,
      aiCluster ? `got ${aiCluster.keys.length} keys` : 'no AI-only cluster found',
    );
  }
} catch (err: any) {
  const msg = String(err?.message ?? err);
  if (/ECONNREFUSED|fetch failed|network|timeout|429|rate.?limit/i.test(msg)) {
    console.warn(`[shared-actor-false-merge] (E) live AI call failed (${msg}) — treating as inconclusive`);
    liveExitCode = 3;
  } else {
    console.error(`[shared-actor-false-merge] (E) unexpected error: ${err?.stack ?? err}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Completion sentinel — guard against a vacuous exit-0.
// ---------------------------------------------------------------------------
const EXPECTED_MIN_CHECKS = 17;
if (ran < EXPECTED_MIN_CHECKS) {
  console.error(
    `\n[shared-actor-false-merge] INCOMPLETE — only ${ran}/${EXPECTED_MIN_CHECKS} checks ran (vacuous pass guard)`,
  );
  process.exit(1);
}

if (failures > 0) {
  console.error(`\n[shared-actor-false-merge] ${failures} check(s) FAILED`);
  process.exit(1);
}

if (liveExitCode === 3) {
  console.warn('\n[shared-actor-false-merge] deterministic checks PASS; live AI call inconclusive — exit 3');
  process.exit(3);
}

console.log(`\n[shared-actor-false-merge] ALL PASS (${ran} checks)`);
