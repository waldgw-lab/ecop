/**
 * Regression test for Task #650 / Task #854 — page-labeled and URL-signal
 * ANALYSIS/OPINION/EXPLAINER detection for trusted outlets.
 *
 * Covers:
 *   1. detectPageOpinionAnalysis precision — flags a structured JSON-LD
 *      OpinionNewsArticle/AnalysisNewsArticle page and an Al Jazeera-style
 *      standalone "Analysis" kicker page, but does NOT flag a normal reported
 *      article, a "?"-in-headline reported story, or body text that merely
 *      mentions "analysis"/"opinion" in a longer sentence.
 *   2. detectPageNonNewsKind (Task #854) — distinguishes 'opinion' vs
 *      'explainer' returns; covers BackgroundNewsArticle, Explainer section
 *      label, explainer kicker, and CNN "Analysis by <Name>" byline rule.
 *   3. URL signal detection (Task #854) — isAnalysisOrLiveBlogUrl,
 *      isExplainerUrl, isOpinionUrl (/commentisfree/), deriveContentType,
 *      including negative precision fixtures (mid-slug "analysis" in a real
 *      news headline must NOT trip it).
 *   4. getEffectiveContentKind / isEffectivelyReportedArticle — the single
 *      shared helper every gate (standalone Top Stories, Top Narratives,
 *      cluster rep selection, client badge) consults, so they can't drift.
 *   5. shouldDemoteEffectiveOpinion — the cluster-tiering decision: a trusted
 *      outlet's effectively-opinion or explainer piece is demoted to
 *      attach-only, while an already-blocked or already-contrast (adversary)
 *      outlet is left alone, and normal reported articles are never demoted.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-opinion-analysis.test.ts
 * Exits non-zero on any failure.
 */
import {
  detectPageOpinionAnalysis,
  detectPageNonNewsKind,
  detectPageContentKind,
} from "../server/streamPrefetch";
import {
  getEffectiveContentKind,
  getEffectiveContentKindWithTitle,
  isEffectivelyReportedArticle,
  shouldDemoteEffectiveOpinion,
  isOpinionUrl,
  isAnalysisOrLiveBlogUrl,
  isLiveBlogUrl,
  isLiveUmbrellaTitle,
  isPodcastUrl,
  isExplainerUrl,
  deriveContentType,
  detectTitleLeadingLabel,
  detectTitleTrailingKicker,
  detectWHLeadDualSignal,
  hasTitleInterrogativeSignal,
} from "../shared/contentKind";
import { evalCuratedAnalysisOpinionCap, CURATED_ANALYSIS_OPINION_CAP } from "../server/scoreAdjustments";

let pass = 0;
const failures: string[] = [];

function check(why: string, got: unknown, expected: unknown) {
  const ok = got === expected;
  if (ok) {
    pass++;
    console.log(`PASS [${why}]`);
  } else {
    failures.push(`FAIL [${why}] got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`);
    console.log(failures[failures.length - 1]);
  }
}

// ---------------------------------------------------------------------------
// 1. detectPageOpinionAnalysis precision (backward-compat boolean wrapper)
// ---------------------------------------------------------------------------

const ALJAZEERA_ANALYSIS_PAGE = `
<html><head><title>Is Israel killing the US-Iran MoU by staying in Lebanon?</title></head>
<body>
  <div class="article-header">
    <span class="article-topic-kicker">Analysis</span>
    <h1>'Will not leave': Is Israel killing the US-Iran MoU by staying in Lebanon?</h1>
  </div>
  <p>Israeli forces have remained in southern Lebanon well past the withdrawal deadline set out in the ceasefire agreement, raising questions about the durability of the broader diplomatic framework.</p>
</body></html>
`;

const STRUCTURED_OPINION_PAGE = `
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"OpinionNewsArticle","headline":"Why the ceasefire will not hold","author":{"@type":"Person","name":"Jane Columnist"}}
</script>
</head>
<body><h1>Why the ceasefire will not hold</h1>
<p>In my view, the terms negotiated last week fail to address the root causes of the conflict.</p>
</body></html>
`;

const SECTION_META_ANALYSIS_PAGE = `
<html><head>
<meta property="article:section" content="Analysis" />
<meta property="og:title" content="What comes next for the region" />
</head>
<body><h1>What comes next for the region</h1>
<p>Officials from both sides met on Tuesday to discuss the framework going forward.</p>
</body></html>
`;

const NORMAL_ARTICLE_PAGE = `
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"NewsArticle","headline":"Ceasefire holds into third day"}
</script>
</head>
<body><h1>Ceasefire holds into third day</h1>
<p>Military officials confirmed the ceasefire has held for a third consecutive day, with no reported violations along the border.</p>
</body></html>
`;

const QUESTION_HEADLINE_REPORTED_PAGE = `
<html><head><title>Will the ceasefire hold?</title></head>
<body><h1>Will the ceasefire hold?</h1>
<p>Defense officials briefed reporters on Tuesday about the state of the ceasefire, declining to speculate on its durability but confirming no violations had occurred.</p>
</body></html>
`;

const BODY_MENTIONS_ANALYSIS_PAGE = `
<html><head><title>Pentagon releases new report</title></head>
<body><h1>Pentagon releases new report</h1>
<p>According to the report's analysis of satellite imagery, troop movements near the border increased by 12 percent over the past month, officials said Tuesday.</p>
<p>A separate opinion poll cited in the report found public support for the ceasefire remains steady.</p>
</body></html>
`;

const NAV_LINK_NORMAL_ARTICLE_PAGE = `
<html><head><title>Ceasefire holds into third day</title></head>
<body>
  <header>
    <nav class="site-nav">
      <a href="/world">World</a>
      <a href="/opinion">Opinion</a>
      <a href="/analysis">Analysis</a>
    </nav>
  </header>
  <div class="article-header">
    <h1>Ceasefire holds into third day</h1>
  </div>
  <p>Military officials confirmed the ceasefire has held for a third consecutive day, with no reported violations along the border.</p>
  <footer>
    <div class="footer-links">
      <a href="/editorial">Editorial</a>
      <span>Commentary</span>
    </div>
  </footer>
</body></html>
`;

