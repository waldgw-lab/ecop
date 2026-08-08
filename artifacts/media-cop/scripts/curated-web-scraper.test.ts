/**
 * Regression test for the curated-only CNN/NPR website scraper parsing
 * (Task #324, guards the Task #321 intake).
 *
 * CNN and NPR have no working RSS into the isolated Curated lane, so
 * server/curatedWebScraper.ts scrapes their public section pages with CSS
 * selectors + dated-URL patterns. If either outlet redesigns its HTML, those
 * selectors silently stop matching and these authoritative wires quietly fall
 * out of Curated with no error — the exact "trickle" problem #321 fixed.
 *
 * This feeds saved section-page HTML fixtures into the scraper's PURE parser
 * (parseSectionHtml — no network, no date filter) and asserts each source still
 * extracts a non-zero set of {title, url} with sensible titles and dated
 * article URLs, while filtering out nav / video / non-dated noise. It fails
 * loudly if a linkSelector / hrefPattern / titleSelector stops matching.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-web-scraper.test.ts
 * Exits non-zero on any failure.
 */
import {
  parseSectionHtml,
  CNN_CURATED_SOURCE,
  NPR_CURATED_SOURCE,
  GLOBAL_TIMES_CURATED_SOURCE,
  CHINA_DAILY_CURATED_SOURCE,
  PEOPLES_DAILY_CURATED_SOURCE,
  CGTN_CURATED_SOURCE,
  TELESUR_CURATED_SOURCE,
  KCNA_CURATED_SOURCE,
  type CuratedWebSource,
} from "../server/curatedWebScraper";
import { extractDateFromUrl } from "../server/articleDateFilter";

// ---------------------------------------------------------------------------
// Saved fixtures. These mirror the real CNN / NPR section-page markup the
// scraper depends on, INCLUDING noise that must be filtered out: site-nav
// links, video pages, share links, dateless links, and too-short titles.
// ---------------------------------------------------------------------------

// CNN: linkSelector 'a[href*="/20"]', titleSelector '.container__headline-text',
// hrefPattern /cnn.com/YYYY/MM/DD/<section>/.../
const CNN_FIXTURE = `
<!doctype html><html><body>
  <nav>
    <a href="/world">World</a>
    <a href="/politics">Politics</a>
    <a href="/us">US</a>
  </nav>
  <section class="container">
    <a href="/2026/06/16/politics/senate-defense-bill-vote/index.html" class="container__link">
      <div class="container__headline">
        <span class="container__headline-text">Senate advances sweeping defense authorization bill</span>
      </div>
    </a>
    <a href="/2026/06/16/world/nato-summit-ukraine-aid/index.html" class="container__link">
      <div class="container__headline">
        <span class="container__headline-text">NATO leaders pledge new aid package at summit</span>
      </div>
    </a>
    <a href="/2026/06/15/us/pentagon-budget-analysis/index.html" class="container__link">
      <div class="container__headline">
        <span class="container__headline-text">Pentagon budget request draws bipartisan scrutiny</span>
      </div>
    </a>
    <!-- NOISE: video page (has /20 but not cnn.com/YYYY/MM/DD/section) -->
    <a href="/videos/2026/06/16/clip-defense-briefing.cnn" class="container__link">
      <span class="container__headline-text">Watch the briefing</span>
    </a>
    <!-- NOISE: dateless gallery link -->
    <a href="/interactive/politics/explainer/index.html" class="container__link">
      <span class="container__headline-text">An interactive explainer</span>
    </a>
    <!-- NOISE: dated link but tiny title -->
    <a href="/2026/06/16/world/short-one/index.html" class="container__link">
      <span class="container__headline-text">Hi</span>
    </a>
    <!-- NOISE: duplicate of the first article (must dedup) -->
    <a href="/2026/06/16/politics/senate-defense-bill-vote/index.html?utm=foo" class="container__link">
      <div class="container__headline">
        <span class="container__headline-text">Senate advances sweeping defense authorization bill</span>
      </div>
    </a>
  </section>
</body></html>
`;

