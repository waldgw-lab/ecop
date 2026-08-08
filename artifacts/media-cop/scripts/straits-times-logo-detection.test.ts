/**
 * Regression test for the Straits Times brand-logo content detector.
 *
 * The Straits Times serves BOTH their "ST" masthead logo AND real article photos
 * from the same opaque CDN URL shape (cassette.sphdigital.com.sg/image/straitstimes/<hash>)
 * with no filename token distinguishing them. The URL-pattern detector added for
 * ABC's abc_news_default_* cannot catch this. Instead, isOutletLogoByContent()
 * detects the logo by PIXEL DIMENSIONS / ASPECT RATIO parsed from the image header:
 *
 *   Real article photos  — landscape, width >= 400 px (e.g. 675×450, 800×533)
 *   Masthead logo        — small and near-square (e.g. 200×200)
 *
 * Byte count is kept only as a fallback for images whose format the header
 * parser cannot decode; the conservative threshold is 8 KB (the actual ST logo
 * is ~6 KB).
 *
 * This test asserts:
 *   (A) The core regression: a small (~15 KB) real landscape WebP photo from
 *       the ST CDN is NOT detected as a logo — it must pass through.
 *   (B) The masthead logo (small, near-square WebP) IS detected as a logo.
 *   (C) Byte-size fallback: an opaque buffer with no parseable image header is
 *       rejected only when it is ≤ 8 KB (the conservative fallback threshold).
 *   (D) SPH publisher-group family coverage: sibling subdomains still work.
 *   (E) Unrelated CDNs are never matched.
 *   (F) isPlaceholderImageUrl does NOT block a raw ST CDN URL.
 *   (G) shouldStampCuratedMediaDone returns false for a favicon so the row
 *       stays retryable.
 *   (H) OUTLET_LOGO_CDN_CONFIGS is present and structured correctly.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/straits-times-logo-detection.test.ts
 * Exits non-zero on any failure.
 */

