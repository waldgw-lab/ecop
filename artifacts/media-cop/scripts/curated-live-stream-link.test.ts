/**
 * Regression test for the Curated live-broadcast SOCIAL "live requires a stream
 * link" rule (extractStreamUrl + classifySocialLive).
 *
 * THE contract this guards: social posts tell MCOP a leader's SCHEDULE (an
 * upcoming cue), but the live banner must point users at an ACTUAL stream — not
 * the post itself. So a social post is only trusted as LIVE when it BOTH uses
 * live language ("watch live", "live now") AND embeds a real streaming link. A
 * "live now" post with no stream link is NOT on-air here (the keyless web checks
 * — White House live page, YouTube /live, C-SPAN/PBS — confirm the real stream).
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-live-stream-link.test.ts
 * Exits non-zero on any failure.
 */
import {
  extractStreamUrl,
  classifySocialLive,
  isSocialUpcoming,
} from "../server/liveBroadcastStatus";

let failures = 0;
function check(name: string, got: unknown, expected: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}\n   expected ${JSON.stringify(expected)}\n   got      ${JSON.stringify(got)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const SELF = "https://truthsocial.com/@realDonaldTrump/posts/123";

// ---- extractStreamUrl: recognized stream destinations ----
check(
  "youtube watch link is a stream",
  extractStreamUrl("Watch live: https://www.youtube.com/watch?v=abc123", SELF),
  "https://www.youtube.com/watch?v=abc123",
);
check(
  "youtu.be short link is a stream",
  extractStreamUrl("LIVE now https://youtu.be/abc123", SELF),
  "https://youtu.be/abc123",
);
check(
  "youtube /live channel link is a stream",
  extractStreamUrl("Tune in live https://www.youtube.com/@WhiteHouse/live", SELF),
  "https://www.youtube.com/@WhiteHouse/live",
);
check(
  "rumble video host is a stream",
  extractStreamUrl("Going live on https://rumble.com/v123-remarks.html", SELF),
  "https://rumble.com/v123-remarks.html",
);
check(
  "whitehouse.gov/live path is a stream",
  extractStreamUrl("Watch live at https://www.whitehouse.gov/live/", SELF),
  "https://www.whitehouse.gov/live/",
);
check(
  "c-span /live path is a stream",
  extractStreamUrl("Live coverage https://www.c-span.org/live/", SELF),
  "https://www.c-span.org/live/",
);
check(
  "x.com /i/broadcasts path is a stream",
  extractStreamUrl("Streaming now https://x.com/i/broadcasts/1abc", SELF),
  "https://x.com/i/broadcasts/1abc",
);
check(
  "trailing period is stripped off the stream link",
  extractStreamUrl("Watch live: https://www.youtube.com/watch?v=abc123.", SELF),
  "https://www.youtube.com/watch?v=abc123",
);

// ---- extractStreamUrl: NON-stream links must be rejected ----
check(
  "a plain article link is NOT a stream",
  extractStreamUrl("Big news today https://apnews.com/article/foo-bar-123", SELF),
  null,
);
check(
  "a '/live-updates' liveblog path is NOT a video stream",
  extractStreamUrl("Follow along https://www.example.com/live-updates/123", SELF),
  null,
);
check(
  "the post's own self URL is NOT a stream",
  extractStreamUrl(`See my post ${SELF}`, SELF),
  null,
);
check(
  "self URL with trailing slash still excluded",
  extractStreamUrl(`Re-truth ${SELF}/`, SELF),
  null,
);
check("no link at all → null", extractStreamUrl("We are LIVE now from the East Room!", SELF), null);
check("empty content → null", extractStreamUrl("", SELF), null);
check(
  "picks the stream link even when a non-stream link comes first",
  extractStreamUrl(
    "Story https://apnews.com/article/x then watch https://youtu.be/abc123",
    SELF,
  ),
  "https://youtu.be/abc123",
);

// ---- classifySocialLive: live requires BOTH live language AND a stream link ----
check(
  "live language + stream link → LIVE",
  classifySocialLive("WATCH LIVE: https://www.youtube.com/watch?v=abc123", SELF),
  { isLive: true, streamUrl: "https://www.youtube.com/watch?v=abc123" },
);
check(
  "live language WITHOUT a stream link → not live",
  classifySocialLive("We are LIVE NOW from the East Room!", SELF),
  { isLive: false, streamUrl: null },
);
check(
  "live language + only a self/article link → not live",
  classifySocialLive(`Live now! ${SELF}`, SELF),
  { isLive: false, streamUrl: null },
);
check(
  "no live language but a stream link → not live (handled as upcoming/elsewhere)",
  classifySocialLive("I'll speak later, link https://youtu.be/abc123", SELF),
  { isLive: false, streamUrl: null },
);
check(
  "neither live language nor link → not live",
  classifySocialLive("Great rally last night, thank you!", SELF),
  { isLive: false, streamUrl: null },
);

// ---- A legitimate stream on a non-allowlisted host is INTENTIONALLY accepted ----
// A "/live" path segment is a strong streaming indicator on any host (e.g. RSBN
// / Newsmax / a campaign site that streams a leader's event). Live language is
// always required first (classifySocialLive), which bounds the false-positive
// surface, so we keep recall broad rather than host-scoping the path rule.
check(
  "non-allowlisted host with a '/live' segment is accepted",
  extractStreamUrl("Watch live https://rsbnetwork.com/live/", SELF),
  "https://rsbnetwork.com/live/",
);

// ---- isSocialUpcoming: anticipation gating shared by both social signals ----
check(
  "upcoming language, same-day → upcoming",
  isSocialUpcoming("President will speak at 3pm today on the economy"),
  true,
);
check(
  "upcoming language but previews a FUTURE date → not upcoming",
  isSocialUpcoming("I'll be there to speak on July 4th, it'll be great"),
  false,
);
check(
  // scheduledEventPhase is summit/conference-scoped: a DURING-phase summit line
  // is the case the shared during-guard suppresses (parity with the schedule
  // anticipation signal so the two can't drift).
  "DURING-phase summit line is NOT anticipation",
  isSocialUpcoming("Press conference as the summit gets under way"),
  false,
);
check(
  // A general 'live now' post with no stream link is NOT live (no link) but DOES
  // read as schedule/anticipation — aligned with the contract that social posts
  // signal the schedule while the web checks confirm the actual stream.
  "general 'live now' remarks line degrades to anticipation (schedule cue)",
  isSocialUpcoming("Delivering remarks live now from the Rose Garden"),
  true,
);
check(
  "no upcoming language → not upcoming",
  isSocialUpcoming("Thank you to everyone who came out!"),
  false,
);

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll stream-link gating cases passed.`);
