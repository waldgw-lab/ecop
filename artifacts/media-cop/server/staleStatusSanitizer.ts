// =============================================================================
// Stale status descriptor sanitizer.
//
// AI models with pre-2025 training cutoffs inject stale political status
// descriptors ("Former President Trump", "ex-Secretary Pompeo") even when
// EVERY source article simply writes "President Trump" or "Secretary Pompeo".
// This module strips such injected descriptors when the combined source text
// never applies that descriptor to that person.
//
// DESIGN
// ------
// Pattern: \b(former|ex-|then-|late) immediately preceding a Title-Cased
// word run (title + name), with or without a space between the descriptor
// and the title (handles both "Former Secretary" and "Ex-Secretary").
// For each match:
//   1. Extract the surname — the last capital-initial word in the title+name
//      run that follows the descriptor.
//   2. Search the combined source text for the descriptor base word within a
//      short word-window of that surname (either order).
//   3. Source supports → leave unchanged (fail-safe preserve).
//      Source does NOT support → strip only the descriptor token.
//
// SAFETY PROPERTIES
// -----------------
// • Name-agnostic: works for any person, no hardcoded name list.
// • Fail-open on uncertainty: if the surname can't be extracted, or the
//   descriptor isn't a recognised base, the text is left unchanged.
// • Only the descriptor prefix is stripped — nothing else is altered.
// • Pure: no DB, no AI, no network. Safely shared by all callers.
// • Does NOT touch human-provenance overlays — callers must gate on that.
// =============================================================================

// Status descriptor base words that models inject from stale world knowledge.
// "late" is included: "late Senator X" applied to a living person is the same
// class of error.
const DESCRIPTOR_BASES = ['former', 'ex', 'then', 'late'] as const;

// Current-office correction for a tiny, explicit set of nationally material
// U.S. officials. Models trained on an older political snapshot can replace a
// source-supported current title with an obsolete one ("Senator Marco Rubio")
// even when no stale modifier exists for the descriptor sanitizer below to
// remove. This is intentionally NOT a general person/title inference system:
// exact full-name matches only, AI-output only at the callers, and the source
// text remains the authority for everybody else.
//
// Keep this list small and reviewable. Revisit it when an office changes.
const CURRENT_OFFICE_REPLACEMENTS: ReadonlyArray<{
  name: string;
  title: string;
  wrongTitle: string;
}> = [
  { name: 'Marco Rubio', title: 'Secretary of State', wrongTitle: 'Senator' },
  { name: 'Donald Trump', title: 'President', wrongTitle: 'Former President' },
];

// Exact identity swaps observed in production where stale model knowledge
// replaces the person named by the article with a predecessor. A replacement
// is allowed ONLY when the source explicitly contains the current name and does
// not contain the stale name. This repairs the line without consulting any
// external knowledge or adding another AI call.
const SOURCE_BACKED_IDENTITY_REPLACEMENTS: ReadonlyArray<{
  staleName: string;
  sourceName: string;
}> = [
  { staleName: 'John Aquilino', sourceName: 'Samuel Paparo' },
];

// Titles that make a capitalized full-name run unambiguously person-shaped.
// Keep this conservative: the guard's job is to fail closed on invented named
// officials, not to classify every capitalized phrase as a person.
const TITLED_FULL_NAME_RE = new RegExp(
  String.raw`\b(?:President|Vice President|Prime Minister|Secretary(?:\s+of\s+[A-Z][A-Za-z-]+){0,3}|Deputy Secretary|Under Secretary|Defense Secretary|Foreign Minister|Senator|Representative|Governor|Ambassador|Admiral|General|Commander|Colonel|Lieutenant Colonel|Major General|Brigadier General|Rear Admiral|Vice Admiral|Gen\.|Adm\.|Col\.)\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){1,3})\b`,
  'g',
);

function normalizedContains(haystack: string, needle: string): boolean {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();
  const h = ` ${normalize(haystack)} `;
  const n = normalize(needle);
  return n.length > 0 && h.includes(` ${n} `);
}

