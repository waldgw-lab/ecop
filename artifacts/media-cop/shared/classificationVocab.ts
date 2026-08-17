// =============================================================================
// Curated classification — CONTROLLED VOCABULARY (Task #336).
//
// The SINGLE enforced enum for the curated lane's structured classification
// enrichment layer. Shared between server (generator + persistence + remap) and
// client (label render + filters) so a topic/track/scope is validated and
// coerced identically everywhere.
//
// CURATED-LANE ONLY. Nothing here is an admission, relevance, or ranking input
// for any feed; it describes an item AFTER routing. It never touches the Main
// analyzer, Classic/Visual, custom-MCOPs, or the public REST API.
//
// Governance model: the lists are enforced in code (validate/coerce), not frozen.
// An off-list value is coerced to the catch-all `Other / Emerging` and the model
// may emit a structured `proposed_topic` into a human-gated proposals log — it
// can NEVER self-expand the live vocabulary in prod.
// =============================================================================

// -----------------------------------------------------------------------------
// primary_topic — geography-agnostic; exactly one per item. 21 topics + catch-all.
// -----------------------------------------------------------------------------
export const PRIMARY_TOPICS = [
  "Military Operations & Armed Conflict",
  "Force Posture & Deployments",
  "Defense Policy & Military Readiness",
  "Weapons, Procurement & Defense Industry",
  "Nuclear, WMD & Strategic Deterrence",
  "Cyber, Space & Emerging Technology",
  "Foreign Policy & Diplomacy",
  "Alliances & Multilateral Institutions",
  "Economic Statecraft & Sanctions",
  "Intelligence, Espionage & Security Services",
  "Information Environment & Influence",
  "Terrorism, Insurgency & Non-State Armed Groups",
  "Border, Homeland & Internal Security",
  "Maritime Security & Chokepoints",
  "Critical Infrastructure, Energy & Supply Chains",
  "Humanitarian, Civilian Harm & Displacement",
  "Governance, Elections & Domestic Stability",
  "Law, Courts & International Norms",
  "Public Health, Disaster & Environmental Security",
  "Global Markets & Strategic Economics",
  // Task #25 — AI/ML/autonomy split out of Cyber, Space & Emerging Technology.
  // Defense-specific capabilities (military drones, defense-industry AI
  // programs) stay in Weapons, Procurement & Defense Industry.
  "AI, Machine Learning & Autonomous Systems",
] as const;

export const OTHER_EMERGING = "Other / Emerging" as const;

export type RealPrimaryTopic = (typeof PRIMARY_TOPICS)[number];
export type PrimaryTopic = RealPrimaryTopic | typeof OTHER_EMERGING;

// -----------------------------------------------------------------------------
// SHORT UI LABELS for the curated card's "Topic" slot (Topic · Focus model).
// The full primary_topic stays the enforced/stored value; this is the compact,
// scannable label the curated view RENDERS (e.g. "Military Ops", "Diplomacy").
// CURATED-LANE display only — never a stored or admission value. There is no
// short label for `Other / Emerging`: the Topic slot renders the neutral dash
// instead (Task #912 allowlist — the free-form `category` is never rendered
// raw as a Topic) so a bare "Other" never shows.
// -----------------------------------------------------------------------------
export const PRIMARY_TOPIC_SHORT_LABELS: Record<RealPrimaryTopic, string> = {
  "Military Operations & Armed Conflict": "Military Ops",
  "Force Posture & Deployments": "Force Posture",
  "Defense Policy & Military Readiness": "Defense Policy",
  "Weapons, Procurement & Defense Industry": "Defense Industry",
  "Nuclear, WMD & Strategic Deterrence": "Nuclear & WMD",
  "Cyber, Space & Emerging Technology": "Space & Tech",
  "Foreign Policy & Diplomacy": "Diplomacy",
  "Alliances & Multilateral Institutions": "Alliances",
  "Economic Statecraft & Sanctions": "Economic Pressure",
  "Intelligence, Espionage & Security Services": "Intel & Espionage",
  "Information Environment & Influence": "Information Ops",
  "Terrorism, Insurgency & Non-State Armed Groups": "Terrorism & Insurgency",
  "Border, Homeland & Internal Security": "Domestic Security",
  "Maritime Security & Chokepoints": "Maritime Security",
  "Critical Infrastructure, Energy & Supply Chains": "Infrastructure & Energy",
  "Humanitarian, Civilian Harm & Displacement": "Humanitarian Impact",
  "Governance, Elections & Domestic Stability": "Governance & Stability",
  "Law, Courts & International Norms": "Legal & Norms",
  "Public Health, Disaster & Environmental Security": "Disaster & Health",
  "Global Markets & Strategic Economics": "Strategic Markets",
  "AI, Machine Learning & Autonomous Systems": "AI",
};

/**
 * The SHORT UI label for a primary_topic, or null when the bucket is
 * `Other / Emerging` / unknown (the Topic slot then falls back to a read-time
 * inferred controlled topic, else the neutral dash — never the raw free-form
 * category; Task #912 allowlist). Tolerates loose/legacy spellings via
 * coercePrimaryTopic.
 */
export function primaryTopicShortLabel(pt: string | null | undefined): string | null {
  const coerced = coercePrimaryTopic(pt);
  if (!coerced || coerced === OTHER_EMERGING) return null;
  return PRIMARY_TOPIC_SHORT_LABELS[coerced];
}

// -----------------------------------------------------------------------------
// conflict_track — optional, governed. A FIELD, never a primary_topic.
// -----------------------------------------------------------------------------
export const CONFLICT_TRACKS = [
  "Russia-Ukraine War",
  "Israel-Iran Conflict",
  "U.S.-Iran-Israel Conflict",
  "Israel-Hamas / Gaza",
  "Israel-Hezbollah / Lebanon",
  "U.S.-Iran Conflict",
] as const;
export type ConflictTrack = (typeof CONFLICT_TRACKS)[number];

// -----------------------------------------------------------------------------
// conflict_track -> FOCUS hint for the curated card's "Focus" slot. conflict_track
// NEVER occupies the Topic slot; it only INFORMS the Focus (the country pair,
// or a theater label when the conflict isn't a clean two-state pair). Lets a
// historical/marquee row render its pair focus (e.g. "Russia–Ukraine") with no
// migration and no extra LLM call — purely derived at read time as a fallback
// after any explicitly stored countryPair. CURATED-LANE display only.
// `countries` are FULL names (the display layer abbreviates, e.g. U.S.).
// -----------------------------------------------------------------------------
export const CONFLICT_TRACK_FOCUS: Record<ConflictTrack, { countries?: [string, string]; label?: string }> = {
  "Russia-Ukraine War": { countries: ["Russia", "Ukraine"] },
  "Israel-Iran Conflict": { countries: ["Israel", "Iran"] },
  // Tri-party theater (U.S. + Iran + Israel) — not a clean two-state pair, so it
  // shows a theater label rather than a country pair.
  "U.S.-Iran-Israel Conflict": { label: "U.S.\u2013Iran\u2013Israel" },
  "Israel-Hamas / Gaza": { label: "Gaza" },
  "Israel-Hezbollah / Lebanon": { countries: ["Israel", "Lebanon"] },
  "U.S.-Iran Conflict": { countries: ["United States", "Iran"] },
};

// -----------------------------------------------------------------------------
// scope
// -----------------------------------------------------------------------------
export const SCOPES = [
  "Global/International",
  "Regional",
  "National/Domestic",
] as const;
export type Scope = (typeof SCOPES)[number];

