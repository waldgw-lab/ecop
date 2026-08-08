/**
 * Regression test for the Curated capability-feature temper cap (Task #480).
 *
 * evalCuratedCapabilityCap is a deterministic, CAP-ONLY backstop in the Curated
 * ingest GATE path. Capability SHOWCASE / trend-FEATURE coverage — a "look at
 * our new hardware" reveal ("Army unveils its next-gen attack drone") or a
 * think-piece trend ("the future of drone warfare", "how AI is transforming
 * warfare") — carries heavy defense vocabulary, so the gate analyzer tends to
 * over-score it into the TOP band, above discrete strategic EVENTS (a strike, a
 * downing, an interception, casualties). This pulls that framing back to
 * CURATED_CAPABILITY_CAP so real events out-rank it.
 *
 * The soft cap can't do this: its strategic guard deliberately EXEMPTS defense
 * vocabulary and its floor (49) is far too low for a legitimate capability
 * story. So this is a SEPARATE, higher cap that fires ONLY on high-precision
 * feature/showcase framing AND only when NO discrete-event verb/outcome is
 * present — a real strike / downing / casualty story is NEVER tempered. It is
 * title-scoped (AI category untrusted) and must NEVER raise a score.
 *
 * This locks that behavior so a future keyword tweak can't silently start
 * clobbering real strike headlines, or stop tempering feature pieces.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-capability-cap.test.ts
 * Exits non-zero on any failure.
 */
import { evalCuratedCapabilityCap, CURATED_CAPABILITY_CAP } from "../server/scoreAdjustments";

interface Case {
  title: string;
  input: number;
  expected: number;
  why: string;
}

