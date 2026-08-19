/**
 * Deterministic, lane-scoped P-score adjustment rules (Task #444, Step 3).
 *
 * Single auditable, testable home for every deterministic post-AI score CAP in
 * the pipeline. Before this, the caps lived inline in two unrelated files (the
 * NOAA downgrade in `scraper.ts`, the curated soft-politics backstop in
 * `curatedIngest.ts`), so there was no one place to see — or test — what the
 * deterministic layer does to a score.
 *
 * Two hard invariants this module preserves:
 *
 *   1. LANE SCOPING. A rule is tagged `main` or `curated` and is ONLY ever
 *      applied through the matching helper. Curated rules (soft-politics) NEVER
 *      run on a main-feed table; the main rule (NOAA) NEVER runs in the curated
 *      gate. Curated scoring/relevance must never leak into Classic/Visual/
 *      custom-MCOP/public API.
 *
 *   2. CAP-ONLY (score rules). Every SCORE rule can only LOWER a score that
 *      exceeds its cap, never raise one, and these are applied only to
 *      AI/machine-derived scores — never to a human-set score or a pin (those are
 *      handled by the call sites).
 *
 * This module ALSO exposes one deterministic curated-lane RELEVANCE reject
 * predicate (isCuratedNonRelevantConsumerFinance) — a different operation from a
 * cap: it answers "should this never enter the curated store AT ALL?" for
 * personal/consumer-finance & money-management how-to content with no national-
 * security bearing. It is lane-scoped (curated-only) exactly like the caps, and is
 * guarded so genuine economic statecraft is never rejected.
 *
 * All rules are pure and deterministic. No AI call is made here.
 */

import { deriveContentType } from '../shared/contentKind';

// ---- AI score resolution (lane-agnostic) ---------------------------------
/**
 * Resolve an AI-reported priority score into the 1-100 scale (Task #444, Step 2).
 *
 * The analyzer JSON can hand back a real number (including a genuine 0), or omit
 * the field / return a non-number. The old `score || 50` collapsed BOTH a real 0
 * AND a missing value into 50, inflating the 50 bucket (the baseline measured 41%
 * of the `headlines` lane sitting exactly at 50). This distinguishes the two: a
 * finite number is clamped into [1,100] (so a real 0 floors to 1, it is NOT
 * treated as "missing"), while only a truly absent/non-numeric score falls back
 * to the explicit default. Pure + deterministic.
 */
export function resolveAiScore(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(1, Math.min(100, Math.round(raw)));
  }
  return fallback;
}

// ---- Curated soft-politics cap (curated-lane ONLY) ------------------------
// Deterministic Curated-ONLY soft-politics safety cap (Task #262). Prompt
// guidance alone drifts, so this is a backstop: clearly-soft, non-strategic
// items (tourism / travel promotion, PR / image / branding campaigns, and the
// like) that the analyzer nonetheless scored into a high band are CAPPED back
// into the low band. Curated-lane only; CAP-ONLY (never raises a score); never
// touches human-set curated pins (a separate table, read only at render time).
export const CURATED_SOFT_CAP = 49;

// Conservative "this is genuine statecraft" guard: if any of these strategic
// terms appear, we never cap, so a real foreign-policy / defense story that
// merely happens to mention tourism, travel, PR, or an appointment is left
// untouched. Deliberately GENEROUS — the cap is a backstop, so a false negative
// (a soft item slipping through uncapped) is far cheaper than a false positive
// (a real statecraft / defense-leadership story wrongly pushed to the low band).
// Includes defense / security ROLES and commands so that significant
// appointments (e.g. a new combatant commander, a SecDef nominee) are protected
// from the appointment cap below. Also includes strategic-economic /
// defense-industrial terms (semiconductors, export controls, critical minerals,
// supply chain, defense contractors / munitions) so a genuinely strategic
// corporate story is never caught by the corporate-fluff cap added below.
// Bare strategic-mineral / commodity element names (lithium / cobalt / gallium /
// germanium / niobium / neodymium / uranium / graphite / manganese / tungsten /
// antimony) are also guarded so a supply / export story that doesn't spell out
// "critical mineral" or "rare earth" (e.g. "Australia appoints new lithium trade
// envoy", "Kazakhstan names uranium export envoy") is not swept into the
// appointment cap. "titanium" is deliberately EXCLUDED: it collides with consumer
// product names (titanium iPhone / watch / credit card) and would wrongly rescue a
// product-launch story from the corporate-fluff cap; a genuinely strategic
// titanium story still carries its own guard term (export control / sanctions /
// defense / supply chain).
// Deliberately excludes ambiguous, high-collision
// tokens: "offensive" (a real military offensive matches no soft/appointment
// pattern so it stays uncapped anyway, while "charm/PR offensive" must be allowed
// through to the cap) and "general election/assembly/public" (political color, not
// a military rank). The rank token "general" additionally excludes "attorney(s)
// general" via a lookbehind, so a domestic AG-litigation story ("Attorneys
// general sue the administration over student-loan forgiveness") is NOT wrongly
// rescued from the domestic-policy cap below (a genuinely strategic AG action
// still carries its own guard term — terror financing, sanctions, espionage).
// The service-branch term "army" is scoped to "U.S. army" or
// "army <defense noun>" (contract/program/troops/...) so a markets crowd metaphor
// ("retail investor army piles into call options") does NOT get wrongly rescued
// from the markets cap; the other branches (air force/space force/coast guard/
// marine corps/marines) are unambiguous and left bare. Cyber-intrusion terms
// (hack/breach/cyberattack/ransomware/malware) are guard tokens too, so a foreign
// hack or data breach of a domestic program (e.g. a Medicare-database breach) is
// treated as security-relevant and is NOT swept into the domestic-policy cap by a
// bare program word like "medicare". International-justice terms (tribunal /
// ICC / ICJ / Hague / genocide / crimes against humanity / ethnic cleansing /
// warlord) are guard tokens so ongoing war-crimes tribunal coverage ("ICC
// convicts warlord", "UN tribunal sentences commander") is never swept into the
// domestic-crime cap — \bwar\b does NOT match "warlord", so these need their own
// tokens.
const CURATED_STRATEGIC_GUARD =
  /\b(war|warfare|wartime|militar(y|ies)|troops?|soldier|missile|nuclear|nukes?|sanction|sanctions|sanctioned|weapons?|arms|attack|strike|airstrike|combat|combatant|invasion|terror|terrorism|terrorist|shooting|shootings|shooter|shooters|gunman|gunmen|gunfire|shoot-?out|bomb(?:s|ing|ings|ed)?|explosion|explosions|blast|blasts|siege|stabb(?:ed|ing|ings)?|massacre|hijack(?:s|ed|ing|ers?)?|kidnap(?:s|ped|ping)?|assassinat(?:e|ed|es|ing|ion)?|defen[cs]e|treaty|treaties|alliance|nato|tribunals?|icc|icj|international criminal court|international court of justice|(?:the\s+)?hague|genocid\w+|crimes against humanity|ethnic cleansing|warlords?|cyber|espionage|hack(?:s|er|ers|ed|ing)?|breach(?:es|ed|ing)?|cyber-?attacks?|ransomware|malware|intelligence|election security|election interference|foreign interference|election meddling|meddl(?:e|es|ed|ing)|disinformation|insurgen|coup|ceasefire|hostage|drone|warship|naval|navy|u\.?s\.?\s+army|army\s+(?:\w+\s+){0,2}?(?:contract|program|base|chief|secretary|soldiers?|troops?|awards?|orders?|corps|aviation|materiel|procurement|weapons?|missiles?|brigades?|divisions?|battalions?|deployment|recruit\w*|reserves?|veterans?|generals?|spending|budget)|air ?force|space force|coast guard|marine corps|marines|deploy|deployment|tariffs?|embargo(?:es)?|cartels?|semiconductors?|chipmaker|microchip|export control|export controls|dual-use|critical mineral|critical minerals|rare earth|rare earths|lithium|cobalt|gallium|germanium|niobium|neodymium|uranium|graphite|manganese|tungsten|antimony|supply chains?|central banks?|asset freezes?|asset[\s-]freezing|frozen (?:bank )?(?:accounts?|assets?|funds?|reserves?)|frozen assets?|money[\s-]?laundering|launder(?:s|ed|ing)|illicit financ\w+|terror(?:ist)? financ\w+|sanctions evasion|capital controls?|(?:sovereign|foreign|currency|forex|fx|gold|hard[\s-]currency)\s+reserves?|sovereign wealth|reserve currency|de-?dollari[sz]\w+|petrodollar|swift\s+(?:system|network|ban|payment|messaging|cut[\s-]?off)|ofac|treasury department|defen[cs]e contractor|arms maker|weapons maker|munitions|border security|hypersonic|warhead|ballistic|pentagon|joint chiefs|cjcs|secdef|centcom|indopacom|eucom|africom|southcom|northcom|national security|homeland security|spy|cia|fbi|dni|(?<!attorneys?\s)general(?!\s+(?:election|assembly|public))|admiral|commander|chief of defen[cs]e|secretary of state)\b/i;

