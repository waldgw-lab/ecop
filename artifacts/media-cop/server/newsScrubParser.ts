// Curated-only: parse the "highlights" section out of a daily news-scrub PDF's
// raw text into { group, trending[], breaking[] } entries for the Curated page's
// IE Highlights panel.
//
// Uploaded scrub PDFs come in two templates:
//
//   1. "IE Highlights" template (parseIeHighlightsSection): an "IE Highlights"
//      heading, then each region (e.g. "Global IE") as an "o"-bullet, with
//      "Top Trending Narratives" / "Breaking/Notable Stories" sub-headers and
//      "•"-bullet stories. Wrapped story lines (no bullet) append to the prior
//      bullet.
//
//   2. "MAJOR IR/IE NARRATIVES" template (parseMajorNarrativesSection): no
//      "IE Highlights" heading at all; instead a table-of-contents block titled
//      "MAJOR IR NARRATIVES" listing each region followed by numbered headlines
//      ("1. Headline"). Some scrubs only have this block.
//
// parseNewsScrubHighlights tries template 1 first (richer), then falls back to
// template 2 so the panel stays populated regardless of which template the
// uploaded PDF used.

export type IeHighlightGroup = {
  group: string;
  trending: string[];
  breaking: string[];
};

// Region names used across the scrub templates. Anchored so only genuine region
// header lines (not story text) are treated as new groups.
const IE_REGION_RE = /^(global\s+ie|pentagon\s*\/?\s*natsec|natsec|domestic\s+ie|homeland(\s+ie)?)\b/i;

// Template 1: the "IE Highlights" section.
export function parseIeHighlightsSection(text: string): IeHighlightGroup[] {
  // The section heading casing varies between scrub templates ("IE HIGHLIGHTS"
  // vs. "IE Highlights:"), so match case-insensitively rather than relying on
  // an exact uppercase string.
  const startMatch = text.match(/IE Highlights:?/i);
  if (!startMatch || startMatch.index === undefined) return [];
  let section = text.substring(startMatch.index + startMatch[0].length);
  const endIdx = section.search(/Latest Brent|Key Social Media|\bGLOBAL IE\b/);
  if (endIdx > -1) section = section.substring(0, endIdx);

  const groups: IeHighlightGroup[] = [];
  let current: IeHighlightGroup | null = null;
  let mode: 'trending' | 'breaking' | null = null;

  for (const raw of section.split('\n')) {
    const line = raw.replace(/\t/g, ' ').trim();
    if (!line) continue;

    // PDFs render the nested bullets with several different glyphs: a literal
    // "o" for regions, "•"/"·" for stories, and a Symbol/Wingdings glyph in the
    // Private Use Area (e.g. U+F0A7) for the "Top Trending"/"Breaking" headers.
    // That PUA glyph is neither whitespace nor "•"/"·", so .trim() and a [•·]
    // test both miss it. Strip any leading run of non-letter/number "marker"
    // characters (whitespace, bullets, PUA symbols) so every level is detectable
    // regardless of which glyph the source PDF used. `marker` is non-empty only
    // for bulleted lines, which distinguishes stories from wrapped continuations.
    const marker = line.match(/^[^\p{L}\p{N}"'(]+/u)?.[0] ?? '';
    // Strip any residual leading "2." / "3)" style number that the PUA bullet
    // glyph was merged with — e.g. a PDF line like "<PUA>2. Headline" yields
    // marker=<PUA> but cleaned still starts with "2. ". Remove it so no item
    // collides with the CSS disc bullet when rendered.
    const cleaned = line.slice(marker.length).trim().replace(/^\d+[.)]\s+/, '');
    if (!cleaned) continue;
    if (/^Major IE narratives/i.test(cleaned)) continue;
    if (/^\d+\s+of\s+\d+/i.test(cleaned)) continue; // page markers like "-- 1 of 11 --"
    if (/^\d+\]?$/.test(cleaned)) continue; // footnote/page markers like "[2]"

    // Region header: rendered as a literal "o" bullet (e.g. "o \tGlobal IE").
    if (marker === '' && /^o\s+/.test(cleaned)) {
      const name = cleaned.replace(/^o\s+/, '').replace(/\s+/g, ' ').trim();
      current = { group: name, trending: [], breaking: [] };
      groups.push(current);
      mode = null;
      continue;
    }

    if (/^Top Trending Narratives/i.test(cleaned)) { mode = 'trending'; continue; }
    if (/^Breaking\s*\/?\s*Notable Stories/i.test(cleaned) || /^Breaking\b/i.test(cleaned)) { mode = 'breaking'; continue; }

    // Bulleted line (had a leading marker glyph) => a story under the current mode.
    if (marker !== '') {
      if (current && mode) current[mode].push(cleaned);
      continue;
    }

    // No marker => continuation of a wrapped story line.
    if (current && mode && current[mode].length > 0) {
      current[mode][current[mode].length - 1] += ' ' + cleaned;
    }
  }

  return groups.filter((g) => g.trending.length > 0 || g.breaking.length > 0);
}