// -----------------------------------------------------------------------------
// source_kind — DERIVED deterministically from lane/table + content_kind +
// registry identity. Never an AI guess. (Definition lives here so client + server
// label it the same way.)
// -----------------------------------------------------------------------------
export const SOURCE_KINDS = [
  "Wire / Reported",
  "Opinion / Analysis",
  "Video",
  "Podcast",
  "Social / OSINT",
  "Official Statement",
  "Manual Submission",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

// -----------------------------------------------------------------------------
// The Phase-1 classification object. Reserve the shape so the deferred Phase-2
// body-inference fields (actor_country, affected_country, event_country,
// entities, narrative_target) can be added later without a rewrite — they are
// intentionally NOT populated now (title-only inference would be empty or wrong).
// -----------------------------------------------------------------------------
export interface ClassificationObject {
  primaryTopic: PrimaryTopic;
  scope: Scope | null;
  region: string | null;
  topicCountry: string | null;
  conflictTrack: ConflictTrack | null;
  // EXACTLY two FULL country names when the story is fundamentally about a
  // relationship / conflict / negotiation / strike / dispute / bilateral policy
  // action BETWEEN two countries (e.g. ["United States","Iran"]). Else null. This
  // is the ONLY source for a non-conflict two-country Focus (e.g. "U.S.–Israel");
  // tracked-conflict pairs also derive for free from conflictTrack. CURATED-LANE
  // display only — never an admission/ranking signal. The display layer
  // abbreviates + joins with an en-dash.
  countryPair: string[] | null;
  // Set ONLY when the model judged that nothing on the list fits and a NEW topic
  // may be warranted. Logged to the human-gated proposals channel; never adopted
  // as a live label automatically.
  proposedTopic: string | null;
  // --- Reserved for Phase 2 (body-inference); do not populate in Phase 1. ---
  // actorCountry?: string | null;
  // affectedCountry?: string | null;
  // eventCountry?: string | null;
  // entities?: string[] | null;
  // narrativeTarget?: string | null;
}

// =============================================================================
// Validation / coercion
// =============================================================================
function normKey(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const PRIMARY_BY_NORM = new Map<string, PrimaryTopic>();
for (const t of PRIMARY_TOPICS) PRIMARY_BY_NORM.set(normKey(t), t);
PRIMARY_BY_NORM.set(normKey(OTHER_EMERGING), OTHER_EMERGING);
// Common shorthand the model tends to emit for the catch-all.
PRIMARY_BY_NORM.set("other", OTHER_EMERGING);
PRIMARY_BY_NORM.set("emerging", OTHER_EMERGING);

// -----------------------------------------------------------------------------
// NEAR-MISS COERCION ALIASES (Task: sharpen curated topic assignment).
// Off-list variants the model has ACTUALLY emitted in production (source: the
// classification_topic_proposals log) that unambiguously mean an EXISTING
// topic. Each alias snaps to its intended real topic instead of falling into
// the "Other / Emerging" catch-all. Rules:
//   - aliases map ONLY to existing PRIMARY_TOPICS — never introduce new ones;
//   - ambiguous variants that could plausibly fit TWO topics stay UNALIASED
//     (they keep falling to the catch-all + proposals log), e.g.
//     "Domestic Security & Civil Unrest" (Border/Homeland vs Governance);
//   - keys are stored through normKey (case/punctuation-insensitive).
// Guarded by scripts/curated-topic-alias.test.ts so a future vocab rename
// can't silently break the targets.
// -----------------------------------------------------------------------------
export const PRIMARY_TOPIC_ALIASES: Record<string, RealPrimaryTopic> = {
  // The retired off-list exemplar label + near-miss diplomacy phrasings.
  "Diplomacy & International Agreements": "Foreign Policy & Diplomacy",
  // Governance near-misses (word-order / phrasing variants).
  "Domestic Stability & Governance": "Governance, Elections & Domestic Stability",
  "Domestic Politics & Security": "Governance, Elections & Domestic Stability",
  // Energy-security phrasings → the infrastructure/energy bucket.
  "Energy Security": "Critical Infrastructure, Energy & Supply Chains",
  "Energy Security & Supply Chains": "Critical Infrastructure, Energy & Supply Chains",
  "Energy Security & Policy": "Critical Infrastructure, Energy & Supply Chains",
  // Environmental security → the health/disaster/environment bucket.
  "Environmental Security": "Public Health, Disaster & Environmental Security",
  // Observed TYPO forms of real list names.
  "Alliances & Multateral Institutions": "Alliances & Multilateral Institutions",
  "Nuclear, WWD & Strategic Deterrence": "Nuclear, WMD & Strategic Deterrence",
  "Intelligence, Esp espionage & Security Services": "Intelligence, Espionage & Security Services",
  "Security, Espionage & Security Services": "Intelligence, Espionage & Security Services",
  "Terrorism, Insinsurgency & Non-State Armed Groups": "Terrorism, Insurgency & Non-State Armed Groups",
  "Terrorism, Insservency & Non-State Armed Groups": "Terrorism, Insurgency & Non-State Armed Groups",
  // Near-miss phrasings for the AI topic (Task #25).
  "Artificial Intelligence": "AI, Machine Learning & Autonomous Systems",
  "AI & Autonomous Systems": "AI, Machine Learning & Autonomous Systems",
  "AI & Machine Learning": "AI, Machine Learning & Autonomous Systems",
  "Artificial Intelligence & Machine Learning": "AI, Machine Learning & Autonomous Systems",
  "AI & Emerging Technology": "AI, Machine Learning & Autonomous Systems",
};
for (const [alias, target] of Object.entries(PRIMARY_TOPIC_ALIASES)) {
  PRIMARY_BY_NORM.set(normKey(alias), target);
}
// The model sometimes writes "and" where the list uses "&" (normKey strips
// punctuation, so "&" and "and" don't collide on their own). Register an
// "and"-spelled variant key for every real topic and alias so those loose
// forms coerce instead of falling to the catch-all. Never overwrites an
// existing key (real list names always win).
for (const t of [...PRIMARY_TOPICS]) {
  const k = normKey(String(t).replace(/&/g, " and "));
  if (!PRIMARY_BY_NORM.has(k)) PRIMARY_BY_NORM.set(k, t);
}
for (const [alias, target] of Object.entries(PRIMARY_TOPIC_ALIASES)) {
  const k = normKey(alias.replace(/&/g, " and "));
  if (!PRIMARY_BY_NORM.has(k)) PRIMARY_BY_NORM.set(k, target);
}

// -----------------------------------------------------------------------------
// Opinion / analysis GENRE categories (the curated free-form `category` field).
// A discrete, structured classification label the ingest/analyzer assigns — NOT
// a free-text body substring match (see curated-opinion-analysis-detection) —
// that marks a piece as commentary/opinion/analysis rather than reported news.
// Used to keep such an item out of the primary/anchor tiers on every curated
// HEADLINE surface (demote to attach-only); it may still corroborate a
// multi-source cluster as a MEMBER. Exact-normalized equality only, so a real
// strategic topic that merely contains one of these words is never mistaken for
// a genre label. Mirrors the opinion URL kinds in shared/contentKind.ts.
// -----------------------------------------------------------------------------
const OPINION_GENRE_CATEGORIES = new Set<string>([
  "opinion",
  "analysis",
  "opinion analysis", // "Opinion / Analysis" normalizes to this
  "op ed",            // "op-ed"
  "editorial",
  "commentary",
  "column",
]);

/**
 * True when a curated `category` is an opinion/analysis GENRE label (exact
 * normalized match), i.e. the classifier itself said the piece is commentary,
 * not reported news. Used by the curated standalone + Top Narratives gates to
 * demote such an item to attach-only when its URL/content_kind didn't already
 * reveal the genre. CURATED-LANE only.
 */
export function isOpinionGenreCategory(category: string | null | undefined): boolean {
  const k = normKey(category);
  if (!k) return false;
  return OPINION_GENRE_CATEGORIES.has(k);
}

const CONFLICT_BY_NORM = new Map<string, ConflictTrack>();
for (const c of CONFLICT_TRACKS) CONFLICT_BY_NORM.set(normKey(c), c);
// Backward-compat: the track formerly named "U.S.-Iran Confrontation" was
// renamed to "U.S.-Iran Conflict". Coerce any lingering old value forward so
// stored rows and human-review input normalize to the current label. ("Red Sea
// Crisis" was retired with no successor → it now coerces to null, off-list.)
CONFLICT_BY_NORM.set(normKey("U.S.-Iran Confrontation"), "U.S.-Iran Conflict");

const SCOPE_BY_NORM = new Map<string, Scope>();
for (const s of SCOPES) SCOPE_BY_NORM.set(normKey(s), s);
// Tolerate the model writing the slash/dash forms loosely.
SCOPE_BY_NORM.set("global", "Global/International");
SCOPE_BY_NORM.set("international", "Global/International");
SCOPE_BY_NORM.set("regional", "Regional");
SCOPE_BY_NORM.set("national", "National/Domestic");
SCOPE_BY_NORM.set("domestic", "National/Domestic");

export function isValidPrimaryTopic(v: string | null | undefined): v is PrimaryTopic {
  if (!v) return false;
  return (PRIMARY_TOPICS as readonly string[]).includes(v) || v === OTHER_EMERGING;
}

/**
 * Coerce a raw model topic to a canonical enum value (exact or case/punctuation-
 * insensitive match). Returns null when the value is genuinely OFF-LIST — the
 * caller then falls back to `Other / Emerging` and may log a proposal.
 */
export function coercePrimaryTopic(raw: string | null | undefined): PrimaryTopic | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (isValidPrimaryTopic(trimmed)) return trimmed;
  return PRIMARY_BY_NORM.get(normKey(trimmed)) ?? null;
}

export function isValidConflictTrack(v: string | null | undefined): v is ConflictTrack {
  if (!v) return false;
  return (CONFLICT_TRACKS as readonly string[]).includes(v);
}

export function coerceConflictTrack(raw: string | null | undefined): ConflictTrack | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || normKey(trimmed) === "none") return null;
  if (isValidConflictTrack(trimmed)) return trimmed;
  return CONFLICT_BY_NORM.get(normKey(trimmed)) ?? null;
}

