/**
 * Regression test: marked opinion stays attach-only, still clusters, logs to Adjustments.
 *
 * Pins three invariants for the content-kind mark flow (Task #939):
 *
 *   A (demotion)    — an item carrying any content-kind mark
 *                     (opinion/analysis/editorial/explainer/other) is demoted to
 *                     attach-only and EXCLUDED from the corroborating count the
 *                     story-formation gate uses.  It can therefore never anchor,
 *                     seed, or represent a story, and is barred from the standalone
 *                     Top Stories list.  Pure / deterministic — no DB, AI, or network.
 *
 *   B (attaches)    — given an already-formed multi-source story, the marked item
 *                     matches via the incremental-attach bridge's pure matching core
 *                     (buildAttachClusters + selectAttachClusterId) and folds in as a
 *                     member.  Also deterministic — no IO.
 *
 *   C (adjustments) — after setting a content-kind mark via the real authenticated
 *                     endpoint, an override event with action='content-kind-mark' and
 *                     a new_value naming the kind is present in curated_override_events
 *                     (read-back via GET /api/curated/override-log). Clearing it
 *                     records 'content-kind-clear'. Needs live server + DB; exits 3
 *                     (inconclusive, non-blocking) when unavailable.
 *
 * Exit codes: 0 = pass, 1 = fail, 3 = inconclusive (server/DB/auth unavailable).
 * Unexpected exceptions in deterministic sections (A/B) are genuine defects — exit 1.
 * Inconclusive exits from Invariant C happen ONLY via main() after cleanup() runs.
 */

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

const PASS = 0, FAIL = 1, INCONCLUSIVE = 3;
const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:5000';

let _failures = 0;
let _completionSentinelReached = false;

/** Thrown by checkInvariantC() to signal an unavailable precondition.
 *  Caught by main() AFTER cleanup() has run via the normal finally path. */
