import { useCallback, useEffect, useRef } from "react";
import {
  PREFERRED_VIEW_STORAGE_KEY,
  getPreferredView,
  isPreferredViewLocallyAuthoritative,
  type PreferredView,
} from "./preferredView";

// All localStorage keys that are synced to the user's Replit account.
// Versioned keys are listed as-is; any key change bumps its version string
// on the localStorage side (the server just stores whatever string we give it).
export const CURATED_SYNC_KEYS = [
  "curatedLayoutConfig",
  "curatedBoardLayoutV2",
  "curatedColumnWeightsV1",
  "curatedSocialRowHeightV1",
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
  // Post-login default-view choice (Classic/Visual/Curated) from /select-view.
  "mcop.preferredView:v1",
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
 * An EXPLICIT null value for a key means the user cleared it on another device
 * (e.g. via "Reset to defaults"). We honour that by removing the local key so
 * the reset propagates — the component's load helpers will then fall back to
 * their built-in defaults and write them back on the next state-change push.
 *
 * A key that is ABSENT from the snapshot (undefined — e.g. a legacy server
 * snapshot saved before that key existed) is left untouched locally: absence
 * is "no information", not a reset. Without this, adding a new key to
 * CURATED_SYNC_KEYS would erase every existing user's local value for it on
 * their next Curated hydration.
 */
export function applyPrefsToLocalStorage(snap: PrefsSnapshot): void {
  for (const key of CURATED_SYNC_KEYS) {
    if (!(key in snap)) continue; // absent ≠ cleared — keep the local value
    // If the user just picked a default view on the splash this session, that
    // choice outranks any server snapshot fetched concurrently (e.g. Curated
    // mounting right after the pick, before the splash's PUT landed). Skipping
    // here also means later full-snapshot pushes re-send the NEW value.
    if (key === PREFERRED_VIEW_STORAGE_KEY && isPreferredViewLocallyAuthoritative()) {
      continue;
    }
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
 * Immediately sync the default-view choice (mcop.preferredView:v1) to the
 * server for Replit-authenticated users — used by the /select-view splash,
 * which lives OUTSIDE the Curated page where the debounced sync hook mounts.
 *
 * Read-merge-write: fetches the current server snapshot and overwrites ONLY
 * the preferred-view key, so a stale local copy of the other curated settings
 * can never clobber the server's. Cleared locally → explicit null on the
 * server, so the reset propagates to other devices. Silently no-ops for
 * password-only users (the GET returns 401) and on any network failure —
 * localStorage remains the source of truth on this device either way.
 */
/**
 * Read ONLY the default-view key from the server snapshot without touching
 * localStorage. Returns:
 *   { present: true,  value }  — the server snapshot contains the key
 *                                (value is a valid view or null = cleared)
 *   { present: false }         — no server info (401 password-only user,
 *                                legacy snapshot without the key, network
 *                                failure): callers keep the local value.
 */
export async function fetchServerPreferredView(): Promise<
  { present: true; value: PreferredView | null } | { present: false }
> {
  try {
    const res = await fetch("/api/curated/preferences", { credentials: "include" });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const keys =
        data && typeof data === "object" && data.keys
          ? (data.keys as Record<string, unknown>)
          : null;
      if (keys && PREFERRED_VIEW_STORAGE_KEY in keys) {
        const v = keys[PREFERRED_VIEW_STORAGE_KEY];
        if (v === "classic" || v === "visual" || v === "curated") {
          return { present: true, value: v };
        }
        if (v === null) return { present: true, value: null };
      }
    }
  } catch {
    // Network failure — treat as no server info.
  }
  return { present: false };
}

/**
 * Resolve the effective default view for ROUTING decisions (post-login and
 * authenticated root landings): server value wins when present — this is what
 * carries a Replit user's choice to a second device with an empty
 * localStorage — and is mirrored into localStorage (explicit null clears it,
 * propagating a reset). With no server info (password-only user, legacy
 * snapshot, network failure) the local value is the answer.
 */
export async function resolvePreferredView(): Promise<PreferredView | null> {
  const server = await fetchServerPreferredView();
  if (server.present) {
    try {
      if (server.value === null) {
        localStorage.removeItem(PREFERRED_VIEW_STORAGE_KEY);
      } else {
        localStorage.setItem(PREFERRED_VIEW_STORAGE_KEY, server.value);
      }
    } catch {
      // Private mode — the returned value still drives this page load.
    }
    return server.value;
  }
  return getPreferredView();
}

// All preferred-view pushes are SERIALIZED through a single promise chain so
// two rapid operations (e.g. Reset immediately followed by picking a view)
// can never interleave their read-merge-write cycles and finish out of order.
// Each queued operation reads localStorage at RUN time, so whichever runs last
// persists the latest local state; a generation counter additionally skips
// superseded intermediate writes entirely (a stale reset never reaches the
// server once a newer pick is queued).
let preferredViewPushChain: Promise<void> = Promise.resolve();
let preferredViewPushGen = 0;

export function pushPreferredViewToServer(): Promise<void> {
  const gen = ++preferredViewPushGen;
  preferredViewPushChain = preferredViewPushChain.then(() => {
    if (gen !== preferredViewPushGen) return; // superseded by a newer operation
    return doPushPreferredView();
  });
  return preferredViewPushChain;
}

async function doPushPreferredView(): Promise<void> {
  const KEY = PREFERRED_VIEW_STORAGE_KEY;
  let current: string | null = null;
  try {
    current = localStorage.getItem(KEY);
  } catch {
    // Private mode — nothing to push.
  }
  try {
    const res = await fetch("/api/curated/preferences", { credentials: "include" });
    if (!res.ok) return; // 401 password-only user, or transient failure.
    const data = await res.json().catch(() => null);
    const serverKeys: PrefsSnapshot =
      data && typeof data === "object" && data.keys ? (data.keys as PrefsSnapshot) : {};
    const keys: PrefsSnapshot = { ...serverKeys, [KEY]: current };
    await fetch("/api/curated/preferences", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ __v: 1, keys }),
      keepalive: true,
    });
  } catch {
    // Best-effort — the local value still wins on this device.
  }
}

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
