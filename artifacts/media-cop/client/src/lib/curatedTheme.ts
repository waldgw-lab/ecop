export type CuratedTheme = "light" | "dark";

export const CURATED_THEME_STORAGE_KEY = "mcop.curated.theme";

/**
 * Curated is intentionally dark unless a viewer has explicitly selected light.
 * Invalid or absent persisted values are treated as no preference.
 */
export function resolveCuratedTheme(value: string | null | undefined): CuratedTheme {
  return value === "light" ? "light" : "dark";
}