export function coerceScope(raw: string | null | undefined): Scope | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if ((SCOPES as readonly string[]).includes(trimmed)) return trimmed as Scope;
  return SCOPE_BY_NORM.get(normKey(trimmed)) ?? null;
}

/**
 * Coerce a raw model country_pair to EXACTLY two trimmed, non-empty country
 * names — else null. Strict: anything that isn't a clean 2-element array of
 * distinct non-empty strings is rejected (the Focus then falls back to the
 * conflict-track map / single country / region / Global). Free-form, not enum:
 * any country name is allowed; only the SHAPE is enforced.
 */
export function coerceCountryPair(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const a = typeof raw[0] === "string" ? raw[0].trim() : "";
  const b = typeof raw[1] === "string" ? raw[1].trim() : "";
  if (!a || !b) return null;
  if (normKey(a) === normKey(b)) return null; // not a pair if both are the same
  return [a, b];
}

// =============================================================================
// Region field hygiene (curated_classifications.region).
// =============================================================================
// The analyzer prompt asks for one of these 12 canonical operating environments.
// This list mirrors server/relevanceDefinition.ts — keep the two in lockstep.
export const REGIONS = [
  "Middle East",
  "Europe",
  "Indo-Pacific",
  "Latin America",
  "Africa",
  "Arctic",
  "Red Sea",
  "Persian Gulf",
  "Korean Peninsula",
  "South China Sea",
  "North America",
  "Global",
] as const;
export type Region = (typeof REGIONS)[number];

const REGION_BY_NORM = new Map<string, Region>();
for (const r of REGIONS) REGION_BY_NORM.set(normKey(r), r);

// -----------------------------------------------------------------------------
// REGION ALIASES (Task #25 — Focus canonicalization). Off-list broad labels the
// model actually emits in production ("Asia" 743 rows, "South America",
// "Oceania", "Pacific", etc.) that unambiguously map onto ONE canonical
// operating environment. Same governance as topic aliases: aliases map ONLY to
// existing REGIONS, and a genuinely ambiguous label stays UNALIASED (it coerces
// to null and the read side falls back to country/heuristics — e.g. "Central
// Asia" is derived client-side from the country, and "Antarctica" has no
// canonical theater). Keys are stored through normKey.
// -----------------------------------------------------------------------------
export const REGION_ALIASES: Record<string, Region> = {
  // Asia-family → Indo-Pacific (the canonical theater for the whole region).
  "Asia": "Indo-Pacific",
  "East Asia": "Indo-Pacific",
  "Southeast Asia": "Indo-Pacific",
  "South Asia": "Indo-Pacific",
  "Asia-Pacific": "Indo-Pacific",
  "Asia Pacific": "Indo-Pacific",
  "Pacific": "Indo-Pacific",
  "Western Pacific": "Indo-Pacific",
  "Oceania": "Indo-Pacific",
  "Australia": "Indo-Pacific",
  // Americas.
  "South America": "Latin America",
  "Central America": "Latin America",
  "Caribbean": "Latin America",
  "Americas": "Latin America",
  // Gulf / Red Sea family.
  "Gulf": "Persian Gulf",
  "The Gulf": "Persian Gulf",
  "Arabian Gulf": "Persian Gulf",
  "Gulf of Aden": "Red Sea",
  // Africa sub-regions.
  "North Africa": "Africa",
  "Sub-Saharan Africa": "Africa",
  "West Africa": "Africa",
  "East Africa": "Africa",
  "Horn of Africa": "Africa",
  "Sahel": "Africa",
  // Middle East family.
  "Levant": "Middle East",
  "MENA": "Middle East",
  "Middle East & North Africa": "Middle East",
  "Eastern Mediterranean": "Middle East",
  // Europe family.
  "Eurasia": "Europe",
  "Western Europe": "Europe",
  "Eastern Europe": "Europe",
  "Caucasus": "Europe",
  "South Caucasus": "Europe",
  "Balkans": "Europe",
  "Mediterranean": "Europe",
  "Baltic": "Europe",
  "Baltics": "Europe",
  "Scandinavia": "Europe",
  "Nordic": "Europe",
  // Global family.
  "Worldwide": "Global",
  "International": "Global",
  "World": "Global",
};
for (const [alias, target] of Object.entries(REGION_ALIASES)) {
  REGION_BY_NORM.set(normKey(alias), target);
}

