// Regression test (run with: pnpm exec tsx --test client/src/lib/curatedPrefsSync.migration.test.ts
// from artifacts/media-cop). Guards the sync-key migration semantics:
//
// A server preferences snapshot saved BEFORE a new key was added to
// CURATED_SYNC_KEYS does not contain that key. Hydrating such a legacy
// snapshot must NOT erase the user's local value for the new key — absence is
// "no information", only an EXPLICIT null is a cross-device reset. Concretely:
// a Replit user with old server prefs picks a default view on /select-view,
// then opens Curated (which hydrates server prefs); the chosen default must
// survive.

import test from "node:test";
import assert from "node:assert/strict";

// Minimal localStorage stub for the node test runner.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};

// fetch stub — each test sets `nextResponse` before calling the code under
// test. PUT bodies are captured in `lastPutBody` so tests can assert what was
// persisted to the server.
let nextResponse: { ok: boolean; body?: unknown } = { ok: false };
let lastPutBody: any = null;
(globalThis as any).fetch = async (_url: string, init?: { method?: string; body?: string }) => {
  if (init?.method === "PUT") {
    lastPutBody = JSON.parse(init.body ?? "null");
    return { ok: true, json: async () => ({ ok: true }) };
  }
  return { ok: nextResponse.ok, json: async () => nextResponse.body };
};

const { applyPrefsToLocalStorage, resolvePreferredView } = await import(
  "./curatedPrefsSync"
);
const { pushPreferredViewToServer, snapshotPrefs } = await import(
  "./curatedPrefsSync"
);
const {
  decidePostLoginDestination,
  sanitizeReturnPath,
  markPreferredViewLocallyAuthoritative,
} = await import("./preferredView");

const PREF_KEY = "mcop.preferredView:v1";

test("legacy server snapshot without the preferred-view key preserves the local default", () => {
  store.clear();
  localStorage.setItem(PREF_KEY, "visual"); // chosen on /select-view
  localStorage.setItem("curatedSocialLayout", "2");

  // Legacy snapshot: predates the preferred-view key entirely.
  applyPrefsToLocalStorage({ curatedSocialLayout: "3" });

  assert.equal(localStorage.getItem(PREF_KEY), "visual"); // NOT erased
  assert.equal(localStorage.getItem("curatedSocialLayout"), "3"); // still applied
});

test("explicit null in the snapshot clears the local value (cross-device reset)", () => {
  store.clear();
  localStorage.setItem(PREF_KEY, "curated");

  applyPrefsToLocalStorage({ [PREF_KEY]: null });

  assert.equal(localStorage.getItem(PREF_KEY), null);
});

test("a present value in the snapshot overwrites the local value", () => {
  store.clear();
  localStorage.setItem(PREF_KEY, "classic");

  applyPrefsToLocalStorage({ [PREF_KEY]: "curated" });

  assert.equal(localStorage.getItem(PREF_KEY), "curated");
});

// ── post-login routing decisions (deep-link preservation) ───────────────────

test("unauthenticated deep-link login with no saved preference: splash carries the return path", () => {
  const dest = decidePostLoginDestination(null, "/curated/archive");
  assert.equal(dest, "/select-view?return=" + encodeURIComponent("/curated/archive"));
  // …and the splash restores it after any pick:
  assert.equal(
    sanitizeReturnPath(new URLSearchParams(dest!.split("?")[1]).get("return")),
    "/curated/archive",
  );
});

test("view-root login with no preference: plain splash, no return param", () => {
  assert.equal(decidePostLoginDestination(null, "/"), "/select-view");
  assert.equal(decidePostLoginDestination(null, "/stream"), "/select-view");
  assert.equal(decidePostLoginDestination(null, "/curated"), "/select-view");
});

test("saved preference: view roots redirect to it, deep links are never hijacked", () => {
  assert.equal(decidePostLoginDestination("visual", "/"), "/stream");
  assert.equal(decidePostLoginDestination("curated", "/stream"), "/curated");
  assert.equal(decidePostLoginDestination("visual", "/curated/archive"), null);
  assert.equal(decidePostLoginDestination("classic", "/mcop/foo?tab=x"), null);
});

