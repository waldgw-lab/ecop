import type { ReactNode } from "react";
import type { FinanceStory } from "@shared/finance";
import type { EconomyOverview, MarketQuote } from "@shared/economy";
import type { FinancialSocialFeed } from "@shared/financeSocial";
import type { FinanceIndicator } from "@shared/finance";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { KIND_LABEL, errorText, fmtDate, fmtDateTime, fmtNum, impactTone, relTime } from "./utils";
import { PAL, TimeChart, moveColor, signed, statusColor } from "./economy/charts";

export function Lane({ title, sub, right, footer, children, testId }: { title: string; sub?: string; right?: ReactNode; footer?: ReactNode; children: ReactNode; testId: string }) {
  return (
    <section className="fsw-panel fsw-lane flex flex-col min-w-0 overflow-hidden" data-testid={testId}>
      <header className="shrink-0 px-3 py-2 border-b border-[hsl(var(--fsw-line))] bg-[hsl(var(--fsw-panel-2)/0.6)]">
        <div className="flex items-center justify-between gap-2"><h2 className="fsw-label text-[hsl(var(--fsw-brass))]">{title}</h2>{right}</div>
        {sub && <p className="text-[11px] text-[hsl(var(--fsw-dim))] mt-0.5 leading-snug">{sub}</p>}
      </header>
      <div className="fsw-lane-body flex-1 min-h-0 overflow-y-auto fsw-scroll">{children}</div>
      {footer && <footer className="shrink-0 px-3 py-2 border-t border-[hsl(var(--fsw-line))] text-[10.5px] leading-snug text-[hsl(var(--fsw-dim))]">{footer}</footer>}
    </section>
  );
}

const LaneSkel = () => <div className="p-3 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 bg-[hsl(var(--fsw-panel-2))]" />)}</div>;
const Note = ({ children }: { children: ReactNode }) => <div className="px-4 py-10 text-center text-sm text-[hsl(var(--fsw-dim))]" data-testid="text-lane-empty">{children}</div>;
const ErrBox = ({ text, onRetry, id }: { text: string; onRetry: () => void; id: string }) => (
  <div className="m-3 p-3 border border-[hsl(var(--fsw-bad)/0.5)] rounded-sm text-xs flex flex-wrap items-center gap-2" data-testid={`error-${id}`}>
    <AlertTriangle className="h-4 w-4 text-[hsl(var(--fsw-bad))]" /><span className="flex-1">{text}</span>
    <button onClick={onRetry} className="fsw-chip" data-testid={`button-retry-${id}`}>Retry</button>
  </div>
);

function NewsItem({ s, rank, active, onSelect, lead }: { s: FinanceStory; rank: number; active: boolean; onSelect: () => void; lead?: boolean }) {
  return (
    <li>
      <button onClick={onSelect} data-active={active} className="fsw-row w-full text-left px-3 py-2.5 border-b border-[hsl(var(--fsw-line))]" data-testid={`row-lane-story-${s.id}`}>
        <span className="flex items-center gap-2 text-[10.5px] fsw-mono text-[hsl(var(--fsw-dim))]">
          <span>{String(rank).padStart(2, "0")}</span>
          <span className={`fsw-k-${s.kind} uppercase tracking-wider`}>{KIND_LABEL[s.kind]}</span>
          <span className="truncate">{s.topic}</span>
          <span className="ml-auto" style={{ color: impactTone(s.impact) }} title="Rule-based evidence score out of 100">{s.impact}</span>
        </span>
        <span className={`block mt-1 font-semibold leading-snug ${lead ? "text-[16px]" : "text-[14px]"}`}>{s.title}</span>
        {lead && s.summary && <span className="block mt-1 text-[12.5px] leading-snug text-[hsl(var(--fsw-ink)/0.8)] line-clamp-3">{s.summary}</span>}
        <span className="mt-1 flex flex-wrap gap-x-1.5 text-[11px] text-[hsl(var(--fsw-dim))]">
          <span>{s.source}</span><span>·</span><span>{s.region}</span>
          {s.sourceCount > 1 && <><span>·</span><span className="text-[hsl(var(--fsw-ink))]">{s.sourceCount} sources</span></>}
          <span>·</span><span className="fsw-mono">{relTime(s.publishedAt)}</span>
        </span>
      </button>
    </li>
  );
}