const cases: Case[] = [
  // ---- Capability SHOWCASE / reveal that MUST be capped to CURATED_CAPABILITY_CAP ----
  {
    title: "Army unveils its next-generation attack drone",
    input: 88,
    expected: CURATED_CAPABILITY_CAP,
    why: "the prompting case — showcase verb (unveils) + hardware (drone), next-gen framing, no event verb",
  },
  {
    title: "Pentagon showcases new hypersonic missile prototype",
    input: 90,
    expected: CURATED_CAPABILITY_CAP,
    why: "showcase (showcases) + hardware (hypersonic/missile), prototype framing",
  },
  {
    title: "China debuts stealth fighter jet at airshow",
    input: 84,
    expected: CURATED_CAPABILITY_CAP,
    why: "debut + hardware (stealth / fighter jet) — capability reveal",
  },
  {
    title: "North Korea parades new intercontinental missiles in Pyongyang",
    input: 86,
    expected: CURATED_CAPABILITY_CAP,
    why: "parade + hardware (missiles) — a showcase, not a launch/strike",
  },
  {
    title: "Russia shows off upgraded battle tank to state media",
    input: 82,
    expected: CURATED_CAPABILITY_CAP,
    why: "'shows off' + hardware (battle tank) — marketing reveal",
  },
  {
    title: "Defense firm touts autonomous drone swarm capability",
    input: 80,
    expected: CURATED_CAPABILITY_CAP,
    why: "touts + hardware (autonomous / drone swarm) — capability profile",
  },
  {
    title: "Navy unveils new laser weapon system aboard destroyer",
    input: 83,
    expected: CURATED_CAPABILITY_CAP,
    why: "unveils + hardware (laser / weapon system / destroyer)",
  },

  // ---- Trend / think-piece FEATURE framing that MUST be capped (no hardware co-mention needed) ----
  {
    title: "The future of drone warfare is autonomous swarms",
    input: 85,
    expected: CURATED_CAPABILITY_CAP,
    why: "'future of drone warfare' — pure trend framing",
  },
  {
    title: "The future of warfare will be won by algorithms",
    input: 88,
    expected: CURATED_CAPABILITY_CAP,
    why: "'future of warfare' trend framing, no event verb",
  },
  {
    title: "How AI is transforming modern warfare",
    input: 84,
    expected: CURATED_CAPABILITY_CAP,
    why: "how + transforming + warfare — trend think-piece",
  },
  {
    title: "Why drones are reshaping the modern battlefield",
    input: 80,
    expected: CURATED_CAPABILITY_CAP,
    why: "why + reshaping + battlefield — trend think-piece",
  },
  {
    title: "How hypersonics are changing the calculus of war",
    input: 82,
    expected: CURATED_CAPABILITY_CAP,
    why: "how + changing + war — trend framing",
  },

  // ---- REAL discrete events — MUST NOT be capped (event exemption wins) ----
  {
    title: "US drone strike kills senior militant commander",
    input: 90,
    expected: 90,
    why: "strike + kills — a real event, never tempered even though 'drone' is hardware",
  },
  {
    title: "Iran shoots down US surveillance drone over the Gulf",
    input: 88,
    expected: 88,
    why: "'shoots down' — a real downing event",
  },
  {
    title: "Ukraine downs Russian fighter jet near Kharkiv",
    input: 86,
    expected: 86,
    why: "'downs' — a real shootdown, jet hardware present but event exempts it",
  },
  {
    title: "Houthis launch drone attack on oil tanker in Red Sea",
    input: 87,
    expected: 87,
    why: "'launch ... drone attack' — a real attack, exempt despite 'drone'",
  },
  {
    title: "Missile strike destroys ammunition depot in eastern Ukraine",
    input: 89,
    expected: 89,
    why: "strike + destroys — real strike, never tempered",
  },
  {
    title: "Russia unveils hypersonic missile hours after striking Kyiv",
    input: 90,
    expected: 90,
    why: "has showcase framing (unveils + missile) BUT the event verb (striking) exempts the whole headline — event wins",
  },
  {
    title: "Drone swarm hits refinery, sparking massive blaze",
    input: 85,
    expected: 85,
    why: "'hits' + blast/fire aftermath — a real attack, not a showcase",
  },
  {
    title: "Attack helicopter shot down during firefight",
    input: 86,
    expected: 86,
    why: "'shot down' + firefight — real event; 'attack helicopter' hardware must NOT trigger the cap",
  },

  // ---- Weapons TESTS — MUST NOT be capped (test-fire deliberately excluded from showcase verbs) ----
  {
    title: "North Korea test-fires ballistic missile into the sea",
    input: 84,
    expected: 84,
    why: "a weapons TEST is a strategically significant event; test-fire is excluded from showcase verbs and there is no other showcase framing",
  },
  {
    title: "Iran conducts test-launch of new satellite carrier rocket",
    input: 82,
    expected: 82,
    why: "test-launch is a test event, not a marketing reveal — no showcase verb matched",
  },

  // ---- Showcase VERB with NO hardware — MUST NOT be capped (needs hardware co-mention) ----
  {
    title: "US unveils new sanctions package targeting Iran's oil exports",
    input: 84,
    expected: 84,
    why: "'unveils' but the object is sanctions (no hardware) — not a capability showcase",
  },
  {
    title: "White House unveils federal budget proposal for next fiscal year",
    input: 80,
    expected: 80,
    why: "'unveils' but budget (no hardware) — not a capability showcase",
  },
  {
    title: "President unveils sweeping immigration reform plan",
    input: 78,
    expected: 78,
    why: "'unveils' but policy plan (no hardware) — untouched",
  },

  // ---- Intelligence / findings that use ambiguous verbs — MUST NOT be capped ----
  {
    title: "Satellite images reveal new missile site under construction",
    input: 84,
    expected: 84,
    why: "'reveal' is deliberately NOT a showcase verb (collides with intelligence findings) — a buildup story stays uncapped",
  },
  {
    title: "Leaked documents show new drone program details",
    input: 82,
    expected: 82,
    why: "'show' (not 'shows off') is not a showcase verb — an intelligence/leak story is untouched",
  },

  // ---- Scores at / below the cap — MUST be left untouched ----
  {
    title: "Army unveils its next-generation attack drone",
    input: CURATED_CAPABILITY_CAP,
    expected: CURATED_CAPABILITY_CAP,
    why: "a feature already AT the cap is returned unchanged (cap-only, never lowers below)",
  },
  {
    title: "The future of drone warfare is autonomous swarms",
    input: 60,
    expected: 60,
    why: "feature framing but already below the cap — never raised, never touched",
  },
  {
    title: "Pentagon showcases new hypersonic missile prototype",
    input: 74,
    expected: 74,
    why: "one point below the cap — untouched",
  },

  // ---- Non-capability high scorers — MUST NOT be capped (no framing at all) ----
  {
    title: "Secretary of Defense meets NATO counterparts in Brussels",
    input: 82,
    expected: 82,
    why: "no showcase/trend framing and no hardware — a diplomacy story, untouched",
  },
  {
    title: "Congress passes annual defense authorization bill",
    input: 80,
    expected: 80,
    why: "legislation, no showcase/trend framing — untouched",
  },
  {
    title: "Pentagon think tank publishes report on great-power competition",
    input: 84,
    expected: 84,
    why: "'think tank' must NOT match the 'tank' hardware noun (negative lookbehind); no showcase framing anyway",
  },
];

let failures = 0;
for (const c of cases) {
  const got = evalCuratedCapabilityCap(c.title, c.input);
  const ok = got.score === c.expected;
  if (ok) {
    console.log(`[capability-cap] OK   ${c.input}->${got.score} (${got.reason ?? "no-cap"})  "${c.title}"`);
  } else {
    console.error(
      `[capability-cap] FAIL "${c.title}"\n    input=${c.input} expected=${c.expected} got=${got.score} reason=${got.reason ?? "null"}\n    why: ${c.why}`,
    );
    failures++;
  }
}

// A capped result must always carry the reason tag, and an uncapped result must not.
for (const c of cases) {
  const got = evalCuratedCapabilityCap(c.title, c.input);
  const lowered = got.score < c.input;
  if (lowered && got.reason == null) {
    console.error(`[capability-cap] FAIL reason missing on a lowered score: "${c.title}"`);
    failures++;
  }
  if (!lowered && got.reason != null) {
    console.error(`[capability-cap] FAIL reason present but score not lowered: "${c.title}"`);
    failures++;
  }
  if (got.score > c.input) {
    console.error(`[capability-cap] FAIL cap RAISED a score (must never happen): "${c.title}"`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n[capability-cap] ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n[capability-cap] ALL PASS (${cases.length} cases, cap=${CURATED_CAPABILITY_CAP})`);
}
