import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Bound the Neon serverless pool so idle websocket connections to Neon are
// released instead of accumulating. Without an explicit max + idle timeout the
// pool can grow unbounded over hours of scheduled scraping, leaking sockets/
// file descriptors and eventually causing EMFILE ("too many open files") for
// DNS lookups, static asset reads, and Playwright browser launches.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Raised from 10 -> 25: under load the curated page fans out ~12 queries per
  // open, and that runs concurrently with the scheduled scrapers/clustering/
  // prefetch crons. At max:10 the pool exhausted ("timeout exceeded when trying
  // to connect") and every request stalled. 25 gives headroom while staying
  // well under the Neon pooler ceiling for this single-instance deployment.
  max: 25,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
export const db = drizzle({ client: pool, schema });

// Neon serverless talks to the database over a WebSocket. Under load (scheduled
// scrapers + clustering + prefetch all hitting the pool) that socket can drop
// mid-query — it surfaces as a DrizzleQueryError whose cause chain contains a
// `ws` ErrorEvent (closeCode 1006) or an Error like "Client network socket
// disconnected before secure TLS connection was established". These are
// transient: the pool evicts the broken client and the very next query succeeds.
// This detector recognizes that class of failure so callers can retry instead of
// treating a one-off disconnect as a fatal error.
export function isTransientDbError(err: unknown): boolean {
  if (!err) return false;
  const seen = new Set<unknown>();
  let cur: any = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    // `ws` emits socket-level failures as an ErrorEvent; Neon only surfaces these
    // on a dropped/failed connection, so the type alone is a reliable signal.
    if (cur.constructor?.name === "ErrorEvent") return true;
    if (cur.closeCode === 1006 || cur._closeCode === 1006) return true;
    const code = cur.code;
    if (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE" ||
      code === "ECONNREFUSED" ||
      code === "EAI_AGAIN" ||
      code === "57P01" // admin_shutdown
    ) {
      return true;
    }
    const msg = typeof cur.message === "string" ? cur.message.toLowerCase() : "";
    if (
      msg.includes("socket disconnected") ||
      msg.includes("socket hang up") ||
      msg.includes("connection terminated") ||
      msg.includes("terminating connection") ||
      msg.includes("connection closed") ||
      msg.includes("connection reset") ||
      msg.includes("fetch failed")
    ) {
      return true;
    }
    cur = cur.cause ?? cur.error;
  }
  return false;
}

// Run a DB operation, retrying with exponential backoff ONLY on transient
// connection failures (see isTransientDbError). Genuine errors (bad SQL,
// constraint violations, missing tables) are re-thrown immediately so real bugs
// are never masked.
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 150,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isTransientDbError(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `[db] transient query failure (attempt ${attempt}/${attempts}); retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
