/**
 * Regression test for the Curated display-title cleaner (cleanDisplayTitle).
 *
 * The cleaning rules are subtle: it must strip daily live-blog noise (day
 * counters, "Live:"/"Watch:" markers) WITHOUT touching context-bearing topic
 * prefixes like "Iran war:" or legitimate content that merely mentions "day N".
 * This locks that behavior so a future regex tweak can't silently over-strip a
 * real headline or stop cleaning a live-blog title.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/title-cleaner.test.ts
 * Exits non-zero on any failure.
 */
import { cleanDisplayTitle } from "../server/titleNormalizer";

const cases: Array<{ input: string; expected: string; why: string }> = [
  // Leading "<topic> war day <N>:" counter — the two live examples.
  {
    input: "Iran war day 106: US and Iran say deal close but Lebanon fighting continues",
    expected: "US and Iran say deal close but Lebanon fighting continues",
    why: "leading day counter stripped",
  },
  {
    input: "Iran war day 105: Trump halts attacks after Kharg Island threat",
    expected: "Trump halts attacks after Kharg Island threat",
    why: "leading day counter stripped",
  },
  {
    input: "Gaza war day 45: Ceasefire talks resume",
    expected: "Ceasefire talks resume",
    why: "leading day counter (other conflict) stripped",
  },
  // Context-bearing topic prefixes must be preserved untouched.
  {
    input: "Iran war: Pakistan PM says peace deal expected in 24 hours",
    expected: "Iran war: Pakistan PM says peace deal expected in 24 hours",
    why: "topic prefix preserved",
  },
  {
    input: "Sudan war: aid convoy blocked",
    expected: "Sudan war: aid convoy blocked",
    why: "topic prefix preserved",
  },
  // Standalone leading presentation markers.
  { input: "Live: Iran strikes Tel Aviv", expected: "Iran strikes Tel Aviv", why: "Live: marker stripped" },
  { input: "Watch: Missile launch over Gulf", expected: "Missile launch over Gulf", why: "Watch: marker stripped" },
  { input: "Watch Live: Pentagon briefing", expected: "Pentagon briefing", why: "Watch Live: marker stripped" },
  // Topic + trailing marker: keep the topic, drop only the marker.
  {
    input: "Iran war live: US and Iran say deal close",
    expected: "Iran war: US and Iran say deal close",
    why: "topic kept, live marker dropped",
  },
  // Trailing day-counter variants.
  {
    input: "Russia-Ukraine war: List of key events, day 800",
    expected: "Russia-Ukraine war",
    why: "trailing 'List of key events, day N' stripped",
  },
  {
    input: "Israel's war on Gaza: List of key events, day 200",
    expected: "Israel's war on Gaza",
    why: "trailing 'List of key events, day N' stripped",
  },
  {
    input: "US and Iran say deal close but Lebanon fighting continues, day 106",
    expected: "US and Iran say deal close but Lebanon fighting continues",
    why: "trailing ', day N' stripped",
  },
  // Times of Israel "Daily Briefing <Month> <DD> — " dateline.
  {
    input: "Daily Briefing June 22 — ‘A cease between fires’: Living on Israel’s northern front",
    expected: "‘A cease between fires’: Living on Israel’s northern front",
    why: "leading 'Daily Briefing <Month> <DD> —' dateline stripped",
  },
  {
    input: "Daily Briefing December 3 - Hostage deal nears as talks resume",
    expected: "Hostage deal nears as talks resume",
    why: "hyphen separator dateline stripped",
  },
  {
    input: "Daily Briefing Jan 7, 2026: What you need to know today",
    expected: "What you need to know today",
    why: "abbreviated month + year + colon dateline stripped",
  },
  // Safe: 'Daily Briefing' WITHOUT a date must NOT be altered.
  {
    input: "Daily Briefing: morning update from the front",
    expected: "Daily Briefing: morning update from the front",
    why: "'Daily Briefing' with no date is not a live-blog dateline",
  },
  // Safe content that must NOT be altered.
  {
    input: "Something happened on day 3 of the trial",
    expected: "Something happened on day 3 of the trial",
    why: "no comma before 'day N' → not a counter",
  },
  { input: "Trump: I will end the war", expected: "Trump: I will end the war", why: "non-marker colon segment preserved" },
  { input: "Stay alive: a survival guide", expected: "Stay alive: a survival guide", why: "'alive' is not a 'live' marker" },
  // Noun phrases ending in watch/live are NOT presentation markers — leave them.
  { input: "Market watch: Dow falls 300 points", expected: "Market watch: Dow falls 300 points", why: "'Market watch' is a noun phrase, not a marker" },
  { input: "Death watch: hospice care debated", expected: "Death watch: hospice care debated", why: "'Death watch' is a noun phrase, not a marker" },
  { input: "Markets live: stocks rally", expected: "Markets live: stocks rally", why: "'Markets live' is a noun phrase, not a marker" },
  { input: "Neighborhood watch: crime down", expected: "Neighborhood watch: crime down", why: "'Neighborhood watch' is a noun phrase, not a marker" },
  // Yonhap update markers: a leading "(LEAD)" / "(Nth LEAD)" is dropped.
  {
    input: "(LEAD) U.S. focused on ensuring OPCON transfer conditions will be met 'as soon as possible': senior official",
    expected: "U.S. focused on ensuring OPCON transfer conditions will be met 'as soon as possible': senior official",
    why: "leading Yonhap (LEAD) marker stripped",
  },
  { input: "(2nd LEAD) N. Korea fires ballistic missile", expected: "N. Korea fires ballistic missile", why: "leading (2nd LEAD) marker stripped" },
  { input: "(3rd LEAD) Seoul, Washington wrap up joint drills", expected: "Seoul, Washington wrap up joint drills", why: "leading (3rd LEAD) marker stripped" },
  { input: "(LEAD) (2nd LEAD) Stacked markers cleared", expected: "Stacked markers cleared", why: "stacked leading LEAD markers all stripped" },
  // Yonhap "(URGENT)" breaking marker is dropped, alone or stacked with LEAD.
  { input: "(URGENT) N. Korea fires ballistic missile toward East Sea", expected: "N. Korea fires ballistic missile toward East Sea", why: "leading Yonhap (URGENT) marker stripped" },
  { input: "(URGENT) (LEAD) Seoul confirms missile launch", expected: "Seoul confirms missile launch", why: "stacked (URGENT) + (LEAD) markers all stripped" },
  { input: "(LEAD) (URGENT) Defense ministry responds", expected: "Defense ministry responds", why: "stacked (LEAD) + (URGENT) markers all stripped" },
  // "Live updates:" / "Live update:" leading marker — stripped like "Live:".
  {
    input: "Live updates: Iran reportedly developed plot to target Trump; housing bill reaches veto deadline",
    expected: "Iran reportedly developed plot to target Trump; housing bill reaches veto deadline",
    why: "'Live updates:' leading marker stripped",
  },
  {
    input: "Live update: Ceasefire talks resume in Qatar",
    expected: "Ceasefire talks resume in Qatar",
    why: "'Live update:' (singular) leading marker stripped",
  },
  // Safe: "live"/"update(s)" mid-sentence — must NOT be altered.
  {
    input: "Officials live in fear as update on ceasefire remains unclear",
    expected: "Officials live in fear as update on ceasefire remains unclear",
    why: "'live' and 'update' mid-sentence are not a marker",
  },
  {
    input: "Follow live updates on the summit: day two begins",
    expected: "Follow live updates on the summit: day two begins",
    why: "'live updates' not at the very start is not a marker",
  },
  // "Breaking:" / "Developing:" / "Update:" standalone leading marker — stripped like "Live:".
  { input: "Breaking: Iran launches missiles at US base", expected: "Iran launches missiles at US base", why: "'Breaking:' leading marker stripped" },
  { input: "Developing: Ceasefire talks collapse overnight", expected: "Ceasefire talks collapse overnight", why: "'Developing:' leading marker stripped" },
  { input: "Update: Pentagon confirms troop movement", expected: "Pentagon confirms troop movement", why: "'Update:' leading marker stripped" },
  // Safe: longer phrases / mid-sentence uses of these words must NOT be altered.
  { input: "Breaking News: markets tumble", expected: "Breaking News: markets tumble", why: "'Breaking News' segment is not the bare 'Breaking' marker" },
  { input: "Developing story: what we know so far", expected: "Developing story: what we know so far", why: "'Developing story' segment is not the bare 'Developing' marker" },
  { input: "Software update: new features released", expected: "Software update: new features released", why: "'Software update' segment is not the bare 'Update' marker" },
  { input: "Officials update reporters on the crisis", expected: "Officials update reporters on the crisis", why: "'update' mid-sentence is not a marker" },
  // Agency datelines — the leading "<CITY> (<Agency>) —" is dropped.
  { input: "WASHINGTON (AP) — Senate passes defense spending bill", expected: "Senate passes defense spending bill", why: "leading 'WASHINGTON (AP) —' dateline stripped" },
  { input: "LONDON (Reuters) — UK announces new sanctions on Russia", expected: "UK announces new sanctions on Russia", why: "leading 'LONDON (Reuters) —' dateline stripped" },
  { input: "KYIV, Ukraine (Reuters) - Talks resume as strikes continue", expected: "Talks resume as strikes continue", why: "city+region dateline with hyphen separator stripped" },
  { input: "NEW YORK (AFP) — Markets rally on rate news", expected: "Markets rally on rate news", why: "multi-word all-caps city dateline stripped" },
  { input: "WASHINGTON, D.C. (AP) — Congress returns from recess", expected: "Congress returns from recess", why: "city with punctuated region + AP dateline stripped" },
  { input: "MOSCOW (TASS) - Kremlin denies involvement", expected: "Kremlin denies involvement", why: "TASS dateline stripped" },
  // Safe: ordinary Title-case headlines with a parenthetical must NOT be treated as datelines.
  { input: "Trump (finally) — a new era begins", expected: "Trump (finally) — a new era begins", why: "Title-case leading word is not an all-caps dateline city" },
  { input: "NASA (finally) launches long-delayed mission", expected: "NASA (finally) launches long-delayed mission", why: "no dash after the parenthetical → not a dateline" },
  // Safe: acronym-led headlines with a non-agency parenthetical + dash must NOT be truncated.
  { input: "US economy (analysis) - recession risks rise", expected: "US economy (analysis) - recession risks rise", why: "'analysis' is not a wire agency → not a dateline" },
  { input: "AI boom (podcast) - why investors are excited", expected: "AI boom (podcast) - why investors are excited", why: "'podcast' is not a wire agency → not a dateline" },
  { input: "UN report (full text) - what the findings mean", expected: "UN report (full text) - what the findings mean", why: "'full text' is not a wire agency → not a dateline" },
  { input: "NATO (explainer) — how the alliance works", expected: "NATO (explainer) — how the alliance works", why: "'explainer' is not a wire agency → not a dateline" },
  // Guardrails: only a LEADING exact-LEAD/URGENT parenthetical is touched.
  { input: "Report on (lead poisoning) in schools", expected: "Report on (lead poisoning) in schools", why: "'(lead poisoning)' is not a LEAD marker" },
  { input: "Markets rally (LEAD) on rate news", expected: "Markets rally (LEAD) on rate news", why: "mid-title (LEAD) is not stripped" },
  { input: "(Lead poisoning) cases rise in region", expected: "(Lead poisoning) cases rise in region", why: "leading '(Lead poisoning)' is not a LEAD marker" },
  { input: "(Urgent care) clinic opens in Seoul", expected: "(Urgent care) clinic opens in Seoul", why: "'(Urgent care)' is not an URGENT marker" },
  { input: "Hospital adds (URGENT) triage lane", expected: "Hospital adds (URGENT) triage lane", why: "mid-title (URGENT) is not stripped" },
];

let failures = 0;
for (const { input, expected, why } of cases) {
  const got = cleanDisplayTitle(input);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} [${why}]`);
  if (!ok) {
    console.log(`     input:    "${input}"`);
    console.log(`     expected: "${expected}"`);
    console.log(`     got:      "${got}"`);
  }
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
if (failures > 0) {
  console.error(`title-cleaner test FAILED: ${failures} case(s) did not match`);
  process.exit(1);
}
