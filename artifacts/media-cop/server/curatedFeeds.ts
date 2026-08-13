// =============================================================================
// Curated lane (Task #89) — WIDER-APERTURE feed list for the SEPARATE curated
// store. These sources deliberately go BEYOND the main feed's curated set:
// adversary state media, international/mainstream B-list, and opinion outlets.
//
// IMPORTANT: the lane TIER (contributing vs attach-only) is NOT defined here.
// It is resolved at ingest time from the Outlet Registry via findOutlet(), so
// `sourceName` below MUST match a registry canonical name / alias / domain.
// Unknown sources resolve to attach-only (fail-closed). This keeps the registry
// the single source of truth for trust and avoids a second, drifting list.
// =============================================================================

export interface CuratedFeedConfig {
  // Canonical outlet name — MUST match an Outlet Registry canonicalName/alias so
  // findOutlet() can resolve the lane role. Used as the stored `source`.
  sourceName: string;
  url: string;
}

// Curated sources whose feed publishes headlines in a NON-English language, so
// the curated lane translates their titles to English at ingest (Task #656).
//
// WHY: the State-Controlled Narratives lens (and every other curated headline
// surface) renders each item's RAW stored title — there is no per-item English
// headline synthesis for standalone/attach-only rows. Prensa Latina's only
// FRESH Cuba path is the Spanish `www.prensa-latina.cu/feed/` (the English desk
// at plenglish.com went stale), so without translation Cuba headlines would
// display in Spanish. Translating at ingest also lets these adversary items
// cluster/attach against the English trusted stories they contrast — the whole
// point of an attach-only contrast source. Keyed by the canonical `source`
// (== CuratedFeedConfig.sourceName / stored curated_items.source). Curated-lane
// only; the main/Classic/Visual/public feeds are untouched.
export const CURATED_TITLE_TRANSLATE_SOURCES = new Set<string>(['Prensa Latina']);

