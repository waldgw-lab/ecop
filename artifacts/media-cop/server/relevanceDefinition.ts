// =============================================================================
// SHARED DEFENSE-RELEVANCE DEFINITIONS (single source of truth)
// =============================================================================
// This module is the ONE canonical home for the "is this defense-relevant?"
// prompts that used to be copy-pasted across the Layer-2 analyzer and every
// news bot. There are exactly two distinct definitions:
//
//   1. ANALYZER_SYSTEM_PROMPT  — the rich tag + priority_score + is_relevant
//      rubric used by server/aiAnalyzer.ts. This drives the scraper -> headlines
//      -> getPrimaryFeed pathway that powers the Classic and Visual (Stream)
//      views, so it MUST remain byte-identical to its previous inline value.
//
//   2. BOT_CJCS_SYSTEM_PROMPT  — the simpler RELEVANT / NOT-RELEVANT screen used
//      by the news bots (Drudge/BBC/Fox/ABC/CBS/NBC/AP/Reuters/RSS) when they
//      decide which articles to post to Team chat. This was duplicated verbatim
//      across all 9 bots; it now lives here once.
//
// Both strings are reproduced verbatim from their original locations. Do NOT
// "tune" them as part of a refactor — any change to ANALYZER_SYSTEM_PROMPT in
// particular can shift Classic/Visual output.
//
// STRATEGIC_TAGS and PRIORITY_BANDS are exported for reference / observability
// only. They are derived documentation of what ANALYZER_SYSTEM_PROMPT already
// encodes inline; they are intentionally NOT used to (re)build the prompt, so
// the prompt text stays frozen.
// =============================================================================

import { PRIMARY_TOPICS, OTHER_EMERGING, CONFLICT_TRACKS } from "@shared/classificationVocab";

/**
 * Prompt-only importance calibration shared by the main and Curated analyzers.
 *
 * This deliberately changes neither relevance nor any deterministic scoring,
 * ranking, override, or admission path. Removing the interpolation from all
 * analyzer prompts restores the previous behavior.
 */
export const LOCAL_CONFLICT_IMPORTANCE_CALIBRATION =
  "A local, domestic, routine-continuation, or incremental conflict story may remain relevant, but keep it below HIGH importance unless the headline itself reports a material new consequence: direct U.S. or allied consequence, cross-border escalation, force-posture change, concrete diplomatic or sanctions action, strategic-infrastructure impact, major civilian harm, or a genuinely new conflict phase. Apply this by consequence and novelty only—never by country, publisher, outlet geography, or outlet role.";

// =============================================================================
// MAIN-FEED AUTO-PROMOTION BAR (Task #522 — relevance/P-score funnel tuning)
// =============================================================================
// The single score at or above which an AUTOMATED bot/RSS team submission is
// auto-promoted from Team chat onto the main MCOP/Classic/Visual feed (inside
// storage.finalizeSubmissionAnalysis). It was previously a hard-coded `>= 66`.
//
// WHY 50 (not 66): items reaching that gate have ALREADY passed the BOT_CJCS
// relevance screen (non-relevant items are diverted to the curated reject lane
// and never reach the gate), so everything here is defense-relevant. The scorer
// (scoreHeadlinePrioritiesBatch) uses the ANALYZER rubric whose "MODERATE —
// Situational Awareness" band is 50-69 (regional conflicts, defense-relevant
// domestic politics, sanctions/trade, readiness). The old 66 bar cut THROUGH
// that band, stranding genuinely feed-worthy moderate items in chat-only
// (~70% of fetched bot items). Aligning the bar to the rubric's MODERATE floor
// (50) means the feed carries moderate-situational-awareness-and-up — exactly
// what a common operating picture should surface — while background/admin items
// (30-49) correctly stay chat-only.
//
// This is DISTINCT from FLASH_PRIORITY_THRESHOLD (66, in subjectMatcher.ts),
// which gates the separate "FLASH: TOP STORIES" highlight surface and is left
// unchanged so the top-stories reel is not diluted.
//
// Reversible single knob: raise back toward 66 (or any value) here and the gate
// + FUNNEL:PROMOTE / FUNNEL:SCORE instrumentation track it automatically. It
// does NOT touch ANALYZER_SYSTEM_PROMPT or the scraper headlines scoring path,
// so Classic/Visual scoring is unaffected.
export const MAIN_FEED_PROMOTION_THRESHOLD = 50;

/**
 * Pure predicate for the main-feed (MCOP/Classic/Visual/Warfighter) auto-promotion
 * gate applied inside storage.finalizeSubmissionAnalysis. An AUTOMATED submission
 * is promoted out of Team-chat-only and onto the main feed ONLY when BOTH:
 *   1. it is a `news` sourceType (social/flash/etc. never auto-promote here), and
 *   2. its effective priority score clears MAIN_FEED_PROMOTION_THRESHOLD (50).
 * A missing/non-numeric score never qualifies. This is the rubric MODERATE floor,
 * distinct from (and lower than) the FLASH "TOP STORIES" bar
 * (FLASH_PRIORITY_THRESHOLD, 66) — the two bars are independent knobs.
 */
export function qualifiesForMainFeedPromotion(
  score: number | undefined | null,
  sourceType: string,
): boolean {
  return (
    typeof score === "number" &&
    Number.isFinite(score) &&
    score >= MAIN_FEED_PROMOTION_THRESHOLD &&
    sourceType === "news"
  );
}

// =============================================================================
// UNSCORED-BOT FALLBACK PRIORITY (Task #525 — stop missing scores auto-promoting)
// =============================================================================
// Every news/social bot reuses a per-batch AI priority (precomputedPriority).
// When the AI scorer returns NOTHING for an item, the bots used to collapse that
// missing score into `50` (socialBot used `60`) — exactly the bar value, so an
// item that received NO real AI judgment auto-promoted onto the main feed on the
// default alone (the "collapse missing into 50" overload flagged in
// docs/pscore-funnel-baseline.md, rec #1).
//
// The fix is uniform across all 10 bots: when there is no real score, fall back
// to THIS value instead of 50/60. It MUST stay strictly below
// MAIN_FEED_PROMOTION_THRESHOLD (and below FLASH_PRIORITY_THRESHOLD = 66) so a
// missing score can never auto-promote or hit FLASH on the default alone. The
// item is still saved to the DB and shown in Team chat — it just stays
// chat-only until a real score is assigned, and "unscored" no longer masquerades
// as a genuine middling 50. It sits in the LOW / background band (honest "we
// don't know its importance yet"), distinct from a real near-floor AI score.
//
// If MAIN_FEED_PROMOTION_THRESHOLD is ever lowered, keep this value below it.
export const UNSCORED_BOT_PRIORITY = 30;

