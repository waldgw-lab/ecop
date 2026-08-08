/**
 * Curated AI GARBAGE-recovery regression (Task #728).
 *
 * The sibling suite curated-timeout-recovery.test.ts pins the fail-SAFE contract
 * for THROWN / timeout errors (the whole model chain rejects). But the most
 * common real-world model failure is NOT a throw — it is a 200 OK whose body is
 * malformed or TRUNCATED JSON (the reply hits the token cap mid-array, or the
 * model emits a prose refusal instead of JSON). curated-json-salvage.test.ts
 * covers the low-level parseAiJson / salvageJsonObjectArray helpers, but nothing
 * ties a malformed CLUSTERING reply end-to-end through clusterCuratedLane to
 * prove it also PRESERVES the visible Top Stories rather than mis-parsing the
 * garbage into a partial/empty grouping that WIPES them.
 *
 * The clustering path does NOT use the array-salvage helper — a partially
 * salvaged grouping would silently DROP whichever members fell after the
 * truncation point, quietly shrinking or dissolving real Top Stories. Instead it
 * parses with parseJsonObjectLoose, which returns null for ANY content it cannot
 * fully parse, and identifyCuratedClusters turns that null into the PRESERVE
 * signal ("keep previous clusters"). This suite locks that end-to-end:
 *
 *   1. A TRUNCATED clustering reply (200 OK, unterminated JSON) makes
 *      identifyCuratedClusters return `null` (PRESERVE), NOT `[]` (which would
 *      mean "the model ran and found no clusters" -> WIPE) and NOT a partial
 *      grouping salvaged from the surviving prefix.
 *
 *   2. A well-formed-but-wrong reply (valid JSON object, but "clusters" is not an
 *      array) also returns `null` (PRESERVE) — a schema drift must never be read
 *      as an empty grouping.
 *
 *   3. A pure PROSE refusal (200 OK, no JSON at all) returns `null` (PRESERVE).
 *
 *   4. The real clusterCuratedLane, driven end-to-end with the clustering call
 *      forced to return truncated JSON, returns { stories: 0, members: 0 } AND
 *      never calls replaceCuratedClusterMembers — it PRESERVES, never wipes.
 *
 * These all return a RESOLVED completion (never throw), so they exercise a
 * path the timeout suite cannot reach: the value survives the provider fallback
 * chain and is handed to the parser, where the fail-safe must still hold.
 *
 * Stubbing strategy mirrors curated-timeout-recovery.test.ts:
 *   - Clustering: __setCuratedClusterCompletionForTest swaps in a stub with the
 *     createPreferOpenRouter signature (production leaves it null).
 *   - clusterCuratedLane: shadow the handful of read methods it touches before the
 *     clustering call with in-memory fixtures; replaceCuratedClusterMembers is a
 *     spy that MUST stay uncalled on the preserve path.
 *
 * Run directly with tsx (no test framework configured):
 *   npx tsx scripts/curated-garbage-recovery.test.ts
 * Exits non-zero on any failure.
 */
import {
  identifyCuratedClusters,
  clusterCuratedLane,
  __setCuratedClusterCompletionForTest,
  type LaneNode,
} from '../server/curatedCluster';
import { storage } from '../server/storage';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[garbage-recovery] OK   ${name}`);
  } else {
    console.error(`[garbage-recovery] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// Build a RESOLVED completion whose message content is exactly `content` — the
