/**
 * Live Leadership Broadcast status aggregator (CURATED LANE ONLY).
 *
 * Computes a single "is a covered leader live right now?" status for the
 * Curated (Top Stories) header banner. Covered leaders: President, Vice
 * President, Secretary of State, Secretary of War (Secretary of Defense).
 *
 * The result the client consumes is ONE object (or null when nothing is
 * happening):
 *   { state: 'upcoming' | 'live' | 'recently_ended', leader, title,
 *     watchUrl, startsAt?, since?, endsAt? }
 *
 * Detection mixes several independent signal functions so new broadcast
 * sources can be added later without rework:
 *   1. Scheduled / anticipation — the already-ingested senior-leader public-
 *      affairs / POTUS schedule (DataMinr First Alerts, keyed on each alert's
 *      eventTime) AND the public Factbase (Roll Call) POTUS calendar JSON feed,
 *      plus the shared scheduled-event "pre/during" phase classifier → a near-
 *      term "upcoming" cue with a real startsAt. Recent leader posts carrying
 *      pre-event language are a secondary anticipation source.
 *   2. Social relay "watch live" — Truth Social (POTUS) + @Rapidresponse47
 *      → President; Hegseth-on-X + @DOWResponse → Secretary of War; VP /
 *      SecState X relay posts. Official SPOKES / ORG accounts (e.g. the White
 *      House Press Secretary @PressSec, the State Department @StateDept, the
 *      Joint Staff) act as early indicators too, but — like the department
 *      YouTube channels — only when the post explicitly NAMES a covered leader,
 *      so a press-secretary's own briefing never reads as the President LIVE.
 *      A social post only fires the LIVE state when it BOTH uses live language
 *      AND embeds an actual streaming link (so the banner points at a real
 *      stream, not the post); otherwise it is treated as schedule/anticipation
 *      and the keyless web checks below confirm the real stream.
 *   3. Keyless on-air web check (all fail soft) — the White House live page;
 *      the official YouTube /live pages for the White House (President/VP),
 *      U.S. Department of State (Sec State) and U.S. Department of War (Sec War),
 *      attributing by the live video title; and the C-SPAN / PBS News network
 *      live pages, which only fire when their program title names a covered
 *      leader. All via the app's resilient fetch stack.
 *   4. Keyed external source (e.g. YouTube Data API) — a pluggable, fail-soft
 *      slot that stays dormant unless a key is configured (none required here).
 *   5. Recently-ended — derived from in-memory memory of the last live event.
 *
 * Backed by a short-TTL in-memory cache (mirrors server/tickerCache.ts). The
 * deploy is a single-instance VM so a per-process cache is correct.
 *
 * ISOLATION: nothing here is read by Classic / Visual / custom-MCOP / the
 * public API. It only reads existing shared social tables and public web
 * pages and is exposed through the curated-access-gated endpoint, so it cannot
 * leak cross-lane.
 */
import { storage } from "./storage";
import { scheduledEventPhase } from "./curatedCluster";
import { fetchWithResilience } from "./resilientFetch";
import {
  applyLiveBroadcastModeration,
  deriveLiveBroadcastEventKey,
  resolveLiveBroadcastEventKey,
} from "./liveBroadcastModeration";

export type BroadcastLeader =
  | "President"
  | "Vice President"
  | "Secretary of State"
  | "Secretary of War"
  // Added for the HASC/SASC committee-hearing signal (Task #1077): a tracked
  // hearing whose witness list includes the CJCS may light the banner under
  // this label. Only ever produced by detectCommitteeHearings.
  | "Chairman of the Joint Chiefs";

export type BroadcastState = "upcoming" | "live" | "recently_ended";

export interface LiveBroadcastStatus {
  state: BroadcastState;
  leader: BroadcastLeader;
  title: string;
  watchUrl: string;
  /** When state === 'upcoming': ISO time the broadcast is expected to start. */
  startsAt?: string;
  /** When state === 'live': ISO time we first saw it go live. */
  since?: string;
  /** When state === 'recently_ended': ISO time it dropped off air. */
  endsAt?: string;
}

/** Internal candidate produced by a signal function before reconciliation. */
export interface Candidate {
  state: "upcoming" | "live";
  leader: BroadcastLeader;
  title: string;
  watchUrl: string;
  /** Time the underlying post/event was observed (drives recency + windows). */
  observedAt: number;
  /** For upcoming candidates: best-guess start time, if any. */
  startsAt?: number;
  /** Signal descriptor for audit logging — which source produced this candidate. */
  source?: string;
}

// --- Tunables ---------------------------------------------------------------
// A live cue is only trusted while fresh; broadcasts are short and a stale
// "watch live" post must not pin the banner red for hours.
const LIVE_WINDOW_MS = 25 * 60 * 1000; // 25 min
// An X broadcast / Spaces link can never be confirmed still-on-air server-side
// (X returns HTTP 200 whether the broadcast is live or ended, and is login-
// walled). So such a link may assert LIVE only for a bounded window measured
// from the announcing post, then it is CLEARED — never allowed to fall through
// into the long "upcoming" fallback pointing at a broadcast that has ended.
export const UNVERIFIABLE_LIVE_MAX_MS = 30 * 60 * 1000; // 30 min
// How far back to SCAN for recent posts. A post older than this never lights the
// banner. (This is the scan/look-back bound, NOT how long a cue is shown.)
const UPCOMING_WINDOW_MS = 90 * 60 * 1000; // 90 min
// How long a social / announcement cue that carries NO genuine scheduled start
// time (only a post timestamp) may light the amber "upcoming" banner. Long
// enough to anticipate an imminent event, short enough that one post can't pin
// the banner for an hour-plus. Cues that DO carry a real scheduled start
// (Factbase / DataMinr alert) are governed by the schedule lookahead/grace and
// their own real startsAt instead.
const SOCIAL_UPCOMING_WINDOW_MS = 30 * 60 * 1000; // 30 min
// After a live event disappears, show a dim "just ended / replay" cue for a
// short window, then hide entirely.
const RECENTLY_ENDED_MS = 45 * 60 * 1000; // 45 min
// How many recent posts to scan per lane.
const SCAN_LIMIT = 12;
// Near-term window for the schedule / PA-events anticipation signal: a covered
// leader scheduled to speak within ~the next 15 min (with a small grace for an
// event whose listed start has just slipped past) lights the amber cue. Kept
// tight on purpose so the cue fires close to air time, not far ahead. Shared by
// both the Factbase calendar signal and the social "scheduled upcoming" signal.
const SCHEDULE_LOOKAHEAD_MS = 15 * 60 * 1000; // 15 min ahead
const SCHEDULE_GRACE_PAST_MS = 10 * 60 * 1000; // 10 min after listed start
// How many recent first-alert / schedule rows to scan.
const SCHEDULE_SCAN_LIMIT = 40;

// Highest-priority leader wins when several qualify at once.
const LEADER_PRIORITY: Record<BroadcastLeader, number> = {
  President: 4,
  "Vice President": 3,
  "Secretary of State": 2,
  "Secretary of War": 1,
  // Below SecWar: when both testify at the same hearing the banner reads SecWar.
  "Chairman of the Joint Chiefs": 0.5,
};
// A live event always outranks an upcoming one regardless of leader.
const STATE_PRIORITY: Record<"upcoming" | "live", number> = {
  live: 100,
  upcoming: 0,
};

// X relay handle → covered leader (OWNER handles only). Lowercased lookup. A
// post from one of these accounts may be attributed to its owner even when the
// post text does not re-name the leader, because the handle *is* the leader.
const X_HANDLE_LEADER: Record<string, BroadcastLeader> = {
  secwar: "Secretary of War",
  petehegseth: "Secretary of War",
  secrubio: "Secretary of State",
  senmarcorubio: "Secretary of State",
  // VP handles — none are ingested today, but mapped so the signal lights up
  // automatically if a VP lane is ever added (degrades gracefully meanwhile).
  vp: "Vice President",
  vp47: "Vice President",
  jdvance: "Vice President",
  vance47: "Vice President",
};

// Official SPOKES / ORG accounts that are NOT themselves covered leaders but
// regularly post the earliest "tune in / watch live" cue for one — e.g. the
// White House Press Secretary announcing the President's remarks, or the State
// Department announcing the Secretary's. These are ingested into x_posts but are
// deliberately attributed ONLY by the covered leader NAMED in the post text
// (never by the handle owner), exactly like the department YouTube channels and
// the C-SPAN/PBS network pages. This keeps them as genuine early indicators
// while guaranteeing a press-secretary's *own* briefing never reads as the
// President being "LIVE". Lowercased; derived from the literal handles so the
// triple-letter "PressSec" → "presssec" can't be mistyped.
const SOCIAL_SPOKES_HANDLES: Set<string> = new Set(
  [
    "PressSec", // White House Press Secretary → President (when named)
    "StateDept", // U.S. Department of State → Secretary of State (when named)
    "TheJointStaff", // Joint Staff → Secretary of War (when named)
    "SecArmy", // service secretary → Secretary of War (when named)
    "SecAFOfficial", // service secretary → Secretary of War (when named)
    "SeanParnellASW", // War Dept spokesman → Secretary of War (when named)
  ].map((h) => h.toLowerCase()),
);

/**
 * Attribute an X post to a covered leader for the social live-broadcast signal.
 *   - OWNER handle (the account IS the leader) → that leader, even when the post
 *     text does not re-name them.
 *   - SPOKES / ORG handle (PressSec, StateDept, …) → the covered leader the post
 *     text explicitly NAMES, or null when none is named (no blind default, so a
 *     press-secretary's own briefing never reads as the President being LIVE).
 *   - Any other handle → null (fail-closed; never guesses).
 * Pure (no I/O) and exported for regression testing.
 */
export function attributeXPostLeader(
  sourceAccount: string | null | undefined,
  content: string | null | undefined,
): BroadcastLeader | null {
  const handle = (sourceAccount || "").trim().replace(/^@+/, "").toLowerCase();
  const owner = X_HANDLE_LEADER[handle];
  if (owner) return owner;
  if (SOCIAL_SPOKES_HANDLES.has(handle)) return detectLeaderInText(content || "");
  return null;
}

