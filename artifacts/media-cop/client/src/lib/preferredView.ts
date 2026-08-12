// Post-login default-view preference (Task: view selection splash).
//
// After the shared MCOP password login, users pick Classic / Visual / Curated
// once on the /select-view splash; the choice is stored here and returning
// users are routed straight to it. The key is registered in CURATED_SYNC_KEYS
// so Replit-authenticated users get it synced across devices through the
// existing curated preferences sync; password-only users keep it in
// localStorage.

export type PreferredView = "classic" | "visual" | "curated";

export const PREFERRED_VIEW_STORAGE_KEY = "mcop.preferredView:v1";

export const PREFERRED_VIEW_PATHS: Record<PreferredView, string> = {
  classic: "/",
  visual: "/stream",
  curated: "/curated",
};

/** The three main-view roots that the saved-preference redirect may steer. */
export const VIEW_ROOT_PATHS = ["/", "/stream", "/curated"];

export function getPreferredView(): PreferredView | null {
  try {
    const v = localStorage.getItem(PREFERRED_VIEW_STORAGE_KEY);
    if (v === "classic" || v === "visual" || v === "curated") return v;
  } catch {
    // Private mode — treat as no preference.
  }
  return null;
}

export function setPreferredView(view: PreferredView): void {
  try {
    localStorage.setItem(PREFERRED_VIEW_STORAGE_KEY, view);
  } catch {
    // Private mode / quota — the splash will simply reappear next login.
  }
}

export function clearPreferredView(): void {
  try {
    localStorage.removeItem(PREFERRED_VIEW_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Local-authority guard ────────────────────────────────────────────────────
// Set the moment the user explicitly picks (or resets) a default on the
// splash, for the remainder of this page-load session. While set, preference
// HYDRATION from the server must not overwrite the preferred-view key in
// localStorage: the user's just-made choice is newer than any snapshot a
// concurrently-mounting page (e.g. Curated) may have fetched before the
// splash's PUT landed. Because hydration can no longer revert localStorage,
// any later full-snapshot push re-sends the NEW value rather than resurrecting
// the old one. A module-level flag is enough — splash → view navigation stays
// inside the SPA, and a fresh page load re-hydrates from the (by then updated)
// server copy.
let preferredViewLocallyAuthoritative = false;

export function markPreferredViewLocallyAuthoritative(): void {
  preferredViewLocallyAuthoritative = true;
}

export function isPreferredViewLocallyAuthoritative(): boolean {
  return preferredViewLocallyAuthoritative;
}

/**
 * Decide where to navigate right after a successful password login.
 *
 * - No saved default → the /select-view splash. A deep entry path (anything
 *   other than the three view roots) is carried along as ?return=… so the
 *   splash can send the user to their original destination after they pick.
 * - Saved default + entry on a view ROOT → the default view.
 * - Saved default + deep entry (e.g. /curated/archive) → null: stay put, the
 *   deep link is the explicit destination and is never hijacked.
 *
 * `entryPath` should include search/hash when available so query'd deep links
 * survive the round-trip.
 */
export function decidePostLoginDestination(
  pref: PreferredView | null,
  entryPath: string,
): string | null {
  const pathOnly = entryPath.split(/[?#]/)[0];
  const isViewRoot = VIEW_ROOT_PATHS.includes(pathOnly);
  if (!pref) {
    if (isViewRoot || pathOnly === "/select-view") return "/select-view";
    return "/select-view?return=" + encodeURIComponent(entryPath);
  }
  if (isViewRoot) return PREFERRED_VIEW_PATHS[pref];
  return null;
}

/**
 * Validate a ?return= destination from the splash. Only same-app absolute
 * paths are accepted; external URLs, protocol-relative "//host", backslash
 * variants, and any loop back to /select-view (including query/fragment
 * variants) are rejected with null. Validation goes through URL parsing
 * against a fixed internal origin so an input that escapes the origin in any
 * form is caught.
 */
export function sanitizeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  try {
    const base = "http://mcop.internal";
    const u = new URL(raw, base);
    if (u.origin !== base) return null;
    if (u.pathname === "/select-view") return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}