check(
  "Al Jazeera-style standalone Analysis kicker flags opinion",
  detectPageOpinionAnalysis(ALJAZEERA_ANALYSIS_PAGE),
  true,
);
check(
  "Structured JSON-LD OpinionNewsArticle flags opinion",
  detectPageOpinionAnalysis(STRUCTURED_OPINION_PAGE),
  true,
);
check(
  "article:section=Analysis meta flags opinion",
  detectPageOpinionAnalysis(SECTION_META_ANALYSIS_PAGE),
  true,
);
check(
  "Normal reported NewsArticle is NOT flagged",
  detectPageOpinionAnalysis(NORMAL_ARTICLE_PAGE),
  false,
);
check(
  "A '?' in the headline of a reported story is NOT flagged (guardrail: never a standalone trigger)",
  detectPageOpinionAnalysis(QUESTION_HEADLINE_REPORTED_PAGE),
  false,
);
check(
  "Body text merely mentioning 'analysis'/'opinion' in a sentence is NOT flagged (guardrail: never free-text substring match)",
  detectPageOpinionAnalysis(BODY_MENTIONS_ANALYSIS_PAGE),
  false,
);
check(
  "A normal article page with 'Opinion'/'Analysis'/'Editorial'/'Commentary' nav/footer links is NOT flagged (guardrail: kickers must be article-context, non-link elements)",
  detectPageOpinionAnalysis(NAV_LINK_NORMAL_ARTICLE_PAGE),
  false,
);
check(
  "No HTML available -> null (leaves stored flag untouched), never a false 'article' guess",
  detectPageContentKind(null, "https://example.com/story"),
  null,
);
check(
  "detectPageContentKind surfaces 'opinion' end-to-end for the Al Jazeera-style page",
  detectPageContentKind(ALJAZEERA_ANALYSIS_PAGE, "https://www.aljazeera.com/features/2026/1/1/some-analysis-piece"),
  "opinion",
);
check(
  "detectPageContentKind surfaces 'article' for a normal reported page",
  detectPageContentKind(NORMAL_ARTICLE_PAGE, "https://example.com/news/ceasefire-holds"),
  "article",
);

// ---------------------------------------------------------------------------
// 2. detectPageNonNewsKind — Task #854 explainer + CNN byline
// ---------------------------------------------------------------------------

const BACKGROUND_NEWS_ARTICLE_PAGE = `
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BackgroundNewsArticle","headline":"What is the Iran nuclear deal?"}
</script>
</head>
<body><h1>What is the Iran nuclear deal?</h1>
<p>The 2015 agreement, formally known as the Joint Comprehensive Plan of Action, limited Iran's nuclear program in exchange for relief from international sanctions.</p>
</body></html>
`;

const EXPLAINER_SECTION_META_PAGE = `
<html><head>
<meta property="article:section" content="Explainer" />
<meta property="og:title" content="How the sanctions work" />
</head>
<body><h1>How the sanctions work</h1>
<p>International sanctions on Iran restrict access to global financial markets and limit exports of oil and weapons.</p>
</body></html>
`;

const EXPLAINER_KICKER_PAGE = `
<html><head><title>How does the nuclear deal work?</title></head>
<body>
  <div class="article-header">
    <span class="article-kicker">Explainer</span>
    <h1>How does the nuclear deal work?</h1>
  </div>
  <p>The agreement sets strict limits on uranium enrichment in exchange for sanctions relief.</p>
</body></html>
`;

const CNN_ANALYSIS_BYLINE_PAGE = `
<html><head><title>How the Iran deal fell apart</title></head>
<body>
  <div class="article-header">
    <span class="byline-lead">Analysis by Brett H. McGurk</span>
    <h1>How the Iran deal fell apart</h1>
  </div>
  <p>Senior administration officials gave a detailed account of the breakdown in negotiations, citing Iranian demands on the timeline for sanctions relief.</p>
</body></html>
`;

const CNN_REPORTED_NEWS_PAGE = `
<html><head><title>US and Iran reach deal</title></head>
<body>
  <div class="article-header">
    <span class="byline">By John Doe, CNN</span>
    <h1>US and Iran reach deal on nuclear limitations</h1>
  </div>
  <p>Officials confirmed the agreement after marathon talks in Geneva.</p>
</body></html>
`;

check(
  "detectPageNonNewsKind: BackgroundNewsArticle JSON-LD → 'explainer'",
  detectPageNonNewsKind(BACKGROUND_NEWS_ARTICLE_PAGE),
  "explainer",
);
check(
  "detectPageNonNewsKind: article:section=Explainer meta → 'explainer'",
  detectPageNonNewsKind(EXPLAINER_SECTION_META_PAGE),
  "explainer",
);
check(
  "detectPageNonNewsKind: standalone Explainer kicker → 'explainer'",
  detectPageNonNewsKind(EXPLAINER_KICKER_PAGE),
  "explainer",
);
check(
  "detectPageNonNewsKind: CNN 'Analysis by <Name>' kicker-byline on cnn.com → 'opinion'",
  detectPageNonNewsKind(CNN_ANALYSIS_BYLINE_PAGE, "https://www.cnn.com/2026/01/01/politics/iran-deal-analysis"),
  "opinion",
);
check(
  "detectPageNonNewsKind: CNN 'Analysis by <Name>' NOT triggered on non-CNN outlet (precision guard)",
  detectPageNonNewsKind(CNN_ANALYSIS_BYLINE_PAGE, "https://www.example.com/politics/iran-deal"),
  null,
);
check(
  "detectPageNonNewsKind: plain CNN reported article with a 'By John Doe, CNN' byline → null (not a structured kicker)",
  detectPageNonNewsKind(CNN_REPORTED_NEWS_PAGE, "https://www.cnn.com/2026/01/01/politics/us-iran-deal"),
  null,
);
check(
  "detectPageNonNewsKind: Al Jazeera Analysis kicker → 'opinion'",
  detectPageNonNewsKind(ALJAZEERA_ANALYSIS_PAGE),
  "opinion",
);
check(
  "detectPageNonNewsKind: normal article → null",
  detectPageNonNewsKind(NORMAL_ARTICLE_PAGE),
  null,
);
check(
  "detectPageContentKind: BackgroundNewsArticle page → 'explainer'",
  detectPageContentKind(BACKGROUND_NEWS_ARTICLE_PAGE, "https://www.reuters.com/world/explainer-what-is-the-iran-deal"),
  "explainer",
);

// ---------------------------------------------------------------------------
// 3. URL signal detection — Task #854 new rules
// ---------------------------------------------------------------------------

// --- isOpinionUrl: new /commentisfree/ rule ---
check(
  "isOpinionUrl: Guardian /commentisfree/ → true",
  isOpinionUrl("https://www.theguardian.com/commentisfree/2026/jan/01/some-column"),
  true,
);
check(
  "isOpinionUrl: existing /opinion/ path still true",
  isOpinionUrl("https://www.washingtonpost.com/opinions/2026/01/some-column"),
  true,
);
check(
  "isOpinionUrl: normal Guardian world article → false",
  isOpinionUrl("https://www.theguardian.com/world/2026/jan/01/ceasefire-holds"),
  false,
);

// --- isAnalysisOrLiveBlogUrl: /analysis/ path segment ---
check(
  "isAnalysisOrLiveBlogUrl: /analysis/ path segment → true",
  isAnalysisOrLiveBlogUrl("https://www.reuters.com/world/analysis/what-comes-next-for-iran-2026-01-01/"),
  true,
);
check(
  "isAnalysisOrLiveBlogUrl: /analysis/ mid-path (not a segment, e.g. 'in-analysis-mode') → false",
  isAnalysisOrLiveBlogUrl("https://www.example.com/news/in-analysis-mode/story"),
  false,
);

