/**
 * Gate: curated-revision-signal (Task #817)
 *
 * Proves the ~12-second curated change signal actually FIRES for every editor
 * action. Curated viewers poll GET /api/curated/revision (a per-process
 * counter, zero-cost) and refetch the feed when the number changes. The
 * counter is bumped inside routes.ts `invalidateCuratedCache`, so any write
 * endpoint that performs a feed-shaping edit but forgets to call
 * invalidateCuratedCache silently breaks live propagation for that action
 * type — viewers fall back to the slow 120s timer without knowing it.
 *
 * This harness boots the REAL Express routes in-process (same pattern as
 * scripts/curated-synthesis-render.test.ts), exercises each curated write
 * endpoint over loopback, and asserts the revision counter INCREMENTED after
 * each one. Covered actions (the task's minimum set):
 *
 *   hide-story, link-items, unlink, replace-link, hide-image, replace-image,
 *   replace-headline, classification, priority-override
 *
 * Stubbing strategy (no test framework, no live AI, no DB writes):
 *   `storage` is a mutable singleton — every write method the endpoints touch
 *   is shadowed with an in-memory no-op, and the read helpers used by the
 *   snapshot/prewarm paths return empty fixtures. getCustomMcopBySlug is
 *   short-circuited BEFORE registerRoutes so the fire-and-forget Cyber-MCOP
 *   boot seed makes no DB write. getCuratedFeedbackSettings reports
 *   capturePaused so no override-log rows are recorded. NODE_ENV is unset
 *   under tsx, so Express defaults env to 'development' and the curated
 *   editor gates return next() (auth bypassed — this gate tests the SIGNAL,
 *   not the auth tier; scripts/curated-revision-auth.test.ts guards that).
 *
 * replace-link / replace-image validate their URL through the real
 * isPublicFetchableUrl SSRF guard (live DNS on a well-known public host). If
 * that network precondition fails, the run exits 3 (INCONCLUSIVE per the
 * harness-reliability convention) instead of reporting a false regression.
 *
 * Run: npx tsx scripts/curated-revision-signal.test.ts
 * Exit 0 = pass, 1 = fail, 3 = inconclusive (network precondition).
 */
import express from 'express';
import type { AddressInfo } from 'net';
import { registerRoutes } from '../server/routes';
import { storage } from '../server/storage';

let failures = 0;
let inconclusive = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[revision-signal] OK   ${name}`);
  } else {
    console.error(`[revision-signal] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// A well-known public host for the two endpoints that run the REAL
// isPublicFetchableUrl SSRF guard (live DNS). Failure to resolve it is a
// network precondition problem, not a revision-signal regression.
const PUBLIC_URL = 'https://www.reuters.com/world/revision-signal-test';

