// ---------------------------------------------------------------------------
// Shared escalation term lists + detectors (single source of truth).
//
// Two DIFFERENT detectors live here so the adversary / force vocabularies can
// never drift between the main feed and the curated lane:
//
//   1. matchesEscalationPattern (MAIN FEED, server/aiAnalyzer.ts) — the broad
//      "statecraft + active escalation" detector that keeps such a headline as
//      its OWN cluster representative so it can never inherit a weaker
//      neighbor's score. Three rubric patterns: (a) deal/negotiation + force;
//      (b) named adversary + U.S. ally/forces + force; (c) strategic chokepoint
//      + force. It is NOT a score floor.
//
//   2. matchesUsCoalitionCasualty (CURATED LANE, server/curatedCluster.ts +
//      server/curatedIncrementalAttach.ts) — a MUCH narrower, precision-first
//      signature for the qualitatively-new "first U.S./coalition KIA" class of
//      escalation: a named adversary's KINETIC attack that KILLS U.S./coalition
//      MILITARY PERSONNEL. It drives the deterministic curated "escalation
//      carve-out" (keep such an event as its OWN curated story rather than let
//      it be absorbed into a broad conflict umbrella) and the matching bridge
//      guard. It requires a personnel SUBJECT + fatality in a direction- and
//      circumstance-gated shape, so it never fires on "U.S. strikes Iran" (no
//      U.S. casualties) or "Iranian commander killed in U.S. strike" (reversed).
// ---------------------------------------------------------------------------

// Broad force / attack / threat vocabulary (main-feed pattern).
export const ESCALATION_FORCE = /\b(strikes?|striking|struck|attacks?|attacking|attacked|missiles?|ballistic|rocket|rockets|drones?|bomb(?:s|ed|ing)?|shell(?:s|ed|ing)?|fire[sd]?|firing|launch(?:es|ed|ing)?|invad(?:e|es|ed|ing)|incursion|blockad(?:e|es|ed|ing)|seiz(?:e|es|ed|ing)|kill(?:s|ed|ing)?|military|troops|warship|warships|naval|flotilla|threaten(?:s|ed|ing)?|threat|warns?|warned|nuclear strike|use of force)\b/i;
export const ESCALATION_DEAL = /\b(deal|talks|negotiation|negotiations|negotiating|ceasefire|cease-fire|truce|denuclearization|denuclearisation|summit|diplomacy|diplomatic|accord|treaty|peace plan|nuclear deal)\b/i;
export const ESCALATION_ADVERSARY = /\b(iran|iranian|iran-backed|russia|russian|china|chinese|north korea|north korean|pyongyang|houthi|houthis|hezbollah|hamas|moscow|beijing|tehran|prc)\b/i;
export const ESCALATION_ALLY = /\b(israel|israeli|taiwan|taiwanese|south korea|south korean|nato|poland|polish|japan|japanese|philippine|philippines|ukraine|ukrainian|u\.s\.|us forces|u\.s\. forces|american forces|gulf base|gulf bases|allied)\b/i;
export const ESCALATION_CHOKEPOINT = /\b(strait of hormuz|hormuz|bab[ -]el[ -]mandeb|bab[ -]al[ -]mandab|suez|panama canal|red sea|strait of malacca|malacca|taiwan strait|persian gulf|gulf of oman)\b/i;

