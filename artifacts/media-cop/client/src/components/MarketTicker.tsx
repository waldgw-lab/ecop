import { useState, useEffect, useRef, useCallback } from "react";
import { TrendingUp, TrendingDown } from "lucide-react";

// Motion mode for the ticker.
//  - "standard": horizontal marquee at the configured speed (default).
//  - "fast":     same horizontal marquee, noticeably quicker.
//  - "fade":     compact vertical rotator — one index at a time, gently fades.
//  - "push":     compact vertical rotator — each new index pushes up the last.
export type TickerMode = "standard" | "fast" | "fade" | "push";

interface TickerItem {
  symbol: string;
  label: string;
  price: number | null;
  changePercent: number | null;
  invertColors: boolean;
}

interface TickerData {
  data: TickerItem[];
  lastFetchTime: number | null;
}

interface MarketTickerProps {
  enabled: boolean;
  variant: "dashboard" | "stream";
  endpoint?: string;
  /** Marquee scroll duration in seconds (higher = slower). Defaults to 45. */
  scrollDurationSeconds?: number;
  /** Optional background image URL painted behind a dark wash (e.g. storm header). */
  backgroundImageUrl?: string;
  /** Compact mode: tighter vertical padding + slightly smaller text to reclaim height. */
  dense?: boolean;
  /** Motion mode. "standard"/"fast" = horizontal marquee (fast is quicker); "fade"/"push" = compact vertical rotator showing one index at a time. Defaults to "standard". */
  mode?: TickerMode;
  /** Opt-in: render a shimmer skeleton bar while the first fetch is in flight
   *  (instead of rendering nothing). Used by the Curated dashboard so the ticker
   *  slot matches the rest of the page's loading treatment. */
  loadingSkeleton?: boolean;
}

