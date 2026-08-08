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
