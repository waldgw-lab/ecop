/**
 * Curated synthesis-only outage regression (Task #727).
 *
 * Curated "Top Stories" is a two-stage AI pipeline: CLUSTERING groups the
 * corroborating members into a story, then SYNTHESIS writes that story's neutral
 * headline + corroborated facts. The two stages are DECOUPLED on purpose —
 * synthesizeFormedStories is wrapped non-fatal, and a synthesizeStory that
 * returns null just skips its synthesis upsert. The load-bearing guarantee is:
 *
 *   When clustering SUCCEEDS (>= 2 corroborating members from >= 2 distinct
 *   publishers form a story) but EVERY synthesizeStory call times out, the
 *   formed story must STILL surface — its members are persisted (with a
 *   representative), the pass does not throw, and it does NOT wipe.
 *
 * The read path then renders that story from its stored representative member
 * (title / url / image) even though the synthesized anchor never got written.
 *
 * This is the COMPLEMENT of curated-timeout-recovery.test.ts, which pins the
 * OTHER failure mode (a CLUSTERING outage must PRESERVE, i.e. NOT wipe). Here
 * clustering succeeds and only synthesis is down, so the correct behavior is the
 * opposite of "preserve": the story genuinely forms and members ARE written.
 *
 * Stubbing strategy (no test framework, no live AI/network/DB):
 *   - Clustering: swapped via the test-only injection seam
 *     (__setCuratedClusterCompletionForTest) with a CONTENT-AWARE stub that
 *     reads each prompt and returns the deterministic "success" shape for the
 *     grouping call (group both nodes) and a keep-all shape for every refinement
 *     pass (coherence guard / adversary attach / anchor-split).
 *   - Synthesis: openai.chat.completions.create is a mutable method, replaced
 *     with a stub that throws a transient timeout for EVERY call — the total
 *     synthesis outage.
 *   - clusterCuratedLane: `storage` is a mutable instance, so every read method
 *     the pass touches is shadowed with an in-memory fixture; the two write
 *     methods that matter (replaceCuratedClusterMembers, upsertCuratedStorySynthesis)
 *     are spies.
 *
 * Run directly with tsx (no test framework configured):
 *   npx tsx scripts/curated-synthesis-outage.test.ts
 * Exits non-zero on any failure.
 */
import {
  clusterCuratedLane,
  __setCuratedClusterCompletionForTest,
} from '../server/curatedCluster';
import { openai } from '../server/aiClient';
import { storage } from '../server/storage';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[synthesis-outage] OK   ${name}`);
  } else {
    console.error(`[synthesis-outage] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// A transient-shaped timeout rejection (isTransientAIError treats ETIMEDOUT as a
// provider failure), so the synthesis chain walks EVERY provider before giving
// up — the all-providers-down worst case that a real outage produces.
function makeTimeoutError(): Error {
  const e = new Error('simulated synthesis timeout') as Error & { code?: string };
  e.code = 'ETIMEDOUT';
  return e;
}

// Anchor the fixture to the REAL current time. clusterCuratedLane applies a
// staleness phase-out (isClusterPhasedOut, ~22h cap) to freshly-formed clusters
// using each member's publishedAt vs Date.now(). A hardcoded calendar date makes
// the fixture cluster "age out" once wall-clock time passes it, so the story
// silently stops forming (0 stories) days later with no code change — a harness
// time-bomb. Seeding at "now" keeps the members inside the phase-out window.
const NOW = new Date();

// Two INDEPENDENT trusted outlets covering the SAME event — the exact shape that
// forms a corroborated Curated Top Story: >= 2 corroborating members from >= 2
// distinct publishers, published within the same-event window.
const REUTERS = {
  id: 90101,
  title: 'Iran and US nuclear talks collapse after final round in Geneva',
  source: 'Reuters',
  url: 'https://www.reuters.com/world/middle-east/iran-us-nuclear-talks-collapse-2026-07-10',
};
const AP = {
  id: 90102,
  title: 'US-Iran nuclear negotiations break down in final Geneva round',
  source: 'Associated Press',
  url: 'https://apnews.com/article/iran-us-nuclear-talks-geneva-9f2c1',
};

// Registry rows that resolve BOTH outlets to cls 'corroborating'
// (news-international + high factuality => deriveBehavior corroborating).
function registryRows(): any[] {
  return [
    {
      key: 'reuters',
      canonicalName: 'Reuters',
      aliases: [],
      domains: ['reuters.com'],
      sourceIdentifier: 'news-international',
      factuality: 'high',
      ownership: [],
      manualOverrides: {},
      otherSourceType: null,
    },
    {
      key: 'associated-press',
      canonicalName: 'Associated Press',
      aliases: ['AP'],
      domains: ['apnews.com'],
      sourceIdentifier: 'news-international',
      factuality: 'high',
      ownership: [],
      manualOverrides: {},
      otherSourceType: null,
    },
  ];
}

