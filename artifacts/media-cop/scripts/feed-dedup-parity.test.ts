/**
 * Regression test for the main public-feed title-dedup pass (Task #684).
 *
 * Task #684 made `storage.getPrimaryFeed`'s O(n^2) title-dedup pass — the
 * heaviest synchronous step behind the Classic (/api/headline-feed), Visual
 * (/api/stream), and custom-MCOP feeds — periodically yield to the event loop
 * so one heavy feed compute can't stall every other in-flight request on this
 * single-process app. The yield is supposed to change ONLY scheduling, never
 * the feed contents.
 *
 * The pass was extracted into the pure `dedupPrimaryFeed` helper so it can be
 * exercised directly here, deterministically and without network — unlike the
 * live-scraping curated-isolation harness, whose byte-identical feed check
 * flakes against constantly-shifting news data and so can't reliably prove
 * this specific behavior.
 *
 * This test locks two things:
 *   1. PARITY — the same input yields byte-identical output regardless of the
 *      yield function or chunk size (this is the core guard for the #684 change).
 *   2. BEHAVIOR — the dedup rules themselves (URL identity, 70% title overlap,
 *      normalizeTitle prefix stripping, manual-over-scraped replacement carrying
 *      the max priority, and the limit slice) so a future edit to the extracted
 *      helper can't silently drop/reorder/merge items differently.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/feed-dedup-parity.test.ts
 * Exits non-zero on any failure.
 */
import { dedupPrimaryFeed, SIMILARITY_THRESHOLD, type DedupableFeedItem } from "../server/feedDedup";
import { yieldToEventLoop, CURATED_YIELD_CHUNK } from "../server/eventLoop";

let pass = 0;
const failures: string[] = [];

function check(label: string, got: unknown, expected: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`PASS [${label}]`);
  } else {
    const msg = `FAIL [${label}] got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`;
    failures.push(msg);
    console.log(msg);
  }
}

function ok(label: string, condition: boolean): void {
  if (condition) {
    pass++;
    console.log(`PASS [${label}]`);
  } else {
    const msg = `FAIL [${label}] condition was false`;
    failures.push(msg);
    console.log(msg);
  }
}

type Item = DedupableFeedItem & { id: string };
function mk(
  id: string,
  title: string,
  url: string,
  type: "scraped" | "manual",
  dep: number,
  orig: number,
): Item {
  return { id, title, url, type, depreciatedPriority: dep, originalPriority: orig };
}

