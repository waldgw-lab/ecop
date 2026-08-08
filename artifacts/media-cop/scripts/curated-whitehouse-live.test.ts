/**
 * Regression test for the curated White House X live-broadcast signal.
 *
 * @WhiteHouse is onboarded curated-only (shared osint_posts, excluded from every
 * non-curated reader). It is the President's official broadcast channel, so its
 * posts can light the curated "President is live" banner — but only safely:
 *
 *   1. Both real example posts the user gave are recognized as WH events
 *      ("Participates in …", "Delivers Remarks at …") and, when their t.co
 *      RESOLVES to a stream, fire LIVE → President, pointing at the resolved
 *      stream (not the t.co / post).
 *   2. A NAMED covered leader (VP / SecState / SecWar) always wins over the
 *      President default.
 *   3. "False LIVE worse than missed": LIVE requires a CONFIRMED stream. When
 *      the t.co can't be confirmed (resolution fails or resolves to an article)
 *      but a leader is NAMED, the banner degrades to amber UPCOMING — never red.
 *   4. Fail-closed: retweets, stale posts, replays/ICYMI, posts with no embedded
 *      link, and unconfirmed posts with no named leader produce NOTHING.
 *   5. The short-link resolver is only consulted when the text has no direct
 *      stream link, and a stale-but-recent confirmed stream is amber, not red.
 *
 * No test framework is configured — run directly with tsx:
 *   npx tsx scripts/curated-whitehouse-live.test.ts
 * Exits non-zero on any failure.
 */
import {
  classifyWhiteHouseXPost,
  isWhiteHouseEventPost,
  firstNonSelfUrl,
} from "../server/liveBroadcastStatus";

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

const NOW = Date.UTC(2026, 5, 26, 18, 0, 0); // fixed clock
const FRESH = new Date(NOW - 5 * 60 * 1000).toISOString(); // 5 min ago (live window)
const RECENT = new Date(NOW - 28 * 60 * 1000).toISOString(); // 28 min ago (>live window, <social-upcoming window)
const STALE = new Date(NOW - 100 * 60 * 1000).toISOString(); // 100 min ago (>upcoming)

const SELF = "https://x.com/WhiteHouse/status/1234567890";

// Resolvers (injectable) — none hit the network.
const youtubeLive = async () => "https://www.youtube.com/live/abcDEF123";
const govLive = async () => "https://www.whitehouse.gov/live/";
const articleOnly = async () =>
  "https://www.whitehouse.gov/briefing-room/statements/remarks-by-the-president";
const unreachable = async () => null;
let resolverCalls = 0;
const countingResolver = async (u: string) => {
  resolverCalls++;
  return "https://www.youtube.com/live/abcDEF123";
};

// --- isWhiteHouseEventPost (pure gate) -------------------------------------
check(
  isWhiteHouseEventPost(
    "President Trump Participates in a Rose Garden Club Dinner with American Farmers https://t.co/PLuEh0MdrI",
  ),
  "example 1 reads as a WH event",
);
check(
  isWhiteHouseEventPost(
    "President Trump Delivers Remarks at the Great American State Fair https://t.co/Hq2fBYgKI6",
  ),
  "example 2 reads as a WH event",
);
check(
  !isWhiteHouseEventPost(
    "ICYMI: President Trump's remarks at the State Fair https://t.co/Hq2fBYgKI6",
  ),
  "ICYMI replay is NOT a live event",
);
check(
  !isWhiteHouseEventPost("Watch the full remarks from the President https://t.co/x"),
  "'watch the full' recap is NOT a live event",
);
check(
  !isWhiteHouseEventPost("Happy Independence Day from the White House!"),
  "a non-event greeting is NOT a WH event",
);

// --- firstNonSelfUrl -------------------------------------------------------
check(
  firstNonSelfUrl(
    "President Trump Delivers Remarks at the Great American State Fair https://t.co/Hq2fBYgKI6",
    SELF,
  ) === "https://t.co/Hq2fBYgKI6",
  "firstNonSelfUrl returns the embedded t.co",
);
check(
  firstNonSelfUrl(`Some post ${SELF}`, SELF) === null,
  "firstNonSelfUrl skips the post's own self URL",
);