// NPR: linkSelector 'h2.title a[href*="/20"]', title from anchor text,
// hrefPattern /npr.org/YYYY/MM/DD/
const NPR_FIXTURE = `
<!doctype html><html><body>
  <nav>
    <a href="/sections/world/">World</a>
    <a href="/sections/politics/">Politics</a>
  </nav>
  <div class="story-wrap">
    <h2 class="title">
      <a href="https://www.npr.org/2026/06/16/nx-s1-5400001/state-department-iran-talks">State Department signals progress in Iran nuclear talks</a>
    </h2>
    <h2 class="title">
      <a href="https://www.npr.org/2026/06/16/nx-s1-5400002/congress-military-spending">Congress weighs record military spending bill</a>
    </h2>
    <h2 class="title">
      <a href="/2026/06/15/nx-s1-5400003/nato-allies-ukraine">NATO allies debate next phase of Ukraine support</a>
    </h2>
    <!-- NOISE: non-title heading anchor -->
    <h3 class="rundown__title">
      <a href="https://www.npr.org/2026/06/16/nx-s1-5400099/rundown">Today's rundown</a>
    </h3>
    <!-- NOISE: title anchor but dateless (program/show landing) -->
    <h2 class="title">
      <a href="https://www.npr.org/programs/morning-edition/">Morning Edition</a>
    </h2>
    <!-- NOISE: duplicate of first (must dedup) -->
    <h2 class="title">
      <a href="https://www.npr.org/2026/06/16/nx-s1-5400001/state-department-iran-talks#comments">State Department signals progress in Iran nuclear talks</a>
    </h2>
  </div>
</body></html>
`;

// ---------------------------------------------------------------------------
// Adversary / state-media fixtures. Same structural concern as CNN/NPR: if any
// of these outlets redesign their section markup, the selector/pattern stops
// matching and they silently fall out of Curated. Several use URL shapes that
// carry NO parseable date (Global Times /page/YYYYMM/, China Daily /a/YYYYMM/DD/,
// People's Daily /nN/YYYY/MMDD/, teleSUR slug-only) — those set requiresUrlDate:
// false so the test does not assert a URL date the scraper never relies on.
// ---------------------------------------------------------------------------

// Global Times: linkSelector 'a[href*="/page/"]', hrefPattern
// /globaltimes.cn/page/YYYYMM/NNNN.shtml. Headline is the anchor text.
const GLOBAL_TIMES_FIXTURE = `
<!doctype html><html><body>
  <nav><a href="/china/">China</a><a href="/world/">World</a></nav>
  <div class="article_list">
    <a href="https://www.globaltimes.cn/page/202606/1364038.shtml">Chinese military showcases DF-17 hypersonic missile in drill</a>
    <a href="/page/202606/1364141.shtml">China proposes new rules to regulate Antarctic tourism</a>
    <a href="https://www.globaltimes.cn/page/202606/1364139.shtml">Iran agrees to invite IAEA inspectors back, official says</a>
    <!-- NOISE: /page/ link but not an article (no dated id + .shtml) -->
    <a href="/page/special/coverage.html">Special coverage hub</a>
    <!-- NOISE: dated article shape but tiny title -->
    <a href="/page/202606/1364200.shtml">Hi</a>
    <!-- NOISE: duplicate of the first article (query string) -->
    <a href="https://www.globaltimes.cn/page/202606/1364038.shtml?from=nav">Chinese military showcases DF-17 hypersonic missile in drill</a>
  </div>
</body></html>
`;

