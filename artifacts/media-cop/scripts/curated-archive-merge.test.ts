/**
 * Regression test for the Curated story-ARCHIVE carry-forward merge
 * (storage.upsertCuratedStoryArchive).
 *
 * Background: a FORMED curated story is archived keyed by its content SIGNATURE
 * (= the cluster's clusterId). That signature CHANGES the moment an outlet joins
 * or drops or the AI regroups the members. Before this fix, the old signature's
 * archive row simply went "not live" and surfaced as a FALSE "phased out" version
 * while the very same story was still on the feed under the NEW signature — and
 * the story's sources fragmented across single-snapshot rows.
 *
 * The fix makes upsertCuratedStoryArchive:
 *   1) Exact signature match  -> recurring-story fast path, UNION members (never
 *      lose a source that briefly dropped out of the grouping).
 *   2) No exact match but a RECENT, NOT-LIVE prior version of the same story
 *      exists (shared representative URL, OR >=2 shared members AND Jaccard>=0.5)
 *      -> carry that row's identity forward: rewrite its signature to the new
 *      live one and union members. No duplicate "phased out" row is left behind.
 *   3) Genuinely distinct story -> insert a new row (two concurrent live stories
 *      must never collapse together).
 *
 * This locks that behavior. No test framework is configured — run with tsx:
 *   ./node_modules/.bin/tsx scripts/curated-archive-merge.test.ts
 * Exits non-zero on any failure. All rows it writes are namespaced and cleaned up.
 *
 * NOTE: this hits the DEV database (writes + reads + cleanup). It only ever
 * touches rows whose headline/title/itemId carry the test MARKER, so it can never
 * mutate real curated data.
 */
import { storage } from "../server/storage";
import { db } from "../server/db";
import {
  curatedStoryArchive,
  curatedClusterMembers,
  type CuratedArchiveMember,
} from "../shared/schema";
import { eq, like, or } from "drizzle-orm";
import { CURATED_EPISODE_HARD_AGE_MS } from "../server/curatedEpisode";

const HOUR_MS = 60 * 60 * 1000;

const MARKER = "__ARCHIVE_MERGE_TEST__";
const RID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS [${name}]`);
  } else {
    console.error(`FAIL [${name}]${detail ? " — " + detail : ""}`);
    failures++;
  }
}

function member(n: number, source: string): CuratedArchiveMember {
  return {
    source,
    title: `${MARKER} member ${n}`,
    url: `https://example.test/${RID}/article-${n}`,
    behaviorClass: "corroborating",
    behaviorLabel: null,
    spin: null,
  };
}

type Row = {
  signature: string;
  headline: string;
  lede: string;
  facts: string[];
  category: string | null;
  region: string | null;
  country: string | null;
  sourceCount: number;
  repTitle: string | null;
  repSource: string | null;
  repUrl: string | null;
  ogImageUrl: string | null;
  members: CuratedArchiveMember[];
};

function story(sigSuffix: string, headlineSuffix: string, members: CuratedArchiveMember[]): Row {
  const rep = members[0];
  return {
    signature: `sig_${sigSuffix}_${RID}`,
    headline: `${MARKER} ${headlineSuffix}`,
    lede: `${MARKER} lede ${headlineSuffix}`,
    facts: [`${MARKER} fact`],
    category: "Conflict",
    region: "Middle East",
    country: null,
    sourceCount: members.length,
    repTitle: rep?.title ?? null,
    repSource: rep?.source ?? null,
    repUrl: rep?.url ?? null,
    ogImageUrl: null,
    members,
  };
}

async function rowsBySig(sig: string) {
  return db.select().from(curatedStoryArchive).where(eq(curatedStoryArchive.signature, sig));
}

async function cleanup() {
  await db
    .delete(curatedClusterMembers)
    .where(or(like(curatedClusterMembers.title, `${MARKER}%`), like(curatedClusterMembers.itemId, `${MARKER}%`)));
  await db.delete(curatedStoryArchive).where(like(curatedStoryArchive.headline, `${MARKER}%`));
}