// --- LIVE: both user examples with a confirmed stream ----------------------
async function run() {
  // Example 1 → t.co resolves to a YouTube live stream → LIVE / President.
  const ex1 = await classifyWhiteHouseXPost(
    {
      content:
        "President Trump Participates in a Rose Garden Club Dinner with American Farmers https://t.co/PLuEh0MdrI",
      xUrl: SELF,
      postedAt: FRESH,
      isRetweet: false,
    },
    NOW,
    youtubeLive,
  );
  check(ex1?.state === "live" && ex1.leader === "President", "example 1 → LIVE President");
  check(
    ex1?.watchUrl === "https://www.youtube.com/live/abcDEF123",
    "example 1 watchUrl points at the resolved stream, not the t.co",
  );

  // Example 2 → t.co resolves to whitehouse.gov/live → LIVE / President.
  const ex2 = await classifyWhiteHouseXPost(
    {
      content:
        "President Trump Delivers Remarks at the Great American State Fair https://t.co/Hq2fBYgKI6",
      xUrl: SELF,
      postedAt: FRESH,
      isRetweet: false,
    },
    NOW,
    govLive,
  );
  check(ex2?.state === "live" && ex2.leader === "President", "example 2 → LIVE President");

  // Direct stream link in the text → LIVE without consulting the resolver.
  resolverCalls = 0;
  const direct = await classifyWhiteHouseXPost(
    {
      content:
        "President Trump Delivers Remarks at the State Fair https://www.youtube.com/live/xyz789",
      xUrl: SELF,
      postedAt: FRESH,
      isRetweet: false,
    },
    NOW,
    countingResolver,
  );
  check(direct?.state === "live", "direct stream link → LIVE");
  check(resolverCalls === 0, "resolver NOT called when text has a direct stream link");

  // NAMED covered leaders win over the President default.
  const vp = await classifyWhiteHouseXPost(
    {
      content:
        "Vice President Vance Delivers Remarks at the Naval Academy https://t.co/vp123",
      xUrl: SELF,
      postedAt: FRESH,
      isRetweet: false,
    },
    NOW,
    youtubeLive,
  );
  check(vp?.state === "live" && vp.leader === "Vice President", "VP named → LIVE Vice President");

  const sec = await classifyWhiteHouseXPost(
    {
      content:
        "Secretary of State Rubio holds a press conference on the summit https://t.co/ss123",
      xUrl: SELF,
      postedAt: FRESH,
      isRetweet: false,
    },
    NOW,
    youtubeLive,
  );
  check(
    sec?.state === "live" && sec.leader === "Secretary of State",
    "SecState named → LIVE Secretary of State",
  );

  // --- AMBER degrade: confirmed-leader but unconfirmed stream → UPCOMING ----
  const unresolved = await classifyWhiteHouseXPost(
    {
      content:
        "President Trump Delivers Remarks at the Great American State Fair https://t.co/Hq2fBYgKI6",
      xUrl: SELF,
      postedAt: FRESH,
      isRetweet: false,
    },
    NOW,
    unreachable,
  );
  check(
    unresolved?.state === "upcoming" && unresolved.leader === "President",
    "t.co unreachable + named leader → amber UPCOMING President (never red)",
  );
  check(
    unresolved?.watchUrl === "https://t.co/Hq2fBYgKI6",
    "amber fallback watchUrl is the embedded t.co",
  );

  const articleResolved = await classifyWhiteHouseXPost(
    {
      content:
        "President Trump Participates in a Rose Garden Club Dinner https://t.co/PLuEh0MdrI",
      xUrl: SELF,
      postedAt: FRESH,
      isRetweet: false,
    },
    NOW,
    articleOnly,
  );
  check(
    articleResolved?.state === "upcoming",
    "t.co resolves to an article (not a stream) → amber UPCOMING, not LIVE",
  );

  // A routine White House policy/promotion post can contain BOTH a broad event
  // verb and a covered leader without describing a leader event. Here @Meijer
  // is the actor that "joins"; "President Trump" is only later context. It must
  // never become a STARTING SOON President banner.
  const groceryPromotion = await classifyWhiteHouseXPost(
    {
      content:
        "One of the biggest grocery stores in America is SLASHING prices, cutting costs on everyday essentials for several weeks. " +
        "@Meijer joins other grocery giants like Walmart and Sam's Club in lowering prices, part of a growing trend under President Trump. " +
        "https://t.co/wVeigjqic1",
      xUrl: "https://x.com/WhiteHouse/status/2084636602169536840",
      postedAt: FRESH,
      isRetweet: false,
    },
    NOW,
    articleOnly,
  );
  check(
    groceryPromotion === null,
    "unrelated company 'joins' + later President mention → no live-watch banner",
  );

  // A confirmed stream that is no longer FRESH (40 min old) is amber, not red.
  const stalish = await classifyWhiteHouseXPost(
    {
      content:
        "President Trump Delivers Remarks at the State Fair https://t.co/Hq2fBYgKI6",
      xUrl: SELF,
      postedAt: RECENT,
      isRetweet: false,
    },
    NOW,
    youtubeLive,
  );
  check(
    stalish?.state === "upcoming",
    "confirmed stream but outside the live window → amber UPCOMING, not red",
  );

  // --- FAIL-CLOSED: nothing surfaces --------------------------------------
  const retweet = await classifyWhiteHouseXPost(
    {
      content: "President Trump Delivers Remarks at the State Fair https://t.co/x",
      xUrl: SELF,
      postedAt: FRESH,
      isRetweet: true,
    },
    NOW,
    youtubeLive,
  );
  check(retweet === null, "retweet → nothing");

  const stale = await classifyWhiteHouseXPost(
    {
      content: "President Trump Delivers Remarks at the State Fair https://t.co/x",
      xUrl: SELF,
      postedAt: STALE,
      isRetweet: false,
    },
    NOW,
    youtubeLive,
  );
  check(stale === null, "stale post (older than upcoming window) → nothing");

  const noLink = await classifyWhiteHouseXPost(
    {
      content: "President Trump Delivers Remarks at the State Fair",
      xUrl: SELF,
      postedAt: FRESH,
      isRetweet: false,
    },
    NOW,
    youtubeLive,
  );
  check(noLink === null, "no embedded watch link → nothing");

  const replay = await classifyWhiteHouseXPost(
    {
      content: "ICYMI: President Trump's remarks at the State Fair https://t.co/x",
      xUrl: SELF,
      postedAt: FRESH,
      isRetweet: false,
    },
    NOW,
    youtubeLive,
  );
  check(replay === null, "ICYMI replay → nothing (even though it would resolve to a stream)");

  // No covered leader named + stream not confirmed → fail-closed (no blind default).
  const noLeaderUnconfirmed = await classifyWhiteHouseXPost(
    {
      content: "The White House hosts a reception for Gold Star families https://t.co/x",
      xUrl: SELF,
      postedAt: FRESH,
      isRetweet: false,
    },
    NOW,
    articleOnly,
  );
  check(
    noLeaderUnconfirmed === null,
    "no named leader + unconfirmed stream → nothing (no blind President default)",
  );

  // No covered leader named BUT a confirmed stream → President default (mirrors WH YouTube).
  const noLeaderConfirmed = await classifyWhiteHouseXPost(
    {
      content: "Watch: a special address from the Oval Office https://t.co/x",
      xUrl: SELF,
      postedAt: FRESH,
      isRetweet: false,
    },
    NOW,
    youtubeLive,
  );
  check(
    noLeaderConfirmed?.state === "live" && noLeaderConfirmed.leader === "President",
    "no named leader + CONFIRMED stream → LIVE President (allowDefault on confirmation)",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
