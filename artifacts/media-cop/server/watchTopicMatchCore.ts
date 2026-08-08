// ---------------------------------------------------------------------------
// PURE watch-topic matching core — NO imports, NO database, NO side effects.
//
// This is the single source of truth for the deterministic Priority/BOLO
// keyword gate. It is consumed by:
//   • server/watchTopicMatcher.ts  — scrape hot-path steering (re-exports this)
//   • server/joePriorityMatcher.ts — the AI submission tagger's keyword gate
//   • server/migrate.ts            — the boot-time mis-tag heal
//   • scripts/watch-topic-priority.test.ts — the CI gate
//
// It is kept dependency-free ON PURPOSE: migrate.ts runs against its own pool
// (and is replayed standalone against an empty schema by .local/verify-migrate)
// so it must never transitively import server/db.ts.
//
// SYMMETRY INVARIANT: the tagger gates on the submission HEADLINE ONLY, and the
// boot heal clears assignments whose HEADLINE fails the same gate. If either
// side ever widens to summary text while the other does not, tag→heal→re-tag
// flip-flop loops appear. Keep both sides on matchesTopic(gate, headline).
// ---------------------------------------------------------------------------

// Generic words that must never match on their own.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'at', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'he', 'she', 'they', 'them',
  'his', 'her', 'their', 'we', 'you', 'new', 'news', 'says', 'said', 'will',
  'has', 'have', 'had', 'not', 'after', 'over', 'into', 'out', 'up', 'down',
  'about', 'more', 'than', 'also', 'amid', 'what', 'how', 'why', 'when',
]);

// Short single-token keywords are rejected as too generic UNLESS they are a
// known distinctive proper noun / acronym. Longer single tokens (>= 7 chars)
// are treated as distinctive on their own.
const SOLO_TOKEN_ALLOWLIST = new Set([
  'nato', 'centcom', 'norad', 'indopacom', 'africom', 'eucom', 'southcom',
  'northcom', 'potus', 'isis', 'isil', 'houthi', 'hamas', 'hezbollah',
  'taliban', 'wagner', 'china', 'russia', 'iran', 'israel', 'ukraine',
  'taiwan', 'gaza', 'korea', 'pyongyang', 'kremlin', 'pentagon', 'putin',
  'zelensky', 'netanyahu', 'quds',
]);
const SOLO_TOKEN_MIN_LEN = 7;

// UK -> US spelling fold, applied token-wise on BOTH the compiled keywords and
// the matched headline so "defence bill" (Al Jazeera/Guardian house style) hits
// a "Defense Spending Bill" topic. Deliberately tiny: only spellings that
// actually appear in wire/outlet headlines for defense coverage.
const SPELLING_FOLD: Record<string, string> = {
  defence: 'defense',
  defences: 'defenses',
  offence: 'offense',
  programme: 'program',
  programmes: 'programs',
  labour: 'labor',
  armour: 'armor',
  centre: 'center',
};

// Max distinctive keywords considered per topic + max topics credited per
// headline — bounds work and blast radius even with many active topics.
const MAX_KEYWORDS_PER_TOPIC = 12;
const MAX_TOPICS_PER_HEADLINE = 3;
// Cap on the 2-of-N token pool (keywords + phrase parts + name tokens).
const MAX_TOKENS_PER_TOPIC = 24;

// A compiled boolean "term" from one of the three keyword boxes.
// Terms wrapped in parentheses are treated as exact phrases (substring match);
// otherwise the term is normalized and matched as a token.
export interface CompiledBoolTerm {
  phrase?: string; // exact-phrase (parenthesized input)
  token?: string;  // single normalized token
}

export interface CompiledWatchTopic {
  id: string;
  name: string;
  isPriorityWatch: boolean;
  isBoloWatch: boolean;
  phrases: string[];     // multi-token keywords; substring match => hit
  soloTokens: string[];  // distinctive single tokens; one hit => match
  tokens: string[];      // supporting single tokens; need >= 2 distinct hits
  // Boolean keyword boxes (Task #1039). Empty arrays = no-op (fall through to AI gate).
  orTerms: CompiledBoolTerm[];  // Box 1 — any match = OR-rule satisfied
  andTerms: CompiledBoolTerm[]; // Box 2 — ALL must match = AND-rule satisfied
  notTerms: CompiledBoolTerm[]; // Box 3 — any match = global veto
  boostStrength: 'weak' | 'standard' | 'strong';
}

