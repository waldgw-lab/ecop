import { createHash } from "node:crypto";
import type { FinanceRegion, FinanceStory, FinanceTopic } from "../../shared/finance";

const RULES: { topic: FinanceTopic; pattern: RegExp; reason: string }[] = [
  { topic: "Banking & liquidity", pattern: /\b(bank run|deposit(?:s|ors)?|bank(?:ing)? (?:crisis|failure|stress|rescue|liquidity)|liquidity|credit crunch|interbank|bankrupt(?:cy|cies)?|insolven(?:t|cy)|lender|banks?|financial institutions?)\b/i, reason: "Banking, credit availability and liquidity can transmit stress across the economy." },
  { topic: "Sovereign & fiscal risk", pattern: /\b(sovereign|debt (?:crisis|default|ceiling|restructur|sustainab)|default|fiscal|government shutdown|budget (?:deficit|crisis)|bond (?:market|yield)|treasur(?:y|ies)|public debt|IMF|bailout)\b/i, reason: "Sovereign financing and fiscal capacity affect government resilience." },
  { topic: "Inflation & monetary policy", pattern: /\b(inflation|deflation|interest rates?|rate (?:cut|cuts|hike|hikes)|monetary|central bank|federal reserve|(?:fed|ECB|BOJ|BOE) (?:chair|policy|rate|cut|hike)|CPI|stagflation)\b/i, reason: "Price pressures and monetary conditions influence financing costs and household stress." },
  { topic: "Currencies & capital flows", pattern: /\b(currenc(?:y|ies)|capital (?:flight|control|flow)|devalu(?:e|ation)|exchange rate|dollar|yuan|renminbi|ruble|rouble|rupee|foreign reserves|forex)\b/i, reason: "Exchange-rate and capital-flow disruption can impair external financing." },
  { topic: "Sanctions & economic coercion", pattern: /\b(sanctions?|embargo|export (?:control|ban|restriction)|asset freez|frozen assets|economic coercion|trade war|tariffs?)\b/i, reason: "Economic restrictions can disrupt trade, financing and critical inputs." },
  { topic: "Energy & food security", pattern: /\b(oil|crude|natural gas|LNG|energy (?:crisis|supply|security|price)|fuel|diesel|OPEC|food (?:price|crisis|security|shortage)|wheat|grain|fertili[sz]er|famine|electricity|power grid)\b/i, reason: "Energy and food affordability are potential drivers of supply disruption and instability." },
  { topic: "Trade & critical supply chains", pattern: /\b(supply chain|shipping|freight|port strike|chokepoint|suez|hormuz|red sea|semiconductor|rare earth|critical mineral|trade (?:deficit|surplus|deal|disruption|war)|exports?|imports?|manufacturing)\b/i, reason: "Trade and critical-supply disruption can affect essential goods and industrial readiness." },
  { topic: "Markets & systemic stress", pattern: /\b(financial (?:crisis|stress|stability|system)|market (?:crash|sell.?off|turmoil|volatility)|stock market|equities|S&P|wall street|VIX|credit spread|recession|contagion|stablecoin|cryptocurrency|bitcoin)\b/i, reason: "Market or credit stress may reveal broader vulnerabilities; prices alone do not prove instability." },
  { topic: "Employment & domestic stability", pattern: /\b(unemployment|jobless|jobs report|payroll|mass layoffs?|labor (?:market|unrest|strike)|labour (?:market|unrest|strike)|cost.of.living|economic (?:crisis|protest)|austerity|poverty|wage)\b/i, reason: "Employment and household-income pressures can contribute to domestic instability." },
];
const SYSTEMIC = /\b(bank run|banking crisis|financial crisis|systemic|contagion|sovereign default|debt default|debt crisis|capital controls?|payment system|insolven|bank fail|bank collapse|bank rescue|credit crunch)\b/i;
const DISRUPTION = /\b(crisis|shutdown|shortage|disruption|default|bailout|emergency|collapse|freeze|plunge|surge|shock|record high|record low|blockade|strike|sanctions?|embargo|tariffs?|recession)\b/i;
const REACH = /\b(global|worldwide|international|cross.border|european union|eurozone|G7|G20|multiple countries)\b/i;
const EXPOSURE = /\b(U\.?S\.?|United States|American|Europe|NATO|allies|Taiwan|semiconductor|critical mineral|oil|gas|food|shipping|energy|sanctions?|treasury)\b/i;
const PERSISTENCE = /\b(escalat|spread|worsen|prolong|sustain|persistent|continued|months|restructur|systemic|crisis)\b/i;
const NOISE = /\b(stock picks?|price targets?|stocks? to buy|best stocks?|earnings per share|dividend stocks?|celebrity|football|movie|recipe)\b/i;