// --- CNN host-scoped trailing -analysis slug ---
check(
  "deriveContentType: CNN URL with trailing -analysis slug → 'opinion'",
  deriveContentType("https://www.cnn.com/2026/01/01/politics/us-iran-deal-analysis"),
  "opinion",
);
check(
  "deriveContentType: CNN URL with -analysis-intl channel suffix → 'opinion'",
  deriveContentType("https://www.cnn.com/2026/01/01/politics/us-iran-deal-analysis-intl"),
  "opinion",
);
check(
  "deriveContentType: CNN URL with -analysis-intl-hnk channel suffix → 'opinion'",
  deriveContentType("https://www.cnn.com/2026/01/01/politics/us-iran-deal-analysis-intl-hnk"),
  "opinion",
);
// Precision guards for CNN host-scoped rule:
// (a) slug starts with "analysis-" (leading, not trailing) → NOT caught by the
//     host-scoped rule (which requires "-analysis" as a TRAILING token).
//     Note: the general /analysis/ segment rule does NOT match here either,
//     since "analysis-of-ceasefire" is NOT a standalone /analysis/ segment.
check(
  "deriveContentType: CNN URL where slug STARTS with 'analysis-' (not trailing) → 'article' (host-scoped precision guard: must end with '-analysis')",
  deriveContentType("https://www.cnn.com/2026/01/01/politics/analysis-of-the-ceasefire"),
  "article",
);
// (b) non-CNN outlet with a bare -analysis slug → not caught (host-scoped)
check(
  "deriveContentType: non-CNN outlet with trailing -analysis slug → 'article' (host-scoped: no false-positive on other outlets)",
  deriveContentType("https://www.bbc.com/news/us-iran-deal-analysis"),
  "article",
);
// (c) CNN slug ending in -analytical (not -analysis) → must not trip
check(
  "deriveContentType: CNN URL ending with -analytical → 'article' (must end exactly in '-analysis[…]', not '-analytical')",
  deriveContentType("https://www.cnn.com/2026/01/01/politics/framework-analytical"),
  "article",
);

// --- Live-blog path rules ---
check(
  "isAnalysisOrLiveBlogUrl: /live-blog/ path → true",
  isAnalysisOrLiveBlogUrl("https://www.bbc.com/news/live-blog/iran-nuclear-talks"),
  true,
);
check(
  "isAnalysisOrLiveBlogUrl: /liveblog/ path → true",
  isAnalysisOrLiveBlogUrl("https://www.theguardian.com/world/liveblog/2026/jan/01/israel-update"),
  true,
);
check(
  "isAnalysisOrLiveBlogUrl: /live-updates/ path → true",
  isAnalysisOrLiveBlogUrl("https://www.reuters.com/world/live-updates/iran-talks-2026-01-01/"),
  true,
);
check(
  "isAnalysisOrLiveBlogUrl: normal news URL with 'live' in a different word → false",
  isAnalysisOrLiveBlogUrl("https://www.cnn.com/2026/01/01/politics/us-live-ammunition-deployed"),
  false,
);

// --- Podcast path rules ---
check(
  "isAnalysisOrLiveBlogUrl: /podcast/ path → true",
  isAnalysisOrLiveBlogUrl("https://www.npr.org/podcast/episode-title"),
  true,
);
check(
  "isAnalysisOrLiveBlogUrl: /podcasts/ path → true",
  isAnalysisOrLiveBlogUrl("https://www.bbc.com/podcasts/series/global-news"),
  true,
);
check(
  "isAnalysisOrLiveBlogUrl: normal news URL → false",
  isAnalysisOrLiveBlogUrl("https://www.npr.org/2026/01/01/ceasefire-holds"),
  false,
);

// --- Explainer URL rules ---
check(
  "isExplainerUrl: /explainer/ path segment → true",
  isExplainerUrl("https://www.bbc.com/explainer/what-is-the-jcpoa"),
  true,
);
check(
  "isExplainerUrl: /explainers/ path segment → true",
  isExplainerUrl("https://www.vox.com/explainers/2026/1/1/what-is-the-iran-deal"),
  true,
);
check(
  "isExplainerUrl: Reuters explainer- slug prefix → true",
  isExplainerUrl("https://www.reuters.com/world/explainer-what-is-the-iran-nuclear-deal-2026-01-01/"),
  true,
);
check(
  "isExplainerUrl: Reuters URL whose slug does NOT start with explainer- → false (host-scoped: precision guard)",
  isExplainerUrl("https://www.reuters.com/world/some-news-explainer-inside-2026-01-01/"),
  false,
);
check(
  "isExplainerUrl: normal news URL → false",
  isExplainerUrl("https://www.reuters.com/world/ceasefire-holds-2026-01-01/"),
  false,
);
check(
  "deriveContentType: /explainers/ path → 'explainer'",
  deriveContentType("https://www.vox.com/explainers/2026/1/1/what-is-the-iran-deal"),
  "explainer",
);
check(
  "deriveContentType: Reuters explainer- slug → 'explainer'",
  deriveContentType("https://www.reuters.com/world/explainer-what-is-the-iran-nuclear-deal-2026-01-01/"),
  "explainer",
);

// ---------------------------------------------------------------------------
// 4. Shared effective-kind helper — gate parity
// ---------------------------------------------------------------------------

check(
  "getEffectiveContentKind: page-detected opinion wins even on a plain /features/ URL",
  getEffectiveContentKind("https://www.aljazeera.com/features/2026/1/1/story", "opinion"),
  "opinion",
);
check(
  "getEffectiveContentKind: page-detected explainer wins on a plain article URL",
  getEffectiveContentKind("https://www.example.com/news/story", "explainer"),
  "explainer",
);
check(
  "getEffectiveContentKind: URL-derived opinion still detected without a stored kind",
  getEffectiveContentKind("https://example.com/opinion/some-column", null),
  "opinion",
);
check(
  "getEffectiveContentKind: URL-derived explainer still detected without a stored kind",
  getEffectiveContentKind("https://www.vox.com/explainers/2026/1/1/what-is-the-iran-deal", null),
  "explainer",
);
check(
  "getEffectiveContentKind: CNN trailing -analysis URL → 'opinion'",
  getEffectiveContentKind("https://www.cnn.com/2026/01/01/politics/us-iran-deal-analysis", null),
  "opinion",
);
check(
  "getEffectiveContentKind: Guardian commentisfree URL → 'opinion'",
  getEffectiveContentKind("https://www.theguardian.com/commentisfree/2026/jan/01/some-column", null),
  "opinion",
);
check(
  "getEffectiveContentKind: normal article URL + stored 'article' stays article",
  getEffectiveContentKind("https://example.com/news/story", "article"),
  "article",
);
check(
  "getEffectiveContentKind: stored 'audio' always wins",
  getEffectiveContentKind("https://npr.org/some/story", "audio"),
  "audio",
);
check(
  "isEffectivelyReportedArticle: page-detected analysis is NOT a reported article (standalone/narrative gate excludes it)",
  isEffectivelyReportedArticle("https://www.aljazeera.com/features/2026/1/1/story", "opinion"),
  false,
);
check(
  "isEffectivelyReportedArticle: page-detected explainer is NOT a reported article",
  isEffectivelyReportedArticle("https://www.reuters.com/world/story", "explainer"),
  false,
);
check(
  "isEffectivelyReportedArticle: CNN trailing -analysis URL is NOT a reported article",
  isEffectivelyReportedArticle("https://www.cnn.com/2026/01/01/politics/us-iran-deal-analysis", null),
  false,
);
check(
  "isEffectivelyReportedArticle: live-blog URL is NOT a reported article",
  isEffectivelyReportedArticle("https://www.bbc.com/news/live-blog/iran-nuclear-talks", null),
  false,
);
check(
  "isEffectivelyReportedArticle: Guardian /commentisfree/ URL is NOT a reported article",
  isEffectivelyReportedArticle("https://www.theguardian.com/commentisfree/2026/jan/01/some-column", null),
  false,
);
check(
  "isEffectivelyReportedArticle: /explainers/ URL is NOT a reported article",
  isEffectivelyReportedArticle("https://www.vox.com/explainers/2026/1/1/what-is-the-iran-deal", null),
  false,
);
check(
  "isEffectivelyReportedArticle: normal reported article IS a reported article",
  isEffectivelyReportedArticle("https://example.com/news/story", "article"),
  true,
);
check(
  "isEffectivelyReportedArticle: a '?'-headline reported article is unaffected (kind is independent of title)",
  isEffectivelyReportedArticle("https://example.com/news/will-it-hold", "article"),
  true,
);
// Precision: a real-news URL that happens to contain "analysis" mid-path must stay 'article'
check(
  "isEffectivelyReportedArticle: non-CNN URL containing 'analysis' in the news path → still a reported article (precision guard)",
  isEffectivelyReportedArticle("https://www.bbc.com/news/world-analysis-ceasefire-holds", null),
  true,
);