// 200-OK-with-bad-body case (no throw), which the timeout suite never reaches.
function completionWith(content: string) {
  return async () =>
    ({ choices: [{ message: { content } }] }) as any;
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

// Two same-event corroborating nodes: on a HEALTHY pass these would obviously
// cluster together, so if a garbage reply ever mis-parsed into a partial/empty
// grouping the result would visibly differ from the PRESERVE (null) contract.
function sameEventNodes(): LaneNode[] {
  return [
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
}

async function main() {
  // =========================================================================
  // TEST 1 — a TRUNCATED clustering reply (200 OK, unterminated JSON that hits
  // the token cap mid-array) -> null (PRESERVE). This is the headline case:
  // the reply looks like it is about to form a real cluster (indices [1, 2)
  // but is cut off, so it must be treated as a failure and NOT salvaged into a
  // partial grouping.
  // =========================================================================
  {
    __setCuratedClusterCompletionForTest(
      completionWith('```json\n{"clusters":[{"indices":[1,2'),
    );
    const result = await identifyCuratedClusters(sameEventNodes());
    check(
      '1 truncated JSON clustering reply returns null (PRESERVE), not a partial/empty grouping',
      result === null,
      `got ${JSON.stringify(result)}`,
    );
    __setCuratedClusterCompletionForTest(null);
  }

  // =========================================================================
  // TEST 2 — a reply that is VALID JSON but the wrong shape ("clusters" is not
  // an array) -> null (PRESERVE). Schema drift must not be read as an empty
  // grouping (which would WIPE), and must not throw.
  // =========================================================================
  {
    __setCuratedClusterCompletionForTest(
      completionWith('{"clusters":"oops-not-an-array","note":"model drifted"}'),
    );
    const result = await identifyCuratedClusters(sameEventNodes());
    check(
      '2 valid-JSON-but-wrong-shape reply returns null (PRESERVE), not [] (WIPE)',
      result === null,
      `got ${JSON.stringify(result)}`,
    );
    __setCuratedClusterCompletionForTest(null);
  }

  // =========================================================================
  // TEST 3 — a pure PROSE reply with no JSON at all (200 OK) -> null (PRESERVE).
  // Covers the model refusing / chatting instead of emitting JSON.
  // =========================================================================
  {
    __setCuratedClusterCompletionForTest(
      completionWith("I'm sorry, but I can't help with grouping these headlines."),
    );
    const result = await identifyCuratedClusters(sameEventNodes());
    check(
      '3 non-JSON prose reply returns null (PRESERVE), not a mis-parsed grouping',
      result === null,
      `got ${JSON.stringify(result)}`,
    );
    __setCuratedClusterCompletionForTest(null);
  }

  // =========================================================================
  // TEST 4 — the real clusterCuratedLane, driven end-to-end with the clustering
  // call returning TRUNCATED JSON, PRESERVES clusters: returns
  // { stories: 0, members: 0 } and never wipes (replaceCuratedClusterMembers is
  // never called). This ties the malformed-reply parse contract to the live
  // pass — the piece the json-salvage unit test cannot cover.
  // =========================================================================
  {
    __setCuratedClusterCompletionForTest(
      completionWith('```json\n{"clusters":[{"indices":[1,2'),
    );

    // Shadow only the read methods clusterCuratedLane touches before the
    // clustering call (mirrors curated-timeout-recovery.test.ts TEST 3). This is
    // the CURATED lane, so candidates must come from the CURATED STORE
    // (getCuratedStoreItems), NOT the main feed — seeding via getPrimaryFeed alone
    // would exercise the curated path only incidentally (via the main+curated node
    // union). Empty registry + empty carry/archive/manual-link sets + two fresh
    // curated-store items is the minimal shape that reaches the clustering call
    // with >= 2 candidate nodes (so we skip the "not enough items" wipe branch and
    // land on the malformed-output branch). The main feed is emptied so the ONLY
    // candidates are these curated rows.
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
      console.error('[garbage-recovery] clusterCuratedLane THREW:', e);
    } finally {
      restore();
      __setCuratedClusterCompletionForTest(null);
    }

    check('4a clusterCuratedLane recovers cleanly (does not throw) on a malformed clustering reply', !threw);
    check(
      '4b clusterCuratedLane returns { stories: 0, members: 0 } on a malformed clustering reply',
      !!laneResult && laneResult.stories === 0 && laneResult.members === 0,
      `got ${JSON.stringify(laneResult)}`,
    );
    check(
      '4c clusterCuratedLane PRESERVES clusters — replaceCuratedClusterMembers is never called (no wipe)',
      replaceCalled === 0,
      `replaceCuratedClusterMembers called ${replaceCalled} time(s)`,
    );
  }

  // -------------------------------------------------------------------------
  if (failures > 0) {
    console.error(`\n[garbage-recovery] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[garbage-recovery] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[garbage-recovery] UNEXPECTED ERROR', e);
  process.exit(1);
});
