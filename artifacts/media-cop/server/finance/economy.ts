import type { EconomyOverview } from "../../shared/economy";
import { economicConditions, oilCurve, rateExpectations } from "./economyAnalysis";
import { getIndicators } from "./indicators";
import { getMarketSnapshot } from "./markets";

export async function getEconomyOverview(days: number): Promise<EconomyOverview> {
  const [all, markets] = await Promise.all([getIndicators(365), getMarketSnapshot(days)]);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const conditions = economicConditions(all.indicators);
  const curve = oilCurve(markets.quotes);
  const briefing = conditions.filter(c => ["stress", "inflation", "jobs"].includes(c.id)).map(c =>
    `${c.title}: ${c.assessment}. ${c.detail}`
  );
  const brent = markets.quotes.find(q => q.id === "brent");
  if (brent?.value != null) briefing.push(`Energy: Brent near-contract oil is $${brent.value.toFixed(2)}/barrel${brent.changePercent !== null ? `, ${brent.changePercent >= 0 ? "+" : ""}${brent.changePercent.toFixed(2)}% versus the previous completed daily bar (${brent.previousCloseDate})` : ""}, observed ${brent.asOf}.${brent.status === "stale" ? " Retained or stale quote." : ""} Oil shocks can affect fuel budgets, import bills and inflation.`);
  else briefing.push("Energy: no usable Brent near-contract price is available. No current oil-price direction is inferred. The oil panel explains any source gaps.");
  return {
    ...all, days, indicators: all.indicators.map(ind => ({ ...ind, points: ind.points.filter(p => p.date >= cutoff) })),
    generatedAt: new Date().toISOString(), markets, conditions, briefing,
    rateExpectations: rateExpectations(markets.quotes), oilCurve: curve,
    notes: [
      "This is an economic briefing, not an investment recommendation or a single objective stability score. Financial conditions, household resilience and market prices can send different signals.",
      "Coverage: global market proxies and OFR global financial stress, with U.S.-weighted released macroeconomic and interest-rate data. This is not a comprehensive assessment of every country's economy.",
      "Quotes are indicative public Yahoo Finance observations and may be delayed or from a closed market. Quote timestamps are observation times; refresh times do not make an old price current. Subject to provider data-use terms.",
      "Daily changes use the preceding completed daily price bar, not certified exchange settlements. Front-month futures are rolling contracts; roll effects can create price-history jumps.",
      "Monthly macroeconomic dates identify the observed month, not the release date. Three-month comparisons are anchored to each series' latest observation, not a falsely synchronised 'today'; revisions are possible.",
      "Fed funds futures imply a contract-month average effective rate: 100 minus price. They include risk premia and are not meeting probabilities. Oil futures incorporate storage and risk premia and are not reliable point forecasts.",
      "Economic interpretations are transparent calculations and explanatory rules; AI integrations remain disabled.",
    ],
  };
}