function formatPrice(price: number | null): string {
  if (price === null) return "--";
  if (price >= 1000) return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

function formatChange(change: number | null): string {
  if (change === null) return "--";
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(2)}%`;
}

function getChangeColor(change: number | null, invertColors: boolean, accentPositive?: boolean): string {
  if (change === null) return "";
  const isPositive = change >= 0;
  const positiveClass = accentPositive ? "text-[#5FA8C4]" : "text-emerald-500";
  const negativeClass = "text-[#e06b6b]";
  if (invertColors) {
    return isPositive ? negativeClass : positiveClass;
  }
  return isPositive ? positiveClass : negativeClass;
}

export default function MarketTicker({ enabled, variant, endpoint = "/api/ticker", scrollDurationSeconds = 45, backgroundImageUrl, dense = false, mode = "standard", loadingSkeleton = false }: MarketTickerProps) {
  const [data, setData] = useState<TickerItem[]>([]);
  const [vIndex, setVIndex] = useState(0);
  // Tracks whether the first fetch attempt has completed, so the opt-in skeleton
  // can distinguish "still loading" from "loaded but empty".
  const [hasFetched, setHasFetched] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(endpoint);
      if (res.ok) {
        const json: TickerData = await res.json();
        if (json.data && json.data.length > 0) {
          setData(json.data);
        }
      }
    } catch {
    } finally {
      setHasFetched(true);
    }
  }, [endpoint]);

  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    fetchData();
    intervalRef.current = setInterval(fetchData, 60_000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, fetchData]);

  // Vertical (fade/push) rotation: advance the visible index on a timer. Only
  // runs in the vertical modes; horizontal modes use the CSS marquee instead.
  useEffect(() => {
    if (mode !== "fade" && mode !== "push") return;
    const live = data.filter((d) => d.price !== null);
    if (!enabled || live.length === 0) return;
    const t = setInterval(() => {
      setVIndex((i) => (i + 1) % live.length);
    }, 3600);
    return () => clearInterval(t);
  }, [enabled, mode, data]);

  if (!enabled) return null;
  if (data.length === 0) {
    // Opt-in loading skeleton: while the very first fetch is still in flight,
    // show a shimmer bar (matching the page's animate-pulse skeletons) instead
    // of rendering nothing. Once fetched-but-empty, fall back to null as before.
    if (loadingSkeleton && !hasFetched) {
      const skeletonContainerClass = backgroundImageUrl
        ? "border-b overflow-hidden"
        : variant === "dashboard"
        ? "bg-card border-b overflow-hidden"
        : "bg-slate-800/60 border-b border-slate-700/50 overflow-hidden backdrop-blur-sm";
      return (
        <div className={skeletonContainerClass} data-testid="loading-market-ticker">
          <div style={{ padding: dense ? "2px 0" : "6px 0" }} className="px-3">
            <div className={`${dense ? "h-3" : "h-3.5"} w-full rounded-sm bg-muted animate-pulse`} />
          </div>
        </div>
      );
    }
    return null;
  }

  const isDashboard = variant === "dashboard";

  const containerClass = backgroundImageUrl
    ? "border-b overflow-hidden"
    : isDashboard
    ? "bg-card border-b overflow-hidden"
    : "bg-slate-800/60 border-b border-slate-700/50 overflow-hidden backdrop-blur-sm";

  const containerStyle = backgroundImageUrl
    ? {
        backgroundImage: [
          "linear-gradient(180deg, rgba(10,14,18,0.52) 0%, rgba(10,14,18,0.68) 100%)",
          `url(${backgroundImageUrl})`,
        ].join(", "),
        backgroundSize: "cover, cover",
        backgroundPosition: "center, center",
      }
    : undefined;

  const labelClass = isDashboard
    ? "text-muted-foreground font-medium"
    : "text-blue-400 font-semibold uppercase tracking-wider";

  const priceClass = isDashboard
    ? "text-foreground font-mono font-semibold"
    : "text-white font-mono font-semibold";

  const separatorClass = isDashboard
    ? "text-muted-foreground/30"
    : "text-slate-600";

  const items = data.filter(d => d.price !== null);

  // ── Vertical modes (fade / push): one compact index at a time ──────────────
  if (mode === "fade" || mode === "push") {
    if (items.length === 0) return null;
    const safe = vIndex % items.length;
    const item = items[safe];
    const positive = (item.changePercent ?? 0) >= 0;
    const colorClass = getChangeColor(item.changePercent, item.invertColors, !!backgroundImageUrl);
    const Arrow = positive ? TrendingUp : TrendingDown;
    return (
      <div className={containerClass} style={containerStyle} data-testid="market-ticker">
        <div className="ticker-vertical-viewport" style={{ padding: dense ? "2px 0" : "6px 0" }}>
          <div
            key={`${safe}-${item.symbol}`}
            className={`flex items-center justify-center gap-2 whitespace-nowrap ${dense ? "text-[11px]" : "text-xs"} ${mode === "fade" ? "ticker-v-fade" : "ticker-v-push"}`}
            data-testid={`ticker-item-${item.symbol}`}
          >
            <Arrow className={`${dense ? "w-3 h-3" : "w-3.5 h-3.5"} shrink-0 ${colorClass}`} />
            <span className={labelClass} data-testid={`ticker-label-${item.symbol}`}>{item.label}</span>
            <span className={priceClass} data-testid={`ticker-price-${item.symbol}`}>{formatPrice(item.price)}</span>
            <span className={`font-mono font-semibold ${colorClass}`} data-testid={`ticker-change-${item.symbol}`}>
              {formatChange(item.changePercent)}
            </span>
          </div>
        </div>
        <style>{`
          .ticker-vertical-viewport {
            width: 100%;
            overflow: hidden;
            display: flex;
            justify-content: center;
          }
          .ticker-v-fade {
            animation: ticker-fade-in 0.6s ease-out;
          }
          @keyframes ticker-fade-in {
            0% { opacity: 0; }
            100% { opacity: 1; }
          }
          .ticker-v-push {
            animation: ticker-push-up 0.55s cubic-bezier(0.16, 1, 0.3, 1);
          }
          @keyframes ticker-push-up {
            0% { transform: translateY(120%); opacity: 0; }
            45% { opacity: 1; }
            100% { transform: translateY(0); opacity: 1; }
          }
        `}</style>
      </div>
    );
  }

  // ── Horizontal marquee (standard / fast) ───────────────────────────────────
  const effectiveDuration =
    mode === "fast" ? Math.max(15, scrollDurationSeconds * 0.4) : scrollDurationSeconds;

  return (
    <div className={containerClass} style={containerStyle} data-testid="market-ticker">
      <div className="ticker-scroll-container" style={{ padding: dense ? "2px 0" : "6px 0" }}>
        <div className="ticker-scroll" style={{ animationDuration: `${effectiveDuration}s` }}>
          {[0, 1].map(copy => (
            <div key={copy} className="ticker-content" aria-hidden={copy === 1}>
              {items.map((item, i) => (
                <span key={`${copy}-${item.symbol}`} className={`inline-flex items-center gap-1.5 whitespace-nowrap ${dense ? "text-[11px]" : "text-xs"}`} data-testid={`ticker-item-${item.symbol}`}>
                  {i > 0 && <span className={`mx-3 ${separatorClass}`}>|</span>}
                  <span className={labelClass} data-testid={`ticker-label-${item.symbol}`}>{item.label}</span>
                  <span className={priceClass} data-testid={`ticker-price-${item.symbol}`}>{formatPrice(item.price)}</span>
                  <span className={`font-mono font-semibold ${getChangeColor(item.changePercent, item.invertColors, !!backgroundImageUrl)}`} data-testid={`ticker-change-${item.symbol}`}>
                    {formatChange(item.changePercent)}
                  </span>
                </span>
              ))}
              <span className={`mx-3 ${separatorClass}`}>|</span>
            </div>
          ))}
        </div>
      </div>
      <style>{`
        .ticker-scroll-container {
          width: 100%;
          overflow: hidden;
        }
        .ticker-scroll {
          display: flex;
          width: max-content;
          animation: ticker-marquee 45s linear infinite;
        }
        .ticker-content {
          display: flex;
          align-items: center;
          flex-shrink: 0;
        }
        @keyframes ticker-marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .ticker-scroll:hover {
          animation-play-state: paused;
        }
      `}</style>
    </div>
  );
}