// China Daily: linkSelector 'a[href*="/a/20"]', hrefPattern
// /chinadaily.com.cn/a/YYYYMM/DD/WS<hex>.html. CRITICAL: hrefs are
// PROTOCOL-RELATIVE (//www.chinadaily.com.cn/a/...) — this exercises the
// parseSectionHtml `//` → https: fix (without it the host gets double-prefixed
// into a malformed URL).
const CHINA_DAILY_FIXTURE = `
<!doctype html><html><body>
  <nav><a href="//www.chinadaily.com.cn/world">World</a></nav>
  <div class="gy_box">
    <a href="//www.chinadaily.com.cn/a/202606/22/WS6a389440a310986e2b461179.html">Intra-Asian travel viewed as opportunity amid global tensions</a>
    <a href="//www.chinadaily.com.cn/a/202606/22/WS6a38b318a310986e2b46128c.html">Europe swelters as fierce heat wave grips the continent</a>
    <a href="/a/202606/22/WS6a38b04ba310986e2b461273.html">Wind turbine installed at record altitude in Xizang</a>
    <!-- NOISE: /a/20 prefix but a section index, not a WS article -->
    <a href="//www.chinadaily.com.cn/a/202606/22/index.html">World section index</a>
    <!-- NOISE: valid WS article but tiny title -->
    <a href="//www.chinadaily.com.cn/a/202606/22/WS6a38ad02a310986e2b461258.html">Hi</a>
  </div>
</body></html>
`;

// People's Daily: linkSelector 'a[href*="/20"]', hrefPattern
// /people.(cn|com.cn)/nN/YYYY/MMDD/c<digits>-<digits>.html. Anchor text headline.
const PEOPLES_DAILY_FIXTURE = `
<!doctype html><html><body>
  <nav><a href="/90777/index.html">World</a><a href="/90883/index.html">China</a></nav>
  <ul class="list_16">
    <li><a href="http://en.people.cn/n3/2026/0622/c90000-20469359.html">China urges calm as Middle East tensions escalate</a></li>
    <li><a href="http://en.people.cn/n3/2026/0622/c90000-20469354.html">Scholars call for return of relics looted during wartime</a></li>
    <li><a href="/n3/2026/0622/c90000-20469619.html">China hopes Lithuania will take steps to mend ties</a></li>
    <!-- NOISE: /20 in URL but a section list page, not an article -->
    <li><a href="http://en.people.cn/n3/2026/0622/list.html">More world news</a></li>
    <!-- NOISE: valid article shape but tiny title -->
    <li><a href="/n3/2026/0622/c90000-20469999.html">Hi</a></li>
  </ul>
</body></html>
`;

// CGTN: linkSelector 'a[href*="cgtn.com/news/"]', hrefPattern
// /cgtn.com/news/YYYY-MM-DD/slug-XXXX/p.html. Dated URL → requiresUrlDate stays
// true.
const CGTN_FIXTURE = `
<!doctype html><html><body>
  <nav><a href="https://www.cgtn.com/world">World</a></nav>
  <div class="cg-feed">
    <a href="https://news.cgtn.com/news/2026-06-22/Iran-US-talks-conclude-1OaWrEvA0Tu/p.html">Iran-US talks conclude as parties set 60-day roadmap</a>
    <a href="https://newseu.cgtn.com/news/2026-06-22/Europe-heat-wave-1Oa6Mo8UwFi/p.html">Record heat wave grips Europe as warnings widen</a>
    <a href="https://news.cgtn.com/news/2026-06-21/Dragon-Boat-Festival-1Ob9RdFtiNi/p.html">Dragon Boat Festival travel boom blends tradition and trend</a>
    <!-- NOISE: cgtn.com/news/ link but a section index, not a /p.html article -->
    <a href="https://news.cgtn.com/news/2026-06-22/world/index.html">World section</a>
    <!-- NOISE: valid article shape but tiny title -->
    <a href="https://news.cgtn.com/news/2026-06-22/x-1OshortAbc/p.html">Hi</a>
  </div>
</body></html>
`;

