import type { Express, RequestHandler } from "express";
import { requireAppSession } from "../appPasswordRoutes";
import { financeStoreReady } from "./store";
import { getFinanceDashboard, refreshFinance } from "./collector";
import { getIndicators, refreshIndicators } from "./indicators";
import { getEconomyOverview } from "./economy";
import { refreshMarkets } from "./markets";

let lastManualRefresh = 0;
const sameOrigin: RequestHandler = (req, res, next) => {
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) return void res.status(403).json({ error: "Cross-origin request rejected" });
    } catch { return void res.status(403).json({ error: "Invalid request origin" }); }
  }
  next();
};
export function registerFinanceRoutes(app: Express) {
  app.use("/api/finance", requireAppSession, (_req, res, next) => {
    if (!financeStoreReady()) return res.status(503).json({ error: "Financial storage is initializing or unavailable. No original-app database is used as a fallback." });
    next();
  });
  app.get("/api/finance/dashboard", async (_req, res) => {
    try { res.json(await getFinanceDashboard()); }
    catch { res.status(503).json({ error: "Financial dashboard storage is unavailable" }); }
  });
  app.get("/api/finance/indicators", async (req, res) => {
    const days = Number(req.query.days ?? 30);
    if (![7, 30, 90, 180, 365].includes(days)) return void res.status(400).json({ error: "days must be 7, 30, 90, 180 or 365" });
    try { res.json(await getIndicators(days)); }
    catch { res.status(503).json({ error: "Historical indicator storage is unavailable" }); }
  });
  app.get("/api/finance/economy", async (req, res) => {
    const days = Number(req.query.days ?? 180);
    if (![7, 30, 90, 180, 365].includes(days)) return void res.status(400).json({ error: "days must be 7, 30, 90, 180 or 365" });
    try { res.json(await getEconomyOverview(days)); }
    catch { res.status(503).json({ error: "Economic observations are temporarily unavailable. No substitute data is shown." }); }
  });
  app.post("/api/finance/refresh", sameOrigin, (_req, res) => {
    if (Date.now() - lastManualRefresh < 60_000) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ error: "Sources were just refreshed. Please wait one minute." });
    }
    lastManualRefresh = Date.now();
    void refreshFinance().catch(error => console.error("[Finance] Manual collection failed:", error.message));
    // Historical data only updates hourly; a button must not bypass publisher request budgets.
    void refreshIndicators().catch(error => console.error("[Finance] Indicators failed:", error.message));
    void refreshMarkets().catch(error => console.error("[Finance] Market collection failed:", error.message));
    res.status(202).json({ refreshing: true });
  });
  // Legacy public feeds, exports, relay mutations and outbound-notification endpoints are not active in this mirror.
  app.use("/api", (_req, res) => res.status(404).json({ error: "This endpoint is not enabled in the financial mirror" }));
}
