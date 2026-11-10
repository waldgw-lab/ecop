import { useEffect, useRef, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, RotateCcw, Send, ShieldAlert, Trash2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { FinanceChatMessage, FinanceChatResponse } from "@shared/financeChat";
import { errorText, fmtDate, fmtDateTime, isAuthError } from "./utils";

export type ChatSource = FinanceChatResponse["sources"][number];
export type ChatMsg = FinanceChatMessage & { sources?: ChatSource[]; asOf?: string; suggestions?: string[] };
export type ChatState = { messages: ChatMsg[]; draft: string };

export const DEFAULT_SUGGESTIONS = [
  "Summarise today's BLUF",
  "What is oil doing?",
  "What do futures price for rates?",
  "Is financial stress rising?",
  "How is inflation trending?",
  "What are the data limits?",
];

export function ChatAssistant({ state, setState, compact = false }: { state: ChatState; setState: (fn: (s: ChatState) => ChatState) => void; compact?: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  const send = useMutation({
    mutationFn: async (vars: { message: string; history: FinanceChatMessage[] }) =>
      (await apiRequest("POST", "/api/finance/chat", vars)).json() as Promise<FinanceChatResponse>,
    onSuccess: (r, vars) => setState((s) => ({
      draft: s.draft === vars.message ? "" : s.draft,
      messages: [...s.messages, { role: "user", content: vars.message }, { role: "assistant", content: r.answer, sources: r.sources, asOf: r.asOf, suggestions: r.suggestions }],
    })),
  });
  const { messages, draft } = state;
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [messages.length, send.isPending]);

  const ask = (text: string) => {
    const message = text.trim().slice(0, 1500);
    if (!message || send.isPending) return;
    setState((s) => ({ ...s, draft: message }));
    send.mutate({ message, history: messages.slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 12000) })) });
  };
  const onSubmit = (ev: FormEvent) => { ev.preventDefault(); ask(draft); };
  const pending = send.isPending ? send.variables?.message : null;
  const lastSuggestions = [...messages].reverse().find((m) => m.suggestions?.length)?.suggestions ?? DEFAULT_SUGGESTIONS;

  if (isAuthError(send.error)) {
    return (
      <div className="fsw-panel p-6 text-center" data-testid="panel-chat-auth-expired">
        <ShieldAlert className="mx-auto h-7 w-7 text-[hsl(var(--fsw-brass))]" />
        <p className="mt-2 font-semibold">Session expired</p>
        <p className="text-sm text-[hsl(var(--fsw-dim))]">Sign in again to use the briefing assistant.</p>
        <button onClick={() => window.location.reload()} className="mt-3 fsw-btn-primary" data-testid="button-chat-reauth">Reload and sign in</button>
      </div>
    );
  }

  return (
    <section className={`fsw-panel flex flex-col min-h-0 ${compact ? "h-full" : "h-[calc(100dvh-170px)] min-h-[520px]"}`} data-testid="panel-chat">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[hsl(var(--fsw-line))]">
        <div>
          <h2 className="text-base font-semibold leading-none">Briefing assistant</h2>
          <p className="fsw-label mt-1 normal-case tracking-normal text-[11px]" data-testid="text-chat-mode">Source-grounded data guide · no generative AI; external AI remains paused</p>
        </div>
        <button onClick={() => { send.reset(); setState(() => ({ messages: [], draft: "" })); }} disabled={send.isPending || (!messages.length && !draft)} className="fsw-chip inline-flex items-center gap-1 disabled:opacity-40" data-testid="button-chat-clear"><Trash2 className="h-3 w-3" />Clear conversation</button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto fsw-scroll px-4 py-4 space-y-4" aria-live="polite" aria-busy={send.isPending} data-testid="list-chat-messages">
        {messages.length === 0 && !pending && (
          <div className="max-w-2xl" data-testid="text-chat-empty">
            <p className="text-sm leading-relaxed">Ask about the latest dated data this dashboard holds: the BLUF, oil, rates and futures, inflation, jobs, financial stress, growth, currencies and markets, or a search of the ranked news. Answers are assembled by rules from those sources and cite them. Questions outside that scope are declined, not guessed.</p>
          </div>
        )}
        {messages.map((m, i) => <Bubble key={i} m={m} i={i} />)}
        {pending && (
          <>
            <Bubble m={{ role: "user", content: pending }} i={-1} />
            <div className="flex items-center gap-2 text-sm text-[hsl(var(--fsw-dim))]" role="status" data-testid="status-chat-loading">
              <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--fsw-brass))] fsw-pulse" />Reading the latest data…
            </div>
          </>
        )}
        {send.isError && (
          <div className="fsw-panel border-[hsl(var(--fsw-bad)/0.6)] p-3 flex flex-wrap items-center gap-3 text-sm" role="alert" data-testid="error-chat">
            <AlertTriangle className="h-4 w-4 text-[hsl(var(--fsw-bad))]" />
            <span className="flex-1">The assistant could not answer ({errorText(send.error)}). Your question is kept below.</span>
            <button onClick={() => send.variables && ask(send.variables.message)} className="fsw-chip inline-flex items-center gap-1" data-testid="button-chat-retry"><RotateCcw className="h-3 w-3" />Retry</button>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t border-[hsl(var(--fsw-line))] px-4 py-3 space-y-2">
        <div className="flex gap-1.5 overflow-x-auto fsw-scroll pb-0.5" role="group" aria-label="Suggested questions">
          {lastSuggestions.map((s) => <button key={s} onClick={() => ask(s)} disabled={send.isPending} className="fsw-chip disabled:opacity-40" data-testid={`button-suggestion-${s.slice(0, 24).replace(/\W+/g, "-").toLowerCase()}`}>{s}</button>)}
        </div>
        <form onSubmit={onSubmit} className="flex gap-2">
          <label className="sr-only" htmlFor="fsw-chat-input">Question for the briefing assistant</label>
          <textarea id="fsw-chat-input" value={draft} maxLength={1500} rows={compact ? 1 : 2}
            onChange={(e) => setState((s) => ({ ...s, draft: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(draft); } }}
            placeholder="e.g. Why is the oil curve in backwardation? Compare inflation to 6 months ago."
            className="flex-1 resize-none bg-[hsl(var(--fsw-bg))] border border-[hsl(var(--fsw-line))] rounded-sm px-3 py-2 text-sm placeholder:text-[hsl(var(--fsw-dim))] focus:border-[hsl(var(--fsw-brass)/0.7)] focus:outline-none transition-colors" data-testid="input-chat" />
          <button type="submit" disabled={!draft.trim() || send.isPending} className="fsw-btn-primary inline-flex items-center gap-1.5 self-end disabled:opacity-40" data-testid="button-chat-send"><Send className="h-3.5 w-3.5" />Ask</button>
        </form>
        <p className="fsw-mono text-[10px] text-[hsl(var(--fsw-dim))] text-right">{draft.length}/1500 · conversation kept only in this tab, cleared on sign-out</p>
      </div>
    </section>
  );
}

function Bubble({ m, i }: { m: ChatMsg; i: number }) {
  const user = m.role === "user";
  return (
    <div className={`fsw-in max-w-3xl ${user ? "ml-auto" : ""}`} data-testid={`msg-chat-${m.role}-${i}`}>
      <p className="fsw-label mb-1" style={user ? { textAlign: "right" } : { color: "hsl(var(--fsw-brass))" }}>{user ? "You" : `Briefing assistant${m.asOf ? ` · data as of ${fmtDateTime(m.asOf)}` : ""}`}</p>
      <div className={`rounded-sm px-3 py-2 text-[14px] leading-relaxed whitespace-pre-wrap ${user ? "bg-[hsl(var(--fsw-brass)/0.1)] border border-[hsl(var(--fsw-brass)/0.35)]" : "bg-[hsl(var(--fsw-panel-2))] border border-[hsl(var(--fsw-line))] border-l-2 border-l-[hsl(var(--fsw-brass))]"}`}>{m.content}</div>
      {!user && !!m.sources?.length && (
        <ol className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Citations">
          {m.sources.map((s, k) => (
            <li key={k}>
              <a href={s.url} target="_blank" rel="noreferrer noopener" className="fsw-cite" data-testid={`link-chat-source-${i}-${k}`}>
                <span className="fsw-mono text-[hsl(var(--fsw-brass))]">[{k + 1}]</span> {s.label}
                <span className="fsw-mono text-[hsl(var(--fsw-dim))]">{s.observedAt ? ` · obs. ${fmtDate(s.observedAt)}` : " · undated"}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
