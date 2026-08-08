/**
 * Regression gate for the curated analysis / opinion / explainer score cap.
 *
 * Editors repeatedly down-pinned analysis/commentary pieces the gate analyzer
 * had scored 72-85 into the same band as breaking events. The deterministic
 * cap `evalCuratedAnalysisOpinionCap` pulls URL-detectable opinion / analysis /
 * explainer / live-blog items to ≤ CURATED_ANALYSIS_OPINION_CAP (69) so
 * discrete breaking events reliably out-rank them.
 *
 * Rules under test:
 *   - Items above the cap with URL-detected opinion/analysis/explainer kind
 *     are capped to exactly CURATED_ANALYSIS_OPINION_CAP.
 *   - Items AT or BELOW the cap are never raised.
 *   - Breaking-news article URLs (no opinion/analysis/explainer path segment)
 *     are NEVER capped regardless of score.
 *   - Genuine statecraft breaking-news URLs are untouched even when they score
 *     in the top band (90+).
 *
 * Section 2 (enrichment-time re-cap, DB round-trip): when enrichment writes a
 * page-labeled contentKind of 'opinion'/'explainer' via cacheCuratedItemMedia,
 * the stored curated machine score is re-capped with SQL LEAST on BOTH write
 * paths (real-image done path AND favicon-retry path); scores at/below the cap
 * and 'article'/'audio' kinds are untouched; and a row whose URL matches a
 * main-lane headlines admin override (priority_override) is NEVER re-capped
 * (human-score invariant).
 *
 * No test framework — run directly with tsx:
 *   npx tsx scripts/curated-analysis-cap.test.ts
 * Exits 0 on pass, 1 on any failure, 3 when the dev DB is unreachable
 * (precondition, not a verdict — harness-reliability convention).
 */
import { evalCuratedAnalysisOpinionCap, CURATED_ANALYSIS_OPINION_CAP } from '../server/curatedIngest';

interface Case {
  label: string;
  url: string | null;
  input: number;
  expectedScore: number;
  expectedReason: string | null;
}

