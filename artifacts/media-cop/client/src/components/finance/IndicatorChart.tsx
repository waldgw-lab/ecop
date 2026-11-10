import { useMemo } from "react";
import type { FinanceIndicator } from "@shared/finance";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ExternalLink } from "lucide-react";
import { fmtDate, fmtDateTime, fmtNum, parseTime } from "./utils";

type Pt = { t: number; v: number | null };

function ChartTip({ active, payload, unit }: { active?: boolean; payload?: { payload: Pt }[]; unit: string }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div role="status" className="fsw-panel px-2.5 py-1.5 text-xs fsw-mono shadow-lg">
      <div className="text-[hsl(var(--fsw-dim))]">Observed {fmtDate(p.t)}</div>
      <div>{p.v === null ? "No observation" : `${fmtNum(p.v)} ${unit}`}</div>
    </div>
  );
}

export function IndicatorChart({ ind, color }: { ind: FinanceIndicator; color: string }) {
  const data = useMemo<Pt[]>(() => {
    const out: Pt[] = [];
    for (const p of ind.points) {
      const t = parseTime(p.date);
      if (t === null) continue;
      out.push({ t, v: p.value !== null && Number.isFinite(p.value) ? p.value : null });
    }
    return out.sort((a, b) => a.t - b.t);
  }, [ind.points]);
  const valid = data.filter((d) => d.v !== null).length;
  const change = ind.change !== null && Number.isFinite(ind.change) ? ind.change : null;

  return (
    <div className="fsw-panel min-w-0 p-3 flex flex-col" data-testid={`card-indicator-${ind.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight">{ind.name}</h3>
          <p className="text-[11px] text-[hsl(var(--fsw-dim))] leading-snug line-clamp-2" title={ind.description}>{ind.description}</p>
        </div>
        <span className="fsw-label shrink-0" style={{ color: ind.status === "available" ? "hsl(var(--fsw-ok))" : ind.status === "stale" ? "hsl(var(--fsw-brass))" : "hsl(var(--fsw-bad))" }} data-testid={`status-indicator-${ind.id}`}>{ind.status}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-2 fsw-mono">
        <span className="text-xl" data-testid={`text-indicator-latest-${ind.id}`}>{ind.latest ? fmtNum(ind.latest.value) : "—"}</span>
        <span className="text-[11px] text-[hsl(var(--fsw-dim))]">{ind.unit}</span>
        {change !== null && (
          <span className="text-[11px]" style={{ color: change > 0 ? "hsl(var(--fsw-brass))" : change < 0 ? "hsl(var(--fsw-cyan))" : "hsl(var(--fsw-dim))" }}>
            {change > 0 ? "+" : ""}{fmtNum(change)} vs prior obs.
          </span>
        )}
      </div>
      <p className="fsw-mono text-[10.5px] text-[hsl(var(--fsw-dim))]">
        Obs. {ind.latest ? fmtDate(ind.latest.date) : "—"} · {ind.frequency} · fetched {fmtDateTime(ind.fetchedAt)}
      </p>
      <div className="mt-2 min-w-0 h-36" aria-label={`${ind.name} history line chart, ${ind.unit}`} role="img">
        {valid < 2 ? (
          <div className="h-full grid place-items-center text-center text-xs text-[hsl(var(--fsw-dim))] border border-dashed border-[hsl(var(--fsw-line))] rounded-sm px-3">
            {ind.status === "unavailable" ? (ind.message || "Indicator unavailable from source.") : "Not enough observations in this window to draw a history."}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: -8 }}>
              <CartesianGrid stroke="hsl(196 18% 20% / 0.6)" vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })} tick={{ fill: "hsl(195 10% 62%)", fontSize: 10 }} stroke="hsl(196 18% 24%)" minTickGap={28} />
              <YAxis domain={["auto", "auto"]} tick={{ fill: "hsl(195 10% 62%)", fontSize: 10 }} stroke="hsl(196 18% 24%)" width={44} tickFormatter={(v: number) => fmtNum(v, Math.abs(v) >= 100 ? 0 : 1)} />
              <Tooltip content={<ChartTip unit={ind.unit} />} cursor={{ stroke: "hsl(40 78% 58% / 0.5)" }} />
              <Line type="linear" dataKey="v" stroke={color} strokeWidth={1.6} dot={valid < 12 ? { r: 2 } : false} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className="min-w-0 text-[hsl(var(--fsw-dim))] truncate" title={ind.message}>{ind.status !== "unavailable" ? ind.message : ""}</span>
        <a href={ind.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 text-[hsl(var(--fsw-dim))] hover:text-[hsl(var(--fsw-brass))]" data-testid={`link-indicator-source-${ind.id}`}>{ind.source}<ExternalLink className="h-3 w-3 shrink-0" /></a>
      </div>
    </div>
  );
}