// Conservative soft-politics signals. Only unambiguous tourism / travel-promotion
// / PR-branding language triggers the cap — bare words like "travel" (travel ban)
// are deliberately excluded so statecraft is not mis-caught.
const CURATED_SOFT_PATTERNS: RegExp[] = [
  /\btouris(m|t|ts|ty)\b/i,
  /\bwoo (back )?(tourist|tourists|visitor|visitors)/i,
  /\b(lure|attract|draw|bring) (back )?(tourist|tourists|visitor|visitors)/i,
  /\b(tourist|visitor)s? back\b/i,
  /\btravel promotion\b/i,
  /\bdestination marketing\b/i,
  /\b(pr|image|branding|rebrand(?:ing)?|reputation|publicity|marketing) (campaign|push|blitz|stunt|makeover|rollout|drive|offensive)\b/i,
  /\bpublic relations\b/i,
  /\brebrand(ing)?\b/i,
];

// Routine appointment / personnel / nomination signals. These only fire when the
// strategic guard above did NOT match, so a routine "ambassador appointed" or
// "envoy named" item is capped, while a significant defense-leadership move (a
// SecDef nominee, a new combatant commander, a CENTCOM chief) is protected by
// the guard and left untouched. Bare "named" is excluded (too ambiguous); the
// confirmation pattern requires a civil/diplomatic role to avoid over-matching.
const CURATED_APPOINTMENT_PATTERNS: RegExp[] = [
  /\bappoint(s|ed|ee|ment|ing)?\b/i,
  /\bnominat(e|ed|es|ing|ion)\b/i,
  /\bnominee\b/i,
  /\bsworn in\b/i,
  /\bnamed (as )?(ambassador|envoy|consul|spokes\w*|aide|advis(?:e|o)r|press secretary|chief of staff)\b/i,
  /\bconfirm(s|ed|ation)?\b[^.]*\b(ambassador|envoy|consul|secretary|chief|director|administrator|spokes\w*|aide|advis(?:e|o)r|deputy|under-?secretary)\b/i,
  /\b(staff|cabinet|personnel) (reshuffle|shake-?up|shuffle|change|changes|move|moves|overhaul)\b/i,
];

// Private-company / consumer-brand internal-or-commercial "fluff" signals. NARROW
// and high-precision: the gate prompt is the primary filter for corporate noise,
// so this deterministic backstop only catches the clearest cases (internal HR /
// cultural / sensitivity / "history" training, and consumer product / menu
// launches) where the analyzer over-scored a business story. As with the others,
// the strategic guard above fires FIRST, so a defense-industrial / critical-tech /
// sanctions story that merely shares an overlapping term is left untouched.
// Deliberately EXCLUDES bare "store closures", "boycott", "layoffs", and
// "rebrand" on their own — too collision-prone with genuinely strategic economic
// stories; those are left to the gate prompt.
const CURATED_CORPORATE_PATTERNS: RegExp[] = [
  /\b(history|diversity|sensitivity|cultural|cultural[- ]awareness|inclusion|dei|unconscious[- ]bias|anti[- ]bias|racial[- ]bias|implicit[- ]bias)\s+training\b/i,
  /\b(employee|employees|staff|workforce|worker|workers|company[- ]wide|store)\s+training\b/i,
  /\b(menu|product|merchandise)\s+(launch|launches|relaunch|revamp|overhaul|lineup|line-up|drop|rollout)\b/i,
  /\bnew (menu|drink|coffee|burger|product) (item|items|line|lineup)\b/i,
];

// "Business of business" signals — corporate structure changes (spin-offs,
// breakups, going public), mergers & acquisitions, and financial-results
// reporting. This is the class that prompted the cap: a pure media/consumer
// corporate restructuring (e.g. "Comcast to spin off NBCUniversal into a new
// publicly traded company") that the analyzer over-scored into the top band even
// though it carries no defense / national-security bearing. As with every group,
// the strategic guard above fires FIRST, so a genuinely strategic deal —
// defense-contractor M&A, a chipmaker IPO, a sanctions-driven divestiture, a
// critical-minerals acquisition — is left untouched (those terms are in the
// guard). Kept high-precision: M&A verbs that collide with non-business senses
// ("acquire", "divest") require a corporate object word, "takeover" requires a
// deal noun (so "government/Taliban takeover" is NOT caught), and earnings
// language is anchored to results/reporting phrasing rather than bare "profit".
const CURATED_BUSINESS_PATTERNS: RegExp[] = [
  // Corporate structure changes
  /\bspin(s|ning)?[-\s]?off\b/i,
  /\bspun[-\s]?off\b/i,
  /\bspin-?offs?\b/i,
  /\bpublicly[-\s]+traded\s+company\b/i,
  /\bbreaks?\s+(itself\s+)?(up|in\s+two|into\s+\w+)\b/i,
  // Going public
  /\bIPO\b/i,
  /\binitial public offering\b/i,
  /\bgoes?\s+public\b/i,
  /\bgo\s+public\b/i,
  // Mergers & acquisitions
  /\bmergers?\b/i,
  /\bmerges?\s+with\b/i,
  /\b(?:acqui(?:re|res|red|ring|sition|sitions)|buys?|buying|snaps?\s+up|scoops?\s+up|gobbles?\s+up)\b[^.]*\b(compan(?:y|ies)|firm|business(?:es)?|unit|division|subsidiary|stake|maker|brand|chain|startups?|start-ups?|operations|assets|rival|competitor|holdings?|platform|app|software\s+(?:firm|maker|company))\b/i,
  /\b(buying|acquisition|shopping|deal|dealmaking|m&a)\s+spree\b/i,
  /\b(takeover|buyout|buy-out)\s+(bid|offer|deal|attempt|battle|talks|saga|approach)\b/i,
  /\bbuyout\b/i,
  /\bdivestiture\b/i,
  /\bdivests?\b[^.]*\b(unit|business|division|stake|subsidiary|brand|arm|operations|holdings?)\b/i,
  // Financial-results reporting
  /\b(quarterly|annual|q[1-4])\s+(earnings|profit|profits|revenue|results|loss|losses|sales)\b/i,
  /\bearnings\s+(report|call|beat|miss|season|guidance)\b/i,
  /\b(beats?|miss(?:es|ed)?|tops?)\s+(?:wall street\s+)?(earnings|profit|revenue|estimates|expectations|forecasts?)\b/i,
  /\b(share|stock)\s+buybacks?\b/i,
  /\bdividend\s+(hike|increase|cut|raise|payout|boost)\b/i,
];

// US domestic election-administration / partisan voting-mechanics signals — the
// ballot-procedure and horse-race coverage (mail-in & absentee ballots, voter-ID,
// voter registration / rolls / turnout / purges, gerrymandering / redistricting,
// ballot counting / measures, the electoral college, voting-rights & election-bill
// legislation) that carries no defense / national-security bearing for a CJCS
// common operating picture. As with every group the strategic guard fires FIRST,
// so genuinely strategic election topics — foreign election INTERFERENCE, election
// SECURITY, meddling / disinformation / cyber operations against voting — are
// protected (those terms are in the guard) and never capped. Kept to voting-
// MECHANICS vocab: bare "election" / "ballot" / "vote" / "referendum" are
// deliberately excluded (a foreign election outcome or an independence referendum
// can be strategic), so every pattern is anchored to an administrative qualifier.
const CURATED_ELECTION_PATTERNS: RegExp[] = [
  /\bmail[\s-]?in\b/i,
  /\babsentee\s+ballots?\b/i,
  /\bvoter[\s-]?id\b/i,
  /\bvoter\s+(fraud|suppression|registration|rolls|turnout|purges?|intimidation)\b/i,
  /\b(election|ballot)\s+fraud\b/i,
  /\bballot\s+(counting|measure|measures|access|harvesting|drop[\s-]?box(?:es)?)\b/i,
  /\bcounting\s+(?:of\s+)?(?:absentee\s+|mail-?in\s+)?ballots\b/i,
  /\bgerrymander(?:ing|ed|s)?\b/i,
  /\bredistricting\b/i,
  /\belectoral college\b/i,
  /\bearly voting\b/i,
  /\bpolling\s+(place|places|station|stations|booth|booths)\b/i,
  /\bvoting rights\b/i,
  /\b(election|voting)\s+(bill|reform|legislation)\b/i,
];

