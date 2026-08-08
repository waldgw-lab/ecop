/**
 * Regression gate for the Top Stories candidate window anchor (Task #792).
 *
 * Task #788 widened the Curated candidate pool: getCuratedStoreItems filters
 * and orders by the DISPLAYED age — COALESCE(article_published_at, scraped_at)
 * — instead of scrapedAt (first-seen) alone. Without a gate, a future refactor
 * could silently revert to a scrapedAt-only window and quietly shrink the feed
 * with no failing test.
 *
 * This gate runs the REAL DatabaseStorage.getCuratedStoreItems SQL against the
 * dev database with fixture rows (all timestamps anchored to new Date() at run
 * time — never wall-clock literals):
 *
 *   With a 24h window:
 *   1. INCLUDED : scrapedAt outside (30h ago), articlePublishedAt inside (2h)
 *                 — the Task #788 widening. A scrapedAt-only window would drop
 *                 this row, failing the gate.
 *   2. EXCLUDED : scrapedAt outside (30h), articlePublishedAt outside (30h).
 *   3. INCLUDED : scrapedAt inside (2h), articlePublishedAt NULL — the
 *                 COALESCE fallback to first-seen still admits the row.
 *   4. EXCLUDED : scrapedAt inside (2h), articlePublishedAt outside (30h) —
 *                 the anchor is the DISPLAYED published date, matching the
 *                 standalone age-out gate; first-seen alone cannot keep a
 *                 stale-published row in the pool.
 *
 * Fixture rows carry a unique __MCOP_STORE_WINDOW_GATE__ marker in the URL
 * (titles stay clean prose); residue from any previously killed run is swept
 * before seeding, and cleanup runs in finally.
 *
 * No test framework — run directly with tsx:
 *   npx tsx scripts/curated-store-window.test.ts
 * Exits 0 on pass, 1 on any failure, 3 when the dev DB is unreachable
 * (precondition, not a verdict — harness-reliability convention).
 */
import { db } from '../server/db';
import { storage } from '../server/storage';
import { curatedItems } from '../shared/schema';
import { like, sql } from 'drizzle-orm';

const MARKER = '__MCOP_STORE_WINDOW_GATE__';
const WINDOW_HOURS = 24;

const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

interface Fixture {
  label: string;
  urlSlug: string;
  title: string;
  scrapedAt: Date;
  articlePublishedAt: Date | null;
  expectIncluded: boolean;
}

const fixtures: Fixture[] = [
  {
    label: 'scrapedAt outside window, published inside — MUST be included (Task #788 widening)',
    urlSlug: 'stale-firstseen-fresh-published',
    title: 'Allied ministers meet to review maritime security posture',
    scrapedAt: hoursAgo(30),
    articlePublishedAt: hoursAgo(2),
    expectIncluded: true,
  },
  {
    label: 'scrapedAt outside, published outside — MUST be excluded',
    urlSlug: 'stale-both',
    title: 'Regional summit concludes with joint communique on trade routes',
    scrapedAt: hoursAgo(30),
    articlePublishedAt: hoursAgo(30),
    expectIncluded: false,
  },
  {
    label: 'scrapedAt inside, published NULL — COALESCE fallback keeps it included',
    urlSlug: 'fresh-firstseen-null-published',
    title: 'Coast guard reports increased patrol activity near shipping lanes',
    scrapedAt: hoursAgo(2),
    articlePublishedAt: null,
    expectIncluded: true,
  },
  {
    label: 'scrapedAt inside, published outside — displayed age governs, MUST be excluded',
    urlSlug: 'fresh-firstseen-stale-published',
    title: 'Defense committee publishes annual readiness assessment',
    scrapedAt: hoursAgo(2),
    articlePublishedAt: hoursAgo(30),
    expectIncluded: false,
  },
];

const fixtureUrl = (slug: string) => `https://gate.invalid/${MARKER}/${slug}`;

async function sweepResidue(): Promise<void> {
  await db.delete(curatedItems).where(like(curatedItems.url, `%${MARKER}%`));
}

async function main(): Promise<void> {
  // Precondition: dev DB reachable (exit 3 = inconclusive, not a verdict).
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    console.error(`[store-window] dev DB unreachable — inconclusive: ${(err as Error).message}`);
    process.exit(3);
  }

  let failures = 0;
  try {
    await sweepResidue(); // residue from a previously killed run

    for (const f of fixtures) {
      await db.insert(curatedItems).values({
        title: f.title,
        normalizedTitle: f.title.toLowerCase(),
        url: fixtureUrl(f.urlSlug),
        source: 'Store Window Gate Fixture',
        category: 'general',
        scrapedAt: f.scrapedAt,
        articlePublishedAt: f.articlePublishedAt,
        priorityScore: 50,
      });
    }

    const items = await storage.getCuratedStoreItems(WINDOW_HOURS);
    const returnedUrls = new Set(items.map((i) => i.url));

    for (const f of fixtures) {
      const included = returnedUrls.has(fixtureUrl(f.urlSlug));
      if (included === f.expectIncluded) {
        console.log(`PASS: ${f.label}`);
      } else {
        failures++;
        console.error(
          `FAIL: ${f.label} — expected ${f.expectIncluded ? 'INCLUDED' : 'EXCLUDED'}, got ${included ? 'INCLUDED' : 'EXCLUDED'}`,
        );
      }
    }
  } catch (err) {
    console.error(`[store-window] unexpected error: ${(err as Error).stack ?? err}`);
    failures++;
  } finally {
    try {
      await sweepResidue();
    } catch (err) {
      console.error(`[store-window] cleanup failed (fixture rows may remain): ${(err as Error).message}`);
      failures++;
    }
  }

  if (failures > 0) {
    console.error(`[store-window] ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('[store-window] candidate-window anchor gate: all checks passed');
  process.exit(0);
}

main();
