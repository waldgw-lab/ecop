import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ExternalLink, Radio } from "lucide-react";

/**
 * Live Leadership Broadcast banner (CURATED LANE ONLY).
 *
 * A subtle single-line strip that lights up when a covered leader (President,
 * Vice President, Secretary of State, Secretary of War) is about to speak, is
 * live, or just finished — with a one-click watch link. Renders NOTHING when
 * there is no activity, so there is no empty strip and no layout shift.
 *
 * Polls the curated-access-gated /api/curated/live-status endpoint every ~45s.
 * Per-viewer on/off is owned by the parent (Curated layout prefs); when the
 * viewer turns it off this component is simply not mounted.
 */

type BroadcastState = "upcoming" | "live" | "recently_ended";

interface LiveBroadcastStatus {
  state: BroadcastState;
  leader: string;
  title: string;
  watchUrl: string;
  startsAt?: string;
  since?: string;
  endsAt?: string;
}

interface LiveStatusResponse {
  status: LiveBroadcastStatus | null;
  lastComputed: number | null;
}

const STATE_LABEL: Record<BroadcastState, string> = {
  upcoming: "Starting soon",
  live: "LIVE",
  recently_ended: "Just ended · replay",
};

export default function LiveBroadcastBanner() {
  // Preview override: visiting /curated?preview=upcoming|live|recently_ended
  // forwards the param to the (curated-gated) endpoint so a tester can see each
  // banner stage on demand. Ignored entirely when the param is absent.
  // ONE-SHOT: the param is captured once on mount and immediately stripped from
  // the URL, so a refresh/bookmark/shared link can never leave the synthetic
  // "(preview sample)" banner stuck on screen.
  const [preview] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const p = params.get("preview");
    if (p !== null) {
      params.delete("preview");
      const qs = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
      );
    }
    return p;
  });
  const isPreview =
    preview === "upcoming" || preview === "live" || preview === "recently_ended";
  const url = isPreview
    ? `/api/curated/live-status?preview=${preview}`
    : "/api/curated/live-status";

  const { data } = useQuery<LiveStatusResponse>({
    queryKey: ["/api/curated/live-status", isPreview ? preview : null],
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    refetchInterval: isPreview ? false : 45_000,
    refetchOnWindowFocus: !isPreview,
    staleTime: 30_000,
  });

  // Re-render on a slow ticker so the relative countdown stays current between
  // the 45s polls (purely display; no network).
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const status = data?.status ?? null;

  // Render nothing at all when there is no activity (no empty strip, no jump).
  if (!status) return null;

  const isLive = status.state === "live";
  const isUpcoming = status.state === "upcoming";

  // Relative countdown / elapsed text, recomputed each tick. Returns "" when
  // there is nothing meaningful to show (e.g. an upcoming cue with no genuine
  // scheduled start), so the span is simply omitted.
  const countdown = ((): string => {
    const fmtMins = (mins: number) =>
      mins >= 60
        ? `${Math.floor(mins / 60)}h ${mins % 60}m`
        : `${mins} min`;
    if (isUpcoming && status.startsAt) {
      const deltaMs = new Date(status.startsAt).getTime() - nowTick;
      if (deltaMs > 0) return `in ${fmtMins(Math.ceil(deltaMs / 60000))}`;
      return "starting any moment";
    }
    if (isLive && status.since) {
      const elapsed = Math.floor((nowTick - new Date(status.since).getTime()) / 60000);
      if (elapsed >= 1) return `${fmtMins(elapsed)} on air`;
      return "on air";
    }
    if (status.state === "recently_ended" && status.endsAt) {
      const ago = Math.floor((nowTick - new Date(status.endsAt).getTime()) / 60000);
      if (ago >= 1) return `ended ${fmtMins(ago)} ago`;
      return "ended just now";
    }
    return "";
  })();

  // Status-light + accent colors per state.
  const dotClass = isLive
    ? "bg-red-500"
    : isUpcoming
      ? "bg-amber-500"
      : "bg-muted-foreground/60";
  const labelClass = isLive
    ? "text-red-500 dark:text-red-400"
    : isUpcoming
      ? "text-amber-600 dark:text-amber-400"
      : "text-muted-foreground";

  return (
    <div
      className="border-b border-border bg-background/95 animate-in fade-in duration-300"
      data-testid="banner-live-broadcast"
      data-state={status.state}
    >
      <div className="max-w-[2200px] mx-auto px-3 py-1.5">
        <div className="flex items-center gap-3 min-w-0">
          {/* Status light */}
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            {isLive && (
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 animate-ping" />
            )}
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dotClass}`}
            />
          </span>

          <Radio className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />

          <span
            className={`text-xs font-semibold uppercase tracking-wide shrink-0 ${labelClass}`}
            data-testid="text-live-state"
          >
            {STATE_LABEL[status.state]}
          </span>

          <span
            className="text-xs font-medium shrink-0 text-foreground"
            data-testid="text-live-leader"
          >
            {status.leader}
          </span>

          <span
            className="text-xs text-muted-foreground truncate min-w-0 flex-1"
            data-testid="text-live-title"
            title={status.title}
          >
            {status.title}
          </span>

          {countdown && (
            <span
              className={`text-xs font-medium tabular-nums shrink-0 ${labelClass}`}
              data-testid="text-live-countdown"
            >
              {countdown}
            </span>
          )}

          <a
            href={status.watchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-foreground rounded-md px-2 py-0.5 hover-elevate active-elevate-2"
            data-testid="link-live-watch"
          >
            <span>{status.state === "recently_ended" ? "Replay" : "Watch"}</span>
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}
