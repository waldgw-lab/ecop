import { z } from "zod";
import type { EconomyOverview } from "../../shared/economy";
import type { FinanceDashboard, FinanceIndicator } from "../../shared/finance";
import type { FinanceChatResponse } from "../../shared/financeChat";

export const financeChatInput = z.object({
  message: z.string().trim().min(1).max(1500),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(12000),
  }).strict()).max(12).default([]),
}).strict();

type Input = z.infer<typeof financeChatInput>;
const n = (v: number | null | undefined, suffix = "") =>
  v == null || !Number.isFinite(v) ? "unavailable" : `${v.toFixed(2)}${suffix}`;
const signed = (v: number | null | undefined, suffix = "") =>
  v == null || !Number.isFinite(v) ? "unavailable" : `${v > 0 ? "+" : ""}${v.toFixed(2)}${suffix}`;
const DEFAULT_SUGGESTIONS = ["What is today's BLUF?", "Explain oil and the futures curve", "How has inflation changed?", "What are the top financial stories?"];

/** Deliberately rule-based while the operator's external-AI stop remains in force.
 * Publisher text is quoted as evidence, never executed as instructions.
 */
export function answerFinanceQuestion(input: Input, e: EconomyOverview, d: FinanceDashboard): FinanceChatResponse {
  const current = input.message.toLowerCase();
  const followup = /^(why\b|what does (that|this) mean|how (has it|did it|does (that|this))|compare (it|that|this)|what about (last|previous)|and (last|previous)|tell me more|explain (that|this))/i.test(current);
  const lastQuestion = [...input.history].reverse().find(m => m.role === "user")?.content.toLowerCase() ?? "";
  const query = followup ? `${lastQuestion} ${current}` : current;
  const sources: FinanceChatResponse["sources"] = [];
  const sections: string[] = [];
  const addSource = (label: string, url: string, observedAt: string | null) => {
    try {
      const parsed = new URL(url);
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return;
      if (!sources.some(s => s.url === url)) sources.push({ label, url, observedAt });
    } catch { /* A missing or unsafe source is not offered as a clickable citation. */ }
  };
  const citeIndicator = (i: FinanceIndicator | undefined) => {
    if (i) addSource(`${i.name} · ${i.source}`, i.sourceUrl, i.latest?.date ?? null);
  };
  const condition = (id: string) => {
    const c = e.conditions.find(c => c.id === id);
    if (!c) return;
    const i = e.indicators.find(i => i.id === c.indicatorId);
    sections.push(`${c.title}: ${c.assessment}\n${c.detail}\nWhy it matters: ${c.whyItMatters}\nStatus: ${c.status}; observation: ${c.observedAt ?? "unavailable"}.\n` +
      c.comparisons.map(p => `${p.period} comparison: ${p.baselineDate ?? "no baseline"}; then ${n(p.baseline, i?.unit ? ` ${i.unit}` : "")}; change ${signed(p.change, i?.unit.includes("%") ? " percentage points" : " index points")}.`).join("\n"));
    citeIndicator(i);
  };
  const quote = (id: string) => {
    const q = e.markets.quotes.find(q => q.id === id);
    if (!q) return;
    sections.push(`${q.name}: ${n(q.value)} ${q.unit}; daily change ${signed(q.change)} (${signed(q.changePercent, "%")}) versus ${q.previousCloseDate ?? "unavailable prior bar"}.\nContract: ${q.contractLabel}${q.contractMonth ? ` · ${q.contractMonth}` : ""}. Observed: ${q.asOf ?? "unavailable"}; status: ${q.status}.\n${q.explanation}${q.message ? ` ${q.message}` : ""}`);
    addSource(`${q.name} · ${q.source}`, q.sourceUrl, q.asOf);
  };

  if (/\b(bluf|briefing|overview|summary|summarize|situation|stable|stability|recession)\b|what.*(important|going on)|how.*economy/.test(query)) {
    sections.push(`Today's BLUF (source-dated, not all observed today)\n${e.briefing.length ? e.briefing.join("\n\n") : "No briefing is available from the loaded observations."}\nThese indicators do not establish a recession probability or an objective global stability score.`);
    for (const id of ["OFR_FSI", "CPI_YOY", "UNRATE"]) citeIndicator(e.indicators.find(i => i.id === id));
    const brent = e.markets.quotes.find(q => q.id === "brent");
    if (brent) addSource(brent.name, brent.sourceUrl, brent.asOf);
  }
  if (/\b(oil|brent|wti|energy|fuel|contango|backwardation)\b/.test(query)) {
    quote("wti"); quote("brent");
    quote("wti-6m");
    sections.push(`WTI futures curve: ${e.oilCurve.shape}. Far minus near: ${n(e.oilCurve.spread, " USD/barrel")}. ${e.oilCurve.interpretation}\nFutures are not certain forecasts of spot prices. Near-contract histories can jump at contract rolls. Oil shocks can raise fuel budgets, import bills and inflation, while falling prices can pressure exporters' revenues.`);
  }
  if (/\b(inflation|cpi|prices|purchasing|household|cost of living)\b/.test(query)) condition("inflation");
  if (/\b(jobs|job|unemployment|employment|labor|labour)\b/.test(query)) condition("jobs");
  if (/\b(stress|strain|vix|volatility|liquidity|banking)\b/.test(query)) {
    condition("stress"); condition("uncertainty");
  }
  if (/\b(growth|production|output|gdp|industrial)\b/.test(query)) {
    condition("activity");
    sections.push("Industrial production is not GDP; this dashboard does not currently include a GDP series.");
  }
  if (/\b(rates?|yields?|treasury|fed|federal|sofr|funding|borrowing)\b/.test(query) || (/\bfutures?\b/.test(query) && !/\b(oil|wti|brent)\b/.test(query))) {
    for (const id of ["DFF", "SOFR", "DGS2", "DGS10", "T10Y2Y", "T10YIE"]) {
      const i = e.indicators.find(i => i.id === id);
      if (!i) continue;
      sections.push(`${i.name}: ${n(i.latest?.value, ` ${i.unit}`)}; ${signed(i.change == null ? null : i.change * 100, " bp")} versus prior observation. Observed ${i.latest?.date ?? "unavailable"}; status ${i.status}.`);
      citeIndicator(i);
    }
    for (const r of e.rateExpectations) {
      sections.push(`Fed funds ${r.contractMonth || "unavailable contract month"}: ${n(r.impliedRate, "%")} implied monthly average rate; daily change ${signed(r.changeBasisPoints, " bp")}; observed ${r.asOf ?? "unavailable"}; status ${r.status}.`);
      addSource(`Fed funds futures ${r.contractMonth}`, r.sourceUrl, r.asOf);
    }
    sections.push("One basis point (bp) = 0.01 percentage point. Fed funds futures imply a contract-month average effective rate (100 minus price), not a specific Fed decision or a meeting probability. Treasury yields also reflect inflation expectations and risk premia.");
  }
  if (/\b(dollar|currenc(?:y|ies)|eur|yen|yuan|exchange|stocks|equities|gold|markets)\b/.test(query)) {
    const ids = /\b(gold)\b/.test(query) ? ["gold"] : /\b(stocks|equities)\b/.test(query) ? ["sp500-futures", "eurostoxx", "nikkei"] : ["eurusd", "usdjpy", "usdcny"];
    ids.forEach(quote);
  }
  if (/\b(fear|greed)\b/.test(query)) {
    sections.push(`CNN Fear & Greed is not supplied: ${e.fearAndGreed.message} VIX and OFR are different indicators, not substitutes.`);
    addSource("CNN Fear & Greed", e.fearAndGreed.sourceUrl, null);
  }
  if (/\b(sources?|coverage|methodology|reliab\w*|stale|delayed|limitations|data|ai|chatbot)\b/.test(query)) {
    sections.push(`This assistant is a rule-based guide to the latest loaded dashboard, not a generative AI model. It makes no external model calls and does not store conversations.\n${e.notes.filter(note => !note.startsWith("Economic interpretations")).join("\n")}\n${d.methodology.description}\n${d.sources.filter(s => s.status === "error" || s.status === "unavailable").length} news sources currently report errors or unavailability. News evidence scores are prioritization rules, not probabilities.`);
  }
  const newsRequest = /\b(news|stories|story|headlines|reports|dataminr|social|sanctions|trade|china|russia|iran|europe|tariffs)\b/.test(query);
  if (newsRequest) {
    const signalOnly = /\b(dataminr|social|signals|alerts)\b/.test(query);
    const pool = signalOnly ? d.signals : d.stories;
    const stop = new Set("what are the top latest financial news stories story headlines reports about today show me tell of in and is happening please any current with".split(" "));
    const terms = current.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(w => w.length > 2 && !stop.has(w) && !["dataminr", "social", "signals", "alerts"].includes(w));
    const generic = terms.length === 0;
    const ranked = pool.map(s => ({
      s, matches: terms.filter(t => `${s.title} ${s.summary} ${s.source} ${s.topic} ${s.region}`.toLowerCase().includes(t)).length,
    })).filter(x => generic || x.matches > 0).sort((a, b) => b.matches - a.matches || b.s.impact - a.s.impact).slice(0, 5);
    sections.push(`${signalOnly ? "Unconfirmed Dataminr/social signals — verify before relying on them" : "Priority reporting and official news — publisher claims, not independent verification"}:\n${ranked.length ? ranked.map(({ s }, index) => {
      addSource(s.source, s.url, s.publishedAt);
      return `${index + 1}. ${s.title}\n${s.source} · ${s.region} · ${s.confidence} · published ${s.publishedAt}. Evidence score ${s.impact}/100.\n${s.summary.slice(0, 650)}`;
    }).join("\n\n") : "No matching items are in the currently loaded feed. This does not establish that no such events exist."}`);
  }
  if (!sections.length) sections.push("I can explain this dashboard's BLUF, oil prices and futures curve, interest rates, inflation, jobs, financial stress, industrial production, currency quotes, and loaded news. I cannot browse the web, give investment advice, predict crises, or answer arbitrary questions while external AI is paused. Ask about one of those topics or request stories mentioning a country or subject.");
  return {
    answer: sections.join("\n\n"),
    sources,
    asOf: e.generatedAt,
    mode: "data-guide",
    suggestions: DEFAULT_SUGGESTIONS,
  };
}
