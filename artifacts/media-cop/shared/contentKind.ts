// Single source of truth for classifying a news URL as a reported ARTICLE vs a
// VIDEO clip, OPINION/ANALYSIS piece, EXPLAINER, LIVE blog, or PODCAST page.
// Shared by the client (Curated.tsx content-kind badge), the curated cluster
// engine (picking a real article as a cluster's representative), and the curated
// Top Stories route (keeping lone non-news items out of the single-source feed).
// Keep this ONE copy so the badge the user sees and the items we filter can
// never drift apart.

export type ContentKind = "article" | "video" | "opinion" | "explainer" | "live" | "podcast";

function urlPath(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    // Not a fully-qualified URL — match against the raw string instead.
    return url.toLowerCase();
  }
}

function urlHostname(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Returns the last non-empty path segment of the URL (no trailing slash),
// lowercased. Used for host-scoped slug-token rules.
function lastSlugSegment(url: string | null | undefined): string {
  const path = urlPath(url).replace(/\/$/, "");
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

// Video clip: aljazeera.com/video/..., bloomberg.com/news/videos/..., /watch/...
export function isVideoUrl(url: string | null | undefined): boolean {
  const path = urlPath(url);
  return /\/videos?(\/|$)/.test(path) || /\/watch(\/|$)/.test(path);
}

// Opinion / commentary column: /opinion/, /op-ed/, /commentary/, /column/,
// /editorial/, /commentisfree/ (Guardian). Path-segment anchored — only a
// complete segment matches so /in-commentary-on/ never trips the rule.
//
// Compound segments (Step 1 gaps):
//   Ynetnews: /opinions-analysis/ — the compound form was missed by the
//   original /opinions?(\/|$)/ because a hyphen is not a segment boundary;
//   fixed by an explicit compound-segment clause.
//   The Daily Star: /slow-reads/geopolitical-insights/ — host-scoped (thedailystar.net)
//   analysis section that was not in the general rules.
export function isOpinionUrl(url: string | null | undefined): boolean {
  const path = urlPath(url);
  if (/\/opinions?(\/|$)/.test(path)) return true;
  if (/\/op-eds?(\/|$)/.test(path)) return true;
  if (/\/commentary(\/|$)/.test(path)) return true;
  if (/\/columns?(\/|$)/.test(path)) return true;
  if (/\/editorials?(\/|$)/.test(path)) return true;
  if (/\/commentisfree(\/|$)/.test(path)) return true;
  // Compound segment: Ynetnews /opinions-analysis/ (missed by the bare
  // /opinions?/ rule which requires a segment boundary immediately after).
  if (/\/opinions?-analysis(\/|$)/.test(path)) return true;
  // Host-scoped: The Daily Star (Bangladesh) analysis section.
  // /slow-reads/geopolitical-insights/ is an editorial analysis section, not
  // general news. Anchored to the specific host so "slow-reads" on other
  // outlets never false-positives.
  const host = urlHostname(url);
  if (/(?:^|\.)thedailystar\.net$/.test(host)) {
    if (/\/slow-reads\/geopolitical-insights(\/|$)/.test(path)) return true;
  }
  return false;
}

// Live-blog / developing-event pages: continuously-updated multi-post formats
// that stitch a developing event over time rather than a single reported piece.
// Receives its own kind ("live") so it is never mislabeled "Opinion". Receives
// the same attach-only/score-cap treatment as analysis/opinion (see
// shouldDemoteEffectiveOpinion and evalCuratedAnalysisOpinionCap).
//
// Precision-first, but covers the common real-world shapes beyond the original
// /live-blog//liveblog//live-updates/ segments, which missed the live blogs that
// straddle multiple sub-events and were leaking in as contributing sources /
// cluster representatives:
//   /live/       — Guardian "/world/live/2026/jul/16/…" section
//   /live-news/  — CNN "/world/live-news/…", Fox "/live-news/…"
//   trailing -live — USA Today "…-strait-hormuz--live/…"
//   host-scoped mid-slug "<topic>-live-<headline>" — Reuters "iran-war-live-…"
//   and France 24 "…-middle-east-live-…". Mid-slug "-live-" is host-scoped (NOT
//   general) — precision-first, mirroring the CNN/Reuters slug rules elsewhere —
//   so a lifestyle slug like "how-to-live-longer" on any other host can never
//   false-positive into the attach-only tier.
export function isLiveBlogUrl(url: string | null | undefined): boolean {
  const path = urlPath(url);
  if (/\/live-blog(\/|$)/.test(path)) return true;
  if (/\/liveblog(\/|$)/.test(path)) return true;
  if (/\/live-updates?(\/|$)/.test(path)) return true;
  if (/\/live-news(\/|$)/.test(path)) return true;
  if (/\/live(\/|$)/.test(path)) return true;
  // Trailing "-live" slug token (…-strait-hormuz--live/… , …/foo-live).
  if (/-live(?:\/|$)/.test(path)) return true;
  // Numbered live-page segment — DW's "/…-slug/live-78077811" shape, where the
  // FINAL path segment is "live-<digits>". The bare /live(\/|$)/ rule above
  // requires the segment to be exactly "live", so these leaked through as full
  // articles and bridged multi-event coverage into one cluster. Anchored to a
  // whole segment of "live-" + digits only — a slug like "live-fire-drill" or
  // "how-to-live-longer" can never match.
  if (/\/live-\d+(\/|$)/.test(path)) return true;
  // Compound "-live-updates" slug token anywhere in a slug (The Hindu's
  // "…/iran-us-war-live-updates-military-strike-…"). The segment rule above
  // only matches a WHOLE "/live-updates/" segment and the trailing "-live"
  // rule requires the slug to END with "-live", so this mid-slug compound
  // leaked through. The two-word compound "live-updates" is used essentially
  // only by live-coverage pages, so a general (non-host-scoped) rule stays
  // precision-safe ("how-to-live-longer" has no "updates"; "week-long" has no
  // "live").
  if (/-live-updates?(?:-|\/|$)/.test(path)) return true;
  // Host-scoped mid-slug "<topic>-live-<headline>" live-coverage slugs.
  const host = urlHostname(url);
  if (/(?:^|\.)reuters\.com$/.test(host) && /-live-/.test(path)) return true;
  if (/(?:^|\.)france24\.com$/.test(host) && /-live-/.test(path)) return true;
  return false;
}

// Live-umbrella RECAP title: a rolling "state of the war" page published on a
// plain article URL (no live-blog path shape to catch), titled with a trailing
// "…: What's the latest?" interrogative — e.g. Al Jazeera's daily "Iran,
// Houthis strike tankers as US bombing continues: What's the latest?" on a
// /news/ path. Like a live blog, such a page stitches SEVERAL same-day
// sub-events into one item, so in the curated lane it must never bridge
// distinct events into one cluster. URL rules cannot catch these (the URL is a
// normal article slug), so this is a separate TITLE predicate, deliberately
// narrow: only a title that ENDS with the fixed recap phrase "what's the
// latest" (optional "?"), optionally preceded by a colon/dash separator. A
// headline that merely asks a question ("What's the latest jobs report say?")
// or contains the phrase mid-title never matches.
export function isLiveUmbrellaTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return /\bwhat[’']s the latest\??\s*$/i.test(title.trim());
}

// Podcast-path URLs: page-hosted episode pages that share the attach-only
// treatment of audio without requiring full page-content detection. Receives
// its own kind ("podcast") so it is never mislabeled "Opinion".
export function isPodcastUrl(url: string | null | undefined): boolean {
  const path = urlPath(url);
  return /\/podcasts?(\/|$)/.test(path);
}

// Analysis piece: /analysis/ path segment, OR host-scoped slug-token rules.
// Precision-first: only anchored segment / end-of-slug tokens; never a
// mid-slug substring match so a real-news slug that happens to contain the
// word "analysis" elsewhere can't false-positive.
//
// Host-scoped rules:
//   CNN — the last slug segment ends with "-analysis" optionally followed by
//   a channel suffix ("-intl", "-intl-hnk", etc.), e.g.:
//     /2026/01/01/politics/us-iran-deal-analysis
//     /2026/01/01/politics/us-iran-deal-analysis-intl
//     /2026/01/01/politics/us-iran-deal-analysis-intl-hnk
//   Precision guard: the segment must have at least one preceding token
//   separated by "-" so a standalone slug of just "analysis" (a section
//   index page) never matches.
//
// NOTE: live-blog and podcast paths used to be included here. They are now
// handled by isLiveBlogUrl / isPodcastUrl and their own kinds ("live" /
// "podcast") so they never resolve to "opinion". This function still returns
// true for those URLs (callers that need a union test still work), but
// deriveContentType routes them to the correct kind before reaching this.
export function isAnalysisOrLiveBlogUrl(url: string | null | undefined): boolean {
  const path = urlPath(url);
  // General path-segment rules (any host)
  if (/\/analysis(\/|$)/.test(path)) return true;
  // Delegate ALL live-blog shapes to the single source of truth so this union
  // predicate can never drift from isLiveBlogUrl (covers /live/, /live-news/,
  // trailing -live, host-scoped mid-slug -live-, plus the original segments).
  if (isLiveBlogUrl(url)) return true;
  if (/\/podcasts?(\/|$)/.test(path)) return true;
  // Host-scoped: CNN trailing -analysis slug (with optional channel suffix)
  const host = urlHostname(url);
  if (/(?:^|\.)cnn\.com$/.test(host)) {
    const slug = lastSlugSegment(url);
    // Must have at least one "-" before "-analysis" (rules out a bare
    // /analysis section index page).
    if (/^.+-analysis(?:-intl(?:-[a-z]+)*)?$/.test(slug)) return true;
  }
  return false;
}

// Explainer: /explainers/ section (any host), or Reuters-style "explainer-"
// slug prefix. Receives the same attach-only tier treatment as opinion/analysis
// but surfaces a distinct "Explainer" badge in the UI.
export function isExplainerUrl(url: string | null | undefined): boolean {
  const path = urlPath(url);
  if (/\/explainers?(\/|$)/.test(path)) return true;
  // Host-scoped: Reuters "explainer-" slug prefix at the start of a segment
  const host = urlHostname(url);
  if (/(?:^|\.)reuters\.com$/.test(host)) {
    const slug = lastSlugSegment(url);
    if (/^explainer-/.test(slug)) return true;
  }
  return false;
}

export function deriveContentType(url: string | null | undefined): ContentKind {
  if (!url) return "article";
  if (isVideoUrl(url)) return "video";
  if (isExplainerUrl(url)) return "explainer";
  // Live-blog and podcast resolve to their own kinds BEFORE the analysis/opinion
  // check so they are never mislabeled "Opinion" in the badge or filter facets.
  if (isLiveBlogUrl(url)) return "live";
  if (isPodcastUrl(url)) return "podcast";
  if (isOpinionUrl(url) || isAnalysisOrLiveBlogUrl(url)) return "opinion";
  return "article";
}

// Is this URL a reported ARTICLE (not a video/opinion/explainer/live/podcast)?
// Unknown/odd URLs are treated as articles so we never penalize them.
export function isReportedArticleUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  return deriveContentType(url) === "article";
}

// Stored content_kind values written by server-side enrichment (never derived
// from the URL alone — a page-labeled signal, e.g. audio-format detection,
// the page-labeled ANALYSIS/OPINION detector, or the BackgroundNewsArticle /
// "Explainer" section detector).
export type StoredContentKind = "audio" | "article" | "opinion" | "explainer" | null | undefined;

// Effective content kind: the URL shape (video/opinion/explainer/live/podcast/
// article) UNLESS the page itself told us otherwise. A trusted outlet's
// page-labeled ANALYSIS/OPINION piece (e.g. Al Jazeera's "Analysis" kicker on
// a plain /features/ URL with no /opinion/ path segment) would otherwise slip
// through as a plain "article" — this is the single place that reconciles the
// two signals so every reader (server gates, cluster tiering, the client badge)
// agrees on one answer. Stored "audio" always wins over the URL shape (it's a
// distinct kind from opinion/video and is handled by existing audio logic).
export function getEffectiveContentKind(
  url: string | null | undefined,
  storedContentKind?: StoredContentKind,
): ContentKind | "audio" {
  if (storedContentKind === "audio") return "audio";
  const urlKind = deriveContentType(url);
  if (urlKind !== "article") return urlKind;
  if (storedContentKind === "opinion") return "opinion";
  if (storedContentKind === "explainer") return "explainer";
  return "article";
}

// Is this URL/row an effectively-reported ARTICLE — i.e. not audio, not video,
// not opinion/analysis (by URL shape OR page-labeled signal), not an explainer,
// not a live blog, not a podcast page? Mirrors isReportedArticleUrl but also
// honors the stored page-labeled kind so a trusted outlet's ANALYSIS/OPINION/
// EXPLAINER piece is excluded even without a telltale URL segment.
// When `title` is provided the title-based checks (detectTitleLeadingLabel,
// detectTitleTrailingKicker and detectWHLeadDualSignal) are also consulted as
// a third fallback — fired
// only when both the URL shape and the stored kind return "article" — so
// classification applies immediately on the first clustering pass without
// waiting for enrichment to stamp content_kind.
export function isEffectivelyReportedArticle(
  url: string | null | undefined,
  storedContentKind?: StoredContentKind,
  title?: string | null,
): boolean {
  const kind = getEffectiveContentKindWithTitle(url, title, storedContentKind);
  return kind === "article";
}

// Effective content kind with title fallback: the URL shape + stored kind UNLESS
// the title-based checks provide additional signal. When both the URL shape and
// stored kind return "article" AND a title is provided, additionally tries
// detectTitleLeadingLabel, detectTitleTrailingKicker and detectWHLeadDualSignal
// as pure-regex fallbacks.
// This lets an Al Jazeera /news/…/why-is-… explainer be classified immediately
// on the first clustering pass (before enrichment runs) without waiting for
// enrichment to stamp content_kind = 'explainer'. Curated-lane only.
export function getEffectiveContentKindWithTitle(
  url: string | null | undefined,
  title: string | null | undefined,
  storedContentKind?: StoredContentKind,
): ContentKind | "audio" {
  const base = getEffectiveContentKind(url, storedContentKind);
  if (base !== "article" || !title) return base;
  // Explicit, outlet-authored leading label first ("Op-ed: …").
  const leadingKind = detectTitleLeadingLabel(title);
  if (leadingKind) return leadingKind;
  // Trailing kicker (outlet explicitly labels the piece at the end of its title).
  const kickerKind = detectTitleTrailingKicker(title);
  if (kickerKind) return kickerKind;
  // WH-lead dual signal: corroborating URL slug + headline lead word.
  const whKind = detectWHLeadDualSignal(url, title);
  if (whKind) return whKind;
  return "article";
}

// Task #650 / Task #854 / Task #899 / Task #1007 — should a cluster member be
// demoted to the attach-only tier because it is an effectively-opinion/analysis,
// explainer, live-blog, or podcast-page piece from an otherwise-trusted outlet?
// An outlet ALREADY blocked or already labeled "contrast" (adversary/CPC/
// low-factuality) is left untouched — this is about keeping a TRUSTED outlet's
// opinion column / analysis piece / explainer / live-blog / podcast out of the
// primary/anchor tiers, never about softening or hardening an adversary label.
// Pure/deterministic so the curated cluster engine's demotion and its unit tests
// share one answer. Covers: opinion, analysis, commentisfree, CNN trailing
// -analysis, live-blog, podcast-path, explainer (URL + page-detected).
// When `title` is provided the title-based checks (detectTitleLeadingLabel,
// detectTitleTrailingKicker and detectWHLeadDualSignal) fire as a third
// fallback, enabling demotion on the
// first clustering pass before enrichment writes content_kind.
export function shouldDemoteEffectiveOpinion(
  isBlocked: boolean,
  behaviorLabel: string | null | undefined,
  url: string | null | undefined,
  storedContentKind?: StoredContentKind,
  title?: string | null,
): boolean {
  if (isBlocked || behaviorLabel === "contrast") return false;
  const kind = getEffectiveContentKindWithTitle(url, title, storedContentKind);
  return kind === "opinion" || kind === "explainer" || kind === "live" || kind === "podcast";
}

// Outlet-authored leading content label in a headline. Unlike ordinary prose,
// this is an explicit type label at the very START of the title and must be
// followed immediately by a colon. The strict boundary is intentional:
// "Op-ed: …" is safely opinion, while "The op-ed argues …" and
// "Analysis shows …" remain reported articles. Keep this curated-only fallback
// narrow; page-level structured signals remain the stronger source of truth.
export function detectTitleLeadingLabel(
  title: string | null | undefined,
): 'opinion' | null {
  if (!title) return null;
  return /^(?:op-ed|opinion|analysis|editorial|commentary|perspective)\s*:\s*\S/i.test(title.trim())
    ? 'opinion'
    : null;
}

// Outlet-authored trailing kicker in a headline: some outlets append a content-
// type label at the END of the H1 title, separated by " - ", " — ", or " | ".
// Example: "Why Morocco's commitment is a major milestone for the US peace plan
//           in Gaza - analysis"
// These are high-confidence opinion/explainer signals because the outlet itself
// wrote the label. Anchored to the TRAILING position only (after a separator at
// end-of-title) so a mid-sentence mention of "analysis" or "opinion" in a real
// reported headline is never caught.
// Precision guards:
//   - Must have at least 5 characters before the separator (rules out a title
//     that IS the kicker with no real headline text).
//   - Separator must immediately precede the kicker (no nested separators).
//   - Only the kicker words that outlets use as explicit type labels; "review"
//     and "interview" are deliberately excluded (collision-prone with reported
//     stories that happen to review or interview someone).
export function detectTitleTrailingKicker(
  title: string | null | undefined,
): 'opinion' | 'explainer' | null {
  if (!title) return null;
  const t = title.trim();
  // Separator variants: " - " / " — " / " | " (allow surrounding spaces)
  const m = /\s+[-—|]\s+(analysis|opinion|op-ed|editorial|comment(?:ary)?|perspective|explainer)\s*$/i.exec(t);
  if (!m) return null;
  // Guard: substantive text must precede the separator.
  const before = t.slice(0, m.index).trim();
  if (before.length < 5) return null;
  const kicker = m[1].toLowerCase();
  if (kicker === 'explainer') return 'explainer';
  return 'opinion';
}

// WH-lead explainer dual-signal: auto-classify as 'explainer' ONLY when the
// same WH lead (why / what / how) is present in BOTH the URL path/slug AND the
// headline. Two agreeing independent signals provide high precision — a plain
// reported story typically has a declarative slug even when the headline is
// phrased as a question. Precision guards:
//   - Only the strong unambiguous lead words (why, what, how) are matched;
//     "will", "is", "who" are excluded — too collision-prone with ordinary
//     reporting ("Will Trump attend?" is a news update, not an explainer).
//   - The WH-word must appear at the START of a URL path SEGMENT (following
//     a "/" or at the beginning of the path) so a mid-slug mention like
//     "iraq-why-sanctions" never false-positives.
//   - The headline must START with the same WH-word (not a mid-sentence "why").
// Curated-lane only (called from the enrichment path, never the main feed).
const _WH_TITLE_START =
  /^(why|what(?:'?s?|\s+is|\s+are|\s+was|\s+were|\s+does|\s+happened)?|how)\b/i;

export function detectWHLeadDualSignal(
  url: string | null | undefined,
  title: string | null | undefined,
): 'explainer' | null {
  if (!url || !title) return null;
  const path = urlPath(url);
  const t = title.trim();
  // 1. Title must START with a strong WH-lead word.
  const titleMatch = _WH_TITLE_START.exec(t);
  if (!titleMatch) return null;
  // Normalise: "what's" / "what is" / "what are" / etc. all → "what".
  const baseWord = titleMatch[1].toLowerCase().startsWith('what') ? 'what' :
    titleMatch[1].toLowerCase();
  // 2. URL slug must contain the same WH-lead at the START of a path segment.
  // "what" matches what-s / what-is / what-are / what-was / what-does / etc.
  // Also allows a YYYYMMDD- (or YYYYMM-) date prefix common on France24:
  // e.g. /20260101-why-the-us-is-launching-strikes-...
  // The optional \d{6,8}- prefix is strictly digits+hyphen so it never widens
  // to a mid-word match on arbitrary slugs.
  const slugVariant = baseWord === 'what'
    ? 'what(?:-s|-is|-are|-was|-were|-does|-happened)?'
    : baseWord;
  const slugRe = new RegExp(`(?:^|/)(?:\\d{6,8}-)?${slugVariant}-`, 'i');
  if (!slugRe.test(path)) return null;
  return 'explainer';
}

// Returns true when the headline carries a lone interrogative signal — a
// trailing "?" OR a WH-lead at the start — WITHOUT a corroborating URL or
// page-HTML signal. Used as a FIRST INDICATOR to surface items for editor
// review. Never used as a standalone demotion trigger. Al Jazeera's
// "US or Iran — Who needs a new truce deal more?" is a prototypical example.
export function hasTitleInterrogativeSignal(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.trim();
  if (t.endsWith('?')) return true;
  return _WH_TITLE_START.test(t);
}

// Multi-story "roundup" / digest headline: a single title that stitches two or
// more UNRELATED top stories together with a sentence-boundary conjunction —
// e.g. NPR's "Up First": "UK PM Keir Starmer resigns. And, US and Iran agree to
// a roadmap for a final deal". Such a title isn't about one event, so in the
// curated lane it must never seed, represent, or be a member of a cluster (it
// makes a single-topic story card look like two merged topics, and it floats
// between the clusters it half-matches), nor surface as a standalone Top Story /
// Top Narrative. Detection is deliberately conservative: a sentence boundary
// (.!?) immediately followed by "And,"/"Plus,"/"Also," — so ordinary prose
// ("He resigned. And he left.") with no comma never trips it — plus NPR's
// "Up First" brand, matched ONLY as the exact title ("Up First"), a title
// prefix with a colon ("Up First: ..."), or "Up First briefing" — so a normal
// headline like "Up first responders arrived" is never mistaken for it.
export function isRoundupDigestTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.trim();
  return (
    /[.!?]\s+And,\s+/i.test(t) ||
    /[.!?]\s+Plus,\s+/i.test(t) ||
    /[.!?]\s+Also,\s+/i.test(t) ||
    /^up first\b\s*(?::|$)/i.test(t) ||
    /\bup first\s+briefing\b/i.test(t) ||
    // Weekly photo-recap / "week in review" galleries — France 24 & BBC "The
    // week in pictures", The National "Pictures of the week", etc. Each stitches
    // several unrelated events of the week into ONE photo-gallery title (e.g.
    // "The week in pictures: America at 250, Taylor Swift gets married and a
    // 'massive attack' on Kyiv"), so like NPR's "Up First" it half-matches
    // multiple stories and must never seed / represent a curated cluster or
    // surface as a standalone headline. Conservative: only the fixed weekly-
    // digest phrasings, which a single-topic story never uses as its title.
    /\bweek in (?:pictures|photos|review)\b/i.test(t) ||
    // `(?!-)` keeps "Photos of the week-long siege of Mariupol" (a single-topic
    // conflict story) from matching — the trailing `\b` alone treats the hyphen
    // as a word boundary, so "week-long" would otherwise trip it.
    /\b(?:pictures|photos|images) of the week\b(?!-)/i.test(t)
  );
}
