/**
 * Curated ANALYZER + TRANSLATOR fail-safe regression (Task #779).
 *
 * Task #731 documented the fail-safe contract for the curated relevance
 * analyzer (analyzeCuratedChunk via analyzeCuratedBatch) and the title
 * translator (translateCuratedTitlesToEnglish): on a malformed / empty /
 * wrong-shape AI reply, the analyzer returns [] (items stay unclassified and
 * retry next pass — never thrown, never fabricated) and the translator returns
 * a map that only ever degrades to the original title (never drops an input).
 * Only the CLUSTERING path had a gate (curated-garbage-recovery.test.ts); this
 * suite pins the same contract for the analyzer and translator so a future
 * regression cannot silently start dropping curated candidates.
 *
 * Stubbing strategy: the `openai` facade exported by server/aiClient is a
 * plain object, so `openai.chat.completions.create` is a MUTABLE method —
 * stub it directly (per the test-injection-seam convention: in-module seams
 * are only for immutable bindings). Every stub RESOLVES (200-OK-with-bad-body),
 * so no live AI call is ever made and the thrown-error path is not what is
 * exercised here (curated-timeout-recovery covers throws).
 *
 * Checks:
 *   ANALYZER (must return [] — retry — never throw, never fabricate):
 *     1. truncated JSON (token cap mid-object, nothing salvageable)
 *     2. valid JSON but WRONG SHAPE (results is not an array)
 *     3. pure non-JSON prose (model refusal/chat)
 *     4. empty content
 *     5. positive control: a VALID reply still classifies (guards vacuous pass)
 *   TRANSLATOR (map preserves originals — effective title map.get(t) ?? t
 *   covers every input; never throws):
 *     6. empty content -> empty map (all originals kept)
 *     7. non-JSON prose -> empty map
 *     8. valid JSON wrong shape -> empty map
 *     9. partial garbage: one bindable row among junk -> only that row
 *        translated, every other input keeps its original title
 *    10. positive control: a valid reply binds by exact echoed original
 *
 * Run directly with tsx (no test framework configured):
 *   npx tsx scripts/curated-analyzer-translator-failsafe.test.ts
 * Exit 0 = pass, 1 = fail (per the harness-reliability convention; this suite
 * is fully deterministic — no exit-3 inconclusive path needed).
 */
import { openai } from '../server/aiClient';
import {
  analyzeCuratedBatch,
  translateCuratedTitlesToEnglish,
} from '../server/aiAnalyzer';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[analyzer-failsafe] OK   ${name}`);
  } else {
    console.error(`[analyzer-failsafe] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const realCreate = openai.chat.completions.create;
function stubReply(content: string | null) {
  (openai.chat.completions as any).create = async () =>
    ({ choices: [{ message: { content } }] }) as any;
}
function restore() {
  (openai.chat.completions as any).create = realCreate;
}

const TITLES = [
  'Iran and US nuclear talks collapse after final round in Geneva',
  'Pentagon confirms new Indo-Pacific carrier deployment schedule',
  'China unveils new long-range air-to-air missile in Pacific drill',
];

// The analyzer fail-safe contract: [] means "unclassified, retry next pass".
// It must NEVER throw and must NEVER fabricate results from garbage.
async function analyzerCase(name: string, reply: string | null) {
  stubReply(reply);
  let threw = false;
  let result: any = null;
  try {
    result = await analyzeCuratedBatch(TITLES);
  } catch (e) {
    threw = true;
    console.error(`[analyzer-failsafe] analyzeCuratedBatch THREW on ${name}:`, e);
  } finally {
    restore();
  }
  check(`${name}: analyzer does not throw`, !threw);
  check(
    `${name}: analyzer returns [] (retry), not fabricated results`,
    Array.isArray(result) && result.length === 0,
    `got ${JSON.stringify(result)?.slice(0, 200)}`,
  );
}

