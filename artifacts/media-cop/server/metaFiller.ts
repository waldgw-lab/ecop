// =============================================================================
// Meta-filler bullet detection (curated card quality). PURE — no DB, no AI, no
// imports — so it is safely shared by the enrichment writers (streamPrefetch),
// the story synthesizer (curatedSynthesis), the boot-time data heal (migrate),
// and the CI gate without any import-cycle or side-effect risk.
//
// PROBLEM: when the per-article summarizer is forced to produce a fixed number
// of bullets from a thin article excerpt, it pads with META-COMMENTARY about
// the excerpt itself instead of news, e.g.:
//   "The article does not provide further details on the nature of the strikes."
//   "Previous US actions against Iran were not specified in the excerpt."
//   "No attributed claims were found in the provided text."
//   "The provided text is a browser compatibility notice rather than an article."
//   "The article is a placeholder and does not contain substantive news content."
// These are not refusals (isAIRefusalText correctly ignores them — they are
// third-person and article-subject), but they are filler that must never be
// stored or rendered as a summary bullet, a synthesis fact, or a claim.
//
// FALSE-POSITIVE DISCIPLINE (see the paired gate): in defense news, lines about
// *people/institutions* declining to give detail are REAL reporting and must
// NEVER match:
//   "Officials did not provide further details."          (subject = officials)
//   "The Pentagon said it cannot provide details."        (attributed)
//   "The report does not name the officials involved."    (report = a document
//        the article covers — genuine content, so "report" is NOT a subject here)
//   "The text of the agreement does not specify enforcement." (document text)
//   "I would need Article 5 assurances" / "source protection" (bare "article")
// So the subject nouns are restricted to the SUMMARIZED MATERIAL itself
// (article / excerpt / article text / provided text / given text) — never
// "report", "document", "text" (bare), "source" (an anonymous source), or any
// person/organization. "provided text" and "given text" are allowed as subjects
// because the two-word qualifier specifically identifies the fed material, unlike
// bare "text" which appears in real reporting ("the text of the agreement…").
// =============================================================================

// SUBJECT: the names the AI uses for the material it was asked to summarize.
// Includes "provided text" / "given text" (two-word qualified form) as subjects
// because these unambiguously refer to the input material, unlike bare "text"
// which also appears in genuine reporting ("the text of the agreement…").
const SUBJECT = String.raw`(?:news\s+)?(?:article(?:['']s)?(?:\s+(?:excerpt|text))?|excerpt|article\s+excerpt|(?:provided|given)\s+text)`;