export function safeLink(input: unknown): string | null {
  if (typeof input !== "string") return null;
  try {
    const u = new URL(input);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^(fbclid|gclid|ref)$/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch { return null; }
}
export function financeId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}
export function detectRegion(text: string): FinanceRegion {
  const matches: FinanceRegion[] = [];
  if (/\b(U\.?S\.?|United States|American|Federal Reserve|Treasury|Wall Street)\b/i.test(text)) matches.push("United States");
  if (/\b(Europe|European|ECB|eurozone|Britain|British|UK|Germany|France|Russia|Ukraine)\b/i.test(text)) matches.push("Europe");
  if (/\b(China|Chinese|Japan|Taiwan|Korea|India|Pakistan|Australia|Asia|yuan|yen)\b/i.test(text)) matches.push("Asia-Pacific");
  if (/\b(Iran|Israel|Saudi|Gulf|Hormuz|Middle East|Lebanon|Iraq|Yemen)\b/i.test(text)) matches.push("Middle East");
  if (/\b(Africa|Nigeria|Kenya|Egypt|Sudan|Ethiopia|Ghana)\b/i.test(text)) matches.push("Africa");
  if (/\b(Canada|Brazil|Mexico|Argentina|Venezuela|Latin America|Chile)\b/i.test(text)) matches.push("Americas");
  return REACH.test(text) || matches.length > 1 ? "Global" : matches[0] ?? "Global";
}
export function classifyFinance(input: {
  id?: string; title: string; summary?: string; url: string; source: string; owner: string;
  kind: FinanceStory["kind"]; publishedAt: string; observedAt?: string; alertType?: string | null; terms?: string | null;
}): FinanceStory | null {
  const text = `${input.title} ${input.summary ?? ""}`;
  const url = safeLink(input.url);
  const published = Date.parse(input.publishedAt);
  if (!url || !Number.isFinite(published) || published > Date.now() + 300_000) return null;
  if (NOISE.test(input.title) && !SYSTEMIC.test(text)) return null;
  // The headline's subject wins over incidental context in the publisher excerpt.
  const rule = RULES.find(r => r.pattern.test(input.title)) ?? RULES.find(r => r.pattern.test(text));
  if (!rule) return null;
  // Bank of a river / central-bank appointments and routine earnings are not crisis signals.
  if (/\b(earnings|quarterly profit|share price|stock price|appointments?|appointed|reappointed|nominations?)\b/i.test(input.title) && !DISRUPTION.test(input.title) && !SYSTEMIC.test(input.title)) return null;
  const evidence = [
    { label: "Systemic consequence", maximum: 35, points: SYSTEMIC.test(input.title) ? 35 : SYSTEMIC.test(text) ? 25 : DISRUPTION.test(input.title) ? 20 : 8 },
    { label: "Potential cross-border / sector reach", maximum: 20, points: REACH.test(text) ? 20 : detectRegion(text) !== "Global" ? 9 : 5 },
    { label: "Immediacy / abnormality", maximum: 20, points: DISRUPTION.test(input.title) ? 18 : DISRUPTION.test(text) ? 12 : 5 },
    { label: "Security / critical supply exposure", maximum: 15, points: EXPOSURE.test(text) ? 15 : 4 },
    { label: "Persistence / escalation", maximum: 10, points: PERSISTENCE.test(text) ? 10 : 3 },
  ];
  return {
    ...input, id: input.id ?? financeId(url), summary: (input.summary ?? "").slice(0, 700),
    url, observedAt: input.observedAt ?? new Date().toISOString(), topic: rule.topic,
    region: detectRegion(text), impact: evidence.reduce((s, e) => s + e.points, 0),
    confidence: input.kind === "official" ? "Primary source" : ["dataminr", "social"].includes(input.kind) ? "Unconfirmed signal" : "Reported",
    reasons: [rule.reason, SYSTEMIC.test(text) ? "Contains a systemic-financial disruption signal; confirm scope against the linked evidence." : "Impact is a screening assessment, not a prediction of unrest."],
    evidence, sourceCount: 1, relatedSources: [],
  };
}
function titleTokens(title: string) {
  return new Set(title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2 && !["the", "and", "for", "with", "says", "say", "from", "that"].includes(w)));
}
export function rankFinanceStories(input: FinanceStory[], now = Date.now()): FinanceStory[] {
  const sorted = input.map(s => ({
    ...s,
    // Identical decay for all channels; original evidence scores are kept for explanation.
    impact: Math.max(1, Math.round(s.evidence.reduce((sum, e) => sum + e.points, 0) * Math.pow(0.5, Math.max(0, now - Date.parse(s.publishedAt)) / (72 * 3_600_000)))),
    sourceCount: 1, relatedSources: [] as FinanceStory["relatedSources"],
  })).sort((a, b) => b.impact - a.impact || b.publishedAt.localeCompare(a.publishedAt));
  const result: FinanceStory[] = [];
  const owners = new Map<string, Set<string>>();
  for (const story of sorted) {
    const tokens = titleTokens(story.title);
    const twin = result.find(s => {
      if (s.topic !== story.topic || Math.abs(Date.parse(s.publishedAt) - Date.parse(story.publishedAt)) > 18 * 3_600_000) return false;
      const a = titleTokens(s.title);
      const intersection = [...a].filter(t => tokens.has(t)).length;
      return s.url === story.url || (Math.min(a.size, tokens.size) >= 5 && intersection / new Set([...a, ...tokens]).size >= 0.78);
    });
    if (twin) {
      if (!twin.relatedSources.some(r => r.url === story.url) && twin.url !== story.url) twin.relatedSources.push({ source: story.source, url: story.url });
      owners.get(twin.id)!.add(story.owner);
      twin.sourceCount = owners.get(twin.id)!.size;
      // Similar headlines are grouping, NOT independently verified corroboration; never increase impact or confidence.
    } else { result.push(story); owners.set(story.id, new Set([story.owner])); }
  }
  return result;
}
