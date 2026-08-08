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

export function htmlToSmsText(raw: string | null | undefined): string {
  if (!raw) return "";

  let s = raw;

  s = s.replace(
    new RegExp(`<span[^>]*\\bclass=${ATTR}[^>]*>[\\s\\S]*?<\\/span>`, "gi"),
    (match) => {
      if (/\bclass=(?:"[^"]*\bquote-inline\b[^"]*"|'[^']*\bquote-inline\b[^']*'|\S*\bquote-inline\b\S*)/i.test(match)) return "";
      if (/\bclass=(?:"[^"]*\binvisible\b[^"]*"|'[^']*\binvisible\b[^']*'|\S*\binvisible\b\S*)/i.test(match)) return "";
      if (/\bclass=(?:"[^"]*\bellipsis\b[^"]*"|'[^']*\bellipsis\b[^']*'|\S*\bellipsis\b\S*)/i.test(match)) {
        return match.replace(/^<span[^>]*>/i, "").replace(/<\/span>$/i, "") + "…";
      }
      return match;
    },
  );

  s = s.replace(
    new RegExp(`<a\\b[^>]*\\bhref=(${ATTR})[^>]*>[\\s\\S]*?<\\/a>`, "gi"),
    (_m, hrefAttr) => {
      const url = String(hrefAttr).replace(/^['"]|['"]$/g, "");
      return ` ${url} `;
    },
  );

  s = s.replace(/<br\s*\/?>/gi, " ");
  s = s.replace(/<\/p>\s*<p[^>]*>/gi, " ");
  s = s.replace(/<[^>]+>/g, "");

  s = decodeEntities(s);

  return s.replace(/\s+/g, " ").trim();
}
