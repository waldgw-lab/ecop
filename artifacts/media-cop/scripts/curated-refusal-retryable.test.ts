/**
 * Regression test for curated social-vs-article enrichment (Task #354).
 *
 * Locks three invariants that keep social posts clean and AI refusals out of
 * stored curated enrichment:
 *
 *   1. isAIRefusalText flags AI refusal / meta replies and does NOT flag real
 *      news bullets/headlines (false-positive guard).
 *   2. shouldStampCuratedMediaDone keeps a refusal-driven row retryable: a real
 *      image + a refusal must NOT mark the row done (media_scraped_at), even
 *      though a real image with a genuine summary still does.
 *   3. cleanSocialPostText strips HTML + decodes entities and is idempotent.
 *
 * No test framework is configured — run directly with tsx:
 *   npx tsx scripts/curated-refusal-retryable.test.ts
 * Exits non-zero on any failure.
 */
import {
  getCuratedEnrichmentLifecycle,
  isAIRefusalText,
  MAX_MEDIA_ATTEMPTS,
  shouldStampCuratedMediaDone,
} from "../server/streamPrefetch";
import { cleanSocialPostText } from "../server/socialPostText";

let passed = 0;
let failed = 0;
function check(cond: boolean, why: string) {
  if (cond) {
    passed++;
    console.log(`PASS [${why}]`);
  } else {
    failed++;
    console.error(`FAIL [${why}]`);
  }
}

// 1) Refusal / meta replies must be detected.
const refusals = [
  "I cannot generate the requested analysis because the provided source material does not contain enough information.",
  "I'm unable to summarize this article.",
  "As an AI, I cannot complete this task.",
  "To complete this task, please provide the full article text.",
  "Please provide the article text or a legitimate news source.",
  "There is insufficient information to produce a summary.",
  "I'm sorry, but I can't help with that.",
  "The given source material did not contain any usable article text.",
  // First-person "I would need the actual article text" family — used to slip
  // through (no "I cannot"/"unable"/"as an AI" trigger) and get stored verbatim.
  "To generate the three bullet points you've requested, I would need the actual article text.",
  "I'd need the full source text to summarize this properly.",
  "I would need the source material to produce the claims.",
  // Curly apostrophe variant (LLM output often uses it).
  "I\u2019d need the article content first.",
];
for (const r of refusals) {
  check(isAIRefusalText(r), `refusal detected: ${JSON.stringify(r.slice(0, 48))}`);
}

// Real news bullets / headlines must NOT be flagged (false-positive guard).
const realLines = [
  "Pentagon confirms a carrier strike group deployed to the eastern Mediterranean.",
  "Senate advances a sweeping defense authorization bill with bipartisan support.",
  "NATO leaders pledged a new aid package at the summit in Brussels.",
  "Officials say the ceasefire framework is close to being finalized.",
  "The strike destroyed a weapons depot, the ministry reported.",
  // Attributed operational statements common in defense reporting — these used
  // to false-positive on bare "cannot provide" / "insufficient information".
  "The Pentagon said it cannot provide details while operations continue.",
  "Officials said there is insufficient information to confirm who launched the drone attack.",
  "Investigators cannot confirm the cause and say there is insufficient information so far.",
  "The spokesperson said the ministry will not provide a casualty figure at this time.",
  "Analysts say there is not enough information to attribute the cyberattack to one actor.",
  // Guards the new first-person pattern: a real quote can begin "I would need
  // to…" without asking for SOURCE MATERIAL — it must NOT be flagged.
  "\"I would need to verify the figures before commenting,\" the analyst said.",
  // Guards against the bare-noun over-match: "material", "source", "article"
  // used in legitimate defense quotes must NOT trip the source-material clause.
  "\"I will need material support to rebuild,\" the minister said.",
  "\"I would need Article 5 assurances before deploying,\" the envoy said.",
  "\"I would need source protection for my reporting,\" the journalist said.",
];
for (const r of realLines) {
  check(!isAIRefusalText(r), `real line NOT flagged: ${JSON.stringify(r.slice(0, 48))}`);
}
check(!isAIRefusalText(""), "empty string is not a refusal");
check(!isAIRefusalText(null), "null is not a refusal");

// 2) Retryability invariant — the core of this regression.
check(shouldStampCuratedMediaDone(true, false) === true, "real image + no refusal => row marked done");
check(shouldStampCuratedMediaDone(true, true) === false, "real image + REFUSAL => row stays retryable (not done)");
check(shouldStampCuratedMediaDone(false, false) === false, "favicon-only + no refusal => not done (retryable)");
check(shouldStampCuratedMediaDone(false, true) === false, "favicon-only + refusal => not done (retryable)");

// 2b) Editor telemetry must explain the EXISTING bounded retry policy without
// changing it. The lifecycle is metadata only; it never schedules a paid retry.
check(
  getCuratedEnrichmentLifecycle({ summaryBullets: ["fact"], ogImageUrl: "https://example.com/photo.jpg" }) === "ready",
  "real image + bullets => ready",
);
check(
  getCuratedEnrichmentLifecycle({ summaryBullets: null, ogImageUrl: "https://example.com/favicon.ico" }) === "pending",
  "never-attempted incomplete row => pending",
);
check(
  getCuratedEnrichmentLifecycle({
    summaryBullets: null,
    ogImageUrl: "https://example.com/favicon.ico",
    mediaAttemptCount: 2,
    lastMediaAttemptAt: new Date(),
  }) === "backed-off",
  "recent incomplete attempt => backed-off",
);
check(
  getCuratedEnrichmentLifecycle({
    summaryBullets: null,
    ogImageUrl: "https://example.com/favicon.ico",
    mediaAttemptCount: MAX_MEDIA_ATTEMPTS,
    lastMediaAttemptAt: new Date(),
  }) === "retry-capped",
  "capped incomplete row => retry-capped",
);

// 3) Social-body HTML cleaning + idempotency.
const dirty = "<p>Big news today &amp; tomorrow</p><br>Stay tuned</";
const clean = cleanSocialPostText(dirty);
check(!/[<>]/.test(clean), "social text: angle brackets stripped");
check(clean.includes("&") && !clean.includes("&amp;"), "social text: entities decoded");
check(clean.includes("\n"), "social text: block tags became newlines");
check(cleanSocialPostText(clean) === clean, "social text: cleaning is idempotent");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
