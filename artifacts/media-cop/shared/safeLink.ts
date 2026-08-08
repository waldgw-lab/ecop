// Safe-link / isolation-proxy unwrapper.
//
// Some links arrive wrapped in a "safe link" isolation proxy that prepends its
// own host in front of the real article URL, e.g. Menlo Security:
//   https://safe.menlosecurity.com/https://www.cnn.com/2026/06/23/politics/...
// or with the inner URL percent-encoded:
//   https://safe.menlosecurity.com/https%3A%2F%2Fwww.cnn.com%2F2026%2F06%2F23%2F...
//
// Fetching the wrapper URL returns the proxy's isolation shell (or is blocked),
// so any metadata/scrape work must run against the EMBEDDED real article URL.
// This detects a generic wrapper of the form `<proxy-host>/<embedded http(s) URL>`
// and returns the embedded URL. If no wrapper is present, the input is returned
// unchanged. It never throws on malformed input.

// Matches the start of an embedded http(s) URL, either plain (`https://`) or
// percent-encoded (`https%3A%2F%2F`). Case-insensitive.
const EMBEDDED_URL_RE = /https?:\/\/|https?%3a%2f%2f/gi;

export function unwrapSafeLink(rawUrl: string): string {
  try {
    if (typeof rawUrl !== 'string') return rawUrl;
    const url = rawUrl.trim();
    if (!url) return rawUrl;

    // Find every embedded http(s) URL marker. The one at index 0 is the wrapper
    // (outer) URL itself; any marker after position 0 is an embedded URL. If
    // there are several embedded markers, use the LAST one.
    EMBEDDED_URL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let lastEmbeddedIndex = -1;
    while ((match = EMBEDDED_URL_RE.exec(url)) !== null) {
      if (match.index > 0) lastEmbeddedIndex = match.index;
      // Guard against zero-length matches causing an infinite loop.
      if (match.index === EMBEDDED_URL_RE.lastIndex) EMBEDDED_URL_RE.lastIndex++;
    }

    // No embedded URL after the wrapper host → not a wrapped link.
    if (lastEmbeddedIndex <= 0) return rawUrl;

    let embedded = url.slice(lastEmbeddedIndex);

    // Percent-decode if the inner URL is encoded.
    if (/^https?%3a%2f%2f/i.test(embedded)) {
      try {
        embedded = decodeURIComponent(embedded);
      } catch {
        // Best-effort decode of just the scheme delimiters if the full string
        // has an invalid percent-sequence somewhere.
        embedded = embedded.replace(/%3a/gi, ':').replace(/%2f/gi, '/');
      }
    }

    // Only accept the result if it parses as a real URL; otherwise leave the
    // original untouched so we never make a bad link worse.
    try {
      // eslint-disable-next-line no-new
      new URL(embedded);
    } catch {
      return rawUrl;
    }

    return embedded;
  } catch {
    return rawUrl;
  }
}
