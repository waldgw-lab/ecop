import { useMemo } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtDate, fmtNum, parseTime } from "../utils";

export type Series = { key: string; name: string; color: string; unit: string; step?: boolean; points: { date: string; value: number | null }[] };
type Pt = { t: number; v: number | null };

export function toPts(points: { date: string; value: number | null }[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const t = parseTime(p.date);
    if (t === null) continue;
    out.push({ t, v: p.value !== null && Number.isFinite(p.value) ? p.value : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

const AX = { fill: "hsl(195 10% 62%)", fontSize: 10 };

/** Multiple series of ONE unit on a shared numeric time axis. Each line keeps its own data so gaps stay gaps. */
export function TimeChart({ series, height = 200, label, testId }: { series: Series[]; height?: number; label: string; testId?: string }) {
  const data = useMemo(() => series.map((s) => ({ ...s, pts: toPts(s.points) })), [series]);
  const valid = data.reduce((n, s) => n + s.pts.filter((p) => p.v !== null).length, 0);
  const unit = series[0]?.unit ?? "";
  const ts = data.flatMap((s) => s.pts.map((p) => p.t));
  const span = ts.length ? Math.max(...ts) - Math.min(...ts) : 0;
  const tickFmt = (t: number) => new Date(t).toLocaleDateString(undefined, span > 200 * 864e5 ? { month: "short", year: "2-digit", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" });
  if (valid < 2) return <div style={{ height }} className="grid place-items-center text-xs text-[hsl(var(--fsw-dim))] border border-dashed border-[hsl(var(--fsw-line))] rounded-sm px-3 text-center" data-testid={testId}>Not enough source observations in this window to draw a history.</div>;
  return (
    <div className="min-w-0 w-full" style={{ height }} role="img" aria-label={label} data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart margin={{ top: 6, right: 8, bottom: 0, left: -6 }}>
          <CartesianGrid stroke="hsl(196 18% 20% / 0.6)" vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} allowDuplicatedCategory={false} tickFormatter={tickFmt} tick={AX} stroke="hsl(196 18% 24%)" minTickGap={30} />
          <YAxis domain={["auto", "auto"]} tick={AX} stroke="hsl(196 18% 24%)" width={46} tickFormatter={(v: number) => fmtNum(v, Math.abs(v) >= 100 ? 0 : 1)} />
          <Tooltip
            cursor={{ stroke: "hsl(40 78% 58% / 0.5)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const t = (payload[0].payload as Pt).t;
              return (
                <div className="fsw-panel px-2.5 py-1.5 text-xs fsw-mono shadow-lg">
                  <div className="text-[hsl(var(--fsw-dim))]">Observed {fmtDate(t)}</div>
                  {payload.map((p) => <div key={String(p.name)} style={{ color: p.color }}>{p.name}: {p.value == null ? "no observation" : `${fmtNum(Number(p.value))} ${unit}`}</div>)}
                </div>
              );
            }}
          />
          {data.length > 1 && <Legend iconType="plainline" wrapperStyle={{ fontSize: 11, color: "hsl(195 10% 62%)" }} />}
          {data.map((s) => (
            <Line key={s.key} data={s.pts} dataKey="v" name={s.name} type={s.step ? "stepAfter" : "linear"} stroke={s.color} strokeWidth={1.7} dot={s.pts.length < 12 ? { r: 2 } : false} connectNulls={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Spark({ points, color, testId }: { points: { date: string; value: number | null }[]; color: string; testId?: string }) {
  const pts = useMemo(() => toPts(points), [points]);
  if (pts.filter((p) => p.v !== null).length < 2) return <div className="h-9 text-[10px] text-[hsl(var(--fsw-dim))] grid place-items-center">no history</div>;
  return (
    <div className="h-9 min-w-0 w-full" data-testid={testId} aria-hidden>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={pts} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} hide />
          <YAxis domain={["auto", "auto"]} hide />
          <Line dataKey="v" stroke={color} strokeWidth={1.3} dot={false} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export const PAL = { cyan: "#61A9BD", yellow: "#CED14E", green: "#44986D", pink: "#DD83C9", blue: "#71A5D2", orange: "#E98E2E", purple: "#9267C6", red: "#D8524F" };
export const signed = (v: number | null | undefined, d = 2, suffix = "") => (v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtNum(Math.abs(v), d)}${suffix}`);
export const moveColor = (v: number | null | undefined) => (v == null || v === 0 ? "hsl(var(--fsw-dim))" : v > 0 ? "hsl(var(--fsw-brass))" : "hsl(var(--fsw-cyan))");
export const statusColor = (s: string) => (s === "available" ? "hsl(var(--fsw-ok))" : s === "stale" ? "hsl(var(--fsw-brass))" : "hsl(var(--fsw-bad))");