// ---------------------------------------------------------------------------
// 5. Cluster tiering decision — attach-only demotion for trusted outlets only
// ---------------------------------------------------------------------------

check(
  "shouldDemoteEffectiveOpinion: trusted outlet + page-detected opinion -> demote to attach-only",
  shouldDemoteEffectiveOpinion(false, "primary", "https://www.aljazeera.com/features/story", "opinion"),
  true,
);
check(
  "shouldDemoteEffectiveOpinion: trusted outlet + page-detected explainer -> demote to attach-only",
  shouldDemoteEffectiveOpinion(false, "primary", "https://www.reuters.com/world/story", "explainer"),
  true,
);
check(
  "shouldDemoteEffectiveOpinion: trusted outlet + CNN trailing -analysis URL -> demote to attach-only",
  shouldDemoteEffectiveOpinion(false, "primary", "https://www.cnn.com/2026/01/01/politics/us-iran-deal-analysis", null),
  true,
);
check(
  "shouldDemoteEffectiveOpinion: trusted outlet + /commentisfree/ URL -> demote to attach-only",
  shouldDemoteEffectiveOpinion(false, "primary", "https://www.theguardian.com/commentisfree/2026/jan/01/some-column", null),
  true,
);
check(
  "shouldDemoteEffectiveOpinion: trusted outlet + /explainers/ URL -> demote to attach-only",
  shouldDemoteEffectiveOpinion(false, "primary", "https://www.vox.com/explainers/2026/1/1/what-is-the-iran-deal", null),
  true,
);
check(
  "shouldDemoteEffectiveOpinion: trusted outlet + live-blog URL -> demote to attach-only",
  shouldDemoteEffectiveOpinion(false, "primary", "https://www.bbc.com/news/live-blog/iran-nuclear-talks", null),
  true,
);
check(
  "shouldDemoteEffectiveOpinion: trusted outlet + podcast URL -> demote to attach-only",
  shouldDemoteEffectiveOpinion(false, "primary", "https://www.npr.org/podcast/some-episode", null),
  true,
);
check(
  "shouldDemoteEffectiveOpinion: trusted outlet + Reuters explainer- URL -> demote to attach-only",
  shouldDemoteEffectiveOpinion(false, "primary", "https://www.reuters.com/world/explainer-what-is-the-iran-nuclear-deal-2026-01-01/", null),
  true,
);
check(
  "shouldDemoteEffectiveOpinion: trusted outlet + normal article -> NOT demoted (stays a contributing/anchor peer)",
  shouldDemoteEffectiveOpinion(false, "primary", "https://example.com/news/story", "article"),
  false,
);
check(
  "shouldDemoteEffectiveOpinion: already-contrast (adversary) outlet is left untouched even with an opinion URL — this task never softens an adversary label",
  shouldDemoteEffectiveOpinion(false, "contrast", "https://example.com/opinion/column", "opinion"),
  false,
);
check(
  "shouldDemoteEffectiveOpinion: already-blocked outlet is left untouched",
  shouldDemoteEffectiveOpinion(true, "primary", "https://example.com/opinion/column", "opinion"),
  false,
);
check(
  "shouldDemoteEffectiveOpinion: no behaviorLabel (unregistered outlet) + opinion URL still demotes",
  shouldDemoteEffectiveOpinion(false, null, "https://example.com/opinion/column", null),
  true,
);
// Precision: a real-news CNN URL containing "analysis" mid-slug must NOT demote
check(
  "shouldDemoteEffectiveOpinion: non-CNN outlet with 'world-analysis' in path → NOT demoted (precision guard)",
  shouldDemoteEffectiveOpinion(false, "primary", "https://www.bbc.com/news/world-analysis", null),
  false,
);

// ---------------------------------------------------------------------------
// 6. Task #899 — live-blog and podcast must NOT be labeled "opinion"
// ---------------------------------------------------------------------------