export function NewsLane({ title, sub, stories, loading, activeId, onSelect, testId, onAll }: { title: string; sub: string; stories: FinanceStory[]; loading: boolean; activeId: string | null; onSelect: (id: string) => void; testId: string; onAll: () => void }) {
  return (
    <Lane title={title} sub={sub} testId={testId} right={<span className="fsw-mono text-[10.5px] text-[hsl(var(--fsw-dim))]">{stories.length}</span>}
      footer={<>Score is a rule-based evidence rating /100. <button onClick={onAll} className="text-[hsl(var(--fsw-brass))] hover:underline" data-testid={`link-${testId}-all`}>All news and filters</button></>}>
      {loading ? <LaneSkel /> : stories.length === 0 ? <Note>No qualifying stories in the current cycle.</Note> :
        <ol>{stories.map((s, i) => <NewsItem key={s.id} s={s} rank={i + 1} lead={i === 0} active={activeId === s.id} onSelect={() => onSelect(s.id)} />)}</ol>}
    </Lane>
  );
}

function Block({ title, status, children, testId, src }: { title: string; status?: string; children: ReactNode; testId: string; src?: { name: string; url: string } }) {
  return (
    <article className="px-3 py-3 border-b border-[hsl(var(--fsw-line))]" data-testid={testId}>
      <div className="flex items-start justify-between gap-2"><h3 className="text-[13.5px] font-semibold leading-tight">{title}</h3>{status && <span className="fsw-label shrink-0" style={{ color: statusColor(status) }}>{status}</span>}</div>
      {children}
      {src && <a href={src.url} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-[hsl(var(--fsw-dim))] hover:text-[hsl(var(--fsw-brass))]" data-testid={`link-${testId}-source`}>{src.name}<ExternalLink className="h-3 w-3" /></a>}
    </article>
  );
}

function QuoteBlock({ x, color, why, id, name }: { x: MarketQuote | undefined; color: string; why: string; id: string; name: string }) {
  if (!x) return <Block title={name} status="unavailable" testId={`lane-quote-${id}`}><p className="mt-1 text-xs text-[hsl(var(--fsw-dim))]">Quote not returned by the market feed this cycle.</p></Block>;
  const d = x.value != null && Math.abs(x.value) < 10 ? 3 : 2;
  return (
    <Block title={x.name} status={x.status} testId={`lane-quote-${x.id}`} src={{ name: x.source, url: x.sourceUrl }}>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 fsw-mono">
        <span className="text-lg" data-testid={`text-lane-value-${x.id}`}>{x.value == null ? "—" : fmtNum(x.value, d)}</span>
        <span className="text-[10.5px] text-[hsl(var(--fsw-dim))]">{x.unit}</span>
        <span className="text-[11.5px]" style={{ color: moveColor(x.change) }} data-testid={`text-lane-change-${x.id}`}>{signed(x.change, d)} ({signed(x.changePercent, 2, "%")})</span>
      </div>
      <p className="fsw-mono text-[10px] text-[hsl(var(--fsw-dim))]">{x.symbol} · {x.contractLabel}{x.contractMonth ? ` ${x.contractMonth}` : ""} · {x.asOf ? fmtDateTime(x.asOf) : "no obs."}{x.previousCloseDate ? ` · vs ${fmtDate(x.previousCloseDate)} close` : ""}</p>
      <div className="mt-2"><TimeChart height={118} label={`${x.name} history, ${x.unit}`} testId={`chart-lane-${x.id}`} series={[{ key: x.id, name: x.name, color, unit: x.unit, points: x.points }]} /></div>
      <p className="mt-1.5 text-[11.5px] leading-snug text-[hsl(var(--fsw-ink)/0.85)]">{why}</p>
      {x.message && x.status !== "available" && <p className="text-[10.5px] text-[hsl(var(--fsw-dim))]">{x.message}</p>}
    </Block>
  );
}

function IndBlock({ i, color, why, id }: { i: FinanceIndicator | undefined; color: string; why: string; id: string }) {
  if (!i) return <Block title={id} status="unavailable" testId={`lane-ind-${id}`}><p className="mt-1 text-xs text-[hsl(var(--fsw-dim))]">Series not returned this cycle.</p></Block>;
  return (
    <Block title={i.name} status={i.status} testId={`lane-ind-${i.id}`} src={{ name: i.source, url: i.sourceUrl }}>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 fsw-mono">
        <span className="text-lg" data-testid={`text-lane-latest-${i.id}`}>{i.latest ? fmtNum(i.latest.value) : "—"}</span>
        <span className="text-[10.5px] text-[hsl(var(--fsw-dim))]">{i.unit}</span>
        <span className="text-[11.5px]" style={{ color: moveColor(i.change) }}>{signed(i.change)} vs prior obs.</span>
      </div>
      <p className="fsw-mono text-[10px] text-[hsl(var(--fsw-dim))]">obs. {i.latest ? fmtDate(i.latest.date) : "—"}{i.previous ? ` · prior ${fmtDate(i.previous.date)}` : ""} · {i.frequency}</p>
      <div className="mt-2"><TimeChart height={118} label={`${i.name} history, ${i.unit}`} testId={`chart-lane-${i.id}`} series={[{ key: i.id, name: i.name, color, unit: i.unit, points: i.points }]} /></div>
      <p className="mt-1.5 text-[11.5px] leading-snug text-[hsl(var(--fsw-ink)/0.85)]">{why}</p>
    </Block>
  );
}

type Gate = { e: EconomyOverview | undefined; error: unknown; isError: boolean; retry: () => void };
function gate(g: Gate, id: string, render: (e: EconomyOverview) => ReactNode) {
  if (!g.e) return g.isError ? <ErrBox id={id} text={`Market and indicator service unavailable (${errorText(g.error)}).`} onRetry={g.retry} /> : <LaneSkel />;
  return <>{g.isError && <p className="px-3 pt-2 text-[10.5px] text-[hsl(var(--fsw-bad))]">Update failed; showing last loaded data.</p>}{render(g.e)}</>;
}
const qt = (e: EconomyOverview, id: string) => e.markets.quotes.find((x) => x.id === id);
const ind = (e: EconomyOverview, id: string) => e.indicators.find((x) => x.id === id);

export function MetricsLane(g: Gate & { days: number }) {
  return (
    <Lane title="Key financial metrics" sub={`History window ${g.days}d. Gaps left as gaps.`} testId="lane-metrics"
      footer="Equity quotes are delayed indicative observations; official series publish with a lag. Values are not executable prices.">
      {gate(g, "metrics", (e) => <>
        <QuoteBlock x={qt(e, "sp500")} id="sp500" name="S&P 500 index" color={PAL.green} why="Broad gauge of US large-company share prices. Sharp falls tighten financing and can signal investor flight from risk." />
        <IndBlock i={ind(e, "VIXCLS")} id="VIXCLS" color={PAL.orange} why="Expected 30-day S&P 500 volatility implied by options. Readings above roughly 30 have accompanied periods of market stress." />
        <IndBlock i={ind(e, "OFR_FSI")} id="OFR_FSI" color={PAL.pink} why="Composite of 33 market measures. Above zero means stress is higher than its long-run average." />
        <IndBlock i={ind(e, "DGS10")} id="DGS10" color={PAL.cyan} why="Benchmark US borrowing cost. Rising yields raise mortgage, corporate and federal debt-service costs." />
        <IndBlock i={ind(e, "T10Y2Y")} id="T10Y2Y" color={PAL.yellow} why="Gap between long and short Treasury yields. A negative gap (inversion) has preceded past US recessions." />
        <Block title="CNN Fear & Greed Index" status="unavailable" testId="lane-fear-greed">
          <p className="mt-1 text-[11.5px] leading-snug">{e.fearAndGreed.message}</p>
          <p className="mt-1 text-[10.5px] text-[hsl(var(--fsw-dim))]">Not graphed: no supported data feed. VIX above is a separate measure, not a substitute.</p>
          <a href={e.fearAndGreed.sourceUrl} target="_blank" rel="noreferrer noopener" className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-[hsl(var(--fsw-brass))] hover:underline" data-testid="link-lane-fear-greed">View at CNN<ExternalLink className="h-3 w-3" /></a>
        </Block>
      </>)}
    </Lane>
  );
}

const COMMS: [string, string, string, string][] = [
  ["wti", "WTI crude", PAL.orange, "US crude benchmark. Drives fuel costs for transport, logistics and military operations."],
  ["brent", "Brent crude", PAL.cyan, "International crude benchmark; most sensitive to Middle East and shipping disruption."],
  ["natural-gas", "Natural gas", PAL.blue, "Henry Hub gas. Feeds power generation, heating and fertiliser costs."],
  ["gold", "Gold", PAL.yellow, "Traditional safe-haven asset. Gains often reflect geopolitical or currency anxiety."],
  ["copper", "Copper", PAL.pink, "Industrial metal tied to construction and manufacturing; a read on global demand."],
  ["wheat", "Wheat", PAL.green, "Staple grain. Price spikes strain food-importing states and can fuel unrest."],
];
export function CommoditiesLane(g: Gate) {
  return (
    <Lane title="Commodities · daily change" sub="Delayed front-month futures; change vs prior daily close." testId="lane-commodities"
      footer="Rolling front-month contracts: history can jump at contract rolls. Units differ by market and are never normalised.">
      {gate(g, "commodities", (e) => COMMS.map(([id, name, c, why]) => <QuoteBlock key={id} x={qt(e, id)} id={id} name={name} color={c} why={why} />))}
    </Lane>
  );
}

const safeUrl = (u: string) => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; } };

