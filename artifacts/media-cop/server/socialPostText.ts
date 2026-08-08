// Server-side cleaner for social-post bodies (X / Truth Social / DataMinr).
// The VM relay bridge stores post content with its source HTML intact (e.g.
// `<p>...</p>`, `<br>`, encoded entities), which then leaks into the curated
// card as literal `</p>` text. This mirrors the client-side `cleanTruthContent`
// presentation cleaner so the curated lane can strip tags + decode entities at
// ingest (and at boot heal) instead of relying on every reader to clean it.
// Plain text in → unchanged out (entity decode is a no-op when there's nothing
// to decode), so it is safe to run idempotently over already-clean rows.

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ""; }
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&hellip;/gi, "…")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&ldquo;/gi, "\u201C")
    .replace(/&rdquo;/gi, "\u201D")
    .replace(/&lsquo;/gi, "\u2018")
    .replace(/&rsquo;/gi, "\u2019");
}

export function cleanSocialPostText(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw;
  // Drop script/style blocks wholesale (content + tags).
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Preserve paragraph / line boundaries as newlines before stripping tags.
  s = s.replace(/<br\s*\/?>(\s*)/gi, "\n");
  s = s.replace(/<\/p>\s*<p[^>]*>/gi, "\n\n");
  // Strip all remaining tags, then any trailing incomplete tag left by an
  // upstream truncation (e.g. a title cut mid-"<p").
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/<[^>]*$/g, "");
  s = decodeEntities(s);
  // Tidy whitespace: trim trailing spaces before newlines, collapse runs.
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * True only when a social post has no substantive text and its body is either
 * blank or the exact synthetic placeholder emitted by our media scrapers.
 *
 * Wrapper punctuation is ignored so "[Media attachment]" and
 * "Media attachment" are equivalent, but real prose that merely contains those
 * words is preserved.
 */
export function isAttachmentOnlySocialContent(
  raw: string | null | undefined,
): boolean {
  const clean = cleanSocialPostText(raw).trim().toLowerCase();
  if (!clean) return true;
  const unwrapped = clean.replace(/^[\[\](){}]+|[\[\](){}]+$/g, '').trim();
  return unwrapped === 'media attachment';
}

/**
 * X-ingestion policy: retain the post and any video attachment, but do not
 * persist a still image when the post has no substantive text.
 *
 * Truth Social deliberately does not opt in: its dedicated feed renders
 * image-only posts, while Curated story-photo selection rejects social sources
 * at the later source-aware boundary. Article and other non-social image
 * extraction must not pass through this helper.
 */
export function suppressAttachmentOnlySocialImage(
  content: string | null | undefined,
  imageUrl: string | null | undefined,
): string | null {
  if (!imageUrl || isAttachmentOnlySocialContent(content)) return null;
  return imageUrl;
}