const cases: Case[] = [
  // ---- Items that MUST be capped ----
  {
    label: 'opinion section URL scored above cap',
    url: 'https://www.nytimes.com/2026/07/01/opinion/iran-nuclear-deal-analysis.html',
    input: 82,
    expectedScore: CURATED_ANALYSIS_OPINION_CAP,
    expectedReason: 'analysis-opinion-explainer',
  },
  {
    label: 'CNN trailing -analysis slug scored high',
    url: 'https://edition.cnn.com/2026/07/01/politics/us-iran-deal-analysis',
    input: 78,
    expectedScore: CURATED_ANALYSIS_OPINION_CAP,
    expectedReason: 'analysis-opinion-explainer',
  },
  {
    label: 'CNN trailing -analysis with intl suffix',
    url: 'https://edition.cnn.com/2026/07/01/politics/us-iran-deal-analysis-intl',
    input: 85,
    expectedScore: CURATED_ANALYSIS_OPINION_CAP,
    expectedReason: 'analysis-opinion-explainer',
  },
  {
    label: '/analysis/ path segment scored above cap',
    url: 'https://www.bbc.com/news/analysis/iran-sanctions-2026',
    input: 80,
    expectedScore: CURATED_ANALYSIS_OPINION_CAP,
    expectedReason: 'analysis-opinion-explainer',
  },
  {
    label: 'Reuters explainer- slug scored above cap',
    url: 'https://www.reuters.com/world/middle-east/explainer-hormuz-toll-deal-2026-07-01/',
    input: 75,
    expectedScore: CURATED_ANALYSIS_OPINION_CAP,
    expectedReason: 'analysis-opinion-explainer',
  },
  {
    label: '/explainers/ path segment scored above cap',
    url: 'https://www.bbc.com/news/explainers/why-hormuz-matters',
    input: 72,
    expectedScore: CURATED_ANALYSIS_OPINION_CAP,
    expectedReason: 'analysis-opinion-explainer',
  },
  {
    label: '/live-updates/ path segment scored above cap',
    url: 'https://www.nytimes.com/live-updates/2026/07/01/world/iran-hormuz',
    input: 80,
    expectedScore: CURATED_ANALYSIS_OPINION_CAP,
    expectedReason: 'analysis-opinion-explainer',
  },
  {
    label: '/liveblog/ path segment scored above cap',
    url: 'https://www.theguardian.com/world/liveblog/2026/07/01/iran-strait-of-hormuz',
    input: 76,
    expectedScore: CURATED_ANALYSIS_OPINION_CAP,
    expectedReason: 'analysis-opinion-explainer',
  },
  {
    label: 'exactly one above the cap fires',
    url: 'https://www.bbc.com/news/analysis/nato-posture',
    input: CURATED_ANALYSIS_OPINION_CAP + 1,
    expectedScore: CURATED_ANALYSIS_OPINION_CAP,
    expectedReason: 'analysis-opinion-explainer',
  },

  // ---- Items that must NOT be capped (already at/below cap) ----
  {
    label: 'opinion URL already at cap — score unchanged',
    url: 'https://www.nytimes.com/2026/07/01/opinion/iran.html',
    input: CURATED_ANALYSIS_OPINION_CAP,
    expectedScore: CURATED_ANALYSIS_OPINION_CAP,
    expectedReason: null,
  },
  {
    label: 'opinion URL below cap — never raised',
    url: 'https://www.nytimes.com/2026/07/01/opinion/iran.html',
    input: 55,
    expectedScore: 55,
    expectedReason: null,
  },

  // ---- Breaking-news article URLs — NEVER capped ----
  {
    label: 'breaking-news article URL scored 90 — untouched',
    url: 'https://www.reuters.com/world/middle-east/iran-fires-missiles-2026-07-01/',
    input: 90,
    expectedScore: 90,
    expectedReason: null,
  },
  {
    label: 'breaking-news article URL scored 85 — untouched',
    url: 'https://apnews.com/article/hormuz-blockade-2026',
    input: 85,
    expectedScore: 85,
    expectedReason: null,
  },
  {
    label: 'null URL — never capped',
    url: null,
    input: 88,
    expectedScore: 88,
    expectedReason: null,
  },
  {
    label: 'plain article URL with "analysis" in path token but not as a full segment — untouched',
    url: 'https://www.reuters.com/world/geopolitical-analysis-firm-report-2026/',
    input: 80,
    expectedScore: 80,
    expectedReason: null,
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const result = evalCuratedAnalysisOpinionCap(c.url, c.input);
  const scoreOk = result.score === c.expectedScore;
  const reasonOk = result.reason === c.expectedReason;
  if (scoreOk && reasonOk) {
    console.log(`  PASS  ${c.label}`);
    pass++;
  } else {
    const issues: string[] = [];
    if (!scoreOk) issues.push(`score: got ${result.score}, want ${c.expectedScore}`);
    if (!reasonOk) issues.push(`reason: got ${JSON.stringify(result.reason)}, want ${JSON.stringify(c.expectedReason)}`);
    console.error(`  FAIL  ${c.label} — ${issues.join('; ')}`);
    fail++;
  }
}

// ---------------------------------------------------------------------------
// Section 2 — enrichment-time re-cap (DB round-trip through cacheCuratedItemMedia)
// ---------------------------------------------------------------------------
// Fixture URLs live on a dedicated .invalid host so they can never collide with
// real content; a sweep of that host runs before AND after (finally) so residue
// from a killed run is cleaned up on the next run.
const FIXTURE_HOST = 'gate-analysis-recap.invalid';

async function runEnrichmentRecapSection(): Promise<void> {
  const { cacheCuratedItemMedia } = await import('../server/streamPrefetch');
  const { db } = await import('../server/db');
  const { curatedItems, headlines } = await import('../shared/schema');
  const { eq, like } = await import('drizzle-orm');

  const runTag = Date.now();
  const fixtureUrl = (slug: string) => `https://${FIXTURE_HOST}/${slug}-${runTag}`;
  const REAL_IMAGE = 'https://example.com/photos/real-article-photo.jpg';
  const BULLETS = ['First summary bullet.', 'Second summary bullet.'];

  async function sweepFixtures(): Promise<void> {
    await db.delete(curatedItems).where(like(curatedItems.url, `https://${FIXTURE_HOST}/%`));
    await db.delete(headlines).where(like(headlines.url, `https://${FIXTURE_HOST}/%`));
  }

  async function insertCuratedRow(slug: string, score: number): Promise<{ id: string; url: string }> {
    const url = fixtureUrl(slug);
    const [row] = await db.insert(curatedItems).values({
      title: `Gate fixture ${slug} ${runTag}`,
      normalizedTitle: `gate fixture ${slug} ${runTag}`,
      url,
      source: 'GateFixture',
      priorityScore: score,
    }).returning({ id: curatedItems.id });
    return { id: row.id, url };
  }

  async function readScore(id: string): Promise<number> {
    const [row] = await db.select({ score: curatedItems.priorityScore }).from(curatedItems).where(eq(curatedItems.id, id));
    return row.score;
  }

  function check(label: string, got: number, want: number): void {
    if (got === want) {
      console.log(`  PASS  ${label}`);
      pass++;
    } else {
      console.error(`  FAIL  ${label} — score: got ${got}, want ${want}`);
      fail++;
    }
  }

  await sweepFixtures();
  try {
    // 1. Machine score above cap + page-labeled 'opinion' via the real-image
    //    (done) write path → re-capped to exactly the cap.
    const c1 = await insertCuratedRow('opinion-done-path', 85);
    await cacheCuratedItemMedia(c1.id, REAL_IMAGE, BULLETS, 'opinion');
    check('re-cap: opinion via done path 85 -> cap', await readScore(c1.id), CURATED_ANALYSIS_OPINION_CAP);

    // 2. Machine score above cap + 'explainer' via the favicon-retry write path
    //    (no real image) → re-capped there too.
    const c2 = await insertCuratedRow('explainer-retry-path', 82);
    await cacheCuratedItemMedia(c2.id, null, BULLETS, 'explainer');
    check('re-cap: explainer via retry path 82 -> cap', await readScore(c2.id), CURATED_ANALYSIS_OPINION_CAP);

    // 3. Score already below the cap → LEAST never raises it.
    const c3 = await insertCuratedRow('opinion-below-cap', 55);
    await cacheCuratedItemMedia(c3.id, REAL_IMAGE, BULLETS, 'opinion');
    check('re-cap: below-cap opinion never raised', await readScore(c3.id), 55);

    // 4. Plain 'article' kind → never touched regardless of score.
    const c4 = await insertCuratedRow('article-untouched', 85);
    await cacheCuratedItemMedia(c4.id, REAL_IMAGE, BULLETS, 'article');
    check('re-cap: article kind untouched at 85', await readScore(c4.id), 85);

    // 5. Human-score invariant: a main-lane headlines row with an explicit
    //    admin priority_override on the SAME URL blocks the re-cap entirely.
    const c5 = await insertCuratedRow('opinion-admin-override', 90);
    await db.insert(headlines).values({
      title: `Gate fixture admin-override headline ${runTag}`,
      normalizedTitle: `gate fixture admin-override headline ${runTag}`,
      url: c5.url,
      category: 'general',
      source: 'GateFixture',
      summary: 'Gate fixture row for the admin-override re-cap guard.',
      priorityScore: 90,
      priorityOverride: 90,
    });
    await cacheCuratedItemMedia(c5.id, REAL_IMAGE, BULLETS, 'opinion');
    check('re-cap: admin-override row NEVER re-capped', await readScore(c5.id), 90);
  } finally {
    await sweepFixtures();
  }
}

async function main(): Promise<void> {
  try {
    await runEnrichmentRecapSection();
  } catch (err) {
    // A DB connection / infrastructure failure is a PRECONDITION failure, not
    // a content verdict — exit 3 per the harness-reliability convention.
    console.error('[analysis-cap] enrichment re-cap section could not run (DB precondition):', (err as Error).message);
    process.exit(3);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('[analysis-cap] all cases passed');
  process.exit(0);
}

void main();