export function SocialLane({ feed, loading, error, isError, retry }: { feed: FinancialSocialFeed | undefined; loading: boolean; error: unknown; isError: boolean; retry: () => void }) {
  const down = feed?.sources.filter((s) => s.status !== "healthy") ?? [];
  return (
    <Lane title="Financial social media" sub="Publisher posts screened for financial and security relevance." testId="lane-social"
      right={feed?.refreshing ? <span className="fsw-label fsw-pulse text-[hsl(var(--fsw-brass))]">refreshing</span> : feed?.updatedAt ? <span className="fsw-mono text-[10px] text-[hsl(var(--fsw-dim))]">{relTime(feed.updatedAt)}</span> : null}
      footer={<details data-testid="details-social-status"><summary className="cursor-pointer hover:text-[hsl(var(--fsw-brass))]">Sources: {feed ? `${feed.sources.length - down.length}/${feed.sources.length} healthy` : "unknown"} · Meltwater {feed?.meltwater.status ?? "unknown"}</summary>
        <ul className="mt-1 space-y-0.5">{feed?.sources.map((s) => <li key={s.name}><span style={{ color: s.status === "healthy" ? "hsl(var(--fsw-ok))" : "hsl(var(--fsw-bad))" }}>{s.status}</span> · {s.name}{s.message ? ` — ${s.message}` : ""}</li>)}</ul>
        <p className="mt-1">Meltwater: {feed?.meltwater.configured ? "a key is present; a dedicated financial-social search has not been configured." : "not configured."} No Meltwater posts appear here.{feed?.meltwater.message ? ` ${feed.meltwater.message}` : ""}</p>
      </details>}>
      {isError && !feed ? <ErrBox id="social" text={`Social feed unavailable (${errorText(error)}).`} onRetry={retry} /> : loading || !feed ? <LaneSkel /> : <>
        {isError && <p className="px-3 pt-2 text-[10.5px] text-[hsl(var(--fsw-bad))]">Update failed; showing last loaded posts.</p>}
        {feed.posts.length === 0 ? <Note>No qualifying posts from monitored publisher accounts in this cycle.{down.length ? ` ${down.length} source${down.length > 1 ? "s" : ""} not responding.` : ""}</Note> :
          <ol>{feed.posts.map((p) => {
            const url = safeUrl(p.url);
            return (
              <li key={p.id} className="fsw-row px-3 py-2.5 border-b border-[hsl(var(--fsw-line))]" data-testid={`card-social-${p.id}`}>
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <span className="text-[13px] font-semibold truncate">{p.author}</span>
                  {p.handle && <span className="fsw-mono text-[10.5px] text-[hsl(var(--fsw-dim))] truncate">@{p.handle.replace(/^@/, "")}</span>}
                  <span className="ml-auto fsw-mono text-[10.5px] shrink-0" style={{ color: impactTone(p.impact) }}>{p.impact}</span>
                </div>
                <p className="mt-1 text-[13px] leading-snug whitespace-pre-line line-clamp-6" data-testid={`text-social-${p.id}`}>{p.text}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-[hsl(var(--fsw-dim))]">
                  <span className="fsw-k-social">{p.platform}</span><span>·</span>
                  <span className="fsw-mono" title={fmtDateTime(p.publishedAt)}>{fmtDateTime(p.publishedAt)}</span><span>·</span>
                  <span>{p.topic}</span><span>·</span>
                  <span style={{ color: p.verification === "Publisher account" ? "hsl(var(--fsw-ok))" : "hsl(var(--fsw-coral))" }}>{p.verification}</span>
                  <span>· via {p.via}</span>
                  {url ? <a href={url} target="_blank" rel="noreferrer noopener" className="ml-auto inline-flex items-center gap-1 text-[hsl(var(--fsw-brass))] hover:underline" data-testid={`link-social-${p.id}`}>Original post<ExternalLink className="h-3 w-3" /></a> : <span className="ml-auto">link unavailable</span>}
                </div>
              </li>
            );
          })}</ol>}
      </>}
    </Lane>
  );
}