// Minimal structural shape of a team_subjects row that compilation needs.
// Kept loose (nullables allowed) so both drizzle rows and raw SQL rows fit.
export interface WatchTopicSource {
  id: string;
  name: string;
  isPriorityWatch?: boolean | null;
  isBoloWatch?: boolean | null;
  watchKeywords?: string[] | null;
  // Task #1039 additions (all optional / nullable for backward compat).
  orKeywords?: string[] | null;
  andKeywords?: string[] | null;
  notKeywords?: string[] | null;
  boostStrength?: string | null;
}

export function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(tok => SPELLING_FOLD[tok] || tok)
    .join(' ');
}

// Compile a topic into its deterministic match gate.
//
// Sources of match signal, in decreasing strength:
//   1. Multi-word watchKeywords            -> phrases (substring hit = match)
//   2. Distinctive single-word keywords    -> soloTokens (one hit = match)
//   3. Supporting tokens                   -> tokens (>= 2 DISTINCT hits = match)
//
// The 2-of-N token pool (3) is fed from THREE places:
//   • short single-word keywords (4-6 chars, e.g. "fy27"),
//   • the constituent words of each keyword PHRASE (e.g. "pentagon budget"
//     contributes "pentagon" + "budget"), and
//   • the topic NAME's own words (e.g. "Defense Spending Bill" contributes
//     "defense" + "spending" + "bill").
// This is what lets "Senate Dems block defense bill" or "must-pass Pentagon
// bill" match a Defense Spending Bill topic even though no literal keyword
// appears — while a single stray hit ("Pentagon issues drone handbook",
// "Russia sanctions bill") still rejects. Name/phrase-part words are NEVER
// promoted to solo tokens: "defense" alone matching everything is exactly the
// over-match this gate exists to prevent.
// Compile one term from a boolean keyword box. Parentheses → exact-phrase match;
// otherwise normalize and use as a single token match.
const BOOL_TERM_CAP = 12; // max terms per box

function compileBoolTerm(raw: string): CompiledBoolTerm | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Exact-phrase: strip the outer parens and normalize the inner text.
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    const inner = normalize(trimmed.slice(1, -1));
    if (inner.length < 2) return null;
    return { phrase: inner };
  }
  // Single-token (after normalization). Multi-word un-parenthesized inputs are
  // treated as a single phrase (same as parenthesized) for user convenience.
  const normed = normalize(trimmed);
  if (!normed) return null;
  const parts = normed.split(' ').filter(Boolean);
  if (parts.length >= 2) return { phrase: normed };
  const tok = parts[0];
  if (!tok) return null;
  return { token: tok };
}

