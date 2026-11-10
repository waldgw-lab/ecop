import type { EconomicComparison, EconomicCondition, MarketQuote, OilCurve, RateExpectation } from "../../shared/economy";
import type { FinanceIndicator } from "../../shared/finance";

type Point = { date: string; value: number | null };
/** Match the SAME calendar month a year earlier. Never use an adjacent month's value to fill a gap. */
export function annualChanges(points: Point[]): Point[] {
  const byMonth = new Map(points.map(p => [p.date.slice(0, 7), p.value]));
  return points.map(p => {
    const priorKey = `${Number(p.date.slice(0, 4)) - 1}${p.date.slice(4, 7)}`;
    const prior = byMonth.get(priorKey);
    return { date: p.date, value: p.value !== null && prior !== undefined && prior !== null && prior > 0 ? (p.value / prior - 1) * 100 : null };
  });
}
function monthsBefore(date: string, months: number) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}
export function compareIndicator(indicator: FinanceIndicator): EconomicComparison[] {
  return ([1, 3, 6] as const).map(months => {
    const target = indicator.latest ? monthsBefore(indicator.latest.date, months) : null;
    const baseline = target ? indicator.points.filter(p => p.date <= target && p.value !== null).at(-1) : null;
    const tolerance = indicator.frequency.startsWith("Weekly") ? 14 : 8;
    const valid = !!(target && baseline && (indicator.frequency.startsWith("Monthly")
      ? baseline.date.slice(0, 7) === target.slice(0, 7)
      : Date.parse(target) - Date.parse(baseline.date) <= tolerance * 86_400_000));
    if (!valid || !baseline || !indicator.latest || baseline.value === null) {
      return { period: `${months}m`, baselineDate: null, baseline: null, change: null };
    }
    return {
      period: `${months}m`, baselineDate: baseline.date, baseline: baseline.value,
      change: indicator.latest.value - baseline.value,
    };
  });
}
const fmt = (value: number) => value.toFixed(2);
const CONDITION_DEFINITIONS = [
  { id: "stress", indicatorId: "OFR_FSI", title: "Global financial strain", why: "Funding, credit and market stress can interrupt investment and cross-border finance. Above-average stress is not the same as a crisis." },
  { id: "inflation", indicatorId: "CPI_YOY", title: "Pressure on household budgets", why: "Persistent inflation erodes purchasing power and can increase pressure on governments. This reading covers the U.S., not every country." },
  { id: "jobs", indicatorId: "UNRATE", title: "Labor-market resilience", why: "Job losses weaken household income and can compound social and fiscal pressure. This is U.S. unemployment, not global employment." },
  { id: "activity", indicatorId: "INDPRO_YOY", title: "Real-economy momentum", why: "Industrial output tracks physical production. A contraction can weaken jobs, trade and tax receipts; it is not a complete measure of GDP." },
  { id: "financing", indicatorId: "DGS10", title: "Cost of long-term money", why: "Treasury yields help set global borrowing costs. Rising yields can reflect growth, inflation or risk premia; the cause matters." },
  { id: "uncertainty", indicatorId: "VIXCLS", title: "Market uncertainty", why: "Options-implied equity volatility measures the price of uncertainty, not the probability of war, unrest or recession." },
];
export function economicConditions(indicators: FinanceIndicator[]): EconomicCondition[] {
  return CONDITION_DEFINITIONS.map(def => {
    const ind = indicators.find(i => i.id === def.indicatorId);
    const latest = ind?.latest;
    const comparisons = ind ? compareIndicator(ind) : [];
    const c = comparisons.find(x => x.period === "3m");
    let assessment = "No usable observation";
    if (latest) {
      const n = fmt(latest.value);
      if (def.id === "stress") assessment = `${n} · ${latest.value > 0 ? "above" : latest.value < 0 ? "below" : "at"} its historical average`;
      if (def.id === "inflation") assessment = `${fmt(Math.abs(latest.value))}% annual consumer-price ${latest.value < 0 ? "decline" : "increase"}`;
      if (def.id === "jobs") assessment = `${n}% of the U.S. labor force unemployed`;
      if (def.id === "activity") assessment = `Industrial output ${latest.value < 0 ? "down" : "up"} ${fmt(Math.abs(latest.value))}% over a year`;
      if (def.id === "financing") assessment = `${n}% 10-year U.S. Treasury yield`;
      if (def.id === "uncertainty") assessment = `${n} VIX index points`;
    }
    const unit = ind?.unit.includes("%") ? "percentage points" : "index points";
    let detail = latest && c?.change !== null && c?.change !== undefined
      ? `${c.change === 0 ? "Unchanged" : c.change > 0 ? "Up" : "Down"} ${fmt(Math.abs(c.change))} ${unit} versus ${c.baselineDate}. Latest observation: ${latest.date}.${ind?.status === "stale" ? " Data is stale; do not read this as a current-day assessment." : ""}`
      : "A comparable three-month baseline is not available; no direction is inferred.";
    if (ind?.message.startsWith("Annual comparison")) detail += ` ${ind.message.split(" The latest valid")[0]}`;
    return { id: def.id, title: def.title, indicatorId: def.indicatorId, assessment, detail, whyItMatters: def.why, observedAt: latest?.date ?? null, status: ind?.status ?? "unavailable", comparisons };
  });
}
export function rateExpectations(quotes: MarketQuote[]): RateExpectation[] {
  return ["fedfunds-3m", "fedfunds-6m"].map(id => {
    const q = quotes.find(q => q.id === id);
    return {
      quoteId: id, contractMonth: q?.contractMonth ?? "", impliedRate: q?.value != null ? 100 - q.value : null,
      previousImpliedRate: q?.previousClose != null ? 100 - q.previousClose : null,
      changeBasisPoints: q?.value != null && q.previousClose != null ? (q.previousClose - q.value) * 100 : null,
      asOf: q?.asOf ?? null, status: q?.status ?? "unavailable", sourceUrl: q?.sourceUrl ?? "https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.html",
    };
  });
}
export function oilCurve(quotes: MarketQuote[]): OilCurve {
  const near = quotes.find(q => q.id === "wti");
  const far = quotes.find(q => q.id === "wti-6m");
  const base: OilCurve = {
    nearQuoteId: "wti", farQuoteId: "wti-6m", shape: "Unavailable", spread: null, spreadPercent: null, asOf: null,
    interpretation: "The near and six-month WTI observations must both be available and no more than 12 hours apart. Unsynchronised or stale prices are not used to infer a curve.",
  };
  if (!near?.asOf || !far?.asOf || near.value === null || far.value === null || near.status !== "available" || far.status !== "available" || Math.abs(Date.parse(near.asOf) - Date.parse(far.asOf)) > 12 * 3_600_000) return base;
  const spread = far.value - near.value;
  const shape = Math.abs(spread) < 0.005 ? "Flat" : spread < 0 ? "Backwardation" : "Contango";
  return {
    ...base, shape, spread, spreadPercent: near.value > 0 ? spread / near.value * 100 : null,
    asOf: near.asOf < far.asOf ? near.asOf : far.asOf,
    interpretation: `${far.contractMonth} delivery is $${fmt(Math.abs(spread))}/barrel ${spread < 0 ? "cheaper" : "more expensive"} than the near contract.${shape === "Backwardation" ? " A near-term premium can be consistent with immediate supply tightness." : shape === "Contango" ? " A deferred premium can reflect storage and financing costs or near-term oversupply." : " The prices are approximately level."} Storage, financing, convenience yields and risk premia also matter: this is not a certain forecast of future spot prices.`,
  };
}