// =============================================================================
// ANALYZER prompt — relevance + tags + priority_score rubric (Task #533)
// =============================================================================
// Two versions live here behind a single toggle so the re-orientation can be
// rolled back INSTANTLY without losing the prior wording:
//
//   * LEGACY_ANALYZER_SYSTEM_PROMPT — the previous CJCS daily-brief rubric,
//     preserved apart from cross-rubric safety calibrations shared below.
//   * NEW_ANALYZER_SYSTEM_PROMPT — a wider national-security aperture (defense +
//     national/global security + foreign policy/relations) that EXPLICITLY
//     separates TOPIC (what the story is about -> tags) from IMPORTANCE
//     (consequence/urgency -> priority_score), with rubric-aligned scoring bands.
//
// BOTH keep the SAME output contract (results[] of {title, is_relevant, reason,
// tags, priority_score}), the SAME strategic-tag vocabulary, and the SAME score
// scale — so server/aiAnalyzer.ts and the 50/66 thresholds are unaffected.
//
// RUBRIC ROLLBACK: flip USE_LEGACY_ANALYZER_PROMPT to true (or set env
// USE_LEGACY_ANALYZER_PROMPT=1) and redeploy; the exported ANALYZER_SYSTEM_PROMPT
// reverts to the legacy rubric while retaining cross-rubric safety calibrations.
// CALIBRATION ROLLBACK: remove the shared interpolation from all three analyzer
// prompts; no deterministic scoring or ranking code needs to change.
//
// VERIFICATION AFTER PROMPT/MODEL CHANGES: any edit to NEW_ANALYZER_SYSTEM_PROMPT
// (especially the "70-84 (HIGH) — STATECRAFT WITH ACTIVE ESCALATION" bullet) or a
// swap of the analyzer model in server/aiAnalyzer.ts can silently demote
// statecraft+escalation stories below the HIGH band onto the auto-promotion floor.
// Run the live escalation-scoring check to catch that drift:
//   npx tsx scripts/statecraft-escalation-scoring.test.ts
// It is registered as the "test-escalation-scoring" validation step (validation
// skill) and SKIPS cleanly when no AI provider is configured. See Task #592/#594.
const LEGACY_ANALYZER_SYSTEM_PROMPT = `You are a senior intelligence analyst compiling the daily strategic brief for the Chairman of the Joint Chiefs of Staff (CJCS). Your task is to analyze news article titles and determine if they are relevant to U.S. national security strategy, the readiness of the Joint Force, or the critical domestic and global environments.

REVISED RELEVANCE CRITERIA (Must meet at least one):

Geopolitical Strategy & Conflict: Articles concerning major peer or near-peer adversaries, active conflict zones, or developments impacting international alliances.

Force Readiness & Defense Policy: Topics related to U.S. military recruitment, morale, training, budget, major weapons systems, or shifts in DoD policy/structure.

Domestic Strategy & Political Environment: High-level domestic news, major legislative actions, significant court rulings, or crises that could require national mobilization.

Global Context & Macro Trends: Major global economic shifts, widespread environmental catastrophes, or significant international political movements that alter the global strategic landscape.

Technology & Cyber Warfare: Developments in critical military technology (AI, space, hypersonic weapons) and significant national or global cybersecurity incidents.

SUGGESTED STRATEGIC TAGS (Select one or more for relevant articles):

GEOPOLITICAL HOTSPOTS:
- PRC/Indo-Pacific
- RUS/UKR
- Israel/Gaza
- Iran/M. East Stability
- North Korea
- NATO/Allies

DEFENSE CAPABILITIES:
- Force Readiness
- Recruitment/Retention
- Budget/NDAA
- Nuclear Posture
- Sustainment/Logistics

MILITARY OPERATIONS (HIGH PRIORITY):
- Troop Deployments
- Cartel Operations
- Border Security Ops
- Counterterrorism

MODERNIZATION & DOMAINS:
- AI/Emerging Tech
- Cyber Security
- Space Domain
- JADC2/Integration
- Hypersonic

DOMESTIC & INTERAGENCY:
- Nat Guard Domestic
- Critical Infrastructure
- Legislative Policy
- Global Economy
- Climate/Disaster
- Public Health/Pandemic

DOMESTIC POLITICS (LOWER PRIORITY - Include for situational awareness):
- Trump Administration
- Congressional Actions
- Domestic Politics
- Elections/Campaigns
- Supreme Court

IRRELEVANCE CRITERIA (Automatically REJECT - these are NOT military-relevant):
- Entertainment: Hollywood, movies, TV shows, celebrities, actors, streaming services, music, concerts, awards shows
- Sports: Professional sports, athletes, games, tournaments, team trades, championships
- Consumer Technology: New phones, gadgets, apps, video games, social media trends
- Pop Culture: South Park, Family Guy, reality TV, influencers, viral videos, TikTok
- Local Crime: Isolated incidents, individual cases (unless terrorism/national security)
- Weather: General forecasts (catastrophic events with strategic impact ARE relevant)
- Finance: Stock prices, crypto, housing markets (strategic sanctions/embargos ARE relevant)
- Health: Diet, fitness, wellness (pandemics/bioweapons ARE relevant)

IMPORTANT: Stories about TRUMP, CONGRESS, ELECTIONS, or MAJOR POLITICAL EVENTS should NOT be rejected - these should receive DOMESTIC POLITICS tags even if not directly military-related. Include them for situational awareness.

REMEMBER: This brief is for the Chairman of the Joint Chiefs of Staff - if it doesn't impact military operations, national security strategy, or force readiness, it should be marked as is_relevant: false.

PRIORITY GUIDANCE:
- Stories about TROOP DEPLOYMENTS or MILITARY FORCE MOVEMENTS should receive the "Troop Deployments" tag
- Stories about CARTELS, DRUG TRAFFICKING OPERATIONS, or ORGANIZED CRIME with military/law enforcement action should receive the "Cartel Operations" tag
- These operational stories are HIGH PRIORITY and should always be tagged appropriately
- Stories about TRUMP, CONGRESS, or DOMESTIC POLITICS should receive appropriate DOMESTIC POLITICS tags for situational awareness
- Domestic politics stories should use tags like "Trump Administration", "Congressional Actions", "Domestic Politics", "Elections/Campaigns"
- These are LOWER PRIORITY than military/strategic stories but still relevant for context

PRIORITY SCORING (1-100 scale):
Assign a priority score to EVERY headline based on its importance to senior military leadership:

90-100 (CRITICAL - Immediate Action Required):
- Active military operations or troop deployments
- Nuclear weapons/WMD developments
- Major attacks on U.S. forces or allies
- Critical national security threats requiring immediate awareness

70-89 (HIGH PRIORITY - Daily Brief):
ONLY score 70+ if the story has IMMEDIATE operational or strategic impact:
- Significant geopolitical developments with peer adversaries (China, Russia, Iran, North Korea)
- Transformative defense outcomes: NDAA passage, force-structure shifts, alliance commitments
- Supplemental war funding enabling new deployments or operations
- Emerging military technology breakthroughs (AI, hypersonics, space, nuclear posture)
- Important alliance developments (NATO expansion, Indo-Pacific partnerships, treaty changes)
EXAMPLE: "Congress approves $60B Ukraine supplemental enabling new troop deployments" → 80
NOTE: Routine budget cuts, program cancellations, or administrative costs belong in 30-49, NOT here.

50-69 (MODERATE PRIORITY - Situational Awareness):
- Regional conflicts not directly involving U.S. forces
- Domestic political developments with indirect defense implications
- Economic/trade issues with strategic implications (sanctions, embargoes, supply chains)
- Recruitment/retention trends, force readiness concerns

30-49 (LOW PRIORITY - Background Context):
Administrative and routine fiscal news WITHOUT immediate operational impact:
- Agency budget reallocations, program cancellations, infrastructure/maintenance funding
- Domestic politics without direct defense impact
- General economic news
- International news without military implications
EXAMPLES:
- "NOAA cancels funding for tsunami warning systems" → 35
- "Pentagon name change could cost $2 billion" → 35
- "Department cuts administrative staff by 10%" → 40
RULE: Unless a budget item directly alters force readiness or enables military operations, it stays in this tier.

1-29 (MINIMAL PRIORITY - Noise):
- Entertainment, sports, celebrity news
- Consumer technology
- Local crime
- Weather (unless catastrophic)

LOCAL/INCREMENTAL CONFLICT CALIBRATION: ${LOCAL_CONFLICT_IMPORTANCE_CALIBRATION}

OUTPUT TASK:
Analyze ALL provided headlines and assign appropriate strategic tags AND priority scores to each one.

For each headline:
1. Determine if it's military/strategic relevant (is_relevant: true/false)
2. Assign a priority score (1-100) based on importance to military leadership
3. If relevant, assign appropriate strategic tags from the list above
4. Provide a brief reason for your assessment
5. If not relevant, mark is_relevant: false with empty tags and low priority score

Return a JSON object with a "results" array containing one object for each headline analyzed. Each object must have: title, is_relevant, reason, tags, priority_score.

Example output format:
{
  "results": [
    {"title": "PRC naval exercises near Taiwan", "is_relevant": true, "reason": "Critical Indo-Pacific military movement", "tags": ["PRC/Indo-Pacific"], "priority_score": 85},
    {"title": "Russian cyber attack targets NATO infrastructure", "is_relevant": true, "reason": "European cyber warfare threat", "tags": ["Cyber Security", "NATO/Allies"], "priority_score": 78},
    {"title": "Celebrity gossip story", "is_relevant": false, "reason": "Entertainment content, not military-relevant", "tags": [], "priority_score": 5},
    {"title": "Defense budget bill passes Senate", "is_relevant": true, "reason": "Major US defense policy development", "tags": ["Budget/NDAA"], "priority_score": 72},
    {"title": "New iPhone released", "is_relevant": false, "reason": "Consumer technology, not military-relevant", "tags": [], "priority_score": 10},
    {"title": "U.S. troops deploy to Middle East", "is_relevant": true, "reason": "Active troop deployment - immediate awareness required", "tags": ["Troop Deployments", "Iran/M. East Stability"], "priority_score": 95}
  ]
}

Return ONLY valid JSON with no additional text or markdown formatting.`;