export function compileWatchTopic(t: WatchTopicSource): CompiledWatchTopic {
  const phrases: string[] = [];
  const soloTokens: string[] = [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  const seenTokens = new Set<string>();

  const addSupportToken = (tok: string) => {
    if (!tok || tok.length < 4 || STOPWORDS.has(tok) || seenTokens.has(tok)) return;
    if (tokens.length >= MAX_TOKENS_PER_TOPIC) return;
    seenTokens.add(tok);
    tokens.push(tok);
  };

  for (const raw of (t.watchKeywords || []).slice(0, MAX_KEYWORDS_PER_TOPIC)) {
    const kw = normalize(raw);
    if (!kw || seen.has(kw)) continue;
    seen.add(kw);
    const parts = kw.split(' ').filter(Boolean);
    if (parts.length >= 2) {
      if (kw.length >= 4) {
        phrases.push(kw);
        // Phrase constituents feed the 2-of-N pool.
        for (const p of parts) addSupportToken(p);
      }
    } else {
      const tok = parts[0];
      if (!tok || STOPWORDS.has(tok)) continue;
      if (SOLO_TOKEN_ALLOWLIST.has(tok) || tok.length >= SOLO_TOKEN_MIN_LEN) {
        soloTokens.push(tok);
      } else {
        addSupportToken(tok);
      }
    }
  }

  // Topic NAME words feed the 2-of-N pool (never solo).
  for (const tok of normalize(t.name).split(' ').filter(Boolean)) {
    addSupportToken(tok);
  }

  // Compile boolean keyword boxes (Task #1039). Each box is independently
  // compiled so empty arrays are a transparent no-op.
  const compileBoolBox = (raw: string[] | null | undefined): CompiledBoolTerm[] => {
    if (!raw || raw.length === 0) return [];
    const out: CompiledBoolTerm[] = [];
    for (const r of raw.slice(0, BOOL_TERM_CAP)) {
      const t = compileBoolTerm(r);
      if (t) out.push(t);
    }
    return out;
  };

  const rawBoost = t.boostStrength;
  const boostStrength: 'weak' | 'standard' | 'strong' =
    rawBoost === 'weak' ? 'weak' : rawBoost === 'strong' ? 'strong' : 'standard';

  return {
    id: t.id,
    name: t.name,
    isPriorityWatch: !!t.isPriorityWatch,
    isBoloWatch: !!t.isBoloWatch,
    phrases,
    soloTokens,
    tokens,
    orTerms: compileBoolBox(t.orKeywords),
    andTerms: compileBoolBox(t.andKeywords),
    notTerms: compileBoolBox(t.notKeywords),
    boostStrength,
  };
}

// A compiled topic can only ever match if it has at least one phrase, one solo
// token, or two supporting tokens (the 2-of-N rule needs two distinct hits),
// OR it has at least one usable boolean keyword box term (Task #1039).
export function hasKeywordGate(t: CompiledWatchTopic): boolean {
  return (
    t.phrases.length > 0 ||
    t.soloTokens.length > 0 ||
    t.tokens.length >= 2 ||
    t.orTerms.length > 0 ||
    t.andTerms.length > 0
  );
}

// Match a single compiled bool-term against the normalized hay and token set.
function matchesBoolTerm(term: CompiledBoolTerm, hay: string, hayTokens: Set<string>): boolean {
  if (term.phrase !== undefined) return hay.includes(term.phrase);
  if (term.token !== undefined) return hayTokens.has(term.token);
  return false;
}

// Evaluate boolean NOT box: true if any NOT term matches (veto).
function matchesNotBox(notTerms: CompiledBoolTerm[], hay: string, hayTokens: Set<string>): boolean {
  for (const t of notTerms) {
    if (matchesBoolTerm(t, hay, hayTokens)) return true;
  }
  return false;
}

// Evaluate the user OR/AND rule (Box 1 + Box 2 combined).
// Returns true if (orBox satisfied OR no orTerms) AND (andBox satisfied OR no andTerms)
// AND at least one box is non-empty (empty both boxes = rule does not fire).
function matchesUserOrAndRule(
  orTerms: CompiledBoolTerm[],
  andTerms: CompiledBoolTerm[],
  hay: string,
  hayTokens: Set<string>,
): boolean {
  if (orTerms.length === 0 && andTerms.length === 0) return false;
  const orOk = orTerms.length === 0 || orTerms.some(t => matchesBoolTerm(t, hay, hayTokens));
  const andOk = andTerms.length === 0 || andTerms.every(t => matchesBoolTerm(t, hay, hayTokens));
  return orOk && andOk;
}

function matchesAiKeywordGate(t: CompiledWatchTopic, hay: string, hayTokens: Set<string>): boolean {
  for (const p of t.phrases) {
    if (hay.includes(p)) return true;
  }
  for (const tok of t.soloTokens) {
    if (hayTokens.has(tok)) return true;
  }
  let hits = 0;
  for (const tok of t.tokens) {
    if (hayTokens.has(tok)) {
      hits++;
      if (hits >= 2) return true;
    }
  }
  return false;
}

// Overall match contract (Task #1039):
//   (AI keyword gate OR user OR/AND rule) AND NOT(notBox)
// - If notTerms is empty the NOT box never fires.
// - If orTerms and andTerms are both empty the user rule does not fire and
//   the result falls through to the AI keyword gate alone (legacy behavior).
function matchesCompiled(t: CompiledWatchTopic, hay: string, hayTokens: Set<string>): boolean {
  // NOT is a hard global veto regardless of any positive match.
  if (t.notTerms.length > 0 && matchesNotBox(t.notTerms, hay, hayTokens)) return false;
  // Positive match: AI gate OR user boolean rule.
  return matchesAiKeywordGate(t, hay, hayTokens) || matchesUserOrAndRule(t.orTerms, t.andTerms, hay, hayTokens);
}

// Single-topic gate check on a headline. This is THE function both the AI
// tagger (pre-gate) and the boot heal (clear decision) must use — see the
// symmetry invariant at the top of this file.
export function matchesTopic(t: CompiledWatchTopic, title: string, summary?: string): boolean {
  const hay = normalize(`${title || ''} ${summary || ''}`);
  if (!hay) return false;
  return matchesCompiled(t, hay, new Set(hay.split(' ').filter(Boolean)));
}

export interface WatchMatch {
  priorityTopicIds: string[];
  boloTopicIds: string[];
}

// Synchronous, AI-free match of a headline (+ optional summary) against the
// pre-loaded active watch topics.
export function matchWatchTopics(
  topics: CompiledWatchTopic[],
  title: string,
  summary?: string,
): WatchMatch {
  const priorityTopicIds: string[] = [];
  const boloTopicIds: string[] = [];
  if (!topics.length) return { priorityTopicIds, boloTopicIds };

  const hay = normalize(`${title || ''} ${summary || ''}`);
  if (!hay) return { priorityTopicIds, boloTopicIds };
  const hayTokens = new Set(hay.split(' ').filter(Boolean));

  let matchedCount = 0;
  for (const t of topics) {
    if (matchedCount >= MAX_TOPICS_PER_HEADLINE) break;
    if (matchesCompiled(t, hay, hayTokens)) {
      matchedCount++;
      if (t.isPriorityWatch) priorityTopicIds.push(t.id);
      if (t.isBoloWatch) boloTopicIds.push(t.id);
    }
  }
  return { priorityTopicIds, boloTopicIds };
}

// Bounded rescue budget shared across a single scrape/poll cycle so a noisy run
// can't flood the feed: at most `max` total BOLO rescues, `maxPerTopic` each.
export interface RescueBudget {
  consume(topicIds: string[]): boolean;
  readonly used: number;
}

export function createRescueBudget(max = 5, maxPerTopic = 2): RescueBudget {
  const perTopic = new Map<string, number>();
  let used = 0;
  return {
    consume(topicIds: string[]): boolean {
      if (used >= max) return false;
      for (const id of topicIds) {
        const c = perTopic.get(id) || 0;
        if (c < maxPerTopic) {
          perTopic.set(id, c + 1);
          used++;
          return true;
        }
      }
      return false;
    },
    get used() { return used; },
  };
}

// Apply the moderate Priority-watch boost to a base score: pull a matched
// headline up to a floor of 66, never above 85, and never more than +15 over
// its analyzed score — a nudge, not a pin. The final Math.max guarantees the
// boost can only ever raise a score: an article that already earned more than
// 85 on its own merits is left untouched, never demoted by matching a watch.
// Standard strength — keeps the pre-Task-#1039 behavior unchanged.
export function applyPriorityBoost(score: number): number {
  const nudged = Math.min(Math.max(score, 66), Math.min(score + 15, 85));
  return Math.max(score, nudged);
}

// Parameterized boost by strength (Task #1039). All strengths share the same
// hard ceiling (85) and the same "never demotes" guarantee. Standard reproduces
// the behavior of applyPriorityBoost() exactly, preserving backward compat.
//   weak:     floor 60, bounded +8,  cap 85
//   standard: floor 66, bounded +15, cap 85  (unchanged from applyPriorityBoost)
//   strong:   floor 72, bounded +22, cap 85
export function applyPriorityBoostWithStrength(
  score: number,
  strength: 'weak' | 'standard' | 'strong' = 'standard',
): number {
  const BOOST_PARAMS = {
    weak:     { floor: 60, maxNudge:  8, cap: 85 },
    standard: { floor: 66, maxNudge: 15, cap: 85 },
    strong:   { floor: 72, maxNudge: 22, cap: 85 },
  } as const;
  const { floor, maxNudge, cap } = BOOST_PARAMS[strength];
  const nudged = Math.min(Math.max(score, floor), Math.min(score + maxNudge, cap));
  return Math.max(score, nudged);
}
