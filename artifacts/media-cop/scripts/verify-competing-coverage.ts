// One-off verification for the reworked Competing Coverage fetcher (Task #203).
// Run: npx tsx scripts/verify-competing-coverage.ts
// Prints the ranked, diverse, blind-spot-tagged items for both scopes so we can
// eyeball that Google News RSS parsing, source-stripping, ranking, and blind-spot
// detection all behave before wiring the UI. NOT used at runtime.
import { __testables } from "../server/competingCoverage";

function fmt(arr: any[]): string {
  if (arr.length === 0) return "  (none)";
  return arr
    .map(
      (i) =>
        `  #${i.rank} [${i.category}]${i.blindSpot ? " [BLIND SPOT]" : ""} ${i.headline}\n` +
        `      source=${i.source ?? "?"}  outlets=${i.outletCount}  url=${i.url ? "yes" : "NO"}`,
    )
    .join("\n");
}

async function main() {
  const {
    buildScope,
    tagBlindSpots,
    loadMcopFeedTokenSets,
    selectBuzz,
    DOMESTIC_TOPICS,
    INTL_TOPICS,
    DOMESTIC_MAX_ITEMS,
    INTL_MAX_ITEMS,
  } = __testables;

  console.log("Fetching DOMESTIC scope (Google News RSS)...");
  const dom = await buildScope(DOMESTIC_TOPICS, DOMESTIC_MAX_ITEMS);
  console.log(`  -> selected ${dom.length} domestic items`);

  console.log("Fetching INTERNATIONAL scope (Google News RSS)...");
  const intl = await buildScope(INTL_TOPICS, INTL_MAX_ITEMS);
  console.log(`  -> selected ${intl.length} international items`);

  console.log("Loading MCOP feed token sets for blind-spot diff...");
  const feed = await loadMcopFeedTokenSets();
  console.log(`  -> feed token sets: ${feed ? feed.length : "null (read failed)"}`);

  const domTagged = tagBlindSpots(dom, feed);
  const intlTagged = tagBlindSpots(intl, feed);

  console.log("\n=== DOMESTIC ===");
  console.log(fmt(domTagged));
  console.log("\n=== INTERNATIONAL ===");
  console.log(fmt(intlTagged));

  const blind = [...domTagged, ...intlTagged].filter((i) => i.blindSpot).length;
  console.log(
    `\nTotal: ${domTagged.length + intlTagged.length} items, ${blind} flagged as blind spots.`,
  );

  console.log("\nSelecting BUZZ (Google Trends, de-duped vs coverage + feed)...");
  const buzz = await selectBuzz([...domTagged, ...intlTagged], feed);
  if (buzz) {
    console.log(
      `  TRENDING: ${buzz.category}\n      headline=${buzz.headline}\n      source=${buzz.source ?? "?"}  url=${buzz.url ? "yes" : "NO"}`,
    );
  } else {
    console.log("  (no fresh buzz item — fail-silent, keep last-good)");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("verify failed:", e);
  process.exit(1);
});
