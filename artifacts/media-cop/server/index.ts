import express, { type Request, Response, NextFunction, type RequestHandler } from "express";
import path from "path";
import compression from "compression";
import { createServer } from "node:http";
import { FINANCIAL_MODE } from "./finance/config";
import { assertMirrorDatabase, initializeFinanceStore } from "./finance/store";
import { startFinanceCollection } from "./finance/collector";
import { registerFinanceRoutes } from "./finance/routes";
import { registerAppPasswordRoutes } from "./appPasswordRoutes";
import { setupVite, serveStatic, log } from "./vite";
import { startScheduledScraping } from "./scheduler";
import { startTickerCache } from "./tickerCache";
import { startCompetingCoverageJob } from "./competingCoverage";
import { ensureDatabaseSchema } from "./migrate";
import { storage } from "./storage";
import { setProviderMode } from "./aiClient";
import { initXRelayHeartbeat } from "./xRelayService";
import { initRelayHeartbeat, repairTruthSocialAttachmentImages } from "./truthSocialService";
import { restoreFeedHealthState } from "./feedHealthTracker";
import { restoreWatchTopicSteering } from "./watchTopicMatcher";
import { restoreClusteringFlags } from "./clusterConfig";
import { restoreScraperFlags } from "./scraperConfig";
import { setupAuth, registerAuthRoutes } from "./replit_integrations/auth";
import { getSession } from "./replit_integrations/auth/replitAuth";
import { seedPredefinedTopics } from "./subjectMatcher";
import { seedOutletRegistry } from "./outletRegistrySeed";
import { normalizeCuratedSourceNames } from "./curatedIngest";
import { healCuratedBypassSourceLabels, healCuratedSocialAndRefusalData, healStaleStatusDescriptors, healMetaFillerBulletsAndClaims, repairCatchAllClassifications } from "./curatedHeal";
import { repairAbcStoryUrls } from "./abcUrlRepair";
import { markSchemaFailed, markSchemaReady } from "./schemaReadiness";

const app = express();

// Gzip/deflate every response. This is a transport-only change: the browser
// transparently decompresses, so payloads (JS bundle + all JSON feeds) shrink
// without altering any application behavior. The one exception is the manual
// scrape endpoint, which streams progress incrementally via res.write() —
// compression would buffer it, so we skip it there. The interactive review-link
// endpoint also streams its result progressively (NDJSON), so it's skipped too.
const STREAMING_PATHS = new Set([
  "/api/trigger-scrape",
  "/api/team/chat/review-link",
]);
app.use(
  compression({
    filter: (req, res) => {
      if (STREAMING_PATHS.has(req.path.replace(/\/$/, ""))) return false;
      return compression.filter(req, res);
    },
  }),
);

declare module 'express-session' {
  interface SessionData {
    authenticated?: boolean;
    adminAuthenticated?: boolean;
    warAdminAuthenticated?: boolean;
    warViewerAuthenticated?: boolean;
    userId?: string;
    userName?: string;
    userProfileImage?: string | null;
  }
}

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}

// Trust proxy is set in setupAuth
// Session middleware is set up in setupAuth (replit_integrations/auth/replitAuth.ts)
// to use PostgreSQL session store for Replit authentication