/**
 * Clean a raw model `region` value before it is persisted.
 *
 * STRICT enum gate (Task #25) — the Focus filter fragmented on off-list labels
 * ("Asia" vs "Indo-Pacific"), so an off-list value is now either aliased onto
 * the canonical allowlist (REGION_ALIASES) or dropped to null; it is NEVER
 * persisted as-is. The caller keeps the raw value for audit (proposals log).
 *   1. empty/null              → null
 *   2. canonical/alias match   → canonical spelling (case-insensitive)
 *   3. anything else (incl. the country-duplication corruption class,
 *      region === country) → null
 * Never guesses a replacement region — fail-safe null lets the read side fall
 * back to country/heuristics.
 */
export function coerceRegionField(
  rawRegion: string | null | undefined,
  _rawCountry?: string | null | undefined,
): Region | null {
  if (rawRegion == null) return null;
  const region = String(rawRegion).trim();
  if (!region) return null;
  return REGION_BY_NORM.get(normKey(region)) ?? null;
}

// =============================================================================
// conflict_track keyword inference (high-precision; from a headline/title).
// Order matters — most specific party-pairing first.
// =============================================================================
export function inferConflictTrack(...texts: (string | null | undefined)[]): ConflictTrack | null {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (!t) return null;
  const has = (re: RegExp) => re.test(t);
  const israel = has(/\bisrael(i|is)?\b|\bidf\b|\bnetanyahu\b|\bjerusalem\b|\btel aviv\b/);
  const iran = has(/\biran(ian)?\b|\btehran\b|\bkhamenei\b|\birgc\b/);
  const us = has(/\bu\.?s\.?\b|\bunited states\b|\bamerican?\b|\bwashington\b|\bpentagon\b|\bcentcom\b/);

  if (has(/\bhezbollah\b/) || (israel && has(/\blebanon|\bbeirut/))) return "Israel-Hezbollah / Lebanon";
  if (has(/\bgaza\b|\bhamas\b|\brafah\b|\bkhan younis\b/)) return "Israel-Hamas / Gaza";
  // Tri-party first (most specific): U.S. + Iran + Israel together.
  if (israel && iran && us) return "U.S.-Iran-Israel Conflict";
  if (israel && iran) return "Israel-Iran Conflict";
  if (has(/\bukrain(e|ian)\b|\bkyiv\b|\bkharkiv\b|\bzaporizh|\bzelensky\b|\bdonbas\b/)) return "Russia-Ukraine War";
  if (iran && us) {
    return "U.S.-Iran Conflict";
  }
  return null;
}