/**
 * Validate AI-generated prose against the source material.
 *
 * Returns null when the output introduces a titled full name that never occurs
 * in the source. This catches predecessor substitutions such as John Aquilino
 * for Samuel Paparo without trying to infer which person the model intended.
 * Exact observed swaps may be repaired first, but only with source support.
 */
export function groundGeneratedTextInSources(
  text: string | null | undefined,
  sourceTexts: ReadonlyArray<string | null | undefined>,
): string | null {
  if (!text) return null;
  const source = sourceTexts
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ');
  if (!source.trim()) return text;

  let grounded = stripStaleStatusDescriptors(text, sourceTexts);
  for (const replacement of SOURCE_BACKED_IDENTITY_REPLACEMENTS) {
    if (
      normalizedContains(source, replacement.sourceName) &&
      !normalizedContains(source, replacement.staleName)
    ) {
      const stale = replacement.staleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      grounded = grounded.replace(
        new RegExp(`\\b${stale}\\b`, 'gi'),
        replacement.sourceName,
      );
    }
  }

  TITLED_FULL_NAME_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TITLED_FULL_NAME_RE.exec(grounded)) !== null) {
    const fullName = match[1];
    if (!normalizedContains(source, fullName)) return null;
  }
  return grounded;
}

export function groundGeneratedLinesInSources(
  lines: ReadonlyArray<string> | null | undefined,
  sourceTexts: ReadonlyArray<string | null | undefined>,
): string[] {
  if (!lines || lines.length === 0) return [];
  return lines
    .map((line) => groundGeneratedTextInSources(line, sourceTexts))
    .filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
}

export function containsKnownStaleIdentity(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  return SOURCE_BACKED_IDENTITY_REPLACEMENTS.some((entry) =>
    normalizedContains(text, entry.staleName),
  );
}

/**
 * Correct a known obsolete title when AI-generated text names the exact
 * officeholder. This never rewrites a source article; callers use it only on
 * generated summaries, bullets, claims, and synthesis output.
 */
export function correctCurrentOfficialTitles(
  text: string | null | undefined,
  sourceTexts: ReadonlyArray<string | null | undefined> = [],
): string {
  if (!text) return text ?? '';
  const source = sourceTexts
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ');
  return CURRENT_OFFICE_REPLACEMENTS.reduce((out, official) => {
    const wrong = official.wrongTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const name = official.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The source remains authoritative. If it explicitly uses the allegedly
    // stale title for this exact person (for example in historical reporting),
    // preserve it rather than applying current-world knowledge.
    if (source && normalizedContains(source, `${official.wrongTitle} ${official.name}`)) {
      return out;
    }
    return out.replace(
      new RegExp(`\\b${wrong}\\s+${name}\\b`, 'gi'),
      `${official.title} ${official.name}`,
    );
  }, text);
}

// Regex: captures the descriptor+optional-article run when followed by a
// Title-Cased word (the start of a title or name).
//
// Two forms handled:
//   • Spaced form:   "Former Secretary", "Late Senator", "Ex- Secretary"
//   • Compound form: "Ex-Secretary", "Then-Secretary" (hyphen, no space)
//
// Group 1 = the full descriptor prefix (what we strip if unsupported).
// The global flag lets String.replace iterate over all occurrences.
const DESCRIPTOR_RE = new RegExp(
  // "former" and "late" only appear spaced ("Former President …")
  '\\b((?:former|late)\\s+(?:(?:the|a|an)\\s+)?)(?=[A-Z])' +
  '|' +
  // "ex" and "then" appear EITHER spaced ("Ex- Secretary") OR compound
  // hyphenated directly ("Ex-Secretary", "Then-Secretary")
  '\\b((?:ex|then)-(?:\\s+(?:(?:the|a|an)\\s+)?)?)(?=[A-Z])',
  'gi',
);

/**
 * Returns true when the combined source text supports the given descriptor
 * base applied to the given surname — i.e. the source itself calls this
 * person "former/ex/then/late … <surname>" within a short word window.
 */
