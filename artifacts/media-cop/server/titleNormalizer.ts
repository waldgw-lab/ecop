/**
 * Normalizes headline titles for duplicate detection
 * Strips boilerplate text like "...Developing...", "BREAKING:", etc.
 * Collapses whitespace, lowercases, and removes source suffixes
 */
export function normalizeTitle(title: string): string {
  let normalized = title;
  
  // Remove common prefixes
  normalized = normalized.replace(/^(BREAKING|DEVELOPING|EXCLUSIVE|UPDATE|URGENT|ALERT):\s*/gi, '');
  normalized = normalized.replace(/^(PAPER|REPORT|STUDY|POLL):\s*/gi, '');
  
  // Remove common suffixes
  normalized = normalized.replace(/\.\.\.\s*(Developing|Breaking|More|Updated?)\.?\.\.\s*$/gi, '');
  normalized = normalized.replace(/\s*\.\.\.\s*$/g, '');
  
  // Remove trailing source attributions in parentheses or brackets
  normalized = normalized.replace(/\s*[\(\[].*?[\)\]]\s*$/g, '');
  
  // Collapse multiple spaces/whitespace
  normalized = normalized.replace(/\s+/g, ' ');
  
  // Trim and lowercase
  normalized = normalized.trim().toLowerCase();
  
  return normalized;
}

/**
 * Display-only title cleaner for the Curated lane.
 *
 * Strips daily live-blog noise from a headline while PRESERVING casing and any
 * context-bearing topic prefix. This is intentionally SEPARATE from
 * `normalizeTitle` (which lowercases / strips for dedup) — never use this for
 * matching, dedup, clustering, classification, or search. It only changes what
 * the user reads, leaving the original `title` intact for all matching logic.
 *
 * Removes:
 *  - A leading day counter of the form "<topic> war day <N>:" → drops the whole
 *    prefix (e.g. "Iran war day 106: US and Iran…" → "US and Iran…").
 *  - Trailing day-counter variants: ", day <N>" and the Al Jazeera
 *    "…: List of key events, day <N>" form.
 *  - A standalone leading presentation marker that is the ENTIRE leading
 *    segment: "Live:", "Watch:", "Watch Live:", "Live update(s):", "Breaking:",
 *    "Developing:", "Update:" (case-insensitive). Only the whole leading
 *    colon-segment is matched, so a mid-sentence "update" or a longer phrase
 *    like "Breaking News:" (segment "Breaking News", not "Breaking") is left
 *    untouched.
 *  - A live/watch marker tacked onto a CONFLICT topic ("Iran war live:") →
 *    keeps the topic, drops only the marker → "Iran war:". This is deliberately
 *    constrained to a marker following "war" so noun phrases that merely end in
 *    "watch"/"live" ("Market watch:", "Death watch:", "Markets live:") are NOT
 *    rewritten.
 *  - A leading "Daily Briefing <Month> <DD>[, <YYYY>] — " dateline (the Times of
 *    Israel daily live-blog format) → drops the whole dateline so the real
 *    headline leads (e.g. "Daily Briefing June 22 — 'A cease between fires': …"
 *    → "'A cease between fires': …"). Anchored to "Daily Briefing" + a real month
 *    name + a day number + a separator so a normal headline that merely says
 *    "Daily Briefing:" (no date) is never touched.
 *  - A leading Yonhap update marker "(LEAD)" / "(2nd LEAD)" / "(3rd LEAD)" or
 *    "(URGENT)" … → drops the whole parenthetical run (Yonhap stamps re-filed and
 *    breaking stories with these), e.g. "(LEAD) U.S. focused on…" → "U.S. focused
 *    on…" and "(URGENT) N. Korea fires missile" → "N. Korea fires missile".
 *    Anchored to the start and to the exact word "LEAD"/"URGENT" inside the parens,
 *    so a real headline that happens to contain "(lead poisoning)" / "(urgent care)"
 *    or a mid-title "(LEAD)"/"(URGENT)" is untouched.
 *  - A leading agency dateline of the form "<ALL-CAPS CITY> (<Agency>) — " →
 *    drops the whole dateline so the real headline leads (e.g.
 *    "WASHINGTON (AP) — Senate passes bill" → "Senate passes bill",
 *    "KYIV, Ukraine (Reuters) - Talks resume" → "Talks resume"). Anchored to a
 *    leading all-caps city token (≥2 consecutive uppercase letters) + a
 *    parenthetical + a dash separator, so an ordinary Title-case headline that
 *    merely contains a parenthetical ("Trump (finally) speaks") is untouched.
 *
 * Context-bearing topic prefixes like "Iran war:" are left untouched.
 */