// New kind predicates
check(
  "isLiveBlogUrl: /live-blog/ → true",
  isLiveBlogUrl("https://www.bbc.com/news/live-blog/iran-nuclear-talks"),
  true,
);
check(
  "isLiveBlogUrl: /liveblog/ → true",
  isLiveBlogUrl("https://www.theguardian.com/world/liveblog/2026/jan/01/update"),
  true,
);
check(
  "isLiveBlogUrl: /live-updates/ → true",
  isLiveBlogUrl("https://www.cbsnews.com/live-updates/iran-us-war-trump-strait-of-hormuz"),
  true,
);
check(
  "isLiveBlogUrl: normal news URL → false",
  isLiveBlogUrl("https://www.cnn.com/2026/01/01/politics/live-ammunition-deployed"),
  false,
);
// Widened shapes: /live/ section, /live-news/, trailing -live, host-scoped mid-slug -live-
check(
  "isLiveBlogUrl: Guardian /world/live/ section → true",
  isLiveBlogUrl("https://www.theguardian.com/world/live/2026/jul/16/iran-us-war-strait-hormuz-latest-news-updates"),
  true,
);
check(
  "isLiveBlogUrl: CNN /live-news/ → true",
  isLiveBlogUrl("https://www.cnn.com/2026/07/16/world/live-news/iran-war-trump"),
  true,
);
check(
  "isLiveBlogUrl: Fox /live-news/ → true",
  isLiveBlogUrl("https://www.foxnews.com/live-news/iran-war-trump-israel-hormuz-oil-july-15-2026"),
  true,
);
check(
  "isLiveBlogUrl: USA Today trailing --live/ → true",
  isLiveBlogUrl("https://www.usatoday.com/story/news/world/2026/07/15/iran-war-updates-us-strikes-strait-hormuz--live/90922350007/"),
  true,
);
check(
  "isLiveBlogUrl: Reuters host-scoped iran-war-live- mid-slug → true",
  isLiveBlogUrl("https://www.reuters.com/world/iran-war-live-iran-says-it-targeted-bases-kuwait-jordan-2026-07-16/"),
  true,
);
check(
  "isLiveBlogUrl: France 24 host-scoped -middle-east-live- mid-slug → true",
  isLiveBlogUrl("https://www.france24.com/en/middle-east/20260716-middle-east-live-us-launches-fresh-strikes-on-iran"),
  true,
);
check(
  "isLiveBlogUrl: France 24 non-live article (no -live- token) → false",
  isLiveBlogUrl("https://www.france24.com/en/middle-east/20260715-us-launches-wave-of-strikes-on-iran-tehran-threatens"),
  false,
);
check(
  "isLiveBlogUrl: lifestyle 'how-to-live-longer' on generic host → false (mid-slug -live- is host-scoped)",
  isLiveBlogUrl("https://example.com/news/how-to-live-longer-and-stay-alive"),
  false,
);
check(
  "isLiveBlogUrl: 'olive-oil-benefits' → false (no -live token)",
  isLiveBlogUrl("https://example.com/health/olive-oil-benefits"),
  false,
);
// Widened live shapes (mixed-cluster fix): DW numbered live segment + general
// mid-slug "-live-updates-" compound (The Hindu), plus the umbrella-recap
// TITLE predicate for plain-URL rolling recap pages (Al Jazeera).
check(
  "isLiveBlogUrl: DW numbered /live-78077811 segment → true",
  isLiveBlogUrl("https://www.dw.com/en/iran-war-us-strikes-latest-updates/live-78077811"),
  true,
);
check(
  "isLiveBlogUrl: The Hindu mid-slug -live-updates- compound → true (general, not host-scoped)",
  isLiveBlogUrl("https://www.thehindu.com/news/international/iran-us-war-live-updates-military-strike-us-central-command-strait-of-hormuz/article12345.ece"),
  true,
);
check(
  "isLiveBlogUrl: slug ending in -live-updates (no trailing dash) → true",
  isLiveBlogUrl("https://example.com/world/iran-conflict-live-updates"),
  true,
);
check(
  "isLiveBlogUrl: 'live-fire-drill' segment → false (live-<digits> only)",
  isLiveBlogUrl("https://example.com/news/live-fire-drill-korea"),
  false,
);
check(
  "isLiveBlogUrl: 'how-to-get-live-updates-app' → true is acceptable, but plain 'delivers-updates' → false",
  isLiveBlogUrl("https://example.com/tech/company-delivers-updates-to-users"),
  false,
);
check(
  "isLiveUmbrellaTitle: AJ trailing ': What's the latest?' recap → true",
  isLiveUmbrellaTitle("Iran, Houthis strike tankers as US bombing continues: What\u2019s the latest?"),
  true,
);
check(
  "isLiveUmbrellaTitle: straight apostrophe + no question mark → true",
  isLiveUmbrellaTitle("US-Iran conflict: what's the latest"),
  true,
);
check(
  "isLiveUmbrellaTitle: mid-title phrase → false",
  isLiveUmbrellaTitle("What's the latest jobs report say about the economy"),
  false,
);
check(
  "isLiveUmbrellaTitle: ordinary headline → false",
  isLiveUmbrellaTitle("House votes to limit Trump's war powers against Iran"),
  false,
);
check(
  "isLiveUmbrellaTitle: null/empty → false",
  isLiveUmbrellaTitle(null) || isLiveUmbrellaTitle(""),
  false,
);
check(
  "deriveContentType: Guardian /world/live/ → 'live' (not 'article')",
  deriveContentType("https://www.theguardian.com/world/live/2026/jul/16/iran-us-war-latest-news-updates"),
  "live",
);
check(
  "deriveContentType: CNN /live-news/ → 'live' (not 'article')",
  deriveContentType("https://www.cnn.com/2026/07/16/world/live-news/iran-war-trump"),
  "live",
);
// Union predicate parity: isAnalysisOrLiveBlogUrl must recognize the same
// widened live-blog shapes as isLiveBlogUrl (it delegates to it).
check(
  "isAnalysisOrLiveBlogUrl: Guardian /world/live/ → true (parity with isLiveBlogUrl)",
  isAnalysisOrLiveBlogUrl("https://www.theguardian.com/world/live/2026/jul/16/iran-us-war-latest-news-updates"),
  true,
);
check(
  "isAnalysisOrLiveBlogUrl: CNN /live-news/ → true (parity)",
  isAnalysisOrLiveBlogUrl("https://www.cnn.com/2026/07/16/world/live-news/iran-war-trump"),
  true,
);
check(
  "isAnalysisOrLiveBlogUrl: Reuters iran-war-live- → true (parity, host-scoped)",
  isAnalysisOrLiveBlogUrl("https://www.reuters.com/world/iran-war-live-iran-says-it-targeted-bases-kuwait-jordan-2026-07-16/"),
  true,
);
check(
  "isAnalysisOrLiveBlogUrl: USA Today trailing --live/ → true (parity)",
  isAnalysisOrLiveBlogUrl("https://www.usatoday.com/story/news/world/2026/07/15/iran-war-updates-strait-hormuz--live/90922350007/"),
  true,
);
check(
  "isAnalysisOrLiveBlogUrl: lifestyle how-to-live-longer on generic host → false (parity, no false-positive)",
  isAnalysisOrLiveBlogUrl("https://example.com/news/how-to-live-longer-and-stay-alive"),
  false,
);
check(
  "isPodcastUrl: /podcast/ → true",
  isPodcastUrl("https://www.npr.org/podcast/episode-title"),
  true,
);
check(
  "isPodcastUrl: /podcasts/ → true",
  isPodcastUrl("https://www.bbc.com/podcasts/series/global-news"),
  true,
);
check(
  "isPodcastUrl: normal news URL → false",
  isPodcastUrl("https://www.npr.org/2026/01/01/ceasefire-holds"),
  false,
);

// deriveContentType now returns 'live' / 'podcast' — never 'opinion' — for these paths
check(
  "deriveContentType: /live-updates/ URL → 'live' (not 'opinion')",
  deriveContentType("https://www.cbsnews.com/live-updates/iran-us-war-trump-strait-of-hormuz"),
  "live",
);
check(
  "deriveContentType: /live-blog/ URL → 'live' (not 'opinion')",
  deriveContentType("https://www.bbc.com/news/live-blog/iran-nuclear-talks"),
  "live",
);
check(
  "deriveContentType: /liveblog/ URL → 'live' (not 'opinion')",
  deriveContentType("https://www.theguardian.com/world/liveblog/2026/jan/01/update"),
  "live",
);
check(
  "deriveContentType: /podcast/ URL → 'podcast' (not 'opinion')",
  deriveContentType("https://www.npr.org/podcast/some-episode"),
  "podcast",
);
check(
  "deriveContentType: /podcasts/ URL → 'podcast' (not 'opinion')",
  deriveContentType("https://www.bbc.com/podcasts/series/global-news"),
  "podcast",
);
// Real opinion URLs still classify as 'opinion'
check(
  "deriveContentType: /opinion/ URL → 'opinion' (unchanged)",
  deriveContentType("https://www.washingtonpost.com/opinions/2026/01/some-column"),
  "opinion",
);
check(
  "deriveContentType: /commentisfree/ URL → 'opinion' (unchanged)",
  deriveContentType("https://www.theguardian.com/commentisfree/2026/jan/01/some-column"),
  "opinion",
);