// Covered leaders detected by NAME/TITLE in free text (used for the schedule /
// PA-events feed, which carries no source-handle). Ordered most→least specific.
// Kept conservative: a bare surname is allowed only because the schedule signal
// additionally requires explicit upcoming + speaking language and a near-term
// event time, so "President to deliver remarks" can't be confused with routine
// coverage that merely mentions a leader.
// The President-specific token (an unambiguous POTUS reference) is kept SEPARATE
// from the generic "president of the united states" phrase. The generic phrase
// is a substring of "vice president of the united states", so it must never on
// its own count as a President match — it fires only when NOT preceded by
// "vice " (negative lookbehind). A President-specific token ("President Trump",
// "POTUS", "President Donald …") always counts, regardless.
const PRESIDENT_SPECIFIC_RE =
  /\b(president\s+trump|potus|president\s+donald)\b/i;
const PRESIDENT_GENERIC_RE =
  /(?<!vice\s)\bpresident\s+of\s+the\s+united\s+states\b/i;

const LEADER_NAME_PATTERNS: { leader: BroadcastLeader; re: RegExp }[] = [
  {
    leader: "Vice President",
    re: /\b(vice\s+president|vice\s+president\s+vance|vp\s+vance|j\.?d\.?\s+vance)\b/i,
  },
  {
    leader: "Secretary of State",
    re: /\b(secretary\s+of\s+state|sec(?:retary)?\s+rubio|secstate|marco\s+rubio)\b/i,
  },
  {
    leader: "Secretary of War",
    re: /\b(secretary\s+of\s+(?:war|defense)|sec(?:retary)?\s+hegseth|secdef|secwar|defense\s+secretary|war\s+secretary|pete\s+hegseth|hegseth)\b/i,
  },
  // NOTE: the President is NOT a row here — it's detected specially (specific vs.
  // guarded-generic token) and always wins in detectLeaderInText below.
];

// Detect the leader named in free text, PRECEDENCE-AWARE. A single title may
// name several covered leaders at once (e.g. "President Trump, Secretary of War
// Pete Hegseth Speak …"); rather than returning the first pattern that matches
// in list order, collect EVERY leader whose pattern matches and return the
// highest-precedence one. The President ALWAYS wins when named — an explicit,
// hard guarantee mirroring pickBest, so a future LEADER_PRIORITY tweak can never
// silently demote POTUS below another leader sharing the same event. Below the
// President, the existing numeric LEADER_PRIORITY breaks ties.
export function detectLeaderInText(text: string): BroadcastLeader | null {
  const presidentMatched =
    PRESIDENT_SPECIFIC_RE.test(text) || PRESIDENT_GENERIC_RE.test(text);
  if (presidentMatched) return "President";
  const matched = LEADER_NAME_PATTERNS.filter(
    ({ leader, re }) => leader !== "President" && re.test(text),
  ).map(({ leader }) => leader);
  if (matched.length === 0) return null;
  return matched.sort((a, b) => LEADER_PRIORITY[b] - LEADER_PRIORITY[a])[0];
}

// "It's happening now" language. Reuses the same vocabulary the Live/Watch
// title parser keys on, broadened to the way leaders announce their own
// streams on social.
const LIVE_LANGUAGE_RE =
  /\b(watch\s+live|live\s+now|now\s+live|going\s+live|streaming\s+(now|live)|live\s+stream|join\s+(us\s+)?live|tune\s+in\s+(now|live)|happening\s+now|live\s+(coverage|from|at\s+the))\b|^\s*(watch\s+live|live|watch)\s*:/i;

// A speaking OBJECT — what a covered leader speaks / delivers / holds / joins
// when about to be on camera. The everyday verbs address / deliver / hold / join
// have common NON-speech senses ("upgrades to address life, health and safety
// issues", "to deliver savings", "hold the line", "join the effort / coalition")
// so they only count as an "about to broadcast" cue when tied to one of these
// speaking objects. Precision-first: a false "STARTING SOON" is worse than a
// missed one.
const UPCOMING_SPEAKING_OBJECT_SRC =
  "(?:remarks?|a\\s+speech|an?\\s+address|a\\s+statement" +
  "|(?:the\\s+|a\\s+)?(?:press|news)\\s+(?:conference|briefing)|presser" +
  "|(?:a\\s+)?(?:town\\s+hall|rally|roundtable|fireside(?:\\s+chat)?)" +
  "|the\\s+(?:nation|country|press|media|press\\s+pool|american\\s+people|public|world)|reporters" +
  "|the\\s+(?:troops|sailors|soldiers|marines|airmen|force|crowd|audience)" +
  "|congress|(?:us\\s+)?live)";

// "It's about to happen" language → an upcoming cue. Bare speech verbs (speak /
// make remarks) count on their own; the ambiguous verbs (address / deliver /
// hold / join) require a speaking object (above), so their everyday non-speech
// senses can't light the amber banner. Standalone schedule markers — "scheduled
// to", "press conference/briefing", "remarks at/today/this", an explicit clock
// time, "coming up", "shortly" — also qualify.
const UPCOMING_LANGUAGE_RE = new RegExp(
  "\\b(?:" +
    "(?:will|to|set\\s+to)\\s+(?:speak|make\\s+remarks)" +
    "|(?:will|to|set\\s+to)\\s+(?:address|deliver|hold|join)\\s+" +
    UPCOMING_SPEAKING_OBJECT_SRC +
    "|scheduled\\s+to" +
    "|press\\s+(?:conference|briefing)" +
    "|remarks?\\s+(?:at|today|this)" +
    "|delivering\\s+remarks" +
    "|tune\\s+in\\s+(?:at|today)" +
    "|live\\s+at\\s+\\d" +
    "|starts?\\s+(?:at|soon)" +
    "|coming\\s+up" +
    "|shortly" +
    ")\\b",
  "i",
);

// Month names (full + common abbreviations) used to spot an explicit calendar
// date inside a free-text social post.
const MONTH_RE_SRC =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

// A leader's post can carry "about to happen" language ("to speak", "will
// address") while actually PREVIEWING a specific FUTURE calendar date ("July
// 4th will be … I'll be there to speak", "next week", "tomorrow") rather than an
// imminent broadcast. The free-text social signals have no reliable event time,
// so a post that names a future date must NOT light the near-term "upcoming"
// banner — the schedule / Factbase signals (which DO carry a real start time)
// own the cue when the event actually approaches. Same-day language ("today",
// "tonight", "this afternoon/evening", "now", "shortly") is deliberately NOT
// matched here, so a genuine same-day announcement still fires.
const FUTURE_DATE_RE = new RegExp(
  "\\b(?:" +
    // month + day  → "July 4", "Jul 4th", "January 6"
    "(?:" + MONTH_RE_SRC + ")\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?" +
    "|" +
    // day + of + month  → "4th of July"
    "\\d{1,2}(?:st|nd|rd|th)?\\s+of\\s+(?:" + MONTH_RE_SRC + ")" +
    "|" +
    // holiday-style spelled-out "(the) fourth of July"
    "fourth\\s+of\\s+july" +
    "|" +
    // explicit relative-future windows (NOT same-day terms)
    "tomorrow|next\\s+(?:week|month|year)|this\\s+(?:coming\\s+)?(?:weekend|week|month)" +
    "|" +
    // a qualified future weekday  → "on Monday", "this Saturday", "next Friday"
    "(?:this|next|on|coming)\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)" +
    ")\\b",
  "i",
);

/**
 * True when free text points at a specific FUTURE calendar date / day rather
 * than an imminent broadcast (e.g. "July 4th", "next week", "on Monday"). Used
 * to suppress the social "upcoming" banner cue for posts that merely PREVIEW a
 * future event. Same-day language ("today", "tonight", "this evening") is
 * intentionally not treated as future. Pure; exported for regression tests.
 */
export function mentionsFutureDate(text: string | null | undefined): boolean {
  return FUTURE_DATE_RE.test(text || "");
}

// A speaking / broadcastable public-affairs event (vs. a leader merely being
// mentioned in coverage). Gates the schedule signal so only genuine "about to
// be on camera" events qualify. NOTE: a BARE "briefing" is deliberately NOT a
// match — only an explicit "press briefing" / "news briefing" — so an internal
// "Intelligence Briefing" (and similar non-public events) never qualifies.
const SPEAKING_EVENT_RE =
  /\b(remarks?|address(?:es|ing)?|speech|speak(?:s|ing)?|(?:press|news)\s+(?:conference|briefing)|presser|statement|deliver(?:s|ing)?|hold(?:s|ing)?\s+(?:a\s+)?(?:press|news|event)|summit|signing\s+ceremony|bill\s+signing|sign(?:s|ing)\s+(?:the|a|an|into|legislation|bill|h\.r\.|executive\s+order|memorand)|town\s+hall|rally|joint\s+(?:address|appearance)|sworn\s+in|swearing-in|fireside|roundtable)\b/i;

/**
 * True when free text describes a genuine speaking / broadcastable event. A bare
 * "briefing" (e.g. an internal "Intelligence Briefing") does NOT qualify — only
 * an explicit "press briefing" / "news briefing". Pure; exported for tests.
 */
export function isSpeakingEvent(text: string | null | undefined): boolean {
  return SPEAKING_EVENT_RE.test(text || "");
}

/**
 * Press-access gate for a Factbase POTUS calendar entry. A "Closed Press" event
 * has nothing to watch, so it must never light the banner (case-insensitive,
 * incl. prefixed variants like "Palm Beach, Florida Closed Press"). Empty / other
 * coverage values are allowed so legitimately public events with a blank coverage
 * field are not dropped. Pure; exported for tests.
 */
export function isViewableCoverage(coverage: string | null | undefined): boolean {
  return !/closed\s+press/i.test((coverage || "").trim());
}

/**
 * Combined admission gate for a Factbase calendar entry: it must have details,
 * be publicly viewable (not Closed Press), and look like a real speaking event.
 * Pure; exported for tests.
 */
export function factbaseEventQualifies(
  details: string | null | undefined,
  coverage?: string | null,
): boolean {
  const d = (details || "").trim();
  if (!d) return false;
  if (!isViewableCoverage(coverage)) return false;
  return isSpeakingEvent(d);
}

// ---------------------------------------------------------------------------
// DataMinr schedule-signal gate helpers (banner-local — never touch the shared
// scheduledEventPhase classifier used by curated clustering)
// ---------------------------------------------------------------------------

