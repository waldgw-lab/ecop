import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { FinanceDashboard, FinanceStory } from "@shared/finance";
import type { EconomyOverview } from "@shared/economy";
import { Briefing, Conditions, Markets, Oil, Rates } from "@/components/finance/economy/Panels";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, BarChart3, ChevronRight, Database, ExternalLink, Gauge, LayoutGrid, LogOut, MessageSquare, Newspaper, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { BlufCharts } from "@/components/finance/BlufCharts";
import { ChatAssistant, type ChatState } from "@/components/finance/ChatAssistant";
import { StoryDetail } from "@/components/finance/StoryDetail";
import { IndicatorChart } from "@/components/finance/IndicatorChart";
import { Methodology, SocialRoster, SourceHealthTable } from "@/components/finance/ReferencePanels";
import { KIND_LABEL, errorText, fmtDateTime, impactTone, isAuthError, relTime } from "@/components/finance/utils";
import "@/components/finance/finance.css";

const DASH_KEY = ["/api/finance/dashboard"];
const RANGES = [7, 30, 90, 180, 365] as const;
const ECON = "/api/finance/economy";
const STRESS = ["OFR_FSI", "VIXCLS", "NFCI", "STLFSI4", "T10Y2Y", "T10YIE", "CPI_YOY", "UNRATE", "INDPRO_YOY", "DTWEXBGS"];
const LINE_COLORS = ["#61A9BD", "#E98E2E", "#CED14E", "#DD83C9", "#44986D", "#9267C6", "#D8524F", "#8CCEDE"];

function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

async function logout() {
  try { await apiRequest("POST", "/api/auth/logout"); } catch { /* reload regardless */ }
  window.location.reload();
}

function AccessExpired() {
  return (
    <div className="fsw grid place-items-center p-6">
      <div className="fsw-panel max-w-md p-6 text-center" data-testid="panel-access-expired">
        <ShieldAlert className="mx-auto h-8 w-8 text-[hsl(var(--fsw-brass))]" />
        <h1 className="mt-3 text-lg font-semibold">Access expired</h1>
        <p className="mt-1 text-sm text-[hsl(var(--fsw-dim))]">Your session is no longer authorised to view this picture. Sign in again to continue.</p>
        <button onClick={() => window.location.reload()} className="mt-4 px-4 py-2 bg-[hsl(var(--fsw-brass))] text-[hsl(198_30%_8%)] text-sm font-semibold rounded-sm" data-testid="button-reauth">Reload and sign in</button>
      </div>
    </div>
  );
}