// getEffectiveContentKind / isEffectivelyReportedArticle for the new kinds
check(
  "getEffectiveContentKind: /live-updates/ URL → 'live'",
  getEffectiveContentKind("https://www.cbsnews.com/live-updates/iran-us-war-trump-strait-of-hormuz", null),
  "live",
);
check(
  "getEffectiveContentKind: /podcast/ URL → 'podcast'",
  getEffectiveContentKind("https://www.npr.org/podcast/some-episode", null),
  "podcast",
);
check(
  "isEffectivelyReportedArticle: /live-updates/ URL → false (excluded from reported-article gates)",
  isEffectivelyReportedArticle("https://www.cbsnews.com/live-updates/iran-us-war-trump-strait-of-hormuz", null),
  false,
);
check(
  "isEffectivelyReportedArticle: /podcast/ URL → false",
  isEffectivelyReportedArticle("https://www.npr.org/podcast/some-episode", null),
  false,
);

// isAnalysisOrLiveBlogUrl still returns true for all these (used as a union
// predicate in the score cap); deriveContentType just routes them earlier.
check(
  "isAnalysisOrLiveBlogUrl: /live-updates/ still true (union predicate unchanged)",
  isAnalysisOrLiveBlogUrl("https://www.cbsnews.com/live-updates/iran-us-war-trump-strait-of-hormuz"),
  true,
);
check(
  "isAnalysisOrLiveBlogUrl: /podcast/ still true (union predicate unchanged)",
  isAnalysisOrLiveBlogUrl("https://www.npr.org/podcast/some-episode"),
  true,
);

// shouldDemoteEffectiveOpinion: live/podcast still demote to attach-only
check(
  "shouldDemoteEffectiveOpinion: /live-updates/ → demoted (same gate, different badge)",
  shouldDemoteEffectiveOpinion(false, "primary", "https://www.cbsnews.com/live-updates/iran-us-war-trump-strait-of-hormuz", null),
  true,
);
check(
  "shouldDemoteEffectiveOpinion: /podcast/ → demoted (same gate, different badge)",
  shouldDemoteEffectiveOpinion(false, "primary", "https://www.npr.org/podcast/some-episode", null),
  true,
);

// evalCuratedAnalysisOpinionCap: live/podcast still capped at ≤69
const OVER_CAP = CURATED_ANALYSIS_OPINION_CAP + 10;
check(
  "evalCuratedAnalysisOpinionCap: /live-updates/ URL above cap → capped to 69",
  evalCuratedAnalysisOpinionCap("https://www.cbsnews.com/live-updates/iran-us-war-trump-strait-of-hormuz", OVER_CAP).score,
  CURATED_ANALYSIS_OPINION_CAP,
);
check(
  "evalCuratedAnalysisOpinionCap: /podcast/ URL above cap → capped to 69",
  evalCuratedAnalysisOpinionCap("https://www.npr.org/podcast/some-episode", OVER_CAP).score,
  CURATED_ANALYSIS_OPINION_CAP,
);
check(
  "evalCuratedAnalysisOpinionCap: /opinion/ URL above cap → still capped to 69",
  evalCuratedAnalysisOpinionCap("https://www.washingtonpost.com/opinions/2026/01/col", OVER_CAP).score,
  CURATED_ANALYSIS_OPINION_CAP,
);
check(
  "evalCuratedAnalysisOpinionCap: normal article URL → not capped",
  evalCuratedAnalysisOpinionCap("https://www.reuters.com/world/ceasefire-2026-01-01/", OVER_CAP).score,
  OVER_CAP,
);

// ---------------------------------------------------------------------------
// 7. Task #963 — headline trailing-kicker, WH-lead dual-signal, URL-section
//    gap fixes, and interrogative first-indicator.
//
// Real examples from the Adjustments log that were NOT previously caught,
// plus negative precision fixtures ensuring ordinary reported "?" headlines
// and mid-slug "analysis" tokens are never demoted.
// ---------------------------------------------------------------------------

// --- detectTitleTrailingKicker ---

// --- detectTitleLeadingLabel ---

check(
  "detectTitleLeadingLabel: CNBC 'Op-ed:' label → 'opinion'",
  detectTitleLeadingLabel("Op-ed: The U.S. lead over China in AI is all but gone"),
  "opinion",
);
check(
  "detectTitleLeadingLabel: case and whitespace variant 'OP-ED : …' → 'opinion'",
  detectTitleLeadingLabel("  OP-ED : The U.S. lead over China in AI is all but gone"),
  "opinion",
);
check(
  "detectTitleLeadingLabel: explicit leading 'Analysis:' label → 'opinion'",
  detectTitleLeadingLabel("Analysis: What Beijing's new AI strategy means"),
  "opinion",
);
check(
  "detectTitleLeadingLabel: mid-headline 'op-ed' mention remains article",
  detectTitleLeadingLabel("Senator responds to op-ed criticizing China policy"),
  null,
);
check(
  "detectTitleLeadingLabel: body-text-style 'Analysis shows …' has no label separator",
  detectTitleLeadingLabel("Analysis shows China expanding its AI lead"),
  null,
);
check(
  "detectTitleLeadingLabel: unlabelled reported headline remains article",
  detectTitleLeadingLabel("The U.S. lead over China in AI is all but gone"),
  null,
);

// JPost prototype: "… in Gaza - analysis"
check(
  "detectTitleTrailingKicker: JPost '… - analysis' trailing kicker → 'opinion'",
  detectTitleTrailingKicker(
    "Why Morocco's commitment is a major milestone for the US peace plan in Gaza - analysis",
  ),
  "opinion",
);
check(
  "detectTitleTrailingKicker: '… — opinion' em-dash variant → 'opinion'",
  detectTitleTrailingKicker("What the new Gulf alliance means for US strategy — opinion"),
  "opinion",
);
check(
  "detectTitleTrailingKicker: '… | editorial' pipe variant → 'opinion'",
  detectTitleTrailingKicker("Trump's Hormuz gamble could backfire badly | editorial"),
  "opinion",
);
check(
  "detectTitleTrailingKicker: '… - explainer' trailing kicker → 'explainer'",
  detectTitleTrailingKicker("How the Iran nuclear deal fell apart - explainer"),
  "explainer",
);
check(
  "detectTitleTrailingKicker: '… - commentary' trailing kicker → 'opinion'",
  detectTitleTrailingKicker("The ceasefire terms are unworkable - commentary"),
  "opinion",
);
check(
  "detectTitleTrailingKicker: '… - op-ed' trailing kicker → 'opinion'",
  detectTitleTrailingKicker("Why sanctions alone cannot stop Iran's nuclear program - op-ed"),
  "opinion",
);
// Precision: mid-sentence "analysis" must NOT be caught
check(
  "detectTitleTrailingKicker: mid-sentence 'analysis' does NOT match (only trailing)",
  detectTitleTrailingKicker("Analysis shows Iran may be enriching uranium faster than expected"),
  null,
);
// Precision: bare "- analysis" with no real headline text is too short → null
check(
  "detectTitleTrailingKicker: bare '- analysis' with no substantive text → null (length guard)",
  detectTitleTrailingKicker("No - analysis"),
  null,
);
// Precision: "review" (collision-prone) is NOT in the kicker list
check(
  "detectTitleTrailingKicker: '… - review' does NOT match (review excluded for precision)",
  detectTitleTrailingKicker("The year-end defense budget summary - review"),
  null,
);
// Precision: normal reported article with no trailing kicker → null
check(
  "detectTitleTrailingKicker: plain reported headline → null",
  detectTitleTrailingKicker("US and Iran agree on nuclear framework after marathon talks"),
  null,
);

