// Tests for the read-time Topic-slot keyword fallback inferPrimaryTopic().
// This guesser bridges the gap while the async controlled-vocab classifier runs
// behind ingestion, so a fresh row shows a sensible Topic instead of "—".
// Focus: the maritime-chokepoint and energy/infrastructure buckets (the most
// common subjects in this app) plus precision guards that keep kinetic stories
// in Military Ops and bare market-price stories OUT of the energy bucket.
import {
  inferPrimaryTopic,
  primaryTopicShortLabel,
  type RealPrimaryTopic,
} from "../shared/classificationVocab";

let passed = 0;
let failed = 0;

function expect(title: string, want: RealPrimaryTopic | null) {
  const got = inferPrimaryTopic(title);
  if (got === want) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL: ${JSON.stringify(title)}\n      want: ${want}\n      got:  ${got}`,
    );
  }
}

function expectNot(title: string, unwanted: RealPrimaryTopic) {
  const got = inferPrimaryTopic(title);
  if (got !== unwanted) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL: ${JSON.stringify(title)}\n      must not be: ${unwanted}\n      got:         ${got}`,
    );
  }
}

// --- The two cards from the report: were stuck on "—" before this fix --------
expect("Strait of Hormuz oil flow 'back towards normal': Energy secretary",
  "Maritime Security & Chokepoints");
expect("Hormuz Transit Security Is 'Hour to Hour' Play, Chubb CEO Says",
  "Maritime Security & Chokepoints");

// --- Maritime Security & Chokepoints -----------------------------------------
expect("Iran threatens to close the Strait of Hormuz", "Maritime Security & Chokepoints");
expect("US ships escort oil tankers through Hormuz", "Maritime Security & Chokepoints");
expect("Houthis attack shipping lanes in the Red Sea", "Maritime Security & Chokepoints");
expect("Tensions rise over the Taiwan Strait", "Maritime Security & Chokepoints");
expect("Freedom of navigation operation in the South China Sea", "Maritime Security & Chokepoints");
expect("Suez Canal traffic disrupted by drifting supertanker", "Maritime Security & Chokepoints");
expect("Bab-el-Mandeb chokepoint sees rerouted vessels", "Maritime Security & Chokepoints");

// --- Critical Infrastructure, Energy & Supply Chains -------------------------
expect("Nord Stream pipeline sabotage probe widens", "Critical Infrastructure, Energy & Supply Chains");
expect("Attack on refinery cuts national fuel supply", "Critical Infrastructure, Energy & Supply Chains");
expect("Power grid outage hits the capital", "Critical Infrastructure, Energy & Supply Chains");
expect("Iraq moves to boost oil exports", "Critical Infrastructure, Energy & Supply Chains");
expect("Europe scrambles to secure natural gas supply", "Critical Infrastructure, Energy & Supply Chains");
expect("Global supply chains strain under new tariffs", "Critical Infrastructure, Energy & Supply Chains");

// --- Precision guards: kinetic stays Military Ops (runs before maritime) ------
expect("US strikes Iranian vessel in the Strait of Hormuz", "Military Operations & Armed Conflict");
expect("Naval clash near the Strait of Hormuz", "Military Operations & Armed Conflict");
expect("Missile attack on Red Sea tanker", "Military Operations & Armed Conflict");

// --- Precision guards: stronger buckets still win their terms -----------------
expect("New sanctions target Iran oil exports", "Economic Statecraft & Sanctions");
expect("Nuclear enrichment continues despite oil supply talks", "Nuclear, WMD & Strategic Deterrence");

// --- Precision guards: unrelated / bare-market headlines do NOT match ---------
expect("Oil prices climb on demand outlook", null); // bare market price, not infrastructure
expect("Crude oil prices climb on demand outlook", null); // bare market price, not infrastructure
expect("KC-46 aerial refueling tanker delivered to the Air Force", null); // aircraft, not a vessel
expect("President signs domestic education bill", null);
expect("City council approves new park budget", null);

// --- Classifier-outage display rescue: high-confidence topic families --------
// These remain display-only guesses. They must bridge temporary missing overlays
// without broad terms that could silently misclassify unrelated reporting.
expect("Iran’s president blames foreign pressure as expert warns regime's economy nears breaking point",
  "Governance, Elections & Domestic Stability");
expect("Loophole forcing release of detained illegal immigrants targeted by Senate GOP",
  "Border, Homeland & Internal Security");
expect("CIA Sets Up Secret Cuba Task Force as White House Pressures Havana",
  "Intelligence, Espionage & Security Services");
expect("Trump says US has massive munitions stockpile",
  "Weapons, Procurement & Defense Industry");