async function main() {
  // ===== ANALYZER =====
  // 1. Truncated JSON: token cap hit mid-FIRST-object, so even the salvage
  //    pass (complete-objects-only) recovers nothing -> [].
  await analyzerCase(
    '1 truncated JSON',
    '```json\n{"results":[{"title":"Iran and US nuclear talks colla',
  );
  // 2. Valid JSON, wrong shape: parseable but `results` is not an array.
  await analyzerCase('2 valid-JSON-wrong-shape', '{"results":"oops-not-an-array","note":"model drifted"}');
  // 3. Pure prose (refusal / chat instead of JSON).
  await analyzerCase(
    '3 non-JSON prose',
    "I'm sorry, but I can't help with analyzing these headlines.",
  );
  // 4. Empty content.
  await analyzerCase('4 empty content', null);

  // 5. POSITIVE CONTROL — a valid reply still classifies, proving the stub
  //    seam actually reaches analyzeCuratedChunk (guards a vacuous pass where
  //    e.g. an upstream error made every case return [] for the wrong reason).
  {
    stubReply(
      JSON.stringify({
        results: TITLES.map((t, i) => ({
          index: i + 1,
          title: t,
          is_relevant: true,
          reason: 'test',
          tags: [],
          priority_score: 80 - i * 7,
          category: 'general',
        })),
      }),
    );
    let result: any = null;
    let threw = false;
    try {
      result = await analyzeCuratedBatch(TITLES);
    } catch (e) {
      threw = true;
      console.error('[analyzer-failsafe] positive control THREW:', e);
    } finally {
      restore();
    }
    check('5 positive control: valid reply classifies all inputs', !threw && Array.isArray(result) && result.length === TITLES.length,
      `got ${Array.isArray(result) ? result.length : JSON.stringify(result)} result(s)`);
    check(
      '5 positive control: results carry the exact input titles',
      Array.isArray(result) && result.every((r: any, i: number) => r.title === TITLES[i]),
    );
  }

  // 5b. TRUNCATED-BUT-PARTIALLY-SALVAGEABLE (Task #978) — a token-cap reply that
  //     carries 2 COMPLETE result objects followed by a third object cut off
  //     mid-array. parseAiJson fails on the unterminated JSON, so the salvage
  //     path (salvageJsonObjectArray, complete-`{...}`-elements-only) must
  //     recover exactly the 2 finished items — bound to their input titles by
  //     the echoed index — while the truncated third stays unclassified and
  //     retries next pass. A regression here silently discards the salvageable
  //     half of every truncated chunk.
  {
    const complete = (index: number) =>
      JSON.stringify({
        index,
        title: TITLES[index - 1],
        is_relevant: true,
        reason: 'test',
        tags: [],
        priority_score: 80 - index * 7,
        category: 'general',
      });
    // Two complete objects, then a third that is cut off mid-object (no closing
    // brace, no array/object terminators) — exactly how a token cap truncates.
    const truncatedReply =
      '```json\n{"results":[' +
      complete(1) +
      ',' +
      complete(2) +
      ',{"index":3,"title":"' +
      TITLES[2].slice(0, 20);
    stubReply(truncatedReply);
    let result: any = null;
    let threw = false;
    try {
      result = await analyzeCuratedBatch(TITLES);
    } catch (e) {
      threw = true;
      console.error('[analyzer-failsafe] truncated-salvage THREW:', e);
    } finally {
      restore();
    }
    check('5b truncated salvage: does not throw', !threw);
    check(
      '5b truncated salvage: exactly the 2 complete items come back',
      Array.isArray(result) && result.length === 2,
      `got ${Array.isArray(result) ? result.length : JSON.stringify(result)?.slice(0, 200)}`,
    );
    check(
      '5b truncated salvage: recovered items bound to the correct input titles',
      Array.isArray(result) &&
        result.length === 2 &&
        result[0]?.title === TITLES[0] &&
        result[1]?.title === TITLES[1],
      `titles=${JSON.stringify((result || []).map((r: any) => r?.title))}`,
    );
    check(
      '5b truncated salvage: the truncated third item stays unclassified',
      Array.isArray(result) && !result.some((r: any) => r?.title === TITLES[2]),
      `titles=${JSON.stringify((result || []).map((r: any) => r?.title))}`,
    );
  }

  // ===== TRANSLATOR =====
  const ES = [
    'Cuba denuncia nuevas sanciones de Estados Unidos',
    'Irán advierte sobre escalada en el estrecho de Ormuz',
    'China refuerza su presencia naval en el Pacífico',
  ];
  // The caller contract: effective title = map.get(original) ?? original.
  // So "never drops an input" == for every input, the effective title is a
  // non-empty string (either a translation or the preserved original).
  async function translatorCase(name: string, reply: string | null, expectTranslated = 0) {
    stubReply(reply);
    let threw = false;
    let map: Map<string, string> | null = null;
    try {
      map = await translateCuratedTitlesToEnglish(ES);
    } catch (e) {
      threw = true;
      console.error(`[analyzer-failsafe] translate THREW on ${name}:`, e);
    } finally {
      restore();
    }
    check(`${name}: translator does not throw`, !threw);
    check(`${name}: translator returns a Map`, map instanceof Map);
    const effective = ES.map((t) => map?.get(t) ?? t);
    check(
      `${name}: every input keeps a non-empty effective title (no drops)`,
      effective.every((t) => typeof t === 'string' && t.trim().length > 0),
      `effective=${JSON.stringify(effective)}`,
    );
    check(
      `${name}: exactly ${expectTranslated} translated, the rest preserve the original`,
      (map?.size ?? -1) === expectTranslated &&
        effective.filter((t, i) => t !== ES[i]).length === expectTranslated,
      `map.size=${map?.size}, effective=${JSON.stringify(effective)}`,
    );
  }

  await translatorCase('6 empty content', null);
  await translatorCase(
    '7 non-JSON prose',
    "I'm sorry, I cannot translate these headlines.",
  );
  await translatorCase('8 valid-JSON-wrong-shape', '{"results":"nope","translations":42}');
  // 9. Partial garbage: one well-formed, exactly-echoed row among junk rows
  //    (garbled echo, missing english_title, out-of-range index). Only the
  //    good row translates; every other input preserves its original title.
  await translatorCase(
    '9 partial garbage keeps unmatched originals',
    JSON.stringify({
      results: [
        { index: 1, original: ES[0], english_title: 'Cuba denounces new US sanctions' },
        { index: 2, original: 'totally garbled echo that matches nothing', english_title: 'Smeared translation must be dropped' },
        { index: 3, original: ES[2] }, // missing english_title -> skipped
        { index: 99, english_title: 'Out-of-range index with no echo' },
      ],
    }),
    1,
  );
  // 10. Positive control: a fully valid reply translates everything.
  await translatorCase(
    '10 positive control: valid reply translates all',
    JSON.stringify({
      results: ES.map((t, i) => ({
        index: i + 1,
        original: t,
        english_title: `English translation ${i + 1}`,
      })),
    }),
    3,
  );

  // -------------------------------------------------------------------------
  if (failures > 0) {
    console.error(`\n[analyzer-failsafe] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[analyzer-failsafe] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[analyzer-failsafe] UNEXPECTED ERROR', e);
  process.exit(1);
});