const META_FILLER_PATTERNS: RegExp[] = [
  // ── Existing families ────────────────────────────────────────────────────

  // Subject-anchored: "The/This article|excerpt does not provide/specify/…".
  // Anchored at line start so attributed sentences ("Officials said the article
  // does not…" is implausible, but e.g. "Critics said the article does not…"
  // stays safely unmatched).
  new RegExp(
    String.raw`^(?:the|this)\s+(?:provided\s+|given\s+)?${SUBJECT}\s+(?:does\s+not|doesn['']?t|did\s+not|didn['']?t)\s+(?:provide|specify|mention|include|contain|offer|give|state|detail|elaborate|clarify|indicate|identify|name|say|reveal|disclose)\b`,
    'i',
  ),
  // Subject-anchored lack/omission: "The article lacks further details…".
  new RegExp(String.raw`^(?:the|this)\s+(?:provided\s+|given\s+)?${SUBJECT}\s+(?:lacks?|omits?)\b`, 'i'),
  // Trailing-reference: "… not specified/mentioned/provided/available in the excerpt".
  // "available" added: "No supplemental information is available in the excerpt."
  new RegExp(
    String.raw`\bnot\s+(?:specified|mentioned|provided|detailed|stated|included|given|clarified|identified|named|disclosed|available)\s+in\s+the\s+(?:provided\s+|given\s+)?${SUBJECT}\b`,
    'i',
  ),
  // "No further/additional details (were) provided in the article/excerpt."
  // The linking verb is optional — the model also emits the elliptical form
  // "No further details provided in the excerpt." The trailing
  // "in the article/excerpt" subject anchor still carries the precision.
  // Broadened nouns: background context, supplemental information.
  // Intervening phrase tolerated: "No further details on the reversal were
  // provided in the excerpt" — the optional clause captures "on the reversal".
  new RegExp(
    String.raw`\bno\s+(?:further|additional|supplemental|other|specific)\s+(?:details?|information|context|background(?:\s+context)?|supplemental\s+information)\s+(?:(?:about|on|of|regarding|concerning|related\s+to|for)\s+\w[\w\s,''\-]{0,40})?\s*(?:(?:is|are|was|were)\s+)?(?:provided|available|given|mentioned|included)\s+in\s+the\s+(?:provided\s+|given\s+)?${SUBJECT}\b`,
    'i',
  ),
  // Compound-noun variants that carry no preceding adjective:
  //   "No background context was provided in the article."
  //   "No supplemental information is available in the excerpt."
  // The compound noun itself is the clear filler indicator, so the adjective
  // prefix is not required. Intervening phrase and optional linking verb same
  // as the pattern above.
  new RegExp(
    String.raw`\bno\s+(?:background\s+(?:context|information)|supplemental\s+(?:information|context))\s+(?:(?:about|on|of|regarding|concerning|related\s+to|for)\s+\w[\w\s,''\-]{0,40})?\s*(?:(?:is|are|was|were)\s+)?(?:provided|available|given|mentioned|included)\s+in\s+the\s+(?:provided\s+|given\s+)?${SUBJECT}\b`,
    'i',
  ),

  // ── New family 1: empty-claims announcements ─────────────────────────────
  // "No attributed claims were found/extracted/identified…" (standalone sentence)
  // Anchored at line start to avoid matching embedded quotes about claims
  // found/not-found in some unrelated report ("officials said no attributed
  // claims were logged…" — but that starts with an attribution, not "No").
  new RegExp(
    String.raw`^no\s+(?:clearly\s+)?attributed\s+claims?\s+(?:(?:were?|can\s+be|could\s+be|has\s+been|have\s+been)\s+)?(?:found|extracted|identified|located|provided|present|available)\b`,
    'i',
  ),
  // "This article contains no attributed claims" /
  // "The excerpt does not contain any attributed claims"
  new RegExp(
    String.raw`^(?:the|this)\s+(?:provided\s+|given\s+)?${SUBJECT}\s+(?:contains?\s+no\s+(?:clearly\s+)?attributed\s+claims?|(?:does\s+not|doesn['']?t)\s+contain\s+(?:any\s+)?(?:clearly\s+)?attributed\s+claims?)`,
    'i',
  ),
  // "This article contains no attributed claims" without the subject anchor
  // (model sometimes drops "The" and writes "This article contains no…").
  new RegExp(
    String.raw`^this\s+article\s+contains?\s+no\s+(?:clearly\s+)?attributed\s+claims?\b`,
    'i',
  ),

  // ── New family 2: junk-source descriptions ───────────────────────────────
  // The AI describing the fed source as non-article content:
  //   "The provided text is a browser compatibility notice rather than an article."
  //   "The provided text appears to be a navigation menu, not a news article."
  //   "The provided text is in Persian and cannot be summarized."
  // Uses "provided/given text" subjects (the extended SUBJECT above) plus the
  // broader "content/material/excerpt/source material" synonyms the model uses.
  // Stopped before the predicate noun to avoid needing an exhaustive list of
  // junk types — the subject ("provided text is…") is already the high-signal
  // anchor; real news bullets never open with "The provided text is".
  new RegExp(
    String.raw`^(?:the|this)\s+(?:provided|given)\s+(?:text|content|material|excerpt|source(?:\s+material)?)\s+(?:is|appears?\s+to\s+be)\b`,
    'i',
  ),

  // ── New family 3: placeholder / no substantive content ───────────────────
  // The AI noting the article is a stub, placeholder, or has no real news.
  //   "The article is a placeholder and does not contain substantive news content."
  //   "This article is a placeholder."
  //   "This article contains no substantive news content."
  //   "The article does not contain any substantive news content."
  //   "The excerpt is a stub with no substantive content."
  // Subject-anchored to only catch the AI describing the SUMMARIZED MATERIAL,
  // not real reporting ("The bill contains no substantive policy changes" = news).
  new RegExp(
    String.raw`^(?:the|this)\s+(?:provided\s+|given\s+)?${SUBJECT}\s+(?:is\s+a\s+(?:placeholder|stub|draft|boilerplate|filler)(?:\b[^.]{0,60})?|(?:does\s+not|doesn['']?t)\s+contain\s+(?:any\s+)?substantive\s+(?:news\s+)?content\b|contains?\s+no\s+substantive\s+(?:news\s+)?content\b|is\s+not\s+a\s+(?:real|genuine|complete|full)\s+(?:news\s+)?article\b)`,
    'i',
  ),
  // Standalone / leading-assertion forms — anchored to the line start so they
  // only match when the AI opens the bullet with the negative assertion, NOT
  // when "no substantive news content" is embedded in real political reporting
  // (e.g. "Sen. Cruz argued the bill has no substantive news content…").
  //   "No substantive news content in this article."   → starts with "No"
  //   "No substantive news content was found."         → starts with "No"
  new RegExp(String.raw`^no\s+substantive\s+news\s+content\b`, 'i'),
  //   "There is no substantive news content in this article."
  new RegExp(
    String.raw`^there\s+(?:is|are|was|were)\s+no\s+substantive\s+news\s+content\b`,
    'i',
  ),

  // ── New family 4: vacuous attribution + date-restatement ─────────────────
  // The AI writing the publication date of the source article as if it were a
  // news fact (pure meta-commentary about the summarized document, never news).
  //   "The article was published on July 16, 2026."
  //   "This directive comes from sources, with the article published on July 16."
  //   "The article is published on Monday."
  // Two anchors:
  //   a) Subject = "the/this article" — narrow enough to skip real reporting
  //      ("The bill was published on Tuesday" → not an "article" meta-marker).
  //   b) Trailing ", with the article published on …" — compound-sentence form.
  //      This trailing clause always makes the whole line a date-restatement.
  new RegExp(
    String.raw`\bthe\s+article\s+(?:was\s+|is\s+|has\s+been\s+)?published\s+on\b`,
    'i',
  ),
  new RegExp(
    String.raw`\bwith\s+the\s+article\s+published\s+on\b`,
    'i',
  ),
  // Content-free source attribution: "This directive/information/content comes
  // from sources" as the SOLE assertion. The model occasionally writes the
  // document provenance as a bullet rather than any news fact.
  //   "This directive comes from sources."
  //   "The information comes from the article."
  //   "This content comes from a news report."
  // Subject anchor restricts to article-like nouns (directive, information,
  // content, report, article, story, piece, news, data) so "NATO funding comes
  // from member states" and similar real facts are never flagged.
  new RegExp(
    String.raw`^(?:this|the)\s+(?:directive|information|content|report|article|story|piece|news\s+content|data)\s+comes\s+from\b`,
    'i',
  ),
];

