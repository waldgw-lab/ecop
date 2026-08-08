/**
 * Regression test for the curated AI JSON parsing hardening.
 *
 * The Curated lane's Topic chip rendered "—" because the AI analyzer's reply
 * was sometimes TRUNCATED at the token cap. A truncated reply leaves an
 * unterminated ```json fence; the parser threw "Unexpected token '`'", the
 * WHOLE curated batch was dropped, and rows never received a primary_topic.
 *
 * The fix (server/aiClient.ts) hardens two exported helpers:
 *   - parseAiJson<T>()        — tolerant parse, returns null instead of throwing
 *   - salvageJsonObjectArray() — brace-scan that recovers the COMPLETE objects
 *                                from a truncated array so a partial batch still
 *                                classifies what came back.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-json-salvage.test.ts
 * Exits non-zero on any failure.
 */
import { parseAiJson, salvageJsonObjectArray } from "../server/aiClient";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("[json-salvage] parseAiJson");

// 1. Clean JSON object parses.
{
  const r = parseAiJson<{ a: number }>('{"a":1}');
  check("clean object parses", !!r && r.a === 1);
}

// 2. A complete ```json fenced object parses.
{
  const r = parseAiJson<{ ok: boolean }>('```json\n{"ok":true}\n```');
  check("complete fenced object parses", !!r && r.ok === true);
}

// 3. An UNTERMINATED ```json fence (truncated mid-object) returns null, not throw.
{
  let threw = false;
  let r: any = "sentinel";
  try {
    r = parseAiJson('```json\n{"results":[{"title":"abc","prio');
  } catch {
    threw = true;
  }
  check("truncated fence returns null without throwing", !threw && r === null);
}

console.log("[json-salvage] salvageJsonObjectArray");

// 4. Truncated results array: recover the complete elements, drop the partial one.
{
  const truncated =
    '```json\n{"results":[' +
    '{"title":"one","primary_topic":"Foreign Policy & Diplomacy"},' +
    '{"title":"two","primary_topic":"Defense Policy & Military Readiness"},' +
    '{"title":"thr'; // truncated mid third object
  const objs = salvageJsonObjectArray(truncated);
  check(
    "recovers 2 complete objects from truncated 3-object array",
    objs.length === 2 && objs[0].title === "one" && objs[1].title === "two",
    `got ${objs.length}`,
  );
}

// 5. Nested arrays/objects, braces inside strings, and escaped quotes are intact.
{
  const tricky =
    '{"results":[' +
    '{"title":"has { and ] in it","tags":["a","b"],"nested":{"k":[1,2]},"q":"a \\"quote\\" here"},' +
    '{"title":"second","tags":[]},' +
    '{"title":"trunc'; // truncated
  const objs = salvageJsonObjectArray(tricky);
  const first = objs[0];
  check(
    "preserves nested arrays/objects + braces-in-strings + escaped quotes",
    objs.length === 2 &&
      first.title === "has { and ] in it" &&
      Array.isArray(first.tags) &&
      first.tags.length === 2 &&
      first.nested.k.length === 2 &&
      first.q === 'a "quote" here',
    JSON.stringify(objs[0]),
  );
}

// 6. A stray '[' in leading prose must not misdirect the keyed-array scan.
{
  const withProse =
    'Here is the data [note] you requested:\n```json\n{"results":[' +
    '{"title":"keyed"},{"title":"works"},{"title":"par';
  const objs = salvageJsonObjectArray(withProse);
  check(
    "keyed-array preference ignores stray bracket in prose",
    objs.length === 2 && objs[0].title === "keyed" && objs[1].title === "works",
    `got ${objs.length}`,
  );
}

// 7. Empty / null input is safe.
{
  check("null input -> []", salvageJsonObjectArray(null).length === 0);
  check("empty input -> []", salvageJsonObjectArray("").length === 0);
}

if (failures > 0) {
  console.error(`\n[json-salvage] FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\n[json-salvage] All checks passed");
process.exit(0);
