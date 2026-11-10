import { pool } from "../db";
import type { FinanceIndicator, FinanceSourceHealth, FinanceStory } from "../../shared/finance";

let initialized = false;
export function assertMirrorDatabase() {
  const identity = (raw: string | undefined) => {
    if (!raw) return null;
    const u = new URL(raw);
    return `${u.hostname.replace("-pooler", "")}${u.pathname}`;
  };
  if (identity(process.env.DATABASE_URL) === identity(process.env.MEDIA_COP_PRODUCTION_DATABASE_URL)) {
    throw new Error("Financial monitoring refused to start: database matches the original production database.");
  }
}
export async function initializeFinanceStore() {
  assertMirrorDatabase();
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_monitor_items (
    id text PRIMARY KEY, published_at timestamptz NOT NULL, payload jsonb NOT NULL
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS finance_monitor_items_date ON finance_monitor_items(published_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_monitor_state (key text PRIMARY KEY, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  // The existing authentication layer uses this session store; don't run legacy military migrations.
  await pool.query(`CREATE TABLE IF NOT EXISTS replit_sessions (
    sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS finance_session_expiry ON replit_sessions(expire)`);
  initialized = true;
}
export function financeStoreReady() { return initialized; }
export async function saveStories(stories: FinanceStory[]) {
  for (const s of stories) {
    await pool.query(`INSERT INTO finance_monitor_items(id,published_at,payload) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(id) DO UPDATE SET payload = EXCLUDED.payload, published_at = EXCLUDED.published_at`,
    [s.id, s.publishedAt, JSON.stringify(s)]);
  }
}
export async function readStories(): Promise<FinanceStory[]> {
  const result = await pool.query(`SELECT payload FROM finance_monitor_items WHERE published_at >= now() - interval '7 days' ORDER BY published_at DESC LIMIT 2000`);
  return result.rows.map(r => r.payload);
}
export async function saveState(key: string, payload: unknown) {
  await pool.query(`INSERT INTO finance_monitor_state(key,payload) VALUES($1,$2::jsonb)
    ON CONFLICT(key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`, [key, JSON.stringify(payload)]);
}
export async function readState<T>(key: string): Promise<T | null> {
  const result = await pool.query(`SELECT payload FROM finance_monitor_state WHERE key=$1`, [key]);
  return result.rows[0]?.payload ?? null;
}
export type FinanceHealthStore = Record<string, FinanceSourceHealth>;
export type StoredIndicator = Omit<FinanceIndicator, "latest" | "previous" | "change" | "status">;
