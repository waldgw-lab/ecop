import { readFileSync } from "node:fs";
import { CURATED_THEME_STORAGE_KEY, resolveCuratedTheme } from "../client/src/lib/curatedTheme.ts";
import { CURATED_SYNC_KEYS } from "../client/src/lib/curatedPrefsSync.ts";

const failures: string[] = [];
const expect = (condition: unknown, message: string) => {
  if (!condition) failures.push(message);
};

// New, reset, and malformed values must all be dark; light is an explicit
// Curated-only opt-in.
expect(resolveCuratedTheme(null) === "dark", "missing Curated preference must default to dark");
expect(resolveCuratedTheme(undefined) === "dark", "undefined Curated preference must default to dark");
expect(resolveCuratedTheme("unexpected") === "dark", "invalid Curated preference must default to dark");
expect(resolveCuratedTheme("dark") === "dark", "explicit dark preference must stay dark");
expect(resolveCuratedTheme("light") === "light", "explicit light preference must be honored");

expect(
  CURATED_SYNC_KEYS.includes(CURATED_THEME_STORAGE_KEY),
  "Curated theme preference must be included in cross-device sync",
);
expect(
  !CURATED_SYNC_KEYS.includes("theme"),
  "general app theme must not be included in Curated preference sync",
);

const app = readFileSync("client/src/App.tsx", "utf8");
expect(
  app.includes('defaultTheme="dark"') &&
    app.includes("storageKey={CURATED_THEME_STORAGE_KEY}") &&
    app.includes("applyToDocument={false}"),
  "Curated route must use a dark, route-scoped theme provider",
);
expect(
  !app.slice(app.indexOf("if (isPrivacyRoute"), app.indexOf("// War routes")).includes("CURATED_THEME_STORAGE_KEY"),
  "non-Curated routes must continue using the general app theme provider",
);

const curated = readFileSync("client/src/pages/Curated.tsx", "utf8");
expect(
  curated.includes("setTheme(resolveCuratedTheme(localStorage.getItem(CURATED_THEME_STORAGE_KEY)))"),
  "preference hydration must resolve a missing or invalid Curated theme to dark",
);
expect(
  curated.includes('setTheme("light")') && curated.includes('setTheme("dark")'),
  "Curated theme controls must update only the scoped provider",
);

const provider = readFileSync("client/src/components/ThemeProvider.tsx", "utf8");
expect(
  provider.includes("useLayoutEffect") &&
    provider.includes('root.classList.add("dark")') &&
    provider.includes("if (hadDarkClass) root.classList.add(\"dark\")") &&
    provider.includes('else root.classList.remove("dark")'),
  "Curated route must theme the document root and restore the prior app theme on exit",
);
expect(
  !provider.includes("document.body.classList"),
  "Curated theme must not leak dark styling through the shared document body",
);
expect(
  provider.includes("Radix") && provider.includes("portal to document.body"),
  "portaled Curated overlays must be covered by the document-root theme scope",
);

if (failures.length) {
  console.error("Curated dark-default regression gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("PASS: Curated defaults dark, syncs its own preference, and leaves the app theme isolated.");