function StoryRow({ s, rank, active, onSelect }: { s: FinanceStory; rank: number; active: boolean; onSelect: () => void }) {
  return (
    <li>
      <button onClick={onSelect} data-active={active} className="fsw-row w-full text-left grid grid-cols-[2.25rem_1fr_auto] gap-3 px-3 py-2.5 border-t border-[hsl(var(--fsw-line))]" data-testid={`row-story-${s.id}`}>
        <span className="fsw-mono text-xs text-[hsl(var(--fsw-dim))] pt-0.5">{String(rank).padStart(2, "0")}</span>
        <span className="min-w-0">
          <span className="block text-[14px] font-medium leading-snug">{s.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[hsl(var(--fsw-dim))]">
            <span className={`fsw-k-${s.kind} font-semibold uppercase tracking-wider`}>{KIND_LABEL[s.kind]}</span>
            <span>{s.source}</span><span>·</span><span>{s.topic}</span><span>·</span><span>{s.region}</span>
            {s.sourceCount > 1 && <span className="text-[hsl(var(--fsw-ink))]">+{s.sourceCount - 1} related publishers</span>}
            <span className="fsw-mono">pub {relTime(s.publishedAt)}</span>
          </span>
        </span>
        <span className="fsw-mono text-sm text-right" style={{ color: impactTone(s.impact) }} title="Rule-based evidence score out of 100">{s.impact}</span>
      </button>
    </li>
  );
}

function Pane({ title, right, children, className = "" }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`fsw-panel overflow-hidden ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-[hsl(var(--fsw-line))]">
        <h2 className="fsw-label text-[hsl(var(--fsw-ink))]">{title}</h2>{right}
      </header>
      {children}
    </section>
  );
}

const VIEWS = [
  { id: "briefing", label: "Briefing", Icon: LayoutGrid },
  { id: "markets", label: "Markets", Icon: BarChart3 },
  { id: "economy", label: "Economy", Icon: Gauge },
  { id: "news", label: "News", Icon: Newspaper },
  { id: "sources", label: "Sources", Icon: Database },
  { id: "assistant", label: "Assistant", Icon: MessageSquare },
] as const;
type View = typeof VIEWS[number]["id"];
const readView = (): View => {
  const v = new URLSearchParams(window.location.search).get("view");
  return (VIEWS.some((x) => x.id === v) ? v : "briefing") as View;
};
function useView(): [View, (v: View) => void] {
  const [view, set] = useState<View>(readView);
  useEffect(() => { const on = () => set(readView()); window.addEventListener("popstate", on); return () => window.removeEventListener("popstate", on); }, []);
  const go = useCallback((v: View) => {
    const u = new URL(window.location.href);
    if (v === "briefing") u.searchParams.delete("view"); else u.searchParams.set("view", v);
    if (u.href !== window.location.href) window.history.pushState(null, "", u.pathname + u.search + u.hash);
    set(v); window.scrollTo({ top: 0 });
  }, []);
  return [view, go];
}

export default function FinancialDashboard() {
  const now = useNow();
  const [view, go] = useView();
  const [days, setDays] = useState<number>(180);
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [refTab, setRefTab] = useState<"health" | "method" | "roster">("health");
  const [chat, setChatRaw] = useState<ChatState>({ messages: [], draft: "" });
  const setChat = useCallback((fn: (s: ChatState) => ChatState) => setChatRaw(fn), []);

  const dash = useQuery<FinanceDashboard>({
    queryKey: DASH_KEY,
    refetchInterval: (query) => (query.state.data?.refreshing ? 4000 : 5 * 60_000),
  });
  const refreshing = !!dash.data?.refreshing;
  const ind = useQuery<EconomyOverview>({
    queryKey: [ECON, { days }],
    refetchInterval: (query) => (refreshing || query.state.data?.markets.refreshing ? 5000 : 10 * 60_000),
    placeholderData: (prev) => prev,
  });

  const wasRefreshing = useState({ v: false })[0];
  useEffect(() => {
    if (wasRefreshing.v && !refreshing) queryClient.invalidateQueries({ queryKey: [ECON] });
    wasRefreshing.v = refreshing;
  }, [refreshing, wasRefreshing]);

  const refresh = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/finance/refresh", {})).json() as Promise<{ refreshing: boolean }>,
    onSuccess: (r) => {
      queryClient.setQueryData<FinanceDashboard>(DASH_KEY, (old) => (old ? { ...old, refreshing: r.refreshing } : old));
      queryClient.invalidateQueries({ queryKey: DASH_KEY });
      queryClient.invalidateQueries({ queryKey: [ECON] });
    },
  });

  const filterFn = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (s: FinanceStory) =>
      (!topic || s.topic === topic) && (!region || s.region === region) &&
      (!needle || `${s.title} ${s.summary} ${s.source} ${s.terms ?? ""}`.toLowerCase().includes(needle));
  }, [q, topic, region]);
  const stories = useMemo(() => (dash.data?.stories ?? []).filter(filterFn), [dash.data, filterFn]);
  const signals = useMemo(() => (dash.data?.signals ?? []).filter(filterFn), [dash.data, filterFn]);
  const selected = useMemo(() => {
    const all = [...(dash.data?.stories ?? []), ...(dash.data?.signals ?? [])];
    return all.find((s) => s.id === selectedId) ?? stories[0] ?? null;
  }, [dash.data, selectedId, stories]);

  if (isAuthError(dash.error) || isAuthError(ind.error) || isAuthError(refresh.error)) return <AccessExpired />;

  const d = dash.data;
  const e = ind.data;
  const selectNews = (id: string) => { setSelectedId(id); if (window.matchMedia("(max-width: 1279px)").matches) setSheetOpen(true); };
  const selectBriefing = (id: string) => { setSelectedId(id); setSheetOpen(true); };
  const filtersOn = !!(q || topic || region);
  const unhealthy = d?.sources.filter((s) => s.status === "error" || s.status === "unavailable").length ?? 0;
  const topStories = (d?.stories ?? []).slice(0, 12);
  const topSignals = (d?.signals ?? []).slice(0, 4);

  const econGate = (render: (e: EconomyOverview) => ReactNode) =>
    ind.isError && !e ? (
      <div className="fsw-panel p-4 flex flex-wrap items-center gap-3" data-testid="error-economy"><AlertTriangle className="h-5 w-5 text-[hsl(var(--fsw-bad))]" /><span className="text-sm flex-1">Economic data service unavailable ({errorText(ind.error)}).</span><button onClick={() => ind.refetch()} className="fsw-chip" data-testid="button-retry-economy">Retry</button></div>
    ) : !e ? (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="loading-economy"><Skeleton className="h-72 bg-[hsl(var(--fsw-panel-2))]" /><Skeleton className="h-72 bg-[hsl(var(--fsw-panel-2))]" /></div>
    ) : (
      <>
        {ind.isError && <p className="text-xs text-[hsl(var(--fsw-bad))]" data-testid="error-economy-stale">Latest economic update failed ({errorText(ind.error)}); showing last loaded data.</p>}
        {render(e)}
      </>
    );

  const rangeGroup = (
    <div className="flex gap-1" role="group" aria-label="History window" data-testid="group-range"><span className="fsw-label self-center mr-1 hidden md:inline">History</span>{RANGES.map((r) => <button key={r} data-on={days === r} onClick={() => setDays(r)} className="fsw-chip fsw-mono" data-testid={`button-range-${r}`}>{r}d</button>)}</div>
  );

  return (
    <div className="fsw" data-testid="page-financial-dashboard">
      <header className="border-b border-[hsl(var(--fsw-line))] bg-[hsl(var(--fsw-bg)/0.92)] backdrop-blur sticky top-0 z-20">
        <div className="max-w-[2480px] mx-auto px-4 pt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          <button onClick={() => go("briefing")} className="text-left" data-testid="link-home">
            <p className="fsw-label text-[hsl(var(--fsw-brass))]">Restricted · Internal</p>
            <h1 className="text-xl font-semibold tracking-tight leading-none mt-0.5">Financial Stability Watch</h1>
            <p className="text-[11px] text-[hsl(var(--fsw-dim))] mt-1">Economic conditions briefing · source-dated, descriptive only</p>
          </button>
          <div className="fsw-mono text-[11px] text-[hsl(var(--fsw-dim))] leading-relaxed" data-testid="status-refresh">
            <div>Fetched {d?.updatedAt ? `${fmtDateTime(d.updatedAt)} (${relTime(d.updatedAt, now)})` : "—"}{e?.markets.updatedAt ? ` · quotes ${fmtDateTime(e.markets.updatedAt)}` : ""}</div>
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${refreshing ? "fsw-pulse bg-[hsl(var(--fsw-brass))]" : "bg-[hsl(var(--fsw-ok))]"}`} />
              {refreshing ? "Refreshing sources…" : d?.nextRefreshAt ? `Auto refresh ${relTime(d.nextRefreshAt, now)}` : "Auto refresh schedule unknown"}
              {unhealthy > 0 && <button onClick={() => go("sources")} className="text-[hsl(var(--fsw-bad))] hover:underline" data-testid="link-sources-down">· {unhealthy} source{unhealthy > 1 ? "s" : ""} down</button>}
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {(view === "markets" || view === "economy" || view === "briefing") && rangeGroup}
            <button onClick={() => refresh.mutate()} disabled={refresh.isPending || refreshing} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-[hsl(var(--fsw-brass)/0.6)] text-[hsl(var(--fsw-brass))] rounded-sm hover:bg-[hsl(var(--fsw-brass)/0.1)] transition-colors disabled:opacity-50" data-testid="button-refresh">
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing || refresh.isPending ? "animate-spin" : ""}`} /> Refresh now
            </button>
            <button onClick={logout} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-[hsl(var(--fsw-dim))] hover:text-[hsl(var(--fsw-ink))]" data-testid="button-logout"><LogOut className="h-3.5 w-3.5" /><span className="hidden sm:inline">Sign out</span></button>
          </div>
          <nav className="fsw-nav basis-full -mx-1" aria-label="Screens">
            {VIEWS.map(({ id, label, Icon }) => (
              <a key={id} href={id === "briefing" ? "?" : `?view=${id}`} aria-current={view === id ? "page" : undefined}
                onClick={(ev) => { if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return; ev.preventDefault(); go(id); }}
                className="fsw-nav-item" data-testid={`nav-${id}`}>
                <Icon className="h-3.5 w-3.5" />{label}
                {id === "assistant" && chat.messages.length > 0 && <span className="fsw-mono text-[10px] text-[hsl(var(--fsw-dim))]">{Math.ceil(chat.messages.length / 2)}</span>}
              </a>
            ))}
          </nav>
        </div>
        {refresh.isError && <p className="px-4 pb-2 text-xs text-[hsl(var(--fsw-bad))] max-w-[2480px] mx-auto">Refresh request failed ({errorText(refresh.error)}).</p>}
      </header>

      <main className="max-w-[2480px] mx-auto px-3 sm:px-4 py-4 space-y-4 min-w-0" key={view}>
        {dash.isError && (
          <div className="fsw-panel p-4 flex items-center gap-3 border-[hsl(var(--fsw-bad)/0.6)]" data-testid="error-dashboard">
            <AlertTriangle className="h-5 w-5 text-[hsl(var(--fsw-bad))]" />
            <div className="text-sm flex-1">Dashboard feed unavailable ({errorText(dash.error)}).{d ? " Showing last loaded picture." : ""}</div>
            <button onClick={() => dash.refetch()} className="fsw-chip" data-testid="button-retry-dashboard">Retry</button>
          </div>
        )}

        {view === "briefing" && (
          <div className="fsw-in space-y-4">
            {econGate((e) => <Briefing e={e} />)}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] 2xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
              <Pane title="Top financial news · ranked" right={<button onClick={() => go("news")} className="inline-flex items-center gap-0.5 text-[11px] text-[hsl(var(--fsw-brass))] hover:underline" data-testid="link-all-news">All news and filters<ChevronRight className="h-3 w-3" /></button>}>
                <div className="xl:max-h-[clamp(360px,calc(100dvh-360px),900px)] xl:overflow-y-auto fsw-scroll">
                {dash.isLoading ? <ListSkeleton /> : topStories.length === 0 ? <Empty text="No qualifying stories in the current cycle." /> : (
                  <ol className="-mt-px">{topStories.map((s, i) => <StoryRow key={s.id} s={s} rank={i + 1} active={sheetOpen && selected?.id === s.id} onSelect={() => selectBriefing(s.id)} />)}</ol>
                )}
                {topSignals.length > 0 && (
                  <div className="border-t border-[hsl(var(--fsw-line))]">
                    <p className="fsw-label px-3 pt-2.5 text-[hsl(var(--fsw-coral))]">Early warning · unconfirmed</p>
                    <ol>{topSignals.map((s, i) => <StoryRow key={s.id} s={s} rank={i + 1} active={sheetOpen && selected?.id === s.id} onSelect={() => selectBriefing(s.id)} />)}</ol>
                  </div>
                )}
                </div>
                <p className="px-3 py-2 text-[10.5px] text-[hsl(var(--fsw-dim))] border-t border-[hsl(var(--fsw-line))]">Score is a rule-based evidence rating out of 100, not a judgement of importance. Select a story for detail.</p>
              </Pane>
              <Pane title="Graphs behind the BLUF" right={<span className="fsw-label">window {days}d</span>}>
                <div className="p-3">
                  {econGate((e) => <BlufCharts e={e} />)}
                  <p className="mt-3 text-[11px] text-[hsl(var(--fsw-dim))]">Official series show observation dates and publish with a lag; Brent is a delayed front-month futures quote. Gaps are left as gaps. Full history on <button onClick={() => go("economy")} className="text-[hsl(var(--fsw-brass))] hover:underline" data-testid="link-economy">Economy</button>, oil curve and rates on <button onClick={() => go("markets")} className="text-[hsl(var(--fsw-brass))] hover:underline" data-testid="link-markets">Markets</button>.</p>
                </div>
              </Pane>
            </div>
          </div>
        )}

        {view === "markets" && <div className="fsw-in space-y-4">{econGate((e) => (
          <>
            <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_460px]">
              <div className="min-w-0 space-y-4"><Oil e={e} /><Rates e={e} /></div>
              <div className="min-w-0"><Markets e={e} /></div>
            </div>
          </>
        ))}</div>}

        {view === "economy" && <div className="fsw-in space-y-4">
          {econGate((e) => <Conditions e={e} />)}
          <Pane title="Indicator history · stress, inflation, jobs, output" right={<span className="fsw-label">window {days}d</span>}>
            <div className="p-3">
              <p className="text-[11px] text-[hsl(var(--fsw-dim))] mb-3">{e?.notes.join(" ")} Daily and weekly series from official publishers; not live market data. Gaps are left as gaps. "Obs." is the observation date; "fetched" is when this system retrieved it.{ind.isFetching && !ind.isLoading ? " Updating…" : ""}</p>
              {ind.isError && !e ? (
                <div className="flex items-center gap-3 text-sm"><AlertTriangle className="h-4 w-4 text-[hsl(var(--fsw-bad))]" />Indicator service unavailable ({errorText(ind.error)}).<button onClick={() => ind.refetch()} className="fsw-chip" data-testid="button-retry-indicators">Retry</button></div>
              ) : !e ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-60 bg-[hsl(var(--fsw-panel-2))]" />)}</div>
              ) : (
                <>
                  {e.indicators.length === 0 && <Empty text="No indicators configured." />}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 min-[2200px]:grid-cols-5">
                    {e.indicators.filter((x) => STRESS.includes(x.id)).map((x, i) => <IndicatorChart key={x.id} ind={x} color={LINE_COLORS[i % LINE_COLORS.length]} />)}
                    <div className="fsw-panel p-3 border-dashed" data-testid="card-fear-greed">
                      <h3 className="text-sm font-semibold">CNN Fear &amp; Greed Index</h3>
                      <p className="fsw-label mt-1 text-[hsl(var(--fsw-dim))]">Not supported</p>
                      <p className="mt-2 text-xs leading-relaxed">{e.fearAndGreed.message}</p>
                      <p className="mt-2 text-[11px] text-[hsl(var(--fsw-dim))]">VIX and OFR stress measures above are separate indicators and are not substitutes for this index.</p>
                      <a href={e.fearAndGreed.sourceUrl} target="_blank" rel="noreferrer noopener" className="mt-3 inline-flex items-center gap-1 text-xs text-[hsl(var(--fsw-brass))] hover:underline" data-testid="link-fear-greed">View at CNN <ExternalLink className="h-3 w-3" /></a>
                    </div>
                  </div>
                </>
              )}
            </div>
          </Pane>
        </div>}

        {view === "news" && <div className="fsw-in space-y-4">
          <div className="fsw-panel p-3 space-y-2.5" data-testid="section-news-filters">
            <div className="flex flex-wrap items-center gap-3">
              <label className="relative flex-1 min-w-[220px] max-w-md">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[hsl(var(--fsw-dim))]" />
                <input type="search" value={q} onChange={(ev) => setQ(ev.target.value)} placeholder="Search titles, descriptions, sources, terms" aria-label="Search stories and signals" className="w-full bg-[hsl(var(--fsw-bg))] border border-[hsl(var(--fsw-line))] rounded-sm pl-8 pr-3 py-1.5 text-sm placeholder:text-[hsl(var(--fsw-dim))]" data-testid="input-search" />
              </label>
              <span className="fsw-mono text-xs text-[hsl(var(--fsw-dim))]" data-testid="text-result-count">{stories.length} stories · {signals.length} signals</span>
              {filtersOn && <button onClick={() => { setQ(""); setTopic(null); setRegion(null); }} className="text-xs text-[hsl(var(--fsw-brass))] hover:underline" data-testid="button-clear-filters">Clear filters</button>}
            </div>
            <div className="flex gap-1.5 overflow-x-auto fsw-scroll pb-0.5" role="group" aria-label="Topic filter">
              <span className="fsw-label self-center mr-1 shrink-0">Topic</span>
              {(d?.topics ?? []).map((t) => <button key={t} data-on={topic === t} onClick={() => setTopic(topic === t ? null : t)} className="fsw-chip" data-testid={`chip-topic-${t}`}>{t}</button>)}
            </div>
            <div className="flex gap-1.5 overflow-x-auto fsw-scroll pb-0.5" role="group" aria-label="Region filter">
              <span className="fsw-label self-center mr-1 shrink-0">Region</span>
              {(d?.regions ?? []).map((r) => <button key={r} data-on={region === r} onClick={() => setRegion(region === r ? null : r)} className="fsw-chip" data-testid={`chip-region-${r}`}>{r}</button>)}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_400px] 2xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_480px]">
            <Pane title="News · reporting & official" right={<span className="fsw-label">score / 100</span>}>
              {dash.isLoading ? <ListSkeleton /> : stories.length === 0 ? (
                <Empty text={filtersOn ? "No stories match the current filters." : "No qualifying stories in the current cycle."} />
              ) : (
                <ol className="max-h-[calc(100dvh-330px)] min-h-[420px] overflow-y-auto fsw-scroll -mt-px">{stories.map((s, i) => <StoryRow key={s.id} s={s} rank={i + 1} active={selected?.id === s.id} onSelect={() => selectNews(s.id)} />)}</ol>
              )}
            </Pane>
            <Pane title="Early warning · Dataminr & social" right={d && <span className="fsw-label" style={{ color: d.dataminr.configured ? "hsl(var(--fsw-coral))" : undefined }}>Dataminr {d.dataminr.status}</span>}>
              <p className="px-3 py-2 text-[11px] text-[hsl(var(--fsw-dim))] border-b border-[hsl(var(--fsw-line))]">Unconfirmed signals. Treat as cues to verify, not findings.</p>
              {dash.isLoading ? <ListSkeleton /> : signals.length === 0 ? (
                <Empty text={filtersOn ? "No signals match the current filters." : d?.dataminr.configured ? `No matching Dataminr alerts in this cycle. ${d.dataminr.message}` : `Dataminr not configured. ${d?.dataminr.message ?? ""}`} />
              ) : (
                <ol className="max-h-[calc(100dvh-370px)] min-h-[380px] overflow-y-auto fsw-scroll -mt-px">{signals.map((s, i) => <StoryRow key={s.id} s={s} rank={i + 1} active={selected?.id === s.id} onSelect={() => selectNews(s.id)} />)}</ol>
              )}
            </Pane>
            <aside className="fsw-panel hidden xl:block self-start sticky top-[118px] max-h-[calc(100dvh-134px)] overflow-y-auto fsw-scroll" aria-label="Selected item detail">
              <StoryDetail story={selected} />
            </aside>
          </div>
        </div>}

        {view === "sources" && <div className="fsw-in">
          <Pane title="Sources, method and roster" right={
            <div className="flex gap-1" role="tablist">
              {([["health", "Source health"], ["method", "Scoring method"], ["roster", "Social roster"]] as const).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={refTab === k} data-on={refTab === k} onClick={() => setRefTab(k)} className="fsw-chip" data-testid={`tab-${k}`}>{l}</button>
              ))}
            </div>
          }>
            {!d ? (dash.isLoading ? <ListSkeleton /> : <Empty text="Reference data unavailable until the dashboard loads." />) :
              refTab === "health" ? <SourceHealthTable sources={d.sources} /> :
              refTab === "method" ? <Methodology m={d.methodology} dataminr={d.dataminr} /> :
              <SocialRoster accounts={d.socialAccounts} />}
          </Pane>
        </div>}

        {view === "assistant" && <div className="fsw-in max-w-[1400px] mx-auto"><ChatAssistant state={chat} setState={setChat} /></div>}
      </main>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="fsw w-full sm:max-w-lg p-0 overflow-y-auto border-[hsl(var(--fsw-line))]">
          <SheetTitle className="sr-only">Item detail</SheetTitle>
          <StoryDetail story={selected} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ListSkeleton() {
  return <div className="p-3 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 bg-[hsl(var(--fsw-panel-2))]" />)}</div>;
}
function Empty({ text }: { text: string }) {
  return <div className="px-4 py-10 text-center text-sm text-[hsl(var(--fsw-dim))]" data-testid="text-empty">{text}</div>;
}
