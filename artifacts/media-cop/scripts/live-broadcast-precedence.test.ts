// Verifies the live leadership-broadcast banner's reconciliation precedence,
// with a focus on the rule: when two (or more) leaders are speaking at the same
// time, the President ALWAYS takes precedence.
import {
  pickBest,
  factbaseEventQualifies,
  isSpeakingEvent,
  isViewableCoverage,
  factbaseEventToCandidate,
  classifyWhiteHouseXPost,
  classifyYouTubeLive,
  candidateToStatus,
  isUnverifiableStreamUrl,
  isDataMinrQuoteAlert,
  hasDataMinrScheduleFraming,
  dataminrLeaderWatchUrl,
  detectLeaderInText,
  isSocialUpcoming,
  UNVERIFIABLE_LIVE_MAX_MS,
  type Candidate,
} from "../server/liveBroadcastStatus";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`PASS [${label}]`);
  } else {
    fail++;
    console.log(`FAIL [${label}]`);
  }
}

const c = (over: Partial<Candidate>): Candidate => ({
  state: "live",
  leader: "President",
  title: "title",
  watchUrl: "https://example.com/watch",
  observedAt: 1000,
  ...over,
});

// --- The core guarantee: concurrent live leaders → President wins -----------
check(
  "two leaders live, President listed second → President wins",
  pickBest([
    c({ leader: "Secretary of War", title: "SecWar", observedAt: 5000 }),
    c({ leader: "President", title: "POTUS", observedAt: 1000 }),
  ])?.leader === "President",
);
check(
  "two leaders live, President listed first → President wins",
  pickBest([
    c({ leader: "President", title: "POTUS", observedAt: 1000 }),
    c({ leader: "Vice President", title: "VP", observedAt: 9000 }),
  ])?.leader === "President",
);
check(
  "President wins over a MORE-recently-observed live leader",
  pickBest([
    c({ leader: "Secretary of State", observedAt: 999999 }),
    c({ leader: "President", observedAt: 1 }),
  ])?.leader === "President",
);
check(
  "President wins among all four leaders live at once",
  pickBest([
    c({ leader: "Secretary of War" }),
    c({ leader: "Secretary of State" }),
    c({ leader: "Vice President" }),
    c({ leader: "President" }),
  ])?.leader === "President",
);

// --- "Speaking" means live: a live non-President still beats an upcoming POTUS
check(
  "live Secretary of State outranks an UPCOMING President",
  pickBest([
    c({ leader: "President", state: "upcoming", observedAt: 9000 }),
    c({ leader: "Secretary of State", state: "live", observedAt: 1000 }),
  ])?.leader === "Secretary of State",
);
check(
  "upcoming President still beats an upcoming Vice President (same state)",
  pickBest([
    c({ leader: "Vice President", state: "upcoming", observedAt: 9000 }),
    c({ leader: "President", state: "upcoming", observedAt: 1000 }),
  ])?.leader === "President",
);

// --- Non-President ordering unchanged: leader priority, then recency --------
check(
  "among non-President live leaders, Sec of State beats Sec of War",
  pickBest([
    c({ leader: "Secretary of War", observedAt: 9000 }),
    c({ leader: "Secretary of State", observedAt: 1000 }),
  ])?.leader === "Secretary of State",
);
check(
  "two same-leader live candidates → most recently observed wins",
  pickBest([
    c({ leader: "Vice President", title: "old", observedAt: 1000 }),
    c({ leader: "Vice President", title: "new", observedAt: 9000 }),
  ])?.title === "new",
);

// --- Degenerate input -------------------------------------------------------
check("empty candidate set → null", pickBest([]) === null);

// --- Factbase (POTUS calendar) admission gate -------------------------------
// The schedule signal must be precision-first: a false "STARTING SOON" is worse
// than a missed one. Two guards: press-access (coverage) and a real speaking
// verb (bare "briefing" no longer counts).

// The exact reported false positive: a closed-door Intelligence Briefing.
check(
  'closed-press "Intelligence Briefing" → does NOT qualify',
  factbaseEventQualifies(
    "The President receives his Intelligence Briefing",
    "Closed Press",
  ) === false,
);
// Even if it were public, a bare "briefing" is not a broadcastable event.
check(
  'open-press "Intelligence Briefing" (bare briefing) → does NOT qualify',
  factbaseEventQualifies(
    "The President receives his Intelligence Briefing",
    "Open Press",
  ) === false,
);
// Other internal closed-door items never qualify.
check(
  'closed-press "Policy Meeting" → does NOT qualify',
  factbaseEventQualifies(
    "The President participates in a Policy Meeting",
    "Closed Press",
  ) === false,
);

