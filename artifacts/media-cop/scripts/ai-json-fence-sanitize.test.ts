import { __aiClientInternals } from "../server/aiClient";

const { sanitizeJsonText } = __aiClientInternals;

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS [${label}]`);
  } else {
    failed++;
    console.log(`FAIL [${label}]`);
  }
}

function parses(label: string, raw: string, check: (v: any) => boolean) {
  try {
    const v = JSON.parse(sanitizeJsonText(raw));
    ok(label, check(v));
  } catch {
    failed++;
    console.log(`FAIL [${label}] — sanitized text did not parse`);
  }
}

function stillThrows(label: string, raw: string) {
  try {
    JSON.parse(sanitizeJsonText(raw));
    failed++;
    console.log(`FAIL [${label}] — expected parse to throw`);
  } catch {
    passed++;
    console.log(`PASS [${label}]`);
  }
}

// Already-clean JSON is returned byte-identical (no behavior change for the
// common path — clean json-mode responses are untouched).
ok("clean json is unchanged", sanitizeJsonText('{"a":1}') === '{"a":1}');

// The exact production failure: a ```json-fenced object from the OpenRouter path
// ([CuratedAnalyzer]/[CuratedSynthesis] "Unexpected token '`'").
parses(
  "fenced json object",
  "```json\n{\"results\":[{\"title\":\"hormuz\"}]}\n```",
  (v) => v.results[0].title === "hormuz",
);

// A bare ``` fence with no language tag.
parses("fenced (no lang)", "```\n{\"ok\":true}\n```", (v) => v.ok === true);

// Fence surrounded by stray whitespace.
parses("fenced w/ whitespace", "  ```json\n{\"n\":5}\n```  ", (v) => v.n === 5);

// A fenced top-level array.
parses(
  "fenced array",
  "```json\n[{\"t\":\"x\"}]\n```",
  (v) => Array.isArray(v) && v[0].t === "x",
);

// Leading prose chatter before the JSON object is sliced out.
parses(
  "leading prose then object",
  'Sure, here it is:\n{"results":[]}',
  (v) => Array.isArray(v.results),
);

// Genuinely malformed output still fails to parse, so each caller's existing
// try/catch fail-safe fires exactly as before (no behavior regression).
stillThrows("malformed still throws", "not json at all");
stillThrows("empty string throws", "");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