// Consumer / local-business human-interest signals: a small food or retail venue
// as the story subject, a personality's image/branding placed on consumer
// merchandise, or a viral / online-backlash social-media controversy. These are
// pure human-interest with no strategic bearing (the prompting case was an Idaho
// "yogurt shop defends putting Charlie Kirk's face on products", which the AI
// mis-tagged "Defense Industry" and scored P66). The strategic guard's new
// violence terms (shooting / bombing / siege / stabbing / hostage / etc.) run
// FIRST, so a real security incident AT such a venue ("gunman at a coffee shop")
// is never demoted by the venue pattern.
const CURATED_CONSUMER_PATTERNS: RegExp[] = [
  /\b(yogurt|frozen[\s-]?yogurt|froyo|ice[\s-]?cream|gelato|coffee|espresso|donut|doughnut|bagel|pizza|pizzeria|burger|taco|taqueria|sandwich|deli|candy|chocolate|cupcake|smoothie|juice|boba|bubble[\s-]?tea|sushi|noodle|ramen|barbecue|bbq|steakhouse|pancake|waffle)\s+(shop|shops|store|stores|stand|stands|parlou?r|truck|trucks|joint|cafe|caf\u00e9|house|chain|spot)\b/i,
  /\b(restaurant|diner|eatery|bistro|brasserie|food[\s-]?truck|bakery|boutique|barber[\s-]?shop|nail[\s-]?salon|hair[\s-]?salon|tattoo[\s-]?parlou?r)\b/i,
  /\b(face|image|photo|picture|likeness|portrait|logo|slogan|name|design|mascot)\s+on\s+(its\s+|their\s+|the\s+)?(products?|merch|merchandise|cups?|mugs?|shirts?|t-?shirts?|hoodies?|apparel|clothing|packaging|labels?|menus?|cans?|bottles?|wrappers?|stickers?)\b/i,
  /\bgoes?\s+viral\b/i,
  /\bwent\s+viral\b/i,
  /\b(online|social[\s-]?media|internet)\s+(backlash|outrage|firestorm|frenzy|furor|furore|uproar|storm)\b/i,
];

// Stock-market / share-trading / options-speculation signals: a headline whose
// SUBJECT is a security's price movement, derivatives positioning, analyst
// ratings, IPO-aftermarket sentiment, or investor/trader betting. This is markets
// noise, not strategic substance (the prompting case was a CNBC piece — "SpaceX
// bulls are back betting on huge, fast gains as Rocket Lab surges", mis-tagged
// "Commercial News / South Korea", P75). SpaceX / Rocket Lab are defense-adjacent,
// which is exactly why this is a CAP (reversible, human-overridable) and NOT a
// hard reject. The strategic guard runs FIRST, so a genuine defense-industrial
// story whose headline carries a guard term (Pentagon / missile / defense / a
// service branch / a contract framed with those) is never demoted — only the pure
// price-action / trading framing is. Patterns stay HIGH-PRECISION and anchored to
// markets context (a bare "surges"/"jumps" is intentionally NOT matched alone).
const CURATED_MARKETS_PATTERNS: RegExp[] = [
  // Bull/bear sentiment + speculative betting on a price move
  /\b(bull|bear)s?\s+(?:are\s+)?(?:back\s+)?(?:bet|bets|betting)\b/i,
  /\bbet(?:s|ting)?\s+on\s+[^.]*\b(gains?|upside|rally|rebound|pop|surge|moonshot)\b/i,
  /\b(bullish|bearish)\s+(?:bet|bets|wager|case|sentiment|trade|trades|outlook|stance|on\b)/i,
  /\bturn(?:s|ed|ing)?\s+(bullish|bearish)\b/i,
  // Share / stock price movement (guard rescues real defense framing)
  /\b(stocks?|shares?|share\s+price|stock\s+price|stock\s+market)\s+(surge|surges|surged|rally|rallies|rallied|soar|soars|soared|jump|jumps|jumped|spike|spikes|spiked|pop|pops|popped|plunge|plunges|plunged|tumble|tumbles|tumbled|slump|slumps|slumped|sink|sinks|sank|slide|slides|slid|crater|craters|cratered|dive|dives|dived|crash|crashes|crashed|rebound|rebounds|rebounded|climb|climbs|climbed|fall|falls|fell|drop|drops|dropped|rise|rises|rose|gain|gains|gained|sell\s*off|selloff)\b/i,
  /\b(surge|surges|surged|rally|rallies|rallied|soar|soars|soared|jump|jumps|jumped|spike|spikes|spiked|plunge|plunges|plunged|tumble|tumbles|tumbled|slump|slumps|slumped|rebound|rebounds|rebounded|pop|pops|popped)\s+(?:in\s+)?(?:pre-?market|premarket|after-?hours|midday\s+trading|early\s+trading|after\s+the\s+bell|on\s+wall\s+street)\b/i,
  // Options / derivatives speculation
  /\b(call|put)\s+(option|options|volume|contracts?|buying|spread)\b/i,
  /\b(?:options|calls\s+and\s+puts|puts\s+and\s+calls)\s+(?:trading|volume|activity)\b/i,
  /\bshort\s+squeeze\b/i,
  /\b(short|long)\s+sellers?\b/i,
  /\bmeme\s+stock\b/i,
  // IPO-aftermarket sentiment & technical levels
  /\bpost-?ipo\s+(high|low|pop|surge|rally|slump|peak|debut|decline|pullback)\b/i,
  /\b52[\s-]week\s+(high|low)\b/i,
  // Analyst / Wall-Street ratings & price targets
  /\b(analyst|analysts|wall\s+street|broker|brokerage)\s+(upgrade|upgrades|downgrade|downgrades|rating|ratings|price\s+target)\b/i,
  /\bprice\s+target\b/i,
  /\b(buy|sell|hold|overweight|underweight|outperform)\s+rating\b/i,
  // Market indices / market-wide trading framing
  /\b(nasdaq|nyse|dow\s+jones|s\s*&\s*p\s*500|russell\s+2000|nikkei|hang\s+seng|ftse\s+100)\b/i,
  /\b(investors?|traders?)\s+(?:are\s+)?(?:pile|piling|piled|flock|flocking|flocked|bet|betting|pour|pouring|poured|snap|snapping|snapped|dump|dumping|dumped)\b/i,
];

// US domestic safety-net / entitlement POLICY and partisan domestic-governance
// LITIGATION signals — domestic health/welfare program coverage (Medicaid /
// Medicare / Obamacare-ACA / SNAP-food-stamps / Social Security / unemployment /
// student-loan relief) and the routine partisan legal fights around it
// (Democratic/Republican-led states or attorneys general suing the
// administration over a domestic rule). For a CJCS common operating picture this
// is domestic political color / routine domestic policy, NOT statecraft — the
// prompting case was Axios "Democratic states sue over Medicaid work rules",
// which the analyzer scored P59 (above the cap) with no defense bearing. As with
// every group the strategic guard fires FIRST, so a domestic-program story that
// DOES carry a national-security dimension (a guard term — cyber / espionage,
// sanctions, terror financing, deploy / troops, defense, etc.) is left
// untouched. Kept high-precision: bare "welfare" / "social security" are scoped
// to their entitlement sense so "child welfare" or "Social Security numbers
// stolen in an espionage breach" is not mis-caught (the latter is additionally
// guarded by 'espionage'); the partisan-states pattern requires the party word
// immediately before "states" so "Democratic Republic" / "United States" never
// match; the AG litigation pattern is anchored to a legal-action verb.
const CURATED_DOMESTIC_POLICY_PATTERNS: RegExp[] = [
  // Safety-net / entitlement / domestic social-program subjects
  /\bmedicaid\b/i,
  /\bmedicare\b/i,
  /\b(obamacare|affordable care act)\b/i,
  /\b(food stamps|snap benefits)\b/i,
  /\bsocial security\s+(benefits?|payments?|checks?|recipients?|trust\s+fund|cuts?|reform|eligibility|cola|cost-of-living)\b/i,
  /\bwelfare\s+(benefits?|reform|programs?|rules?|requirements?|recipients?|rolls?)\b/i,
  /\bunemployment\s+(benefits?|insurance)\b/i,
  /\bstudent\s+(loan|debt)\s+(forgiveness|relief|cancellation|repayment|bailout)\b/i,
  // Partisan domestic-governance litigation (states / AGs vs the administration)
  /\b(?:democratic|republican|gop|blue|red)[\s-]?(?:led\s+)?states?\b/i,
  /\b(?:state\s+)?attorneys?\s+general\s+(?:sue|sues|sued|suing|file[ds]?|filing|challeng(?:e|es|ed|ing)|lawsuit|probe[ds]?|investigat\w+)\b/i,
  /\bsue[sd]?\s+(?:the\s+)?(?:trump\s+)?administration\b/i,
  /\bcoalition\s+of\s+(?:\d+\s+)?states\b/i,
];