// --- detectWHLeadDualSignal ---

// France24 class: why-slug + Why headline
check(
  "detectWHLeadDualSignal: France24-style why-slug + Why headline → 'explainer'",
  detectWHLeadDualSignal(
    "https://www.france24.com/en/middle-east/20260101-why-the-us-is-launching-strikes-against-houthi-positions",
    "Why the US is launching strikes against Houthi positions",
  ),
  "explainer",
);
// Reuters class: why-are-houthis slug + Why headline
check(
  "detectWHLeadDualSignal: Reuters-style why-slug + Why headline → 'explainer'",
  detectWHLeadDualSignal(
    "https://www.reuters.com/world/middle-east/why-are-houthis-attacking-ships-what-does-it-mean-oil-2026-01-01/",
    "Why are the Houthis attacking ships and what does it mean for oil?",
  ),
  "explainer",
);
// DW class: what-s-behind slug + What's headline
check(
  "detectWHLeadDualSignal: DW-style what-s-slug + What's headline → 'explainer'",
  detectWHLeadDualSignal(
    "https://www.dw.com/en/what-s-behind-the-iran-regime-crackdown-on-protests/a-12345678",
    "What's behind the Iran regime crackdown on protests",
  ),
  "explainer",
);
// DW class: how-slug + How headline
check(
  "detectWHLeadDualSignal: how-slug + How headline → 'explainer'",
  detectWHLeadDualSignal(
    "https://www.dw.com/en/how-the-us-iran-nuclear-deal-fell-apart-whats-at-stake/a-87654321",
    "How the US-Iran nuclear deal fell apart — and what's at stake",
  ),
  "explainer",
);
// Precision: Why headline with a DECLARATIVE slug → NOT caught (only one signal)
check(
  "detectWHLeadDualSignal: Why headline + declarative slug → null (single signal, no dual-corroboration)",
  detectWHLeadDualSignal(
    "https://www.aljazeera.com/news/2026/1/1/us-iran-truce-deal",
    "Why a new truce deal is harder than it looks",
  ),
  null,
);
// Precision: WH-word mid-slug (not at segment start) → NOT caught
check(
  "detectWHLeadDualSignal: WH-word mid-slug 'iraq-why-sanctions' → null (must be at segment start)",
  detectWHLeadDualSignal(
    "https://www.example.com/news/iraq-why-sanctions-matter",
    "Why Iraq's sanctions exposure is growing",
  ),
  null,
);
// Precision: Why headline with "will" slug → NOT matched (wrong base word)
check(
  "detectWHLeadDualSignal: Why headline + 'will-iran-back-down' slug → null (base-word mismatch)",
  detectWHLeadDualSignal(
    "https://www.example.com/news/will-iran-back-down",
    "Why Iran is unlikely to back down",
  ),
  null,
);

// --- isOpinionUrl gaps (Task #963 Step 1) ---

// Ynetnews /opinions-analysis/ compound segment
check(
  "isOpinionUrl: Ynetnews /opinions-analysis/ compound segment → true",
  isOpinionUrl("https://www.ynetnews.com/opinions-analysis/article/someid"),
  true,
);
check(
  "isOpinionUrl: Ynetnews /opinion-analysis/ (singular) also caught",
  isOpinionUrl("https://www.ynetnews.com/opinion-analysis/article/someid"),
  true,
);
// Precision: a slug that happens to contain "opinions" mid-path on an
// unrelated host must not match the bare /opinions?/ rule — confirmed by
// ensuring that /in-opinions-round-up/ does NOT match.
check(
  "isOpinionUrl: mid-path 'opinions' on arbitrary host → false (segment-anchored)",
  isOpinionUrl("https://www.example.com/news/in-opinions-round-up/story"),
  false,
);

// The Daily Star (thedailystar.net) /slow-reads/geopolitical-insights/ section
check(
  "isOpinionUrl: The Daily Star /slow-reads/geopolitical-insights/ → true (host-scoped)",
  isOpinionUrl("https://www.thedailystar.net/slow-reads/geopolitical-insights/article-20260101"),
  true,
);
// Precision: same path on a DIFFERENT host must not match (host-scoped)
check(
  "isOpinionUrl: /slow-reads/geopolitical-insights/ on another host → false (host-scoped guard)",
  isOpinionUrl("https://www.example.com/slow-reads/geopolitical-insights/some-article"),
  false,
);

// Downstream: deriveContentType correctly routes these new URL shapes
check(
  "deriveContentType: Ynetnews /opinions-analysis/ → 'opinion'",
  deriveContentType("https://www.ynetnews.com/opinions-analysis/article/byq5kdaxg"),
  "opinion",
);
check(
  "deriveContentType: Daily Star /slow-reads/geopolitical-insights/ → 'opinion'",
  deriveContentType("https://www.thedailystar.net/slow-reads/geopolitical-insights/some-analysis"),
  "opinion",
);

// --- hasTitleInterrogativeSignal (Step 4 first-indicator) ---

// Must flag interrogative titles
check(
  "hasTitleInterrogativeSignal: trailing '?' → true",
  hasTitleInterrogativeSignal("US or Iran — Who needs a new truce deal more?"),
  true,
);
check(
  "hasTitleInterrogativeSignal: Newsweek 'Why?' at end → true",
  hasTitleInterrogativeSignal("Thousands of Ukrainians Are Protesting Zelensky Decision Today—Why?"),
  true,
);
check(
  "hasTitleInterrogativeSignal: WH-lead 'Why' at start → true",
  hasTitleInterrogativeSignal("Why Morocco's commitment is a milestone for the Gaza peace plan"),
  true,
);
check(
  "hasTitleInterrogativeSignal: WH-lead 'What' at start → true",
  hasTitleInterrogativeSignal("What's behind the Iran regime crackdown"),
  true,
);
// Precision: plain reported article → false (this is a FIRST INDICATOR only)
check(
  "hasTitleInterrogativeSignal: plain reported headline without '?' or WH-lead → false",
  hasTitleInterrogativeSignal("US and Iran sign nuclear framework after marathon talks"),
  false,
);
// KEY NEGATIVE: a '?' alone must NEVER auto-demote — it is a first indicator only.
// This is verified by confirming detectTitleTrailingKicker returns null for it.
check(
  "detectTitleTrailingKicker: lone '?' headline does NOT match trailing-kicker rule (no auto-demotion)",
  detectTitleTrailingKicker("US or Iran — Who needs a new truce deal more?"),
  null,
);
// And detectWHLeadDualSignal needs DUAL signal so lone '?' also does not auto-demote.
check(
  "detectWHLeadDualSignal: lone '?' title with no WH-lead + declarative slug → null (no auto-demotion)",
  detectWHLeadDualSignal(
    "https://www.aljazeera.com/news/2026/1/1/us-iran-who-needs-truce",
    "US or Iran — Who needs a new truce deal more?",
  ),
  null,
);