// =============================================================================
// primary_topic keyword inference (high-precision, from a headline/title).
//
// READ-TIME DISPLAY FALLBACK ONLY (curated lane). The sibling of
// `inferConflictTrack`: it exists solely to fill the curated card's Topic slot
// for a freshly-ingested row BEFORE the async classifier has written a stored
// primary_topic — so a brand-new story shows a sensible Topic (e.g. "Military
// Ops") instead of a bare "—" that would otherwise self-heal only minutes later.
// It is NEVER an admission, ranking, clustering, or persistence input, and is
// always the LAST link in the Topic fallback chain: any stored / voted
// classification wins and overwrites this guess on the next read.
//
// Conservative by design: returns null (keeping the neutral "—") whenever no
// rule fires with confidence, so showing nothing is preferred over showing a
// wrong label. Returns ONLY a real controlled-vocabulary topic — never
// `Other / Emerging`, and never a conflict_track (which informs the Focus slot,
// never the Topic slot). Order = most specific / least ambiguous first.
// =============================================================================
function inferPrimaryTopicWithOptions(
  includeDisplayOnlyRescue: boolean,
  ...texts: (string | null | undefined)[]
): RealPrimaryTopic | null {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (!t) return null;
  const has = (re: RegExp) => re.test(t);

  // 1) Nuclear / WMD / strategic deterrence — unambiguous strategic-weapons terms.
  if (has(/\bnuclear\b|\buranium\b|\benrich(ment|ed|ing)?\b|\bwarheads?\b|\bicbm\b|\bwmd\b|\bchemical weapons?\b|\bbiological weapons?\b/))
    return "Nuclear, WMD & Strategic Deterrence";

  // 2) Cyber / space / emerging technology.
  if (has(/\bcyber-?attacks?\b|\bransomware\b|\bmalware\b|\bdata breach\b|\bhack(ed|ing|ers?)\b|\bsatellites?\b|\bspace force\b/))
    return "Cyber, Space & Emerging Technology";

  // 2a) AI / machine learning / autonomous systems (Task #25). Conservative,
  //     unambiguous AI terms only — deliberately NO "drone"/"autonomous weapon"
  //     keys, so defense-specific capability stories keep routing to the
  //     Weapons/Defense-Industry and Military-Ops rules (the defense-industry
  //     carve-out lives in the prompt for the AI generator).
  if (has(/\bartificial intelligence\b|\bmachine learning\b|\bgenerative ai\b|\blarge language models?\b|\bllms?\b|\bopenai\b|\banthropic\b|\bchatgpt\b|\bdeepseek\b|\bai (model|models|chatbots?|race|arms race|regulation|safety|labs?|startups?|boom|chips?)\b|\bself-driving\b|\bautonomous (vehicles?|robots?|systems?)\b/))
    return "AI, Machine Learning & Autonomous Systems";

  // 2b) Intelligence / espionage. Keep this to unmistakable service/operation
  //     language so a generic "secret" or "probe" cannot hijack another topic.
  if (includeDisplayOnlyRescue && has(/\b(cia|central intelligence agency|mi6|mossad)\b[^.;:]{0,60}\b(task force|operation|unit|mission)\b|\b(counterintelligence operation|espionage (operation|campaign|network|ring)|spy ring|intelligence operation|covert operation)\b/))
    return "Intelligence, Espionage & Security Services";

  // 2c) Weapons / procurement / readiness. These are concrete defense-material
  //     signals exposed by classifier outages; bare "military" is intentionally
  //     insufficient because it would swallow operational reporting.
  if (includeDisplayOnlyRescue && has(/\bmunitions? stockpiles?\b|\bweapons? stockpiles?\b|\bdefen[cs]e contracts?\b|\bweapons? procurement\b|\bmilitary readiness\b/))
    return "Weapons, Procurement & Defense Industry";

  // 3) Economic statecraft / sanctions.
  if (has(/\bsanctions?\b|\bembargo\b|\basset freeze\b|\bexport controls?\b/))
    return "Economic Statecraft & Sanctions";

  // 4) Terrorism / non-state armed groups — plot/attack framing. State-vs-state
  //    fighting routes to Military Ops below; named conflict groups (Hamas,
  //    Hezbollah) are intentionally NOT keyed here so they stay armed-conflict.
  //    Expanded (Task #995): militants/insurgents/jihadists and the Sahel theater
  //    (dominated by JNIM/ISIS-WA operations) are common defense-news surfaces
  //    that previously fell to Other/Emerging.
  //    Expanded (terror-attack routing): the words real terror-attack headlines
  //    actually use — bare "terror" (attack/plot/threat/cell compounds and the
  //    standalone word), "Islamist(s)", and vehicle-ramming forms
  //    (van/car/truck/vehicle(-)ramming, "ramming attack", "rams into crowd").
  //    Precision guards: bare "terror" excludes the "war on terror" policy
  //    idiom (lookbehind) so counterterrorism-policy commentary doesn't
  //    misroute; bare "attack" is deliberately NOT keyed. This rule runs
  //    BEFORE Military Ops so keep every term unambiguous.
  if (has(/\bterroris(m|t|ts)\b|(?<!war on )\bterror\b|\bislamists?\b|\b(van|car|truck|vehicle)[- ]ramming\b|\bramming attacks?\b|\brams? into (a )?(crowd|pedestrians|parade)\b|\bisis\b|\bislamic state\b|\bal[- ]?qaeda\b|\bal[- ]?shabaab\b|\bboko haram\b|\bsuicide bomb|\bmilitants?\b|\binsurgents?\b|\bjihadis(m|t|ts)?\b|\bjihad\b|\bjnim\b|\bsahel\b/))
    return "Terrorism, Insurgency & Non-State Armed Groups";

  // 5) Law, courts, and institutional norms. Unmistakable court surfaces are
  // sufficient on their own. Agency/prosecutor/subpoena language is intentionally
  // narrower: it must describe a U.S. institutional action affecting journalism
  // or reporting. Otherwise those broad words can hijack kinetic headlines such
  // as "Prosecutors say an Iranian airstrike killed civilians."
  if (
    has(/\b(supreme court|scotus|federal court|court ruling|court order|lawsuit|international criminal court|\bicc\b|war crimes tribunal)\b/) ||
    (includeDisplayOnlyRescue && has(/\b(congressional|senate|house) (committee )?(votes? to )?hold(s|ing)? [^.;:]{0,80}\bin contempt\b|\bcongressional contempt\b/)) ||
    isUsPressLegalProcess(t)
  )
    return "Law, Courts & International Norms";

  // 6) Diplomacy — talks / negotiation / ceasefire framing.
  //    Bare "talks", "accord", and "agreement" now require a diplomatic qualifier
  //    so energy headlines like "LNG supply agreement", "natural gas supply
  //    talks", "pipeline accord" cannot misroute here before falling through to
  //    the Infrastructure rule (7c). Qualifiers must be explicitly diplomatic
  //    (peace, ceasefire, security, hostage, bilateral, etc.). "negotiations" and
  //    "summit" remain unqualified because they are unambiguously diplomatic.
  if (has(/\bsummit\b|\bnegotiat(e|es|ed|ing|ions?)\b|\bcease-?fire\b|\bceasefire\b|\bpeace (talks|deal|plan|agreement|process)\b|\bdiploma(t|ts|tic|cy)\b|\benvoy\b|\bambassador\b|\bbilateral (talks|meeting|summit)\b|\b(diplomatic|multilateral|ceasefire|cease-?fire|normalization|hostage|prisoner|armistice|mediation|reconciliation|security|high-?level|direct) talks\b|\b(diplomatic|bilateral|ceasefire|cease-?fire|normalization|hostage|prisoner|armistice|security) accord\b|\b(diplomatic|bilateral|ceasefire|cease-?fire|normalization|hostage|prisoner|armistice|security) agreement\b/))
    return "Foreign Policy & Diplomacy";

  // 7) Force posture / deployments / buildup.
  if (has(/\bdeploy(s|ed|ment|ments|ing)?\b|\btroop buildup\b|\bmilitary buildup\b|\breinforce(ment|ments|s|d)?\b|\bmobiliz(e|es|ed|ing|ation)\b|\bcarrier (group|strike group)\b/))
    return "Force Posture & Deployments";

  // 8) Active military operations / armed conflict — the dominant defense bucket.
  if (has(/\bstrikes?\b|\bair-?strikes?\b|\bair raids?\b|\bmissile (attack|strike|barrage)|\bdrone (attack|strike)|\bshell(ed|ing)\b|\bbombard(ed|ment|ing)?\b|\boffensive\b|\binvasions?\b|\bincursions?\b|\bground operation\b|\bcaptur(e|es|ed|ing)\b|\bseiz(e|es|ed|ing|ure)\b|\bclash(es|ed)?\b|\bfighting\b|\bcombat\b|\bfront-?lines?\b|\btroops\b|\bmilitary (operation|operations|site|sites|base|target|targets|infrastructure)\b|\bkilled in (a |an )?(strike|attack|raid)/))
    return "Military Operations & Armed Conflict";

  // 8b) Maritime security / chokepoints — named straits & shipping chokepoints,
  //     escort/transit/closure framing, and freedom-of-navigation. Runs AFTER the
  //     kinetic buckets above so an actual strike/clash AT a strait stays Military
  //     Ops, but a closure/transit/escort story routes here. Placed BEFORE the
  //     energy rule (7c) so a "Hormuz oil flow" story reads as the chokepoint
  //     (the strategically dominant frame for these waterways).
  //     "tanker" requires a marine-cargo qualifier so an aerial-refueling
  //     "tanker"/KC-46 story is NOT read as maritime.
  //     Generic "waterway" and compound "canal <noun>" forms added so Panama
  //     Canal, Kiel Canal, Bosporus, Dardanelles, Gibraltar, Danish Straits,
  //     English Channel, and similar named chokepoints reliably route here
  //     without depending solely on AI classification.
  if (has(/\bhormuz\b|\bstraits?\b|\bchoke-?points?\b|\b(shipping|sea) lanes?\b|\bfreedom of navigation\b|\b(oil|lng|crude|cargo|chemical|super)\s?tankers?\b|\bbab[- ]?el[- ]?mandeb\b|\bsuez canal\b|\bmalacca\b|\bsouth china sea\b|\bred sea\b|\bpanama canal\b|\bkiel canal\b|\bbosporus\b|\bdardanelles\b|\bgibraltar\b|\bdanish straits?\b|\benglish channel\b|\btaiwan strait\b|\bwaterways?\b|\bcanal (transit|closure|toll|fees?|traffic|access|control|rights?|zone|passage|draft|shipping)\b/))
    return "Maritime Security & Chokepoints";

  // 8c) Critical infrastructure / energy / supply chains — PHYSICAL energy &
  //     supply flows (oil/gas/fuel supply, output & exports; pipelines;
  //     refineries; the power grid; supply chains). Also covers critical
  //     minerals / rare earths and the most strategically named minerals
  //     (lithium, cobalt, gallium, germanium) — these are strategic-resource
  //     stories, not bare market prices, so they belong here rather than in
  //     the markets bucket. Deliberately NOT bare market prices, which are a
  //     markets story, not infrastructure (so bare "crude oil prices"
  //     deliberately does NOT match here).
  if (has(/\b(oil|crude|gas|energy|fuel) (flow|flows|supply|supplies|output|exports?|shipments?|infrastructure|security)\b|\bpipelines?\b|\brefiner(y|ies)\b|\b(power|electricity) grid\b|\bpower (plant|station)s?\b|\bnatural gas\b|\blng\b|\bsupply chains?\b|\bcritical minerals?\b|\brare earths?\b|\bstrategic minerals?\b|\blithium\b|\bcobalt\b|\bgallium\b|\bgermanium\b|\bniobium\b|\bneodymium\b/))
    return "Critical Infrastructure, Energy & Supply Chains";

  // 8d) Public health / natural disaster / severe weather / environmental
  //     security. Runs AFTER all the kinetic buckets above so a strike/attack AT
  //     a hospital or in a flood-hit zone stays Military Ops, but a pure
  //     health/disaster story routes here instead of flashing "—" / catch-all.
  //     Conservative: named diseases + pandemic/epidemic (NOT bare "outbreak",
  //     which is often "outbreak of violence"); plural/qualified flood forms
  //     (NOT bare "flood", which is often "flood of migrants").
  if (has(/\bpandemics?\b|\bepidemics?\b|\binfectious diseases?\b|\bdisease outbreaks?\b|\bvaccin(e|es|ation|ations)\b|\bquarantines?\b|\bcholera\b|\bebola\b|\bmpox\b|\bmonkeypox\b|\b(avian|bird|swine) flu\b|\bh5n1\b|\bcovid(-19)?\b|\bcoronavirus\b|\bmeasles\b|\bpolio\b|\bpublic health emergenc(y|ies)\b/))
    return "Public Health, Disaster & Environmental Security";
  if (has(/\bearthquakes?\b|\btsunamis?\b|\bvolcan(o|oes|ic eruptions?)\b|\bwildfires?\b|\bbushfires?\b|\bhurricanes?\b|\btyphoons?\b|\bcyclones?\b|\bheat-?waves?\b|\bdroughts?\b|\bfloods\b|\bflooding\b|\bfloodwaters?\b|\bflash floods?\b|\bmudslides?\b|\blandslides?\b|\bblizzards?\b|\bsevere weather\b|\bclimate change\b|\bglobal warming\b/))
    return "Public Health, Disaster & Environmental Security";

  // 8e) Border / homeland security. Require explicit immigration-enforcement
  //     language; bare "immigrant" or "migrant" is too broad for this fallback.
  if (includeDisplayOnlyRescue && has(/\billegal immigrants?\b|\bundocumented immigrants?\b|\bimmigration detention\b|\bdetained (migrants?|immigrants?)\b|\bdeport(ation|ations|ed|ing)?\b|\bborder security\b|\basylum seekers?\b/))
    return "Border, Homeland & Internal Security";

  // 8f) Governance / domestic stability. These are direct institutional-stability
  //     formulations, not generic criticism of a government or its economy.
  if (includeDisplayOnlyRescue && has(/\b(regime|government|coalition)(?:['’]s)? (?:economy )?(?:is |nears? |at |on the brink of )?(?:economic )?(collapse|breaking point)\b|\bconstitutional crisis\b|\bmilitary coup\b|\bcoup d['’]?état\b/))
    return "Governance, Elections & Domestic Stability";

  // 8g) Public-health outbreak names that do not contain the generic disease
  //     words above but are unambiguous when used in a headline.
  if (includeDisplayOnlyRescue && has(/\bsalmonella\b|\bcyclospora\b/))
    return "Public Health, Disaster & Environmental Security";

  // 8) Final lean: a recognized active-conflict theater with no other signal is,
  //    by definition, armed conflict.
  if (inferConflictTrack(t)) return "Military Operations & Armed Conflict";

  return null;
}

/**
 * Conservative read-time fallback for temporarily missing Curated overlays.
 * The caller may render this label, but must not persist it or use it for
 * ranking, clustering, or the generate-once classification lock.
 */
export function inferPrimaryTopic(...texts: (string | null | undefined)[]): RealPrimaryTopic | null {
  return inferPrimaryTopicWithOptions(true, ...texts);
}

/**
 * Legacy classifier post-check for an AI-produced Other/Emerging label.
 * It deliberately excludes read-time outage-rescue families so newly inferred
 * display labels cannot enter curated_classifications.
 */
export function inferPersistablePrimaryTopic(...texts: (string | null | undefined)[]): RealPrimaryTopic | null {
  return inferPrimaryTopicWithOptions(false, ...texts);
}

// =============================================================================
// FOCUS (geography) keyword inference — high-precision, from a headline/title.
//
// READ-TIME DISPLAY FALLBACK ONLY (curated lane). The sibling of
// `inferConflictTrack` / `inferPrimaryTopic`: it fills the curated card's FOCUS
// slot for a row that carries NO server-classified geography (no countryPair /
// conflictTrack / country / region — i.e. the overlay hasn't classified it yet).
// Returns a real, CONTENT-derived focus label (a country, a broad region, or a
// first-class "United States" domestic label) or null when nothing fires.
//
// FOREIGN signals are tested FIRST so a U.S.-actor-abroad story (e.g. "Trump
// threatens Iran", "Pentagon strikes Houthis") resolves to the FOREIGN theater,
// and the U.S./domestic path is the LAST positive rule before null — it only
// fires when the story names no foreign geography at all. Returns FULL names
// ("United States"); the display layer abbreviates (→ "U.S."). Geography reflects
// the ARTICLE CONTENT, never the outlet's origin.
//
// CURATED-LANE display only — never an admission, ranking, clustering, or
// persistence input; any stored / classified geography always wins over this.
// =============================================================================
const FOCUS_KEYWORDS: { label: string; re: RegExp }[] = [
  { label: "Venezuela", re: /\bvenezuela(n)?\b|\bmaduro\b|\bcaracas\b/ },
  { label: "Greenland", re: /\bgreenland\b|\bnuuk\b/ },
  { label: "Iran", re: /\biran(ian)?\b|\btehran\b|\bkhamenei\b|\birgc\b/ },
  { label: "Israel", re: /\bisrael(i)?\b|\bgaza\b|\bnetanyahu\b|\bidf\b|\bhamas\b|\bhezbollah\b|\bjerusalem\b|\btel aviv\b/ },
  { label: "Russia / Ukraine", re: /\brussia(n)?\b|\bukrain(e|ian)\b|\bputin\b|\bzelensky\b|\bmoscow\b|\bkyiv\b|\bkremlin\b/ },
  { label: "China", re: /\bchina\b|\bchinese\b|\bbeijing\b|\btaiwan\b|\bxi jinping\b|\bpla\b|\bindo-pacific\b|\bsouth china sea\b/ },
  { label: "North Korea", re: /\bnorth korea(n)?\b|\bpyongyang\b|\bkim jong[- ]?un\b/ },
  { label: "India", re: /\bindia(n)?\b|\bnew delhi\b|\bmodi\b/ },
  { label: "Mexico / South America", re: /\bmexico\b|\bmexican\b|\bbrazil\b|\bcolombia\b|\bargentina\b|\bcartel\b|\bsouth america\b|\blatin america\b/ },
  { label: "Africa", re: /\bafrica(n)?\b|\bsahel\b|\bnigeria\b|\bsudan\b|\bsomalia\b|\bethiopia\b|\blibya\b/ },
  { label: "Arctic", re: /\barctic\b|\bnorth pole\b/ },
  { label: "Middle East", re: /\bmiddle east\b|\bsaudi\b|\bsyria\b|\biraq\b|\byemen\b|\bqatar\b|\bhouthi\b|\blebanon\b|\bgulf\b/ },
  { label: "Europe", re: /\beurope(an)?\b|\bnato\b|\bgermany\b|\bfrance\b|\bbritain\b|\bbritish\b|\bpoland\b|\bbrussels\b/ },
];

// U.S. / domestic detector — runs ONLY after every foreign signal above. Catches
// the common domestic surfaces (the three federal branches, the major federal
// agencies, domestic politics, and core domestic-security terms) that previously
// fell through the thin keyword list to the alarming "Global" focus. Conservative
// on intentionally-ambiguous tokens (no bare "ice"/"sec"/"trump"/state names) so
// a foreign-actor story is never mis-tagged U.S.
const US_DOMESTIC_RE = /\b(white house|oval office|supreme court|scotus|congress(ional)?|capitol hill|capitol|the senate|senators?|house republicans?|house democrats?|house gop|federal reserve|the fed\b|pentagon|justice department|\bdoj\b|\bfbi\b|\bdhs\b|\bnsa\b|\birs\b|\bcdc\b|\bfda\b|homeland security|national guard|federal (government|agenc(?:y|ies)|workers?|employees?|workforce|bureaucracy|courts?|judges?|prosecutors?|funding|budget|shutdown|reserve)|government shutdown|impeach(?:ment|ed)?|electoral college|state of the union|trump administration|biden administration|u\.?s\.? (?:senate|house|congress|capitol|government|military|troops|forces))\b/;
// A U.S. institutional/legal action can mention a foreign country solely as the
// subject of reporting or evidence. In that narrow case the domestic institution
// is the area of impact; do not let the first country word hijack Focus. Require
// a reporting/press-process signal as well as legal action: a DOJ prosecution of
// a foreign operative is not domestic merely because DOJ appears in the title.
// This preserves foreign-first behavior for genuine U.S. action abroad.
const US_INSTITUTIONAL_IMPACT_RE = /\b(subpoena|subpoenas|subpoenaed|subpoenaing|court (?:order|ruling|case)|lawsuit|legal action|justice department|\bdoj\b|prosecutors?|press freedom)\b/;
const US_PRESS_PROCESS_RE = /\b(press|journalis(?:m|ts?)|reporters?|freelancers?|news (?:story|report|article)|reporting|coverage|new york times|washington post)\b/;

function isUsPressLegalProcess(text: string): boolean {
  return US_DOMESTIC_RE.test(text) &&
    US_INSTITUTIONAL_IMPACT_RE.test(text) &&
    US_PRESS_PROCESS_RE.test(text);
}

export function inferFocus(...texts: (string | null | undefined)[]): string | null {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (!t) return null;
  if (isUsPressLegalProcess(t)) {
    return "United States";
  }
  for (const { label, re } of FOCUS_KEYWORDS) {
    if (re.test(t)) return label;
  }
  if (US_DOMESTIC_RE.test(t)) return "United States";
  return null;
}

// =============================================================================
// Narrow-label -> primary_topic remap table. Drives BOTH the going-forward
// fallback (when an OLD free-form label survives on a row) AND the one-time
// historical remap. Keyed by normalized label.
// =============================================================================
interface RemapEntry {
  topic: PrimaryTopic;
  conflictTrack?: ConflictTrack;
}

function buildRemap(): Map<string, RemapEntry> {
  const m = new Map<string, RemapEntry>();
  const add = (labels: string[], entry: RemapEntry) => {
    for (const l of labels) m.set(normKey(l), entry);
  };
  add(["US-Iran Relations", "Iran-US Relations", "U.S.-Iran Relations", "US-Iran Agreement"],
    { topic: "Foreign Policy & Diplomacy", conflictTrack: "U.S.-Iran Conflict" });
  add(["US-Iran Military Action", "US-Iran Conflict", "Iran Military Operations"],
    { topic: "Military Operations & Armed Conflict", conflictTrack: "U.S.-Iran Conflict" });
  add(["Ukraine Battlefield", "Ukraine Conflict", "Ukraine Military Operations"],
    { topic: "Military Operations & Armed Conflict", conflictTrack: "Russia-Ukraine War" });
  add(["Ukraine Diplomacy", "Russia-Ukraine Relations"],
    { topic: "Foreign Policy & Diplomacy", conflictTrack: "Russia-Ukraine War" });
  add(["Iran Nuclear Program", "Iran Nuclear Deal", "Iran Nuclear Agreement", "Nuclear Policy"],
    { topic: "Nuclear, WMD & Strategic Deterrence" });
  add(["Iran-Israel Conflict", "Israel-Iran Conflict", "Iran-Israel Tensions"],
    { topic: "Military Operations & Armed Conflict", conflictTrack: "Israel-Iran Conflict" });
  add(["Israel-Lebanon", "Israel-Hezbollah", "Lebanon Conflict"],
    { topic: "Military Operations & Armed Conflict", conflictTrack: "Israel-Hezbollah / Lebanon" });
  add(["Gaza Conflict", "Israeli-Palestinian Conflict"],
    { topic: "Military Operations & Armed Conflict", conflictTrack: "Israel-Hamas / Gaza" });
  add(["Maritime Security", "Strait of Hormuz", "Panama Canal", "Canal Transit",
    "Waterway Security", "Bosporus", "Dardanelles", "Kiel Canal", "English Channel",
    "Taiwan Strait", "Strait of Gibraltar", "Danish Straits", "Chokepoint Security"],
    { topic: "Maritime Security & Chokepoints" });
  add(["Defense Procurement", "Defense Technology"],
    { topic: "Weapons, Procurement & Defense Industry" });
  add(["Military Technology", "Space Industry", "Space Technology", "Space Tech", "Cyber Espionage", "Cybersecurity"],
    { topic: "Cyber, Space & Emerging Technology" });
  // Task #25 — AI/ML/autonomy labels route to the dedicated AI topic (was
  // Cyber, Space & Emerging Technology). Defense-specific programs stay in
  // Weapons, Procurement & Defense Industry via their own labels.
  add(["AI Technology", "Artificial Intelligence", "Machine Learning", "AI Policy",
    "AI Regulation", "AI Safety", "AI Race", "AI Development", "Autonomous Systems",
    "Autonomous Vehicles", "Generative AI"],
    { topic: "AI, Machine Learning & Autonomous Systems" });
  add(["Sanctions Diplomacy", "Economic Diplomacy"],
    { topic: "Economic Statecraft & Sanctions" });
  add(["Economic Policy", "Trade Policy", "Russian Economy"],
    { topic: "Global Markets & Strategic Economics" });
  add(["Energy Security", "Energy Policy", "Critical Minerals", "Rare Earth Minerals",
    "Rare Earth Elements", "Strategic Minerals", "Lithium Supply", "Cobalt Supply",
    "Mineral Supply Chain", "Rare Earth Supply"],
    { topic: "Critical Infrastructure, Energy & Supply Chains" });
  add(["Domestic Politics", "US Politics", "Indian Politics", "Israeli Politics", "Election Integrity"],
    { topic: "Governance, Elections & Domestic Stability" });
  add(["Immigration Policy", "Border Security", "Migration Policy", "Visa Policy"],
    { topic: "Border, Homeland & Internal Security" });
  add(["Counterterrorism", "Domestic Terrorism", "Transnational Crime", "Drug Trafficking"],
    { topic: "Terrorism, Insurgency & Non-State Armed Groups" });
  add(["Information Environment", "Information Warfare", "Press Freedom", "Political Commentary"],
    { topic: "Information Environment & Influence" });
  add(["Natural Disaster", "Public Health", "Climate Change",
    // Task #408 — disaster/health/environmental free-form labels that were
    // landing on the catch-all. All map to the existing real bucket.
    "Natural Disasters", "Disaster Response", "Disaster Relief",
    "Emergency Response", "Weather Alert", "Severe Weather", "Extreme Weather",
    "Wildfire", "Wildfires", "Bushfire", "Earthquake", "Flooding", "Floods",
    "Drought", "Hurricane", "Typhoon", "Cyclone", "Heatwave", "Volcanic Eruption",
    "Public Health Emergency", "Health Policy", "Health Crisis", "Healthcare",
    "Epidemic", "Pandemic", "Disease Outbreak", "Infectious Disease",
    "Climate Security", "Climate Policy", "Environmental Security",
    "Environmental Policy", "Environment"],
    { topic: "Public Health, Disaster & Environmental Security" });
  add(["Humanitarian Crisis", "Civilian Harm", "Displacement"],
    { topic: "Humanitarian, Civilian Harm & Displacement" });
  add(["G7 Summit", "G7 Diplomacy", "NATO Force Posture"],
    { topic: "Alliances & Multilateral Institutions" });
  add(["Human Rights"],
    { topic: "Law, Courts & International Norms" });
  // ---------------------------------------------------------------------------
  // Task #336 follow-up — high-frequency catch-all backlog patterns. These were
  // the dominant free-form labels still falling to `Other / Emerging` after the
  // first remap pass. Deterministic, curated-lane-only, fully reversible (the
  // original label is retained in legacy_category). Mapping choices: a "buildup"
  // is fundamentally about force posture/accumulation, so the missile/military
  // buildup family routes to Force Posture (NOT Nuclear & WMD, reserved for
  // explicit nuclear/WMD labels).
  // ---------------------------------------------------------------------------
  add(["Adversary Missile Buildup", "Missile Buildup", "Adversary Military Buildup",
       "Military Buildup", "Missile Threats", "Missile Program", "Military Modernization",
       "Arms Buildup"],
    { topic: "Force Posture & Deployments" });
  add(["Military Operations", "Military Incident", "Military Action", "Combat Operations",
       "Iran Conflict", "Middle East Conflict", "Regional Conflict"],
    { topic: "Military Operations & Armed Conflict" });
  add(["Iran-Israel Relations", "Israel-Iran Relations"],
    { topic: "Foreign Policy & Diplomacy", conflictTrack: "Israel-Iran Conflict" });
  add(["Israel-Lebanon Conflict"],
    { topic: "Military Operations & Armed Conflict", conflictTrack: "Israel-Hezbollah / Lebanon" });
  add(["US Foreign Policy", "Foreign Policy", "Diplomatic Relations", "Bilateral Relations"],
    { topic: "Foreign Policy & Diplomacy" });
  add(["Domestic Security", "Homeland Security", "Internal Security", "Public Safety"],
    { topic: "Border, Homeland & Internal Security" });
  add(["US Immigration Policy", "Immigration Enforcement", "Asylum Policy", "Refugee Policy"],
    { topic: "Border, Homeland & Internal Security" });
  add(["Domestic Unrest", "Civil Unrest", "Political Instability", "Domestic Policy",
       "Government Shutdown", "Legislation"],
    { topic: "Governance, Elections & Domestic Stability" });
  add(["Counterterrorism Operations", "Terrorism Threat", "Insurgency", "Militancy"],
    { topic: "Terrorism, Insurgency & Non-State Armed Groups" });
  add(["Legal Proceedings", "Court Ruling", "Litigation", "Criminal Charges", "Indictment",
       "War Crimes"],
    { topic: "Law, Courts & International Norms" });
  add(["Trade Relations", "Economic Impact", "Economic Developments", "Market Impact"],
    { topic: "Global Markets & Strategic Economics" });
  return m;
}

const NARROW_LABEL_MAP = buildRemap();

// -----------------------------------------------------------------------------
// SUFFIX patterns — a deterministic fallback that runs ONLY after an exact-map
// miss AND an already-valid-enum miss, strictly BEFORE the catch-all. It can
// therefore only ever rescue a row that would otherwise be `Other / Emerging`;
// it never changes the bucket of an already-matched row. This collapses the
// long tail of "<A>-<B> relations", "<X> politics", and "<X> diplomacy" labels
// (china-north korea relations, armenia politics, sports diplomacy, ...) without
// enumerating every country pair. Exact rules above still win (e.g. "Trade
// Relations" -> Strategic Markets overrides the generic relations -> Diplomacy).
// Keyed on the normalized (lowercased, space-separated) label.
// -----------------------------------------------------------------------------
const SUFFIX_REMAP: { test: RegExp; topic: PrimaryTopic }[] = [
  { test: /\brelations$/, topic: "Foreign Policy & Diplomacy" },
  { test: /\bdiplomacy$/, topic: "Foreign Policy & Diplomacy" },
  { test: /\bpolitics$/, topic: "Governance, Elections & Domestic Stability" },
];

function matchSuffixRemap(norm: string): PrimaryTopic | null {
  for (const p of SUFFIX_REMAP) if (p.test.test(norm)) return p.topic;
  return null;
}

export interface RemapResult {
  primaryTopic: PrimaryTopic;
  conflictTrack: ConflictTrack | null;
  // true when a real rule (mapping table OR an already-valid enum value) matched;
  // false when the label fell through to the `Other / Emerging` catch-all.
  matched: boolean;
}

/**
 * Deterministically remap an OLD free-form label to the new vocabulary. Used by
 * the going-forward fallback and the one-time historical remap. Order:
 *   1) mapping table (most specific; may also fix the conflict_track)
 *   2) the label is ALREADY a valid enum value
 *   3) catch-all `Other / Emerging`
 * The conflict_track is taken from the matched rule, else inferred from the
 * label + optional title text (never invented off-list).
 */
export function remapLegacyCategory(
  category: string | null | undefined,
  ...titleText: (string | null | undefined)[]
): RemapResult {
  const inferred = inferConflictTrack(category, ...titleText);
  const mapped = NARROW_LABEL_MAP.get(normKey(category));
  if (mapped) {
    return {
      primaryTopic: mapped.topic,
      conflictTrack: mapped.conflictTrack ?? inferred,
      matched: true,
    };
  }
  const already = coercePrimaryTopic(category);
  if (already && already !== OTHER_EMERGING) {
    return { primaryTopic: already, conflictTrack: inferred, matched: true };
  }
  const suffix = matchSuffixRemap(normKey(category));
  if (suffix) {
    return { primaryTopic: suffix, conflictTrack: inferred, matched: true };
  }
  return { primaryTopic: OTHER_EMERGING, conflictTrack: inferred, matched: false };
}

// =============================================================================
// Deterministic source_kind from lane/table + content_kind + registry identity.
// =============================================================================
export function deriveSourceKind(opts: {
  itemType: string | null | undefined; // 'scraped' | 'manual' | 'curated' | 'main'
  contentKind?: string | null;         // 'video' | 'opinion' | 'audio' | null
  sourceIdentifier?: string | null;    // registry source identifier
  otherSourceType?: string | null;     // registry "other" refinement
}): SourceKind {
  const ck = (opts.contentKind || "").toLowerCase();
  const ost = (opts.otherSourceType || "").toLowerCase();
  const sid = (opts.sourceIdentifier || "").toLowerCase();
  if (ck === "audio" || ost === "podcast") return "Podcast";
  if (ck === "video" || ost === "video") return "Video";
  if (ck === "opinion" || ost === "opinion") return "Opinion / Analysis";
  if (sid.startsWith("release-")) return "Official Statement";
  if (sid.startsWith("social-") || ost === "social") return "Social / OSINT";
  if (opts.itemType === "manual") return "Manual Submission";
  return "Wire / Reported";
}

/**
 * Deterministic scope fallback used by the historical remap (and as a backstop
 * when the model omits scope). Prefer the model's own scope when present.
 */
export function deriveScope(opts: {
  topicCountry?: string | null;
  region?: string | null;
}): Scope {
  if (opts.topicCountry && opts.topicCountry.trim()) return "National/Domestic";
  if (opts.region && opts.region.trim()) return "Regional";
  return "Global/International";
}