// Entertainment / TV-culture LISTICLE signals — ranked or recommendation lists
// for television, film, and streaming: "best 10 shows", "top movies to watch",
// "what to stream this weekend", movie reviews, streaming platform new-arrivals
// roundups, and award-season prediction/rankings pieces. No defense/statecraft
// bearing for a CJCS operating picture. The strategic guard fires FIRST, so a
// documentary about military history or an actual awards-ceremony outcome that
// triggers geopolitical commentary is left untouched.
const CURATED_ENTERTAINMENT_LISTICLE_PATTERNS: RegExp[] = [
  // Best/top/worst N TV shows, movies, films, streaming series
  /\b(?:best|top|worst|greatest|all-time\s+best)\b[^.]{0,50}\b(?:tv\s+shows?|television\s+shows?|movies?|films?|streaming\s+shows?|web\s+series|documentaries|episodes?|seasons?)\b/i,
  // Must-watch / binge-worthy recommendations
  /\b(?:must[-\s]watch|must[-\s]see|binge[-\s]worthy|worth\s+watching|worth\s+binging)\b[^.]*\b(?:shows?|movies?|series|films?|streaming)\b/i,
  // "What to watch" on a streaming platform
  /\bwhat\s+to\s+watch\b/i,
  // Streaming platform new arrivals / monthly lineup
  /\b(?:netflix|hbo\s+max?|disney\s*\+|amazon\s+prime\s+video|hulu|peacock|paramount\s*\+|apple\s+tv\s*\+)\s+(?:new\s+)?(?:shows?|movies?|series|arrivals?|releases?|picks?|lineup)\b/i,
  // Movie or TV show review
  /\b(?:movie|film|tv\s+show|television\s+series)\s+review\b/i,
  /\breview[^.]{0,30}\b(?:new\s+(?:movie|film|series|season)|season\s+\d)\b/i,
  // Award-season prediction/ranking listicles (not the actual ceremony result)
  /\b(?:oscars?|emmys?|golden\s+globes?|baftas?)\s+(?:predictions?|best\s+bets?|contenders?|who\s+(?:will|should)\s+win|snubs?\s+and\s+surprises?)\b/i,
  // Ranked/countdown entertainment pieces
  /\b(?:ranked|ranking|countdown)\b[^.]{0,40}\b(?:tv|shows?|movies?|films?|episodes?|seasons?|characters?)\b/i,
  // Generic entertainment listicle framing
  /\b(?:shows?\s+you\s+need\s+to\s+watch|shows?\s+worth\s+watching|movies?\s+you\s+(?:need|should)\s+to\s+watch|films?\s+to\s+watch)\b/i,
];

// Publishing / memoir / celebrity-book signals — a public figure's memoir or
// autobiography, a book deal announcement, a bestseller-list placement, or a
// literary prize shortlist involving fiction/memoir. No defense bearing. The
// strategic guard runs FIRST, so a military leader's memoir, a declassified-
// intelligence account, or a national-security-themed book still carries guard
// terms (militar / intelligence / espionage / defen[cs]e / pentagon / diplomat)
// and is never capped. Memoir/autobiography alone without a strategic modifier
// is almost always personal narrative, not CJCS-relevant.
const CURATED_PUBLISHING_MEMOIR_PATTERNS: RegExp[] = [
  /\bmemoir\b/i,
  /\bautobiograph(?:y|ical)\b/i,
  // Book deal / advance / signing / tour
  /\bbook\s+(?:deal|advance|tour|signing|launch|release)\b/i,
  // "writes/releases a new book/memoir/novel"
  /\b(?:writes?|wrote|releasing|releases?|published?)\s+(?:a\s+new\s+)?(?:memoir|autobiography|novel|book)\b/i,
  // Bestseller framing
  /\b(?:bestseller|best-seller|instant\s+bestseller)\b/i,
  // Celebrity reveals/claims from a book
  /\bnew\s+book\b[^.]{0,50}\b(?:reveals?|claims?|alleges?|dishes?|details\s+about|opens?\s+up\s+about)\b/i,
  // Literary fiction/nonfiction prize shortlists (Booker, Pulitzer-fiction)
  /\b(?:booker\s+prize|pulitzer\s+prize\s+for\s+(?:fiction|biography|autobiography)|national\s+book\s+(?:award|prize))\s+(?:shortlist|longlist|finalist|winner)\b/i,
];

