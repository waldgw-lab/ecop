// =============================================================================
// Centralized title translation helpers for bot ingestion.
//
// Translation is piggybacked onto each bot's existing CJCS-relevance batch AI
// call — no extra AI requests are made. Every bot that already calls the AI for
// relevance + summary scoring now also receives an `english_title` field in the
// same JSON response. English titles pass through verbatim; non-English titles
// are faithfully translated. The original scraped title is preserved in the bot
// post table (`articleTitle`) so dedup and audit trails are intact.
//
// Usage:
//   1. Include ENGLISH_TITLE_FIELD_SPEC in the JSON schema description inside the
//      analyzeArticlesForCJCS prompt.
//   2. Call extractEnglishTitle(aiItem, originalTitle) after parsing the result.
// =============================================================================

/**
 * Description of the `english_title` field to splice into the AI JSON schema.
 * Paste this into the list of expected fields inside the prompt.
 */
export const ENGLISH_TITLE_FIELD_SPEC =
  '"english_title" (the headline in English — return verbatim if already English, return a faithful concise English translation if the headline is in another language; always present, never null; return ONLY the headline text itself — never include the numbered list index, any bracketed [SourceName] tag, or the surrounding quotation marks used in the input list formatting)';

// ---------------------------------------------------------------------------
// Echo-artifact sanitization (Task #1136).
//
// The screening prompts list candidates as `N. [SourceName] "title"` (or
// `N. "title"`), and the model sometimes echoes that whole formatting back as
// english_title — producing stored/displayed headlines like
// `[The Hill] "Netanyahu vows …"`. Strip that LIST-FORMATTING echo here at the
// shared chokepoint, while never mangling a genuinely bracketed or quoted real
// headline:
//   • A leading `[X]` tag is stripped only when X matches the known source
//     name, OR when the remainder is itself fully quote-wrapped (the exact
//     echo shape — real headlines don't look like `[Word] "whole rest quoted"`).
//   • Symmetric wrapping quotes are unwrapped only when a bracket tag was also
//     stripped, OR when the unwrapped text matches the original scraped title
//     (i.e. the model provably just re-quoted the input). A headline that
//     legitimately begins with a quote is left intact.
//   • If the sanitized result is just the original title modulo formatting,
//     the original scraped title is returned verbatim.
// ---------------------------------------------------------------------------

const QUOTE_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ['\u201C', '\u201D'], // “ ”
  ["'", "'"],
  ['\u2018', '\u2019'], // ‘ ’
];

function looseNorm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "'")
    .replace(/[\u201C\u201D"]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Unwrap ONE layer of symmetric wrapping quotes, or return null if not fully wrapped. */
function unwrapQuotes(s: string): string | null {
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length > 2 && s.startsWith(open) && s.endsWith(close)) {
      const inner = s.slice(open.length, s.length - close.length).trim();
      if (inner.length > 0) return inner;
    }
  }
  return null;
}

/**
 * Strip the `[SourceName] "…"` list-formatting echo from an AI-returned title.
 * Exported for the boot-time heal and tests.
 */
export function sanitizeEchoedTitle(
  raw: string,
  originalTitle: string,
  sourceName?: string,
): string {
  let t = raw.trim();
  const origNorm = looseNorm(originalTitle);

  // 1. Leading `[X]` tag.
  let strippedBracket = false;
  const m = t.match(/^\[([^\]\n]{1,80})\]\s*(.*)$/s);
  if (m) {
    const label = m[1].trim();
    const rest = m[2].trim();
    const restUnwrapped = unwrapQuotes(rest);
    const labelMatchesSource =
      !!sourceName && looseNorm(label) === looseNorm(sourceName);
    const restIsQuotedEcho = restUnwrapped !== null; // `[X] "whole rest"` shape
    const restMatchesOriginal =
      looseNorm(rest) === origNorm ||
      (restUnwrapped !== null && looseNorm(restUnwrapped) === origNorm);
    if (rest.length > 0 && (labelMatchesSource || restIsQuotedEcho || restMatchesOriginal)) {
      t = rest;
      strippedBracket = true;
    }
  }

  // 2. Symmetric wrapping quotes — only when we know it's list-formatting echo.
  const unwrapped = unwrapQuotes(t);
  if (unwrapped !== null && (strippedBracket || looseNorm(unwrapped) === origNorm)) {
    t = unwrapped;
  }

  // 3. If the sanitized result is the original title modulo formatting, prefer
  //    the original scraped title verbatim (preserves its exact punctuation).
  if (looseNorm(t) === origNorm) return originalTitle;

  return t;
}

/**
 * Extract the English title from one AI result item.
 * Falls back to the original scraped title on any failure so the bot is
 * always fail-safe. Pass `sourceName` when the caller knows it so a
 * `[SourceName]` list-formatting echo can be stripped confidently.
 */
export function extractEnglishTitle(
  aiItem: { english_title?: string | null | unknown },
  originalTitle: string,
  sourceName?: string,
): string {
  if (typeof aiItem.english_title === 'string') {
    const t = sanitizeEchoedTitle(aiItem.english_title, originalTitle, sourceName);
    if (t.length > 5) return t;
  }
  return originalTitle;
}