// ---------------------------------------------------------------------------
// Editorial/spin detection helpers — separate from META_FILLER_PATTERNS so
// the combined check (spin pattern AND no attribution) can be expressed cleanly.
// ---------------------------------------------------------------------------

// Standard attribution markers. A line that contains one of these is attributed
// reporting (real news), even when it also uses evaluative language.
// e.g. "Officials said the chaos brought them no closer to agreement" = real news.
const HAS_ATTRIBUTION_RE =
  /\b(?:said|say|says|saying|stated|announced|confirmed|reported|according\s+to|warned|noted|claimed|added|told|acknowledged|admitted|denied|revealed|suggest(?:s|ed)?|asserts?|declares?)\b/i;

// Editorial "no closer to [goal]" framing: almost always an opinion-assessment
// of policy failure when used without any attribution. With attribution it can
// be legitimate reporting ("diplomats say talks brought parties no closer to
// agreement") and the HAS_ATTRIBUTION_RE guard excludes it.
// Scoped to resolution/deal-class nouns to avoid matching unrelated literals.
const EDITORIAL_NO_CLOSER_RE =
  /\bno\s+closer\s+to\s+(?:a\s+)?(?:resolution|solution|deal|agreement|peace|ceasefire|end|conclusion|compromise)\b/i;

