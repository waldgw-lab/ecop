import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ThemeProvider";
import { CURATED_THEME_STORAGE_KEY } from "@/lib/curatedTheme";
// Login stays eager: it is the auth gate that must render immediately.
import Login from "@/pages/Login";

// Page components are lazy-loaded so each route ships as its own JS chunk,
// dramatically shrinking the initial bundle and first page load.
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Team = lazy(() => import("@/pages/Team"));
const Stream = lazy(() => import("@/pages/Stream"));
const StreamManager = lazy(() => import("@/pages/StreamManager"));
const War = lazy(() => import("@/pages/War"));
const WarAdmin = lazy(() => import("@/pages/WarAdmin"));
const CustomMcop = lazy(() => import("@/pages/CustomMcop"));
const CustomMcopAdmin = lazy(() => import("@/pages/CustomMcopAdmin"));
const AdditionalMcops = lazy(() => import("@/pages/AdditionalMcops"));
const PrivacyPolicy = lazy(() => import("@/pages/PrivacyPolicy"));
const TermsAndConditions = lazy(() => import("@/pages/TermsAndConditions"));
const Curated = lazy(() => import("@/pages/Curated"));
const CuratedArchive = lazy(() => import("@/pages/CuratedArchive"));
const CuratedMethodology = lazy(() => import("@/pages/CuratedMethodology"));
const NotFound = lazy(() => import("@/pages/not-found"));

// Lightweight centered fallback shown while a lazy page chunk downloads.
function PageLoadingFallback() {
  return (
    <div className="h-screen bg-background flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/stream" component={Stream} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [location, setLocation] = useLocation();

  // Dev-only convenience: default the preview pane to the Curated view. The
  // Replit preview restores the LAST-visited path, so we only steer a fresh
  // landing on '/' (root) over to '/curated' — if you navigate somewhere else
  // in-session it stays put (the ref guard runs this exactly once per page
  // load). Caveat: the Curated view authenticates through Replit, so if you are
  // logged OUT of Replit it bounces the whole page to Replit's own login, which
  // refuses to render inside an iframe and leaves the preview blank; log into
  // Replit (or navigate to any other route) to recover. The Team view has the
  // same un-frameable-login problem and is NOT the requested default, so keep
  // sending it back to '/', which shows the app's own in-app password login and
  // renders fine in the preview. `import.meta.env.DEV` compiles to `false` in
  // production builds, so none of this ships to or affects production.
  const didInitialDevRedirect = useRef(false);
  useEffect(() => {
    if (didInitialDevRedirect.current) return;
    didInitialDevRedirect.current = true;
    if (!import.meta.env.DEV) return;
    if (location === '/team') {
      setLocation('/');
    } else if (location === '/') {
      setLocation('/curated');
    }
  }, [location, setLocation]);

  const isPrivacyRoute = location === '/privacy';
  const isTermsRoute = location === '/terms';
  const isTeamRoute = location === '/team' || location === '/stream-manager' || location === '/additional-mcops';
  const isCuratedRoute = location === '/curated' || location.startsWith('/curated/');
  const isStreamRoute = location === '/stream';
  const isWarRoute = location === '/war' || location === '/war-admin';
  const isCustomMcopRoute = location.startsWith('/mcop/');
  
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  useEffect(() => {
    // Only check main app authentication for non-war routes
    if (!isWarRoute && !isCustomMcopRoute && !isTeamRoute && !isCuratedRoute) {
      setIsCheckingAuth(true);
      checkAuthStatus();
    }
  }, [isWarRoute, isCustomMcopRoute, isTeamRoute, isCuratedRoute]);

  const checkAuthStatus = async () => {
    try {
      const response = await fetch("/api/auth/status");
      const data = await response.json();
      setIsAuthenticated(data.authenticated);
    } catch (error) {
      console.error("Failed to check auth status:", error);
      setIsAuthenticated(false);
    } finally {
      setIsCheckingAuth(false);
    }
  };

  const handleLoginSuccess = () => {
    setIsAuthenticated(true);
    queryClient.invalidateQueries({ queryKey: ['/api/auth/curated-access'] });
  };

  if (isPrivacyRoute || isTermsRoute) {
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TooltipProvider>
            <Toaster />
            <Suspense fallback={<PageLoadingFallback />}>
              {isTermsRoute ? <TermsAndConditions /> : <PrivacyPolicy />}
            </Suspense>
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
  }

  // War routes bypass main app auth (have their own auth for admin)
  if (isWarRoute) {
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TooltipProvider>
            <Toaster />
            <Suspense fallback={<PageLoadingFallback />}>
              {location === '/war-admin' ? <WarAdmin /> : <War />}
            </Suspense>
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
  }

  // Team route bypasses main app auth (uses Replit auth instead)
  if (isTeamRoute) {
    let page = <Team />;
    if (location === '/stream-manager') page = <StreamManager />;
    else if (location === '/additional-mcops') page = <AdditionalMcops />;
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TooltipProvider>
            <Toaster />
            <Suspense fallback={<PageLoadingFallback />}>
              {page}
            </Suspense>
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
  }

  // Curated View route bypasses the outer app-auth wrapper because the page
  // gates itself via /api/auth/curated-access: any app-password session gets
  // view access (and the page shows the MCOP password login in-place for
  // logged-out visitors), while the Replit-auth tester allowlist gates the
  // editor/moderation controls inside the page.
  if (isCuratedRoute) {
    let curatedPage = <Curated />;
    if (location === '/curated/archive') curatedPage = <CuratedArchive />;
    else if (location === '/curated/methodology') {
      // Methodology overlays a frozen (non-interactive, animation-paused)
      // Curated view so it shows through behind the transparent panel.
      curatedPage = (
        <div className="relative min-h-screen">
          <div
            aria-hidden="true"
            className="fixed inset-0 overflow-hidden pointer-events-none select-none [&_*]:![animation-play-state:paused] [&_*]:![transition:none]"
          >
            <Curated />
          </div>
          <CuratedMethodology />
        </div>
      );
    }
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider
          defaultTheme="dark"
          storageKey={CURATED_THEME_STORAGE_KEY}
          applyToDocument={false}
        >
          <TooltipProvider>
            <Toaster />
            <Suspense fallback={<PageLoadingFallback />}>
              {curatedPage}
            </Suspense>
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
  }

  // Custom MCOP routes bypass main app auth (use Replit/team auth)
  if (isCustomMcopRoute) {
    const isAdmin = location.endsWith('/admin');
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TooltipProvider>
            <Toaster />
            <Suspense fallback={<PageLoadingFallback />}>
              <Switch>
                <Route path="/mcop/:slug/admin" component={CustomMcopAdmin} />
                <Route path="/mcop/:slug" component={CustomMcop} />
              </Switch>
            </Suspense>
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
  }

  // Main app authentication flow for non-admin routes
  if (isCheckingAuth) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TooltipProvider>
            <Toaster />
            <Login onLoginSuccess={handleLoginSuccess} />
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          <Suspense fallback={<PageLoadingFallback />}>
            <Router />
          </Suspense>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