// teleSUR: linkSelector 'a[href]' (broad), hrefPattern matches a 4+-word
// hyphenated slug ending in '/'. URLs carry NO date → requiresUrlDate: false.
const TELESUR_FIXTURE = `
<!doctype html><html><body>
  <nav><a href="https://www.telesurenglish.net/news/">News</a></nav>
  <div class="td-block">
    <a href="https://www.telesurenglish.net/russia-condemns-ukrainian-drone-strikes-on-crimea/">Russia Condemns Ukrainian Drone Strikes on Crimea</a>
    <a href="/starmer-resigns-as-uk-pm-after-labour-pressure/">Starmer Resigns as UK PM After Labour Pressure</a>
    <a href="https://www.telesurenglish.net/iran-walks-out-of-switzerland-talks-after-new-threats/">Iran Walks Out of Switzerland Talks After New Threats</a>
    <!-- NOISE: 2-word slug (below the 4-word minimum) -->
    <a href="https://www.telesurenglish.net/live-blog/">Live blog</a>
    <!-- NOISE: external link (not telesurenglish.net) -->
    <a href="https://www.youtube.com/@telesurenglish">YouTube channel</a>
    <!-- NOISE: valid 5-word slug but tiny title -->
    <a href="https://www.telesurenglish.net/a-b-c-d-e/">Hi</a>
  </div>
</body></html>
`;

// KCNA (North Korea) — Task #634. linkSelector 'a[href*="/newstream/"]',
// hrefPattern matches /newstream/<id>-<id>/<slug>. URLs carry no date → same
// requiresUrlDate: false treatment as Global Times/China Daily/People's
// Daily/teleSUR. Mirrors the real kcnawatch.org homepage markup: article
// anchors wrap plain text, image-only anchors to the same URL are noise that
// must be deduped away (same "empty wrapper" shape as the CNN regression).
const KCNA_FIXTURE = `
<!doctype html><html><body>
  <nav><a href="https://kcnawatch.org/about-kcnawatch/">About</a></nav>
  <div class="stream">
    <a href="https://kcnawatch.org/newstream/1782903878-144079679/economic-growth-and-strategy-for-readjustment-and-reinforcement"><img src="/thumb1.jpg" alt=""></a>
    <a href="https://kcnawatch.org/newstream/1782903878-144079679/economic-growth-and-strategy-for-readjustment-and-reinforcement">Economic Growth and Strategy for Readjustment and Reinforcement</a>
    <a href="/newstream/1782903877-509710465/national-photo-exhibition-opens">National Photo Exhibition Opens</a>
    <a href="https://kcnawatch.org/newstream/1782903870-572918542/folk-customs-in-july">Folk Customs in July</a>
    <!-- NOISE: periodicals index link, not an article -->
    <a href="https://kcnawatch.org/periodicals/rodong-sinmun/">Rodong Sinmun</a>
    <!-- NOISE: newstream-shaped href but title too short -->
    <a href="https://kcnawatch.org/newstream/1782903999-111111111/hi">Hi</a>
  </div>
</body></html>
`;

interface SourceCase {
  src: CuratedWebSource;
  html: string;
  expectedCount: number;
  mustInclude: string[]; // substrings that must appear among extracted titles
  mustExclude: string[]; // substrings that must NOT appear among extracted titles
  // Some outlets use URL shapes with no parseable date (Global Times, China
  // Daily, People's Daily, teleSUR). Their recency is handled by section-page
  // freshness + curated store age-out, not a URL date, so skip the date assert.
  requiresUrlDate?: boolean;
}