// Content-aware clustering stub. Every curated clustering AI call routes through
// the injection seam, so ONE stub must answer all of them. It reads the prompt
// and returns the deterministic SUCCESS shape per pass:
//   - grouping         -> group node #1 and #2 into ONE cluster {indices:[1,2]}
//   - coherence guard  -> remove nothing (keep the whole cluster)
//   - adversary attach -> no adversary matches
//   - anchor-split     -> no split decisions
// so the two corroborating nodes reach the formation gate together and FORM.
function makeClusteringStub(counter: { calls: number }) {
  return async (body: any) => {
    counter.calls++;
    const prompt: string = body?.messages?.[0]?.content ?? '';
    let obj: unknown;
    if (prompt.includes('same_event_attach')) {
      obj = { decisions: [] }; // anchor-split: keep all
    } else if (prompt.includes('ADVERSARY HEADLINES')) {
      obj = { matches: [] }; // semantic adversary attach: nothing
    } else if (prompt.includes('SUPPOSED to contain only')) {
      obj = { clusters: [{ cluster: 1, remove: [] }] }; // coherence guard: keep all
    } else if (prompt.includes('identify groups that cover')) {
      obj = { clusters: [{ indices: [1, 2] }] }; // grouping: one cluster of both
    } else {
      obj = {}; // any other refinement pass: fail-safe no-op
    }
    return { choices: [{ message: { content: JSON.stringify(obj) } }] } as any;
  };
}