// Template 2: the "MAJOR IR/IE NARRATIVES" table-of-contents block. Headlines
// are placed under `trending` (the only list the panel renders).
export function parseMajorNarrativesSection(text: string): IeHighlightGroup[] {
  const startMatch = text.match(/MAJOR\s+I[RE]\s+NARRATIVES/i);
  if (!startMatch || startMatch.index === undefined) return [];
  let section = text.substring(startMatch.index + startMatch[0].length);
  // The TOC ends at the next "***" divider, the start of the detailed
  // "GLOBAL IE" section, or the "Key Social Media" bloc. Social posts are not IE
  // regions — the IE Highlights template likewise treats "Key Social Media" as
  // the section end — so they are excluded here too.
  const endIdx = section.search(/\*\*\*|\bGLOBAL IE\b|Key Social Media|Latest Brent/);
  if (endIdx > -1) section = section.substring(0, endIdx);

  const groups: IeHighlightGroup[] = [];
  let current: IeHighlightGroup | null = null;

  for (const raw of section.split('\n')) {
    const line = raw.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (/^UNCLASSIFIED$/i.test(line)) continue;
    if (/^-*\s*\d+\s*of\s*\d+\s*-*$/i.test(line)) continue; // "-- 1 of 9 --"
    if (/^\d+$/.test(line)) continue; // bare page numbers
    if (/^Major I[RE] narratives/i.test(line)) continue;

    // Numbered story line: "1. Headline" or "1) Headline".
    const story = line.match(/^\d+\s*[.)]\s+(.+)$/);
    if (story) {
      const headline = story[1].trim();
      // Skip "nothing to report" placeholders so an empty region is dropped.
      if (current && headline && !/^(NSTR|N\/A|None)\.?$/i.test(headline)) {
        current.trending.push(headline);
      }
      continue;
    }

    // Region header (Global IE / Pentagon/NATSEC / Domestic IE ...).
    if (IE_REGION_RE.test(line)) {
      current = { group: line.replace(/:$/, '').trim(), trending: [], breaking: [] };
      groups.push(current);
      continue;
    }

    // Otherwise: a wrapped continuation of the previous headline.
    if (current && current.trending.length > 0) {
      current.trending[current.trending.length - 1] += ' ' + line;
    }
  }

  return groups.filter((g) => g.trending.length > 0 || g.breaking.length > 0);
}

// Primary parse with fallback: prefer the richer "IE Highlights" template, but
// fall back to the "MAJOR IR/IE NARRATIVES" TOC when the scrub omits the
// "IE Highlights" section so the panel still populates.
export function parseNewsScrubHighlights(text: string): IeHighlightGroup[] {
  const primary = parseIeHighlightsSection(text);
  if (primary.length > 0) return primary;
  return parseMajorNarrativesSection(text);
}