expect("Senate committee votes to hold Fauci in contempt",
  "Law, Courts & International Norms");
expect("Qdoba removes jalapeños as salmonella outbreak spreads to 27 states",
  "Public Health, Disaster & Environmental Security");
expect("Cyclospora outbreak tied to lettuce now linked to 15 states, CDC says",
  "Public Health, Disaster & Environmental Security");

// Precision negatives for the new rules.
expect("Government weighs new economic package as growth slows", null);
expect("Senate committee votes to advance annual farm bill", null);
expect("Secret recipe makes this restaurant's stockpile of spices famous", null);
expect("Migrants open new businesses after settling in the city", null);

// --- Vessel-qualified tankers DO match maritime ------------------------------
expect("LNG tanker rerouted amid Gulf tensions", "Maritime Security & Chokepoints");

// --- New: Panama Canal & other named waterways / chokepoints -----------------
expect("Panama Canal drought forces ship draft limits, transit delays mount",
  "Maritime Security & Chokepoints");
expect("China eyes influence over Panama Canal as US access concerns grow",
  "Maritime Security & Chokepoints");
expect("US warships assert rights through Bosporus amid Russia tensions",
  "Maritime Security & Chokepoints");
expect("Drought cuts canal traffic through a key Central American waterway",
  "Maritime Security & Chokepoints");
expect("Gibraltar strait sees record warship transits as NATO exercises expand",
  "Maritime Security & Chokepoints");

// --- New: Critical minerals / rare earths ------------------------------------
expect("China restricts gallium and germanium exports in retaliation over chip controls",
  "Critical Infrastructure, Energy & Supply Chains");
expect("US scrambles to secure rare earth supply as China tightens export curbs",
  "Critical Infrastructure, Energy & Supply Chains");
expect("Pentagon warns of critical minerals shortfall in defense supply chain",
  "Critical Infrastructure, Energy & Supply Chains");
expect("Australia-US lithium deal aims to reduce dependence on Chinese processing",
  "Critical Infrastructure, Energy & Supply Chains");
expect("Cobalt stockpile deal signed to reduce adversary supply leverage",
  "Critical Infrastructure, Energy & Supply Chains");

// --- Diplomacy misrouting regression: energy "agreement"/"talks" stay Infrastructure ---
// LNG / natural-gas / pipeline headlines that contain "agreement" or "talks"
// must NOT route to Diplomacy. Fix: rule 5 now requires an explicit diplomatic
// qualifier for bare "agreement", "accord", and "talks" — none of these energy
// headlines carry such a qualifier, so they fall through to rule 7c (Infrastructure).
expect("Qatar LNG supply agreement with Germany extended through 2030",
  "Critical Infrastructure, Energy & Supply Chains");
expect("Russia natural gas supply agreement with Hungary renewed amid winter demand",
  "Critical Infrastructure, Energy & Supply Chains");
expect("US and Canada pipeline agreement targets oil sands exports",
  "Critical Infrastructure, Energy & Supply Chains");
expect("LNG supply talks between Qatar and Germany resume after price dispute",
  "Critical Infrastructure, Energy & Supply Chains");
expect("Energy supply talks between the US and Saudi Arabia target oil output cuts",
  "Critical Infrastructure, Energy & Supply Chains");
expect("Pipeline accord between Turkey and Azerbaijan expanded to carry more gas",
  "Critical Infrastructure, Energy & Supply Chains");

// --- Diplomatic qualifiers still correctly route to Diplomacy ----------------
// After the fix, "security agreement", "ceasefire accord", etc. still hit Diplomacy.
expect("US and Iraq sign security agreement on military cooperation",
  "Foreign Policy & Diplomacy");
expect("Israel and Hamas reach ceasefire accord brokered by Qatar",
  "Foreign Policy & Diplomacy");
// "Taliban-US talks" no longer matches any qualified "talks" pattern — returns
// null (conservative fallback; the stored AI classification fills the gap).
expect("Taliban-US talks in Doha produce no breakthrough on aid", null);

// --- Domestic legal action with incidental foreign reference -----------------
expect("US Justice Department subpoenas New York Times freelancer over North Korea story",
  "Law, Courts & International Norms");
// Press actors alone do not make a story a legal-process story. Kinetic and
// security stories must retain their substantive Topic while AI classification is
// still pending.
expect("Journalists killed in Gaza strike as fighting intensifies",
  "Military Operations & Armed Conflict");
expect("Reuters reporter detained in Moscow on espionage charges", null);
expect("Prosecutors say Iranian airstrike killed civilians",
  "Military Operations & Armed Conflict");