async function main() {
  // ---------------------------------------------------------------------------
  // Storage stubs — writes become in-memory no-ops; reads return empty fixtures.
  // ---------------------------------------------------------------------------
  const orig: Record<string, any> = {};
  const stub = (name: string, fn: (...a: any[]) => any) => {
    orig[name] = (storage as any)[name];
    (storage as any)[name] = fn;
  };
  const restore = () => {
    for (const [name, fn] of Object.entries(orig)) (storage as any)[name] = fn;
  };

  // Short-circuit the fire-and-forget Cyber-MCOP boot seed (no DB write).
  stub('getCustomMcopBySlug', async () => ({ id: 'seed-noop', slug: 'cyber' }));

  // Coordinated manual mutations now fail closed when durable evidence capture
  // is paused. Keep capture active and route it into the synthetic atomic adapter
  // below so this remains a no-DB revision-signal harness.
  stub('getCuratedFeedbackSettings', async () => ({ capturePaused: false }));

  // Snapshot-resolution reads (resolveCuratedOverrideSnapshot) — all empty.
  stub('getCuratedItemsByIds', async () => new Map());
  stub('getCuratedItemByUrl', async () => null);
  stub('getCuratedClusterMemberByItem', async () => null);
  stub('getCuratedClusterMembersByClusterId', async () => []);
  stub('getHeadlineById', async () => null);
  stub('getManualSubmissionById', async () => null);
  stub('getCuratedClassificationsByUrls', async () => new Map());

  // Read-path stubs so the warm-on-write top-stories prewarmer (fired by
  // invalidateCuratedCache) completes instantly against empty fixtures.
  stub('getPrimaryFeed', async () => []);
  stub('getCuratedStoreItems', async () => []);
  stub('getCuratedClusterMembers', async () => []); // also: reshape no-ops fail-closed
  stub('getCuratedStorySynthesisMap', async () => new Map());
  stub('getOutletRegistry', async () => []);
  stub('getCuratedPriorityOverrides', async () => new Map());
  stub('getCuratedLinkReplacements', async () => new Map());
  stub('getCuratedHiddenStories', async () => []);
  stub('getCuratedImageReplacements', async () => new Map());
  stub('getCuratedHiddenImages', async () => new Set());

  // Write methods under test — in-memory no-ops (nothing touches the DB).
  let evidenceCaptureCount = 0;
  const mutationOrder: string[] = [];
  let manualLink: any = null;
  stub('setCuratedHiddenStory', async () => {});
  stub('removeCuratedHiddenStory', async () => {});
  stub('captureCuratedOverrideEvidenceAtomic', async (_event: any, captureEpisode: Function) => {
    evidenceCaptureCount++;
    mutationOrder.push('capture');
    const eventId = `rev-sig-event-${evidenceCaptureCount}`;
    const episodeId = await captureEpisode(eventId, {
      upsertCuratedEditorialEpisode: async () => ({ id: `rev-sig-episode-${evidenceCaptureCount}` }),
      attachCuratedEditorialEpisodeEvents: async () => {},
      findLatestCuratedEditorialEpisodeForIdentity: async () => undefined,
      updateCuratedEditorialOutcome: async () => undefined,
    });
    if (!episodeId) throw new Error('synthetic durable episode was not persisted');
    return { eventId, episodeId };
  });
  stub('getActiveCuratedManualLinks', async () => manualLink?.status === 'active' ? [manualLink] : []);
  stub('createCuratedManualLinkConsolidated', async (row: any) => {
    mutationOrder.push('apply-link');
    manualLink = {
      id: 'rev-sig-link-1',
      status: 'active',
      kind: row?.kind === 'merge' ? 'merge' : 'link',
      label: row?.label ?? '',
      memberUrls: row?.memberUrls ?? [],
      overrodeAi: false,
      ...row,
    };
    return {
      row: manualLink,
      effectiveMemberUrls: manualLink.memberUrls,
      effectiveKind: manualLink.kind,
      supersededIds: [],
    };
  });
  stub('getCuratedManualLink', async (id: string) =>
    manualLink?.id === id ? manualLink : undefined);
  stub('revokeCuratedManualLink', async (id: string) => {
    mutationOrder.push('apply-unlink');
    if (manualLink?.id !== id || manualLink.status !== 'active') return undefined;
    manualLink.status = 'revoked';
    return manualLink;
  });
  stub('setCuratedLinkReplacement', async () => {});
  stub('applyCuratedLinkReplacement', async () => {});
  stub('setCuratedImageReplacement', async () => {});
  stub('setCuratedHeadlineOverride', async () => {});
  stub('setCuratedHiddenImage', async () => {});
  stub('removeCuratedHiddenImage', async () => {});
  stub('setCuratedPriorityOverride', async () => {});
  stub('upsertCuratedClassifications', async () => {});

  // ---------------------------------------------------------------------------
  // Boot the real routes.
  // ---------------------------------------------------------------------------
  const app = express();
  app.use(express.json());
  const server = await registerRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const readRevision = async (): Promise<number> => {
    const res = await fetch(`${base}/api/curated/revision`);
    if (res.status !== 200) throw new Error(`/api/curated/revision status=${res.status}`);
    const body = await res.json();
    if (typeof body?.revision !== 'number') throw new Error('revision missing from payload');
    return body.revision;
  };

  type Action = {
    name: string;
    path: string;
    body: Record<string, unknown>;
    /** SSRF-guarded endpoints do live DNS — a 400 there is a network precondition. */
    networkPrecondition?: boolean;
  };

  const actions: Action[] = [
    {
      name: 'hide-story',
      path: '/api/curated/hide-story',
      body: { scope: 'standalone', type: 'curated', id: 'rev-sig-item-1', hidden: true },
    },
    {
      name: 'link-items',
      path: '/api/curated/link-items',
      body: {
        memberUrls: ['https://example.com/rev-sig-a', 'https://example.org/rev-sig-b'],
        kind: 'link',
        label: 'revision-signal test link',
      },
    },
    {
      name: 'unlink',
      path: '/api/curated/unlink',
      body: { id: 'rev-sig-link-1' },
    },
    {
      name: 'replace-link',
      path: '/api/curated/replace-link',
      body: { type: 'curated', id: 'rev-sig-item-1', url: PUBLIC_URL },
      networkPrecondition: true,
    },
    {
      name: 'hide-image',
      path: '/api/curated/hide-image',
      body: { imageUrl: 'https://example.com/rev-sig-image.jpg', hidden: true },
    },
    {
      name: 'replace-image',
      path: '/api/curated/replace-image',
      body: { type: 'curated', id: 'rev-sig-item-1', url: PUBLIC_URL },
      networkPrecondition: true,
    },
    {
      name: 'replace-headline',
      path: '/api/curated/replace-headline',
      body: {
        scope: 'standalone', type: 'curated', id: 'rev-sig-item-1',
        headline: 'Revision signal test headline',
      },
    },
    {
      name: 'classification',
      path: '/api/curated/classification',
      body: {
        url: 'https://example.com/rev-sig-a',
        primaryTopic: 'Foreign Policy & Diplomacy',
      },
    },
    {
      name: 'priority-override',
      path: '/api/curated/priority-override',
      body: { scope: 'standalone', type: 'curated', id: 'rev-sig-item-1', priorityScore: 75 },
    },
  ];

  try {
    for (const action of actions) {
      const before = await readRevision();
      const res = await fetch(`${base}${action.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action.body),
      });
      let bodyText = '';
      try { bodyText = await res.text(); } catch { /* ignore */ }

      if (action.networkPrecondition && res.status === 400 && /publicly fetchable/i.test(bodyText)) {
        // The real SSRF guard could not DNS-resolve the public host — a network
        // precondition failure, not a revision-signal regression.
        console.warn(`[revision-signal] INCONCLUSIVE ${action.name} — SSRF guard could not resolve public host (network precondition)`);
        inconclusive++;
        continue;
      }

      check(
        `${action.name}: endpoint accepted the write (2xx)`,
        res.status >= 200 && res.status < 300,
        `status=${res.status} body=${bodyText.slice(0, 200)}`,
      );

      const after = await readRevision();
      check(
        `${action.name}: /api/curated/revision incremented (${before} -> ${after})`,
        after > before,
        `revision did not change — this action's edits are invisible to the 12s poll`,
      );
    }
    check(
      'strict evidence capture precedes both coordinated link writes',
      evidenceCaptureCount === 2
        && mutationOrder.join('|') === 'capture|apply-link|capture|apply-unlink',
      mutationOrder.join(' -> '),
    );
  } catch (e) {
    check('harness ran without unexpected errors', false, e instanceof Error ? e.message : String(e));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restore();
  }

  if (failures > 0) {
    console.error(`\n[revision-signal] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  if (inconclusive > 0) {
    console.warn(`\n[revision-signal] no failures, but ${inconclusive} action(s) INCONCLUSIVE (network precondition)`);
    process.exit(3);
  }
  console.log('\n[revision-signal] all revision-signal checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[revision-signal] UNEXPECTED ERROR', e);
  process.exit(1);
});
