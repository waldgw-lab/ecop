import type { ReactNode } from "react";
import type { EconomicCondition, EconomyOverview, MarketQuote } from "@shared/economy";
import type { FinanceIndicator } from "@shared/finance";
import { ExternalLink } from "lucide-react";
import { fmtDate, fmtDateTime, fmtNum } from "../utils";
import { PAL, Spark, TimeChart, moveColor, signed, statusColor } from "./charts";

export function Pane({ title, sub, right, children, className = "", testId }: { title: string; sub?: string; right?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={`fsw-panel min-w-0 overflow-hidden ${className}`} data-testid={testId}>
      <header className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 border-b border-[hsl(var(--fsw-line))]">
        <div className="min-w-0"><h2 className="fsw-label text-[hsl(var(--fsw-ink))]">{title}</h2>{sub && <p className="text-[11px] text-[hsl(var(--fsw-dim))] mt-0.5">{sub}</p>}</div>{right}
      </header>
      {children}
    </section>
  );
}

const byId = (e: EconomyOverview, id: string) => e.indicators.find((i) => i.id === id);
const q = (e: EconomyOverview, id: string) => e.markets.quotes.find((x) => x.id === id);
const ser = (i: FinanceIndicator | undefined, name: string, color: string, step = false) => i ? [{ key: i.id, name, color, unit: i.unit, step, points: i.points }] : [];

export function Briefing({ e }: { e: EconomyOverview }) {
  return (
    <section className="fsw-panel min-w-0 p-4 border-l-2 border-l-[hsl(var(--fsw-brass))]" data-testid="section-briefing">
      <p className="fsw-label text-[hsl(var(--fsw-brass))]">The picture in plain terms</p>
      {e.briefing.length === 0 ? <p className="mt-2 text-sm text-[hsl(var(--fsw-dim))]">No briefing lines could be drawn from available data.</p> : (
        <ol className="mt-2 grid grid-cols-1 gap-x-8 gap-y-2 lg:grid-cols-2">
          {e.briefing.map((b, i) => <li key={i} className="grid grid-cols-[1.5rem_1fr] text-[14px] leading-snug" data-testid={`text-briefing-${i}`}><span className="fsw-mono text-xs text-[hsl(var(--fsw-brass))] pt-0.5">{String(i + 1).padStart(2, "0")}</span><span>{b}</span></li>)}
        </ol>
      )}
      <p className="mt-3 text-[11px] text-[hsl(var(--fsw-dim))]">Coverage: macro series are US-weighted; the OFR stress index is global. Descriptive only — no stability score, forecast or trading advice.</p>
    </section>
  );
}

function Condition({ c, ind }: { c: EconomicCondition; ind?: FinanceIndicator }) {
  return (
    <article className="fsw-panel min-w-0 p-3 bg-[hsl(var(--fsw-panel-2)/0.5)] hover:border-[hsl(var(--fsw-dim)/0.5)] transition-colors" data-testid={`card-condition-${c.id}`}>
      <div className="flex justify-between gap-2"><h3 className="text-sm font-semibold leading-tight">{c.title}</h3><span className="fsw-label shrink-0" style={{ color: statusColor(c.status) }}>{c.status}</span></div>
      <p className="mt-1 text-[15px] font-medium leading-snug" data-testid={`text-condition-assessment-${c.id}`}>{c.assessment}</p>
      <div className="mt-1 flex items-baseline gap-2 fsw-mono">
        <span className="text-lg" data-testid={`text-condition-value-${c.id}`}>{ind?.latest ? fmtNum(ind.latest.value) : "—"}</span>
        <span className="text-[11px] text-[hsl(var(--fsw-dim))]">{ind?.unit} · obs. {fmtDate(c.observedAt)}</span>
      </div>
      <table className="mt-2 w-full text-[11px] fsw-mono" data-testid={`table-condition-compare-${c.id}`}>
        <thead><tr className="text-[hsl(var(--fsw-dim))]"><th className="text-left font-normal">vs</th><th className="text-left font-normal">baseline date</th><th className="text-right font-normal">then</th><th className="text-right font-normal">Δ {ind?.unit.includes("%") ? "pp" : "points"}</th></tr></thead>
        <tbody>{c.comparisons.map((k) => (
          <tr key={k.period} className="border-t border-[hsl(var(--fsw-line))]">
            <td className="py-0.5">{k.period}</td><td>{k.baselineDate ? fmtDate(k.baselineDate) : "unavailable"}</td>
            <td className="text-right">{k.baseline == null ? "—" : fmtNum(k.baseline)}</td>
            <td className="text-right" style={{ color: moveColor(k.change) }}>{signed(k.change)}</td>
          </tr>))}</tbody>
      </table>
      <p className="mt-2 text-xs text-[hsl(var(--fsw-ink)/0.85)] leading-relaxed">{c.detail}</p>
      <p className="mt-1 text-xs text-[hsl(var(--fsw-dim))]"><span className="text-[hsl(var(--fsw-sand))]">Why it matters: </span>{c.whyItMatters}</p>
    </article>
  );
}

