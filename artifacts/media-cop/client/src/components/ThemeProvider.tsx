import { createContext, useContext, useEffect, useLayoutEffect, useState, ReactNode } from "react";

type Theme = "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

interface ThemeProviderProps {
  children: ReactNode;
  /** Default used when this provider's storage key has no valid saved value. */
  defaultTheme?: Theme;
  /** Storage key owned by this theme scope. */
  storageKey?: string;
  /**
   * The main application owns the document theme. Route-local providers instead
   * add their class to a wrapper so they cannot change another route's setting.
   */
  applyToDocument?: boolean;
}

export function ThemeProvider({
  children,
  defaultTheme = "light",
  storageKey = "theme",
  applyToDocument = true,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(storageKey);
    return (stored === "dark" || stored === "light") ? stored : defaultTheme;
  });

  // Curated needs the active class on <html>, not just its wrapper: Radix
  // dialogs/popovers/tooltips portal to document.body. Preserve the main app's
  // DOM state and restore it on route exit; this scoped route never reads or
  // writes the main app's persisted `theme` key.
  useLayoutEffect(() => {
    if (applyToDocument) return;
    const root = document.documentElement;
    const hadDarkClass = root.classList.contains("dark");
    return () => {
      if (hadDarkClass) root.classList.add("dark");
      else root.classList.remove("dark");
    };
  }, [applyToDocument]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem(storageKey, theme);
  }, [storageKey, theme]);

  const toggleTheme = () => {
    setThemeState((prev) => (prev === "light" ? "dark" : "light"));
  };

  const setTheme = (t: Theme) => {
    setThemeState(t);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
