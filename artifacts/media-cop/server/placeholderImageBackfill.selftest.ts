// Deterministic self-test for the placeholder-image backfill drain loop.
// Run with:  pnpm exec tsx server/placeholderImageBackfill.selftest.ts
// (No DB / network — dependencies are injected.) Asserts that a legacy
// population far larger than any single batch's network-fetch cap (80) is
// FULLY drained in one invocation: every eligible row ends up stamped or
// cleared, across well over 50 batches.
import assert from 'node:assert/strict';
import { runPlaceholderImageBackfill, type BackfillDeps } from './placeholderImageBackfill';

interface Row { id: string; url: string; ogImageSourceUrl: string | null; checked: boolean; clearedFlag: boolean }

async function main() {
  // 4,500 legacy ABC rows (no provenance, recheck-host, need a "fetch") →
  // at 80 fetches/batch this requires 57 batches, exceeding the old 50-batch
  // cutoff that stranded rows. Plus provenance rows (placeholder + real) and
  // non-recheck-host rows.
  const rows: Row[] = [];
  for (let i = 0; i < 4500; i++) {
    rows.push({ id: `abc-${i}`, url: 'https://abcnews.go.com/story/' + i, ogImageSourceUrl: null, checked: false, clearedFlag: false });
  }
  rows.push({ id: 'prov-placeholder', url: 'https://example.com/a', ogImageSourceUrl: 'https://s.abcnews.com/images/US/abc_news_default_2000x2000_update_16x9_992.jpg', checked: false, clearedFlag: false });
  rows.push({ id: 'prov-real', url: 'https://example.com/b', ogImageSourceUrl: 'https://cdn.example.com/real-photo.jpg', checked: false, clearedFlag: false });
  rows.push({ id: 'other-host', url: 'https://example.org/c', ogImageSourceUrl: null, checked: false, clearedFlag: false });

  const byId = new Map(rows.map((r) => [r.id, r]));
  let batches = 0;
  const deps: BackfillDeps = {
    selectBatch: async (limit) => {
      batches++;
      return rows.filter((r) => !r.checked && !r.clearedFlag).slice(0, limit)
        .map(({ id, url, ogImageSourceUrl }) => ({ id, url, ogImageSourceUrl }));
    },
    // Every 10th legacy ABC page still serves the branded default; the rest
    // have a real photo — exercises both clear and stamp paths.
    fetchOgImage: async (url) =>
      url.endsWith('0')
        ? 'https://s.abcnews.com/images/US/abc_news_default_2000x2000_update_16x9_992.jpg'
        : 'https://cdn.abcnews.com/real/photo.jpg',
    clear: async (id) => { byId.get(id)!.clearedFlag = true; },
    stamp: async (id) => { byId.get(id)!.checked = true; },
    sleep: async () => {}, // no real waiting in the test
  };

  const { scanned, cleared } = await runPlaceholderImageBackfill(deps);

  const remaining = rows.filter((r) => !r.checked && !r.clearedFlag);
  assert.equal(remaining.length, 0, `all eligible rows must be stamped or cleared; ${remaining.length} remained`);
  assert.ok(batches > 50, `must drain across >50 batches without a cutoff (got ${batches})`);
  assert.equal(byId.get('prov-placeholder')!.clearedFlag, true, 'provenance placeholder row must be cleared');
  assert.equal(byId.get('prov-real')!.checked, true, 'provenance real-photo row must only be stamped');
  assert.equal(byId.get('other-host')!.checked, true, 'non-recheck-host row must be stamped without fetch');
  assert.equal(cleared, 450 + 1, 'every 10th ABC row + the provenance placeholder must be cleared');
  assert.equal(scanned, 4500 + 2, 'scanned = all fetched ABC rows + both provenance rows');

  console.log(`PASS: batches=${batches}, scanned=${scanned}, cleared=${cleared}, drained=${rows.length}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e); process.exit(1); });