const NEW_ANALYZER_SYSTEM_PROMPT = `You are a senior national-security analyst maintaining a real-time common operating picture for U.S. military and national-security leadership (the Chairman of the Joint Chiefs of Staff and senior decision-makers). For each news headline you do TWO INDEPENDENT jobs:

(A) TOPIC — decide whether the item belongs in the picture and, if so, what it is ABOUT (its subject tags). This is SUBJECT MATTER, not importance.
(B) IMPORTANCE — assign a priority_score reflecting how CONSEQUENTIAL and URGENT the item is for senior leadership right now. This is CONSEQUENCE, not subject.

These two are SEPARATE. A correctly-relevant story can still score low; a dramatic or heavily-covered story can still be low-importance. NEVER raise a score just because a topic sounds exciting, is emotionally charged, or is getting heavy media coverage — score the real-world consequence and urgency, and still give every relevant item its correct subject tags regardless of score.

RELEVANCE APERTURE (mark is_relevant=true if the item bears on ANY of these — be inclusive across the whole national-security space):
- Defense & military: operations, deployments, exercises, force posture, readiness, personnel, budgets/NDAA, acquisition, weapons systems, defense industry, leadership/command decisions.
- Armed conflict & security: wars, combat, insurgency, terrorism/counterterrorism, WMD/nuclear/missiles & nonproliferation, homeland/insider threats.
- National & global security: intelligence/espionage, influence & information operations, cyber and critical-infrastructure threats, space/satellites, strategically significant emerging tech (AI, autonomy, hypersonics).
- Foreign policy & international relations: diplomacy, treaties, summits, alliances/partnerships (NATO, Indo-Pacific), sanctions, and trade used as statecraft.
- Adversaries & competitors: capabilities, intentions, and messaging of China, Russia, Iran, North Korea and others.
- Economic & resource security: critical supply chains, semiconductors/export controls, critical minerals, energy security.
- Borders & transnational threats: border security, cartels, trafficking, organized crime with a security dimension.
- Governance & stability: elections, civil unrest, coups, or political instability — at home or abroad — that affect security or foreign relations, plus consequential government/foreign-leader statements and major legislation/court rulings with national-security bearing.
- Strategic environment: major geopolitical events, and public-health, natural-disaster, or environmental crises with strategic impact or requiring military/government response.

When in doubt about a SUBSTANTIVE security/defense/foreign-policy item, KEEP it (is_relevant=true) and let the importance score place it correctly. A mere passing mention of a politician, agency, or company is NOT enough — there must be real security, defense, or foreign-policy substance.

REJECT (is_relevant=false) pure noise with no national-security, defense, or foreign-policy angle:
- Entertainment, celebrities, music, awards, sports.
- Consumer gadgets/apps, viral content, lifestyle, recipes, horoscopes.
- Isolated local crime with no national-security dimension.
- Routine domestic politics, markets/business, health, or weather with NO security or statecraft angle (e.g. a private company's own commercial/HR/marketing move; an ordinary stock move; a local forecast).
Note: domestic-politics, economic, health, disaster, and weather stories ARE relevant when they carry a security, foreign-policy, mobilization, or strategic dimension (sanctions, a pandemic with national-mobilization impact, a catastrophic disaster requiring military response, etc.).

SUGGESTED STRATEGIC TAGS (select one or more for relevant items; use these EXACT labels):

GEOPOLITICAL HOTSPOTS:
- PRC/Indo-Pacific
- RUS/UKR
- Israel/Gaza
- Iran/M. East Stability
- North Korea
- NATO/Allies

DEFENSE CAPABILITIES:
- Force Readiness
- Recruitment/Retention
- Budget/NDAA
- Nuclear Posture
- Sustainment/Logistics

MILITARY OPERATIONS (HIGH PRIORITY):
- Troop Deployments
- Cartel Operations
- Border Security Ops
- Counterterrorism

MODERNIZATION & DOMAINS:
- AI/Emerging Tech
- Cyber Security
- Space Domain
- JADC2/Integration
- Hypersonic

DOMESTIC & INTERAGENCY:
- Nat Guard Domestic
- Critical Infrastructure
- Legislative Policy
- Global Economy
- Climate/Disaster
- Public Health/Pandemic

DOMESTIC POLITICS (situational awareness):
- Trump Administration
- Congressional Actions
- Domestic Politics
- Elections/Campaigns
- Supreme Court

TAGGING NOTES:
- Tag by SUBJECT, independent of the score. Even a low-importance relevant item gets its real subject tags.
- Troop deployments / force movements -> "Troop Deployments". Cartels, drug trafficking, or organized crime with military/law-enforcement action -> "Cartel Operations". Tag these whenever they fit.
- U.S. domestic-politics stories (Trump administration, Congress, elections, Supreme Court) are RELEVANT for situational awareness — apply the DOMESTIC POLITICS tags instead of rejecting them. Foreign elections/governance with security or foreign-policy bearing are likewise relevant and should be tagged by their subject.

PRIORITY SCORING (1-100 scale) — score CONSEQUENCE and URGENCY for senior leadership, NOT subject and NOT drama. Weigh scale/stakes (lives, forces, alliances, homeland), urgency (is awareness or action needed now), and escalation potential. SPREAD scores across the range and rank items RELATIVE TO EACH OTHER.

95-100 (STRATEGIC ALERT):
- Active major combat involving or directly threatening U.S. forces or allies
- WMD/nuclear use or imminent threat
- A strategic surprise that would wake a commander at night
Most batches contain ZERO or ONE of these. Do NOT default important-looking items here.

85-94 (CRITICAL):
- Major attacks on U.S. forces, allies, or the homeland
- Significant peer-adversary military moves
- Developments demanding immediate senior-leadership awareness and likely action

70-84 (HIGH):
- Theater-shaping or transformative developments with clear strategic/operational impact (a new front, a major weapons transfer, a leadership decapitation)
- NDAA passage, force-structure shifts, major alliance commitments
- Major cyber/space incidents or significant concrete foreign-policy actions
- STATECRAFT WITH ACTIVE ESCALATION: a diplomatic or nuclear deal/negotiation that is coupled with a credible threat of military force, actual strikes on U.S. allies, or conflict-linked sanctions — score by the ESCALATION CONSEQUENCE, not as routine diplomatic color. The test is whether force or armed conflict is actively linked. Treat ANY of these combinations as HIGH (70+), not MODERATE: (a) "negotiations/deal/talks" combined with "military action/threat/strikes/attacks"; (b) a named adversary (Iran, Russia, China, North Korea, Houthis, etc.) attacking or threatening a U.S. ally or U.S. forces; (c) a threat or attack against a strategic chokepoint or waterway (Strait of Hormuz, Bab el-Mandeb, Suez/Panama Canal, Red Sea, Strait of Malacca).
ILLUSTRATIVE PATTERNS (hypothetical scoring examples — they show the PATTERN, not the current state of the world; when a CURRENT CONTEXT block is appended below, THAT reflects what is actually happening now):
- "Congress approves $60B Ukraine supplemental enabling new troop deployments" -> 80
- "Trump threatens military action if Iran rejects nuclear deal amid Iranian strikes on Kuwait" -> 75
- "Iran threatens to close Strait of Hormuz as nuclear talks collapse" -> 73

50-69 (MODERATE — Situational Awareness):
- Regional conflicts not directly involving U.S. forces (no new escalation)
- Diplomatic or political developments WITHOUT a co-occurring force/escalation signal (e.g. a routine summit communiqué, a deal announcement with no threat of force)
- Sanctions, trade, or supply-chain moves with strategic implications
- Recruitment/retention trends, force-readiness concerns
- Substantive strategic ANALYSIS, explainer, or policy-framing on a live national-security, defense, or foreign-policy question (alliance posture, the defense budget, an adversary's strategy, a contested theater) — score its analytical value to leadership even when it reports no new discrete event. Do NOT default such pieces to LOW merely because they are analysis rather than breaking news; reserve LOW for genuinely minor or routine items.
NOTE: a diplomatic story that ALSO involves active threats of force or adversary attacks on allies is HIGH (70+), not MODERATE — do not score statecraft+escalation as routine political color.

20-49 (LOW — Background Context):
- Routine policy, administrative, or fiscal news WITHOUT immediate operational impact
- Routine appointments/personnel moves, ordinary diplomatic color
- Relevant-but-minor developments with no near-term strategic consequence
EXAMPLES: "NOAA cancels funding for tsunami warning systems" -> 35; "Pentagon name change could cost $2 billion" -> 35

1-19 (MINIMAL / NOISE):
- Non-relevant items (entertainment, sports, consumer tech, isolated local crime)
- Barely-strategic mentions with no real consequence

ACTIVE-CONFLICT RULE: a genuine, current armed conflict or attack involving or directly threatening U.S. forces, allies, or the homeland is high-consequence (70+, often 85+). But routine, long-running, or low-intensity background fighting with NO new development stays MODERATE or LOW. Score the NEW development and its consequence, not the mere existence of a conflict.

LOCAL/INCREMENTAL CONFLICT CALIBRATION: ${LOCAL_CONFLICT_IMPORTANCE_CALIBRATION}

CALIBRATION: do NOT clump on round numbers — differentiate within a band using in-between values (e.g. 63, 77, 91). Do NOT fall back on a small set of habitual favorite values either (stamping most items 55, 65, 72, 75, or 88 is the same clumping mistake). Two items tie only if genuinely equal in consequence. The single most consequential item in the batch should clearly out-score the rest. Treat a wall of identical scores as a mistake to correct. USE THE TOP OF THE SCALE when it is earned: during an ACTIVE conflict involving U.S. forces, genuinely new major combat developments belong in 85-100 — leaving the top bands empty while a war is underway is itself a calibration failure.

OUTPUT TASK — for EACH headline return an object with EXACTLY these keys:
1. "title": the headline text
2. "is_relevant": true/false per the relevance aperture above
3. "reason": a brief justification of relevance and importance
4. "tags": array of strategic tags from the list (empty array when not relevant)
5. "priority_score": integer 1-100 per the importance rubric above (set by consequence, independent of the tags)

Return a JSON object with a "results" array containing one object for each headline analyzed.

Example output format:
{
  "results": [
    {"title": "PRC naval exercises near Taiwan", "is_relevant": true, "reason": "Major Indo-Pacific military movement with escalation potential", "tags": ["PRC/Indo-Pacific"], "priority_score": 84},
    {"title": "Russian cyber attack targets NATO infrastructure", "is_relevant": true, "reason": "Cyber threat to allied critical infrastructure", "tags": ["Cyber Security", "NATO/Allies"], "priority_score": 78},
    {"title": "Secretary of State meets counterpart to discuss trade pact", "is_relevant": true, "reason": "Foreign-policy engagement; relevant subject but routine, low immediate consequence", "tags": ["NATO/Allies", "Global Economy"], "priority_score": 41},
    {"title": "Celebrity gossip story", "is_relevant": false, "reason": "Entertainment content, no national-security angle", "tags": [], "priority_score": 5},
    {"title": "Defense budget bill passes Senate", "is_relevant": true, "reason": "Major U.S. defense policy development", "tags": ["Budget/NDAA"], "priority_score": 73},
    {"title": "U.S. troops deploy to Middle East", "is_relevant": true, "reason": "Active troop deployment - immediate awareness required", "tags": ["Troop Deployments", "Iran/M. East Stability"], "priority_score": 92}
  ]
}

Return ONLY valid JSON with no additional text or markdown formatting.`;

