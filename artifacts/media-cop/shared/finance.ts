/** Financial-monitoring contract. This mirror keeps its legacy Express API, not scaffold codegen. */
export const FINANCE_TOPICS = [
  "Banking & liquidity", "Sovereign & fiscal risk", "Inflation & monetary policy",
  "Currencies & capital flows", "Sanctions & economic coercion", "Energy & food security",
  "Trade & critical supply chains", "Markets & systemic stress", "Employment & domestic stability",
] as const;
export type FinanceTopic = typeof FINANCE_TOPICS[number];
export const FINANCE_REGIONS = ["Global", "United States", "Europe", "Asia-Pacific", "Middle East", "Africa", "Americas"] as const;
export type FinanceRegion = typeof FINANCE_REGIONS[number];
export interface FinanceStory {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  owner: string;
  kind: "reporting" | "official" | "dataminr" | "social";
  publishedAt: string;
  observedAt: string;
  topic: FinanceTopic;
  region: FinanceRegion;
  impact: number;
  confidence: "Primary source" | "Reported" | "Unconfirmed signal";
  reasons: string[];
  evidence: { label: string; points: number; maximum: number }[];
  sourceCount: number;
  relatedSources: { source: string; url: string }[];
  alertType?: string | null;
  terms?: string | null;
}
export interface FinanceSourceHealth {
  id: string;
  name: string;
  url: string;
  kind: FinanceStory["kind"];
  status: "healthy" | "error" | "unavailable" | "refreshing";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  latestPublicationAt: string | null;
  received: number;
  relevant: number;
  message: string;
}
export interface FinanceSocialAccount {
  name: string; handle: string; url: string; role: "Institution" | "Journalist" | "Analyst";
  focus: string; status: "Via public releases" | "Not directly collected";
}
export interface FinanceDashboard {
  stories: FinanceStory[];
  signals: FinanceStory[];
  sources: FinanceSourceHealth[];
  socialAccounts: FinanceSocialAccount[];
  topics: readonly string[];
  regions: readonly string[];
  updatedAt: string | null;
  refreshing: boolean;
  nextRefreshAt: string | null;
  methodology: { title: string; description: string; weights: { label: string; maximum: number }[]; limitations: string[] };
  dataminr: { configured: boolean; status: string; message: string };
}
export interface FinanceIndicator {
  id: string; name: string; description: string; unit: string;
  source: string; sourceUrl: string; frequency: string;
  points: { date: string; value: number | null }[];
  latest: { date: string; value: number } | null;
  previous: { date: string; value: number } | null;
  change: number | null;
  status: "available" | "stale" | "unavailable";
  fetchedAt: string | null; message: string;
}
export interface FinanceIndicators {
  days: number; indicators: FinanceIndicator[];
  fearAndGreed: { status: "unavailable"; sourceUrl: string; message: string };
}
