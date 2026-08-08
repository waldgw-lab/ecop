// =============================================================================
// SECURITY-CONTEXT RESCUE VOCABULARY (shared)
// =============================================================================
// Single source of truth for the deterministic, AI-free "does this text touch a
// defense/security context?" keyword check. Lives in `shared/` so both the
// server (Layer-1 scrape gate in server/scraper.ts, re-exported via
// server/relevanceDefinition.ts) and the client (Curated U.S. X Feed
// @rapidResponse47 keyword rescue) use the exact same list and matcher.
//
// The list is intentionally a touch inclusive — when used server-side the
// downstream AI layer is the backstop. Pure case-insensitive substring matching
// only, so the gate stays fast. Multi-word forms are used where a single bare
// word would over-match (e.g. "naval base", not bare "base").
export const SECURITY_CONTEXT_RESCUE_TERMS: readonly string[] = [
  // Conflict & force
  'war', 'warfare', 'conflict', 'invasion', 'invade', 'military', 'troops',
  'soldiers', 'armed forces', 'deployment', 'deployed', 'combat', 'airstrike',
  'missile', 'drone strike', 'warship', 'naval', 'fleet', 'fighter jet',
  'war game', 'mobiliz', 'ceasefire',
  // Named adversaries & actors
  'china', 'chinese', 'prc', 'beijing', 'russia', 'russian', 'kremlin',
  'moscow', 'iran', 'iranian', 'tehran', 'north korea', 'pyongyang',
  'hezbollah', 'hamas', 'houthi', 'wagner',
  // Flashpoints & geography
  'taiwan', 'strait of hormuz', 'ukraine', 'gaza', 'south china sea',
  'red sea', 'korean peninsula', 'black sea', 'west bank', 'lebanon',
  // Alliances & partners
  'nato', 'allies', 'allied', 'coalition', 'partner nation',
  // Security & statecraft
  'sanctions', 'embargo', 'blockade', 'national security', 'homeland security',
  'pentagon', 'defense', 'deterrence', 'cyberattack', 'espionage',
  // Installations
  'naval base', 'air base', 'military base', 'naval station', 'norfolk',
  // Crisis & humanitarian
  'humanitarian aid', 'evacuation', 'refugees',
];

// Pure-string check: does this text reference a security/defense context?
export function hasSecurityContext(text: string): boolean {
  const lower = (text || '').toLowerCase();
  return SECURITY_CONTEXT_RESCUE_TERMS.some((term) => lower.includes(term));
}