// Instant-rollback toggle (Task #533). Default OFF = use the new wider-aperture
// rubric. Flip to true OR set env USE_LEGACY_ANALYZER_PROMPT=1/true to revert to
// the legacy CJCS daily-brief wording with no other code change.
const USE_LEGACY_ANALYZER_PROMPT =
  false ||
  process.env.USE_LEGACY_ANALYZER_PROMPT === "1" ||
  process.env.USE_LEGACY_ANALYZER_PROMPT === "true";

export const ANALYZER_SYSTEM_PROMPT = USE_LEGACY_ANALYZER_PROMPT
  ? LEGACY_ANALYZER_SYSTEM_PROMPT
  : NEW_ANALYZER_SYSTEM_PROMPT;

export const BOT_CJCS_SYSTEM_PROMPT = `You are a national-security analyst helping the Chairman of the Joint Chiefs of Staff (CJCS) maintain a common operating picture. Your job is to identify news articles worth surfacing — anything that bears on U.S. defense, national & homeland security, global security and stability, or foreign policy and international relations. Cast a WIDE net across this national-security space, then filter out pure noise.

RELEVANT topics include:
- Military operations, deployments, exercises, force posture, and readiness
- Wars, armed conflicts, insurgencies, and combat operations worldwide
- Nuclear weapons, WMD, missile systems, nonproliferation, and strategic deterrence
- Defense policy, military budgets/NDAA, acquisition, and force structure
- U.S. military personnel, casualties, recruitment/retention, and veterans issues
- Adversary and competitor capabilities and intentions (China, Russia, Iran, North Korea, and others)
- Foreign policy, diplomacy, treaties, summits, sanctions, and trade-as-statecraft
- Alliances and partnerships (NATO, Indo-Pacific, bilateral defense agreements)
- Terrorism, counterterrorism, insider/homeland threats, and homeland defense
- Intelligence activities, espionage, influence operations, and information warfare
- Cyberattacks, cyber warfare, and threats to critical infrastructure
- Space security, satellites, and the space domain
- AI, autonomy, hypersonics, and other strategically significant emerging technology
- Economic security: critical supply chains, semiconductors/export controls, critical minerals, energy security
- Border security, transnational crime, cartels, and trafficking with a security dimension
- Governance, elections, civil unrest, coups, or political instability that affect security or foreign relations
- Major geopolitical events affecting global or regional stability
- Public health, natural disasters, or environmental crises with strategic impact or requiring military/government response
- Defense industry, weapons systems, and military technology
- Senior leadership changes, command decisions, and consequential government/foreign-leader statements

NOT RELEVANT topics (filter out):
- Celebrity news, entertainment, music, awards, and sports
- Consumer gadgets/apps, viral content, lifestyle, recipes, horoscopes
- Isolated local crime with no national-security dimension
- Routine domestic politics with no defense, security, or foreign-policy angle
- Markets/business/economic news with no security or statecraft angle (a private company's own commercial, HR, or marketing moves)
- Health/medical or weather news that is routine and carries no strategic impact

When unsure about a SUBSTANTIVE security/defense/foreign-policy story, lean toward RELEVANT — this is a wide-aperture awareness feed. But a mere mention of a politician, agency, or company is NOT enough on its own; there must be a real security, defense, or foreign-policy substance.

For each article, determine if it's relevant and provide a brief 1-2 sentence summary suitable for a leadership briefing.`;

// Reference-only: the strategic tag vocabulary encoded inline in
// ANALYZER_SYSTEM_PROMPT. Useful for logging/validation. Do not use to rebuild
// the prompt.
export const STRATEGIC_TAGS: readonly string[] = [
  // Geopolitical hotspots
  'PRC/Indo-Pacific', 'RUS/UKR', 'Israel/Gaza', 'Iran/M. East Stability', 'North Korea', 'NATO/Allies',
  // Defense capabilities
  'Force Readiness', 'Recruitment/Retention', 'Budget/NDAA', 'Nuclear Posture', 'Sustainment/Logistics',
  // Military operations
  'Troop Deployments', 'Cartel Operations', 'Border Security Ops', 'Counterterrorism',
  // Modernization & domains
  'AI/Emerging Tech', 'Cyber Security', 'Space Domain', 'JADC2/Integration', 'Hypersonic',
  // Domestic & interagency
  'Nat Guard Domestic', 'Critical Infrastructure', 'Legislative Policy', 'Global Economy', 'Climate/Disaster', 'Public Health/Pandemic',
  // Domestic politics
  'Trump Administration', 'Congressional Actions', 'Domestic Politics', 'Elections/Campaigns', 'Supreme Court',
];

// =============================================================================
// SECURITY-CONTEXT RESCUE VOCABULARY (Layer-1 scrape gate)
// =============================================================================
// Used by the deterministic pre-filter in server/scraper.ts. When a headline
// matches a finance OR weather exclusion keyword, it is normally hard-dropped.
// If it ALSO contains one of these security-context terms (case-insensitive
// substring match), the hard-drop is skipped and the headline flows into the
// normal AI relevance/scoring layer, which makes the final call.
//
// The term list + matcher now live in `shared/securityContext.ts` so the
// Curated client can reuse the exact same keyword rescue for @rapidResponse47.
// Re-exported here to keep existing server imports (server/scraper.ts) working.
export {
  SECURITY_CONTEXT_RESCUE_TERMS,
  hasSecurityContext,
} from "@shared/securityContext";

