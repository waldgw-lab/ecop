// Single source of truth for recognizing an image URL that is NOT a real
// article photo. This covers three classes of "not a real photo":
//   1. Search-engine favicons (Google faviconV2)
//   2. Brand logos served by a logo CDN (Clearbit)
//   3. An outlet's generic "default / share" placeholder image — the branded
//      fallback an outlet serves as og:image when an article has no real lead
//      photo (ABC's `abc_news_default_*` is the canonical example).
//
// Detecting (3) matters because a placeholder that slips past this check is
// treated downstream as if the row already has a real photo: the enrichment
// pipeline skips fetching a real image / generating bullets, leaving the card
// stuck on the logo. The patterns below are intentionally specific (anchored to
// distinctive filename tokens) so a real article photo is never misclassified.
//
// IMPORTANT: keep the SQL mirror in server/streamPrefetch.ts
// (staleCuratedMediaFilters) in sync with this list — Postgres cannot import
// these regexes, so the curated backfill re-implements them as LIKE / ~* terms.
export const PLACEHOLDER_IMAGE_PATTERNS: RegExp[] = [
  /gstatic\.com\/faviconV2/i,
  /logo\.clearbit\.com/i,
  // ABC News generic default share image, e.g.
  //   s.abcnews.com/images/US/abc_news_default_2000x2000_update_16x9_992.jpg
  /abc_news_default/i,
  // Generic outlet "default" share placeholder: a branded default whose filename
  // carries a delimited `default` token immediately followed by a `<W>x<H>`
  // dimension marker (e.g. abc_news_default_2000x2000, default-1200x630).
  // Anchored to that distinctive "default + dimensions" shape so a real article
  // slug that merely contains the word "default" is never matched.
  /[-_/]default[-_]\d+x\d+/i,
  // NPR generic Facebook/social "default" share image — the branded NPR logo
  // NPR serves as og:image when an article has no real lead photo, e.g.
  //   media.npr.org/include/images/facebook-default-wide-s1400-c85.jpg
  // Anchored to NPR's static /include/images/facebook-default path: real NPR
  // article photos are served from npr.brightspotcdn.com or media.npr.org/assets/,
  // never from /include/images/, so a real photo is never misclassified.
  /media\.npr\.org\/include\/images\/facebook-default/i,
];

export function isPlaceholderImageUrl(u: string | null | undefined): boolean {
  return !!u && PLACEHOLDER_IMAGE_PATTERNS.some((re) => re.test(u));
}

// ---------------------------------------------------------------------------
// Image-dimension parser (pure buffer, no external dependency)
// ---------------------------------------------------------------------------
// Reads the pixel width and height from the binary header of a JPEG, PNG, or
// WebP buffer. Returns null when the format is unrecognised or the buffer is
// too short. Used by isOutletLogoByContent to distinguish logos from real
// article photos by shape rather than byte count.

export function parseImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature (89 50 4E 47 0D 0A 1A 0A), then IHDR at byte 8:
  //   4-byte chunk length, 4 bytes 'IHDR', 4-byte width (BE), 4-byte height (BE).
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // JPEG: FF D8 — scan segment chain for a SOF (Start Of Frame) marker.
  if (buffer.length >= 4 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let i = 2;
    while (i + 3 < buffer.length) {
      if (buffer[i] !== 0xFF) break;
      const marker = buffer[i + 1];
      // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 (all carry dimensions)
      if (
        (marker >= 0xC0 && marker <= 0xC3) ||
        (marker >= 0xC5 && marker <= 0xC7) ||
        (marker >= 0xC9 && marker <= 0xCB) ||
        (marker >= 0xCD && marker <= 0xCF)
      ) {
        if (i + 9 <= buffer.length) {
          return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
        }
      }
      if (i + 4 > buffer.length) break;
      const segLen = buffer.readUInt16BE(i + 2);
      if (segLen < 2) break;
      i += 2 + segLen;
    }
    return null;
  }

  // WebP: RIFF <4-byte size> WEBP <chunk-type> ...
  if (
    buffer.length >= 30 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    const chunkType = buffer.slice(12, 16).toString('ascii');

    // VP8X (extended): canvas width-1 at bytes 24-26, height-1 at bytes 27-29 (24-bit LE each)
    if (chunkType === 'VP8X' && buffer.length >= 30) {
      const w = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
      const h = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
      return { width: w, height: h };
    }

    // VP8L (lossless): signature byte 0x2F at offset 20, then 32-bit LE at 21-24:
    //   bits 0-13 = width-1, bits 14-27 = height-1
    if (chunkType === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2F) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
    }

    // VP8  (lossy): 3-byte frame tag at 20-22, key-frame start code 9D 01 2A at 23-25,
    //   then 16-bit LE at 26-27 (bits 0-13 = width), 16-bit LE at 28-29 (bits 0-13 = height)
    if (
      chunkType === 'VP8 ' && buffer.length >= 30 &&
      buffer[23] === 0x9D && buffer[24] === 0x01 && buffer[25] === 0x2A
    ) {
      const w = (buffer[26] | (buffer[27] << 8)) & 0x3FFF;
      const h = (buffer[28] | (buffer[29] << 8)) & 0x3FFF;
      return { width: w, height: h };
    }

    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Content-based brand-logo detector