// Detects a reporting-verb quote context: the alert is relaying WHAT a leader
// said, not announcing that a leader WILL speak. Matches says/said/tells/told
// as reporting verbs. Combined with hasDataMinrScheduleFraming, this
// categorically blocks "Trump says X during press conference"-style alerts.
const DATAMINR_QUOTE_VERB_RE = /\b(?:says?|said|tells?|told)\b/i;

// "during [event-type]" conclusively places the alert inside an already-running
// event — it is live coverage, not a schedule announcement.
const DATAMINR_DURING_EVENT_RE =
  /\bduring\s+(?:a\s+)?(?:press\s+(?:conference|briefing)|news\s+(?:conference|briefing)|joint\s+(?:press\s+conference|statement|appearance)|(?:the\s+)?(?:meeting|summit|conference|remarks?|appearance|session))\b/i;

/**
 * True when a DataMinr alert text reads as a MID-EVENT report or quote
 * rather than as an announcement of an upcoming event. Either condition
 * is sufficient to reject the alert from the schedule signal:
 *   a. A reporting verb (says/said/tells/told) — relaying what was said.
 *   b. "during [event]" language — the alert places itself inside a running event.
 * Banner-local; does NOT modify the shared scheduledEventPhase classifier.
 * Pure; exported for tests.
 */
export function isDataMinrQuoteAlert(text: string | null | undefined): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (DATAMINR_DURING_EVENT_RE.test(t)) return true;
  if (DATAMINR_QUOTE_VERB_RE.test(t)) return true;
  return false;
}

// Forward-looking / schedule framing: the alert must read as an announcement
// that an event WILL happen (future tense, explicit time, "scheduled to", etc.)
// before we trust publishedAt as a genuine scheduled start time. An alert that
// only exists because it is "fresh" (i.e. a quote published during an event)
// must never qualify via the grace window.
const DATAMINR_SCHEDULE_FRAMING_RE =
  /\b(?:will\s+(?:hold|deliver|host|address|speak|meet|attend|appear|give|make)|to\s+(?:hold|deliver|host|address|speak|meet|attend|appear|give|discuss|make)|scheduled\s+to|is\s+set\s+to|set\s+to\s+(?:hold|speak|address|deliver|meet|appear)|plans?\s+to|expected\s+to\s+(?:hold|speak|deliver|appear)|upcoming|later\s+today|this\s+afternoon|this\s+morning|this\s+evening|tonight|at\s+\d{1,2}:\d{2}|at\s+\d{1,2}\s*(?:am|pm)|beginning\s+at|starting\s+at|joint\s+press\s+conference\s+(?:with|at))\b/i;

/**
 * True when a DataMinr alert text carries explicit forward-looking / scheduled
 * framing ("will hold", "scheduled to", "at 3pm", "this afternoon", etc.).
 * Used to verify that publishedAt genuinely represents a scheduled event start
 * rather than just the moment DataMinr ingested a mid-event quote.
 * Pure; exported for tests.
 */
export function hasDataMinrScheduleFraming(
  text: string | null | undefined,
): boolean {
  return DATAMINR_SCHEDULE_FRAMING_RE.test(text || "");
}

// Safe watch-URL fallback per covered leader for the DataMinr schedule signal.
// DataMinr publicPostLink / url is always an r.dataminr.com redirect — never a
// watchable stream. Route to a known-watchable public live page instead; if no
// fallback exists for a leader, the candidate is suppressed rather than linking
// to a redirect that can never be a stream.
const LEADER_DATAMINR_WATCH_FALLBACK: Partial<Record<BroadcastLeader, string>> =
  {
    President: "https://www.whitehouse.gov/live/",
  };

/**
 * Returns the safe watch URL for a DataMinr schedule-signal candidate, or null
 * when no watchable fallback is configured for the leader (candidate must be
 * suppressed in that case). Pure; exported for tests.
 */
export function dataminrLeaderWatchUrl(
  leader: BroadcastLeader,
): string | null {
  return LEADER_DATAMINR_WATCH_FALLBACK[leader] ?? null;
}

// The White House X account (@WhiteHouse) announces a leader's live/broadcastable
// event in its own house style — present-tense event framing, e.g. "President
// Trump Participates in …", "President Trump Delivers Remarks at …" — NOT the
// generic "watch live" wording the standard social classifier keys on. This
// matches that on-camera-event vocabulary so the curated President banner can
// fire from those posts. Kept to genuine on-camera event verbs; routine
// article/announcement verbs are deliberately excluded.
const WHITE_HOUSE_EVENT_RE =
  /\b(participat(?:es|ing)\s+in|deliver(?:s|ing)?\s+(?:remarks|a\s+speech|an?\s+address|a\s+statement)|remarks\s+(?:at|on|to|before)|hosts?|attends?|tours?|visits?|joins?|holds?\s+(?:a\s+)?(?:press|news|briefing|event|roundtable|meeting)|speaks?|speaking|address(?:es|ing)?|press\s+(?:conference|briefing)|news\s+conference|signs?\s+(?:into|legislation|a\s+bill|an?\s+executive\s+order)|signing\s+ceremony|bill\s+signing|sworn\s+in|swearing-in|town\s+hall|rally|fireside|roundtable|meets?\s+with)\b/i;

// Markers that a White House post is a REPLAY / recap / article rather than a
// happening-now event, so it can never be mistaken for an on-air broadcast even
// when it embeds a video link.
const REPLAY_RE =
  /\b(icymi|in\s+case\s+you\s+missed|recap|replay|re-?watch|watch\s+the\s+full|full\s+(?:remarks|video|speech|address)|read\s+(?:the|more)|read\s+the\s+full|fact\s+sheet)\b/i;

const URL_RE = /https?:\/\/[^\s)"'<>]+/i;
const URL_RE_G = /https?:\/\/[^\s)"'<>]+/gi;

function extractWatchUrl(content: string, fallback: string): string {
  const m = content.match(URL_RE);
  return (m && m[0]) || fallback;
}

/**
 * Watch URL for an UPCOMING (not yet live) banner candidate sourced from a
 * social post. We prefer a real embedded stream link; if the post only contains
 * an article / post self-link (the common case for schedule-announcement RTs),
 * fall back to the leader's known live page so the "Watch" button always points
 * at an actual stream destination rather than an article. Pure-ish (reads the
 * already-computed extractStreamUrl result, no I/O).
 */
function upcomingWatchUrl(
  content: string | null | undefined,
  selfUrl: string | null | undefined,
  leader: BroadcastLeader,
): string {
  const stream = extractStreamUrl(content, selfUrl);
  if (stream) return stream;
  return dataminrLeaderWatchUrl(leader) ?? safeWatchUrl(selfUrl);
}