// Adversary / state-controlled media (registry role: attach-only). Valuable as
// NARRATIVE signal — how adversaries frame events — but may only ATTACH to a
// trusted story downstream, never seed one.
const ADVERSARY_FEEDS: CuratedFeedConfig[] = [
  { sourceName: "RT", url: "https://www.rt.com/rss/news/" },
  { sourceName: "Sputnik", url: "https://sputnikglobe.com/export/rss2/archive/index.xml" },
  { sourceName: "TASS", url: "https://tass.com/rss/v2.xml" },
  // Press TV — switched from the .ir feed to the .co.uk mirror 2026-07-23 after
  // a live re-probe: www.presstv.ir/rss.xml has been consistently unreachable
  // from this infrastructure (connection failures → circuit-breaker trips, Iran
  // state-media intake silent), while www.presstv.co.uk/rss.xml serves the SAME
  // feed (same outlet identity/domain family in the Outlet Registry) with HTTP
  // 200, fast, and same-day items. Same lesson as Prensa Latina below: always
  // re-verify freshness AND reachability live before trusting an old URL.
  { sourceName: "Press TV", url: "https://www.presstv.co.uk/rss.xml" },
  // Prensa Latina (Cuba) — the ONLY Cuba state-media intake for the
  // State-Controlled Narratives lens, so it must never be dropped without a
  // working replacement (teleSUR is VENEZUELA in the Outlet Registry, not a Cuba
  // stand-in). Switched from the English desk (plenglish.com/feed/) to the
  // Spanish .cu feed 2026-07-05 after a live re-probe:
  //   - plenglish.com/feed/  — HTTP 200 but SLOW (~12s, right at the 15s fetch
  //       timeout, so under production concurrency it intermittently times out →
  //       "fetch failed" → the circuit breaker shut it off, giving Cuba zero
  //       intake for a day) AND STALE (newest item ~9 days old). Its category
  //       pages 301-redirect to 2021 articles and the homepage carries no fresh
  //       2026 links — the English desk is effectively dormant now.
  //   - www.prensa-latina.cu/feed/ — HTTP 200, FAST (~0.1s) and FRESH (same-day
  //       items). Valid WordPress RSS (Spanish). prensa-latina.cu is already a
  //       registered domain for this outlet, so item links resolve to the same
  //       "Prensa Latina" identity and its trust tier is unchanged
  //       (news-cpc → attach-only / contrast, curated-lane only).
  // Lesson: always re-verify a source's freshness AND latency live before
  // trusting an old comment, especially when it's the sole intake path for a
  // country bucket. Do NOT re-add the English plenglish.com/feed/ here — it is
  // both slow and stale.
  { sourceName: "Prensa Latina", url: "https://www.prensa-latina.cu/feed/" },
  // NOTE — Global Times, China Daily, People's Daily and CGTN were MOVED OFF RSS
  // (probed live 2026-06-22) and now ingest via the curated-only WEBSITE scraper
  // (server/curatedWebScraper.ts). The four Chinese state outlets' RSS endpoints
  // still return 200 but only WEEKS-old items (Global Times /rss/outbrain.xml,
  // China Daily world_rss.xml, People's Daily World.xml, CGTN section RSS), while
  // their section pages carry same-day headlines. All still resolve to news-cpc
  // in the registry (contrast / attach-only) exactly as before — only the
  // transport changed. Do NOT re-add their RSS here (it would only re-introduce
  // stale rows). teleSUR also ingests via the WEBSITE scraper (it resolves to
  // Venezuela in the registry, not Cuba — kept for its own Venezuela coverage,
  // not as a Cuba substitute). RT / Sputnik / TASS / Press TV / Prensa Latina
  // keep working RSS and stay above.
  //
  // NOTE — these adversary/state-media feeds were REMOVED earlier (probed
  // 2026-06-18, verified not transient). Each has NO working public RSS reachable
  // from this infra and no live alternate path/host/mirror. Do not blindly re-add:
  //   - Tehran Times (www.tehrantimes.com/rss)        — DNS resolves but TCP
  //       connection times out (~20s, curl code 000). Host-level block from our
  //       egress; any path on this host times out (Iranian-outlet reachability
  //       via proxy/VPN is out of scope).
  //   - Mehr News Agency (en.mehrnews.com/rss)        — same: resolves, TCP
  //       connection times out. Host-level block from our egress.
  //   - Tasnim News Agency (tasnimnews.com .../feed/) — DNS does not resolve
  //       (ENOTFOUND).
  //   - China Military Online (eng.chinamil.com.cn/rss/index.xml) — HTTP 404
  //       (retired path). Alternates /rss/news.xml, /rss/china.xml,
  //       english.chinamil.com.cn, www.chinamil.com.cn all 404 / 301 / dead.
  //   - KCNA (kcnawatch.org/feed/)                    — feed 302-redirects to an
  //       HTML member-signup popup (?popup=free-member-form), so the parser gets
  //       HTML and throws. /feed, /rss/ same redirect; www.kcna.kp times out.
  //   - teleSUR RSS (telesurenglish.net)              — old /rss/RssAllContent.xml
  //       is dead (404/413) and the WordPress /feed/ returns an anti-bot HTTP 413
  //       on most Node-fetch requests; teleSUR now ingests via the WEBSITE scraper
  //       above instead (homepage HTML, not RSS).
  // Press TV (above) remains the only reachable Iranian state outlet and keeps
  // ingesting normally.
];

