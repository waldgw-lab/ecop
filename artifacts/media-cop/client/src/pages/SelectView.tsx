import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/ThemeProvider";
import { LayoutList, Newspaper, Sparkles, RotateCcw } from "lucide-react";
import mcopLogoWhite from "@assets/Logo5_WHITE_1782606805634.png";
import mcopLogoBlack from "@assets/Logo5_BLACK_1782606794585.png";
import {
  type PreferredView,
  PREFERRED_VIEW_PATHS,
  getPreferredView,
  setPreferredView,
  clearPreferredView,
  sanitizeReturnPath,
  markPreferredViewLocallyAuthoritative,
} from "@/lib/preferredView";
import {
  pushPreferredViewToServer,
  fetchServerPreferredView,
} from "@/lib/curatedPrefsSync";

// Accent colors mirror ViewSwitcher's VIEW_ACCENTS so the splash and the
// switcher read as the same system.
const OPTIONS: {
  key: PreferredView;
  label: string;
  accent: string;
  icon: typeof LayoutList;
  description: string;
}[] = [
  {
    key: "classic",
    label: "Classic",
    accent: "#2563EB",
    icon: LayoutList,
    description:
      "The original MCOP dashboard — the full ranked headline feed with filters, alerts, and analysis tools.",
  },
  {
    key: "visual",
    label: "Visual",
    accent: "#60A5FA",
    icon: Newspaper,
    description:
      "A photo-forward stream built for wall displays and quick scanning — big imagery, bold headlines.",
  },
  {
    key: "curated",
    label: "Curated",
    accent: "#5FA8C4",
    icon: Sparkles,
    description:
      "An editor-shaped common operating picture — top stories, official statements, and live feeds in one view.",
  },
];

/**
 * Post-login view selection splash (/select-view).
 *
 * Shown after a password login when no default view is saved, and reachable
 * any time from the view switcher to change or reset the remembered default.
 * Choosing a view saves it (localStorage; synced for Replit users via the
 * curated prefs sync key list) and navigates there.
 */
export default function SelectView() {
  const { theme } = useTheme();
  const [, setLocation] = useLocation();
  const [saved, setSaved] = useState<PreferredView | null>(() => getPreferredView());

  // Hydrate the "Current default" marker from the server for Replit users so a
  // choice made on another device shows here too. Race-safe with the user's
  // own clicks: once they interact, the (possibly slower) fetch result is
  // discarded — their explicit choice always wins.
  const interactedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const server = await fetchServerPreferredView();
      if (cancelled || interactedRef.current || !server.present) return;
      if (server.value === null) {
        clearPreferredView();
      } else {
        setPreferredView(server.value);
      }
      setSaved(server.value);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [isSaving, setIsSaving] = useState(false);

  const choose = async (view: PreferredView) => {
    if (isSaving) return;
    interactedRef.current = true;
    setIsSaving(true);
    setPreferredView(view);
    setSaved(view);
    // The just-made choice outranks any concurrently-fetched server snapshot
    // for the rest of this page load — prevents the Curated page's own prefs
    // hydration from reverting it locally or re-pushing the stale value.
    markPreferredViewLocallyAuthoritative();
    // Serialize the server save (Replit users; 401 no-op for password-only
    // users) BEFORE navigating into the destination view, bounded so a slow
    // network can't hold the UI hostage — the authority guard covers the
    // unfinished-push case.
    await Promise.race([
      pushPreferredViewToServer(),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
    // Deep-link preservation: when the login flow carried the visitor's
    // original destination here (?return=/curated/archive etc.), honour it —
    // the pick is saved as the default for future visits, but this visit
    // continues to where they were originally headed.
    const returnTo = sanitizeReturnPath(
      new URLSearchParams(window.location.search).get("return"),
    );
    setLocation(returnTo ?? PREFERRED_VIEW_PATHS[view]);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-3xl flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3">
          <img
            src={theme === "dark" ? mcopLogoWhite : mcopLogoBlack}
            alt="MCOP"
            className="h-20 w-auto"
            data-testid="img-select-view-logo"
          />
          <h1 className="text-xl font-semibold tracking-tight" data-testid="text-select-view-title">
            Choose your view
          </h1>
          <p className="text-sm text-muted-foreground text-center max-w-md">
            Pick how you want to see MCOP. We'll remember your choice and take
            you straight there next time — you can switch views or change your
            default at any point.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full">
          {OPTIONS.map(({ key, label, accent, icon: Icon, description }) => (
            <Card
              key={key}
              role="button"
              tabIndex={0}
              onClick={() => choose(key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  choose(key);
                }
              }}
              className="p-5 flex flex-col gap-3 cursor-pointer transition-colors hover-elevate border-2"
              style={{ borderColor: saved === key ? accent : undefined }}
              data-testid={`card-select-view-${key}`}
            >
              <div
                className="h-10 w-10 rounded-md flex items-center justify-center"
                style={{ backgroundColor: `${accent}29`, color: accent }}
              >
                <Icon className="h-5 w-5" />
              </div>
              <div className="font-semibold" style={{ color: accent }}>
                {label}
                {saved === key && (
                  <span className="ml-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Current default
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
            </Card>
          ))}
        </div>

        {saved && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              interactedRef.current = true;
              markPreferredViewLocallyAuthoritative();
              clearPreferredView();
              // Propagate the reset (explicit null) to other devices for
              // Replit users; harmless 401 no-op for password-only users.
              void pushPreferredViewToServer();
              setSaved(null);
            }}
            data-testid="button-reset-default-view"
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Reset saved default
          </Button>
        )}
      </div>
    </div>
  );
}