test("sanitizeReturnPath rejects unsafe or looping destinations", () => {
  assert.equal(sanitizeReturnPath("https://evil.example"), null);
  assert.equal(sanitizeReturnPath("//evil.example"), null);
  assert.equal(sanitizeReturnPath("/\\evil.example"), null);
  assert.equal(sanitizeReturnPath("/select-view"), null);
  assert.equal(sanitizeReturnPath("/select-view?return=/x"), null);
  assert.equal(sanitizeReturnPath("/select-view#frag"), null);
  assert.equal(sanitizeReturnPath(""), null);
  assert.equal(sanitizeReturnPath("/curated/archive?d=2026-08-01"), "/curated/archive?d=2026-08-01");
});

// ── Race regression: changing an existing default to Curated ────────────────
// Scenario: user's server default is "visual"; on the splash they pick
// "curated" and are navigated into /curated, whose prefs hydration
// concurrently fetched the OLD server snapshot. Neither localStorage nor the
// next full-snapshot push may revert to "visual".

test("splash pick survives concurrent Curated hydration of the stale snapshot", async () => {
  store.clear();
  localStorage.setItem(PREF_KEY, "visual"); // previous default, already local

  // Splash pick: set local, mark authoritative, push (read-merge-write; the
  // GET still returns the OLD server snapshot).
  nextResponse = { ok: true, body: { __v: 1, keys: { [PREF_KEY]: "visual", curatedSocialLayout: "2" } } };
  localStorage.setItem(PREF_KEY, "curated");
  markPreferredViewLocallyAuthoritative();
  await pushPreferredViewToServer();

  // PUT payload carries the NEW value merged over the old snapshot.
  assert.equal(lastPutBody.keys[PREF_KEY], "curated");
  assert.equal(lastPutBody.keys.curatedSocialLayout, "2");

  // Curated mounts with a STALE snapshot fetched before the PUT landed and
  // hydrates it — the authoritative local pick must not be reverted...
  applyPrefsToLocalStorage({ [PREF_KEY]: "visual", curatedSocialLayout: "2" });
  assert.equal(localStorage.getItem(PREF_KEY), "curated");
  // ...while other synced keys still hydrate normally.
  assert.equal(localStorage.getItem("curatedSocialLayout"), "2");

  // Any later full-snapshot push (the Curated sync hook reads localStorage at
  // push time) re-sends the NEW value, not the stale one.
  assert.equal(snapshotPrefs()[PREF_KEY], "curated");
});

test("reset immediately followed by choosing a view: the choice wins on the server", async () => {
  store.clear();
  nextResponse = { ok: true, body: { __v: 1, keys: { [PREF_KEY]: "visual" } } };
  lastPutBody = null;

  // Reset (clears local, fire-and-forget push)…
  localStorage.removeItem(PREF_KEY);
  const resetPush = pushPreferredViewToServer();
  // …immediately followed by picking a new default before the reset resolves.
  localStorage.setItem(PREF_KEY, "curated");
  const choosePush = pushPreferredViewToServer();

  await Promise.all([resetPush, choosePush]);

  // The serialized queue guarantees the LAST persisted server value is the
  // choice — a superseded reset can never leave the server at null.
  assert.equal(lastPutBody.keys[PREF_KEY], "curated");
  assert.equal(localStorage.getItem(PREF_KEY), "curated");
});

// ── resolvePreferredView (server-first routing resolution) ──────────────────

test("second device: server preference wins over empty localStorage", async () => {
  store.clear();
  nextResponse = { ok: true, body: { __v: 1, keys: { [PREF_KEY]: "visual" } } };

  assert.equal(await resolvePreferredView(), "visual");
  assert.equal(localStorage.getItem(PREF_KEY), "visual"); // mirrored locally
});

test("password-only user (401): local value is the fallback", async () => {
  store.clear();
  localStorage.setItem(PREF_KEY, "curated");
  nextResponse = { ok: false };

  assert.equal(await resolvePreferredView(), "curated");
});

test("legacy server snapshot without the key: local value survives resolution", async () => {
  store.clear();
  localStorage.setItem(PREF_KEY, "classic");
  nextResponse = { ok: true, body: { __v: 1, keys: { curatedSocialLayout: "2" } } };

  assert.equal(await resolvePreferredView(), "classic");
  assert.equal(localStorage.getItem(PREF_KEY), "classic");
});

test("explicit null on the server clears the local value (cross-device reset)", async () => {
  store.clear();
  localStorage.setItem(PREF_KEY, "visual");
  nextResponse = { ok: true, body: { __v: 1, keys: { [PREF_KEY]: null } } };

  assert.equal(await resolvePreferredView(), null);
  assert.equal(localStorage.getItem(PREF_KEY), null);
});
