import type { Express, RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";

/** Existing MCOP password/session access, extracted for reuse by the financial mirror.
 * This does not add a second identity system or change the account's password. */
export function registerAppPasswordRoutes(app: Express) {
  const attempts = new Map<string, { count: number; until: number }>();
  app.post("/api/auth/login", (req, res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    // Bound the limiter and avoid retaining IP addresses indefinitely.
    for (const [ip, attempt] of attempts) if (attempt.until <= now) attempts.delete(ip);
    const attempt = attempts.get(key);
    if ((attempt?.count ?? 0) >= 10) return res.status(429).json({ message: "Too many attempts. Try again in 15 minutes." });
    const correct = process.env.APP_PASSWORD;
    if (!correct) return res.status(503).json({ message: "Server not configured for authentication" });
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const given = Buffer.from(password);
    const expected = Buffer.from(correct);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      attempts.set(key, { count: (attempt?.count ?? 0) + 1, until: attempt?.until ?? now + 15 * 60_000 });
      return res.status(401).json({ message: "Invalid password" });
    }
    attempts.delete(key);
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.authenticated = true;
      req.session.save(error => error ? next(error) : res.json({ success: true }));
    });
  });
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(error => {
      if (error) return res.status(500).json({ error: "Failed to logout" });
      res.clearCookie("connect.sid");
      res.json({ success: true });
    });
  });
  app.get("/api/auth/status", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ authenticated: !!req.session.authenticated });
  });
}
export const requireAppSession: RequestHandler = (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Cookie");
  if (!req.session?.authenticated) return void res.status(401).json({ error: "Internal team login required" });
  next();
};