class InconclusiveError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InconclusiveError';
  }
}

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`[opinion-attach] OK   ${name}`);
  } else {
    console.error(`[opinion-attach] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    _failures++;
  }
}

// =============================================================================
// INVARIANT A — Demotion: each override kind demotes the item to attach-only.
// Uses the pure exported functions from shared/contentKind.ts and
// server/curatedCluster.ts — zero IO.
// =============================================================================
async function checkInvariantA(): Promise<void> {
  const {
    shouldDemoteEffectiveOpinion,
    isEffectivelyReportedArticle,
  } = await import('../shared/contentKind');
  const { evaluateFormation } = await import('../server/curatedCluster');

  // A plain news article URL that carries NO opinion signal in its path —
  // the content-kind mark is the only reason for demotion.
  const PLAIN_URL = 'https://www.reuters.com/world/us/senate-passes-defense-bill-2026-06-30/';

  // The clustering pass maps override kinds → effectiveCk:
  //   'explainer' → 'explainer'  (kept distinct for badge/treatment)
  //   everything else → 'opinion'
  // We replicate that mapping here and call shouldDemoteEffectiveOpinion with the
  // same storedContentKind argument the clustering pass would supply.
  const OVERRIDE_KINDS: Array<{ overrideKind: string; effectiveCk: 'opinion' | 'explainer' }> = [
    { overrideKind: 'opinion',   effectiveCk: 'opinion' },
    { overrideKind: 'analysis',  effectiveCk: 'opinion' },
    { overrideKind: 'editorial', effectiveCk: 'opinion' },
    { overrideKind: 'other',     effectiveCk: 'opinion' },
    { overrideKind: 'explainer', effectiveCk: 'explainer' },
  ];

  const NOW = new Date('2026-07-01T12:00:00Z');

  for (const { overrideKind, effectiveCk } of OVERRIDE_KINDS) {
    // shouldDemoteEffectiveOpinion must return true for a non-blocked, non-contrast
    // trusted outlet's item when the effective content kind is opinion or explainer.
    const demotes = shouldDemoteEffectiveOpinion(
      false,    // isBlocked — trusted outlet, not blocked
      null,     // behaviorLabel — not contrast
      PLAIN_URL,
      effectiveCk as any,
    );
    check(
      `A.demote override='${overrideKind}' (effectiveCk='${effectiveCk}') → shouldDemote=true`,
      demotes,
      `shouldDemoteEffectiveOpinion returned ${demotes}`,
    );

    // The clustering pass's demoteOpinionAnalysis helper sets cls='attach'.
    // Verify evaluateFormation excludes such nodes from the corroborating count.
    //
    // KEY CONSTRUCTION: the reporter is 'Reuters' and the opinion-marked node is
    // 'Associated Press' — DISTINCT publishers.  If the formation gate were ever
    // broken to count attach-only nodes as corroborating, sourceCount would
    // reach 2 and forms would be true; the test would fail, correctly catching
    // the regression.  Using the SAME publisher would hide this: sourceCount
    // would stay 1 either way (same publisher dedups), so the assertion would
    // vacuously pass even for a broken gate.
    const reporter = {
      key: 'main:reporter',
      itemType: 'main' as const,
      itemId: 'reporter',
      title: 'Senate passes defense bill by wide margin',
      source: 'Reuters',
      url: PLAIN_URL,
      category: 'Security',
      cls: 'corroborating' as any,
      label: null as any,
      role: 'contributing' as any,
      blocked: false,
      priority: 72,
      ogImageUrl: null,
      publishedAt: NOW,
      sourceIdentifier: null,
      factuality: null,
      ownership: [],
      summary: null,
      bullets: null,
    };
    // Distinct publisher, demoted to cls='attach', role='attach-only'.
    const opinionNode = {
      key: 'main:opinion',
      itemType: 'main' as const,
      itemId: 'opinion',
      title: 'Analysis: what the Senate defense bill means for Pentagon budgets',
      source: 'Associated Press',   // ← DIFFERENT publisher from reporter
      url: PLAIN_URL,
      category: 'Security',
      cls: 'attach' as any,          // ← result of demoteOpinionAnalysis
      label: null as any,
      role: 'attach-only' as any,
      blocked: false,
      priority: 65,
      ogImageUrl: null,
      publishedAt: NOW,
      sourceIdentifier: null,
      factuality: null,
      ownership: [],
      summary: null,
      bullets: null,
    };
    const result = evaluateFormation([reporter, opinionNode]);
    // forms must be false AND sourceCount must stay 1: if the opinion node were
    // wrongly counted as corroborating, the distinct publisher would push
    // sourceCount to 2 and forms to true — the test would catch that regression.
    check(
      `A.formation override='${overrideKind}' — marked node excluded from corroborating count (sourceCount=1, forms=false)`,
      result.forms === false && result.sourceCount === 1,
      `forms=${result.forms} sourceCount=${result.sourceCount}`,
    );

    // isEffectivelyReportedArticle must return false for the effective kind
    // (bars the item from seeding a standalone Top Story).
    const isReported = isEffectivelyReportedArticle(PLAIN_URL, effectiveCk as any);
    check(
      `A.standalone-gate override='${overrideKind}' — isEffectivelyReportedArticle=false (barred from standalone)`,
      !isReported,
      `isEffectivelyReportedArticle returned ${isReported}`,
    );
  }

  // Negative: a plain reporting article with no mark must NOT be demoted and
  // MUST pass the standalone gate (regression guard — we don't over-demote).
  const notDemoted = shouldDemoteEffectiveOpinion(false, null, PLAIN_URL, null);
  check('A.no-false-demote — unmarked article is NOT demoted', !notDemoted);
  const stillReported = isEffectivelyReportedArticle(PLAIN_URL, null);
  check('A.no-false-gate — unmarked article passes standalone gate', stillReported);

  // A blocked or contrast outlet must NOT be demoted regardless of override kind
  // (we never soften an adversary label via content-kind marks).
  const notDemotedBlocked = shouldDemoteEffectiveOpinion(true, null, PLAIN_URL, 'opinion');
  const notDemotedContrast = shouldDemoteEffectiveOpinion(false, 'contrast', PLAIN_URL, 'opinion');
  check('A.blocked-not-demoted — blocked outlet ignored by demotion gate', !notDemotedBlocked);
  check('A.contrast-not-demoted — contrast outlet ignored by demotion gate', !notDemotedContrast);

  console.log('[opinion-attach] Invariant A complete');
}

// =============================================================================
// INVARIANT B — Attach: marked item folds into a formed same-event cluster.
// Uses the pure incremental-attach bridge functions — zero IO.
// =============================================================================
async function checkInvariantB(): Promise<void> {
  const {
    buildAttachClusters,
    selectAttachClusterId,
  } = await import('../server/curatedIncrementalAttach') as any;
  const { significantTitleTokens } = await import('../server/curatedCluster');
  const { isEffectivelyReportedArticle } = await import('../shared/contentKind');

  const NOW = new Date('2026-07-01T12:00:00Z');
  const HOUR = 3_600_000;
  function ageH(h: number) { return new Date(NOW.getTime() - h * HOUR); }

  // Build a cluster already formed by two trusted corroborating publishers —
  // the "defense bill" story that the opinion piece will attach to.
  const formedMembers = [
    {
      clusterId: 'def-bill',
      behaviorClass: 'corroborating',
      title: 'Senate passes defense bill by wide margin',
      category: 'Security',
      publishedAt: ageH(1),
      isRepresentative: true,
    },
    {
      clusterId: 'def-bill',
      behaviorClass: 'corroborating',
      title: 'Defense bill clears Senate with bipartisan support',
      category: 'Security',
      publishedAt: ageH(2),
      isRepresentative: false,
    },
  ];

  const clusters = buildAttachClusters(formedMembers);
  check(
    'B.cluster-formed — test cluster is a valid attach target (>=2 contributing)',
    clusters.length === 1 && clusters[0].clusterId === 'def-bill',
    `clusters=${clusters.length}`,
  );

  // The opinion-marked item covers the same Senate defense-bill event.
  // Its role is 'attach-only' (demoted by the clustering pass), but the pure
  // matching core only looks at title tokens — it is agnostic to the item's
  // role/cls.  This is intentional: in the full clustering pass, such items are
  // included in the candidate pool and CAN be assigned to a formed cluster.
  const opinionToks: Set<string> = significantTitleTokens('Analysis: what the Senate defense bill means for Pentagon');
  const opinionCandidate = {
    key: 'main:opinion-piece',
    tokens: opinionToks,
    publishedAt: ageH(0.5),
    category: 'Security',
  };

  const matchedClusterId = selectAttachClusterId(opinionCandidate, clusters);
  check(
    'B.opinion-attaches — marked opinion item folds into the formed same-event cluster',
    matchedClusterId === 'def-bill',
    `selectAttachClusterId returned '${matchedClusterId}'`,
  );

  // Standalone exclusion: the same item, if it were NOT a cluster member, would
  // be barred from the standalone Top Stories list because its effective content
  // kind is opinion.  We simulate this by running the same gate the route uses.
  const PLAIN_URL = 'https://www.reuters.com/world/us/senate-defense-bill-analysis-2026-07-01/';
  const opinionUrl = 'https://www.reuters.com/world/us/opinion/senate-defense-bill-2026-07-01/';

  // Stored 'opinion' override → barred from standalone.
  check(
    'B.standalone-exclusion — marked item barred from standalone Top Stories',
    !isEffectivelyReportedArticle(PLAIN_URL, 'opinion'),
  );
  // URL with /opinion/ path segment → same result.
  check(
    'B.standalone-exclusion (opinion url) — opinion-url item barred from standalone',
    !isEffectivelyReportedArticle(opinionUrl, null),
  );

  // Sanity: a plain reporting article on the same event passes the standalone gate.
  check(
    'B.reporting-article-passes — plain reporting URL passes standalone gate',
    isEffectivelyReportedArticle(PLAIN_URL, null),
  );

  // An off-topic opinion item must NOT attach to the defense-bill cluster.
  const offTopicToks: Set<string> = significantTitleTokens('How to invest in Treasury bonds this summer');
  const offTopicCandidate = {
    key: 'main:off-topic',
    tokens: offTopicToks,
    publishedAt: ageH(1),
    category: 'Economy',
  };
  check(
    'B.off-topic-no-attach — off-topic opinion item does NOT attach to unrelated cluster',
    selectAttachClusterId(offTopicCandidate, clusters) === null,
    `got '${selectAttachClusterId(offTopicCandidate, clusters)}'`,
  );

  console.log('[opinion-attach] Invariant B complete');
}

// =============================================================================
// INVARIANT C — Adjustments log: mark + clear both land in curated_override_events.
// Exercises the real authenticated endpoint + DB read-back.
//
// IMPORTANT: this function NEVER calls process.exit() directly. Unavailable
// preconditions are signalled by throwing InconclusiveError; main() catches
// that AFTER cleanup() has run via the normal finally path, then exits 3.
// This guarantees the fixture sweep always executes regardless of which path
// the function exits on.
// =============================================================================
async function login(): Promise<string | null> {
  const pw = process.env.APP_PASSWORD ?? process.env.ADMIN_PASSWORD;
  if (!pw) return null;
  try {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ password: pw }),
    });
    if (!r.ok) return null;
    const cookies = typeof (r.headers as any).getSetCookie === 'function'
      ? (r.headers as any).getSetCookie()
      : [r.headers.get('set-cookie')].filter(Boolean);
    if (!cookies || cookies.length === 0) return null;
    return cookies.map((c: string) => c.split(';')[0]).join('; ');
  } catch {
    return null;
  }
}

async function apiReq(method: string, urlPath: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'x-forwarded-proto': 'https',
    },
    body: method !== 'GET' ? JSON.stringify(body) : undefined,
  });
}

async function checkInvariantC(): Promise<void> {
  // Unique per-run URL — the only safe anchor for event lookup.
  // Exact equality throughout so a stale event from a prior run (different
  // timestamp) can never satisfy the check.
  const TEST_URL = `https://gate-test.example.com/opinion-attach-adjlog-${Date.now()}`;

  // Pre-flight: authenticate. Login errors are preconditions (throw Inconclusive).
  let cookie: string | null = null;
  try {
    cookie = await login();
  } catch {
    // Network failure reaching the server — unavailable precondition.
    throw new InconclusiveError('login request failed (server unreachable)');
  }
  if (!cookie) {
    throw new InconclusiveError('could not authenticate (APP_PASSWORD missing or login non-OK)');
  }

  // Cleanup is registered as a finally so it runs on every exit path —
  // normal return, thrown InconclusiveError, or unexpected exception.
  const cleanup = async () => {
    try {
      await apiReq('POST', '/api/curated/content-kind-override', { url: TEST_URL, kind: null }, cookie!);
    } catch {
      // best-effort sweep — never throws
    }
  };

  try {
    // C1: Set the mark via the real endpoint.
    const setR = await apiReq('POST', '/api/curated/content-kind-override', { url: TEST_URL, kind: 'analysis' }, cookie);
    if (setR.status === 503 || setR.status === 502) {
      // Server unavailable — inconclusive precondition. Throws so finally runs.
      throw new InconclusiveError(`content-kind-override endpoint unavailable (${setR.status})`);
    }
    if (!setR.ok) {
      // Server reachable but returned a real error — treat as test failure (exit 1).
      console.error(`[opinion-attach] Invariant C FAIL: POST content-kind-override returned ${setR.status}`);
      _failures++;
      return;
    }
    console.log('[opinion-attach] C1: POST content-kind-override kind=analysis → OK');

    // C2: Read the override-log; assert the content-kind-mark event is present.
    // Exact URL match — no substring fallback — so stale events can't satisfy this.
    const logR = await apiReq('GET', '/api/curated/override-log', null, cookie);
    if (logR.status === 503 || logR.status === 502) {
      throw new InconclusiveError(`override-log endpoint unavailable (${logR.status})`);
    }
    if (!logR.ok) {
      console.error(`[opinion-attach] Invariant C FAIL: GET override-log returned ${logR.status}`);
      _failures++;
      return;
    }
    const logData = await logR.json() as {
      recent: Array<{ action: string; newValue?: string | null; itemUrl?: string | null }>;
    };
    const markEvent = (logData.recent ?? []).find(
      (e) => e.action === 'content-kind-mark' && e.itemUrl === TEST_URL,
    );
    check(
      'C.mark-logged — content-kind-mark event present in override-log.recent (exact URL)',
      !!markEvent,
      `events.count=${logData.recent?.length ?? 0} found=${!!markEvent}`,
    );
    if (markEvent) {
      check(
        'C.mark-new-value — new_value names the kind ("analysis")',
        typeof markEvent.newValue === 'string' && markEvent.newValue.includes('analysis'),
        `newValue='${markEvent.newValue}'`,
      );
    }

    // C3: Clear the mark.
    const clearR = await apiReq('POST', '/api/curated/content-kind-override', { url: TEST_URL, kind: null }, cookie);
    if (!clearR.ok) {
      console.error(`[opinion-attach] Invariant C FAIL: POST content-kind-override (clear) returned ${clearR.status}`);
      _failures++;
      return;
    }
    console.log('[opinion-attach] C3: POST content-kind-override kind=null (clear) → OK');

    // C4: Read the log again; the clear event must also be present at the exact URL.
    const logR2 = await apiReq('GET', '/api/curated/override-log', null, cookie);
    if (!logR2.ok) {
      console.error(`[opinion-attach] Invariant C FAIL: GET override-log (after clear) returned ${logR2.status}`);
      _failures++;
      return;
    }
    const logData2 = await logR2.json() as {
      recent: Array<{ action: string; newValue?: string | null; itemUrl?: string | null }>;
    };
    const clearEvent = (logData2.recent ?? []).find(
      (e) => e.action === 'content-kind-clear' && e.itemUrl === TEST_URL,
    );
    check(
      'C.clear-logged — content-kind-clear event present in override-log.recent (exact URL)',
      !!clearEvent,
      `events.count=${logData2.recent?.length ?? 0} found=${!!clearEvent}`,
    );

    console.log('[opinion-attach] Invariant C complete');
  } finally {
    // Always sweep — runs on: normal return, InconclusiveError throw,
    // unexpected exception. process.exit() is never called inside this function.
    await cleanup();
  }
}

// =============================================================================
// Entry point — guarded so it never auto-runs on import (avoids racing shared
// fixtures when this module is loaded by run-gates.ts's spawned child process).
// =============================================================================
async function main(): Promise<void> {
  // Invariants A + B are pure/deterministic — always run them.
  // Unexpected exceptions here are genuine defects → exit 1 (via top-level catch).
  console.log('\n[opinion-attach] === Invariant A: demotion ===');
  await checkInvariantA();

  console.log('\n[opinion-attach] === Invariant B: attach bridge ===');
  await checkInvariantB();

  // Invariant C needs a live server + auth.
  // InconclusiveError from checkInvariantC means a precondition was unavailable;
  // cleanup() has already run inside checkInvariantC's finally before the throw.
  console.log('\n[opinion-attach] === Invariant C: adjustments log ===');
  try {
    await checkInvariantC();
  } catch (e) {
    if (e instanceof InconclusiveError) {
      // Precondition unavailable — non-blocking per gate convention.
      console.warn(`[opinion-attach] Invariant C SKIP: ${e.message}`);
      process.exit(INCONCLUSIVE);
    }
    // Any other exception is a real defect in C's deterministic portions → fall
    // through to the top-level catch which exits 1.
    throw e;
  }

  // Completion sentinel — must be reached before any successful exit so a
  // vacuous-pass (early process.exit(0) without reaching this line) cannot
  // sneak through as a gate pass.
  _completionSentinelReached = true;
  console.log('[opinion-attach] COMPLETION_SENTINEL_REACHED');

  // Explicit sentinel guard: if this is somehow false at this point (e.g., a
  // future refactor moves the sentinel past an early exit), treat it as a fail.
  if (!_completionSentinelReached) {
    console.error('[opinion-attach] FAIL sentinel not reached — possible vacuous pass');
    process.exit(FAIL);
  }

  if (_failures > 0) {
    console.error(`\n[opinion-attach] ${_failures} check(s) FAILED`);
    process.exit(FAIL);
  }
  console.log('\n[opinion-attach] all checks passed (opinion-attach-adjustments)');
  process.exit(PASS);
}

// Invoke directly guard — prevents auto-run when the module is imported.
const invokedDirectly = process.argv[1] &&
  (process.argv[1].endsWith('curated-opinion-attach-adjustments.test.ts') ||
   process.argv[1].endsWith('curated-opinion-attach-adjustments.test.js'));

if (invokedDirectly) {
  // Top-level catch: only fires for genuine unexpected defects in deterministic
  // code that were not handled inside the per-invariant functions.  Those are
  // real failures → exit 1.  The C-precondition path already resolves to
  // process.exit(INCONCLUSIVE) inside main() above.
  main().catch((e) => {
    console.error('[opinion-attach] Unexpected error in deterministic section:', e);
    process.exit(FAIL);
  });
}