app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Setup Replit Auth (for Team page access). The PG session store is
  // configured lazily (createTableIfMissing:false), so this does not query
  // the database at startup and is safe to run before schema init.
  let server;
  if (FINANCIAL_MODE) {
    assertMirrorDatabase();
    app.set("trust proxy", 1);
    app.use(getSession() as unknown as RequestHandler);
    registerAppPasswordRoutes(app);
    registerFinanceRoutes(app);
    server = createServer(app);
  } else {
    await setupAuth(app);
    registerAuthRoutes(app);
    const { registerRoutes } = await import("./routes");
    server = await registerRoutes(app);
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    // Serve the content-hashed build assets (e.g. /assets/main-DoVbhH-9.js)
    // with a long-lived immutable cache. Because their filenames are derived
    // from their content, a new build always produces new filenames, so it is
    // safe to cache them forever. Registered BEFORE serveStatic so it owns the
    // /assets path; serveStatic continues to serve everything else (notably
    // index.html) with its normal short/no-cache behavior.
    app.use(
      "/assets",
      express.static(path.resolve(import.meta.dirname, "public", "assets"), {
        immutable: true,
        maxAge: "1y",
      }),
    );
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  // IMPORTANT: open the port BEFORE running the database schema migration and
  // other slow startup work, so the deployment health check can pass quickly.
  // Schema init issues ALTER/CREATE statements that can block on locks held by
  // another running instance; if that ran before listen() it could stop the
  // port from ever opening (deploy healthcheck failure / 500 crash loop).
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, async () => {
    log(`serving on port ${port}`);

    if (FINANCIAL_MODE) {
      try {
        await initializeFinanceStore();
        markSchemaReady();
        startFinanceCollection();
      } catch (error) {
        markSchemaFailed(error);
        console.error("[Finance] Initialization failed; original military jobs remain disabled:", error);
      }
      return;
    }

    // Ensure database schema is initialized (creates tables / adds columns if
    // missing). Runs AFTER the port is open; any failure is logged but never
    // crashes the server or blocks it from serving requests.
    try {
      const schemaInitialized = await ensureDatabaseSchema();
      if (!schemaInitialized) throw new Error('Database schema initialization did not complete');
      markSchemaReady();
    } catch (err) {
      markSchemaFailed(err);
      console.error('[Startup] ensureDatabaseSchema error:', err);
    }

    // Restore the persisted relay heartbeats into memory so MCOP stays in
    // WATCHDOG mode across redeploys when a relay was recently healthy, instead
    // of falling back to PRIMARY (scrapers). Runs AFTER schema init so the
    // relay_heartbeats table is guaranteed to exist, and is AWAITED before the
    // scheduler starts so the very first scrape-mode decision sees the restored
    // heartbeat (otherwise the initial scrape could observe NEVER and bounce to
    // PRIMARY for one cycle — the exact bounce this persistence prevents). Each
    // is a single fast indexed read and the port is already open, so this never
    // blocks serving requests. Errors are logged, never fatal.
    await Promise.all([
      initXRelayHeartbeat(storage).catch((err) => {
        console.error('[Startup] initXRelayHeartbeat error:', err);
      }),
      initRelayHeartbeat(storage).catch((err) => {
        console.error('[Startup] initRelayHeartbeat error:', err);
      }),
      // Restore the persisted RSS feed-health streaks (Task #553) so a feed that
      // was already dead before the restart shows as stale/broken on the Coverage
      // tab immediately, instead of resetting to "healthy" until 3 fresh cycles
      // re-detect it. Awaited before the scheduler so the first Coverage read
      // reflects pre-restart state; bounded single read, fail-open, never fatal.
      restoreFeedHealthState(storage).catch((err) => {
        console.error('[Startup] restoreFeedHealthState error:', err);
      }),
      // Restore the persisted AI provider mode (OpenRouter vs Internal) so the
      // Team-page toggle survives restarts and applies to bots/crons. Awaited
      // before the scheduler starts so the first AI call uses the saved mode.
      (async () => {
        try {
          const ai = await storage.getAiSettings();
          setProviderMode(ai.provider as 'openrouter' | 'internal' | 'auto');
        } catch (err) {
          console.error('[Startup] load AI provider mode error:', err);
        }
      })(),
      // Restore the persisted Watch Topic steering flag so Priority/BOLO
      // steering resumes on the very first scrape cycle after a restart,
      // without anyone needing to re-toggle the switch. Awaited before the
      // scheduler starts; fail-open (keeps default OFF on error).
      restoreWatchTopicSteering().catch((err) => {
        console.error('[Startup] restoreWatchTopicSteering error:', err);
      }),
      // Restore persisted clustering + topic-clustering toggles so an admin's
      // saved OFF state isn't silently reset to ON by a redeploy. Awaited
      // before the scheduler starts; fail-open (keeps defaults ON on error).
      restoreClusteringFlags().catch((err) => {
        console.error('[Startup] restoreClusteringFlags error:', err);
      }),
      // Restore the persisted Drudge scraper toggle so an admin's saved state
      // isn't silently reset to the default OFF on redeploy. Awaited before
      // the scheduler starts; fail-open (keeps default OFF on error).
      restoreScraperFlags().catch((err) => {
        console.error('[Startup] restoreScraperFlags error:', err);
      }),
    ]);

    // Fire-and-forget background startup work — must not block listen()
    seedPredefinedTopics().catch((err) => {
      console.error('[Startup] seedPredefinedTopics error:', err);
    });
    // Seed the outlet registry, then heal historical curated rows that still
    // carry pre-canonicalization raw outlet names (Task #313). The backfill must
    // run AFTER the registry is populated so findOutlet can resolve canonicals,
    // hence the chain. Idempotent — a no-op once every row is already canonical.
    try {
      // Must finish before scheduler startup: clustering/synthesis consumes
      // curated summaries and bullets as source context, so letting it race a
      // historical repair can immediately recycle contaminated AI text.
      await seedOutletRegistry();
      await normalizeCuratedSourceNames();
      // Re-attribute pre-guard archive/paywall-bypass rows using the embedded
      // publisher URL. Label-only and idempotent; short-code links stay unchanged.
      await healCuratedBypassSourceLabels();
      // Heal historical curated rows (Task #354): clear AI refusal/meta text
      // stored as bullets/claims and strip raw relay HTML from social-post
      // bodies. Runs after the registry seed so social outlets resolve.
      await healCuratedSocialAndRefusalData();
      await healStaleStatusDescriptors();
      // Heal any stored meta-filler / placeholder lines in curated bullets &
      // claims (e.g. "The article is a placeholder…") so the next enrichment
      // cycle can produce real content. Idempotent — rows are skipped once clean.
      await healMetaFillerBulletsAndClaims();
      // One-time repair: age AI 'Other / Emerging' rows past the 6h reclassify
      // cooldown so the next classification cron pass re-sharpens them. Idempotent
      // — rows already re-classified to a real topic are no longer 'Other/Emerging'
      // and match nothing. Human-provenance rows are hard-guarded in the function.
      await repairCatchAllClassifications();
    } catch (err) {
      console.error('[Startup] seedOutletRegistry / curated source normalize / heal error:', err);
    }
    // One-time, self-limiting repair of ABC /story URLs that lost their ?id=
    // query (recovers the id from ABC's live RSS feeds). Idempotent — rows that
    // already carry ?id= or can no longer be matched are skipped.
    repairAbcStoryUrls().catch((err) => {
      console.error('[Startup] repairAbcStoryUrls error:', err);
    });
    // Restore still images that the former ingest-time attachment-only policy
    // removed from dedicated Truth Social cards. The original media survives
    // in relay raw payloads; the repair only fills missing image_url values and
    // is safe to run after every restart.
    repairTruthSocialAttachmentImages(storage).catch((err) => {
      console.error('[Startup] Truth Social attachment-image repair error:', err);
    });

    try {
      startScheduledScraping();
      startTickerCache();
      startCompetingCoverageJob();
    } catch (err) {
      console.error('[Startup] background scheduler error:', err);
    }
  });
})();
