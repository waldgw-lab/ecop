import test from "node:test";
import assert from "node:assert/strict";
import type { FinanceIndicator } from "../../shared/finance";
import { annualChanges, compareIndicator, economicConditions, oilCurve, rateExpectations } from "./economyAnalysis";
import { parseMarketChart, unavailableQuote, type QuoteDefinition } from "./marketParsing";
import { buildBriefing } from "./briefing";

const now = Date.parse("2026-11-10T18:00:00Z");
const seconds = (date: string) => Date.parse(date) / 1000;
const definition: QuoteDefinition = { id: "wti", symbol: "CL=F", name: "WTI", category: "Energy", unit: "USD / barrel", explanation: "Oil benchmark" };
function payload() {
  return { chart: { result: [{
    meta: { symbol: "CL=F", regularMarketPrice: 100, regularMarketTime: seconds("2026-11-10T17:00:00Z"), exchangeTimezoneName: "America/New_York", chartPreviousClose: 50 },
    timestamp: ["2026-11-06", "2026-11-09", "2026-11-10"].map(d => seconds(`${d}T05:00:00Z`)),
    indicators: { quote: [{ close: [75, 80, 100] }] },
  }] } };
}
const indicator = (points: FinanceIndicator["points"], frequency = "Monthly"): FinanceIndicator => ({
  id: "UNRATE", name: "Unemployment", description: "", unit: "%", source: "BLS", sourceUrl: "https://fred.stlouisfed.org/series/UNRATE", frequency,
  points, latest: points.at(-1) as { date: string; value: number }, previous: null, change: null,
  status: "available", fetchedAt: null, message: "",
});
test("quote change uses previous completed day, never chartPreviousClose at start of year", () => {
  const quote = parseMarketChart(payload(), definition, now);
  assert.equal(quote.previousClose, 80);
  assert.equal(quote.previousCloseDate, "2026-11-09");
  assert.equal(quote.change, 20);
  assert.equal(quote.changePercent, 25);
  assert.equal(quote.points.length, 3);
});
test("invalid quote identity, future times and missing prices fail explicitly", () => {
  const bad = payload(); bad.chart.result[0].meta.symbol = "OTHER";
  assert.throws(() => parseMarketChart(bad, definition, now), /matching/);
  const future = payload(); future.chart.result[0].meta.regularMarketTime = now / 1000 + 400;
  assert.throws(() => parseMarketChart(future, definition, now), /matching/);
  assert.throws(() => parseMarketChart({ chart: { result: null } }, definition, now));
});
test("null daily observations remain gaps; a missing prior close does not become zero", () => {
  const raw = payload(); raw.chart.result[0].indicators.quote[0].close = [null, null, 100] as unknown as number[];
  const quote = parseMarketChart(raw, definition, now);
  assert.equal(quote.points[0].value, null);
  assert.equal(quote.previousClose, null);
  assert.equal(quote.change, null);
});
test("year-on-year inflation uses exactly the same prior-year month and preserves missing months", () => {
  const data = annualChanges([
    { date: "2025-09-01", value: 200 }, { date: "2025-10-01", value: null },
    { date: "2026-09-01", value: 210 }, { date: "2026-10-01", value: 220 },
  ]);
  assert.ok(Math.abs(data[2].value! - 5) < 1e-10);
  assert.equal(data[3].value, null);
});
test("monthly comparisons do not silently borrow an adjacent month", () => {
  const ind = indicator([{ date: "2026-06-01", value: 4 }, { date: "2026-08-01", value: 4.1 }, { date: "2026-10-01", value: 4.3 }]);
  const comparisons = compareIndicator(ind);
  assert.equal(comparisons[0].baseline, null);
  assert.equal(comparisons[1].baseline, null);
});
test("month-end lookbacks clamp rather than spilling into the next month", () => {
  const ind = indicator([{ date: "2026-02-28", value: 2 }, { date: "2026-05-31", value: 3 }], "Daily");
  assert.equal(compareIndicator(ind)[1].baselineDate, "2026-02-28");
  assert.equal(compareIndicator(ind)[1].change, 1);
});
test("futures imply monthly average rates and invert price changes to basis points correctly", () => {
  const quote = { ...parseMarketChart(payload(), definition, now), id: "fedfunds-3m", value: 95.75, previousClose: 95.8, contractMonth: "2027-02" };
  const rate = rateExpectations([quote])[0];
  assert.equal(rate.impliedRate, 4.25);
  assert.ok(Math.abs(rate.changeBasisPoints! - 5) < 1e-8);
});
test("backwardation is far-minus-near negative; stale or unsynchronised observations give no signal", () => {
  const near = parseMarketChart(payload(), definition, now);
  const far = { ...near, id: "wti-6m", value: 90, contractMonth: "2027-05" };
  assert.equal(oilCurve([near, far]).spread, -10);
  assert.equal(oilCurve([near, far]).shape, "Backwardation");
  assert.equal(oilCurve([near, { ...far, status: "stale" }]).shape, "Unavailable");
  assert.equal(oilCurve([near, { ...far, asOf: "2026-11-09T00:00:00Z" }]).shape, "Unavailable");
});
test("missing economic data and unavailable quotes never become reassuring zeroes", () => {
  const conditions = economicConditions([]);
  assert.equal(conditions.length, 6);
  assert.ok(conditions.every(c => c.status === "unavailable" && c.observedAt === null));
  assert.equal(unavailableQuote(definition, "Failed").value, null);
  assert.equal(rateExpectations([])[0].impliedRate, null);
});
test("BLUF pairs dated facts with significance, without leaking technical data-quality notices", () => {
  const inflation: FinanceIndicator = {
    ...indicator([{ date: "2026-06-01", value: 3.47 }, { date: "2026-09-01", value: 3.72 }]),
    id: "CPI_YOY", status: "stale", message: "Annual comparison is unavailable because a source observation is missing.",
  };
  const jobs = indicator([{ date: "2026-07-01", value: 4.1 }, { date: "2026-10-01", value: 4.1 }]);
  const conditions = economicConditions([inflation, jobs]);
  const oil = { ...parseMarketChart(payload(), definition, now), id: "brent" };
  const items = buildBriefing([inflation, jobs], conditions, [oil]);
  assert.deepEqual(items.map(i => i.id), ["02", "03", "04"]);
  const text = items.map(i => i.text).join("\n");
  assert.match(text, /3.72% higher.*September 2026/);
  assert.match(text, /rose 0.25 percentage points/);
  assert.match(text, /household budgets and operating costs/);
  assert.match(text, /little changed over three months/);
  assert.match(text, /tax revenue/);
  assert.match(text, /oil-exporting governments/);
  assert.doesNotMatch(text, /missing|unavailable|stale|source observation|No usable|current-day assessment/i);
});
test("BLUF omits unsupported facts and comparisons rather than reporting data gaps", () => {
  assert.deepEqual(buildBriefing([], economicConditions([]), []), []);
  const jobs = indicator([{ date: "2026-10-01", value: 4.1 }]);
  const [item] = buildBriefing([jobs], economicConditions([jobs]), []);
  assert.equal(item.id, "03");
  assert.match(item.text, /4.10% in October 2026/);
  assert.doesNotMatch(item.text, /three months|baseline|unavailable|missing/i);
});
test("BLUF distinguishes above-average stress and falling consumer prices", () => {
  const stress = { ...indicator([{ date: "2026-11-06", value: 1.2 }], "Daily"), id: "OFR_FSI" };
  const prices = { ...indicator([{ date: "2026-09-01", value: -1 }]), id: "CPI_YOY" };
  const items = buildBriefing([stress, prices], economicConditions([stress, prices]), []);
  assert.match(items[0].text, /above its historical average/);
  assert.match(items[0].text, /credit harder to obtain/);
  assert.match(items[1].text, /1.00% lower/);
  assert.match(items[1].text, /weak demand/);
});
