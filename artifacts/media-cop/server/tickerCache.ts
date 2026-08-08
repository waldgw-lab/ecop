import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

interface TickerItem {
  symbol: string;
  label: string;
  price: number | null;
  changePercent: number | null;
  invertColors: boolean;
}

const SYMBOLS: { symbol: string; label: string; invertColors?: boolean }[] = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^IXIC", label: "NASDAQ" },
  { symbol: "^DJI", label: "Dow Jones" },
  { symbol: "ITA", label: "Aerospace & Defense" },
  { symbol: "CL=F", label: "Crude Oil WTI" },
  { symbol: "BZ=F", label: "Brent Crude" },
  { symbol: "NG=F", label: "Natural Gas" },
  { symbol: "DX-Y.NYB", label: "US Dollar Index" },
  { symbol: "CNY=X", label: "USD/CNY" },
  { symbol: "RUB=X", label: "USD/RUB" },
  { symbol: "GC=F", label: "Gold" },
  { symbol: "^TNX", label: "US 10Y Treasury" },
  { symbol: "BTC-USD", label: "Bitcoin" },
  { symbol: "^VIX", label: "Fear Index (VIX)", invertColors: true },
];

let cachedData: TickerItem[] = [];
let lastFetchTime: number | null = null;

async function fetchTickerData() {
  try {
    const results: TickerItem[] = [];

    for (const { symbol, label, invertColors } of SYMBOLS) {
      try {
        const quote = await yahooFinance.quote(symbol);
        results.push({
          symbol,
          label,
          price: quote.regularMarketPrice ?? null,
          changePercent: quote.regularMarketChangePercent ?? null,
          invertColors: invertColors ?? false,
        });
      } catch (err: any) {
        console.error(`[Ticker] Failed to fetch ${symbol}:`, err.message);
        results.push({
          symbol,
          label,
          price: null,
          changePercent: null,
          invertColors: invertColors ?? false,
        });
      }
    }

    cachedData = results;
    lastFetchTime = Date.now();
    console.log(`[Ticker] Fetched ${results.filter(r => r.price !== null).length}/${results.length} symbols successfully`);
  } catch (err: any) {
    console.error("[Ticker] Fatal fetch error:", err.message);
  }
}

export function getTickerData() {
  return {
    data: cachedData,
    lastFetchTime,
  };
}

export function startTickerCache() {
  fetchTickerData();
  setInterval(fetchTickerData, 5 * 60 * 1000);
  console.log("Market ticker cache started (refreshes every 5 minutes)");
}