export function Conditions({ e }: { e: EconomyOverview }) {
  return (
    <Pane title="Conditions now vs 1, 3 and 6 months ago" sub="Each compares the latest source observation with the nearest observed value on the stated baseline date." testId="section-conditions">
      {e.conditions.length === 0 ? <p className="p-6 text-sm text-center text-[hsl(var(--fsw-dim))]">No conditions available from sources.</p> :
        <div className="p-3 grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">{e.conditions.map((c) => <Condition key={c.id} c={c} ind={byId(e, c.indicatorId)} />)}</div>}
    </Pane>
  );
}

function QuoteRow({ x }: { x: MarketQuote }) {
  const col = x.category === "Energy" ? PAL.orange : x.category === "Forward contracts" ? PAL.yellow : x.category === "Currencies" ? PAL.cyan : x.category === "Safe assets" ? PAL.pink : PAL.green;
  const d = x.value != null && Math.abs(x.value) < 10 ? 4 : 2;
  return (
    <li className="fsw-row px-3 py-2 border-t border-[hsl(var(--fsw-line))]" data-testid={`row-quote-${x.id}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_88px_auto] items-center gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium truncate">{x.name}{x.status !== "available" && <span className="ml-1.5 fsw-label px-1 border rounded-sm" style={{ color: statusColor(x.status), borderColor: statusColor(x.status) }} data-testid={`status-quote-${x.id}`}>{x.status}</span>}</div>
          <div className="fsw-mono text-[10.5px] text-[hsl(var(--fsw-dim))] truncate">{x.symbol} · {x.contractLabel}{x.contractMonth ? ` · ${x.contractMonth}` : ""} · {x.asOf ? fmtDateTime(x.asOf) : "no obs."}</div>
        </div>
        <div className="hidden sm:block"><Spark points={x.points} color={col} testId={`spark-quote-${x.id}`} /></div>
        <div className="text-right fsw-mono">
          <div className="text-sm" data-testid={`text-quote-value-${x.id}`}>{x.value == null ? "—" : fmtNum(x.value, d)} <span className="text-[10px] text-[hsl(var(--fsw-dim))]" data-testid={`text-quote-unit-${x.id}`}>{x.unit}</span></div>
          <div className="text-[10.5px]" style={{ color: moveColor(x.change) }} data-testid={`text-quote-change-${x.id}`}>{signed(x.change, d)} ({signed(x.changePercent, 2, "%")})</div>
        </div>
      </div>
      <details className="mt-1 group">
        <summary className="cursor-pointer text-[10.5px] text-[hsl(var(--fsw-dim))] hover:text-[hsl(var(--fsw-brass))] list-none" data-testid={`button-quote-explain-${x.id}`}>What is this?</summary>
        <p className="mt-1 text-xs leading-relaxed">{x.explanation}</p>
        {x.message && <p className="text-[11px] text-[hsl(var(--fsw-dim))]">{x.message}</p>}
        <a href={x.sourceUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 text-[11px] text-[hsl(var(--fsw-brass))] hover:underline" data-testid={`link-quote-source-${x.id}`}>{x.source}<ExternalLink className="h-3 w-3" /></a>
      </details>
    </li>
  );
}

export function Markets({ e }: { e: EconomyOverview }) {
  const cats = ["Energy", "Equities", "Currencies", "Safe assets", "Forward contracts"] as const;
  return (
    <Pane title="Market prices & exchange rates" sub="Indicative, delayed Yahoo Finance observations; collected every 15 minutes. Change is vs the previous completed daily bar. Not executable prices." testId="section-markets">
      {e.markets.quotes.length === 0 ? <p className="p-6 text-sm text-center text-[hsl(var(--fsw-dim))]">No market quotes available.</p> :
        cats.map((c) => {
          const list = e.markets.quotes.filter((x) => x.category === c && !x.id.startsWith("fedfunds"));
          if (!list.length) return null;
          return <div key={c}><p className="fsw-label px-3 pt-2.5 pb-1">{c}</p><ul>{list.map((x) => <QuoteRow key={x.id} x={x} />)}</ul></div>;
        })}
      <p className="px-3 py-2 text-[10.5px] text-[hsl(var(--fsw-dim))] border-t border-[hsl(var(--fsw-line))]">Updated {fmtDateTime(e.markets.updatedAt)}. Front-month futures history can jump at contract rolls. Fed funds futures appear as implied rates in the rates section.</p>
    </Pane>
  );
}

export function Oil({ e }: { e: EconomyOverview }) {
  const near = q(e, e.oilCurve.nearQuoteId), far = q(e, e.oilCurve.farQuoteId), wti = q(e, "wti"), brent = q(e, "brent");
  const c = e.oilCurve;
  return (
    <Pane title="Oil · price and the futures curve" sub="Higher oil prices strain fuel budgets and import bills; lower prices can pressure producer revenues. Neither direction is universally good or bad." testId="section-oil">
      <div className="p-3 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <p className="text-xs text-[hsl(var(--fsw-dim))] mb-1">Official spot prices (US EIA via FRED, published with a lag), USD per barrel</p>
          <TimeChart label="WTI and Brent spot price history, USD per barrel" testId="chart-oil-spot" series={[...ser(byId(e, "DCOILWTICO"), "WTI spot", PAL.orange), ...ser(byId(e, "DCOILBRENTEU"), "Brent spot", PAL.cyan)]} />
          <p className="text-xs text-[hsl(var(--fsw-dim))] mt-3 mb-1">Front-month futures (indicative, delayed), USD per barrel</p>
          <TimeChart height={150} label="WTI and Brent futures history" testId="chart-oil-futures" series={[wti, brent].filter((x): x is MarketQuote => !!x).map((x, i) => ({ key: x.id, name: `${x.name} (${x.symbol})`, color: i ? PAL.cyan : PAL.orange, unit: x.unit, points: x.points }))} />
        </div>
        <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-2" data-testid="group-oil-prices">
            {[wti, brent].map((x, i) => x ? (
              <div key={x.id} className="fsw-panel p-2.5 bg-[hsl(var(--fsw-panel-2)/0.5)]" data-testid={`card-oil-price-${x.id}`}>
                <div className="text-xs font-medium">{x.name}{x.status !== "available" && <span className="ml-1 fsw-label" style={{ color: statusColor(x.status) }}>{x.status}</span>}</div>
                <div className="fsw-mono text-xl" data-testid={`text-oil-price-${x.id}`}>{x.value == null ? "—" : fmtNum(x.value)} <span className="text-[10px] text-[hsl(var(--fsw-dim))]">{x.unit}</span></div>
                <div className="fsw-mono text-[11px]" style={{ color: moveColor(x.change) }} data-testid={`text-oil-change-${x.id}`}>{signed(x.change)} ({signed(x.changePercent, 2, "%")})</div>
                <div className="fsw-mono text-[10px] text-[hsl(var(--fsw-dim))]">{x.contractLabel}{x.contractMonth ? ` ${x.contractMonth}` : ""} · {fmtDateTime(x.asOf)}</div>
              </div>) : <div key={i} className="fsw-panel p-2.5 text-xs text-[hsl(var(--fsw-dim))]">{i ? "Brent" : "WTI"} quote unavailable</div>)}
            <p className="col-span-2 text-[10.5px] text-[hsl(var(--fsw-dim))]">Delayed indicative futures; change vs previous daily bar.</p>
          </div>
          <div className="fsw-panel p-3 bg-[hsl(var(--fsw-panel-2)/0.5)]" data-testid="card-oil-curve">
            <p className="fsw-label">Curve shape</p>
            <p className="text-2xl font-semibold mt-1" style={{ color: c.shape === "Backwardation" ? "hsl(var(--fsw-brass))" : c.shape === "Unavailable" ? "hsl(var(--fsw-dim))" : "hsl(var(--fsw-cyan))" }} data-testid="text-oil-curve-shape">{c.shape}</p>
            <p className="fsw-mono text-xs mt-1" data-testid="text-oil-curve-spread">Far minus near: {signed(c.spread)} USD/bbl ({signed(c.spreadPercent, 2, "%")})</p>
            <div className="mt-2 grid grid-cols-2 gap-2 fsw-mono text-xs">
              {[near, far].map((x, i) => <div key={i} className="border border-[hsl(var(--fsw-line))] rounded-sm p-2"><div className="text-[hsl(var(--fsw-dim))] text-[10px]">{x?.contractLabel ?? (i ? "Far" : "Near")}{x?.contractMonth ? ` · ${x.contractMonth}` : ""}</div><div className="text-sm">{x?.value != null ? fmtNum(x.value) : "—"}</div></div>)}
            </div>
            <p className="mt-2 text-xs leading-relaxed">{c.interpretation}</p>
            <p className="mt-1 text-[10.5px] text-[hsl(var(--fsw-dim))]">As of {fmtDateTime(c.asOf)}. Describes today's price structure; it is not a price prediction.</p>
          </div>
        </div>
      </div>
    </Pane>
  );
}

export function Rates({ e }: { e: EconomyOverview }) {
  const effective = byId(e, "DFF");
  return (
    <Pane title="Interest rates and market-implied policy path" testId="section-rates">
      <div className="p-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6 border-b border-[hsl(var(--fsw-line))]" data-testid="group-benchmark-rates">
        {([["DFF", "Fed funds (effective)"], ["SOFR", "SOFR overnight"], ["DGS2", "2-year Treasury"], ["DGS10", "10-year Treasury"], ["T10Y2Y", "10y minus 2y curve"], ["T10YIE", "10y breakeven inflation"]] as const).map(([id, label]) => {
          const i = byId(e, id);
          const bp = i?.change == null ? null : i.change * 100;
          return (
            <div key={id} className="fsw-panel min-w-0 p-2.5 bg-[hsl(var(--fsw-panel-2)/0.5)]" data-testid={`card-benchmark-${id}`}>
              <div className="flex justify-between gap-1"><span className="text-xs font-medium truncate">{label}</span><span className="fsw-label shrink-0" style={{ color: statusColor(i?.status ?? "unavailable") }}>{i?.status ?? "missing"}</span></div>
              <div className="fsw-mono text-xl" data-testid={`text-benchmark-value-${id}`}>{i?.latest ? `${fmtNum(i.latest.value)}${id === "T10Y2Y" ? " pp" : "%"}` : "—"}</div>
              <div className="fsw-mono text-[11px]" style={{ color: moveColor(bp) }} data-testid={`text-benchmark-change-${id}`}>{signed(bp, 0)} bp vs prior obs.</div>
              <div className="fsw-mono text-[10px] text-[hsl(var(--fsw-dim))]">obs. {i?.latest ? fmtDate(i.latest.date) : "—"}{i?.previous ? ` · prior ${fmtDate(i.previous.date)}` : ""}</div>
              {i && <a href={i.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[10.5px] text-[hsl(var(--fsw-dim))] hover:text-[hsl(var(--fsw-brass))]" data-testid={`link-benchmark-source-${id}`}>{i.source}<ExternalLink className="h-3 w-3" /></a>}
            </div>
          );
        })}
      </div>
      <div className="p-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="text-xs text-[hsl(var(--fsw-dim))] mb-1">Overnight policy-linked rates, % (steps)</p>
          <TimeChart label="Federal funds and SOFR history, percent" testId="chart-policy-rates" series={[...ser(byId(e, "DFF"), "Effective fed funds", PAL.yellow, true), ...ser(byId(e, "SOFR"), "SOFR", PAL.pink, true)]} />
          <p className="text-xs text-[hsl(var(--fsw-dim))] mt-3 mb-1">Treasury yields, %</p>
          <TimeChart height={170} label="2-year and 10-year Treasury yields, percent" testId="chart-yields" series={[...ser(byId(e, "DGS2"), "2-year", PAL.cyan), ...ser(byId(e, "DGS10"), "10-year", PAL.orange)]} />
        </div>
        <div className="min-w-0">
          <p className="fsw-label mb-2">What futures price for the fed funds rate</p>
          {e.rateExpectations.length === 0 ? <p className="text-sm text-[hsl(var(--fsw-dim))]">No fed funds futures observations available.</p> : (
            <div className="space-y-2">{e.rateExpectations.map((r) => (
              <div key={r.quoteId} className="fsw-panel p-3 bg-[hsl(var(--fsw-panel-2)/0.5)] flex flex-wrap items-baseline justify-between gap-2" data-testid={`card-rate-${r.quoteId}`}>
                <div><div className="text-sm font-medium">{r.contractMonth} average</div><div className="fsw-mono text-[10.5px] text-[hsl(var(--fsw-dim))]">obs. {fmtDateTime(r.asOf)} · <span style={{ color: statusColor(r.status) }}>{r.status}</span></div></div>
                <div className="text-right fsw-mono">
                  <div className="text-xl" data-testid={`text-rate-implied-${r.quoteId}`}>{r.impliedRate == null ? "—" : `${fmtNum(r.impliedRate)}%`}</div>
                  <div className="text-[11px]" style={{ color: moveColor(r.changeBasisPoints) }} data-testid={`text-rate-change-${r.quoteId}`}>{signed(r.changeBasisPoints, 1)} bp vs prior daily close</div>
                  {r.impliedRate !== null && effective?.latest && <div className="mt-1 text-[10.5px] max-w-[250px] text-[hsl(var(--fsw-dim))]">
                    {fmtNum(Math.abs(r.impliedRate - effective.latest.value) * 100, 1)} bp {r.impliedRate >= effective.latest.value ? "above" : "below"} the latest released effective rate ({fmtNum(effective.latest.value)}%, {fmtDate(effective.latest.date)}).
                  </div>}
                </div>
              </div>))}</div>
          )}
          <p className="mt-2 text-[11px] text-[hsl(var(--fsw-dim))] leading-relaxed">Implied rate = 100 minus futures price: the market's priced average effective rate for that month. It is not a probability of a Fed decision and includes risk premia.</p>
        </div>
      </div>
    </Pane>
  );
}
