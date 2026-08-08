/**
 * Curated AI timeout-recovery regression (Task #714).
 *
 * The curated pipeline calls out to an AI model chain in TWO load-bearing
 * places — clustering (identifyCuratedClusters via createCuratedClusterCompletion)
 * and per-story synthesis (synthesizeStory via createCuratedSynthesisCompletion).
 * Both wrap every call in withAiTimeout + a provider fallback chain. If a
 * regression ever let one of those calls throw out of its catch, the next
 * clustering pass would run replaceCuratedClusterMembers([]) and SILENTLY WIPE
 * every formed Top Story on a transient model outage. This test pins the
 * fail-SAFE contract that keeps that from happening:
 *
 *   1. When the WHOLE clustering model chain times out, identifyCuratedClusters
 *      returns `null` — the PRESERVE signal ("keep previous clusters") — and NOT
 *      `[]` (which would mean "the model ran and found no clusters", i.e. WIPE).
 *      A successful-but-empty grouping is separately pinned to return `[]`, so
 *      the null-vs-empty distinction clusterCuratedLane switches on is locked.
 *
 *   2. The real clusterCuratedLane, driven end-to-end with the clustering call
 *      forced to time out, returns { stories: 0, members: 0 } AND never calls
 *      replaceCuratedClusterMembers — it PRESERVES the existing clusters rather
 *      than crashing or wiping.
 *
 *   3. When synthesizeStory's model chain times out, it returns `null` (that one
 *      story is skipped for the pass) rather than throwing and taking the whole
 *      pass down with it.
 *
 * Stubbing strategy (no test framework, no live AI/network):
 *   - Clustering: ESM named imports are read-only, so createPreferOpenRouter
 *     cannot be reassigned. curatedCluster.ts exposes a test-only injection seam
 *     (__setCuratedClusterCompletionForTest) that swaps in a stub with the exact
 *     createPreferOpenRouter signature; production leaves it null.
 *   - Synthesis: the shared `openai` OBJECT's method is mutable, so we replace
 *     openai.chat.completions.create directly (no production seam needed).
 *   - clusterCuratedLane: `storage` is a mutable DatabaseStorage instance, so we
 *     shadow the handful of read methods it touches before the clustering call
 *     with in-memory fixtures — nothing hits the DB, and replaceCuratedClusterMembers
 *     is a spy that MUST stay uncalled on the preserve path.
 *
 * A transient-shaped timeout (code: 'ETIMEDOUT') is used so the stub exercises
 * the FULL provider fallback chain (every entry attempted, then re-thrown) —
 * the worst case where all providers are unreachable.
 *
 * Run directly with tsx (no test framework configured):
 *   npx tsx scripts/curated-timeout-recovery.test.ts
 * Exits non-zero on any failure.
 */
import {
  identifyCuratedClusters,
  clusterCuratedLane,
  __setCuratedClusterCompletionForTest,
  __setClusterMaxDurationForTest,
  __setMaxClustersPerGuardCallForTest,
  type LaneNode,
} from '../server/curatedCluster';
import { synthesizeStory, type SynthMember } from '../server/curatedSynthesis';
import { openai } from '../server/aiClient';
import { storage } from '../server/storage';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[timeout-recovery] OK   ${name}`);
  } else {
    console.error(`[timeout-recovery] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// A transient-shaped timeout rejection (isTransientAIError treats ETIMEDOUT as a
// provider failure), so createCuratedClusterCompletion walks EVERY chain entry
// before re-throwing — the all-providers-down worst case.
function makeTimeoutError(): Error {
  const e = new Error('simulated model timeout') as Error & { code?: string };
  e.code = 'ETIMEDOUT';
  return e;
}

const NOW = new Date('2026-07-10T12:00:00Z');