// International / mainstream B-list (registry role: mostly contributing). Widens
// the aperture beyond the main feed's core sources so foreign-desk coverage can
// help FORM stories.
const INTERNATIONAL_FEEDS: CuratedFeedConfig[] = [
  { sourceName: "Le Monde", url: "https://www.lemonde.fr/en/rss/une.xml" },
  // Der Spiegel — LOW-YIELD BY DESIGN; its "silent source" flag on the Coverage
  // tab is EXPECTED and understood, not a broken feed. Kept on the English
  // INTERNATIONAL desk (the only English-language Spiegel feed). Re-probed live
  // 2026-07-26 (Task #1115): index.rss is reachable (HTTP 200) and parses fine,
  // but the English desk is effectively DORMANT — newest item 17 days old, so
  // every fetch delivers 20/20 aged-out past the 48h curated window (the
  // fetchCuratedFeeds instrumentation logs items>0 aged-out=all, distinguishing
  // this from a 0-item/broken fetch). ALL English variants are equally stale
  // (/international/world 17d, /europe ~7wk, /germany 18d, /business ~6wk) — no
  // fresher English path exists. The German Schlagzeilen feed IS fresh
  // (same-day), and ingest-time title translation exists
  // (CURATED_TITLE_TRANSLATE_SOURCES), but that path is deliberately NOT taken:
  // the Prensa Latina precedent reserves translation for a country bucket's
  // ONLY intake, while German/European perspective is already carried by the
  // FRESH Deutsche Welle + France 24 + Le Monde feeds below — a full German
  // firehose would add per-item translation cost for redundant coverage. Kept
  // configured (one cheap fetch/pass) so the occasional English long-form piece
  // still lands when the desk wakes up; expect items only intermittently.
  { sourceName: "Der Spiegel", url: "https://www.spiegel.de/international/index.rss" },
  { sourceName: "France 24", url: "https://www.france24.com/en/rss" },
  { sourceName: "Deutsche Welle", url: "https://rss.dw.com/rdf/rss-en-all" },
  { sourceName: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { sourceName: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { sourceName: "The Diplomat", url: "https://thediplomat.com/feed/" },
  { sourceName: "Foreign Policy", url: "https://foreignpolicy.com/feed/" },
  // NOTE — Arab News (www.arabnews.com/rss.xml) REMOVED (probed live 2026-06-23,
  // verified not transient). Cloudflare now serves an HTTP 403 to this datacenter
  // egress on BOTH the RSS endpoint AND the website (homepage and /middleeast),
  // even over Node fetch with a full browser User-Agent — so neither an RSS pipe
  // nor a curated website-scraper can reach it from here. No reachable alternate
  // host/path. Removing it (vs. leaving it configured) also stops the Source
  // Oversight → Coverage tab from falsely flagging it as a "silent source" every
  // pass. Do not blindly re-add — re-probe RSS + website first. (Arab News had
  // recovered from a 403 once before via a browser UA; that path no longer works.)
  // Group 2 expansion (Task #231) — international/regional desks, curated-lane
  // only (never the main feed / Classic / Visual / custom-MCOP / public API).
  { sourceName: "Taipei Times", url: "https://www.taipeitimes.com/xml/index.rss" },
  // The Hindu — use the INTERNATIONAL (world) desk, not national. The national
  // feeder (news/national/feeder/default.rss) is reachable + fresh but carries
  // India-domestic stories that the wide-aperture curated gate almost always
  // rejects, so The Hindu read as a "silent source" (0 admitted). The world desk
  // carries foreign-affairs / conflict coverage that actually clears the gate.
  { sourceName: "The Hindu", url: "https://www.thehindu.com/news/international/feeder/default.rss" },
  { sourceName: "Kyiv Post", url: "https://www.kyivpost.com/feed" },
  { sourceName: "The Japan Times", url: "https://www.japantimes.co.jp/feed/" },
  // ABC News (Australia) — switched from feed 51120 ("Just In", the raw
  // chronological firehose) to feed 1534 (the flagship "ABC News" feed). Probed
  // live 2026-06-23: BOTH are reachable (HTTP 200) and FRESH (newest items same
  // day), but 51120's mix is almost entirely Australia-DOMESTIC (state politics,
  // crime, local human-interest) which the wide-aperture-but-defense curated gate
  // rejects — so ABC read "silent" not because the URL is stale/broken but because
  // its content rarely clears the gate. Feed 1534 carries a higher share of
  // international / strategic stories (UK PM transition, foreign affairs) so more
  // items clear the gate. ABC has NO reachable dedicated world-desk feed (the
  // /feed/52278/ world id 404s; 45910 "Top Stories" is equally domestic-heavy),
  // so 1534 is the best reachable option. Still resolves to the same registry
  // canonical ("ABC News (Australia)") — only the feed id changed.
  { sourceName: "ABC News (Australia)", url: "https://www.abc.net.au/news/feed/1534/rss.xml" },
  // Task #425 expansion — registered, trusted (role: contributing) regional desks
  // that the Source Oversight reconciliation flagged as SILENT (registered but
  // delivering zero curated rows) because they had no configured feed entry. Each
  // URL below was probed live 2026-06-24 from this infra: HTTP 200 + FRESH
  // (same-day items) over the browser-UA fetch the curated lane already uses
  // (fetchWithResilience in curatedIngest.ts). Curated-lane only; sourceName
  // matches the Outlet Registry canonical so the lane role resolves.
  { sourceName: "Ynetnews", url: "https://www.ynetnews.com/Integration/StoryRss3082.xml" },
  // NOTE (Task #661, re-diagnosed 2026-07-05) — Ynetnews reads SILENT not from a
  // stale/broken URL but because its English hard-news feed is FROZEN at the
  // Cloudflare edge: StoryRss3082 (News) and StoryRss3089 (Breaking News) BOTH
  // return `cf-cache-status: HIT` with `max-age=604800` (7-day edge cache), so
  // this infra's egress is served a multi-day-old snapshot that the 48h curated
  // recency gate then drops. Ynet's only FRESH feeds (Opinion/Business/Culture/
  // Travel/Environment) are soft, non-defense sections the gate rejects; the site
  // itself is Wix/JS-rendered (static HTML carries only chrome), and Bing does not
  // index ynetnews.com — so there is NO reachable fresh hard-news path from this
  // datacenter. Kept configured: the edge cache rolls over intermittently and
  // delivers a fresh burst when it does, so this is best-effort, not dead.
  // Task #664 — durable fresh Israeli coverage is now supplied by The Jerusalem
  // Post's direct front-page RSS (below), which the Bing off-host route could not
  // provide for Ynet (Bing indexes 0 ynetnews.com items). Probed live 2026-07-06
  // from this infra: HTTP 200 + FRESH (52 same-day items incl. Gaza/Iran/IDF
  // defense stories) over the browser-UA fetch the curated lane already uses. The
  // sourceName matches the Outlet Registry canonical ("The Jerusalem Post",
  // domain jpost.com) so the contributing lane role resolves; curated-lane only.
  { sourceName: "The Jerusalem Post", url: "https://www.jpost.com/rss/rssfeedsfrontpage.aspx" },
  { sourceName: "The National", url: "https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml" },
  { sourceName: "The Straits Times", url: "https://www.straitstimes.com/news/world/rss.xml" },
  // Task #661 — registered, trusted regional desks re-sourced 2026-07-05 with a
  // direct RSS pipe (previously reached curated only via the reject path or not at
  // all). Both probed live from this infra: HTTP 200 + FRESH (same-day items, incl.
  // NATO rearmament / Ukraine / Macron-Syria) over the browser-UA fetch the curated
  // lane uses. sourceName matches the Outlet Registry canonical ("El País" incl.
  // accent, "Al-Monitor") so the lane role resolves; curated-lane only.
  { sourceName: "El País", url: "https://feeds.elpais.com/mrss-s/pages/ep/site/english.elpais.com/portada" },
  // Al-Monitor — probed live 2026-07-15: HTTP 200 + FRESH (same-day items).
  // OUTCOME (corrected-and-restored, Task #950): feed delivers ~20 items/pass;
  // ~11 are wire-story dups already seen from Al Jazeera/Guardian in the same
  // pass (dup-in-pass=11), leaving ~9 unique articles that reach the AI gate.
  // Content is Middle East policy (Iran nuclear program, Israel-Gaza, Gulf states
  // diplomacy, Turkey-Syria) — all clearly in-scope for the WIDE-APERTURE curated
  // gate. Expected admission: 4-7 rows/pass. Pre-Task-#950 silence was a telemetry
  // blind spot (table wiped each restart), not a gate failure — the per-source
  // admission telemetry (curated_intake_telemetry) now confirms actual ingestion.
  { sourceName: "Al-Monitor", url: "https://www.al-monitor.com/rss" },
  // NOTE — Gulf News (gulfnews.com/stories.rss) TRIALED then REMOVED 2026-06-24 on
  // a reward-per-cost review. The feed works (HTTP 200), but it is REDUNDANT with
  // The National (same UAE/Gulf beat, already kept above) and is a general
  // all-sections feed (UAE local / business / lifestyle), so most items are
  // rejected by the curated gate as soft/local noise — little marginal Gulf-
  // security coverage for the candidate/soft-cap cycles it consumes. The National
  // carries the Gulf beat. Do not re-add without a distinct, defense-dense feed.
  // NOTE — Israeli/Arab regional outlets OMITTED (probed live 2026-06-24, verified
  // not transient). No working public feed reachable from this datacenter egress,
  // and no scrapeable alternate, so they stay intentionally silent. Do not blindly
  // re-add — re-probe first:
  //   - Haaretz (www.haaretz.com/cmlink/1.628752) — RSS path HTTP 301-redirects to
  //       the bare homepage (public RSS discontinued); Haaretz is also hard-
  //       paywalled, so even a scraped section page yields only teaser stubs.
  //   - Israel Hayom (www.israelhayom.com/feed/) — HTTP 403 "Access Denied" edge
  //       block to this datacenter egress (Akamai-style reference id), on the feed
  //       AND the site.
  //   - Al Arabiya (english.alarabiya.net/feed/rss2/en.xml) — HTTP 403 Cloudflare
  //       managed challenge (the same block already documented for Arab News);
  //       stays 403 over a full browser UA.
  //   - The Jordan Times (jordantimes.com/rss.xml) — HTTP 403 Cloudflare challenge
  //       to this egress (www. variant 301s into the same blocked host).
  //   - The Daily Star / Lebanon (dailystar.com.lb) — HTTP 403 Cloudflare
  //       challenge; the outlet also ceased regular publication years ago, so even
  //       if reachable it carries no current news.
  // NOTE — Times of Israel (www.timesofisrael.com/feed/) REMOVED (probed
  // 2026-06-18/19, verified not transient). Cloudflare serves a managed
  // challenge (HTTP 403, `cf-mitigated: challenge`) to this datacenter egress;
  // it stays 403 even over Node fetch with a full browser User-Agent (the same
  // path that recovered Arab News), and the only feed host is the CF-fronted
  // /feed/. No reachable alternate. Do not blindly re-add.
  //
  // Expansion (2026-08-13) — seven English-language desks added as easy-win
  // curated-only intake at operator request. ALL probed live from this infra
  // same day: HTTP 200 + same-day items over the browser-UA fetch the curated
  // lane uses. Each sourceName matches an Outlet Registry canonical (seeded in
  // server/outletRegistrySeed.ts) so the contributing lane role resolves.
  // Reuters and CNN were REQUESTED but NOT added: Reuters retired public RSS
  // (401/HTML from this egress) and CNN's legacy feed serves recycled 2023
  // items — both already documented in server/rssFeeds.ts. Do not re-add
  // without a fresh live probe. LA Times / Euronews carry a heavy domestic /
  // general-news mix, so expect the relevance gate to screen most items —
  // low admission there is gate behavior, not a broken feed.
  { sourceName: "The Independent", url: "https://www.independent.co.uk/news/world/rss" },
  { sourceName: "Los Angeles Times", url: "https://www.latimes.com/world-nation/rss2.0.xml" },
  { sourceName: "United Press International", url: "https://rss.upi.com/news/tn_int.rss" },
  { sourceName: "Euronews", url: "https://www.euronews.com/rss" },
  { sourceName: "Sky News", url: "https://feeds.skynews.com/feeds/rss/world.xml" },
  // ANSA — the operator-supplied link (www.ansa.it/english/) is the HTML
  // homepage; the working English RSS endpoint below was located by probe.
  { sourceName: "ANSA", url: "https://www.ansa.it/english/english_rss.xml" },
  { sourceName: "CBC News", url: "https://www.cbc.ca/webfeed/rss/rss-world" },
];

// Opinion / partisan B-list (registry role: attach-only). Admissible to the lane
// but, like adversary media, may only attach to a trusted story.
const OPINION_FEEDS: CuratedFeedConfig[] = [
  { sourceName: "The Blaze", url: "https://www.theblaze.com/feeds/feed.rss" },
  { sourceName: "The Daily Wire", url: "https://www.dailywire.com/feeds/rss.xml" },
  { sourceName: "Breitbart", url: "https://feeds.feedburner.com/breitbart" },
  { sourceName: "The Gateway Pundit", url: "https://www.thegatewaypundit.com/feed/" },
  // HuffPost (Task #662) — curated-only by design, no main-feed/RSS-roster
  // presence. Live-probed 2026-07-05: the outlet's generic /section/front-page/feed
  // returns 200 but an EMPTY channel (no <item>s); /section/politics/feed returns
  // 200 with a full, fresh item list (newest pubDate same-day). Using that feed.
  // OUTCOME (corrected-and-restored, Task #950): probed live 2026-07-15, kept=25
  // (aged-out=0) — confirmed fresh and contributing.
  { sourceName: "HuffPost", url: "https://www.huffpost.com/section/politics/feed" },
];

// Magazine / Periodical (registry role: attach-only). Curated-only by design —
// never on the main-feed / RSS roster. Articles can attach to already-formed
// curated Top Stories as additional coverage but never anchor, form, or stand
// alone as headlines, and never inform corroborated facts (trust-engine rule).
const MAGAZINE_FEEDS: CuratedFeedConfig[] = [
  // The Atlantic — REMOVED 2026-07-15. Probed 2026-07-14: HTTP 200 (brief window),
  // but as of 2026-07-15 https://www.theatlantic.com/feed/all/ returns HTTP 403
  // from this datacenter egress (Cloudflare/edge block). No reachable alternate
  // feed path. Do not re-add without re-probing from this infra first.
];

// US mainstream (registry role: contributing). Trusted US outlets that are NOT
// yet on the main feed (server/rssFeeds.ts) and are being proven out in the
// curated lane first. Axios (Task #151) is curated-only by design — it only
// flows into the isolated curated store, never the main feed / Classic / Visual
// / custom-MCOP / public API.
const US_MAINSTREAM_FEEDS: CuratedFeedConfig[] = [
  { sourceName: "Axios", url: "https://api.axios.com/feed/" },
];

// Authoritative US/Western wires + national/beltway desks (Task #309). These
// trusted wires (all registry role: contributing) previously reached the curated
// store ONLY via the main CJCS reject path (server/rssFeedBot.ts) — i.e. curated
// only ever saw their LEAST CJCS-relevant stories. Giving them a direct,
// recurring pipe lets domestic US defense/policy events corroborate and FORM
// curated Top Stories. These outlets are ALSO on the main RSS roster
// (server/rssFeeds.ts); the same article therefore exists as both a main:<id>
// and a curated:<id> node, but the curated clustering pass dedups those by URL,
// and admitCuratedCandidates dedups by URL on intake — so there is no
// double-count or self-clustering. Curated-lane only: writes solely to
// curated_items / curated_classifications, never the main feed / Classic /
// Visual / custom-MCOP / public API.
//
// Every URL below was probed live (DNS + HTTP + freshness) before inclusion.
// NOTE — flagship wires deliberately OMITTED because they have NO working public
// RSS reachable from this infra (verified, not transient). Do not blindly re-add:
//   - AP News  (feeds.apnews.com)        — DNS does not resolve (host retired)
//   - Reuters  (feeds.reuters.com)       — DNS does not resolve (RSS discontinued)
//   - NPR      (feeds.npr.org)           — HTTP 403, blocks datacenter egress
//   - USA Today(rssfeeds.usatoday.com)   — RSS retired; now 301s to the HTML homepage
//       (Task #661 re-sources USA Today OFF-HOST via Bing News RSS — see
//        server/curatedOffHostBot.ts — with the query scoped to defense/security.)
//   - CNN      (rss.cnn.com)             — feed frozen for years (CNN abandoned RSS)
//   - AFP      (afp.com/en/rss.xml)      — feed frozen for years (no live article feed)
// Those outlets still reach curated via the existing main scrapers' reject path
// (e.g. server/apNewsBot.ts scrapes apnews.com directly), so they are not lost —
// they simply cannot get a *direct* generous-gate RSS pipe without a live feed.
const US_WIRE_FEEDS: CuratedFeedConfig[] = [
  // Bloomberg — RSS feed (feeds.bloomberg.com/politics/news.rss) returns HTTP 404
  // from this infrastructure. Task #950 re-sources Bloomberg OFF-HOST via Bing News
  // RSS — see server/curatedOffHostBot.ts (BLOOMBERG_OFFHOST_SOURCE) — with the
  // query scoped to defense/security/geopolitics so the curated gate admission is
  // dense rather than triggering on sports/entertainment. Bloomberg continues to
  // reach curated via the off-host bot; it is no longer a direct RSS feed here.
  { sourceName: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { sourceName: "New York Times", url: "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml" },
  { sourceName: "Washington Post", url: "https://feeds.washingtonpost.com/rss/politics" },
  { sourceName: "Washington Post", url: "https://feeds.washingtonpost.com/rss/national" },
  // Politico — TWO feeds, so Politico is NOT a silent source: silent detection is
  // per-CANONICAL-outlet (routes.ts coverage endpoint), and politics-news.xml is
  // FRESH (probed live 2026-06-23, newest item same/prior day). defense.xml is the
  // most on-topic Politico feed and is reachable (HTTP 200) but LOWER-CADENCE
  // (newest ~6 days at probe), so within the 48h window it often admits 0 on its
  // own — that's expected, not a stale/broken URL, and it never flags Politico
  // silent because politics-news.xml carries the outlet. Kept both as-is.
  { sourceName: "Politico", url: "https://rss.politico.com/defense.xml" },
  { sourceName: "Politico", url: "https://rss.politico.com/politics-news.xml" },
  { sourceName: "The Hill", url: "https://thehill.com/policy/defense/feed/" },
  { sourceName: "NBC News", url: "https://feeds.nbcnews.com/nbcnews/public/world" },
  { sourceName: "CBS News", url: "https://www.cbsnews.com/latest/rss/world" },
  { sourceName: "ABC News", url: "https://feeds.abcnews.com/abcnews/internationalheadlines" },
  { sourceName: "CNBC", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114" },
  // NewsNation — probed live 2026-07-15: HTTP 200 + FRESH (kept=17, aged-out=0).
  // OUTCOME (corrected-and-restored, Task #950): confirmed contributing.
  { sourceName: "NewsNation", url: "https://www.newsnationnow.com/feed/" },
  // Yonhap — probed live 2026-07-15: HTTP 200 + FRESH (kept=25, aged-out=0 in
  // latest pass). OUTCOME (corrected-and-restored, Task #950): confirmed fresh and
  // contributing. Note: boot-time parallel-pool fetch may intermittently see a stale
  // snapshot (items ordered oldest-first in that epoch), but the next cron pass
  // always returns fresh content — not a persistent stale/broken feed.
  { sourceName: "Yonhap", url: "https://en.yna.co.kr/RSS/news.xml" },
];

// US defense / military trade + analysis press (Task #309). All registry role:
// contributing (very-high factuality, news-us-domestic). Same direct-pipe
// rationale + dual-intake/URL-dedup safety as US_WIRE_FEEDS above. These carry
// the strongest domestic defense-industrial / acquisition / policy coverage that
// rarely surfaced in curated when limited to the reject path. URLs probed live.
// NOTE — Stars and Stripes publishes no working RSS (all RSS paths 404), and a
// bespoke curated-only WEBSITE scraper was TRIALED then REMOVED 2026-06-24 on a
// reward-per-cost review (a hand-written site scraper silently breaks on a
// redesign). Task #661 re-sources it a THIRD, more durable way: OFF-HOST Bing
// News RSS discovery (server/curatedOffHostBot.ts) — Bing indexes stripes.com and
// exposes the REAL article URL in its `url=` param, so there is no bespoke DOM to
// maintain and no direct edge block to trip. Still curated-lane only. Do NOT add
// a Stars and Stripes RSS entry here (none works).
const DEFENSE_TRADE_FEEDS: CuratedFeedConfig[] = [
  // Breaking Defense's own /feed/ intermittently 403s from the prod egress
  // (Cloudflare); Task #661 adds a RESILIENT off-host supplement via Bing News RSS
  // (server/curatedOffHostBot.ts) that dedups by URL against this entry, so keep
  // this direct feed AND the off-host bot — whichever is reachable delivers.
  { sourceName: "Breaking Defense", url: "https://breakingdefense.com/feed/" },
  { sourceName: "Defense One", url: "https://www.defenseone.com/rss/all/" },
  { sourceName: "Defense News", url: "https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml" },
  { sourceName: "Military Times", url: "https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml" },
  // The War Zone rebranded off TheDrive to its own domain; pin the canonical
  // twz.com feed (Task #661, probed live 2026-07-05: HTTP 200 + FRESH) to avoid
  // relying on the thedrive.com/the-war-zone → twz.com redirect hop.
  { sourceName: "The War Zone", url: "https://www.twz.com/feed" },
  { sourceName: "War on the Rocks", url: "https://warontherocks.com/feed/" },
  // Task #425 — registered trusted defense outlets flagged SILENT (no configured
  // feed). Both probed live 2026-06-24: HTTP 200 + FRESH over the browser-UA
  // fetch. Military.com's /feed/ is its main news feed (the bare /rss/news,
  // /rss-feeds/headlines paths 404; /feed 301s to /feed/). Inside Defense's
  // /rss.xml exposes headline + date for its (otherwise paywalled) defense-
  // acquisition coverage — enough for the curated lane, which clusters on titles.
  { sourceName: "Military.com", url: "https://www.military.com/feed/" },
  { sourceName: "Inside Defense", url: "https://insidedefense.com/rss.xml" },
];

// Think tanks — NO think-tank feed is configured in the curated lane (decision
// 2026-06-24, reward-per-cost review). They are documented-omitted, not broken:
//   - RAND (www.rand.org/news/press.xml) — feed WORKS (Atom, News Releases desk),
//       but was TRIALED then REMOVED 2026-06-24: low cadence + press-release /
//       analysis content that rarely clears the wide-aperture-but-defense curated
//       gate (often gated as non-news), so it added little for the cycles it cost.
//   - CSIS (www.csis.org/rss.xml) — HTTP 200 but FROZEN: newest item is from 2016
//       (abandoned). Every other guessed path (/analysis/feed, /analysis.xml,
//       /analysis/rss.xml, /podcasts/feed) 404s, so a feed only re-introduces
//       years-old rows.
//   - Brookings (www.brookings.edu/feed/) — public RSS discontinued: /feed/, /rss/
//       and every topic /feed/ HTTP 30x-redirect to the bare HTML page (the parser
//       then receives HTML and yields nothing). No FeedBurner mirror.
// All three carry long-form analysis that rarely clears the curated gate, so they
// stay documented-omitted rather than configured. Do not blindly re-add.

export const CURATED_FEEDS: CuratedFeedConfig[] = [
  ...ADVERSARY_FEEDS,
  ...INTERNATIONAL_FEEDS,
  ...OPINION_FEEDS,
  ...MAGAZINE_FEEDS,
  ...US_MAINSTREAM_FEEDS,
  ...US_WIRE_FEEDS,
  ...DEFENSE_TRADE_FEEDS,
];