// ---------------------------------------------------------------------------
// Some outlets serve BOTH their brand logo AND real article photos from the
// same opaque CDN with hashed URLs — making URL-pattern detection impossible.
// For those outlets we detect the logo by its PIXEL DIMENSIONS / ASPECT RATIO:
// a real news article photo is landscape and several hundred pixels wide, while
// a masthead logo is typically small and square or near-square.
//
// Byte count is kept only as a conservative fallback for images whose format
// the header parser cannot decode (very unusual in practice for WebP/JPEG/PNG).
//
// Add entries here (NOT to PLACEHOLDER_IMAGE_PATTERNS) when an outlet's logo
// and article photos share the same URL shape.

interface OutletLogoCdnConfig {
  /** Exact hostname (or suffix match with a leading ".") to gate this check on. */
  domain: string;
  /**
   * Fallback byte-size threshold used ONLY when image dimensions cannot be
   * parsed from the buffer header (i.e. the format is unrecognised). Images
   * at or below this value are then treated as brand logos.
   */
  maxLogoBytes: number;
  /**
   * Primary dimension-based signal. When both fields are set, the decoded pixel
   * width and aspect ratio (width/height) are checked first:
   *
   *   REAL PHOTO  — width >= minPhotoWidth AND aspect >= minPhotoAspectRatio
   *   LOGO        — fails either threshold (small, square, or portrait)
   *
   * When dimensions cannot be parsed, falls back to maxLogoBytes.
   */
  minPhotoWidth?: number;
  minPhotoAspectRatio?: number;
}

export const OUTLET_LOGO_CDN_CONFIGS: OutletLogoCdnConfig[] = [
  // SPH Media publisher group (Singapore): the "logo-as-share-image" trick was
  // first observed on The Straits Times, whose brand "ST" masthead logo and real
  // article photos are both served from cassette.sphdigital.com.sg/image/
  // straitstimes/<hash> with no filename token distinguishing them.
  //
  // The original byte-size heuristic (≤ 20 KB = logo) was too aggressive: real
  // ST photos are WebP, which compresses dark or simple scenes very small — the
  // actual lead photo for a night missile-launch article is ~14.9 KB, well under
  // the old 20 KB gate. The correct discriminant is SHAPE:
  //
  //   Real article photos  — landscape, ≥ 400 px wide (e.g. 675×450, 800×533)
  //   Masthead logo        — small and near-square (e.g. 200×200)
  //
  // sphdigital.com.sg is SPH Media's shared image CDN covering every SPH title
  // (The Straits Times, The Business Times, Berita Harian, Lianhe Zaobao, The
  // New Paper, Tamil Murasu). We gate on the whole family suffix so sibling
  // titles added to the roster are automatically covered.
  //
  // maxLogoBytes is set conservatively at 8 KB (the actual ST logo is ~6 KB) as
  // a safety net for images whose WebP/JPEG/PNG header cannot be parsed — a
  // situation vanishingly rare in practice for well-formed CDN images.
  {
    domain: 'sphdigital.com.sg',
    maxLogoBytes: 8 * 1024,
    minPhotoWidth: 400,
    minPhotoAspectRatio: 1.2,
  },
];

/**
 * Returns true when the fetched image buffer is an outlet brand logo rather
 * than a real article photo. Detection uses pixel dimensions parsed from the
 * image header as the primary signal (width + aspect ratio), falling back to
 * raw byte count only when the format is unrecognised.
 *
 * Only fires for CDN+outlet pairs in OUTLET_LOGO_CDN_CONFIGS; never matches
 * arbitrary URLs. Call this AFTER fetching the image bytes so the check uses
 * the actual payload, not a declared Content-Length.
 */
export function isOutletLogoByContent(buffer: Buffer, sourceUrl: string): boolean {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    for (const cfg of OUTLET_LOGO_CDN_CONFIGS) {
      if (host === cfg.domain || host.endsWith('.' + cfg.domain)) {
        if (cfg.minPhotoWidth !== undefined && cfg.minPhotoAspectRatio !== undefined) {
          // PRIMARY: dimension-based detection — parse the image header.
          const dims = parseImageDimensions(buffer);
          if (dims !== null) {
            const aspect = dims.width / dims.height;
            const isRealPhoto = dims.width >= cfg.minPhotoWidth && aspect >= cfg.minPhotoAspectRatio;
            return !isRealPhoto;
          }
          // Dimensions not parseable — fall through to the byte-size fallback.
        }
        // FALLBACK: reject by byte count when dimensions can't be parsed.
        if (buffer.length <= cfg.maxLogoBytes) {
          return true;
        }
      }
    }
  } catch {
    // Malformed URL — not a logo.
  }
  return false;
}
