import type { EconomicCondition, MarketQuote } from "../../shared/economy";
import type { FinanceIndicator } from "../../shared/finance";

const number = (value: number) => Math.abs(value).toFixed(2);
function date(value: string, monthly = false): string {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    month: monthly ? "long" : "short", ...(!monthly ? { day: "numeric" as const } : {}),
    year: "numeric", timeZone: "UTC",
  });
}
function trend(c: EconomicCondition | undefined, unit: string, subject = "It"): string {
  const change = c?.comparisons.find(p => p.period === "3m")?.change;
  if (change == null || !Number.isFinite(change)) return "";
  if (Math.abs(change) < 0.005) return ` ${subject} was little changed over three months.`;
  return ` ${subject} ${change > 0 ? "rose" : "fell"} ${number(change)} ${unit} over three months.`;
}

/** Facts and their significance only. Source gaps/status belong to the charts,
 * not the executive narrative. Keep the original topic IDs when omitting a fact.
 */
export function buildBriefing(indicators: FinanceIndicator[], conditions: EconomicCondition[], quotes: MarketQuote[]) {
  const items: { id: string; text: string }[] = [];
  const find = (id: string) => indicators.find(i => i.id === id);
  const usable = (i: FinanceIndicator | undefined) => i?.latest && Number.isFinite(i.latest.value);
  const stress = find("OFR_FSI");
  if (usable(stress)) {
    const p = stress!.latest!;
    items.push({ id: "01", text: `Financial conditions: Global financial stress was ${p.value < 0 ? "below" : p.value > 0 ? "above" : "at"} its historical average on ${date(p.date)} (index: ${p.value.toFixed(2)}).${trend(conditions.find(c => c.id === "stress"), "index points")} ${p.value > 0 ? "Elevated stress can make credit harder to obtain and disrupt investment and cross-border finance." : "Lower stress generally supports lending and cross-border finance; a sustained increase can make borrowing harder and investment more cautious."}` });
  }
  const inflation = find("CPI_YOY");
  if (usable(inflation)) {
    const p = inflation!.latest!;
    const level = p.value === 0 ? "unchanged from a year earlier" : `${number(p.value)}% ${p.value < 0 ? "lower" : "higher"} than a year earlier`;
    items.push({ id: "02", text: `Inflation: U.S. consumer prices were ${level} in ${date(p.date, true)}.${trend(conditions.find(c => c.id === "inflation"), "percentage points", "The annual inflation rate")} ${p.value < 0 ? "Falling prices can ease household costs, but persistent declines can also signal weak demand." : "Higher prices put pressure on household budgets and operating costs, with implications for consumer spending and public finances."}` });
  }
  const jobs = find("UNRATE");
  if (usable(jobs)) {
    const p = jobs!.latest!;
    items.push({ id: "03", text: `Employment: U.S. unemployment was ${p.value.toFixed(2)}% in ${date(p.date, true)}.${trend(conditions.find(c => c.id === "jobs"), "percentage points")} A weakening labor market can reduce household spending and tax revenue, increasing pressure on families and public budgets.` });
  }
  const oil = quotes.find(q => q.id === "brent");
  if (oil?.value != null && Number.isFinite(oil.value) && oil.asOf) {
    const move = oil.changePercent != null && Number.isFinite(oil.changePercent)
      ? Math.abs(oil.changePercent) < 0.005 ? ", little changed from the previous trading day"
        : `, ${oil.changePercent > 0 ? "up" : "down"} ${number(oil.changePercent)}% from the previous trading day`
      : "";
    items.push({ id: "04", text: `Energy: Brent crude futures for near-term delivery were $${oil.value.toFixed(2)} per barrel on ${date(oil.asOf)}${move}. Higher oil prices raise transport, fuel and import costs; lower prices ease those costs but can weaken oil-exporting governments' revenues.` });
  }
  return items;
}
