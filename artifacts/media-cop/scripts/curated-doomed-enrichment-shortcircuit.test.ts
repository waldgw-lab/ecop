/**
 * Regression test for the curated doomed-enrichment short-circuits (Task #1022).
 *
 * Production evidence showed two classes of URL burning paid enrichment calls
 * (Jina / paywall2 / CPC) on content that demonstrably cannot be recovered:
 *   1. Bloomberg NON-ARTICLE URLs (/news/newsletters/…, /features/…): the full
 *      chain fails identically on every attempt — Jina returns the same
 *      ~905-char paywall stub, paywall2 answers 422, CPC ends "story=none,
 *      image=false". The only recovery ever observed was the free Bloomberg RSS
 *      feed index on the first attempt. These now short-circuit: RSS feed index
 *      on every attempt + a SINGLE bounded CPC call on the first attempt only.
 *   2. CPC-image-doomed hosts (chinaview.cn, kcnawatch.org): CPC has never
 *      returned an image for them in prod (69 rows, 0 images) — every
 *      image-only CPC call is a guaranteed 15s timeout. CPC is skipped when the
 *      row only needs an image; a genuine TEXT need may still call CPC.
 *
 * This locks:
 *   - the pure URL classifiers (host-anchored, spoof-safe, fail-closed);
 *   - deriveCuratedCpcDecision — the single chokepoint for every CPC skip rule
 *     (Dataminr redirect, Bloomberg non-article single-CPC, image-doomed host);
 *   - the enrichOneItem wiring (Jina reader/HTML + paywall2 gated by
 *     !bloombergNonArticle, CPC gated through deriveCuratedCpcDecision);
 *   - the prefetch top-N slot filter excluding backed-off rows
 *     (isCuratedMediaBackedOff) so they stop consuming slots.
 *
 * Pure/unit-style: no live network. No test framework is configured — run with:
 *   npx tsx scripts/curated-doomed-enrichment-shortcircuit.test.ts
 * Exits non-zero on any failure.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  isBloombergNonArticleUrl,
  isCpcImageDoomedHost,
  deriveCuratedCpcDecision,
  isCuratedMediaBackedOff,
  MAX_MEDIA_ATTEMPTS,
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
// 1. isBloombergNonArticleUrl — newsletters/features only, host-anchored
// ---------------------------------------------------------------------------
const bbCases: { url: string; expected: boolean; why: string }[] = [
  { url: "https://www.bloomberg.com/news/newsletters/2026-07-17/why-the-moonshot-moment", expected: true, why: "newsletter path is non-article" },
  { url: "https://www.bloomberg.com/features/2026-tucker-carlson-weekend-interview/", expected: true, why: "features path is non-article" },
  { url: "https://bloomberg.com/features/x", expected: true, why: "bare bloomberg.com matches" },
  { url: "https://news.bloomberg.com/news/newsletters/abc", expected: true, why: "*.bloomberg.com subdomain matches" },
  { url: "https://www.bloomberg.com/news/articles/2026-07-18/some-regular-article", expected: false, why: "regular /news/articles/ keeps the FULL hard-blocked chain (paywall2 cracks these)" },
  { url: "https://www.bloomberg.com/opinion/articles/x", expected: false, why: "opinion articles are not in the evidence set — full chain retained" },
  { url: "https://www.reuters.com/news/newsletters/x", expected: false, why: "non-Bloomberg host never matches, regardless of path" },
  { url: "https://bloomberg.com.evil.example/news/newsletters/x", expected: false, why: "suffix spoof must NOT match" },
  { url: "https://notbloomberg.com/features/x", expected: false, why: "substring host must NOT match" },
  { url: "not a url", expected: false, why: "invalid URL fails closed to false" },
];
for (const c of bbCases) {
  check(`isBloombergNonArticleUrl(${c.url.slice(0, 70)}) === ${c.expected} :: ${c.why}`, isBloombergNonArticleUrl(c.url) === c.expected);
}

// ---------------------------------------------------------------------------
// 2. isCpcImageDoomedHost — evidence-based host set, spoof-safe
// ---------------------------------------------------------------------------
const doomedCases: { url: string; expected: boolean; why: string }[] = [
  { url: "http://chinaview.cn/20260718/abc/c.html", expected: true, why: "bare chinaview.cn is CPC-image-doomed" },
  { url: "https://www.chinaview.cn/x", expected: true, why: "*.chinaview.cn subdomain matches" },
  { url: "https://kcnawatch.org/newstream/x", expected: true, why: "kcnawatch.org is CPC-image-doomed" },
  { url: "https://www.kcnawatch.org/x", expected: true, why: "*.kcnawatch.org subdomain matches" },
  { url: "https://www.bloomberg.com/news/articles/x", expected: false, why: "bloomberg is NOT in the image-doomed set (CPC recovers images there)" },
  { url: "https://chinaview.cn.evil.example/x", expected: false, why: "suffix spoof must NOT match" },
  { url: "https://notchinaview.cn/x", expected: false, why: "substring host must NOT match" },
  { url: "not a url", expected: false, why: "invalid URL fails closed to false" },
];
for (const c of doomedCases) {
  check(`isCpcImageDoomedHost(${c.url.slice(0, 60)}) === ${c.expected} :: ${c.why}`, isCpcImageDoomedHost(c.url) === c.expected);
}

// ---------------------------------------------------------------------------
// 3. deriveCuratedCpcDecision — the single CPC chokepoint
// ---------------------------------------------------------------------------
const nl = "https://www.bloomberg.com/news/newsletters/2026-07-17/x";
const feat = "https://www.bloomberg.com/features/2026-y/";
const bbArticle = "https://www.bloomberg.com/news/articles/2026-07-18/z";
const cv = "http://chinaview.cn/20260718/abc/c.html";
const kcna = "https://kcnawatch.org/newstream/x";
const dataminr = "https://r.dataminr.com/a/b";
const normal = "https://www.nytimes.com/2026/07/18/world/a.html";

// Nothing needed → never call.
check("no-need: never calls CPC", deriveCuratedCpcDecision({ url: normal, mediaAttemptCount: 0 }, false, false).call === false);
check("no-need: reason is no-need", deriveCuratedCpcDecision({ url: normal, mediaAttemptCount: 0 }, false, false).skipReason === "no-need");

// Dataminr redirects: never call (pre-existing rule, now routed through the chokepoint).
check("dataminr: image need skipped", deriveCuratedCpcDecision({ url: dataminr, mediaAttemptCount: 0 }, true, false).skipReason === "dataminr-redirect");
check("dataminr: text need skipped too", deriveCuratedCpcDecision({ url: dataminr, mediaAttemptCount: 0 }, false, true).call === false);

// Bloomberg non-article: exactly ONE CPC attempt (first attempt only).
check("bb newsletter attempt 0: CPC allowed (the single bounded attempt)", deriveCuratedCpcDecision({ url: nl, mediaAttemptCount: 0 }, true, true).call === true);
check("bb newsletter null count treated as 0: CPC allowed", deriveCuratedCpcDecision({ url: nl, mediaAttemptCount: null }, true, true).call === true);
check("bb newsletter attempt 1: CPC skipped", deriveCuratedCpcDecision({ url: nl, mediaAttemptCount: 1 }, true, true).skipReason === "bloomberg-non-article-cpc-spent");
check("bb feature attempt 5: CPC skipped", deriveCuratedCpcDecision({ url: feat, mediaAttemptCount: 5 }, true, false).call === false);
check("bb REGULAR article attempt 5: CPC still allowed (full chain retained)", deriveCuratedCpcDecision({ url: bbArticle, mediaAttemptCount: 5 }, true, false).call === true);

// CPC-image-doomed hosts: image-only need skipped, text need still allowed.
check("chinaview image-only: CPC skipped", deriveCuratedCpcDecision({ url: cv, mediaAttemptCount: 2 }, true, false).skipReason === "cpc-image-doomed-host");
check("kcnawatch image-only: CPC skipped", deriveCuratedCpcDecision({ url: kcna, mediaAttemptCount: 0 }, true, false).call === false);
check("chinaview TEXT need: CPC allowed (pull capability retained)", deriveCuratedCpcDecision({ url: cv, mediaAttemptCount: 2 }, false, true).call === true);
check("chinaview image+text need: CPC allowed (text is genuinely needed)", deriveCuratedCpcDecision({ url: cv, mediaAttemptCount: 2 }, true, true).call === true);

// Normal outlets: fail-open, CPC exactly as before.
check("normal outlet image need: CPC allowed", deriveCuratedCpcDecision({ url: normal, mediaAttemptCount: 4 }, true, false).call === true);
check("normal outlet text need: CPC allowed", deriveCuratedCpcDecision({ url: normal, mediaAttemptCount: 4 }, false, true).call === true);
check("invalid URL: fail-open to CPC (classifiers fail closed to false)", deriveCuratedCpcDecision({ url: "not a url", mediaAttemptCount: 0 }, true, false).call === true);

// ---------------------------------------------------------------------------
// 4. isCuratedMediaBackedOff — slot-filter semantics (unchanged behavior, now
//    also consulted by the prefetch top-N slice)
// ---------------------------------------------------------------------------
check("never-attempted row is not backed off", isCuratedMediaBackedOff(0, null) === false);
check("capped row is permanently backed off", isCuratedMediaBackedOff(MAX_MEDIA_ATTEMPTS, new Date()) === true);
check("recent failure inside window is backed off", isCuratedMediaBackedOff(2, new Date(Date.now() - 10 * 60 * 1000)) === true);
check("old failure outside window is retryable", isCuratedMediaBackedOff(1, new Date(Date.now() - 2 * 60 * 60 * 1000)) === false);

// ---------------------------------------------------------------------------
// 5. Source-structure guard — enrichOneItem + prefetch still wire the gates.
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "server", "streamPrefetch.ts"), "utf8");

// enrichOneItem must derive the short-circuit from the single-source classifier.
check(
  "enrichOneItem derives bloombergNonArticle from isBloombergNonArticleUrl (curated-gated)",
  /const\s+bloombergNonArticle\s*=\s*item\.kind\s*===\s*'curated'\s*&&\s*isBloombergNonArticleUrl\(item\.url\)/.test(src),
);

// Jina reader must be gated by the short-circuit (ternary to null).
check(
  "Jina reader call gated by bloombergNonArticle",
  /bloombergNonArticle\s*\?\s*null\s*:\s*await\s+fetchViaJinaReader\(item\.url,\s*CURATED_PROVIDER_TIMEOUT_MS\)/.test(src),
);

// Jina HTML-mode last resort must also be gated.
check(
  "Jina HTML call gated by !bloombergNonArticle",
  /if\s*\(\s*!imageUrl\s*&&\s*!bloombergNonArticle\s*\)\s*\{\s*\n\s*const\s+jinaHtml\s*=\s*await\s+fetchViaJinaHtml/.test(src),
);

// paywall2 must be gated by !bloombergNonArticle INSIDE the isHardBlocked branch.
check(
  "paywall2 branch gated by isHardBlocked && !bloombergNonArticle",
  /if\s*\(isHardBlocked\s*&&\s*!bloombergNonArticle\s*&&/.test(src),
);

// The CPC call must be reachable ONLY through the pure decision chokepoint.
const decisionIdx = src.indexOf("deriveCuratedCpcDecision(item, stillNeedsImage, stillNeedsText)");
const cpcIdx = src.indexOf("fetchViaCpc(item.url, CURATED_CPC_TIMEOUT_MS)");
check("CPC decision chokepoint present in enrichOneItem", decisionIdx !== -1);
check("curated CPC call present", cpcIdx !== -1);
check("CPC decision derived BEFORE the CPC call", decisionIdx !== -1 && cpcIdx !== -1 && decisionIdx < cpcIdx);
check(
  "CPC call gated by cpcDecision.call",
  /else\s+if\s*\(cpcDecision\.call\)\s*\{/.test(src),
);

// The Bloomberg RSS feed-index check (the retained free path) must still exist
// and run for hard-blocked curated rows — the short-circuit must NOT remove it.
check(
  "Bloomberg RSS feed-index path retained",
  /getBloombergFeedImage\(item\.url\)/.test(src),
);

// prefetchCuratedMedia must exclude backed-off rows BEFORE the top-N slice.
const prefetchIdx = src.indexOf("export async function prefetchCuratedMedia");
const sliceIdx = src.indexOf("needsEnrichment.slice(0, topN)", prefetchIdx);
const backoffFilterIdx = src.indexOf("!isCuratedMediaBackedOff(c.mediaAttemptCount, c.lastMediaAttemptAt)", prefetchIdx);
check("prefetchCuratedMedia present", prefetchIdx !== -1);
check(
  "prefetch slot filter excludes backed-off rows before the top-N slice",
  prefetchIdx !== -1 && backoffFilterIdx !== -1 && sliceIdx !== -1 && backoffFilterIdx < sliceIdx,
);

// ---------------------------------------------------------------------------
console.log(`\n${pass} checks passed`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
