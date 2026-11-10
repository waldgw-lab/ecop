/** On-demand, source-grounded guide. No model calls or persisted conversations. */
export interface FinanceChatMessage {
  role: "user" | "assistant";
  content: string;
}
export interface FinanceChatResponse {
  answer: string;
  sources: { label: string; url: string; observedAt: string | null }[];
  asOf: string;
  mode: "data-guide";
  suggestions: string[];
}