const noopYield = async (): Promise<void> => {};
const ids = (rows: Item[]): string[] => rows.map((r) => r.id);

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // Sanity: threshold constant is what the behavior fixtures below assume.
  // -------------------------------------------------------------------------
  check("SIMILARITY_THRESHOLD is 0.7", SIMILARITY_THRESHOLD, 0.7);

  // -------------------------------------------------------------------------
  // BEHAVIOR — small handcrafted fixtures with known expected output.
  // -------------------------------------------------------------------------

  // Same URL, different title → same article, later one dropped.
  check(
    "URL identity collapses duplicates",
    ids(await dedupPrimaryFeed([
      mk("a", "Totally unique headline one", "u1", "scraped", 50, 50),
      mk("b", "Different words entirely here now", "u1", "scraped", 40, 40),
    ], undefined, noopYield)),
    ["a"],
  );

  // 4/5 word overlap = 0.8 >= 0.7 → duplicate.
  check(
    "title overlap >= threshold collapses",
    ids(await dedupPrimaryFeed([
      mk("a", "alpha beta gamma delta", "ua", "scraped", 50, 50),
      mk("b", "alpha beta gamma delta epsilon", "ub", "scraped", 40, 40),
    ], undefined, noopYield)),
    ["a"],
  );

  // 3/7 overlap = ~0.43 < 0.7 → kept separate.
  check(
    "title overlap < threshold kept separate",
    ids(await dedupPrimaryFeed([
      mk("a", "one two three four", "ua", "scraped", 50, 50),
      mk("b", "one two three five six seven", "ub", "scraped", 40, 40),
    ], undefined, noopYield)),
    ["a", "b"],
  );

  // normalizeTitle strips "BREAKING:" so the two collapse.
  check(
    "normalizeTitle prefix stripping drives dedup",
    ids(await dedupPrimaryFeed([
      mk("a", "alpha beta gamma delta", "ua", "scraped", 50, 50),
      mk("b", "BREAKING: alpha beta gamma delta", "ub", "scraped", 40, 40),
    ], undefined, noopYield)),
    ["a"],
  );

  // Manual dup of an already-kept scraped item REPLACES it, carrying max priority.
  {
    const out = await dedupPrimaryFeed([
      mk("a", "kilo lima mike november", "ua", "scraped", 50, 55),
      mk("b", "kilo lima mike november", "ub", "manual", 30, 20),
    ], undefined, noopYield);
    check(
      "manual replaces scraped, keeps max priority",
      out.map((r) => ({ id: r.id, url: r.url, type: r.type, dep: r.depreciatedPriority, orig: r.originalPriority })),
      [{ id: "b", url: "ub", type: "manual", dep: 50, orig: 55 }],
    );
  }

  // Scraped dup of an already-kept manual does NOT replace it (quirk lock).
  {
    const out = await dedupPrimaryFeed([
      mk("a", "oscar papa quebec romeo", "ua", "manual", 10, 10),
      mk("b", "oscar papa quebec romeo", "ub", "scraped", 90, 90),
    ], undefined, noopYield);
    check(
      "scraped does NOT replace manual",
      out.map((r) => ({ id: r.id, type: r.type, dep: r.depreciatedPriority })),
      [{ id: "a", type: "manual", dep: 10 }],
    );
  }

  // Manual dup of an already-kept manual does NOT replace (requires existing scraped).
  check(
    "manual does NOT replace manual",
    ids(await dedupPrimaryFeed([
      mk("a", "sierra tango uniform victor", "ua", "manual", 10, 10),
      mk("b", "sierra tango uniform victor", "ub", "manual", 90, 90),
    ], undefined, noopYield)),
    ["a"],
  );

  // limit slices the final deduplicated list.
  check(
    "limit slices final result",
    ids(await dedupPrimaryFeed([
      mk("a", "wholly distinct one", "u1", "scraped", 50, 50),
      mk("b", "wholly distinct two", "u2", "scraped", 40, 40),
      mk("c", "wholly distinct three", "u3", "scraped", 30, 30),
      mk("d", "wholly distinct four", "u4", "scraped", 20, 20),
    ], 2, noopYield)),
    ["a", "b"],
  );

  // -------------------------------------------------------------------------
  // PARITY — a large deterministic dataset must dedup byte-identically no
  // matter the yield function or chunk size (the actual #684 guard).
  // -------------------------------------------------------------------------

  // Deterministic LCG so the dataset is fixed across runs.
  let seed = 123456789;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pickN = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  const vocab = [
    "iran", "israel", "strike", "talks", "sanctions", "missile", "nato",
    "ukraine", "russia", "china", "taiwan", "summit", "defense", "budget",
    "navy", "drone",
  ];
  const urlPool = Array.from({ length: 40 }, (_, i) => `https://example.com/${i}`);

  const N = 400;
  const dataset: Item[] = [];
  for (let i = 0; i < N; i++) {
    const wordCount = 4 + Math.floor(rand() * 3); // 4..6 words → frequent overlaps
    const words: string[] = [];
    for (let w = 0; w < wordCount; w++) words.push(pickN(vocab));
    dataset.push(
      mk(
        `n${i}`,
        words.join(" "),
        pickN(urlPool),
        rand() < 0.3 ? "manual" : "scraped",
        Math.floor(rand() * 100),
        Math.floor(rand() * 100),
      ),
    );
  }

  // Reference = no-yield, default chunk.
  const reference = await dedupPrimaryFeed(dataset, undefined, noopYield, CURATED_YIELD_CHUNK);
  const refJSON = JSON.stringify(reference);

  // The dataset must actually collide, or parity would be vacuous.
  ok(`dataset dedups meaningfully (${reference.length}/${N})`, reference.length < N && reference.length > 0);

  const variants: Array<{ label: string; yieldFn: () => Promise<void>; chunk: number }> = [
    { label: "real yield, chunk 64", yieldFn: yieldToEventLoop, chunk: 64 },
    { label: "real yield, chunk 1", yieldFn: yieldToEventLoop, chunk: 1 },
    { label: "real yield, chunk 7", yieldFn: yieldToEventLoop, chunk: 7 },
    { label: "real yield, chunk 1000 (never fires)", yieldFn: yieldToEventLoop, chunk: 1000 },
    { label: "noop yield, chunk 3", yieldFn: noopYield, chunk: 3 },
  ];
  for (const v of variants) {
    const out = await dedupPrimaryFeed(dataset, undefined, v.yieldFn, v.chunk);
    ok(`parity: ${v.label} matches reference`, JSON.stringify(out) === refJSON);
  }

  // The yield function actually fires once per `chunk` iterations (scheduling
  // only — output already proven identical above).
  let yieldCalls = 0;
  const counting = async (): Promise<void> => { yieldCalls++; };
  await dedupPrimaryFeed(dataset, undefined, counting, 64);
  check("yield fires floor(N/chunk) times", yieldCalls, Math.floor(N / 64));

  // Parity also holds with a limit applied.
  const refLim = JSON.stringify(await dedupPrimaryFeed(dataset, 50, noopYield, CURATED_YIELD_CHUNK));
  const gotLim = await dedupPrimaryFeed(dataset, 50, yieldToEventLoop, 7);
  ok("parity: limited result matches reference", JSON.stringify(gotLim) === refLim);
  ok("limited result respects cap", gotLim.length <= 50);

  // -------------------------------------------------------------------------
  console.log("");
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} failure(s), ${pass} passed`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
  console.log(`All ${pass} checks passed.`);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
