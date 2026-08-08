/**
 * Cold-start persisted gate-verdict regression.
 *
 * The storage hydrate stub is installed before the first gate-mode admission
 * pass in this process because gateVerdictHydrated is module-level state.
 */

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`[verdict-hydration] OK   ${name}`);
  else {
    console.error(`[verdict-hydration] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const hydratedRelevant = [
  'NATO adds destroyers to Baltic patrol after undersea cable damage',
  'Pentagon deploys additional air defenses to protect Gulf bases',
];
const hydratedRejected = 'Celebrity designer reveals a new summer footwear collection';
const expiredTitle = 'Japan begins joint missile defense drill with United States';
const unknownTitle = 'Poland orders additional artillery systems for eastern flank';
const freshlyRelevant = new Set([expiredTitle, unknownTitle]);

function verdict(title: string, isRelevant: boolean) {
  return {
    title,
    is_relevant: isRelevant,
    reason: 'persisted hydration test',
    tags: [],
    priority_score: isRelevant ? 60 : 10,
    category: 'general',
    region: null,
    country: null,
    primaryTopic: 'Other / Emerging',
    scope: null,
    conflictTrack: null,
    countryPair: null,
    proposedTopic: null,
  };
}

async function main() {
  const { __setCuratedGateAnalyzeForTest } = await import('../server/aiAnalyzer');
  const { admitCuratedCandidates } = await import('../server/curatedIngest');
  const { storage } = await import('../server/storage');

  const originals: Record<string, any> = {};
  const stub = (name: string, fn: (...args: any[]) => any) => {
    originals[name] = (storage as any)[name];
    (storage as any)[name] = fn;
  };
  const restore = () => {
    for (const [name, fn] of Object.entries(originals)) (storage as any)[name] = fn;
  };

  let loadCalls = 0;
  const inserted: string[] = [];
  const analyzed: string[] = [];
  const now = Date.now();

  stub('getOutletRegistry', async () => []);
  stub('getExistingCuratedUrls', async () => new Set<string>());
  stub('getCuratedItemByUrl', async () => undefined);
  stub('getSimilarCuratedItems', async () => []);
  stub('getSimilarCuratedItemsForOutlet', async () => []);
  stub('getCuratedDedupCorpus', async () => []);
  stub('addCuratedItem', async (insert: any) => {
    inserted.push(insert.title);
    return { id: `hydration-${inserted.length}`, ...insert };
  });
  stub('getCuratedLearnedRules', async () => []);
  stub('getCuratedClassificationsByUrls', async () => new Map());
  stub('upsertCuratedClassifications', async () => {});
  stub('recordClassificationProposal', async () => {});
  stub('recordWatchTopicMatch', async () => {});
  stub('upsertCuratedIntakeTelemetry', async () => {});
  stub('mergeCuratedIntakeFeedStats', async () => {});
  stub('saveCuratedGateVerdicts', async () => {});
  stub('loadCuratedGateVerdicts', async () => {
    loadCalls++;
    return [
      ...hydratedRelevant.map((title, index) => ({
        title,
        verdict: verdict(title, true),
        // Exercise both Date and serialized timestamp expiry parsing.
        expiresAt: index === 0 ? new Date(now + 60 * 60_000) : new Date(now + 60 * 60_000).toISOString(),
      })),
      {
        title: hydratedRejected,
        verdict: verdict(hydratedRejected, false),
        expiresAt: new Date(now + 60 * 60_000),
      },
      {
        title: expiredTitle,
        verdict: verdict(expiredTitle, false),
        expiresAt: new Date(now - 1),
      },
    ] as any;
  });

  __setCuratedGateAnalyzeForTest(async (titles: string[]) => {
    analyzed.push(...titles);
    return titles.map((title) => verdict(title, freshlyRelevant.has(title))) as any;
  });

  let threw: unknown = null;
  try {
    const titles = [...hydratedRelevant, hydratedRejected, expiredTitle, unknownTitle];
    await admitCuratedCandidates(
      titles.map((title, index) => ({
        title,
        url: `https://example.com/verdict-hydration/${index}`,
        source: 'Reuters',
        pubDate: new Date(now),
      })),
      { mode: 'gate', label: 'verdict-hydration', deadlineMs: Date.now() + 60_000 },
    );
  } catch (error) {
    threw = error;
  } finally {
    __setCuratedGateAnalyzeForTest(null);
    restore();
  }

  check('a. cold-start gate pass resolves', threw === null, String(threw));
  check('b. persisted verdicts hydrate exactly once', loadCalls === 1, `loadCalls=${loadCalls}`);
  check(
    'c. unexpired persisted titles make ZERO analyzer calls',
    [...hydratedRelevant, hydratedRejected].every((title) => !analyzed.includes(title)),
    `analyzed=${analyzed.join(' | ')}`,
  );
  check(
    'd. unknown and expired titles are analyzed fresh',
    analyzed.length === 2 && analyzed.includes(unknownTitle) && analyzed.includes(expiredTitle),
    `analyzed=${analyzed.join(' | ')}`,
  );
  check(
    'e. hydrated relevant verdicts ingest while hydrated rejection stays rejected',
    hydratedRelevant.every((title) => inserted.includes(title)) && !inserted.includes(hydratedRejected),
    `inserted=${inserted.join(' | ')}`,
  );
  check(
    'f. expired persisted rejection is not restored',
    inserted.includes(expiredTitle),
    `inserted=${inserted.join(' | ')}`,
  );

  if (failures > 0) {
    console.error(`\n[verdict-hydration] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[verdict-hydration] all checks passed');
}

main().catch((error) => {
  console.error('[verdict-hydration] UNEXPECTED ERROR', error);
  process.exit(1);
});