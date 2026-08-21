import { createRoot } from "react-dom/client";
import { polyfillCountryFlagEmojis } from "country-flag-emoji-polyfill";
import App from "./App";
import "./index.css";

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

// Render country/flag emojis (e.g. 🇺🇸) as a web font on platforms whose system
// font lacks them (Windows/Linux), where they otherwise degrade to letters
// ("USUSUS"). No-op on Mac/iOS/Android. Self-hosted woff2 (no runtime CDN).
polyfillCountryFlagEmojis("Twemoji Country Flags", "/TwemojiCountryFlags.woff2");

createRoot(document.getElementById("root")!).render(
  <>
    <PhaseOutNotice />
    <App />
  </>,
);