const sourceCases: SourceCase[] = [
  {
    src: CNN_CURATED_SOURCE,
    html: CNN_FIXTURE,
    expectedCount: 3,
    mustInclude: [
      "Senate advances sweeping defense authorization bill",
      "NATO leaders pledge new aid package at summit",
      "Pentagon budget request draws bipartisan scrutiny",
    ],
    mustExclude: ["Watch the briefing", "interactive explainer", "Hi"],
  },
  {
    src: NPR_CURATED_SOURCE,
    html: NPR_FIXTURE,
    expectedCount: 3,
    mustInclude: [
      "State Department signals progress in Iran nuclear talks",
      "Congress weighs record military spending bill",
      "NATO allies debate next phase of Ukraine support",
    ],
    mustExclude: ["Today's rundown", "Morning Edition"],
  },
  {
    src: GLOBAL_TIMES_CURATED_SOURCE,
    html: GLOBAL_TIMES_FIXTURE,
    expectedCount: 3,
    mustInclude: [
      "Chinese military showcases DF-17 hypersonic missile in drill",
      "China proposes new rules to regulate Antarctic tourism",
      "Iran agrees to invite IAEA inspectors back, official says",
    ],
    mustExclude: ["Special coverage hub", "Hi"],
    requiresUrlDate: false,
  },
  {
    src: CHINA_DAILY_CURATED_SOURCE,
    html: CHINA_DAILY_FIXTURE,
    expectedCount: 3,
    mustInclude: [
      "Intra-Asian travel viewed as opportunity amid global tensions",
      "Europe swelters as fierce heat wave grips the continent",
      "Wind turbine installed at record altitude in Xizang",
    ],
    mustExclude: ["World section index", "Hi"],
    requiresUrlDate: false,
  },
  {
    src: PEOPLES_DAILY_CURATED_SOURCE,
    html: PEOPLES_DAILY_FIXTURE,
    expectedCount: 3,
    mustInclude: [
      "China urges calm as Middle East tensions escalate",
      "Scholars call for return of relics looted during wartime",
      "China hopes Lithuania will take steps to mend ties",
    ],
    mustExclude: ["More world news", "Hi"],
    requiresUrlDate: false,
  },
  {
    src: CGTN_CURATED_SOURCE,
    html: CGTN_FIXTURE,
    expectedCount: 3,
    mustInclude: [
      "Iran-US talks conclude as parties set 60-day roadmap",
      "Record heat wave grips Europe as warnings widen",
      "Dragon Boat Festival travel boom blends tradition and trend",
    ],
    mustExclude: ["World section", "Hi"],
  },
  {
    src: TELESUR_CURATED_SOURCE,
    html: TELESUR_FIXTURE,
    expectedCount: 3,
    mustInclude: [
      "Russia Condemns Ukrainian Drone Strikes on Crimea",
      "Starmer Resigns as UK PM After Labour Pressure",
      "Iran Walks Out of Switzerland Talks After New Threats",
    ],
    mustExclude: ["Live blog", "YouTube channel", "News"],
    requiresUrlDate: false,
  },
  {
    src: KCNA_CURATED_SOURCE,
    html: KCNA_FIXTURE,
    expectedCount: 3,
    mustInclude: [
      "Economic Growth and Strategy for Readjustment and Reinforcement",
      "National Photo Exhibition Opens",
      "Folk Customs in July",
    ],
    mustExclude: ["Rodong Sinmun", "Hi"],
    requiresUrlDate: false,
  },
];