// --- Contrast-outlet interaction (Step 5) ---
// shouldDemoteEffectiveOpinion early-returns false for 'contrast' outlets,
// so a contrast outlet's interrogative headline is NEVER auto-demoted by
// either the URL gate or the title-based gates. Confirmed here.
check(
  "shouldDemoteEffectiveOpinion: contrast outlet with trailing-kicker stored kind → NOT demoted (contrast gate)",
  shouldDemoteEffectiveOpinion(false, "contrast", "https://www.aljazeera.com/news/story", "opinion"),
  false,
);
check(
  "shouldDemoteEffectiveOpinion: contrast outlet even with explainer URL → NOT demoted",
  shouldDemoteEffectiveOpinion(false, "contrast", "https://www.aljazeera.com/features/explainer-iran", "explainer"),
  false,
);

// ---------------------------------------------------------------------------
// 8. Task #1007 — title-based demotion at read time (getEffectiveContentKindWithTitle)
//
// Al Jazeera /news/…/why-is-… explainers have no /explainers/ path segment
// so URL detection returns "article". The WH-lead dual-signal catches them
// via the title, enabling demotion on the FIRST clustering pass before
// enrichment writes content_kind = 'explainer'.
// ---------------------------------------------------------------------------

// --- getEffectiveContentKindWithTitle: WH-lead dual signal ---
check(
  "getEffectiveContentKindWithTitle: CNBC 'Op-ed:' title → 'opinion' on first pass without stored enrichment",
  getEffectiveContentKindWithTitle(
    "https://www.cnbc.com/2026/08/02/us-china-ai-lead.html",
    "Op-ed: The U.S. lead over China in AI is all but gone",
    null,
  ),
  "opinion",
);
check(
  "isEffectivelyReportedArticle: CNBC 'Op-ed:' title is excluded from standalone headline surfaces on first pass",
  isEffectivelyReportedArticle(
    "https://www.cnbc.com/2026/08/02/us-china-ai-lead.html",
    null,
    "Op-ed: The U.S. lead over China in AI is all but gone",
  ),
  false,
);
check(
  "getEffectiveContentKindWithTitle: AJ /news/ + WH 'Why is…' title → 'explainer' (no stored kind)",
  getEffectiveContentKindWithTitle(
    "https://www.aljazeera.com/news/2026/7/17/why-is-the-us-attacking-southern-irans-civilian-infrastructure",
    "Why is the US attacking southern Iran's civilian infrastructure?",
    null,
  ),
  "explainer",
);
check(
  "getEffectiveContentKindWithTitle: AJ /news/ + declarative title → 'article' (only one signal, no dual-corroboration)",
  getEffectiveContentKindWithTitle(
    "https://www.aljazeera.com/news/2026/7/17/why-is-the-us-attacking-southern-irans-civilian-infrastructure",
    "US strikes southern Iran's civilian infrastructure",
    null,
  ),
  "article",
);
check(
  "getEffectiveContentKindWithTitle: plain /news/ URL + trailing-kicker title → 'opinion'",
  getEffectiveContentKindWithTitle(
    "https://www.aljazeera.com/news/2026/7/17/sanctions-cannot-stop-iran",
    "Why sanctions alone cannot stop Iran's nuclear program - analysis",
    null,
  ),
  "opinion",
);
// Stored kind wins even when title provides no extra signal (regression guard).
check(
  "getEffectiveContentKindWithTitle: stored 'opinion' still wins regardless of title",
  getEffectiveContentKindWithTitle(
    "https://www.aljazeera.com/features/2026/7/17/analysis-piece",
    "US and Iran sign a deal",
    "opinion",
  ),
  "opinion",
);
// URL shape wins before title is consulted (regression guard).
check(
  "getEffectiveContentKindWithTitle: /explainers/ URL wins before title check",
  getEffectiveContentKindWithTitle(
    "https://www.vox.com/explainers/2026/1/1/what-is-the-iran-deal",
    "US and Iran sign a deal",
    null,
  ),
  "explainer",
);

// --- shouldDemoteEffectiveOpinion: title-based path (fifth param) ---
check(
  "shouldDemoteEffectiveOpinion: trusted CNBC 'Op-ed:' title → attach-only without stored enrichment",
  shouldDemoteEffectiveOpinion(
    false,
    "primary",
    "https://www.cnbc.com/2026/08/02/us-china-ai-lead.html",
    null,
    "Op-ed: The U.S. lead over China in AI is all but gone",
  ),
  true,
);
check(
  "shouldDemoteEffectiveOpinion: contrast 'Op-ed:' title stays contrast (never re-tiered)",
  shouldDemoteEffectiveOpinion(
    false,
    "contrast",
    "https://www.cnbc.com/2026/08/02/us-china-ai-lead.html",
    null,
    "Op-ed: The U.S. lead over China in AI is all but gone",
  ),
  false,
);
check(
  "shouldDemoteEffectiveOpinion: AJ /news/ + WH title + no stored kind → demoted immediately (title-based, no enrichment needed)",
  shouldDemoteEffectiveOpinion(
    false,
    "primary",
    "https://www.aljazeera.com/news/2026/7/17/why-is-the-us-attacking-southern-irans-civilian-infrastructure",
    null,
    "Why is the US attacking southern Iran's civilian infrastructure?",
  ),
  true,
);
check(
  "shouldDemoteEffectiveOpinion: AJ /news/ + declarative title + no stored kind → NOT demoted (dual signal requires both)",
  shouldDemoteEffectiveOpinion(
    false,
    "primary",
    "https://www.aljazeera.com/news/2026/7/17/why-is-the-us-attacking-southern-irans-civilian-infrastructure",
    null,
    "US strikes southern Iran's civilian infrastructure",
  ),
  false,
);
check(
  "shouldDemoteEffectiveOpinion: trailing-kicker title on plain /news/ URL → demoted (title-based)",
  shouldDemoteEffectiveOpinion(
    false,
    "primary",
    "https://www.aljazeera.com/news/2026/7/17/iran-sanctions",
    null,
    "Why sanctions alone cannot stop Iran's nuclear program - analysis",
  ),
  true,
);
// Backward-compat: no title param → behaves identically to prior version.
check(
  "shouldDemoteEffectiveOpinion: no title param → URL-only detection unchanged (backward-compat)",
  shouldDemoteEffectiveOpinion(false, "primary", "https://example.com/opinion/col", null),
  true,
);
// Contrast early-return fires before title check (regression guard).
check(
  "shouldDemoteEffectiveOpinion: contrast outlet + WH title → NOT demoted (contrast gate fires before title)",
  shouldDemoteEffectiveOpinion(
    false,
    "contrast",
    "https://www.aljazeera.com/news/2026/7/17/why-is-the-us-attacking-iran",
    null,
    "Why is the US attacking Iran?",
  ),
  false,
);

console.log(`\n${pass}/${pass + failures.length} passed`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
