import type { FinanceDashboard } from "@shared/finance";
import { ExternalLink } from "lucide-react";
import { KIND_LABEL, fmtDateTime, relTime } from "./utils";

const STATUS_COLOR: Record<string, string> = {
  healthy: "hsl(var(--fsw-ok))", error: "hsl(var(--fsw-bad))", unavailable: "hsl(var(--fsw-dim))", refreshing: "hsl(var(--fsw-brass))",
};

export function SourceHealthTable({ sources }: { sources: FinanceDashboard["sources"] }) {
  if (sources.length === 0) return <p className="p-4 text-sm text-[hsl(var(--fsw-dim))]">No sources registered.</p>;
  const bad = sources.filter((s) => s.status === "error" || s.status === "unavailable").length;
  return (
    <div>
      <p className="px-4 pt-3 text-xs text-[hsl(var(--fsw-dim))]">{sources.length - bad} of {sources.length} sources returned data on last attempt. Publication time is the newest item date; attempt time is when we fetched.</p>
      <div className="overflow-x-auto fsw-scroll">
        <table className="w-full text-xs mt-2">
          <thead><tr className="fsw-label text-left">
            <th className="px-4 py-2 font-normal">Source</th><th className="px-2 font-normal">Status</th><th className="px-2 font-normal">Last attempt</th><th className="px-2 font-normal">Last success</th><th className="px-2 font-normal">Newest pub.</th><th className="px-2 font-normal text-right">Recv / relevant</th><th className="px-4 font-normal">Note</th>
          </tr></thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id} className="border-t border-[hsl(var(--fsw-line))] fsw-row" data-testid={`row-source-${s.id}`}>
                <td className="px-4 py-1.5"><a href={s.url} target="_blank" rel="noreferrer noopener" className="hover:text-[hsl(var(--fsw-brass))]">{s.name}</a> <span className={`fsw-label fsw-k-${s.kind}`}>{KIND_LABEL[s.kind]}</span></td>
                <td className="px-2"><span className="inline-flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${s.status === "refreshing" ? "fsw-pulse" : ""}`} style={{ background: STATUS_COLOR[s.status] }} />{s.status}</span></td>
                <td className="px-2 fsw-mono whitespace-nowrap" title={fmtDateTime(s.lastAttemptAt)}>{relTime(s.lastAttemptAt)}</td>
                <td className="px-2 fsw-mono whitespace-nowrap" title={fmtDateTime(s.lastSuccessAt)}>{relTime(s.lastSuccessAt)}</td>
                <td className="px-2 fsw-mono whitespace-nowrap">{fmtDateTime(s.latestPublicationAt)}</td>
                <td className="px-2 fsw-mono text-right">{s.received} / {s.relevant}</td>
                <td className="px-4 text-[hsl(var(--fsw-dim))] max-w-[320px] truncate" title={s.message}>{s.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Methodology({ m, dataminr }: { m: FinanceDashboard["methodology"]; dataminr: FinanceDashboard["dataminr"] }) {
  const max = Math.max(1, ...m.weights.map((w) => w.maximum));
  return (
    <div className="p-4 grid gap-6 md:grid-cols-2 text-sm">
      <div>
        <h3 className="font-semibold">{m.title}</h3>
        <p className="mt-1 text-[hsl(var(--fsw-ink)/0.85)] leading-relaxed">{m.description}</p>
        <p className="mt-3 text-xs text-[hsl(var(--fsw-dim))]">Scores are deterministic rules applied to feed metadata. No AI model summarises, ranks or rewrites items; AI integrations are disabled by the operator.</p>
        <p className="fsw-label mt-4">Limitations</p>
        <ul className="mt-1 list-disc pl-4 space-y-1 text-[hsl(var(--fsw-ink)/0.85)]">{m.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
        <p className="fsw-label mt-4">Dataminr integration</p>
        <p className="mt-1">{dataminr.configured ? "Configured" : "Not configured"} · {dataminr.status}</p>
        <p className="text-xs text-[hsl(var(--fsw-dim))]">{dataminr.message}</p>
      </div>
      <div>
        <p className="fsw-label">Weight ceilings (points)</p>
        <ul className="mt-2 space-y-2">
          {m.weights.map((w) => (
            <li key={w.label} className="grid grid-cols-[1fr_auto] gap-x-3 text-xs">
              <span>{w.label}</span><span className="fsw-mono">{w.maximum}</span>
              <div className="col-span-2 h-1 bg-[hsl(var(--fsw-line))]"><div className="h-full origin-left bg-[hsl(var(--fsw-cyan))]" style={{ transform: `scaleX(${w.maximum / max})` }} /></div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function SocialRoster({ accounts }: { accounts: FinanceDashboard["socialAccounts"] }) {
  if (accounts.length === 0) return <p className="p-4 text-sm text-[hsl(var(--fsw-dim))]">No accounts on the roster.</p>;
  return (
    <div className="p-4">
      <p className="text-xs text-[hsl(var(--fsw-dim))] mb-3">Reference list of accounts relevant to financial stability. These accounts are not scraped live; status shows how each is actually covered.</p>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {accounts.map((a) => (
          <a key={a.handle} href={a.url} target="_blank" rel="noreferrer noopener" className="fsw-panel p-3 block hover:border-[hsl(var(--fsw-brass)/0.5)] transition-colors" data-testid={`link-social-${a.handle}`}>
            <div className="flex justify-between gap-2"><span className="font-medium text-sm">{a.name}</span><ExternalLink className="h-3 w-3 opacity-50 shrink-0" /></div>
            <p className="fsw-mono text-[11px] text-[hsl(var(--fsw-dim))]">{a.handle} · {a.role}</p>
            <p className="text-xs mt-1">{a.focus}</p>
            <p className="fsw-label mt-2" style={{ color: a.status === "Via public releases" ? "hsl(var(--fsw-sand))" : "hsl(var(--fsw-dim))" }}>{a.status}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
