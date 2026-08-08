/**
 * Task #336 — One-time historical deterministic remap of the curated label store.
 *
 * DERIVES the controlled-vocabulary GROUPING bucket (`primary_topic`, plus
 * `conflict_track` + `scope`) from each row's EXISTING free-form `category`
 * using the deterministic mapping table + conflict keyword rules in
 * `shared/classificationVocab.ts` — NO LLM. The specific free-form `category`
 * is KEPT as the card label (it is NOT overwritten); the derived bucket is
 * stored alongside it. The original label is also snapshotted into
 * `legacy_category` for audit/reversal; unmatched residue maps the bucket to
 * `Other / Emerging` (decision knob (a), the cost-controlled default) while the
 * specific category still shows on the card.
 *
 * CURATED-LANE ONLY: touches `curated_classifications` + `curated_items` only.
 * Never reads or writes `headlines`, Main/Visual, custom-MCOPs, or the public
 * API. Classification is enrichment — never an admission/relevance/ranking input
 * — so this changes display labels only and leaves clustering/archive identity
 * untouched.
 *
 * IDEMPOTENT + RESUMABLE: the marker for "already remapped / already on the new
 * vocabulary" is `primary_topic IS NOT NULL`. Only rows whose primary_topic is
 * still null are processed, so a re-run (or a run interrupted partway) skips the
 * rows it already converted. Default is a DRY RUN; pass `--apply` to write.
 *
 *   npx tsx scripts/curated-classification-remap.ts            # dry run
 *   npx tsx scripts/curated-classification-remap.ts --apply    # write changes
 */
import { db } from "../server/db";
import { curatedClassifications, curatedItems } from "@shared/schema";
import { eq, isNull } from "drizzle-orm";
import {
  remapLegacyCategory,
  deriveScope,
  OTHER_EMERGING,
} from "@shared/classificationVocab";

const APPLY = process.argv.includes("--apply");
// Re-process rows that already landed on `Other / Emerging` in a PRIOR pass,
// re-deriving their bucket from the retained `legacy_category` against the
// (now expanded) deterministic rules. Needed because the default run is guarded
// by `primary_topic IS NULL`, which skips every already-remapped backlog row.
const REAPPLY_CATCHALL = process.argv.includes("--reapply-catchall");