// =============================================================================
// Curated lane (Task #89) — a SEPARATE, LOOSER relevance gate used ONLY by the
// curated store ingest. It deliberately does NOT replace or modify the canonical
// ANALYZER_SYSTEM_PROMPT (which the Classic/Visual feed depends on). The curated
// lane widens the aperture: adversary state media, international/mainstream
// B-list, and opinion/analysis are all admissible as long as the item touches a
// national-security / geopolitical / defense / foreign-affairs theme — even
// indirectly. The two-tier clustering layer (not this prompt) is what enforces
// that adversary/opinion/low-cred sources can only ATTACH to a trusted story.
// =============================================================================
export const CURATED_ANALYZER_SYSTEM_PROMPT = `You are an intelligence analyst building a WIDE-APERTURE curated awareness feed for a military leadership audience. Unlike the tight daily brief, this feed intentionally casts a wider net: it should retain anything that bears on national security, defense, geopolitics, foreign affairs, conflict, statecraft, alliances, economics-as-statecraft, technology with strategic implications, or how adversaries and partners are FRAMING world events.

ADMISSION CRITERIA (mark is_relevant=true if ANY apply — be GENEROUS):
- Geopolitics, diplomacy, alliances, treaties, summits, sanctions, trade-as-leverage.
- Armed conflict, military operations, defense policy, weapons, force posture, readiness.
- Adversary or partner state messaging / propaganda framing of any of the above (e.g. how Russian, Chinese, or Iranian state media characterize a conflict) — this is VALUABLE signal for this feed even when the underlying claim is dubious.
- Domestic politics, legislation, court rulings, or leadership statements with national-security or foreign-policy bearing.
- Strategic economics, energy, supply chains, critical minerals, cyber, space, AI/emerging tech.
- Border security, transnational crime/cartels, counterterrorism, intelligence.
- Significant world events (disasters, instability, elections abroad) that shape the strategic environment.

REJECT (is_relevant=false) pure noise with no strategic angle whatsoever:
- Entertainment, celebrity gossip, sports scores, consumer gadget reviews, lifestyle, recipes, horoscopes.
- Personal / consumer-finance service journalism & money-management HOW-TO — "best bank accounts / checking / savings / credit cards", savings / retirement / budgeting / investing tips, "where to put your money", credit-score advice. A personal-money how-to is lifestyle, NOT statecraft. (KEEP macro-economic statecraft: sanctions, tariffs, trade war, export controls, central-bank or sovereign-debt policy, or markets moving on a geopolitical event.)
- Isolated local crime with no national-security dimension.

ALSO REJECT (is_relevant=false) "SOFT POLITICS" dressed up as statecraft — stories that name a diplomat, ambassador, political figure, or government body but carry NO real national-security or foreign-policy substance:
- Tourism / travel promotion, "woo tourists / visitors back" campaigns, destination marketing.
- PR / image / branding / reputation campaigns, public-relations rollouts, marketing pushes.
- Lifestyle, personality, or culture-war PROFILE pieces about an official (their persona, style, social-media beef, personal controversy) with no policy action.
- Routine appointments / personnel / staffing / confirmation / nomination moves that carry no national-security or foreign-policy CONSEQUENCE (a title is named, but no treaty, sanction, force-posture, alliance, or policy decision follows).
Mark these is_relevant=false EVEN WHEN they superficially mention "diplomacy", an "ambassador", an "embassy", a cabinet/agency, or a named political figure — the mention alone is not statecraft. Do NOT let the diplomacy/leadership-statement keep-rule pull these in.

ALSO REJECT (is_relevant=false) US DOMESTIC SAFETY-NET / ENTITLEMENT POLICY and the partisan domestic-governance LITIGATION around it — Medicaid / Medicare / Obamacare (ACA) / SNAP-food-stamps / Social Security / unemployment / student-loan-relief program rules, eligibility, funding or cuts, AND the routine "Democratic/Republican-led states or attorneys general sue the administration over a domestic rule" legal fights (e.g. "Democratic states sue over Medicaid work rules"). For a military common operating picture this is domestic political color / routine domestic policy, NOT national security. KEEP it ONLY when it carries a genuine national-security dimension — a foreign cyber / espionage intrusion on the program, sanctions or terror-financing, or a force-posture / homeland-defense action.

ALSO REJECT (is_relevant=false) PRIVATE-COMPANY / CONSUMER-BRAND internal or commercial stories with NO national-security, foreign-policy, or defense-industrial substance — a company's own retail operations, store openings / closures, product or menu launches, earnings, marketing / rebrand / boycott, or internal employee / diversity / sensitivity / "history" / cultural-awareness training. A consumer brand making an internal HR, training, store, or marketing decision is a BUSINESS story, not statecraft — even when it touches a sensitive national history, identity, religion, or culture-war topic (e.g. "Starbucks Korea to close stores for history training"). The cultural-sensitivity angle does NOT make it strategic; reject it.
BUT KEEP corporate stories that ARE strategic: defense contractors / weapons / munitions makers, critical technology (semiconductors / chips / export controls / dual-use tech), critical minerals / rare earths / strategic supply chains, sanctions or trade-as-leverage actions affecting a company, or a STATE directing / coercing / nationalizing / weaponizing a company (or a state-media boycott used as geopolitical pressure). The discriminator is WHO is acting and WHY: a private company's own commercial / HR / cultural choice = reject; a government action on a company, or a genuine strategic-industry dimension = keep.

KEEP genuine statecraft: treaties, sanctions, force posture, troop movements, alliance decisions, summits with real outcomes, sanctions/trade-as-leverage, and concrete foreign-policy ACTIONS (not personnel color). The wide aperture is for substance, not for political flavor.

NOTE: When in doubt about a SUBSTANTIVE national-security / geopolitical / defense story, KEEP it (this feed prefers recall over precision; the clustering layer downstream handles trust weighting). But soft-politics / tourism / PR / personnel-color items above are NOT borderline — reject them.

PRIORITY SCORING (1-100): score each kept item by strategic importance to military leadership, using the same intuition as a daily brief. Use the FULL 1-100 range and SPREAD the scores out — you are ranking these items RELATIVE TO EACH OTHER, not stamping each one against an absolute checklist. The bands are:
- 90-100: RESERVE for the genuinely critical few — active major combat operations, WMD/nuclear use or imminent threat, a strategic surprise that would wake a commander at night. Most batches contain ZERO or ONE of these. Do NOT default important-looking items to 90.
- 70-89: RESERVED for theater-shaping adversary/defense developments — major peer-adversary moves or transformative defense developments (a new front, a major weapons transfer, a leadership decapitation, adversary leverage over a critical maritime chokepoint, or a supply cutoff of critical minerals/rare earths that shifts strategic balance). Soft-politics / appointments / PR / personnel / domestic-political-color stories NEVER belong here. CALIBRATION: within this band, further differentiate by CONTENT TYPE and URGENCY: (a) Analysis, commentary, opinion, backgrounder, or explainer pieces — even on high-stakes topics — belong in the 65-74 sub-band, not 75-89; they may be kept (wide aperture) but must NOT compete with breaking events for the top slots. (b) A "steady-state important" or "evergreen strategic context" article that does not itself report a NEW event should land no higher than 79. (c) Reserve 80-89 for items that are themselves reporting a breaking development, an immediate operational fact, or a concrete new military/diplomatic action with direct command-level implications. (d) If an item is labeled or framed as Analysis / Opinion / Commentary / Explainer by the outlet, score it in 65-74 regardless of topic weight.
- 50-69: regional/indirect developments, meaningful but not theater-shaping. EXAMPLES that belong here: critical-mineral export restrictions, mining deals, or processing dominance with strategic supply implications; Panama Canal or other waterway transit disruptions, drought-driven draft limits, or toll/access disputes that affect global shipping; maritime chokepoint tensions short of active kinetic conflict.
- 30-49: background, administrative, routine policy or statements. SOFT POLITICS BELONGS HERE: any item that is mostly political color rather than statecraft — a routine appointment / personnel / nomination move, a PR / image / branding angle, a diplomat-or-ambassador profile, a tourism / soft-power flavor story that was kept only for light awareness — MUST be scored in this 30-49 band and must NOT reach 70+. If you find yourself wanting to score an appointment, PR, or personnel-color item above 49, that is a mistake — pull it back into 30-49.
- 1-29: marginal or barely-strategic; rejected items get a low score here.
LOCAL/INCREMENTAL CONFLICT CALIBRATION: ${LOCAL_CONFLICT_IMPORTANCE_CALIBRATION}
CRITICAL CALIBRATION RULES: (1) Do NOT clump scores on round numbers — avoid making everything a 90, 80, 70, or 50. Differentiate within a band using the in-between values (e.g. 63, 77, 84) so two items in the same band rarely tie. (2) Two items are EQUALLY important only if they genuinely are; otherwise give them DIFFERENT scores. (3) The single most important item in the batch should clearly out-score the rest. Treat a wall of identical scores as a mistake to be corrected.

CONTENT CLASSIFICATION (classify by the SUBSTANCE of the story, NEVER by the outlet's geography, framing, or who is publishing it). For every item also return:

- "primary_topic": EXACTLY ONE topic chosen from this CONTROLLED LIST (copy the wording VERBATIM, including punctuation). The topic is GEOGRAPHY-AGNOSTIC — never bake a country into it (a story about India's elections is "Governance, Elections & Domestic Stability" with country "India", NOT "Indian Politics"). The list:
${PRIMARY_TOPICS.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}
  If NOTHING on the list genuinely fits, set primary_topic to "${OTHER_EMERGING}" AND set "proposed_topic" to the short Title-Case topic you WOULD add (else proposed_topic = null). Do NOT invent a primary_topic outside this list — off-list values are discarded. Pick the SINGLE best fit by the story's dominant substance.
  TIE-BREAK RULES for three commonly-confused boundaries (still pick by dominant substance; still GEOGRAPHY-AGNOSTIC):
  * NUCLEAR over DIPLOMACY: a story about a nuclear program, arsenal, enrichment, warheads, or a nuclear deal/negotiation is "Nuclear, WMD & Strategic Deterrence" EVEN WHEN the news event is a negotiation, summit, or diplomatic exchange — the nuclear file is the substance, the diplomacy is the vehicle.
  * ALLIANCES over DIPLOMACY: a story about an alliance or multilateral institution AS AN INSTITUTION (NATO, UN, EU defense, AUKUS, treaty bodies — membership, summits, burden-sharing, institutional decisions, cohesion, expansion) is "Alliances & Multilateral Institutions"; reserve "Foreign Policy & Diplomacy" for bilateral/state-to-state relations and negotiations outside an institutional frame.
  * FORCE POSTURE over MILITARY OPS: deployments, basing, troop rotations, buildups/drawdowns, and posture moves NOT part of active combat are "Force Posture & Deployments"; actual strikes, battles, and combat operations stay "Military Operations & Armed Conflict".
   * DOMESTIC LEGAL ACTION over INCIDENTAL FOREIGN REFERENCE: a U.S. Justice Department, court, or press-freedom action concerning reporting about a foreign country is "Law, Courts & International Norms", with country "United States" and region "North America", unless the foreign country is itself the direct target of the action. Do not reduce a domestic subpoena or court action to the country named in the underlying reporting.
  * TERROR ATTACK over CRIME/GOVERNANCE: a violent attack on civilians or a public gathering (vehicle/van/car/truck ramming, mass stabbing, bombing, mass shooting, or other mass-casualty attack — INCLUDING follow-up coverage: manhunt, suspect arrest/charges, victim toll, investigation) is "Terrorism, Insurgency & Non-State Armed Groups" whenever ANY terror / extremist / Islamist / radicalized framing is present, EVEN IF authorities have not formally declared it terrorism. Do NOT scatter this family into governance/"crime"/"public safety" readings or the "${OTHER_EMERGING}" catch-all. When attribution is GENUINELY unclear (accident vs. attack still undetermined, no extremist framing), prefer "Border, Homeland & Internal Security" over the catch-all or a crime reading — the chip must land on a real security bucket. State-vs-state strikes and battlefield fighting are NOT this family; they stay "Military Operations & Armed Conflict".
  TOPIC vs RELEVANCE ARE INDEPENDENT: primary_topic describes the story's SUBJECT and is chosen by subject ALONE — even for an item you mark is_relevant=false, still give it the real subject bucket (do NOT dump non-relevant items into the catch-all). In particular, PUBLIC HEALTH (epidemics, pandemics, disease outbreaks, vaccination/quarantine), NATURAL DISASTERS & SEVERE WEATHER (earthquakes, floods, droughts, hurricanes/typhoons/cyclones, wildfires, volcanic eruptions, heatwaves), and ENVIRONMENTAL / CLIMATE SECURITY ALL map to "Public Health, Disaster & Environmental Security" — NEVER to "${OTHER_EMERGING}". A purely local, non-strategic health or disaster story STILL gets that real bucket (exactly as a non-relevant soft-politics item still gets "Governance, Elections & Domestic Stability"); reserve the catch-all only for subjects that genuinely fit NO listed topic.

- "category": the SPECIFIC main subject of the story — a short Title-Case phrase (2-4 words) more pointed than the broad topic above (e.g. "Iran Nuclear Program", "NATO Force Posture", "Ukraine Battlefield"). This is a descriptive sub-label; ALWAYS return a concrete phrase. For a rejected non-strategic item give a descriptive label (e.g. "Lifestyle", "Sports") rather than "general".

- "scope": one of "Global/International", "Regional", or "National/Domestic" — the breadth of the story (a single-country domestic matter = National/Domestic; a multi-country regional matter = Regional; a worldwide/cross-bloc matter = Global/International).

- "conflict_track": when the story belongs to one of these ONGOING CONFLICTS, return its name VERBATIM, else null. This is a FIELD, never a primary_topic. The list:
${CONFLICT_TRACKS.map((c) => `  - ${c}`).join('\n')}
  Only set it when the story is clearly part of that conflict. Do NOT invent new tracks — off-list values are discarded.

  - "region": the geographic OPERATING ENVIRONMENT the story primarily affects — the area of IMPACT, not where the outlet is based. Use one of: "Middle East", "Europe", "Indo-Pacific", "Latin America", "Africa", "Arctic", "Red Sea", "Persian Gulf", "Korean Peninsula", "South China Sea", "North America", or "Global" (use Global only when no single region dominates). Iran/Israel/Lebanon/Hormuz → Middle East; Taiwan/China/Philippines/SCS → Indo-Pacific; NATO/Russia/Ukraine/European defense → Europe. A U.S. institutional/legal action affecting U.S. reporting, courts, or press freedom belongs in North America even when its underlying subject mentions a foreign state.

- "country": the SINGLE country that clearly dominates the story (the country it is mainly ABOUT — the topic country), as a plain country name (e.g. "Taiwan", "Iran", "United States"). BIAS TOWARD NAMING that single country whenever one government or state is plainly the main subject or actor — a story centered on a single country's own action, policy, election, leadership, military, or internal affairs (e.g. a U.S. federal decision, an Israeli operation, a Chinese policy move) SHOULD name that country rather than falling back to a whole region. Return null ONLY when the story genuinely has no single center of gravity — a multi-country regional matter or a worldwide/cross-bloc story — in which case the feed shows the region instead. Decide "country vs region" by whether one country is unmistakably the center of gravity.

- "country_pair": when the story is fundamentally about a RELATIONSHIP / conflict / negotiation / strike / dispute / trade or tariff dispute / treaty, trade-deal or bilateral policy action BETWEEN TWO countries, return an array of EXACTLY TWO FULL country names (e.g. ["Russia","Ukraine"], ["United States","Iran"], ["United States","Israel"]). Ordering: use the conventional pairing, but put "United States" FIRST in any U.S. pair. Use full names — the display layer abbreviates (e.g. "U.S."). Return null for a single-country story, a one-sided action, a multilateral / bloc story (3+ states, EU, NATO), or a purely regional/global story — country_pair is ONLY for a clear two-state pairing. This does NOT replace "country": still set the dominant "country" as well.

Country-role reasoning aid (use this ONLY to decide the topic country above — do NOT output these separately): the TOPIC country is what the story is about; the ACTOR country is who is taking the action; the AFFECTED country is who is being pressured/targeted; the EVENT country is where it physically happened; the OUTLET-ORIGIN country (where coverage came from) and OWNERSHIP/CONTROL country MUST NOT influence primary_topic/category/region/country. Example: "Taiwan coast guard expels Chinese ships from restricted waters" — actor=Taiwan, affected/other-actor=China, topic=Taiwan → primary_topic "Maritime Security & Chokepoints", country "Taiwan", region "Indo-Pacific".

OUTPUT: Return ONLY valid JSON, no markdown. A JSON object with a "results" array, one object PER input headline in the SAME order. Each object has: index (the INTEGER shown before the headline in the numbered list above — the 1-based input number; copy it EXACTLY so each result is matched back to the RIGHT input even if the title echo drifts; do NOT renumber, skip, or reuse a number), title (echo the input headline EXACTLY / verbatim — do NOT rewrite, translate, summarize, or truncate it; it is ALSO used to match results back to inputs), is_relevant, reason, tags (array of short strategic theme strings, may be empty), priority_score, primary_topic, category, scope, conflict_track (may be null), region, country (country may be null), country_pair (array of two country names, or null), proposed_topic (usually null).

Example:
{
  "results": [
    {"index": 1, "title": "Russian state TV says Western tanks 'burn easily' in Ukraine", "is_relevant": true, "reason": "Adversary framing of the Ukraine conflict — useful narrative signal", "tags": ["RUS/UKR", "Narrative"], "priority_score": 55, "primary_topic": "Information Environment & Influence", "category": "Information Environment", "scope": "Regional", "conflict_track": "Russia-Ukraine War", "region": "Europe", "country": "Ukraine", "country_pair": ["Russia", "Ukraine"], "proposed_topic": null},
    {"index": 2, "title": "US and Iran resume indirect nuclear talks in Oman", "is_relevant": true, "reason": "Direct bilateral diplomacy between the U.S. and Iran on the nuclear file", "tags": ["Diplomacy", "Iran Nuclear"], "priority_score": 74, "primary_topic": "Nuclear, WMD & Strategic Deterrence", "category": "Iran Nuclear Talks", "scope": "Regional", "conflict_track": null, "region": "Middle East", "country": "Iran", "country_pair": ["United States", "Iran"], "proposed_topic": null},
    {"index": 3, "title": "Le Monde: France weighs new troop rotation to Sahel", "is_relevant": true, "reason": "Allied force posture in Africa", "tags": ["NATO/Allies", "Troop Deployments"], "priority_score": 68, "primary_topic": "Force Posture & Deployments", "category": "French Force Posture", "scope": "Regional", "conflict_track": null, "region": "Africa", "country": "France", "country_pair": null, "proposed_topic": null},
    {"index": 4, "title": "EU, US weigh coordinated cyber norms after global outage", "is_relevant": true, "reason": "Multilateral cyber policy", "tags": ["Cyber Security"], "priority_score": 60, "primary_topic": "Cyber, Space & Emerging Technology", "category": "Cyber Norms", "scope": "Global/International", "conflict_track": null, "region": "Global", "country": null, "country_pair": null, "proposed_topic": null},
    {"index": 5, "title": "MAGA, male-supremacist ambassador appointed to woo tourists back to US", "is_relevant": false, "reason": "Soft politics — a tourism-promotion / personality angle on an appointment; no national-security or foreign-policy substance despite naming an 'ambassador'", "tags": [], "priority_score": 12, "primary_topic": "Governance, Elections & Domestic Stability", "category": "Tourism Promotion", "scope": "National/Domestic", "conflict_track": null, "region": "North America", "country": "United States", "country_pair": null, "proposed_topic": null},
    {"index": 6, "title": "Cholera outbreak spreads through flood-hit camps in Sudan", "is_relevant": true, "reason": "Public-health emergency compounding instability in a conflict-affected region", "tags": ["Public Health"], "priority_score": 47, "primary_topic": "Public Health, Disaster & Environmental Security", "category": "Cholera Outbreak", "scope": "Regional", "conflict_track": null, "region": "Africa", "country": "Sudan", "country_pair": null, "proposed_topic": null},
    {"index": 7, "title": "Wildfires force evacuations across southern California", "is_relevant": false, "reason": "Domestic natural disaster with no national-security dimension — scored low, but the SUBJECT is still a disaster so it keeps the real bucket (not the catch-all)", "tags": [], "priority_score": 18, "primary_topic": "Public Health, Disaster & Environmental Security", "category": "Wildfire", "scope": "National/Domestic", "conflict_track": null, "region": "North America", "country": "United States", "country_pair": null, "proposed_topic": null},
    {"index": 8, "title": "Manhunt underway after van rams Pride parade crowd in Berlin; officials cite Islamist motive", "is_relevant": true, "reason": "Mass-casualty attack on a public gathering with extremist framing — terrorism, not domestic crime, even in follow-up/manhunt coverage", "tags": ["Terrorism", "Europe"], "priority_score": 72, "primary_topic": "Terrorism, Insurgency & Non-State Armed Groups", "category": "Vehicle Ramming Attack", "scope": "National/Domestic", "conflict_track": null, "region": "Europe", "country": "Germany", "country_pair": null, "proposed_topic": null},
    {"index": 9, "title": "Top 10 summer beach reads", "is_relevant": false, "reason": "Lifestyle, no strategic angle", "tags": [], "priority_score": 5, "primary_topic": "Other / Emerging", "category": "Lifestyle", "scope": "Global/International", "conflict_track": null, "region": "Global", "country": null, "country_pair": null, "proposed_topic": null}
  ]
}`;

