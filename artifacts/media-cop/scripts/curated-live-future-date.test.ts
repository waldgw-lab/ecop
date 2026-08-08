/**
 * Regression test for the Curated live-broadcast SOCIAL "upcoming" false-positive
 * guard (mentionsFutureDate).
 *
 * THE bug this guards against: a leader's recent Truth Social / X post can carry
 * "about to happen" language ("to speak", "will address") while actually
 * PREVIEWING a specific FUTURE calendar date — e.g.
 *   "Last night's Rally was packed … July 4th will be a step beyond anything
 *    you've ever seen … I'll be there to speak about how Great our Country is …"
 * That post is recent, so the social signal's recency gate passes, and "to
 * speak" matches UPCOMING_LANGUAGE_RE — but the event is July 4th, not imminent.
 * mentionsFutureDate() detects the future-date reference so the social upcoming
 * cue is suppressed. The schedule / Factbase signals (which carry a real start
 * time) still own the cue when the event actually approaches.
 *
 * Crucially, same-day language ("today", "tonight", "this evening", "now",
 * "shortly", "live at <time>") must NOT be treated as future, so a genuine
 * same-day announcement still fires the banner.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-live-future-date.test.ts
 * Exits non-zero on any failure.
 */
import { mentionsFutureDate } from "../server/liveBroadcastStatus";

interface Case {
  text: string;
  expected: boolean;
  why: string;
}

const cases: Case[] = [
  // ---- THE reported false positive: a future-dated preview must be future ----
  {
    text:
      "Last night's Rally was packed — 45,000 people. July 4th will be a step beyond anything you've ever seen. The Military flyovers will be the best, EVER. I'll be there to speak about how Great our Country is and, Making America Great Again!",
    expected: true,
    why: "THE bug: 'July 4th' preview with 'to speak' → future, not imminent",
  },

  // ---- month + day forms ----
  { text: "Remarks on July 4 at the National Mall.", expected: true, why: "month + bare day" },
  { text: "Big speech January 6th, mark your calendars.", expected: true, why: "month + ordinal day" },
  { text: "Jul 4 will be historic.", expected: true, why: "abbreviated month + day" },
  { text: "See you Dec. 25 for the address.", expected: true, why: "abbrev month w/ period + day" },

  // ---- day-of-month + holiday spelling ----
  { text: "I will speak on the 4th of July.", expected: true, why: "day of month" },
  { text: "The Fourth of July will be unforgettable.", expected: true, why: "spelled-out holiday" },

  // ---- relative future windows ----
  { text: "I'll address the nation next week.", expected: true, why: "next week" },
  { text: "Major announcement coming next month.", expected: true, why: "next month" },
  { text: "I will speak tomorrow about the economy.", expected: true, why: "tomorrow" },
  { text: "Tune in this weekend for a big one.", expected: true, why: "this weekend" },
  { text: "Press conference on Monday.", expected: true, why: "qualified weekday (on)" },
  { text: "I'll deliver remarks this Saturday.", expected: true, why: "qualified weekday (this)" },
  { text: "Remarks next Friday from the Oval Office.", expected: true, why: "qualified weekday (next)" },

  // ---- NEAR-TERM / same-day language must NOT be treated as future ----
  {
    text: "President Trump delivers remarks at 2:00 PM ET today. Watch live.",
    expected: false,
    why: "same-day 'today' is not a future-date preview",
  },
  { text: "I'll speak tonight from the White House.", expected: false, why: "'tonight' is same-day" },
  { text: "Joining live this afternoon.", expected: false, why: "'this afternoon' is same-day" },
  { text: "Remarks this evening on the talks.", expected: false, why: "'this evening' is same-day" },
  { text: "Tune in at 3pm, coming up shortly.", expected: false, why: "'shortly'/'coming up' near-term" },
  { text: "We are LIVE now from the Pentagon.", expected: false, why: "live-now carries no future date" },
  { text: "Watch live: Secretary Rubio delivers remarks.", expected: false, why: "no date reference at all" },

  // ---- guard against over-matching the month 'may' modal & bare weekday ----
  {
    text: "He may speak about the budget at some point.",
    expected: false,
    why: "modal 'may' (no following day number) must not match the month branch",
  },
  {
    text: "Monday's briefing covered readiness.",
    expected: false,
    why: "bare weekday without this/next/on/coming qualifier must not match",
  },

  // ---- degenerate input ----
  { text: "", expected: false, why: "empty string → false" },
];

let failures = 0;
for (const c of cases) {
  const got = mentionsFutureDate(c.text);
  const ok = got === c.expected;
  if (!ok) {
    failures++;
    console.error(
      `FAIL expected ${c.expected} got ${got} — ${c.why}\n   text: ${c.text}`,
    );
  } else {
    console.log(`ok   → ${got} (${c.why})`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} future-date guard cases passed.`);
