// Per-mode sizing for the Curated social feed bloc only (Task #252). The 3 / 2 /
// 1 column layout switcher steps the avatar-icon size and reading text up as the
// column count drops (fewer, wider columns = larger, more readable posts). These
// classes are applied ONLY when a curated feed is rendered with an explicit
// `scale` prop, so every other surface (Dashboard, Stream, War, CustomMcop) is
// untouched.
export type CuratedFeedScale = "sm" | "md" | "lg";

export interface CuratedScaleClasses {
  avatar: string; // square avatar / seal / logo size
  content: string; // main reading (post body) text
  author: string; // author display name
  meta: string; // timestamp / small meta text
}

export const CURATED_FEED_SCALE: Record<CuratedFeedScale, CuratedScaleClasses> = {
  // 3-column baseline — avatars a touch smaller than the legacy h-8 icons.
  sm: { avatar: "h-7 w-7", content: "text-[12px]", author: "text-[12px]", meta: "text-[11px]" },
  // 2-column — slightly larger avatars + reading text.
  md: { avatar: "h-9 w-9", content: "text-[13px]", author: "text-[12px]", meta: "text-[11px]" },
  // 1-column — larger still.
  lg: { avatar: "h-11 w-11", content: "text-[15px]", author: "text-[13px]", meta: "text-[12px]" },
};

// ── Width-driven scale step-up (Task #43) ────────────────────────────────────
// A resizable column that renders scaled social feeds derives a step-up "tier"
// (0 / +1 / +2 scale notches) from the ratio of its MEASURED pixel width to its
// EXPECTED width at the base fr weight (no drag). Hysteresis bands prevent
// flicker at the drag boundary:
//   tier 1: step UP at ≥1.15× base, step DOWN below 1.10×
//   tier 2: step UP at ≥1.45× base, step DOWN below 1.40×
// Between a tier's up/down thresholds the current tier is held.
const TIER_UP = [1.15, 1.45];
const TIER_DOWN = [1.1, 1.4];

/** Next hysteresis tier given the current tier and the measured/base widths. */
export function nextWidthTier(current: number, width: number, basePx: number): number {
  if (!(width > 0) || !(basePx > 0)) return current;
  const r = width / basePx;
  let t = Math.min(TIER_UP.length, Math.max(0, current));
  while (t < TIER_UP.length && r >= TIER_UP[t]) t++;
  while (t > 0 && r < TIER_DOWN[t - 1]) t--;
  return t;
}

const SCALE_ORDER: CuratedFeedScale[] = ["sm", "md", "lg"];

/** Step a base scale up by `tiers` notches (clamped to the sm→md→lg ladder). */
export function bumpCuratedScale(base: CuratedFeedScale, tiers: number): CuratedFeedScale {
  const idx = Math.min(
    SCALE_ORDER.length - 1,
    Math.max(0, SCALE_ORDER.indexOf(base) + Math.max(0, tiers)),
  );
  return SCALE_ORDER[idx];
}