export function cleanDisplayTitle(title: string): string {
  if (!title) return title;
  let result = title.trim();

  // (a0) Leading Yonhap update marker(s): "(LEAD) ", "(2nd LEAD) ", "(URGENT) ", …
  // → drop the whole parenthetical run. Each parenthetical must be the exact token
  // "(URGENT)" or "([ordinal] LEAD)" so "(Lead poisoning) report" / "(urgent care)"
  // or a mid-title "(LEAD)"/"(URGENT)" is never stripped.
  result = result.replace(/^(?:\(\s*(?:(?:\d+(?:st|nd|rd|th)\s+)?lead|urgent)\s*\)\s*)+/i, '').trim();

  // (a) Leading day counter: "<topic> war day <N>:" → drop the entire prefix.
  result = result.replace(/^.*?\bwar\s+day\s+\d[\d,]*\s*:\s*/i, '').trim();

  // (a2) Times of Israel "Daily Briefing <Month> <DD>[, <YYYY>] — " dateline →
  // drop the whole prefix. Requires a real month name + day number + a dash/colon
  // separator so a plain "Daily Briefing:" (no date) is left untouched.
  result = result.replace(
    /^daily briefing\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?\s*[—–\-:·]\s*/i,
    '',
  ).trim();

  // (a3) Leading agency dateline: "<ALL-CAPS CITY>[, Region] (<Agency>) — " →
  // drop the whole dateline. Tightly anchored:
  //  - the location must be one or more ALL-CAPS words ("WASHINGTON", "NEW YORK"),
  //    optionally followed by a ", <Region>" that may be Title-case ("KYIV, Ukraine"),
  //  - the parenthetical must be a KNOWN wire-agency name (allowlist), and
  //  - a dash separator (em/en dash or spaced hyphen) must follow.
  // This prevents ordinary headlines that merely start with an acronym + a
  // parenthetical + dash (e.g. "US economy (analysis) - ...",
  // "AI boom (podcast) - ...") from being truncated.
  result = result.replace(
    /^[A-Z][A-Z.'’\-]+(?:\s+[A-Z][A-Z.'’\-]+)*(?:,\s*[A-Za-z][A-Za-z.'’\-]*(?:\s+[A-Za-z][A-Za-z.'’\-]*)*)?\s*\((?:AP|Reuters|REUTERS|AFP|dpa|DPA|Kyodo|KYODO|Yonhap|YONHAP|TASS|ANSA|PTI|Xinhua|XINHUA|EFE|AAP|UPI|Interfax|INTERFAX|Anadolu|ANADOLU|Bloomberg|BLOOMBERG|RIA(?:\s+Novosti)?)\)\s*[—–\-]\s+/,
    '',
  ).trim();

  // (b) Trailing day-counter variants.
  //  - "…: List of key events, day <N>" / "…, List of key events, day <N>"
  result = result.replace(/\s*[,:]\s*list of key events\s*,?\s*day\s+\d[\d,]*\s*$/i, '').trim();
  //  - "…, day <N>" (comma required so legitimate "...on day 3" content is safe)
  result = result.replace(/\s*,\s*day\s+\d[\d,]*\s*$/i, '').trim();

  // (c) Leading presentation marker on the first colon-delimited segment.
  const firstColon = result.indexOf(':');
  if (firstColon !== -1) {
    const seg = result.slice(0, firstColon).trim();
    const rest = result.slice(firstColon + 1).trim();
    if (/^(watch\s+live|live\s+updates?|live|watch|breaking|developing|update)$/i.test(seg)) {
      // The whole leading segment is just a marker → drop it.
      result = rest;
    } else if (/\bwar\s+(live|watch)$/i.test(seg)) {
      // Conflict topic + trailing marker → keep the topic, drop only the marker,
      // keep the colon (e.g. "Iran war live: …" → "Iran war: …"). Gated on the
      // marker following "war" so noun phrases like "Market watch:" / "Markets
      // live:" are left untouched.
      const topic = seg.replace(/\s+(live|watch)$/i, '').trim();
      result = rest ? `${topic}: ${rest}` : `${topic}:`;
    }
  }

  // (d) Trailing show/brand suffix: "… | Daybreak Europe 8/18/2026",
  // "… | CNN Politics", "… | Fox News". Strip the LAST pipe-delimited segment
  // ONLY on a positive branding signal — a date (a show-episode tell) or a
  // known outlet/show word — and only while the remaining headline stays
  // substantial (>= 4 words). Ambiguous pipes (quoted titles, film names,
  // "… | The Ugly") are left intact: no signal, no strip.
  const BRAND_SUFFIX_WORD =
    /\b(?:news|politics|tonight|today|morning|evening|daybreak|newshour|newsnight|podcast|radio|tv|network|channel|live|video|watch|cnn|bbc|nbc|msnbc|abc|cbs|npr|pbs|fox|sky|cnbc|bloomberg|reuters|afp|wion|dw|rfi|euronews|newsweek|axios|politico|semafor|al\s*jazeera|straits\s*times|the\s*hill|washington\s*post|new\s*york\s*times|wall\s*street\s*journal|usa\s*today|ap)\b/i;
  const DATED_SUFFIX = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b(?:19|20)\d{2}\b/;
  for (;;) {
    const m = result.match(/^(.*\S)\s*\|\s*([^|]+)$/);
    if (!m) break;
    const remaining = m[1].trim();
    const suffix = m[2].trim();
    const suffixWords = suffix.split(/\s+/).length;
    const remainingWords = remaining.split(/\s+/).length;
    // Never strip across a quote pair spanning the pipe (the pipe is inside a
    // quoted title: `… 'War | Peace' still matters`). Only blocks when the
    // remaining side has an UNBALANCED quote AND the suffix carries the same
    // quote char — a plain possessive ("Trump's …") never blocks.
    const spansQuote = (counter: RegExp, probe: RegExp): boolean =>
      ((remaining.match(counter)?.length ?? 0) % 2 === 1) && probe.test(suffix);
    const balancedQuotes =
      !spansQuote(/"/g, /"/) && !spansQuote(/['’‘]/g, /['’‘]/);
    const brandLike = DATED_SUFFIX.test(suffix) || BRAND_SUFFIX_WORD.test(suffix);
    if (suffixWords <= 8 && remainingWords >= 4 && brandLike && balancedQuotes) {
      result = remaining;
    } else {
      break;
    }
  }

  result = result.replace(/\s+/g, ' ').trim();
  // Safety: never return an empty headline.
  return result.length ? result : title.trim();
}

/**
 * Calculate similarity between two strings (simple implementation)
 * Returns a value between 0 and 1
 */
export function calculateSimilarity(str1: string, str2: string): number {
  const words1 = new Set(str1.toLowerCase().split(/\s+/));
  const words2 = new Set(str2.toLowerCase().split(/\s+/));
  
  const intersection = new Set(Array.from(words1).filter(x => words2.has(x)));
  const union = new Set([...Array.from(words1), ...Array.from(words2)]);
  
  return union.size > 0 ? intersection.size / union.size : 0;
}