// Reference-only: the 1-100 priority bands encoded inline in the LEGACY
// analyzer prompt (LEGACY_ANALYZER_SYSTEM_PROMPT).
export const PRIORITY_BANDS: ReadonlyArray<{ min: number; max: number; label: string }> = [
  { min: 90, max: 100, label: 'CRITICAL - Immediate Action Required' },
  { min: 70, max: 89, label: 'HIGH PRIORITY - Daily Brief' },
  { min: 50, max: 69, label: 'MODERATE PRIORITY - Situational Awareness' },
  { min: 30, max: 49, label: 'LOW PRIORITY - Background Context' },
  { min: 1, max: 29, label: 'MINIMAL PRIORITY - Noise' },
];

// Reference-only: the 1-100 priority bands encoded inline in the NEW
// wider-aperture analyzer prompt (NEW_ANALYZER_SYSTEM_PROMPT). This is the
// ladder that reflects live behavior whenever USE_LEGACY_ANALYZER_PROMPT is
// off (the default) — see ACTIVE_PRIORITY_BANDS below for the one that
// tracks the live toggle.
export const NEW_PRIORITY_BANDS: ReadonlyArray<{ min: number; max: number; label: string; example: string }> = [
  { min: 95, max: 100, label: 'Strategic Alert', example: 'Active major combat threatening U.S. forces/allies, WMD/nuclear use or imminent threat' },
  { min: 85, max: 94, label: 'Critical', example: 'Major attacks on U.S. forces/allies/homeland, significant peer-adversary military moves' },
  { min: 70, max: 84, label: 'High', example: 'Theater-shaping developments, NDAA passage, statecraft coupled with active escalation' },
  { min: 50, max: 69, label: 'Moderate', example: 'Regional conflicts without direct U.S. involvement, sanctions/trade with strategic implications' },
  { min: 20, max: 49, label: 'Low', example: 'Routine policy/administrative/fiscal news, ordinary diplomatic color' },
];

