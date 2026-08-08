/**
 * Regression test for Task #677 — NPR broadcast/podcast segments must be
 * detected as audio (content_kind='audio') so they are attach-only in
 * Curated, even when the page shows a "HEARD ON <program>" byline or "Audio
 * will be available later today" instead of an already-published .mp3 URL.
 *
 * Covers:
 *   1. detectPageContentKind precision on NPR pages — flags "HEARD ON
 *      <program>" and "Audio will be available later today" as audio, but
 *      never flags a plain NPR article, and never applies the "HEARD ON"
 *      heuristic to a non-NPR host (scope must stay NPR-only).
 *   2. Existing published-audio signals (ondemand.npr.org/.mp3/audiourl,
 *      og:audio) still work unchanged.
 *   3. Gate parity — getEffectiveContentKind / isEffectivelyReportedArticle
 *      treat a page-detected NPR audio segment exactly like an already
 *      audio-tagged row: excluded from standalone Top Stories / Top
 *      Narratives / cluster rep selection.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-npr-audio.test.ts
 * Exits non-zero on any failure.
 */
import { detectPageContentKind } from "../server/streamPrefetch";
import {
  getEffectiveContentKind,
  isEffectivelyReportedArticle,
} from "../shared/contentKind";

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
// 1. NPR-scoped "HEARD ON" / "Audio will be available later today" detection
// ---------------------------------------------------------------------------

const NPR_HEARD_ON_MORNING_EDITION = `
<html><head><title>Trump won spending promises from NATO last year</title></head>
<body>
  <div class="story-meta"><span class="story-audio">HEARD ON</span> <a href="/programs/morning-edition/">Morning Edition</a></div>
  <h1>Trump won spending promises from NATO last year. This week, he'll try to enforce them</h1>
  <p>Audio will be available later today.</p>
</body></html>
`;

const NPR_PENDING_AUDIO_ONLY = `
<html><head><title>Russian missile and drone attack on Ukraine's capital kills at least 12</title></head>
<body>
  <h1>Russian missile and drone attack on Ukraine's capital kills at least 12</h1>
  <p>Audio will be available later today.</p>
</body></html>
`;

const NPR_HEARD_ON_ATC = `
<html><head><title>What comes next for the ceasefire</title></head>
<body>
  <span>Heard on All Things Considered</span>
  <h1>What comes next for the ceasefire</h1>
</body></html>
`;

const NPR_PLAIN_ARTICLE = `
<html><head><title>Huge crowds of mourners join a funeral procession</title></head>
<body>
  <h1>Huge crowds of mourners join a funeral procession for Iran's Ayatollah Ali Khamenei</h1>
  <p>Thousands gathered Monday in Tehran as state television broadcast the procession live.</p>
</body></html>
`;

const NPR_UNRELATED_HEARD_PHRASE = `
<html><head><title>A story about acoustics</title></head>
<body>
  <h1>A story about acoustics</h1>
  <p>Heard on the radio somewhere in the Midwest, the signal cut in and out all week.</p>
</body></html>
`;

const NON_NPR_HEARD_ON_LOOKALIKE = `
<html><head><title>Some other outlet's story</title></head>
<body>
  <span>HEARD ON Morning Edition</span>
  <p>Audio will be available later today.</p>
</body></html>
`;

check(
  "NPR: 'HEARD ON Morning Edition' + pending-audio note -> audio",
  detectPageContentKind(NPR_HEARD_ON_MORNING_EDITION, "https://www.npr.org/2026/07/06/g-s1-132082/trump-nato-turkey-spending"),
  "audio",
);
check(
  "NPR: 'Audio will be available later today' alone -> audio",
  detectPageContentKind(NPR_PENDING_AUDIO_ONLY, "https://www.npr.org/2026/07/06/g-s1-132088/russian-missile-drone-attack-kyiv-kills-at-least-12"),
  "audio",
);
check(
  "NPR: 'Heard on All Things Considered' -> audio",
  detectPageContentKind(NPR_HEARD_ON_ATC, "https://www.npr.org/2026/07/06/nx-s1-999999/ceasefire-next"),
  "audio",
);
check(
  "NPR: plain reported article with no audio signal -> article",
  detectPageContentKind(NPR_PLAIN_ARTICLE, "https://www.npr.org/2026/07/06/nx-s1-5877741/ayatollahs-funeral-procession-begins-in-iran"),
  "article",
);
check(
  "NPR: body merely containing the word 'heard' in an unrelated sentence -> article (guardrail: requires a known program name or the pending-audio phrase)",
  detectPageContentKind(NPR_UNRELATED_HEARD_PHRASE, "https://www.npr.org/2026/07/06/nx-s1-000001/acoustics-story"),
  "article",
);
check(
  "Non-NPR host: 'HEARD ON'/pending-audio lookalike text is NOT flagged (guardrail: heuristic is NPR-scoped only)",
  detectPageContentKind(NON_NPR_HEARD_ON_LOOKALIKE, "https://www.example.com/2026/07/06/some-story"),
  "article",
);

// ---------------------------------------------------------------------------
// 2. Existing published-audio signals still work unchanged
// ---------------------------------------------------------------------------

const NPR_PUBLISHED_MP3 = `
<html><head><title>A published segment</title></head>
<body>
<script>var audiourl = "https://ondemand.npr.org/anon.npr-mp3/npr/me/2026/07/segment.mp3";</script>
<h1>A published segment</h1>
</body></html>
`;

const NPR_OG_AUDIO = `
<html><head>
<meta property="og:audio" content="https://ondemand.npr.org/anon.npr-mp3/npr/me/2026/07/segment2.mp3" />
<title>Another published segment</title>
</head>
<body><h1>Another published segment</h1></body></html>
`;

check(
  "NPR: existing ondemand.npr.org/.mp3/audiourl signal still detected -> audio",
  detectPageContentKind(NPR_PUBLISHED_MP3, "https://www.npr.org/2026/07/06/nx-s1-1/a-published-segment"),
  "audio",
);
check(
  "NPR: existing og:audio signal still detected -> audio",
  detectPageContentKind(NPR_OG_AUDIO, "https://www.npr.org/2026/07/06/nx-s1-2/another-published-segment"),
  "audio",
);

// ---------------------------------------------------------------------------
// 3. Gate parity — page-detected NPR audio is excluded exactly like a stored
//    audio row from standalone Top Stories / Top Narratives / cluster rep.
// ---------------------------------------------------------------------------

check(
  "getEffectiveContentKind: page-detected NPR audio wins over the article URL shape",
  getEffectiveContentKind("https://www.npr.org/2026/07/06/g-s1-132082/trump-nato-turkey-spending", "audio"),
  "audio",
);
check(
  "isEffectivelyReportedArticle: page-detected NPR audio is NOT a reported article (standalone/narrative gate excludes it)",
  isEffectivelyReportedArticle("https://www.npr.org/2026/07/06/g-s1-132082/trump-nato-turkey-spending", "audio"),
  false,
);
check(
  "isEffectivelyReportedArticle: an NPR article with no audio signal IS a reported article",
  isEffectivelyReportedArticle("https://www.npr.org/2026/07/06/nx-s1-5877741/ayatollahs-funeral-procession-begins-in-iran", "article"),
  true,
);

console.log(`\n${pass}/${pass + failures.length} passed`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
