import type { FinanceIndicator, FinanceIndicators } from "../../shared/finance";
import { csvPoints, downloadPublicText } from "./publicData";
import { readState, saveState, type StoredIndicator } from "./store";

const SERIES = [
  { id: "VIXCLS", name: "VIX · equity volatility", unit: "Index", frequency: "Daily, after market close", source: "Cboe via FRED", description: "Expected 30-day S&P 500 volatility. Not CNN Fear & Greed and not a prediction of unrest." },
  { id: "STLFSI4", name: "St. Louis financial stress", unit: "Index", frequency: "Weekly", source: "Federal Reserve Bank of St. Louis", description: "Financial stress relative to its historical average; zero is the average, not a crisis threshold." },
  { id: "NFCI", name: "Chicago Fed financial conditions", unit: "Index", frequency: "Weekly", source: "Federal Reserve Bank of Chicago", description: "Credit, risk and leverage conditions. Positive values indicate tighter-than-average conditions." },
  { id: "DGS10", name: "U.S. 10-year Treasury yield", unit: "%", frequency: "Daily, business days", source: "Federal Reserve / U.S. Treasury via FRED", description: "Long-term government financing rate. Changes are shown in percentage points." },
  { id: "DGS2", name: "U.S. 2-year Treasury yield", unit: "%", frequency: "Daily, business days", source: "Federal Reserve / U.S. Treasury via FRED", description: "Shorter-term government financing rate. Changes are shown in percentage points." },
  { id: "T10Y2Y", name: "Treasury yield curve · 10Y−2Y", unit: "Percentage points", frequency: "Daily, business days", source: "Federal Reserve Bank of St. Louis", description: "Difference between 10-year and 2-year Treasury yields. An inversion is context, not a timed recession forecast." },
  { id: "DCOILBRENTEU", name: "Brent crude oil", unit: "USD / barrel", frequency: "Daily, published with a lag", source: "U.S. EIA via FRED", description: "European Brent spot price. Energy affordability and supply exposure; publication is delayed." },
  { id: "DTWEXBGS", name: "Broad U.S. dollar index", unit: "Index (Jan 2006 = 100)", frequency: "Daily, published with a lag", source: "Federal Reserve Board via FRED", description: "Trade-weighted U.S. dollar value; strength can affect dollar-denominated external debt." },
];
let lastRefresh = 0;
let flight: Promise<void> | null = null;
export function indicatorsRefreshing() { return !!flight; }
export function refreshIndicators(force = false): Promise<void> {
  if (flight) return flight;
  if (!force && Date.now() - lastRefresh < 3_600_000) return Promise.resolve();
  flight = (async () => {
    const definitions = [
      ...SERIES.map(s => ({ ...s, url: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${s.id}&cosd=${new Date(Date.now() - 370 * 86_400_000).toISOString().slice(0, 10)}`, sourceUrl: `https://fred.stlouisfed.org/series/${s.id}`, dateKey: "observation_date", valueKey: s.id })),
      { id: "OFR_FSI", name: "OFR global financial stress", unit: "Index", frequency: "Daily, after U.S. market close", source: "U.S. Treasury · Office of Financial Research", sourceUrl: "https://www.financialresearch.gov/financial-stress-index/", url: "https://www.financialresearch.gov/financial-stress-index/data/fsi.csv", dateKey: "Date", valueKey: "OFR FSI", description: "Global financial stress across credit, equity valuation, funding, safe assets and volatility. Above zero indicates above-average stress." },
    ];
    // Small bounded batches; don't flood FRED with simultaneous requests.
    for (let i = 0; i < definitions.length; i += 3) {
      await Promise.all(definitions.slice(i, i + 3).map(async definition => {
        const previous = await readState<StoredIndicator>(`indicator:${definition.id}`);
        try {
          const points = csvPoints(await downloadPublicText(definition.url), definition.dateKey, definition.valueKey);
          await saveState(`indicator:${definition.id}`, { ...definition, points, fetchedAt: new Date().toISOString(), message: "Public historical observations; market holidays and missing values are not filled. Subject to the source's data-use terms." });
        } catch (error) {
          await saveState(`indicator:${definition.id}`, {
            ...definition, points: previous?.points ?? [], fetchedAt: previous?.fetchedAt ?? null,
            message: `${error instanceof Error ? error.message : "Download failed"}.${previous?.points.length ? " Showing retained observations from the last successful download." : " No values are substituted."}`,
          });
        }
      }));
    }
    lastRefresh = Date.now();
  })().finally(() => { flight = null; });
  return flight;
}
export async function getIndicators(days: number): Promise<FinanceIndicators> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const ids = ["VIXCLS", "OFR_FSI", "STLFSI4", "NFCI", "DGS10", "DGS2", "T10Y2Y", "DCOILBRENTEU", "DTWEXBGS"];
  const indicators: FinanceIndicator[] = [];
  for (const id of ids) {
    const stored = await readState<StoredIndicator>(`indicator:${id}`);
    if (!stored) {
      const definition = SERIES.find(s => s.id === id);
      indicators.push({ id, name: definition?.name ?? "OFR global financial stress", unit: definition?.unit ?? "Index", source: definition?.source ?? "U.S. OFR", sourceUrl: definition ? `https://fred.stlouisfed.org/series/${id}` : "https://www.financialresearch.gov/financial-stress-index/", frequency: definition?.frequency ?? "Daily", description: definition?.description ?? "Global financial stress.", points: [], latest: null, previous: null, change: null, fetchedAt: null, status: "unavailable", message: "Historical download has not completed yet." });
      continue;
    }
    const actual = stored.points.filter((p): p is { date: string; value: number } => p.value !== null);
    const latest = actual.at(-1) ?? null;
    const previous = actual.at(-2) ?? null;
    const maxAge = stored.frequency.startsWith("Weekly") ? 14 : 7;
    const stale = latest && Date.now() - Date.parse(latest.date) > maxAge * 86_400_000;
    indicators.push({ ...stored, points: stored.points.filter(p => p.date >= cutoff), latest, previous, change: latest && previous ? latest.value - previous.value : null, status: !latest ? "unavailable" : stale || /failed|HTTP|exceeded|did not|no numeric/i.test(stored.message) ? "stale" : "available" });
  }
  return { days, indicators, fearAndGreed: { status: "unavailable", sourceUrl: "https://www.cnn.com/markets/fear-and-greed", message: "CNN Fear & Greed historical access has not been verified for this application. VIX and OFR are separate indicators, not substitutes for that index." } };
}
