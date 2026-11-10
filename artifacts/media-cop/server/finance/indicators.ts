import type { FinanceIndicator, FinanceIndicators } from "../../shared/finance";
import { csvPoints, downloadPublicText } from "./publicData";
import { readState, saveState, type StoredIndicator } from "./store";
import { annualChanges } from "./economyAnalysis";

const SERIES = [
  { id: "VIXCLS", name: "VIX · equity volatility", unit: "Index", frequency: "Daily, after market close", source: "Cboe via FRED", description: "Expected 30-day S&P 500 volatility. Not CNN Fear & Greed and not a prediction of unrest." },
  { id: "STLFSI4", name: "St. Louis financial stress", unit: "Index", frequency: "Weekly", source: "Federal Reserve Bank of St. Louis", description: "Financial stress relative to its historical average; zero is the average, not a crisis threshold." },
  { id: "NFCI", name: "Chicago Fed financial conditions", unit: "Index", frequency: "Weekly", source: "Federal Reserve Bank of Chicago", description: "Credit, risk and leverage conditions. Positive values indicate tighter-than-average conditions." },
  { id: "DGS10", name: "U.S. 10-year Treasury yield", unit: "%", frequency: "Daily, business days", source: "Federal Reserve / U.S. Treasury via FRED", description: "Long-term government financing rate. Changes are shown in percentage points." },
  { id: "DGS2", name: "U.S. 2-year Treasury yield", unit: "%", frequency: "Daily, business days", source: "Federal Reserve / U.S. Treasury via FRED", description: "Shorter-term government financing rate. Changes are shown in percentage points." },
  { id: "T10Y2Y", name: "Treasury yield curve · 10Y−2Y", unit: "Percentage points", frequency: "Daily, business days", source: "Federal Reserve Bank of St. Louis", description: "Difference between 10-year and 2-year Treasury yields. An inversion is context, not a timed recession forecast." },
  { id: "DCOILBRENTEU", name: "Brent crude oil", unit: "USD / barrel", frequency: "Daily, published with a lag", source: "U.S. EIA via FRED", description: "European Brent spot price. Energy affordability and supply exposure; publication is delayed." },
  { id: "DTWEXBGS", name: "Broad U.S. dollar index", unit: "Index (Jan 2006 = 100)", frequency: "Daily, published with a lag", source: "Federal Reserve Board via FRED", description: "Trade-weighted U.S. dollar value; strength can affect dollar-denominated external debt." },
  { id: "DFF", name: "Effective federal funds rate", unit: "%", frequency: "Daily, published with a lag", source: "Federal Reserve Bank of New York via FRED", description: "Actual overnight interbank borrowing rate, not the Fed's target range. Higher rates raise financing costs." },
  { id: "SOFR", name: "Secured overnight financing rate", unit: "%", frequency: "Daily, business days", source: "Federal Reserve Bank of New York via FRED", description: "Overnight Treasury-backed borrowing cost; a benchmark for dollar funding. Moves can signal changing funding pressure." },
  { id: "T10YIE", name: "10-year inflation compensation", unit: "%", frequency: "Daily, business days", source: "Federal Reserve Bank of St. Louis", description: "Nominal minus inflation-protected Treasury yield. Includes inflation expectations, liquidity and risk premia; not a pure inflation forecast." },
  { id: "DCOILWTICO", name: "WTI crude oil · spot", unit: "USD / barrel", frequency: "Daily, published with a lag", source: "U.S. EIA via FRED", description: "Cushing WTI spot price. Published later than futures quotes; do not interpret the different dates as an oil forward curve." },
  { id: "CPI_YOY", rawId: "CPIAUCSL", name: "U.S. consumer inflation", unit: "% year over year", frequency: "Monthly", source: "U.S. Bureau of Labor Statistics via FRED", description: "12-month change in the seasonally adjusted consumer price index. Slower inflation means prices rise more slowly, not that prices fall." },
  { id: "UNRATE", name: "U.S. unemployment rate", unit: "%", frequency: "Monthly", source: "U.S. Bureau of Labor Statistics via FRED", description: "Share of the U.S. civilian labor force unemployed. A rising rate can signal weaker household resilience; one monthly move is not a recession diagnosis." },
  { id: "INDPRO_YOY", rawId: "INDPRO", name: "U.S. industrial output growth", unit: "% year over year", frequency: "Monthly", source: "Federal Reserve Board via FRED", description: "12-month change in U.S. industrial production. A measure of real activity, not a complete measure of GDP or global growth." },
];
let lastRefresh = 0;
let flight: Promise<void> | null = null;
export function indicatorsRefreshing() { return !!flight; }
export function refreshIndicators(force = false): Promise<void> {
  if (flight) return flight;
  if (!force && Date.now() - lastRefresh < 3_600_000) return Promise.resolve();
  flight = (async () => {
    const definitions = [
      ...SERIES.map(s => {
        const rawId = s.rawId ?? s.id;
        return { ...s, url: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${rawId}&cosd=${new Date(Date.now() - 800 * 86_400_000).toISOString().slice(0, 10)}`, sourceUrl: `https://fred.stlouisfed.org/series/${rawId}`, dateKey: "observation_date", valueKey: rawId };
      }),
      { id: "OFR_FSI", name: "OFR global financial stress", unit: "Index", frequency: "Daily, after U.S. market close", source: "U.S. Treasury · Office of Financial Research", sourceUrl: "https://www.financialresearch.gov/financial-stress-index/", url: "https://www.financialresearch.gov/financial-stress-index/data/fsi.csv", dateKey: "Date", valueKey: "OFR FSI", description: "Global financial stress across credit, equity valuation, funding, safe assets and volatility. Above zero indicates above-average stress." },
    ];
    // Small bounded batches; don't flood FRED with simultaneous requests.
    for (let i = 0; i < definitions.length; i += 3) {
      await Promise.all(definitions.slice(i, i + 3).map(async definition => {
        const previous = await readState<StoredIndicator>(`indicator:${definition.id}`);
        try {
          const raw = csvPoints(await downloadPublicText(definition.url), definition.dateKey, definition.valueKey, 800);
          const cutoff = new Date(Date.now() - 370 * 86_400_000).toISOString().slice(0, 10);
          const points = (definition.id.endsWith("_YOY") ? annualChanges(raw) : raw).filter(p => p.date >= cutoff);
          if (!points.some(p => p.value !== null)) throw new Error("Source had no usable derived observations");
          await saveState(`indicator:${definition.id}`, { ...definition, points, fetchedAt: new Date().toISOString(), message: definition.id.endsWith("_YOY") ? "Calculated as 100 × (index / same month a year earlier − 1), using seasonally adjusted source indices. Observation dates name the measured month, not the release date; figures can be revised." : "Public historical observations; market holidays and missing values are not filled. Subject to the source's data-use terms." });
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
  const ids = ["VIXCLS", "OFR_FSI", "STLFSI4", "NFCI", "DGS10", "DGS2", "T10Y2Y", "DCOILBRENTEU", "DTWEXBGS", "DFF", "SOFR", "T10YIE", "DCOILWTICO", "CPI_YOY", "UNRATE", "INDPRO_YOY"];
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
    const lastPoint = stored.points.at(-1);
    const missingAnnualComparison = id.endsWith("_YOY") && lastPoint?.value === null && latest && lastPoint.date > latest.date;
    const message = missingAnnualComparison
      ? `Annual comparison for ${lastPoint.date} is unavailable because a required source observation is missing. The latest valid annual reading is ${latest.date}; missing inputs are not interpolated. ${stored.message}`
      : stored.message;
    const maxAge = stored.frequency.startsWith("Monthly") ? 75 : stored.frequency.startsWith("Weekly") ? 14 : 7;
    const stale = latest && Date.now() - Date.parse(latest.date) > maxAge * 86_400_000;
    indicators.push({ ...stored, message, points: stored.points.filter(p => p.date >= cutoff), latest, previous, change: latest && previous ? latest.value - previous.value : null, status: !latest ? "unavailable" : stale || missingAnnualComparison || /failed|HTTP|exceeded|did not|no numeric/i.test(stored.message) ? "stale" : "available" });
  }
  return { days, indicators, fearAndGreed: { status: "unavailable", sourceUrl: "https://www.cnn.com/markets/fear-and-greed", message: "CNN Fear & Greed historical access has not been verified for this application. VIX and OFR are separate indicators, not substitutes for that index." } };
}