// Clearly evaluative opener that identifies the subject as a characterization
// rather than an event or actor. "Chaos and confusion", "confusion and chaos",
// "disorder and dysfunction" as the LINE-OPENING subject → almost always spin.
const EVALUATIVE_OPENER_RE =
  /^(?:chaos(?:\s+and\s+\w+)?|confusion(?:\s+and\s+\w+)?|disorder(?:\s+and\s+\w+)?|gridlock(?:\s+and\s+\w+)?|dysfunction(?:\s+and\s+\w+)?|stalemate(?:\s+and\s+\w+)?|deadlock(?:\s+and\s+\w+)?)\b/i;

/**
 * True when a single bullet/fact/claim line is meta-commentary about the
 * summarized article/excerpt itself (padding), rather than news content.
 *
 * Also catches editorial/spin phrasing that leaks into key-fact bullets:
 *   • "no closer to [resolution/deal]" framing without attribution
 *   • evaluative opener ("chaos and confusion…") + editorial outcome assessment
 * These checks are gated on the ABSENCE of an attribution marker so attributed
 * quotes ("X said the talks brought parties no closer to a deal") are never
 * filtered — they are real attributed reporting.
 */
export function isMetaFillerLine(line: string | null | undefined): boolean {
  if (!line) return false;
  const t = line.trim();
  if (!t) return false;
  if (META_FILLER_PATTERNS.some((re) => re.test(t))) return true;

  // Spin/editorial gate — only fires when no attribution marker is present.
  if (!HAS_ATTRIBUTION_RE.test(t)) {
    // "no closer to [resolution/deal]" + evaluative opener → clearly editorial.
    if (EDITORIAL_NO_CLOSER_RE.test(t) && EVALUATIVE_OPENER_RE.test(t)) return true;
    // "no closer to [resolution/deal]" alone on a line that also uses an
    // editorial outcome verb ("bring/brings/bringing [entity] no closer to") →
    // opinion assessment masquerading as a fact.
    if (EDITORIAL_NO_CLOSER_RE.test(t) && /\bbring(?:s|ing)?\b/i.test(t)) return true;
  }

  return false;
}

/**
 * Strip meta-filler lines from a bullets/claims array, preserving order of the
 * surviving lines. Returns a NEW array; [] when every line was filler.
 */
export function stripMetaFillerLines(lines: ReadonlyArray<string> | null | undefined): string[] {
  if (!lines || lines.length === 0) return [];
  return lines.filter((l) => typeof l === 'string' && l.trim().length > 0 && !isMetaFillerLine(l));
}

// ---------------------------------------------------------------------------
// Explicit-attribution guard for lines rendered as "Attributed claims".
// ---------------------------------------------------------------------------
// A claim is not clear merely because it lives under an attributed-claims
// heading. The sentence itself must identify who originated the assertion and
// contain an attribution verb:
//   "Pentagon officials warned that..."
//   "According to three U.S. officials, ..."
//   "Reuters reported, citing two defense officials, ..."
// This intentionally rejects unsupported declarative phrasing such as
// "The depletion raises concerns..." and vague passives such as "It is said...".
const CLAIM_ATTRIBUTION_VERB_RE =
  /\b(?:say|said|says|state|states|stated|announce|announces|announced|claim|claims|claimed|report|reports|reported|find|finds|found|conclude|concludes|concluded|estimate|estimates|estimated|assess|assesses|assessed|warn|warns|warned|argue|argues|argued|contend|contends|contended|maintain|maintains|maintained|deny|denies|denied|confirm|confirms|confirmed|acknowledge|acknowledges|acknowledged|admit|admits|admitted|predict|predicts|predicted|forecast|forecasts|project|projects|projected|attribute|attributes|attributed|blame|blames|blamed|describe|describes|described|characterize|characterizes|characterized|tell|tells|told|write|writes|wrote|testify|testifies|testified|cite|cites|cited|indicate|indicates|indicated|suggest|suggests|suggested|believe|believes|believed|accuse|accuses|accused|allege|alleges|alleged|assert|asserts|asserted|declare|declares|declared|insist|insists|insisted|urge|urges|urged|call|calls|called|recommend|recommends|recommended|request|requests|requested|pledge|pledges|pledged|promise|promises|promised|vow|vows|vowed)\b/i;
