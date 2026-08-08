/**
 * Summary preamble sanitizer.
 *
 * Several news bots summarize articles with an AI prompt that frames the
 * audience (e.g. "...for the Chairman of the Joint Chiefs of Staff"). The model
 * sometimes ECHOES that audience framing back as a leading markdown heading or
 * label — e.g. a stored summary that begins with:
 *
 *     # Summary for Chairman of the Joint Chiefs of Staff
 *
 *     An F-16 intercepted a civilian aircraft ...
 *
 * That leading heading/label is an AI-formatting ARTIFACT that must never reach
 * any external surface (Curated, Classic/Visual feeds, custom MCOPs, public API).
 * `stripBriefingPreamble` removes that leading artifact while preserving the
 * actual news prose.
 *
 * SAFETY: this only strips a LEADING audience-framing heading/label. It never
 * touches inline mentions, because legitimate defense news genuinely reports on
 * the real Chairman of the Joint Chiefs of Staff. When the value is nothing BUT
 * that artifact (the strip empties it, or it is a content-free heading-only line
 * with no body prose), it intentionally returns '' — '' is valid for the NOT
 * NULL summary columns and is strictly better than surfacing the artifact. It
 * never blanks a value that still has real news prose after stripping.
 */

// Audience-framing tokens the summarizer prompts reference and the model may echo.
const AUDIENCE =
  '(?:the\\s+)?(?:chairman\\s+of\\s+the\\s+joint\\s+chiefs\\s+of\\s+staff|joint\\s+chiefs\\s+of\\s+staff|cjcs|senior\\s+(?:u\\.?s\\.?\\s+)?military\\s+leadership|senior\\s+(?:military\\s+)?leadership|military\\s+leadership)';

// A leading "[#] Summary/Briefing for <audience>[:.-]" label — handles both the
// markdown-heading form and an inline form that runs straight into the body.
const AUDIENCE_LABEL = new RegExp(
  '^\\s*#{0,6}[ \\t]*' +
    "(?:here(?:['\u2019]s| is)\\s+(?:a|the|your)\\s+)?" +
    '(?:summary|briefing|brief|intelligence\\s+summary|executive\\s+summary)' +
    '[ \\t]+(?:for|to|prepared\\s+for|addressed\\s+to)[ \\t]+' +
    AUDIENCE +
    '\\b[ \\t]*[:.\\-\u2014]?[ \\t]*(?:\\r?\\n)*',
  'i',
);

// Any leading markdown heading LINE. Requires a trailing newline so the body of
// a single-line summary is never eaten.
const LEADING_HEADING_LINE = /^\s*#{1,6}[ \t]+[^\n]*\r?\n+/;

export function stripBriefingPreamble<T extends string | null | undefined>(input: T): T {
  if (input == null) return input;
  const original = String(input);
  let out = original;
  let prev: string;
  let guard = 0;
  do {
    prev = out;
    out = out.replace(AUDIENCE_LABEL, '');
    out = out.replace(LEADING_HEADING_LINE, '');
  } while (out !== prev && out.length > 0 && guard++ < 6);

  out = out.trim();
  // A summary whose ENTIRE content was a leading audience-framing label or
  // markdown heading is pure leaked formatting with no news prose (e.g.
  // "# Key Facts Summary", "# Summary for Senior Leadership"). Drop it — '' is
  // valid for the NOT NULL columns and is strictly better than surfacing the
  // artifact. This covers both the stripped-to-empty case and a heading-only
  // value that had no body (no newline) for the line-strip to protect.
  if (out.length === 0) return '' as T;
  if (!out.includes('\n') && /^#{1,6}[ \t]+\S/.test(out)) return '' as T;
  return out as T;
}

/**
 * Sanitize an already-COMPOSED bot chat message.
 *
 * Every news bot composes its Team-chat message as a single baked string:
 *
 *     **<title>**
 *
 *     <summary>
 *
 *     <url>
 *
 * If the audience-framing artifact leaked into <summary>, it leads the segment
 * immediately AFTER the title's blank line. The row-level `stripBriefingPreamble`
 * can't clean this directly because the artifact is no longer leading the whole
 * value (the bold title precedes it). So split off the leading title segment
 * (everything up to and including the first blank line) and run the same narrow
 * sanitizer on the remainder, where the artifact — if any — now leads. Recompose
 * title + cleaned remainder. Returns the input unchanged when nothing is stripped
 * (so human messages and clean bot messages are never altered).
 */
export function stripBriefingPreambleFromMessage<T extends string | null | undefined>(input: T): T {
  if (input == null) return input;
  const msg = String(input);
  const sep = msg.indexOf('\n\n');
  if (sep === -1) return input; // not the composed title + body + url shape
  const head = msg.slice(0, sep + 2); // title segment, includes the blank line
  const rest = msg.slice(sep + 2);
  const cleanedRest = stripBriefingPreamble(rest);
  if (cleanedRest === rest) return input; // nothing stripped → leave untouched
  return (head + cleanedRest) as T;
}