function sourceSupportsDescriptor(
  descBase: string,
  surname: string,
  sourceLower: string,
): boolean {
  const sn = surname.toLowerCase();
  if (!sourceLower.includes(sn)) return false;

  const snEsc = sn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // For "ex" and "then" we accept both "ex " (spaced) and "ex-" (compound).
  let descPat: string;
  if (descBase === 'ex') {
    descPat = 'ex[\\s-]';
  } else if (descBase === 'then') {
    descPat = 'then[\\s-]';
  } else {
    descPat = descBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s';
  }

  // Accept the descriptor within 0-7 words of the surname in either order.
  const re = new RegExp(
    `(?:${descPat})(?:[\\w-]+\\s+){0,6}${snEsc}|${snEsc}(?:\\s+[\\w,.-]+){0,7}\\s+(?:${descPat})`,
    'i',
  );
  return re.test(sourceLower);
}

/**
 * Strip stale status descriptors from a single text string.
 *
 * @param text        AI-generated text to sanitize (bullet, claim, lede, …).
 * @param sourceTexts Source material the AI was given (article headline +
 *                    excerpt for per-item enrichment; member titles/summaries
 *                    for synthesis). Used only to determine whether each
 *                    descriptor is source-supported or AI-injected.
 * @returns Sanitized string — identical to input when nothing was stripped.
 */
export function stripStaleStatusDescriptors(
  text: string | null | undefined,
  sourceTexts: ReadonlyArray<string | null | undefined>,
): string {
  if (!text) return text ?? '';

  const sourceLower = sourceTexts
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ')
    .toLowerCase();

  DESCRIPTOR_RE.lastIndex = 0;
  const descriptorCleaned = text.replace(
    DESCRIPTOR_RE,
    (match: string, g1: string | undefined, g2: string | undefined, offset: number, full: string) => {
      // One of the two capturing groups matched — the descriptor prefix.
      const descriptor = g1 ?? g2 ?? match;
      const afterOffset = offset + match.length;
      const afterText = full.slice(afterOffset);

      // Extract the title+name run after the descriptor.
      // Allows multi-word titles like "Secretary of State", "Prime Minister".
      const runMatch = afterText.match(
        /^([A-Z][A-Za-z]*(?:\s+(?:[A-Z][A-Za-z]*|of|the|and|for|to|at|in)){0,5})/,
      );
      if (!runMatch) return match; // can't identify run — fail-safe

      const titleRun = runMatch[1];
      const words = titleRun.split(/\s+/).filter(Boolean);

      // Surname = last capital-initial word (filters lowercase connectors like "of").
      const capitalWords = words.filter((w) => /^[A-Z]/.test(w));
      const surname = capitalWords[capitalWords.length - 1];
      if (!surname || surname.length < 2) return match; // too short — fail-safe

      // Normalise descriptor to a base token ("ex-" → "ex", "former " → "former").
      const descNorm = descriptor.trim().toLowerCase().replace(/[-\s]+$/, '');
      const descBase = DESCRIPTOR_BASES.find((b) => descNorm.startsWith(b));
      if (!descBase) return match; // unrecognised — fail-safe

      // Source supports this descriptor for this person → preserve.
      if (sourceSupportsDescriptor(descBase, surname, sourceLower)) return match;

      // AI-injected stale descriptor → strip (return empty string).
      return '';
    },
  );
  return correctCurrentOfficialTitles(descriptorCleaned, sourceTexts);
}

/**
 * Apply stripStaleStatusDescriptors to every element of a string array.
 * Returns a new array of the same length; never removes elements.
 */
export function stripStaleStatusDescriptorsFromArray(
  lines: ReadonlyArray<string> | null | undefined,
  sourceTexts: ReadonlyArray<string | null | undefined>,
): string[] {
  if (!lines || lines.length === 0) return [];
  return lines.map((l) =>
    typeof l === 'string' ? stripStaleStatusDescriptors(l, sourceTexts) : l,
  );
}

/**
 * Returns true when `text` contains at least one stale status descriptor that
 * the source text does NOT support — useful for boot-time heal selection.
 */
export function hasUnsupportedStatusDescriptor(
  text: string | null | undefined,
  sourceTexts: ReadonlyArray<string | null | undefined>,
): boolean {
  if (!text) return false;
  return stripStaleStatusDescriptors(text, sourceTexts) !== text;
}
