/**
 * Curated synthesis-less READ-path render regression (Task #730).
 *
 * Curated "Top Stories" is a two-stage AI pipeline: CLUSTERING groups the
 * corroborating members into a story, then SYNTHESIS writes that story's neutral
 * headline + corroborated facts. The two stages are DECOUPLED on purpose, so a
 * story whose cluster members ARE persisted but whose synthesis row is ABSENT
 * (synthesis timed out / never ran) must STILL render as ONE corroborated card.
 *
 * The companion clustering-side test (scripts/curated-synthesis-outage.test.ts,
 * Task #727) proves the STORAGE-boundary guarantee: on a total synthesis outage
 * the pass does not throw, does not wipe, and persists >= 2 members with a
 * representative. This test proves the OTHER half — the READ side. It drives the
 * SAME code path behind GET /api/curated/top-stories (the real Express handler,
 * booted in-process and hit over loopback with x-mcop-no-cache so BOTH the read
 * cache and the single-flight coalescing are bypassed) against a fixture where:
 *
 *   - the cluster's members ARE persisted (Reuters representative + AP, two
 *     distinct publishers, both confirmed / non-provisional), AND
 *   - the story's synthesis row is ABSENT (getCuratedStorySynthesisMap is empty),
 *     AND
 *   - the members have CHURNED out of the live window (getPrimaryFeed and
 *     getCuratedStoreItems are empty) — so `base` is undefined and the card can
 *     only render from the STORED representative member.
 *
 * The load-bearing assertions: the response contains exactly ONE story for the
 * cluster; its headline is null (no synthesis was written) while its
 * title / url / image fall back to the stored representative member; and its
 * sourceCount is >= 2 (it is a genuinely corroborated cluster, not a degraded
 * single-source card).
 *
 * Stubbing strategy (no test framework, no live AI/network, no DB writes):
 *   `storage` is a mutable singleton, so every read method the handler touches is
 *   shadowed with an in-memory fixture. getCustomMcopBySlug is short-circuited
 *   BEFORE registerRoutes so the fire-and-forget Cyber-MCOP boot seed makes no DB
 *   write. NODE_ENV is unset under tsx, so Express defaults env to 'development'
 *   and requireCuratedAccess returns next() (auth bypassed).
 *
 * Run directly with tsx (no test framework configured):
 *   npx tsx scripts/curated-synthesis-render.test.ts
 * Exits non-zero on any failure.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import { registerRoutes } from '../server/routes';
import { storage } from '../server/storage';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[synthesis-render] OK   ${name}`);
  } else {
    console.error(`[synthesis-render] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const NOW = new Date('2026-07-10T12:00:00Z');
const CLUSTER_ID = 'render-test-cluster-1';

// Two INDEPENDENT trusted outlets covering the SAME event — the exact shape that
// forms a corroborated Curated Top Story: >= 2 corroborating members from >= 2
// distinct publishers. Reuters is the persisted representative.
const REUTERS = {
  id: '90101',
  title: 'Iran and US nuclear talks collapse after final round in Geneva',
  source: 'Reuters',
  url: 'https://www.reuters.com/world/middle-east/iran-us-nuclear-talks-collapse-2026-07-10',
  ogImageUrl: 'https://www.reuters.com/img/iran-talks.jpg',
};
const AP = {
  id: '90102',
  title: 'US-Iran nuclear negotiations break down in final Geneva round',
  source: 'Associated Press',
  url: 'https://apnews.com/article/iran-us-nuclear-talks-geneva-9f2c1',
  ogImageUrl: 'https://apnews.com/img/iran-talks.jpg',
};

// Registry rows that resolve BOTH outlets to a non-blocked 'corroborating'
// behavior (news-international + high factuality). A non-blocked rep that has
// aged out of the live window must still render from its stored row.
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

// Persisted cluster members: Reuters is the representative. Both are confirmed
// (provisional:false) so isConfirmedCuratedMember passes and sourceCount === 2.
function clusterMemberRows(): any[] {
  const common = {
    clusterId: CLUSTER_ID,
    itemType: 'main',
    role: 'contributing',
    behaviorClass: 'corroborating',
    behaviorLabel: 'primary',
    contentKind: null,
    category: 'General',
    summary: null,
    priorityScore: 78,
    provisional: false,
    confirmedStreak: 0,
    publishedAt: NOW,
    createdAt: NOW,
  };
  return [
    {
      ...common,
      id: 'member-reuters',
      itemId: REUTERS.id,
      isRepresentative: true,
      title: REUTERS.title,
      source: REUTERS.source,
      url: REUTERS.url,
      ogImageUrl: REUTERS.ogImageUrl,
    },
    {
      ...common,
      id: 'member-ap',
      itemId: AP.id,
      isRepresentative: false,
      title: AP.title,
      source: AP.source,
      url: AP.url,
      ogImageUrl: AP.ogImageUrl,
      priorityScore: 77,
    },
  ];
}

async function main() {
  // Shadow every storage read the read path touches; short-circuit the boot seed.
  const orig: Record<string, any> = {};
  const stub = (name: string, fn: (...a: any[]) => any) => {
    orig[name] = (storage as any)[name];
    (storage as any)[name] = fn;
  };
  const restore = () => {
    for (const [name, fn] of Object.entries(orig)) (storage as any)[name] = fn;
  };

  // Short-circuit the fire-and-forget Cyber-MCOP boot seed in registerRoutes so
  // it makes no DB write (getCustomMcopBySlug truthy => the IIFE returns early).
  stub('getCustomMcopBySlug', async () => ({ id: 'seed-noop', slug: 'cyber' }));

  // Live window is EMPTY: the members have churned out, so the card can only be
  // rendered from the STORED representative — the exact fallback under test.
  stub('getPrimaryFeed', async () => []);
  stub('getCuratedStoreItems', async () => []);
  // Members ARE persisted; synthesis row is ABSENT.
  stub('getCuratedClusterMembers', async () => clusterMemberRows());
  stub('getCuratedStorySynthesisMap', async () => new Map());
  // Registry resolves both outlets (non-blocked corroborating).
  stub('getOutletRegistry', async () => registryRows());
  // Overlays / editor controls / hydration — all empty for a clean fixture.
  stub('getCuratedPriorityOverrides', async () => new Map());
  stub('getCuratedLinkReplacements', async () => new Map());
  stub('getCuratedHiddenStories', async () => []);
  stub('getCuratedImageReplacements', async () => new Map());
  stub('getCuratedHiddenImages', async () => new Set());
  stub('getCuratedItemsByIds', async () => new Map());
  stub('getCuratedClassificationsByUrls', async () => new Map());

  const app = express();
  const server = await registerRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  let payload: any = null;
  let fetchErr: unknown = null;
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/curated/top-stories?hours=48&limit=40`,
      { headers: { 'x-mcop-no-cache': '1' } },
    );
    check('0 endpoint responds 200', res.status === 200, `status=${res.status}`);
    payload = await res.json();
  } catch (e) {
    fetchErr = e;
    console.error('[synthesis-render] fetch threw:', e);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restore();
  }

  check('1 the read path returned a payload without throwing', !fetchErr && !!payload);

  const stories: any[] = Array.isArray(payload?.stories) ? payload.stories : [];
  const story = stories.find((s) => s.clusterId === CLUSTER_ID);

  check(
    '2 the synthesis-less cluster renders as exactly ONE card',
    stories.filter((s) => s.clusterId === CLUSTER_ID).length === 1,
    `matching cards=${stories.filter((s) => s.clusterId === CLUSTER_ID).length}, total stories=${stories.length}`,
  );

  check(
    '3 the card is genuinely corroborated (sourceCount >= 2)',
    !!story && (story.sourceCount ?? 0) >= 2,
    story ? `sourceCount=${story.sourceCount}` : 'no story',
  );

  check(
    '4 no synthesized headline is shown (synthesis row absent => headline null)',
    !!story && (story.headline === null || story.headline === undefined),
    story ? `headline=${JSON.stringify(story.headline)}` : 'no story',
  );

  check(
    '5 the title falls back to the stored representative member',
    !!story && story.title === REUTERS.title,
    story ? `title=${JSON.stringify(story.title)}` : 'no story',
  );

  check(
    '6 the url falls back to the stored representative member',
    !!story && story.url === REUTERS.url,
    story ? `url=${JSON.stringify(story.url)}` : 'no story',
  );

  check(
    '7 the image falls back to the stored representative member',
    !!story && story.ogImageUrl === REUTERS.ogImageUrl,
    story ? `ogImageUrl=${JSON.stringify(story.ogImageUrl)}` : 'no story',
  );

  // -------------------------------------------------------------------------
  if (failures > 0) {
    console.error(`\n[synthesis-render] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[synthesis-render] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[synthesis-render] UNEXPECTED ERROR', e);
  process.exit(1);
});
