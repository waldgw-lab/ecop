import { useCallback, useEffect, useRef } from "react";

// All localStorage keys that are synced to the user's Replit account.
// Versioned keys are listed as-is; any key change bumps its version string
// on the localStorage side (the server just stores whatever string we give it).
export const CURATED_SYNC_KEYS = [
  "curatedLayoutConfig",
  "curatedBoardLayoutV2",
  "curatedColumnWeightsV1",
  "selectedUsXFeedAccounts:v3",
  "curatedSocialLayout",
  "selectedOsintXFeedAccounts:v2",
  "selectedPressXFeedAccounts:v2",
  "curatedHideRepostsUsXFeed:v2",
  "curatedHideRepostsOsintFeed:v2",
  "curatedHideRepostsPressFeed:v2",
  "mcop-curated-custom-feed-v3",
  "mcop-curated-custom-feed-views-v1",
  "mcop-curated-custom-feed-keywords-v1",
  "mcop.curated.timezone",
  "mcop.curated.theme",
] as const;

export type SyncKey = typeof CURATED_SYNC_KEYS[number];
export type PrefsSnapshot = Partial<Record<SyncKey, string | null>>;

/** Read all sync keys from localStorage into a snapshot object. */
export function snapshotPrefs(): PrefsSnapshot {
  const snap: PrefsSnapshot = {};
  for (const key of CURATED_SYNC_KEYS) {
    try {
      snap[key] = localStorage.getItem(key);
    } catch {
      snap[key] = null;
    }
  }
  return snap;
}

/**
 * Apply a server snapshot to localStorage.
 *
 * A null value for a key means the user cleared it on another device (e.g. via
 * "Reset to defaults"). We honour that by removing the local key so the reset
 * propagates — the component's load helpers will then fall back to their
 * built-in defaults and write them back on the next state-change push.
 */
export function applyPrefsToLocalStorage(snap: PrefsSnapshot): void {
  for (const key of CURATED_SYNC_KEYS) {
    const val = snap[key];
    try {
      if (val == null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, val);
      }
    } catch {
      // Private mode / quota — ignore.
    }
  }
}

/** Returns true when a snapshot contains at least one non-null value. */
export function snapshotHasData(snap: PrefsSnapshot): boolean {
  return CURATED_SYNC_KEYS.some((k) => snap[k] != null);
}

const PUSH_DEBOUNCE_MS = 3000;

/**
 * Syncs Curated settings between localStorage and the server for Replit users.
 *
 * Behaviour:
 * - On mount (Replit user): fetches server prefs.
 *   • Server has data  → writes to localStorage, calls `onApply(snap)`.
 *   • Server is empty  → seeds server from current localStorage (first-login merge).
 * - `push()`: call whenever any setting changes; debounces a server write.
 *   Pushes are suppressed until the initial hydration fetch has resolved to
 *   prevent the local state from overwriting server prefs on slower networks.
 * - Non-Replit (password-only) users: all operations are no-ops.
 *
 * `onApply` must update React state from the freshly-written localStorage values.
 */
export function useCuratedPrefsSync({
  replitUserId,
  onApply,
}: {
  replitUserId: string | null | undefined;
  onApply: (snap: PrefsSnapshot) => void;
}): { push: () => void } {
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;

  // Set to true once the initial hydration fetch has resolved (either applied
  // server prefs or confirmed there are none). Outbound pushes are suppressed
  // until this flag is set to prevent the local state from racing ahead and
  // overwriting server prefs on slow networks.
  const hydratedRef = useRef(false);
  // When not a Replit user there is no fetch to wait for — allow pushes
  // immediately (they will no-op on the !replitUserId check anyway).
  if (!replitUserId) hydratedRef.current = true;

  // Immediately send any pending (debounced) save. Used when the page is being
  // hidden/closed or the component unmounts, so a change made inside the
  // debounce window isn't lost. `keepalive: true` lets the browser complete the
  // request even after the page goes away (payload is a few KB, well under the
  // 64KB keepalive cap).
  const flushPending = useCallback(() => {
    if (pendingRef.current === null) return;
    clearTimeout(pendingRef.current);
    pendingRef.current = null;
    if (!replitUserId || !hydratedRef.current) return;
    const snap = snapshotPrefs();
    if (!snapshotHasData(snap)) return;
    try {
      void fetch("/api/curated/preferences", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ __v: 1, keys: snap }),
        keepalive: true,
      }).catch(() => {
        // Best-effort — a missed push is recoverable on the next change.
      });
    } catch {
      // Best-effort.
    }
  }, [replitUserId]);

  // Debounced server push: reads a fresh snapshot from localStorage each time
  // so it always captures the most recent written values regardless of whether
  // React has batched multiple state updates yet.
  const push = useCallback(() => {
    if (!replitUserId) return;
    // Suppress pushes until initial hydration is complete to avoid overwriting
    // a server copy that hasn't been loaded yet.
    if (!hydratedRef.current) return;
    if (pendingRef.current !== null) clearTimeout(pendingRef.current);
    pendingRef.current = setTimeout(async () => {
      pendingRef.current = null;
      const snap = snapshotPrefs();
      if (!snapshotHasData(snap)) return;
      try {
        await fetch("/api/curated/preferences", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ __v: 1, keys: snap }),
        });
      } catch {
        // Best-effort — a missed push is recoverable on the next change.
      }
    }, PUSH_DEBOUNCE_MS);
  }, [replitUserId]);

  // On mount: load prefs from server for Replit-logged-in users.
  useEffect(() => {
    if (!replitUserId) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/curated/preferences", { credentials: "include" });
        if (cancelled || !res.ok) {
          // Network failure or non-200: stay local; allow pushes so subsequent
          // changes aren't silently dropped.
          hydratedRef.current = true;
          return;
        }
        const data = await res.json();
        if (cancelled) return;

        if (data && typeof data === "object" && data.keys) {
          // Server has saved preferences — apply them before allowing pushes.
          const snap = data.keys as PrefsSnapshot;
          applyPrefsToLocalStorage(snap);
          onApplyRef.current(snap);
        } else {
          // No server prefs yet (first login after this feature ships).
          // Seed from whatever the user already had in localStorage.
          const snap = snapshotPrefs();
          if (snapshotHasData(snap)) {
            try {
              await fetch("/api/curated/preferences", {
                method: "PUT",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ __v: 1, keys: snap }),
              });
            } catch {
              // Best-effort seed.
            }
          }
        }
      } catch {
        // Network failure — stay local, no disruption.
      } finally {
        if (!cancelled) {
          // Hydration complete (success or failure); allow future pushes.
          hydratedRef.current = true;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [replitUserId]);

  // Flush a pending save when the tab is hidden or the page is being unloaded
  // (mobile tab switch, browser close), so a change made within the debounce
  // window isn't lost. Also flush (instead of dropping) on unmount, which
  // covers in-app navigation away from Curated.
  useEffect(() => {
    if (!replitUserId) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushPending();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flushPending);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flushPending);
      flushPending();
    };
  }, [replitUserId, flushPending]);

  return { push };
}
