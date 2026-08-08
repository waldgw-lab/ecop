/**
 * Curated-only combatant-command OSINT handle ISOLATION regression test.
 *
 * The 9 combatant-command X handles (US_EUCOM, INDOPACOM, USAfricaCommand,
 * USNorthernCmd, US_SpaceCom, US_CYBERCOM, USSOCOM, US_STRATCOM, US_TRANSCOM)
 * live in the shared osint_posts table (so the OSINT scraper can keep writing
 * them) but must surface ONLY in the curated "U.S. X Feed". They must never
 * appear in any non-curated reader:
 *   - getRecentOsintPosts      -> /api/osint-posts (main OSINT feed)
 *   - getAllXFeedPosts         -> /api/x-feed/all (combined X feed)
 *   - publicApi /api/v1/social (read path; covered by the same constant)
 *   - mcopBotArchive search/count/getFullText (covered by the same constant)
 *
 * CENTCOM and SOUTHCOM are intentionally SHARED — they stay visible in the main
 * OSINT feed — so they are used here as the positive control.
 *
 * This test mutates state but cleans up every row it inserts in a finally block.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-only-osint.test.ts
 * Exits non-zero on any failure.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import { osintPosts } from "@shared/schema";
import {
  CURATED_ONLY_OSINT_HANDLES,
  CURATED_ONLY_OSINT_HANDLE_SET,
} from "../server/curatedOnlyOsint";

const MARKER = `__CURATED_ONLY_OSINT_TEST__${Date.now()}`;
// A curated-only handle (must be hidden from non-curated readers).
const CURATED_ONLY_HANDLE = "US_EUCOM";
// A shared handle (must stay visible in the main OSINT feed) — positive control.
const SHARED_HANDLE = "CENTCOM";

const curatedOnlyPostId = `${MARKER}_curated_only`;
const sharedPostId = `${MARKER}_shared`;

const failures: string[] = [];
function check(ok: boolean, msg: string) {
  if (ok) {
    console.log(`PASS [${msg}]`);
  } else {
    failures.push(`FAIL [${msg}]`);
    console.log(failures[failures.length - 1]);
  }
}

async function main() {
  // Sanity: the constant and its set agree, and CENTCOM/SOUTHCOM are NOT in it.
  check(
    CURATED_ONLY_OSINT_HANDLE_SET.has(CURATED_ONLY_HANDLE),
    `${CURATED_ONLY_HANDLE} is in CURATED_ONLY_OSINT_HANDLE_SET`,
  );
  check(
    !CURATED_ONLY_OSINT_HANDLE_SET.has(SHARED_HANDLE),
    `${SHARED_HANDLE} is NOT curated-only (stays shared)`,
  );
  check(
    !CURATED_ONLY_OSINT_HANDLE_SET.has("SOUTHCOM"),
    `SOUTHCOM is NOT curated-only (stays shared)`,
  );
  // 9 original combatant-command handles + the legacy INDOPACOM alias +
  // @WhiteHouse (both intentionally added later, documented in
  // server/curatedOnlyOsint.ts). Update in lockstep with that list.
  check(
    CURATED_ONLY_OSINT_HANDLES.length === 11,
    `exactly 11 curated-only handles (got ${CURATED_ONLY_OSINT_HANDLES.length})`,
  );

  const now = new Date();
  await db.insert(osintPosts).values([
    {
      postId: curatedOnlyPostId,
      content: `${MARKER} curated-only combatant command post`,
      postedAt: now,
      xUrl: `https://x.com/${CURATED_ONLY_HANDLE}/status/${curatedOnlyPostId}`,
      sourceAccount: CURATED_ONLY_HANDLE,
      isHidden: false,
    },
    {
      postId: sharedPostId,
      content: `${MARKER} shared combatant command post`,
      postedAt: now,
      xUrl: `https://x.com/${SHARED_HANDLE}/status/${sharedPostId}`,
      sourceAccount: SHARED_HANDLE,
      isHidden: false,
    },
  ]);

  const LIMIT = 500;

  // 1. Main OSINT feed (no account filter) must EXCLUDE the curated-only row
  //    but INCLUDE the shared row (positive control).
  const recentAll = await storage.getRecentOsintPosts(LIMIT);
  check(
    !recentAll.some((p) => p.postId === curatedOnlyPostId),
    `getRecentOsintPosts() excludes curated-only ${CURATED_ONLY_HANDLE}`,
  );
  check(
    recentAll.some((p) => p.postId === sharedPostId),
    `getRecentOsintPosts() still includes shared ${SHARED_HANDLE}`,
  );

  // 2. Explicit per-account request for a curated-only handle must still be empty.
  const recentByAccount = await storage.getRecentOsintPosts(
    LIMIT,
    CURATED_ONLY_HANDLE,
  );
  check(
    !recentByAccount.some((p) => p.postId === curatedOnlyPostId),
    `getRecentOsintPosts(account=${CURATED_ONLY_HANDLE}) returns nothing curated-only`,
  );

  // 3. Combined X feed must EXCLUDE the curated-only row, INCLUDE the shared one.
  const xFeedAll = await storage.getAllXFeedPosts(LIMIT);
  check(
    !xFeedAll.some((p) => p.postId === curatedOnlyPostId),
    `getAllXFeedPosts() excludes curated-only ${CURATED_ONLY_HANDLE}`,
  );
  check(
    xFeedAll.some((p) => p.postId === sharedPostId),
    `getAllXFeedPosts() still includes shared ${SHARED_HANDLE}`,
  );

  // 4. Curated reader MUST surface the curated-only row (positive control:
  //    a real leak the other direction would be caught here).
  const since = new Date(now.getTime() - 60 * 60 * 1000);
  const curated = await storage.getCuratedOsintPosts(
    since,
    LIMIT,
    CURATED_ONLY_HANDLE,
  );
  check(
    curated.some((p) => p.postId === curatedOnlyPostId),
    `getCuratedOsintPosts(${CURATED_ONLY_HANDLE}) DOES surface the curated-only row`,
  );
}

main()
  .catch((err) => {
    failures.push(`FAIL [harness error] ${err?.stack || err}`);
    console.error(err);
  })
  .finally(async () => {
    // Always clean up the rows we inserted.
    try {
      await db
        .delete(osintPosts)
        .where(inArray(osintPosts.postId, [curatedOnlyPostId, sharedPostId]));
    } catch (e) {
      console.error("Cleanup failed:", e);
    }
    const total = failures.length;
    if (total) {
      console.error(`\n${total} failure(s).`);
      process.exit(1);
    } else {
      console.log(`\nAll curated-only OSINT isolation checks passed.`);
      process.exit(0);
    }
  });
