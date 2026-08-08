/**
 * Regression test for the Curated soft-politics safety cap (Task #262).
 *
 * capSoftPoliticsPriority is a deterministic, CAP-ONLY backstop in the Curated
 * ingest path: clearly-soft items (tourism / travel promotion, PR / image /
 * branding campaigns, routine appointments / personnel moves with no strategic
 * bearing) that the analyzer over-scored into a high band are pulled back to the
 * low band (<=49). Genuine statecraft / defense-leadership stories — even when
 * they share an overlapping soft term — are protected by a strategic guard and
 * left untouched. It must NEVER raise a score.
 *
 * This locks that behavior so a future prompt/keyword tweak can't silently
 * re-open the leak (the original Le Monde "ambassador appointed to woo tourists"
 * P70 admission) or, conversely, start clobbering real statecraft headlines.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-soft-cap.test.ts
 * Exits non-zero on any failure.
 */
import { capSoftPoliticsPriority, CURATED_SOFT_CAP } from "../server/curatedIngest";

interface Case {
  title: string;
  category: string | null;
  input: number;
  expected: number;
  why: string;
}

const cases: Case[] = [
  // ---- Soft politics that MUST be capped to <=49 ----
  {
    title: "MAGA, male-supremacist ambassador appointed to woo tourists back to US",
    category: "US Diplomatic Appointments",
    input: 70,
    expected: CURATED_SOFT_CAP,
    why: "the prompting Le Monde example — tourism + appointment, no NatSec substance",
  },
  {
    title: "MAGA, male-supremacist ambassador appointed to woo tourists back to US",
    category: "Tourism Promotion",
    input: 84,
    expected: CURATED_SOFT_CAP,
    why: "same story, even higher band, still capped",
  },
  {
    title: "New envoy launches PR campaign to rebuild country's image",
    category: "Public Relations",
    input: 72,
    expected: CURATED_SOFT_CAP,
    why: "PR / image campaign — soft politics",
  },
  {
    title: "Tourism minister unveils branding campaign",
    category: "Tourism Promotion",
    input: 80,
    expected: CURATED_SOFT_CAP,
    why: "branding campaign + tourism",
  },
  {
    title: "Country rolls out destination marketing to lure visitors back",
    category: "Tourism",
    input: 66,
    expected: CURATED_SOFT_CAP,
    why: "destination marketing / lure visitors",
  },
  {
    title: "President appoints new envoy to Paris",
    category: "Diplomatic Appointments",
    input: 71,
    expected: CURATED_SOFT_CAP,
    why: "routine appointment, no strategic term present",
  },
  {
    title: "Senate confirms new ambassador to Canada",
    category: "Diplomatic Appointments",
    input: 65,
    expected: CURATED_SOFT_CAP,
    why: "routine ambassador confirmation, no strategic bearing",
  },
  {
    title: "White House announces cabinet reshuffle",
    category: "Personnel Moves",
    input: 73,
    expected: CURATED_SOFT_CAP,
    why: "cabinet reshuffle — personnel color",
  },

  // ---- Private-company / consumer-brand fluff that MUST be capped to <=49 ----
  {
    title: "Starbucks Korea to close stores for history training",
    category: "Corporate Affairs",
    input: 70,
    expected: CURATED_SOFT_CAP,
    why: "the prompting case — consumer-brand internal 'history training', no NatSec substance",
  },
  {
    title: "Starbucks rolls out new diversity training for all employees",
    category: "Corporate Affairs",
    input: 75,
    expected: CURATED_SOFT_CAP,
    why: "consumer-brand internal diversity training — business story, not statecraft",
  },
  {
    title: "McDonald's unveils new menu lineup for summer",
    category: "Corporate Affairs",
    input: 64,
    expected: CURATED_SOFT_CAP,
    why: "consumer product / menu launch — commercial fluff",
  },

  // ---- Corporate restructuring / M&A / financial results that MUST be capped ----
  {
    title: "Comcast announces it will spin off NBCUniversal and Sky from cable business",
    category: "Economic Pressure",
    input: 76,
    expected: CURATED_SOFT_CAP,
    why: "the prompting case — media corporate spin-off, no defense bearing",
  },
  {
    title: "Warner Bros and Paramount in merger talks to create media giant",
    category: "Corporate Affairs",
    input: 71,
    expected: CURATED_SOFT_CAP,
    why: "media merger — business of business",
  },
  {
    title: "Reddit prices IPO, set to go public next week",
    category: "Markets",
    input: 68,
    expected: CURATED_SOFT_CAP,
    why: "IPO / going public — pure markets story",
  },
  {
    title: "Apple beats earnings estimates on strong iPhone sales",
    category: "Markets",
    input: 70,
    expected: CURATED_SOFT_CAP,
    why: "earnings beat — financial-results reporting",
  },
  {
    title: "Private equity firm launches buyout bid for retail chain",
    category: "Corporate Affairs",
    input: 67,
    expected: CURATED_SOFT_CAP,
    why: "buyout bid for a retail chain — corporate M&A",
  },
  {
    title: "Disney to acquire remaining stake in streaming business",
    category: "Corporate Affairs",
    input: 72,
    expected: CURATED_SOFT_CAP,
    why: "acquire + corporate object (stake/business) — M&A",
  },
  {
    title: "Salesforce is on an AI buying spree, but Wall Street still has its doubts",
    category: "Economic Pressure",
    input: 74,
    expected: CURATED_SOFT_CAP,
    why: "the prompting case — 'buying spree' corporate M&A, no defense bearing",
  },
  {
    title: "Tech giant goes on acquisition spree to bolster AI",
    category: "Markets",
    input: 69,
    expected: CURATED_SOFT_CAP,
    why: "acquisition spree — corporate dealmaking",
  },
  {
    title: "Salesforce snaps up AI startup Fin in $3.6 billion deal",
    category: "Corporate Affairs",
    input: 73,
    expected: CURATED_SOFT_CAP,
    why: "'snaps up' + startup — common M&A title phrasing",
  },

  // ---- Strategic / defense deals that share an M&A term — MUST NOT be capped ----
  {
    title: "Lockheed Martin to acquire missile-defense maker in $5B deal",
    category: "Defense Industry",
    input: 84,
    expected: 84,
    why: "M&A wording but guard (missile / maker) protects a defense-industrial deal",
  },
  {
    title: "Two top defense contractors announce merger",
    category: "Defense Industry",
    input: 80,
    expected: 80,
    why: "'merger' but guard (defense contractor) protects strategic consolidation",
  },
  {
    title: "Taiwan chipmaker prepares IPO amid export controls",
    category: "Semiconductor Policy",
    input: 79,
    expected: 79,
    why: "'IPO' but guard (chipmaker / export controls) protects critical-tech statecraft",
  },
  {
    title: "Boeing posts quarterly loss amid defense program delays",
    category: "Defense Industry",
    input: 77,
    expected: 77,
    why: "'quarterly loss' but guard (defense) protects a defense-industrial story",
  },
  {
    title: "Taliban announces takeover of northern province",
    category: "Afghanistan",
    input: 82,
    expected: 82,
    why: "bare 'takeover' (no deal noun) is NOT a business pattern — stays uncapped",
  },
  {
    title: "Pentagon on a weapons buying spree to replenish stockpiles",
    category: "Defense Industry",
    input: 83,
    expected: 83,
    why: "'buying spree' but guard (Pentagon / weapons) protects defense procurement",
  },

  // ---- Stock-market / share-trading / options-speculation that MUST be capped ----
  {
    title: "SpaceX bulls are back betting on huge, fast gains as Rocket Lab surges",
    category: "Commercial News",
    input: 75,
    expected: CURATED_SOFT_CAP,
    why: "the prompting case — bulls betting on price gains; markets noise, no guard term (space/rocket deliberately not guarded)",
  },
  {
    title: "Tesla stock surges in premarket trading",
    category: "Markets",
    input: 72,
    expected: CURATED_SOFT_CAP,
    why: "stock surges + premarket — pure price action",
  },
  {
    title: "GameStop short squeeze sends shares soaring",
    category: "Markets",
    input: 70,
    expected: CURATED_SOFT_CAP,
    why: "short squeeze — speculative trading event",
  },
  {
    title: "Nvidia stock plunges as investors dump shares",
    category: "Markets",
    input: 68,
    expected: CURATED_SOFT_CAP,
    why: "stock plunges + investors dump — markets selloff",
  },
  {
    title: "Analysts raise price target on Palantir",
    category: "Markets",
    input: 66,
    expected: CURATED_SOFT_CAP,
    why: "analyst price target — Wall-Street rating noise",
  },
  {
    title: "Traders pile into call options ahead of earnings",
    category: "Markets",
    input: 69,
    expected: CURATED_SOFT_CAP,
    why: "call options + traders pile — derivatives speculation",
  },

  // ---- Defense-industrial stories that share a markets term — MUST NOT be capped ----
  {
    title: "SpaceX stock jumps after Pentagon awards launch contract",
    category: "Defense Industry",
    input: 80,
    expected: 80,
    why: "'stock jumps' present, but guard (Pentagon) protects a real defense-contract story",
  },
  {
    title: "Defense stocks rally as war fears mount",
    category: "Markets",
    input: 82,
    expected: 82,
    why: "'stocks rally' present, but guard (defense / war) protects it",
  },
  {
    title: "Lockheed shares surge after missile test success",
    category: "Markets",
    input: 81,
    expected: 81,
    why: "'shares surge' present, but guard (missile) protects a defense-capability story",
  },
  {
    title: "Palantir shares soar on new Army AI contract",
    category: "Markets",
    input: 79,
    expected: 79,
    why: "'shares soar' present, but guard (army — new service-branch term) protects a defense-contract story",
  },
  {
    title: "Boeing shares climb on new Air Force tanker order",
    category: "Markets",
    input: 78,
    expected: 78,
    why: "'shares climb' present, but guard (air force — new service-branch term) protects a defense procurement story",
  },
  {
    title: "Retail investor army piles into call options on meme stock",
    category: "Markets",
    input: 77,
    expected: CURATED_SOFT_CAP,
    why: "'investor army' is a crowd metaphor, NOT the service branch — scoped army guard must NOT rescue this options-trading story",
  },

  // ---- US domestic election-administration / voting-mechanics — MUST be capped ----
  {
    title:
      "Trump laments 'tremendous loss' on mail-in ballots at Supreme Court, doubles down on voter-ID bill",
    category: "Economic Pressure",
    input: 78,
    expected: CURATED_SOFT_CAP,
    why: "the prompting case — mail-in ballots + voter-ID, domestic voting mechanics",
  },
  {
    title: "State expands early voting and absentee ballot access",
    category: "Politics",
    input: 70,
    expected: CURATED_SOFT_CAP,
    why: "early voting + absentee ballots — election administration",
  },
  {
    title: "Supreme Court upholds mail-in ballot counting deadline",
    category: "Domestic",
    input: 72,
    expected: CURATED_SOFT_CAP,
    why: "mail-in / ballot counting — voting mechanics, not strategic",
  },
  {
    title: "Redistricting battle could swing control of the House",
    category: "Politics",
    input: 66,
    expected: CURATED_SOFT_CAP,
    why: "redistricting — partisan electoral mechanics",
  },
  {
    title: "Lawmakers spar over voter registration purges",
    category: "Politics",
    input: 64,
    expected: CURATED_SOFT_CAP,
    why: "voter registration purge — voting administration",
  },

  // ---- Strategic election topics that share a voting term — MUST NOT be capped ----
  {
    title:
      "Intelligence officials warn of foreign election interference targeting mail-in ballots",
    category: "National Security",
    input: 84,
    expected: 84,
    why: "mail-in present, but guard (intelligence / foreign interference / election interference) protects it",
  },
  {
    title: "Pentagon boosts election security against cyberattacks on voter rolls",
    category: "Cyber",
    input: 82,
    expected: 82,
    why: "voter rolls present, but guard (Pentagon / election security / cyber) protects it",
  },
  {
    title: "Russia accused of meddling in mail-in ballot disinformation campaign",
    category: "Information Warfare",
    input: 80,
    expected: 80,
    why: "mail-in present, but guard (meddling / disinformation) protects an info-warfare story",
  },
  {
    title: "Scotland independence referendum could redraw the map",
    category: "Europe",
    input: 75,
    expected: 75,
    why: "no voting-mechanics pattern (bare 'referendum'/'ballot' excluded) — strategic vote stays uncapped",
  },

  // ---- High-collision guard tokens that must NOT exempt soft items ----
  {
    title: "Country launches charm offensive to woo tourists back",
    category: "Tourism Promotion",
    input: 74,
    expected: CURATED_SOFT_CAP,
    why: "'offensive' must not exempt a tourism charm offensive",
  },
  {
    title: "Embassy mounts PR offensive to rebuild image",
    category: "Public Relations",
    input: 71,
    expected: CURATED_SOFT_CAP,
    why: "'PR offensive' is soft, 'offensive' no longer guards it",
  },
  {
    title: "New aide appointed ahead of general election",
    category: "Personnel Moves",
    input: 68,
    expected: CURATED_SOFT_CAP,
    why: "'general election' must not exempt a routine appointment",
  },
  {
    title: "President appoints envoy before UN General Assembly",
    category: "Diplomatic Appointments",
    input: 67,
    expected: CURATED_SOFT_CAP,
    why: "'General Assembly' must not exempt a routine appointment",
  },

  // ---- Consumer / local-business human-interest that MUST be capped to <=49 ----
  {
    title: "Idaho yogurt shop defends putting Charlie Kirk's face on products",
    category: "Defense Industry",
    input: 66,
    expected: CURATED_SOFT_CAP,
    why: "the prompting case — consumer venue + face-on-products; the MIS-TAGGED 'Defense Industry' category must NOT rescue it (guard reads title only)",
  },
  {
    title: "Idaho yogurt shop defends putting Charlie Kirk's face on products",
    category: "Human Interest",
    input: 66,
    expected: CURATED_SOFT_CAP,
    why: "same story with an honest category — still capped",
  },
  {
    title: "Coffee shop goes viral after barista's holiday latte stunt",
    category: "Culture",
    input: 64,
    expected: CURATED_SOFT_CAP,
    why: "consumer venue (coffee shop) + goes viral — human-interest fluff",
  },
  {
    title: "Local bakery faces online backlash over politically themed cupcakes",
    category: "Trending",
    input: 62,
    expected: CURATED_SOFT_CAP,
    why: "bakery + online backlash — consumer human-interest",
  },
  {
    title: "Ice cream parlor puts mascot on cups amid social media frenzy",
    category: "Lifestyle",
    input: 71,
    expected: CURATED_SOFT_CAP,
    why: "venue + mascot-on-cups merchandise + social media frenzy",
  },

  // ---- Security incidents AT a consumer venue — MUST NOT be capped ----
  {
    title: "Gunman opens fire at crowded coffee shop, three killed",
    category: "Defense Industry",
    input: 84,
    expected: 84,
    why: "venue word present, but guard (gunman/fire) protects a real mass-casualty event",
  },
  {
    title: "Bombing at restaurant near military base kills twelve",
    category: "Human Interest",
    input: 88,
    expected: 88,
    why: "venue word present, but guard (bombing/military) protects a terror attack",
  },
  {
    title: "Hostage siege at downtown bakery enters second day",
    category: "Lifestyle",
    input: 82,
    expected: 82,
    why: "venue word present, but guard (hostage/siege) protects a security incident",
  },

  // ---- US domestic safety-net policy / partisan domestic litigation — MUST be capped ----
  {
    title: "Democratic states sue over Medicaid work rules",
    category: "Legal & Norms",
    input: 59,
    expected: CURATED_SOFT_CAP,
    why: "the prompting Axios case — Medicaid domestic-policy litigation by Democratic states, no defense bearing",
  },
  {
    title: "Republican-led states challenge new SNAP benefits rule",
    category: "Politics",
    input: 64,
    expected: CURATED_SOFT_CAP,
    why: "SNAP benefits + partisan states — domestic safety-net policy",
  },
  {
    title: "Attorneys general sue the administration over student loan forgiveness",
    category: "Domestic",
    input: 66,
    expected: CURATED_SOFT_CAP,
    why: "AGs sue administration + student loan forgiveness — domestic-policy litigation",
  },
  {
    title: "White House unveils Medicare eligibility overhaul",
    category: "Health Policy",
    input: 61,
    expected: CURATED_SOFT_CAP,
    why: "Medicare domestic entitlement policy — not statecraft",
  },
  {
    title: "Coalition of 20 states files lawsuit over Obamacare subsidies",
    category: "Politics",
    input: 63,
    expected: CURATED_SOFT_CAP,
    why: "coalition of states + Obamacare — domestic-policy litigation",
  },

  // ---- Domestic-program stories with a real security dimension — MUST NOT be capped ----
  {
    title: "Chinese hackers breach Medicare database in cyber espionage operation",
    category: "Cyber",
    input: 82,
    expected: 82,
    why: "Medicare present, but guard (cyber / espionage) protects a real cyber-intrusion story",
  },
  {
    title: "Chinese hackers breach Medicare database, exposing millions",
    category: "Legal & Norms",
    input: 82,
    expected: 82,
    why: "Medicare present with NO 'cyber'/'espionage' words, but guard (hack/breach) still protects the intrusion",
  },
  {
    title: "Ransomware attack cripples Social Security payment systems",
    category: "Legal & Norms",
    input: 80,
    expected: 80,
    why: "Social Security present, but guard (ransomware) protects a critical-infrastructure cyber incident",
  },
  {
    title: "Republican-led states deploy National Guard troops to the border",
    category: "Homeland Security",
    input: 80,
    expected: 80,
    why: "partisan-states present, but guard (deploy / troops) protects a force-posture story",
  },

  // ---- Domestic-policy collision guards that must NOT be mis-capped ----
  {
    title: "Democratic Republic of Congo signs ceasefire with rebels",
    category: "Africa",
    input: 78,
    expected: 78,
    why: "'Democratic Republic' is not 'Democratic states'; guard (ceasefire) protects regardless",
  },
  {
    title: "United States and allies expand naval patrols in the Red Sea",
    category: "Maritime Security",
    input: 84,
    expected: 84,
    why: "'United States' must NOT match the partisan-states pattern; guard (naval) protects anyway",
  },

  // ---- Genuine statecraft / defense — MUST NOT be capped ----
  {
    title: "Ukraine launches major offensive to retake territory",
    category: "Ukraine Battlefield",
    input: 85,
    expected: 85,
    why: "a real military offensive matches no soft/appointment pattern, so stays uncapped",
  },
  {
    title: "US imposes new sanctions targeting tourism revenue funding terrorism",
    category: "Sanctions Diplomacy",
    input: 78,
    expected: 78,
    why: "sanctions + terrorism — statecraft, guard protects despite 'tourism'",
  },
  {
    title: "Trump signs travel ban on seven nations",
    category: "Travel Ban Policy",
    input: 75,
    expected: 75,
    why: "'travel ban' is policy, not travel promotion — never matched",
  },
  {
    title: "Russia launches missile strike on Kyiv",
    category: "Ukraine Battlefield",
    input: 88,
    expected: 88,
    why: "active combat — never capped",
  },
  {
    title: "Trump nominates hawkish general to lead CENTCOM",
    category: "Defense Leadership",
    input: 82,
    expected: 82,
    why: "appointment, but guard (general/CENTCOM) protects a significant defense move",
  },
  {
    title: "Pentagon names new combatant commander for INDOPACOM",
    category: "Defense Leadership",
    input: 80,
    expected: 80,
    why: "guard (Pentagon/combatant/commander/INDOPACOM) protects defense appointment",
  },
  {
    title: "Senate confirms Secretary of Defense nominee",
    category: "Defense Leadership",
    input: 77,
    expected: 77,
    why: "confirmation + defense role — guard protects",
  },
  {
    title: "Australia appoints new lithium trade envoy",
    category: "Diplomatic Appointments",
    input: 70,
    expected: 70,
    why: "appointment, but guard (lithium) protects a critical-mineral supply story",
  },
  {
    title: "DRC names cobalt special representative amid supply concerns",
    category: "Personnel Moves",
    input: 68,
    expected: 68,
    why: "personnel move, but guard (cobalt) protects a strategic-mineral story",
  },
  {
    title: "China appoints envoy to oversee gallium and germanium exports",
    category: "Diplomatic Appointments",
    input: 72,
    expected: 72,
    why: "appointment, but guard (gallium / germanium) protects an export-control story",
  },
  {
    title: "Kazakhstan appoints new uranium export envoy",
    category: "Diplomatic Appointments",
    input: 70,
    expected: 70,
    why: "appointment, but guard (uranium) protects a nuclear-fuel supply story",
  },
  {
    title: "Beijing names tungsten supply coordinator amid export curbs",
    category: "Personnel Moves",
    input: 71,
    expected: 71,
    why: "personnel move, but guard (tungsten) protects a strategic-commodity story",
  },
  {
    title: "China appoints envoy to oversee antimony and graphite exports",
    category: "Diplomatic Appointments",
    input: 73,
    expected: 73,
    why: "appointment, but guard (antimony / graphite) protects an export-control story",
  },
  {
    title: "South Africa names new manganese trade representative",
    category: "Personnel Moves",
    input: 69,
    expected: 69,
    why: "personnel move, but guard (manganese) protects a critical-commodity story",
  },
  {
    title: "Apple unveils new titanium product lineup for the holidays",
    category: "Corporate Affairs",
    input: 70,
    expected: CURATED_SOFT_CAP,
    why: "'titanium' is deliberately NOT guarded — it collides with consumer products, so a product-launch story must still be capped",
  },
  {
    title: "Defense contractor launches new employee training after security breach",
    category: "Defense Industry",
    input: 76,
    expected: 76,
    why: "matches 'employee training' but guard (defense contractor) protects a strategic story",
  },
  {
    title: "Taiwan chipmaker rolls out staff training amid export controls",
    category: "Semiconductor Policy",
    input: 80,
    expected: 80,
    why: "matches 'staff training' but guard (chipmaker / export controls) protects critical-tech statecraft",
  },
  {
    title: "US sanctions Chinese chipmaker over military supply chain",
    category: "Sanctions Diplomacy",
    input: 85,
    expected: 85,
    why: "sanctions + chipmaker + supply chain — strategic, no corporate-fluff pattern anyway",
  },

  // ---- Cap-only invariant: never raise, never touch already-low scores ----
  {
    title: "Tourism push announced",
    category: "Tourism Promotion",
    input: 40,
    expected: 40,
    why: "already at/below cap — untouched (cap-only, never raised)",
  },
  {
    title: "Tourism push announced",
    category: "Tourism Promotion",
    input: 49,
    expected: 49,
    why: "exactly at cap — untouched",
  },

  // ---- Consumer cyber-fraud how-to that MUST be capped to <=49 ----
  {
    title: "How to protect your small business from hackers and phishing scams",
    category: "Cybersecurity",
    input: 70,
    expected: CURATED_SOFT_CAP,
    why: "the prompting case — small-business cyber-fraud how-to, no national-security substance",
  },
  {
    title: "Protect your business from ransomware: 5 tips every SMB owner needs",
    category: "Business Security",
    input: 75,
    expected: CURATED_SOFT_CAP,
    why: "protect-business-from-ransomware how-to framing",
  },
  {
    title: "Small business cybersecurity tips for 2026",
    category: "Cybersecurity",
    input: 68,
    expected: CURATED_SOFT_CAP,
    why: "small-business cybersecurity tips",
  },
  {
    title: "Cybersecurity tips for small businesses facing fraud",
    category: "Business",
    input: 60,
    expected: CURATED_SOFT_CAP,
    why: "cybersecurity tips-for-small-businesses pattern",
  },

  // ---- Culture / heritage / commemoration fluff that MUST be capped to <=49 ----
  {
    title: "Jewish heritage initiative launched for America's 250th anniversary celebration",
    category: "Cultural Affairs",
    input: 66,
    expected: CURATED_SOFT_CAP,
    why: "the prompting Fox News case — heritage initiative for America's 250th, no strategic hook",
  },
  {
    title: "City kicks off semiquincentennial festivities with parade celebrating America's founding",
    category: "Local News",
    input: 60,
    expected: CURATED_SOFT_CAP,
    why: "national-milestone (semiquincentennial) celebration — human interest",
  },
  {
    title: "Commemoration ceremonies continue to honor martyred Leader",
    category: "general",
    input: 56,
    expected: CURATED_SOFT_CAP,
    why: "the production-measured case — commemoration-ceremony coverage, no strategic hook",
  },
  {
    title: "Smithsonian museum opens new exhibit on colonial craftsmanship",
    category: "Cultural Affairs",
    input: 58,
    expected: CURATED_SOFT_CAP,
    why: "museum exhibit opening — cultural human interest",
  },
  {
    title: "Town unveils statue of hometown hero for founders day",
    category: "Local News",
    input: 55,
    expected: CURATED_SOFT_CAP,
    why: "statue unveiling + founders day — commemoration fluff",
  },
  {
    title: "National Hispanic Heritage Month events planned across the country",
    category: "Cultural Affairs",
    input: 62,
    expected: CURATED_SOFT_CAP,
    why: "ethnic-heritage month programming — cultural color",
  },

  // ---- Culture/heritage-adjacent that must NOT be capped (guard or precision) ----
  {
    title: "Military parade marks army anniversary as tensions rise",
    category: "Defense",
    input: 70,
    expected: 70,
    why: "guard (military / army) protects — an adversary military-parade show of force is strategic",
  },
  {
    title: "Israeli settlers attack journalists on anniversary of deadly West Bank beating",
    category: "Israel/Gaza",
    input: 62,
    expected: 62,
    why: "guard (attack) protects — violence on an anniversary is not celebration coverage",
  },
  {
    title: "Xi's speech marking CPC's 105th founding anniversary to be published",
    category: "Political Messaging",
    input: 52,
    expected: 52,
    why: "bare 'anniversary' deliberately unmatched — adversary political messaging is not celebration fluff",
  },
  {
    title: "Memorial held for soldiers killed in drone strike",
    category: "RUS/UKR",
    input: 74,
    expected: 74,
    why: "guard (soldiers / drone / strike) protects a conflict-casualty memorial",
  },
  {
    title: "China warns US over Taiwan ahead of national day celebrations",
    category: "PRC/Indo-Pacific",
    input: 78,
    expected: 78,
    why: "guard would not even be needed (no pattern), and 'warns over Taiwan' is statecraft",
  },

  // ---- Consumer cyber that must NOT be capped (strategic guard fires first) ----
  {
    title: "NSA warns Chinese espionage group targeting defense contractors with ransomware",
    category: "Cybersecurity",
    input: 82,
    expected: 82,
    why: "nation-state espionage advisory — strategic guard fires, never capped",
  },
  {
    title: "CISA advisory: Russian hackers targeting critical infrastructure via phishing",
    category: "Critical Infrastructure Security",
    input: 80,
    expected: 80,
    why: "CISA advisory on state-sponsored attack — strategic guard fires, never capped",
  },
];

let pass = 0;
const failures: string[] = [];
for (const c of cases) {
  const got = capSoftPoliticsPriority(c.title, c.category, c.input);
  const ok = got === c.expected;
  if (ok) {
    pass++;
    console.log(`PASS [${c.why}]`);
  } else {
    failures.push(
      `FAIL [${c.why}] in=${c.input} got=${got} expected=${c.expected} :: "${c.title}"`,
    );
    console.log(failures[failures.length - 1]);
  }
}

console.log(`\n${pass}/${cases.length} passed (cap=${CURATED_SOFT_CAP})`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