function node(
  partial: Partial<LaneNode> & { key: string; title: string; priority: number; cls: LaneNode['cls'] },
): LaneNode {
  return {
    itemType: 'curated',
    itemId: partial.key.split(':')[1] ?? partial.key,
    source: partial.source ?? 'Test Wire',
    url: partial.url ?? `https://example.com/${partial.key}`,
    category: 'general',
    label: null,
    role:
      partial.cls === 'corroborating'
        ? 'contributing'
        : partial.cls === 'anchor-only'
          ? 'anchor-only'
          : 'attach-only',
    blocked: false,
    ogImageUrl: null,
    publishedAt: NOW,
    sourceIdentifier: null,
    factuality: null,
    ownership: [],
    summary: null,
    bullets: null,
    ...partial,
  } as LaneNode;
}

async function main() {
  // =========================================================================
  // TEST 1 — clustering call times out across the WHOLE chain -> null (PRESERVE),
  // and the fallback chain is fully walked (every entry attempted).
  // =========================================================================
  {
    let calls = 0;
    __setCuratedClusterCompletionForTest(async () => {
      calls++;
      throw makeTimeoutError();
    });

    const nodes = [
      node({
        key: 'curated:a',
        title: 'Iran and US nuclear talks collapse after final round in Geneva',
        priority: 71,
        cls: 'corroborating',
        source: 'Reuters',
        url: 'https://www.reuters.com/world/iran-us-nuclear-talks-collapse',
      }),
      node({
        key: 'curated:b',
        title: 'US-Iran nuclear negotiations break down in final Geneva round',
        priority: 70,
        cls: 'corroborating',
        source: 'Associated Press',
        url: 'https://apnews.com/article/iran-us-nuclear-talks-geneva',
      }),
    ];

    const result = await identifyCuratedClusters(nodes);
    check(
      '1a identifyCuratedClusters returns null (PRESERVE previous clusters) on an all-chain timeout',
      result === null,
      `got ${JSON.stringify(result)}`,
    );
    check(
      '1b the entire provider fallback chain is attempted before giving up',
      calls === 3,
      `stub called ${calls} time(s), expected 3`,
    );

    __setCuratedClusterCompletionForTest(null);
  }

  // =========================================================================
  // TEST 2 — a SUCCESSFUL but empty grouping returns [] (CLEAR), pinning the
  // null-vs-empty distinction clusterCuratedLane switches on. Without this, a
  // regression that turned the preserve-null into an empty-[] would silently
  // wipe Top Stories and this suite would not notice.
  // =========================================================================
  {
    __setCuratedClusterCompletionForTest(async () => ({
      choices: [{ message: { content: JSON.stringify({ clusters: [] }) } }],
    }) as any);

    const nodes = [
      node({ key: 'curated:c', title: 'Unrelated headline one about trade policy', priority: 60, cls: 'corroborating' }),
      node({ key: 'curated:d', title: 'Completely different headline two about weather', priority: 59, cls: 'corroborating' }),
    ];
    const result = await identifyCuratedClusters(nodes);
    check(
      '2 a successful empty grouping returns [] (CLEAR), NOT null — the distinction is preserved',
      Array.isArray(result) && result.length === 0,
      `got ${JSON.stringify(result)}`,
    );

    __setCuratedClusterCompletionForTest(null);
  }

  // =========================================================================
  // TEST 3 — the real clusterCuratedLane, driven end-to-end with the clustering
  // call timed out, PRESERVES clusters: returns { stories: 0, members: 0 } and
  // never wipes (replaceCuratedClusterMembers is never called).
  // =========================================================================
  {
    __setCuratedClusterCompletionForTest(async () => {
      throw makeTimeoutError();
    });

    // Shadow only the read methods clusterCuratedLane touches before the
    // clustering call. This is the CURATED lane, so candidates must come from the
    // CURATED STORE (getCuratedStoreItems), NOT the main feed — seeding via
    // getPrimaryFeed alone would exercise the curated path only incidentally (via
    // the main+curated node union). Empty registry + empty carry/archive/manual-
    // link sets + two fresh curated-store items is the minimal shape that reaches
    // the clustering call with >= 2 candidate nodes (so we skip the separate
    // "not enough items" wipe branch and land on the AI-failure branch). The main
    // feed is emptied so the ONLY candidates are these curated rows.
    const orig: Record<string, any> = {};
    const stub = (name: string, fn: (...a: any[]) => any) => {
      orig[name] = (storage as any)[name];
      (storage as any)[name] = fn;
    };
    const restore = () => {
      for (const [name, fn] of Object.entries(orig)) (storage as any)[name] = fn;
    };

    let replaceCalled = 0;
    stub('getOutletRegistry', async () => []);
    stub('getCuratedStoreItems', async () => [
      {
        id: 90001,
        title: 'China unveils new long-range air-to-air missile in Pacific drill',
        normalizedTitle: null,
        source: 'Defense News',
        url: 'https://www.defensenews.com/air/2026/07/10/china-aam',
        category: 'general',
        summary: null,
        summaryBullets: null,
        role: 'contributing',
        priorityScore: 68,
        ogImageUrl: null,
        contentKind: null,
        articlePublishedAt: NOW,
        scrapedAt: NOW,
      },
      {
        id: 90002,
        title: 'Pentagon confirms new Indo-Pacific carrier deployment schedule',
        normalizedTitle: null,
        source: 'Military Times',
        url: 'https://www.militarytimes.com/news/2026/07/10/carrier',
        category: 'general',
        summary: null,
        summaryBullets: null,
        role: 'contributing',
        priorityScore: 67,
        ogImageUrl: null,
        contentKind: null,
        articlePublishedAt: NOW,
        scrapedAt: NOW,
      },
    ]);
    stub('getCuratedClusterMembers', async () => []);
    stub('getCuratedArchiveOriginationBySignatures', async () => new Map());
    stub('getCuratedArchiveGraceCandidates', async () => []);
    stub('getActiveCuratedManualLinks', async () => []);
    stub('getPrimaryFeed', async () => []);
    stub('replaceCuratedClusterMembers', async () => {
      replaceCalled++;
    });

    let threw = false;
    let laneResult: any = null;
    try {
      laneResult = await clusterCuratedLane({ mode: 'full' });
    } catch (e) {
      threw = true;
      console.error('[timeout-recovery] clusterCuratedLane THREW:', e);
    } finally {
      restore();
      __setCuratedClusterCompletionForTest(null);
    }

    check('3a clusterCuratedLane recovers cleanly (does not throw) on a clustering timeout', !threw);
    check(
      '3b clusterCuratedLane returns { stories: 0, members: 0 } on a clustering timeout',
      !!laneResult && laneResult.stories === 0 && laneResult.members === 0,
      `got ${JSON.stringify(laneResult)}`,
    );
    check(
      '3c clusterCuratedLane PRESERVES clusters — replaceCuratedClusterMembers is never called (no wipe)',
      replaceCalled === 0,
      `replaceCuratedClusterMembers called ${replaceCalled} time(s)`,
    );
  }

  // =========================================================================
  // TEST 4 — synthesis call times out -> synthesizeStory skips gracefully (null),
  // never throwing to take the whole pass down.
  // =========================================================================
  {
    const origCreate = openai.chat.completions.create;
    let synthCalls = 0;
    (openai.chat.completions as any).create = async () => {
      synthCalls++;
      throw makeTimeoutError();
    };

    const members: SynthMember[] = [
      {
        key: 'curated:s1',
        url: 'https://www.reuters.com/world/iran-us-nuclear-talks-collapse',
        source: 'Reuters',
        sourceIdentifier: 'reuters',
        factuality: 'high',
        ownership: ['reuters'],
        title: 'Iran and US nuclear talks collapse after final round in Geneva',
        summary: null,
        bullets: null,
        cls: 'corroborating',
        label: 'primary',
      },
      {
        key: 'curated:s2',
        url: 'https://apnews.com/article/iran-us-nuclear-talks-geneva',
        source: 'Associated Press',
        sourceIdentifier: 'ap',
        factuality: 'high',
        ownership: ['ap'],
        title: 'US-Iran nuclear negotiations break down in final Geneva round',
        summary: null,
        bullets: null,
        cls: 'corroborating',
        label: 'primary',
      },
    ];

    let synthThrew = false;
    let synthResult: any = 'unset';
    try {
      synthResult = await synthesizeStory(members);
    } catch (e) {
      synthThrew = true;
      console.error('[timeout-recovery] synthesizeStory THREW:', e);
    } finally {
      (openai.chat.completions as any).create = origCreate;
    }

    check('4a synthesizeStory recovers cleanly (does not throw) on a synthesis timeout', !synthThrew);
    check(
      '4b synthesizeStory returns null (skips this story) on a synthesis timeout',
      synthResult === null,
      `got ${JSON.stringify(synthResult)}`,
    );
    check(
      '4c synthesis reached the AI call (fixture had corroborating members)',
      synthCalls >= 1,
      `synthesis AI call invoked ${synthCalls} time(s)`,
    );
  }

  // =========================================================================
  // TEST 5 — hard-timeout early-stop fires MID-PASS (Task #742). A short fake
  // CLUSTER_MAX_DURATION is injected so the abort signal trips WHILE the
  // grouping call is in flight. The grouping succeeds (returns a real cluster),
  // but the very next phase boundary (before-coherence-guard) must throw
  // AbortError: no further AI phase (coherence guard / semantic attach /
  // synthesis / anchor-split) is ever entered, and the destructive
  // replaceCuratedClusterMembers write never runs — clusters are PRESERVED.
  // =========================================================================
  {
    // Abort fires 800ms into the pass; the grouping stub takes 2000ms, so the
    // signal is guaranteed aborted by the time grouping returns. The boundary
    // BEFORE grouping is reached within a few ms (storage stubs are in-memory),
    // so it passes; the boundary AFTER grouping must throw.
    // Note: 800ms budget (vs 150ms) avoids a timing flake under the concurrent
    // load of the full 77-gate suite, where startup overhead can exhaust a
    // tight budget before the grouping call is even dispatched.
    __setClusterMaxDurationForTest(800);

    let clusterAiCalls = 0;
    __setCuratedClusterCompletionForTest(async () => {
      clusterAiCalls++;
      await new Promise((r) => setTimeout(r, 2000));
      // A VALID grouping of both seeded items — if the early-stop regressed,
      // the pass would proceed to coherence-guard/synthesis and eventually
      // write members, which the checks below would catch.
      return {
        choices: [{ message: { content: JSON.stringify({ clusters: [{ indices: [1, 2] }] }) } }],
      } as any;
    });

    // Spy on the shared openai client too: coherence guard, semantic attach and
    // synthesis all ultimately go through chat.completions.create when not
    // running via the injection seam.
    const origCreate = openai.chat.completions.create;
    let openaiCalls = 0;
    (openai.chat.completions as any).create = async (...args: any[]) => {
      openaiCalls++;
      throw makeTimeoutError();
    };

    const orig: Record<string, any> = {};
    const stub = (name: string, fn: (...a: any[]) => any) => {
      orig[name] = (storage as any)[name];
      (storage as any)[name] = fn;
    };
    const restore = () => {
      for (const [name, fn] of Object.entries(orig)) (storage as any)[name] = fn;
    };

    let replaceCalled = 0;
    stub('getOutletRegistry', async () => []);
    stub('getCuratedStoreItems', async () => [
      {
        id: 91001,
        title: 'Iran and US nuclear talks collapse after final round in Geneva',
        normalizedTitle: null,
        source: 'Reuters',
        url: 'https://www.reuters.com/world/iran-us-nuclear-talks-collapse-t5',
        category: 'general',
        summary: null,
        summaryBullets: null,
        role: 'contributing',
        priorityScore: 71,
        ogImageUrl: null,
        contentKind: null,
        articlePublishedAt: NOW,
        scrapedAt: NOW,
      },
      {
        id: 91002,
        title: 'US-Iran nuclear negotiations break down in final Geneva round',
        normalizedTitle: null,
        source: 'Associated Press',
        url: 'https://apnews.com/article/iran-us-nuclear-talks-geneva-t5',
        category: 'general',
        summary: null,
        summaryBullets: null,
        role: 'contributing',
        priorityScore: 70,
        ogImageUrl: null,
        contentKind: null,
        articlePublishedAt: NOW,
        scrapedAt: NOW,
      },
    ]);
    stub('getCuratedClusterMembers', async () => []);
    stub('getCuratedArchiveOriginationBySignatures', async () => new Map());
    stub('getCuratedArchiveGraceCandidates', async () => []);
    stub('getActiveCuratedManualLinks', async () => []);
    stub('getPrimaryFeed', async () => []);
    stub('replaceCuratedClusterMembers', async () => {
      replaceCalled++;
    });

    let threw = false;
    let laneResult: any = null;
    try {
      laneResult = await clusterCuratedLane({ mode: 'full' });
    } catch (e) {
      threw = true;
      console.error('[timeout-recovery] clusterCuratedLane THREW under mid-pass abort:', e);
    } finally {
      restore();
      __setCuratedClusterCompletionForTest(null);
      __setClusterMaxDurationForTest(null);
      (openai.chat.completions as any).create = origCreate;
    }

    check('5a mid-pass abort: clusterCuratedLane does not throw (AbortError is caught internally)', !threw);
    check(
      '5b mid-pass abort: pass returns { stories: 0, members: 0 } (PRESERVE result)',
      !!laneResult && laneResult.stories === 0 && laneResult.members === 0,
      `got ${JSON.stringify(laneResult)}`,
    );
    check(
      '5c mid-pass abort: grouping ran exactly once — NO downstream AI phase entered via the seam',
      clusterAiCalls === 1,
      `cluster completion seam called ${clusterAiCalls} time(s), expected 1 (grouping only)`,
    );
    check(
      '5d mid-pass abort: no downstream AI phase reached the shared openai client either',
      openaiCalls === 0,
      `openai.chat.completions.create called ${openaiCalls} time(s), expected 0`,
    );
    check(
      '5e mid-pass abort: destructive replaceCuratedClusterMembers never runs (clusters preserved)',
      replaceCalled === 0,
      `replaceCuratedClusterMembers called ${replaceCalled} time(s)`,
    );
  }

  // =========================================================================
  // TEST 6 — PRE-ABORTED signal (duration 0): the abort fires before the FIRST
  // phase boundary (before-grouping), so the grouping LLM must never even be
  // called, and the pass still returns the PRESERVE result with no wipe.
  // =========================================================================
  {
    __setClusterMaxDurationForTest(0);

    let clusterAiCalls = 0;
    __setCuratedClusterCompletionForTest(async () => {
      clusterAiCalls++;
      return {
        choices: [{ message: { content: JSON.stringify({ clusters: [] }) } }],
      } as any;
    });

    const orig: Record<string, any> = {};
    const stub = (name: string, fn: (...a: any[]) => any) => {
      orig[name] = (storage as any)[name];
      (storage as any)[name] = fn;
    };
    const restore = () => {
      for (const [name, fn] of Object.entries(orig)) (storage as any)[name] = fn;
    };

    let replaceCalled = 0;
    stub('getOutletRegistry', async () => []);
    stub('getCuratedStoreItems', async () => [
      {
        id: 92001,
        title: 'China unveils new long-range air-to-air missile in Pacific drill',
        normalizedTitle: null,
        source: 'Defense News',
        url: 'https://www.defensenews.com/air/2026/07/10/china-aam-t6',
        category: 'general',
        summary: null,
        summaryBullets: null,
        role: 'contributing',
        priorityScore: 68,
        ogImageUrl: null,
        contentKind: null,
        articlePublishedAt: NOW,
        scrapedAt: NOW,
      },
      {
        id: 92002,
        title: 'Pentagon confirms new Indo-Pacific carrier deployment schedule',
        normalizedTitle: null,
        source: 'Military Times',
        url: 'https://www.militarytimes.com/news/2026/07/10/carrier-t6',
        category: 'general',
        summary: null,
        summaryBullets: null,
        role: 'contributing',
        priorityScore: 67,
        ogImageUrl: null,
        contentKind: null,
        articlePublishedAt: NOW,
        scrapedAt: NOW,
      },
    ]);
    stub('getCuratedClusterMembers', async () => []);
    stub('getCuratedArchiveOriginationBySignatures', async () => new Map());
    stub('getCuratedArchiveGraceCandidates', async () => []);
    stub('getActiveCuratedManualLinks', async () => []);
    stub('getPrimaryFeed', async () => []);
    stub('replaceCuratedClusterMembers', async () => {
      replaceCalled++;
    });

    let threw = false;
    let laneResult: any = null;
    try {
      laneResult = await clusterCuratedLane({ mode: 'full' });
    } catch (e) {
      threw = true;
      console.error('[timeout-recovery] clusterCuratedLane THREW under pre-aborted signal:', e);
    } finally {
      restore();
      __setCuratedClusterCompletionForTest(null);
      __setClusterMaxDurationForTest(null);
    }

    check('6a pre-aborted signal: clusterCuratedLane does not throw', !threw);
    check(
      '6b pre-aborted signal: pass returns { stories: 0, members: 0 } (PRESERVE result)',
      !!laneResult && laneResult.stories === 0 && laneResult.members === 0,
      `got ${JSON.stringify(laneResult)}`,
    );
    check(
      '6c pre-aborted signal: the grouping LLM is never called (stopped at before-grouping)',
      clusterAiCalls === 0,
      `cluster completion seam called ${clusterAiCalls} time(s), expected 0`,
    );
    check(
      '6d pre-aborted signal: replaceCuratedClusterMembers never runs (no wipe)',
      replaceCalled === 0,
      `replaceCuratedClusterMembers called ${replaceCalled} time(s)`,
    );
  }

  // =========================================================================
  // TEST 7 — IN-LOOP abort (Task #982). The phase-boundary checks (tests 5/6)
  // only fire BETWEEN phases; the loops INSIDE the fail-safe try/catch blocks
  // (coherence-guard batches, per-cluster re-partition, semantic-attach) instead
  // use a plain `signal.aborted` break to stop starting NEW AI calls mid-loop. A
  // regression that removed one of those breaks would let an aborted pass keep
  // hammering the AI client through a long loop, invisible to tests 5/6.
  //
  // This drives the real coherence-guard loop across MULTIPLE batches (chunk size
  // forced to 1 via the test seam, so two 2-member clusters = two batches). The
  // grouping call returns fast (two valid clusters), so the before-coherence-guard
  // boundary passes and the loop is entered. The FIRST guard batch sleeps long
  // enough for the pass's hard-timeout to fire while it is in flight; the loop's
  // top-of-iteration `if (abortSignal?.aborted) break` must then stop before
  // starting the SECOND batch. The pass then hits the next phase boundary
  // (before-semantic-attach), throws AbortError, and returns the PRESERVE result
  // with no member write.
  // =========================================================================
  {
    // Budget long enough that grouping + in-memory setup comfortably finish
    // before it fires, but short enough that the first guard batch's sleep
    // outlasts it (so the abort trips WHILE batch 1 is in flight and batch 2 is
    // skipped by the in-loop break).
    __setClusterMaxDurationForTest(1200);
    // One cluster per guard batch, so two clusters => two sequential batches.
    __setMaxClustersPerGuardCallForTest(1);

    let seamCalls = 0;
    __setCuratedClusterCompletionForTest(async (body: any) => {
      seamCalls++;
      const prompt = String(body?.messages?.[0]?.content ?? '');
      const isGrouping = seamCalls === 1;
      if (isGrouping) {
        // Two valid 2-member clusters over the four seeded nodes (indices are
        // 1-based into the priority-ordered node list).
        return {
          choices: [{ message: { content: JSON.stringify({ clusters: [{ indices: [1, 2] }, { indices: [3, 4] }] }) } }],
        } as any;
      }
      // This is a coherence-guard batch. Sleep past the abort budget so the
      // signal fires while we're in flight; raceWithAbortClustering then rejects
      // this batch (caught fail-safe), and the loop's next-iteration abort check
      // must break before a THIRD seam call (a second guard batch) is ever made.
      void prompt;
      await new Promise((r) => setTimeout(r, 2500));
      return {
        choices: [{ message: { content: JSON.stringify({ clusters: [{ cluster: 1, remove: [] }] }) } }],
      } as any;
    });

    // Spy on the shared openai client: if any downstream AI phase were entered
    // after the abort, it would ultimately go through chat.completions.create.
    const origCreate = openai.chat.completions.create;
    let openaiCalls = 0;
    (openai.chat.completions as any).create = async () => {
      openaiCalls++;
      throw makeTimeoutError();
    };

    const orig: Record<string, any> = {};
    const stub = (name: string, fn: (...a: any[]) => any) => {
      orig[name] = (storage as any)[name];
      (storage as any)[name] = fn;
    };
    const restore = () => {
      for (const [name, fn] of Object.entries(orig)) (storage as any)[name] = fn;
    };

    const mkItem = (id: number, title: string, source: string, url: string, priority: number) => ({
      id,
      title,
      normalizedTitle: null,
      source,
      url,
      category: 'general',
      summary: null,
      summaryBullets: null,
      role: 'contributing',
      priorityScore: priority,
      ogImageUrl: null,
      contentKind: null,
      articlePublishedAt: NOW,
      scrapedAt: NOW,
    });

    let replaceCalled = 0;
    stub('getOutletRegistry', async () => []);
    stub('getCuratedStoreItems', async () => [
      mkItem(93001, 'Iran and US nuclear talks collapse after final round in Geneva', 'Reuters', 'https://www.reuters.com/world/iran-us-nuclear-talks-collapse-t7', 71),
      mkItem(93002, 'US-Iran nuclear negotiations break down in final Geneva round', 'Associated Press', 'https://apnews.com/article/iran-us-nuclear-talks-geneva-t7', 70),
      mkItem(93003, 'China unveils new long-range air-to-air missile in Pacific drill', 'Defense News', 'https://www.defensenews.com/air/2026/07/10/china-aam-t7', 69),
      mkItem(93004, 'Beijing shows off new long-range air-to-air missile at Pacific exercise', 'Military Times', 'https://www.militarytimes.com/news/2026/07/10/china-missile-t7', 68),
    ]);
    stub('getCuratedClusterMembers', async () => []);
    stub('getCuratedArchiveOriginationBySignatures', async () => new Map());
    stub('getCuratedArchiveGraceCandidates', async () => []);
    stub('getActiveCuratedManualLinks', async () => []);
    stub('getPrimaryFeed', async () => []);
    stub('replaceCuratedClusterMembers', async () => {
      replaceCalled++;
    });

    let threw = false;
    let laneResult: any = null;
    try {
      laneResult = await clusterCuratedLane({ mode: 'full' });
    } catch (e) {
      threw = true;
      console.error('[timeout-recovery] clusterCuratedLane THREW under in-loop abort:', e);
    } finally {
      restore();
      __setCuratedClusterCompletionForTest(null);
      __setClusterMaxDurationForTest(null);
      __setMaxClustersPerGuardCallForTest(null);
      (openai.chat.completions as any).create = origCreate;
    }

    check('7a in-loop abort: clusterCuratedLane does not throw (AbortError is caught internally)', !threw);
    check(
      '7b in-loop abort: pass returns { stories: 0, members: 0 } (PRESERVE result)',
      !!laneResult && laneResult.stories === 0 && laneResult.members === 0,
      `got ${JSON.stringify(laneResult)}`,
    );
    check(
      '7c in-loop abort: exactly TWO seam calls — grouping + ONE guard batch; the loop broke before batch 2',
      seamCalls === 2,
      `cluster completion seam called ${seamCalls} time(s), expected 2 (grouping + 1 guard batch)`,
    );
    check(
      '7d in-loop abort: no downstream AI phase reached the shared openai client',
      openaiCalls === 0,
      `openai.chat.completions.create called ${openaiCalls} time(s), expected 0`,
    );
    check(
      '7e in-loop abort: destructive replaceCuratedClusterMembers never runs (clusters preserved)',
      replaceCalled === 0,
      `replaceCuratedClusterMembers called ${replaceCalled} time(s)`,
    );
  }

  // -------------------------------------------------------------------------
  if (failures > 0) {
    console.error(`\n[timeout-recovery] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[timeout-recovery] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[timeout-recovery] UNEXPECTED ERROR', e);
  process.exit(1);
});
