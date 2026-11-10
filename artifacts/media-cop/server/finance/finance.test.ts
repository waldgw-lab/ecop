import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFinance, detectRegion, rankFinanceStories, safeLink } from "./scoring";
import { csvPoints } from "./publicData";

const story = (title: string, extra: Record<string, unknown> = {}) => classifyFinance({
  title, url: "https://example.org/test", source: "Test publication", owner: "Test owner",
  kind: "reporting", publishedAt: new Date().toISOString(), ...extra,
});
test("systemic bank stress outranks routine policy; investment tips are excluded", () => {
  const severe = story("U.S. banking crisis spreads globally as emergency bank rescue averts default");
  const routine = story("Federal Reserve discusses interest rates and monetary policy");
  assert.ok(severe && routine);
  assert.ok(severe.impact > routine.impact);
  assert.equal(story("Best stocks to buy and dividend stocks"), null);
  assert.equal(story("Company earnings per share beat expectations"), null);
});
test("news filtering keeps economic sanctions, supply shocks and sovereign defaults", () => {
  for (const title of ["Sovereign debt default forces emergency bailout", "Sanctions disrupt global oil supply", "Wheat shortage and food prices surge"]) assert.ok(story(title), title);
  assert.equal(story("Football club wins championship"), null);
});
test("signals remain unconfirmed regardless of severity", () => {
  const signal = story("Global banking crisis triggers emergency liquidity", { kind: "dataminr" });
  assert.equal(signal?.confidence, "Unconfirmed signal");
  assert.equal(story("Federal Reserve announces interest rate cuts", { kind: "official" })?.confidence, "Primary source");
});
test("headline topic wins over incidental excerpt context", () => {
  const inflation = story("U.S. inflation rose as gas costs dipped", { summary: "Treasury yields moved after the banking report." });
  assert.equal(inflation?.topic, "Inflation & monetary policy");
});
test("conservative grouping never boosts impact or manufactures confidence", () => {
  const a = story("Global banking crisis spreads as emergency bank rescue averts default");
  const b = story("Global banking crisis spreads as emergency bank rescue averts default", { url: "https://second.org/report", source: "Other", owner: "Second owner" });
  assert.ok(a && b);
  const ranked = rankFinanceStories([a, b]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sourceCount, 2);
  assert.ok(ranked[0].impact <= a.impact);
  assert.equal(ranked[0].confidence, "Reported");
  const sameOwner = { ...b, owner: a.owner };
  assert.equal(rankFinanceStories([a, sameOwner])[0].sourceCount, 1);
});
test("decay does not mutate stored evidence and new developments remain distinct", () => {
  const a = story("Global banking crisis triggers emergency liquidity");
  const b = story("Global banking crisis triggers emergency liquidity", { publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), id: "older" });
  assert.ok(a && b);
  const raw = a.impact;
  const ranked = rankFinanceStories([a], Date.now() + 72 * 3_600_000);
  assert.ok(Math.abs(ranked[0].impact - raw / 2) <= 1);
  assert.equal(a.impact, raw);
  assert.equal(rankFinanceStories([a, b]).length, 2);
});
test("regions, missing dates and unsafe links are handled explicitly", () => {
  assert.equal(detectRegion("U.S. and European banking liquidity"), "Global");
  assert.equal(detectRegion("China yuan devaluation"), "Asia-Pacific");
  assert.equal(story("Global banking crisis", { publishedAt: "not-a-date" }), null);
  assert.equal(safeLink("javascript:alert(1)"), null);
  assert.equal(safeLink("https://name:password@example.org"), null);
  assert.equal(safeLink("https://example.org/report?utm_source=test"), "https://example.org/report");
});
test("historical parsing preserves missing observations and negative stress values", () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const points = csvPoints(`Date,Stress\n${yesterday},-0.7\n${today},\n`, "Date", "Stress");
  assert.deepEqual(points, [{ date: yesterday, value: -0.7 }, { date: today, value: null }]);
  assert.throws(() => csvPoints("wrong,column\n1,2", "Date", "Stress"), /columns/);
});
