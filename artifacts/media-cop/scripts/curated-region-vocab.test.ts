// Gate: curated region-field hygiene (coerceRegionField).
//
// Guards the write-time region validation applied in
// storage.upsertCuratedClassifications. Since Task #25 this is a STRICT
// allowlist gate: the Focus filters fragmented on off-list model regions
// ("Asia" vs "Indo-Pacific"), so the coercion must:
//   1. canonicalize case-variant vocab spellings,
//   2. snap known off-list aliases ("Asia", "Oceania", "South America", …)
//      onto their canonical operating environment via REGION_ALIASES,
//   3. null EVERYTHING else off-list (including the region==country
//      corruption class) — an off-list value is never persisted,
//   4. never invent a replacement region.
//
// Pure-function gate — no DB, no network. Exit 0 = pass, 1 = fail.

import { coerceRegionField, REGIONS, REGION_ALIASES } from "../shared/classificationVocab";

let checks = 0;
let failures = 0;

function expect(label: string, actual: string | null, want: string | null) {
  checks++;
  const ok = actual === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label} → ${JSON.stringify(actual)} (want ${JSON.stringify(want)})`);
}

// 1. Canonical vocab values pass through untouched (every one of the 12).
for (const r of REGIONS) {
  expect(`vocab passthrough "${r}"`, coerceRegionField(r, "Iran"), r);
}

// 2. Case-insensitive canonicalization to the canonical spelling.
expect('canonicalize "europe"', coerceRegionField("europe", "France"), "Europe");
expect('canonicalize "NORTH AMERICA"', coerceRegionField("NORTH AMERICA", "United States"), "North America");
expect('canonicalize "indo-pacific"', coerceRegionField("indo-pacific", "China"), "Indo-Pacific");
expect('canonicalize with whitespace "  Middle East  "', coerceRegionField("  Middle East  ", null), "Middle East");

// 3. Every registered alias snaps to its canonical target (and the target is
//    itself on the canonical list).
for (const [alias, target] of Object.entries(REGION_ALIASES)) {
  expect(`alias "${alias}" → "${target}"`, coerceRegionField(alias, null), target);
  if (!(REGIONS as readonly string[]).includes(target)) {
    failures++;
    console.log(`FAIL: alias target "${target}" is not a canonical region`);
  }
}

// 4. Alias matching is case/spacing-insensitive.
expect('alias "asia" (lowercase)', coerceRegionField("asia", "China"), "Indo-Pacific");
expect('alias "SOUTH AMERICA"', coerceRegionField("SOUTH AMERICA", "Brazil"), "Latin America");
expect('alias "  Oceania  "', coerceRegionField("  Oceania  ", "Australia"), "Indo-Pacific");

// 5. The corruption class: country duplicated into region → null (unless the
//    value is itself canonical/aliased — "Australia" now aliases to
//    Indo-Pacific by design).
expect('corruption "United Kingdom"=="United Kingdom"', coerceRegionField("United Kingdom", "United Kingdom"), null);
expect('corruption "United States"=="United States"', coerceRegionField("United States", "United States"), null);
expect('corruption "China"=="China"', coerceRegionField("China", "China"), null);
expect('"Australia" aliases even when country matches', coerceRegionField("Australia", "Australia"), "Indo-Pacific");

// 6. TRUE off-list values are nulled — never persisted verbatim.
expect('off-list "Central Asia" → null', coerceRegionField("Central Asia", "Kazakhstan"), null);
expect('off-list "Antarctica" → null', coerceRegionField("Antarctica", null), null);
expect('off-list "United Kingdom" (no country) → null', coerceRegionField("United Kingdom", null), null);
expect('off-list "Narnia" → null', coerceRegionField("Narnia", null), null);

// 7. Empty / null handling.
expect("null region", coerceRegionField(null, "Iran"), null);
expect("undefined region", coerceRegionField(undefined, "Iran"), null);
expect('empty region ""', coerceRegionField("", "Iran"), null);
expect('whitespace region "   "', coerceRegionField("   ", "Iran"), null);

// 8. A vocab region is NEVER nulled even when the country carries the same
//    string — the vocab match wins.
expect('vocab wins over dup check', coerceRegionField("Global", "Global"), "Global");

// Completion sentinel — guard against a vacuous pass (harness-reliability
// convention): every check above must actually have run.
const EXPECTED_CHECKS =
  REGIONS.length + 4 + Object.keys(REGION_ALIASES).length + 3 + 4 + 4 + 4 + 1;
if (checks !== EXPECTED_CHECKS) {
  console.error(`GATE FAIL: expected ${EXPECTED_CHECKS} checks, ran ${checks} — harness incomplete`);
  process.exit(1);
}
if (failures > 0) {
  console.error(`GATE FAIL: ${failures}/${checks} checks failed`);
  process.exit(1);
}
console.log(`GATE PASS: all ${checks} region-hygiene checks passed`);
process.exit(0);
