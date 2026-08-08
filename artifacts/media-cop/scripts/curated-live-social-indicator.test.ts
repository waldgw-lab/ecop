/**
 * Regression test for the Curated live-broadcast SOCIAL early-indicator
 * attribution (extends Task #420).
 *
 * attributeXPostLeader maps an ingested X post to one of the four covered
 * leaders for the live-broadcast banner:
 *   - OWNER handle (the account IS the leader, e.g. @SecRubio, @SecWar) → that
 *     leader, even when the post text does not re-name them.
 *   - SPOKES / ORG handle (e.g. @PressSec for the White House, @StateDept) →
 *     ONLY the covered leader the post text explicitly NAMES; null otherwise.
 *     This is the early-indicator path the user asked for, and the named-leader
 *     gate is what guarantees a press-secretary's own briefing never lights the
 *     banner as the President being LIVE (a false "LIVE" is worse than a missed
 *     one).
 *   - Any other handle → null (fail-closed; never guesses).
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-live-social-indicator.test.ts
 * Exits non-zero on any failure.
 */
import {
  attributeXPostLeader,
  type BroadcastLeader,
} from "../server/liveBroadcastStatus";

interface Case {
  handle: string;
  content: string;
  expected: BroadcastLeader | null;
  why: string;
}

const cases: Case[] = [
  // ---- OWNER handles: attributed by the handle itself (no re-name needed) ----
  {
    handle: "SecRubio",
    content: "Heading to the podium shortly. Watch live.",
    expected: "Secretary of State",
    why: "owner handle → its leader even without naming",
  },
  {
    handle: "SecWar",
    content: "We are LIVE now from the Pentagon.",
    expected: "Secretary of War",
    why: "owner handle SecWar → Secretary of War",
  },
  {
    handle: "PeteHegseth",
    content: "Tune in.",
    expected: "Secretary of War",
    why: "owner handle PeteHegseth → Secretary of War",
  },
  {
    handle: "@SecRubio",
    content: "Remarks at 2pm.",
    expected: "Secretary of State",
    why: "leading @ is stripped before lookup",
  },

  // ---- SPOKES / ORG handles: ONLY when a covered leader is NAMED ----
  {
    handle: "PressSec",
    content: "Tune in: President Trump delivers remarks at 2:00 PM ET. Watch live.",
    expected: "President",
    why: "White House Press Sec naming the President → early indicator for POTUS",
  },
  {
    handle: "PressSec",
    content: "Watch today's White House press briefing live.",
    expected: null,
    why: "THE false-positive guard: a press-sec's OWN briefing names no covered leader → never the President LIVE",
  },
  {
    handle: "StateDept",
    content: "Watch live: Secretary Rubio delivers remarks on the talks.",
    expected: "Secretary of State",
    why: "State Dept org account naming the Secretary → early indicator for Sec State",
  },
  {
    handle: "StateDept",
    content: "Watch live: a briefing on visa policy updates.",
    expected: null,
    why: "org account with no covered leader named → no banner",
  },
  {
    handle: "TheJointStaff",
    content: "Secretary of War Hegseth speaks live to the troops.",
    expected: "Secretary of War",
    why: "Joint Staff naming Sec War → early indicator for Sec War",
  },
  {
    handle: "SecArmy",
    content: "Army readiness update for the quarter.",
    expected: null,
    why: "service secretary, no covered leader named → no banner",
  },

  // ---- case-insensitivity of the spokes lookup ----
  {
    handle: "presssec",
    content: "President Trump LIVE now.",
    expected: "President",
    why: "lowercased handle still matches the spokes set",
  },

  // ---- unknown handle: never qualifies, even with a named leader + live cue ----
  {
    handle: "SomeRandomAccount",
    content: "President Trump is LIVE right now, watch!",
    expected: null,
    why: "fail-closed: an unlisted handle never lights the banner",
  },
  {
    handle: "",
    content: "President Trump LIVE.",
    expected: null,
    why: "empty handle → null",
  },
];

let failures = 0;
for (const c of cases) {
  const got = attributeXPostLeader(c.handle, c.content);
  const ok = got === c.expected;
  if (!ok) {
    failures++;
    console.error(
      `FAIL [@${c.handle}] expected ${JSON.stringify(c.expected)} got ${JSON.stringify(got)} — ${c.why}\n   content: ${c.content}`,
    );
  } else {
    console.log(`ok   [@${c.handle}] → ${JSON.stringify(got)} (${c.why})`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} social-indicator attribution cases passed.`);
