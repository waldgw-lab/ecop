/**
 * Task #336 — Dev coverage measurement for the controlled-vocabulary curated
 * classification layer.
 *
 * Reports, over the REAL curated label store (`curated_classifications`), the
 * share of items landing on a real primary_topic vs. the `Other / Emerging`
 * catch-all, plus conflict_track / scope coverage and the human-gated topic
 * proposal backlog. This is the "measure coverage before trusting the vocab"
 * step — read-only, CURATED-LANE ONLY (never reads headlines / Main / Visual).
 *
 *   npx tsx scripts/curated-classification-coverage.ts
 */
import { db } from "../server/db";
import { curatedClassifications, classificationTopicProposals } from "@shared/schema";
import { isValidPrimaryTopic, OTHER_EMERGING } from "@shared/classificationVocab";
import { buildCuratedCandidateWindow, isGenericCategory } from "../server/curatedClassify";
import { storage } from "../server/storage";

async function main() {
  console.log(`\n=== Curated classification coverage (dev) ===\n`);

  const rows = await db
    .select({
      primaryTopic: curatedClassifications.primaryTopic,
      conflictTrack: curatedClassifications.conflictTrack,
      scope: curatedClassifications.scope,
      proposedTopic: curatedClassifications.proposedTopic,
    })
    .from(curatedClassifications);

  const total = rows.length;
  if (total === 0) {
    console.log("No curated classification rows present.\n");
    process.exit(0);
  }

  let classified = 0; // has a non-null primary_topic (generated or remapped)
  let onRealTopic = 0; // a real enum topic (not the catch-all)
  let onCatchAll = 0; // Other / Emerging
  let invalid = 0; // off-list value that slipped past coercion (should be 0)
  let withTrack = 0;
  let withScope = 0;
  let withProposal = 0;
  const topicCounts = new Map<string, number>();
  const trackCounts = new Map<string, number>();
  const scopeCounts = new Map<string, number>();

  for (const r of rows) {
    const pt = r.primaryTopic;
    if (pt) {
      classified++;
      if (pt === OTHER_EMERGING) onCatchAll++;
      else if (isValidPrimaryTopic(pt)) onRealTopic++;
      else invalid++;
      topicCounts.set(pt, (topicCounts.get(pt) ?? 0) + 1);
    }
    if (r.conflictTrack) {
      withTrack++;
      trackCounts.set(r.conflictTrack, (trackCounts.get(r.conflictTrack) ?? 0) + 1);
    }
    if (r.scope) {
      withScope++;
      scopeCounts.set(r.scope, (scopeCounts.get(r.scope) ?? 0) + 1);
    }
    if (r.proposedTopic) withProposal++;
  }

  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  console.log(`Total curated classification rows : ${total}`);
  console.log(`  classified (primary_topic set)  : ${classified} (${pct(classified)})`);
  console.log(`  on a real topic                 : ${onRealTopic} (${pct(onRealTopic)})`);
  console.log(`  on ${OTHER_EMERGING} (catch-all): ${onCatchAll} (${pct(onCatchAll)})`);
  console.log(`  INVALID off-list (should be 0)  : ${invalid}`);
  console.log(`  carried a conflict_track        : ${withTrack} (${pct(withTrack)})`);
  console.log(`  carried a scope                 : ${withScope} (${pct(withScope)})`);
  console.log(`  flagged a proposed_topic        : ${withProposal}`);

  console.log(`\n  primary_topic distribution:`);
  for (const [t, n] of [...topicCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${t}`);
  }
  console.log(`\n  conflict_track distribution:`);
  for (const [t, n] of [...trackCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${t}`);
  }
  console.log(`\n  scope distribution:`);
  for (const [t, n] of [...scopeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${t}`);
  }

  // Human-gated proposal backlog.
  const proposals = await db
    .select({
      kind: classificationTopicProposals.kind,
      proposedLabel: classificationTopicProposals.proposedLabel,
      occurrences: classificationTopicProposals.occurrences,
      status: classificationTopicProposals.status,
    })
    .from(classificationTopicProposals);
  console.log(`\n  topic proposals logged (human-gated): ${proposals.length}`);
  for (const p of [...proposals].sort((a, b) => (b.occurrences ?? 0) - (a.occurrences ?? 0)).slice(0, 20)) {
    console.log(`    [${p.status}] ${p.kind} ×${p.occurrences}: ${p.proposedLabel}`);
  }

  // ── In-window coverage (Task #350) ─────────────────────────────────────────
  // The store-wide numbers above include aged-out rows users never see. What
  // actually matters is coverage over the DISPLAYED window. Measure over EXACTLY
  // the set the backfill classifies (the shared candidate-window helper), so the
  // "General"/non-generic gap and provenance share track what's on screen.
  console.log(`\n=== In-window coverage (the displayed candidate window) ===\n`);
  const { candidates } = await buildCuratedCandidateWindow();
  const winUrls = Array.from(new Set(candidates.map((c) => c.url)));
  const winOverlay = await storage.getCuratedClassificationsByUrls(winUrls);

  let inWin = winUrls.length;
  let winMissing = 0;     // no overlay row at all → renders "General"
  let winGenericCat = 0;  // overlay present but category is a generic bucket
  let winSpecificCat = 0; // overlay present with a real (non-generic) category
  let winRealTopic = 0;   // a real enum primary_topic
  let winCatchAll = 0;    // Other / Emerging
  let winNullTopic = 0;   // overlay present but primary_topic null
  let provAi = 0;
  let provHuman = 0;
  let provUnknown = 0;

  for (const url of winUrls) {
    const r = winOverlay.get(url);
    if (!r) { winMissing++; continue; }
    if (isGenericCategory(r.category)) winGenericCat++; else winSpecificCat++;
    if (!r.primaryTopic) winNullTopic++;
    else if (r.primaryTopic === OTHER_EMERGING) winCatchAll++;
    else if (isValidPrimaryTopic(r.primaryTopic)) winRealTopic++;
    if (r.provenance === 'ai') provAi++;
    else if (r.provenance === 'human') provHuman++;
    else provUnknown++;
  }

  const wpct = (n: number) => (inWin === 0 ? "n/a" : `${((n / inWin) * 100).toFixed(1)}%`);
  console.log(`In-window candidate URLs            : ${inWin}`);
  console.log(`  MISSING overlay (renders General) : ${winMissing} (${wpct(winMissing)})`);
  console.log(`  generic category (General/etc)    : ${winGenericCat} (${wpct(winGenericCat)})`);
  console.log(`  specific (non-generic) category   : ${winSpecificCat} (${wpct(winSpecificCat)})`);
  console.log(`  real primary_topic                : ${winRealTopic} (${wpct(winRealTopic)})`);
  console.log(`  ${OTHER_EMERGING} (catch-all)     : ${winCatchAll} (${wpct(winCatchAll)})`);
  console.log(`  null primary_topic (overlay set)  : ${winNullTopic} (${wpct(winNullTopic)})`);
  console.log(`\n  provenance share (in-window):`);
  console.log(`    ai      : ${provAi} (${wpct(provAi)})`);
  console.log(`    human   : ${provHuman} (${wpct(provHuman)})`);
  console.log(`    unknown : ${provUnknown} (${wpct(provUnknown)})`);
  console.log(`\nCoverage GAP = MISSING + generic category: a card with no specific`);
  console.log(`Category/Topic falls back to "General" in the curated view.`);

  console.log(`\nNote: residue on ${OTHER_EMERGING} is the cost-controlled default (knob a).`);
  console.log(`An off-list value coerced to INVALID>0 would indicate an enforcement gap.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Coverage measurement failed:", err);
    process.exit(1);
  });
