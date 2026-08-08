/**
 * Regression test for the Task #927 Curated classification overlay URL-identity
 * merge (server/curatedClassificationMerge.ts).
 *
 * The curated classification overlay (curated_classifications) is keyed by the
 * shared canonical identity URL so cosmetic variants of the SAME article
 * (trailing slash / tracking query / fragment / casing) resolve to ONE overlay
 * row — never two rows that split a Topic label or strand a human override.
 *
 * This test proves:
 *   - two URL variants of one article group under a single canonical key
 *     (so a write under variant A and a read under variant B hit one row), and
 *   - the survivor conflict-resolution order is human > non-null primary_topic
 *     > most recently classified.
 *
 * No test framework is configured — run directly with tsx:
 *   npx tsx scripts/curated-classification-url-merge.test.ts
 * Exits non-zero on any failure.
 */
import {
  groupOverlayRowsByCanonical,
  pickOverlaySurvivor,
  type OverlayMergeRow,
} from "../server/curatedClassificationMerge";
import { normalizeIdentityUrl } from "../server/urlIdentity";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS [${label}]`); }
  else { failed++; console.log(`FAIL [${label}]`); }
}

// ---- Variants of ONE article collapse to a single canonical group ----
const variants: OverlayMergeRow[] = [
  { url: "https://www.cbsnews.com/news/cuba-military-options/", primary_topic: "Military Operations & Armed Conflict", provenance: "ai", classified_at: "2026-07-15T10:00:00Z" },
  { url: "https://www.cbsnews.com/news/cuba-military-options", primary_topic: "Weapons, Procurement & Defense Industry", provenance: "ai", classified_at: "2026-07-15T10:05:00Z" },
  { url: "https://www.cbsnews.com/news/cuba-military-options?utm_source=rss#top", primary_topic: null, provenance: "ai", classified_at: "2026-07-15T09:00:00Z" },
];
const groups = groupOverlayRowsByCanonical(variants);
check("three URL variants collapse into ONE canonical group", groups.size === 1);
const canonical = normalizeIdentityUrl(variants[0].url);
check("canonical group key present", groups.has(canonical) && (groups.get(canonical)!.length === 3));

// A read under a DIFFERENT variant resolves to the same canonical key.
check(
  "variant A and variant B share a canonical key (write-A / read-B hit one row)",
  normalizeIdentityUrl(variants[0].url) === normalizeIdentityUrl(variants[1].url),
);

// ---- Survivor: human always wins ----
const withHuman: OverlayMergeRow[] = [
  { url: "https://x.com/a", primary_topic: "Cyber & Information Operations", provenance: "ai", classified_at: "2026-07-15T12:00:00Z" },
  { url: "https://x.com/a/", primary_topic: "Military Operations & Armed Conflict", provenance: "human", classified_at: "2026-07-14T00:00:00Z" },
];
check(
  "human-provenance row wins even when older and even against a non-null AI label",
  pickOverlaySurvivor(withHuman).provenance === "human",
);

// ---- Survivor: non-null primary_topic beats null (both AI) ----
const labelBeatsNull: OverlayMergeRow[] = [
  { url: "https://y.com/b?utm_source=x", primary_topic: null, provenance: "ai", classified_at: "2026-07-15T12:00:00Z" },
  { url: "https://y.com/b", primary_topic: "Diplomacy & Statecraft", provenance: "ai", classified_at: "2026-07-15T11:00:00Z" },
];
check(
  "non-null primary_topic wins over a newer unclassified row",
  pickOverlaySurvivor(labelBeatsNull).primary_topic === "Diplomacy & Statecraft",
);

// ---- Survivor: tie-break by most recent classified_at ----
const recencyTie: OverlayMergeRow[] = [
  { url: "https://z.com/c", primary_topic: "Economic Statecraft & Sanctions", provenance: "ai", classified_at: "2026-07-15T08:00:00Z" },
  { url: "https://z.com/c/", primary_topic: "Maritime & Freedom of Navigation", provenance: "ai", classified_at: "2026-07-15T09:30:00Z" },
];
check(
  "equal-rank rows tie-break to the most recently classified",
  pickOverlaySurvivor(recencyTie).primary_topic === "Maritime & Freedom of Navigation",
);

// ---- Degenerate: empty-normalizing URLs are dropped from grouping ----
const degenerate: OverlayMergeRow[] = [
  { url: "   ", primary_topic: null, provenance: "ai" },
  { url: "https://ok.com/a", primary_topic: "X", provenance: "ai" },
];
check("empty-normalizing URLs are dropped", groupOverlayRowsByCanonical(degenerate).size === 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
