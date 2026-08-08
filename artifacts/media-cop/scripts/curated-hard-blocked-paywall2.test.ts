/**
 * Regression test for the curated hard-blocked-outlet enrichment routing
 * (Task #339, locked by Task #549, WSJ added Task #689).
 *
 * Some outlets (Bloomberg, Reuters, WSJ) 403/401/redirect EVERY curated direct /
 * 12ft / strengthened fetch. Burning the per-item budget on those doomed attempts
 * pushed the paid CPC last resort out of the budget and left curated rows stuck on
 * a favicon. The fix (curated lane ONLY): detect the hard-blocked host, SKIP the
 * doomed direct/12ft/strengthened fetches, and run the main feed's paywall2 breaker
 * (fetchViaPaywallBypass) BEFORE the paid CPC. The main feed (kind !== 'curated')
 * is never affected.
 *
 * This locks the routing so a future tweak can't silently:
 *   - re-enable the ~23s of doomed fetches for a hard-blocked curated item, or
 *   - drop the paywall2 step before CPC, or
 *   - start hard-blocking main-feed items.
 *
 * Pure/unit-style: no live network to Bloomberg. It asserts the exported pure
 * helpers (isHardBlockedOutlet, deriveHardBlockEnrichmentPlan) AND does a
 * lightweight source-structure check that enrichOneItem still wires those gates
 * (the dead fetches gated by !isHardBlocked, paywall2 reachable before CPC).
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-hard-blocked-paywall2.test.ts
 * Exits non-zero on any failure.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  isHardBlockedOutlet,
  deriveHardBlockEnrichmentPlan,
  extractArchiveOriginalUrl,
} from "../server/streamPrefetch";

const failures: string[] = [];
let pass = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`PASS [${name}]`);
  } else {
    failures.push(`FAIL [${name}]`);
    console.log(failures[failures.length - 1]);
  }
}

// ---------------------------------------------------------------------------
// 1. isHardBlockedOutlet — host matching (Bloomberg + Reuters + WSJ; evidence-based set)
// ---------------------------------------------------------------------------
const hostCases: { url: string; expected: boolean; why: string }[] = [
  { url: "https://www.bloomberg.com/news/articles/abc", expected: true, why: "www.bloomberg.com is hard-blocked" },
  { url: "https://bloomberg.com/news/xyz", expected: true, why: "bare bloomberg.com is hard-blocked" },
  { url: "https://news.bloomberg.com/story", expected: true, why: "any *.bloomberg.com subdomain is hard-blocked" },
  { url: "https://www.reuters.com/world/", expected: true, why: "www.reuters.com is hard-blocked (host-level 401 bot wall)" },
  { url: "https://reuters.com/world/x", expected: true, why: "bare reuters.com is hard-blocked" },
  { url: "https://news.reuters.com/story", expected: true, why: "any *.reuters.com subdomain is hard-blocked" },
  { url: "https://www.wsj.com/articles/ukraine-drones-now-reaching-siberia", expected: true, why: "www.wsj.com is hard-blocked (login-wall paywall)" },
  { url: "https://wsj.com/politics/national-security/abc", expected: true, why: "bare wsj.com is hard-blocked" },
  { url: "https://blogs.wsj.com/story", expected: true, why: "any *.wsj.com subdomain is hard-blocked" },
  { url: "https://www.nytimes.com/2026/01/01/world.html", expected: false, why: "NYT is not hard-blocked (normal curated chain)" },
  { url: "https://bloomberg.com.evil.example/phish", expected: false, why: "suffix spoof must NOT match (endsWith('.bloomberg.com') guards it)" },
  { url: "https://reuters.com.evil.example/phish", expected: false, why: "suffix spoof must NOT match (endsWith('.reuters.com') guards it)" },
  { url: "https://wsj.com.evil.example/phish", expected: false, why: "suffix spoof must NOT match (endsWith('.wsj.com') guards it)" },
  { url: "https://notbloomberg.com/x", expected: false, why: "substring 'bloomberg.com' in a different host must NOT match" },
  { url: "https://notreuters.com/x", expected: false, why: "substring 'reuters.com' in a different host must NOT match" },
  { url: "https://notwsj.com/x", expected: false, why: "substring 'wsj.com' in a different host must NOT match" },
  { url: "not a url", expected: false, why: "invalid URL fails closed to false" },
];
for (const c of hostCases) {
  check(`isHardBlockedOutlet(${c.url}) === ${c.expected} :: ${c.why}`, isHardBlockedOutlet(c.url) === c.expected);
}

// ---------------------------------------------------------------------------
// 2. deriveHardBlockEnrichmentPlan — routing plan per item
// ---------------------------------------------------------------------------
// A curated item on a hard-blocked host: skip the dead fetches, paywall2 before CPC.
const curatedBloomberg = deriveHardBlockEnrichmentPlan({ kind: "curated", url: "https://www.bloomberg.com/news/a" });
check("curated+bloomberg: isHardBlocked", curatedBloomberg.isHardBlocked === true);
check("curated+bloomberg: direct fetch skipped", curatedBloomberg.skipDirectFetch === true);
check("curated+bloomberg: 12ft fetch skipped", curatedBloomberg.skip12ftFetch === true);
check("curated+bloomberg: strengthened fetch skipped", curatedBloomberg.skipStrengthenedFetch === true);
check("curated+bloomberg: paywall2 before CPC", curatedBloomberg.paywall2BeforeCpc === true);

// A curated item on Reuters (also hard-blocked): same routing as Bloomberg.
const curatedReuters = deriveHardBlockEnrichmentPlan({ kind: "curated", url: "https://www.reuters.com/world/a" });
check("curated+reuters: isHardBlocked", curatedReuters.isHardBlocked === true);
check("curated+reuters: direct fetch skipped", curatedReuters.skipDirectFetch === true);
check("curated+reuters: 12ft fetch skipped", curatedReuters.skip12ftFetch === true);
check("curated+reuters: strengthened fetch skipped", curatedReuters.skipStrengthenedFetch === true);
check("curated+reuters: paywall2 before CPC", curatedReuters.paywall2BeforeCpc === true);

// A curated item on WSJ (hard-paywalled, same class as Bloomberg/Reuters): same routing.
const curatedWsj = deriveHardBlockEnrichmentPlan({ kind: "curated", url: "https://www.wsj.com/articles/ukraine-drones-now-reaching-siberia" });
check("curated+wsj: isHardBlocked", curatedWsj.isHardBlocked === true);
check("curated+wsj: direct fetch skipped", curatedWsj.skipDirectFetch === true);
check("curated+wsj: 12ft fetch skipped", curatedWsj.skip12ftFetch === true);
check("curated+wsj: strengthened fetch skipped", curatedWsj.skipStrengthenedFetch === true);
check("curated+wsj: paywall2 before CPC", curatedWsj.paywall2BeforeCpc === true);

// Main-feed WSJ item: MUST be unaffected (hard-blocked is curated-only).
const mainFeedWsj = deriveHardBlockEnrichmentPlan({ kind: "classic", url: "https://www.wsj.com/articles/abc" });
check("main-feed+wsj: NOT hard-blocked", mainFeedWsj.isHardBlocked === false);
check("main-feed+wsj: direct fetch NOT skipped", mainFeedWsj.skipDirectFetch === false);

// Main-feed Reuters item: MUST be unaffected (hard-blocked is curated-only).
const mainFeedReuters = deriveHardBlockEnrichmentPlan({ kind: "classic", url: "https://www.reuters.com/world/a" });
check("main-feed+reuters: NOT hard-blocked", mainFeedReuters.isHardBlocked === false);
check("main-feed+reuters: direct fetch NOT skipped", mainFeedReuters.skipDirectFetch === false);

// A curated item on a normal host: full chain runs, no special routing.
const curatedNyt = deriveHardBlockEnrichmentPlan({ kind: "curated", url: "https://www.nytimes.com/x" });
check("curated+nyt: not hard-blocked", curatedNyt.isHardBlocked === false);
check("curated+nyt: direct fetch NOT skipped", curatedNyt.skipDirectFetch === false);
check("curated+nyt: 12ft fetch NOT skipped", curatedNyt.skip12ftFetch === false);
check("curated+nyt: strengthened fetch NOT skipped", curatedNyt.skipStrengthenedFetch === false);
check("curated+nyt: no special paywall2-before-CPC routing", curatedNyt.paywall2BeforeCpc === false);

// Main-feed (classic/visual) item on a hard-blocked host: MUST be unaffected.
for (const kind of ["classic", "visual", undefined]) {
  const mainFeed = deriveHardBlockEnrichmentPlan({ kind, url: "https://www.bloomberg.com/news/a" });
  const label = kind ?? "undefined";
  check(`main-feed(${label})+bloomberg: NOT hard-blocked`, mainFeed.isHardBlocked === false);
  check(`main-feed(${label})+bloomberg: direct fetch NOT skipped`, mainFeed.skipDirectFetch === false);
  check(`main-feed(${label})+bloomberg: 12ft fetch NOT skipped`, mainFeed.skip12ftFetch === false);
  check(`main-feed(${label})+bloomberg: strengthened fetch NOT skipped`, mainFeed.skipStrengthenedFetch === false);
  check(`main-feed(${label})+bloomberg: no paywall2-before-CPC routing`, mainFeed.paywall2BeforeCpc === false);
}

// ---------------------------------------------------------------------------
// 3. Source-structure guard — enrichOneItem still wires the gates.
//    The pure helper alone can't prove the dead-fetch branches consult
//    isHardBlocked or that paywall2 runs before CPC; lock the wiring textually
//    so a regression that removes a guard or reorders the breakers is caught.
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "server", "streamPrefetch.ts"), "utf8");

// enrichOneItem must derive isHardBlocked from the single-source helper.
check(
  "enrichOneItem derives isHardBlocked from deriveHardBlockEnrichmentPlan",
  /const\s*\{\s*isHardBlocked\s*\}\s*=\s*deriveHardBlockEnrichmentPlan\(item\)/.test(src),
);

// The doomed fetch branches must remain gated by !isHardBlocked.
const notHardBlockedGates = (src.match(/!\s*isHardBlocked/g) || []).length;
check(
  `at least 3 fetch branches gated by !isHardBlocked (found ${notHardBlockedGates})`,
  notHardBlockedGates >= 3,
);

// The paywall2 breaker must run inside an isHardBlocked branch, BEFORE the CPC
// call. It must use its OWN longer bound (CURATED_PAYWALL2_TIMEOUT_MS), NOT the
// short CPC fast-fail that previously aborted it mid-extraction.
const paywall2Idx = src.indexOf("fetchViaPaywallBypass(item.url, CURATED_PAYWALL2_TIMEOUT_MS)");
const cpcIdx = src.indexOf("fetchViaCpc(item.url, CURATED_CPC_TIMEOUT_MS)");
check("curated paywall2 breaker call present", paywall2Idx !== -1);
check(
  "curated paywall2 breaker does NOT share the short CPC fast-fail timeout",
  src.indexOf("fetchViaPaywallBypass(item.url, CURATED_CPC_TIMEOUT_MS)") === -1,
);
check("curated CPC call present", cpcIdx !== -1);
check(
  "curated paywall2 breaker runs BEFORE the paid CPC",
  paywall2Idx !== -1 && cpcIdx !== -1 && paywall2Idx < cpcIdx,
);
// The paywall2 breaker call must be guarded by isHardBlocked (the block opens
// with `if (isHardBlocked && ...)` just above the call).
const guardBeforePaywall2 = src.lastIndexOf("if (isHardBlocked", paywall2Idx);
check(
  "curated paywall2 breaker is gated by an isHardBlocked branch",
  guardBeforePaywall2 !== -1 && guardBeforePaywall2 < paywall2Idx,
);

// ---------------------------------------------------------------------------
// 4. extractArchiveOriginalUrl — unwrap the wayback snapshot to the durable
//    original CDN image (Task #697). WSJ cracks via the paywall2 branch, which
//    returns a `https://web.archive.org/web/<ts>im_/https://images.wsj.net/…`
//    URL. Re-hosting must prefer the wrapped ORIGINAL (durable) over the fragile
//    archive snapshot (can 404 later, depends on archive.org uptime).
// ---------------------------------------------------------------------------
const archiveCases: { url: string; expected: string | null; why: string }[] = [
  {
    url: "https://web.archive.org/web/20260710032657im_/https://images.wsj.net/im-83594617/social",
    expected: "https://images.wsj.net/im-83594617/social",
    why: "WSJ im_ snapshot unwraps to the original images.wsj.net URL",
  },
  {
    url: "https://web.archive.org/web/20260709000131/https://static01.nyt.com/images/x/y-videoSixteenByNineJumbo1600.jpg",
    expected: "https://static01.nyt.com/images/x/y-videoSixteenByNineJumbo1600.jpg",
    why: "NYT snapshot WITHOUT the im_ modifier still unwraps",
  },
  {
    url: "https://web.archive.org/web/20240101000000im_/http://example.com/photo.jpg?w=1",
    expected: "http://example.com/photo.jpg?w=1",
    why: "http original with a query string is preserved verbatim",
  },
  {
    url: "https://images.wsj.net/im-83594617/social",
    expected: null,
    why: "a plain (non-archive) CDN URL is not a wayback wrapper → null",
  },
  {
    url: "https://web.archive.org/web/20240101000000/not-a-url",
    expected: null,
    why: "no wrapped http(s) original → null (fall back to the snapshot itself)",
  },
  { url: "not a url", expected: null, why: "invalid URL fails closed to null" },
];
for (const c of archiveCases) {
  check(
    `extractArchiveOriginalUrl(${c.url.slice(0, 60)}…) :: ${c.why}`,
    extractArchiveOriginalUrl(c.url) === c.expected,
  );
}

// Source-structure guard: persistImageToStorage must try the extracted archive
// original BEFORE the raw URL, and the enrichment / preview call sites must drop
// a raw archive URL rather than store it (never silently depend on archive.org).
check(
  "persistImageToStorage builds a candidate list via extractArchiveOriginalUrl",
  /const\s+original\s*=\s*extractArchiveOriginalUrl\(imageUrl\)/.test(src) &&
    /candidates\.push\(original\)/.test(src) &&
    /candidates\.push\(imageUrl\)/.test(src),
);
check(
  "a persist failure on an archive URL drops to no-image (isArchiveHost → null)",
  /else if \(isArchiveHost\(imageUrl\)\)/.test(src),
);

// ---------------------------------------------------------------------------
console.log(`\n${pass} checks passed`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