// The genuinely public event the banner SHOULD anticipate.
check(
  'public "delivers Remarks …" with Pre-Credentialed Media → qualifies',
  factbaseEventQualifies(
    "The President delivers Remarks at the Faith & Freedom Coalition's 2026 Policy Conference",
    "Pre-Credentialed Media",
  ) === true,
);
// Same public event, but closed press → barred (nothing to watch).
check(
  'a public-sounding "delivers Remarks …" that is Closed Press → does NOT qualify',
  factbaseEventQualifies(
    "The President delivers Remarks at a private event",
    "Closed Press",
  ) === false,
);
// Prefixed closed-press variant is still denied.
check(
  'variant "Palm Beach, Florida Closed Press" → does NOT qualify',
  factbaseEventQualifies(
    "The President delivers Remarks at Mar-a-Lago",
    "Palm Beach, Florida Closed Press",
  ) === false,
);
// Genuine press/news briefings still qualify with viewable coverage.
check(
  'genuine "press briefing" with viewable coverage → qualifies',
  factbaseEventQualifies(
    "The Press Secretary holds a press briefing",
    "On Camera",
  ) === true,
);
check(
  'genuine "news briefing" with viewable coverage → qualifies',
  factbaseEventQualifies("The President holds a news briefing", "Open Press") ===
    true,
);
// Blank coverage is allowed (don't drop legit public events with no field).
check(
  'public "delivers Remarks …" with BLANK coverage → qualifies',
  factbaseEventQualifies(
    "The President delivers Remarks on the economy",
    "",
  ) === true,
);

// --- The underlying predicates, exercised directly --------------------------
check(
  'isSpeakingEvent: bare "briefing" → false',
  isSpeakingEvent("Intelligence Briefing") === false,
);
check(
  'isSpeakingEvent: "holds a briefing" (bare) → false',
  isSpeakingEvent("The President holds a briefing") === false,
);
check(
  'isSpeakingEvent: "holds a press briefing" → true',
  isSpeakingEvent("The President holds a press briefing") === true,
);
check(
  'isSpeakingEvent: "holds a news briefing" → true',
  isSpeakingEvent("The President holds a news briefing") === true,
);
check(
  'factbaseEventQualifies: open-press "holds a briefing" (bare) → does NOT qualify',
  factbaseEventQualifies("The President holds a briefing", "Open Press") ===
    false,
);
check(
  'isSpeakingEvent: "press briefing" → true',
  isSpeakingEvent("today's press briefing") === true,
);
check(
  'isSpeakingEvent: "news briefing" → true',
  isSpeakingEvent("a news briefing") === true,
);
check(
  'isSpeakingEvent: "press conference" → true',
  isSpeakingEvent("a press conference") === true,
);
check(
  'isSpeakingEvent: "news conference" → true',
  isSpeakingEvent("holds a news conference") === true,
);
check(
  'isSpeakingEvent: "remarks" → true',
  isSpeakingEvent("delivers remarks") === true,
);
check("isViewableCoverage: blank → true", isViewableCoverage("") === true);
check(
  "isViewableCoverage: Open Press → true",
  isViewableCoverage("Open Press") === true,
);
check(
  "isViewableCoverage: Closed Press → false",
  isViewableCoverage("Closed Press") === false,
);
check(
  "isViewableCoverage: case-insensitive closed press → false",
  isViewableCoverage("CLOSED   press") === false,
);