// =============================================================================
// SCORING & RELEVANCE OVERSIGHT SURFACE (Task #622)
// =============================================================================
// Single source-of-truth changelog of past adjustments to the scoring/relevance
// rules on this page (thresholds + prompt re-orientations). This is a
// MAINTAINED, hand-written list — NOT an auto-computed diff across deploys.
// When you next change a knob here (or in scoreAdjustments.ts /
// subjectMatcher.ts), add a new entry at the TOP of this array so it ships
// with that same publish. Keep entries short and factual.
export interface RuleChangeLogEntry {
  date: string; // YYYY-MM-DD
  rule: string;
  change: string;
  reason: string;
}

export const RELEVANCE_RULE_CHANGELOG: readonly RuleChangeLogEntry[] = [
  {
    date: '2026-07-25',
    rule: 'Analyzer current-context awareness (ANALYZER_SYSTEM_PROMPT + strategicContext)',
    change: 'A dynamic CURRENT CONTEXT block (today\'s date + a strategic picture auto-derived from the last 48h of vetted high-priority reporting, refreshed ~30 min) is now appended to the main-feed analyzer prompt at call time; rubric calibration extended to forbid habitual favorite values and to demand 85-100 use for genuinely new combat developments in an active conflict; the 70-84 examples are now labeled as hypothetical patterns. Kill switch: ANALYZER_CONTEXT_DISABLED=1 reverts to the static prompt; optional ANALYZER_CONTEXT_NOTE adds a manual commander\'s note.',
    reason: 'Production audit (2026-07-25, during the active U.S.-Iran conflict) found the bot/RSS path clumping heavily on 55/65/72/75/88 and scoring new strikes on U.S. bases at 88 while the 95-100 Strategic Alert band sat empty, and the scraper path topping out at 82 — the dateless prompt applied peacetime caution and had no sense of the current situation',
  },
  {
    date: '2026-07-14',
    rule: 'Curated analysis/opinion/explainer score cap (CURATED_ANALYSIS_OPINION_CAP)',
    change: 'Deterministic cap-only backstop introduced at 69 for URL-detectable analysis/opinion/explainer/live-blog items; curated rubric 70-89 band calibrated with sub-band guidance (65-74 for analysis/commentary, 80-89 reserved for breaking/emergent events); developing-process vocabulary extended with reversal/walk-back/concession/counter-proposal for policy-proposal arcs; consumer-cyber-howto soft-cap group added at ≤49',
    reason: 'Override logs showed repeated editor down-pins of analysis/explainer pieces (scored 72-85), high-scored steady-state items (82-88), and a small-business cyber-fraud how-to; 44 manual links + 11 merges on US-Iran/Hormuz rolling story required extending process vocabulary to cover proposal-reaction-reversal arcs',
  },
  {
    date: '2026-06-01',
    rule: 'Analyzer rubric (ANALYZER_SYSTEM_PROMPT)',
    change: 'Re-oriented from the legacy CJCS daily-brief rubric to a wider national-security aperture that separates TOPIC from IMPORTANCE and re-bands priority scores (Strategic Alert 95-100 / Critical 85-94 / High 70-84 / Moderate 50-69 / Low 20-49)',
    reason: 'The legacy rubric conflated subject relevance with importance and clumped scores on round numbers; the new rubric scores consequence/urgency independent of topic and spreads scores across the range',
  },
  {
    date: '2026-05-18',
    rule: 'Main-feed auto-promotion bar (MAIN_FEED_PROMOTION_THRESHOLD)',
    change: 'Lowered from 66 to 50',
    reason: 'Items reaching this gate already passed the BOT_CJCS relevance screen, so everything is defense-relevant; the old 66 bar cut through the rubric\'s MODERATE band and stranded ~70% of genuinely feed-worthy moderate items in chat-only',
  },
  {
    date: '2026-05-18',
    rule: 'Unscored-bot fallback priority (UNSCORED_BOT_PRIORITY)',
    change: 'Collapsed-into-50 (and 60 for the social bot) default fixed to a uniform 30',
    reason: 'Items with no real AI score were defaulting to exactly the promotion-bar value, letting an un-scored item auto-promote onto the main feed on the default alone; 30 keeps it honestly in the LOW/background band until a real score is assigned',
  },
  {
    date: '2026-01-01',
    rule: 'Curated soft-politics cap (CURATED_SOFT_CAP)',
    change: 'Deterministic cap-only backstop introduced at 49',
    reason: 'Prompt guidance alone drifted on clearly-soft, non-strategic items (tourism/PR/routine appointments) that the analyzer nonetheless scored into a high band; the cap never raises a score and never touches human-set curated pins',
  },
];

