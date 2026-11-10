import type { FinanceIndicator, FinanceIndicators } from "./finance";

export type ObservationStatus = FinanceIndicator["status"];
export type EconomicPeriod = "1m" | "3m" | "6m";
export interface EconomicComparison {
  period: EconomicPeriod;
  baselineDate: string | null;
  baseline: number | null;
  change: number | null;
}
export interface EconomicCondition {
  id: string;
  title: string;
  indicatorId: string;
  assessment: string;
  detail: string;
  whyItMatters: string;
  observedAt: string | null;
  status: ObservationStatus;
  comparisons: EconomicComparison[];
}
export interface MarketQuote {
  id: string;
  symbol: string;
  name: string;
  category: "Energy" | "Equities" | "Currencies" | "Safe assets" | "Forward contracts";
  unit: string;
  explanation: string;
  contractLabel: string;
  contractMonth: string | null;
  value: number | null;
  previousClose: number | null;
  previousCloseDate: string | null;
  change: number | null;
  changePercent: number | null;
  asOf: string | null;
  fetchedAt: string | null;
  status: ObservationStatus;
  message: string;
  source: string;
  sourceUrl: string;
  points: { date: string; value: number | null }[];
}
export interface RateExpectation {
  quoteId: string;
  contractMonth: string;
  impliedRate: number | null;
  previousImpliedRate: number | null;
  changeBasisPoints: number | null;
  asOf: string | null;
  status: ObservationStatus;
  sourceUrl: string;
}
export interface OilCurve {
  nearQuoteId: string;
  farQuoteId: string;
  shape: "Backwardation" | "Contango" | "Flat" | "Unavailable";
  spread: number | null;
  spreadPercent: number | null;
  asOf: string | null;
  interpretation: string;
}
export interface EconomyOverview extends FinanceIndicators {
  generatedAt: string;
  markets: {
    quotes: MarketQuote[];
    updatedAt: string | null;
    nextRefreshAt: string | null;
    refreshing: boolean;
  };
  conditions: EconomicCondition[];
  briefing: string[];
  rateExpectations: RateExpectation[];
  oilCurve: OilCurve;
  notes: string[];
}