import {
  isOutletLogoByContent,
  isPlaceholderImageUrl,
  parseImageDimensions,
  OUTLET_LOGO_CDN_CONFIGS,
} from "../shared/placeholderImage";
import { shouldStampCuratedMediaDone } from "../server/streamPrefetch";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS [${label}]`);
  } else {
    failed++;
    console.error(`FAIL [${label}]`);
  }
}

const ST_CDN = "https://cassette.sphdigital.com.sg/image/straitstimes/abc123";

// ---------------------------------------------------------------------------
// WebP header helpers
// ---------------------------------------------------------------------------
// Build a minimal VP8X WebP header for a given width × height. The rest of
// the buffer is zeroed padding so we can control the total byte count.
function makeWebPVP8X(width: number, height: number, totalBytes: number): Buffer {
  const header = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // 'RIFF'
    0x00, 0x00, 0x00, 0x00, // file size (dummy)
    0x57, 0x45, 0x42, 0x50, // 'WEBP'
    0x56, 0x50, 0x38, 0x58, // 'VP8X'
    0x0A, 0x00, 0x00, 0x00, // chunk size = 10
    0x00,                   // flags
    0x00, 0x00, 0x00,       // reserved
    // canvas width - 1 (24-bit LE)
    (width - 1) & 0xFF, ((width - 1) >> 8) & 0xFF, ((width - 1) >> 16) & 0xFF,
    // canvas height - 1 (24-bit LE)
    (height - 1) & 0xFF, ((height - 1) >> 8) & 0xFF, ((height - 1) >> 16) & 0xFF,
  ]); // 30 bytes
  const padLen = Math.max(0, totalBytes - header.length);
  return Buffer.concat([header, Buffer.alloc(padLen)]);
}

// ---------------------------------------------------------------------------
// (A) Core regression: small real landscape WebP must NOT be detected as logo
// ---------------------------------------------------------------------------
// The reported bug: a 14.9 KB WebP at 675×450 (landscape, aspect ~1.5) was
// wrongly rejected by the old 20 KB byte-size gate. With the dimension-based
// detector it must pass through.

const smallLandscapeWebP = makeWebPVP8X(675, 450, Math.round(14.9 * 1024));
check(
  "(A1) 14.9 KB WebP 675×450 from ST CDN → NOT a logo (main regression fix)",
  !isOutletLogoByContent(smallLandscapeWebP, ST_CDN),
);

const standardPhotoWebP = makeWebPVP8X(800, 533, 50 * 1024);
check(
  "(A2) 50 KB WebP 800×533 from ST CDN → NOT a logo (standard article photo)",
  !isOutletLogoByContent(standardPhotoWebP, ST_CDN),
);

const minimalLandscapeWebP = makeWebPVP8X(400, 300, 5 * 1024);
check(
  "(A3) 5 KB WebP 400×300 (just at width threshold, aspect 1.33) → NOT a logo",
  !isOutletLogoByContent(minimalLandscapeWebP, ST_CDN),
);

// ---------------------------------------------------------------------------
// (B) Masthead logo (small, near-square) IS detected as a logo
// ---------------------------------------------------------------------------
const squareLogoWebP = makeWebPVP8X(200, 200, 6 * 1024);
check(
  "(B1) 6 KB WebP 200×200 (square) from ST CDN → IS a logo",
  isOutletLogoByContent(squareLogoWebP, ST_CDN),
);

const nearSquareLogoWebP = makeWebPVP8X(250, 220, 7 * 1024);
check(
  "(B2) 7 KB WebP 250×220 (near-square, aspect ~1.14) from ST CDN → IS a logo",
  isOutletLogoByContent(nearSquareLogoWebP, ST_CDN),
);

const narrowLogoWebP = makeWebPVP8X(300, 150, 5 * 1024);
check(
  "(B3) 5 KB WebP 300×150 (narrow, width < 400) from ST CDN → IS a logo",
  isOutletLogoByContent(narrowLogoWebP, ST_CDN),
);

// ---------------------------------------------------------------------------
// (C) Byte-size fallback: opaque buffers with no parseable image header
// ---------------------------------------------------------------------------
// When dimensions can't be parsed the fallback threshold is 8 KB (≤ 8 KB = logo).

const smallOpaqueBuffer = Buffer.alloc(6 * 1024, 0);   // 6 KB zeros, no valid header
const largeOpaqueBuffer = Buffer.alloc(20 * 1024, 0);  // 20 KB zeros, no valid header

check(
  "(C1) 6 KB opaque buffer (no parseable header) from ST CDN → IS a logo (byte fallback)",
  isOutletLogoByContent(smallOpaqueBuffer, ST_CDN),
);
check(
  "(C2) 20 KB opaque buffer (no parseable header) from ST CDN → NOT a logo (above 8 KB fallback)",
  !isOutletLogoByContent(largeOpaqueBuffer, ST_CDN),
);
check(
  "(C3) http:// variant of ST CDN URL with 6 KB opaque buffer → IS a logo",
  isOutletLogoByContent(smallOpaqueBuffer, "http://cassette.sphdigital.com.sg/image/straitstimes/def456"),
);

// ---------------------------------------------------------------------------
// (D) SPH publisher-group family coverage
// ---------------------------------------------------------------------------
// The config gates on the whole sphdigital.com.sg family so sibling titles
// (Business Times, Zaobao, etc.) on any SPH subdomain are also covered.

const ZB_CDN = "https://static1.sphdigital.com.sg/image/zaobao/aabbcc";
const BT_CDN = "https://cassette.sphdigital.com.sg/image/businesstimes/xyz789";

check(
  "(D1) 6 KB WebP 200×200 from sibling Zaobao subdomain → IS a logo",
  isOutletLogoByContent(squareLogoWebP, ZB_CDN),
);
check(
  "(D2) 50 KB WebP 800×533 from sibling Zaobao subdomain → NOT a logo (real photo)",
  !isOutletLogoByContent(standardPhotoWebP, ZB_CDN),
);
check(
  "(D3) 14.9 KB WebP 675×450 from BusinessTimes (cassette) → NOT a logo",
  !isOutletLogoByContent(smallLandscapeWebP, BT_CDN),
);
check(
  "(D4) 6 KB WebP 200×200 from BusinessTimes (cassette) → IS a logo",
  isOutletLogoByContent(squareLogoWebP, BT_CDN),
);

// ---------------------------------------------------------------------------
// (E) Unrelated CDNs are NEVER detected (gate is host-specific)
// ---------------------------------------------------------------------------
const otherCdn = "https://images.example-newspaper.com/photo/hash123";

check("(E1) 6 KB buffer from unrelated CDN → NOT detected", !isOutletLogoByContent(smallOpaqueBuffer, otherCdn));
check("(E2) 1 KB buffer from unrelated CDN → NOT detected", !isOutletLogoByContent(Buffer.alloc(1024), otherCdn));
check("(E3) small square WebP from unrelated CDN → NOT detected", !isOutletLogoByContent(squareLogoWebP, otherCdn));
check("(E4) Malformed URL → NOT detected (no throw)", !isOutletLogoByContent(smallOpaqueBuffer, "not-a-url"));

// ---------------------------------------------------------------------------
// (F) isPlaceholderImageUrl does NOT match the raw ST CDN URL
// ---------------------------------------------------------------------------
// Real article photos from cassette.sphdigital.com.sg must NOT be blocked by
// the URL-pattern check. The content-based detector handles logos; if we also
// added a URL pattern, large real photos from the same CDN would be suppressed.
check(
  "(F1) isPlaceholderImageUrl does NOT match raw ST CDN URL",
  !isPlaceholderImageUrl(ST_CDN),
);
check(
  "(F2) isPlaceholderImageUrl still matches faviconV2",
  isPlaceholderImageUrl("https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&url=https://straitstimes.com"),
);

// ---------------------------------------------------------------------------
// (G) shouldStampCuratedMediaDone is false for a favicon image URL
// ---------------------------------------------------------------------------
// After logo detection, fetchAndPersistImage returns null. The enrichment path
// then falls back to the Google favicon URL. shouldStampCuratedMediaDone must
// return false so the row is placed on the retryable path, NOT stamped done.
check(
  "(G1) shouldStampCuratedMediaDone(false, false) → false (favicon → retryable)",
  shouldStampCuratedMediaDone(false, false) === false,
);
check(
  "(G2) shouldStampCuratedMediaDone(false, true) → false (favicon + refusal → retryable)",
  shouldStampCuratedMediaDone(false, true) === false,
);
check(
  "(G3) shouldStampCuratedMediaDone(true, false) → true (real image → done)",
  shouldStampCuratedMediaDone(true, false) === true,
);

// ---------------------------------------------------------------------------
// (H) parseImageDimensions works correctly for each format
// ---------------------------------------------------------------------------
// Verify the header parser itself (used inside isOutletLogoByContent).

const parsedLandscape = parseImageDimensions(smallLandscapeWebP);
check(
  "(H1) parseImageDimensions reads 675 width from VP8X WebP",
  parsedLandscape?.width === 675,
);
check(
  "(H2) parseImageDimensions reads 450 height from VP8X WebP",
  parsedLandscape?.height === 450,
);

const parsedSquare = parseImageDimensions(squareLogoWebP);
check("(H3) parseImageDimensions reads 200×200 from square WebP", parsedSquare?.width === 200 && parsedSquare?.height === 200);

check(
  "(H4) parseImageDimensions returns null for opaque all-zeros buffer",
  parseImageDimensions(smallOpaqueBuffer) === null,
);

// PNG header check
const pngBuf = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
  0x00, 0x00, 0x00, 0x0D,                           // IHDR chunk length = 13
  0x49, 0x48, 0x44, 0x52,                           // 'IHDR'
  0x00, 0x00, 0x03, 0x84,                           // width = 900 (big-endian)
  0x00, 0x00, 0x02, 0x58,                           // height = 600 (big-endian)
  0x08, 0x02, 0x00, 0x00, 0x00,                     // bit depth + colour type + etc
]);
const parsedPng = parseImageDimensions(pngBuf);
check("(H5) parseImageDimensions reads 900×600 from PNG header", parsedPng?.width === 900 && parsedPng?.height === 600);

// ---------------------------------------------------------------------------
// (I) OUTLET_LOGO_CDN_CONFIGS is present and structured correctly
// ---------------------------------------------------------------------------
check(
  "(I1) OUTLET_LOGO_CDN_CONFIGS has at least one entry",
  OUTLET_LOGO_CDN_CONFIGS.length >= 1,
);
check(
  "(I2) SPH CDN entry gates on the whole 'sphdigital.com.sg' family",
  OUTLET_LOGO_CDN_CONFIGS.some(c => c.domain === 'sphdigital.com.sg'),
);
check(
  "(I3) SPH CDN entry has minPhotoWidth set (dimension-based detection active)",
  OUTLET_LOGO_CDN_CONFIGS.some(c => c.domain === 'sphdigital.com.sg' && typeof c.minPhotoWidth === 'number'),
);
check(
  "(I4) SPH CDN entry has minPhotoAspectRatio set (dimension-based detection active)",
  OUTLET_LOGO_CDN_CONFIGS.some(c => c.domain === 'sphdigital.com.sg' && typeof c.minPhotoAspectRatio === 'number'),
);
check(
  "(I5) SPH CDN fallback maxLogoBytes is positive and ≤ 8192 (8 KB)",
  OUTLET_LOGO_CDN_CONFIGS.every(c => c.domain !== 'sphdigital.com.sg' || (c.maxLogoBytes > 0 && c.maxLogoBytes <= 8 * 1024)),
);
check(
  "(I6) every config entry has a positive maxLogoBytes",
  OUTLET_LOGO_CDN_CONFIGS.every(c => typeof c.maxLogoBytes === 'number' && c.maxLogoBytes > 0),
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
