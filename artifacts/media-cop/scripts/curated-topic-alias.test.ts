// Guard for the near-miss topic coercion aliases (PRIMARY_TOPIC_ALIASES in
// shared/classificationVocab.ts) and the analyzer prompt's few-shot examples.
//
// WHY: production audit found (1) the analyzer prompt's worked example used an
// OFF-LIST topic ("Diplomacy & International Agreements"), contradicting the
// prompt's own copy-verbatim rule; (2) near-miss labels the model actually
// emits (proposals log) fell to "Other / Emerging" instead of snapping to the
// intended real topic. This gate pins:
//   A. every alias target is a REAL topic on the controlled list (a future
//      vocab rename can't silently break an alias);
//   B. each observed production near-miss / typo coerces to its intended topic;
//   C. genuinely off-list subjects still fall to the catch-all (return null);
//   D. ambiguous variants stay UNALIASED;
//   E. every "primary_topic" value in the analyzer prompt's few-shot example
//      block is on the controlled list (no off-list exemplar can return).
//
// Pure + deterministic — no DB / LLM / network. Run: npx tsx scripts/curated-topic-alias.test.ts
import {
  PRIMARY_TOPICS,
  OTHER_EMERGING,
  PRIMARY_TOPIC_ALIASES,
  coercePrimaryTopic,
  isValidPrimaryTopic,
} from "../shared/classificationVocab";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// --- A. every alias target is on the live controlled list --------------------
for (const [alias, target] of Object.entries(PRIMARY_TOPIC_ALIASES)) {
  check(`alias target on-list: ${alias} -> ${target}`,
    (PRIMARY_TOPICS as readonly string[]).includes(target));
  check(`alias key is NOT itself a real topic: ${alias}`,
    !isValidPrimaryTopic(alias));
}

// --- B. observed production near-misses coerce to the intended topic ---------
const cases: Array<[string, string]> = [
  ["Diplomacy & International Agreements", "Foreign Policy & Diplomacy"],
  ["diplomacy and international agreements", "Foreign Policy & Diplomacy"], // loose form
  ["Domestic Stability & Governance", "Governance, Elections & Domestic Stability"],
  ["Domestic Politics & Security", "Governance, Elections & Domestic Stability"],
  ["Energy Security", "Critical Infrastructure, Energy & Supply Chains"],
  ["Energy Security & Supply Chains", "Critical Infrastructure, Energy & Supply Chains"],
  ["Energy Security & Policy", "Critical Infrastructure, Energy & Supply Chains"],
  ["Environmental Security", "Public Health, Disaster & Environmental Security"],
  ["Alliances & Multateral Institutions", "Alliances & Multilateral Institutions"],
  ["Nuclear, WWD & Strategic Deterrence", "Nuclear, WMD & Strategic Deterrence"],
  ["Intelligence, Esp espionage & Security Services", "Intelligence, Espionage & Security Services"],
  ["Security, Espionage & Security Services", "Intelligence, Espionage & Security Services"],
  ["Terrorism, Insinsurgency & Non-State Armed Groups", "Terrorism, Insurgency & Non-State Armed Groups"],
  ["Terrorism, Insservency & Non-State Armed Groups", "Terrorism, Insurgency & Non-State Armed Groups"],
];
for (const [raw, want] of cases) {
  const got = coercePrimaryTopic(raw);
  check(`coerce: ${JSON.stringify(raw)} -> ${want}`, got === want, `got ${got}`);
}

// --- C. genuinely off-list subjects still fall to the catch-all --------------
// (coercePrimaryTopic returns null; the caller then uses Other / Emerging.)
for (const offList of [
  "Arctic Strategy",
  "Cultural Heritage",
  "UFOs & National Security",
  "Critical Incident Monitoring",
  "Sports & Entertainment",
]) {
  check(`off-list stays off-list: ${offList}`, coercePrimaryTopic(offList) === null);
}

// --- D. ambiguous variants stay unaliased ------------------------------------
// Could fit Border/Homeland OR Governance — must NOT be aliased.
check("ambiguous 'Domestic Security & Civil Unrest' unaliased",
  coercePrimaryTopic("Domestic Security & Civil Unrest") === null);

// --- exact list names + catch-all still coerce to themselves ------------------
for (const t of PRIMARY_TOPICS) {
  if (coercePrimaryTopic(t) !== t) { failures++; console.error(`  ✗ identity coercion broke: ${t}`); }
}
check("catch-all identity", coercePrimaryTopic(OTHER_EMERGING) === OTHER_EMERGING);
console.log("  ✓ identity coercion holds for all controlled topics");

// --- E. analyzer prompt few-shot examples only use ON-LIST topics ------------
// Static scan of server/relevanceDefinition.ts: every literal
// "primary_topic": "<value>" in the file must be a controlled-list value.
{
  const src = readFileSync("server/relevanceDefinition.ts", "utf8");
  const re = /"primary_topic":\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  let found = 0;
  const bad: string[] = [];
  while ((m = re.exec(src)) !== null) {
    found++;
    if (!isValidPrimaryTopic(m[1])) bad.push(m[1]);
  }
  check("prompt exemplars found", found > 0, "no primary_topic literals found — scan is vacuous");
  check("all prompt exemplar topics are on-list", bad.length === 0, `off-list: ${bad.join("; ")}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll curated topic alias checks passed");