async function main() {
  console.log(
    `\n=== Curated classification ${REAPPLY_CATCHALL ? "catch-all re-apply" : "historical remap"} (${APPLY ? "APPLY" : "DRY RUN"}) ===\n`,
  );

  // Title text per URL (improves conflict_track inference) from curated_items.
  const items = await db
    .select({
      id: curatedItems.id,
      url: curatedItems.url,
      title: curatedItems.title,
      category: curatedItems.category,
    })
    .from(curatedItems);
  const titleByUrl = new Map<string, string>();
  for (const it of items) titleByUrl.set(it.url, it.title);

  // ---- Catch-all re-apply mode -------------------------------------------
  // Re-derive the bucket for rows that fell to `Other / Emerging` in a prior
  // pass, using their RETAINED legacy_category against the expanded rules. Only
  // rows that NOW match a real topic are written; still-unmatched rows are left
  // untouched (no classifiedAt churn). The specific `category` card label and
  // `legacy_category` audit snapshot are never overwritten.
  if (REAPPLY_CATCHALL) {
    const catchAllRows = await db
      .select()
      .from(curatedClassifications)
      .where(eq(curatedClassifications.primaryTopic, OTHER_EMERGING));

    let upgraded = 0;
    let stillResidue = 0;
    let trackAdded = 0;
    const upTopicCounts = new Map<string, number>();

    for (const row of catchAllRows) {
      const source = row.legacyCategory ?? row.category; // original free-form label
      const title = titleByUrl.get(row.url) ?? null;
      const result = remapLegacyCategory(source, title);
      if (!result.matched || result.primaryTopic === OTHER_EMERGING) {
        stillResidue++;
        continue;
      }
      upgraded++;
      upTopicCounts.set(
        result.primaryTopic,
        (upTopicCounts.get(result.primaryTopic) ?? 0) + 1,
      );
      const conflictTrack = row.conflictTrack ?? result.conflictTrack ?? null;
      if (!row.conflictTrack && conflictTrack) trackAdded++;
      if (APPLY) {
        await db
          .update(curatedClassifications)
          .set({ primaryTopic: result.primaryTopic, conflictTrack, classifiedAt: new Date() })
          .where(eq(curatedClassifications.url, row.url));
      }
    }

    console.log(`Catch-all rows scanned        : ${catchAllRows.length}`);
    console.log(`  upgraded to a real topic    : ${upgraded}`);
    console.log(`  still residue (no rule fits): ${stillResidue}`);
    console.log(`  newly carried conflict_track: ${trackAdded}`);
    console.log(`\n  upgrade distribution:`);
    for (const [topic, n] of [...upTopicCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(5)}  ${topic}`);
    }
    if (!APPLY) {
      console.log(`\n(DRY RUN — no rows written. Re-run with --apply --reapply-catchall to commit.)\n`);
    } else {
      console.log(`\nDone. Catch-all backlog re-derived against the expanded rules.\n`);
    }
    return;
  }

  // ---- Phase A: curated_classifications (the canonical label store) ----
  const rows = await db
    .select()
    .from(curatedClassifications)
    .where(isNull(curatedClassifications.primaryTopic));

  let matched = 0;
  let residue = 0;
  let withTrack = 0;
  const topicCounts = new Map<string, number>();

  for (const row of rows) {
    const title = titleByUrl.get(row.url) ?? null;
    const result = remapLegacyCategory(row.category, title);
    const primaryTopic = result.primaryTopic;
    const conflictTrack = row.conflictTrack ?? result.conflictTrack ?? null;
    const scope = row.scope ?? deriveScope({ topicCountry: row.country, region: row.region });
    // Retain the ORIGINAL free-form label for audit/reversal (only stamp it once).
    const legacyCategory = row.legacyCategory ?? row.category;

    if (result.matched) matched++;
    else residue++;
    if (conflictTrack) withTrack++;
    topicCounts.set(primaryTopic, (topicCounts.get(primaryTopic) ?? 0) + 1);

    if (APPLY) {
      await db
        .update(curatedClassifications)
        .set({
          primaryTopic,
          conflictTrack,
          scope,
          legacyCategory,
          // The SPECIFIC free-form `category` is intentionally NOT touched — it
          // stays the card label. Only the derived grouping bucket
          // (primary_topic) + track + scope are written alongside it.
          classifiedAt: new Date(),
        })
        .where(eq(curatedClassifications.url, row.url));
    }
  }

  // ---- Phase B: backfill a classification row for ORPHAN curated_items ----
  // curated_items.category is the SPECIFIC card label and is LEFT UNTOUCHED.
  // Items that already have a classification row got their bucket in Phase A.
  // Items WITHOUT one get a fresh classification row whose `category` is the
  // item's specific label (kept) and whose `primary_topic` is the DERIVED
  // grouping bucket — so the archive isn't permanently un-bucketed.
  const classUrls = new Set<string>();
  const allClass = await db
    .select({ url: curatedClassifications.url })
    .from(curatedClassifications);
  for (const c of allClass) classUrls.add(c.url);

  let itemsOrphanClassified = 0;
  for (const it of items) {
    if (classUrls.has(it.url)) continue; // already has a classification row
    const result = remapLegacyCategory(it.category, it.title);
    itemsOrphanClassified++;
    if (APPLY) {
      await db
        .insert(curatedClassifications)
        .values({
          url: it.url,
          category: it.category, // keep the SPECIFIC label as the card label
          primaryTopic: result.primaryTopic, // derived grouping bucket
          conflictTrack: result.conflictTrack ?? null,
          scope: deriveScope({ topicCountry: null, region: null }),
          legacyCategory: it.category,
        })
        .onConflictDoNothing({ target: curatedClassifications.url });
    }
  }

  // ---- Report ----
  const total = matched + residue;
  console.log(`Phase A — curated_classifications (legacy rows w/ null primary_topic): ${total}`);
  console.log(`  matched to a real topic : ${matched}`);
  console.log(`  residue → ${OTHER_EMERGING} : ${residue}`);
  console.log(`  carried a conflict_track : ${withTrack}`);
  if (total > 0) {
    console.log(`  coverage (matched/total) : ${((matched / total) * 100).toFixed(1)}%`);
  }
  console.log(`\n  topic distribution:`);
  for (const [topic, n] of [...topicCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${topic}`);
  }
  console.log(`\nPhase B — curated_items:`);
  console.log(`  orphan items given a classification row : ${itemsOrphanClassified}`);

  if (!APPLY) {
    console.log(`\n(DRY RUN — no rows written. Re-run with --apply to commit.)\n`);
  } else {
    console.log(`\nDone. Specific category kept as the card label; grouping bucket derived alongside.\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Remap failed:", err);
    process.exit(1);
  });
