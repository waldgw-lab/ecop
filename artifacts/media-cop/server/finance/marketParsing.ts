import type { MarketQuote } from "../../shared/economy";

export interface QuoteDefinition {
  id: string;
  symbol: string;
  name: string;
  category: MarketQuote["category"];
  unit: string;
  explanation: string;
  contractMonth?: string;
}
export const quoteSourceUrl = (symbol: string) => `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function localDate(seconds: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(seconds * 1000));
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
/** Validate the public chart response; never use chartPreviousClose (the start of the requested YEAR). */
export function parseMarketChart(payload: unknown, definition: QuoteDefinition, now = Date.now()): MarketQuote {
  const data = payload as { chart?: { result?: Array<{
    meta?: { symbol?: string; regularMarketPrice?: number; regularMarketTime?: number; exchangeTimezoneName?: string; shortName?: string };
    timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] };
  }> } };
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta || meta.symbol !== definition.symbol || !number(meta.regularMarketPrice) || !number(meta.regularMarketTime) || meta.regularMarketTime * 1000 > now + 300_000 || meta.regularMarketTime < 1) throw new Error("Quote response lacked a valid matching symbol, price or observation time");
  const zone = meta.exchangeTimezoneName ?? "UTC";
  const quoteDay = localDate(meta.regularMarketTime, zone);
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes) || timestamps.length !== closes.length) throw new Error("Quote history columns did not match");
  const byDate = new Map<string, number | null>();
  timestamps.forEach((t, i) => {
    if (!number(t) || t <= 0 || t * 1000 > now + 300_000) return;
    const day = localDate(t, zone);
    if (day <= quoteDay) byDate.set(day, number(closes[i]) ? closes[i] : null);
  });
  const points = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
  const previous = points.filter(p => p.date < quoteDay && p.value !== null).at(-1);
  const previousClose = previous?.value ?? null;
  const change = previousClose === null ? null : meta.regularMarketPrice - previousClose;
  return {
    ...definition, contractMonth: definition.contractMonth ?? null, contractLabel: meta.shortName ?? definition.name,
    value: meta.regularMarketPrice, previousClose, previousCloseDate: previous?.date ?? null, change,
    changePercent: change !== null && previousClose !== null && previousClose > 0 ? change / previousClose * 100 : null,
    asOf: new Date(meta.regularMarketTime * 1000).toISOString(), fetchedAt: new Date(now).toISOString(),
    status: now - meta.regularMarketTime * 1000 > 4 * 86_400_000 ? "stale" : "available",
    source: "Yahoo Finance · public indicative data", sourceUrl: quoteSourceUrl(definition.symbol), points,
    message: "Indicative / delayed, not execution-grade. Change is calculated against the preceding completed daily bar, not certified exchange settlement. Continuous front-month futures can jump when contracts roll.",
  };
}
export function unavailableQuote(definition: QuoteDefinition, message: string): MarketQuote {
  return { ...definition, contractMonth: definition.contractMonth ?? null, contractLabel: definition.name, value: null, previousClose: null, previousCloseDate: null, change: null, changePercent: null, asOf: null, fetchedAt: null, status: "unavailable", message, points: [], source: "Yahoo Finance · public indicative data", sourceUrl: quoteSourceUrl(definition.symbol) };
}
