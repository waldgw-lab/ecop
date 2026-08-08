/**
 * Tests for alignCuratedAnalyses — the result→input binding for the curated
 * relevance analyzer (server/aiAnalyzer.ts).
 *
 * Regression context: an entire batch of unrelated US CNBC market stories
 * (Comcast, Eli Lilly, Salesforce, SpaceX, ...) was stamped country="South
 * Korea" + semiconductor categories in the curated overlay. Root cause: when the
 * model's echoed title didn't normalize-match an input, the binder fell back to a
 * BLIND POSITIONAL guess and overwrote the result's title with the wrong input —
 * smearing one story's analysis onto another headline and LOCKING it under the
 * generate-once rule. The fix binds by the model-echoed 1-based index, then an
 * UNAMBIGUOUS title match, and DROPS anything unbindable (retried next pass).
 *
 * No test framework is configured — run directly with tsx:
 *   npx tsx scripts/curated-analyzer-alignment.test.ts
 * Exits non-zero on any failure.
 */
import { alignCuratedAnalyses, type CuratedAnalysisResult } from '../server/aiAnalyzer';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Build a model result carrying just the fields the binder cares about (title +
// the analysis payload we want to detect smearing on: country / category).
function res(
  title: string,
  country: string | null,
  category: string,
): CuratedAnalysisResult {
  return {
    title,
    is_relevant: true,
    reason: 'test',
    tags: [],
    priority_score: 50,
    category,
    region: null,
    country,
    primaryTopic: 'Other / Emerging' as CuratedAnalysisResult['primaryTopic'],
    scope: null,
    conflictTrack: null,
    countryPair: null,
    proposedTopic: null,
  };
}
const item = (index: unknown, r: CuratedAnalysisResult) => ({ index, result: r });

function byTitle(out: CuratedAnalysisResult[]) {
  return new Map(out.map((r) => [r.title, r]));
}

function testAlignment() {
  console.log('alignCuratedAnalyses:');

  const COMCAST = "What's behind the Comcast / NBCUniversal break-up?";
  const SK = 'South Korea unveils $880bn chip and AI investment plan';

  // --- 1. faithful echo, in order, with correct index → exact binding ---
  {
    const titles = [COMCAST, SK];
    const out = alignCuratedAnalyses(titles, [
      item(1, res(COMCAST, 'United States', 'Media M&A')),
      item(2, res(SK, 'South Korea', 'Semiconductor Cluster')),
    ]);
    const m = byTitle(out);
    check('faithful+index: all bound', out.length === 2);
    check('faithful+index: Comcast keeps US/Media', m.get(COMCAST)?.country === 'United States');
    check('faithful+index: SK keeps South Korea/chips', m.get(SK)?.country === 'South Korea');
  }

  // --- 2. model REORDERED results but echoed correct index → bound by index ---
  {
    const titles = [COMCAST, SK];
    const out = alignCuratedAnalyses(titles, [
      item(2, res(SK, 'South Korea', 'Semiconductor Cluster')), // SK first in output
      item(1, res(COMCAST, 'United States', 'Media M&A')),
    ]);
    const m = byTitle(out);
    check('reordered+index: Comcast NOT smeared to South Korea', m.get(COMCAST)?.country === 'United States');
    check('reordered+index: SK correct', m.get(SK)?.country === 'South Korea');
  }

  // --- 3. model REFORMATTED the echoed title but kept correct index → index wins ---
  {
    const titles = [COMCAST, SK];
    const out = alignCuratedAnalyses(titles, [
      item(1, res('Comcast spins off NBCUniversal cable nets', 'United States', 'Media M&A')),
      item(2, res('S. Korea bets ~$880B on chips & AI', 'South Korea', 'Semiconductor Cluster')),
    ]);
    const m = byTitle(out);
    check('reformatted+index: titles forced back to inputs', m.has(COMCAST) && m.has(SK));
    check('reformatted+index: Comcast correct (not SK)', m.get(COMCAST)?.country === 'United States');
  }

  // --- 4. CORE REGRESSION: missing index + reformatted title (no match) ---
  // The model deduped the near-identical SK chip cluster into ONE reformatted
  // object with no index, returned BEFORE the others. Old code would idx=pos=0
  // and smear the SK analysis onto Comcast. New code must DROP it, leaving
  // Comcast unclassified rather than stamped "South Korea".
  {
    const titles = [COMCAST, SK];
    const out = alignCuratedAnalyses(titles, [
      item(undefined, res('S Korea $880bn chip & AI plan', 'South Korea', 'Semiconductor Cluster')),
    ]);
    const m = byTitle(out);
    check('comcast-repro: unbindable SK analysis DROPPED', out.length === 0, `got ${out.length}`);
    check('comcast-repro: Comcast NOT present with South Korea', !m.has(COMCAST));
    check(
      'comcast-repro: no row carries South Korea on a wrong title',
      out.every((r) => !(r.title === COMCAST && r.country === 'South Korea')),
    );
  }

  // --- 5. missing index + faithful UNAMBIGUOUS title → bound by title ---
  {
    const titles = [COMCAST, SK];
    const out = alignCuratedAnalyses(titles, [
      item(undefined, res(COMCAST, 'United States', 'Media M&A')),
      item(undefined, res(SK, 'South Korea', 'Semiconductor Cluster')),
    ]);
    const m = byTitle(out);
    check('no-index+faithful: both bound by title', out.length === 2);
    check('no-index+faithful: correct countries', m.get(COMCAST)?.country === 'United States' && m.get(SK)?.country === 'South Korea');
  }

  // --- 6. near-duplicate titles WITHOUT index → never mis-bound by title ---
  // Two near-identical SK headlines that normalize to the SAME key. Without an
  // index, an ambiguous title must NOT bind (could pick the wrong twin); WITH an
  // index each binds correctly.
  {
    const A = 'South Korea unveils $880bn chip plan';
    const B = 'South Korea unveils $880bn chip plan!'; // normalizes identically
    const titles = [A, B];
    const ambiguous = alignCuratedAnalyses(titles, [
      item(undefined, res(A, 'South Korea', 'Chip Plan A')),
    ]);
    check('near-dup: ambiguous title without index is dropped', ambiguous.length === 0, `got ${ambiguous.length}`);
    const indexed = alignCuratedAnalyses(titles, [
      item(1, res(A, 'South Korea', 'Chip Plan A')),
      item(2, res(B, 'South Korea', 'Chip Plan B')),
    ]);
    check('near-dup: index disambiguates both', indexed.length === 2);
    check('near-dup: index maps to right slots', byTitle(indexed).get(A)?.category === 'Chip Plan A' && byTitle(indexed).get(B)?.category === 'Chip Plan B');
  }

  // --- 7. out-of-range / duplicate index → ignored, fall through or drop ---
  {
    const titles = [COMCAST, SK];
    const out = alignCuratedAnalyses(titles, [
      item(99, res('garbled', 'South Korea', 'Semiconductor Cluster')), // out of range, no title match
      item(2, res(SK, 'South Korea', 'Semiconductor Cluster')),
      item(2, res('dup index', 'China', 'Military Modernization')), // dup of taken slot 2, no title match
    ]);
    const m = byTitle(out);
    check('bad-index: only the valid one binds', out.length === 1, `got ${out.length}`);
    check('bad-index: SK bound correctly', m.get(SK)?.country === 'South Korea');
    check('bad-index: Comcast left unclassified (not smeared)', !m.has(COMCAST));
  }

  // --- 8. count mismatch (model dropped items) → survivors bound, no smear ---
  {
    const titles = [COMCAST, SK, 'Eli Lilly tops drug-pricing forecast'];
    const out = alignCuratedAnalyses(titles, [
      item(2, res(SK, 'South Korea', 'Semiconductor Cluster')), // only one returned
    ]);
    const m = byTitle(out);
    check('count-mismatch: only returned item binds', out.length === 1);
    check('count-mismatch: bound to correct title', m.get(SK)?.country === 'South Korea');
    check('count-mismatch: others stay unclassified', !m.has(COMCAST) && !m.has(titles[2]));
  }

  // --- 9. string index (e.g. "3") is coerced ---
  {
    const titles = [COMCAST, SK];
    const out = alignCuratedAnalyses(titles, [item('1', res('whatever', 'United States', 'Media M&A'))]);
    check('string-index: coerced and bound', out.length === 1 && out[0].title === COMCAST);
  }

  // --- 10. CONFLICT: valid index says slot 1 but a FAITHFUL title echo points
  // at slot 2 (model renumbered) → trust neither, DROP (no smear). ---
  {
    const titles = [COMCAST, SK];
    const out = alignCuratedAnalyses(titles, [
      item(1, res(SK, 'South Korea', 'Semiconductor Cluster')), // index→Comcast, title→SK
    ]);
    const m = byTitle(out);
    check('conflict: index/title disagreement is DROPPED', out.length === 0, `got ${out.length}`);
    check('conflict: Comcast not stamped South Korea', !m.has(COMCAST));
  }

  // --- 11. caller objects are NOT mutated (clone-on-bind) ---
  {
    const titles = [COMCAST];
    const original = res('reformatted comcast echo', 'United States', 'Media M&A');
    const out = alignCuratedAnalyses(titles, [item(1, original)]);
    check('no-mutation: output title forced to input', out[0]?.title === COMCAST);
    check('no-mutation: caller object title untouched', original.title === 'reformatted comcast echo');
  }
}

(async () => {
  testAlignment();
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll curated analyzer alignment checks passed');
})();