// Consumer-brand INCIDENT signals — product-safety recalls at the consumer level,
// retail-sector / fast-food labor actions, customer data exposures at non-
// strategic companies, and celebrity endorsement controversy. All are pure
// consumer / retail stories with no national-security bearing. The shared
// CURATED_STRATEGIC_GUARD fires FIRST, so a defense-contractor recall, a
// hospital data breach, a government-agency supply-chain incident, or a
// cartel-linked retail operation is protected and left untouched.
const CURATED_CONSUMER_BRAND_INCIDENT_PATTERNS: RegExp[] = [
  // Consumer-product recall (toy / baby / household / fashion)
  /\b(?:toy|baby\s+(?:product|formula|food)|children'?s?\s+product|household\s+appliance|clothing|fashion|consumer\s+electronics)\s+(?:recall|recalled|recalls)\b/i,
  /\bproduct\s+recall\b[^.]{0,40}\b(?:safety\s+(?:concern|hazard|risk)|choking\s+hazard|burn\s+risk|injury\s+risk|contamination)\b/i,
  // Fast-food / retail / consumer-brand labor walkouts (guard covers defense-industrial strikes)
  /\b(?:fast[\s-]food|retail|restaurant)\s+(?:workers?|employees?)\s+(?:strike|walkout|protest|unionize)\b/i,
  // Customer / shopper data exposure at consumer companies
  /\b(?:shoppers?|customers?|store\s+(?:customers?|members?))\b[^.]{0,40}\b(?:data\s+breach|information\s+exposed?|accounts?\s+compromised?|personal\s+(?:data|information)\s+(?:stolen|leaked?|exposed?))\b/i,
  // Celebrity / athlete endorsement deal controversy
  /\b(?:celebrity|athlete|influencer|spokesperson)\s+(?:endorsement|sponsorship)\s+(?:deal|contract|partnership)\b[^.]{0,50}\b(?:dropped?|terminated?|cancelled?|canceled?|backlash|scandal|controversy)\b/i,
];

// Culture / heritage / commemoration / anniversary human-interest signals —
// celebratory heritage initiatives, ethnic-heritage features, national-milestone
// commemorations (America's 250th / bicentennial-class vocabulary), museum /
// monument / memorial openings-and-unveilings, and commemoration-ceremony
// coverage. The prompting case was a Fox News human-interest piece about a
// Jewish-heritage initiative for America's 250th anniversary that scored P66 —
// pure cultural color with no strategic hook, which none of the existing soft
// groups recognized. As with every group, the strategic guard fires FIRST, so a
// genuinely strategic story that merely mentions heritage/commemoration (a
// military parade, an attack on an anniversary, a memorial for strike victims —
// all carry guard terms in the headline) is never demoted. Kept high-precision:
// bare "anniversary" is deliberately excluded (an adversary leader's
// founding-anniversary SPEECH or violence "on the anniversary of" an attack is
// not a celebration feature) — every anniversary pattern is anchored to
// celebratory/commemorative framing or a national-milestone term. Measured
// against 30 days of production intake (1,305 items): exactly 1 item matched
// above the cap (a commemoration-ceremony feature — the target class) and 0
// items needed guard rescue, confirming the group targets fluff, not statecraft.
const CURATED_CULTURE_HERITAGE_PATTERNS: RegExp[] = [
  // Heritage / cultural celebration-and-programming subjects
  /\b(heritage|cultural|culture)\s+(initiative|initiatives|celebration|celebrations|festival|festivals|month|week|day|event|events|exhibit|exhibits|exhibition|exhibitions|program|programs|project|projects|campaign|trail|tour|tours|site|sites|center|centre|preservation|revival)\b/i,
  /\b(jewish|black|hispanic|latino|asian|native[\s-]american|irish|italian|german|polish|greek|armenian|african[\s-]american)[\s-]heritage\b/i,
  // National-milestone anniversary vocabulary (America's 250th class)
  /\b(bicentennial|semiquincentennial|sestercentennial|centennial|sesquicentennial|tricentennial|quadricentennial)\b/i,
  /\bamerica'?s?\s*250(th)?\b/i,
  /\bamerica250\b/i,
  // Anniversary ONLY with celebratory/commemorative framing (bare word excluded)
  /\banniversary\s+(celebration|celebrations|festivities|festival|parade|gala|concert|exhibit|exhibition|initiative|events?)\b/i,
  /\b(celebrat\w+|commemorat\w+|honor(?:s|ing)?|honour(?:s|ing)?)\b[^.]*\banniversary\b/i,
  /\bcommemorat(e|es|ed|ing|ion|ions|ive)\b/i,
  // Museum / monument / memorial openings, unveilings, dedications
  /\b(museum|monument|memorial|statue|landmark|historic\s+site)\s+(opening|opens|opened|unveil\w*|exhibit\w*|dedicat\w*|renovat\w*|restor\w*|reopen\w*)\b/i,
  /\bunveil\w*\s+(a\s+|the\s+)?(statue|monument|memorial|plaque|mural|exhibit)\b/i,
  // Founders-day / time-capsule / celebration-ceremony human interest
  /\b(founders?|founding)\s+day\b/i,
  /\btime\s+capsule\b/i,
  /\b(parade|festival|festivities|pageant|gala|ceremony|ceremonies)\s+(marking|celebrating|honoring|honouring|commemorating)\b/i,
];

// Small-business / consumer cyber-fraud protection HOW-TOs (single signal from
// override log: small-business cyber-fraud piece scored P70 and received a
// "Not relevant" pin to ~30; the desired floor is ≤49). This group is special:
// it is evaluated BEFORE the shared strategic guard (see evalCuratedSoftCap),
// because the how-to framing itself unavoidably names guard tokens — "protect
// your business from HACKERS / RANSOMWARE / PHISHING" — so the shared guard
// would rescue exactly the items this group exists to cap. That is safe only
// because the patterns are high-precision full-phrase how-to constructions
// (never bare cyber vocabulary), and a NARROW agency / nation-state guard of
// its own (below) still exempts genuine government-advisory coverage.
const CURATED_CONSUMER_CYBER_PATTERNS: RegExp[] = [
  /\bhow\s+to\s+(?:protect|defend|secure|safeguard)\s+(?:your\s+)?(?:small\s+)?(?:business(?:es)?|company|data|yourself)\s+(?:from|against)\s+(?:hackers?|cybercriminals?|phishing|scams?|fraud|ransomware|identity\s+theft)\b/i,
  /\b(?:protect|guard|secure)\s+(?:your\s+)?(?:small\s+)?(?:business(?:es)?|company|data)\s+(?:from|against)\s+(?:hackers?|phishing|cyber\s+attacks?|scams?|fraud|ransomware)\b/i,
  /\bsmall[\s-]?business(?:es)?\s+cyber(?:security|\s+security|\s+fraud|\s+scam)\s+(?:tips?|guide|advice|best\s+practices?|awareness)\b/i,
  /\bcyber(?:security|\s+security)\s+tips?\s+for\s+(?:small\s+)?businesses?\b/i,
  /\b(?:phishing|ransomware|scam|fraud)\s+(?:protection\s+)?(?:tips?|guide|how[- ]to|advice)\s+(?:for\s+)?(?:small\s+)?businesses?\b/i,
];

// Narrow guard for the consumer-cyber group ONLY. Deliberately excludes the
// bare intrusion vocabulary (hack / ransomware / phishing / breach) that every
// consumer how-to naturally mentions; keeps the agency / nation-state /
// national-security tokens that mark a genuine government advisory or
// state-sponsored intrusion story (NSA / CISA / FBI warnings, espionage,
// critical infrastructure, defense contractors) — those are never capped.
const CURATED_CONSUMER_CYBER_GUARD =
  /\b(nsa|cisa|fbi|dhs|nist|pentagon|national\s+security|homeland\s+security|state[\s-]sponsored|nation[\s-]state|espionage|intelligence\s+agenc\w*|critical\s+infrastructure|defen[cs]e\s+(?:contractors?|department|industrial)|militar(y|ies)|government\s+agenc\w*|federal\s+agenc\w*|election)\b/i;

// Soft-politics rule groups, each tagged with the cap-firing reason it records
// for auditability. Order matters only for which reason is logged first.
const CURATED_SOFT_RULE_GROUPS: { reason: string; patterns: RegExp[] }[] = [
  { reason: 'soft-politics', patterns: CURATED_SOFT_PATTERNS },
  { reason: 'appointment', patterns: CURATED_APPOINTMENT_PATTERNS },
  { reason: 'corporate-fluff', patterns: CURATED_CORPORATE_PATTERNS },
  { reason: 'corporate-restructuring', patterns: CURATED_BUSINESS_PATTERNS },
  { reason: 'markets-trading', patterns: CURATED_MARKETS_PATTERNS },
  { reason: 'election-politics', patterns: CURATED_ELECTION_PATTERNS },
  { reason: 'consumer-human-interest', patterns: CURATED_CONSUMER_PATTERNS },
  { reason: 'domestic-policy', patterns: CURATED_DOMESTIC_POLICY_PATTERNS },
  { reason: 'culture-heritage', patterns: CURATED_CULTURE_HERITAGE_PATTERNS },
  // Task #1027: three new families from 164 post-reset editor corrections.
  { reason: 'entertainment-listicle', patterns: CURATED_ENTERTAINMENT_LISTICLE_PATTERNS },
  { reason: 'publishing-memoir', patterns: CURATED_PUBLISHING_MEMOIR_PATTERNS },
  { reason: 'consumer-brand-incident', patterns: CURATED_CONSUMER_BRAND_INCIDENT_PATTERNS },
  // NOTE: the consumer-cyber-howto group is intentionally NOT in this list —
  // it is evaluated pre-guard inside evalCuratedSoftCap (see comment there).
];

/**
 * Curated soft-politics cap. Returns a `{ score, reason }` pair: `score` is the
 * (possibly capped) value and `reason` names the rule that fired, or null when
 * nothing fired. Pure + deterministic; CAP-ONLY (only ever lowers an over-cap
 * score). Curated-lane ONLY.
 */
export function evalCuratedSoftCap(
  title: string,
  category: string | null | undefined,
  score: number,
): { score: number; reason: string | null } {
  if (score <= CURATED_SOFT_CAP) return { score, reason: null }; // already low
  // Consumer cyber-fraud HOW-TOs are evaluated BEFORE the shared strategic
  // guard: their framing itself names guard tokens (hackers / ransomware /
  // phishing), so the shared guard would rescue exactly the items this group
  // exists to cap. Safe pre-guard because the patterns are high-precision
  // full-phrase how-to constructions; the NARROW agency/nation-state guard
  // still exempts genuine government-advisory coverage. Title-scoped on BOTH
  // sides (guard and patterns) for maximum precision.
  if (!CURATED_CONSUMER_CYBER_GUARD.test(title || '')) {
    for (const re of CURATED_CONSUMER_CYBER_PATTERNS) {
      if (re.test(title || '')) {
        return { score: CURATED_SOFT_CAP, reason: 'consumer-cyber-howto' };
      }
    }
  }
  // Guard reads the TITLE ONLY (never the AI-assigned category). The category is
  // frequently mis-tagged (a yogurt-shop human-interest story arrived labeled
  // "Defense Industry", whose "Defense" tripped the guard and rescued it from the
  // cap), so a wrong defense-y / security-y category must never exempt a soft item.
  // Genuine statecraft always asserts itself in the HEADLINE, so a title-scoped
  // guard still protects every real strategic story (verified against the suite).
  if (CURATED_STRATEGIC_GUARD.test(title || '')) return { score, reason: null }; // statecraft
  // Soft patterns still read title + category: a correctly-soft category only ever
  // WIDENS capture (capping is the desired direction), it can never rescue a story.
  const hay = `${title || ''} ${category || ''}`;
  for (const group of CURATED_SOFT_RULE_GROUPS) {
    for (const re of group.patterns) {
      if (re.test(hay)) return { score: CURATED_SOFT_CAP, reason: group.reason };
    }
  }
  return { score, reason: null };
}

/**
 * Backwards-compatible pure cap (Task #262 contract). Returns the capped score
 * only; preserved verbatim in behavior so `scripts/curated-soft-cap.test.ts`
 * and the curated ingest path keep their exact semantics.
 */
export function capSoftPoliticsPriority(
  title: string,
  category: string | null | undefined,
  score: number,
): number {
  return evalCuratedSoftCap(title, category, score).score;
}

// ---- Curated capability-feature temper cap (curated-lane ONLY) ------------
// Discrete strategic EVENTS (a strike, a downing, an interception, a seizure,
// casualties) should out-rank capability SHOWCASE / trend-FEATURE coverage — a
// "look at our new hardware" reveal ("Army unveils its next-gen attack drone")
// or a think-piece trend ("the future of drone warfare", "how AI is reshaping
// combat"). The gate analyzer tends to over-score the latter into the top band
// because they carry heavy defense vocabulary (drone / missile / hypersonic).
//
// The soft cap above CANNOT temper these: its strategic guard deliberately
// EXEMPTS exactly that defense vocabulary, and its floor of 49 is far too low
// for a legitimate capability story. So this is a SEPARATE, higher cap that
// fires ONLY on high-precision feature/showcase framing AND only when NO
// discrete-event verb/outcome is present — so a real strike or downing is never
// tempered. CAP-ONLY, title-scoped (the AI category is untrusted, exactly as the
// soft cap treats it). It only lowers a score ABOVE the cap; anything at/below
// CURATED_CAPABILITY_CAP is left untouched. Curated-lane ONLY; wired for
// gate-mode analyzer scores (never a human/upstream score or reuse baseline).
export const CURATED_CAPABILITY_CAP = 75;

// Discrete-event / outcome signal. When ANY of these appears the headline is
// reporting a real event (something HAPPENED), not a capability profile, so it
// is NEVER tempered. Deliberately GENEROUS (err toward NOT capping): a false
// negative (a feature slips through uncapped) is cheap; a false positive (a real
// strike tempered) is expensive. Note bare "attack" is intentionally EXCLUDED —
// it collides with the hardware nouns ("attack drone", "attack helicopter") we
// specifically WANT to temper; genuine attacks are still caught by strike /
// struck / launched-a-strike / assault / raid / etc.
const CAPABILITY_EVENT_EXEMPTION =
  /\b(strikes?|struck|striking|shot\s+down|shoots?\s+down|downs?|downed|intercept(?:s|ed|ing)?|kill(?:s|ed|ing)?|hits?|destroy(?:s|ed|ing)?|casualt\w*|wound(?:s|ed|ing)?|dead|deaths?|deadly|fatalit\w*|explod(?:e|es|ed|ing)?|blast(?:s|ed)?|assault(?:s|ed|ing)?|seiz(?:e|es|ed|ing)?|captur(?:e|es|ed|ing)?|shell(?:s|ed|ing)?|bomb(?:s|ed|ing)?|bombard\w*|ambush\w*|raid(?:s|ed|ing)?|incursion|invad(?:e|es|ed|ing)?|invasion|clash(?:es|ed|ing)?|firefight|barrage|salvo|shootdown|shoot-?down)\b|\blaunch(?:es|ed|ing)?\s+(?:a\s+|an\s+|its\s+|new\s+|fresh\s+|major\s+)*(?:strike|attack|assault|offensive|barrage|salvo|missiles?|drones?)\b/i;

// Capability hardware / platform nouns — the subject a showcase reveals. "tanks?"
// carries a negative lookbehind so "think tank" never matches.
const CAPABILITY_HARDWARE =
  /\b(drones?|uavs?|ucavs?|missiles?|hypersonic\w*|warheads?|fighter\s+jets?|jets?|stealth|warships?|destroyers?|frigates?|submarines?|carriers?|(?<!think[\s-])tanks?|howitzers?|artiller\w*|weapons?\s+systems?|weapon\s+systems?|weaponry|aircraft|helicopters?|radars?|lasers?|railguns?|loitering\s+munitions?|munitions?|counter-?drone|air\s+defen[cs]e|missile\s+defen[cs]e|exoskeleton\w*|robot\w*|autonomous\s+(?:weapons?|systems?|vehicles?|drones?)|drone\s+swarms?)\b/i;

// High-precision SHOWCASE verbs (marketing / reveal register). Weapons TESTS
// ("test-fire", "test-launch", "conducts drill") are deliberately EXCLUDED —
// they are often strategically significant events, not marketing reveals. So
// are ambiguous verbs like "reveal" / "introduce" / "roll out" (they collide
// with intelligence findings and force-fielding).
const CAPABILITY_SHOWCASE_VERB =
  /\b(unveil(?:s|ed|ing)?|debut(?:s|ed|ing)?|showcas(?:e|es|ed|ing)|shows?\s+off|showed\s+off|touts?|touted|put(?:s|ting)?\s+on\s+display|parades?|paraded)\b/i;

// Intrinsically feature/trend phrasing that needs no hardware co-mention.
const CAPABILITY_TREND_FRAMING =
  /\bfuture of (?:war|warfare|combat|conflict|air\s+combat|naval\s+warfare|drone\s+warfare|ground\s+combat|modern\s+war\w*)\b/i;

function hasCapabilityFeatureFraming(title: string): boolean {
  const t = title || '';
  if (!t.trim()) return false;
  // Pure trend / think-piece framing ("the future of drone warfare").
  if (CAPABILITY_TREND_FRAMING.test(t)) return true;
  // "how/why X is changing / transforming / reshaping ... war/warfare/combat".
  if (
    /\b(?:how|why)\b/i.test(t) &&
    /\b(?:chang(?:e|es|ing)|transform(?:s|ed|ing)?|reshap(?:e|es|ing)|revolutioni[sz](?:e|es|ing)|redefin(?:e|es|ing)|reinvent(?:s|ed|ing)?)\b/i.test(t) &&
    /\b(?:war|warfare|combat|battlefield|military|conflict)\b/i.test(t)
  ) {
    return true;
  }
  // "next-gen(eration)" capability reveal — requires hardware context.
  if (/\bnext[\s-]?gen(?:eration)?\b/i.test(t) && CAPABILITY_HARDWARE.test(t)) return true;
  // Prototype / concept demonstrator — requires hardware context.
  if (
    /\b(?:prototype|technology\s+demonstrator|tech\s+demo|test-?bed|concept\s+(?:vehicle|aircraft|drone|weapon))\b/i.test(t) &&
    CAPABILITY_HARDWARE.test(t)
  ) {
    return true;
  }
  // A showcase VERB paired with a hardware noun ("unveils new drone").
  if (CAPABILITY_SHOWCASE_VERB.test(t) && CAPABILITY_HARDWARE.test(t)) return true;
  return false;
}

/**
 * Deterministic curated-lane temper cap for capability SHOWCASE / trend-FEATURE
 * coverage that the gate analyzer over-scored into the top band. Returns the
 * (possibly lowered) score plus the reason that fired (or null). Pure +
 * deterministic; CAP-ONLY (never raises). A discrete-event headline is exempt.
 * Curated-lane ONLY — must never run inside the main-feed path.
 */
export function evalCuratedCapabilityCap(
  title: string,
  score: number,
): { score: number; reason: string | null } {
  const t = title || '';
  if (score <= CURATED_CAPABILITY_CAP) return { score, reason: null };
  if (CAPABILITY_EVENT_EXEMPTION.test(t)) return { score, reason: null }; // real event — keep
  if (hasCapabilityFeatureFraming(t)) {
    return { score: CURATED_CAPABILITY_CAP, reason: 'capability-feature' };
  }
  return { score, reason: null };
}

// ---- Curated LEARNED scoring cap (curated-lane ONLY) ------------------------
// Task #678: an APPROVED learned scoring-cap rule (mined from editors repeatedly
// hiding or down-pinning an outlet×category the AI over-scored) supplies a cap
// ceiling for that class. This helper applies it: STRICTLY DOWN-only, cap-only —
// it can only ever LOWER a MACHINE score (analyzer or reuse baseline), never
// raise one, and the caller gates it so it never touches a real human/upstream
// score. Pure + deterministic. `cap` is the ceiling from the approved rule
// (undefined/null → no learned cap applies, score returned untouched).
export function evalCuratedLearnedScoringCap(
  score: number,
  cap: number | null | undefined,
): { score: number; reason: string | null } {
  if (cap == null || !Number.isFinite(cap)) return { score, reason: null };
  if (score <= cap) return { score, reason: null }; // already at/below the cap
  return { score: cap, reason: 'learned-scoring-cap' };
}

// ---- Curated analysis / opinion / explainer score cap (curated-lane ONLY) ---
// Editors repeatedly down-pinned analysis/explainer/commentary pieces that the
// gate analyzer scored 72–85 — the same band it reserves for theater-shaping
// NEWS. Analysis/opinion/explainer pieces (URL-detectable via /opinion/,
// /analysis/, CNN trailing -analysis slug, /explainers/, Reuters explainer-
// slug, /live-blog/, /liveblog/, /live-updates/) should not compete with
// breaking events for top-band slots. This CAP pulls them to ≤69 (the
// top of the Moderate band) so discrete strategic events reliably out-rank
// them. CAP-ONLY, machine-score-only (gate + reuse baselines), curated-lane
// ONLY. Never applied to human-set scores or pins. Uses URL detection only
// so it fires at ingest time; page-labeled kinds (article:section = Analysis)
// gain a badge and attach-only tier via enrichment independently.
export const CURATED_ANALYSIS_OPINION_CAP = 69;

/**
 * Deterministic curated-lane temper cap for opinion / analysis / explainer
 * pieces the gate analyzer over-scored into the top band. Returns the
 * (possibly lowered) score plus the reason that fired (or null). Pure +
 * deterministic; CAP-ONLY (only ever lowers a score above the cap). Curated-
 * lane ONLY — must never run inside the main-feed path.
 */
export function evalCuratedAnalysisOpinionCap(
  url: string | null | undefined,
  score: number,
): { score: number; reason: string | null } {
  if (score <= CURATED_ANALYSIS_OPINION_CAP) return { score, reason: null };
  const kind = deriveContentType(url);
  if (kind === 'opinion' || kind === 'explainer' || kind === 'live' || kind === 'podcast') {
    return { score: CURATED_ANALYSIS_OPINION_CAP, reason: 'analysis-opinion-explainer' };
  }
  return { score, reason: null };
}

// ---- Direct U.S.-implication tie-break (curated-lane ONLY) ------------------
// This is deliberately narrower than "mentions the U.S.": it recognizes
// Russia–Ukraine OR Israel–Gaza conflict coverage only when the headline/known
// synopsis names a concrete U.S. security, force-posture, alliance,
// economic-statecraft, diplomatic, homeland-security, or material-exposure
// consequence. It runs after relevance acceptance and deterministic caps, never
// admits a rejected candidate, and only nudges an already machine-derived
// curated score relative to comparable reporting.
export const CURATED_US_IMPLICATION_TIE_BREAK = 3;
const RUSSIA_UKRAINE_CONFLICT = /\b(?:russia|russian|kremlin|moscow|ukraine|ukrainian|kyiv|kiev|zelensky|putin|kherson|kharkiv|zaporizh\w*|donbas|donetsk|luhansk|crimea|odesa|dnipro|pokrovsk)\b/i;
const ISRAEL_GAZA_CONFLICT = /\b(?:gaza|hamas|rafah|khan younis|deir al-balah|jabalia|hind rajab)\b/i;
const US_ACTOR_FRAGMENT = String.raw`(?:u\.?s\.?|united states|american|washington|pentagon|defense department|department of defense|dod|white house|state department|treasury|congress|nato|trump(?: administration)?|biden(?: administration)?)`;
const MATERIAL_US_FRAGMENT = String.raw`(?:troops?|forces?|deployment|force posture|air defense|missiles?|weapons?|arms?|munitions?|security assistance|aid(?: package)?|military aid|arms package|defense commitment|article 5|alliance commitment|sanctions?|export controls?|asset seizure|frozen assets?|tariffs?|homeland security|border security|cyber(?:attack|security)?|critical infrastructure|intelligence sharing|ceasefire|truce|peace plan|mediat(?:e|es|ed|ion)|diploma(?:cy|tic)|negotiations?|talks|hostages?|personnel|citizens?|bases?|assets?)`;
const DIRECT_US_ACTION_FRAGMENT = String.raw`(?:announc\w*|approv\w*|authoriz\w*|block\w*|suspend\w*|halt\w*|provid\w*|send\w*|deliver\w*|transfer\w*|deploy\w*|withdraw\w*|fund\w*|sanction\w*|impos\w*|lift\w*|seiz\w*|freez\w*|mediat\w*|broker\w*|negotiat\w*|defend\w*|intercept\w*|evacuat\w*|rescu\w*)`;
const INCIDENTAL_US_MENTION = new RegExp(
  String.raw`\b${US_ACTOR_FRAGMENT}\s+(?:media|outlets?|journalists?|reporters?|commentators?|analysts?|officials?\s+(?:said|say|told|commented))\b`,
  'i',
);
// A concrete relationship, not loose co-occurrence. These patterns require the
// U.S. actor to own/perform a material action, the material action to be
// explicitly by/from the U.S., or U.S. people/assets to be directly affected.
const DIRECT_US_RELATION_PATTERNS = [
  new RegExp(
    String.raw`\b${US_ACTOR_FRAGMENT}\b.{0,55}\b${DIRECT_US_ACTION_FRAGMENT}\b.{0,55}\b${MATERIAL_US_FRAGMENT}\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b${US_ACTOR_FRAGMENT}\s+(?:new\s+|military\s+|security\s+|defense\s+)?${MATERIAL_US_FRAGMENT}\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b${MATERIAL_US_FRAGMENT}\b.{0,30}\b(?:by|from|of|with|under)\s+(?:the\s+)?${US_ACTOR_FRAGMENT}\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b(?:kill\w*|injur\w*|wound\w*|threaten\w*|detain\w*|captur\w*|kidnap\w*|hold\w*)\b.{0,35}\b(?:u\.?s\.?|american)\s+(?:personnel|citizens?|troops?|forces?|hostages?|assets?)\b`,
    'i',
  ),
];

export function hasDirectUsConflictImplication(
  title: string,
  summary: string | null | undefined,
  conflictTrack?: string | null,
): boolean {
  const text = `${title || ''} ${summary || ''}`.trim();
  const targetTrack =
    conflictTrack === 'Russia-Ukraine War' ||
    conflictTrack === 'Israel-Hamas / Gaza';
  return !!(
    text &&
    (targetTrack ||
      RUSSIA_UKRAINE_CONFLICT.test(text) ||
      ISRAEL_GAZA_CONFLICT.test(text)) &&
    !INCIDENTAL_US_MENTION.test(text) &&
    DIRECT_US_RELATION_PATTERNS.some((pattern) => pattern.test(text))
  );
}

export function evalCuratedDirectUsImplicationTieBreak(
  title: string,
  summary: string | null | undefined,
  score: number,
): { score: number; applied: boolean; reason: string | null } {
  if (!hasDirectUsConflictImplication(title, summary)) {
    return { score, applied: false, reason: null };
  }
  return {
    score: Math.min(85, score + CURATED_US_IMPLICATION_TIE_BREAK),
    applied: true,
    reason: 'direct-us-conflict-implication',
  };
}

// ---- Curated learned-rule GOVERNANCE helpers (curated-lane ONLY) ------------
// Task #678: two pure, deterministic guards the learned-rule loop relies on so a
// human's "Reset" and "Snooze" controls in the Adjustments tab are actually
// honored by the deterministic compiler. Extracted here (leaf module, no DB) so
// they are unit-testable in isolation.

// The compiler mines editor actions from the LATER of its plain lookback window
// and the reset checkpoint (curated_feedback_settings.acknowledgedAt). A reset
// must truly start a fresh learning cycle, so pre-reset events never drive new
// suggestions. Returns the effective `since` bound.
export function resolveLearnedRuleCompilerSince(
  lookbackSince: Date,
  acknowledgedAt: Date | null | undefined,
): Date {
  if (acknowledgedAt && acknowledgedAt.getTime() > lookbackSince.getTime()) {
    return acknowledgedAt;
  }
  return lookbackSince;
}

// A snoozed rule whose cooldown has NOT yet elapsed must stay hidden — the
// compiler must not resurface it as 'suggested' until snoozedUntil passes. True
// = still cooling down (leave hidden); false = not snoozed or cooldown expired.
export function isSnoozeCooldownActive(
  status: string,
  snoozedUntil: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return status === 'snoozed' && !!snoozedUntil && snoozedUntil.getTime() > now.getTime();
}

// ---- Curated personal/consumer-finance RELEVANCE reject (curated-lane ONLY) --
// Unlike the caps above, this is a HARD RELEVANCE reject (is_relevant=false), not
// a score cap: a personal/consumer-finance & money-management HOW-TO with no
// national-security, defense, or foreign-policy bearing should never enter the
// curated store at all. The prompting case was a CNBC service-journalism piece —
// "Just graduated college? Here are 4 bank accounts to put your money before real
// life hits" — which the AI gate mis-kept at P67 (and even mis-tagged "Economic
// Pressure / South Korea"). Prompt guidance alone drifts, and the 'reuse' intake
// path (Meltwater / social) runs NO AI relevance gate, so this deterministic
// backstop runs on EVERY curated intake regardless of mode.
//
// The shared CURATED_STRATEGIC_GUARD fires FIRST — it covers sanctions, tariffs,
// embargoes, "trade war" (via "war"), export controls, supply chains, critical
// minerals, semiconductors, defense-industrial terms AND the economic-statecraft
// finance vocabulary that legitimately co-occurs with consumer money words —
// central bank(s), asset freezes / frozen accounts·assets·funds·reserves, money
// laundering / illicit & terror financing / sanctions evasion, capital controls,
// sovereign·foreign·currency·gold reserves, sovereign wealth, reserve currency /
// de-dollarization, the SWIFT system and OFAC / Treasury — so a genuine
// economic-statecraft story that merely shares a money word is NEVER rejected. The
// patterns themselves are NARROW personal-banking / consumer-credit / retirement /
// money-advice phrasing: macro-economic terms (central bank, interest rates,
// inflation, sovereign debt) do not match them, so macro coverage is untouched.
// Title-scoped (genuine relevance asserts itself in the headline; the AI category
// is frequently mis-tagged, so it must not be trusted to rescue or condemn).
const CURATED_PERSONAL_FINANCE_PATTERNS: RegExp[] = [
  // "bank account(s)" is consumer-QUALIFIED (open/best/new/online/a number of …)
  // so statecraft phrasing — "central bank accounts", "frozen/Swiss/offshore bank
  // accounts" — does NOT match here (and is additionally covered by the guard).
  /\b(?:open(?:ing)?|opened|best|top|new|online|free|joint|second|student|starter|first|multiple|several|separate|different|\d+)\s+(?:[a-z][a-z-]*\s+){0,2}bank accounts?\b/i,
  /\b(checking|savings|brokerage|retirement|money[\s-]?market)\s+accounts?\b/i,
  /\bhigh[\s-]?yield\s+savings\b/i,
  /\bcredit cards?\b/i,
  /\bdebit cards?\b/i,
  /\bcredit score\b/i,
  /\bcredit union\b/i,
  /\b401\s*\(?\s*k\s*\)?\b/i,
  /\broth\s+ira\b/i,
  /\bira\s+(account|accounts|contribution|contributions|rollover)\b/i,
  /\bpersonal\s+finance\b/i,
  /\bpersonal\s+loans?\b/i,
  /\bmortgage\s+rates?\b/i,
  /\b(budgeting|saving|savings|money|retirement|investing)\s+(tips?|advice|hacks?|strateg(?:y|ies)|guide|basics?|101)\b/i,
  /\bhow to (save|invest|budget|retire|build credit|pay off|manage your money|grow your (?:money|savings|wealth))\b/i,
  /\b(put|park|stash|grow)\s+your\s+(money|cash|savings)\b/i,
  /\bbest\s+(banks?|savings|checking|credit\s+cards?|cds?|brokerages?|robo-?advisors?)\b/i,
  /\bsign[\s-]?up\s+bonus\b/i,
];

/**
 * Deterministic curated-lane relevance reject for personal/consumer-finance &
 * money-management HOW-TO content with no national-security bearing. Returns true
 * when the title should be rejected from the curated store. Pure + deterministic;
 * curated-lane ONLY. Economic STATECRAFT is protected by CURATED_STRATEGIC_GUARD
 * (checked first), so this only ever removes personal/consumer money advice.
 */
export function isCuratedNonRelevantConsumerFinance(title: string): boolean {
  const t = title || '';
  if (!t.trim()) return false;
  if (CURATED_STRATEGIC_GUARD.test(t)) return false; // economic statecraft / defense — keep
  return CURATED_PERSONAL_FINANCE_PATTERNS.some((re) => re.test(t));
}

// ---- Curated DOMESTIC-CRIME / PARTISAN-POLITICS cap ≤60 (curated-lane ONLY) --
// Editors repeatedly down-pinned domestic-crime narratives (individual murder
// trials, local violence without terrorism/NG framing) and purely partisan
// political brinkmanship (congressional party-line votes, party rhetoric with
// no national-security legislation bearing) that the gate analyzer over-scored
// into the 61–74 band. These belong in the Low-Strategic tier (50–60) — they
// can still reach that tier when genuinely relevant, but they must not compete
// with theater-shaping events for top-band slots.
//
// CAP value: 60 (sits just inside the Low-Strategic ceiling so stories with
// real strategic co-text can still reach 61+ via other dimensions — the guard
// only fires when the title LACKS any strategic anchor).
//
// GUARD: CURATED_STRATEGIC_GUARD fires FIRST so the cap NEVER fires on:
//   - domestic terrorism / mass-casualty attacks (guard: terror / massacre)
//   - NG deployments / border security / federal law enforcement operations
//     (guard: militar / national guard / border / federal law / dhs / fbi)
//   - congressional votes on national-security or defense-authorization bills
//     (guard: defen[cs]e / ndaa / authorization / military funding / pentagon)
//   - political decisions with strategic impact (sanctions, arms, diplomacy)
//   - any story with escalation, strike, attack, conflict geography, etc.
//
// Pattern scope: curated-lane ONLY, machine-score-only. Never applied to human
// pins or imported priority scores.
export const CURATED_DOMESTIC_CRIME_CAP = 60;

const CURATED_DOMESTIC_CRIME_PATTERNS: RegExp[] = [
  // Individual criminal trial / conviction / sentencing
  /\b(?:convicted|sentenced|acquitted|found\s+guilty|on\s+trial|murder\s+trial|arraigned|indicted\s+for|pleaded?\s+guilty)\b/i,
  // Domestic-violence / homicide narrative (non-mass-casualty — guard covers mass shootings)
  /\b(?:stabbing|strangulation|domestic\s+violence|domestic\s+abuse|wife\s+killing|husband\s+killing)\s+(?:case|trial|suspect|victim|verdict|sentence|charges?)\b/i,
  // Gang / street violence without terrorism framing
  /\b(?:gang\s+(?:shooting|violence|member|leader)|drive[\s-]by\s+shooting|carjacking|armed\s+robbery)\s+(?:charges?|suspect|verdict|sentence|conviction)\b/i,
  // Drug-trafficking prosecution (domestic criminal, not cartel-strategic — guard covers cartels)
  /\b(?:drug\s+trafficking|drug\s+ring|fentanyl\s+dealer|opioid\s+distribution)\s+(?:sentence|conviction|arrest|indictment|charges?)\b/i,
];

const CURATED_PARTISAN_POLITICS_PATTERNS: RegExp[] = [
  // Congressional party-line vote with no strategic legislation
  /\bhouse\s+(?:republicans?|democrats?|gop)\s+(?:vote|votes|voted|block|blocked|pass|passed|push)\b[^.]{0,60}\b(?!(?:defen[cs]e|national\s+security|ndaa|military|sanctions|arms|weapon|intelligence|foreign|appropriations|budget\s+(?:for\s+)?(?:defen[cs]e|military|pentagon)))\b/i,
  // Purely partisan political attack / rhetoric
  /\b(?:republicans?|democrats?|gop|dnc|rnc)\s+(?:accuse[sd]?|blast(?:ed|s)?|slam(?:med|s)?|attack(?:ed|s)?|criticize[sd]?|slam(?:s|med)?)\s+(?:biden|trump|harris|obama|pelosi|mccarthy|schumer|mcconnell)\b/i,
  // Political party strategy / caucus process story
  /\b(?:party\s+(?:caucus|primary|base|donors?|fundraising)|leadership\s+race|speakership|party\s+(?:platform|message|brand|strategists?|operatives?))\b/i,
];

/**
 * Curated-lane domestic-crime and partisan-politics score cap at ≤60.
 * Returns the (possibly capped) score and the reason, or null. Pure +
 * deterministic; CAP-ONLY; curated-lane ONLY.
 *
 * The cap fires when:
 *   1. The score is above CURATED_DOMESTIC_CRIME_CAP (60).
 *   2. The title does NOT contain any CURATED_STRATEGIC_GUARD term.
 *   3. The title matches one of the domestic-crime or partisan-politics patterns.
 */
export function evalCuratedDomesticCrimeCap(
  title: string,
  score: number,
): { score: number; reason: string | null } {
  if (score <= CURATED_DOMESTIC_CRIME_CAP) return { score, reason: null };
  const t = title || '';
  if (CURATED_STRATEGIC_GUARD.test(t)) return { score, reason: null };
  for (const re of CURATED_DOMESTIC_CRIME_PATTERNS) {
    if (re.test(t)) return { score: CURATED_DOMESTIC_CRIME_CAP, reason: 'domestic-crime' };
  }
  for (const re of CURATED_PARTISAN_POLITICS_PATTERNS) {
    if (re.test(t)) return { score: CURATED_DOMESTIC_CRIME_CAP, reason: 'partisan-politics' };
  }
  return { score, reason: null };
}

// ---- Main-feed NOAA cap (main-lane ONLY) ---------------------------------
// DOWNGRADE: cap NOAA-related articles so a weather-agency item can't claim a
// top main-feed slot (prevents top-4 ranking). Main-lane ONLY; CAP-ONLY.
export const NOAA_MAIN_CAP = 40;

/**
 * Main-feed deterministic caps. Today: the NOAA downgrade. Returns the capped
 * score plus the reason that fired (or null). Pure + deterministic; CAP-ONLY.
 * Main-lane ONLY — must never run inside the curated gate.
 */
export function evalMainScoreCaps(
  title: string,
  score: number,
): { score: number; reason: string | null } {
  const hay = (title || '').toLowerCase();
  if (hay.includes('noaa') && score > NOAA_MAIN_CAP) {
    return { score: NOAA_MAIN_CAP, reason: 'noaa' };
  }
  return { score, reason: null };
}