// True when a headline expresses statecraft coupled with active escalation, per
// the three rubric patterns: (a) a deal/negotiation co-occurring with force;
// (b) a named adversary using/threatening force against a U.S. ally or forces;
// (c) a threat/attack against a strategic chokepoint or waterway.
export function matchesEscalationPattern(title: string): boolean {
  const t = title || '';
  const hasForce = ESCALATION_FORCE.test(t);
  // (a) deal/negotiation + force.
  if (hasForce && ESCALATION_DEAL.test(t)) return true;
  // (b) named adversary + ally/U.S. forces + force.
  if (hasForce && ESCALATION_ADVERSARY.test(t) && ESCALATION_ALLY.test(t)) return true;
  // (c) strategic chokepoint + force/threat.
  if (hasForce && ESCALATION_CHOKEPOINT.test(t)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// CURATED "U.S./coalition casualty" signature (precision-first).
//
// Building blocks:
//   - US_MIL      — a U.S./coalition military qualifier ("U.S.", "American",
//                   "allied", "coalition", "NATO"). Bare "U.S." alone is NOT
//                   enough; it must qualify a PERSONNEL noun below.
//   - PERSONNEL   — a HUMAN military noun (service members / troops / soldiers /
//                   marines / sailors / airmen / personnel / contractors).
//                   "forces" is deliberately EXCLUDED — "U.S. forces killed X"
//                   is actor-ambiguous, whereas "U.S. troops killed" is the
//                   people being killed.
//   - FATAL       — a DEATH term (killed / dead / slain / KIA / died / deaths /
//                   fatalities). "casualties"/"wounded" are excluded on purpose:
//                   the signature marks the first-KIA magnitude, not injuries.
//   - KINETIC     — an attack mechanism (strike / attack / missile / drone /
//                   rocket / shelling / blast / raid / ambush). Requiring this
//                   (plus a named adversary) stops an incidental adversary
//                   mention in a non-combat death from matching.
//
// Direction + circumstance gating (this is the whole point):
//   - FORWARD ("<US personnel> ... killed IN/BY/DURING ... | end") — the
//     personnel are the SUBJECT and the fatality is followed by a circumstance
//     word or a terminator, so "U.S. troops killed 30 militants" (an OBJECT
//     follows "killed") does NOT match — the troops are the killers there.
//   - BACKWARD ("killed <quantifier> <US personnel>") — a quantifier must sit
//     directly before the personnel ("killed two U.S. soldiers"); this excludes
//     "killed BY U.S. soldiers" (no quantifier, and "by" makes them the killers)
//     and "killed in a U.S. strike" (no quantifier, no personnel noun).
// ---------------------------------------------------------------------------
const US_MIL = '(?:u\\.?\\s?s\\.?|american|allied|coalition|nato)';
const PERSONNEL = '(?:service\\s?members?|servicemen|troops?|soldiers?|marines?|sailors?|airmen|airman|personnel|contractors?)';
const FATAL = '(?:killed(?:\\s+in\\s+action)?|dead|slain|kia|die[sd]?|dying|deaths?|fatally\\s+(?:wounded|shot|struck))';
const CIRCUMSTANCE = '(?:in|into|during|after|by|when|amid|near|at|following|as|from|aboard|outside)';
const QUANT = '(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozens?|several|multiple|numerous)';

// A named adversary's KINETIC attack — narrower than ESCALATION_FORCE (which
// includes "killed"/"troops"/"military"), so the attack mechanism must be named.
const KINETIC = /\b(strikes?|striking|struck|attacks?|attacked|attacking|assault(?:s|ed|ing)?|offensive|missiles?|ballistic|rocket|rockets|drones?|bomb(?:s|ed|ing)?|shell(?:s|ed|ing)?|shelling|bombardment|blast|explosion|explosive|ied|ambush(?:ed|es)?|raid(?:s|ed)?|barrage|air\s?strikes?)\b/i;

// personnel-SUBJECT then fatality, gated by a trailing circumstance/terminator.
const US_KIA_FORWARD = new RegExp(
  `\\b${US_MIL}\\s+${PERSONNEL}\\b\\s+(?:were\\s+|are\\s+|was\\s+|reportedly\\s+|apparently\\s+|among\\s+(?:those|the\\s+dead)\\s+)*${FATAL}\\b(?=\\s+${CIRCUMSTANCE}\\b|\\s*[,.;:!?—-]|\\s*$)`,
  'i',
);
// fatality then a quantifier then the personnel-OBJECT ("killed two U.S. soldiers").
const US_KIA_BACKWARD = new RegExp(
  `\\b(?:killed|killing|left\\s+dead|claimed\\s+the\\s+lives\\s+of)\\b\\s+(?:at\\s+least\\s+|as\\s+many\\s+as\\s+|up\\s+to\\s+|nearly\\s+)?${QUANT}\\s+${US_MIL}\\s+${PERSONNEL}\\b`,
  'i',
);

/**
 * CURATED-LANE detector: does this text describe a named adversary's kinetic
 * attack that KILLED U.S./coalition military personnel (the "first U.S. KIA"
 * escalation class)? Pass title alone, or title + body snippet for more recall.
 * Deterministic + pure (no live LLM) so it is fully gate-testable.
 */
export function matchesUsCoalitionCasualty(text: string | null | undefined): boolean {
  const t = text || '';
  if (!t) return false;
  // Must involve a named adversary AND a named attack mechanism...
  if (!ESCALATION_ADVERSARY.test(t)) return false;
  if (!KINETIC.test(t)) return false;
  // ...and a direction/subject-gated U.S./coalition fatality.
  return US_KIA_FORWARD.test(t) || US_KIA_BACKWARD.test(t);
}