// Pure live-video hosts: a link to one of these counts as a stream destination
// on its own. Other broadcast destinations (gov live pages, C-SPAN, PBS, X
// broadcasts/Spaces) must ALSO carry a live/watch path SEGMENT, so a routine
// article link on those hosts — including a "/live-updates" liveblog — is never
// mistaken for an actual video stream.
const STREAM_VIDEO_HOST_RE = /(?:^|\.)(?:youtube\.com|youtu\.be|rumble\.com)$/i;
const STREAM_PATH_RE =
  /\/(?:live|live_stream|livestream|watch|broadcasts?|i\/spaces)(?:[\/?#]|$)/i;

// An X broadcast (/i/broadcasts/…) or Space (/i/spaces/…) is accepted as a
// stream DESTINATION, but its on-air state can NEVER be confirmed server-side —
// X returns HTTP 200 whether the broadcast is live or has ended, and the page is
// login-walled. Such links are therefore an UNVERIFIABLE live assertion: they
// may light LIVE only for a bounded window from the post, then are cleared.
const UNVERIFIABLE_STREAM_PATH_RE = /\/i\/(?:broadcasts?|spaces)(?:[\/?#]|$)/i;

/**
 * True when a stream link can't be verified as still-on-air without credentials
 * (an X broadcast / Space). Verifiable sources (YouTube /live, whitehouse.gov/
 * live) return false. Pure; exported for regression tests.
 */
export function isUnverifiableStreamUrl(url: string | null | undefined): boolean {
  return !!url && UNVERIFIABLE_STREAM_PATH_RE.test(url);
}

/** Normalize a URL for self-link comparison (scheme / www / trailing punctuation insensitive). */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) =>
    (u || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/[\/#?]+$/, "");
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * Return the first embedded STREAMING link in a social post — a link to a live-
 * video host, or any URL whose path is a live/watch/broadcast segment — while
 * excluding the post's own self URL. null when the post carries no stream link.
 *
 * Rationale: social posts are how MCOP learns a leader's SCHEDULE, but the
 * banner must point users at an ACTUAL stream, not the post itself. So a "live"
 * social post is only trusted as on-air when it embeds a real stream link; the
 * keyless web checks (White House live page, YouTube /live, C-SPAN/PBS) remain
 * the authoritative way to confirm a stream when the post carries no link.
 * Pure (no I/O); exported for regression tests.
 */
export function extractStreamUrl(
  content: string | null | undefined,
  selfUrl: string | null | undefined,
): string | null {
  const text = content || "";
  const self = selfUrl || "";
  URL_RE_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE_G.exec(text)) !== null) {
    const raw = m[0].replace(/[.,;:]+$/, ""); // drop trailing sentence punctuation
    if (sameUrl(raw, self)) continue; // a self post-link is not a stream
    let host = "";
    try {
      host = new URL(raw).hostname;
    } catch {
      continue;
    }
    if (STREAM_VIDEO_HOST_RE.test(host) || STREAM_PATH_RE.test(raw)) return raw;
  }
  return null;
}

/**
 * Return the first embedded http(s) URL that is NOT the post's own self link
 * (e.g. the t.co a White House post embeds, vs. the x.com status URL itself).
 * null when the post embeds no foreign URL. Pure; exported for regression tests.
 */
export function firstNonSelfUrl(
  content: string | null | undefined,
  selfUrl: string | null | undefined,
): string | null {
  const text = content || "";
  URL_RE_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE_G.exec(text)) !== null) {
    const raw = m[0].replace(/[.,;:]+$/, "");
    if (!sameUrl(raw, selfUrl || "")) return raw;
  }
  return null;
}

/**
 * Classify a leader's social post for the live-broadcast signal. A post counts
 * as LIVE only when it BOTH uses live language ("watch live", "live now") AND
 * embeds an actual streaming link — otherwise it is anticipation/schedule
 * context and is left to the upcoming logic. Pure; exported for regression tests.
 */
export function classifySocialLive(
  content: string | null | undefined,
  selfUrl: string | null | undefined,
): { isLive: boolean; streamUrl: string | null } {
  const text = content || "";
  if (!LIVE_LANGUAGE_RE.test(text)) return { isLive: false, streamUrl: null };
  const streamUrl = extractStreamUrl(text, selfUrl);
  return { isLive: streamUrl != null, streamUrl };
}

/**
 * True when a social post is a genuine near-term ANTICIPATION cue: it uses
 * "about to happen" language, is NOT a replay / recap of an ALREADY-delivered
 * event (REPLAY_RE — "full remarks", "ICYMI", "recap", "re-watch", …: a post
 * describing completed remarks is neither live nor upcoming, so it must never
 * light the amber "STARTING SOON" banner — this is the same replay marker the
 * White House event path trusts, kept shared so the two can't drift), does NOT
 * preview a specific future calendar date (the schedule/Factbase signals own
 * those, with a real start time), and is not a DURING-phase ("it's happening
 * now") line per the shared phase classifier. Shared by both social signals so
 * their upcoming gating can't drift. Pure; exported for regression tests.
 */
export function isSocialUpcoming(content: string | null | undefined): boolean {
  const text = content || "";
  return (
    UPCOMING_LANGUAGE_RE.test(text) &&
    !REPLAY_RE.test(text) &&
    !mentionsFutureDate(text) &&
    scheduledEventPhase(text) !== "during"
  );
}

/** Trim a social post down to a short single-line banner title. */
function toBannerTitle(content: string, leader: BroadcastLeader): string {
  let t = (content || "").replace(URL_RE_G, "").replace(/\s+/g, " ").trim();
  // Strip a leading "WATCH LIVE:" / "LIVE:" style marker for a cleaner read.
  t = t.replace(/^\s*(watch\s+live|live\s+now|live|watch)\s*[:\-–—]\s*/i, "").trim();
  if (t.length > 110) t = t.slice(0, 107).trimEnd() + "…";
  if (!t) return `${leader} live`;
  return t;
}

/** Minimal HTML-entity decode for titles scraped from public live pages. */
function decodeEntities(s: string): string {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Fail-soft cleanup + output hygiene helpers.
// ---------------------------------------------------------------------------

// When a detector bails on a non-OK response it must still release the
// connection. An undici Response whose body is never read can pin a socket
// until GC; with recurring upstream failures (e.g. C-SPAN 403s) that turns into
// FD/socket pressure on the single Reserved VM. Cancel the stream best-effort;
// cleanup must never throw.
function releaseBody(resp: Response | null | undefined): void {
  try {
    const c = resp?.body?.cancel?.();
    if (c && typeof (c as Promise<void>).catch === "function") {
      (c as Promise<void>).catch(() => {});
    }
  } catch {
    /* never throw from cleanup */
  }
}

// White House posts embed their stream behind a t.co short link, which hides the
// real destination from the stream-host check. We resolve it by reading the
// redirect Location header ONLY — never fetching (or chasing a hop to) the
// destination — so the single outbound request always goes to the fixed,
// trusted t.co host and there is no SSRF path to an internal address. Cached
// per short-URL so a live recompute every 30s doesn't re-hit t.co. Fail-soft:
// any error / non-redirect / non-http(s) target yields null and the caller
// degrades to an amber "upcoming" cue rather than a red "LIVE".
const SHORTLINK_TTL_MS = 30 * 60 * 1000; // 30 min
const shortLinkCache = new Map<string, { at: number; url: string | null }>();

async function resolveShortLink(
  shortUrl: string,
  now: number,
): Promise<string | null> {
  let host = "";
  try {
    host = new URL(shortUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  // Only the trusted Twitter/X shortener is ever resolved; any other host (incl.
  // a destination we'd have to fetch to learn about) is left untouched.
  if (host !== "t.co" && !host.endsWith(".t.co")) return null;

  const cached = shortLinkCache.get(shortUrl);
  if (cached && now - cached.at < SHORTLINK_TTL_MS) return cached.url;

  let resolved: string | null = null;
  let resp: Response | null = null;
  try {
    resp = await fetch(shortUrl, {
      method: "GET",
      redirect: "manual", // read the 3xx Location header; do NOT follow it
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,*/*",
      },
      signal: AbortSignal.timeout(5000),
    });
    const loc = resp.headers.get("location");
    if (loc) {
      try {
        const u = new URL(loc, shortUrl);
        if (u.protocol === "http:" || u.protocol === "https:") {
          resolved = u.toString();
        }
      } catch {
        /* malformed Location → leave null */
      }
    }
  } catch {
    resolved = null; // network / timeout / abort → fail soft
  } finally {
    releaseBody(resp);
  }
  shortLinkCache.set(shortUrl, { at: now, url: resolved });
  return resolved;
}

// Guarantee any emitted watch link is a safe http(s) URL. watchUrl values flow
// from DB rows and external feeds, so a compromised upstream could inject a
// `javascript:`/`data:` scheme that the client renders as an <a href>. Anything
// non-http(s) (or unparseable) collapses to the White House live page — always
// a sane President fallback. A function (not const) so it can reference
// WH_LIVE_URL declared later in module scope; only called at runtime.
function safeWatchUrl(url: string | null | undefined): string {
  if (url) {
    const trimmed = url.trim();
    try {
      const u = new URL(trimmed);
      if (u.protocol === "http:" || u.protocol === "https:") return trimmed;
    } catch {
      /* not a parseable absolute URL */
    }
  }
  return WH_LIVE_URL;
}

// ---------------------------------------------------------------------------
// Signal 1: social relay "watch live"
// ---------------------------------------------------------------------------
async function detectSocialWatchLive(now: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const consider = (
    content: string | null | undefined,
    url: string | null | undefined,
    postedAt: Date | string | null | undefined,
    leader: BroadcastLeader,
    source: string,
  ) => {
    if (!content || !url) return;
    const observedAt = postedAt ? new Date(postedAt).getTime() : 0;
    if (!observedAt || now - observedAt > UPCOMING_WINDOW_MS) return;
    // A social post is only trusted as LIVE when it says it's live AND embeds an
    // actual streaming link — the banner has to point at a real stream, not the
    // post itself. A "live"-language post with no stream link is NOT on-air here
    // (the keyless web checks confirm the real stream); it can still qualify as
    // anticipation via the upcoming branch below.
    const { isLive, streamUrl } = classifySocialLive(content, url);
    // An "about to happen" post that PREVIEWS a specific future date ("July 4th
    // … I'll be there to speak") is not an imminent broadcast — don't let it
    // light the upcoming banner (the schedule/Factbase signals own the real,
    // timestamped cue), and a DURING-phase line isn't anticipation either. The
    // live cue is left alone: a confirmed live+link post is a real-time signal
    // regardless of any future date it also mentions. Shared with the schedule
    // anticipation signal via isSocialUpcoming so the two can't drift.
    const isUpcoming = !isLive && isSocialUpcoming(content);
    if (!isLive && !isUpcoming) return;
    // A live cue only counts while fresh; otherwise treat a still-recent post
    // as merely "upcoming"-grade context (won't pin the banner red for long).
    if (isLive && now - observedAt > LIVE_WINDOW_MS) return;
    // An upcoming cue from a free-text post has no genuine scheduled start, so
    // bound how long it lights the amber banner to a short window from the post
    // — it must not linger for the full scan window.
    if (isUpcoming && now - observedAt > SOCIAL_UPCOMING_WINDOW_MS) return;
    out.push({
      state: isLive ? "live" : "upcoming",
      leader,
      title: toBannerTitle(content, leader),
      // A confirmed-live post points the banner at the embedded stream; an
      // upcoming post keeps the existing best-effort link (embedded URL → post).
      // A confirmed-live post uses the embedded stream; an upcoming post prefers
      // any embedded stream link, falling back to the leader's known live page
      // so the Watch button never points at an article.
      watchUrl: isLive && streamUrl ? streamUrl : upcomingWatchUrl(content, url, leader),
      observedAt,
      source,
    });
  };

  const [truth, rapid, dow, xposts] = await Promise.all([
    storage.getRecentTruthSocialPosts(SCAN_LIMIT).catch(() => []),
    storage.getRecentRapidResponsePosts(SCAN_LIMIT).catch(() => []),
    storage.getRecentDOWResponsePosts(SCAN_LIMIT).catch(() => []),
    storage.getRecentXPosts(SCAN_LIMIT * 2).catch(() => []),
  ]);

  for (const p of truth) consider(p.content, p.truthSocialUrl, p.postedAt, "President", "social:truth-social");
  for (const p of rapid) consider(p.content, p.xUrl, p.postedAt, "President", "social:x:rapidresponse47");
  for (const p of dow) consider(p.content, p.xUrl, p.postedAt, "Secretary of War", "social:x:dowresponse");
  for (const p of xposts) {
    // OWNER handles map to their leader; SPOKES/ORG handles only to a NAMED
    // covered leader; any other handle is ignored (fail-closed).
    const leader = attributeXPostLeader(p.sourceAccount, p.content);
    if (leader) consider(p.content, p.xUrl, p.postedAt, leader, `social:x:${(p.sourceAccount || "unknown").toLowerCase()}`);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Signal 1b: White House X account (@WhiteHouse) — CURATED-ONLY
// @WhiteHouse is onboarded curated-only and lands in the SHARED osint_posts
// table (sourceAccount='WhiteHouse'), which every NON-curated reader excludes.
// It is the President's official broadcast channel, so its posts announce a
// leader's live event — but in a house style ("President Trump Participates in
// …", "… Delivers Remarks at …") that uses neither the "watch live" wording the
// standard social classifier needs NOR a recognizable stream host (the stream
// sits behind a t.co short link). This signal handles both:
//   • LIVE (red) only when an ACTUAL stream is confirmed — a direct stream link
//     in the text, or a t.co that RESOLVES to a stream destination — AND the
//     post is fresh. A confirmed stream with no OTHER covered leader named
//     defaults to the President (mirrors the WH YouTube allowDefault), but a
//     NAMED covered leader (VP / SecState / SecWar) always wins.
//   • UPCOMING (amber) as the safe degrade when a covered leader is NAMED with a
//     watch link but the stream can't be confirmed (resolution failed / not a
//     stream / no longer fresh). No blind President default here — fail-closed.
// "False LIVE worse than missed": red requires a confirmed stream; the existing
// keyless YouTube /live check independently backstops the WH livestream too.
// ---------------------------------------------------------------------------

/** True when a WH post reads as a happening-now event (not a replay/article). */
export function isWhiteHouseEventPost(content: string | null | undefined): boolean {
  const text = content || "";
  return WHITE_HOUSE_EVENT_RE.test(text) && !REPLAY_RE.test(text);
}

/**
 * Bind an unconfirmed White House event cue to the covered leader it names.
 * White House promotional posts often mention the President after describing
 * somebody else's action ("@Meijer joins ... under President Trump"). The broad
 * event vocabulary correctly sees "joins", and the leader detector correctly
 * sees "President Trump", but combining those unrelated matches creates a false
 * STARTING SOON banner. For amber social cues, require the named leader to occur
 * before the event verb in the same clause. Confirmed stream links remain the
 * stronger live signal and do not depend on this fallback-only guard.
 */
function namedLeaderOwnsWhiteHouseEvent(
  content: string,
  leader: BroadcastLeader,
): boolean {
  const leaderPatterns = leader === "President"
    ? [PRESIDENT_SPECIFIC_RE, PRESIDENT_GENERIC_RE]
    : LEADER_NAME_PATTERNS
        .filter((entry) => entry.leader === leader)
        .map((entry) => entry.re);
  const leaderMatches = leaderPatterns
    .map((pattern) => pattern.exec(content))
    .filter((match): match is RegExpExecArray => !!match);
  const eventMatch = WHITE_HOUSE_EVENT_RE.exec(content);
  if (leaderMatches.length === 0 || !eventMatch) return false;

  return leaderMatches.some((leaderMatch) => {
    if (leaderMatch.index > eventMatch.index) return false;
    const between = content.slice(
      leaderMatch.index + leaderMatch[0].length,
      eventMatch.index,
    );
    return between.length <= 80 && !/[.!?;\n]/.test(between);
  });
}

/**
 * Decide the broadcast candidate (if any) for a single @WhiteHouse post. Pure
 * apart from the injected `resolve` short-link resolver, so every branch is
 * deterministically testable. Returns null when the post is not a usable cue.
 */
export async function classifyWhiteHouseXPost(
  post: {
    content?: string | null;
    xUrl?: string | null;
    postedAt?: Date | string | null;
    isRetweet?: boolean | null;
  },
  now: number,
  resolve: (shortUrl: string, now: number) => Promise<string | null>,
): Promise<Candidate | null> {
  if (post.isRetweet) return null; // a retweet isn't the WH announcing its own event
  const content = post.content || "";
  const xUrl = post.xUrl || "";
  if (!content || !xUrl) return null;
  const observedAt = post.postedAt ? new Date(post.postedAt).getTime() : 0;
  if (!observedAt || now - observedAt > UPCOMING_WINDOW_MS) return null;
  if (!isWhiteHouseEventPost(content)) return null;
  const embedded = firstNonSelfUrl(content, xUrl);
  if (!embedded) return null; // nothing to point the banner at

  // A NAMED covered leader always wins (so a WH post about the VP / SecState is
  // attributed correctly, never blindly to the President).
  const namedLeader = detectLeaderInText(content);

  // Confirm an ACTUAL stream: a direct stream link in the text, or a t.co that
  // resolves to a stream destination (host/path checked by extractStreamUrl).
  let streamUrl = extractStreamUrl(content, xUrl);
  let resolved: string | null = null;
  if (!streamUrl) {
    resolved = await resolve(embedded, now);
    if (resolved) streamUrl = extractStreamUrl(resolved, xUrl);
  }

  if (streamUrl) {
    // An X broadcast / Space can't be confirmed still-on-air, so it may assert
    // LIVE only for a short bounded window from the post; a verifiable stream
    // (YouTube /live etc.) keeps the standard freshness window.
    const unverifiable = isUnverifiableStreamUrl(streamUrl);
    const liveCap = unverifiable ? UNVERIFIABLE_LIVE_MAX_MS : LIVE_WINDOW_MS;
    if (now - observedAt <= liveCap) {
      const leader = namedLeader || "President"; // default President only on a confirmed stream
      return {
        state: "live",
        leader,
        title: toBannerTitle(content, leader),
        watchUrl: streamUrl,
        observedAt,
      };
    }
    // Past its cap, an UNVERIFIABLE stream is CLEARED outright — it must never
    // degrade into a long-lived "upcoming" pointing at a broadcast that has
    // almost certainly ended ("false LIVE/replay worse than missed").
    if (unverifiable) return null;
  }
  // Safe degrade to amber UPCOMING for a NAMED leader (never a blind President
  // default), bounded to a short window from the post: these WH posts carry no
  // genuine scheduled start, and an in-progress ("delivers remarks") post must
  // not be recycled as a fresh long-lived "upcoming".
  if (
    namedLeader &&
    namedLeaderOwnsWhiteHouseEvent(content, namedLeader) &&
    now - observedAt <= SOCIAL_UPCOMING_WINDOW_MS
  ) {
    return {
      state: "upcoming",
      leader: namedLeader,
      title: toBannerTitle(content, namedLeader),
      watchUrl: resolved || embedded,
      observedAt,
    };
  }
  return null; // unconfirmed stream + no named leader (or stale) → fail-closed
}

async function detectWhiteHouseXSignal(now: number): Promise<Candidate[]> {
  const since = new Date(now - UPCOMING_WINDOW_MS);
  // Curated-safe reader: getCuratedOsintPosts does NOT exclude the curated-only
  // handle list, so it can see @WhiteHouse (getRecentOsintPosts excludes it).
  const posts = await storage
    .getCuratedOsintPosts(since, SCAN_LIMIT, "WhiteHouse")
    .catch(() => []);
  const out: Candidate[] = [];
  for (const p of posts) {
    const c = await classifyWhiteHouseXPost(p, now, resolveShortLink);
    if (c) out.push({ ...c, source: "x-osint:WhiteHouse" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signal 2: scheduled / anticipation
// Uses the shared scheduled-event phase classifier to keep an "ahead-of"
// (pre-phase) framing from being read as a live event, and only admits a
// candidate that carries explicit upcoming language for a covered leader.
// ---------------------------------------------------------------------------
async function detectScheduledUpcoming(now: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const xposts = await storage.getRecentXPosts(SCAN_LIMIT * 2).catch(() => []);
  for (const p of xposts) {
    if (!p.content || !p.xUrl) continue;
    // OWNER handle → its leader; SPOKES/ORG handle → only the NAMED covered
    // leader (mirrors the live signal's attribution rules).
    const leader = attributeXPostLeader(p.sourceAccount, p.content);
    if (!leader) continue;
    const observedAt = p.postedAt ? new Date(p.postedAt).getTime() : 0;
    // Free-text anticipation carries no genuine scheduled start, so bound it to
    // a short window from the post (it must not linger for the full scan window).
    if (!observedAt || now - observedAt > SOCIAL_UPCOMING_WINDOW_MS) continue;
    // Genuine near-term anticipation only: upcoming language, no specific future
    // date (the schedule/Factbase signals own those), and not a DURING-phase
    // line. Shared with the social live signal so the two can't drift.
    if (!isSocialUpcoming(p.content)) continue;
    out.push({
      state: "upcoming",
      leader,
      title: toBannerTitle(p.content, leader),
      watchUrl: upcomingWatchUrl(p.content, p.xUrl, leader),
      observedAt,
      source: `x:upcoming:${(p.sourceAccount || "unknown").toLowerCase()}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signal 2b: scheduled / anticipation from the ingested PA-events / POTUS
// schedule. DataMinr First Alerts carry each event's listed start (eventTime →
// publishedAt), so this is the authoritative "what is scheduled soon" source.
// Admits a covered leader whose speaking event is listed within the near-term
// window, using the shared phase classifier to drop any DURING-phase line.
// ---------------------------------------------------------------------------
async function detectScheduledEvent(now: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const alerts = await storage
    .getRecentFirstAlerts(SCHEDULE_SCAN_LIMIT)
    .catch(() => []);
  for (const a of alerts) {
    const text = `${a.headline || ""} ${a.subHeadline || ""}`.trim();
    if (!text) continue;
    const leader = detectLeaderInText(text);
    if (!leader) continue;
    // Must look like a genuine speaking/broadcast event with an anticipation
    // framing — not routine coverage that merely names a leader.
    if (!SPEAKING_EVENT_RE.test(text)) continue;
    // [Fix 1] Reject mid-event quote/report alerts. "Trump says X during press
    // conference" carries a speaking-event term (press conference) and passes
    // SPEAKING_EVENT_RE, but it is a report of what was said, not an upcoming
    // schedule announcement. Drop it before touching startsAt or watchUrl.
    if (isDataMinrQuoteAlert(text)) continue;
    // [Fix 2] Require genuine forward-looking scheduled framing before treating
    // publishedAt as a scheduled start time. An alert that is only "fresh"
    // (e.g. a quote ingested mid-event) must not qualify via the grace window.
    if (!hasDataMinrScheduleFraming(text)) continue;
    // A DURING-phase line is the event itself, not an anticipation cue; the
    // live signals own that. (Schedule rows are not a live-confirmation source.)
    if (scheduledEventPhase(text) === "during") continue;
    const startsAtMs = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    if (!startsAtMs) continue;
    const delta = startsAtMs - now;
    // Near-term only: listed to start within the lookahead window, or just
    // slipped past its listed start by a short grace.
    if (delta > SCHEDULE_LOOKAHEAD_MS || delta < -SCHEDULE_GRACE_PAST_MS) continue;
    // [Fix 3] Never link Watch at a DataMinr redirect (publicPostLink / url are
    // always r.dataminr.com). Route to a known-watchable leader fallback; if
    // none is configured for this leader, suppress the candidate.
    const watchUrl = dataminrLeaderWatchUrl(leader);
    if (!watchUrl) continue;
    out.push({
      state: "upcoming",
      leader,
      title: toBannerTitle(a.headline || text, leader),
      watchUrl,
      observedAt: a.scrapedAt ? new Date(a.scrapedAt).getTime() : now,
      startsAt: startsAtMs,
      source: "dataminr",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signal 3: keyless on-air web check (fail soft)
// Confirms a stream is actually on air on a public live page and supplies a
// watch link. Conservative on purpose — a false "LIVE" shown to leadership is
// worse than a missed one — so it only fires on a strong embedded-live cue.
// ---------------------------------------------------------------------------
const WH_LIVE_URL = "https://www.whitehouse.gov/live/";

async function detectKeylessOnAir(now: number): Promise<Candidate[]> {
  try {
    const resp = await fetchWithResilience(WH_LIVE_URL, {
      label: "LiveBroadcastWH",
      accept: "text/html,application/xhtml+xml,*/*",
      timeoutMs: 6000,
      retries: 0,
    });
    if (!resp.ok) {
      releaseBody(resp);
      return [];
    }
    const html = await resp.text();
    // Strong on-air cues: a YouTube live embed or schema marking a live
    // broadcast currently in progress. Ambiguous pages return nothing.
    const liveEmbed =
      /youtube\.com\/embed\/live_stream/i.test(html) ||
      /"isLiveBroadcast"\s*:\s*true/i.test(html) ||
      /"liveBroadcastContent"\s*:\s*"live"/i.test(html) ||
      /\bclass="[^"]*\bis-live\b[^"]*"/i.test(html);
    if (!liveEmbed) return [];
    return [
      {
        state: "live",
        leader: "President",
        title: "White House live coverage",
        watchUrl: WH_LIVE_URL,
        observedAt: now,
        source: "whitehouse-live-page",
      },
    ];
  } catch {
    // Page unreachable / blocked / timeout — fail soft, defer to other signals.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Signal 3b: keyless YouTube channel /live check (fail soft)
// The official department channels resolve "@handle/live" to the active live
// watch page only while a stream is on air (otherwise it canonicalizes back to
// the channel). We confirm with TWO factors — the canonical points at a
// /watch?v= video AND the page carries a live cue — then attribute to a covered
// leader by the live video TITLE. Department channels (State / War) require the
// title to actually name their principal (no blind default), so a routine
// spokesperson stream never mislabels the Secretary as "LIVE". The White House
// channel may default to the President (its near-exclusive use), matching the
// existing White House live-page behavior.
// ---------------------------------------------------------------------------
const YT_LIVE_SOURCES: {
  liveUrl: string;
  org: string;
  defaultLeader: BroadcastLeader;
  allowDefault: boolean;
}[] = [
  {
    liveUrl: "https://www.youtube.com/@WhiteHouse/live",
    org: "White House",
    defaultLeader: "President",
    allowDefault: true,
  },
  {
    liveUrl: "https://www.youtube.com/@statedept/live",
    org: "U.S. Department of State",
    defaultLeader: "Secretary of State",
    allowDefault: false,
  },
  {
    liveUrl: "https://www.youtube.com/@DeptofWar/live",
    org: "U.S. Department of War",
    defaultLeader: "Secretary of War",
    allowDefault: false,
  },
  // RSBN and Fox News carry the President's events live on YouTube. They are
  // multi-program networks, so they may NOT blindly default to the President —
  // the live video TITLE must actually name a covered leader (two-factor +
  // title attribution), otherwise we leave the banner dark.
  {
    liveUrl: "https://www.youtube.com/@RSBNetwork/live",
    org: "Right Side Broadcasting Network",
    defaultLeader: "President",
    allowDefault: false,
  },
  {
    liveUrl: "https://www.youtube.com/@FoxNews/live",
    org: "Fox News",
    defaultLeader: "President",
    allowDefault: false,
  },
];

/**
 * Decide the live candidate (if any) from a fetched YouTube channel "/live"
 * page. Two-factor: the page must canonicalize to a `/watch?v=` video AND carry
 * an on-air cue; the leader comes from the live video TITLE, falling back to the
 * source default only when that source allows it. Pure; exported for tests.
 */
export function classifyYouTubeLive(
  html: string,
  src: { liveUrl: string; org: string; defaultLeader: BroadcastLeader; allowDefault: boolean },
  now: number,
): Candidate | null {
  const canonical =
    html.match(/<link rel="canonical" href="([^"]+)"/i)?.[1] || "";
  // A genuine live render canonicalizes to the /watch video; a not-live
  // /live just shows the channel page.
  if (!/\/watch\?v=[\w-]{11}/.test(canonical)) return null;
  const liveCue =
    /"isLive"\s*:\s*true/.test(html) ||
    /\bhlsManifestUrl\b/.test(html) ||
    /"liveBroadcastContent"\s*:\s*"live"/.test(html);
  if (!liveCue) return null;
  const ogTitle = decodeEntities(
    html.match(/<meta property="og:title" content="([^"]*)"/i)?.[1] || "",
  );
  const leader =
    detectLeaderInText(ogTitle) ||
    (src.allowDefault ? src.defaultLeader : null);
  if (!leader) return null;
  return {
    state: "live",
    leader,
    title: ogTitle
      ? toBannerTitle(ogTitle, leader)
      : `${src.org} live coverage`,
    watchUrl: canonical || src.liveUrl,
    observedAt: now,
  };
}

async function detectYouTubeChannelLive(now: number): Promise<Candidate[]> {
  const results = await Promise.all(
    YT_LIVE_SOURCES.map(async (src): Promise<Candidate | null> => {
      try {
        const resp = await fetchWithResilience(src.liveUrl, {
          label: "LiveBroadcastYT",
          accept: "text/html,application/xhtml+xml,*/*",
          timeoutMs: 6000,
          retries: 0,
        });
        if (!resp.ok) {
          releaseBody(resp);
          return null;
        }
        const html = await resp.text();
        const c = classifyYouTubeLive(html, src, now);
        return c ? { ...c, source: `youtube:${src.org}` } : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((c): c is Candidate => c !== null);
}

// ---------------------------------------------------------------------------
// Signal 3b-bis: HASC / SASC committee hearings (Task #1077). Reads the
// committee_hearings table maintained by server/hearingTracker.ts (hourly
// poll). A hearing qualifies ONLY when the tracker matched a key-leader
// witness AND mapped it to a precise banner label (bannerLeader non-null —
// SecDef → "Secretary of War", CJCS → "Chairman of the Joint Chiefs";
// everything else is fail-closed: tracked + testimony-ingested, never banner).
//   - UPCOMING: real startsAt within the shared schedule lookahead/grace.
//   - LIVE: hearing in its plausible run window AND the committee's own
//     YouTube /live page passes the standard two-factor check (canonical
//     /watch + live cue). The committee channel streams only its own hearings,
//     so when a tracked hearing is in-window the live video is attributed to
//     the hearing's banner leader (title still preferred from og:title).
//     SASC has no discoverable channel → upcoming-only, watchUrl = hearing page.
// Fail-soft; curated-lane only like every other signal here.
// ---------------------------------------------------------------------------
// How long after its listed start a hearing is still plausibly running.
const HEARING_RUN_WINDOW_MS = 3.5 * 60 * 60 * 1000; // 3.5 h
// Allow the live check slightly before the listed start (streams open early).
const HEARING_EARLY_LIVE_MS = 10 * 60 * 1000; // 10 min

const COMMITTEE_YT_LIVE: Record<string, string | null> = {
  HASC: "https://www.youtube.com/@HouseArmedServices/live",
  SASC: null,
};

async function detectCommitteeHearings(now: number): Promise<Candidate[]> {
  const hearings = await storage.getCommitteeHearingsInWindow(
    now - HEARING_RUN_WINDOW_MS,
    now + SCHEDULE_LOOKAHEAD_MS,
  );
  const out: Candidate[] = [];
  // At most ONE live check per committee per compute (both committees stream on
  // one channel each), and only when a tracked hearing is in its run window.
  // Sort by proximity of startsAt to now so that when two hearings from the
  // same committee overlap the run window, the single live check (and thus the
  // title/leader a live stream is attributed to) binds to the hearing nearest
  // its scheduled start — not merely the first row returned.
  hearings.sort((a, b) => {
    const da = a.startsAt ? Math.abs(new Date(a.startsAt).getTime() - now) : Infinity;
    const db = b.startsAt ? Math.abs(new Date(b.startsAt).getTime() - now) : Infinity;
    return da - db;
  });
  const liveChecked = new Set<string>();
  for (const h of hearings) {
    if (!h.bannerLeader || !h.startsAt) continue;
    const leader = h.bannerLeader as BroadcastLeader;
    if (!(leader in LEADER_PRIORITY)) continue; // stale label — fail closed
    const startsMs = new Date(h.startsAt).getTime();
    const watchFallback = COMMITTEE_YT_LIVE[h.committee] || h.eventUrl;
    const title = `${h.committee} hearing: ${h.title}`;

    // LIVE — in-window + committee YouTube two-factor confirmation.
    const liveUrl = COMMITTEE_YT_LIVE[h.committee];
    if (
      liveUrl &&
      !liveChecked.has(h.committee) &&
      now >= startsMs - HEARING_EARLY_LIVE_MS &&
      now <= startsMs + HEARING_RUN_WINDOW_MS
    ) {
      liveChecked.add(h.committee);
      try {
        const resp = await fetchWithResilience(liveUrl, {
          label: "LiveBroadcastHearing",
          accept: "text/html,application/xhtml+xml,*/*",
          timeoutMs: 6000,
          retries: 0,
        });
        if (resp.ok) {
          const html = await resp.text();
          const c = classifyYouTubeLive(
            html,
            { liveUrl, org: h.committee, defaultLeader: leader, allowDefault: true },
            now,
          );
          if (c) {
            out.push({ ...c, source: `hearing:${h.committee}:live` });
            continue;
          }
        } else {
          releaseBody(resp);
        }
      } catch {
        /* fail-soft — fall through to the upcoming cue */
      }
    }

    // UPCOMING — real scheduled start within lookahead/grace.
    if (
      startsMs - now <= SCHEDULE_LOOKAHEAD_MS &&
      now - startsMs <= SCHEDULE_GRACE_PAST_MS
    ) {
      out.push({
        state: "upcoming",
        leader,
        title,
        watchUrl: watchFallback,
        observedAt: now,
        startsAt: startsMs,
        source: `hearing:${h.committee}:schedule`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signal 3c: keyless network live pages — currently no active sources.
// C-SPAN was removed: it is CDN-blocked (HTTP 403) from server IPs every
// cycle, producing only connection errors and FD pressure with zero signal.
// PBS News was removed: its live page only ever returns a generic "Live"
// title that never names a covered leader, so it has never fired the banner.
// Factbase and YouTube /live checks (signals 1c and 3b) remain the reliable
// on-air detection paths. This slot is kept as infrastructure for future
// live-page sources.
// ---------------------------------------------------------------------------
const NETWORK_LIVE_SOURCES: { url: string; org: string }[] = [];

async function detectNetworkLive(now: number): Promise<Candidate[]> {
  const results = await Promise.all(
    NETWORK_LIVE_SOURCES.map(async (src): Promise<Candidate | null> => {
      try {
        const resp = await fetchWithResilience(src.url, {
          label: "LiveBroadcastNet",
          accept: "text/html,application/xhtml+xml,*/*",
          timeoutMs: 6000,
          retries: 0,
        });
        if (!resp.ok) {
          releaseBody(resp);
          return null;
        }
        const html = await resp.text();
        const og =
          html.match(/<meta property="og:title" content="([^"]*)"/i)?.[1] || "";
        const titleTag = html.match(/<title>([^<]*)<\/title>/i)?.[1] || "";
        const jsonLdName =
          html.match(/"name"\s*:\s*"([^"]{0,120})"/i)?.[1] || "";
        const programText = decodeEntities(`${og} ${titleTag} ${jsonLdName}`);
        const leader = detectLeaderInText(programText);
        if (!leader) return null;
        if (!SPEAKING_EVENT_RE.test(programText)) return null;
        return {
          state: "live",
          leader,
          title: toBannerTitle(programText, leader),
          watchUrl: src.url,
          observedAt: now,
          source: `network:${src.org}`,
        };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((c): c is Candidate => c !== null);
}

// ---------------------------------------------------------------------------
// Signal 1c: Factbase (Roll Call) POTUS calendar schedule (President upcoming)
// The public calendar JSON lists each presidential event with a date + local
// (America/New_York) start time. We admit a near-term SPEAKING event as an
// "upcoming" cue with a real startsAt. The feed is ~2MB, so it is cached on its
// own longer TTL (schedules change slowly) instead of being re-fetched on every
// 30s status recompute. President-only by nature of the source. Fail soft.
// ---------------------------------------------------------------------------
const FACTBASE_CAL_URL =
  "https://media-cdn.factba.se/rss/json/trump/calendar-full.json";
const FACTBASE_TTL_MS = 15 * 60 * 1000; // 15 min

interface FactbaseEvent {
  date?: string;
  time?: string;
  details?: string;
  coverage?: string | null;
  url?: string | null;
  video_url?: string | null;
}

let factbaseCache: { at: number; events: FactbaseEvent[] } | null = null;

/** Interpret a "YYYY-MM-DD" + "HH:MM:SS" America/New_York wall time (DST-aware)
 *  as a UTC epoch ms. */
function etWallTimeToMs(dateStr?: string, timeStr?: string): number | null {
  if (!dateStr || !timeStr) return null;
  const pretendUtc = new Date(`${dateStr}T${timeStr}Z`);
  if (isNaN(pretendUtc.getTime())) return null;
  // What does that same instant read as on a New York wall clock?
  const tzView = new Date(
    pretendUtc.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  if (isNaN(tzView.getTime())) return null;
  const offset = pretendUtc.getTime() - tzView.getTime();
  return pretendUtc.getTime() + offset;
}

async function getFactbaseEvents(now: number): Promise<FactbaseEvent[]> {
  if (factbaseCache && now - factbaseCache.at < FACTBASE_TTL_MS) {
    return factbaseCache.events;
  }
  try {
    const resp = await fetchWithResilience(FACTBASE_CAL_URL, {
      label: "LiveBroadcastFactbase",
      accept: "application/json,*/*",
      timeoutMs: 8000,
      retries: 0,
    });
    if (!resp.ok) {
      releaseBody(resp);
      return factbaseCache?.events ?? [];
    }
    const data = JSON.parse(await resp.text());
    const events: FactbaseEvent[] = Array.isArray(data) ? data : [];
    factbaseCache = { at: now, events };
    return events;
  } catch {
    // Keep serving the last good calendar rather than dropping the signal.
    return factbaseCache?.events ?? [];
  }
}

async function detectFactbaseSchedule(now: number): Promise<Candidate[]> {
  const events = await getFactbaseEvents(now);
  const out: Candidate[] = [];
  for (const e of events) {
    const candidate = factbaseEventToCandidate(e, now);
    if (candidate) out.push({ ...candidate, source: "factbase" });
  }
  return out;
}

/**
 * Admit a single Factbase calendar entry as an "upcoming" President candidate,
 * or null when it must not light the banner. Pure (no I/O); exported for
 * regression tests. Fail-closed precision: a closed-press / non-speaking /
 * out-of-window entry yields null.
 */
export function factbaseEventToCandidate(
  e: FactbaseEvent | null | undefined,
  now: number,
): Candidate | null {
  const details = (e?.details || "").trim();
  if (!details || !e?.time) return null;
  // Press-access + speaking-event gate: a closed-door event has nothing to
  // watch, and a bare "briefing" (e.g. "Intelligence Briefing") is not public.
  if (!factbaseEventQualifies(details, e?.coverage)) return null;
  const startMs = etWallTimeToMs(e.date, e.time);
  if (!startMs) return null;
  const delta = startMs - now;
  // Near-term only: listed to start within the lookahead window, or just
  // slipped past its listed start by a short grace.
  if (delta > SCHEDULE_LOOKAHEAD_MS || delta < -SCHEDULE_GRACE_PAST_MS) {
    return null;
  }
  return {
    state: "upcoming",
    leader: "President",
    title: toBannerTitle(details, "President"),
    watchUrl: e.video_url || e.url || WH_LIVE_URL,
    observedAt: now,
    startsAt: startMs,
  };
}

// ---------------------------------------------------------------------------
// Signal 4: keyed external source (pluggable, dormant)
// Left as a fail-soft slot. Adding a keyed source (e.g. the YouTube Data API)
// is a separate optional enhancement — this returns nothing unless a key is
// configured, and never throws.
// ---------------------------------------------------------------------------
async function detectKeyedSource(_now: number): Promise<Candidate[]> {
  // Example wiring point (intentionally not enabled here):
  //   if (process.env.YOUTUBE_API_KEY) { ...query live broadcasts... }
  return [];
}

// ---------------------------------------------------------------------------
// Aggregation + cache
// ---------------------------------------------------------------------------
let cached: LiveBroadcastStatus | null = null;
let lastComputed: number | null = null;
// Remembers the most recent confirmed-live event so we can show a short
// "recently ended" replay cue after every live signal has dropped off.
let lastLive: { status: LiveBroadcastStatus; at: number } | null = null;
// Remembers the most recent upcoming event that carried a REAL scheduled start,
// so that once it drops off (and its listed start has passed) we can show a
// short conservative "recently ended" cue — without ever having claimed LIVE.
let lastUpcoming: {
  status: LiveBroadcastStatus;
  startsAt: number;
  at: number;
} | null = null;

// ---------------------------------------------------------------------------
// Firing-log transition tracker
// Holds the DB row ID + signature of the currently-ongoing logged firing so
// repeated 30s recomputes of the same event don't insert duplicate rows.
// A "signature" is state|leader|title — any change means a new firing.
// ---------------------------------------------------------------------------
let _firingLogId: string | null = null;
let _firingLogKey: string | null = null;
let _activeEventKey: string | null = null;
let _activeDetectorStatus: LiveBroadcastStatus | null = null;
let _activeDetectorObservedAt: number | null = null;
// The source and observedAt of the most recent computeStatus() winning
// candidate — carried out via module-level variables so getLiveBroadcastStatus()
// can pass them to logFiringTransition without changing any function signatures.
let _lastComputedSource: string | undefined = undefined;
// The candidate's observedAt (time the underlying social post / event was seen),
// distinct from startsAt (scheduled start) and from the wall-clock now at compute
// time. This is the correct firstObservedAt for audit rows.
let _lastComputedObservedAt: number | undefined = undefined;

// Simple in-flight guard: prevents a concurrent recompute at the TTL boundary
// from racing logFiringTransition and inserting duplicate rows.
let _firingLogInFlight = false;

/**
 * Fire-and-forget: compare new status to last logged firing; write a new row
 * on genuine transitions; stamp endedAt when the banner goes dark or changes.
 * All DB errors are swallowed — this must never affect banner behavior.
 */
async function logFiringTransition(
  status: LiveBroadcastStatus | null,
  source: string | undefined,
  observedAt: number | undefined,
  now: number,
): Promise<void> {
  if (_firingLogInFlight) return; // concurrent recompute — skip safely
  _firingLogInFlight = true;
  try {
    const key = status ? `${status.state}|${status.leader}|${status.title}` : null;
    if (key === _firingLogKey) return; // same ongoing event — no duplicate

    if (status) {
      // One resolver owns BOTH in-process and restart continuity. The active
      // detector status is supplied as a synthetic recent firing so it receives
      // the same lifecycle/time/content checks as persisted transitions.
      let recent: Array<{
        eventKey: string;
        state: string;
        leader: string;
        title: string;
        watchUrl: string;
        startsAt?: Date | string | null;
        firstObservedAt: Date | string;
        endedAt?: Date | string | null;
      }> = [];
      if (_activeEventKey && _activeDetectorStatus) {
        const priorObserved = _activeDetectorObservedAt ?? now;
        recent.push({
          eventKey: _activeEventKey,
          state: _activeDetectorStatus.state,
          leader: _activeDetectorStatus.leader,
          title: _activeDetectorStatus.title,
          watchUrl: _activeDetectorStatus.watchUrl,
          startsAt: _activeDetectorStatus.startsAt ?? null,
          firstObservedAt: new Date(priorObserved),
          endedAt: _activeDetectorStatus.endsAt ?? null,
        });
      }
      try {
        recent.push(...await storage.getRecentLiveBroadcastFirings(24, 30));
      } catch {
        // Logging is fail-soft; deterministic derivation remains available.
      }
      _activeEventKey = resolveLiveBroadcastEventKey(status, observedAt, recent);
      _activeDetectorStatus = status;
      _activeDetectorObservedAt = observedAt ?? now;
    }

    // Close out the previous row when the firing ends or transitions.
    if (_firingLogId) {
      await storage.stampLiveBroadcastFiringEnded(_firingLogId, new Date(now));
      _firingLogId = null;
    }
    if (!status) {
      // Banner went dark — nothing new to record. Safe to mark idle now since
      // there is no insert that could fail and need a retry.
      _firingLogKey = key;
      _activeEventKey = null;
      _activeDetectorStatus = null;
      _activeDetectorObservedAt = null;
      return;
    }

    // firstObservedAt = when the underlying signal was actually observed
    // (the candidate's observedAt), NOT the scheduled start time.
    const firstObservedAt = observedAt ? new Date(observedAt) : new Date(now);

    const row = await storage.insertLiveBroadcastFiring({
      eventKey: _activeEventKey ?? deriveLiveBroadcastEventKey(status, observedAt),
      state: status.state,
      leader: status.leader,
      title: status.title,
      watchUrl: status.watchUrl,
      source: source ?? null,
      startsAt: status.startsAt ? new Date(status.startsAt) : null,
      firstObservedAt,
      endedAt: null,
    });
    _firingLogId = row.id;
    // Only mark this event as logged AFTER a successful insert. If the insert
    // throws transiently, _firingLogKey keeps the prior value so the next
    // recompute retries instead of silently dropping the audit row.
    _firingLogKey = key;
  } finally {
    _firingLogInFlight = false;
  }
}

const COMPUTE_TTL_MS = 30 * 1000;

// Reconcile all concurrent candidates down to the single broadcast the banner
// shows. Precedence, applied in order:
//   1. A live broadcast always outranks one that is merely upcoming.
//   2. Among leaders in the SAME state, the President ALWAYS takes precedence —
//      i.e. when two (or more) leaders are speaking at once, the President wins.
//      This is an explicit, hard guarantee that does NOT rely on the numeric
//      LEADER_PRIORITY weights, so a future weight tweak can never silently
//      demote the President below another leader who is also live.
//   3. Otherwise fall back to LEADER_PRIORITY, then the most recent observation.
export function pickBest(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => {
    const stateDiff = STATE_PRIORITY[b.state] - STATE_PRIORITY[a.state];
    if (stateDiff !== 0) return stateDiff;
    const aPotus = a.leader === "President" ? 1 : 0;
    const bPotus = b.leader === "President" ? 1 : 0;
    if (aPotus !== bPotus) return bPotus - aPotus;
    const leaderDiff = LEADER_PRIORITY[b.leader] - LEADER_PRIORITY[a.leader];
    if (leaderDiff !== 0) return leaderDiff;
    return b.observedAt - a.observedAt;
  })[0];
}

/**
 * Project the winning candidate into the public status shape. An upcoming
 * candidate carries `startsAt` ONLY when it had a real scheduled start — never
 * the post-observation timestamp (a free-text cue has no genuine countdown).
 * Pure; exported for regression tests.
 */
export function candidateToStatus(best: Candidate): LiveBroadcastStatus {
  if (best.state === "live") {
    return {
      state: "live",
      leader: best.leader,
      title: best.title,
      watchUrl: safeWatchUrl(best.watchUrl),
      since: new Date(best.observedAt).toISOString(),
    };
  }
  return {
    state: "upcoming",
    leader: best.leader,
    title: best.title,
    watchUrl: safeWatchUrl(best.watchUrl),
    ...(best.startsAt ? { startsAt: new Date(best.startsAt).toISOString() } : {}),
  };
}

async function computeStatus(): Promise<LiveBroadcastStatus | null> {
  const now = Date.now();
  // Each signal is independent and fail-soft; one failing must not sink the
  // rest.
  const groups = await Promise.all([
    detectSocialWatchLive(now).catch(() => [] as Candidate[]),
    detectWhiteHouseXSignal(now).catch(() => [] as Candidate[]),
    detectScheduledEvent(now).catch(() => [] as Candidate[]),
    detectScheduledUpcoming(now).catch(() => [] as Candidate[]),
    detectFactbaseSchedule(now).catch(() => [] as Candidate[]),
    detectKeylessOnAir(now).catch(() => [] as Candidate[]),
    detectYouTubeChannelLive(now).catch(() => [] as Candidate[]),
    detectCommitteeHearings(now).catch(() => [] as Candidate[]),
    detectNetworkLive(now).catch(() => [] as Candidate[]),
    detectKeyedSource(now).catch(() => [] as Candidate[]),
  ]);
  const candidates = groups.flat();
  const best = pickBest(candidates);

  if (best) {
    const status = candidateToStatus(best);
    _lastComputedSource = best.source;       // carry for audit log
    _lastComputedObservedAt = best.observedAt; // time the signal was actually observed
    if (best.state === "live") {
      lastLive = { status, at: now };
    } else if (best.state === "upcoming" && best.startsAt) {
      // Only an upcoming cue with a REAL scheduled start can later become a
      // conservative "recently ended" (we know when it was due to begin).
      lastUpcoming = { status, startsAt: best.startsAt, at: now };
    }
    return status;
  }
  _lastComputedSource = undefined;
  _lastComputedObservedAt = undefined; // no winning candidate — recently_ended has no direct source

  // Nothing live/upcoming right now — surface a short "recently ended" cue if
  // we saw a live event recently, then hide entirely.
  if (lastLive && now - lastLive.at <= RECENTLY_ENDED_MS) {
    return {
      state: "recently_ended",
      leader: lastLive.status.leader,
      title: lastLive.status.title,
      watchUrl: safeWatchUrl(lastLive.status.watchUrl),
      endsAt: new Date(lastLive.at).toISOString(),
    };
  }

  // Conservative "event over" path: we never confirmed LIVE, but a scheduled
  // event we were anticipating has had its listed start pass and then dropped
  // off the signals — show a brief "recently ended" cue (its listed start as the
  // end marker) so the banner doesn't just vanish mid-stream-of-attention.
  if (
    lastUpcoming &&
    now >= lastUpcoming.startsAt &&
    now - lastUpcoming.at <= RECENTLY_ENDED_MS
  ) {
    return {
      state: "recently_ended",
      leader: lastUpcoming.status.leader,
      title: lastUpcoming.status.title,
      watchUrl: safeWatchUrl(lastUpcoming.status.watchUrl),
      endsAt: new Date(lastUpcoming.startsAt).toISOString(),
    };
  }

  return null;
}

/**
 * Returns the cached live-broadcast status, recomputing at most once per TTL.
 * Never throws — on any failure it serves the last computed value (or null).
 */
export async function getLiveBroadcastStatus(): Promise<{
  status: LiveBroadcastStatus | null;
  lastComputed: number | null;
}> {
  const now = Date.now();
  if (lastComputed !== null && now - lastComputed < COMPUTE_TTL_MS) {
    return { status: cached, lastComputed };
  }
  try {
    cached = await computeStatus();
    lastComputed = now;
    // Fire-and-forget: log genuine transitions only. Any DB error is swallowed
    // and must never affect what the banner shows or the endpoint's latency.
    void logFiringTransition(cached, _lastComputedSource, _lastComputedObservedAt, now).catch((err: any) => {
      console.error("[LiveBroadcast] firing log error:", err?.message || err);
    });
  } catch (err: any) {
    console.error("[LiveBroadcast] compute failed:", err?.message || err);
    // Keep serving the last good value rather than flapping to empty.
  }
  return { status: cached, lastComputed };
}

async function resolveActiveLiveBroadcastEventKey(
  status: LiveBroadcastStatus,
): Promise<string> {
  const fallback = _activeEventKey ?? deriveLiveBroadcastEventKey(status, _lastComputedObservedAt);
  try {
    const recent: Array<{
      eventKey: string;
      state: string;
      leader: string;
      title: string;
      watchUrl: string;
      startsAt?: Date | string | null;
      firstObservedAt: Date | string;
      endedAt?: Date | string | null;
    }> = [];
    if (_activeEventKey && _activeDetectorStatus) {
      recent.push({
        eventKey: _activeEventKey,
        state: _activeDetectorStatus.state,
        leader: _activeDetectorStatus.leader,
        title: _activeDetectorStatus.title,
        watchUrl: _activeDetectorStatus.watchUrl,
        startsAt: _activeDetectorStatus.startsAt ?? null,
        firstObservedAt: new Date(_activeDetectorObservedAt ?? Date.now()),
        endedAt: _activeDetectorStatus.endsAt ?? null,
      });
    }
    recent.push(...await storage.getRecentLiveBroadcastFirings(24, 30));
    return resolveLiveBroadcastEventKey(status, _lastComputedObservedAt, recent);
  } catch (error: any) {
    console.warn("[LiveBroadcast] active event-key resolution failed:", error?.message || error);
    return fallback;
  }
}

/**
 * Resolve the Curated-only human moderation overlay over the detector result.
 * Any persistence/read failure returns the unmodified detector status: a
 * moderation outage must never break the status endpoint or the detector.
 */
export async function getModeratedLiveBroadcastStatus(): Promise<{
  status: LiveBroadcastStatus | null;
  lastComputed: number | null;
  eventKey: string | null;
}> {
  const result = await getLiveBroadcastStatus();
  if (!result.status) return { ...result, eventKey: null };
  const eventKey = await resolveActiveLiveBroadcastEventKey(result.status);
  try {
    const moderation = await storage.getLiveBroadcastModeration(eventKey);
    return {
      status: applyLiveBroadcastModeration(result.status, moderation),
      lastComputed: result.lastComputed,
      eventKey,
    };
  } catch (error: any) {
    console.warn("[LiveBroadcast] moderation read failed:", error?.message || error);
    return { ...result, eventKey };
  }
}

/**
 * Re-resolve the Curated moderation overlay immediately after an editor save.
 * This deliberately reuses the current detector snapshot: it does not re-run
 * external detectors, alter their precedence, or mutate the firing log.
 */
export async function refreshModeratedLiveBroadcastStatus(): ReturnType<
  typeof getModeratedLiveBroadcastStatus
> {
  return getModeratedLiveBroadcastStatus();
}
