// Tests for the read-time Focus-slot keyword fallback inferFocus() (Task #611).
// This deterministic guesser fills the curated card's FOCUS slot for a row the
// overlay hasn't classified yet, so a fresh/clustered-but-real story shows a
// meaningful geography instead of falling through to the alarming "Global · DEMO"
// placeholder. Two properties under test:
//   1. FOREIGN-first precision: a U.S.-actor-abroad story resolves to the FOREIGN
//      theater, never to the U.S./domestic path.
//   2. A first-class U.S./domestic path catches the federal branches / agencies /
//      domestic politics that previously fell through to "Global".
import { inferFocus } from "../shared/classificationVocab";

let passed = 0;
let failed = 0;

function expect(title: string, want: string | null, ...extra: string[]) {
  const got = inferFocus(title, ...extra);
  if (got === want) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL: ${JSON.stringify(title)}\n      want: ${want}\n      got:  ${got}`,
    );
  }
}

// --- The card from the report: was stuck on "Global · DEMO" before this fix ----
expect("Supreme Court expands Trump's power over the federal bureaucracy", "United States");

// --- U.S. / domestic path: federal branches, agencies, domestic politics -------
expect("White House unveils new budget proposal", "United States");
expect("Congress passes stopgap funding bill to avert government shutdown", "United States");
expect("Senate confirms new Pentagon nominee", "United States");
expect("Federal Reserve holds interest rates steady", "United States");
expect("DOJ opens probe into federal agency contracts", "United States");
expect("FBI warns of domestic threats ahead of election", "United States");
expect("Federal workers brace for layoffs across agencies", "United States");
expect("Homeland Security expands border operations", "United States");
expect("National Guard deployed to the capital", "United States");
// A domestic DOJ press-freedom action remains U.S.-focused even though the
// underlying reporting names North Korea. This is the reported Reuters family.
expect("US Justice Department subpoenas New York Times freelancer over North Korea story", "United States");

// --- FOREIGN-first precision: U.S.-actor-abroad resolves to the FOREIGN theater -
expect("Trump threatens Iran with new strikes", "Iran");
expect("Pentagon strikes Houthi targets in Yemen", "Middle East");
expect("White House weighs sanctions on Russia over Ukraine", "Russia / Ukraine");
expect("Congress debates Taiwan arms package", "China");
expect("Senate votes on Israel aid bill", "Israel");
// Do not overcorrect: a real U.S. action abroad remains foreign-theater focused.
expect("Justice Department charges North Korean operative over cyber theft", "North Korea");

// --- Foreign theaters, standalone --------------------------------------------
expect("Maduro rejects opposition demands in Venezuela", "Venezuela");
expect("Trump floats buying Greenland again", "Greenland");
expect("Netanyahu addresses the nation amid Gaza fighting", "Israel");
expect("Putin meets Xi Jinping in Moscow", "Russia / Ukraine"); // Russia tested before China
expect("North Korea tests new missile", "North Korea");
expect("Modi visits New Delhi summit", "India");
expect("Cartel violence spikes in Mexico", "Mexico / South America");
expect("Sudan conflict displaces millions across Africa", "Africa");
expect("NATO expands exercises across Europe", "Europe");

// --- Precision guards: ambiguous / non-geographic do NOT match ----------------
expect("Ice storm knocks out power across the Midwest", null); // no bare "ice"->ICE
expect("Markets rally as tech stocks surge", null);
expect("New smartphone launch breaks sales records", null);
expect("Global supply chains strain under new tariffs", null); // no geo signal -> "Global" fallback handled by caller

// --- Summary text is also considered (caller passes title + displayTitle + summary)
expect("Court ruling reshapes agency power", "United States", "", "The Supreme Court decision limits the federal bureaucracy.");

console.log(`\ncurated-focus-inference: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