async function main() {
  // Start clean so counts are deterministic even after an aborted prior run.
  await cleanup();

  // -------------------------------------------------------------------------
  // Scenario A — exact recurring signature UNIONs members (no source loss).
  // -------------------------------------------------------------------------
  const a1 = member(1, "Reuters");
  const a2 = member(2, "AP");
  const a3 = member(3, "BBC");
  const sigA = `sig_A_${RID}`;
  await storage.upsertCuratedStoryArchive(story("A", "A", [a1, a2, a3]));
  let aRows = await rowsBySig(sigA);
  check("A: first capture creates exactly one row", aRows.length === 1, `got ${aRows.length}`);
  check("A: first capture sourceCount=3", aRows[0]?.sourceCount === 3, `got ${aRows[0]?.sourceCount}`);

  // Same signature next pass, but member 3 momentarily drops from the grouping.
  await storage.upsertCuratedStoryArchive(story("A", "A v2", [a1, a2]));
  aRows = await rowsBySig(sigA);
  check("A: recurring keeps a single row", aRows.length === 1, `got ${aRows.length}`);
  check(
    "A: dropped member retained via union (sourceCount stays 3)",
    aRows[0]?.sourceCount === 3,
    `got ${aRows[0]?.sourceCount}`,
  );
  check("A: headline refreshed on recurrence", aRows[0]?.headline === `${MARKER} A v2`);

  // -------------------------------------------------------------------------
  // Scenario B — carry-forward merge (the core fix). A churned story (new
  // signature) merges into its recent, NOT-LIVE prior version: signature is
  // rewritten, members unioned, NO false "phased out" duplicate left behind.
  // -------------------------------------------------------------------------
  const b1 = member(11, "Reuters");
  const b2 = member(12, "AP");
  const b3 = member(13, "AFP");
  const b4 = member(14, "Guardian"); // joins in the new version
  const sigB1 = `sig_B1_${RID}`;
  const sigB2 = `sig_B2_${RID}`;
  await storage.upsertCuratedStoryArchive(story("B1", "B", [b1, b2, b3]));
  const bBefore = await rowsBySig(sigB1);
  check("B: old version present before churn", bBefore.length === 1);
  const bFirstSeen = bBefore[0]?.firstSeenAt?.getTime();

  // New pass: outlet joins -> new signature, SAME representative URL.
  await storage.upsertCuratedStoryArchive(story("B2", "B updated", [b1, b2, b3, b4]));
  check(
    "B: old signature row is GONE (no false phased-out duplicate)",
    (await rowsBySig(sigB1)).length === 0,
  );
  const b2Rows = await rowsBySig(sigB2);
  check("B: exactly one row now carries the new signature", b2Rows.length === 1, `got ${b2Rows.length}`);
  check("B: members unioned to 4 (b4 added, none lost)", b2Rows[0]?.sourceCount === 4, `got ${b2Rows[0]?.sourceCount}`);
  const b2Urls = new Set((b2Rows[0]?.members ?? []).map((m) => m.url));
  check(
    "B: union contains all four member URLs",
    [b1, b2, b3, b4].every((m) => b2Urls.has(m.url)),
  );
  check(
    "B: firstSeenAt preserved from the original version (unchanged across the merge)",
    !!bFirstSeen && b2Rows[0]?.firstSeenAt?.getTime() === bFirstSeen,
    `before=${bFirstSeen} after=${b2Rows[0]?.firstSeenAt?.getTime()}`,
  );

  // -------------------------------------------------------------------------
  // Scenario C — conservative guard: a genuinely DISTINCT story (no shared rep,
  // no shared members) must NOT merge; it gets its own row.
  // -------------------------------------------------------------------------
  const c1 = member(21, "CNN");
  const c2 = member(22, "Fox");
  const c3 = member(23, "NBC");
  const d1 = member(31, "Politico");
  const d2 = member(32, "Axios");
  const d3 = member(33, "Hill");
  const sigC1 = `sig_C1_${RID}`;
  const sigC2 = `sig_C2_${RID}`;
  await storage.upsertCuratedStoryArchive(story("C1", "C", [c1, c2, c3]));
  await storage.upsertCuratedStoryArchive(story("C2", "D distinct", [d1, d2, d3]));
  check("C: distinct story #1 still its own row", (await rowsBySig(sigC1)).length === 1);
  check("C: distinct story #2 inserted as a separate row", (await rowsBySig(sigC2)).length === 1);

  // Negative overlap guard: a single shared NON-representative member is NOT
  // enough to merge (b1 is shared but is not E's representative, so no rep match
  // and Jaccard 1/6 < 0.5).
  const e1 = b1; // shares ONE member with the B story (but not as rep)
  const e2 = member(41, "Sky");
  const e3 = member(42, "DW");
  const sigE = `sig_E_${RID}`;
  await storage.upsertCuratedStoryArchive(story("E", "E one-shared", [e2, e3, e1]));
  check(
    "C: one shared member (Jaccard<0.5, no shared rep) does NOT merge",
    (await rowsBySig(sigE)).length === 1 && (await rowsBySig(sigB2)).length === 1,
  );

  // -------------------------------------------------------------------------
  // Scenario F — overlap-only merge: a churned version that changes BOTH its
  // signature AND its representative URL still merges via the member-token anchor
  // (member-overlap anchor: >=3 shared tokens AND containment>=0.4), independent
  // of the rep-URL anchor.
  // -------------------------------------------------------------------------
  const f1 = member(51, "Reuters");
  const f2 = member(52, "AP");
  const f3 = member(53, "AFP");
  const f4 = member(54, "Guardian");
  const f5 = member(55, "Sky"); // joins in the new version
  const sigF1 = `sig_F1_${RID}`;
  const sigF2 = `sig_F2_${RID}`;
  await storage.upsertCuratedStoryArchive(story("F1", "F", [f1, f2, f3, f4])); // rep = f1
  // f1 drops, f5 joins; rep becomes f2 (different URL) so the rep-URL anchor cannot
  // match — only the member-overlap anchor (f2,f3,f4 = 3 shared) carries it forward.
  await storage.upsertCuratedStoryArchive(story("F2", "F updated", [f2, f3, f4, f5])); // rep = f2
  check("F: old signature row is GONE after overlap-only merge", (await rowsBySig(sigF1)).length === 0);
  const fRows = await rowsBySig(sigF2);
  check("F: exactly one row carries the new signature", fRows.length === 1, `got ${fRows.length}`);
  check(
    "F: members unioned across the churn (f1 retained, f5 added => 5)",
    fRows[0]?.sourceCount === 5,
    `got ${fRows[0]?.sourceCount}`,
  );

  // -------------------------------------------------------------------------
  // Scenario G — never merge into a LIVE prior version: even with the SAME rep
  // URL, if the old version is still on the feed the new version must insert as
  // its own row (two concurrent live stories must never collapse together).
  // Robust to a concurrent clustering pass wiping the live table.
  // -------------------------------------------------------------------------
  const g1 = member(61, "Reuters");
  const g2 = member(62, "AP");
  const g3 = member(63, "AFP");
  const g4 = member(64, "BBC");
  const sigG1 = `sig_G1_${RID}`;
  const sigG2 = `sig_G2_${RID}`;
  await storage.upsertCuratedStoryArchive(story("G1", "G", [g1, g2, g3])); // rep = g1
  await db.insert(curatedClusterMembers).values({
    clusterId: sigG1,
    itemType: "curated",
    itemId: `${MARKER}-${RID}-G-live`,
    role: "contributing",
    title: `${MARKER} G live member`,
    source: "Reuters",
    url: g1.url,
  });
  const gLiveStill = await db
    .select()
    .from(curatedClusterMembers)
    .where(eq(curatedClusterMembers.clusterId, sigG1));
  if (gLiveStill.length === 0) {
    console.log(
      "SKIP [G: live non-merge] — injected live row was wiped by a concurrent clustering pass (inconclusive, not a regression)",
    );
  } else {
    // Same rep URL as G1, so ONLY the live-guard prevents a merge.
    await storage.upsertCuratedStoryArchive(story("G2", "G updated", [g1, g2, g3, g4]));
    check("G: live old version is NOT merged (still its own row)", (await rowsBySig(sigG1)).length === 1);
    check("G: new version inserted as a separate row", (await rowsBySig(sigG2)).length === 1);
  }

  // -------------------------------------------------------------------------
  // Scenario D — the rewritten row is HIDDEN by the read endpoint while it is
  // live under the new signature (proves the notLive filter + signature rewrite
  // work together). Robust to a concurrent clustering pass wiping the live table.
  // -------------------------------------------------------------------------
  const visibleBefore = await storage.searchCuratedStoryArchive({ query: `${MARKER} B`, limit: 100 });
  check(
    "D: not-live archived version IS visible in the archive",
    visibleBefore.items.some((i) => i.signature === sigB2),
  );

  await db.insert(curatedClusterMembers).values({
    clusterId: sigB2,
    itemType: "curated",
    itemId: `${MARKER}-${RID}-live`,
    role: "contributing",
    title: `${MARKER} live member`,
    source: "Reuters",
    url: b1.url,
  });
  const liveStill = await db
    .select()
    .from(curatedClusterMembers)
    .where(eq(curatedClusterMembers.clusterId, sigB2));
  if (liveStill.length === 0) {
    console.log(
      "SKIP [D: hidden while live] — injected live row was wiped by a concurrent clustering pass (inconclusive, not a regression)",
    );
  } else {
    const afterLive = await storage.searchCuratedStoryArchive({ query: `${MARKER} B`, limit: 100 });
    check(
      "D: archived version is HIDDEN while live under the new signature",
      !afterLive.items.some((i) => i.signature === sigB2),
    );
  }

  // -------------------------------------------------------------------------
  // Scenario H — episode boundary (Task #334): an OVER-AGE prior episode is NOT
  // a carry-forward target. A version whose firstSeenAt already exceeded the
  // hard episode-age cap is a CLOSED prior episode; even though its lastSeenAt is
  // recent (so it is in the merge window) and its rep URL matches exactly, the
  // current (live) story must NOT collapse into it — it inserts a fresh row so
  // the old multi-day episode stays closed (kills the perpetual zombie row).
  // -------------------------------------------------------------------------
  const h1 = member(71, "Reuters");
  const h2 = member(72, "AP");
  const h3 = member(73, "AFP");
  const h4 = member(74, "Guardian"); // joins in the new version
  const sigH1 = `sig_H1_${RID}`;
  const sigH2 = `sig_H2_${RID}`;
  const overAgeFirstSeen = new Date(Date.now() - (CURATED_EPISODE_HARD_AGE_MS + 10 * HOUR_MS));
  // Insert the OLD episode directly with a controlled, over-cap firstSeenAt but a
  // recent lastSeenAt (so it falls inside the 48h merge window and is otherwise a
  // perfect rep-URL match). storage.upsert would stamp firstSeenAt=now, so we seed
  // the row by hand to model a genuinely old episode.
  await db.insert(curatedStoryArchive).values({
    signature: sigH1,
    headline: `${MARKER} H old-episode`,
    lede: `${MARKER} lede H`,
    facts: [`${MARKER} fact`],
    attributedClaims: [],
    category: "Conflict",
    region: "Middle East",
    country: null,
    sourceCount: 3,
    repTitle: h1.title,
    repSource: h1.source,
    repUrl: h1.url,
    ogImageUrl: null,
    members: [h1, h2, h3],
    firstSeenAt: overAgeFirstSeen,
    lastSeenAt: new Date(Date.now() - 1 * HOUR_MS),
  });
  await storage.upsertCuratedStoryArchive(story("H2", "H updated", [h1, h2, h3, h4]));
  check(
    "H: over-age prior episode is NOT merged into (stays its own closed row)",
    (await rowsBySig(sigH1)).length === 1,
  );
  const h2Rows = await rowsBySig(sigH2);
  check(
    "H: continuing story inserts a FRESH episode row (new signature)",
    h2Rows.length === 1,
    `got ${h2Rows.length}`,
  );
  check(
    "H: fresh episode firstSeenAt is recent, not the old episode's day-0",
    !!h2Rows[0] &&
      Date.now() - new Date(h2Rows[0].firstSeenAt).getTime() < CURATED_EPISODE_HARD_AGE_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario I — boundary sanity: a still-IN-WINDOW prior episode DOES carry
  // forward (proves the over-age guard isn't over-broad). Same setup as H but
  // with a firstSeenAt comfortably inside the cap.
  // -------------------------------------------------------------------------
  const i1 = member(81, "Reuters");
  const i2 = member(82, "AP");
  const i3 = member(83, "AFP");
  const i4 = member(84, "Guardian");
  const sigI1 = `sig_I1_${RID}`;
  const sigI2 = `sig_I2_${RID}`;
  const inWindowFirstSeen = new Date(Date.now() - (CURATED_EPISODE_HARD_AGE_MS - 10 * HOUR_MS));
  await db.insert(curatedStoryArchive).values({
    signature: sigI1,
    headline: `${MARKER} I young-episode`,
    lede: `${MARKER} lede I`,
    facts: [`${MARKER} fact`],
    attributedClaims: [],
    category: "Conflict",
    region: "Middle East",
    country: null,
    sourceCount: 3,
    repTitle: i1.title,
    repSource: i1.source,
    repUrl: i1.url,
    ogImageUrl: null,
    members: [i1, i2, i3],
    firstSeenAt: inWindowFirstSeen,
    lastSeenAt: new Date(Date.now() - 1 * HOUR_MS),
  });
  await storage.upsertCuratedStoryArchive(story("I2", "I updated", [i1, i2, i3, i4]));
  check(
    "I: in-window prior episode IS carried forward (old signature gone)",
    (await rowsBySig(sigI1)).length === 0,
  );
  const iRows = await rowsBySig(sigI2);
  check("I: exactly one row carries the new signature", iRows.length === 1, `got ${iRows.length}`);
  check(
    "I: members unioned across the churn (i4 added => 4)",
    iRows[0]?.sourceCount === 4,
    `got ${iRows[0]?.sourceCount}`,
  );
  check(
    "I: in-window episode firstSeenAt preserved across the merge",
    !!iRows[0] &&
      Math.abs(new Date(iRows[0].firstSeenAt).getTime() - inWindowFirstSeen.getTime()) < 2000,
    `expected ~${inWindowFirstSeen.getTime()} got ${iRows[0]?.firstSeenAt?.getTime()}`,
  );

  // -------------------------------------------------------------------------
  // Scenario J — exact-signature fast path is INTENTIONALLY not episode-capped
  // (Task #334 design note / reviewer-flagged edge). The episode-age guard lives
  // only on the carry-forward path (branch 2). A story that keeps the EXACT same
  // signature across passes (its member SET never changes) hits branch 1 and is
  // unioned in place forever — it never rolls over even past the hard age cap.
  // This is correct: the perpetual "zombie" was an EVER-ACCUMULATING mega-story
  // whose signature (a hash of the member set) changes every pass, so it can
  // never sit on the exact path. Rollover therefore relies on signature churn;
  // a genuinely stable signature is a coherent recurring identity, not the bug.
  // -------------------------------------------------------------------------
  const j1 = member(91, "Reuters");
  const j2 = member(92, "AP");
  const j3 = member(93, "AFP");
  const j4 = member(94, "Guardian"); // joins, but signature is held constant below
  const sigJ = `sig_J_${RID}`;
  const jOverAgeFirstSeen = new Date(Date.now() - (CURATED_EPISODE_HARD_AGE_MS + 24 * HOUR_MS));
  // Seed an OVER-AGE row carrying the signature the upsert will reuse.
  await db.insert(curatedStoryArchive).values({
    signature: sigJ,
    headline: `${MARKER} J old`,
    lede: `${MARKER} lede J`,
    facts: [`${MARKER} fact`],
    attributedClaims: [],
    category: "Conflict",
    region: "Middle East",
    country: null,
    sourceCount: 3,
    repTitle: j1.title,
    repSource: j1.source,
    repUrl: j1.url,
    ogImageUrl: null,
    members: [j1, j2, j3],
    firstSeenAt: jOverAgeFirstSeen,
    lastSeenAt: new Date(Date.now() - 1 * HOUR_MS),
  });
  // Next pass keeps the SAME signature (sigJ) despite a new member -> exact path.
  await storage.upsertCuratedStoryArchive(story("J", "J recurring", [j1, j2, j3, j4]));
  const jRows = await rowsBySig(sigJ);
  check(
    "J: exact recurring signature stays ONE row even when over the age cap",
    jRows.length === 1,
    `got ${jRows.length}`,
  );
  check(
    "J: members unioned in place (no rollover on the exact path)",
    jRows[0]?.sourceCount === 4,
    `got ${jRows[0]?.sourceCount}`,
  );
  check(
    "J: over-age firstSeenAt is preserved (exact path is NOT episode-capped)",
    !!jRows[0] &&
      Math.abs(new Date(jRows[0].firstSeenAt).getTime() - jOverAgeFirstSeen.getTime()) < 2000,
    `expected ~${jOverAgeFirstSeen.getTime()} got ${jRows[0]?.firstSeenAt?.getTime()}`,
  );

  console.log(failures === 0 ? `\nALL PASSED (run ${RID})` : `\n${failures} FAILURE(S) (run ${RID})`);
}

main()
  .then(async () => {
    await cleanup();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error("Test crashed:", err);
    try {
      await cleanup();
    } catch {}
    process.exit(1);
  });
