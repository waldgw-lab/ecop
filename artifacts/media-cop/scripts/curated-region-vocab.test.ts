// Gate: curated region-field hygiene (coerceRegionField).
//
// Guards the write-time region validation applied in
// storage.upsertCuratedClassifications: the model sometimes duplicates the
// COUNTRY into the region field (region="United Kingdom", country="United
// Kingdom"), corrupting region's area-of-impact semantics. The coercion must:
//   1. canonicalize case-variant vocab spellings,
//   2. null the region==country corruption class (non-vocab only),
//   3. PRESERVE off-list broad labels ("Asia") that readers tolerate,
//   4. never invent a replacement region.
//
// Pure-function gate — no DB, no network. Exit 0 = pass, 1 = fail.

import { coerceRegionField, REGIONS } from "../shared/classificationVocab";

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

// 3. The corruption class: country duplicated into region → null.
expect('corruption "United Kingdom"=="United Kingdom"', coerceRegionField("United Kingdom", "United Kingdom"), null);
expect('corruption "United States"=="United States"', coerceRegionField("United States", "United States"), null);
expect('corruption "Australia"=="Australia"', coerceRegionField("Australia", "Australia"), null);
expect('corruption "China"=="China"', coerceRegionField("China", "China"), null);
expect('corruption is case-insensitive "china"=="China"', coerceRegionField("china", "China"), null);

// 4. Off-list broad labels that do NOT duplicate the country are preserved
//    verbatim (prod has thousands of tolerated "Asia"/"South Asia" rows —
//    nulling them would silently degrade Top Narratives geo bucketing).
expect('preserve off-list "Asia" (country China)', coerceRegionField("Asia", "China"), "Asia");
expect('preserve off-list "South Asia" (country India)', coerceRegionField("South Asia", "India"), "South Asia");
expect('preserve off-list "Oceania" (country Australia)', coerceRegionField("Oceania", "Australia"), "Oceania");
expect('preserve off-list "Caribbean" (no country)', coerceRegionField("Caribbean", null), "Caribbean");

// 5. Empty / null handling.
expect("null region", coerceRegionField(null, "Iran"), null);
expect("undefined region", coerceRegionField(undefined, "Iran"), null);
expect('empty region ""', coerceRegionField("", "Iran"), null);
expect('whitespace region "   "', coerceRegionField("   ", "Iran"), null);

// 6. A vocab region is NEVER nulled even in the (theoretical) case a country
//    field carries the same string — the vocab match wins before the dup check.
expect('vocab wins over dup check', coerceRegionField("Global", "Global"), "Global");

// 7. Missing/empty country → dup check can't fire; off-list value preserved.
expect('off-list preserved when country empty', coerceRegionField("United Kingdom", ""), "United Kingdom");
expect('off-list preserved when country null', coerceRegionField("United Kingdom", null), "United Kingdom");

// Completion sentinel — guard against a vacuous pass (harness-reliability
// convention): every check above must actually have run.
const EXPECTED_CHECKS = 12 + 4 + 5 + 4 + 4 + 1 + 2;
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
