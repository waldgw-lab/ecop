import { createRoot } from "react-dom/client";
import { polyfillCountryFlagEmojis } from "country-flag-emoji-polyfill";
import App from "./App";
import "./index.css";

// Render country/flag emojis (e.g. 🇺🇸) as a web font on platforms whose system
// font lacks them (Windows/Linux), where they otherwise degrade to letters
// ("USUSUS"). No-op on Mac/iOS/Android. Self-hosted woff2 (no runtime CDN).
polyfillCountryFlagEmojis("Twemoji Country Flags", "/TwemojiCountryFlags.woff2");

createRoot(document.getElementById("root")!).render(<App />);