async function main() {
  const clusterCounter = { calls: 0 };
  __setCuratedClusterCompletionForTest(makeClusteringStub(clusterCounter));

  // Total synthesis outage: every synthesizeStory model call times out.
  const origCreate = openai.chat.completions.create;
  let synthCalls = 0;
  (openai.chat.completions as any).create = async () => {
    synthCalls++;
    throw makeTimeoutError();
  };

  // Shadow every storage read the lane touches; spy on the writes that matter.
  const orig: Record<string, any> = {};
  const stub = (name: string, fn: (...a: any[]) => any) => {
    orig[name] = (storage as any)[name];
    (storage as any)[name] = fn;
  };
  const restore = () => {
    for (const [name, fn] of Object.entries(orig)) (storage as any)[name] = fn;
  };

  let replacedMembers: any[] | null = null;
  let synthUpserts = 0;

  stub('getOutletRegistry', async () => registryRows());
  stub('getCuratedClusterMembers', async () => []);
  stub('getCuratedArchiveOriginationBySignatures', async () => new Map());
  stub('getCuratedArchiveGraceCandidates', async () => []);
  stub('getActiveCuratedManualLinks', async () => []);
  stub('getActiveCuratedSplitOverlays', async () => []);
  stub('getCuratedClassificationsByUrls', async () => new Map());
  stub('getCuratedStorySynthesisMap', async () => new Map());
  stub('pruneCuratedStorySynthesisNotIn', async () => {});
  stub('pruneCuratedStoryArchive', async () => {});
  stub('upsertCuratedStoryArchive', async () => {});
  stub('upsertCuratedSplitOverlay', async () => {});
  stub('bumpCuratedMemberConfirmation', async () => 1);
  stub('pruneCuratedMemberConfirmations', async () => {});
  stub('recordCuratedClusterMetrics', async () => {});
  stub('upsertCuratedStorySynthesis', async () => {
    synthUpserts++;
  });
  // clusterCuratedLane draws candidates from the UNION of getPrimaryFeed (main
  // feed) AND getCuratedStoreItems (the curated store). To prove the CURATED path
  // end-to-end we seed the curated store and INTENTIONALLY EMPTY the main feed, so
  // the only candidates are these two curated rows and the formed story is
  // genuinely a curated-lane story (members keyed `curated:*`); seeding via
  // getPrimaryFeed instead would pass incidentally on `main:*` nodes.
  stub('getPrimaryFeed', async () => []);
  // Two INDEPENDENT trusted curated rows covering the SAME event, FULLY ENRICHED
  // (real headline + AI summary bullets + non-favicon image) so each can seed and
  // stand as the story's representative — the content-completeness seeding gate
  // (isNodeFullyEnriched) prefers an enriched face, and the read path renders the
  // synthesis-less story from that stored representative member.
  stub('getCuratedStoreItems', async () => [
    {
      id: REUTERS.id,
      title: REUTERS.title,
      normalizedTitle: null,
      source: REUTERS.source,
      url: REUTERS.url,
      category: 'general',
      summary: 'Iran and the US ended nuclear talks without a deal after the final Geneva round.',
      summaryBullets: [
        'Talks in Geneva ended without agreement after the final round.',
        'Both delegations left without scheduling further negotiations.',
      ],
      role: 'contributing',
      priorityScore: 78,
      ogImageUrl: 'https://www.reuters.com/img/iran-talks.jpg',
      contentKind: null,
      articlePublishedAt: NOW,
      scrapedAt: NOW,
    },
    {
      id: AP.id,
      title: AP.title,
      normalizedTitle: null,
      source: AP.source,
      url: AP.url,
      category: 'general',
      summary: 'US-Iran nuclear negotiations broke down during the final round in Geneva.',
      summaryBullets: [
        'Negotiations broke down in the final Geneva round.',
        'No new date was set to resume the talks.',
      ],
      role: 'contributing',
      priorityScore: 77,
      ogImageUrl: 'https://apnews.com/img/iran-talks.jpg',
      contentKind: null,
      articlePublishedAt: NOW,
      scrapedAt: NOW,
    },
  ]);
  stub('replaceCuratedClusterMembers', async (members: any[]) => {
    replacedMembers = members;
  });

  let threw = false;
  let laneResult: any = null;
  try {
    laneResult = await clusterCuratedLane({ mode: 'full' });
  } catch (e) {
    threw = true;
    console.error('[synthesis-outage] clusterCuratedLane THREW:', e);
  } finally {
    restore();
    (openai.chat.completions as any).create = origCreate;
    __setCuratedClusterCompletionForTest(null);
  }

  // -- The pass survives the synthesis outage without crashing or wiping. -----
  check('1 clusterCuratedLane does not throw on a total synthesis outage', !threw);

  check(
    '2 the grouping stage actually ran (clustering AI seam was invoked)',
    clusterCounter.calls >= 1,
    `clustering stub called ${clusterCounter.calls} time(s)`,
  );

  check(
    '3 synthesis was genuinely attempted and every call timed out (the outage was exercised)',
    synthCalls >= 1,
    `synthesis AI call invoked ${synthCalls} time(s)`,
  );

  check(
    '4 no synthesis row is written when every synthesizeStory call times out',
    synthUpserts === 0,
    `upsertCuratedStorySynthesis called ${synthUpserts} time(s)`,
  );

  // -- The formed story STILL surfaces despite the synthesis outage. ----------
  check(
    '5 the story still FORMS despite the synthesis outage (stories >= 1, members >= 2)',
    !!laneResult && laneResult.stories >= 1 && laneResult.members >= 2,
    `got ${JSON.stringify(laneResult)}`,
  );

  check(
    '6 members are PERSISTED (not wiped) — replaceCuratedClusterMembers written with >= 2 members',
    Array.isArray(replacedMembers) && replacedMembers!.length >= 2,
    `replaceCuratedClusterMembers wrote ${
      Array.isArray(replacedMembers) ? replacedMembers!.length : 'nothing'
    }`,
  );

  // The read path renders a synthesis-less story from its stored representative
  // member — so the persisted set MUST carry a representative with a title/url.
  const rep = Array.isArray(replacedMembers)
    ? replacedMembers!.find((m: any) => m.isRepresentative)
    : undefined;
  check(
    '7 exactly one member is flagged representative (the story renders from it)',
    Array.isArray(replacedMembers) &&
      replacedMembers!.filter((m: any) => m.isRepresentative).length === 1,
    `representatives=${
      Array.isArray(replacedMembers)
        ? replacedMembers!.filter((m: any) => m.isRepresentative).length
        : 'n/a'
    }`,
  );
  check(
    '8 the representative carries the display fields the read path renders (title + url)',
    !!rep && typeof rep.title === 'string' && rep.title.length > 0 && typeof rep.url === 'string' && rep.url.length > 0,
    rep ? `title=${JSON.stringify(rep.title)} url=${JSON.stringify(rep.url)}` : 'no representative',
  );

  const distinctUrls = Array.isArray(replacedMembers)
    ? new Set(replacedMembers!.map((m: any) => m.url)).size
    : 0;
  check(
    '9 the persisted story is genuinely corroborated (>= 2 distinct publisher URLs)',
    distinctUrls >= 2,
    `distinct member urls=${distinctUrls}`,
  );

  // -------------------------------------------------------------------------
  if (failures > 0) {
    console.error(`\n[synthesis-outage] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[synthesis-outage] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[synthesis-outage] UNEXPECTED ERROR', e);
  process.exit(1);
});