const MATERIAL_SUBJECT_RE =
  /^(?:the|this)\s+(?:article|excerpt|provided\s+text|given\s+text|source\s+material)\b/i;
const VAGUE_PASSIVE_ATTRIBUTION_RE =
  /^(?:it|this|that)\s+(?:is|was|has\s+been|had\s+been)\s+(?:said|reported|claimed|believed|suggested|estimated|assessed)\b/i;
const SOURCE_CLASS_RE =
  /\b(?:officials?|sources?|analysts?|experts?|researchers?|investigators?|witnesses?|diplomats?|lawmakers?|ministers?|presidents?|secretar(?:y|ies)|generals?|admirals?|commanders?|spokes(?:person|man|woman|people)|representatives?|executives?|leaders?|authorities|agenc(?:y|ies)|departments?|ministr(?:y|ies)|administration|government|military|army|navy|air\s+force|marines?|white\s+house|pentagon|kremlin|parliament|congress|committee|court)\b/i;

function hasPlausibleClaimOriginator(text: string): boolean {
  const source = text
    .trim()
    .replace(/^[,;:\s]+|[,;:.\s]+$/g, '')
    .replace(/^(?:and|but|while|although)\s+/i, '');
  if (!source || /^(?:it|this|that|he|she|they|we|i)$/i.test(source)) return false;
  if (MATERIAL_SUBJECT_RE.test(source)) return false;
  if (/^(?:reported|estimated|assessed|alleged|claimed|suggested|indicated|forecast|projected)\b/i.test(source)) {
    return false;
  }
  if (SOURCE_CLASS_RE.test(source)) return true;
  // Named people, states, agencies, and originating publications are also clear
  // originators. Accept an acronym, a multi-token proper name, or a single
  // capitalized proper name ("Reuters", "Russia", "Trump").
  if (/\b[A-Z]{2,}(?:['’-][A-Z]+)?\b/.test(source)) return true;
  const properTokens = source.match(/\b[A-Z][A-Za-z'’.-]{2,}\b/g) || [];
  if (properTokens.length >= 2) return true;
  return properTokens.length === 1 && !/^(?:The|A|An)$/i.test(properTokens[0]);
}

/**
 * True only when a rendered claim visibly identifies its origin through an
 * explicit attribution construction. Pure and deterministic; malformed model
 * output fails closed rather than appearing as an unattributed fact.
 */
export function hasExplicitClaimAttribution(line: string | null | undefined): boolean {
  if (!line) return false;
  const t = line.trim();
  if (!t || MATERIAL_SUBJECT_RE.test(t) || VAGUE_PASSIVE_ATTRIBUTION_RE.test(t)) return false;

  // "According to [actual source/originator], ..." is explicit without needing
  // a second speech verb. Meta-material subjects were rejected above.
  const accordingMatch = t.match(
    /(?:^|,\s*)according\s+to\s+([^,;]{2,100})(?:[,;]|$)/i,
  );
  if (accordingMatch && hasPlausibleClaimOriginator(accordingMatch[1])) {
    return true;
  }

  // Active attribution: require a plausible originator immediately before the
  // attribution verb in the same clause. This accepts both leading forms
  // ("Officials warned...") and trailing tags ("..., analysts said").
  for (const match of t.matchAll(new RegExp(CLAIM_ATTRIBUTION_VERB_RE.source, 'gi'))) {
    const prefix = t.slice(0, match.index ?? 0);
    const sentencePrefix = prefix.split(/[.;:]/).pop()?.trim() ?? '';
    const commaClauses = sentencePrefix.split(',').map((part) => part.trim()).filter(Boolean);
    const nearestClause = commaClauses.at(-1) ?? '';
    const passiveAuxiliaryBeforeVerb =
      /\b(?:is|are|was|were|be|been|being|has\s+been|have\s+been|had\s+been)\s*$/i.test(nearestClause);
    if (!passiveAuxiliaryBeforeVerb && hasPlausibleClaimOriginator(nearestClause)) return true;

    // Preserve a named originator separated from the verb only by a normal
    // journalistic sourcing aside: "Reuters, citing two officials, reported…".
    // Do not scan the whole sentence indiscriminately; that could let an
    // unrelated proper name in an earlier clause validate a vague subject such
    // as "the assessment warned".
    const firstClause = commaClauses[0] ?? '';
    const sourcingAsides = commaClauses.slice(1);
    if (
      commaClauses.length > 1 &&
      hasPlausibleClaimOriginator(firstClause) &&
      sourcingAsides.every((clause) =>
        /^(?:citing|quoting|according\s+to|based\s+on|after\s+(?:interviewing|reviewing))\b/i.test(clause),
      )
    ) return true;

    // Passive source binding: "was reported by Reuters" / "was assessed by
    // Pentagon analysts". The source follows the verb instead of preceding it.
    const suffix = t.slice((match.index ?? 0) + match[0].length);
    const byMatch = suffix.match(/^\s+by\s+([^,;]{2,100})(?:[,;]|$)/i);
    if (byMatch && hasPlausibleClaimOriginator(byMatch[1])) return true;

    // Inverted quote attribution: '"Stocks are low," said three officials.'
    const closesQuotedClaim = /["”’]\s*$/.test(prefix);
    const invertedMatch = suffix.match(/^\s+([^,;]{2,100})(?:[,;]|$)/i);
    if (
      closesQuotedClaim &&
      invertedMatch &&
      hasPlausibleClaimOriginator(invertedMatch[1])
    ) return true;
  }

  return false;
}

/** Keep only self-contained, visibly attributed claim sentences. */
export function filterExplicitlyAttributedClaims(
  lines: ReadonlyArray<string> | null | undefined,
): string[] {
  if (!lines || lines.length === 0) return [];
  return lines
    .map((line) => typeof line === 'string' ? line.trim() : '')
    .filter((line) => hasExplicitClaimAttribution(line));
}

// High-signal proposition forms that are ordinarily estimates, interpretations,
// forecasts, causal accounts, or assessments rather than directly observable
// events. Used as a narrow fail-closed guard for generated cluster headlines and
// ledes; it is not a general fact checker.
const SOURCE_DEPENDENT_ASSERTION_RE =
  /\b(?:nearly|virtually)\s+all\b|\b(?:raises?|heightens?|sparks?|fuels?)\s+(?:(?:fresh|new|serious)\s+)?(?:concerns?|fears?|risk)\b|\b(?:concerns?|risk|threat)\s+(?:about|of|to)\s+(?:military\s+)?readiness\b|\b(?:estimated|assessed|forecast|predicted|projected)\s+(?:at|as|to|that)\b|\b(?:signals?|suggests?|indicates?)\s+that\b|\b(?:may|might|could|likely|unlikely)\s+(?:signal|indicate|suggest|trigger|fuel|heighten|escalate|retaliate|undermine|weaken)\b|\b(?:war|conflict|fighting|hostilities|escalation)\s+(?:is|are|was|were)\s+expected\s+to\s+continue\b|\b(?:aims?|seeks?|intends?|is\s+intended|was\s+intended|designed)\s+to\s+(?:avoid|enable|allow|prevent|pressure|signal|bolster|undermine|weaken)\b/i;

/** True when an obvious source-dependent assertion is presented without attribution. */
export function hasUnattributedSourceDependentAssertion(
  line: string | null | undefined,
): boolean {
  if (!line) return false;
  const t = line.trim();
  return !!t && SOURCE_DEPENDENT_ASSERTION_RE.test(t) && !hasExplicitClaimAttribution(t);
}

// ---------------------------------------------------------------------------
// Content-word deduplication for bullets and attributed claims.
// ---------------------------------------------------------------------------
// Short stop-words that carry no subject-matter signal. Words shorter than 4
// characters are already excluded by the minimum-length filter below.
const DEDUP_STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'they', 'were', 'have', 'been', 'will',
  'would', 'could', 'should', 'said', 'says', 'also', 'about', 'more',
  'than', 'into', 'over', 'under', 'after', 'before', 'during', 'while',
  'when', 'where', 'which', 'what', 'there', 'them', 'then', 'their',
  'does', 'make', 'made', 'some', 'such', 'very', 'much', 'even',
  'both', 'each', 'most', 'other', 'same', 'only', 'back', 'just',
]);

function contentWords(line: string): Set<string> {
  const raw = line.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  return new Set(raw.filter((w) => !DEDUP_STOP_WORDS.has(w)));
}

function hasNearDuplicateContent(words: Set<string>, references: ReadonlyArray<Set<string>>): boolean {
  if (words.size < 2) return false;
  return references.some((referenceWords) => {
    if (referenceWords.size < 2) return false;
    let intersection = 0;
    for (const word of words) {
      if (referenceWords.has(word)) intersection++;
    }
    return intersection / Math.min(words.size, referenceWords.size) > 0.60;
  });
}

// A high-overlap denial or contradiction is not a duplicate of the proposition
// it disputes. Preserve these stance-bearing claims unless the reference line
// carries the same stance too.
const CONTRADICTION_STANCE_RE =
  /\b(?:deny|denies|denied|denial|dispute|disputes|disputed|contradict|contradicts|contradicted|reject|rejects|rejected|refute|refutes|refuted|contest|contests|contested|false|untrue|inaccurate|did\s+not|does\s+not|do\s+not|is\s+not|are\s+not|was\s+not|were\s+not|won['’]?t|cannot|can['’]?t)\b/i;

/**
 * Remove near-duplicate lines from a bullets or attributed-claims array.
 *
 * Two lines are considered duplicates when their meaningful content words
 * (4+ chars, excluding common stop words) overlap by more than 60%
 * (intersection / smaller-set size). The FIRST occurrence is always kept;
 * later near-duplicates are dropped. Handles same-predicate subject-splits
 * ("Vance attended…" / "Witkoff attended…" / "Sharif attended…") as well as
 * same-assertion rewordings ("will dismantle" / "vowed to take apart").
 *
 * Pure, deterministic — no I/O, no AI.
 */
export function deduplicateLines(lines: ReadonlyArray<string>): string[] {
  const kept: string[] = [];
  const keptWords: Array<Set<string>> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const words = contentWords(trimmed);

    // Lines with fewer than 2 content words can't meaningfully be deduped —
    // always keep them.
    if (words.size < 2) {
      kept.push(trimmed);
      keptWords.push(words);
      continue;
    }

    const isDup = hasNearDuplicateContent(words, keptWords);

    if (!isDup) {
      kept.push(trimmed);
      keptWords.push(words);
    }
  }

  return kept;
}

/**
 * Remove lines that restate a proposition already present in a reference
 * section. Used to keep Curated facts and attributed claims complementary:
 * attribution words may differ, but the underlying event/action/object cannot
 * be repeated in both sections.
 */
export function excludeNearDuplicateLines(
  lines: ReadonlyArray<string>,
  referenceLines: ReadonlyArray<string>,
): string[] {
  const references = referenceLines
    .map((line) => {
      const trimmed = line.trim();
      return {
        words: contentWords(trimmed),
        hasContradictionStance: CONTRADICTION_STANCE_RE.test(trimmed),
      };
    })
    .filter((reference) => reference.words.size >= 2);
  if (references.length === 0) return lines.map((line) => line.trim()).filter(Boolean);

  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const words = contentWords(line);
      const hasContradictionStance = CONTRADICTION_STANCE_RE.test(line);
      return !references.some((reference) => {
        // Different polarity/stance means different information even when most
        // content words overlap ("outage occurred" vs "Russia denied causing it").
        if (hasContradictionStance !== reference.hasContradictionStance) return false;
        return hasNearDuplicateContent(words, [reference.words]);
      });
    });
}
