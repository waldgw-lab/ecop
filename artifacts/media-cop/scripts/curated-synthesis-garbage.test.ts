/**
 * Curated SYNTHESIS garbage-recovery regression (Task #729).
 *
 * Task #728 (curated-garbage-recovery.test.ts) pinned the fail-safe for the
 * CLUSTERING call when the model RETURNS (not throws) a 200 with a malformed
 * body. The sibling per-story SYNTHESIS call (synthesizeStory in
 * server/curatedSynthesis.ts) was only covered for THROWN/timeout errors
 * (curated-timeout-recovery.test.ts TEST 4). This suite closes the gap: when
 * the synthesis model resolves with garbage, synthesizeStory must return null
 * (skip that ONE story this pass — cluster preserved, retried next pass),
 * never throw, and never hand back an empty/partial SynthResult that would be
 * persisted as a blank story card.
 *
 *   1. TRUNCATED JSON (200 OK, reply cut off at the token cap mid-object)
 *      -> null. parseAiJson is strict (no salvage on the synthesis path).
 *   2. VALID JSON but WRONG SHAPE (an unrelated object with none of the
 *      synthesis fields) -> null. Guarded by the wrong-shape fail-safe:
 *      headline/lede/facts all empty after validation means garbage, and must
 *      NOT be returned as an all-empty SynthResult (which the caller would
 *      persist as a blanked summary).
 *   3. PROSE refusal (200 OK, no JSON at all) -> null.
 *   4. Sanity: a WELL-FORMED reply through the same stub still returns a real
 *      SynthResult — proving the wrong-shape guard doesn't over-trigger and
 *      the stub actually exercises the parse path.
 *
 * Stubbing strategy mirrors curated-timeout-recovery.test.ts TEST 4: swap
 * openai.chat.completions.create for a stub that RESOLVES with the fixture
 * body (the timeout suite could only make it throw).
 *
 * Run directly with tsx (no test framework configured):
 *   npx tsx scripts/curated-synthesis-garbage.test.ts
 * Exits non-zero on any failure.
 */
import { synthesizeStory, type SynthMember } from '../server/curatedSynthesis';
import { openai } from '../server/aiClient';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[synthesis-garbage] OK   ${name}`);
  } else {
    console.error(`[synthesis-garbage] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

function members(): SynthMember[] {
  return [
    {
      key: 'curated:s1',
      url: 'https://www.reuters.com/world/iran-us-nuclear-talks-collapse',
      source: 'Reuters',
      sourceIdentifier: 'news-international',
      factuality: 'high',
      ownership: ['thomson reuters'],
      title: 'Iran and US nuclear talks collapse after final round in Geneva',
      summary: null,
      bullets: null,
      cls: 'corroborating',
      label: 'primary',
    },
    {
      key: 'curated:s2',
      url: 'https://apnews.com/article/iran-us-nuclear-talks-geneva',
      source: 'Associated Press',
      sourceIdentifier: 'news-us-domestic',
      factuality: 'high',
      ownership: ['associated press'],
      title: 'US-Iran nuclear negotiations break down in final Geneva round',
      summary: null,
      bullets: null,
      cls: 'corroborating',
      label: 'primary',
    },
  ];
}

// Run synthesizeStory with the model RESOLVING to `content` (200-OK-bad-body —
// the path the timeout suite can never reach). Returns { result, threw, calls }.
async function runWith(content: string) {
  const origCreate = openai.chat.completions.create;
  let calls = 0;
  (openai.chat.completions as any).create = async () => {
    calls++;
    return { choices: [{ message: { content } }] } as any;
  };
  let threw = false;
  let result: any = 'unset';
  try {
    result = await synthesizeStory(members());
  } catch (e) {
    threw = true;
    console.error('[synthesis-garbage] synthesizeStory THREW:', e);
  } finally {
    (openai.chat.completions as any).create = origCreate;
  }
  return { result, threw, calls };
}

async function main() {
  // =========================================================================
  // TEST 1 — TRUNCATED JSON (token cap hit mid-object) -> null, no throw.
  // Looks like the start of a real synthesis payload, so a salvaging parser
  // could be fooled into producing a partial result — it must not be.
  // =========================================================================
  {
    const { result, threw, calls } = await runWith(
      '```json\n{"headline":"Iran-US talks collapse","lede":"Talks between Iran and the US collapsed","facts":["Negotiations en',
    );
    check('1a truncated JSON reply does not throw', !threw);
    check(
      '1b truncated JSON reply returns null (story skipped, not a partial summary)',
      result === null,
      `got ${JSON.stringify(result)}`,
    );
    check('1c the AI call was actually reached', calls >= 1, `calls=${calls}`);
  }

  // =========================================================================
  // TEST 2 — VALID JSON, WRONG SHAPE (none of the synthesis fields) -> null.
  // Without the wrong-shape guard this parsed fine and produced an ALL-EMPTY
  // SynthResult (headline:'', lede:'', facts:[]) that the caller would persist
  // as a blanked story summary.
  // =========================================================================
  {
    const { result, threw } = await runWith(
      '{"clusters":[{"indices":[1,2]}],"note":"model answered the wrong task"}',
    );
    check('2a wrong-shape valid-JSON reply does not throw', !threw);
    check(
      '2b wrong-shape valid-JSON reply returns null (never an empty SynthResult)',
      result === null,
      `got ${JSON.stringify(result)}`,
    );
  }

  // =========================================================================
  // TEST 3 — PROSE refusal (no JSON at all) -> null, no throw.
  // =========================================================================
  {
    const { result, threw } = await runWith(
      "I'm sorry, but I can't provide a synthesis of these news articles.",
    );
    check('3a prose refusal reply does not throw', !threw);
    check(
      '3b prose refusal reply returns null (story skipped)',
      result === null,
      `got ${JSON.stringify(result)}`,
    );
  }

  // =========================================================================
  // TEST 4 — sanity: a WELL-FORMED reply via the SAME stub returns a real
  // SynthResult (guard doesn't over-trigger; stub exercises the parse path).
  // =========================================================================
  {
    const good = JSON.stringify({
      headline: 'Iran-US nuclear talks collapse',
      lede: 'Nuclear negotiations between Iran and the United States collapsed after the final round in Geneva.',
      facts: [
        'Talks between Iran and the United States collapsed after the final Geneva round.',
        'Both delegations left Geneva without scheduling further meetings.',
      ],
      factSources: [
        ['curated:s1', 'curated:s2'],
        ['curated:s1', 'curated:s2'],
      ],
      spins: {
        'curated:s1': 'Reuters frames the collapse as a procedural breakdown.',
        'curated:s2': 'AP emphasizes the absence of a follow-up schedule.',
      },
      alignments: {},
      attributedClaims: ['The State Department said talks "ran their course."'],
    });
    const { result, threw } = await runWith(good);
    check('4a well-formed reply does not throw', !threw);
    check(
      '4b well-formed reply returns a real SynthResult (guard does not over-trigger)',
      !!result && result !== null && result.headline.length > 0 && result.lede.length > 0 && result.facts.length === 2,
      `got ${JSON.stringify(result)}`,
    );
    check(
      '4c well-formed reply is corroborated (facts shared across 2 independent owners)',
      !!result && result.corroborated === true,
      `got corroborated=${result?.corroborated}`,
    );
  }

  // -------------------------------------------------------------------------
  if (failures > 0) {
    console.error(`\n[synthesis-garbage] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[synthesis-garbage] all checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[synthesis-garbage] UNEXPECTED ERROR', e);
  process.exit(1);
});
