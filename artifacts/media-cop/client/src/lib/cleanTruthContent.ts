import DOMPurify from "dompurify";

const ATTR = `(?:"[^"]*"|'[^']*'|[^\\s>]+)`;

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

export function cleanTruthContent(raw: string | null | undefined): string {
  if (!raw) return "";

  let html = raw;

  html = html.replace(
    new RegExp(`<span[^>]*\\bclass=${ATTR}[^>]*>[\\s\\S]*?<\\/span>`, "gi"),
    (match) => {
      if (/\bclass=(?:"[^"]*\bquote-inline\b[^"]*"|'[^']*\bquote-inline\b[^']*'|\S*\bquote-inline\b\S*)/i.test(match)) return "";
      if (/\bclass=(?:"[^"]*\binvisible\b[^"]*"|'[^']*\binvisible\b[^']*'|\S*\binvisible\b\S*)/i.test(match)) return "";
      return match;
    },
  );

  html = html.replace(
    /\bRT:\s*https?:\/\/truthsocial\.com\/[^\s<]+/gi,
    "",
  );

  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "div", "span", "a", "strong", "em", "b", "i"],
    ALLOWED_ATTR: ["href"],
  });

  const withBreaks = sanitized
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<\/?(p|div|span|a|strong|em|b|i)[^>]*>/gi, "");

  return decodeEntities(withBreaks).replace(/\n{3,}/g, "\n\n").trim();
}