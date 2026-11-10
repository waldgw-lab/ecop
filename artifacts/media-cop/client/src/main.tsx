import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import { polyfillCountryFlagEmojis } from "country-flag-emoji-polyfill";
import { shouldPauseProductionViews } from "./lib/operationalPause";
import "./index.css";

// The mirror uses the existing framework with a dedicated financial product entry.
// Keep the legacy App intact; it is not the active dashboard in this copy.
const App = lazy(() => import("./FinancialApp"));

function PhaseOutNotice() {
  return (
    <aside
      className="phase-out-notice"
      aria-label="MCOP3 phase-out notice"
      data-testid="phase-out-notice"
    >
      <p>
        You've reached a phased out, temporary URL. Visit MCOP at its legacy
        URL:{" "}
        <a
          href="https://MCOP2.replit.app"
          className="phase-out-notice-link"
          data-testid="link-mcop2-legacy-url"
        >
          https://MCOP2.replit.app
        </a>
      </p>
    </aside>
  );
}

const productionViewsPaused = shouldPauseProductionViews(
  import.meta.env.PROD,
  import.meta.env.VITE_PRODUCTION_VIEWS_PAUSED,
);

if (!productionViewsPaused) {
  for (const [rel, href, crossOrigin] of [
    ["preconnect", "https://fonts.googleapis.com", ""],
    ["preconnect", "https://fonts.gstatic.com", "anonymous"],
    [
      "stylesheet",
      "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap",
      "",
    ],
  ] as const) {
    const link = document.createElement("link");
    link.rel = rel;
    link.href = href;
    if (crossOrigin) link.crossOrigin = crossOrigin;
    document.head.appendChild(link);
  }

  // Render country/flag emojis (e.g. 🇺🇸) as a web font on platforms whose
  // system font lacks them. The static production phase-out page does not load
  // this font or any application module.
  polyfillCountryFlagEmojis("Twemoji Country Flags", "/TwemojiCountryFlags.woff2");
}

createRoot(document.getElementById("root")!).render(
  productionViewsPaused ? (
    <PhaseOutNotice />
  ) : (
    <>
      <Suspense fallback={null}>
        <App />
      </Suspense>
    </>
  ),
);
