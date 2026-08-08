/**
 * Curated manual link/merge speed-refactor regression (Task #745).
 *
 * The editor "link / merge" action (POST /api/curated/link-items) was refactored
 * for speed: the handler now returns FAST — it runs ONE deterministic re-shape
 * synchronously (zero AI cost), verifies the merge actually landed, invalidates
 * the curated read cache, and kicks the AI headline/facts synthesis off in the
 * BACKGROUND so the editor is never blocked on it. Unlink likewise no longer
 * polls for clustering to go idle. The load-bearing guarantees this gate pins:
 *
 *   FAST PATH (clustering idle):
 *     - POST link-items on two corroborating standalone items returns
 *       `formed: true` (the merge genuinely landed under ONE clusterId).
 *     - The synchronous re-shape actually WROTE a single clusterId covering both
 *       linked URLs (a real must-link merge, not a false success).
 *     - The curated read cache is invalidated so the next poll recomputes.
 *
 *   BUSY PATH (a full clustering pass holds the lock):
 *     - The merge is NOT silently dropped to the next ~5-min cron. A pending
 *       deferred re-shape (schedulePendingManualReshape) fires the INSTANT the
 *       lock frees — verified by driving a lock-holding pass to completion and
 *       observing the deferred re-shape run (a 2nd persistence write + a bus
 *       cache invalidation) after it releases.
 *
 * A regression here (e.g. the handler awaits synthesis again, or the deferred
 * hook stops firing) would strand a merge invisibly until the next cron — the
 * exact silent failure this refactor was meant to remove.
 *
 * Stubbing strategy (no test framework, no live AI/network/DB):
 *   - `storage` is a mutable singleton — every read the lane + route touch is
 *     shadowed with an in-memory fixture; cluster-member reads/writes are backed
 *     by ONE in-memory store so the route's post-reshape formation check sees
 *     exactly what the re-shape wrote.
 *   - Re-shape mode calls NO grouping/coherence/adversary/anchor LLM; the manual
 *     link alone stands up the group (curatedCluster.ts reconcile). The only AI
 *     call reachable is background synthesis (forceSynthesis) via
 *     openai.chat.completions.create — stubbed to a benign parseable response.
 *   - The curated clustering completion seam is stubbed to a safe no-op in case
 *     any refinement pass is reached.
 *
 * Run directly with tsx (deterministic — no inconclusive3):
 *   npx tsx scripts/curated-manual-link.test.ts
 * Exits 0 on pass, 1 on any failure.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import { storage } from '../server/storage';
import { openai } from '../server/aiClient';
import {
  __setCuratedClusterCompletionForTest,
  isCuratedClusteringRunning,
  schedulePendingManualReshape,
  reshapeCuratedLane,
} from '../server/curatedCluster';
import {
  __setManualLinkCompletionForTest,
  __setManualLinkReviewBackstopForTest,
  buildManualLinkReviewPrompt,
  MANUAL_LINK_REVIEW_LIMIT,
  reviewManualLink,
  selectRecentManualLinkReviewItems,
} from '../server/curatedManualLink';
import { CURATED_EVENT_IDENTITY_GUIDANCE } from '../server/curatedEventIdentityGuidance';
import { registerCuratedCacheInvalidator } from '../server/curatedCacheBus';
import { normalizeIdentityUrl } from '../server/urlIdentity';
import { readFileSync } from 'fs';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[manual-link] OK   ${name}`);
  } else {
    console.error(`[manual-link] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// Fresh relative to the real system clock so the fixture never trips the
// curated staleness / phase-out age cap (which is measured against Date.now()).
const NOW = new Date();

// Two INDEPENDENT trusted outlets covering the SAME event — the shape that CAN
// form a corroborated Curated Top Story (>= 2 corroborating members from >= 2
// distinct publishers) once the editor manual-link forces them together.
const REUTERS = {
  id: 74501,
  title: 'Iran and US nuclear talks collapse after final round in Geneva',
  source: 'Reuters',
  url: 'https://www.reuters.com/world/middle-east/iran-us-nuclear-talks-collapse-2026-07-11',
};
const AP = {
  id: 74502,
  title: 'US-Iran nuclear negotiations break down in final Geneva round',
  source: 'Associated Press',
  url: 'https://apnews.com/article/iran-us-nuclear-talks-geneva-74502',
};
const OFFICIAL_X = {
  id: 'social-x-74503',
  title: 'Department of Defense statement on the Geneva talks',
  source: 'DeptofDefense',
  url: 'https://x.com/DeptofDefense/status/1900123456789012345?utm_source=copy_link',
};
const TRUTH_SOCIAL = {
  id: 'social-truth-74504',
  title: 'POTUS statement on the Geneva talks',
  source: 'POTUS',
  url: 'https://truthsocial.com/@realDonaldTrump/114000000000000000?at_medium=social',
};

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
      key: 'social-us-official',
      canonicalName: 'U.S. Official Social',
      aliases: ['DeptofDefense', 'POTUS'],
      domains: ['x.com', 'truthsocial.com'],
      sourceIdentifier: 'social-us-official',
      factuality: 'high',
      ownership: [],
      manualOverrides: {},
      otherSourceType: 'social',
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

function primaryFeedRows(): any[] {
  return [
    {
      id: REUTERS.id,
      title: REUTERS.title,
      source: REUTERS.source,
      url: REUTERS.url,
      category: 'general',
      normalizedTitle: null,
      priorityScore: 78,
      ogImageUrl: 'https://www.reuters.com/img/iran-talks.jpg',
      articlePublishedAt: NOW,
      scrapedAt: NOW,
      summary: 'The same-track Geneva negotiations ended without an agreement.',
      summaryBullets: ['Officials confirmed the final round ended without a deal.'],
      type: 'scraped',
    },
    {
      id: AP.id,
      title: AP.title,
      source: AP.source,
      url: AP.url,
      category: 'general',
      normalizedTitle: null,
      priorityScore: 77,
      ogImageUrl: 'https://apnews.com/img/iran-talks.jpg',
      articlePublishedAt: NOW,
      scrapedAt: NOW,
      summary: 'Negotiators confirmed the Geneva track had broken down.',
      summaryBullets: ['Both delegations left the same negotiation round.'],
      type: 'scraped',
    },
  ];
}

function curatedSocialRows(): any[] {
  return [OFFICIAL_X, TRUTH_SOCIAL].map((post) => ({
    id: post.id,
    title: post.title,
    source: post.source,
    url: post.url,
    category: 'general',
    normalizedTitle: null,
    priorityScore: 50,
    ogImageUrl: null,
    articlePublishedAt: NOW,
    scrapedAt: NOW,
    summary: post.title,
  }));
}

// A safe no-op curated clustering completion (in case any refinement pass is
// reached — re-shape mode should not call the grouping/coherence LLM at all).
let reviewCompletion: 'concur' | 'object' | 'malformed' | 'error' = 'concur';
let lastReviewPrompt = '';
function safeCompletionStub() {
  return async (body: any) => {
    const prompt: string = body?.messages?.[0]?.content ?? '';
    let obj: unknown;
    if (prompt.includes("newsroom editor's assistant reviewing")) {
      lastReviewPrompt = prompt;
      if (reviewCompletion === 'error') throw new Error('synthetic provider outage');
      if (reviewCompletion === 'malformed') {
        return { choices: [{ message: { content: 'not-json' } }] } as any;
      }
      obj = reviewCompletion === 'object'
        ? { verdict: 'object', rationale: 'downstream market effect', reasoning: 'The price reaction is separate from the strike.' }
        : { verdict: 'concur', rationale: 'same negotiation track/status update', reasoning: 'These are status angles of the same talks.' };
    } else if (prompt.includes('same_event_attach')) obj = { decisions: [] };
    else if (prompt.includes('ADVERSARY HEADLINES')) obj = { matches: [] };
    else if (prompt.includes('SUPPOSED to contain only')) obj = { clusters: [] };
    else if (prompt.includes('identify groups that cover')) obj = { clusters: [] };
    else obj = {};
    return { choices: [{ message: { content: JSON.stringify(obj) } }] } as any;
  };
}

// ---------------------------------------------------------------------------
// In-memory fixture state shared by every stub.
// ---------------------------------------------------------------------------
let clusterMembersStore: any[] = [];
let writeCount = 0;
const manualLinks: any[] = [];
const mutationOrder: string[] = [];
let evidenceCaptureCount = 0;

const origStorage: Record<string, any> = {};
function stub(name: string, fn: (...a: any[]) => any) {
  origStorage[name] = (storage as any)[name];
  (storage as any)[name] = fn;
}
function restoreStorage() {
  for (const [name, fn] of Object.entries(origStorage)) (storage as any)[name] = fn;
}

function installStorageStubs() {
  // Reads reachable in re-shape mode.
  stub('getOutletRegistry', async () => registryRows());
  stub('getPrimaryFeed', async () => primaryFeedRows());
  stub('getCuratedStoreItems', async () => curatedSocialRows());
  stub('getCuratedClusterMembers', async () => clusterMembersStore);
  stub('getCuratedArchiveOriginationBySignatures', async () => new Map());
  stub('getCuratedArchiveGraceCandidates', async () => []);
  stub('getActiveCuratedManualLinks', async () => manualLinks.filter((m) => m.status === 'active'));
  stub('getActiveCuratedSplitOverlays', async () => []);
  stub('getCuratedClassificationsByUrls', async () => new Map());
  stub('getCuratedStorySynthesisMap', async () => new Map());
  stub('pruneCuratedStorySynthesisNotIn', async () => {});
  stub('pruneCuratedStoryArchive', async () => {});
  stub('upsertCuratedStoryArchive', async () => {});
  stub('upsertCuratedSplitOverlay', async () => {});
  stub('bumpCuratedMemberConfirmation', async () => 2);
  stub('pruneCuratedMemberConfirmations', async () => {});
  stub('recordCuratedClusterMetrics', async () => {});
  stub('upsertCuratedStorySynthesis', async () => {});
  // THE write under test — persist to the in-memory store so the route's
  // post-reshape formation check reads exactly what the re-shape wrote.
  stub('replaceCuratedClusterMembers', async (members: any[]) => {
    clusterMembersStore = members;
    writeCount++;
  });
  // Route-only writes. Required evidence capture runs before the authoritative
  // overlay write, so the no-DB harness supplies a transaction-scoped adapter
  // rather than weakening the production fail-closed path.
  stub('captureCuratedOverrideEvidenceAtomic', async (_event: any, captureEpisode: Function) => {
    evidenceCaptureCount++;
    mutationOrder.push('capture');
    const eventId = `event-${evidenceCaptureCount}`;
    const episodeId = await captureEpisode(eventId, {
      upsertCuratedEditorialEpisode: async () => ({ id: `episode-${evidenceCaptureCount}` }),
      attachCuratedEditorialEpisodeEvents: async () => {},
      findLatestCuratedEditorialEpisodeForIdentity: async () => undefined,
      updateCuratedEditorialOutcome: async () => undefined,
    });
    if (!episodeId) throw new Error('synthetic durable episode was not persisted');
    return { eventId, episodeId };
  });
  stub('createCuratedManualLinkConsolidated', async (row: any, options: any) => {
    mutationOrder.push('apply');
    const requestedUrls = Array.from(new Set<string>(row.memberUrls ?? []));
    const selected = new Set(requestedUrls);
    const unioned = new Set(requestedUrls);
    let effectiveKind: 'link' | 'merge' = row.kind === 'merge' ? 'merge' : 'link';
    const overlapping = options?.absorbOverlaps
      ? manualLinks.filter((candidate) =>
          candidate.status === 'active'
          && (candidate.memberUrls ?? []).some((url: string) => selected.has(url)))
      : [];
    for (const candidate of overlapping) {
      if (candidate.kind === 'merge') effectiveKind = 'merge';
      for (const url of candidate.memberUrls ?? []) {
        if (unioned.size >= Math.max(requestedUrls.length, options?.effectiveUrlCap ?? requestedUrls.length)) break;
        unioned.add(url);
      }
    }
    const effectiveMemberUrls = Array.from(unioned);
    const setKey = (urls: string[]) => Array.from(new Set(urls)).sort().join('\n');
    const existing = manualLinks.find((candidate) =>
      candidate.status === 'active'
      && candidate.kind === effectiveKind
      && setKey(candidate.memberUrls ?? []) === setKey(effectiveMemberUrls));
    const surviving = existing
      ? Object.assign(existing, { ...row, memberUrls: effectiveMemberUrls, kind: effectiveKind, updatedAt: NOW })
      : {
          id: `ml-${manualLinks.length + 1}`,
          createdAt: NOW,
          updatedAt: NOW,
          aiVerdict: 'skipped',
          aiReasoning: '',
          overrodeAi: false,
          ...row,
          memberUrls: effectiveMemberUrls,
          kind: effectiveKind,
        };
    if (!existing) manualLinks.push(surviving);
    const supersededIds = overlapping
      .filter((candidate) => candidate.id !== surviving.id)
      .map((candidate) => candidate.id);
    for (const candidate of overlapping) {
      if (candidate.id !== surviving.id) candidate.status = 'revoked';
    }
    return { row: surviving, effectiveMemberUrls, effectiveKind, supersededIds };
  });
  stub('getCuratedManualLink', async (id: string) => manualLinks.find((m) => m.id === id));
  stub('revokeCuratedManualLink', async (id: string) => {
    const row = manualLinks.find((m) => m.id === id);
    if (!row) return null;
    row.status = 'revoked';
    return row;
  });
  stub('getCuratedItemByUrl', async () => null);
  stub('getCuratedLinkReviewEvidence', async (urls: string[]) => {
    const selected = new Set(urls);
    return [
      ...primaryFeedRows(),
      ...curatedSocialRows(),
      ...clusterMembersStore,
    ].filter((row) => selected.has(row.url));
  });
  stub('getCuratedFeedbackSettings', async () => ({ capturePaused: false }));
  stub('recordCuratedOverrideEvent', async () => {});
  // Boot seed short-circuit (registerRoutes runs it once).
  stub('getCustomMcopBySlug', async () => ({ id: 1, slug: 'cyber' }));
}

async function waitForClusteringIdle(maxMs = 8000) {
  const start = Date.now();
  while (isCuratedClusteringRunning() && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitUntil(pred: () => boolean, maxMs = 8000) {
  const start = Date.now();
  while (!pred() && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

async function main() {
  // Keep every reachable AI call off the network for the whole run.
  __setCuratedClusterCompletionForTest(safeCompletionStub());
  __setManualLinkCompletionForTest(safeCompletionStub());
  const origCreate = openai.chat.completions.create;
  (openai.chat.completions as any).create = async () =>
    ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              headline: 'Iran-US nuclear talks collapse in Geneva',
              summary: 'Talks broke down in the final round.',
              bullets: ['Talks collapsed', 'No further rounds scheduled'],
              claims: [],
              corroborated: true,
            }),
          },
        },
      ],
    }) as any;

  installStorageStubs();

  // The BUSY-path deferred re-shape fires its cache invalidation through the
  // curated cache BUS (a single registered invalidator). The spy is installed
  // just before Part 2 — AFTER registerRoutes (which registers the route's own
  // bus invalidator) and after Part 1's cache checks (which exercise the route's
  // private closure, not the bus) — so it cleanly measures the deferred fire.
  let busInvalidations = 0;

  const { registerRoutes } = await import('../server/routes');
  const app = express();
  app.use(express.json());
  const server = await registerRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  // Let the boot seed settle, then make sure nothing holds the lock.
  await waitForClusteringIdle();

  try {
    // =====================================================================
    // PART 0 — REVIEW PARITY / EVIDENCE / FAIL-OPEN CONTRACT.
    // =====================================================================
    const clusterSource = readFileSync(new URL('../server/curatedCluster.ts', import.meta.url), 'utf8');
    const reviewSource = readFileSync(new URL('../server/curatedManualLink.ts', import.meta.url), 'utf8');
    check(
      '0a clustering and manual review both interpolate the one shared event-identity guidance source',
      clusterSource.includes('${CURATED_EVENT_IDENTITY_GUIDANCE}') &&
        reviewSource.includes('${CURATED_EVENT_IDENTITY_GUIDANCE}'),
    );
    check(
      '0b shared guidance pins same-track announcement + direct denial/status response as one negotiation story',
      CURATED_EVENT_IDENTITY_GUIDANCE.includes('no direct talks with Iranian officials planned') &&
        CURATED_EVENT_IDENTITY_GUIDANCE.includes('ALL ANGLES of ONE story and must be grouped together'),
    );
    check(
      '0c shared guidance preserves scheduled-phase, kinetic/diplomatic, downstream-effect, timing, and ordinary same/different-event rules',
      [
        'SCHEDULED EVENT PHASES',
        'kinetic strike, killing, raid, or military operation is NEVER',
        'DOWNSTREAM ECONOMIC / MARKET EFFECT',
        'roughly a half-day or more apart',
        'SHARED ACTOR ≠ SHARED EVENT',
        'Do NOT split a single incident',
      ].every((needle) => CURATED_EVENT_IDENTITY_GUIDANCE.includes(needle)),
    );
    const missingEvidencePrompt = buildManualLinkReviewPrompt([
      { title: 'US and Iran resume Doha talks', url: REUTERS.url },
      { title: 'Envoys give status update', url: AP.url },
    ]);
    check(
      '0d missing evidence is explicit and never silently invented',
      missingEvidencePrompt.includes('time unknown') &&
        missingEvidencePrompt.includes('no summary/bullet evidence available'),
    );

    // The route must replace stale/client-supplied display text with current
    // server evidence and return a signed review tied to this selection.
    reviewCompletion = 'concur';
    const routeReviewRes = await fetch(`${base}/api/curated/link-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { title: 'STALE CLIENT TITLE ONE', outlet: '2 sources', url: REUTERS.url },
          { title: 'STALE CLIENT TITLE TWO', outlet: '2 sources', url: AP.url },
        ],
        memberUrls: [REUTERS.url, AP.url],
      }),
    });
    const routeReview: any = await routeReviewRes.json();
    check('0e existing editor review endpoint remains available and advisory', routeReviewRes.ok && routeReview.verdict === 'concur');
    check(
      '0f route prompt uses server title, publisher, timestamp, role, summary, and bullets',
      lastReviewPrompt.includes(REUTERS.title) &&
        !lastReviewPrompt.includes('STALE CLIENT TITLE ONE') &&
        lastReviewPrompt.includes('publisher=Reuters') &&
        lastReviewPrompt.includes('published=') &&
        lastReviewPrompt.includes('role=') &&
        lastReviewPrompt.includes('same-track Geneva negotiations') &&
        lastReviewPrompt.includes('final round ended without a deal'),
    );
    check(
      '0g complete server-resolved review reports honest evidence counts',
      routeReview.requestedCount === 2 &&
        routeReview.reviewedCount === 2 &&
        routeReview.evidenceResolvedCount === 2 &&
        routeReview.partial === false &&
        typeof routeReview.reviewToken === 'string',
      JSON.stringify(routeReview),
    );
    lastReviewPrompt = '';
    const hiddenMemberReviewRes = await fetch(`${base}/api/curated/link-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { title: REUTERS.title, url: REUTERS.url },
          { title: AP.title, url: AP.url },
        ],
        memberUrls: [REUTERS.url, AP.url, OFFICIAL_X.url],
      }),
    });
    const hiddenMemberReview: any = await hiddenMemberReviewRes.json();
    check(
      '0g2 review prompt covers hidden cluster-member identities, not only visible representative cards',
      hiddenMemberReviewRes.ok &&
        hiddenMemberReview.reviewedCount === 3 &&
        lastReviewPrompt.includes(OFFICIAL_X.title) &&
        typeof hiddenMemberReview.reviewToken === 'string',
      JSON.stringify(hiddenMemberReview),
    );

    const oversized = Array.from({ length: MANUAL_LINK_REVIEW_LIMIT + 3 }, (_, i) => ({
      title: `Same-track negotiation update ${i + 1}`,
      url: `https://example.com/story-${i + 1}`,
      // Deliberately oldest-first: the capped opinion must reverse this input
      // by real publication time and exclude updates 1-3.
      publishedAt: new Date(Date.UTC(2026, 6, i + 1)),
      evidenceSource: 'server' as const,
    }));
    const recentSelection = selectRecentManualLinkReviewItems(oversized);
    check(
      '0h0 capped selection chooses the most recently published items, not incoming URL order',
      recentSelection.length === MANUAL_LINK_REVIEW_LIMIT &&
        recentSelection[0]?.title.endsWith(`${MANUAL_LINK_REVIEW_LIMIT + 3}`) &&
        recentSelection.at(-1)?.title.endsWith('4') &&
        !recentSelection.some((item) => /update [123]$/.test(item.title)),
      recentSelection.map((item) => item.title).join(' | '),
    );
    const capped = await reviewManualLink(oversized);
    check(
      '0h selections over the review cap are explicitly partial, never presented as fully reviewed',
      capped.partial === true &&
        capped.requestedCount === MANUAL_LINK_REVIEW_LIMIT + 3 &&
        capped.reviewedCount === MANUAL_LINK_REVIEW_LIMIT &&
        capped.reviewToken === undefined &&
        !!capped.warning?.includes(`most recent ${MANUAL_LINK_REVIEW_LIMIT}`) &&
        !!capped.warning?.includes('older 3 were not evaluated'),
      JSON.stringify(capped),
    );
    check(
      '0i capped prompt evaluates only the newest bounded subset',
      lastReviewPrompt.includes(`${MANUAL_LINK_REVIEW_LIMIT}.`) &&
        !lastReviewPrompt.includes(`${MANUAL_LINK_REVIEW_LIMIT + 1}.`) &&
        lastReviewPrompt.includes(`Same-track negotiation update ${MANUAL_LINK_REVIEW_LIMIT + 3}`) &&
        lastReviewPrompt.includes('Same-track negotiation update 4') &&
        !lastReviewPrompt.includes('Same-track negotiation update 3'),
    );

    reviewCompletion = 'malformed';
    const malformed = await reviewManualLink(oversized.slice(0, 2));
    check('0j malformed AI output fails open to skipped', malformed.verdict === 'skipped');
    reviewCompletion = 'error';
    const outage = await reviewManualLink(oversized.slice(0, 2));
    check('0k AI outage fails open to skipped', outage.verdict === 'skipped');
    reviewCompletion = 'concur';

    // A provider that never settles must not hold the editor behind Curated's
    // long clustering chain. Use a tiny test-only deadline and prove the
    // advisory review promptly degrades to skipped.
    __setManualLinkCompletionForTest(
      async () => new Promise<any>(() => {}),
    );
    __setManualLinkReviewBackstopForTest(25);
    const hungStartedAt = Date.now();
    const hung = await reviewManualLink(oversized.slice(0, 2));
    const hungElapsedMs = Date.now() - hungStartedAt;
    check(
      '0k2 hung provider returns skipped within the advisory deadline',
      hung.verdict === 'skipped' && hungElapsedMs < 250,
      `verdict=${hung.verdict} elapsed=${hungElapsedMs}ms`,
    );
    __setManualLinkReviewBackstopForTest(null);
    __setManualLinkCompletionForTest(safeCompletionStub());

    const routesSource = readFileSync(new URL('../server/routes.ts', import.meta.url), 'utf8');
    const publicApiSource = readFileSync(new URL('../server/publicApi.ts', import.meta.url), 'utf8');
    const curatedPageSource = readFileSync(new URL('../client/src/pages/Curated.tsx', import.meta.url), 'utf8');
    const overflowTooltipSource = readFileSync(new URL('../client/src/components/OverflowHeadlineTooltip.tsx', import.meta.url), 'utf8');
    check(
      '0l review route stays editor-authorized and absent from public API',
      /app\.post\(\"\/api\/curated\/link-review\",\s*requireCuratedEditor/.test(routesSource) &&
        !publicApiSource.includes('link-review'),
    );
    check(
      '0m editor-only radar payload keeps trustworthy publication and first-seen timestamps separate',
      /app\.get\(\"\/api\/curated\/scoring-radar\",\s*requireCuratedAccess/.test(routesSource) &&
        routesSource.includes('articlePublishedAt: c.articlePublishedAt') &&
        routesSource.includes('firstSeenAt: c.firstSeenAt') &&
        !publicApiSource.includes('firstSeenAt: c.firstSeenAt'),
    );
    check(
      '0n surfaced and below-cut news candidates share the honest timestamp formatter',
      curatedPageSource.match(/formatNewsCandidateContext\(/g)?.length === 2 &&
        curatedPageSource.includes('updatedAt: s.sourceCount > 1 ? s.articlePublishedAt : null') &&
        curatedPageSource.includes('articlePublishedAt: r.articlePublishedAt') &&
        curatedPageSource.includes('firstSeenAt: r.firstSeenAt'),
    );
    check(
      '0o full-headline tooltip is overflow-conditional, mouse-only, focus-closed, and row-click transparent',
      overflowTooltipSource.includes('isCandidateHeadlineTruncated') &&
        overflowTooltipSource.includes('event.pointerType !== "mouse"') &&
        overflowTooltipSource.includes('{truncated && (') &&
        overflowTooltipSource.includes('onFocus={() => setOpen(false)}') &&
        !overflowTooltipSource.includes('onClick=') &&
        curatedPageSource.includes('text-link-target-headline-') &&
        curatedPageSource.includes('text-link-target-radar-headline-'),
    );

    // =====================================================================
    // PART 1 — FAST HTTP PATH (clustering idle): durable link write returns
    // promptly with honest persisted/deferred status; background re-shape then
    // forms one clusterId and invalidates the cache.
    // =====================================================================
    const linkRes = await fetch(`${base}/api/curated/link-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberUrls: [REUTERS.url, AP.url],
        kind: 'merge',
        label: 'Iran-US Geneva talks',
        reviewToken: routeReview.reviewToken,
        reviewUrls: [REUTERS.url, AP.url],
      }),
    });
    const linkBody: any = await linkRes.json().catch(() => ({}));

    check('1 link-items returns 200 OK', linkRes.status === 200, `status=${linkRes.status}`);
    check('2 response ok:true with a persisted link id', linkBody?.ok === true && !!linkBody?.id, JSON.stringify(linkBody));
    check(
      '2a required evidence capture completes before the consolidated overlay write',
      evidenceCaptureCount === 1
        && mutationOrder[0] === 'capture'
        && mutationOrder[1] === 'apply',
      mutationOrder.join(' -> '),
    );
    check(
      '3 durable write returns promptly with background reshape deferred',
      linkBody?.deferred === true && linkBody?.mutationStatus === 'persisted',
      `deferred=${linkBody?.deferred}`,
    );
    check(
      '4 response honestly reports reshape was not awaited',
      linkBody?.reshaped === false,
      `reshaped=${linkBody?.reshaped}`,
    );
    check(
      '5 response does not claim synchronous formation',
      linkBody?.formed === false,
      `formed=${linkBody?.formed}`,
    );

    const firstWriteBefore = writeCount;
    await waitForClusteringIdle();
    await waitUntil(() => writeCount > firstWriteBefore && clusterMembersStore.some((m) => m.url === REUTERS.url));

    // Verify the WRITE itself: both linked URLs persisted under exactly ONE clusterId.
    const linkedNormalized = new Set([REUTERS.url, AP.url]);
    const hitClusterIds = new Set(
      clusterMembersStore
        .filter((m) => m.url && linkedNormalized.has(m.url))
        .map((m) => m.clusterId),
    );
    check(
      '6 re-shape WROTE both linked URLs under exactly one clusterId',
      hitClusterIds.size === 1,
      `clusterIds hit=${hitClusterIds.size}, members=${clusterMembersStore.length}`,
    );
    check(
      '7 the persisted story carries both distinct publisher URLs (genuinely corroborated)',
      new Set(clusterMembersStore.map((m) => m.url)).size >= 2,
      `distinct urls=${new Set(clusterMembersStore.map((m) => m.url)).size}`,
    );
    check(
      '7a only server-issued review metadata tied to this selection entered the audit row',
      manualLinks[0]?.aiVerdict === 'concur' &&
        String(manualLinks[0]?.aiReasoning).includes('same negotiation track/status update'),
      JSON.stringify(manualLinks[0]),
    );
    // A valid token cannot be reused to make a larger, partially unreviewed
    // commit look AI-approved. The editor action still succeeds (fail open), but
    // its audit metadata must degrade to skipped.
    const extraUrl = OFFICIAL_X.url;
    const mismatchedCommit = await fetch(`${base}/api/curated/link-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberUrls: [REUTERS.url, AP.url, extraUrl],
        kind: 'link',
        reviewToken: routeReview.reviewToken,
        reviewUrls: [REUTERS.url, AP.url],
      }),
    });
    const mismatchedBody: any = await mismatchedCommit.json();
    const mismatchedRow = manualLinks[manualLinks.length - 1];
    check(
      '7b token cannot label a larger unreviewed commit as AI-concurred',
      mismatchedCommit.ok &&
        mismatchedBody.ok === true &&
        mismatchedRow?.aiVerdict === 'skipped' &&
        mismatchedRow?.aiReasoning === '',
      JSON.stringify(mismatchedRow),
    );

    // Cache invalidation (behavioral): a cached top-stories read must be dropped
    // by a subsequent link so the next poll recomputes. Seed the cache, count a
    // stubbed read, link again, and confirm the cache miss forces a recompute.
    let registryReads = 0;
    stub('getOutletRegistry', async () => {
      registryReads++;
      return registryRows();
    });
    await waitForClusteringIdle();

    // Warm the cache (no x-mcop-no-cache) — this populates the top-stories entry.
    await fetch(`${base}/api/curated/top-stories`).then((r) => r.text());
    const readsAfterWarm = registryReads;
    // A second warm read (no bypass) must be served from cache — no new read.
    await fetch(`${base}/api/curated/top-stories`).then((r) => r.text());
    const cacheHeld = registryReads === readsAfterWarm;
    check(
      '8 top-stories read is cached (a repeat read does not recompute)',
      cacheHeld,
      `reads warm=${readsAfterWarm}, after-repeat=${registryReads}`,
    );

    // Now a link must INVALIDATE that cache → the next read recomputes.
    await waitForClusteringIdle();
    await fetch(`${base}/api/curated/link-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberUrls: [REUTERS.url, AP.url], kind: 'merge' }),
    }).then((r) => r.json());
    await waitForClusteringIdle();
    const readsBeforeReRead = registryReads;
    await fetch(`${base}/api/curated/top-stories`).then((r) => r.text());
    check(
      '9 link-items INVALIDATED the curated read cache (next top-stories read recomputes)',
      registryReads > readsBeforeReRead,
      `reads before=${readsBeforeReRead}, after=${registryReads}`,
    );

    // =====================================================================
    // PART 2 — BUSY PATH: a pending deferred re-shape fires the instant the
    // clustering lock frees (schedulePendingManualReshape), so a merge that
    // arrived while a pass held the lock is never stranded to the next cron.
    // =====================================================================
    await waitForClusteringIdle();
    // Ensure a merge grouping exists to re-form (fresh active link is present).
    if (!manualLinks.some((m) => m.status === 'active')) {
      manualLinks.push({
        id: 'ml-busy',
        status: 'active',
        kind: 'merge',
        memberUrls: [REUTERS.url, AP.url],
        label: '',
      });
    }

    // Install the bus spy now (Part 1's route-cache checks are done).
    registerCuratedCacheInvalidator(() => {
      busInvalidations++;
    });
    busInvalidations = 0;
    const writesBefore = writeCount;
    // Model "a manual link arrived while a pass held the lock": stage the pending
    // deferred re-shape, then drive a lock-holding pass to completion. Its finally
    // must consume the pending flag and fire the deferred re-shape (AI-free).
    schedulePendingManualReshape(false);
    await reshapeCuratedLane(); // the synthetic lock-hold; its finally frees the lock

    // The deferred re-shape is fire-and-forget inside the finally — wait for it.
    const deferredFired = await waitUntil(() => writeCount >= writesBefore + 2, 8000);
    check(
      '10 the deferred re-shape fired after the lock freed (a 2nd persistence write occurred)',
      deferredFired,
      `writes before=${writesBefore}, after=${writeCount}`,
    );
    check(
      '11 the deferred re-shape invalidated the curated read cache via the bus',
      busInvalidations > 0,
      `bus invalidations=${busInvalidations}`,
    );

    // Sanity: after the deferred re-shape the merge is STILL a single cluster.
    const busyHitClusterIds = new Set(
      clusterMembersStore
        .filter((m) => m.url && linkedNormalized.has(m.url))
        .map((m) => m.clusterId),
    );
    check(
      '12 the merge remains one clusterId after the deferred re-shape',
      busyHitClusterIds.size === 1,
      `clusterIds hit=${busyHitClusterIds.size}`,
    );

    // Social URL variants must resolve through the exact manual-link identity
    // path, join the already-formed story, and remain attach-only. This covers
    // the two editor-visible social lanes without allowing either post to seed,
    // represent, or promote a story.
    const socialAttachResponse = await fetch(`${base}/api/curated/link-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberUrls: [REUTERS.url, AP.url, OFFICIAL_X.url, TRUTH_SOCIAL.url],
        kind: 'link',
        aiVerdict: 'skipped',
        label: 'Geneva talks',
      }),
    });
    const socialAttach = await socialAttachResponse.json() as { ok?: boolean; formed?: boolean };
    check('13 social attach request succeeds', socialAttachResponse.ok && socialAttach.ok === true);
    const socialAttachConverged = await waitUntil(() => {
      const urls = new Set(clusterMembersStore.map((m) => m.url));
      return [REUTERS.url, AP.url, OFFICIAL_X.url, TRUTH_SOCIAL.url].every((url) => urls.has(url));
    }, 8000);
    check(
      '14 social attach defers reshape and the background pass preserves the formed story',
      socialAttachConverged &&
        socialAttach.formed === false &&
        new Set(clusterMembersStore.filter((m) => [REUTERS.url, AP.url].includes(m.url)).map((m) => m.clusterId)).size === 1,
    );
    const socialUrls = new Set([
      OFFICIAL_X.url.replace(/\?.*$/, '').toLowerCase(),
      TRUTH_SOCIAL.url.replace(/\?.*$/, '').toLowerCase(),
    ]);
    const socialMembers = clusterMembersStore.filter((m) =>
      socialUrls.has(String(m.url).replace(/\?.*$/, '').toLowerCase()),
    );
    check(
      '15 official X and Truth Social identity URLs resolve as cluster members',
      socialMembers.length === 2,
      `members=${socialMembers.length}`,
    );
    check(
      '16 social members remain attach-only after regrouping',
      socialMembers.every((m) => m.behaviorClass === 'attach'),
      JSON.stringify(socialMembers.map((m) => m.behaviorClass)),
    );
    const socialClusterIds = new Set(socialMembers.map((m) => m.clusterId));
    check(
      '17 both social members persist on the intended formed story',
      socialClusterIds.size === 1 && socialClusterIds.has([...busyHitClusterIds][0]),
      `social=${[...socialClusterIds].join(',')} story=${[...busyHitClusterIds].join(',')}`,
    );

    // Forced editor merges may bypass formation, but social remains
    // Additional Coverage-only. An all-social merge is rejected before an
    // overlay is written; a mixed article/social merge elects the article.
    for (const row of manualLinks) row.status = 'revoked';
    const manualLinkCountBeforeAllSocial = manualLinks.length;
    const allSocialMergeRes = await fetch(`${base}/api/curated/link-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberUrls: [OFFICIAL_X.url, TRUTH_SOCIAL.url],
        kind: 'merge',
        aiVerdict: 'skipped',
        label: 'Official statements',
      }),
    });
    const allSocialMerge: any = await allSocialMergeRes.json();
    check(
      '18 all-social forced merge is rejected instead of creating a hidden story',
      allSocialMergeRes.status === 400 &&
        /non-social article/i.test(String(allSocialMerge.error ?? '')),
      JSON.stringify({ status: allSocialMergeRes.status, response: allSocialMerge }),
    );
    check(
      '19 rejected all-social merge writes no manual-link overlay',
      manualLinks.length === manualLinkCountBeforeAllSocial,
      `before=${manualLinkCountBeforeAllSocial} after=${manualLinks.length}`,
    );

    for (const row of manualLinks) row.status = 'revoked';
    const mixedMergeRes = await fetch(`${base}/api/curated/link-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberUrls: [REUTERS.url, OFFICIAL_X.url, TRUTH_SOCIAL.url],
        kind: 'merge',
        aiVerdict: 'skipped',
        label: 'Geneva talks and official statements',
      }),
    });
    const mixedMerge: any = await mixedMergeRes.json();
    const mixedMergeConverged = await waitUntil(() => {
      const urls = new Set(clusterMembersStore.map((m) => m.url));
      return [REUTERS.url, OFFICIAL_X.url, TRUTH_SOCIAL.url].every((url) => urls.has(url)) &&
        !urls.has(AP.url);
    }, 8000);
    const mixedMembers = clusterMembersStore.filter((m) =>
      [REUTERS.url, OFFICIAL_X.url, TRUTH_SOCIAL.url].includes(m.url),
    );
    const mixedRepresentatives = mixedMembers.filter((m) => m.isRepresentative);
    check(
      '20 mixed article/social forced merge keeps the non-social article as its sole representative',
      mixedMergeRes.ok &&
        mixedMergeConverged &&
        mixedMerge.formed === false &&
        mixedMerge.deferred === true &&
        mixedRepresentatives.length === 1 &&
        mixedRepresentatives[0]?.url === REUTERS.url,
      JSON.stringify(mixedRepresentatives),
    );
    check(
      '21 mixed merge retains social source links and media rows as Additional Coverage',
      mixedMembers.filter((m) => socialUrls.has(
        String(m.url).replace(/\?.*$/, '').toLowerCase(),
      )).length === 2 &&
        mixedMembers
          .filter((m) => socialUrls.has(String(m.url).replace(/\?.*$/, '').toLowerCase()))
          .every((m) => m.behaviorClass === 'attach' && !m.isRepresentative),
      JSON.stringify(mixedMembers),
    );
  } finally {
    await waitForClusteringIdle();
    restoreStorage();
    (openai.chat.completions as any).create = origCreate;
    __setManualLinkCompletionForTest(null);
    __setManualLinkReviewBackstopForTest(null);
    __setCuratedClusterCompletionForTest(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (failures > 0) {
    console.error(`\n[manual-link] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[manual-link] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[manual-link] UNEXPECTED ERROR', e);
  process.exit(1);
});
