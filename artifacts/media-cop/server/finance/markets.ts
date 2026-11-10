import type { EconomyOverview, MarketQuote } from "../../shared/economy";
import { downloadPublicText } from "./publicData";
import { readState, saveState } from "./store";
import { parseMarketChart, unavailableQuote, type QuoteDefinition } from "./marketParsing";

const REFRESH_MS = 15 * 60_000;
const MONTH_CODES = "FGHJKMNQUVXZ";
export function marketDefinitions(now = new Date()): QuoteDefinition[] {
  const base: QuoteDefinition[] = [
    { id: "wti", symbol: "CL=F", name: "WTI crude · near contract", category: "Energy", unit: "USD / barrel", explanation: "U.S. oil benchmark. Moves affect fuel costs, transport, inflation and producer revenues." },
    { id: "brent", symbol: "BZ=F", name: "Brent crude · near contract", category: "Energy", unit: "USD / barrel", explanation: "International oil benchmark, sensitive to seaborne supply and geopolitical disruption." },
    { id: "gold", symbol: "GC=F", name: "Gold futures", category: "Safe assets", unit: "USD / troy ounce", explanation: "A possible hedge against uncertainty, but also sensitive to real interest rates and the dollar; not a standalone crisis gauge." },
    { id: "sp500-futures", symbol: "ES=F", name: "S&P 500 futures", category: "Equities", unit: "Index points", explanation: "Prices for a broad U.S. equity futures contract; risk appetite, not a direct measure of national output." },
    { id: "eurostoxx", symbol: "^STOXX50E", name: "Euro Stoxx 50", category: "Equities", unit: "Index points", explanation: "Large euro-area listed companies. Market prices can diverge from household and real-economy conditions." },
    { id: "nikkei", symbol: "^N225", name: "Nikkei 225", category: "Equities", unit: "Index points", explanation: "Japanese listed equities; a regional risk-appetite signal, not a complete measure of Asian economic activity." },
    { id: "eurusd", symbol: "EURUSD=X", name: "Euro / U.S. dollar", category: "Currencies", unit: "USD per EUR", explanation: "A lower reading means a stronger dollar against the euro; exchange-rate shocks affect import costs and dollar debt." },
    { id: "usdjpy", symbol: "JPY=X", name: "U.S. dollar / yen", category: "Currencies", unit: "JPY per USD", explanation: "A higher reading means a weaker yen against the dollar. Rapid changes can affect import costs and funding trades." },
    { id: "usdcny", symbol: "CNY=X", name: "U.S. dollar / yuan", category: "Currencies", unit: "CNY per USD", explanation: "Indicative onshore yuan exchange rate; a higher reading means a weaker yuan. Not the offshore CNH rate." },
  ];
  for (const offset of [3, 6]) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const contractMonth = date.toISOString().slice(0, 7);
    const code = `${MONTH_CODES[date.getUTCMonth()]}${String(date.getUTCFullYear()).slice(-2)}`;
    const label = date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
    base.push(
      { id: `wti-${offset}m`, symbol: `CL${code}.NYM`, name: `WTI · ${label} delivery`, category: "Forward contracts", unit: "USD / barrel", contractMonth, explanation: "A named oil-delivery contract. Futures prices include storage, financing, convenience yield and risk premia; they are not a certain forecast." },
      { id: `fedfunds-${offset}m`, symbol: `ZQ${code}.CBT`, name: `Fed funds · ${label}`, category: "Forward contracts", unit: "100 minus implied rate", contractMonth, explanation: "100 minus this futures price is the contract month's implied average effective federal funds rate, not a Fed meeting probability or a promised rate." },
    );
  }
  return base;
}
type MarketState = { attemptedAt: string; quotes: MarketQuote[] };
let flight: Promise<void> | null = null;
let lastAttempt = 0;
export function marketsRefreshing() { return !!flight; }
export function refreshMarkets(): Promise<void> {
  if (flight) return flight;
  if (Date.now() - lastAttempt < REFRESH_MS) return Promise.resolve();
  flight = (async () => {
    const stored = await readState<MarketState>("marketSnapshot");
    lastAttempt = Date.now();
    if (stored && Date.now() - Date.parse(stored.attemptedAt) < REFRESH_MS) return;
    const definitions = marketDefinitions();
    const quotes: MarketQuote[] = [];
    for (let i = 0; i < definitions.length; i += 3) {
      quotes.push(...await Promise.all(definitions.slice(i, i + 3).map(async definition => {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(definition.symbol)}?range=1y&interval=1d`;
          return parseMarketChart(JSON.parse(await downloadPublicText(url)), definition);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Public quote download failed";
          const previous = stored?.quotes.find(q => q.id === definition.id && q.symbol === definition.symbol && q.value !== null);
          return previous ? { ...previous, status: "stale" as const, message: `${message}. Retained last successful quote; check observation time.` } : unavailableQuote(definition, `${message}. No substitute prices are shown.`);
        }
      })));
    }
    await saveState("marketSnapshot", { attemptedAt: new Date().toISOString(), quotes } satisfies MarketState);
  })().finally(() => { flight = null; });
  return flight;
}
export async function getMarketSnapshot(days: number): Promise<EconomyOverview["markets"]> {
  const state = await readState<MarketState>("marketSnapshot");
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const quotes = marketDefinitions().map(d => {
    const quote = state?.quotes.find(q => q.id === d.id && q.symbol === d.symbol);
    if (!quote) return unavailableQuote(d, "Waiting for this public quote's first successful collection.");
    const stale = quote.asOf && Date.now() - Date.parse(quote.asOf) > 4 * 86_400_000;
    return { ...quote, status: stale && quote.status === "available" ? "stale" as const : quote.status, points: quote.points.filter(p => p.date >= cutoff) };
  });
  return { quotes, updatedAt: state?.attemptedAt ?? null, nextRefreshAt: state ? new Date(Date.parse(state.attemptedAt) + REFRESH_MS).toISOString() : null, refreshing: marketsRefreshing() };
}