let failures = 0;
function check(ok: boolean, label: string, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} [${label}]`);
  if (!ok && detail) console.log(`     ${detail}`);
}

for (const { src, html, expectedCount, mustInclude, mustExclude, requiresUrlDate = true } of sourceCases) {
  const articles = parseSectionHtml(src, html);
  const titles = articles.map((a) => a.title);

  console.log(`\n=== ${src.sourceName} (${src.logTag}) ===`);
  for (const a of articles) console.log(`  - ${a.title} :: ${a.url}`);

  // 1) Non-zero extraction — the core "did the selectors still match" guard.
  check(
    articles.length > 0,
    `${src.sourceName}: extracts a non-zero set of articles`,
    `got ${articles.length} — linkSelector/hrefPattern/titleSelector likely broke`,
  );

  // 2) Exact expected count (noise filtered, duplicates deduped).
  check(
    articles.length === expectedCount,
    `${src.sourceName}: extracts exactly ${expectedCount} clean articles`,
    `got ${articles.length}: ${JSON.stringify(titles)}`,
  );

  // 3) Every expected real headline present.
  for (const want of mustInclude) {
    check(
      titles.some((t) => t.includes(want)),
      `${src.sourceName}: includes "${want}"`,
      `extracted: ${JSON.stringify(titles)}`,
    );
  }

  // 4) Noise excluded (titleSelector / hrefPattern / min-length working).
  for (const bad of mustExclude) {
    check(
      !titles.some((t) => t.includes(bad)),
      `${src.sourceName}: excludes noise "${bad}"`,
      `extracted: ${JSON.stringify(titles)}`,
    );
  }

  // 5) Every URL matches the source hrefPattern, is well-formed (no double host
  // from a botched protocol-relative absolutize), and — for dated-URL sources —
  // carries a parseable date.
  for (const a of articles) {
    check(
      src.hrefPattern.test(a.url),
      `${src.sourceName}: URL matches hrefPattern`,
      `offending url: ${a.url}`,
    );
    // Guards the parseSectionHtml protocol-relative `//` fix: a double-prefixed
    // host (`https://host//host/path`) leaves a `//` in the path right after the
    // host, which this catches even though hrefPattern still substring-matches.
    check(
      !/^https?:\/\/[^/]+\/\//.test(a.url),
      `${src.sourceName}: URL is well-formed (no double host / stray //)`,
      `offending url: ${a.url}`,
    );
    if (requiresUrlDate) {
      check(
        extractDateFromUrl(a.url) !== null,
        `${src.sourceName}: URL has a parseable YYYY/MM/DD date`,
        `offending url: ${a.url}`,
      );
    }
  }

  // 6) Titles are sensible (trimmed, length-bounded).
  for (const t of titles) {
    check(
      t.length >= 10 && t.length <= 203 && t === t.trim(),
      `${src.sourceName}: title is sensible`,
      `offending title: "${t}"`,
    );
  }

  // 7) No duplicate URLs survived.
  const urls = articles.map((a) => a.url);
  check(
    new Set(urls).size === urls.length,
    `${src.sourceName}: no duplicate URLs`,
    `urls: ${JSON.stringify(urls)}`,
  );
}

// ---------------------------------------------------------------------------
// Regression (Task #321 fix): a CNN/NPR card commonly renders the SAME article
// URL twice on a section page — first as an empty image-wrapper <a> (no headline
// text), then as the real headline <a>. The parser must NOT let the empty
// wrapper poison the dedup set and silently drop the real headline.
// ---------------------------------------------------------------------------
const CNN_DUP_WRAPPER_FIXTURE = `
<!doctype html><html><body>
  <section class="container">
    <a href="/2026/06/16/world/carrier-strike-group-deploys/index.html" class="container__link">
      <img src="/img/thumb.jpg" alt="" />
    </a>
    <a href="/2026/06/16/world/carrier-strike-group-deploys/index.html" class="container__link">
      <div class="container__headline">
        <span class="container__headline-text">Carrier strike group deploys to eastern Mediterranean</span>
      </div>
    </a>
  </section>
</body></html>
`;

console.log(`\n=== CNN empty-wrapper poisoning regression ===`);
const dupArticles = parseSectionHtml(CNN_CURATED_SOURCE, CNN_DUP_WRAPPER_FIXTURE);
for (const a of dupArticles) console.log(`  - ${a.title} :: ${a.url}`);
check(
  dupArticles.length === 1,
  `CNN: empty wrapper <a> before the headline <a> does not drop the real headline`,
  `got ${dupArticles.length}: ${JSON.stringify(dupArticles.map((a) => a.title))}`,
);
check(
  dupArticles.some((a) =>
    a.title.includes("Carrier strike group deploys to eastern Mediterranean"),
  ),
  `CNN: extracts the real headline despite a leading empty wrapper to the same URL`,
  `extracted: ${JSON.stringify(dupArticles.map((a) => a.title))}`,
);

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) {
  console.error(`curated-web-scraper test FAILED: ${failures} check(s) did not match`);
  process.exit(1);
}