// --- Factbase calendar admission (integrated candidate) ---------------------
// Replicates the production ET-wall-time → epoch conversion so we can place an
// event a known number of minutes ahead of a synthetic "now".
function etWallTimeToMs(dateStr: string, timeStr: string): number {
  const pretendUtc = new Date(`${dateStr}T${timeStr}Z`);
  const tzView = new Date(
    pretendUtc.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const offset = pretendUtc.getTime() - tzView.getTime();
  return pretendUtc.getTime() + offset;
}

const EVT_DATE = "2026-06-26";
const EVT_TIME = "13:30:00"; // 1:30 PM ET
const evtStart = etWallTimeToMs(EVT_DATE, EVT_TIME);
// "now" 5 min before the listed start → inside the 15-min lookahead window.
const nowWithin = evtStart - 5 * 60 * 1000;

check(
  "Closed Press intelligence briefing → no candidate",
  factbaseEventToCandidate(
    {
      date: EVT_DATE,
      time: "11:00:00",
      details: "The President receives his Intelligence Briefing",
      coverage: "Closed Press",
    },
    etWallTimeToMs(EVT_DATE, "11:00:00") - 5 * 60 * 1000,
  ) === null,
);

check(
  "Closed Press variant (location-prefixed) → no candidate",
  factbaseEventToCandidate(
    {
      date: EVT_DATE,
      time: EVT_TIME,
      details: "The President delivers Remarks at the conference",
      coverage: "Palm Beach, Florida Closed Press",
    },
    nowWithin,
  ) === null,
);

check(
  "bare 'Intelligence Briefing' (no closed-press) → no candidate (matcher tightened)",
  factbaseEventToCandidate(
    {
      date: EVT_DATE,
      time: "11:00:00",
      details: "The President receives his Intelligence Briefing",
    },
    etWallTimeToMs(EVT_DATE, "11:00:00") - 5 * 60 * 1000,
  ) === null,
);

check(
  "public 'delivers Remarks' with viewable coverage → upcoming candidate",
  factbaseEventToCandidate(
    {
      date: EVT_DATE,
      time: EVT_TIME,
      details:
        "delivers Remarks at the Faith & Freedom Coalition's 2026 Policy Conference",
      coverage: "Pre-Credentialed Media",
    },
    nowWithin,
  )?.state === "upcoming",
);

check(
  "public speaking entry with BLANK coverage still qualifies",
  factbaseEventToCandidate(
    {
      date: EVT_DATE,
      time: EVT_TIME,
      details: "delivers Remarks to the press pool",
      coverage: "",
    },
    nowWithin,
  )?.state === "upcoming",
);

check(
  "genuine 'press briefing' still qualifies",
  factbaseEventToCandidate(
    {
      date: EVT_DATE,
      time: EVT_TIME,
      details: "holds a press briefing in the Briefing Room",
      coverage: "On Camera",
    },
    nowWithin,
  )?.state === "upcoming",
);

check(
  "genuine 'news briefing' still qualifies",
  factbaseEventToCandidate(
    {
      date: EVT_DATE,
      time: EVT_TIME,
      details: "delivers a news briefing",
      coverage: "White House Press Pool",
    },
    nowWithin,
  )?.state === "upcoming",
);

check(
  "public event beyond the 15-min lookahead → no candidate",
  factbaseEventToCandidate(
    {
      date: EVT_DATE,
      time: EVT_TIME,
      details: "delivers Remarks at the conference",
      coverage: "Open Press",
    },
    evtStart - 20 * 60 * 1000, // 20 min ahead, outside the 15-min window
  ) === null,
);

// --- Unverifiable X broadcast / Space stream links --------------------------
check(
  "isUnverifiableStreamUrl: x.com /i/broadcasts → true",
  isUnverifiableStreamUrl("https://x.com/i/broadcasts/1abcDEFghij") === true,
);
check(
  "isUnverifiableStreamUrl: x.com /i/spaces → true",
  isUnverifiableStreamUrl("https://x.com/i/spaces/1abcDEFghij") === true,
);
check(
  "isUnverifiableStreamUrl: youtube /live → false (verifiable)",
  isUnverifiableStreamUrl("https://www.youtube.com/@WhiteHouse/live") === false,
);
check(
  "isUnverifiableStreamUrl: null → false",
  isUnverifiableStreamUrl(null) === false,
);

// --- White House X post: unverifiable broadcast link is bounded -------------
const noResolve = async () => null;
const whBase = 1_000_000_000_000; // arbitrary epoch
const whBroadcastPost = {
  content:
    "The President delivers remarks now. Watch live: https://x.com/i/broadcasts/1abcDEFghij",
  xUrl: "https://x.com/WhiteHouse/status/123",
  postedAt: new Date(whBase).toISOString(),
};

const whFresh = await classifyWhiteHouseXPost(whBroadcastPost, whBase, noResolve);
check(
  "WH unverifiable broadcast link, fresh → LIVE",
  whFresh?.state === "live" && whFresh?.leader === "President",
);

const whStale = await classifyWhiteHouseXPost(
  whBroadcastPost,
  whBase + UNVERIFIABLE_LIVE_MAX_MS + 60_000,
  noResolve,
);
check(
  "WH unverifiable broadcast link past its cap → CLEARED (null, NOT upcoming)",
  whStale === null,
);

// A Factbase upcoming candidate must never be a live state.
check(
  "Factbase candidate is upcoming, never live",
  factbaseEventToCandidate(
    {
      date: EVT_DATE,
      time: EVT_TIME,
      details: "delivers Remarks at the conference",
      coverage: "Open Press",
    },
    nowWithin,
  )?.state !== "live",
);

// --- classifyYouTubeLive two-factor + title attribution ---------------------
const ytSrcNoDefault = {
  liveUrl: "https://www.youtube.com/@FoxNews/live",
  org: "Fox News",
  defaultLeader: "President" as const,
  allowDefault: false,
};
const ytNotLiveHtml =
  '<link rel="canonical" href="https://www.youtube.com/@FoxNews"/>';
check(
  "classifyYouTubeLive: not-live page (no /watch canonical) → null",
  classifyYouTubeLive(ytNotLiveHtml, ytSrcNoDefault, whBase) === null,
);

const ytLiveLeaderHtml =
  '<link rel="canonical" href="https://www.youtube.com/watch?v=abcd1234XYZ"/>' +
  '"isLive":true' +
  '<meta property="og:title" content="WATCH: President Trump delivers remarks"/>';
const ytLeader = classifyYouTubeLive(ytLiveLeaderHtml, ytSrcNoDefault, whBase);
check(
  "classifyYouTubeLive: live + leader in title → live (President)",
  ytLeader?.state === "live" && ytLeader?.leader === "President",
);

const ytLiveNoLeaderHtml =
  '<link rel="canonical" href="https://www.youtube.com/watch?v=abcd1234XYZ"/>' +
  '"isLive":true' +
  '<meta property="og:title" content="Breaking News Coverage"/>';
check(
  "classifyYouTubeLive: live + no leader + allowDefault:false → null",
  classifyYouTubeLive(ytLiveNoLeaderHtml, ytSrcNoDefault, whBase) === null,
);

// --- detectLeaderInText: multi-leader precedence (POTUS always wins) --------
// The reported bug: a single title naming both the President and another covered
// leader was attributed to the OTHER leader (first-match ordering VP→…→President).
check(
  "dual-leader title, POTUS named FIRST → President",
  detectLeaderInText(
    "President Donald J. Trump, Secretary of War Pete Hegseth Speak During a Defense & Innovation Summit",
  ) === "President",
);
check(
  "dual-leader title, POTUS named LAST → President",
  detectLeaderInText(
    "Secretary of War Pete Hegseth and President Trump deliver remarks",
  ) === "President",
);
check(
  "dual-leader title (VP + POTUS) → President",
  detectLeaderInText(
    "Vice President Vance and President Trump hold a joint event",
  ) === "President",
);
// Single-leader attributions are unchanged.
check(
  "SecWar-only title → Secretary of War",
  detectLeaderInText("Secretary of War Pete Hegseth delivers remarks") ===
    "Secretary of War",
);
check(
  "SecState-only title → Secretary of State",
  detectLeaderInText("Secretary of State Marco Rubio holds a briefing") ===
    "Secretary of State",
);
check(
  "President-only title → President",
  detectLeaderInText("President Trump delivers remarks") === "President",
);
// The VP-substring guard: the generic "president of the united states" token
// must NOT let a "vice president …" phrase count as a President match.
check(
  '"Vice President of the United States" alone → Vice President (never President)',
  detectLeaderInText(
    "The Vice President of the United States delivers remarks",
  ) === "Vice President",
);
check(
  '"president of the united states" (genuine POTUS phrase) → President',
  detectLeaderInText("The President of the United States addresses the nation") ===
    "President",
);
// No covered leader named → null.
check(
  "no covered leader → null",
  detectLeaderInText("Breaking news coverage of the summit") === null,
);

// --- candidateToStatus startsAt projection ----------------------------------
const upWithStart = candidateToStatus({
  state: "upcoming",
  leader: "President",
  title: "t",
  watchUrl: "https://www.whitehouse.gov/live/",
  observedAt: whBase,
  startsAt: whBase + 15 * 60 * 1000,
});
check(
  "candidateToStatus: upcoming WITH real startsAt → status carries startsAt",
  upWithStart.state === "upcoming" && typeof upWithStart.startsAt === "string",
);

const upNoStart = candidateToStatus({
  state: "upcoming",
  leader: "President",
  title: "t",
  watchUrl: "https://www.whitehouse.gov/live/",
  observedAt: whBase,
});
check(
  "candidateToStatus: upcoming WITHOUT startsAt → startsAt omitted (no fake countdown)",
  upNoStart.state === "upcoming" && upNoStart.startsAt === undefined,
);

// --- DataMinr quote-alert gate (Fix 1) -------------------------------------
// The exact production false positive: "Trump says Iraq has 'tremendous
// potential because of their oil'" with "during press conference with Iraqi PM"
// in the subHeadline. The combined text must be rejected as a quote alert.
const PROD_QUOTE_TEXT =
  "Trump says Iraq has 'tremendous potential because of their oil' " +
  "during press conference with Iraqi PM";

check(
  "production quote alert: isDataMinrQuoteAlert → true (reporting verb + during event)",
  isDataMinrQuoteAlert(PROD_QUOTE_TEXT) === true,
);
check(
  "production quote alert: hasDataMinrScheduleFraming → false (no forward-looking framing)",
  hasDataMinrScheduleFraming(PROD_QUOTE_TEXT) === false,
);

// Explicit "during [event]" alone is sufficient to flag as a quote alert.
check(
  '"during press conference" alone → isDataMinrQuoteAlert: true',
  isDataMinrQuoteAlert(
    "President Trump speaks during press conference with Iraqi PM",
  ) === true,
);
check(
  '"during meeting" alone → isDataMinrQuoteAlert: true',
  isDataMinrQuoteAlert("President Trump during the meeting") === true,
);

// Reporting verb alone is also sufficient.
check(
  '"President says X" → isDataMinrQuoteAlert: true',
  isDataMinrQuoteAlert("President Trump says the deal is historic") === true,
);
check(
  '"Secretary of State told reporters …" → isDataMinrQuoteAlert: true',
  isDataMinrQuoteAlert(
    "Secretary of State Rubio told reporters the talks were productive",
  ) === true,
);

// Null / empty input must not throw.
check(
  "isDataMinrQuoteAlert: null → false",
  isDataMinrQuoteAlert(null) === false,
);
check(
  "isDataMinrQuoteAlert: empty → false",
  isDataMinrQuoteAlert("") === false,
);

// --- Genuine schedule alerts still pass the gate (Fix 1 does not over-block) --
check(
  '"will hold joint press conference" → isDataMinrQuoteAlert: false',
  isDataMinrQuoteAlert(
    "President Trump will hold joint press conference with Iraqi PM",
  ) === false,
);
check(
  '"scheduled to deliver remarks" → isDataMinrQuoteAlert: false',
  isDataMinrQuoteAlert(
    "President Trump scheduled to deliver remarks at the White House at 3pm",
  ) === false,
);

// --- Forward-looking schedule framing (Fix 2) ---------------------------------
check(
  '"will hold press conference" → hasDataMinrScheduleFraming: true',
  hasDataMinrScheduleFraming(
    "President Trump will hold press conference at 3pm",
  ) === true,
);
check(
  '"scheduled to deliver remarks" → hasDataMinrScheduleFraming: true',
  hasDataMinrScheduleFraming(
    "President scheduled to deliver remarks this afternoon",
  ) === true,
);
check(
  '"at 3:00 PM" → hasDataMinrScheduleFraming: true',
  hasDataMinrScheduleFraming(
    "POTUS press conference at 3:00 PM",
  ) === true,
);
check(
  '"to hold joint press conference" → hasDataMinrScheduleFraming: true',
  hasDataMinrScheduleFraming(
    "President Trump to hold joint press conference with Iraqi PM at the White House",
  ) === true,
);
check(
  'bare mid-event quote → hasDataMinrScheduleFraming: false',
  hasDataMinrScheduleFraming(PROD_QUOTE_TEXT) === false,
);
check(
  "hasDataMinrScheduleFraming: null → false",
  hasDataMinrScheduleFraming(null) === false,
);

// --- Watch URL is always a watchable destination, never a DataMinr redirect ---
// (Fix 3)
check(
  "dataminrLeaderWatchUrl: President → whitehouse.gov/live (never r.dataminr.com)",
  (() => {
    const url = dataminrLeaderWatchUrl("President");
    return (
      url !== null &&
      !url.includes("dataminr.com") &&
      url.startsWith("https://")
    );
  })(),
);
check(
  "dataminrLeaderWatchUrl: President → whitehouse.gov/live specifically",
  dataminrLeaderWatchUrl("President") === "https://www.whitehouse.gov/live/",
);
// Leaders without a configured live page return null (candidate is suppressed).
check(
  "dataminrLeaderWatchUrl: Vice President → null (no safe fallback configured)",
  dataminrLeaderWatchUrl("Vice President") === null,
);
check(
  "dataminrLeaderWatchUrl: Secretary of State → null (no safe fallback configured)",
  dataminrLeaderWatchUrl("Secretary of State") === null,
);
check(
  "dataminrLeaderWatchUrl: Secretary of War → null (no safe fallback configured)",
  dataminrLeaderWatchUrl("Secretary of War") === null,
);

// --- Social "upcoming" must not fire on a REPLAY / recap of a DELIVERED event -
// The reported false positive: @DOWResponse posted a RECORDING of already-
// delivered remarks — ".@SECWAR FULL REMARKS AT THE PENNSYLVANIA DEFENSE AND
// INNOVATION SUMMIT." — and the amber "STARTING SOON" banner lit up. "FULL
// REMARKS" means the speech is OVER: a recap is neither live nor upcoming. Each
// recap case below ALSO matches the upcoming-language regex (e.g. "remarks at"),
// so the REPLAY guard is the deciding factor — without it these were "upcoming".
check(
  'recap "FULL REMARKS AT THE … SUMMIT" → NOT upcoming (the reported bug)',
  isSocialUpcoming(
    ".@SECWAR FULL REMARKS AT THE PENNSYLVANIA DEFENSE AND INNOVATION SUMMIT.",
  ) === false,
);
check(
  'recap "ICYMI: full remarks at …" → NOT upcoming',
  isSocialUpcoming("ICYMI: full remarks at the Pennsylvania summit") === false,
);
check(
  'recap "Recap — … remarks today at …" → NOT upcoming',
  isSocialUpcoming("Recap — the President's remarks today at the forum") ===
    false,
);
// The REPLAY guard must NOT over-block genuine near-term anticipation cues.
check(
  'genuine "to deliver remarks shortly" → upcoming',
  isSocialUpcoming("Secretary of War to deliver remarks shortly") === true,
);
check(
  'genuine "will address the nation … tonight" → upcoming',
  isSocialUpcoming("President will address the nation at 8pm tonight") === true,
);

// --- Social "upcoming" must not fire on the EVERYDAY sense of address/deliver/hold
// The second reported false positive: a spokesman's ADVOCACY post about Navy
// barracks funding lit "STARTING SOON — President" because
// "…targeted upgrades to address life, health, and safety issues…" matched the
// upcoming-language regex. "address a problem" is NOT "address an audience":
// address / deliver / hold / join only count when tied to a speaking object.
check(
  'advocacy "upgrades to address life, health, and safety issues" → NOT upcoming (the reported bug)',
  isSocialUpcoming(
    "the Navy is executing critical, targeted upgrades to address life, health, and safety issues that were ignored for years",
  ) === false,
);
check(
  'non-speech "to deliver savings" → NOT upcoming',
  isSocialUpcoming("new reforms to deliver savings for taxpayers") === false,
);
check(
  'non-speech "will hold the line" → NOT upcoming',
  isSocialUpcoming("our forces will hold the line against aggression") === false,
);
check(
  'non-speech "to join the coalition" → NOT upcoming',
  isSocialUpcoming("more allies to join the coalition this year") === false,
);
// address / deliver / hold + a real speaking object still fire.
check(
  'genuine "will address the troops" → upcoming',
  isSocialUpcoming("The Secretary will address the troops at noon") === true,
);
check(
  'genuine "to hold a press conference" → upcoming',
  isSocialUpcoming("The President is to hold a press conference") === true,
);
check(
  'genuine "will deliver a speech" → upcoming',
  isSocialUpcoming("The President will deliver a speech from the Oval Office") ===
    true,
);
check(
  'genuine "will address the American people" → upcoming',
  isSocialUpcoming("The President will address the American people tonight") ===
    true,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