expectNot("Justice Department charges North Korean operative over cyber theft",
  "Law, Courts & International Norms");

// --- Diplomacy narrowing: bare "trade agreement" / bare-accord forms ---------
// The narrowing dropped bare \bagreement\b and \baccord\b from rule 5 in favor
// of qualifier-gated patterns. Purely-economic "trade agreement" headlines with
// no diplomatic qualifier now fall through to null (the stored AI classifier
// fills the Topic later); they must NOT route to Diplomacy.
expect("US-China trade agreement reached after months of tariff standoff", null);
expect("Trade agreement signed to lower tariffs on autos", null);
expect("Two nations resume trade talks after tariff spat", null);
expect("Countries reach trade accord to ease tariffs", null);

// A diplomatic qualifier attached to "talks" still routes to Diplomacy.
expect("Russia-Ukraine direct talks resume in Istanbul", "Foreign Policy & Diplomacy");
expect("Peace talks resume between rival factions", "Foreign Policy & Diplomacy");
expect("Hostage talks yield partial release", "Foreign Policy & Diplomacy");
// "envoy" is a standalone rule-5 diplomatic marker (no qualifier needed).
expect("US envoy signals progress in talks with Tehran", "Foreign Policy & Diplomacy");
expect("Envoy dispatched to broker ceasefire", "Foreign Policy & Diplomacy");
// Qualified "agreement" (diplomatic adjective) still hits Diplomacy.
expect("Diplomatic agreement reached on visa rules", "Foreign Policy & Diplomacy");
// Summit / bilateral framing is unaffected by the narrowing.
expect("Bilateral summit between US and India yields defense pact", "Foreign Policy & Diplomacy");
expect("Normalization talks between Israel and Saudi Arabia advance", "Foreign Policy & Diplomacy");

// --- Terror-attack routing (Berlin Pride van-ramming family) ------------------
// Real headline family from the Berlin event: bare "terror", "Islamist(s)",
// van/car/truck/vehicle-ramming forms — must route to the Terrorism bucket
// immediately (no "—" flash) instead of scattering to crime/catch-all.
expect("Van rams into crowd at Berlin Pride parade, several dead",
  "Terrorism, Insurgency & Non-State Armed Groups");
expect("Berlin van-ramming: police probe Islamist motive",
  "Terrorism, Insurgency & Non-State Armed Groups");
expect("Germany raises terror alert after Pride parade ramming attack",
  "Terrorism, Insurgency & Non-State Armed Groups");
expect("Islamist suspect arrested after vehicle-ramming at public festival",
  "Terrorism, Insurgency & Non-State Armed Groups");
expect("Manhunt underway after truck ramming near Christmas market; terror probe opened",
  "Terrorism, Insurgency & Non-State Armed Groups");
expect("Car ramming at parade leaves dozens injured, terror not ruled out",
  "Terrorism, Insurgency & Non-State Armed Groups");
expect("Islamists claim responsibility for market bombing",
  "Terrorism, Insurgency & Non-State Armed Groups");

// --- Terror-attack negatives: no regression on adjacent families --------------
// State-vs-state kinetic stories still hit Military Ops (rule ordering: the
// terrorism rule keys only unambiguous terror terms, never bare "attack"/"strike").
expect("Russian missile strike hits Kyiv apartment block, dozens killed",
  "Military Operations & Armed Conflict");
expect("Israel strikes military targets in southern Lebanon",
  "Military Operations & Armed Conflict");
// "war on terror" policy idiom must NOT misroute to Terrorism.
const warOnTerror = inferPrimaryTopic("Two decades after the war on terror reshaped US policy");
if (warOnTerror !== "Terrorism, Insurgency & Non-State Armed Groups") { passed++; }
else { failed++; console.error("FAIL: 'war on terror' policy piece misrouted to Terrorism"); }
// Bare accident/crime headlines with no terror framing stay unmatched (null),
// deferring to the stored AI classification.
expect("Bus crashes into storefront after driver suffers medical emergency", null);

// --- Short-label rendering sanity --------------------------------------------
if (primaryTopicShortLabel("Maritime Security & Chokepoints") !== "Maritime Security") {
  failed++;
  console.error("FAIL: short label for Maritime Security & Chokepoints");
} else { passed++; }
if (primaryTopicShortLabel("Critical Infrastructure, Energy & Supply Chains") !== "Infrastructure & Energy") {
  failed++;
  console.error("FAIL: short label for Critical Infrastructure, Energy & Supply Chains");
} else { passed++; }

console.log(`\ncurated-topic-inference: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