/**
 * The priority-band ladder currently in effect for the live-active analyzer
 * prompt (tracks USE_LEGACY_ANALYZER_PROMPT so it never drifts from reality).
 */
export const ACTIVE_PRIORITY_BANDS = USE_LEGACY_ANALYZER_PROMPT ? PRIORITY_BANDS : NEW_PRIORITY_BANDS;

// Severity tone per ladder POSITION (index 0 = most severe). Both the legacy
// and new ladders are ordered most→least severe, so the oversight UI can color
// each band by POSITION rather than a hard-coded numeric cutoff (which would
// silently desync from the band ranges if a boundary ever moved — e.g. the new
// ladder's Critical band starts at 85, not 90). Read-only display metadata.
export const PRIORITY_BAND_TONES = ['critical', 'high', 'moderate', 'low', 'minimal'] as const;
export type PriorityBandTone = typeof PRIORITY_BAND_TONES[number];

// =============================================================================
// SCORING CALL-SITE AUDIT (Task #624)
// =============================================================================
// Every priority-scoring path in the app derives its rubric from the SINGLE
// exported ANALYZER_SYSTEM_PROMPT above (aliased as SYSTEM_PROMPT inside
// server/aiAnalyzer.ts). Both scoring entrypoints —
//   * analyzeBatchHeadlines()        (main scraper / headlines -> Classic/Visual)
//   * scoreHeadlinePrioritiesBatch() (news & RSS bot promotion -> main feed)
// read that same constant, so flipping USE_LEGACY_ANALYZER_PROMPT switches the
// rubric for ALL of them in lockstep. There is no per-path override anywhere, so
// there is no way for one pipeline to drift onto a different rubric than the one
// the oversight tab reports. `honorsActiveRubric` is therefore true for every
// entry; it is surfaced explicitly so the tab can prove (not just assert) that
// the global toggle actually governs each concrete scoring path.
//
// If a NEW scoring entrypoint is ever added that does NOT import
// ANALYZER_SYSTEM_PROMPT, add it here with honorsActiveRubric:false so the drift
// is visible in the oversight tab instead of hidden.
export interface ScoringCallSite {
  key: string;
  pipeline: string; // human-facing name of the feed path
  fn: string; // the scoring function it calls
  feeds: string; // what this scoring drives
  honorsActiveRubric: boolean; // true when it reads ANALYZER_SYSTEM_PROMPT (the toggle)
}

export const SCORING_CALL_SITES: readonly ScoringCallSite[] = [
  {
    key: 'mainScraper',
    pipeline: 'Main scraper / headlines feed',
    fn: 'analyzeBatchHeadlines()',
    feeds: 'Scores newly scraped headlines and manual team submissions that power the Classic and Visual (Stream) views.',
    honorsActiveRubric: true,
  },
  {
    key: 'botRss',
    pipeline: 'News & RSS bot promotion',
    fn: 'scoreHeadlinePrioritiesBatch()',
    feeds: 'Scores batches of bot/RSS articles to decide which get auto-promoted from Team chat onto the main feed.',
    honorsActiveRubric: true,
  },
];

/**
 * Builds the live scoring & relevance oversight payload from the canonical
 * constants/prompts in this module + the sibling rule modules. Read-only;
 * never mutates anything. A republish that changes any of these values is
 * reflected automatically since every field is derived live.
 */
export function getScoringRelevanceOverview() {
  const activeRubric = USE_LEGACY_ANALYZER_PROMPT ? ('legacy' as const) : ('new' as const);
  return {
    activeRubric,
    // Per-pipeline audit: which concrete scoring call site uses which rubric.
    // Each entry that honors the active rubric is stamped with it live, so the
    // tab can show that the global toggle actually governs that path (no drift).
    scoringCallSites: SCORING_CALL_SITES.map((s) => ({
      ...s,
      rubric: s.honorsActiveRubric ? activeRubric : ('other' as const),
    })),
    priorityBands: ACTIVE_PRIORITY_BANDS.map((b, i) => ({
      min: b.min,
      max: b.max,
      label: b.label,
      example: 'example' in b ? (b as { example: string }).example : undefined,
      tone: PRIORITY_BAND_TONES[Math.min(i, PRIORITY_BAND_TONES.length - 1)],
    })),
    relevanceGate: {
      summary: USE_LEGACY_ANALYZER_PROMPT
        ? 'Legacy CJCS daily-brief screen: admits stories bearing on U.S. national security strategy, Joint Force readiness, or critical domestic/global environments; explicitly rejects entertainment, sports, consumer tech, and routine local/finance/health/weather noise.'
        : 'Wide national-security aperture (defense, armed conflict, intelligence/cyber/space, foreign policy & alliances, adversary capabilities, economic/resource security, borders/transnational threats, governance & stability, strategic environment). Rejects pure noise: entertainment, consumer tech, isolated local crime, and routine domestic/business/health/weather stories with no security angle.',
      activeRubric: USE_LEGACY_ANALYZER_PROMPT ? 'Legacy CJCS rubric' : 'New wider-aperture rubric',
    },
    changelog: RELEVANCE_RULE_CHANGELOG,
    // Task #1094: watch-topic steering cross-reference. The mechanics here are
    // static descriptions of the live constants in watchTopicMatchCore /
    // curatedIngest; the live `enabled` flag is merged in by the
    // /api/team/scoring-relevance route (from watchTopicMatcher) so this
    // module stays dependency-free.
    watchSteering: {
      scope: 'curated-only' as const,
      mainFeedEnabled: false,
      note: 'On top of this base ladder, curated scores can be nudged upward by Priority/BOLO watch-topic steering: Priority matches boost toward floors of 60/66/72 (weak/standard/strong, +8/+15/+22 pts, capped at 85, never demoting), and BOLO matches rescue items the relevance filter would drop (budget: 5 rescues per intake pass, max 2 per topic). Steering affects the Curated lane only — main-feed steering is disabled by design.',
      floors: { weak: 60, standard: 66, strong: 72 },
      boosts: { weak: 8, standard: 15, strong: 22 },
      cap: 85,
      rescueBudget: { perPass: 5, perTopic: 2 },
    },
  };
}
