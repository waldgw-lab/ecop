import type { EconomyOverview, MarketQuote } from "@shared/economy";
import type { FinanceIndicator } from "@shared/finance";
import { ExternalLink } from "lucide-react";
import { PAL, TimeChart, moveColor, signed, statusColor } from "./economy/charts";
import { fmtDate, fmtDateTime, fmtNum } from "./utils";

type Card = {
  n: string; theme: string; title: string; caption: string; color: string;
  ind?: FinanceIndicator; quote?: MarketQuote;
};

function BlufCard({ c, height }: { c: Card; height: number }) {
  const src = c.ind ?? c.quote;
  const id = c.ind?.id ?? c.quote?.id ?? c.n;
  const value = c.ind ? c.ind.latest?.value ?? null : c.quote?.value ?? null;
  const change = c.ind ? c.ind.change : c.quote?.change ?? null;
  const unit = src?.unit ?? "";
  const obs = c.ind ? (c.ind.latest ? `obs. ${fmtDate(c.ind.latest.date)}` : "no obs.") : (c.quote?.asOf ? `as of ${fmtDateTime(c.quote.asOf)}` : "no obs.");
  const status = src?.status ?? "unavailable";
  return (
    <article className="fsw-panel fsw-bluf-card min-w-0 p-3 flex flex-col" data-testid={`card-bluf-chart-${c.n}`}>
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="fsw-label"><span className="text-[hsl(var(--fsw-brass))]">BLUF {c.n}</span> · {c.theme}</p>
          <h3 className="text-[15px] font-semibold leading-tight mt-0.5 truncate" title={c.title}>{c.title}</h3>
        </div>
        <span className="fsw-label shrink-0" style={{ color: statusColor(status) }} data-testid={`status-bluf-${c.n}`}>{src ? status : "missing"}</span>
      </header>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 fsw-mono">
        <span className="text-2xl leading-none" data-testid={`text-bluf-value-${c.n}`}>{value == null ? "—" : fmtNum(value)}</span>
        <span className="text-[11px] text-[hsl(var(--fsw-dim))]">{unit}</span>
        <span className="text-[11px]" style={{ color: moveColor(change) }}>{signed(change)} vs prior</span>
        <span className="text-[10.5px] text-[hsl(var(--fsw-dim))] ml-auto">{obs}</span>
      </div>
      <div className="mt-2 flex-1 min-h-0">
        {src ? <TimeChart height={height} label={`${c.title} history, ${unit}`} testId={`chart-bluf-${id}`} series={[{ key: id, name: c.title, color: c.color, unit, points: src.points }]} />
          : <div style={{ height }} className="grid place-items-center text-xs text-[hsl(var(--fsw-dim))] border border-dashed border-[hsl(var(--fsw-line))] rounded-sm">Series not returned by source.</div>}
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-[hsl(var(--fsw-dim))]">{c.caption}</p>
      {src && <a href={src.sourceUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 self-start text-[10.5px] text-[hsl(var(--fsw-dim))] hover:text-[hsl(var(--fsw-brass))]" data-testid={`link-bluf-source-${c.n}`}>{src.source}<ExternalLink className="h-3 w-3" /></a>}
    </article>
  );
}

export function BlufCharts({ e, height = 150 }: { e: EconomyOverview; height?: number }) {
  const ind = (id: string) => e.indicators.find((i) => i.id === id);
  const brent = e.markets.quotes.find((x) => x.id === "brent");
  const cards: Card[] = [
    { n: "01", theme: "Financial stress", title: "OFR Financial Stress Index", color: PAL.red, ind: ind("OFR_FSI"), caption: "Above zero = stress above average. Global measure from the Office of Financial Research." },
    { n: "02", theme: "Inflation", title: "CPI inflation, year over year", color: PAL.orange, ind: ind("CPI_YOY"), caption: "US consumer prices vs a year earlier. Monthly; published with a lag." },
    { n: "03", theme: "Jobs", title: "US unemployment rate", color: PAL.cyan, ind: ind("UNRATE"), caption: "Share of the US labour force without work. Monthly release." },
    { n: "04", theme: "Oil", title: brent ? `Brent near contract (${brent.symbol}${brent.contractMonth ? ` · ${brent.contractMonth}` : ""})` : "Brent near contract", color: PAL.yellow, quote: brent, caption: "Front-month futures price history: indicative, delayed, not the official spot price. Can jump at contract rolls." },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2" data-testid="group-bluf-charts">
      {cards.map((c) => <BlufCard key={c.n} c={c} height={height} />)}
    </div>
  );
}
